// ─────────────────────────────────────────────────────────────────────────────
// Configuración del auth-service (línea de comandos > .env > valores por defecto)
//
// Un solo nodo (como en talleres anteriores):
//   node index.js                                   → :4000, users.db, líder único
//
// Clúster replicado (Taller 7): un líder y réplicas.
//   node index.js --id auth-a --port 4001 --peer-port 4101 \
//     --cluster auth-a=ws://localhost:4101,auth-b=ws://localhost:4102,auth-c=ws://localhost:4103
//
// --cluster (o AUTH_CLUSTER en el .env) es la MISMA lista en los tres nodos:
// cada uno se reconoce por su --id y se conecta a los demás.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('node:path');
const { parseArgs } = require('node:util');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { values: args } = parseArgs({
  options: {
    id:          { type: 'string' },
    port:        { type: 'string' },
    'peer-port': { type: 'string' },
    'public-url': { type: 'string' },
    'peer-url':  { type: 'string' },
    cluster:     { type: 'string' },
    db:          { type: 'string' },
    seed:        { type: 'string' },
    'no-panel':  { type: 'boolean' }     // no abrir el panel en el navegador
  }
});

// Si el puerto viene por línea de comandos (varios auths en la misma carpeta),
// la identidad del .env (PORT, DB_PATH, PUBLIC_URL...) se ignora para no compartirla.
const fromCli = Boolean(args.port || args.id);
const envId   = (name) => (fromCli ? undefined : process.env[name]);
const clean   = (u) => (u ? String(u).replace(/\/+$/, '') : u);
const root    = (p) => path.resolve(__dirname, '..', p);

const PORT      = Number(args.port || envId('PORT') || 4000);
const AUTH_ID   = args.id || envId('AUTH_ID') || `auth-${PORT}`;
const PEER_PORT = Number(args['peer-port'] || envId('PEER_PORT') || PORT + 100);

// "auth-a=ws://host:4101,auth-b=ws://host:4102" → [{ authId, peerUrl }]
function parseCluster(text) {
  if (!text) return [];
  return String(text).split(',').map(s => s.trim()).filter(Boolean).map(item => {
    const i = item.indexOf('=');
    if (i <= 0) throw new Error(`Entrada de --cluster inválida: "${item}" (formato id=ws://host:puerto)`);
    return { authId: item.slice(0, i).trim(), peerUrl: clean(item.slice(i + 1).trim()) };
  });
}

const cluster = parseCluster(args.cluster || process.env.AUTH_CLUSTER);

const config = {
  AUTH_ID,
  PORT,
  PEER_PORT,
  PUBLIC_URL: clean(args['public-url'] || envId('PUBLIC_URL')) || `http://localhost:${PORT}`,
  PEER_URL:   clean(args['peer-url'] || envId('PEER_URL'))     || `ws://localhost:${PEER_PORT}`,
  // Pares del clúster (sin uno mismo). Vacío = nodo único, líder de inmediato.
  PEERS: cluster.filter(p => p.authId !== AUTH_ID),

  JWT_SECRET:       process.env.JWT_SECRET,
  JWT_EXPIRES_IN:   process.env.JWT_EXPIRES_IN || '1h',
  BCRYPT_ROUNDS:    Math.max(10, Number(process.env.BCRYPT_ROUNDS || 10)),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,

  // Base de datos local de ESTE nodo. En clúster cada nodo tiene la suya.
  DB_PATH: args.db ? root(args.db)
         : envId('DB_PATH') ? root(envId('DB_PATH'))
         : cluster.length ? root(path.join('data', `${AUTH_ID}.db`))
         : root('users.db'),
  // BD heredada para sembrar un nodo NUEVO (todos los nodos copian la misma,
  // así arrancan con el mismo log). Solo se usa si DB_PATH no existe todavía.
  SEED_DB: args.seed ? root(args.seed) : (process.env.SEED_DB ? root(process.env.SEED_DB) : null),

  // Panel del auth (http://localhost:<puerto>/): se abre solo al arrancar
  OPEN_PANEL: !args['no-panel'] && process.env.OPEN_PANEL !== '0',

  // Directorio de coordinadores
  HEARTBEAT_TTL_MS: Number(process.env.HEARTBEAT_TTL_MS || 3000),   // 3 latidos de 1 s

  // Replicación y elección (Taller 7)
  LEADER_HEARTBEAT_MS: Number(process.env.LEADER_HEARTBEAT_MS || 2000),  // líder → réplicas
  ELECTION_TIMEOUT_MS: Number(process.env.ELECTION_TIMEOUT_MS || 6000),  // 3 latidos perdidos
  ELECTION_JITTER_MS:  Number(process.env.ELECTION_JITTER_MS  || 1500),  // evita empates
  WRITE_ACK_TIMEOUT_MS: Number(process.env.WRITE_ACK_TIMEOUT_MS || 3000), // opción B
  LAG_TOLERANCE:       Number(process.env.LAG_TOLERANCE ?? 10)            // lecturas en réplicas
};

function validate() {
  if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) {
    console.error('[ERROR] JWT_SECRET no está definida o tiene menos de 32 caracteres.');
    process.exit(1);
  }
  if (!config.GOOGLE_CLIENT_ID) {
    console.error('[ERROR] GOOGLE_CLIENT_ID no está definida en el archivo .env');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(config.AUTH_ID)) {
    console.error('[ERROR] --id inválido (solo letras, números, guion, punto y guion bajo)');
    process.exit(1);
  }
  if (cluster.length && !cluster.some(p => p.authId === AUTH_ID)) {
    console.warn(`[WARN] ${AUTH_ID} no aparece en --cluster; se suma igual como nodo extra.`);
  }
}

module.exports = { config, validate };
