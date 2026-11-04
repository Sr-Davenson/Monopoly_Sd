const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const http = require('node:http');
const url = require('node:url');
const { parseArgs } = require('node:util');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { MonopolyGame, GameError } = require('./game/monopoly');

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    role: { type: 'string' }
  }
});

const PORT      = Number(args.port || positionals[0] || process.env.PORT || process.env.COORDINATOR_PORT || 5000);
const TIMEOUT   = Number(process.env.PULSE_TIMEOUT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;

// Intervalo de ping para detectar conexiones muertas (red caída, ngrok, etc.)
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL || 30000);

// ── Token-revalidation challenge ──────────────────────────────────────────────
// Cada AUTH_CHALLENGE_INTERVAL ms el coordinador pide al cliente que reenvíe
// su token actual. Si en AUTH_CHALLENGE_TIMEOUT ms no llega respuesta válida
// se cierra la conexión con código 4003 (token manipulado / sesión inválida).
const AUTH_CHALLENGE_INTERVAL = Number(process.env.AUTH_CHALLENGE_INTERVAL || 20000); // 20 s
const AUTH_CHALLENGE_TIMEOUT  = Number(process.env.AUTH_CHALLENGE_TIMEOUT  ||  5000); //  5 s
// ─────────────────────────────────────────────────────────────────────────────

// ── Mundo del juego (Taller 5) ────────────────────────────────────────────────
// El servidor es autoritativo: estas dimensiones las decide el coordinador y se
// envían al cliente en el mensaje 'welcome' para inicializar el canvas.
const WORLD_WIDTH   = Number(process.env.WORLD_WIDTH   || 800);
const WORLD_HEIGHT  = Number(process.env.WORLD_HEIGHT  || 600);
const PLAYER_RADIUS = Number(process.env.PLAYER_RADIUS || 15);
const PLAYER_SPEED  = Number(process.env.PLAYER_SPEED  || 200); // px/seg
const TICK_RATE     = 20;                                        // Hz
const TICK_MS       = 1000 / TICK_RATE;
// ─────────────────────────────────────────────────────────────────────────────

// ── Partida de Monopoly (una sala global) ────────────────────────────────────
// Si el jugador en turno se desconecta, su turno se salta tras este tiempo.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 30000);
const game = new MonopolyGame();
let skipTimer = null;
// ─────────────────────────────────────────────────────────────────────────────

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no está definida en el archivo .env');
  process.exit(1);
}

const ID   = Math.floor(Math.random() * 10000);
const role = args.role || process.env.COORDINATOR_ROLE || 'PRIMARY';
const servers = {};
const totalTimeouts = 0;

// Map en memoria: userId -> { username, provider, socket, connectedAt, x, y, intent, extras }
const players = new Map();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/status', (req, res) => {
  const activePlayers = Array.from(players.entries()).map(([userId, p]) => ({
    userId: String(userId),
    username: p.username,
    connectedAt: p.connectedAt
  }));

  res.json({
    id: ID,
    role,
    playersCount: players.size,
    players: activePlayers,
    servers: Object.values(servers),
    totalTimeouts,
    game: {
      phase: game.phase,
      players: game.players.length,
      turnOf: game.turn ? game.turn.playerId : null
    }
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function send(ws, type, data = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function broadcastPlayers() {
  const list = Array.from(players.entries()).map(([userId, p]) => ({
    userId: String(userId),
    username: p.username
  }));

  const msg = JSON.stringify({ type: 'players_update', players: list });

  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) {
      socket.send(msg);
    }
  }
}

// ── Monopoly: difusión del estado ─────────────────────────────────────────────
// A diferencia del canvas (20 Hz), el tablero es por turnos: el estado se envía
// solo cuando una acción lo cambia.
function broadcastGame() {
  const msg = JSON.stringify({ type: 'game_state', data: game.toJSON() });
  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) socket.send(msg);
  }
  scheduleDisconnectSkip();
}

