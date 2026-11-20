// ─────────────────────────────────────────────────────────────────────────────
// CLÚSTER DE AUTH-SERVICES — replicación single-writer + elección de líder
//
// Roles:
//   leader  → acepta lecturas y escrituras; cada escritura va al log, se aplica
//             y se propaga (write_propagate). Late cada 2 s (heartbeat).
//   replica → solo lecturas; aplica lo que manda el líder. Si pasan 6 s sin
//             latido del líder (3 ciclos) inicia una elección.
//
// Mesh: un WebSocket por par, en un puerto aparte (PEER_PORT). Inicia la
// conexión el de authId lexicográficamente MENOR. Primer mensaje: hello.
//
// Mensajes (todos llevan term):
//   hello            { authId, role, term, publicUrl, peerUrl, lastSeq, lastTerm, leaderId, auth }
//   heartbeat        { authId, term, lastSeq }                  líder → réplicas
//   heartbeat_ack    { authId, term, lastSeq }                  réplica → líder
//   write_propagate  { term, seq, op, data }                    líder → réplicas
//   write_ack        { authId, term, seq }                      réplica → líder (opción B)
//   request_sync     { fromSeq, lastTerm }                      réplica → líder
//   sync_response    { entries:[...], reset }                   líder → réplica
//   election         { candidate, term, lastSeq, lastTerm }     candidato → todos
//   vote             { voter, term, voteGranted }               → candidato
//   new_leader       { leader, term }                           ganador → todos
//   directory        { coordinators:[...] }                     líder → réplicas (soft state)
//
// Reglas de seguridad (estilo Raft, simplificado):
//   · Gana quien junte MAYORÍA de votos del clúster (2 de 3). Así nunca hay
//     dos líderes en el mismo term.
//   · Solo se vota a un candidato cuyo log está al menos tan al día como el
//     propio (lastTerm, lastSeq). Así una escritura confirmada no se pierde.
//   · Un voto por term (persistido en la BD).
//   · Quien ve un term mayor que el suyo lo adopta y, si era líder, se baja.
// ─────────────────────────────────────────────────────────────────────────────
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');
const { config } = require('./config');
const store = require('./db');

const SELF = config.AUTH_ID;
const CLUSTER_SIZE = 1 + config.PEERS.length;
const MAJORITY = Math.floor(CLUSTER_SIZE / 2) + 1;
const peerConfig = new Map(config.PEERS.map(p => [p.authId, p.peerUrl]));

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// ── Estado ────────────────────────────────────────────────────────────────────
const state = {
  role: 'replica',                      // 'leader' | 'replica'
  candidate: false,                     // réplica en medio de una elección propia
  term: Number(store.getMeta('term', 0)),
  votedFor: store.getMeta('votedFor', null),
  leaderId: null,
  leaderLastSeq: 0,                     // último seq que anunció el líder
  lastLeaderContact: Date.now(),        // arrancamos esperando un latido
  electionDeadline: 0,
  votes: new Set(),
  syncing: null                         // { at } mientras espera sync_response
};
let heartbeatTimer = null;

// authId → { ws, authId, publicUrl, peerUrl, role, term, lastSeq, lastAckAt, outbound }
const peers = new Map();
// Escrituras esperando confirmación de réplicas (opción B): seq → { acks, resolve, timer }
const pendingAcks = new Map();

// Ganchos del directorio de coordinadores (directory.js los registra)
const hooks = { snapshot: () => [], applySnapshot: () => {}, onPromoted: () => {} };
function setDirectoryHooks(h) { Object.assign(hooks, h); }

function persistTerm() {
  store.setMeta('term', state.term);
  store.setMeta('votedFor', state.votedFor);
}

// Próximo intento de elección: base + un azar (así no se postulan todos a la vez)
function scheduleElection(baseMs) {
  state.electionDeadline = Date.now() + baseMs + Math.floor(Math.random() * config.ELECTION_JITTER_MS);
}

function serviceToken() {
  return jwt.sign({ role: 'auth', authId: SELF }, config.JWT_SECRET, { expiresIn: '1h' });
}

// ── Envío ─────────────────────────────────────────────────────────────────────
function send(peer, msg) {
  if (peer && peer.ws && peer.ws.readyState === WebSocket.OPEN) {
    peer.ws.send(JSON.stringify({ term: state.term, ...msg }));
    return true;
  }
  return false;
}
function broadcast(msg) { for (const p of peers.values()) send(p, msg); }

