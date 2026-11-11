// ─────────────────────────────────────────────────────────────────────────────
// SERVICIO DE DIRECTORIO DE COORDINADORES + BALANCEADOR DE CARGA
//
// Los coordinadores se anuncian con POST /heartbeat cada 1 s. Si uno no lo hace
// durante HEARTBEAT_TTL_MS (3 s = 3 ciclos) se considera muerto y se descarta.
// Si se cierra bien (Ctrl+C) avisa con POST /leave y sale al instante.
//
//   GET /coordinator              → el coordinador vivo MENOS cargado
//   GET /coordinator?prefer=X     → X si está vivo (anfitrión de una sala)
//   GET /coordinator?exclude=X    → cualquiera menos X (el que acaba de fallar)
//   GET /coordinators             → todos, con carga y último latido
//   GET /peers                    → { coordinatorId, peerUrl } de cada uno
//
// REBALANCEO: cada vez que entra un coordinador (nuevo o que vuelve) o sale uno,
// el directorio recalcula las cargas. Durante REBALANCE_WINDOW_MS, en la
// respuesta del heartbeat le ordena al coordinador sobrecargado mover N
// jugadores del LOBBY a los que están por debajo del promedio. Los jugadores
// que están dentro de una sala no se mueven (se quedan con el anfitrión).
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');
const { config } = require('../config');

const router = express.Router();
const COORD_ID_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

// Map<coordinatorId, { coordinatorId, publicUrl, peerUrl, connectedPlayers, reserved, uptime, lastSeen }>
const coordinators = new Map();
let roundRobin = 0;

const REBALANCE_WINDOW_MS   = Number(process.env.REBALANCE_WINDOW_MS || 30000); // tras un cambio en la red
const REBALANCE_COOLDOWN_MS = Number(process.env.REBALANCE_COOLDOWN_MS || 1000); // entre dos órdenes
let topologyChangedAt = 0;
let lastOrderAt = 0;
let lastAssignAt = 0;          // última vez que se mandó un jugador a algún coordinador
const SETTLE_MS = 300;         // margen para que ese jugador termine de conectarse

function topologyChanged(reason) {
  topologyChangedAt = Date.now();
  lastOrderAt = 0;
  console.log(`[BALANCE] Cambió la red (${reason}). Coordinadores vivos: [${[...coordinators.keys()].join(', ')}]. Se recalculan las cargas.`);
}

function isWsUrl(u) {
  if (typeof u !== 'string' || u.length > 512) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch { return false; }
}

// Descarta los coordinadores que dejaron de mandar heartbeat
function sweep() {
  const now = Date.now();
  for (const [id, c] of coordinators) {
    if (now - c.lastSeen > config.HEARTBEAT_TTL_MS) {
      coordinators.delete(id);
      console.log(`[DIRECTORY] ${id} descartado: sin heartbeat hace ${now - c.lastSeen} ms`);
      topologyChanged(`salió ${id}`);
    }
  }
}
setInterval(sweep, 250).unref();

function alive() {
  sweep();
  return [...coordinators.values()];
}

// Carga = jugadores reportados + reservas hechas desde el último heartbeat
const load = (c) => c.connectedPlayers + c.reserved;

