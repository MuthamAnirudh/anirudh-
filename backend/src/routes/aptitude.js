// Per-student aptitude progress -> Neon (PostgreSQL), table "AptitudeAttempt".
//
//   GET  /api/aptitude/progress  -> { seen:[qKey], correct:[qKey], stats:{ seen, attempted, correct } }
//   POST /api/aptitude/progress  -> body { events:[{ k, a?, c?, g?, t? }] }
//        k = question key (content hash), a = attempted, c = answered correctly, g = group, t = topic.
//        Sending an event at all means "this question was shown".
//
// Merge rules are a pure union (flags only ever go false -> true), so progress coming from
// several devices/tabs merges safely and a retried request cannot double-count anything.
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const KEY_RE = /^[a-z0-9]{6,40}$/;
const MAX_EVENTS_PER_REQUEST = 300;
const MAX_ROWS_PER_USER = 500000;

const clip = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

// Validates a request body and folds duplicate keys together (flags are OR-ed).
function normalizeEvents(events) {
  const merged = new Map();
  for (const e of (Array.isArray(events) ? events : []).slice(0, MAX_EVENTS_PER_REQUEST)) {
    if (!e || typeof e.k !== 'string' || !KEY_RE.test(e.k)) continue;
    const cur = merged.get(e.k) || { k: e.k, a: false, c: false, g: null, t: null };
    cur.a = cur.a || e.a === true || e.c === true;   // a correct answer is necessarily an attempt
    cur.c = cur.c || e.c === true;
    cur.g = cur.g || clip(e.g);
    cur.t = cur.t || clip(e.t);
    merged.set(e.k, cur);
  }
  return [...merged.values()];
}

async function applyEvents(userId, events) {
  const rows = normalizeEvents(events);
  if (!rows.length) return 0;
  const existing = await prisma.aptitudeAttempt.count({ where: { userId } });
  if (existing < MAX_ROWS_PER_USER) {
    await prisma.aptitudeAttempt.createMany({
      data: rows.map(r => ({ userId, qKey: r.k, qGroup: r.g, topic: r.t, attempted: r.a, correct: r.c })),
      skipDuplicates: true,                        // atomic insert-if-absent, safe under concurrent requests
    });
  }
  const attempted = rows.filter(r => r.a).map(r => r.k);
  const correct = rows.filter(r => r.c).map(r => r.k);
  if (attempted.length) await prisma.aptitudeAttempt.updateMany({ where: { userId, qKey: { in: attempted }, attempted: false }, data: { attempted: true } });
  if (correct.length) await prisma.aptitudeAttempt.updateMany({ where: { userId, qKey: { in: correct }, correct: false }, data: { correct: true } });
  return rows.length;
}

async function loadProgress(userId) {
  const rows = await prisma.aptitudeAttempt.findMany({
    where: { userId }, select: { qKey: true, attempted: true, correct: true }, take: MAX_ROWS_PER_USER,
  });
  const seen = [], correct = [];
  let attempted = 0;
  for (const r of rows) {
    seen.push(r.qKey);
    if (r.attempted) attempted++;
    if (r.correct) correct.push(r.qKey);
  }
  return { seen, correct, stats: { seen: seen.length, attempted, correct: correct.length } };
}

router.get('/progress', async (req, res) => {
  try { res.json(await loadProgress(req.user.sub)); }
  catch (_) { res.status(500).json({ error: 'Could not load your aptitude progress.' }); }
});

router.post('/progress', async (req, res) => {
  try {
    const applied = await applyEvents(req.user.sub, req.body && req.body.events);
    res.json({ ok: true, applied });
  } catch (_) { res.status(500).json({ error: 'Could not save your aptitude progress.' }); }
});

module.exports = router;
module.exports.normalizeEvents = normalizeEvents;
module.exports.applyEvents = applyEvents;
module.exports.loadProgress = loadProgress;
