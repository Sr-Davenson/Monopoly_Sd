// ─────────────────────────────────────────────────────────────────────────────
// DIRECTORIO: heartbeat al auth-service + descubrimiento de pares
//
// Cada 2 s:
//   POST {AUTH_URL}/heartbeat     → me anuncio (id, publicUrl, peerUrl, carga)
//   GET  {AUTH_URL}/coordinators  → lista de TODOS los coordinadores vivos
// y abro enlace con los que todavía no tengo (solo si mi id es el menor).
// ─────────────────────────────────────────────────────────────────────────────
const { config } = require('./config');
const { clients, directory, log } = require('./state');
const mesh = require('./mesh');

const HEADERS = { 'ngrok-skip-browser-warning': 'true' };

async function cycle() {
  try {
    const res = await fetch(`${config.AUTH_URL}/heartbeat`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coordinatorId: config.COORDINATOR_ID,
        publicUrl: config.getPublicUrl(),
        peerUrl: config.getPeerUrl(),
        connectedPlayers: clients.size,
        uptime: Math.round((Date.now() - config.STARTED_AT) / 1000)
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`heartbeat respondió ${res.status}${body.error ? ': ' + body.error : ''}`);
    }

    const listRes = await fetch(`${config.AUTH_URL}/coordinators`, { headers: HEADERS, signal: AbortSignal.timeout(5000) });
    const { coordinators = [] } = await listRes.json();

    if (directory.ok !== true) log('DIRECTORY', `Registrado en ${config.AUTH_URL} (heartbeat cada ${config.DIRECTORY_EVERY_MS / 1000}s)`);
    directory.ok = true;
    directory.error = null;
    directory.list = coordinators;
    directory.updatedAt = Date.now();

    for (const c of coordinators) {
      if (!c || c.coordinatorId === config.COORDINATOR_ID) continue;   // nos filtramos
      if (mesh.shouldDial(c.coordinatorId)) mesh.connectToPeer(c.coordinatorId, c.peerUrl);
    }
  } catch (err) {
    if (directory.ok !== false) log('DIRECTORY', `Auth-service no disponible (${err.message}). Reintentando...`);
    directory.ok = false;
    directory.error = err.message;
  }
}

function start() {
  cycle();
  setInterval(cycle, config.DIRECTORY_EVERY_MS);
}

module.exports = { start, cycle };
