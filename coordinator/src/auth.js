// ─────────────────────────────────────────────────────────────────────────────
// Cliente HTTP del clúster de auth-services (Taller 7)
//
// AUTH_URLS es una LISTA. Para cada petición:
//   · se prueba primero el último auth que respondió bien (o el líder, si la
//     petición es una escritura: heartbeat, leave, match-result);
//   · error de red o 5xx → se prueba el siguiente de la lista;
//   · 503 { error: 'not_leader', leaderUrl } → se repite directo contra leaderUrl;
//   · 503 { error: 'no_leader' } (elección en curso) → siguiente; si nadie
//     puede, la petición falla y el ciclo siguiente (1 s después) reintenta.
// ─────────────────────────────────────────────────────────────────────────────
const { config } = require('./config');

const HEADERS = { 'ngrok-skip-browser-warning': 'true' };
const clean = (u) => String(u).replace(/\/+$/, '');

// ── Descubrimiento de los demás auths ─────────────────────────────────────────
// Basta con UNA URL en AUTH_URLS: cada vez que un auth responde se le pide
// GET /peers (cada 15 s como mucho), que trae la URL pública de todos los del
// clúster. Si el auth de siempre se cae, el coordinador ya conoce a los demás.
// Las del .env van primero y nunca se quitan; las descubiertas se reemplazan.
const CONFIGURED = [...config.AUTH_URLS];
const DISCOVER_EVERY_MS = 15000;
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
let discovered = [];
let lastDiscover = 0;

async function discover(fromUrl) {
  if (Date.now() - lastDiscover < DISCOVER_EVERY_MS) return;
  lastDiscover = Date.now();
  try {
    const res = await fetch(`${fromUrl}/peers`, { headers: HEADERS, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return;
    const { peers = [] } = await res.json();
    // URLs localhost de otro PC no sirven aquí, salvo que el .env ya use localhost
    const localOk = CONFIGURED.some(isLocalUrl);
    const urls = peers.map(p => p && p.publicUrl).filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
      .map(clean).filter(u => localOk || !isLocalUrl(u));
    if (!urls.length) return;
    const added = urls.filter(u => !config.AUTH_URLS.includes(u));
    discovered = urls;
    config.AUTH_URLS.splice(0, config.AUTH_URLS.length, ...new Set([...CONFIGURED, ...discovered]));
    if (added.length) console.log(`[AUTH] Auths descubiertos: ${added.join(', ')}`);
  } catch { /* se reintenta en el próximo ciclo */ }
}

const state = {
  current: config.AUTH_URLS[0],   // último auth que respondió
  currentId: null,
  leaderUrl: null,                // líder conocido (para escrituras)
  leaderId: null,
  lastError: null
};

function remember(url, res) {
  const id = res.headers.get('x-auth-id');
  const role = res.headers.get('x-auth-role');
  state.current = url;
  state.currentId = id || null;
  if (role === 'leader') {
    if (state.leaderUrl !== url) console.log(`[AUTH] Líder del clúster de auth: ${id || url} (${url})`);
    state.leaderUrl = url;
    state.leaderId = id || null;
  }
}

// Respuesta: { ok, status, data, url, authId }
async function authFetch(path, { method = 'GET', headers = {}, body, leader = false, timeout = 2500 } = {}) {
  const first = leader && state.leaderUrl ? state.leaderUrl : state.current;
  const queue = [first, ...config.AUTH_URLS.filter(u => u !== first)];
  const tried = new Set();
  let last = null;
  let lastErr = null;

  while (queue.length && tried.size < config.AUTH_URLS.length + 3) {
    const url = clean(queue.shift());
    if (tried.has(url)) continue;
    tried.add(url);

    let res;
    try {
      res = await fetch(`${url}${path}`, {
        method,
        headers: { ...HEADERS, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout)
      });
    } catch (err) {
      lastErr = `${url}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`;
      continue;                                  // error de red → siguiente
    }
    const data = await res.json().catch(() => ({}));
    const out = { ok: res.ok, status: res.status, data, url, authId: res.headers.get('x-auth-id') };

    if (res.status === 503 && data.error === 'not_leader' && data.leaderUrl) {
      if (state.leaderUrl !== clean(data.leaderUrl)) console.log(`[AUTH] ${out.authId || url} no es líder → reintento en ${data.leaderId || ''} ${data.leaderUrl}`);
      state.leaderUrl = clean(data.leaderUrl);
      state.leaderId = data.leaderId || null;
      queue.unshift(state.leaderUrl);           // directo contra el líder
      last = out;
      continue;
    }
    if (res.status >= 500) {                     // 5xx (incl. no_leader) → siguiente
      if (data.error === 'no_leader' && leader) { state.leaderUrl = null; state.leaderId = null; }
      if (data.error === 'replication_timeout') { remember(url, res); return out; }   // no reintentar una escritura
      last = out;
      lastErr = `${out.authId || url}: ${res.status}${data.error ? ' ' + data.error : ''}`;
      continue;
    }
    remember(url, res);
    state.lastError = null;
    discover(url);
    return out;
  }

  state.lastError = lastErr || (last ? `HTTP ${last.status}` : 'sin respuesta');
  if (last) return last;
  const err = new Error(`ningún auth-service respondió (${state.lastError})`);
  err.network = true;
  throw err;
}

function describe() {
  return {
    urls: config.AUTH_URLS,
    current: state.current,
    currentId: state.currentId,
    leaderUrl: state.leaderUrl,
    leaderId: state.leaderId,
    lastError: state.lastError
  };
}

module.exports = { authFetch, describe };
