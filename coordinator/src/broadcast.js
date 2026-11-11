// ─────────────────────────────────────────────────────────────────────────────
// Difusión a los clientes LOCALES (nunca a los pares). Los cambios se agrupan
// con setImmediate para no mandar el mismo mensaje varias veces en un tick.
// ─────────────────────────────────────────────────────────────────────────────
const { config } = require('./config');
const { clients, world, peers, localBroadcast } = require('./state');
const rooms = require('./rooms');

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
    localBroadcast({ type: 'rooms_update', data: { rooms: rooms.roomsSummary() } });
  });
}

function meshInfo() {
  return {
    coordinatorId: config.COORDINATOR_ID,
    publicUrl: config.getPublicUrl(),
    peers: [...peers.keys()].sort(),
    uptime: Math.round((Date.now() - config.STARTED_AT) / 1000),
    localPlayers: clients.size
  };
}

function broadcastMesh() {
  localBroadcast({ type: 'mesh_update', data: meshInfo() });
}

Object.assign(module.exports, { playersList, markWorldDirty, markRoomsDirty, meshInfo, broadcastMesh });
