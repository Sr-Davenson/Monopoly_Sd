// ─────────────────────────────────────────────────────────────────────────────
// CHAT DISTRIBUIDO (track principal)
//
// Canales:
//   global          plaza/lobby: lo ven los jugadores de TODOS los coordinadores
//   room:<sala-id>  chat de una sala: jugadores y espectadores de esa sala
//
// Flujo de un mensaje (Alice en coord-A):
//   1. WS → coord-A  { type:'chat_send', data:{ text } }
//   2. coord-A valida (largo, caracteres de control, rate limit), le pone el
//      reloj de Lamport y lo guarda en SU historial (últimos M mensajes).
//   3. coord-A lo entrega a sus clientes locales y lo replica a los pares
//      (`chat_replicate`). Nadie retransmite lo que recibe (igual que el resto
//      de la mesh), así que no hay bucles.
//   4. coord-B y coord-C re-validan (no confían en el par), actualizan su reloj
//      de Lamport, lo insertan en SU historial EN ORDEN y lo entregan a los suyos.
//
// El orden es (lc, origin, seq): ver chat-core.js. Al enlazarse dos
// coordinadores se intercambian sus historiales (`chat_sync`) y el que ya tenía
// un mensaje lo ignora (id único `origin#seq`).
//
// Los espectadores solo LEEN el chat de la sala; nunca envían (ver clients.js).
// ─────────────────────────────────────────────────────────────────────────────
const { WebSocket } = require('ws');
const { config } = require('./config');
const { clients, spectators, rooms, stats, log, send } = require('./state');
const core = require('./chat-core');

const { COORDINATOR_ID } = config;
const clock = new core.LamportClock();
const channels = new Map();                  // canal -> ChatLog
let seq = 0;
const limiter = new core.RateLimiter({ capacity: config.CHAT_RATE_CAPACITY, refillPerSec: config.CHAT_RATE_PER_SEC });
setInterval(() => limiter.sweep(), 60 * 1000).unref();

const roomChannel = (roomId) => `room:${roomId}`;

function logOf(ch) {
  let l = channels.get(ch);
  if (!l) { l = new core.ChatLog(core.HISTORY); channels.set(ch, l); }
  return l;
}

const lazyMesh = () => require('./mesh');

// Canal al que escribe un cliente local según lo que está viendo
function channelOfClient(c) {
  if (c.view === 'board') return c.roomId ? roomChannel(c.roomId) : null;
  return 'global';
}

// ── Entrega local ────────────────────────────────────────────────────────────
function deliver(msg, late) {
  const payload = JSON.stringify({ type: 'chat_message', data: { msg, late: !!late } });
  const open = (c) => c.socket.readyState === WebSocket.OPEN;
  for (const c of clients.values()) {
    if (open(c) && channelOfClient(c) === msg.ch) c.socket.send(payload);
  }
  if (msg.ch.startsWith('room:')) {
    const roomId = msg.ch.slice(5);
    for (const s of spectators.values()) if (s.roomId === roomId && open(s)) s.socket.send(payload);
  }
}

function store(msg) {
  const res = logOf(msg.ch).add(msg);
  if (!res) return false;
  deliver(msg, !res.atEnd);
  return true;
}

// ── Mensaje de un cliente local ──────────────────────────────────────────────
function handleSend(ws, client, data) {
  const ch = channelOfClient(client);
  if (!ch) return;
  if (ch.startsWith('room:') && !rooms.has(client.roomId)) return;

  const verdict = limiter.take(client.userId);
  if (!verdict.ok) {
    stats.chatRejected++;
    if (verdict.reason === 'muted') log('CHAT', `${client.username} silenciado por exceso de mensajes (${Math.ceil(verdict.retryMs / 1000)} s)`);
    return send(ws, 'chat_error', { code: verdict.reason, retryMs: verdict.retryMs });
  }

  const text = core.sanitizeText(data && data.text);
  if (!text) {
    stats.chatRejected++;
    const tooLong = typeof (data && data.text) === 'string' && data.text.trim().length > core.MAX_LEN;
    return send(ws, 'chat_error', { code: tooLong ? 'too_long' : 'empty', max: core.MAX_LEN });
  }

  const n = ++seq;
  const msg = {
    id: `${COORDINATOR_ID}#${n}`,
    ch,
    userId: client.userId,
    username: client.username,
    text,
    ts: Date.now(),
    lc: clock.tick(),
    origin: COORDINATOR_ID,
    seq: n
  };
  stats.chatSent++;
  store(msg);
  lazyMesh().toPeers({ type: 'chat_replicate', msg });
}

// ── Mensajes que llegan por la mesh ──────────────────────────────────────────
function acceptRemote(raw, origin) {
  const msg = core.normalizeRemote(raw, origin);
  if (!msg) return false;
  if (msg.origin !== origin) return false;                          // un par no puede firmar por otro
  if (msg.ch.startsWith('room:') && !rooms.has(msg.ch.slice(5))) return false;
  clock.observe(msg.lc);
  stats.chatReceived++;
  return store(msg);
}

function applyRemote(origin, m) {
  if (m && m.msg) acceptRemote(m.msg, origin);
}

function applySync(origin, m) {
  if (!m || !Array.isArray(m.messages)) return;
  for (const raw of m.messages.slice(0, core.HISTORY * 2)) acceptRemote(raw, raw && raw.origin ? raw.origin : origin);
}

// Al enlazarse con un par: mi historial de todos los canales
function syncTo(peerWs) {
  const mesh = lazyMesh();
  for (const [ch, l] of channels) {
    if (l.messages.length) mesh.toPeer(peerWs, { type: 'chat_sync', ch, messages: l.list() });
  }
}

// ── Historial para un cliente que se conecta ─────────────────────────────────
function sendHistory(ws, ch) {
  send(ws, 'chat_history', { ch, messages: logOf(ch).list(), max: core.MAX_LEN, rate: { capacity: limiter.capacity, perSec: limiter.refillPerSec } });
}

function dropChannel(ch) {
  channels.delete(ch);
}

module.exports = { handleSend, applyRemote, applySync, syncTo, sendHistory, dropChannel, roomChannel, deliver };
