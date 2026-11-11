// ─────────────────────────────────────────────────────────────────────────────
// SALAS DE JUEGO (creadas por los jugadores)
//
// · Cualquier jugador crea una sala desde el lobby. La sala queda ALOJADA en el
//   coordinador del creador (room.host). Todos los coordinadores tienen una
//   copia (se replica) para listarla, pero los jugadores que entran a jugar u
//   observar se cambian al anfitrión: si llegan a otro coordinador se les
//   cierra el WS con 4010 "host:<id>" y el cliente se reconecta al anfitrión.
//
// · El juego es por turnos y usa azar: se replica el ESTADO completo después de
//   cada cambio, con una versión que solo crece. Empate de versión → gana el
//   writer con id menor (todos convergen al mismo estado).
//
// · Si el anfitrión se cae, la sala queda huérfana; tras ORPHAN_GRACE_MS el
//   líder (id menor vivo) la adopta y pasa a ser su anfitrión.
//
// · El anfitrión borra las salas vacías y las partidas abandonadas.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { config } = require('./config');
const { clients, world, peers, rooms, directory, log, send, localBroadcast } = require('./state');
const { MonopolyGame, GameError, RECONNECT_GRACE_MS } = require('../game/monopoly');
const broadcast = require('./broadcast');
const mesh = require('./mesh');

const { COORDINATOR_ID } = config;
const ROOM_ID_RE = /^sala-[a-z0-9-]{4,48}$/;
const REDIRECT_CODE = 4010;

const reportedMatches = new Set();
const tombstones = new Map();       // roomId -> borrada en (ms); evita resucitarla

const isRoomId = (id) => typeof id === 'string' && ROOM_ID_RE.test(id);

// ── Crear / borrar ───────────────────────────────────────────────────────────
function newRoom(meta) {
  return {
    id: meta.id,
    name: meta.name,
    emblem: meta.emblem,
    host: meta.host,
    createdBy: meta.createdBy || null,
    createdAt: meta.createdAt || Date.now(),
    game: new MonopolyGame(),
    writer: meta.host,
    turnTimer: null,
    kickTimers: [],
    lifeTimer: null,
    orphanSince: null
  };
}

function cleanName(name) {
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim() : '';
}

// Lo pide un cliente LOCAL desde el lobby: la sala queda alojada aquí.
function createRoom(userId, username, data) {
  const name = cleanName(data && data.name);
  if (name.length < 3 || name.length > 40) throw new GameError('El nombre de la sala debe tener entre 3 y 40 caracteres.');
  const emblem = config.ROOM_EMBLEMS.includes(data.emblem) ? data.emblem : config.ROOM_EMBLEMS[0];

  if (rooms.size >= config.MAX_ROOMS) throw new GameError(`Ya hay ${config.MAX_ROOMS} salas abiertas. Únete a una o espera a que se libere alguna.`);
  if ([...rooms.values()].some(r => r.name.toLowerCase() === name.toLowerCase())) throw new GameError('Ya existe una sala con ese nombre.');
  const active = activeRoomOf(userId);
  if (active) throw new GameError(`Ya estás en la ${active.name}. Sal de allá primero.`);
  const ownEmpty = [...rooms.values()].find(r => r.createdBy && r.createdBy.userId === userId && r.game.phase === 'lobby' && r.game.players.length === 0);
  if (ownEmpty) throw new GameError(`Ya creaste la ${ownEmpty.name} y sigue vacía. Entra a ella o espera a que se cierre.`);

  const id = `sala-${crypto.randomBytes(4).toString('hex')}`;
  const room = newRoom({ id, name, emblem, host: COORDINATOR_ID, createdBy: { userId, username } });
  room.game.version = 1;
  rooms.set(id, room);
  log('ROOM', `${username} creó la sala "${name}" (${id}), alojada en este coordinador`);
  commitRoom(room);
  return room;
}

function deleteRoom(room, reason) {
  clearRoomTimers(room);
  rooms.delete(room.id);
  tombstones.set(room.id, Date.now());
  log('ROOM', `Sala "${room.name}" (${room.id}) eliminada: ${reason}`);
  mesh.toPeers({ type: 'room_deleted', roomId: room.id });
  closeViewers(room, 4004, 'room closed');
  broadcast.markRoomsDirty();
}

function applyRemoteDelete(msg) {
  const room = rooms.get(msg.roomId);
  tombstones.set(msg.roomId, Date.now());
  if (!room) return;
  clearRoomTimers(room);
  rooms.delete(room.id);
  log('ROOM', `Sala "${room.name}" eliminada por ${msg.origin}`);
  closeViewers(room, 4004, 'room closed');
  broadcast.markRoomsDirty();
}

