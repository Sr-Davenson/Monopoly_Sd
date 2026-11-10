// ─────────────────────────────────────────────────────────────────────────────
// Conexión con los coordinadores (Taller 6).
//
// El cliente hace dos pasos antes de jugar:
//   1. GET {AUTH_URL}/coordinator   → { coordinatorId, publicUrl }  (el menos cargado)
//   2. WebSocket a {publicUrl}/connect?token=...
//
// Si el WebSocket se cae NO se reconecta directo al mismo coordinador: se
// vuelve a pedir GET /coordinator (con ?exclude=<el que falló>) y se conecta
// al que diga el auth-service.
//
// Los cierres 4001 (token inválido), 4002 (sesión duplicada), 4003 (token
// manipulado) y 4004 (sala inválida) son definitivos: no se reintenta.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const cfg = window.APP_CONFIG || {};
  const AUTH_URL = (cfg.AUTH_URL || 'http://localhost:4000').replace(/\/+$/, '');
  const HEADERS = { 'ngrok-skip-browser-warning': 'true' };
  const FATAL_CODES = new Set([4001, 4002, 4003, 4004]);

  async function requestCoordinator(exclude) {
    const q = exclude ? `?exclude=${encodeURIComponent(exclude)}` : '';
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
  //   token, params: { view, room },
  //   onStatus(state: 'connecting'|'connected'|'disconnected', text, info),
  //   onOpen(info), onMessage(msg), onFatal(code, reason), onLost(info)
  // }
  function connectCoordinator(opts) {
    let ws = null;
    let stopped = false;
    let attempt = 0;
    let lastFailed = null;
    let current = null;
    let retryTimer = null;
    const status = (state, text) => opts.onStatus && opts.onStatus(state, text, current);

    async function open() {
      if (stopped) return;
      attempt++;
      status('connecting', attempt > 1 ? `Pidiendo coordinador al auth (intento ${attempt})…` : 'Pidiendo coordinador…');

      let info;
      try {
        info = await requestCoordinator(lastFailed);
      } catch (err) {
        status('connecting', err.status === 503
          ? 'No hay coordinadores vivos. Reintentando…'
          : 'Auth-service no disponible. Reintentando…');
        return retry();
      }
      if (stopped) return;
      current = info;
      console.log(`[NET] GET /coordinator → ${info.coordinatorId} (${info.publicUrl})`);
      status('connecting', `Conectando a ${info.coordinatorId}…`);

      const qs = new URLSearchParams({ ...(opts.params || {}), token: opts.token });
      let opened = false;
      try {
        ws = new WebSocket(`${info.publicUrl.replace(/\/+$/, '')}/connect?${qs}`);
      } catch {
        lastFailed = info.coordinatorId;
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
        // Volver a preguntar al auth, sin repetir el coordinador que falló
        lastFailed = info.coordinatorId;
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
