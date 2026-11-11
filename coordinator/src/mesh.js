// ─────────────────────────────────────────────────────────────────────────────
// MESH ENTRE COORDINADORES
//
// Cada coordinador escucha a sus pares en  <publicUrl>/peer  (mismo puerto y
// mismo túnel de ngrok que los clientes). Solo el coordinador con el id MENOR
// inicia la conexión, así hay un único enlace por par.
//
// Handshake: { type: 'hello', coordinatorId, auth: <JWT de servicio> }
// Todo mensaje replicado lleva `origin`; nadie retransmite lo que recibe.
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');
const { config } = require('./config');
const { clients, world, peers, rooms, stats, log, sendRaw } = require('./state');
const broadcast = require('./broadcast');
const roomSvc = require('./rooms');

const { COORDINATOR_ID } = config;
const connecting = new Map();   // id -> { url, since, lastError }
const lastErrors = new Map();   // id -> último error al intentar enlazar (para el panel)

// ── Credencial de servicio ───────────────────────────────────────────────────
// Solo quien conoce JWT_SECRET puede firmarla: un proceso cualquiera no puede
// meterse en la mesh ni inyectar estado.
function serviceToken() {
  return jwt.sign({ role: 'coordinator', coordinatorId: COORDINATOR_ID }, config.JWT_SECRET, { expiresIn: '5m' });
}

function helloMessage() {
  return { type: 'hello', coordinatorId: COORDINATOR_ID, auth: serviceToken() };
}

function verifyHello(msg) {
  if (!msg || msg.type !== 'hello' || typeof msg.coordinatorId !== 'string') return 'se esperaba hello';
  try {
    const p = jwt.verify(msg.auth || '', config.JWT_SECRET);
    if (p.role !== 'coordinator' || p.coordinatorId !== msg.coordinatorId) return 'credencial de coordinador inválida';
  } catch {
    return 'credencial de coordinador inválida (¿mismo JWT_SECRET en todos?)';
  }
  if (msg.coordinatorId === COORDINATOR_ID) return 'conexión a sí mismo (dos coordinadores con el mismo id)';
  return null;
}

// ── Envío ────────────────────────────────────────────────────────────────────
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

// El coordinador vivo con el id más bajo es el líder (adopta salas huérfanas).
function isLeader() {
  for (const id of peers.keys()) if (id < COORDINATOR_ID) return false;
  return true;
}

// ── Alta y baja de enlaces ───────────────────────────────────────────────────
function registerPeer(id, ws, direction) {
  const link = { ws, direction, since: Date.now(), alive: true };
  peers.set(id, link);
  lastErrors.delete(id);
  ws.on('pong', () => { link.alive = true; });
  log('MESH', `Enlace establecido con ${id} (${direction === 'out' ? 'saliente' : 'entrante'}). Pares: [${[...peers.keys()].join(', ')}]`);

  // Sincronización inicial: jugadores locales + todas las salas que conocemos.
  for (const [userId] of clients) {
    const w = world.get(userId);
    if (w && w.coordinatorId === COORDINATOR_ID) toPeer(ws, playerJoinedMessage(w));
  }
  for (const room of rooms.values()) toPeer(ws, roomSvc.roomStateMessage(room));

  broadcast.broadcastMesh();
  roomSvc.scheduleAllRoomTimers();
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
      if (w.view === 'board' && w.roomId === room.id) changed = roomSvc.markAbsent(room, w.userId) || changed;
    }
    if (changed) roomSvc.commitRoom(room);
  }

  broadcast.markWorldDirty();
  broadcast.broadcastMesh();
  roomSvc.scheduleAllRoomTimers();
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

// ── Conexiones entrantes (ruta /peer del servidor HTTP) ──────────────────────
const peerWss = new WebSocketServer({ noServer: true });

function handleUpgrade(req, socket, head) {
  peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit('connection', ws));
}

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
      return ws.close(4001, error.slice(0, 120));
    }
    const id = msg.coordinatorId;
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

// ── Conexiones salientes ─────────────────────────────────────────────────────
// Regla anti-duplicados: solo el coordinador con el id MENOR inicia la conexión.
function shouldDial(id) {
  return COORDINATOR_ID < id;
}

