// ─────────────────────────────────────────────────────────────────────────────
// Base de datos SQLite LOCAL de este nodo: usuarios, progreso, partidas y el
// LOG DE REPLICACIÓN.
//
// Toda escritura pasa por applyEntry({ seq, term, op, data }):
//   · el líder la crea (seq = último + 1) y la aplica;
//   · las réplicas aplican exactamente la misma entrada que les manda el líder.
// Como las entradas llevan todos los valores ya decididos (userId, hash,
// fecha...), aplicar el mismo log en el mismo orden deja BDs idénticas.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { config } = require('./config');

// Nodo nuevo + BD heredada: se copia para que todos arranquen con lo mismo
fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
if (config.SEED_DB && !fs.existsSync(config.DB_PATH) && fs.existsSync(config.SEED_DB) &&
    path.resolve(config.SEED_DB) !== path.resolve(config.DB_PATH)) {
  fs.copyFileSync(config.SEED_DB, config.DB_PATH);
  console.log(`[DB] BD nueva sembrada desde ${config.SEED_DB}`);
}

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');

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

  -- Taller 7: log de replicación (una fila por escritura, en orden)
  CREATE TABLE IF NOT EXISTS replication_log (
    seq   INTEGER PRIMARY KEY,
    term  INTEGER NOT NULL,
    op    TEXT    NOT NULL,
    data  TEXT    NOT NULL
  );

  -- Taller 7: estado persistente de la elección (term actual y voto)
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const stmts = {
  findByUsername: db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  findById:       db.prepare('SELECT id FROM users WHERE id = ?'),
  findMatch:      db.prepare('SELECT match_id FROM matches WHERE match_id = ?'),
  getStats:       db.prepare('SELECT * FROM user_stats WHERE user_id = ?'),
  nextUserId:     db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM users'),
  countUsers:     db.prepare('SELECT COUNT(*) AS n FROM users'),

  insertUser: db.prepare(`
    INSERT INTO users (id, username, provider, password_hash, google_sub, email, created_at)
    VALUES (@userId, @username, @provider, @password_hash, @google_sub, @email, @created_at)
  `),
  insertMatch: db.prepare('INSERT OR IGNORE INTO matches (match_id, room_id, reported_by, finished_at) VALUES (?, ?, ?, ?)'),
  addStats: db.prepare(`
    INSERT INTO user_stats (user_id, games_played, games_won, properties_bought, buildings_built)
    VALUES (@userId, 1, @won, @bought, @built)
    ON CONFLICT(user_id) DO UPDATE SET
      games_played      = games_played + 1,
      games_won         = games_won + @won,
      properties_bought = properties_bought + @bought,
      buildings_built   = buildings_built + @built
  `),
  setStats: db.prepare(`
    INSERT OR REPLACE INTO user_stats (user_id, games_played, games_won, properties_bought, buildings_built)
    VALUES (@userId, @games_played, @games_won, @properties_bought, @buildings_built)
  `),

  lastEntry:  db.prepare('SELECT seq, term FROM replication_log ORDER BY seq DESC LIMIT 1'),
  termAt:     db.prepare('SELECT term FROM replication_log WHERE seq = ?'),
  entriesFrom: db.prepare('SELECT seq, term, op, data FROM replication_log WHERE seq > ? ORDER BY seq'),
  insertLog:  db.prepare('INSERT INTO replication_log (seq, term, op, data) VALUES (?, ?, ?, ?)'),
  getMeta:    db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta:    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
};

// ── Operaciones replicables ──────────────────────────────────────────────────
// Una función por tipo de escritura. Deben ser deterministas: todo lo que
// usan viene en `data`.
const OPS = {
  register(d) {
    stmts.insertUser.run({
      userId: d.userId, username: d.username, provider: 'local',
      password_hash: d.password_hash, google_sub: null, email: null, created_at: d.created_at
    });
  },
  register_google(d) {
    stmts.insertUser.run({
      userId: d.userId, username: d.username, provider: 'google',
      password_hash: null, google_sub: d.google_sub, email: d.email || null, created_at: d.created_at
    });
  },
  match_result(d) {
    const inserted = stmts.insertMatch.run(d.matchId, d.roomId || '', d.reportedBy || '', d.finished_at);
    if (inserted.changes === 0) return;   // ya estaba
    for (const p of d.players || []) {
      if (!stmts.findById.get(Number(p.userId))) continue;
      stmts.addStats.run({ userId: Number(p.userId), won: p.won ? 1 : 0, bought: p.bought, built: p.built });
    }
  },
  // Solo para importar una BD de talleres anteriores (ver importLegacy)
  import_stats(d) { stmts.setStats.run(d); },
  import_match(d) { stmts.insertMatch.run(d.matchId, d.roomId || '', d.reportedBy || '', d.finished_at); }
};

