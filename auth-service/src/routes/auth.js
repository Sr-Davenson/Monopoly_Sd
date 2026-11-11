// ─────────────────────────────────────────────────────────────────────────────
// Rutas de autenticación: registro, login local y login con Google.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { config } = require('../config');
const { stmts } = require('../db');

const { JWT_SECRET, JWT_EXPIRES_IN, BCRYPT_ROUNDS, GOOGLE_CLIENT_ID } = config;
const router = express.Router();
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Solo letras, dígitos y guion bajo — bloquea caracteres especiales / inyecciones
const SAFE_USERNAME_RE = /^[a-zA-Z0-9_]+$/;

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
router.post('/register', async (req, res) => {
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
router.post('/login', async (req, res) => {
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
router.post('/auth/google', async (req, res) => {
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

module.exports = router;
