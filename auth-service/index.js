require('dotenv').config();
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const BCRYPT_ROUNDS = Math.max(10, Number(process.env.BCRYPT_ROUNDS || 10));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'users.db');

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no está definida en el archivo .env');
  process.exit(1);
}

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const findUserByUsernameStmt = db.prepare(
  'SELECT id, username, password_hash, created_at FROM users WHERE username = ?'
);
const insertUserStmt = db.prepare(
  'INSERT INTO users (username, password_hash) VALUES (?, ?)'
);

const app = express();

app.use(cors());
app.use(express.json());

// Manejo de JSON malformado en el body
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Body JSON inválido' });
  }
  next(err);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !username.trim() ||
      !password
    ) {
      return res.status(400).json({
        error: 'Se requieren los campos username y password válidos'
      });
    }

    const cleanUsername = username.trim();

    if (cleanUsername.length < 3 || cleanUsername.length > 32) {
      return res.status(400).json({
        error: 'El username debe tener entre 3 y 32 caracteres'
      });
    }

    if (password.length < 4) {
      return res.status(400).json({
        error: 'La contraseña debe tener al menos 4 caracteres'
      });
    }

    const existing = findUserByUsernameStmt.get(cleanUsername);
    if (existing) {
      return res.status(409).json({
        error: 'El nombre de usuario ya está registrado'
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const info = insertUserStmt.run(cleanUsername, passwordHash);
    const userId = String(info.lastInsertRowid);

    console.log(`[AUTH] Usuario registrado: ${cleanUsername} (id: ${userId})`);

    return res.status(201).json({
      userId,
      username: cleanUsername
    });
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({
        error: 'El nombre de usuario ya está registrado'
      });
    }
    console.error('[AUTH ERROR] Error en /register:', err.message);
    return res.status(500).json({
      error: 'Error interno al procesar el registro'
    });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !username.trim() ||
      !password
    ) {
      return res.status(400).json({
        error: 'Se requieren los campos username y password válidos'
      });
    }

    const cleanUsername = username.trim();
    const user = findUserByUsernameStmt.get(cleanUsername);

    if (!user) {
      return res.status(401).json({
        error: 'Credenciales inválidas'
      });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({
        error: 'Credenciales inválidas'
      });
    }

    const userId = String(user.id);
    const token = jwt.sign(
      {
        userId,
        username: user.username
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    console.log(`[AUTH] Login exitoso: ${user.username} (id: ${userId})`);

    return res.status(200).json({
      token,
      username: user.username
    });
  } catch (err) {
    console.error('[AUTH ERROR] Error en /login:', err.message);
    return res.status(500).json({
      error: 'Error interno al procesar el inicio de sesión'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Auth service corriendo en http://localhost:${PORT} (JWT expira en: ${JWT_EXPIRES_IN})`);
});
