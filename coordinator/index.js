// ─────────────────────────────────────────────────────────────────────────────
// COORDINADOR (Taller 6 — múltiples coordinadores en mesh)
//
// Cada coordinador:
//   1. Atiende a SUS clientes por WebSocket en publicUrl  (ws://host:PORT/connect)
//   2. Escucha a los OTROS coordinadores en peerUrl        (ws://host:PEER_PORT)
//   3. Se anuncia al auth-service con POST /heartbeat cada 2 s y descubre a sus
//      pares con GET /peers.
//   4. Replica a los pares lo que hacen sus clientes locales (intent, extras,
//      conexión/desconexión y el estado de las 3 salas de juego).
//
// Todos los coordinadores tienen el mismo estado del mundo; cada uno hace
// broadcast SOLO a sus clientes locales.
//
// Uso:
//   node index.js --id coord-a --port 5001 --peer-port 5101
//   (o variables COORDINATOR_ID, PORT, PEER_PORT, PUBLIC_URL, PEER_URL, AUTH_URL)
// ─────────────────────────────────────────────────────────────────────────────
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const http = require('node:http');
const url = require('node:url');
const { parseArgs } = require('node:util');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { MonopolyGame, GameError } = require('./game/monopoly');
const { findTheme, findSkin, starterSkin, isUnlocked } = require('./game/themes');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id:           { type: 'string' },
    port:         { type: 'string' },
    'peer-port':  { type: 'string' },
    'public-url': { type: 'string' },
    'peer-url':   { type: 'string' },
    'auth-url':   { type: 'string' },
    role:         { type: 'string' }   // compatibilidad con talleres anteriores
  }
});

// ── Configuración ─────────────────────────────────────────────────────────────
// Si el puerto viene por línea de comandos (varios coordinadores en la misma
// carpeta), la identidad del .env se ignora para que no la compartan.
const fromCli        = Boolean(args.port || positionals[0]);
const envId          = (name) => (fromCli ? undefined : process.env[name]);
const PORT           = Number(args.port || positionals[0] || process.env.PORT || process.env.COORDINATOR_PORT || 5000);
const PEER_PORT      = Number(args['peer-port'] || envId('PEER_PORT') || PORT + 100);
const COORDINATOR_ID = args.id || envId('COORDINATOR_ID') || `coord-${PORT}`;
const PUBLIC_URL     = (args['public-url'] || envId('PUBLIC_URL') || `ws://localhost:${PORT}`).replace(/\/+$/, '');
const PEER_URL       = (args['peer-url'] || envId('PEER_URL') || `ws://localhost:${PEER_PORT}`).replace(/\/+$/, '');
const AUTH_URL       = (args['auth-url'] || process.env.AUTH_URL || 'http://localhost:4000').replace(/\/+$/, '');
const JWT_SECRET     = process.env.JWT_SECRET;

const DIRECTORY_EVERY_MS = Number(process.env.DIRECTORY_INTERVAL || 2000); // heartbeat + /peers
const PEER_PING_MS       = 2000;   // keepalive del enlace entre coordinadores
const POSITION_SYNC_MS   = 1000;   // corrección de deriva de posiciones

// Intervalo de ping para detectar clientes muertos (red caída, ngrok, etc.)
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL || 30000);

// ── Token-revalidation challenge ──────────────────────────────────────────────
// Cada AUTH_CHALLENGE_INTERVAL ms el coordinador pide al cliente que reenvíe
// su token actual. Si en AUTH_CHALLENGE_TIMEOUT ms no llega respuesta válida
// se cierra la conexión con código 4003 (token manipulado / sesión inválida).
const AUTH_CHALLENGE_INTERVAL = Number(process.env.AUTH_CHALLENGE_INTERVAL || 20000);
const AUTH_CHALLENGE_TIMEOUT  = Number(process.env.AUTH_CHALLENGE_TIMEOUT  ||  5000);

// ── Mundo del canvas (Taller 5) ───────────────────────────────────────────────
const WORLD_WIDTH   = Number(process.env.WORLD_WIDTH   || 800);
const WORLD_HEIGHT  = Number(process.env.WORLD_HEIGHT  || 600);
const PLAYER_RADIUS = Number(process.env.PLAYER_RADIUS || 18);
const PLAYER_SPEED  = Number(process.env.PLAYER_SPEED  || 200); // px/seg
const TICK_RATE     = 20;                                        // Hz
const TICK_MS       = 1000 / TICK_RATE;

// ── Salas de juego ────────────────────────────────────────────────────────────
// Si el jugador en turno se desconecta, su turno se salta tras este tiempo.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 30000);
// Una sala en curso o terminada sin nadie conectado se libera tras este tiempo.
const ROOM_ABANDON_MS     = Number(process.env.ROOM_ABANDON_MS || 90000);

const ROOMS = [
  { id: 'sala-1', name: 'Sala del Kraken',    emblem: 'kraken' },
  { id: 'sala-2', name: 'Sala de Yggdrasil',  emblem: 'yggdrasil' },
  { id: 'sala-3', name: 'Sala de Babel',      emblem: 'babel' }
];

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no está definida en el archivo .env');
  process.exit(1);
}
if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(COORDINATOR_ID)) {
  console.error('[ERROR] COORDINATOR_ID inválido (solo letras, números, guion, punto y guion bajo)');
  process.exit(1);
}

