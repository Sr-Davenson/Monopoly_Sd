// ─────────────────────────────────────────────────────────────────────────────
// Rutas de autenticación: registro, login local y login con Google.
//
// Taller 7 — replicación single-writer:
//   · Escrituras (registro local, primer login con Google): solo el LÍDER.
//     Una réplica responde 503 { error: 'not_leader', leaderUrl } y el cliente
//     repite la petición contra leaderUrl. Durante una elección: 503 no_leader.
//   · Lecturas (login, Google de un usuario existente): cualquier nodo cuyo
//     lastAppliedSeq esté a menos de LAG_TOLERANCE del líder.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { config } = require('../config');
const { stmts } = require('../db');
const cluster = require('../cluster');
const { refuse, leaderOnly, freshRead } = require('./cluster');

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

// Una réplica que NO encuentra al usuario y está algo atrasada no puede
// asegurar que no exista (quizá se registró hace un instante): mejor al líder.
function missingOnStaleReplica() {
  return !cluster.isLeader() && cluster.lag() > 0 ? cluster.writeRefusal() : null;
}

// ── POST /register (ESCRITURA → solo el líder) ────────────────────────────────
router.post('/register', leaderOnly, async (req, res) => {
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

    if (stmts.findByUsername.get(cleanUsername)) {
      return res.status(409).json({ error: 'El nombre de usuario ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // El líder decide userId, hash y fecha; las réplicas aplican lo mismo.
    const out = await cluster.propose(() => {
      if (stmts.findByUsername.get(cleanUsername)) return { error: 'taken' };
      return {
        op: 'register',
        data: {
          userId: stmts.nextUserId.get().id,
          username: cleanUsername,
          provider: 'local',
          password_hash: passwordHash,
          created_at: new Date().toISOString()
        }
      };
    });

    if (!out.ok) {
      if (out.result && out.result.error === 'taken') {
        return res.status(409).json({ error: 'El nombre de usuario ya está registrado' });
      }
      return refuse(res, out.refusal);
    }

    const userId = String(out.entry.data.userId);
    console.log(`[AUTH] Registro local: ${cleanUsername} (id: ${userId}, seq #${out.entry.seq}, confirmado por: ${out.acks.join(', ') || 'solo líder'})`);
    return res.status(201).json({ userId, username: cleanUsername, seq: out.entry.seq, replicatedTo: out.acks });

  } catch (err) {
    console.error('[AUTH ERROR] /register:', err.message);
    return res.status(500).json({ error: 'Error interno al procesar el registro' });
  }
});

// ── POST /login (LECTURA → líder o réplica al día) ────────────────────────────
router.post('/login', freshRead, async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Se requieren los campos username y password válidos' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const usernameError = validateUsername(cleanUsername);
    if (usernameError) return res.status(400).json({ error: usernameError });

    const user = stmts.findByUsername.get(cleanUsername);
    if (!user) {
      const stale = missingOnStaleReplica();
      if (stale) return refuse(res, stale);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // IMPORTANTE: usuarios de Google no tienen contraseña — deben usar /auth/google
    if (user.provider !== 'local') {
      return res.status(401).json({
        error: 'Esta cuenta fue creada con Google. Usa el botón "Iniciar sesión con Google".'
      });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Credenciales inválidas' });

    console.log(`[AUTH] Login local: ${user.username} (id: ${user.id}) atendido por ${cluster.SELF} (${cluster.isLeader() ? 'líder' : 'réplica'})`);
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
//   3a. Si ya existe → 200 { token, username }                 (lectura)
//   3b. Si es nuevo  → 409 { error: 'username_required' }      (lectura)
//   3c. Cliente reenvía { idToken, username }
//   3d. Se crea el usuario → 200 { token, username }           (ESCRITURA → líder)
router.post('/auth/google', async (req, res) => {
  const { idToken, username } = req.body || {};

  if (typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken requerido' });
  }

  // Una réplica muy atrasada (o sin líder) no emite tokens
  const readRefusal = cluster.readRefusal();
  if (readRefusal) return refuse(res, readRefusal);

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
    console.log(`[AUTH] Login Google existente: ${existing.username} (id: ${existing.id}) atendido por ${cluster.SELF}`);
    return res.status(200).json({ token: emitToken(existing), username: existing.username });
  }
  const stale = missingOnStaleReplica();
  if (stale) return refuse(res, stale);

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
  if (typeof username !== 'string') return res.status(400).json({ error: 'username debe ser string' });
  const cleanUsername = username.trim().toLowerCase();
  const usernameError = validateUsername(cleanUsername);
  if (usernameError) return res.status(400).json({ error: usernameError });

  // 6. Crear el usuario Google: ESCRITURA → solo el líder
  const out = await cluster.propose(() => {
    if (stmts.findByUsername.get(cleanUsername)) return { error: 'username_taken' };
    if (stmts.findByGoogle.get(googleSub)) return { error: 'already_linked' };
    return {
      op: 'register_google',
      data: {
        userId: stmts.nextUserId.get().id,
        username: cleanUsername,
        provider: 'google',
        google_sub: googleSub,
        email,
        created_at: new Date().toISOString()
      }
    };
  });

  if (!out.ok) {
    if (out.result && out.result.error === 'username_taken') return res.status(409).json({ error: 'username_taken' });
    if (out.result && out.result.error === 'already_linked') {
      const user = stmts.findByGoogle.get(googleSub);
      return res.status(200).json({ token: emitToken(user), username: user.username });
    }
    return refuse(res, out.refusal);
  }

  const newUser = { id: out.entry.data.userId, username: cleanUsername, provider: 'google' };
  console.log(`[AUTH] Registro Google: ${cleanUsername} (id: ${newUser.id}, email: ${email}, seq #${out.entry.seq})`);
  return res.status(200).json({ token: emitToken(newUser), username: cleanUsername });
});

module.exports = router;
