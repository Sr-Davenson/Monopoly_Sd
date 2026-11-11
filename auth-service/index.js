// ─────────────────────────────────────────────────────────────────────────────
// AUTH-SERVICE — punto de entrada
//
// Módulos (src/):
//   config.js            variables del .env
//   db.js                SQLite (usuarios, progreso, partidas)
//   routes/auth.js       /register · /login · /auth/google
//   routes/directory.js  /heartbeat · /coordinator (balanceo) · /coordinators · /peers
//   routes/progress.js   /me/progress · /internal/match-result
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const { config, validate } = require('./src/config');

validate();

const app = express();
app.use(cors());
app.use(express.json({ limit: '16kb' }));

// Manejo de JSON malformado
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Body JSON inválido' });
  }
  next(err);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'auth-service' }));

app.use(require('./src/routes/auth'));
app.use(require('./src/routes/directory'));
app.use(require('./src/routes/progress'));

app.listen(config.PORT, () => {
  console.log(`[AUTH] Servicio corriendo en http://localhost:${config.PORT} (JWT expira en: ${config.JWT_EXPIRES_IN})`);
  console.log(`[DIRECTORY] Directorio de coordinadores activo (TTL de heartbeat: ${config.HEARTBEAT_TTL_MS} ms)`);
});
