'use strict';
// Runtime AI configuration — what an Admin pastes into  Admin -> Settings -> AI Keys & Services.
//
//   * Groq / Gemini API keys (+ optional model names, provider order)
//   * The AI/ML (FastAPI) service link and its shared token
//
// Resolution order (per field):  value saved by the Admin (stored in the database)  ->  environment
// variable / backend/.env  ->  built-in default.  An Admin action is the most recent intent, so it wins over
// a stale .env value. Keys are applied LIVE (no restart) by mutating the objects server.js already reads
// (KEYS / MODELS / PROVIDER_PRIORITY), and are forwarded to the AI/ML service on every gateway call, so a
// key pasted once is used by /api/ai *and* by every /api/ai-ml feature.
//
// Storage: PortalKV scope "system" (never exposed through /api/storage), same place as the e-mail settings.
const crypto = require('crypto');
const prisma = require('../db');

const SCOPE = 'system';
const OWNER = 'SYSTEM';
const CONFIG_KEY = 'ai-runtime-config';
const PROVIDERS = ['groq', 'gemini'];

const clean = (v) => String(v == null ? '' : v).trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const maskKey = (v) => (v ? `${String(v).slice(0, 4)}••••${String(v).slice(-3)}` : '');

const refs = { KEYS: null, MODELS: null, ORDER: null };
const envDefaults = { keys: {}, models: {}, order: [] };
const state = {
  stored: {},
  loaded: false,
  loadError: '',
  // Used only when neither the Admin nor the environment provided a token: a random per-process secret that
  // is shared with the AI/ML service this backend starts itself, so it is never an open, unauthenticated API.
  ephemeralToken: crypto.randomBytes(24).toString('hex'),
};
const listeners = new Set();

function bind({ KEYS, MODELS, PROVIDER_PRIORITY }) {
  refs.KEYS = KEYS; refs.MODELS = MODELS; refs.ORDER = PROVIDER_PRIORITY;
  envDefaults.keys = { ...KEYS };
  envDefaults.models = { ...MODELS };
  envDefaults.order = [...PROVIDER_PRIORITY];
  apply();
}

function envMl() {
  return {
    url: clean(process.env.AI_ML_SERVICE_URL),
    token: clean(process.env.AI_ML_SERVICE_TOKEN),
  };
}

