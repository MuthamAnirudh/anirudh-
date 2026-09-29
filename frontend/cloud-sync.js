/*
 * Campus Portal — cloud sync (browser localStorage  <->  Neon PostgreSQL)
 *
 * WHY: most per-student data (progress, quiz history, timetables, resume draft, mock-interview
 * history, Striver progress, ...) lived only in this browser's localStorage, so it never reached
 * the database and was lost on another device / after clearing the browser.
 *
 * WHAT IT DOES (no change to any existing feature — the app keeps reading/writing localStorage):
 *   1. Every allow-listed localStorage key that changes is queued and pushed to  PUT /api/sync.
 *   2. After sign-in (or on page load while signed in) the user's saved copy is fetched from
 *      GET /api/sync and restored into localStorage. If anything was restored the page reloads
 *      ONCE so the app starts from the restored data.
 *   3. Keys already on this device but not yet in Neon are uploaded (one-time migration).
 *   4. Tokens, API keys, session flags and shared/admin caches are never synced.
 *
 * Must be loaded BEFORE the main application script.
 */
(function () {
  'use strict';
  if (window.__CP_CLOUD_SYNC__) return;
  window.__CP_CLOUD_SYNC__ = true;

  var ls;
  try { ls = window.localStorage; ls.getItem('__cp_probe__'); } catch (_) { return; }

  var origSet = Storage.prototype.setItem;
  var origRemove = Storage.prototype.removeItem;
  var origGet = Storage.prototype.getItem;

  // Keep in sync with backend/src/routes/userSync.js
  var ALLOW = [/^TNP_/, /_v\d+$/, /^CP_ADV3:/];
  var DENY = [
    /^TNP_(CURRENT_USER|SESSION_META|LOGIN_ATTEMPTS|AUDIT_LOG|DB|PUBLIC_BASE_URL|APP_BOOTED__)/,
    /^TNP_DB::/,
    /^TNP_(FACULTY_LIST|COORDINATOR_EMAILS|ADMIN_ADDED_COMPANIES)$/,
    /API_KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /EMAILJS/i
  ];
  function syncable(k) {
    k = String(k || '');
    if (!k || k.length > 180) return false;
    for (var i = 0; i < DENY.length; i++) if (DENY[i].test(k)) return false;
    for (var j = 0; j < ALLOW.length; j++) if (ALLOW[j].test(k)) return true;
    return false;
  }

  var K_USER = 'CP_SYNC_USER', K_DIRTY = 'CP_SYNC_DIRTY', K_HASH = 'CP_SYNC_HASH';
  var TOKEN = 'CP_ACCESS_TOKEN';
  var MAX_BATCH_KEYS = 40, MAX_BATCH_CHARS = 2400000;

  function readJSON(k, fb) { try { var r = origGet.call(ls, k); return r ? JSON.parse(r) : fb; } catch (_) { return fb; } }
  function writeJSON(k, v) { try { origSet.call(ls, k, JSON.stringify(v)); } catch (_) {} }
  function hash(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36) + ':' + str.length;
  }
  function apiBase() { return String(origGet.call(ls, 'AI_BACKEND_URL') || '').trim().replace(/\/+$/, ''); }
  function token() { return String(origGet.call(ls, TOKEN) || '').replace(/^"|"$/g, ''); }
  function currentEmail() {
    var u = readJSON('CP_USER', null);
    return u && u.email ? String(u.email).toLowerCase() : '';
  }
  function allSyncableKeys() {
    var out = [];
    for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (syncable(k)) out.push(k); }
    return out;
  }

  // ---- state -------------------------------------------------------------------------------
  var dirty = readJSON(K_DIRTY, {});      // key -> 'set' | 'del'  (persisted, survives reloads)
  var hashes = readJSON(K_HASH, {});      // key -> hash of last value known to be in Neon
  var ready = false;                      // true only after a successful hydrate for this user
  var hydrating = false;
  var flushing = false;
  var timer = null, firstQueuedAt = 0;
  var hadTokenAtStart = !!token();
  var startDirty = JSON.parse(JSON.stringify(dirty)); // unsynced edits from a previous session win over the server

  // ---- tiny status pill --------------------------------------------------------------------
  var pill, pillTimer;
  function showPill(text, tone) {
    try {
      if (!document.body) return;
      if (!pill) {
        pill = document.createElement('div');
        pill.setAttribute('aria-live', 'polite');
        pill.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;padding:5px 10px;border-radius:999px;font:600 11px system-ui,sans-serif;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.15);transition:opacity .25s;opacity:0';
        document.body.appendChild(pill);
      }
      pill.textContent = text;
      pill.style.background = tone === 'err' ? '#fef2f2' : '#ecfdf5';
      pill.style.color = tone === 'err' ? '#b91c1c' : '#047857';
      pill.style.opacity = '1';
      clearTimeout(pillTimer);
      pillTimer = setTimeout(function () { pill.style.opacity = '0'; }, tone === 'err' ? 4000 : 1800);
    } catch (_) {}
  }

  // ---- network -----------------------------------------------------------------------------
  function refreshToken() {
    return fetch(apiBase() + '/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('refresh'); return r.json(); })
      .then(function (d) { if (d && d.accessToken) { origSet.call(ls, TOKEN, d.accessToken); return true; } return false; })
      .catch(function () { return false; });
  }
  function api(method, body, opts) {
    opts = opts || {};
    function go() {
      var headers = { 'Content-Type': 'application/json' };
      var t = token(); if (t) headers.Authorization = 'Bearer ' + t;
      return fetch(apiBase() + '/api/sync', {
        method: method, credentials: 'include', headers: headers,
        body: body ? JSON.stringify(body) : undefined, keepalive: !!opts.keepalive
      });
    }
    return go().then(function (res) {
      if (res.status === 401) {
        return refreshToken().then(function (ok) { return ok ? go() : res; });
      }
      return res;
    });
  }

  // ---- push --------------------------------------------------------------------------------
  function markDirty(k, kind) {
    dirty[k] = kind;
    writeJSON(K_DIRTY, dirty);
    schedule();
  }
  function schedule(delay) {
    if (!ready) return;
    if (!firstQueuedAt) firstQueuedAt = Date.now();
    clearTimeout(timer);
    var wait = Math.min(delay == null ? 1500 : delay, Math.max(0, 8000 - (Date.now() - firstQueuedAt)));
    timer = setTimeout(flush, wait);
  }
  function batches(keys) {
    var out = [], cur = {}, n = 0, chars = 0;
    keys.forEach(function (k) {
      var raw = origGet.call(ls, k);
      if (raw == null) return;
      if (n >= MAX_BATCH_KEYS || (chars + raw.length > MAX_BATCH_CHARS && n > 0)) { out.push(cur); cur = {}; n = 0; chars = 0; }
      cur[k] = raw; n++; chars += raw.length;
    });
    if (n) out.push(cur);
    return out;
  }
  function flush(opts) {
    opts = opts || {};
    if (!ready || flushing || !token()) return Promise.resolve(false);
    var keys = Object.keys(dirty);
    if (!keys.length) { firstQueuedAt = 0; return Promise.resolve(true); }
    flushing = true; firstQueuedAt = 0;
    var setKeys = [], delKeys = [];
    keys.forEach(function (k) { if (dirty[k] === 'del' || origGet.call(ls, k) == null) delKeys.push(k); else setKeys.push(k); });
    var sentVersion = {}; keys.forEach(function (k) { sentVersion[k] = dirty[k]; });
    var jobs = [];
    batches(setKeys).forEach(function (items) {
      jobs.push(api('PUT', { items: items }, opts).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        Object.keys(items).forEach(function (k) { hashes[k] = hash(items[k]); if (dirty[k] === sentVersion[k]) delete dirty[k]; });
      }));
    });
    if (delKeys.length) {
      jobs.push(api('DELETE', { keys: delKeys }, opts).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        delKeys.forEach(function (k) { delete hashes[k]; delete dirty[k]; });
      }));
    }
    return Promise.all(jobs).then(function () {
      writeJSON(K_DIRTY, dirty); writeJSON(K_HASH, hashes); flushing = false;
      if (!opts.keepalive) showPill('☁ Saved to cloud', 'ok');
      if (Object.keys(dirty).length) schedule(500);
      return true;
    }).catch(function () {
      writeJSON(K_DIRTY, dirty); writeJSON(K_HASH, hashes); flushing = false;
      if (!opts.keepalive) showPill('☁ Offline — will retry', 'err');
      clearTimeout(timer); timer = setTimeout(flush, 15000);
      return false;
    });
  }

  // ---- pull (hydrate) ----------------------------------------------------------------------
  function reloadOnce() {
    try {
      var n = Number(sessionStorage.getItem('CP_SYNC_RELOADS') || 0);
      if (n >= 2) return;
      sessionStorage.setItem('CP_SYNC_RELOADS', String(n + 1));
    } catch (_) {}
    location.reload();
  }
  function hydrate(reason) {
    if (hydrating || !token()) return Promise.resolve();
    hydrating = true;
    var email = currentEmail();
    var lastUser = origGet.call(ls, K_USER) || '';
    var userSwitched = !!(email && lastUser && email !== lastUser);
    return api('GET').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var items = (data && data.items) || {};
      var changed = userSwitched;
      if (userSwitched) {
        // Different account on the same browser: drop the previous user's local copy first.
        allSyncableKeys().forEach(function (k) { origRemove.call(ls, k); });
        dirty = {}; hashes = {}; startDirty = {};
      }
      Object.keys(items).forEach(function (k) {
        if (!syncable(k)) return;
        var serverRaw = items[k].raw, localRaw = origGet.call(ls, k);
        if (localRaw === serverRaw) { hashes[k] = hash(serverRaw); return; }
        if (startDirty[k] && !userSwitched) return; // unsynced local edit from earlier — local wins, pushed below
        origSet.call(ls, k, serverRaw); hashes[k] = hash(serverRaw); delete dirty[k]; changed = true;
      });
      // One-time migration + unsynced edits: anything local that Neon doesn't have (or has differently
      // and was edited offline) is pushed.
      allSyncableKeys().forEach(function (k) {
        var raw = origGet.call(ls, k);
        if (raw == null) return;
        if (!items[k] || startDirty[k]) { if (hashes[k] !== hash(raw)) dirty[k] = 'set'; }
      });
      if (email) origSet.call(ls, K_USER, email);
      writeJSON(K_DIRTY, dirty); writeJSON(K_HASH, hashes);
      hydrating = false;
      if (changed) {
        // Stay "not ready": the running app still holds pre-restore state, and nothing it writes
        // in the next instant may be pushed over the data we just restored. Reload right away.
        showPill('☁ Restoring your saved data…', 'ok'); reloadOnce(); return;
      }
      ready = true;
      schedule(300);
    }).catch(function () {
      hydrating = false;           // stay not-ready: nothing is pushed until a hydrate succeeds
      setTimeout(function () { if (!ready && token()) hydrate('retry'); }, 20000);
    });
  }

  // ---- hooks -------------------------------------------------------------------------------
  var loginTimer = null;
  function onLogin() {
    ready = false;
    var tries = 0;
    (function attempt() {
      if (!token()) return;
      if (!currentEmail() && tries++ < 10) { loginTimer = setTimeout(attempt, 200); return; }
      try { sessionStorage.removeItem('CP_SYNC_RELOADS'); } catch (_) {}
      startDirty = JSON.parse(JSON.stringify(dirty));
      hydrate('login');
    })();
  }
  Storage.prototype.setItem = function (k, v) {
    var isLS = this === ls;
    var prevToken = isLS && k === TOKEN ? origGet.call(ls, TOKEN) : null;
    origSet.apply(this, arguments);
    if (!isLS) return;
    try {
      if (k === TOKEN) { if (!prevToken) { clearTimeout(loginTimer); loginTimer = setTimeout(onLogin, 150); } return; }
      if (!syncable(k) || !ready) return;
      var raw = String(v);
      if (hashes[k] === hash(raw)) { if (dirty[k]) { delete dirty[k]; writeJSON(K_DIRTY, dirty); } return; }
      markDirty(k, 'set');
    } catch (_) {}
  };
  Storage.prototype.removeItem = function (k) {
    var isLS = this === ls;
    origRemove.apply(this, arguments);
    if (!isLS) return;
    try {
      if (k === TOKEN) { ready = false; clearTimeout(timer); return; }   // logout
      if (!syncable(k) || !ready) return;
      if (hashes[k] === undefined && !dirty[k]) return;
      markDirty(k, 'del');
    } catch (_) {}
  };

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush({ keepalive: true });
  });
  window.addEventListener('pagehide', function () { flush({ keepalive: true }); });
  window.addEventListener('online', function () { if (!ready && token()) hydrate('online'); else flush(); });

  window.CPCloudSync = {
    flushNow: function () { return flush(); },
    status: function () { return { ready: ready, pending: Object.keys(dirty).length, user: origGet.call(ls, K_USER) || '' }; }
  };

  if (hadTokenAtStart) hydrate('load');
})();
