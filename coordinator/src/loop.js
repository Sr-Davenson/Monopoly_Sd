// ─────────────────────────────────────────────────────────────────────────────
// GAME LOOP de la plaza (20 Hz)
//   1. Aplica los intents de TODOS los jugadores (locales y remotos).
//   2. Broadcast del state SOLO a los clientes locales (no a los pares).
// Cada segundo el dueño de cada jugador manda su posición "oficial" a los pares
// para corregir la deriva (cada coordinador integra con su propio dt).
// ─────────────────────────────────────────────────────────────────────────────
const { config } = require('./config');
const { clients, world, peers, localBroadcast } = require('./state');
const mesh = require('./mesh');

const round2 = (n) => Math.round(n * 100) / 100;

function snapshot() {
  const out = [];
  for (const w of world.values()) {
    if (w.view !== 'canvas') continue;
    out.push({
      userId: w.userId,
      username: w.username,
      provider: w.provider,
      coordinatorId: w.coordinatorId,
      x: round2(w.x),
      y: round2(w.y),
      extras: w.extras
    });
  }
  return out;
}

let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;

  for (const w of world.values()) {
    const { x: ix, y: iy } = w.intent;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      w.x = mesh.clampX(w.x + (ix / mag) * config.PLAYER_SPEED * dt);
      w.y = mesh.clampY(w.y + (iy / mag) * config.PLAYER_SPEED * dt);
    }
  }

  let hasCanvasClient = false;
  for (const c of clients.values()) if (c.view === 'canvas') { hasCanvasClient = true; break; }
  if (hasCanvasClient) {
    localBroadcast({ type: 'state', t: now, coordinatorId: config.COORDINATOR_ID, players: snapshot() }, c => c.view === 'canvas');
  }
}

function syncPositions() {
  if (peers.size === 0) return;
  const positions = [];
  for (const [userId, c] of clients) {
    const w = world.get(userId);
    if (c.view === 'canvas' && w && w.coordinatorId === config.COORDINATOR_ID) {
      positions.push({ userId, x: round2(w.x), y: round2(w.y) });
    }
  }
  if (positions.length) mesh.toPeers({ type: 'positions_replicate', positions });
}

function start() {
  setInterval(tick, config.TICK_MS);
  setInterval(syncPositions, config.POSITION_SYNC_MS);
}

module.exports = { start };
