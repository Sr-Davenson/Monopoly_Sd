// ─────────────────────────────────────────────────────────────────────────────
// PROGRESO Y MISIONES (desbloqueo de fichas)
//   GET  /me/progress            (JWT de usuario)
//   POST /internal/match-result  (JWT de servicio de un coordinador)
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { db, stmts } = require('../db');

const { JWT_SECRET } = config;
const router = express.Router();

function statsFor(userId) {
  const row = stmts.getStats.get(Number(userId));
  return {
    gamesPlayed:      row ? row.games_played : 0,
    gamesWon:         row ? row.games_won : 0,
    propertiesBought: row ? row.properties_bought : 0,
    buildingsBuilt:   row ? row.buildings_built : 0
  };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// GET /me/progress — lo llama el cliente (y el coordinador en nombre del
// cliente, reenviando su JWT) para saber qué fichas tiene desbloqueadas.
router.get('/me/progress', (req, res) => {
  try {
    const payload = jwt.verify(bearer(req) || '', JWT_SECRET);
    if (!payload.userId || payload.role) throw new Error('no es un token de usuario');
    return res.json({ userId: String(payload.userId), stats: statsFor(payload.userId) });
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
});

// POST /internal/match-result — lo llama el coordinador cuando termina una
// partida. Se autentica con un JWT de servicio { role: 'coordinator' } firmado
// con el mismo JWT_SECRET (un usuario no puede fabricarlo).
router.post('/internal/match-result', (req, res) => {
  let service;
  try {
    service = jwt.verify(bearer(req) || '', JWT_SECRET);
    if (service.role !== 'coordinator') throw new Error('rol inválido');
  } catch {
    return res.status(401).json({ error: 'invalid_service_token' });
  }

  const { matchId, roomId, players } = req.body || {};
  if (typeof matchId !== 'string' || !matchId || matchId.length > 64 ||
      !Array.isArray(players) || players.length > 6) {
    return res.status(400).json({ error: 'resultado inválido' });
  }

  const clamp = (n) => Math.max(0, Math.min(1000, Math.floor(Number(n) || 0)));
  const record = db.transaction(() => {
    const inserted = stmts.insertMatch.run(matchId, String(roomId || ''), String(service.coordinatorId || ''));
    if (inserted.changes === 0) return false; // ya estaba reportada
    for (const p of players) {
      if (!p || !stmts.findById.get(Number(p.userId))) continue;
      stmts.addStats.run({
        userId: Number(p.userId),
        won: p.won ? 1 : 0,
        bought: clamp(p.propertiesBought),
        built: clamp(p.buildingsBuilt)
      });
    }
    return true;
  });

  const counted = record();
  console.log(`[AUTH] Partida ${matchId} (${roomId}) reportada por ${service.coordinatorId}: ${counted ? 'registrada' : 'duplicada, ignorada'}`);
  return res.json({ ok: true, counted });
});

module.exports = router;
