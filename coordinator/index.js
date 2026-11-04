require('dotenv').config();
const http = require('node:http');
const url = require('node:url');
const { parseArgs } = require('node:util');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

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

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no está definida en el archivo .env');
  process.exit(1);
}

const ID   = Math.floor(Math.random() * 10000);
const role = args.role || process.env.COORDINATOR_ROLE || 'PRIMARY';
const servers = {};
const totalTimeouts = 0;

// Map en memoria: userId -> { username, socket, connectedAt }
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
    totalTimeouts
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

// Validación del JWT durante el HTTP Upgrade en /connect?token=XXX
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

  try {
    if (!token) throw new Error('Token ausente');
    const payload = jwt.verify(token, JWT_SECRET);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, payload);
    });
  } catch (err) {
    console.warn(`[COORDINATOR] Conexión rechazada (token inválido/vencido): ${err.message}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(4001, 'invalid token');
    });
  }
});

wss.on('connection', (ws, payload) => {
  const userId   = String(payload.userId);
  const username = payload.username;

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
  // ─────────────────────────────────────────────────────────────────────────

  // Registrar jugador
  players.set(userId, { username, socket: ws, connectedAt: new Date().toISOString() });
  console.log(`[COORDINATOR] Jugador conectado: ${username} (id: ${userId}) | Total en línea: ${players.size}`);
  broadcastPlayers();

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
    handler(ws, msg.data || {}, { userId, username });
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
    }
  });
});

const handlers = {
  ping(ws) {
    send(ws, 'pong', { timestamp: Date.now() });
  },

  get_players(ws) {
    const list = Array.from(players.entries()).map(([userId, p]) => ({
      userId: String(userId),
      username: p.username
    }));
    ws.send(JSON.stringify({ type: 'players_update', players: list }));
  },

  // ── Respuesta al auth_challenge ───────────────────────────────────────────
  // El cliente reenvía el token que tiene en localStorage.
  // Se verifica firma + que el userId del payload coincida con el userId de esta sesión.
  auth_response(ws, data, { userId, username }) {
    // Cancelar el timer de timeout — llegó la respuesta
    if (challengeResponseTimer) {
      clearTimeout(challengeResponseTimer);
      challengeResponseTimer = null;
    }

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

server.listen(PORT, () => {
  console.log(`Coordinator ${ID} (${role}) en http://localhost:${PORT} y WS en ws://localhost:${PORT}/connect`);
  console.log(`  -> Auth challenge cada ${AUTH_CHALLENGE_INTERVAL / 1000}s, timeout de respuesta ${AUTH_CHALLENGE_TIMEOUT / 1000}s`);
});
