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

const stmts = {
  insertLocal:    db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle:   db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
};

// ── App Express ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '4kb' }));

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

// ── Arranque ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[AUTH] Servicio corriendo en http://localhost:${PORT} (JWT expira en: ${JWT_EXPIRES_IN})`);
});