// ── POST /heartbeat ───────────────────────────────────────────────────────────
router.post('/heartbeat', (req, res) => {
  const { coordinatorId, publicUrl, peerUrl, connectedPlayers, lobbyPlayers, uptime } = req.body || {};

  if (typeof coordinatorId !== 'string' || !COORD_ID_RE.test(coordinatorId)) {
    return res.status(400).json({ error: 'coordinatorId inválido' });
  }
  if (!isWsUrl(publicUrl) || !isWsUrl(peerUrl)) {
    return res.status(400).json({ error: 'publicUrl y peerUrl deben ser URLs ws:// o wss://' });
  }
  const players = Number(connectedPlayers);
  if (!Number.isInteger(players) || players < 0) {
    return res.status(400).json({ error: 'connectedPlayers debe ser un entero >= 0' });
  }

  const prev = coordinators.get(coordinatorId);
  coordinators.set(coordinatorId, {
    coordinatorId,
    publicUrl,
    peerUrl,
    connectedPlayers: players,
    // Jugadores que se pueden mover (están en el lobby, no dentro de una sala)
    lobbyPlayers: Number.isInteger(Number(lobbyPlayers)) ? Math.max(0, Math.min(players, Number(lobbyPlayers))) : players,
    reserved: 0,               // el heartbeat trae la cifra real
    uptime: Number.isFinite(Number(uptime)) ? Number(uptime) : 0,
    lastSeen: Date.now()
  });
  if (!prev) {
    console.log(`[DIRECTORY] Coordinador registrado: ${coordinatorId} (${publicUrl}, pares ${peerUrl})`);
    topologyChanged(`entró ${coordinatorId}`);
  } else if (prev.publicUrl !== publicUrl) {
    console.log(`[DIRECTORY] ${coordinatorId} cambió su URL pública a ${publicUrl}`);
  }

  const rebalance = planRebalance(coordinators.get(coordinatorId));
  return res.status(200).json(rebalance ? { ok: true, rebalance } : { ok: true });
});

// ── Plan de rebalanceo ───────────────────────────────────────────────────────
// Reparto ideal: total / N por coordinador. Con datos frescos se calcula UN
// plan global: cada coordinador por encima del techo del promedio mueve su
// exceso (solo jugadores del lobby) a los que están por debajo del piso.
// Ej.: 6 jugadores, A=3, B=3 y entra C=0 → A mueve 1 a C y B mueve 1 a C.
// Cada coordinador recibe su parte de la orden en su siguiente heartbeat.
const pendingOrders = new Map();   // coordinatorId -> { moves, at }
const ORDER_TTL_MS = 3000;

function planRebalance(self) {
  const now = Date.now();
  for (const [id, o] of pendingOrders) if (now - o.at > ORDER_TTL_MS) pendingOrders.delete(id);

  // 1) ¿Hay una orden ya calculada para este coordinador?
  const mine = pendingOrders.get(self.coordinatorId);
  if (mine) {
    pendingOrders.delete(self.coordinatorId);
    return { moves: mine.moves };
  }
  if (pendingOrders.size) return null;                               // falta entregar el plan actual
  if (now - topologyChangedAt > REBALANCE_WINDOW_MS) return null;    // la red no cambió hace poco
  if (now - lastOrderAt < REBALANCE_COOLDOWN_MS) return null;

  const list = alive();
  if (list.length < 2) return null;
  // Datos frescos: todos reportaron DESPUÉS de la última asignación. Si no,
  // todavía hay jugadores entrando o moviéndose y las cifras están viejas.
  if (list.some(c => c.lastSeen < lastAssignAt + SETTLE_MS)) return null;

  // 2) Plan global con las cifras reales de los heartbeats
  const real = (c) => c.connectedPlayers;
  const total = list.reduce((n, c) => n + real(c), 0);
  const floor = Math.floor(total / list.length);
  const ceil  = Math.ceil(total / list.length);

  const sources = list
    .map(c => ({ c, excess: Math.min(real(c) - ceil, c.lobbyPlayers) }))
    .filter(s => s.excess > 0)
    .sort((a, b) => b.excess - a.excess);
  const targets = list
    .map(c => ({ c, deficit: floor - real(c) }))
    .filter(t => t.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);
  if (!sources.length || !targets.length) return null;

  const plan = [];
  for (const s of sources) {
    const moves = [];
    for (const t of targets) {
      if (s.excess <= 0) break;
      const count = Math.min(s.excess, t.deficit);
      if (count <= 0) continue;
      moves.push({ coordinatorId: t.c.coordinatorId, count });
      t.c.reserved += count;            // las asignaciones nuevas ya cuentan la carga que llega
      t.deficit -= count;
      s.excess -= count;
    }
    if (moves.length) {
      pendingOrders.set(s.c.coordinatorId, { moves, at: now });
      plan.push(`${s.c.coordinatorId}: ${moves.map(m => `${m.count} → ${m.coordinatorId}`).join(', ')}`);
    }
  }
  if (!plan.length) return null;

  lastOrderAt = now;
  lastAssignAt = now;
  console.log(`[BALANCE] ${list.length} coordinadores, ${total} jugadores (ideal ${floor}-${ceil} c/u). Plan: ${plan.join(' · ')}`);

  return planRebalance(self);          // entrega la parte de este coordinador (si tiene)
}

