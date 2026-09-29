// End-to-end checks (no database, no network): sign-up works, the camera is not blocked by the server,
// Admin-pasted AI keys / AI-ML link are stored + applied live, and the /api/ai-ml gateway forwards them.
// prisma is replaced by an in-memory stub; the AI/ML service is replaced by a tiny local HTTP server.
process.env.NODE_ENV = 'test';
process.env.AI_ML_AUTOSTART = 'false';
process.env.PORTAL_ADMIN_EMAIL = 'admin@example.edu';
process.env.PORTAL_ADMIN_PASSWORD = 'Admin#Pass123';
process.env.BCRYPT_SALT_ROUNDS = '4';
process.env.PORTAL_AUTH_RATE_LIMIT_PER_15MIN = '1000';
process.env.API_RATE_LIMIT_PER_MINUTE = '10000';
delete process.env.GROQ_API_KEY; delete process.env.GEMINI_API_KEY;

const assert = require('assert');
const http = require('http');
const path = require('path');

// ---- in-memory prisma ------------------------------------------------------------------------
const users = [];
const kv = new Map();
const kid = (w) => `${w.scope}|${w.key}|${w.ownerId}`;
let seq = 1;
const stub = {
  user: {
    findUnique: async ({ where }) => users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) || null,
    create: async ({ data }) => { const u = { id: `u${seq++}`, ...data }; users.push(u); return u; },
    update: async ({ where, data }) => { const u = users.find((x) => x.id === where.id); Object.assign(u, data); return u; },
  },
  portalKV: {
    findFirst: async ({ where }) => kv.get(kid(where)) || null,
    upsert: async ({ where, create, update }) => { const k = kid(where.scope_key_ownerId); const row = kv.has(k) ? { ...kv.get(k), ...update } : { ...create }; kv.set(k, row); return row; },
    findMany: async () => [], count: async () => 0, deleteMany: async () => ({ count: 0 }),
  },
  refreshToken: { create: async () => ({}) },
  $disconnect: async () => {},
};
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };

