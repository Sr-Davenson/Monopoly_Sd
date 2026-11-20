// ─────────────────────────────────────────────────────────────────────────────
// PROGRESO Y MISIONES (desbloqueo de fichas)
//   GET  /me/progress            (JWT de usuario)                 lectura
//   POST /me/prefs               (JWT de usuario)                 ESCRITURA → líder
//   POST /internal/match-result  (JWT de servicio de coordinador) ESCRITURA → líder
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { stmts, readPrefs, readCounters } = require('../db');
const cluster = require('../cluster');
const { refuse, leaderOnly, freshRead } = require('./cluster');

const { JWT_SECRET } = config;
const router = express.Router();

// Estadísticas que acepta /internal/match-result (además de jugar/ganar)
const MATCH_STATS = ['propertiesBought', 'buildingsBuilt', 'hotelsBuilt', 'rentCollected', 'tradesDone',
                     'cardsDrawn', 'jailVisits', 'lapsCompleted', 'potWins', 'doublesRolled', 'groupsCompleted'];
const STAT_MAX = { rentCollected: 200000 };
const ID_RE = /^[a-z0-9_]{1,40}$/;

// Globales: las 4 históricas salen de user_stats; el resto, de los contadores 'all'
function statsFor(userId, counters) {
  const row = stmts.getStats.get(Number(userId));
  return {
    ...(counters.all || {}),
    gamesPlayed:      row ? row.games_played : 0,
    gamesWon:         row ? row.games_won : 0,
    propertiesBought: row ? row.properties_bought : 0,
    buildingsBuilt:   row ? row.buildings_built : 0
  };
}

// { stats: globales, themes: { tema_x: contadores del grupo }, prefs }
function progressFor(userId) {
  const counters = readCounters(userId);
  const themes = {};
  for (const [scope, values] of Object.entries(counters)) if (scope !== 'all') themes[scope] = values;
  return { userId: String(userId), stats: statsFor(userId, counters), themes, prefs: readPrefs(userId) };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function userFrom(req) {
  const payload = jwt.verify(bearer(req) || '', JWT_SECRET);
  if (!payload.userId || payload.role) throw new Error('no es un token de usuario');
  return payload;
}

// GET /me/progress — lo llama el cliente (y el coordinador en nombre del
// cliente, reenviando su JWT) para saber qué fichas y dados tiene desbloqueados.
router.get('/me/progress', freshRead, (req, res) => {
  let payload;
  try { payload = userFrom(req); } catch { return res.status(401).json({ error: 'invalid_token' }); }
  return res.json(progressFor(payload.userId));
});

// POST /me/prefs — guarda ficha, color, dado y grupo en liberación para que
// se conserven al volver al lobby o al iniciar sesión otra vez.
// Body parcial: { themeId?, skinId?, color?, diceId?, unlockTheme?, mood? };
// se fusiona con lo guardado. Escritura replicada (solo el líder).
const PREF_RULES = {
  themeId:     ID_RE,
  skinId:      ID_RE,
  diceId:      ID_RE,
  unlockTheme: ID_RE,
  color:       /^#[0-9a-fA-F]{6}$/,
  mood:        /^.{0,8}$/u
};

router.post('/me/prefs', leaderOnly, async (req, res) => {
  let payload;
  try { payload = userFrom(req); } catch { return res.status(401).json({ error: 'invalid_token' }); }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  for (const [k, re] of Object.entries(PREF_RULES)) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'string' || !re.test(body[k])) return res.status(400).json({ error: `preferencia inválida: ${k}` });
    patch[k] = body[k];
  }
  const userId = Number(payload.userId);
  if (!Object.keys(patch).length) return res.json({ ok: true, prefs: readPrefs(userId) });

  const out = await cluster.propose(() => {
    if (!stmts.findById.get(userId)) return { error: 'unknown_user' };
    return { op: 'set_prefs', data: { userId, prefs: { ...readPrefs(userId), ...patch } } };
  });
  if (!out.ok) {
    if (out.result && out.result.error === 'unknown_user') return res.status(404).json({ error: 'unknown_user' });
    return refuse(res, out.refusal);
  }
  return res.json({ ok: true, prefs: readPrefs(userId) });
});

// POST /internal/match-result — lo llama el coordinador cuando termina una
// partida. Se autentica con un JWT de servicio { role: 'coordinator' } firmado
// con el mismo JWT_SECRET (un usuario no puede fabricarlo).
router.post('/internal/match-result', leaderOnly, async (req, res) => {
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

  const clampTo = (n, max) => Math.max(0, Math.min(max, Math.floor(Number(n) || 0)));
  const clamp = (n) => clampTo(n, 1000);
  const out = await cluster.propose(() => {
    if (stmts.findMatch.get(matchId)) return { error: 'duplicate' };   // ya estaba reportada
    return {
      op: 'match_result',
      data: {
        matchId,
        roomId: String(roomId || ''),
        reportedBy: String(service.coordinatorId || ''),
        finished_at: new Date().toISOString(),
        players: players.filter(p => p && p.userId != null).map(p => ({
          userId: Number(p.userId),
          won: p.won ? 1 : 0,
          bought: clamp(p.propertiesBought),
          built: clamp(p.buildingsBuilt),
          themeId: typeof p.themeId === 'string' && ID_RE.test(p.themeId) ? p.themeId : null,
          s: Object.fromEntries(MATCH_STATS.map(k => [k, clampTo(p.stats && p.stats[k], STAT_MAX[k] || 1000)]))
        }))
      }
    };
  });

  if (!out.ok && !(out.result && out.result.error === 'duplicate')) return refuse(res, out.refusal);
  const counted = out.ok;
  console.log(`[AUTH] Partida ${matchId} (${roomId}) reportada por ${service.coordinatorId}: ${counted ? `registrada (seq #${out.entry.seq})` : 'duplicada, ignorada'}`);
  return res.json({ ok: true, counted });
});

module.exports = router;
