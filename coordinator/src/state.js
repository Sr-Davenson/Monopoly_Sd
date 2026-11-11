// ─────────────────────────────────────────────────────────────────────────────
// Estado compartido del coordinador (en memoria) y utilidades de envío.
// ─────────────────────────────────────────────────────────────────────────────
const { WebSocket } = require('ws');
const { config } = require('./config');

// Clientes conectados a ESTE coordinador:
// userId -> { userId, socket, username, provider, view, roomId, token, connectedAt }
const clients = new Map();

// Mundo replicado: TODOS los jugadores de la mesh (locales y remotos).
// userId -> { userId, username, provider, view, roomId, coordinatorId, since,
//             x, y, intent: {x,y}, extras }
const world = new Map();

// Enlaces con otros coordinadores: coordinatorId -> { ws, direction, since, alive }
const peers = new Map();

// Salas de juego (creadas por los jugadores): roomId -> room (ver rooms.js)
const rooms = new Map();

// Último listado del directorio (auth-service GET /coordinators)
const directory = { ok: null, list: [], updatedAt: 0, error: null };

const stats = { replicated: 0, received: 0, discardedOwnOrigin: 0 };

// Eventos recientes para el panel del coordinador
const events = [];
function log(tag, ...rest) {
  const text = rest.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(`[${config.COORDINATOR_ID}] [${tag}]`, text);
  events.push({ t: Date.now(), tag, text });
  if (events.length > 80) events.shift();
}

function send(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

function sendRaw(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function localBroadcast(obj, filter = () => true) {
  const msg = JSON.stringify(obj);
  for (const c of clients.values()) {
    if (filter(c) && c.socket.readyState === WebSocket.OPEN) c.socket.send(msg);
  }
}

module.exports = { clients, world, peers, rooms, directory, stats, events, log, send, sendRaw, localBroadcast };
