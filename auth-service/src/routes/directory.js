// ─────────────────────────────────────────────────────────────────────────────
// SERVICIO DE DIRECTORIO DE COORDINADORES + BALANCEADOR DE CARGA
//
// Los coordinadores se anuncian con POST /heartbeat cada 2 s. Si uno no lo hace
// durante HEARTBEAT_TTL_MS (6 s = 3 ciclos) se considera muerto y se descarta.
//
//   GET /coordinator              → el coordinador vivo MENOS cargado
//   GET /coordinator?prefer=X     → X si está vivo (anfitrión de una sala)
//   GET /coordinator?exclude=X    → cualquiera menos X (el que acaba de fallar)
//   GET /coordinators             → todos, con carga y último latido
//   GET /peers                    → { coordinatorId, peerUrl } de cada uno
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const { config } = require('../config');

const router = express.Router();
const COORD_ID_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

// Map<coordinatorId, { coordinatorId, publicUrl, peerUrl, connectedPlayers, reserved, uptime, lastSeen }>
const coordinators = new Map();
let roundRobin = 0;

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
    }
  }
}
setInterval(sweep, 1000).unref();

function alive() {
  sweep();
  return [...coordinators.values()];
}

// Carga = jugadores reportados + reservas hechas desde el último heartbeat
const load = (c) => c.connectedPlayers + c.reserved;

// ── POST /heartbeat ───────────────────────────────────────────────────────────
router.post('/heartbeat', (req, res) => {
  const { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime } = req.body || {};

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
    reserved: 0,               // el heartbeat trae la cifra real
    uptime: Number.isFinite(Number(uptime)) ? Number(uptime) : 0,
    lastSeen: Date.now()
  });
  if (!prev) console.log(`[DIRECTORY] Coordinador registrado: ${coordinatorId} (${publicUrl}, pares ${peerUrl})`);
  else if (prev.publicUrl !== publicUrl) console.log(`[DIRECTORY] ${coordinatorId} cambió su URL pública a ${publicUrl}`);

  return res.status(200).json({ ok: true });
});

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

  console.log(`[DIRECTORY] GET /coordinator → ${best.coordinatorId} · ${reason}${exclude ? ` · excluyendo ${exclude}` : ''}`);
  return res.json({ coordinatorId: best.coordinatorId, publicUrl: best.publicUrl });
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
