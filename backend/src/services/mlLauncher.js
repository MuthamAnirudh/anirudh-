'use strict';
// Starts the FastAPI AI/ML service (../ai-ml-service) automatically when the backend starts, so
// "npm start" in backend/ is all that is needed for every AI feature.
//
//  * If the AI/ML link (env or Admin -> Settings -> AI Keys & Services) points at a REMOTE host, nothing is started -
//    that service is used as-is (external).
//  * If a service already answers on the configured local address (you started it yourself), it is reused.
//  * Otherwise Python is located, a virtual environment (ai-ml-service/.venv) is created and the requirements are
//    installed ONCE (first start only), then uvicorn is launched and supervised (auto-restart with back-off).
//
// Disable with AI_ML_AUTOSTART=false (or the "start automatically" switch in the Admin screen).
// Never runs on Vercel / serverless (the FastAPI service is a separate deployment there).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const aiRuntime = require('./aiRuntime');

const ML_DIR = path.join(__dirname, '..', '..', '..', 'ai-ml-service');
const IS_WIN = process.platform === 'win32';
const REQUIRED_IMPORTS = 'import fastapi, uvicorn, httpx, multipart, numpy, pypdf, docx';
const MAX_RESTARTS = 5;

const st = {
  state: 'idle', // idle | disabled | missing | external | installing | starting | running | error | stopped
  managed: false, pid: null, lastError: '', restarts: 0, python: '', startedAt: null, log: [],
};
let child = null;
let stopping = false;
let ensuring = null;
let restartTimer = null;

function log(line, level = 'info') {
  const text = String(line).replace(/\r/g, '').trimEnd();
  if (!text) return;
  st.log.push(text);
  if (st.log.length > 60) st.log.splice(0, st.log.length - 60);
  (level === 'error' ? console.error : console.log)(`[ai-ml] ${text}`);
}

async function probe(url, timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    return j && j.status === 'ok' ? j : null;
  } catch (_) { return null; }
}

function runQuiet(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(cmd, args, { cwd: ML_DIR, windowsHide: true, ...opts }); } catch (e) { return resolve({ code: -1, out: String(e.message) }); }
    p.stdout && p.stdout.on('data', (d) => { out += d; });
    p.stderr && p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

function streamed(cmd, args, label) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { cwd: ML_DIR, windowsHide: true }); } catch (e) { return resolve(-1); }
    const pipe = (d) => String(d).split('\n').forEach((l) => { if (l.trim()) log(`${label}: ${l.slice(0, 200)}`); });
    p.stdout.on('data', pipe); p.stderr.on('data', pipe);
    p.on('error', (e) => { log(`${label}: ${e.message}`, 'error'); resolve(-1); });
    p.on('close', (code) => resolve(code));
  });
}

async function findPython() {
  const custom = String(process.env.AI_ML_PYTHON || '').trim();
  const venvPy = IS_WIN ? path.join(ML_DIR, '.venv', 'Scripts', 'python.exe') : path.join(ML_DIR, '.venv', 'bin', 'python');
  const candidates = [];
  if (custom) candidates.push([custom, []]);
  if (fs.existsSync(venvPy)) candidates.push([venvPy, []]);
  if (IS_WIN) candidates.push(['py', ['-3']], ['python', []], ['python3', []]);
  else candidates.push(['python3', []], ['python', []]);
  for (const [cmd, pre] of candidates) {
    const r = await runQuiet(cmd, [...pre, '-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])']);
    const v = Number(String(r.out).trim().split('\n').pop());
    if (r.code === 0 && v >= 309) return { cmd, pre, version: v, isVenv: cmd === venvPy };
  }
  return null;
}

async function hasDeps(py) {
  const r = await runQuiet(py.cmd, [...py.pre, '-c', REQUIRED_IMPORTS]);
  return r.code === 0;
}

async function prepareInterpreter() {
  const py = await findPython();
  if (!py) throw new Error('Python 3.9+ was not found. Install Python from https://www.python.org/downloads/ (tick "Add to PATH"), then restart the backend - or set AI_ML_PYTHON to your python executable.');
  if (await hasDeps(py)) return py;
  if (String(process.env.AI_ML_AUTOINSTALL || '').toLowerCase() === 'false') {
    throw new Error(`Python packages for the AI/ML service are missing. Run:  cd ai-ml-service && ${py.cmd} -m pip install -r requirements.txt`);
  }
  st.state = 'installing';
  log('First start: installing the AI/ML service packages into ai-ml-service/.venv (one-time, 1-3 minutes)...');
  const venvDir = path.join(ML_DIR, '.venv');
  const venvPy = IS_WIN ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
  if (!fs.existsSync(venvPy)) {
    const c = await streamed(py.cmd, [...py.pre, '-m', 'venv', venvDir], 'venv');
    if (c !== 0) throw new Error('Could not create the Python virtual environment (ai-ml-service/.venv). On Linux install python3-venv, then restart the backend.');
  }
  const pip = await streamed(venvPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt'], 'pip');
  if (pip !== 0) throw new Error('pip could not install ai-ml-service/requirements.txt (see the [ai-ml] log lines above). Check your internet connection and restart the backend.');
  const ready = { cmd: venvPy, pre: [], version: py.version, isVenv: true };
  if (!(await hasDeps(ready))) throw new Error('The AI/ML packages were installed but could not be imported. Delete ai-ml-service/.venv and restart the backend.');
  log('AI/ML packages installed.');
  return ready;
}

function childEnv(port) {
  const ml = aiRuntime.getMl();
  const env = { ...process.env };
  // Never hand the portal's own secrets to the AI/ML process.
  for (const k of ['DATABASE_URL', 'DIRECT_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'OPERATIONS_TOKEN', 'PORTAL_ADMIN_PASSWORD']) delete env[k];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), ENV: 'development', AI_ML_SERVICE_TOKEN: ml.token,
    PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', CORS_ORIGINS: env.AI_ML_CORS_ORIGINS || '*',
  });
  // Only set non-empty values: an empty variable would shadow the same key in ai-ml-service/.env.
  const map = { GROQ_API_KEY: ml.headers['x-groq-key'], GEMINI_API_KEY: ml.headers['x-gemini-key'], GROQ_MODEL: ml.headers['x-groq-model'], GEMINI_MODEL: ml.headers['x-gemini-model'] };
  for (const [k, v] of Object.entries(map)) if (v) env[k] = v;
  return env;
}

function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(String(hostname).toLowerCase());
}

