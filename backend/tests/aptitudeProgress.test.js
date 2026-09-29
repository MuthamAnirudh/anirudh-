// Aptitude no-repeat progress stored in Neon: route logic, schema/migration wiring, and the browser module.
// Runs without a database: prisma is replaced by an in-memory stub.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---- in-memory prisma stub (AptitudeAttempt only) ----------------------------------------------------
const rows = [];
const stub = { aptitudeAttempt: {
  count: async ({ where }) => rows.filter(r => r.userId === where.userId).length,
  createMany: async ({ data, skipDuplicates }) => {
    let n = 0;
    for (const d of data) {
      if (rows.some(r => r.userId === d.userId && r.qKey === d.qKey)) { if (skipDuplicates) continue; throw new Error('unique'); }
      rows.push({ attempted: false, correct: false, ...d }); n++;
    }
    return { count: n };
  },
  updateMany: async ({ where, data }) => {
    let n = 0;
    for (const r of rows) {
      if (r.userId !== where.userId || !where.qKey.in.includes(r.qKey)) continue;
      if (where.attempted === false && r.attempted) continue;
      if (where.correct === false && r.correct) continue;
      Object.assign(r, data); n++;
    }
    return { count: n };
  },
  findMany: async ({ where }) => rows.filter(r => r.userId === where.userId).map(r => ({ qKey: r.qKey, attempted: r.attempted, correct: r.correct })),
} };
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stub };

