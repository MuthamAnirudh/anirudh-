// Password-recovery e-mail delivery (EmailJS REST API, called from the server).
//
// Configuration is resolved in this order:
//   1. Environment variables (Vercel -> Settings -> Environment Variables):
//        RECOVERY_EMAILJS_SERVICE_ID / _TEMPLATE_ID / _PUBLIC_KEY / _PRIVATE_KEY
//      (the shorter EMAILJS_SERVICE_ID / EMAILJS_TEMPLATE_ID / EMAILJS_PUBLIC_KEY /
//       EMAILJS_PRIVATE_KEY names are accepted too)
//   2. The values an Admin saved from the portal's Settings screen. Those are stored in the
//      Neon database (PortalKV scope "system", never readable through /api/storage).
//
// IMPORTANT (EmailJS rule): the REST API is only accepted from a server when
//   - "Allow EmailJS API for non-browser applications" is ON  (EmailJS -> Account -> Security)
//   - the request carries the account PRIVATE key (accessToken)
// Without those two, EmailJS answers 403 and no mail is sent. Errors are therefore surfaced
// (server log + admin test endpoint) instead of being silently swallowed.
const prisma = require('../db');

const SYSTEM_SCOPE = 'system';
const SYSTEM_OWNER = 'SYSTEM';
const CONFIG_KEY = 'emailjs-config';

const clean = (v) => String(v == null ? '' : v).trim();
const pick = (...names) => { for (const n of names) { const v = clean(process.env[n]); if (v) return v; } return ''; };

async function loadStoredConfig() {
  try {
    const row = await prisma.portalKV.findFirst({ where: { scope: SYSTEM_SCOPE, key: CONFIG_KEY, ownerId: SYSTEM_OWNER } });
    return row && row.value && typeof row.value === 'object' ? row.value : {};
  } catch (_) { return {}; }
}

async function resolveConfig() {
  const stored = await loadStoredConfig();
  const cfg = {
    serviceId: pick('RECOVERY_EMAILJS_SERVICE_ID', 'EMAILJS_SERVICE_ID') || clean(stored.serviceId),
    templateId: pick('RECOVERY_EMAILJS_TEMPLATE_ID', 'EMAILJS_TEMPLATE_ID') || clean(stored.templateId),
    publicKey: pick('RECOVERY_EMAILJS_PUBLIC_KEY', 'EMAILJS_PUBLIC_KEY') || clean(stored.publicKey),
    privateKey: pick('RECOVERY_EMAILJS_PRIVATE_KEY', 'EMAILJS_PRIVATE_KEY') || clean(stored.privateKey),
  };
  const missing = [];
  if (!cfg.serviceId) missing.push('service id');
  if (!cfg.templateId) missing.push('template id');
  if (!cfg.publicKey) missing.push('public key');
  if (!cfg.privateKey) missing.push('private key (required for server-side sending)');
  cfg.missing = missing;
  cfg.configured = !!(cfg.serviceId && cfg.templateId && cfg.publicKey);
  return cfg;
}

async function saveStoredConfig(input) {
  const old = await loadStoredConfig();
  const next = { ...old };
  for (const f of ['serviceId', 'templateId', 'publicKey', 'privateKey']) {
    if (input[f] !== undefined) {
      const v = clean(input[f]).slice(0, 300);
      // An empty private key in the form means "keep the one already saved".
      if (f === 'privateKey' && !v) continue;
      if (v) next[f] = v; else delete next[f];
    }
  }
  await prisma.portalKV.upsert({
    where: { scope_key_ownerId: { scope: SYSTEM_SCOPE, key: CONFIG_KEY, ownerId: SYSTEM_OWNER } },
    create: { scope: SYSTEM_SCOPE, key: CONFIG_KEY, ownerId: SYSTEM_OWNER, value: next },
    update: { value: next },
  });
  return next;
}

function hintFor(status, text) {
  const t = String(text || '').toLowerCase();
  if (status === 403 && /non-browser|browser/.test(t)) return 'EmailJS blocks server calls. In EmailJS open Account -> Security and switch ON "Allow EmailJS API for non-browser applications", and make sure the Private Key is set.';
  if (status === 403) return 'EmailJS rejected the request (403). Check the Private Key and that "Allow EmailJS API for non-browser applications" is ON in Account -> Security.';
  if (status === 400 && /template/.test(t)) return 'EmailJS could not find the template. Re-check the Template ID (it starts with "template_").';
  if (status === 400 && /service/.test(t)) return 'EmailJS could not find the service. Re-check the Service ID (it starts with "service_").';
  if (status === 400 && /recipient|address|to_email|empty/.test(t)) return 'The recipient is empty. In the EmailJS template set the "To Email" field to {{to_email}}.';
  if (status === 400) return 'EmailJS returned 400. Verify Service ID, Template ID and Public Key belong to the same EmailJS account.';
  if (status === 401 || status === 412) return 'EmailJS authentication failed. Check the Public Key and Private Key, and reconnect the e-mail service in EmailJS if it shows "expired".';
  if (status === 402 || status === 429) return 'EmailJS quota or rate limit reached (free plan is 200 mails/month).';
  return 'EmailJS could not send the mail.';
}

// Sends the 6-digit code. Resolves { ok:true } or throws an Error with .status/.detail/.hint.
async function sendRecoveryCode(toEmail, code, opts = {}) {
  const cfg = opts.config || await resolveConfig();
  if (!cfg.configured) {
    const e = new Error('Password recovery e-mail is not configured on the server.');
    e.code = 'NOT_CONFIGURED'; e.hint = `Missing: ${cfg.missing.join(', ')}.`;
    throw e;
  }
  const params = {
    // Every common variable name is supplied so the template works whichever names it uses.
    to_email: toEmail, email: toEmail, user_email: toEmail, recipient: toEmail, reply_to: toEmail,
    to_name: opts.name || toEmail.split('@')[0], name: opts.name || toEmail.split('@')[0],
    passcode: code, code, otp: code, token: code, verification_code: code,
    purpose: opts.purpose || 'password reset', expires_in: opts.expiresIn || '10 minutes',
    subject: opts.subject || 'Your password reset code',
    message: opts.message || `Your password reset code is ${code}. It expires in ${opts.expiresIn || '10 minutes'}. If you did not request it, ignore this mail.`,
  };
  const body = { service_id: cfg.serviceId, template_id: cfg.templateId, user_id: cfg.publicKey, template_params: params };
  if (cfg.privateKey) body.accessToken = cfg.privateKey;
  let response;
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
    response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined,
    });
    if (timer) clearTimeout(timer);
  } catch (err) {
    const e = new Error('Could not reach EmailJS.'); e.code = 'NETWORK'; e.detail = String(err && err.message || err);
    e.hint = 'The server could not connect to api.emailjs.com.'; throw e;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const e = new Error(`EmailJS responded HTTP ${response.status}`);
    e.code = 'PROVIDER'; e.status = response.status; e.detail = text.slice(0, 300); e.hint = hintFor(response.status, text);
    throw e;
  }
  return { ok: true };
}

module.exports = { resolveConfig, saveStoredConfig, sendRecoveryCode };