function helloMessage() {
  return {
    type: 'hello', authId: SELF, role: state.role, term: state.term,
    publicUrl: config.PUBLIC_URL, peerUrl: config.PEER_URL,
    lastSeq: store.lastSeq(), lastTerm: store.lastTerm(), leaderId: state.leaderId,
    auth: serviceToken()
  };
}

// ── Consultas para las rutas ──────────────────────────────────────────────────
const isLeader = () => state.role === 'leader';

function leaderUrl() {
  if (isLeader()) return config.PUBLIC_URL;
  const p = state.leaderId && peers.get(state.leaderId);
  return p && p.publicUrl ? p.publicUrl : null;
}

function lag() {
  return isLeader() ? 0 : Math.max(0, state.leaderLastSeq - store.lastSeq());
}

// Por qué este nodo NO puede atender una escritura (null = sí puede)
function writeRefusal() {
  if (isLeader()) return null;
  const url = leaderUrl();
  if (!state.leaderId || !url) return { error: 'no_leader', authId: SELF };
  return { error: 'not_leader', leaderUrl: url, leaderId: state.leaderId, authId: SELF };
}

// Por qué este nodo NO puede atender una lectura que emite token (null = sí)
function readRefusal() {
  if (isLeader()) return null;
  if (!state.leaderId) return { error: 'no_leader', authId: SELF };
  // Responde localmente si leaderSeq - mySeq < LAG_TOLERANCE (por defecto 10)
  if (lag() > 0 && lag() >= config.LAG_TOLERANCE) {
    return { error: 'not_leader', leaderUrl: leaderUrl(), leaderId: state.leaderId, authId: SELF, lag: lag() };
  }
  return null;
}

function status() {
  return {
    authId: SELF,
    role: state.role,
    publicUrl: config.PUBLIC_URL,
    peerUrl: config.PEER_URL,
    leaderUrl: leaderUrl(),
    leaderId: state.leaderId,
    term: state.term,
    electionInProgress: !state.leaderId,
    knownPeers: [...peers.keys()].sort(),
    clusterSize: CLUSTER_SIZE,
    lastAppliedSeq: store.lastSeq(),
    leaderLastSeq: isLeader() ? store.lastSeq() : state.leaderLastSeq,
    lag: lag(),
    users: store.userCount(),
    consistency: 'B (propagar y esperar ACK de la mayoría antes de responder)',
    lagTolerance: config.LAG_TOLERANCE
  };
}

function peerList() {
  const out = [{ authId: SELF, publicUrl: config.PUBLIC_URL, peerUrl: config.PEER_URL, role: state.role, self: true, lastSeq: store.lastSeq() }];
  for (const [authId, url] of peerConfig) {
    const p = peers.get(authId);
    out.push({
      authId,
      publicUrl: p ? p.publicUrl : null,
      peerUrl: p ? p.peerUrl : url,
      role: p ? (authId === state.leaderId ? 'leader' : 'replica') : 'unreachable',
      connected: Boolean(p),
      lastSeq: p ? p.lastSeq : null
    });
  }
  return out.sort((a, b) => a.authId.localeCompare(b.authId));
}

// ── Cambios de rol ────────────────────────────────────────────────────────────
function observeTerm(term) {
  if (typeof term !== 'number' || term <= state.term) return;
  const wasLeader = isLeader();
  state.term = term;
  state.votedFor = null;
  persistTerm();
  if (wasLeader) stepDown(`vi un term mayor (${term})`);
  state.candidate = false;
}

function stepDown(reason) {
  if (isLeader()) log('CLUSTER', `${SELF} deja de ser líder: ${reason}`);
  state.role = 'replica';
  state.candidate = false;
  if (state.leaderId === SELF) state.leaderId = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  for (const [, p] of pendingAcks) p.finish(false);
  state.lastLeaderContact = Date.now();
  scheduleElection(config.ELECTION_TIMEOUT_MS);
}

function becomeLeader() {
  state.role = 'leader';
  state.candidate = false;
  state.leaderId = SELF;
  state.leaderLastSeq = store.lastSeq();
  log('ELECTION', `★ ${SELF} es el NUEVO LÍDER (term ${state.term}, ${state.votes.size}/${CLUSTER_SIZE} votos, lastSeq ${store.lastSeq()})`);
  broadcast({ type: 'new_leader', leader: SELF });
  hooks.onPromoted();
  sendHeartbeat();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, config.LEADER_HEARTBEAT_MS);
}