(async () => {
  const route = require('../src/routes/aptitude');
  const K = (n) => 'q' + String(n).padStart(8, '0') + 'abc';

  // ---- validation / folding ---------------------------------------------------------------------------
  const norm = route.normalizeEvents([
    { k: K(1) }, { k: K(1), c: true }, { k: 'BAD KEY!' }, { k: '' }, null, { k: K(2), a: true }, { k: K(3), c: false },
  ]);
  assert.strictEqual(norm.length, 3, 'invalid keys dropped, duplicates folded');
  const e1 = norm.find(e => e.k === K(1));
  assert(e1.c && e1.a, 'a correct answer implies an attempt; flags are OR-ed');
  assert(!norm.find(e => e.k === K(3)).a, 'shown-only event stays un-attempted');
  assert.strictEqual(route.normalizeEvents(Array.from({ length: 1000 }, (_, i) => ({ k: K(i) }))).length, 300, 'batch is capped');

  // ---- storage semantics --------------------------------------------------------------------------------
  await route.applyEvents('u1', [{ k: K(1) }, { k: K(2) }, { k: K(3) }]);              // three questions shown
  let p = await route.loadProgress('u1');
  assert.strictEqual(p.stats.seen, 3); assert.strictEqual(p.stats.attempted, 0); assert.strictEqual(p.stats.correct, 0);

  await route.applyEvents('u1', [{ k: K(1), a: true, c: true }, { k: K(2), a: true, c: false }]);
  p = await route.loadProgress('u1');
  assert.deepStrictEqual([p.stats.seen, p.stats.attempted, p.stats.correct], [3, 2, 1]);
  assert.deepStrictEqual(p.correct, [K(1)]);

  await route.applyEvents('u1', [{ k: K(1), a: true, c: false }]);                      // later wrong attempt must not erase "correct"
  await route.applyEvents('u1', [{ k: K(1), a: true, c: true }, { k: K(2), a: true, c: false }]); // retried request = idempotent
  p = await route.loadProgress('u1');
  assert.deepStrictEqual([p.stats.seen, p.stats.attempted, p.stats.correct], [3, 2, 1], 'union merge is monotonic and idempotent');
  assert.strictEqual(rows.filter(r => r.userId === 'u1').length, 3, 'no duplicate rows');

  await route.applyEvents('u2', [{ k: K(1) }]);
  assert.strictEqual((await route.loadProgress('u2')).stats.correct, 0, 'progress is per user');
  assert.strictEqual((await route.loadProgress('u1')).stats.correct, 1);

  // ---- wiring -------------------------------------------------------------------------------------------
  assert(read('src/routes/aptitude.js').includes('router.use(requireAuth)'), 'all aptitude routes need a signed-in user');
  assert(read('server.js').includes("app.use('/api/aptitude', aptitudeRoutes)"), 'route must be mounted');
  const schema = read('prisma/schema.prisma');
  assert(/model AptitudeAttempt\s*\{/.test(schema) && schema.includes('@@unique([userId, qKey])') && schema.includes('aptitudeAttempts AptitudeAttempt[]'));
  const mig = read('prisma/migrations/20260928000000_add_aptitude_attempts/migration.sql');
  assert(mig.includes('CREATE TABLE IF NOT EXISTS "AptitudeAttempt"') && mig.includes('"AptitudeAttempt_userId_qKey_key"') && !/\bDROP\b|\bTRUNCATE\b|DELETE FROM/i.test(mig), 'additive migration only');

  // ---- frontend integration (static) --------------------------------------------------------------------
  const html = read('../frontend/index.html');
  ['AptiProgress.init(em)', 'AptiProgress.markShown(key,', 'AptiProgress.markAnswered(aptiQuestionKey(currentAptiQ)', 'AptiProgress.has(key)',
   'AptiProgress.markAnswered(AptiProgress.key(q.question), correct', 'AptiProgress.whenReady(3000)', 'qk || AptiProgress.has(qk)']
    .forEach(s => assert(html.includes(s), `index.html must contain: ${s}`));
  ['handleRemoveAptiQuestion', 'handleAdaptiveNext', 'jumpToAptiQuestion', 'randomAptiQuestion', 'aptiBrowseRevealed', 'handleAptiExplainDifferently', 'speakAptiQuestion', 'startAiQuiz', 'markQuizSeen']
    .forEach(s => assert(html.includes(s), `existing feature must still exist: ${s}`));

  // ---- browser module, run in a sandbox against a fake server ---------------------------------------------
  const code = /\/\/ <<APTI_PROGRESS_START>>([\s\S]*?)\/\/ <<APTI_PROGRESS_END>>/.exec(html)[1];
  const server = new Map();                                    // userEmail -> Map(qKey -> {a,c})
  let online = true;
  const makeDevice = (token = 'tok') => {
    const store = new Map(token ? [['CP_ACCESS_TOKEN', token]] : []);
    const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    let email = null;
    const storageFetch = async (p, o = {}) => {
      if (!online) throw new Error('offline');
      const db = server.get(email) || server.set(email, new Map()).get(email);
      if (!o.method || o.method === 'GET') {
        const seen = [...db.keys()], correct = [...db].filter(([, v]) => v.c).map(([k]) => k);
        return { seen, correct, stats: { seen: seen.length, attempted: [...db.values()].filter(v => v.a).length, correct: correct.length } };
      }
      for (const e of JSON.parse(o.body).events) { const cur = db.get(e.k) || { a: false, c: false }; db.set(e.k, { a: cur.a || !!e.a || !!e.c, c: cur.c || !!e.c }); }
      return { ok: true };
    };
    const win = { addEventListener() {} }, doc = { addEventListener() {}, visibilityState: 'visible' };
    const mod = new Function('storageFetch', 'localStorage', 'window', 'document', code + '; return AptiProgress;')(storageFetch, localStorage, win, doc);
    return { mod, store, setEmail: (e) => { email = e; } };
  };

  const A = makeDevice(); A.setEmail('s@x.com');
  assert.strictEqual(A.mod.key('What is  50% of 171?'), A.mod.key(' what is 50% of 171? '), 'key ignores case/whitespace');
  assert.notStrictEqual(A.mod.key('What is 50% of 171?'), A.mod.key('What is 50% of 172?'));
  assert.strictEqual(A.mod.key('   '), '');
  const kq1 = A.mod.key('Q one'), kq2 = A.mod.key('Q two'), kq3 = A.mod.key('Q three');
  await A.mod.init('s@x.com');
  assert(A.mod.isReady());
  A.mod.markShown(kq1, { g: 'G', t: 'T' });
  A.mod.markShown(kq2);
  A.mod.markAnswered(kq2, true);
  assert(A.mod.has(kq1) && A.mod.has(kq2) && !A.mod.has(kq3) && A.mod.isCorrect(kq2) && !A.mod.isCorrect(kq1));
  await A.mod.flush();
  assert(server.get('s@x.com').has(kq1) && server.get('s@x.com').get(kq2).c, 'shown + correct answers reach the database');

  const B = makeDevice(); B.setEmail('s@x.com');                // second device, empty cache
  await B.mod.init('s@x.com');
  assert(B.mod.has(kq1) && B.mod.has(kq2) && B.mod.isCorrect(kq2) && !B.mod.has(kq3), 'another device sees the same history');

  online = false;                                               // offline session: nothing may be lost
  B.mod.markShown(kq3); B.mod.markAnswered(kq3, true);
  assert.strictEqual(await B.mod.flush(), false);
  assert(B.mod.has(kq3));
  const B2 = makeDevice(); B2.store.clear(); [...B.store].forEach(([k, v]) => B2.store.set(k, v)); B2.setEmail('s@x.com');
  await B2.mod.init('s@x.com');                                 // "page reload" while still offline
  assert(B2.mod.has(kq3) && B2.mod.isCorrect(kq3), 'offline progress survives a reload');
  online = true;
  assert.strictEqual(await B2.mod.flush(), true);
  assert(server.get('s@x.com').get(kq3).c, 'queued offline progress is uploaded once back online');

  B2.setEmail('other@x.com');                                   // new student signs in on the same browser (new token)
  await B2.mod.init('other@x.com');
  assert(!B2.mod.has(kq1), 'a different student never inherits the previous student\'s history');

  console.log('Aptitude progress tests passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
