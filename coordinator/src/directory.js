// ─────────────────────────────────────────────────────────────────────────────
// DIRECTORIO: heartbeat al auth-service + descubrimiento de pares
//
// Cada 1 s:
//   POST {líder}/heartbeat        → me anuncio (id, publicUrl, peerUrl, carga)
//   GET  {cualquier auth}/coordinators → lista de TODOS los coordinadores vivos
// y abro enlace con los que todavía no tengo (solo si mi id es el menor).
//
// Taller 7: los auth-services están replicados (AUTH_URLS). El heartbeat es
// una escritura del directorio, así que va al LÍDER; si el líder cambia, la
// réplica que contesta 503 not_leader nos da su leaderUrl y nos reorientamos
// (ver auth.js). La lista la puede dar cualquier auth (réplicas incluidas).
//
// Si la red cambió (entró o salió un coordinador), la respuesta del heartbeat
// puede traer { rebalance: { moves: [{ coordinatorId, count }] } }: mover esa
// cantidad de jugadores del LOBBY a otro coordinador (ver clients.js).
// ─────────────────────────────────────────────────────────────────────────────
const { config } = require('./config');
const { clients, directory, log } = require('./state');
const mesh = require('./mesh');
const clientSvc = require('./clients');
const { authFetch } = require('./auth');

async function heartbeat() {
  const beat = await authFetch('/heartbeat', {
    method: 'POST',
    leader: true,
    body: {
      coordinatorId: config.COORDINATOR_ID,
      publicUrl: config.getPublicUrl(),
      peerUrl: config.getPeerUrl(),
      connectedPlayers: clients.size,
      lobbyPlayers: [...clients.values()].filter(c => c.view === 'canvas').length,
      uptime: Math.round((Date.now() - config.STARTED_AT) / 1000)
    }
  });
  if (!beat.ok) throw new Error(`heartbeat respondió ${beat.status}${beat.data.error ? ': ' + beat.data.error : ''}`);
  if (beat.data.rebalance && Array.isArray(beat.data.rebalance.moves)) clientSvc.rebalance(beat.data.rebalance.moves);
  return beat;
}

async function cycle() {
  // 1) Heartbeat al líder. Durante una elección puede fallar unos segundos:
  //    se reintenta en el siguiente ciclo sin dejar de usar la lista.
  let beatError = null;
  try {
    const beat = await heartbeat();
    if (directory.heartbeatOk !== true) log('DIRECTORY', `Heartbeat aceptado por el líder ${beat.authId || beat.url} (cada ${config.DIRECTORY_EVERY_MS / 1000}s)`);
    directory.heartbeatOk = true;
    directory.leader = beat.authId || beat.url;
  } catch (err) {
    beatError = err.message;
    if (directory.heartbeatOk !== false) log('DIRECTORY', `No se pudo latir al líder (${err.message}). Reintentando...`);
    directory.heartbeatOk = false;
  }

  // 2) Lista de coordinadores (cualquier auth la tiene)
  try {
    const list = await authFetch('/coordinators');
    if (!list.ok) throw new Error(`/coordinators respondió ${list.status}`);
    const coordinators = Array.isArray(list.data.coordinators) ? list.data.coordinators : [];

    if (directory.ok !== true) log('DIRECTORY', `Directorio disponible vía ${list.authId || list.url}`);
    directory.ok = true;
    directory.error = beatError;
    directory.list = coordinators;
    directory.updatedAt = Date.now();

    for (const c of coordinators) {
      if (!c || c.coordinatorId === config.COORDINATOR_ID) continue;   // nos filtramos
      if (mesh.shouldDial(c.coordinatorId)) mesh.connectToPeer(c.coordinatorId, c.peerUrl);
    }
  } catch (err) {
    if (directory.ok !== false) log('DIRECTORY', `Ningún auth-service disponible (${err.message}). Reintentando...`);
    directory.ok = false;
    directory.error = err.message;
  }
}

// Cierre ordenado: avisar al directorio (al líder) para salir de inmediato
async function leave() {
  try {
    await authFetch('/leave', {
      method: 'POST',
      leader: true,
      headers: { Authorization: `Bearer ${mesh.serviceToken()}` },
      timeout: 1000
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