function followLeader(leaderId, term, lastSeq) {
  const changed = state.leaderId !== leaderId;
  if (isLeader() && leaderId !== SELF) stepDown(`${leaderId} es líder en term ${term}`);
  state.role = 'replica';
  state.candidate = false;
  state.leaderId = leaderId;
  state.lastLeaderContact = Date.now();
  if (typeof lastSeq === 'number') state.leaderLastSeq = lastSeq;
  if (changed) log('CLUSTER', `${SELF} sigue al líder ${leaderId} (term ${term})`);
  if (store.lastSeq() < state.leaderLastSeq) requestSync();
}

// ── Heartbeat del líder ──────────────────────────────────────────────────────
function sendHeartbeat() {
  if (!isLeader()) return;
  const lastSeq = store.lastSeq();
  broadcast({ type: 'heartbeat', authId: SELF, lastSeq });
  broadcast({ type: 'directory', coordinators: hooks.snapshot() });

  // Un líder que no ve a la mayoría durante un timeout entero se baja: así,
  // si quedó aislado, no sigue aceptando escrituras mientras los demás eligen.
  if (CLUSTER_SIZE > 1) {
    const now = Date.now();
    const alive = 1 + [...peers.values()].filter(p => now - (p.lastAckAt || 0) < config.ELECTION_TIMEOUT_MS).length;
    if (alive < MAJORITY) {
      state.isolatedSince = state.isolatedSince || now;
      if (now - state.isolatedSince > config.ELECTION_TIMEOUT_MS) {
        state.isolatedSince = null;
        state.leaderId = null;
        stepDown(`solo veo ${alive}/${CLUSTER_SIZE} nodos (sin mayoría)`);
      }
    } else {
      state.isolatedSince = null;
    }
  }
}

// ── Elección ──────────────────────────────────────────────────────────────────
function startElection() {
  state.term += 1;
  state.votedFor = SELF;
  persistTerm();
  state.candidate = true;
  state.leaderId = null;
  state.votes = new Set([SELF]);
  scheduleElection(2000);          // si no gano en ~2 s (empate), reintento
  log('ELECTION', `${SELF} no oye al líder: me postulo en term ${state.term} (lastSeq ${store.lastSeq()}, necesito ${MAJORITY}/${CLUSTER_SIZE})`);
  if (state.votes.size >= MAJORITY) return becomeLeader();      // clúster de 1
  broadcast({ type: 'election', candidate: SELF, lastSeq: store.lastSeq(), lastTerm: store.lastTerm() });
}

function onElection(peer, msg) {
  const recentLeader = state.leaderId && Date.now() - state.lastLeaderContact < config.ELECTION_TIMEOUT_MS;
  // Si todavía oigo a un líder vivo, ignoro candidatos (evita que un nodo
  // que vuelve con un term inflado tumbe al líder actual).
  if (recentLeader && msg.candidate !== state.leaderId && !isLeader()) {
    return send(peer, { type: 'vote', voter: SELF, voteGranted: false, reason: 'tengo_lider' });
  }
  if (isLeader() && msg.term <= state.term) {
    return send(peer, { type: 'vote', voter: SELF, voteGranted: false, reason: 'soy_lider' });
  }
  observeTerm(msg.term);
  if (msg.term < state.term) return send(peer, { type: 'vote', voter: SELF, voteGranted: false, reason: 'term_viejo' });

  const myTerm = store.lastTerm(), mySeq = store.lastSeq();
  const upToDate = msg.lastTerm > myTerm || (msg.lastTerm === myTerm && msg.lastSeq >= mySeq);
  const free = state.votedFor === null || state.votedFor === msg.candidate;
  const granted = upToDate && free;
  if (granted) {
    state.votedFor = msg.candidate;
    persistTerm();
    scheduleElection(config.ELECTION_TIMEOUT_MS / 2);   // le doy tiempo a que gane
  }
  log('ELECTION', `Voto de ${SELF} para ${msg.candidate} en term ${msg.term}: ${granted ? 'SÍ' : 'NO'}${!upToDate ? ' (su log está atrasado)' : !free ? ` (ya voté por ${state.votedFor})` : ''}`);
  send(peer, { type: 'vote', voter: SELF, term: state.term, voteGranted: granted });
}

function onVote(msg) {
  observeTerm(msg.term);
  if (!state.candidate || msg.term !== state.term || !msg.voteGranted) return;
  state.votes.add(msg.voter);
  if (state.votes.size >= MAJORITY) becomeLeader();
}