// Accept whatever the Admin pastes: "http://127.0.0.1:8000/", ".../docs", "127.0.0.1:8000", ...
function normalizeServiceUrl(input) {
  let v = clean(input);
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  let u;
  try { u = new URL(v); } catch (_) { throw new Error('The AI/ML service link is not a valid URL (example: http://127.0.0.1:8000).'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The AI/ML service link must start with http:// or https://.');
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/(docs|redoc|health|openapi\.json)$/i, '');
  return `${u.origin}${p}`;
}

function apply() {
  if (!refs.KEYS) return;
  const s = state.stored || {};
  for (const p of PROVIDERS) {
    refs.KEYS[p] = clean(s[`${p}Key`]) || envDefaults.keys[p] || '';
    refs.MODELS[p] = clean(s[`${p}Model`]) || envDefaults.models[p] || refs.MODELS[p];
  }
  const order = Array.isArray(s.providerOrder) ? s.providerOrder.filter((p) => PROVIDERS.includes(p)) : [];
  const next = order.length ? [...new Set([...order, ...PROVIDERS])] : envDefaults.order;
  refs.ORDER.splice(0, refs.ORDER.length, ...next);
}

async function load() {
  try {
    const row = await prisma.portalKV.findFirst({ where: { scope: SCOPE, key: CONFIG_KEY, ownerId: OWNER } });
    state.stored = row && row.value && typeof row.value === 'object' ? row.value : {};
    state.loadError = '';
  } catch (e) {
    state.stored = state.stored || {};
    state.loadError = String((e && e.message) || e).split('\n').filter(Boolean).pop();
  }
  state.loaded = true;
  state.lastLoad = Date.now();
  apply();
  return state.stored;
}

// Serverless (Vercel) instances start cold and never run the boot sequence, and an Admin may save from a different
// instance - so re-read the stored config lazily (at most every `maxAgeMs`) before serving AI requests there.
async function ensureFresh(maxAgeMs = 30000) {
  const serverless = !!process.env.VERCEL;
  if (!state.loaded || (serverless && Date.now() - (state.lastLoad || 0) > maxAgeMs)) await load();
}

function sourceOf(field, envValue) {
  if (clean(state.stored[field])) return 'admin';
  return envValue ? 'environment' : 'none';
}

// ---- values other modules consume -------------------------------------------------------------
function getMl() {
  const env = envMl();
  const url = clean(state.stored.aiMlUrl) || env.url || 'http://127.0.0.1:8000';
  const token = clean(state.stored.aiMlToken) || env.token || state.ephemeralToken;
  const headers = {};
  if (refs.KEYS) {
    if (refs.KEYS.groq) headers['x-groq-key'] = refs.KEYS.groq;
    if (refs.KEYS.gemini) headers['x-gemini-key'] = refs.KEYS.gemini;
    if (refs.MODELS && refs.MODELS.groq) headers['x-groq-model'] = refs.MODELS.groq;
    if (refs.MODELS && refs.MODELS.gemini) headers['x-gemini-model'] = refs.MODELS.gemini;
  }
  return { url: url.replace(/\/+$/, ''), token, headers, tokenSource: clean(state.stored.aiMlToken) ? 'admin' : env.token ? 'environment' : 'generated' };
}

function autostartEnabled() {
  if (process.env.VERCEL) return false;
  if (String(process.env.AI_ML_AUTOSTART || '').toLowerCase() === 'false') return false;
  if (state.stored.aiMlAutostart === false) return false;
  return true;
}

// ---- Admin API --------------------------------------------------------------------------------
function publicView() {
  const env = envMl();
  return {
    groq: {
      set: !!refs.KEYS?.groq, masked: maskKey(refs.KEYS?.groq), source: sourceOf('groqKey', envDefaults.keys.groq),
      model: refs.MODELS?.groq || '',
    },
    gemini: {
      set: !!refs.KEYS?.gemini, masked: maskKey(refs.KEYS?.gemini), source: sourceOf('geminiKey', envDefaults.keys.gemini),
      model: refs.MODELS?.gemini || '',
    },
    providerOrder: [...(refs.ORDER || [])],
    aiMl: {
      url: getMl().url,
      urlSource: clean(state.stored.aiMlUrl) ? 'admin' : env.url ? 'environment' : 'default',
      tokenSet: true,
      tokenSource: getMl().tokenSource,
      autostart: autostartEnabled(),
    },
    persisted: state.loaded && !state.loadError,
    loadError: state.loadError,
  };
}

async function save(input = {}) {
  const old = state.stored || {};
  const next = { ...old };
  const changed = { ml: false, keys: false };

  for (const p of PROVIDERS) {
    const kf = `${p}Key`, mf = `${p}Model`;
    if (input[kf] !== undefined) {
      const v = clean(input[kf]).slice(0, 400);
      // Blank = "keep the key that is already saved" (the form never shows the real key back).
      if (v) {
        if (/\s/.test(v)) throw new Error(`The ${p} key contains spaces or line breaks - paste only the key itself.`);
        if (v.length < 12) throw new Error(`The ${p} key looks too short - paste the full key.`);
        next[kf] = v; changed.keys = true;
      }
    }
    if (input.clear && input.clear[kf]) { delete next[kf]; changed.keys = true; }
    if (input[mf] !== undefined) {
      const v = clean(input[mf]).slice(0, 120);
      if (v) next[mf] = v; else delete next[mf];
      changed.keys = true;
    }
  }
  if (Array.isArray(input.providerOrder)) {
    const o = input.providerOrder.map((x) => String(x).toLowerCase()).filter((x) => PROVIDERS.includes(x));
    if (o.length) next.providerOrder = [...new Set(o)]; else delete next.providerOrder;
    changed.keys = true;
  }
  if (input.aiMlUrl !== undefined) {
    const v = normalizeServiceUrl(input.aiMlUrl);
    if (v) next.aiMlUrl = v; else delete next.aiMlUrl;
    if ((old.aiMlUrl || '') !== (next.aiMlUrl || '')) changed.ml = true;
  }
  if (input.aiMlToken !== undefined) {
    const v = clean(input.aiMlToken).slice(0, 300);
    if (v) { next.aiMlToken = v; if (old.aiMlToken !== v) changed.ml = true; }
  }
  if (input.clear && input.clear.aiMlToken) { delete next.aiMlToken; changed.ml = true; }
  if (input.aiMlAutostart !== undefined) {
    if (input.aiMlAutostart === false) next.aiMlAutostart = false; else delete next.aiMlAutostart;
    changed.ml = true;
  }

  await prisma.portalKV.upsert({
    where: { scope_key_ownerId: { scope: SCOPE, key: CONFIG_KEY, ownerId: OWNER } },
    create: { scope: SCOPE, key: CONFIG_KEY, ownerId: OWNER, value: next },
    update: { value: next },
  });
  state.stored = next;
  apply();
  for (const fn of listeners) { try { fn(changed); } catch (_) { /* listener errors must not fail the save */ } }
  return { changed, view: publicView() };
}

function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { bind, load, ensureFresh, apply, save, publicView, getMl, autostartEnabled, normalizeServiceUrl, onChange, maskKey, PROVIDERS };
