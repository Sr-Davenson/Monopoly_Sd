// ─────────────────────────────────────────────────────────────────────────────
// Configuración del coordinador (línea de comandos > .env > valores por defecto)
//
//   node index.js --id coord-david --port 5001 --auth-url https://xxx.ngrok-free.app
//   node index.js --id coord-david --port 5001 --ngrok      (abre el túnel solo)
//
// La mesh entre coordinadores usa el MISMO puerto que los clientes (ruta /peer),
// así cada coordinador necesita un único túnel de ngrok.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('node:path');
const os = require('node:os');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { parseArgs } = require('node:util');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id:           { type: 'string' },
    port:         { type: 'string' },
    'public-url': { type: 'string' },
    'peer-url':   { type: 'string' },
    'auth-url':   { type: 'string' },
    ngrok:        { type: 'boolean' },   // lanzar `ngrok http <port>` automáticamente
    'no-panel':   { type: 'boolean' },   // no abrir el panel en el navegador
    'peer-port':  { type: 'string' },    // obsoleto: la mesh ya va por el puerto de clientes
    role:         { type: 'string' }     // compatibilidad con talleres anteriores
  }
});

// Si el puerto viene por línea de comandos (varios coordinadores en la misma
// carpeta), la identidad del .env se ignora para que no la compartan.
const fromCli = Boolean(args.port || positionals[0]);
const envId   = (name) => (fromCli ? undefined : process.env[name]);
const clean   = (u) => (u ? String(u).replace(/\/+$/, '') : u);

const PORT = Number(args.port || positionals[0] || process.env.PORT || process.env.COORDINATOR_PORT || 5000);

// Id por defecto: nombre del equipo + puerto. Así dos personas que arrancan el
// coordinador en máquinas distintas con el mismo puerto NO comparten id (si lo
// compartieran, el auth-service los vería como uno solo).
function defaultId() {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'host';
  return `coord-${host}-${PORT}`;
}

const config = {
  PORT,
  COORDINATOR_ID: args.id || envId('COORDINATOR_ID') || defaultId(),
  AUTH_URL:       clean(args['auth-url'] || process.env.AUTH_URL || 'http://localhost:4000'),
  JWT_SECRET:     process.env.JWT_SECRET,

  // URLs anunciadas al directorio. Pueden cambiar en caliente si se detecta
  // un túnel de ngrok después de arrancar (ver ngrok.js).
  publicUrl:        clean(args['public-url'] || envId('PUBLIC_URL')) || null,
  peerUrl:          clean(args['peer-url'] || envId('PEER_URL')) || null,
  publicUrlFixed:   Boolean(args['public-url'] || envId('PUBLIC_URL')),
  peerUrlFixed:     Boolean(args['peer-url'] || envId('PEER_URL')),
  launchNgrok:      Boolean(args.ngrok || process.env.NGROK === '1'),
  openPanel:        !args['no-panel'] && process.env.OPEN_PANEL !== '0',
  legacyPeerPort:   args['peer-port'] || null,

  DIRECTORY_EVERY_MS: Number(process.env.DIRECTORY_INTERVAL || 2000), // heartbeat + /coordinators
  PEER_PING_MS:       2000,   // keepalive del enlace entre coordinadores
  POSITION_SYNC_MS:   1000,   // corrección de deriva de posiciones
  HEARTBEAT_MS:       Number(process.env.HEARTBEAT_INTERVAL || 30000), // ping a clientes

  // Re-validación periódica del token de cada cliente
  AUTH_CHALLENGE_INTERVAL: Number(process.env.AUTH_CHALLENGE_INTERVAL || 20000),
  AUTH_CHALLENGE_TIMEOUT:  Number(process.env.AUTH_CHALLENGE_TIMEOUT  ||  5000),

  // Plaza (canvas)
  WORLD_WIDTH:   Number(process.env.WORLD_WIDTH   || 800),
  WORLD_HEIGHT:  Number(process.env.WORLD_HEIGHT  || 600),
  PLAYER_RADIUS: Number(process.env.PLAYER_RADIUS || 18),
  PLAYER_SPEED:  Number(process.env.PLAYER_SPEED  || 200),
  TICK_RATE:     20,

  // Salas
  MAX_ROOMS:         Number(process.env.MAX_ROOMS || 24),
  ROOM_EMPTY_MS:     Number(process.env.ROOM_EMPTY_MS || 60000),    // sala sin nadie (sin iniciar) → se borra
  ROOM_ABANDON_MS:   Number(process.env.ROOM_ABANDON_MS || 90000),  // partida sin nadie conectado → se borra
  ORPHAN_GRACE_MS:   Number(process.env.ORPHAN_GRACE_MS || 4000),   // anfitrión caído → otro adopta la sala
  ROOM_EMBLEMS:      ['kraken', 'cofre', 'yggdrasil', 'dragon', 'drakkar', 'martillo', 'babel', 'pluma'],

  STARTED_AT: Date.now()
};
config.TICK_MS = 1000 / config.TICK_RATE;

// URL local mientras no haya una pública (ngrok)
config.localUrl = `ws://localhost:${PORT}`;
config.getPublicUrl = () => config.publicUrl || config.localUrl;
config.getPeerUrl   = () => config.peerUrl || `${config.getPublicUrl()}/peer`;

function validate() {
  if (!config.JWT_SECRET) {
    console.error('[ERROR] JWT_SECRET no está definida en coordinator/.env');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(config.COORDINATOR_ID)) {
    console.error('[ERROR] COORDINATOR_ID inválido (solo letras, números, guion, punto y guion bajo)');
    process.exit(1);
  }
}

module.exports = { config, validate };