// ── Escrituras (solo el líder) ────────────────────────────────────────────────
// build() se ejecuta de forma síncrona: valida contra la BD local y devuelve
// { op, data } (o { error }). Como Node es de un solo hilo, nada se cuela
// entre la validación y la aplicación.
//
// OPCIÓN B: la escritura se aplica en el log del líder, se propaga, y solo se
// responde al cliente cuando la MAYORÍA del clúster la tiene (líder + 1 réplica
// en un clúster de 3). Si no llega la confirmación a tiempo → { ok:false }.
function propose(build) {
  const refusal = writeRefusal();
  if (refusal) return Promise.resolve({ ok: false, refusal });
  const built = build();
  if (!built || built.error) return Promise.resolve({ ok: false, result: built });

  const entry = { seq: store.lastSeq() + 1, term: state.term, op: built.op, data: built.data };
  store.applyEntry(entry);
  state.leaderLastSeq = entry.seq;
  log('REPL', `Escritura #${entry.seq} (${entry.op}) aplicada en el líder; propagando a ${peers.size} réplica(s)`);
  broadcast({ type: 'write_propagate', seq: entry.seq, op: entry.op, data: entry.data });

  const needed = MAJORITY - 1;
  if (needed <= 0) return Promise.resolve({ ok: true, entry, acks: [] });

  return new Promise((resolve) => {
    const pending = {
      acks: new Set(),
      finish(ok) {
        if (!pendingAcks.has(entry.seq)) return;
        clearTimeout(pending.timer);
        pendingAcks.delete(entry.seq);
        if (!ok) log('REPL', `Escritura #${entry.seq} SIN confirmación de la mayoría (${pending.acks.size}/${needed} ACK)`);
        resolve({ ok, entry, acks: [...pending.acks], refusal: ok ? null : { error: 'replication_timeout', authId: SELF } });
      }
    };
    pending.timer = setTimeout(() => pending.finish(false), config.WRITE_ACK_TIMEOUT_MS);
    pendingAcks.set(entry.seq, pending);
  });
}

function onWriteAck(msg) {
  for (const [seq, p] of pendingAcks) {
    if (msg.seq >= seq) {
      p.acks.add(msg.authId);
      if (p.acks.size >= MAJORITY - 1) {
        log('REPL', `Escritura #${seq} confirmada por ${[...p.acks].join(', ')} → se responde al cliente`);
        p.finish(true);
      }
    }
  }
}

// ── Réplica: aplicar lo que manda el líder ────────────────────────────────────
function fromLeader(peer, msg) {
  // Solo se acepta replicación del líder legítimo (term actual)
  observeTerm(msg.term);
  if (msg.term < state.term) { send(peer, { type: 'heartbeat_ack', authId: SELF, lastSeq: store.lastSeq() }); return false; }
  if (state.leaderId !== peer.authId) followLeader(peer.authId, msg.term);
  state.lastLeaderContact = Date.now();
  return true;
}

function onWritePropagate(peer, msg) {
  if (!fromLeader(peer, msg)) return;
  state.leaderLastSeq = Math.max(state.leaderLastSeq, msg.seq);
  const mySeq = store.lastSeq();
  if (msg.seq === mySeq + 1) {
    try {
      store.applyEntry({ seq: msg.seq, term: msg.term, op: msg.op, data: msg.data });
      log('REPL', `Aplicada #${msg.seq} (${msg.op}) del líder ${peer.authId} · usuarios: ${store.userCount()}`);
    } catch (err) {
      log('REPL', `No pude aplicar #${msg.seq}: ${err.message}. Pido sync.`);
      return requestSync(true);
    }
    return send(peer, { type: 'write_ack', authId: SELF, seq: msg.seq });
  }
  if (msg.seq <= mySeq) {
    // Ya la tenía: si es la misma (mismo term) confirmo; si no, hay divergencia
    if (store.termAt(msg.seq) === msg.term) return send(peer, { type: 'write_ack', authId: SELF, seq: msg.seq });
    return requestSync(true);
  }
  requestSync();     // hueco: me faltan entradas anteriores
}

function requestSync(force = false) {
  const leader = state.leaderId && peers.get(state.leaderId);
  if (!leader || isLeader()) return;
  if (state.syncing && !force && Date.now() - state.syncing.at < 3000) return;
  state.syncing = { at: Date.now() };
  const fromSeq = store.lastSeq();
  log('SYNC', `${SELF} atrasado (mi lastSeq ${fromSeq}, líder ${state.leaderLastSeq}) → request_sync a ${leader.authId}`);
  send(leader, { type: 'request_sync', fromSeq, lastTerm: store.termAt(fromSeq) });
}

