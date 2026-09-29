'use strict';
// Local-development convenience: if backend/.env does not exist yet, create it from .env.example with freshly
// generated random secrets so `npm start` works without any manual editing (login sessions also survive restarts).
// Never runs in production or on Vercel. DATABASE_URL is deliberately left for you to fill in.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function bootstrapEnv() {
  try {
    if (process.env.VERCEL || ['production', 'test'].includes(String(process.env.NODE_ENV || '').toLowerCase())) return false;
    const root = path.join(__dirname, '..');
    const target = path.join(root, '.env');
    const example = path.join(root, '.env.example');
    if (fs.existsSync(target) || !fs.existsSync(example)) return false;
    const rnd = () => crypto.randomBytes(32).toString('hex');
    let text = fs.readFileSync(example, 'utf8');
    text = text
      .replace(/^JWT_ACCESS_SECRET=.*$/m, `JWT_ACCESS_SECRET=${rnd()}`)
      .replace(/^JWT_REFRESH_SECRET=.*$/m, `JWT_REFRESH_SECRET=${rnd()}`)
      .replace(/^AI_ML_SERVICE_TOKEN=.*$/m, `AI_ML_SERVICE_TOKEN=${rnd()}`)
      .replace(/^OPERATIONS_TOKEN=.*$/m, `OPERATIONS_TOKEN=${rnd()}`);
    fs.writeFileSync(target, text, { flag: 'wx' });
    console.log('[setup] Created backend/.env from .env.example with generated secrets. Open it and set DATABASE_URL (PostgreSQL) and PORTAL_ADMIN_EMAIL / PORTAL_ADMIN_PASSWORD.');
    return true;
  } catch (e) { console.warn('[setup] Could not create backend/.env automatically:', e.message); return false; }
};
