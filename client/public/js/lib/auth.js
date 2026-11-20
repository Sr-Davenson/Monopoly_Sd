// ─────────────────────────────────────────────────────────────────────────────
// Cliente del clúster de auth-services (Taller 7)
//
// APP_CONFIG.AUTH_URLS = ['http://localhost:4001', 'http://localhost:4002', ...]
//
// Cada petición:
//   · empieza por el último auth que respondió bien (o por el líder conocido
//     si es una escritura como /register);
//   · error de red o 5xx → prueba el siguiente de la lista;
//   · 503 { error: 'not_leader', leaderUrl } → repite directo contra leaderUrl;
//   · 503 { error: 'no_leader' } → hay una elección: prueba los demás y, si
//     nadie puede, espera y reintenta unas rondas (las escrituras fallan
//     mientras no haya líder: unos segundos).
//
// La UI muestra a qué auth quedó conectado (insignia abajo a la izquierda).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const cfg = window.APP_CONFIG || {};
  const clean = (u) => String(u).trim().replace(/\/+$/, '');
  const URLS = (Array.isArray(cfg.AUTH_URLS) && cfg.AUTH_URLS.length ? cfg.AUTH_URLS
    : cfg.AUTH_URL ? String(cfg.AUTH_URL).split(',') : ['http://localhost:4001', 'http://localhost:4002', 'http://localhost:4003'])
    .map(clean).filter(Boolean);
  const HEADERS = { 'ngrok-skip-browser-warning': 'true' };
  const STORE_KEY = 'auth_node';
  const listeners = new Set();

  let node = load() || { url: URLS[0], authId: null, role: null, leaderUrl: null, leaderId: null };
  if (!URLS.includes(node.url)) node.url = URLS[0];

  function load() { try { return JSON.parse(sessionStorage.getItem(STORE_KEY)); } catch { return null; } }
  function save() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(node)); } catch { /* sin storage */ }
    listeners.forEach(fn => { try { fn(node); } catch { /* ignore */ } });
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Una ronda por todos los auths. Devuelve { ok, status, data, url, authId, role } o lanza si nadie respondió.
  async function round(path, { method, body, headers, leader }) {
    const first = leader && node.leaderUrl ? node.leaderUrl : node.url;
    const queue = [first, ...URLS.filter(u => u !== first)];
    const tried = new Set();
    let last = null;

    while (queue.length && tried.size < URLS.length + 3) {
      const url = clean(queue.shift());
      if (tried.has(url)) continue;
      tried.add(url);

      let res;
      try {
        res = await fetch(`${url}${path}`, {
          method,
          headers: { ...HEADERS, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          cache: 'no-store',
          signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
        });
      } catch {
        console.warn(`[AUTH] ${url} no responde → siguiente`);
        continue;                                   // error de red → siguiente
      }
      const data = await res.json().catch(() => ({}));
      const out = { ok: res.ok, status: res.status, data, url, authId: res.headers.get('X-Auth-Id'), role: res.headers.get('X-Auth-Role') };

      if (res.status === 503 && data.error === 'not_leader' && data.leaderUrl) {
        console.log(`[AUTH] ${out.authId || url} es réplica → reintento contra el líder ${data.leaderId || ''} ${data.leaderUrl}`);
        node.leaderUrl = clean(data.leaderUrl);
        node.leaderId = data.leaderId || null;
        queue.unshift(node.leaderUrl);
        last = out;
        continue;
      }
      if (res.status >= 500 && data.error !== 'replication_timeout') {
        console.warn(`[AUTH] ${out.authId || url} respondió ${res.status} ${data.error || ''} → siguiente`);
        last = out;
        continue;
      }
      node = { ...node, url, authId: out.authId, role: out.role };
      if (out.role === 'leader') { node.leaderUrl = url; node.leaderId = out.authId; }
      save();
      return out;
    }
    if (last) return last;
    const err = new Error('Ningún auth-service respondió');
    err.network = true;
    throw err;
  }

  // opts: { method, body, headers, leader, rounds (reintentos si hay elección), onWait(msg) }
  async function request(path, opts = {}) {
    const o = { method: 'GET', leader: false, rounds: 1, ...opts };
    let lastErr = null;
    for (let i = 0; i < o.rounds; i++) {
      try {
        const out = await round(path, o);
        const electing = out.status === 503 && (out.data.error === 'no_leader' || out.data.error === 'not_leader');
        if (!electing || i === o.rounds - 1) return out;
        o.onWait && o.onWait('Elección de líder en curso entre los auth-services. Reintentando…');
      } catch (err) {
        lastErr = err;
        if (i === o.rounds - 1) throw err;
        o.onWait && o.onWait('Ningún auth-service responde. Reintentando…');
      }
      await sleep(2000);
    }
    throw lastErr || new Error('sin respuesta');
  }

  // ── Insignia "Auth: auth-b (réplica)" ───────────────────────────────────────
  function mountBadge() {
    if (document.getElementById('auth-badge')) return;
    const b = document.createElement('div');
    b.id = 'auth-badge';
    b.className = 'auth-badge';
    b.title = `AUTH_URLS: ${URLS.join(', ')}`;
    const paint = () => {
      const role = node.role === 'leader' ? 'líder' : node.role === 'replica' ? 'réplica' : '…';
      b.dataset.role = node.role || 'unknown';
      b.textContent = `Auth: ${node.authId || node.url} (${role})`;
      b.title = `Conectado a ${node.url}\nLíder: ${node.leaderId || node.leaderUrl || 'desconocido'}\nAUTH_URLS: ${URLS.join(', ')}`;
    };
    paint();
    listeners.add(paint);
    document.body.append(b);
  }

  // Al cargar: preguntar /status para que la insignia muestre el estado real
  async function refresh() {
    try { await request('/status'); } catch { /* insignia queda como estaba */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mountBadge(); refresh(); });
  else { mountBadge(); refresh(); }

  window.AuthApi = {
    URLS,
    request,
    get current() { return { ...node }; },
    describe: () => `${node.authId || node.url}${node.role ? ` (${node.role === 'leader' ? 'líder' : 'réplica'})` : ''}`,
    onChange: (fn) => listeners.add(fn)
  };
})();