function onRequestSync(peer, msg) {
  if (!isLeader()) return;
  const mine = store.lastSeq();
  const from = Number(msg.fromSeq) || 0;
  // Log matching: si la réplica tiene algo que yo no tengo (o con otro term),
  // divergió (p. ej. un ex-líder con escrituras sin confirmar) → reset completo.
  const diverged = from > mine || store.termAt(from) !== (msg.lastTerm ?? 0);
  const entries = store.entriesFrom(diverged ? 0 : from);
  log('SYNC', `${peer.authId} pide sync desde #${from}: envío ${entries.length} entrada(s)${diverged ? ' (RESET: su log divergió)' : ''}`);
  send(peer, { type: 'sync_response', entries, reset: diverged, lastSeq: mine });
}

function onSyncResponse(peer, msg) {
  if (!fromLeader(peer, msg)) return;
  const entries = Array.isArray(msg.entries) ? msg.entries : [];
  try {
    if (msg.reset) {
      store.resetAndApply(entries);
      log('SYNC', `Log reemplazado por el del líder (${entries.length} entradas)`);
    } else {
      store.applyMany(entries.filter(e => e.seq > store.lastSeq()).sort((a, b) => a.seq - b.seq));
    }
  } catch (err) {
    log('SYNC', `Error aplicando sync (${err.message}); pido reset`);
    state.syncing = null;
    return send(peer, { type: 'request_sync', fromSeq: store.lastSeq() + 1e9, lastTerm: -1 });   // fuerza reset
  }
  state.syncing = null;
  if (typeof msg.lastSeq === 'number') state.leaderLastSeq = Math.max(state.leaderLastSeq, msg.lastSeq);
  log('SYNC', `Sync completo: lastSeq ${store.lastSeq()} · usuarios: ${store.userCount()}`);
  send(peer, { type: 'write_ack', authId: SELF, seq: store.lastSeq() });
}

// ── Mensajes entrantes ────────────────────────────────────────────────────────
function onMessage(peer, msg) {
  switch (msg.type) {
    case 'heartbeat':
      if (!fromLeader(peer, msg)) return;
      state.leaderLastSeq = msg.lastSeq;
      if (store.lastSeq() < msg.lastSeq) requestSync();
      send(peer, { type: 'heartbeat_ack', authId: SELF, lastSeq: store.lastSeq() });
      break;
    case 'heartbeat_ack':
      observeTerm(msg.term);
      peer.lastSeq = msg.lastSeq;
      peer.lastAckAt = Date.now();
      break;
    case 'new_leader':
      observeTerm(msg.term);
      if (msg.term >= state.term && msg.leader === peer.authId) followLeader(msg.leader, msg.term);
      break;
    case 'election':      return onElection(peer, msg);
    case 'vote':          return onVote(msg);
    case 'write_propagate': return onWritePropagate(peer, msg);
    case 'write_ack':
      peer.lastSeq = msg.seq;
      peer.lastAckAt = Date.now();
      return onWriteAck(msg);
    case 'request_sync':  return onRequestSync(peer, msg);
    case 'sync_response': return onSyncResponse(peer, msg);
    case 'directory':
      if (msg.term >= state.term && peer.authId === state.leaderId) hooks.applySnapshot(msg.coordinators || []);
      break;
    default: break;
  }
}

// ── Conexiones ────────────────────────────────────────────────────────────────
function attach(ws, outbound, expectedId) {
  let peer = null;
  ws.send(JSON.stringify(helloMessage()));

  const helloTimer = setTimeout(() => { if (!peer) ws.close(4008, 'hello timeout'); }, 5000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!peer) {
      if (msg.type !== 'hello') return ws.close(4008, 'hello esperado');
      try {
        const t = jwt.verify(msg.auth || '', config.JWT_SECRET);
        if (t.role !== 'auth' || t.authId !== msg.authId) throw new Error('credencial inválida');
      } catch { return ws.close(4003, 'credencial de auth inválida'); }
      if (msg.authId === SELF || (expectedId && msg.authId !== expectedId)) return ws.close(4009, 'id inesperado');
      if (!peerConfig.has(msg.authId)) return ws.close(4009, `${msg.authId} no está en --cluster`);
      const existing = peers.get(msg.authId);
      if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
        return ws.close(4009, 'enlace duplicado');
      }
      clearTimeout(helloTimer);
      peer = { ws, authId: msg.authId, publicUrl: msg.publicUrl, peerUrl: msg.peerUrl, role: msg.role,
               lastSeq: msg.lastSeq, lastAckAt: Date.now(), outbound };
      peers.set(peer.authId, peer);
      log('MESH', `Enlazado con ${peer.authId} (${msg.role}, term ${msg.term}, lastSeq ${msg.lastSeq}, ${outbound ? 'saliente' : 'entrante'})`);

      observeTerm(msg.term);
      if (msg.role === 'leader' && msg.term >= state.term) {
        followLeader(peer.authId, msg.term, msg.lastSeq);
      } else if (isLeader()) {
        sendHeartbeat();    // que la réplica nueva sepa ya quién manda
      }
      return;
    }
    onMessage(peer, msg);
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (peer && peers.get(peer.authId) === peer) {
      peers.delete(peer.authId);
      log('MESH', `Se perdió el enlace con ${peer.authId}${peer.authId === state.leaderId ? ' (era el LÍDER)' : ''}`);
    }
  });
  ws.on('error', () => {});
}