async function spawnService(py, port) {
  return new Promise((resolve) => {
    const args = [...py.pre, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'];
    log(`Starting the AI/ML service on http://127.0.0.1:${port} ...`);
    st.state = 'starting';
    try {
      child = spawn(py.cmd, args, { cwd: ML_DIR, env: childEnv(port), windowsHide: true });
    } catch (e) { st.state = 'error'; st.lastError = e.message; return resolve(false); }
    st.managed = true; st.pid = child.pid; st.startedAt = new Date().toISOString();
    const pipe = (d) => String(d).split('\n').forEach((l) => { if (l.trim()) log(l.slice(0, 240)); });
    child.stdout.on('data', pipe); child.stderr.on('data', pipe);
    child.on('error', (e) => { st.lastError = e.message; log(`process error: ${e.message}`, 'error'); });
    child.on('close', (code) => {
      const was = child; child = null; st.pid = null;
      if (stopping) { st.state = 'stopped'; return; }
      st.lastError = `AI/ML service exited (code ${code}).`;
      log(st.lastError, 'error');
      if (st.restarts < MAX_RESTARTS) {
        st.restarts += 1; st.state = 'starting';
        restartTimer = setTimeout(() => { ensure().catch(() => {}); }, Math.min(30000, 1500 * 2 ** st.restarts));
      } else { st.state = 'error'; st.lastError += ' Giving up after several restarts - check the [ai-ml] log lines above.'; }
      void was;
    });
    // Wait until /health answers (models/dependencies can take a few seconds to import).
    const url = `http://127.0.0.1:${port}`;
    let tries = 0;
    const wait = async () => {
      if (!child) return resolve(false);
      if (await probe(url, 1500)) { st.state = 'running'; st.restarts = 0; st.lastError = ''; log(`AI/ML service is ready at ${url}`); return resolve(true); }
      if (++tries > 60) { st.lastError = 'The AI/ML service did not become ready within 60 seconds.'; st.state = 'error'; return resolve(false); }
      setTimeout(wait, 1000);
    };
    wait();
  });
}

async function ensure() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      if (!aiRuntime.autostartEnabled()) { st.state = 'disabled'; return st; }
      if (!fs.existsSync(path.join(ML_DIR, 'app', 'main.py'))) { st.state = 'missing'; st.lastError = 'The ai-ml-service folder was not found next to backend/.'; return st; }
      stopping = false;
      const { url } = aiRuntime.getMl();
      let u; try { u = new URL(url); } catch (_) { st.state = 'error'; st.lastError = `Invalid AI/ML service link: ${url}`; return st; }
      if (!isLocalHost(u.hostname)) { st.state = 'external'; st.managed = false; return st; }
      if (child) return st;
      if (await probe(url)) { st.state = 'running'; st.managed = false; st.lastError = ''; log(`Using the AI/ML service already running at ${url}`); return st; }
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      const py = await prepareInterpreter();
      st.python = py.cmd;
      await spawnService(py, port);
      return st;
    } catch (e) {
      st.state = 'error'; st.lastError = String((e && e.message) || e);
      log(st.lastError, 'error');
      return st;
    } finally { ensuring = null; }
  })();
  return ensuring;
}

async function stop() {
  stopping = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) {
    const c = child;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (_) {} resolve(); }, 4000);
      c.once('close', () => { clearTimeout(t); resolve(); });
      try { c.kill(); } catch (_) { clearTimeout(t); resolve(); }
    });
  }
  child = null; st.pid = null; st.managed = false;
}

async function restart() { await stop(); st.restarts = 0; return ensure(); }

async function status() {
  const { url } = aiRuntime.getMl();
  const health = st.state === 'installing' ? null : await probe(url, 1500);
  return {
    state: health ? (st.state === 'external' ? 'external' : 'running') : st.state,
    healthy: !!health, llmConfigured: !!(health && health.llm_configured),
    managed: st.managed, url, pid: st.pid, restarts: st.restarts,
    lastError: health ? '' : st.lastError, python: st.python, log: st.log.slice(-15),
  };
}

// Node exits -> make sure the child does not linger as an orphan.
process.on('exit', () => { if (child) { try { child.kill(); } catch (_) { /* ignore */ } } });

module.exports = { ensure, stop, restart, status, probe };
