// Static + unit checks for: (1) password-recovery e-mail delivery, (2) Neon user-data sync.
// Runs without a database: prisma is replaced by an in-memory stub.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---- in-memory prisma stub ---------------------------------------------------------------
const kv = new Map();
const kid = (w) => `${w.scope}|${w.key}|${w.ownerId}`;
const stub = { portalKV: {
  findFirst: async ({ where }) => kv.get(kid(where)) || null,
  upsert: async ({ where, create, update }) => { const k = kid(where.scope_key_ownerId); const row = kv.has(k) ? { ...kv.get(k), ...update } : { ...create }; kv.set(k, row); return row; },
  findMany: async ({ where }) => [...kv.values()].filter(r => r.scope === where.scope && r.ownerId === where.ownerId && r.key.startsWith(where.key.startsWith)),
  count: async ({ where }) => [...kv.values()].filter(r => r.scope === where.scope && r.ownerId === where.ownerId && r.key.startsWith(where.key.startsWith)).length,
  deleteMany: async () => ({ count: 0 }),
} };
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };

(async () => {
  // ---- mailer configuration ---------------------------------------------------------------
  ['RECOVERY_EMAILJS_SERVICE_ID','RECOVERY_EMAILJS_TEMPLATE_ID','RECOVERY_EMAILJS_PUBLIC_KEY','RECOVERY_EMAILJS_PRIVATE_KEY','EMAILJS_SERVICE_ID','EMAILJS_TEMPLATE_ID','EMAILJS_PUBLIC_KEY','EMAILJS_PRIVATE_KEY'].forEach(k => delete process.env[k]);
  const mailer = require('../src/services/recoveryMailer');
  let cfg = await mailer.resolveConfig();
  assert.strictEqual(cfg.configured, false, 'Unconfigured mailer must report not configured.');
  await assert.rejects(() => mailer.sendRecoveryCode('a@b.com', '123456'), (e) => e.code === 'NOT_CONFIGURED');

  await mailer.saveStoredConfig({ serviceId: 'service_x', templateId: 'template_x', publicKey: 'pub', privateKey: 'privatekey1' });
  cfg = await mailer.resolveConfig();
  assert(cfg.configured && cfg.privateKey === 'privatekey1', 'Admin-saved (database) config must be used.');
  await mailer.saveStoredConfig({ serviceId: 'service_y', privateKey: '' });
  cfg = await mailer.resolveConfig();
  assert.strictEqual(cfg.serviceId, 'service_y'); assert.strictEqual(cfg.privateKey, 'privatekey1', 'Blank private key must keep the saved one.');
  process.env.EMAILJS_SERVICE_ID = 'service_env';
  cfg = await mailer.resolveConfig();
  assert.strictEqual(cfg.serviceId, 'service_env', 'Env vars (short names) take priority.');
  delete process.env.EMAILJS_SERVICE_ID;

  // ---- request sent to EmailJS --------------------------------------------------------------
  let sent = null;
  global.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200, text: async () => 'OK' }; };
  await mailer.sendRecoveryCode('student@gmail.com', '654321', { name: 'Asha' });
  assert.strictEqual(sent.url, 'https://api.emailjs.com/api/v1.0/email/send');
  assert.strictEqual(sent.body.accessToken, 'privatekey1', 'Private key must be sent as accessToken.');
  assert.strictEqual(sent.body.template_params.to_email, 'student@gmail.com');
  assert.strictEqual(sent.body.template_params.passcode, '654321');
  global.fetch = async () => ({ ok: false, status: 403, text: async () => 'API calls are disabled for non-browser applications' });
  await assert.rejects(() => mailer.sendRecoveryCode('a@b.com', '111111'), (e) => e.status === 403 && /non-browser/i.test(e.hint));

  // ---- recovery goes to the address given at account creation --------------------------------
  const auth = read('src/routes/portalAuth.js');
  assert(auth.includes("normalizeEmail(u.recoveryEmail)||u.email"), 'Reset code must go to the recovery e-mail captured at signup.');
  assert(!/patch\.recoveryEmail!==undefined\?\{recoveryEmail/.test(auth), 'PATCH /me must not change the recovery e-mail.');
  assert(read('src/routes/storage.js').includes('isAdmin && value?.recoveryEmail'), 'Only admins may change recoveryEmail through KV sync.');
  assert(auth.includes('delivery failed') || auth.includes('Delivery failed'), 'Delivery failures must be logged.');

  // ---- user data sync -----------------------------------------------------------------------
  const sync = require('../src/routes/userSync');
  ['TNP_TASK_PROGRESS', 'TNP_QUIZ_HISTORY', 'TNP_TASK_PROGRESS::a@b.com', 'mirrorMentorHistory_v1', 'mockHubHistory_v1', 'CP_ADV3:notes', 'TNP_STRIVER_A2Z_V2'].forEach(k => assert(sync.syncable(k), `${k} must sync`));
  ['CP_ACCESS_TOKEN', 'CP_USER', 'GROQ_API_KEY', 'EMAILJS_PUBLIC_KEY', 'TNP_SESSION_META', 'TNP_CURRENT_USER', 'TNP_AUDIT_LOG', 'TNP_FACULTY_LIST', 'AI_BACKEND_URL', 'execRunnerKey', 'CP_V23_RUNTIME', 'cp:v25:leader', 'TNP_LOGIN_ATTEMPTS'].forEach(k => assert(!sync.syncable(k), `${k} must NOT sync`));
  const html = read('../frontend/index.html');
  assert(html.includes('src="./cloud-sync.js"') && html.indexOf('cloud-sync.js') < html.indexOf('Idempotency guard'), 'cloud-sync.js must load before the app script.');
  const client = read('../frontend/cloud-sync.js');
  const allow = /var ALLOW = \[(.*?)\];/.exec(client)[1].replace(/\s/g, '');
  assert.strictEqual(allow, '/^TNP_/,/_v\\d+$/,/^CP_ADV3:/', 'Client and server allow-lists must match.');

  console.log('Recovery + Neon sync tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