const dialing = new Set();
const lastDial = new Map();
function dialPeers() {
  const now = Date.now();
  for (const [authId, url] of peerConfig) {
    if (SELF.localeCompare(authId) >= 0) continue;     // inicia el id MENOR
    if (peers.has(authId) || dialing.has(authId)) continue;
    if (now - (lastDial.get(authId) || 0) < 1000) continue;
    lastDial.set(authId, now);
    dialing.add(authId);
    const ws = new WebSocket(url, { headers: { 'ngrok-skip-browser-warning': 'true' }, handshakeTimeout: 4000 });
    ws.on('open', () => { dialing.delete(authId); attach(ws, true, authId); });
    ws.on('error', () => {});
    ws.on('close', () => dialing.delete(authId));
  }
}

function tick() {
  dialPeers();
  if (isLeader()) return;
  const now = Date.now();
  // Sin latido del líder durante ELECTION_TIMEOUT → el líder murió
  if (state.leaderId && now - state.lastLeaderContact > config.ELECTION_TIMEOUT_MS) {
    log('ELECTION', `Sin heartbeat de ${state.leaderId} hace ${now - state.lastLeaderContact} ms → líder caído`);
    state.leaderId = null;
    scheduleElection(0);
  }
  if (!state.leaderId && now > state.electionDeadline) startElection();
  // Sync que no respondió: reintentar
  if (state.syncing && now - state.syncing.at > 3000) { state.syncing = null; requestSync(); }
}

// ── Arranque ──────────────────────────────────────────────────────────────────
function start(httpServer) {
  const handle = (ws) => attach(ws, false, null);

  // Puerto propio para la mesh de auths (PEER_PORT)…
  if (CLUSTER_SIZE > 1) {
    const peerServer = http.createServer((req, res) => res.end(`auth-peer ${SELF}\n`));
    new WebSocketServer({ server: peerServer }).on('connection', handle);
    peerServer.listen(config.PEER_PORT, () => log('MESH', `Mesh de auths escuchando en ws://localhost:${config.PEER_PORT} (anunciado como ${config.PEER_URL})`));
    peerServer.on('error', (err) => { console.error(`[MESH] No se pudo abrir el puerto ${config.PEER_PORT}: ${err.message}`); process.exit(1); });
  }
  // …y también en /peer del puerto HTTP (útil con ngrok: un solo túnel por auth)
  const wssPath = new WebSocketServer({ noServer: true });
  wssPath.on('connection', handle);
  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/peer') return socket.destroy();
    wssPath.handleUpgrade(req, socket, head, (ws) => wssPath.emit('connection', ws, req));
  });

  scheduleElection(config.ELECTION_TIMEOUT_MS);
  if (CLUSTER_SIZE === 1) {
    // Nodo único: es líder sin elección (compatibilidad con talleres anteriores)
    state.votes = new Set([SELF]);
    becomeLeader();
  } else {
    log('CLUSTER', `${SELF} arranca como réplica (term ${state.term}, lastSeq ${store.lastSeq()}, ${store.userCount()} usuarios). Clúster: ${[SELF, ...peerConfig.keys()].sort().join(', ')} · mayoría ${MAJORITY}/${CLUSTER_SIZE}`);
  }
  setInterval(tick, 250).unref();
}

function shutdown() {
  for (const p of peers.values()) { try { p.ws.close(1001, 'apagando'); } catch {} }
}

module.exports = {
  start, shutdown, status, peerList, isLeader, leaderUrl, propose, writeRefusal, readRefusal,
  setDirectoryHooks, lag, SELF
};
