// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES (WebSocket público en /connect)
//
//   /connect?token=JWT&view=canvas            → lobby / plaza
//   /connect?token=JWT&view=board&room=<id>   → tablero de una sala (jugar u observar)
//
// Si la sala está alojada en otro coordinador vivo, el WS se cierra con
// 4010 "host:<id>" y el cliente se cambia a ese coordinador.
//
// Rebalanceo: si el directorio lo ordena, jugadores del LOBBY se cierran con
// 4011 "move:<id>" y el cliente se reconecta a ese coordinador.
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');
const { config } = require('./config');
const { clients, world, rooms, log, send, sendRaw } = require('./state');
const { MonopolyGame, GameError } = require('../game/monopoly');
const { findTheme, findSkin, starterSkin, isUnlocked } = require('../game/themes');
const broadcast = require('./broadcast');
const mesh = require('./mesh');
const roomSvc = require('./rooms');

const { COORDINATOR_ID } = config;
const wss = new WebSocketServer({ noServer: true });

function rejectWith(req, socket, head, code, reason) {
  wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
}

// Validación del JWT durante el HTTP Upgrade
function handleUpgrade(req, socket, head) {
  const query  = new URL(req.url, 'http://localhost').searchParams;
  const token  = query.get('token');
  const view   = query.get('view') === 'board' ? 'board' : 'canvas';
  const roomId = view === 'board' ? query.get('room') : null;

  let payload;
  try {
    if (!token) throw new Error('Token ausente');
    payload = jwt.verify(token, config.JWT_SECRET);
    if (payload.role || !payload.userId) throw new Error('No es un token de jugador');
  } catch (err) {
    log('WS', `Conexión rechazada (token inválido/vencido): ${err.message}`);
    return rejectWith(req, socket, head, 4001, 'invalid token');
  }

  if (view === 'board') {
    const room = rooms.get(roomId);
    if (!room) return rejectWith(req, socket, head, 4004, 'invalid room');
    if (roomSvc.hostElsewhere(room)) {
      log('WS', `${payload.username} pidió "${room.name}": la atiende ${room.host}, se le redirige`);
      return rejectWith(req, socket, head, roomSvc.REDIRECT_CODE, `host:${room.host}`);
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, payload, view, roomId, token));
}

