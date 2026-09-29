# Deploy: GitHub -> Vercel (with Neon PostgreSQL)

## 1. Push to GitHub
```bash
git init
git add .
git commit -m "Campus portal"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
`.gitignore` already keeps real `.env` files out. Only `.env.example` templates are committed.

## 2. Import the repo in Vercel
New Project -> import the repo -> leave Framework Preset as "Other" and every build setting at its default
(`vercel.json` already routes `/api/*` to the backend and everything else to `frontend/`).

## 3. Environment variables (Vercel -> Settings -> Environment Variables)
| Name | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (ends with `?sslmode=require`) |
| `DIRECT_URL` | Optional. Neon **direct** (non-pooler) string, used only to create tables. Set it if `DATABASE_URL` contains `-pooler` |
| `JWT_ACCESS_SECRET` | random, 32+ characters |
| `JWT_REFRESH_SECRET` | random, 32+ characters, different from the one above |
| `CORS_ORIGIN` | your site URL, e.g. `https://your-app.vercel.app` (must be https) |
| `TRUST_PROXY` | `1` |
| `PORTAL_ADMIN_EMAIL` | admin login email |
| `PORTAL_ADMIN_PASSWORD` | admin password, 8+ characters |
| `PORTAL_ADMIN_NAME` | e.g. `Professor-In-Charge (T&P)` |
| `AI_ML_SERVICE_TOKEN` | random, 32+ characters |
| `OPERATIONS_TOKEN` | random, 32+ characters |
| `RECOVERY_EMAILJS_SERVICE_ID`, `RECOVERY_EMAILJS_TEMPLATE_ID`, `RECOVERY_EMAILJS_PUBLIC_KEY`, `RECOVERY_EMAILJS_PRIVATE_KEY` | from your EmailJS account (password recovery). All four are needed for server-side sending. Alternative: leave them empty and save them from **Admin -> Settings -> Email Delivery** (stored in Neon) |
| `GROQ_API_KEY` and/or `GEMINI_API_KEY` | AI features |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 4. Deploy
Every deploy runs `npm install` in `backend/`, which generates the Prisma client and (on Vercel only)
applies all database migrations, so the tables are created automatically. Check the build log for
`[migrate-deploy] Database schema is up to date.`

## 5. Verify
1. Open `https://<your-site>/api/health` -> should show `"db":"ok"`.
2. Sign in as T&P Admin with `PORTAL_ADMIN_EMAIL` / `PORTAL_ADMIN_PASSWORD` (creates the admin on first use).
3. Create a student account, sign out, sign in again. The account and its progress are kept.

## Password-recovery e-mail (EmailJS) checklist
1. EmailJS -> **Account -> Security** -> switch ON **Allow EmailJS API for non-browser applications** (without this EmailJS answers 403 and nothing is sent).
2. Copy the **Private Key** from the same page (needed in addition to the Public Key).
3. Template: **To Email** = `{{to_email}}`; put `{{passcode}}` in the body.
4. Save the four values in Vercel (redeploy) **or** in Admin -> Settings -> Email Delivery, then press **Send test** there. The test shows EmailJS's exact reply if something is wrong.
5. Reset codes go to the recovery Gmail the student entered at sign-up. It is locked afterwards (only an Admin can correct it).

## Where student data lives
Account, results, Digital Twin, Striver progress, gate passes, notices etc. are stored in Neon through the API. Everything a student saves in the browser
(progress, quiz history, timetable, resume draft, mock-interview history ...) is now mirrored to Neon automatically (`/api/sync`, table `PortalKV`, keys `ls:*`)
and restored after sign-in on any device. No new migration is needed.

### Aptitude progress (no repeated questions)
Every aptitude question a student is **shown**, **attempts** or answers **correctly** is stored per student in the Neon table `AptitudeAttempt`
(`/api/aptitude/progress`, migration `20260928000000_add_aptitude_attempts`, applied automatically on deploy). Questions are identified by a hash of
their text, so a question is never served again to the same student - in Aptitude Practice or in the Quiz - on any device, even if the question bank
is reordered or extended. Offline progress is queued in the browser and uploaded when the connection returns. Run `npm run test:aptitude` in `backend/`.

## Manual migration (optional)
```bash
cd backend
npm install
DATABASE_URL="<neon url>" npm run migrate:deploy
```
If a previous failed attempt left a "failed migration" record (Prisma error P3009) on an empty database,
run `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` once in the Neon SQL editor, then deploy again.

## Notes
- `ai-ml-service/` (FastAPI) is a separate service and is not part of the Vercel deploy.

## Quick start (local) — everything with one command

1. Install **Node 18+**, **Python 3.9+** and **PostgreSQL** (or use a free Neon database).
2. `cd backend && npm install`
3. `npm start` — the first run creates `backend/.env` with random secrets. Open it, set `DATABASE_URL`
   (and `PORTAL_ADMIN_EMAIL` / `PORTAL_ADMIN_PASSWORD`), then run `npm start` again.
4. Open **http://localhost:8787** (use this address; opening `index.html` from disk or Live Server also works now, but 8787 is the one to use).

On every start the backend: applies the database migrations, starts the AI/ML service (first run installs its Python
packages into `ai-ml-service/.venv`, 1–3 minutes), and loads the keys the Admin saved. Nothing else has to be started.

### Admin: paste the AI keys and the AI/ML link
Sign in as Admin -> **Settings -> AI Keys & AI/ML Service**: paste the Groq and/or Gemini key (and, only if you run the AI/ML
service somewhere else, its link and token) -> **Save** -> **Test connection**. Keys are stored in the database, apply
instantly for every student and are passed on to the AI/ML service — no `.env` edit, no restart. Pasting a remote link
makes the backend use that service instead of starting its own.

### If "Create account" still does not work
The page now shows the exact reason. Typical ones: *Cannot reach the portal server* (backend not running / wrong address),
*database missing tables* (run `cd backend && npx prisma migrate deploy`), *cannot reach its database* (fix `DATABASE_URL`),
*email already exists*. Allow the camera when the browser asks: Face ID is required at sign-up.

### Vercel
The AI/ML service cannot be started by a serverless function. Deploy `ai-ml-service` separately (Render/Railway/Fly), then paste its
link and token in the Admin screen above.
