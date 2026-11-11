// ─────────────────────────────────────────────────────────────────────────────
// COORDINADOR — punto de entrada
//
//   node index.js --id coord-david --port 5001 --auth-url https://<auth>.ngrok-free.app
//   node index.js --id coord-david --port 5001 --ngrok          (abre su túnel)
//
// Módulos (src/):
//   config.js     parámetros de línea de comandos y .env
//   state.js      estado en memoria (clientes, mundo, pares, salas) y envío
//   server.js     servidor HTTP: panel, /status, WS /connect y WS /peer
//   clients.js    WebSocket de los jugadores y sus mensajes
//   mesh.js       enlaces con los otros coordinadores y réplica
//   rooms.js      salas creadas por los jugadores (réplica, anfitrión, timers)
//   broadcast.js  difusión a los clientes locales
//   loop.js       game loop de la plaza (20 Hz)
//   directory.js  heartbeat al auth-service y descubrimiento de pares
//   ngrok.js      detección / lanzamiento del túnel de ngrok
//   panel.js      panel web del coordinador (carpeta panel/)
// ─────────────────────────────────────────────────────────────────────────────
const { validate } = require('./src/config');

validate();
require('./src/server').start();