wss.on('connection', (ws, payload, view, roomId, token) => {
  const userId   = String(payload.userId);
  const username = payload.username;
  const provider = payload.provider || 'local';
  const now      = Date.now();

  // Pestaña duplicada en este coordinador: se cierra la anterior
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
  }, config.HEARTBEAT_MS);

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
    }, config.AUTH_CHALLENGE_TIMEOUT);
  }, config.AUTH_CHALLENGE_INTERVAL);

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

  const r = config.PLAYER_RADIUS;
  const entry = {
    userId, username, provider, view, roomId,
    coordinatorId: COORDINATOR_ID,
    since: now,
    x: r + Math.random() * (config.WORLD_WIDTH - 2 * r),
    y: r + Math.random() * (config.WORLD_HEIGHT - 2 * r),
    intent: { x: 0, y: 0 },
    extras: {}
  };
  world.set(userId, entry);
  mesh.toPeers(mesh.playerJoinedMessage(entry));
  log('WS', `Jugador conectado: ${username} (id: ${userId}) vista=${view}${roomId ? ' sala=' + roomId : ''} | Locales: ${clients.size}`);

  sendRaw(ws, {
    type: 'welcome',
    you: { userId, username, provider },
    world: { width: config.WORLD_WIDTH, height: config.WORLD_HEIGHT, playerRadius: r, tickRate: config.TICK_RATE },
    coordinator: broadcast.meshInfo()
  });
  send(ws, 'game_config', MonopolyGame.config());
  sendRaw(ws, { type: 'players_update', players: broadcast.playersList() });
  send(ws, 'rooms_update', { rooms: roomSvc.roomsSummary() });
  broadcast.markWorldDirty();
  broadcast.broadcastMesh();

  // Tablero: estado de su sala. Si ya estaba en la partida, se reconecta.
  if (view === 'board') {
    const room = rooms.get(roomId);
    const gp = room.game.getPlayer(userId);
    if (gp && !gp.connected) {
      room.game.setConnected(userId, true);
      room.game.version++;
      roomSvc.commitRoom(room);
    } else {
      send(ws, 'game_state', roomSvc.roomState(room));
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
      mesh.toPeers({ type: 'player_left', userId });
      const room = view === 'board' ? rooms.get(roomId) : null;
      if (room && roomSvc.markAbsent(room, userId)) roomSvc.commitRoom(room);
    }
    broadcast.markWorldDirty();
    broadcast.broadcastMesh();
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

  // ── Crear sala (desde el lobby) ───────────────────────────────────────────
  // { type: 'create_room', data: { name, emblem } }
  create_room(ws, data, { userId, username }) {
    try {
      const room = roomSvc.createRoom(userId, username, data);
      send(ws, 'room_created', { room: { id: room.id, name: room.name, host: room.host } });
    } catch (err) {
      if (err instanceof GameError) return send(ws, 'room_error', { message: err.message });
      throw err;
    }
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
        const other = roomSvc.activeRoomOf(userId, room);
        if (other) throw new GameError(`Ya estás en la ${other.name}. Sal de allá primero.`);

        // La ficha elegida debe estar desbloqueada (misiones).
        const theme = findTheme(data.themeId);
        if (!theme) throw new GameError('Temática inválida');
        const skin = data.skinId ? findSkin(theme, data.skinId) : starterSkin(theme);
        if (!skin) throw new GameError('Esa ficha no pertenece a la temática elegida');
        if (!skin.starter) {
          const progress = await roomSvc.fetchProgress(clients.get(userId) ? clients.get(userId).token : '');
          if (!isUnlocked(skin, progress)) {
            throw new GameError(`Aún no desbloqueas "${skin.name}". Misión: ${skin.unlock.text}.`);
          }
        }
      }

      if (!rooms.has(room.id)) throw new GameError('La sala ya no existe');
      room.game.handle(userId, username, data.action, data);
      roomSvc.commitRoom(room);
    } catch (err) {
      if (err instanceof GameError) return send(ws, 'game_error', { message: err.message });
      log('GAME', `Error en game_action: ${err.stack || err.message}`);
      send(ws, 'game_error', { message: 'Error interno' });
    }
  },

  get_game(ws, data, { userId }) {
    const room = roomOf(userId);
    if (room) send(ws, 'game_state', roomSvc.roomState(room));
  },

  get_players(ws) {
    sendRaw(ws, { type: 'players_update', players: broadcast.playersList() });
  },

  get_rooms(ws) {
    send(ws, 'rooms_update', { rooms: roomSvc.roomsSummary() });
  },

  // ── Intención de movimiento ───────────────────────────────────────────────
  // { type: 'intent', intent: { dir: { x: -1|0|1, y: -1|0|1 } } }
  intent(ws, data, { userId }, msg) {
    const c = clients.get(userId);
    const w = world.get(userId);
    if (!c || c.socket !== ws || !w || w.coordinatorId !== COORDINATOR_ID) return;
    const intent = msg.intent || data.intent;
    const dir = mesh.sanitizeDir(intent && intent.dir);
    if (!dir) return;
    if (dir.x === w.intent.x && dir.y === w.intent.y) return;
    w.intent = dir;
    mesh.toPeers({ type: 'intent_replicate', userId, intent: { dir }, x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100 });
  },

  // ── Extras replicados (color, mood, ficha) ────────────────────────────────
  extras_update(ws, data, { userId }, msg) {
    const c = clients.get(userId);
    const w = world.get(userId);
    if (!c || c.socket !== ws || !w || w.coordinatorId !== COORDINATOR_ID) return;
    const extras = msg.extras || data.extras;
    if (!mesh.validExtras(extras)) return;
    w.extras = extras;
    mesh.toPeers({ type: 'extras_replicate', userId, extras });
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
      const verified = jwt.verify(clientToken, config.JWT_SECRET);
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

// ── Rebalanceo de carga ordenado por el directorio ───────────────────────────
// Se mueven solo jugadores del lobby (vista canvas), empezando por los que
// llegaron más recientemente. Los que están en una sala se quedan.
const REBALANCE_CODE = 4011;

function rebalance(moves) {
  const movable = [...clients.values()]
    .filter(c => c.view === 'canvas' && c.socket.readyState === WebSocket.OPEN)
    .sort((a, b) => b.connectedAt - a.connectedAt);
  for (const { coordinatorId, count } of moves) {
    if (typeof coordinatorId !== 'string' || coordinatorId === COORDINATOR_ID) continue;
    const batch = movable.splice(0, Math.max(0, Number(count) || 0));
    if (!batch.length) continue;
    log('BALANCE', `El directorio pide repartir carga: ${batch.length} jugador(es) del lobby → ${coordinatorId} (${batch.map(c => c.username).join(', ')})`);
    for (const c of batch) c.socket.close(REBALANCE_CODE, `move:${coordinatorId}`);
  }
}

module.exports = { handleUpgrade, rebalance };