const STARTED_AT = Date.now();
const log = (tag, ...rest) => console.log(`[${COORDINATOR_ID}] [${tag}]`, ...rest);

// ═════════════════════════════════════════════════════════════════════════════
// ESTADO
// ═════════════════════════════════════════════════════════════════════════════

// Clientes conectados a ESTE coordinador:
// userId -> { socket, username, provider, view, roomId, token, connectedAt }
const clients = new Map();

// Mundo replicado: TODOS los jugadores de la mesh (locales y remotos).
// userId -> { userId, username, provider, view, roomId, coordinatorId, since,
//             x, y, intent: {x,y}, extras }
const world = new Map();

// Enlaces con otros coordinadores: coordinatorId -> { ws, direction, since, alive }
const peers = new Map();
const connecting = new Set();     // ids con conexión saliente en curso

// Salas: cada una es una partida independiente.
// writer = coordinador que escribió la versión actual (desempate de la réplica)
const rooms = new Map(ROOMS.map(r => [r.id, {
  ...r,
  game: new MonopolyGame(),
  writer: COORDINATOR_ID,
  skipTimer: null,
  abandonTimer: null
}]));
const reportedMatches = new Set();

const stats = { replicated: 0, received: 0, discardedOwnOrigin: 0 };

// ═════════════════════════════════════════════════════════════════════════════
// HTTP
// ═════════════════════════════════════════════════════════════════════════════
const app = express();
app.use(cors());
app.use(express.json());

app.get('/status', (req, res) => {
  res.json({
    coordinatorId: COORDINATOR_ID,
    publicUrl: PUBLIC_URL,
    peerUrl: PEER_URL,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    connectedPlayers: clients.size,
    peers: Array.from(peers.entries()).map(([id, p]) => ({ coordinatorId: id, direction: p.direction, since: p.since })),
    localPlayers: Array.from(clients.entries()).map(([userId, c]) => ({ userId, username: c.username, view: c.view, roomId: c.roomId })),
    worldPlayers: Array.from(world.values()).map(w => ({ userId: w.userId, username: w.username, coordinatorId: w.coordinatorId, view: w.view, roomId: w.roomId })),
    rooms: roomsSummary(),
    replication: stats
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ── Utilidades de envío ───────────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════════════
// MESH ENTRE COORDINADORES
// ═════════════════════════════════════════════════════════════════════════════

// Token de servicio: demuestra a los pares (y al auth) que somos un coordinador
// legítimo, porque solo quien conoce JWT_SECRET puede firmarlo.
function serviceToken() {
  return jwt.sign({ role: 'coordinator', coordinatorId: COORDINATOR_ID }, JWT_SECRET, { expiresIn: '5m' });
}

function helloMessage() {
  return { type: 'hello', coordinatorId: COORDINATOR_ID, auth: serviceToken() };
}

function verifyHello(msg) {
  if (!msg || msg.type !== 'hello' || typeof msg.coordinatorId !== 'string') return 'se esperaba hello';
  try {
    const p = jwt.verify(msg.auth || '', JWT_SECRET);
    if (p.role !== 'coordinator' || p.coordinatorId !== msg.coordinatorId) return 'credencial de coordinador inválida';
  } catch {
    return 'credencial de coordinador inválida';
  }
  if (msg.coordinatorId === COORDINATOR_ID) return 'conexión a sí mismo';
  return null;
}

// Envía un mensaje a todos los pares. Siempre lleva origin = este coordinador.
// Los receptores NO lo retransmiten: así no hay bucles de replicación.
function toPeers(obj) {
  const msg = JSON.stringify({ ...obj, origin: COORDINATOR_ID });
  for (const p of peers.values()) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
      stats.replicated++;
    }
  }
}

function toPeer(peerWs, obj) {
  sendRaw(peerWs, { ...obj, origin: COORDINATOR_ID });
}

function isLeader() {
  // El coordinador con el id más bajo entre los vivos se encarga de los
  // temporizadores de las salas (saltar turnos, liberar salas abandonadas).
  for (const id of peers.keys()) if (id < COORDINATOR_ID) return false;
  return true;
}

function registerPeer(id, ws, direction) {
  const link = { ws, direction, since: Date.now(), alive: true };
  peers.set(id, link);
  ws.on('pong', () => { link.alive = true; });
  log('MESH', `Enlace establecido con ${id} (${direction === 'out' ? 'saliente' : 'entrante'}). Pares: [${[...peers.keys()].join(', ')}]`);

  // Sincronización inicial: le contamos al nuevo par quiénes son nuestros
  // jugadores locales y en qué estado tenemos cada sala.
  for (const [userId] of clients) {
    const w = world.get(userId);
    if (w && w.coordinatorId === COORDINATOR_ID) toPeer(ws, playerJoinedMessage(w));
  }
  for (const room of rooms.values()) {
    toPeer(ws, { type: 'room_state', roomId: room.id, writer: room.writer, state: room.game.serialize() });
  }

  broadcastMesh();
  scheduleAllRoomTimers();
}

function peerDown(id, reason) {
  peers.delete(id);
  log('MESH', `Enlace con ${id} cerrado (${reason}). Pares: [${[...peers.keys()].join(', ') || 'ninguno'}]`);

  // Los jugadores que estaban en ese coordinador ya no están conectados.
  const gone = [...world.values()].filter(w => w.coordinatorId === id);
  for (const w of gone) world.delete(w.userId);
  if (gone.length) log('MESH', `Se retiran ${gone.length} jugador(es) de ${id}: ${gone.map(w => w.username).join(', ')}`);

  for (const room of rooms.values()) {
    let changed = false;
    for (const w of gone) {
      if (w.view === 'board' && w.roomId === room.id) changed = markAbsent(room, w.userId) || changed;
    }
    if (changed) commitRoom(room);
  }

  markWorldDirty();
  broadcastMesh();
  scheduleAllRoomTimers();
}

function attachPeerHandlers(ws, getId) {
  ws.on('message', (raw) => {
    const id = getId();
    if (!id) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handlePeerMessage(id, msg);
  });
}

// ── Servidor de pares (conexiones entrantes) ─────────────────────────────────
const peerWss = new WebSocketServer({ port: PEER_PORT });

peerWss.on('connection', (ws) => {
  let peerId = null;
  ws.on('error', (err) => log('MESH', `Error en enlace entrante: ${err.message}`));
  const helloTimer = setTimeout(() => { if (!peerId) ws.close(4000, 'hello timeout'); }, 5000);

  ws.once('message', (raw) => {
    clearTimeout(helloTimer);
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(4000, 'json invalido'); }
    const error = verifyHello(msg);
    if (error) {
      log('MESH', `Hello rechazado: ${error}`);
      return ws.close(4001, error);
    }
    const id = msg.coordinatorId;

    // Una sola conexión por par: si ya existe, se cierra la nueva.
    if (peers.has(id)) {
      log('MESH', `Conexión duplicada desde ${id}: ya existe un enlace, se cierra la nueva`);
      return ws.close(4009, 'duplicate peer link');
    }

    peerId = id;
    sendRaw(ws, helloMessage());          // respuesta del handshake
    registerPeer(id, ws, 'in');
  });

  attachPeerHandlers(ws, () => peerId);

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (peerId && peers.get(peerId) && peers.get(peerId).ws === ws) peerDown(peerId, 'desconexión');
  });
});

