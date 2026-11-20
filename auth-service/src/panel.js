// ─────────────────────────────────────────────────────────────────────────────
// PANEL DEL AUTH-SERVICE (Taller 7)
//
// Al arrancar, cada auth abre en el navegador  http://localhost:<puerto>/
// Ahí se ve: su rol (líder / réplica / candidato), el term, cuánto falta para
// que una réplica declare muerto al líder, TODOS los auths del clúster con lo
// que cada uno dice de sí mismo (/status), los usuarios y el log de
// replicación de la BD local y los eventos (elecciones, votos, sync...).
//
// El panel y su API solo responden a peticiones locales (no por el túnel).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('node:path');
const { exec } = require('node:child_process');
const express = require('express');
const { config } = require('./config');
const cluster = require('./cluster');
const store = require('./db');
const { events } = require('./events');

const PANEL_DIR = path.join(__dirname, '..', 'panel');
const STARTED_AT = Date.now();

function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  // ngrok también llega desde localhost, pero agrega X-Forwarded-For
  if (loopback && !req.headers['x-forwarded-for']) return next();
  res.status(403).json({ error: 'El panel solo está disponible en la máquina del auth' });
}

// Lo que cada auth dice de sí mismo (GET /status por su URL pública)
async function remoteStatus(url) {
  if (!url) return null;
  try {
    const res = await fetch(`${url}/status`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(1200)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function panelData() {
  const self = cluster.status();
  const nodes = await Promise.all(cluster.peerList().map(async (p) => {
    const status = p.self ? self : await remoteStatus(p.publicUrl);
    return {
      authId: p.authId,
      self: Boolean(p.self),
      publicUrl: p.publicUrl,
      peerUrl: p.peerUrl,
      linked: p.self ? true : Boolean(p.connected),
      reachable: Boolean(status),
      status
    };
  }));

  return {
    self,
    election: cluster.electionInfo(),
    nodes,
    db: { path: config.DB_PATH, users: store.recentUsers(12), log: store.logTail(12) },
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    events: events.slice(-80).reverse()
  };
}

function mount(app) {
  app.get('/api/panel', localOnly, async (req, res) => {
    try { res.json(await panelData()); } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.use('/', localOnly, express.static(PANEL_DIR));
}

function openInBrowser() {
  if (!config.OPEN_PANEL) return;
  const target = `http://localhost:${config.PORT}/`;
  const cmd = process.platform === 'win32' ? `start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"`
    : `xdg-open "${target}"`;
  exec(cmd, () => { /* si no hay navegador, la URL ya quedó en consola */ });
}

module.exports = { mount, openInBrowser };
