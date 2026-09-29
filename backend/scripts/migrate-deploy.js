'use strict';
// Applies every Prisma migration to the production PostgreSQL database.
// Without this step the tables (User, PortalKV, ...) never exist on a fresh Vercel/Supabase/Neon
// database, so sign-up and login silently fail and nothing is stored.
//
// Uses DIRECT_URL (a non-pooled connection string) when provided, because `prisma migrate`
// cannot run through a PgBouncer / "transaction pooler" URL (Supabase port 6543, Neon -pooler).
const { spawnSync } = require('child_process');
const path = require('path');

const url = String(process.env.DIRECT_URL || process.env.DATABASE_URL || '').trim();
if (!url) {
  console.warn('[migrate-deploy] DATABASE_URL is not set - skipping migrations. Accounts will NOT be stored until it is configured.');
  process.exit(0);
}
const result = spawnSync(
  process.execPath,
  [path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
  { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url }, cwd: path.join(__dirname, '..') }
);
if (result.status !== 0) {
  console.error('[migrate-deploy] prisma migrate deploy FAILED. Check DATABASE_URL / DIRECT_URL.');
  process.exit(result.status || 1);
}
console.log('[migrate-deploy] Database schema is up to date.');