peerWss.on('listening', () => log('MESH', `Escuchando pares en ${PEER_URL} (puerto ${PEER_PORT})`));
peerWss.on('error', (err) => {
  console.error(`[${COORDINATOR_ID}] [MESH] No se pudo abrir el puerto de pares ${PEER_PORT}: ${err.message}`);
  process.exit(1);
});

// ── Conexiones salientes ─────────────────────────────────────────────────────
// Regla anti-duplicados: solo el coordinador con el id MENOR (lexicográfico)
// inicia la conexión; el mayor espera a recibirla.
function connectToPeer(id, peerUrl) {
  if (peers.has(id) || connecting.has(id)) return;
  connecting.add(id);
  log('MESH', `Conectando con ${id} en ${peerUrl}...`);

  let ws;
  try {
    ws = new WebSocket(peerUrl, { handshakeTimeout: 3000 });
  } catch (err) {
    connecting.delete(id);
    return log('MESH', `URL de par inválida para ${id}: ${err.message}`);
  }

  let confirmed = false;
  const helloTimer = setTimeout(() => { if (!confirmed) ws.terminate(); }, 5000);
  ws.on('open', () => sendRaw(ws, helloMessage()));
  ws.on('error', (err) => log('MESH', `Error con ${id}: ${err.message}`));

  ws.once('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(4000, 'json invalido'); }
    const error = verifyHello(msg);
    if (error || msg.coordinatorId !== id) {
      log('MESH', `Respuesta de hello inválida de ${id}: ${error || 'id distinto'}`);
      return ws.close(4001, 'hello invalido');
    }
    connecting.delete(id);
    if (peers.has(id)) {
      log('MESH', `Ya existe un enlace con ${id}; se cierra la conexión nueva`);
      return ws.close(4009, 'duplicate peer link');
    }
    confirmed = true;
    registerPeer(id, ws, 'out');
  });

  attachPeerHandlers(ws, () => (confirmed ? id : null));

  ws.on('close', (code, reason) => {
    clearTimeout(helloTimer);
    connecting.delete(id);
    if (confirmed && peers.get(id) && peers.get(id).ws === ws) peerDown(id, `código ${code}${reason ? ' ' + reason : ''}`);
  });
}

// Keepalive de los enlaces: un coordinador colgado (sin cerrar el socket) se
// detecta igual que uno caído.
setInterval(() => {
  for (const [id, p] of peers) {
    if (!p.alive) {
      log('MESH', `${id} no responde al ping; se termina el enlace`);
      p.ws.terminate();
      continue;
    }
    p.alive = false;
    try { p.ws.ping(); } catch { /* el close lo maneja */ }
  }
}, PEER_PING_MS);

// ── Mensajes de la mesh ──────────────────────────────────────────────────────
function playerJoinedMessage(w) {
  return {
    type: 'player_joined',
    userId: w.userId,
    username: w.username,
    x: Math.round(w.x),
    y: Math.round(w.y),
    // Campos extra (además de los del enunciado):
    provider: w.provider,
    view: w.view,
    roomId: w.roomId,
    since: w.since,
    extras: w.extras
  };
}

