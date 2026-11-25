// ─────────────────────────────────────────────────────────────────────────────
// Rutas del clúster de auth-services (Taller 7)
//   GET /status  → rol, líder, lastAppliedSeq, usuarios...
//   GET /peers   → auth-services conocidos y su rol
// y helpers para que las demás rutas respeten líder / réplica.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const cluster = require('../cluster');

const router = express.Router();

router.get('/status', (req, res) => res.json(cluster.status()));
router.get('/peers', (req, res) => res.json({ peers: cluster.peerList() }));

// 503 { error: 'not_leader', leaderUrl } · 503 { error: 'no_leader' } · 503 { error: 'replication_timeout' }
function refuse(res, refusal) {
  return res.status(503).json(refusal);
}

// Middleware: solo el líder atiende esta ruta (escrituras)
function leaderOnly(req, res, next) {
  const refusal = cluster.writeRefusal();
  return refusal ? refuse(res, refusal) : next();
}

// Middleware: lecturas que deben estar al día (réplica muy atrasada → al líder)
function freshRead(req, res, next) {
  const refusal = cluster.readRefusal();
  return refusal ? refuse(res, refusal) : next();
}

module.exports = { router, refuse, leaderOnly, freshRead };
