// Base de datos SQLite: usuarios, progreso de misiones y partidas reportadas
const Database = require('better-sqlite3');
const { config } = require('./config');

const db = new Database(config.DB_PATH);

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

  -- Progreso de cada usuario para las misiones de desbloqueo de fichas
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

module.exports = { db, stmts };
