// ─────────────────────────────────────────────────────────────────────────────
// AUTH-SERVICE — punto de entrada
//
//   node index.js                       nodo único en :4000 (talleres anteriores)
//   npm run start:a | start:b | start:c clúster replicado de 3 nodos (Taller 7)
//
// Módulos (src/):
//   config.js            línea de comandos + .env
//   db.js                SQLite local + log de replicación
//   cluster.js           mesh de auths, líder/réplica, propagación, sync, elección
//   routes/cluster.js    /status · /peers (auths) + guardas leaderOnly / freshRead
//   routes/auth.js       /register · /login · /auth/google
//   routes/directory.js  /heartbeat · /coordinator (balanceo) · /coordinators · /coordinator-peers
//   routes/progress.js   /me/progress · /internal/match-result
//   panel.js + panel/    panel del auth en http://localhost:<puerto>/ (solo local)
//   events.js            eventos recientes (copia de la consola) para el panel
// ─────────────────────────────────────────────────────────────────────────────
require('./src/events');               // primero: copia la consola al panel
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { config, validate } = require('./src/config');

validate();

const cluster = require('./src/cluster');
const clusterRoutes = require('./src/routes/cluster');

const app = express();
// X-Auth-Id / X-Auth-Role: el cliente muestra a qué auth quedó conectado
app.use(cors({ exposedHeaders: ['X-Auth-Id', 'X-Auth-Role'] }));
app.use((req, res, next) => {
  res.set('X-Auth-Id', config.AUTH_ID);
  res.set('X-Auth-Role', cluster.isLeader() ? 'leader' : 'replica');
  next();
});
app.use(express.json({ limit: '16kb' }));

// Manejo de JSON malformado
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Body JSON inválido' });
  }
  next(err);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'auth-service', authId: config.AUTH_ID }));

app.use(clusterRoutes.router);
app.use(require('./src/routes/auth'));
app.use(require('./src/routes/directory'));
app.use(require('./src/routes/progress'));

// Panel (solo local). Va AL FINAL: se monta en "/" y no debe tapar las rutas.
const panel = require('./src/panel');
panel.mount(app);

const server = http.createServer(app);
server.on('error', (err) => {
  console.error(`[AUTH] No se pudo abrir el puerto ${config.PORT}: ${err.message}`);
  process.exit(1);
});
server.listen(config.PORT, () => {
  console.log(`[AUTH] ${config.AUTH_ID} en http://localhost:${config.PORT} (pública: ${config.PUBLIC_URL}) · BD: ${config.DB_PATH} · JWT expira en ${config.JWT_EXPIRES_IN}`);
  console.log(`[DIRECTORY] Directorio de coordinadores activo (TTL de heartbeat: ${config.HEARTBEAT_TTL_MS} ms)`);
  console.log(`[PANEL] Panel del auth: http://localhost:${config.PORT}/`);
  cluster.start(server);
  require('./src/ngrok').start(() => cluster.announcePublicUrl());
  panel.openInBrowser();
});

function shutdown() {
  console.log(`\n[AUTH] ${config.AUTH_ID} apagándose…`);
  cluster.shutdown();
  setTimeout(() => process.exit(0), 150);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