// Si el jugador en turno está desconectado, saltar su turno tras un periodo de gracia.
function scheduleDisconnectSkip() {
  if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
  if (game.phase !== 'playing' || !game.turn) return;
  const current = game.current();
  if (!current || current.connected) return;
  const turnId = current.id;
  skipTimer = setTimeout(() => {
    skipTimer = null;
    if (game.skipDisconnected(turnId)) {
      game.version++;
      broadcastGame();
    }
  }, DISCONNECT_GRACE_MS);
}

// Validación del JWT durante el HTTP Upgrade en /connect?token=XXX&view=board|canvas
server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => console.warn('[COORDINATOR] Error en socket de upgrade:', err.message));
  const parsedUrl = url.parse(req.url, true);
  const pathname  = parsedUrl.pathname;

  if (pathname !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const token = parsedUrl.query.token;
  // 'board' = pantalla del tablero (no participa en el canvas en tiempo real)
  const view  = parsedUrl.query.view === 'board' ? 'board' : 'canvas';

  try {
    if (!token) throw new Error('Token ausente');
    const payload = jwt.verify(token, JWT_SECRET);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, payload, view);
    });
  } catch (err) {
    console.warn(`[COORDINATOR] Conexión rechazada (token inválido/vencido): ${err.message}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(4001, 'invalid token');
    });
  }
});

wss.on('connection', (ws, payload, view = 'canvas') => {
  const userId   = String(payload.userId);
  const username = payload.username;
  const provider = payload.provider || 'local';

  // Política de pestañas duplicadas
  if (players.has(userId)) {
    const previousSession = players.get(userId);
    console.log(`[COORDINATOR] Sesión duplicada detectada para ${username} (${userId}). Cerrando sesión anterior.`);
    players.delete(userId);
    if (previousSession.socket && previousSession.socket.readyState === previousSession.socket.OPEN) {
      previousSession.socket.close(4002, 'duplicate session: connected from another tab');
    }
  }

  ws.on('error', (err) => {
    console.warn(`[COORDINATOR] Error de socket (${username}):`, err.message);
  });

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const heartbeat = setInterval(() => {
    if (!ws.isAlive) {
      console.log(`[COORDINATOR] Sin respuesta de ${username} (${userId}). Terminando conexión.`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, HEARTBEAT_MS);

  // ── Token-challenge: re-validación periódica del token ────────────────────
  // Permite detectar manipulación manual del token desde DevTools en tiempo real.
  let challengeResponseTimer = null; // timer de espera por respuesta

  const challengeInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;

    // Enviar desafío al cliente
    send(ws, 'auth_challenge', {});
    console.log(`[COORDINATOR] auth_challenge enviado a ${username} (${userId})`);

    // Si en AUTH_CHALLENGE_TIMEOUT ms no llega auth_response válido → cerrar
    challengeResponseTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        console.warn(`[COORDINATOR] Sin respuesta al auth_challenge de ${username} (${userId}). Cerrando por token sucio/ausente.`);
        ws.close(4003, 'token tampered or missing');
      }
    }, AUTH_CHALLENGE_TIMEOUT);
  }, AUTH_CHALLENGE_INTERVAL);

  // Contexto de la sesión que se pasa a los handlers. clearChallenge permite a
  // auth_response cancelar el timer, que vive en el closure de esta conexión.
  const session = {
    userId,
    username,
    clearChallenge() {
      if (challengeResponseTimer) {
        clearTimeout(challengeResponseTimer);
        challengeResponseTimer = null;
      }
    }
  };
  // ─────────────────────────────────────────────────────────────────────────

  // Registrar jugador con su estado de juego.
  // La posición inicial la decide el servidor (aleatoria dentro del mundo).
  players.set(userId, {
    username,
    provider,
    view,
    socket: ws,
    connectedAt: new Date().toISOString(),
    x: PLAYER_RADIUS + Math.random() * (WORLD_WIDTH  - 2 * PLAYER_RADIUS),
    y: PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS),
    intent: { x: 0, y: 0 },
    extras: {}
  });
  console.log(`[COORDINATOR] Jugador conectado: ${username} (id: ${userId}) | Total en línea: ${players.size}`);

  // Welcome enriquecido: identidad + parámetros del mundo para el canvas
  ws.send(JSON.stringify({
    type: 'welcome',
    you: { userId, username, provider },
    world: {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      playerRadius: PLAYER_RADIUS,
      tickRate: TICK_RATE
    }
  }));

  broadcastPlayers();

  // Monopoly: datos estáticos del tablero + estado actual de la partida.
  // Si el usuario ya estaba en la partida, se marca como reconectado.
  send(ws, 'game_config', MonopolyGame.config());
  if (game.getPlayer(userId)) {
    game.setConnected(userId, true);
    game.version++;
    broadcastGame();
  } else {
    send(ws, 'game_state', game.toJSON());
  }

  // Expiración natural del token
  let expTimer = null;
  if (payload.exp) {
    const msUntilExpiry = payload.exp * 1000 - Date.now();
    if (msUntilExpiry > 0) {
      expTimer = setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          console.log(`[COORDINATOR] Token expirado para ${username} (${userId}). Cerrando conexión.`);
          ws.close(4001, 'invalid token');
        }
      }, msUntilExpiry);
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return send(ws, 'error', { message: 'json invalido' });
    }

    const handler = handlers[msg.type];
    if (!handler) {
      return send(ws, 'error', { message: `tipo desconocido: ${msg.type}` });
    }
    handler(ws, msg.data || {}, session, msg);
  });

  ws.on('close', () => {
    if (expTimer) clearTimeout(expTimer);
    if (challengeResponseTimer) clearTimeout(challengeResponseTimer);
    clearInterval(heartbeat);
    clearInterval(challengeInterval);

    const current = players.get(userId);
    if (current && current.socket === ws) {
      players.delete(userId);
      console.log(`[COORDINATOR] Jugador desconectado: ${username} (id: ${userId}) | Total en línea: ${players.size}`);
      broadcastPlayers();

      // Monopoly: se conserva su asiento; si estaba en la sala de espera, se libera.
      const gp = game.getPlayer(userId);
      if (gp) {
        if (game.phase === 'lobby') game.leave(userId);
        else game.setConnected(userId, false);
        game.version++;
        broadcastGame();
      }
    }
  });
});

const handlers = {
  ping(ws) {
    send(ws, 'pong', { timestamp: Date.now() });
  },

  // ── Monopoly: todas las acciones del tablero ──────────────────────────────
  // { type: 'game_action', data: { action: 'roll' | 'buy' | 'build' | ..., ...params } }
  // El motor valida turno, etapa y fondos. Si la acción no es válida, solo el
  // remitente recibe 'game_error' y el estado no cambia.
  game_action(ws, data, { userId, username }) {
    if (typeof data.action !== 'string') return send(ws, 'game_error', { message: 'Acción requerida' });
    try {
      game.handle(userId, username, data.action, data);
      broadcastGame();
    } catch (err) {
      if (err instanceof GameError) return send(ws, 'game_error', { message: err.message });
      console.error('[COORDINATOR] Error en game_action:', err);
      send(ws, 'game_error', { message: 'Error interno' });
    }
  },

  get_game(ws) {
    send(ws, 'game_state', game.toJSON());
  },

  get_players(ws) {
    const list = Array.from(players.entries()).map(([userId, p]) => ({
      userId: String(userId),
      username: p.username
    }));
    ws.send(JSON.stringify({ type: 'players_update', players: list }));
  },

  // ── Intención de movimiento ───────────────────────────────────────────────
  // { type: 'intent', intent: { dir: { x: -1|0|1, y: -1|0|1 } } }
  // Aquí SOLO se guarda la intención. Quien mueve al jugador es el game loop;
  // si moviéramos aquí, la velocidad dependería de cuántos mensajes manda el cliente.
  // Tampoco se hace broadcast aquí: eso ocurre una vez por tick.
  intent(ws, data, { userId }, msg) {
    const p = players.get(userId);
    if (!p || p.socket !== ws) return;

    const intent = msg.intent || data.intent;
    const dir = intent && intent.dir;
    if (!dir || !Number.isFinite(dir.x) || !Number.isFinite(dir.y)) return;

    // Sanitizar a -1, 0, 1 — NO confiar en lo que mande el cliente ({x: 9999} no teletransporta)
    p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
  },

  // ── Extras replicados (color, mood, etc.) ─────────────────────────────────
  // { type: 'extras_update', extras: { color: '#ff5500' } }
  // Se guardan en el jugador y se replican a todos en el siguiente tick.
  extras_update(ws, data, { userId }, msg) {
    const p = players.get(userId);
    if (!p || p.socket !== ws) return;

    const extras = msg.extras || data.extras;
    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return;
    if (JSON.stringify(extras).length > 1024) return; // límite anti-abuso (1 KB)

    p.extras = extras;
  },

  // ── Respuesta al auth_challenge ───────────────────────────────────────────
  // El cliente reenvía el token que tiene en localStorage.
  // Se verifica firma + que el userId del payload coincida con el userId de esta sesión.
  auth_response(ws, data, { userId, username, clearChallenge }) {
    // Cancelar el timer de timeout — llegó la respuesta
    clearChallenge();

    const clientToken = data && data.token;

    if (!clientToken) {
      console.warn(`[COORDINATOR] auth_response sin token de ${username} (${userId}). Cerrando.`);
      ws.close(4003, 'token tampered or missing');
      return;
    }

    try {
      const verifiedPayload = jwt.verify(clientToken, JWT_SECRET);

      // El userId del token debe coincidir con el userId de esta sesión WS
      if (String(verifiedPayload.userId) !== userId) {
        console.warn(`[COORDINATOR] Token de otra cuenta enviado por ${username} (${userId}). Cerrando.`);
        ws.close(4003, 'token tampered or missing');
        return;
      }

      console.log(`[COORDINATOR] auth_response válido de ${username} (${userId}). Sesión confirmada.`);
    } catch (err) {
      console.warn(`[COORDINATOR] Token inválido en auth_response de ${username} (${userId}): ${err.message}. Cerrando.`);
      ws.close(4003, 'token tampered or missing');
    }
  }
  // ─────────────────────────────────────────────────────────────────────────
};

// ── Game loop (servidor autoritativo) ─────────────────────────────────────────
// Snapshot serializable del estado (sin el socket).
// Solo incluye a quienes están en la vista del canvas (no a los del tablero).
function snapshot() {
  return Array.from(players.entries()).filter(([, p]) => p.view !== 'board').map(([userId, p]) => ({
    userId,
    username: p.username,
    provider: p.provider,
    x: Math.round(p.x * 100) / 100,
    y: Math.round(p.y * 100) / 100,
    extras: p.extras
  }));
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const { socket, view } of players.values()) {
    if (view !== 'board' && socket.readyState === socket.OPEN) socket.send(msg);
  }
}

let lastTick = Date.now();

function tick() {
  const now = Date.now();
  const dt  = (now - lastTick) / 1000; // segundos reales desde el tick anterior
  lastTick  = now;

  for (const p of players.values()) {
    // Normalizar diagonales: sin esto, en diagonal se iría ~41% más rápido.
    const ix  = p.intent.x;
    const iy  = p.intent.y;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      p.x += (ix / mag) * PLAYER_SPEED * dt;
      p.y += (iy / mag) * PLAYER_SPEED * dt;
    }

    // Mantener dentro del mundo
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH  - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
  }

  // Un único broadcast por tick
  if (players.size > 0) {
    broadcast({ type: 'state', t: now, players: snapshot() });
  }
}

setInterval(tick, TICK_MS);
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Coordinator ${ID} (${role}) en http://localhost:${PORT} y WS en ws://localhost:${PORT}/connect`);
  console.log(`  -> Game loop a ${TICK_RATE} Hz | Mundo ${WORLD_WIDTH}x${WORLD_HEIGHT} | Velocidad ${PLAYER_SPEED} px/s`);
  console.log(`  -> Auth challenge cada ${AUTH_CHALLENGE_INTERVAL / 1000}s, timeout de respuesta ${AUTH_CHALLENGE_TIMEOUT / 1000}s`);
});