function closeViewers(room, code, reason) {
  for (const c of clients.values()) {
    if (c.view === 'board' && c.roomId === room.id) c.socket.close(code, reason);
  }
}

// Las lápidas se olvidan tras 10 min
setInterval(() => {
  const limit = Date.now() - 10 * 60 * 1000;
  for (const [id, t] of tombstones) if (t < limit) tombstones.delete(id);
}, 60 * 1000).unref();

// ── Réplica ──────────────────────────────────────────────────────────────────
function roomMeta(room) {
  return { name: room.name, emblem: room.emblem, host: room.host, createdBy: room.createdBy, createdAt: room.createdAt };
}

function roomStateMessage(room) {
  return { type: 'room_state', roomId: room.id, writer: room.writer, meta: roomMeta(room), state: room.game.serialize() };
}

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
  mesh.toPeers(roomStateMessage(room));
  onRoomChanged(room);
}

function applyRemoteRoom(msg) {
  if (!isRoomId(msg.roomId) || !msg.state || !Number.isInteger(msg.state.version)) return;
  if (tombstones.has(msg.roomId)) return;
  const writer = typeof msg.writer === 'string' ? msg.writer : msg.origin;
  const meta = msg.meta || {};

  let room = rooms.get(msg.roomId);
  if (!room) {
    if (rooms.size >= config.MAX_ROOMS * 2) return;   // protección básica
    room = newRoom({
      id: msg.roomId,
      name: cleanName(meta.name).slice(0, 40) || msg.roomId,
      emblem: config.ROOM_EMBLEMS.includes(meta.emblem) ? meta.emblem : config.ROOM_EMBLEMS[0],
      host: typeof meta.host === 'string' ? meta.host : msg.origin,
      createdBy: meta.createdBy || null,
      createdAt: Number(meta.createdAt) || Date.now()
    });
    room.game.version = -1;
    room.writer = writer;
    rooms.set(room.id, room);
    log('ROOM', `Sala "${room.name}" (${room.id}) replicada desde ${msg.origin} (anfitrión ${room.host})`);
  }

  const local = room.game.version;
  const incoming = msg.state.version;
  const accept = incoming > local || (incoming === local && writer < room.writer);
  if (!accept) return;

  room.game.load(msg.state);
  room.writer = writer;
  if (typeof meta.host === 'string') room.host = meta.host;

  // Si alguno de nuestros clientes está en esta sala pero el estado recibido
  // lo marca desconectado (p. ej. tras un corte de la mesh), se corrige.
  let changed = false;
  for (const [userId, c] of clients) {
    if (c.view !== 'board' || c.roomId !== room.id) continue;
    const gp = room.game.getPlayer(userId);
    if (gp && !gp.connected) { room.game.setConnected(userId, true); changed = true; }
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
  enforceHost(room);
  broadcast.markRoomsDirty();
  scheduleRoomTimers(room);
  if (room.game.phase === 'finished') reportResults(room);
}

// Si la sala la atiende otro coordinador vivo, los clientes del tablero que
// estén aquí se cambian a él (4010 host:<id>).
function hostElsewhere(room) {
  return room.host !== COORDINATOR_ID && peers.has(room.host);
}

function enforceHost(room) {
  if (!hostElsewhere(room)) return;
  for (const c of clients.values()) {
    if (c.view === 'board' && c.roomId === room.id) {
      log('ROOM', `${c.username} → ${room.host} (anfitrión de "${room.name}")`);
      c.redirected = true;
      c.socket.close(REDIRECT_CODE, `host:${room.host}`);
    }
  }
}

function roomState(room) {
  // serverNow permite al cliente corregir la diferencia de reloj en las cuentas regresivas
  return { ...room.game.toJSON(), room: { id: room.id, name: room.name, host: room.host }, serverNow: Date.now() };
}

function roomStatus(game) {
  if (game.players.length === 0) return 'vacia';
  if (game.phase === 'lobby') return 'sin_iniciar';
  if (game.phase === 'playing') return 'en_curso';
  return 'finalizada';
}

function viewersOf(room) {
  return [...world.values()].filter(w => w.view === 'board' && w.roomId === room.id);
}

function roomsSummary() {
  const g0 = MonopolyGame.config().economy;
  return [...rooms.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(room => {
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
        host: room.host,
        createdBy: room.createdBy,
        createdAt: room.createdAt,
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
        spectators: viewersOf(room)
          .filter(w => !inGame.has(w.userId))
          .map(w => ({ userId: w.userId, username: w.username, coordinatorId: w.coordinatorId }))
      };
    });
}

function activeRoomOf(userId, except) {
  for (const room of rooms.values()) {
    if (room === except) continue;
    const gp = room.game.getPlayer(userId);
    if (gp && !gp.bankrupt && room.game.phase !== 'finished') return room;
  }
  return null;
}

// ── Temporizadores (solo el anfitrión de la sala) ────────────────────────────
function clearRoomTimers(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  for (const t of room.kickTimers) clearTimeout(t);
  room.kickTimers = [];
  if (room.lifeTimer) { clearTimeout(room.lifeTimer); room.lifeTimer = null; }
}

function scheduleAllRoomTimers() {
  for (const room of rooms.values()) scheduleRoomTimers(room);
}

function scheduleRoomTimers(room) {
  clearRoomTimers(room);
  if (room.host !== COORDINATOR_ID) return;
  const g = room.game;

  if (g.phase === 'playing' && g.turn) {
    // Tiempo del turno: al vencer se pasa al siguiente jugador.
    const turnId = g.turn.playerId;
    const deadline = g.turn.deadline || Date.now();
    room.turnTimer = setTimeout(() => {
      room.turnTimer = null;
      if (!g.turn || g.turn.playerId !== turnId || g.turn.deadline !== deadline) return;
      if (g.timeoutTurn(turnId)) { g.version++; commitRoom(room); }
    }, Math.max(0, deadline - Date.now()) + 50);

    // Jugadores desconectados: 30 s para volver o quedan fuera.
    for (const p of g.players) {
      if (p.bankrupt || p.connected) continue;
      const since = p.disconnectedAt || Date.now();
      room.kickTimers.push(setTimeout(() => {
        if (g.expelDisconnected(p.id, RECONNECT_GRACE_MS)) { g.version++; commitRoom(room); }
      }, Math.max(0, since + RECONNECT_GRACE_MS - Date.now()) + 50));
    }
  }

  // Vida de la sala: se borra si queda vacía (sin iniciar) o abandonada.
  const empty = g.phase === 'lobby' && g.players.length === 0;
  const abandoned = g.phase !== 'lobby' && !g.players.some(p => p.connected);
  if (empty || abandoned) {
    const version = g.version;
    const wait = empty ? config.ROOM_EMPTY_MS : config.ROOM_ABANDON_MS;
    room.lifeTimer = setTimeout(() => {
      room.lifeTimer = null;
      if (g.version !== version || !rooms.has(room.id)) return;
      if (empty && viewersOf(room).length) return scheduleRoomTimers(room);   // alguien está mirando
      deleteRoom(room, empty ? 'quedó vacía' : 'partida abandonada');
    }, wait);
  }
}

// ── Salas huérfanas (su anfitrión se cayó) ───────────────────────────────────
function hostAlive(hostId) {
  if (hostId === COORDINATOR_ID || peers.has(hostId)) return true;
  // Si el directorio todavía lo ve vivo, puede que solo falte el enlace.
  return directory.ok === true && directory.list.some(c => c.coordinatorId === hostId);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (hostAlive(room.host)) { room.orphanSince = null; continue; }
    if (!room.orphanSince) {
      room.orphanSince = now;
      log('ROOM', `"${room.name}" quedó sin anfitrión (${room.host} no responde)`);
      continue;
    }
    if (now - room.orphanSince < config.ORPHAN_GRACE_MS || !mesh.isLeader()) continue;
    log('ROOM', `Adopto la sala "${room.name}" (antes en ${room.host})`);
    room.host = COORDINATOR_ID;
    room.orphanSince = null;
    room.game.version++;
    commitRoom(room);
  }
}, 1000).unref();

// ── Misiones: reportar el resultado de la partida al auth-service ────────────
async function reportResults(room) {
  if (room.host !== COORDINATOR_ID) return;          // solo el anfitrión reporta
  const results = room.game.results();
  if (!results || !results.matchId || reportedMatches.has(results.matchId)) return;
  reportedMatches.add(results.matchId);
  try {
    const res = await fetch(`${config.AUTH_URL}/internal/match-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mesh.serviceToken()}`, 'ngrok-skip-browser-warning': 'true' },
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
    const res = await fetch(`${config.AUTH_URL}/me/progress`, {
      headers: { Authorization: `Bearer ${token}`, 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return null;
    return (await res.json()).stats || null;
  } catch {
    return null;
  }
}

Object.assign(module.exports, {
  REDIRECT_CODE, isRoomId, createRoom, roomStateMessage, markAbsent, commitRoom, applyRemoteRoom,
  applyRemoteDelete, roomState, roomsSummary, activeRoomOf, scheduleAllRoomTimers, hostElsewhere,
  fetchProgress
});
