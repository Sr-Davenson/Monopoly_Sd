// ─────────────────────────────────────────────────────────────────────────────
// DIRECTORIO: heartbeat al auth-service + descubrimiento de pares
//
// Cada 1 s:
//   POST {AUTH_URL}/heartbeat     → me anuncio (id, publicUrl, peerUrl, carga)
//   GET  {AUTH_URL}/coordinators  → lista de TODOS los coordinadores vivos
// y abro enlace con los que todavía no tengo (solo si mi id es el menor).
//
// Si la red cambió (entró o salió un coordinador), la respuesta del heartbeat
// puede traer { rebalance: { moves: [{ coordinatorId, count }] } }: mover esa
// cantidad de jugadores del LOBBY a otro coordinador (ver clients.js).
// ─────────────────────────────────────────────────────────────────────────────
const { config } = require('./config');
const { clients, directory, log } = require('./state');
const mesh = require('./mesh');
const clientSvc = require('./clients');

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
        lobbyPlayers: [...clients.values()].filter(c => c.view === 'canvas').length,
        uptime: Math.round((Date.now() - config.STARTED_AT) / 1000)
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`heartbeat respondió ${res.status}${body.error ? ': ' + body.error : ''}`);
    }
    const beat = await res.json().catch(() => ({}));
    if (beat.rebalance && Array.isArray(beat.rebalance.moves)) clientSvc.rebalance(beat.rebalance.moves);

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

// Cierre ordenado: avisar al directorio para salir de inmediato
async function leave() {
  try {
    await fetch(`${config.AUTH_URL}/leave`, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Bearer ${mesh.serviceToken()}` },
      signal: AbortSignal.timeout(1500)
    });
  } catch { /* el TTL lo descartará igual */ }
}

let running = false;
function start() {
  // Sin solaparse: si el auth tarda (ngrok), no se acumulan peticiones
  const loop = async () => {
    if (running) return;
    running = true;
    try { await cycle(); } finally { running = false; }
  };
  loop();
  setInterval(loop, config.DIRECTORY_EVERY_MS);
}

module.exports = { start, cycle, leave };