function connectToPeer(id, peerUrl) {
  if (peers.has(id) || connecting.has(id)) return;
  connecting.set(id, { url: peerUrl, since: Date.now() });
  log('MESH', `Conectando con ${id} en ${peerUrl}...`);

  let ws;
  try {
    // La cabecera evita la página de advertencia de ngrok en el upgrade
    ws = new WebSocket(peerUrl, { handshakeTimeout: 5000, headers: { 'ngrok-skip-browser-warning': 'true' } });
  } catch (err) {
    connecting.delete(id);
    lastErrors.set(id, `URL inválida: ${err.message}`);
    return log('MESH', `URL de par inválida para ${id}: ${err.message}`);
  }

  let confirmed = false;
  const helloTimer = setTimeout(() => { if (!confirmed) ws.terminate(); }, 7000);
  ws.on('open', () => sendRaw(ws, helloMessage()));
  ws.on('error', (err) => {
    lastErrors.set(id, err.message);
    log('MESH', `Error con ${id}: ${err.message}`);
  });

  ws.once('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(4000, 'json invalido'); }
    const error = verifyHello(msg);
    if (error || msg.coordinatorId !== id) {
      lastErrors.set(id, error || 'id distinto');
      log('MESH', `Respuesta de hello inválida de ${id}: ${error || 'id distinto'}`);
      return ws.close(4001, 'hello invalido');
    }
    connecting.delete(id);
    if (peers.has(id)) return ws.close(4009, 'duplicate peer link');
    confirmed = true;
    registerPeer(id, ws, 'out');
  });

  attachPeerHandlers(ws, () => (confirmed ? id : null));

  ws.on('close', (code, reason) => {
    clearTimeout(helloTimer);
    connecting.delete(id);
    if (!confirmed && code === 4001) lastErrors.set(id, `rechazado: ${reason || 'credencial inválida'}`);
    if (confirmed && peers.get(id) && peers.get(id).ws === ws) peerDown(id, `código ${code}${reason ? ' ' + reason : ''}`);
  });
}

// Keepalive: un coordinador colgado (sin cerrar el socket) se detecta igual
// que uno caído.
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
}, config.PEER_PING_MS).unref();

// ── Mensajes de la mesh ──────────────────────────────────────────────────────
function playerJoinedMessage(w) {
  return {
    type: 'player_joined',
    userId: w.userId,
    username: w.username,
    x: Math.round(w.x),
    y: Math.round(w.y),
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

const clampX = (x) => Math.max(config.PLAYER_RADIUS, Math.min(config.WORLD_WIDTH - config.PLAYER_RADIUS, x));
const clampY = (y) => Math.max(config.PLAYER_RADIUS, Math.min(config.WORLD_HEIGHT - config.PLAYER_RADIUS, y));

function handlePeerMessage(fromId, msg) {
  stats.received++;

  // Anti-bucle: un mensaje que originamos nosotros se descarta.
  if (msg.origin === COORDINATOR_ID) { stats.discardedOwnOrigin++; return; }
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
        roomId: roomSvc.isRoomId(msg.roomId) ? msg.roomId : null,
        coordinatorId: msg.origin,
        since,
        x: clampX(Number(msg.x) || config.WORLD_WIDTH / 2),
        y: clampY(Number(msg.y) || config.WORLD_HEIGHT / 2),
        intent: { x: 0, y: 0 },
        extras: validExtras(msg.extras) ? msg.extras : {}
      });
      log('REPL', `player_joined ${msg.username} (${userId}) desde ${msg.origin}`);
      broadcast.markWorldDirty();
      return;
    }

    case 'player_left': {
      const w = owned();
      if (!w) return; // ya se movió a otro coordinador (o no lo conocemos)
      world.delete(userId);
      log('REPL', `player_left ${w.username} (${userId}) desde ${msg.origin}`);
      broadcast.markWorldDirty();
      return;
    }

    case 'room_state':
      return roomSvc.applyRemoteRoom(msg);

    case 'room_deleted':
      return roomSvc.applyRemoteDelete(msg);

    default:
      log('MESH', `Mensaje desconocido de ${fromId}: ${msg.type}`);
  }
}

// Estado de los enlaces para el panel
function linkStatus(id) {
  if (peers.has(id)) return { state: 'enlazado', direction: peers.get(id).direction, since: peers.get(id).since };
  if (connecting.has(id)) return { state: 'conectando', error: lastErrors.get(id) || null };
  if (!shouldDial(id)) return { state: 'esperando', note: `${id} inicia el enlace (id menor)`, error: lastErrors.get(id) || null };
  return { state: 'sin enlace', error: lastErrors.get(id) || null };
}

Object.assign(module.exports, {
  serviceToken, toPeers, toPeer, isLeader, connectToPeer, shouldDial, handleUpgrade,
  playerJoinedMessage, sanitizeDir, validExtras, clampX, clampY, linkStatus
});
