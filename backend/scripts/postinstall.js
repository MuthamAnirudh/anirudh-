'use strict';
// Runs after `npm install`.
//  1. Always generates the Prisma client (same as the previous "postinstall": "prisma generate").
//  2. ONLY on Vercel (VERCEL=1 is set automatically during Vercel builds) also applies the database
//     migrations, so a fresh Neon database gets every table on the first deploy with no manual steps.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');

const gen = spawnSync(process.execPath, [prismaCli, 'generate'], { stdio: 'inherit', cwd: root });
if (gen.status !== 0) process.exit(gen.status || 1);

if (process.env.VERCEL) {
  const mig = spawnSync(process.execPath, [path.join(__dirname, 'migrate-deploy.js')], { stdio: 'inherit', cwd: root });
  if (mig.status !== 0) process.exit(mig.status || 1);
}
