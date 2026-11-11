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

function start() {
  const app = express();
  app.use(cors());
  app.use(express.json());
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
    log('START', `Panel: http://localhost:${config.PORT}/  · Auth: ${config.AUTH_URL}`);
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
