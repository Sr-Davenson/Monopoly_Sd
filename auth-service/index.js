const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express          = require('express');
const cors             = require('cors');
const Database         = require('better-sqlite3');
const bcrypt           = require('bcrypt');
const jwt              = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

// ── Configuración ──────────────────────────────────────────────────────────────
const PORT            = Number(process.env.PORT || 4000);
const JWT_SECRET      = process.env.JWT_SECRET;
const JWT_EXPIRES_IN  = process.env.JWT_EXPIRES_IN || '1h';
const BCRYPT_ROUNDS   = Math.max(10, Number(process.env.BCRYPT_ROUNDS || 10));
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const DB_PATH         = process.env.DB_PATH
  ? path.resolve(__dirname, process.env.DB_PATH)
  : path.join(__dirname, 'users.db');

// Solo letras, dígitos y guion bajo — bloquea caracteres especiales / inyecciones
const SAFE_USERNAME_RE = /^[a-zA-Z0-9_]+$/;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[ERROR] JWT_SECRET no está definida o tiene menos de 32 caracteres.');
  process.exit(1);
}
if (!GOOGLE_CLIENT_ID) {
  console.error('[ERROR] GOOGLE_CLIENT_ID no está definida en el archivo .env');
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── Base de datos ──────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

// Schema Taller 5: una sola tabla con columna provider
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    provider      TEXT    NOT NULL CHECK(provider IN ('local','google')) DEFAULT 'local',
    password_hash TEXT,
    google_sub    TEXT    UNIQUE,
    email         TEXT,
    created_at    TEXT    DEFAULT CURRENT_TIMESTAMP
  );
`);

// Taller 6: progreso de cada usuario para las misiones de desbloqueo de fichas
db.exec(`
  CREATE TABLE IF NOT EXISTS user_stats (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id),
    games_played       INTEGER NOT NULL DEFAULT 0,
    games_won          INTEGER NOT NULL DEFAULT 0,
    properties_bought  INTEGER NOT NULL DEFAULT 0,
    buildings_built    INTEGER NOT NULL DEFAULT 0
  );
  -- Evita contar dos veces la misma partida si se reporta más de una vez
  CREATE TABLE IF NOT EXISTS matches (
    match_id     TEXT PRIMARY KEY,
    room_id      TEXT,
    reported_by  TEXT,
    finished_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const stmts = {
  insertLocal:    db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle:   db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  findById:       db.prepare('SELECT id FROM users WHERE id = ?'),
  getStats:       db.prepare('SELECT * FROM user_stats WHERE user_id = ?'),
  insertMatch:    db.prepare('INSERT OR IGNORE INTO matches (match_id, room_id, reported_by) VALUES (?, ?, ?)'),
  addStats:       db.prepare(`
    INSERT INTO user_stats (user_id, games_played, games_won, properties_bought, buildings_built)
    VALUES (@userId, 1, @won, @bought, @built)
    ON CONFLICT(user_id) DO UPDATE SET
      games_played      = games_played + 1,
      games_won         = games_won + @won,
      properties_bought = properties_bought + @bought,
      buildings_built   = buildings_built + @built
  `)
};

// ── App Express ───────────────────────────────────────────────────────────────
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function emitToken(user) {
  return jwt.sign(
    { userId: String(user.id), username: user.username, provider: user.provider },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function validateUsername(u) {
  if (typeof u !== 'string')               return 'username debe ser string';
  const clean = u.trim().toLowerCase();
  if (clean.length < 3 || clean.length > 32) return 'username debe tener entre 3 y 32 caracteres';
  if (!SAFE_USERNAME_RE.test(clean))       return 'username solo puede contener letras, números y guion bajo (_)';
  return null; // sin error
}

function isUniqueConstraintError(err) {
  return (
    err &&
    (err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
     err.code === 'SQLITE_CONSTRAINT' ||
     (err.message && err.message.includes('UNIQUE constraint failed')))
  );
}

// ── POST /register ─────────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Se requieren los campos username y password válidos' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const usernameError = validateUsername(cleanUsername);
    if (usernameError) return res.status(400).json({ error: usernameError });

    if (password.length < 4) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    }

    const existing = stmts.findByUsername.get(cleanUsername);
    if (existing) return res.status(409).json({ error: 'El nombre de usuario ya está registrado' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const info = stmts.insertLocal.run(cleanUsername, passwordHash);
    const userId = String(info.lastInsertRowid);

    console.log(`[AUTH] Registro local: ${cleanUsername} (id: ${userId})`);
    return res.status(201).json({ userId, username: cleanUsername });

  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: 'El nombre de usuario ya está registrado' });
    }
    console.error('[AUTH ERROR] /register:', err.message);
    return res.status(500).json({ error: 'Error interno al procesar el registro' });
  }
});