// Aplica una entrada del log (y la guarda) en una sola transacción
const applyEntry = db.transaction((entry) => {
  const fn = OPS[entry.op];
  if (!fn) throw new Error(`op desconocida: ${entry.op}`);
  fn(entry.data);
  stmts.insertLog.run(entry.seq, entry.term, entry.op, JSON.stringify(entry.data));
});

const applyMany = db.transaction((entries) => { for (const e of entries) applyEntry(e); });

// Borra todo y vuelve a aplicar el log del líder (cuando hay divergencia)
const resetAndApply = db.transaction((entries) => {
  db.exec('DELETE FROM user_stats; DELETE FROM matches; DELETE FROM users; DELETE FROM replication_log;');
  for (const e of entries) applyEntry(e);
});

function lastSeq()  { const r = stmts.lastEntry.get(); return r ? r.seq : 0; }
function lastTerm() { const r = stmts.lastEntry.get(); return r ? r.term : 0; }
function termAt(seq) {
  if (seq === 0) return 0;
  const r = stmts.termAt.get(seq);
  return r ? r.term : null;
}
function entriesFrom(fromSeq) {
  return stmts.entriesFrom.all(fromSeq).map(r => ({ seq: r.seq, term: r.term, op: r.op, data: JSON.parse(r.data) }));
}
function userCount() { return stmts.countUsers.get().n; }

// Para el panel (sin hashes ni datos sensibles)
const recentUsersStmt = db.prepare('SELECT id, username, provider, created_at FROM users ORDER BY id DESC LIMIT ?');
const logTailStmt = db.prepare('SELECT seq, term, op, data FROM replication_log ORDER BY seq DESC LIMIT ?');
function recentUsers(n = 12) { return recentUsersStmt.all(n); }
function logTail(n = 12) {
  return logTailStmt.all(n).map(r => {
    const d = JSON.parse(r.data);
    const detail = d.username ? `${d.username} (id ${d.userId})`
      : d.matchId ? `partida ${d.matchId}${d.players ? ` · ${d.players.length} jugadores` : ''}`
      : d.userId ? `usuario ${d.userId}` : '';
    return { seq: r.seq, term: r.term, op: r.op, detail };
  });
}
function getMeta(key, fallback = null) { const r = stmts.getMeta.get(key); return r ? r.value : fallback; }
function setMeta(key, value) { stmts.setMeta.run(key, value == null ? null : String(value)); }

// ── Importar una BD heredada ─────────────────────────────────────────────────
// Si el log está vacío pero hay datos (users.db de talleres anteriores), se
// generan entradas term=0 en un orden fijo. Dos nodos sembrados con la misma
// BD generan EXACTAMENTE el mismo log, así que quedan sincronizados.
(function importLegacy() {
  if (lastSeq() > 0 || userCount() === 0) return;
  let seq = 0;
  const entries = [];
  for (const u of db.prepare('SELECT * FROM users ORDER BY id').all()) {
    entries.push({
      seq: ++seq, term: 0, op: u.provider === 'google' ? 'register_google' : 'register',
      data: { userId: u.id, username: u.username, provider: u.provider, password_hash: u.password_hash,
              google_sub: u.google_sub, email: u.email, created_at: u.created_at }
    });
  }
  for (const s of db.prepare('SELECT * FROM user_stats ORDER BY user_id').all()) {
    entries.push({ seq: ++seq, term: 0, op: 'import_stats',
      data: { userId: s.user_id, games_played: s.games_played, games_won: s.games_won,
              properties_bought: s.properties_bought, buildings_built: s.buildings_built } });
  }
  for (const m of db.prepare('SELECT * FROM matches ORDER BY match_id').all()) {
    entries.push({ seq: ++seq, term: 0, op: 'import_match',
      data: { matchId: m.match_id, roomId: m.room_id, reportedBy: m.reported_by, finished_at: m.finished_at } });
  }
  resetAndApply(entries);
  console.log(`[DB] BD heredada importada al log de replicación (${entries.length} entradas, ${userCount()} usuarios)`);
})();

module.exports = {
  db, stmts, applyEntry, applyMany, resetAndApply,
  lastSeq, lastTerm, termAt, entriesFrom, userCount, getMeta, setMeta, recentUsers, logTail
};