function request(port, method, url, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      let buf = ''; res.on('data', (d) => { buf += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, json, text: buf }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

(async () => {
  // fake AI/ML service that records what the gateway sends
  const seen = [];
  const ml = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ status: 'ok', llm_configured: true })); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ echoed: req.url }));
  });
  await new Promise((r) => ml.listen(0, '127.0.0.1', r));
  const mlUrl = `http://127.0.0.1:${ml.address().port}`;

  const app = require('../server.js');
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  // ---- 1. the server must not block the camera (Face ID is mandatory at sign-up) ----------------
  const h = await request(port, 'GET', '/api/health');
  const pp = String(h.headers['permissions-policy'] || '');
  assert(/camera=\(self\)/.test(pp), `Permissions-Policy must allow the camera for the portal itself, got: ${pp}`);
  assert(/microphone=\(self\)/.test(pp), `Permissions-Policy must allow the microphone, got: ${pp}`);

  // ---- 2. student sign-up (with the full payload the form sends) -----------------------------------
  const payload = {
    email: 'anirudh@animail.com', password: 'Strong#Pass1', name: 'M. Anirudh', year: '3rd Year', role: 'student', branch: 'CSE',
    photo: 'data:image/jpeg;base64,' + 'A'.repeat(200000), mustChangePassword: false, recoveryEmail: 'anirudh@gmail.com',
    faceDescriptor: Array.from({ length: 128 }, (_, i) => i / 128), fingerprintCredentialId: null,
    accountCode: 'NEC-ABCD-EFGH', classTeacherEmail: '', mentorEmail: '',
  };
  const reg = await request(port, 'POST', '/api/portal-auth/register', { body: payload });
  assert.strictEqual(reg.status, 200, `register failed: ${reg.status} ${reg.text}`);
  assert(reg.json.accessToken && reg.json.user.email === 'anirudh@animail.com');
  assert(users.length === 1 && users[0].recoveryEmail === 'anirudh@gmail.com');
  const mirrored = [...kv.values()].find((r) => r.key === 'account:anirudh@animail.com');
  assert(mirrored, 'profile mirror must exist');
  assert(!('password' in mirrored.value) && !('passwordHash' in mirrored.value), 'plain-text password must never be mirrored');

  const dup = await request(port, 'POST', '/api/portal-auth/register', { body: payload });
  assert.strictEqual(dup.status, 409, 'duplicate e-mail must be a clear 409');
  assert(/already exists/i.test(dup.json.error));

  // a failure in the profile mirror must not make sign-up look failed
  const realUpsert = stub.portalKV.upsert;
  stub.portalKV.upsert = async () => { throw new Error('mirror down'); };
  const reg2 = await request(port, 'POST', '/api/portal-auth/register', { body: { ...payload, email: 'second@animail.com' } });
  stub.portalKV.upsert = realUpsert;
  assert.strictEqual(reg2.status, 200, 'sign-up must still succeed if only the mirror copy fails');

  // database problems surface as an actionable message, not a silent failure
  const realCreate = stub.user.create;
  stub.user.create = async () => { const e = new Error('table missing'); e.code = 'P2021'; throw e; };
  const reg3 = await request(port, 'POST', '/api/portal-auth/register', { body: { ...payload, email: 'third@animail.com' } });
  stub.user.create = realCreate;
  assert.strictEqual(reg3.status, 500); assert(/migrate deploy/i.test(reg3.json.error), reg3.json.error);

  // ---- 3. Admin pastes keys + AI/ML link ---------------------------------------------------------------
  assert.strictEqual((await request(port, 'POST', '/api/portal-auth/bootstrap-admin')).status, 200);
  const login = await request(port, 'POST', '/api/portal-auth/login', { body: { email: 'admin@example.edu', password: 'Admin#Pass123' } });
  assert.strictEqual(login.status, 200, login.text);
  const admin = { Authorization: `Bearer ${login.json.accessToken}` };
  const student = { Authorization: `Bearer ${reg.json.accessToken}` };

  assert.strictEqual((await request(port, 'GET', '/api/portal-auth/admin/ai-config', { headers: student })).status, 403, 'students must not read AI config');
  assert.strictEqual((await request(port, 'PUT', '/api/portal-auth/admin/ai-config', { headers: student, body: { groqKey: 'x'.repeat(30) } })).status, 403);

  const bad = await request(port, 'PUT', '/api/portal-auth/admin/ai-config', { headers: admin, body: { groqKey: 'short' } });
  assert.strictEqual(bad.status, 400, 'a too-short key must be rejected with a clear message');
  const bad2 = await request(port, 'PUT', '/api/portal-auth/admin/ai-config', { headers: admin, body: { aiMlUrl: 'http://exa mple' } });
  assert.strictEqual(bad2.status, 400);

  const save = await request(port, 'PUT', '/api/portal-auth/admin/ai-config', {
    headers: admin, body: { groqKey: '  "gsk_TESTKEY_1234567890abcdef"  ', geminiKey: 'AIzaTESTKEY1234567890abcdef', aiMlUrl: `${mlUrl}/docs`, aiMlToken: 'shared-token-1234567890' },
  });
  assert.strictEqual(save.status, 200, save.text);
  assert(save.json.groq.set && save.json.gemini.set && !JSON.stringify(save.json).includes('TESTKEY_1234567890abcdef'), 'keys must never be echoed back');
  assert.strictEqual(save.json.aiMl.url, mlUrl, '"/docs" suffix must be stripped from the pasted link');
  assert.strictEqual(save.json.groq.source, 'admin');

  const get = await request(port, 'GET', '/api/portal-auth/admin/ai-config', { headers: admin });
  assert(get.json.groq.masked.includes('••••') && get.json.service.state);

  // blank key on a later save keeps the stored one
  const keep = await request(port, 'PUT', '/api/portal-auth/admin/ai-config', { headers: admin, body: { groqKey: '', groqModel: 'openai/gpt-oss-120b' } });
  assert(keep.json.groq.set, 'blank key field must keep the saved key');

  // ---- 4. gateway forwards the admin keys + token to the AI/ML service, per request ---------------------
  const noAuth = await request(port, 'GET', '/api/ai-ml/adaptive/topics');
  assert.strictEqual(noAuth.status, 401, 'gateway must require a signed-in user');
  const viaGw = await request(port, 'GET', '/api/ai-ml/adaptive/topics', { headers: student });
  assert.strictEqual(viaGw.status, 200, viaGw.text);
  const hit = seen.find((s) => s.url === '/adaptive/topics');
  assert(hit, 'the fake AI/ML service must have been called');
  assert.strictEqual(hit.headers['x-service-token'], 'shared-token-1234567890');
  assert.strictEqual(hit.headers['x-groq-key'], 'gsk_TESTKEY_1234567890abcdef', 'quotes/whitespace pasted around the key must be stripped');
  assert.strictEqual(hit.headers['x-gemini-key'], 'AIzaTESTKEY1234567890abcdef');
  assert(!hit.headers.authorization && !hit.headers.cookie, 'user credentials must not leak to the AI/ML service');

  const post = await request(port, 'POST', '/api/ai-ml/career-path/predict', { headers: student, body: { current_skills: ['python'] } });
  assert.strictEqual(post.status, 200); assert.strictEqual(post.json.echoed, '/career-path/predict');
  const postEmpty = await request(port, 'POST', '/api/ai-ml/adaptive/session/start', { headers: student, body: {} });
  assert.strictEqual(postEmpty.status, 200, 'an empty JSON body {} must still be forwarded');

  const st = await request(port, 'GET', '/api/ai-ml-status');
  assert.strictEqual(st.status, 200); assert.strictEqual(st.json.available, true);

  // ---- 5. unreachable AI/ML service -> friendly 503, not a generic 502 --------------------------------------
  await request(port, 'PUT', '/api/portal-auth/admin/ai-config', { headers: admin, body: { aiMlUrl: 'http://127.0.0.1:9' } });
  const down = await request(port, 'GET', '/api/ai-ml/adaptive/topics', { headers: student });
  assert.strictEqual(down.status, 503); assert(down.json.detail && /AI\/ML|service/i.test(down.json.detail));

  // ---- 6. keys are applied live to the LLM proxy (/api/ai) - no restart ----------------------------------------
  await request(port, 'PUT', '/api/portal-auth/admin/ai-config', { headers: admin, body: { aiMlUrl: mlUrl } });
  const realFetch = global.fetch; let groqAuth = null;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.groq.com')) { groqAuth = opts.headers.Authorization; return new Response(JSON.stringify({ choices: [{ message: { content: 'hello from groq' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    return realFetch(url, opts);
  };
  const ai = await request(port, 'POST', '/api/ai', { headers: student, body: { systemPrompt: 'be brief', userPrompt: 'say hello', opts: { noCache: true } } });
  global.fetch = realFetch;
  assert.strictEqual(ai.status, 200, ai.text);
  assert.strictEqual(groqAuth, 'Bearer gsk_TESTKEY_1234567890abcdef', 'the Admin-pasted Groq key must be used by /api/ai immediately');

  srv.close(); ml.close();
  console.log('signupAndAiConfig.test.js: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
