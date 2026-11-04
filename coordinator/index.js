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

const PORT = Number(args.port || positionals[0] || process.env.PORT || process.env.COORDINATOR_PORT || 5000);
const TIMEOUT = Number(process.env.PULSE_TIMEOUT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no está definida en el archivo .env');
  process.exit(1);
}

const ID = Math.floor(Math.random() * 10000);
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

  const msg = JSON.stringify({
    type: 'players_update',
    players: list
  });

  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) {
      socket.send(msg);
    }
  }
}

// Validación del JWT durante el HTTP Upgrade en /connect?token=XXX
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const token = parsedUrl.query.token;

  try {
    if (!token) {
      throw new Error('Token ausente');
    }

    const payload = jwt.verify(token, JWT_SECRET);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, payload);
    });
  } catch (err) {
    console.warn(`[COORDINATOR] Conexión rechazada (token inválido/vencido): ${err.message}`);
    // Cerramos con código 4001 y mensaje "invalid token" para que el cliente WebSocket reciba el código exacto
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(4001, 'invalid token');
    });
  }
});

wss.on('connection', (ws, payload) => {
  const userId = String(payload.userId);
  const username = payload.username;

  // Política de pestañas duplicadas: si el mismo usuario ya tiene una conexión activa,
  // desconectamos la primera sesión antes de registrar la nueva.
  if (players.has(userId)) {
    const previousSession = players.get(userId);
    console.log(`[COORDINATOR] Sesión duplicada detectada para ${username} (${userId}). Cerrando sesión anterior.`);
    players.delete(userId);
    if (previousSession.socket && previousSession.socket.readyState === previousSession.socket.OPEN) {
      previousSession.socket.close(4002, 'duplicate session: connected from another tab');
    }
  }

  // Registrar jugador en el Map
  players.set(userId, {
    username,
    socket: ws,
    connectedAt: new Date().toISOString()
  });

  console.log(`[COORDINATOR] Jugador conectado: ${username} (id: ${userId}) | Total en línea: ${players.size}`);

  // Broadcast de la lista actualizada a todos los conectados
  broadcastPlayers();

  // Si el token tiene exp, programar verificación cuando venza durante la sesión activa
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

    // Solo eliminamos del Map si el socket que se cierra es el socket activo actual de este userId
    // (evita que el evento close de la pestaña desplazada borre la nueva pestaña)
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
  }
};

server.listen(PORT, () => {
  console.log(`Coordinator ${ID} (${role}) en http://localhost:${PORT} y WS en ws://localhost:${PORT}/connect`);
});
