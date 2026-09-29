// Per-user browser-state sync -> Neon (PostgreSQL).
//
// The portal keeps a lot of student data in the browser's localStorage (progress, quiz history,
// timetables, resume draft, mock-interview history, Striver progress, ...). localStorage is
// per-device, so none of that was reaching the database. The frontend now mirrors every
// allow-listed localStorage key here, and restores it after login on any device.
//
//   GET    /api/sync            -> { items: { key: { raw, updatedAt } } }
//   PUT    /api/sync            -> body { items: { key: rawString } }   (batch upsert)
//   DELETE /api/sync            -> body { keys: [key, ...] }
//
// Rows live in PortalKV (scope "private", ownerId = user id, key "ls:<localStorage key>").
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const PREFIX = 'ls:';
const MAX_VALUE_CHARS = 2_000_000;      // per key
const MAX_KEYS_PER_REQUEST = 60;
const MAX_KEYS_PER_USER = 800;

// Keep this list identical to the allow-list in the frontend sync script.
const ALLOW = [/^TNP_/, /_v\d+$/, /^CP_ADV3:/];
const DENY = [
  /^TNP_(CURRENT_USER|SESSION_META|LOGIN_ATTEMPTS|AUDIT_LOG|DB|PUBLIC_BASE_URL|APP_BOOTED__)/,
  /^TNP_DB::/,
  /^TNP_(FACULTY_LIST|COORDINATOR_EMAILS|ADMIN_ADDED_COMPANIES)$/,  // shared data, already stored server-side
  /API_KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /EMAILJS/i,
];
function syncable(key) {
  const k = String(key || '');
  if (!k || k.length > 180) return false;
  if (DENY.some(r => r.test(k))) return false;
  return ALLOW.some(r => r.test(k));
}

router.get('/', async (req, res) => {
  try {
    const rows = await prisma.portalKV.findMany({
      where: { scope: 'private', ownerId: req.user.sub, key: { startsWith: PREFIX } },
      take: MAX_KEYS_PER_USER + 50,
    });
    const items = {};
    for (const r of rows) {
      const raw = r.value && typeof r.value === 'object' ? r.value.raw : null;
      if (typeof raw === 'string') items[r.key.slice(PREFIX.length)] = { raw, updatedAt: r.updatedAt };
    }
    res.json({ items });
  } catch (_) { res.status(500).json({ error: 'Could not load your saved data.' }); }
});

router.put('/', async (req, res) => {
  try {
    const incoming = req.body && typeof req.body.items === 'object' && req.body.items ? req.body.items : {};
    const entries = Object.entries(incoming).slice(0, MAX_KEYS_PER_REQUEST);
    const userId = req.user.sub;
    const existing = await prisma.portalKV.count({ where: { scope: 'private', ownerId: userId, key: { startsWith: PREFIX } } });
    let saved = 0, skipped = 0;
    for (const [key, raw] of entries) {
      if (!syncable(key) || typeof raw !== 'string' || raw.length > MAX_VALUE_CHARS) { skipped++; continue; }
      if (existing + saved > MAX_KEYS_PER_USER) { skipped++; continue; }
      const dbKey = PREFIX + key;
      await prisma.portalKV.upsert({
        where: { scope_key_ownerId: { scope: 'private', key: dbKey, ownerId: userId } },
        create: { scope: 'private', key: dbKey, ownerId: userId, value: { raw } },
        update: { value: { raw } },
      });
      saved++;
    }
    res.json({ ok: true, saved, skipped });
  } catch (_) { res.status(500).json({ error: 'Could not save your data.' }); }
});

router.delete('/', async (req, res) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.slice(0, MAX_KEYS_PER_REQUEST) : [];
    const dbKeys = keys.filter(syncable).map(k => PREFIX + k);
    if (dbKeys.length) await prisma.portalKV.deleteMany({ where: { scope: 'private', ownerId: req.user.sub, key: { in: dbKeys } } });
    res.json({ ok: true, deleted: dbKeys.length });
  } catch (_) { res.status(500).json({ error: 'Could not delete data.' }); }
});

module.exports = router;
module.exports.syncable = syncable;