// ── POST /login ───────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Se requieren los campos username y password válidos' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const usernameError = validateUsername(cleanUsername);
    if (usernameError) return res.status(400).json({ error: usernameError });

    const user = stmts.findByUsername.get(cleanUsername);
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    // IMPORTANTE: usuarios de Google no tienen contraseña — deben usar /auth/google
    if (user.provider !== 'local') {
      return res.status(401).json({
        error: 'Esta cuenta fue creada con Google. Usa el botón "Iniciar sesión con Google".'
      });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Credenciales inválidas' });

    console.log(`[AUTH] Login local: ${user.username} (id: ${user.id})`);
    return res.status(200).json({ token: emitToken(user), username: user.username });

  } catch (err) {
    console.error('[AUTH ERROR] /login:', err.message);
    return res.status(500).json({ error: 'Error interno al procesar el inicio de sesión' });
  }
});

// ── POST /auth/google ─────────────────────────────────────────────────────────
// Opción A — Google Identity Services (token enviado desde el cliente)
//
// Flujo:
//   1. Cliente obtiene idToken con el botón GSI de Google
//   2. POST /auth/google { idToken }
//   3a. Si ya existe → 200 { token, username }
//   3b. Si es nuevo  → 409 { error: 'username_required' }  (cliente pide username)
//   3c. Cliente reenvía { idToken, username }
//   3d. Se crea el usuario → 200 { token, username }
app.post('/auth/google', async (req, res) => {
  const { idToken, username } = req.body || {};

  if (typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken requerido' });
  }

  // 1. Verificar el ID token contra las claves públicas de Google
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID   // valida que el token sea para ESTA app
    });
    payload = ticket.getPayload();
  } catch (err) {
    console.warn('[AUTH] ID token de Google inválido:', err.message);
    return res.status(401).json({ error: 'invalid_id_token' });
  }

  // 2. El email debe estar verificado por Google
  if (!payload.email_verified) {
    return res.status(401).json({ error: 'email_not_verified' });
  }

  const googleSub = payload.sub;    // identificador estable del usuario en Google
  const email     = payload.email;

  // 3. ¿Ya existe este google_sub en la base?
  const existing = stmts.findByGoogle.get(googleSub);
  if (existing) {
    console.log(`[AUTH] Login Google existente: ${existing.username} (id: ${existing.id})`);
    return res.status(200).json({ token: emitToken(existing), username: existing.username });
  }

  // 4. Primer login con esta cuenta de Google — necesita elegir username
  if (!username) {
    // Sugerir la parte local del email como hint (ya sin caracteres raros)
    const emailHint = email ? email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_') : '';
    return res.status(409).json({
      error: 'username_required',
      hint: emailHint
    });
  }

  // 5. Validar el username elegido
  const cleanUsername = username.trim().toLowerCase();
  const usernameError = validateUsername(cleanUsername);
  if (usernameError) return res.status(400).json({ error: usernameError });

  // 6. Crear el usuario Google
  try {
    const result  = stmts.insertGoogle.run(cleanUsername, googleSub, email);
    const newUser = { id: result.lastInsertRowid, username: cleanUsername, provider: 'google' };

    console.log(`[AUTH] Registro Google: ${cleanUsername} (id: ${newUser.id}, email: ${email})`);
    return res.status(200).json({ token: emitToken(newUser), username: cleanUsername });

  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error('[AUTH ERROR] /auth/google:', err.message);
    return res.status(500).json({ error: 'internal' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TALLER 6 — SERVICIO DE DIRECTORIO DE COORDINADORES
//
// Los coordinadores se anuncian con POST /heartbeat cada 2 s. Si uno no lo hace
// durante HEARTBEAT_TTL_MS (6 s = 3 ciclos) se considera muerto y se descarta.
// Los clientes preguntan a cuál conectarse con GET /coordinator (el menos
// cargado) y los coordinadores descubren a sus pares con GET /peers.
// ═════════════════════════════════════════════════════════════════════════════
const HEARTBEAT_TTL_MS = Number(process.env.HEARTBEAT_TTL_MS || 6000);
const COORD_ID_RE      = /^[a-zA-Z0-9_.-]{1,64}$/;

// Map<coordinatorId, { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime, lastSeen }>
const coordinators = new Map();

function isWsUrl(u) {
  if (typeof u !== 'string' || u.length > 512) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch { return false; }
}

// Descarta los coordinadores que dejaron de mandar heartbeat
function sweepCoordinators() {
  const now = Date.now();
  for (const [id, c] of coordinators) {
    if (now - c.lastSeen > HEARTBEAT_TTL_MS) {
      coordinators.delete(id);
      console.log(`[DIRECTORY] ${id} descartado: sin heartbeat hace ${now - c.lastSeen} ms`);
    }
  }
}
setInterval(sweepCoordinators, 1000).unref();

function aliveCoordinators() {
  sweepCoordinators();
  return Array.from(coordinators.values());
}

// ── POST /heartbeat ───────────────────────────────────────────────────────────
app.post('/heartbeat', (req, res) => {
  const { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime } = req.body || {};

  if (typeof coordinatorId !== 'string' || !COORD_ID_RE.test(coordinatorId)) {
    return res.status(400).json({ error: 'coordinatorId inválido' });
  }
  if (!isWsUrl(publicUrl) || !isWsUrl(peerUrl)) {
    return res.status(400).json({ error: 'publicUrl y peerUrl deben ser URLs ws:// o wss://' });
  }
  const players = Number(connectedPlayers);
  if (!Number.isInteger(players) || players < 0) {
    return res.status(400).json({ error: 'connectedPlayers debe ser un entero >= 0' });
  }

  const isNew = !coordinators.has(coordinatorId);
  coordinators.set(coordinatorId, {
    coordinatorId,
    publicUrl,
    peerUrl,
    connectedPlayers: players,
    uptime: Number.isFinite(Number(uptime)) ? Number(uptime) : 0,
    lastSeen: Date.now()
  });
  if (isNew) console.log(`[DIRECTORY] Coordinador registrado: ${coordinatorId} (${publicUrl}, peer ${peerUrl})`);

  return res.status(200).json({ ok: true });
});

// ── GET /coordinator ──────────────────────────────────────────────────────────
// Client-side load balancing: devuelve el coordinador vivo con menos jugadores.
// Empate → el primero que se encuentre. Ninguno vivo → 503.
// Opcional: ?exclude=coord-a para que un cliente que acaba de perder la conexión
// no vuelva al mismo coordinador (si es el único vivo, se ignora el filtro).
app.get('/coordinator', (req, res) => {
  const alive = aliveCoordinators();
  if (alive.length === 0) {
    return res.status(503).json({ error: 'no_coordinators_available' });
  }

  const exclude = typeof req.query.exclude === 'string' ? req.query.exclude : null;
  const candidates = exclude && alive.some(c => c.coordinatorId !== exclude)
    ? alive.filter(c => c.coordinatorId !== exclude)
    : alive;

  let best = candidates[0];
  for (const c of candidates) {
    if (c.connectedPlayers < best.connectedPlayers) best = c;
  }

  // Reserva provisional: si varios clientes piden a la vez, no van todos al
  // mismo coordinador antes de su siguiente heartbeat (que trae la cifra real).
  best.connectedPlayers++;

  console.log(`[DIRECTORY] GET /coordinator → ${best.coordinatorId}${exclude ? ` (excluyendo ${exclude})` : ''}`);
  return res.json({ coordinatorId: best.coordinatorId, publicUrl: best.publicUrl });
});

// ── GET /peers ────────────────────────────────────────────────────────────────
// Cada coordinador filtra su propio id de la lista.
app.get('/peers', (req, res) => {
  const peers = aliveCoordinators().map(c => ({ coordinatorId: c.coordinatorId, peerUrl: c.peerUrl }));
  res.json({ peers });
});

// ── GET /coordinators (debug / UI) ───────────────────────────────────────────
app.get('/coordinators', (req, res) => {
  const now = Date.now();
  res.json({
    ttlMs: HEARTBEAT_TTL_MS,
    coordinators: aliveCoordinators().map(c => ({ ...c, lastSeenMsAgo: now - c.lastSeen }))
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TALLER 6 — PROGRESO Y MISIONES (desbloqueo de fichas)
// ═════════════════════════════════════════════════════════════════════════════
function statsFor(userId) {
  const row = stmts.getStats.get(Number(userId));
  return {
    gamesPlayed:      row ? row.games_played : 0,
    gamesWon:         row ? row.games_won : 0,
    propertiesBought: row ? row.properties_bought : 0,
    buildingsBuilt:   row ? row.buildings_built : 0
  };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// GET /me/progress — lo llama el cliente (y el coordinador en nombre del
// cliente, reenviando su JWT) para saber qué fichas tiene desbloqueadas.
app.get('/me/progress', (req, res) => {
  try {
    const payload = jwt.verify(bearer(req) || '', JWT_SECRET);
    if (!payload.userId || payload.role) throw new Error('no es un token de usuario');
    return res.json({ userId: String(payload.userId), stats: statsFor(payload.userId) });
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
});

// POST /internal/match-result — lo llama el coordinador cuando termina una
// partida. Se autentica con un JWT de servicio { role: 'coordinator' } firmado
// con el mismo JWT_SECRET (un usuario no puede fabricarlo).
app.post('/internal/match-result', (req, res) => {
  let service;
  try {
    service = jwt.verify(bearer(req) || '', JWT_SECRET);
    if (service.role !== 'coordinator') throw new Error('rol inválido');
  } catch {
    return res.status(401).json({ error: 'invalid_service_token' });
  }

  const { matchId, roomId, players } = req.body || {};
  if (typeof matchId !== 'string' || !matchId || matchId.length > 64 ||
      !Array.isArray(players) || players.length > 6) {
    return res.status(400).json({ error: 'resultado inválido' });
  }

  const clamp = (n) => Math.max(0, Math.min(1000, Math.floor(Number(n) || 0)));
  const record = db.transaction(() => {
    const inserted = stmts.insertMatch.run(matchId, String(roomId || ''), String(service.coordinatorId || ''));
    if (inserted.changes === 0) return false; // ya estaba reportada
    for (const p of players) {
      if (!p || !stmts.findById.get(Number(p.userId))) continue;
      stmts.addStats.run({
        userId: Number(p.userId),
        won: p.won ? 1 : 0,
        bought: clamp(p.propertiesBought),
        built: clamp(p.buildingsBuilt)
      });
    }
    return true;
  });

  const counted = record();
  console.log(`[AUTH] Partida ${matchId} (${roomId}) reportada por ${service.coordinatorId}: ${counted ? 'registrada' : 'duplicada, ignorada'}`);
  return res.json({ ok: true, counted });
});

// ── Arranque ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[AUTH] Servicio corriendo en http://localhost:${PORT} (JWT expira en: ${JWT_EXPIRES_IN})`);
  console.log(`[DIRECTORY] Directorio de coordinadores activo (TTL de heartbeat: ${HEARTBEAT_TTL_MS} ms)`);
});
