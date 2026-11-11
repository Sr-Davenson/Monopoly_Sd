// ─────────────────────────────────────────────────────────────────────────────
// PANEL DEL COORDINADOR
//
// Al arrancar, el coordinador abre en el navegador  http://localhost:<puerto>/
// Ahí se ve: su identidad y URL pública (ngrok), TODOS los coordinadores que
// conoce el directorio con su carga y el estado del enlace mesh con cada uno,
// las salas (y quién las aloja), los jugadores y los eventos recientes.
//
// El panel y su API solo responden a peticiones locales (no por el túnel).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('node:path');
const { exec } = require('node:child_process');
const express = require('express');
const { config } = require('./config');
const { clients, world, peers, rooms, directory, stats, events } = require('./state');
const roomSvc = require('./rooms');
const mesh = require('./mesh');
const ngrok = require('./ngrok');

const PANEL_DIR = path.join(__dirname, '..', 'panel');

function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  // ngrok también llega desde localhost, pero agrega X-Forwarded-For
  if (loopback && !req.headers['x-forwarded-for']) return next();
  res.status(403).json({ error: 'El panel solo está disponible en la máquina del coordinador' });
}

function panelData() {
  const now = Date.now();
  const known = new Map(directory.list.map(c => [c.coordinatorId, c]));
  for (const id of peers.keys()) if (!known.has(id)) known.set(id, { coordinatorId: id, unlisted: true });

  const coordinators = [...known.values()]
    .sort((a, b) => a.coordinatorId.localeCompare(b.coordinatorId))
    .map(c => {
      const self = c.coordinatorId === config.COORDINATOR_ID;
      return {
        coordinatorId: c.coordinatorId,
        self,
        publicUrl: c.publicUrl || null,
        peerUrl: c.peerUrl || null,
        connectedPlayers: c.connectedPlayers ?? null,
        uptime: c.uptime ?? null,
        lastSeenMsAgo: c.lastSeenMsAgo ?? null,
        unlisted: !!c.unlisted,
        localUrl: /\/\/(localhost|127\.)/.test(c.publicUrl || ''),
        link: self ? { state: 'yo' } : mesh.linkStatus(c.coordinatorId),
        rooms: [...rooms.values()].filter(r => r.host === c.coordinatorId).length
      };
    });

  return {
    self: {
      coordinatorId: config.COORDINATOR_ID,
      port: config.PORT,
      publicUrl: config.getPublicUrl(),
      peerUrl: config.getPeerUrl(),
      authUrl: config.AUTH_URL,
      uptime: Math.round((now - config.STARTED_AT) / 1000),
      leader: mesh.isLeader(),
      localPlayers: clients.size
    },
    ngrok: ngrok.status,
    directory: { ok: directory.ok, error: directory.error, updatedMsAgo: directory.updatedAt ? now - directory.updatedAt : null },
    coordinators,
    rooms: roomSvc.roomsSummary().map(r => ({
      id: r.id, name: r.name, host: r.host, status: r.status,
      players: r.players.length, maxPlayers: r.maxPlayers, spectators: r.spectators.length,
      createdBy: r.createdBy ? r.createdBy.username : null
    })),
    players: [...world.values()].map(w => ({
      username: w.username, coordinatorId: w.coordinatorId, view: w.view,
      room: w.roomId && rooms.get(w.roomId) ? rooms.get(w.roomId).name : null
    })),
    replication: stats,
    events: events.slice(-40).reverse()
  };
}

function mount(app) {
  // Estado público (debug, igual que en talleres anteriores)
  app.get('/status', (req, res) => {
    res.json({
      coordinatorId: config.COORDINATOR_ID,
      publicUrl: config.getPublicUrl(),
      peerUrl: config.getPeerUrl(),
      uptime: Math.round((Date.now() - config.STARTED_AT) / 1000),
      connectedPlayers: clients.size,
      peers: [...peers.entries()].map(([id, p]) => ({ coordinatorId: id, direction: p.direction, since: p.since })),
      rooms: roomSvc.roomsSummary(),
      replication: stats
    });
  });

  app.get('/api/panel', localOnly, (req, res) => res.json(panelData()));
  app.use('/', localOnly, express.static(PANEL_DIR));
}

function openInBrowser() {
  if (!config.openPanel) return;
  const target = `http://localhost:${config.PORT}/`;
  const cmd = process.platform === 'win32' ? `start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"`
    : `xdg-open "${target}"`;
  exec(cmd, () => { /* si no hay navegador, la URL ya quedó en consola */ });
}

module.exports = { mount, openInBrowser };
