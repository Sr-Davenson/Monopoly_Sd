// ─────────────────────────────────────────────────────────────────────────────
// Conexión con los coordinadores.
//
// El cliente hace dos pasos antes de jugar:
//   1. GET {AUTH_URL}/coordinator   → { coordinatorId, publicUrl }
//        · sin parámetros: el coordinador MENOS cargado (balanceo de carga)
//        · ?prefer=coord-a: ese coordinador si está vivo (anfitrión de una sala)
//        · ?exclude=coord-b: cualquiera menos el que acaba de fallar
//   2. WebSocket a {publicUrl}/connect?token=...
//
// Si el WebSocket se cae NO se reconecta directo al mismo coordinador: se
// vuelve a pedir GET /coordinator (con ?exclude=<el que falló>).
//
// Cierre 4010 ("host:<id>"): la sala pedida la atiende otro coordinador. El
// cliente se cambia a ese coordinador automáticamente (onRedirect).
//
// Cierre 4011 ("move:<id>"): el balanceador de carga reparte jugadores porque
// entró o salió un coordinador. El cliente se cambia a ese coordinador.
//
// Los cierres 4001 (token inválido), 4002 (sesión duplicada), 4003 (token
// manipulado) y 4004 (sala inválida) son definitivos: no se reintenta.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const cfg = window.APP_CONFIG || {};
  const AUTH_URL = (cfg.AUTH_URL || 'http://localhost:4000').replace(/\/+$/, '');
  const HEADERS = { 'ngrok-skip-browser-warning': 'true' };
  const FATAL_CODES = new Set([4001, 4002, 4003, 4004]);
  // 4010 → la sala vive en otro coordinador · 4011 → rebalanceo de carga
  const REDIRECT = { 4010: /^host:(.+)$/, 4011: /^move:(.+)$/ };

  async function requestCoordinator({ exclude, prefer } = {}) {
    const qs = new URLSearchParams();
    if (exclude) qs.set('exclude', exclude);
    if (prefer) qs.set('prefer', prefer);
    const q = qs.toString() ? `?${qs}` : '';
    const res = await fetch(`${AUTH_URL}/coordinator${q}`, { headers: HEADERS, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function fetchProgress(token) {
    const res = await fetch(`${AUTH_URL}/me/progress`, {
      headers: { ...HEADERS, Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).stats;
  }

  // opts = {
  //   token, params: { view, room }, prefer: 'coord-a' (opcional),
  //   onStatus(state: 'connecting'|'connected'|'disconnected', text, info),
  //   onOpen(info), onMessage(msg), onFatal(code, reason), onLost(info),
  //   onRedirect(fromId, toId, reason: 'host' | 'balance')
  // }
  function connectCoordinator(opts) {
    let ws = null;
    let stopped = false;
    let attempt = 0;
    let lastFailed = null;
    let prefer = opts.prefer || null;
    let current = null;
    let retryTimer = null;
    const status = (state, text) => opts.onStatus && opts.onStatus(state, text, current);

    async function open() {
      if (stopped) return;
      attempt++;
      status('connecting', prefer
        ? `Cambiando al coordinador ${prefer}…`
        : attempt > 1 ? `Pidiendo coordinador al auth (intento ${attempt})…` : 'Pidiendo coordinador…');

      let info;
      try {
        info = await requestCoordinator({ exclude: lastFailed, prefer });
      } catch (err) {
        status('connecting', err.status === 503
          ? 'No hay coordinadores vivos. Reintentando…'
          : 'Auth-service no disponible. Reintentando…');
        return retry();
      }
      if (stopped) return;
      current = info;
      console.log(`[NET] GET /coordinator${prefer ? ` (prefer ${prefer})` : ''} → ${info.coordinatorId} (${info.publicUrl})`);
      status('connecting', `Conectando a ${info.coordinatorId}…`);

      const qs = new URLSearchParams({ ...(opts.params || {}), token: opts.token });
      let opened = false;
      try {
        ws = new WebSocket(`${info.publicUrl.replace(/\/+$/, '')}/connect?${qs}`);
      } catch {
        lastFailed = info.coordinatorId;
        if (prefer === info.coordinatorId) prefer = null;
        return retry();
      }

      ws.onopen = () => {
        opened = true;
        attempt = 0;
        lastFailed = null;
        status('connected', 'Conectado');
        opts.onOpen && opts.onOpen(info);
      };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        opts.onMessage && opts.onMessage(msg);
      };

      ws.onclose = (event) => {
        if (stopped) return;
        if (FATAL_CODES.has(event.code)) {
          stopped = true;
          return opts.onFatal && opts.onFatal(event.code, event.reason);
        }

        // Cambio de coordinador ordenado por el servidor (sala o balanceo)
        const m = REDIRECT[event.code] && String(event.reason || '').match(REDIRECT[event.code]);
        if (m) {
          const target = m[1];
          const why = event.code === 4010 ? 'host' : 'balance';
          console.log(`[NET] ${info.coordinatorId} → ${target} (${why === 'host' ? 'anfitrión de la sala' : 'rebalanceo de carga'})`);
          prefer = target;
          lastFailed = null;
          status('connecting', `Cambiando de ${info.coordinatorId} a ${target}…`);
          opts.onRedirect && opts.onRedirect(info.coordinatorId, target, why);
          return retry(true);
        }

        // Volver a preguntar al auth, sin repetir el coordinador que falló
        lastFailed = info.coordinatorId;
        if (prefer === info.coordinatorId) prefer = null;
        console.warn(`[NET] Se perdió ${info.coordinatorId} (código ${event.code}). Pidiendo otro coordinador…`);
        status('disconnected', `Se perdió ${info.coordinatorId}. Buscando otro…`);
        opts.onLost && opts.onLost(info);
        retry(opened);
      };
    }

    function retry(fast) {
      clearTimeout(retryTimer);
      const delay = fast ? 400 : Math.min(800 * attempt, 4000);
      retryTimer = setTimeout(open, delay);
    }

    open();

    return {
      send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
        return false;
      },
      close(code = 1000, reason = 'bye') {
        stopped = true;
        clearTimeout(retryTimer);
        if (ws && ws.readyState <= WebSocket.OPEN) ws.close(code, reason);
      },
      isOpen: () => !!ws && ws.readyState === WebSocket.OPEN,
      get info() { return current; }
    };
  }

  // Redirección al login conservando (o no) la sesión
  let redirecting = false;
  function goToLogin(message, keepSession = false) {
    if (redirecting) return;
    redirecting = true;
    if (!keepSession) {
      localStorage.removeItem('token');
      localStorage.removeItem('username');
    }
    if (message) sessionStorage.setItem('session_message', message);
    window.location.replace('login.html');
  }

  const FATAL_MESSAGES = {
    4001: 'Sesión terminada: token inválido o expirado. Vuelve a iniciar sesión.',
    4002: 'Tu sesión se abrió en otra pestaña o dispositivo.',
    4003: 'Sesión cerrada: se detectó una modificación no autorizada del token de sesión.',
    4004: 'Esa sala no existe.'
  };

  window.Net = { AUTH_URL, requestCoordinator, fetchProgress, connectCoordinator, goToLogin, FATAL_MESSAGES };
})();