// ── GET /coordinator ──────────────────────────────────────────────────────────
// Balanceo de carga: el coordinador vivo con menos jugadores. Con empate se
// reparte por turnos (round-robin), así 10 jugadores y 2 coordinadores quedan 5 y 5.
router.get('/coordinator', (req, res) => {
  const list = alive();
  if (list.length === 0) return res.status(503).json({ error: 'no_coordinators_available' });

  const exclude = typeof req.query.exclude === 'string' ? req.query.exclude : null;
  const prefer  = typeof req.query.prefer === 'string' ? req.query.prefer : null;

  let best = prefer && prefer !== exclude ? coordinators.get(prefer) : null;
  let reason = best ? `anfitrión de sala (prefer=${prefer})` : null;

  if (!best) {
    const candidates = exclude && list.some(c => c.coordinatorId !== exclude)
      ? list.filter(c => c.coordinatorId !== exclude)
      : list;
    const min = Math.min(...candidates.map(load));
    const tied = candidates.filter(c => load(c) === min).sort((a, b) => a.coordinatorId.localeCompare(b.coordinatorId));
    best = tied[roundRobin++ % tied.length];
    reason = `menos cargado (${min} jugadores)${prefer ? `; ${prefer} no está vivo` : ''}`;
  }

  // Reserva provisional: si varios clientes piden a la vez, no van todos al
  // mismo coordinador antes de su siguiente heartbeat.
  best.reserved++;
  lastAssignAt = Date.now();

  console.log(`[DIRECTORY] GET /coordinator → ${best.coordinatorId} · ${reason}${exclude ? ` · excluyendo ${exclude}` : ''}`);
  return res.json({ coordinatorId: best.coordinatorId, publicUrl: best.publicUrl });
});

// ── POST /leave ───────────────────────────────────────────────────────────────
// Un coordinador que se cierra bien avisa para salir del directorio YA (sin
// esperar el TTL). Exige el JWT de servicio para que nadie saque a otro.
router.post('/leave', (req, res) => {
  const h = req.headers.authorization || '';
  let service;
  try {
    service = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', config.JWT_SECRET);
    if (service.role !== 'coordinator') throw new Error('rol inválido');
  } catch {
    return res.status(401).json({ error: 'invalid_service_token' });
  }
  if (coordinators.delete(service.coordinatorId)) {
    console.log(`[DIRECTORY] ${service.coordinatorId} se despidió (cierre ordenado)`);
    topologyChanged(`salió ${service.coordinatorId}`);
  }
  return res.json({ ok: true });
});

// ── GET /peers ────────────────────────────────────────────────────────────────
router.get('/peers', (req, res) => {
  res.json({ peers: alive().map(c => ({ coordinatorId: c.coordinatorId, peerUrl: c.peerUrl })) });
});

// ── GET /coordinators (paneles y debug) ──────────────────────────────────────
router.get('/coordinators', (req, res) => {
  const now = Date.now();
  res.json({
    ttlMs: config.HEARTBEAT_TTL_MS,
    coordinators: alive()
      .sort((a, b) => a.coordinatorId.localeCompare(b.coordinatorId))
      .map(c => ({ ...c, lastSeenMsAgo: now - c.lastSeen }))
  });
});

module.exports = router;