function sanitizeDir(dir) {
  if (!dir || !Number.isFinite(dir.x) || !Number.isFinite(dir.y)) return null;
  return { x: Math.sign(dir.x), y: Math.sign(dir.y) };
}

function validExtras(extras) {
  return extras && typeof extras === 'object' && !Array.isArray(extras) && JSON.stringify(extras).length <= 1024;
}

function clampX(x) { return Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, x)); }
function clampY(y) { return Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, y)); }

function handlePeerMessage(fromId, msg) {
  stats.received++;

  // Anti-bucle: un mensaje que originamos nosotros se descarta.
  if (msg.origin === COORDINATOR_ID) {
    stats.discardedOwnOrigin++;
    return;
  }
  if (typeof msg.origin !== 'string') return;

  const userId = msg.userId !== undefined ? String(msg.userId) : null;
  const owned = () => {
    const w = userId && world.get(userId);
    return w && w.coordinatorId === msg.origin ? w : null;
  };

  switch (msg.type) {
    case 'hello':
      return; // handshake ya resuelto

    case 'intent_replicate': {
      const w = owned();
      const dir = sanitizeDir(msg.intent && msg.intent.dir);
      if (!w || !dir) return;
      w.intent = dir;
      // Corrección de deriva: el origen manda su posición al cambiar de intent
      if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) { w.x = clampX(msg.x); w.y = clampY(msg.y); }
      return;
    }

    case 'extras_replicate': {
      const w = owned();
      if (!w || !validExtras(msg.extras)) return;
      w.extras = msg.extras;
      return;
    }

    case 'positions_replicate': {
      if (!Array.isArray(msg.positions)) return;
      for (const p of msg.positions) {
        const w = world.get(String(p.userId));
        if (w && w.coordinatorId === msg.origin && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          w.x = clampX(p.x); w.y = clampY(p.y);
        }
      }
      return;
    }

    case 'player_joined': {
      if (!userId || typeof msg.username !== 'string') return;
      const since = Number(msg.since) || Date.now();
      const existing = world.get(userId);
      if (existing && existing.since > since) return; // llegó tarde un join más viejo

      // Sesión duplicada en otro coordinador: la más nueva gana.
      const local = clients.get(userId);
      if (local && local.connectedAt < since) {
        log('SESSION', `${local.username} abrió sesión en ${msg.origin}; se cierra la sesión local`);
        local.socket.close(4002, 'duplicate session: connected from another coordinator');
      }

      world.set(userId, {
        userId,
        username: msg.username,
        provider: msg.provider || 'local',
        view: msg.view === 'board' ? 'board' : 'canvas',
        roomId: rooms.has(msg.roomId) ? msg.roomId : null,
        coordinatorId: msg.origin,
        since,
        x: clampX(Number(msg.x) || WORLD_WIDTH / 2),
        y: clampY(Number(msg.y) || WORLD_HEIGHT / 2),
        intent: { x: 0, y: 0 },
        extras: validExtras(msg.extras) ? msg.extras : {}
      });
      log('REPL', `player_joined ${msg.username} (${userId}) desde ${msg.origin}`);
      markWorldDirty();
      return;
    }

    case 'player_left': {
      const w = owned();
      if (!w) return; // ya se movió a otro coordinador (o no lo conocemos)
      world.delete(userId);
      log('REPL', `player_left ${w.username} (${userId}) desde ${msg.origin}`);
      markWorldDirty();
      return;
    }

    case 'room_state':
      return applyRemoteRoom(msg);

    default:
      log('MESH', `Mensaje desconocido de ${fromId}: ${msg.type}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SALAS (réplica del estado de cada partida)
//
// El juego es por turnos y usa azar (dados, cartas): reaplicar la ACCIÓN en
// cada coordinador daría resultados distintos. Por eso se replica el ESTADO
// completo de la sala después de cada cambio, con una versión que solo crece.
// Si dos coordinadores escriben la misma versión a la vez, gana el de id menor
// (desempate determinista): todos convergen al mismo estado.
// ═════════════════════════════════════════════════════════════════════════════

// El jugador ya no está en la sala (se desconectó).
function markAbsent(room, userId) {
  const g = room.game;
  const gp = g.getPlayer(userId);
  if (!gp) return false;
  if (g.phase === 'lobby') g.leave(userId);
  else if (gp.connected) g.setConnected(userId, false);
  else return false;
  g.version++;
  return true;
}

// Cambio hecho por ESTE coordinador → broadcast local + réplica a los pares.
function commitRoom(room) {
  room.writer = COORDINATOR_ID;
  toPeers({ type: 'room_state', roomId: room.id, writer: room.writer, state: room.game.serialize() });
  onRoomChanged(room);
}

function applyRemoteRoom(msg) {
  const room = rooms.get(msg.roomId);
  if (!room || !msg.state || !Number.isInteger(msg.state.version)) return;
  const local = room.game.version;
  const incoming = msg.state.version;
  const writer = typeof msg.writer === 'string' ? msg.writer : msg.origin;

  const accept = incoming > local || (incoming === local && writer < room.writer);
  if (!accept) return;

  room.game.load(msg.state);
  room.writer = writer;

  // Si alguno de nuestros clientes está en esta sala pero el estado recibido
  // lo marca desconectado (p. ej. tras un corte de la mesh), se corrige.
  let changed = false;
  for (const [userId, c] of clients) {
    if (c.view !== 'board' || c.roomId !== room.id) continue;
    const gp = room.game.getPlayer(userId);
    if (gp && !gp.connected) { gp.connected = true; changed = true; }
  }
  if (changed) {
    room.game.version++;
    commitRoom(room);
  } else {
    onRoomChanged(room);
  }
}

function onRoomChanged(room) {
  const msg = JSON.stringify({ type: 'game_state', data: roomState(room) });
  for (const c of clients.values()) {
    if (c.view === 'board' && c.roomId === room.id && c.socket.readyState === WebSocket.OPEN) c.socket.send(msg);
  }
  markRoomsDirty();
  scheduleRoomTimers(room);
  if (room.game.phase === 'finished') reportResults(room);
}

function roomState(room) {
  return { ...room.game.toJSON(), room: { id: room.id, name: room.name } };
}

function roomStatus(game) {
  if (game.players.length === 0) return 'vacia';
  if (game.phase === 'lobby') return 'sin_iniciar';
  if (game.phase === 'playing') return 'en_curso';
  return 'finalizada';
}

function roomsSummary() {
  const g0 = MonopolyGame.config().economy;
  return [...rooms.values()].map(room => {
    const g = room.game;
    const inGame = new Set(g.players.map(p => p.id));
    const presence = (userId) => {
      const w = world.get(userId);
      return w && w.view === 'board' && w.roomId === room.id ? w.coordinatorId : null;
    };
    return {
      id: room.id,
      name: room.name,
      emblem: room.emblem,
      status: roomStatus(g),
      phase: g.phase,
      version: g.version,
      writer: room.writer,
      minPlayers: g0.minPlayers,
      maxPlayers: g0.maxPlayers,
      hostId: g.hostId,
      turnOf: g.turn ? g.turn.playerId : null,
      winnerId: g.winnerId,
      players: g.players.map(p => ({
        id: p.id,
        username: p.username,
        themeId: p.themeId,
        skin: { id: p.skin.id, art: p.skin.art, icon: p.skin.icon, name: p.skin.name },
        color: p.color,
        connected: p.connected,
        bankrupt: p.bankrupt,
        coordinatorId: presence(p.id)
      })),
      spectators: [...world.values()]
        .filter(w => w.view === 'board' && w.roomId === room.id && !inGame.has(w.userId))
        .map(w => ({ userId: w.userId, username: w.username, coordinatorId: w.coordinatorId }))
    };
  });
}

// ── Temporizadores (solo el líder) ───────────────────────────────────────────
function scheduleAllRoomTimers() {
  for (const room of rooms.values()) scheduleRoomTimers(room);
}

function scheduleRoomTimers(room) {
  if (room.skipTimer) { clearTimeout(room.skipTimer); room.skipTimer = null; }
  if (room.abandonTimer) { clearTimeout(room.abandonTimer); room.abandonTimer = null; }
  if (!isLeader()) return;
  const g = room.game;

  // Saltar el turno del jugador desconectado tras el periodo de gracia.
  if (g.phase === 'playing' && g.turn) {
    const current = g.current();
    if (current && !current.connected) {
      const turnId = current.id;
      const version = g.version;
      room.skipTimer = setTimeout(() => {
        room.skipTimer = null;
        if (g.version !== version) return;
        if (g.skipDisconnected(turnId)) { g.version++; commitRoom(room); }
      }, DISCONNECT_GRACE_MS);
    }
  }

  // Liberar una sala en curso / terminada donde ya no queda nadie.
  if (g.phase !== 'lobby' && !g.players.some(p => p.connected)) {
    const version = g.version;
    room.abandonTimer = setTimeout(() => {
      room.abandonTimer = null;
      if (g.version !== version) return;
      log('ROOM', `${room.name} abandonada: se reinicia`);
      g.reset();
      g.version = version + 1;
      commitRoom(room);
    }, ROOM_ABANDON_MS);
  }
}

// ── Misiones: reportar el resultado de la partida al auth-service ────────────
// Todos los coordinadores reportan; el auth ignora los duplicados por matchId.
async function reportResults(room) {
  const results = room.game.results();
  if (!results || !results.matchId || reportedMatches.has(results.matchId)) return;
  reportedMatches.add(results.matchId);
  try {
    const res = await fetch(`${AUTH_URL}/internal/match-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken()}`, 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ roomId: room.id, ...results }),
      signal: AbortSignal.timeout(3000)
    });
    const body = await res.json().catch(() => ({}));
    log('MISSIONS', `Resultado de ${room.name} reportado (${res.status}${body.counted === false ? ', ya estaba' : ''})`);
    const ids = new Set(results.players.map(p => p.userId));
    localBroadcast({ type: 'progress_changed', data: {} }, c => ids.has(c.userId));
  } catch (err) {
    reportedMatches.delete(results.matchId);
    log('MISSIONS', `No se pudo reportar el resultado: ${err.message}`);
  }
}

async function fetchProgress(token) {
  try {
    const res = await fetch(`${AUTH_URL}/me/progress`, {
      headers: { Authorization: `Bearer ${token}`, 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return null;
    return (await res.json()).stats || null;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DIFUSIÓN A CLIENTES LOCALES
// ═════════════════════════════════════════════════════════════════════════════
function playersList() {
  return [...world.values()].map(w => ({
    userId: w.userId,
    username: w.username,
    provider: w.provider,
    coordinatorId: w.coordinatorId,
    view: w.view,
    roomId: w.roomId
  }));
}

let worldDirty = false;
function markWorldDirty() {
  if (worldDirty) return;
  worldDirty = true;
  setImmediate(() => {
    worldDirty = false;
    localBroadcast({ type: 'players_update', players: playersList() });
    markRoomsDirty();
  });
}

let roomsDirty = false;
function markRoomsDirty() {
  if (roomsDirty) return;
  roomsDirty = true;
  setImmediate(() => {
    roomsDirty = false;
    localBroadcast({ type: 'rooms_update', data: { rooms: roomsSummary() } });
  });
}

function meshInfo() {
  return {
    coordinatorId: COORDINATOR_ID,
    publicUrl: PUBLIC_URL,
    peers: [...peers.keys()].sort(),
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    localPlayers: clients.size
  };
}

function broadcastMesh() {
  localBroadcast({ type: 'mesh_update', data: meshInfo() });
}

// ═════════════════════════════════════════════════════════════════════════════
// CLIENTES (WebSocket público)
// ═════════════════════════════════════════════════════════════════════════════

// Validación del JWT durante el HTTP Upgrade en /connect?token=XXX&view=canvas|board&room=sala-1
server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => log('WS', `Error en socket de upgrade: ${err.message}`));
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const token  = parsedUrl.query.token;
  const view   = parsedUrl.query.view === 'board' ? 'board' : 'canvas';
  const roomId = view === 'board' ? parsedUrl.query.room : null;

  try {
    if (!token) throw new Error('Token ausente');
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role || !payload.userId) throw new Error('No es un token de jugador');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (view === 'board' && !rooms.has(roomId)) return ws.close(4004, 'invalid room');
      wss.emit('connection', ws, payload, view, roomId, token);
    });
  } catch (err) {
    log('WS', `Conexión rechazada (token inválido/vencido): ${err.message}`);
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, 'invalid token'));
  }
});

wss.on('connection', (ws, payload, view, roomId, token) => {
  const userId   = String(payload.userId);
  const username = payload.username;
  const provider = payload.provider || 'local';
  const now      = Date.now();

  // Política de pestañas duplicadas (en este coordinador)
  if (clients.has(userId)) {
    const previous = clients.get(userId);
    log('SESSION', `Sesión duplicada para ${username} (${userId}). Cerrando la anterior.`);
    clients.delete(userId);
    previous.socket.close(4002, 'duplicate session: connected from another tab');
  }

  ws.on('error', (err) => log('WS', `Error de socket (${username}): ${err.message}`));

  // ── Ping/pong para detectar conexiones muertas ─────────────────────────────
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const heartbeat = setInterval(() => {
    if (!ws.isAlive) {
      log('WS', `Sin respuesta de ${username} (${userId}). Terminando conexión.`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, HEARTBEAT_MS);

  // ── Token-challenge: re-validación periódica del token ────────────────────
  let challengeResponseTimer = null;
  const challengeInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    send(ws, 'auth_challenge', {});
    challengeResponseTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        log('WS', `Sin respuesta al auth_challenge de ${username} (${userId}). Cerrando.`);
        ws.close(4003, 'token tampered or missing');
      }
    }, AUTH_CHALLENGE_TIMEOUT);
  }, AUTH_CHALLENGE_INTERVAL);

  const session = {
    userId,
    username,
    clearChallenge() {
      if (challengeResponseTimer) { clearTimeout(challengeResponseTimer); challengeResponseTimer = null; }
    }
  };

  // ── Registro local + en el mundo replicado ────────────────────────────────
  const client = { userId, socket: ws, username, provider, view, roomId, token, connectedAt: now };
  clients.set(userId, client);

  const entry = {
    userId,
    username,
    provider,
    view,
    roomId,
    coordinatorId: COORDINATOR_ID,
    since: now,
    x: PLAYER_RADIUS + Math.random() * (WORLD_WIDTH  - 2 * PLAYER_RADIUS),
    y: PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS),
    intent: { x: 0, y: 0 },
    extras: {}
  };
  world.set(userId, entry);
  toPeers(playerJoinedMessage(entry));
  log('WS', `Jugador conectado: ${username} (id: ${userId}) vista=${view}${roomId ? ' sala=' + roomId : ''} | Locales: ${clients.size}`);

  // Welcome: identidad + mundo + coordinador asignado
  sendRaw(ws, {
    type: 'welcome',
    you: { userId, username, provider },
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE },
    coordinator: meshInfo()
  });

  send(ws, 'game_config', MonopolyGame.config());
  sendRaw(ws, { type: 'players_update', players: playersList() });
  send(ws, 'rooms_update', { rooms: roomsSummary() });
  markWorldDirty();
  broadcastMesh();

  // Tablero: estado de su sala. Si ya estaba en la partida, se reconecta.
  if (view === 'board') {
    const room = rooms.get(roomId);
    const gp = room.game.getPlayer(userId);
    if (gp && !gp.connected) {
      room.game.setConnected(userId, true);
      room.game.version++;
      commitRoom(room);
    } else {
      send(ws, 'game_state', roomState(room));
    }
  }

  // Expiración natural del token
  let expTimer = null;
  if (payload.exp) {
    const msUntilExpiry = payload.exp * 1000 - Date.now();
    if (msUntilExpiry > 0) {
      expTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          log('WS', `Token expirado para ${username} (${userId}). Cerrando conexión.`);
          ws.close(4001, 'invalid token');
        }
      }, msUntilExpiry);
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, 'error', { message: 'json invalido' }); }
    const handler = handlers[msg.type];
    if (!handler) return send(ws, 'error', { message: `tipo desconocido: ${msg.type}` });
    Promise.resolve(handler(ws, msg.data || {}, session, msg)).catch((err) => {
      log('WS', `Error en handler ${msg.type}: ${err.stack || err.message}`);
    });
  });

  ws.on('close', () => {
    if (expTimer) clearTimeout(expTimer);
    session.clearChallenge();
    clearInterval(heartbeat);
    clearInterval(challengeInterval);

    const current = clients.get(userId);
    if (!current || current.socket !== ws) return; // ya lo reemplazó otra sesión local
    clients.delete(userId);
    log('WS', `Jugador desconectado: ${username} (id: ${userId}) | Locales: ${clients.size}`);

    // Si el usuario ya abrió sesión en otro coordinador, ese coordinador es su
    // dueño ahora: no anunciamos su salida ni lo sacamos de la sala.
    const w = world.get(userId);
    if (w && w.coordinatorId === COORDINATOR_ID && w.since === now) {
      world.delete(userId);
      toPeers({ type: 'player_left', userId });
      if (view === 'board') {
        const room = rooms.get(roomId);
        if (markAbsent(room, userId)) commitRoom(room);
      }
    }
    markWorldDirty();
    broadcastMesh();
  });
});

function roomOf(userId) {
  const c = clients.get(userId);
  return c && c.view === 'board' ? rooms.get(c.roomId) : null;
}

const handlers = {
  ping(ws) {
    send(ws, 'pong', { timestamp: Date.now() });
  },

  // ── Acciones del tablero ──────────────────────────────────────────────────
  // { type: 'game_action', data: { action: 'join' | 'roll' | 'buy' | ..., ...params } }
  async game_action(ws, data, { userId, username }) {
    if (typeof data.action !== 'string') return send(ws, 'game_error', { message: 'Acción requerida' });
    const room = roomOf(userId);
    if (!room) return send(ws, 'game_error', { message: 'Entra a una sala desde el lobby' });

    try {
      if (data.action === 'join') {
        // Un jugador solo puede estar en una sala activa a la vez.
        for (const other of rooms.values()) {
          if (other === room) continue;
          const gp = other.game.getPlayer(userId);
          if (gp && !gp.bankrupt && other.game.phase !== 'finished') {
            throw new GameError(`Ya estás en la ${other.name}. Sal de allá primero.`);
          }
        }
        // La ficha elegida debe estar desbloqueada (misiones).
        const theme = findTheme(data.themeId);
        if (!theme) throw new GameError('Temática inválida');
        const skin = data.skinId ? findSkin(theme, data.skinId) : starterSkin(theme);
        if (!skin) throw new GameError('Esa ficha no pertenece a la temática elegida');
        if (!skin.starter) {
          const progress = await fetchProgress(clients.get(userId) ? clients.get(userId).token : '');
          if (!isUnlocked(skin, progress)) {
            throw new GameError(`Aún no desbloqueas "${skin.name}". Misión: ${skin.unlock.text}.`);
          }
        }
      }

      room.game.handle(userId, username, data.action, data);
      commitRoom(room);
    } catch (err) {
      if (err instanceof GameError) return send(ws, 'game_error', { message: err.message });
      log('GAME', `Error en game_action: ${err.stack || err.message}`);
      send(ws, 'game_error', { message: 'Error interno' });
    }
  },

  get_game(ws, data, { userId }) {
    const room = roomOf(userId);
    if (room) send(ws, 'game_state', roomState(room));
  },

  get_players(ws) {
    sendRaw(ws, { type: 'players_update', players: playersList() });
  },

  get_rooms(ws) {
    send(ws, 'rooms_update', { rooms: roomsSummary() });
  },

  // ── Intención de movimiento ───────────────────────────────────────────────
  // { type: 'intent', intent: { dir: { x: -1|0|1, y: -1|0|1 } } }
  // Solo se guarda la intención (la aplica el game loop) y se replica a los pares.
  intent(ws, data, { userId }, msg) {
    const c = clients.get(userId);
    const w = world.get(userId);
    if (!c || c.socket !== ws || !w || w.coordinatorId !== COORDINATOR_ID) return;
    const intent = msg.intent || data.intent;
    const dir = sanitizeDir(intent && intent.dir);
    if (!dir) return;
    if (dir.x === w.intent.x && dir.y === w.intent.y) return;
    w.intent = dir;
    toPeers({ type: 'intent_replicate', userId, intent: { dir }, x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100 });
  },

  // ── Extras replicados (color, mood, ficha) ────────────────────────────────
  // { type: 'extras_update', extras: { color: '#ff5500', mood: '⚓', art: 'samsa' } }
  extras_update(ws, data, { userId }, msg) {
    const c = clients.get(userId);
    const w = world.get(userId);
    if (!c || c.socket !== ws || !w || w.coordinatorId !== COORDINATOR_ID) return;
    const extras = msg.extras || data.extras;
    if (!validExtras(extras)) return;
    w.extras = extras;
    toPeers({ type: 'extras_replicate', userId, extras });
  },

  // ── Respuesta al auth_challenge ───────────────────────────────────────────
  auth_response(ws, data, { userId, username, clearChallenge }) {
    clearChallenge();
    const clientToken = data && data.token;
    if (!clientToken) {
      log('WS', `auth_response sin token de ${username} (${userId}). Cerrando.`);
      return ws.close(4003, 'token tampered or missing');
    }
    try {
      const verified = jwt.verify(clientToken, JWT_SECRET);
      if (String(verified.userId) !== userId) {
        log('WS', `Token de otra cuenta enviado por ${username} (${userId}). Cerrando.`);
        return ws.close(4003, 'token tampered or missing');
      }
    } catch (err) {
      log('WS', `Token inválido en auth_response de ${username} (${userId}): ${err.message}. Cerrando.`);
      ws.close(4003, 'token tampered or missing');
    }
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GAME LOOP (20 Hz)
//   1. Aplica los intents de TODOS los jugadores (locales y remotos).
//   2. Broadcast del state SOLO a los clientes locales (no a los pares).
// ═════════════════════════════════════════════════════════════════════════════
function snapshot() {
  const out = [];
  for (const w of world.values()) {
    if (w.view !== 'canvas') continue;
    out.push({
      userId: w.userId,
      username: w.username,
      provider: w.provider,
      coordinatorId: w.coordinatorId,
      x: Math.round(w.x * 100) / 100,
      y: Math.round(w.y * 100) / 100,
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
      w.x = clampX(w.x + (ix / mag) * PLAYER_SPEED * dt);
      w.y = clampY(w.y + (iy / mag) * PLAYER_SPEED * dt);
    }
  }

  let hasCanvasClient = false;
  for (const c of clients.values()) if (c.view === 'canvas') { hasCanvasClient = true; break; }
  if (hasCanvasClient) {
    localBroadcast({ type: 'state', t: now, coordinatorId: COORDINATOR_ID, players: snapshot() }, c => c.view === 'canvas');
  }
}
setInterval(tick, TICK_MS);

// Corrección de deriva: cada coordinador integra las posiciones por su cuenta,
// así que cada segundo el dueño de cada jugador manda su posición "oficial".
setInterval(() => {
  if (peers.size === 0) return;
  const positions = [];
  for (const [userId, c] of clients) {
    const w = world.get(userId);
    if (c.view === 'canvas' && w && w.coordinatorId === COORDINATOR_ID) {
      positions.push({ userId, x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100 });
    }
  }
  if (positions.length) toPeers({ type: 'positions_replicate', positions });
}, POSITION_SYNC_MS);

// ═════════════════════════════════════════════════════════════════════════════
// DIRECTORIO: heartbeat al auth-service + descubrimiento de pares
// ═════════════════════════════════════════════════════════════════════════════
let directoryOk = null;

async function directoryCycle() {
  try {
    const res = await fetch(`${AUTH_URL}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({
        coordinatorId: COORDINATOR_ID,
        publicUrl: PUBLIC_URL,
        peerUrl: PEER_URL,
        connectedPlayers: clients.size,
        uptime: Math.round((Date.now() - STARTED_AT) / 1000)
      }),
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) throw new Error(`heartbeat respondió ${res.status}`);

    const peersRes = await fetch(`${AUTH_URL}/peers`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(1500)
    });
    const { peers: list = [] } = await peersRes.json();

    if (directoryOk !== true) log('DIRECTORY', `Registrado en ${AUTH_URL} (heartbeat cada ${DIRECTORY_EVERY_MS / 1000}s)`);
    directoryOk = true;

    for (const p of list) {
      if (!p || p.coordinatorId === COORDINATOR_ID) continue;   // nos filtramos
      if (COORDINATOR_ID < p.coordinatorId) connectToPeer(p.coordinatorId, p.peerUrl);
    }
  } catch (err) {
    if (directoryOk !== false) log('DIRECTORY', `Auth-service no disponible (${err.message}). Reintentando...`);
    directoryOk = false;
  }
}
setInterval(directoryCycle, DIRECTORY_EVERY_MS);

// ── Arranque ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log('START', `Clientes en ${PUBLIC_URL}/connect (puerto ${PORT})`);
  log('START', `Game loop a ${TICK_RATE} Hz | Mundo ${WORLD_WIDTH}x${WORLD_HEIGHT} | Salas: ${ROOMS.map(r => r.name).join(', ')}`);
  directoryCycle();
});

server.on('error', (err) => {
  console.error(`[${COORDINATOR_ID}] [START] No se pudo abrir el puerto ${PORT}: ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('STOP', 'Ctrl+C recibido: el coordinador se detiene (el auth lo descartará al no recibir heartbeats).');
  process.exit(0);
});
