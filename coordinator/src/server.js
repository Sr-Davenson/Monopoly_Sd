// ─────────────────────────────────────────────────────────────────────────────
// Servidor HTTP del coordinador. Un solo puerto para todo:
//   GET  /             panel del coordinador (solo local)
//   GET  /status       estado en JSON
//   WS   /connect      clientes (navegadores)
//   WS   /peer         otros coordinadores (mesh)
// ─────────────────────────────────────────────────────────────────────────────
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { config } = require('./config');
const { log } = require('./state');
const clients = require('./clients');
const mesh = require('./mesh');
const panel = require('./panel');
const directory = require('./directory');
const ngrok = require('./ngrok');
const loop = require('./loop');
const roomSvc = require('./rooms');

function start() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  // Público (sin login): lista de salas para la vista de espectador
  app.get('/rooms', (req, res) => {
    res.json({
      coordinatorId: config.COORDINATOR_ID,
      rooms: roomSvc.roomsSummary().map(r => ({
        id: r.id, name: r.name, emblem: r.emblem, host: r.host, status: r.status, phase: r.phase,
        players: r.players.map(p => ({ username: p.username, skin: p.skin, color: p.color, bankrupt: p.bankrupt })),
        maxPlayers: r.maxPlayers,
        spectators: r.spectators.length + r.anonymousSpectators
      }))
    });
  });
  panel.mount(app);

  const server = http.createServer(app);

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', (err) => log('WS', `Error en socket de upgrade: ${err.message}`));
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/connect') return clients.handleUpgrade(req, socket, head);
    if (pathname === '/peer') return mesh.handleUpgrade(req, socket, head);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  server.on('error', (err) => {
    console.error(`[${config.COORDINATOR_ID}] [START] No se pudo abrir el puerto ${config.PORT}: ${err.message}`);
    process.exit(1);
  });

  server.listen(config.PORT, () => {
    log('START', `Coordinador ${config.COORDINATOR_ID} en el puerto ${config.PORT}`);
    log('START', `Clientes: ${config.getPublicUrl()}/connect · Pares: ${config.getPeerUrl()}`);
    log('START', `Panel: http://localhost:${config.PORT}/  · Auths: ${config.AUTH_URLS.join(', ')}`);
    if (config.legacyPeerPort) log('START', '--peer-port ya no se usa: la mesh va por el mismo puerto (ruta /peer)');
    if (!config.publicUrlFixed) log('START', 'Sin --public-url: buscando un túnel de ngrok hacia este puerto…');
    ngrok.start();
    loop.start();
    directory.start();
    panel.openInBrowser();
  });

  // Ctrl+C: avisa al directorio para que los demás lo noten al instante
  let stopping = false;
  const stop = async () => {
    if (stopping) return process.exit(0);
    stopping = true;
    log('STOP', 'Cerrando: aviso al directorio para que reparta la carga entre los demás…');
    await directory.leave();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { start };
