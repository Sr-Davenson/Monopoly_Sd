// ─────────────────────────────────────────────────────────────────────────────
// Cliente del tablero.
//
// Este archivo NO calcula nada del juego: solo dibuja el estado que manda el
// coordinador (game_state) y envía acciones (game_action). Si alguien modifica
// `state` desde DevTools, solo cambia su propia pantalla; el servidor sigue
// siendo la fuente de verdad.
// ─────────────────────────────────────────────────────────────────────────────

const originalToken   = localStorage.getItem('token');
const currentUsername = localStorage.getItem('username') || 'Jugador';
const ROOM_ID         = new URLSearchParams(location.search).get('sala') || 'sala-1';

let conn = null;            // conexión con el coordinador (net.js)
let config = null;          // tablero, temáticas, economía (estático)
let state = null;           // estado de la partida de ESTA sala (lo manda el servidor)
let myId = null;
let progress = null;        // estadísticas del usuario (misiones)
let selectedTheme = null;
let selectedSkin = null;
let selectedSpace = null;
let lastRollT = 0;
let lastCardSeq = 0;
let leaving = false;
let recoverUntil = 0;       // ventana tras perder el coordinador para recuperar el asiento
let rejoinTried = -1;       // versión del estado en la que ya se intentó volver a unirse
let lastSeat = null;        // temática/ficha con la que estábamos en la sala de espera
let tradeDraft = emptyDraft();

const WORLD_COLOR = { david: 'var(--pirate)', jossef: 'var(--fantasy)', sebastian: 'var(--viking)', santiago: 'var(--letters)' };

const $ = (id) => document.getElementById(id);

// ── Utilidades ───────────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k.startsWith('--')) node.style.setProperty(k, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function money(n) {
  const sym = config ? config.economy.currency.symbol : '¤';
  return `${sym}${Number(n).toLocaleString('es-CO')}`;
}

let toastTimer = null;
function toast(text, kind = 'error') {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast ${kind === 'info' ? 'info' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function act(action, data = {}) {
  if (!conn || !conn.send({ type: 'game_action', data: { action, ...data } })) {
    toast('Sin conexión con el coordinador');
  }
}

// Botón con confirmación en dos pasos (el visor no permite confirm())
function confirmButton(label, confirmLabel, cls, onConfirm) {
  const b = el('button', { class: cls, type: 'button' }, label);
  let armed = false, timer = null;
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      timer = setTimeout(() => { armed = false; b.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer);
    onConfirm();
  });
  return b;
}

function setConn(stateName, text) {
  $('conn-status').dataset.state = stateName;
  $('conn-text').textContent = text;
}

function tokenOf(skin, size, color) {
  return Tokens.node(skin, size, color);
}

function isUnlocked(skin) {
  if (skin.starter || !skin.unlock) return true;
  return !!progress && Number(progress[skin.unlock.stat] || 0) >= skin.unlock.count;
}

// ── Consultas sobre el estado ────────────────────────────────────────────────
const me = () => state && state.players.find(p => p.id === myId);
const playerById = (id) => state.players.find(p => p.id === id);
const memberById = (id) => config.members.find(m => m.id === id);
const isMyTurn = () => state && state.phase === 'playing' && state.turn && state.turn.playerId === myId;

function groupSpaces(groupId) {
  return config.spaces.filter(s => s.type === 'property' && s.group === groupId);
}
function groupHasBuildings(groupId) {
  return groupSpaces(groupId).some(s => state.properties[s.id].level > 0);
}
function isTradeable(space) {
  return space.type !== 'property' || !groupHasBuildings(space.group);
}
function ownedBy(id) {
  return config.spaces.filter(s => state.properties[s.id] && state.properties[s.id].ownerId === id);
}
function unmortgageCost(space) {
  const e = config.economy;
  return Math.ceil(space.price * e.mortgageRate * (1 + e.unmortgageInterest));
}

// ── Tablero ──────────────────────────────────────────────────────────────────
function gridPos(i) {
  if (i <= 10) return { row: 11, col: 11 - i };
  if (i <= 20) return { row: 11 - (i - 10), col: 1 };
  if (i <= 30) return { row: 1, col: 1 + (i - 20) };
  return { row: 1 + (i - 30), col: 11 };
}

const SPACE_ICONS = {
  start: '⚑', jail: '⛓', rest: '🍺', go_to_jail: '⚔',
  card_general: '📜', card_special: '✶', donation: '♥', transport: '⇄', service: '⚡'
};

const TYPE_LABELS = {
  start: 'Esquina', jail: 'Esquina', rest: 'Esquina', go_to_jail: 'Esquina',
  property: 'Propiedad', transport: 'Transporte', service: 'Servicio',
  card_general: 'Tarjeta General', card_special: 'Tarjeta Especial', donation: 'Donación'
};

function buildBoard() {
  const board = $('board');
  board.querySelectorAll('.space, .section-label').forEach(n => n.remove());
  const center = board.querySelector('.board-center');

  for (const m of config.members) {
    center.append(el('div', { class: `section-label s${m.side}`, '--section-color': m.color }, `${m.world} · ${m.sectionName}`));
  }

  // Capa de fichas animadas (se recrea junto con el tablero)
  board.querySelector('.token-layer')?.remove();
  tokenAnim.clear();
  lastMoveRollT = null;
  board.append(el('div', { class: 'token-layer', id: 'token-layer', 'aria-hidden': 'true' }));

  for (const s of config.spaces) {
    const { row, col } = gridPos(s.id);
    const member = s.memberId ? memberById(s.memberId) : null;
    const corner = ['start', 'jail', 'rest', 'go_to_jail'].includes(s.type);
    const side = s.id < 10 ? 'bottom' : s.id < 20 ? 'left' : s.id < 30 ? 'top' : 'right';
    const cell = el('div', {
      class: `space ${corner ? 'corner' : `side-${side}`} ${s.type === 'property' ? 'is-prop' : ''}`,
      id: `space-${s.id}`,
      style: `grid-row:${row};grid-column:${col}`,
      '--section-color': member ? member.color : '#334155',
      title: s.name,
      onclick: () => { selectedSpace = s.id; render(); }
    });
    board.append(cell);
  }
}

function renderBoard() {
  const turnId = state.turn && state.turn.playerId;
  for (const s of config.spaces) {
    const cell = $(`space-${s.id}`);
    const prop = state.properties[s.id];
    const owner = prop && prop.ownerId ? playerById(prop.ownerId) : null;
    const corner = cell.classList.contains('corner');

    cell.classList.toggle('owned', !!owner);
    cell.classList.toggle('mortgaged', !!(prop && prop.mortgaged));
    cell.classList.toggle('selected', selectedSpace === s.id);
    if (owner) cell.style.setProperty('--owner-color', owner.color);

    const parts = [];
    if (s.type === 'property') {
      parts.push(el('div', { class: 'strip', '--group-color': config.groups[s.group].color }));
      if (s.icon) parts.push(el('div', { class: 'sicon', 'aria-hidden': 'true' }, s.icon));
    } else {
      parts.push(el('div', { class: 'sicon', 'aria-hidden': 'true' }, s.icon || SPACE_ICONS[s.type] || ''));
    }
    parts.push(el('div', { class: 'name' }, s.name));

    if (prop && prop.level > 0) {
      const b = el('div', { class: 'buildings' });
      if (prop.level === 5) b.append(el('span', { class: 'hotel' }));
      else for (let i = 0; i < prop.level; i++) b.append(el('span', { class: 'house' }));
      parts.push(b);
    }

    if (s.price && !owner && !corner) parts.push(el('div', { class: 'price' }, money(s.price)));
    else if (s.type === 'donation') parts.push(el('div', { class: 'price' }, money(s.amount)));

    // La franja de color va aparte (pegada al borde interior); el resto en .sbody
    const strip = parts[0] && parts[0].classList.contains('strip') ? parts.shift() : null;
    cell.replaceChildren(...(strip ? [strip] : []), el('div', { class: 'sbody' }, ...parts));
  }
  renderTokens(turnId);
}

// ── Fichas animadas ──────────────────────────────────────────────────────────
// Las fichas viven en una capa encima del tablero. Cuando el servidor manda
// una posición nueva, la ficha camina casilla por casilla hasta llegar.
const BOARD_SIZE   = 40;
const JAIL_POS     = 10;
const STEP_MS      = 420;   // duración de cada paso (lento, para ver el recorrido)
const LONG_TRIP_MS = 7000;  // tope de duración para recorridos muy largos (tarjetas)
const DICE_WAIT_MS = 500;   // espera a que terminen de girar los dados
const tokenAnim = new Map(); // playerId -> { wrap, art, skinId, shown, target, busy }
let lastMoveRollT = null;

// Zona de la casilla donde se paran las fichas: el borde exterior, para no
// tapar el nombre (el contenido de la casilla está pegado al borde interior).
// axis = eje a lo largo del cual se reparten varias fichas en la misma casilla.
function tokenAnchor(pos) {
  const cell = $(`space-${pos}`);
  const x = cell.offsetLeft, y = cell.offsetTop, w = cell.offsetWidth, h = cell.offsetHeight;
  if (pos === 0)  return { x: x + w / 2,    y: y + h * 0.76, axis: 'x', inward: [-1, 0] };
  if (pos === 10) return { x: x + w / 2,    y: y + h * 0.76, axis: 'x', inward: [1, 0] };
  if (pos === 20) return { x: x + w / 2,    y: y + h * 0.24, axis: 'x', inward: [1, 0] };
  if (pos === 30) return { x: x + w / 2,    y: y + h * 0.24, axis: 'x', inward: [-1, 0] };
  if (pos < 10)   return { x: x + w / 2,    y: y + h * 0.78, axis: 'x', inward: [0, -1] };
  if (pos < 20)   return { x: x + w * 0.22, y: y + h / 2,    axis: 'y', inward: [1, 0] };
  if (pos < 30)   return { x: x + w / 2,    y: y + h * 0.22, axis: 'x', inward: [0, 1] };
  return            { x: x + w * 0.78, y: y + h / 2,    axis: 'y', inward: [-1, 0] };
}

// Coloca cada ficha en su casilla visible, repartiendo las que comparten casilla
function placeTokens() {
  const layer = $('token-layer');
  if (!layer) return;
  const sample = $('space-1');
  const narrow = Math.min(sample.offsetWidth, sample.offsetHeight);
  const deep = Math.max(sample.offsetWidth, sample.offsetHeight);
  const size = Math.max(16, Math.min(narrow * 0.48, deep * 0.32));
  layer.style.setProperty('--tok', `${size}px`);

  const byCell = new Map();
  for (const [id, a] of tokenAnim) {
    if (!byCell.has(a.shown)) byCell.set(a.shown, []);
    byCell.get(a.shown).push(id);
  }
  for (const [pos, ids] of byCell) {
    const c = tokenAnchor(pos);
    const cell = $(`space-${pos}`);
    const span = c.axis === 'x' ? cell.offsetWidth : cell.offsetHeight;
    const n = ids.length;
    const cols = Math.min(n, 3);
    const rows = Math.ceil(n / 3);
    const step = Math.min(size * 0.95, (span * 0.9 - size) / Math.max(1, cols - 1));
    ids.forEach((id, i) => {
      const a = tokenAnim.get(id);
      const col = i % 3, row = Math.floor(i / 3);
      const rowCols = row === rows - 1 ? n - row * 3 : 3;
      const along = (col - (rowCols - 1) / 2) * step;
      const depth = row * size * 0.75;
      const dx = (c.axis === 'x' ? along : 0) + c.inward[0] * depth;
      const dy = (c.axis === 'y' ? along : 0) + c.inward[1] * depth;
      a.wrap.style.transform = `translate(${c.x + dx - size / 2}px, ${c.y + dy - size / 2}px)`;
      a.wrap.style.zIndex = a.busy ? 5 : 2;
    });
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function hop(a) {
  a.wrap.classList.remove('hop'); void a.wrap.offsetWidth; a.wrap.classList.add('hop');
}

// Construye el recorrido: [{ kind: 'walk', dir: ±1, steps }, { kind: 'jump', to }]
function planPath(from, to, p, rolled) {
  const fwd = (to - from + BOARD_SIZE) % BOARD_SIZE;
  const back = (from - to + BOARD_SIZE) % BOARD_SIZE;
  if (rolled && !(rolled.wasInJail && p.inJail)) {
    const landing = (from + rolled.sum) % BOARD_SIZE;
    // Cayó en "Ve al calabozo": camina hasta allí y luego salta a la cárcel
    if (p.inJail && to === JAIL_POS) {
      return rolled.tripleDoubles
        ? [{ kind: 'jump', to }] // tres dobles: directo a la cárcel sin moverse
        : [{ kind: 'walk', dir: 1, steps: rolled.sum }, { kind: 'jump', to }];
    }
    // Camina lo que marcaron los dados y luego, si una tarjeta lo movió, sigue
    const path = [{ kind: 'walk', dir: 1, steps: rolled.sum }];
    if (landing !== to) path.push(...planPath(landing, to, p, null));
    return path;
  }
  if (p.inJail && to === JAIL_POS) return [{ kind: 'jump', to }];
  if (back <= 3 && back < fwd) return [{ kind: 'walk', dir: -1, steps: back }];
  return [{ kind: 'walk', dir: 1, steps: fwd }];
}

async function animateToken(id, path) {
  const a = tokenAnim.get(id);
  a.busy = true;
  const total = path.reduce((n, s) => n + (s.kind === 'walk' ? s.steps : 1), 0);
  const stepMs = Math.min(STEP_MS, Math.max(140, LONG_TRIP_MS / total));
  a.wrap.style.setProperty('--step', `${stepMs}ms`);
  for (const seg of path) {
    if (!tokenAnim.has(id)) return;
    if (seg.kind === 'jump') {
      flushAfterMove(a);
      a.wrap.classList.add('teleport');
      await wait(260);
      a.shown = seg.to; placeTokens();
      await wait(40);
      a.wrap.classList.remove('teleport');
      await wait(300);
      continue;
    }
    for (let i = 0; i < seg.steps; i++) {
      a.shown = (a.shown + seg.dir + BOARD_SIZE) % BOARD_SIZE;
      hop(a);
      Sound.play('step', themeOfPlayer(id), a.shown);
      placeTokens();
      $(`space-${a.shown}`).classList.add('stepped');
      setTimeout((pos => () => $(`space-${pos}`).classList.remove('stepped'))(a.shown), stepMs + 250);
      await wait(stepMs);
    }
  }
  a.busy = false;
  // Si llegó otra actualización mientras caminaba, sigue hacia el nuevo destino
  if (a.shown !== a.target) {
    const p = state.players.find(x => x.id === id);
    if (p) return animateToken(id, planPath(a.shown, a.target, p, null));
  }
  placeTokens();
  flushAfterMove(a);
}

function themeOfPlayer(id) {
  const p = state && state.players.find(x => x.id === id);
  return p ? p.themeId : null;
}

// Sonidos que deben sonar cuando la ficha llega (compra, renta, tarjeta...)
function flushAfterMove(a) {
  const queue = a.after || [];
  a.after = [];
  queue.forEach((fn, k) => setTimeout(fn, k * 350));
}

function renderTokens(turnId) {
  const layer = $('token-layer');
  // Detecta una tirada nueva de dados (para saber cuánto caminó el jugador)
  const rollEntry = [...state.log].reverse().find(l => l.text.includes(' sacó '));
  let rolled = null;
  if (rollEntry && rollEntry.t !== lastMoveRollT) {
    const first = lastMoveRollT === null;
    lastMoveRollT = rollEntry.t;
    if (!first && state.turn && state.turn.dice) {
      const after = state.log.slice(state.log.indexOf(rollEntry) + 1);
      rolled = {
        playerId: state.turn.playerId,
        sum: state.turn.dice[0] + state.turn.dice[1],
        tripleDoubles: after.some(l => l.text.includes('dobles seguidos'))
      };
    }
  }

  const alive = new Set();
  for (const p of state.players) {
    if (p.bankrupt) continue;
    alive.add(p.id);
    let a = tokenAnim.get(p.id);
    if (!a || a.skinId !== p.skin.id) {
      if (a) a.wrap.remove();
      const art = tokenOf(p.skin, '', p.color);
      const wrap = el('div', { class: 'ptoken fresh' }, art);
      requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.remove('fresh')));
      layer.append(wrap);
      a = { wrap, art, skinId: p.skin.id, shown: a ? a.shown : p.position, target: a ? a.target : p.position, busy: false, inJail: p.inJail };
      tokenAnim.set(p.id, a);
    }
    a.art.classList.toggle('current', p.id === turnId);
    a.wrap.title = `${p.username} — ${p.skin.name}${p.inJail ? ' (en el calabozo)' : ''}`;

    const wasInJail = a.inJail;
    a.inJail = p.inJail;
    if (a.target === p.position) continue;
    a.target = p.position;
    if (a.busy) continue; // animateToken retomará el nuevo destino al terminar
    const r = rolled && rolled.playerId === p.id ? { ...rolled, wasInJail } : null;
    const path = planPath(a.shown, p.position, p, r);
    a.busy = true;
    wait(r ? DICE_WAIT_MS : 0).then(() => animateToken(p.id, path));
  }
  for (const [id, a] of tokenAnim) {
    if (!alive.has(id)) { a.wrap.remove(); tokenAnim.delete(id); }
  }
  placeTokens();
}

window.addEventListener('resize', () => { if (state && config) placeTokens(); });

// ── Centro: turno, dados y acciones ──────────────────────────────────────────
function renderCenter() {
  const info = $('turn-info');
  const actions = $('actions');
  actions.replaceChildren();

  if (state.phase === 'finished') {
    const w = state.winnerId && playerById(state.winnerId);
    info.replaceChildren(el('strong', {}, w ? `🏆 ¡${w.username} gana la partida!` : 'Partida terminada'));
    if (state.hostId === myId) actions.append(el('button', { class: 'btn btn-success', onclick: () => act('restart') }, 'Nueva partida'));
    $('die-1').textContent = '–'; $('die-2').textContent = '–';
    renderPot();
    return;
  }

  const current = playerById(state.turn.playerId);
  const t = state.turn;
  const stageText = { roll: 'tira los dados', buy: 'decide si compra', debt: 'debe pagar', end: 'puede gestionar o terminar el turno' }[t.stage];
  info.replaceChildren(
    'Turno de ', el('strong', { style: `color:${current.color}` }, current.username), ` — ${stageText}`,
    current.connected ? '' : ' (desconectado)'
  );

  const [d1, d2] = t.dice || ['–', '–'];
  $('die-1').textContent = d1;
  $('die-2').textContent = d2;
  const rollEntry = [...state.log].reverse().find(l => l.text.includes(' sacó '));
  if (rollEntry && rollEntry.t !== lastRollT) {
    lastRollT = rollEntry.t;
    for (const d of [$('die-1'), $('die-2')]) {
      d.classList.remove('rolling'); void d.offsetWidth; d.classList.add('rolling');
    }
  }

  const mine = me();
  if (!mine) {
    actions.append(el('span', { class: 'text-muted small' }, 'Partida en curso: estás como espectador.'));
  } else if (isMyTurn()) {
    const e = config.economy;
    if (t.stage === 'roll') {
      if (mine.inJail) {
        actions.append(
          el('button', { class: 'btn', onclick: () => act('roll') }, 'Intentar dobles'),
          el('button', { class: 'btn btn-warning', onclick: () => act('pay_jail'), disabled: mine.money < e.jailFine }, `Pagar multa (${money(e.jailFine)})`)
        );
        if (mine.jailCards > 0) actions.append(el('button', { class: 'btn btn-success', onclick: () => act('use_jail_card') }, 'Usar carta de salida'));
      } else {
        actions.append(el('button', { class: 'btn', onclick: () => act('roll') }, '🎲 Tirar dados'));
      }
    } else if (t.stage === 'buy') {
      const s = config.spaces[t.pendingBuy];
      actions.append(
        el('button', { class: 'btn btn-success', onclick: () => act('buy'), disabled: mine.money < s.price }, `Comprar por ${money(s.price)}`),
        el('button', { class: 'btn btn-ghost', onclick: () => act('decline') }, 'No comprar')
      );
      if (mine.money < s.price) actions.append(el('span', { class: 'small text-muted' }, 'No te alcanza: puedes hipotecar en "Mis propiedades".'));
    } else if (t.stage === 'debt') {
      actions.append(
        el('span', { class: 'small', style: 'color:#fca5a5' }, `Debes ${money(t.debt.total)}. Vende construcciones o hipoteca en "Mis propiedades".`),
        confirmButton('Declararme en bancarrota', '¿Seguro? Confirmar bancarrota', 'btn btn-danger', () => act('bankrupt'))
      );
    } else if (t.stage === 'end') {
      actions.append(el('button', { class: 'btn', onclick: () => act('end_turn') }, 'Terminar turno'));
    }
  } else if (!mine.bankrupt) {
    actions.append(el('span', { class: 'text-muted small' }, 'Espera tu turno.'));
  }

  if (mine && !mine.bankrupt) {
    actions.append(confirmButton('Rendirse', '¿Seguro? Confirmar rendición', 'btn btn-ghost btn-small', () => act('forfeit')));
  }

  renderPot();
}

function renderPot() {
  $('pot').textContent = `Fondo de Donaciones: ${money(state.pot)} (lo cobra quien cae en Descanso)`;

  const c = state.lastCard;
  const box = $('last-card');
  if (!c) { box.hidden = true; return; }
  const who = playerById(c.playerId);
  box.hidden = false;
  box.replaceChildren(
    el('div', { class: 'card-deck' }, `Tarjeta ${c.deck === 'general' ? 'General' : 'Especial'} · ${who ? who.username : ''}`),
    el('div', { class: 'card-title' }, c.title),
    el('div', {}, c.text)
  );
  if (c.seq !== lastCardSeq) {
    if (lastCardSeq !== 0) toast(`${who ? who.username : ''}: ${c.text}`, 'info');
    lastCardSeq = c.seq;
  }
}

// ── Panel: jugadores ─────────────────────────────────────────────────────────
function renderPlayers() {
  const list = $('players');
  list.replaceChildren(...state.players.map(p => {
    const theme = config.themes.find(t => t.id === p.themeId);
    const owned = ownedBy(p.id).length;
    const meta = [
      theme ? theme.name : '',
      `${owned} prop.`,
      p.inJail ? 'en el calabozo' : '',
      p.jailCards ? `${p.jailCards} carta(s) de salida` : '',
      '',
      p.id === state.hostId ? 'anfitrión' : ''
    ].filter(Boolean).join(' · ');
    return el('li', {
      class: `${state.turn && state.turn.playerId === p.id ? 'turn' : ''} ${p.bankrupt ? 'bankrupt' : ''}`,
      '--player-color': p.color
    },
      tokenOf(p.skin, '', p.color),
      el('div', { class: 'pname' },
        el('div', {}, p.username, p.id === myId ? ' (tú)' : ''),
        el('div', { class: 'pmeta' }, meta),
        !p.connected && !p.bankrupt && state.phase === 'playing'
          ? el('div', { class: 'pmeta dc-count', 'data-since': p.disconnectedAt || serverNow() }, 'desconectado')
          : (!p.connected ? el('div', { class: 'pmeta' }, 'desconectado') : '')
      ),
      el('span', { class: 'pmoney' }, money(p.money))
    );
  }));

  const mine = me();
  $('me-money').hidden = !mine;
  if (mine) $('me-money').textContent = money(mine.money);
  $('me-token').replaceChildren(mine ? tokenOf(mine.skin, 'sm', mine.color) : '');
}

// ── Panel: casilla seleccionada ──────────────────────────────────────────────
function renderSpaceDetail() {
  const box = $('space-detail');
  if (selectedSpace === null) return;
  const s = config.spaces[selectedSpace];
  const prop = state.properties[s.id];
  const member = s.memberId ? memberById(s.memberId) : null;
  const e = config.economy;
  const rows = [];
  const row = (k, v) => rows.push(el('tr', {}, el('td', {}, k), el('td', {}, v)));

  if (s.price) row('Precio', money(s.price));
  if (s.type === 'property') {
    const g = config.groups[s.group];
    row('Grupo', g.name);
    row('Renta base', money(s.rents[0]));
    row('Con grupo completo', money(s.rents[0] * 2));
    for (let i = 1; i <= 4; i++) row(`${i} casa${i > 1 ? 's' : ''}`, money(s.rents[i]));
    row('Hotel', money(s.rents[5]));
    row('Costo por construcción', money(s.houseCost));
  }
  if (s.type === 'transport') e.transportRents.forEach((r, i) => row(`Con ${i + 1} transporte${i ? 's' : ''}`, money(r)));
  if (s.type === 'service') e.serviceMultipliers.forEach((m, i) => row(`Con ${i + 1} servicio${i ? 's' : ''}`, `dados × ${m}`));
  if (s.price) row('Valor de hipoteca', money(Math.floor(s.price * e.mortgageRate)));
  if (s.type === 'donation') row('Donación', `${money(s.amount)} al Fondo`);
  if (prop) {
    const owner = prop.ownerId ? playerById(prop.ownerId) : null;
    row('Dueño', owner ? owner.username : 'Banco');
    if (prop.level) row('Construcciones', prop.level === 5 ? 'Hotel' : `${prop.level} casa(s)`);
    if (prop.mortgaged) row('Estado', 'Hipotecada');
  }

  box.className = 'space-detail small';
  box.replaceChildren(
    el('div', { class: 'detail-name' }, s.name),
    el('div', { class: 'text-muted' }, TYPE_LABELS[s.type], member ? ` · Sección de ${member.name}` : ''),
    rows.length ? el('table', {}, el('tbody', {}, rows)) : ''
  );
}

// ── Panel: mis propiedades (construir, vender, hipotecar) ────────────────────
function renderMyProps() {
  const box = $('my-props');
  const mine = me();
  const props = mine ? ownedBy(mine.id) : [];
  if (!props.length) {
    box.className = 'my-props text-muted small';
    box.textContent = 'Sin propiedades.';
    return;
  }
  box.className = 'my-props';
  const myTurn = isMyTurn();
  const inDebt = myTurn && state.turn.stage === 'debt';
  const e = config.economy;

  box.replaceChildren(...props.map(s => {
    const prop = state.properties[s.id];
    const btns = [];
    if (s.type === 'property' && !prop.mortgaged) {
      const full = groupSpaces(s.group).every(g => state.properties[g.id].ownerId === myId);
      if (full && prop.level < 5 && !inDebt) {
        btns.push(el('button', { class: 'btn btn-success', disabled: !myTurn, onclick: () => act('build', { spaceId: s.id }) },
          `${prop.level === 4 ? 'Hotel' : 'Casa'} (−${money(s.houseCost)})`));
      }
      if (prop.level > 0) {
        btns.push(el('button', { class: 'btn btn-secondary', disabled: !myTurn, onclick: () => act('sell_building', { spaceId: s.id }) },
          `Vender (+${money(Math.floor(s.houseCost * e.buildingSellRate))})`));
      }
    }
    if (!prop.mortgaged && !(s.type === 'property' && groupHasBuildings(s.group))) {
      btns.push(el('button', { class: 'btn btn-secondary', disabled: !myTurn, onclick: () => act('mortgage', { spaceId: s.id }) },
        `Hipotecar (+${money(Math.floor(s.price * e.mortgageRate))})`));
    }
    if (prop.mortgaged && !inDebt) {
      btns.push(el('button', { class: 'btn btn-secondary', disabled: !myTurn, onclick: () => act('unmortgage', { spaceId: s.id }) },
        `Levantar (−${money(unmortgageCost(s))})`));
    }
    const status = prop.mortgaged ? ' · hipotecada' : prop.level ? ` · ${prop.level === 5 ? 'hotel' : prop.level + ' casa(s)'}` : '';
    return el('div', { class: 'prop-row', '--group-color': s.type === 'property' ? config.groups[s.group].color : '#64748b' },
      el('div', { class: 'prop-name' }, s.name, el('span', { class: 'text-muted' }, status)),
      btns.length ? el('div', { class: 'prop-actions' }, btns) : ''
    );
  }));
}

// ── Panel: intercambios ──────────────────────────────────────────────────────
function emptyDraft() {
  return { toId: '', offer: { money: 0, properties: new Set(), jailCards: 0 }, request: { money: 0, properties: new Set(), jailCards: 0 } };
}

function describeSide(side) {
  const parts = [];
  if (side.money) parts.push(money(side.money));
  for (const id of side.properties) parts.push(config.spaces[id].name);
  if (side.jailCards) parts.push(`${side.jailCards} carta(s) de salida`);
  return parts.length ? parts.join(', ') : 'nada';
}

// La ventana flotante tiene dos modos:
//   'propose' → formulario para armar una oferta (solo en tu turno)
//   'offer'   → una oferta pendiente en la que participas (aceptar/rechazar/cancelar)
let tradeWin = { open: false, mode: null, tradeId: null, dismissedTradeId: null, pos: null };

function propChip(spaceId) {
  const s = config.spaces[spaceId];
  const color = s.type === 'property' ? config.groups[s.group].color : '#64748b';
  return el('span', { class: 'prop-chip', '--group-color': color }, s.icon ? `${s.icon} ` : '', s.name);
}

function sideView(title, player, side) {
  const items = [];
  if (side.money) items.push(el('span', { class: 'money-chip' }, money(side.money)));
  for (const id of side.properties) items.push(propChip(id));
  if (side.jailCards) items.push(el('span', { class: 'prop-chip' }, `🗝 ${side.jailCards} carta(s) de salida`));
  return el('div', { class: 'trade-side', '--player-color': player.color },
    el('div', { class: 'trade-side-head' },
      tokenOf(player.skin, 'sm', player.color),
      el('div', {}, el('small', {}, title), el('strong', {}, player.username))),
    el('div', { class: 'trade-items' }, items.length ? items : el('span', { class: 'text-muted' }, 'Nada'))
  );
}

function canPropose() {
  return !!state && state.phase === 'playing' && !state.trade && isMyTurn() && state.turn.stage !== 'buy';
}

function openTradeWindow(mode) {
  tradeWin.open = true;
  tradeWin.mode = mode;
  const win = $('trade-window');
  win.hidden = false;
  if (tradeWin.pos) {
    Object.assign(win.style, { left: `${tradeWin.pos.x}px`, top: `${tradeWin.pos.y}px`, right: 'auto', bottom: 'auto' });
  }
  win.classList.remove('pop'); void win.offsetWidth; win.classList.add('pop');
  buildTradeWindow();
}

function closeTradeWindow() {
  tradeWin.open = false;
  tradeWin.mode = null;
  $('trade-window').hidden = true;
}

function buildTradeWindow() {
  const body = $('trade-win-body');
  const title = $('trade-win-title');
  const t = state.trade;

  if (tradeWin.mode === 'offer' && t) {
    const from = playerById(t.fromId), to = playerById(t.toId);
    tradeWin.tradeId = t.id;
    title.textContent = t.toId === myId ? `Oferta de ${from.username}` : `Tu oferta a ${to.username}`;
    const actions = el('div', { class: 'trade-actions' });
    if (t.toId === myId) {
      actions.append(
        el('button', { class: 'btn btn-success', onclick: () => act('trade_respond', { tradeId: t.id, accept: true }) }, 'Aceptar'),
        el('button', { class: 'btn btn-danger', onclick: () => act('trade_respond', { tradeId: t.id, accept: false }) }, 'Rechazar')
      );
    } else if (t.fromId === myId) {
      actions.append(
        el('span', { class: 'text-muted small waiting-dots' }, `Esperando a ${to.username}`),
        el('button', { class: 'btn btn-ghost btn-small', onclick: () => act('trade_cancel', { tradeId: t.id }) }, 'Cancelar oferta')
      );
    }
    body.replaceChildren(
      el('div', { class: 'trade-compare' },
        sideView('Entrega', from, t.offer),
        el('div', { class: 'trade-arrows', 'aria-hidden': 'true' }, '⇄'),
        sideView('Entrega', to, t.request)
      ),
      actions
    );
    return;
  }

  // Modo proponer
  title.textContent = 'Proponer intercambio';
  const mine = me();
  const others = state.players.filter(p => !p.bankrupt && p.id !== myId);
  if (!others.find(p => p.id === tradeDraft.toId)) tradeDraft = { ...emptyDraft(), toId: others[0] ? others[0].id : '' };
  const target = playerById(tradeDraft.toId);
  if (!mine || !target) { body.replaceChildren(el('p', { class: 'text-muted' }, 'No hay con quién intercambiar.')); return; }

  const targets = el('div', { class: 'trade-targets' }, others.map(p =>
    el('button', {
      type: 'button', class: 'trade-target', 'aria-pressed': String(p.id === tradeDraft.toId), '--player-color': p.color,
      onclick: () => { tradeDraft = { ...emptyDraft(), toId: p.id }; buildTradeWindow(); }
    }, tokenOf(p.skin, 'sm', p.color), el('span', {}, p.username), el('small', {}, money(p.money)))
  ));

  const column = (heading, owner, side) => {
    const props = ownedBy(owner.id).filter(isTradeable);
    return el('div', { class: 'trade-col', '--player-color': owner.color },
      el('div', { class: 'trade-col-title' }, heading),
      el('label', { class: 'trade-money' }, 'Dinero',
        el('input', { type: 'number', min: 0, max: owner.money, step: 10, value: side.money,
          oninput: (ev) => { side.money = Math.max(0, Math.min(owner.money, Math.floor(Number(ev.target.value) || 0))); } })),
      owner.jailCards ? el('label', { class: 'trade-money' }, 'Cartas de salida',
        el('input', { type: 'number', min: 0, max: owner.jailCards, value: side.jailCards,
          oninput: (ev) => { side.jailCards = Math.max(0, Math.min(owner.jailCards, Math.floor(Number(ev.target.value) || 0))); } })) : '',
      el('div', { class: 'checks' }, props.length
        ? props.map(s => el('label', { class: 'check-prop', '--group-color': s.type === 'property' ? config.groups[s.group].color : '#64748b' },
            el('input', { type: 'checkbox', checked: side.properties.has(s.id),
              onchange: (ev) => { if (ev.target.checked) side.properties.add(s.id); else side.properties.delete(s.id); } }),
            el('span', {}, s.name)))
        : el('span', { class: 'text-muted small' }, 'Sin propiedades intercambiables'))
    );
  };

  body.replaceChildren(
    el('div', { class: 'trade-label' }, 'Con quién'),
    targets,
    el('div', { class: 'trade-cols' },
      column('Tú ofreces', mine, tradeDraft.offer),
      column(`Pides a ${target.username}`, target, tradeDraft.request)),
    el('div', { class: 'trade-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => {
        const side = s => ({ money: s.money, properties: [...s.properties], jailCards: s.jailCards });
        act('trade_propose', { toId: tradeDraft.toId, offer: side(tradeDraft.offer), request: side(tradeDraft.request) });
        tradeDraft = emptyDraft();
      } }, 'Enviar oferta'),
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: closeTradeWindow }, 'Cerrar')
    )
  );
}

function renderTrade() {
  const summary = $('trade-summary');
  const t = state.phase === 'playing' ? state.trade : null;

  // Panel lateral: resumen + botón para abrir la ventana
  if (t) {
    const from = playerById(t.fromId), to = playerById(t.toId);
    const mineInvolved = t.fromId === myId || t.toId === myId;
    summary.replaceChildren(
      el('div', {}, el('strong', {}, from.username), ' ⇄ ', el('strong', {}, to.username), ': oferta pendiente'),
      mineInvolved ? el('button', { class: 'btn btn-small', type: 'button', onclick: () => openTradeWindow('offer') }, 'Ver oferta') : ''
    );
  } else if (canPropose()) {
    summary.replaceChildren(el('button', { class: 'btn btn-small', type: 'button', onclick: () => openTradeWindow('propose') }, '⇄ Proponer intercambio'));
  } else {
    summary.replaceChildren(el('span', { class: 'text-muted' },
      state.phase === 'playing' ? 'Puedes proponer intercambios durante tu turno.' : 'Sin intercambios.'));
  }

  // Ventana flotante
  const involved = t && (t.fromId === myId || t.toId === myId);
  if (involved && t.id !== tradeWin.dismissedTradeId && !(tradeWin.open && tradeWin.mode === 'offer' && tradeWin.tradeId === t.id)) {
    openTradeWindow('offer'); // llega una oferta nueva (o la acabo de enviar)
    return;
  }
  if (!tradeWin.open) return;
  if (tradeWin.mode === 'offer' && !t) { closeTradeWindow(); return; }
  if (tradeWin.mode === 'propose' && !canPropose()) { closeTradeWindow(); return; }
  // No reconstruir mientras escribe en la ventana (perdería el foco)
  if (!$('trade-window').contains(document.activeElement)) buildTradeWindow();
}

// Arrastrar la ventana flotante desde su barra
(function makeDraggable() {
  const win = $('trade-window');
  const bar = $('trade-win-bar');
  let drag = null;
  bar.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('button')) return;
    const r = win.getBoundingClientRect();
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    bar.setPointerCapture(ev.pointerId);
    win.classList.add('dragging');
  });
  bar.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const x = Math.min(Math.max(0, ev.clientX - drag.dx), window.innerWidth - win.offsetWidth);
    const y = Math.min(Math.max(0, ev.clientY - drag.dy), window.innerHeight - 48);
    tradeWin.pos = { x, y };
    Object.assign(win.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
  });
  const end = () => { drag = null; win.classList.remove('dragging'); };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  $('trade-win-close').addEventListener('click', () => {
    if (tradeWin.mode === 'offer') tradeWin.dismissedTradeId = tradeWin.tradeId;
    closeTradeWindow();
  });
})();

// ── Eventos de la partida → sonidos (según la temática de quien actúa) ───────
let seenLog = null;   // claves de las entradas del registro ya procesadas
let clockOffset = 0;  // serverNow - Date.now() (para las cuentas regresivas)

const LOG_SOUNDS = [
  [/ compró /, 'buy'],
  [/ construyó /, 'build'],
  [/ de renta a | pagó su deuda| paga la multa| pagó .* sale del calabozo/, 'pay'],
  [/ pasa por Salida| se lleva el Fondo/, 'collect'],
  [/ toma Tarjeta /, 'card'],
  [/ va al calabozo| dobles seguidos/, 'jail'],
  [/ aceptó el intercambio /, 'tradeOk'],
  [/ propone un intercambio a /, 'trade'],
  [/^⏰ Se acabó el tiempo de /, 'timeout'],
  [/ no se reconectó a tiempo| quebró| quedó eliminado| se rinde/, 'expel']
];

function playerFromText(text) {
  const clean = text.replace(/^[^\p{L}\p{N}]+/u, '');
  return state.players
    .filter(p => clean.startsWith(`${p.username} `) || text.includes(`tiempo de ${p.username}`))
    .sort((x, y) => y.username.length - x.username.length)[0] || null;
}

function processEvents() {
  const keys = state.log.map(l => `${l.t}|${l.text}`);
  if (seenLog === null) { seenLog = new Set(keys); return; } // primera carga: sin sonidos
  const fresh = state.log.filter((l, i) => !seenLog.has(keys[i]));
  seenLog = new Set(keys);

  for (const entry of fresh) {
    const text = entry.text;
    if (text.includes(' sacó ') && !text.includes('dobles seguidos')) {
      const p = playerFromText(text);
      Sound.play('roll', p && p.themeId);
      continue;
    }
    const turnMatch = /^Turno de (.+)$/.exec(text);
    if (turnMatch) {
      const p = state.players.find(x => x.username === turnMatch[1]);
      if (p && p.id === myId) Sound.play('turn', p.themeId);
      continue;
    }
    if (/gana la partida/.test(text)) continue; // lo toca la ventana de fin de partida
    const rule = LOG_SOUNDS.find(([re]) => re.test(text));
    if (!rule) continue;
    let p = playerFromText(text);
    if (rule[1] === 'trade') {
      // La oferta suena con la temática de quien la recibe, y solo para los implicados
      const target = state.players.find(x => text.endsWith(` a ${x.username}`));
      if (!p || !target || (p.id !== myId && target.id !== myId)) continue;
      p = target;
    }
    const play = () => Sound.play(rule[1], p ? p.themeId : null);
    const anim = p && tokenAnim.get(p.id);
    if (anim && anim.busy) (anim.after = anim.after || []).push(play);
    else play();
  }
}

// ── Temporizadores: turno (1:30) y reconexión (30 s) ─────────────────────────
const serverNow = () => Date.now() + clockOffset;
let lastTickSecond = null;

function fmtClock(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function updateTimers() {
  if (!state || !config) return;
  const box = $('turn-timer');
  const t = state.phase === 'playing' ? state.turn : null;
  if (!t || !t.deadline) {
    box.hidden = true;
  } else {
    const total = (config.rules && config.rules.turnTimeoutMs) || 90000;
    const left = t.deadline - serverNow();
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    box.hidden = false;
    $('turn-timer-text').textContent = fmtClock(left);
    $('turn-timer-fill').style.width = `${pct}%`;
    box.dataset.level = left <= 10000 ? 'danger' : left <= 30000 ? 'warn' : 'ok';
    const current = playerById(t.playerId);
    if (current) box.style.setProperty('--timer-color', current.color);
    // Últimos 10 s de MI turno: tic por segundo
    const sec = Math.ceil(left / 1000);
    if (t.playerId === myId && sec <= 10 && sec > 0 && sec !== lastTickSecond) {
      lastTickSecond = sec;
      Sound.play('tick');
    }
  }

  // Cuenta regresiva de reconexión en la lista de jugadores
  const grace = (config.rules && config.rules.reconnectGraceMs) || 30000;
  for (const node of document.querySelectorAll('.dc-count')) {
    const left = Number(node.dataset.since) + grace - serverNow();
    node.textContent = left > 0
      ? `desconectado · ${Math.ceil(left / 1000)} s para volver`
      : 'desconectado · saliendo de la partida…';
  }
}
setInterval(updateTimers, 250);

// ── Logros: aviso cuando se desbloquea una ficha nueva ───────────────────────
function achievementKey() { return `unlocked_skins:${currentUsername}`; }

function checkAchievements() {
  if (!config || !progress) return;
  const skins = config.themes.flatMap(t => t.skins.map(sk => ({ ...sk, themeId: t.id, themeName: t.name })));
  const unlocked = skins.filter(sk => !sk.starter && sk.unlock && isUnlocked(sk));
  let known = null;
  try { known = JSON.parse(localStorage.getItem(achievementKey()) || 'null'); } catch { known = null; }
  const ids = unlocked.map(sk => sk.id);
  try { localStorage.setItem(achievementKey(), JSON.stringify(ids)); } catch { /* sin storage */ }
  if (!Array.isArray(known)) return; // primera vez en este navegador: solo se guarda
  unlocked.filter(sk => !known.includes(sk.id)).forEach((sk, k) => setTimeout(() => showAchievement(sk), k * 1600));
}

function showAchievement(skin) {
  const rarity = (config.rarities && config.rarities[skin.rarity]) || null;
  const RARITY_COLOR = { common: '#cbd5e1', rare: '#5b9bd5', epic: '#a78bfa', legendary: '#f2c14e' };
  const color = RARITY_COLOR[skin.rarity] || '#f2c14e';
  const card = el('div', { class: 'achievement', role: 'status', '--rarity-color': color },
    el('div', { class: 'achievement-glow', 'aria-hidden': 'true' }),
    tokenOf(skin, 'lg', color),
    el('div', { class: 'achievement-text' },
      el('div', { class: 'achievement-kicker' }, '🏅 ¡Logro desbloqueado!'),
      el('div', { class: 'achievement-title' }, skin.name),
      el('div', { class: 'achievement-sub' },
        [rarity ? rarity.label : skin.rarity, skin.themeName].filter(Boolean).join(' · ')),
      skin.unlock && skin.unlock.text ? el('div', { class: 'achievement-sub' }, skin.unlock.text) : ''
    ),
    el('button', { class: 'achievement-close', type: 'button', 'aria-label': 'Cerrar', onclick: () => dismiss() }, '✕')
  );
  const dismiss = () => { card.classList.add('leaving'); setTimeout(() => card.remove(), 400); };
  $('achievements').append(card);
  Sound.play('achievement', skin.themeId);
  setTimeout(dismiss, 7000);
}

// ── Fin de la partida: ventana con el ganador ────────────────────────────────
let endShownFor = null;

function endKey() {
  const start = state.log.find(l => l.text.startsWith('¡Comienza la partida!'));
  return `${ROOM_ID}|${state.winnerId}|${start ? start.t : ''}`;
}

function renderEndModal() {
  const modal = $('end-modal');
  if (state.phase !== 'finished') { modal.hidden = true; endShownFor = null; return; }
  const key = endKey();
  if (endShownFor === key) return;
  endShownFor = key;
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('end_dismissed') === key; } catch { /* sin storage */ }
  if (dismissed) return;

  const winner = state.winnerId ? playerById(state.winnerId) : null;
  const theme = winner && config.themes.find(t => t.id === winner.themeId);
  $('end-token').replaceChildren(winner ? tokenOf(winner.skin, 'xl', winner.color) : '');
  $('end-title').textContent = winner ? `¡${winner.username} gana la partida!` : 'Partida terminada';
  $('end-title').style.color = winner ? winner.color : '';
  $('end-sub').textContent = winner
    ? (winner.id === myId ? '¡Felicidades, eres el último en pie!' : `Victoria para ${theme ? theme.name : 'su temática'}.`)
    : 'No quedó ningún jugador en pie.';

  const ranking = [...state.players].sort((x, y) =>
    (y.id === state.winnerId) - (x.id === state.winnerId) || (x.bankrupt - y.bankrupt) || (y.money - x.money));
  $('end-ranking').replaceChildren(...ranking.map((p, i) => el('li', { class: p.id === state.winnerId ? 'is-winner' : '', '--player-color': p.color },
    el('span', { class: 'rank' }, i === 0 && p.id === state.winnerId ? '🏆' : `${i + 1}.`),
    tokenOf(p.skin, 'sm', p.color),
    el('span', { class: 'rname' }, p.username, p.id === myId ? ' (tú)' : ''),
    el('span', { class: 'rmeta' }, p.bankrupt ? 'eliminado' : money(p.money))
  )));

  const close = () => {
    modal.hidden = true;
    try { sessionStorage.setItem('end_dismissed', key); } catch { /* sin storage */ }
  };
  const actions = [
    el('a', { class: 'btn btn-ghost', href: 'lobby.html' }, 'Volver al lobby'),
    el('button', { class: 'btn btn-secondary', type: 'button', onclick: close }, 'Ver tablero')
  ];
  if (state.hostId === myId) actions.push(el('button', { class: 'btn btn-success', type: 'button', onclick: () => { close(); act('restart'); } }, 'Nueva partida'));
  $('end-actions').replaceChildren(...actions);

  modal.hidden = false;
  closeTradeWindow();
  if (winner) setTimeout(() => Sound.play('win', winner.themeId), 300);
}

// ── Botón de sonido ──────────────────────────────────────────────────────────
function syncSoundBtn() {
  const b = $('sound-btn');
  const on = !Sound.isMuted();
  b.textContent = on ? '🔊' : '🔇';
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Silenciar sonidos' : 'Activar sonidos';
}
$('sound-btn').addEventListener('click', () => { Sound.setMuted(!Sound.isMuted()); syncSoundBtn(); });
syncSoundBtn();

// ── Registro ─────────────────────────────────────────────────────────────────
function renderLog() {
  $('log').replaceChildren(...state.log.map(l => el('li', {}, l.text)));
}

// ── Sala de espera ───────────────────────────────────────────────────────────
function renderWaitingRoom() {
  const mine = me();
  if (mine && !selectedTheme) { selectedTheme = mine.themeId; selectedSkin = mine.skin.id; }

  $('theme-grid').replaceChildren(...config.themes.map(t => {
    const m = memberById(t.memberId);
    const color = WORLD_COLOR[t.memberId] || m.color;
    const free = t.skins.filter(isUnlocked).length;
    return el('button', {
      type: 'button',
      class: 'theme-card',
      'aria-pressed': String(selectedTheme === t.id),
      '--member-color': color,
      onclick: () => {
        if (selectedTheme !== t.id) selectedSkin = (t.skins.find(s => s.starter) || t.skins[0]).id;
        selectedTheme = t.id;
        render();
      }
    },
      el('span', { class: 'theme-member' }, `${m.world} · ${m.name}`),
      el('strong', {}, t.name),
      el('span', { class: 'small text-muted' }, t.description),
      el('span', { class: 'theme-tokens' }, t.skins.map(s => {
        const n = tokenOf(s, 'sm', isUnlocked(s) ? color : '#4a4356');
        if (!isUnlocked(s)) n.classList.add('locked');
        return n;
      })),
      el('span', { class: 'small' }, `${free}/${t.skins.length} fichas desbloqueadas`)
    );
  }));

  // Fichas de la temática elegida (las bloqueadas muestran su misión)
  const theme = config.themes.find(t => t.id === selectedTheme);
  $('skins-title').hidden = !theme;
  $('skin-grid').replaceChildren(...(theme ? theme.skins.map(s => {
    const ok = isUnlocked(s);
    const color = WORLD_COLOR[theme.memberId];
    const have = s.unlock && progress ? Math.min(Number(progress[s.unlock.stat] || 0), s.unlock.count) : 0;
    const node = tokenOf(s, 'xl', ok ? color : '#4a4356');
    if (!ok) node.classList.add('locked');
    return el('button', {
      type: 'button',
      class: 'skin-option',
      disabled: !ok,
      'aria-pressed': String(selectedSkin === s.id),
      onclick: () => { selectedSkin = s.id; render(); }
    },
      node,
      el('span', { class: 'sname' }, s.name, ok ? '' : ' 🔒'),
      el('span', { class: 'smission' }, s.starter ? 'Ficha inicial' : ok ? 'Desbloqueada' : `${s.unlock.text} (${have}/${s.unlock.count})`)
    );
  }) : []));

  const join = $('join-btn');
  const unchanged = mine && mine.themeId === selectedTheme && mine.skin.id === selectedSkin;
  join.disabled = !selectedTheme || !selectedSkin || unchanged;
  join.textContent = mine ? 'Cambiar temática / ficha' : 'Unirme a la partida';
  $('leave-btn').hidden = !mine;
  const start = $('start-btn');
  start.hidden = !(mine && state.hostId === myId);
  start.disabled = state.players.length < config.economy.minPlayers;
  start.textContent = state.players.length < config.economy.minPlayers
    ? `Iniciar (mínimo ${config.economy.minPlayers} jugadores)` : 'Iniciar partida';

  $('waiting-title').textContent = `${state.room ? state.room.name : 'Sala'} — sala de espera`;
  $('waiting-count').textContent = `${state.players.length}/${config.economy.maxPlayers} · mínimo ${config.economy.minPlayers}`;
  $('waiting-list').replaceChildren(...(state.players.length
    ? state.players.map(p => {
      const theme = config.themes.find(t => t.id === p.themeId);
      return el('li', {},
        tokenOf(p.skin, '', p.color),
        el('strong', {}, p.username), p.id === myId ? ' (tú)' : '',
        el('span', { class: 'text-muted small' }, ` · ${p.skin.name} · ${theme ? theme.name : ''}`, p.id === state.hostId ? ' · anfitrión 👑' : '')
      );
    })
    : [el('li', { class: 'text-muted' }, 'Nadie se ha unido todavía. ¡Sé el primero!')]));
}

// ── Render principal ─────────────────────────────────────────────────────────
function render() {
  if (!config || !state) return;
  const lobby = state.phase === 'lobby';
  $('waiting-room').hidden = !lobby;
  $('game-area').hidden = lobby;
  renderPlayers();
  if (lobby) return renderWaitingRoom();
  renderBoard();
  renderCenter();
  renderSpaceDetail();
  renderMyProps();
  renderTrade();
  renderLog();
  processEvents();
  updateTimers();
  renderEndModal();
}

$('join-btn').addEventListener('click', () => act('join', { themeId: selectedTheme, skinId: selectedSkin }));
$('leave-btn').addEventListener('click', () => { selectedTheme = null; selectedSkin = null; act('leave'); });
$('start-btn').addEventListener('click', () => act('start'));

// ── Conexión (Taller 6: GET /coordinator → WS; reconexión a otro coordinador) ─
$('me-name').textContent = currentUsername;
$('room-name').textContent = ROOM_ID;

async function loadProgress() {
  try { progress = await Net.fetchProgress(originalToken); } catch { progress = null; }
  checkAchievements();
  render();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = String(msg.you.userId);
      if (msg.coordinator) $('coord-id').textContent = msg.coordinator.coordinatorId;
      break;
    case 'game_config':
      config = msg.data;
      checkAchievements();
      buildBoard();
      render();
      break;
    case 'game_state':
      state = msg.data;
      if (state.serverNow) clockOffset = state.serverNow - Date.now();
      // Si estábamos en la sala de espera y se cayó nuestro coordinador, el
      // asiento se liberó: al reconectar volvemos a unirnos con la misma ficha.
      if (state.phase === 'lobby') {
        const mine = me();
        if (mine) lastSeat = { themeId: mine.themeId, skinId: mine.skin.id };
        else if (lastSeat && Date.now() < recoverUntil && rejoinTried !== state.version) {
          rejoinTried = state.version;
          act('join', lastSeat);
        }
      }
      if (state.room) {
        $('room-name').textContent = state.room.name;
        $('center-room').textContent = state.room.name;
        document.title = `Cuatro Mundos — ${state.room.name}`;
      }
      render();
      break;
    case 'game_error':
      toast(msg.data.message);
      break;
    case 'progress_changed':
      loadProgress();
      break;
    case 'auth_challenge':
      conn.send({ type: 'auth_response', data: { token: localStorage.getItem('token') } });
      break;
  }
}

function connect() {
  conn = Net.connectCoordinator({
    token: originalToken,
    params: { view: 'board', room: ROOM_ID },
    onStatus(stateName, text, info) {
      setConn(stateName, stateName === 'connected' && info ? `Conectado a ${info.coordinatorId}` : text);
      if (info) $('coord-id').textContent = stateName === 'connected' ? info.coordinatorId : '—';
    },
    onOpen() {
      $('lost-banner').hidden = true;
    },
    onLost(info) {
      if (leaving) return;
      recoverUntil = Date.now() + 15000;
      const b = $('lost-banner');
      b.hidden = false;
      b.textContent = `Se perdió la conexión con ${info.coordinatorId}. Tu partida sigue en los demás coordinadores: pidiendo uno nuevo al auth-service…`;
    },
    onMessage,
    onFatal(code) {
      if (leaving) return;
      if (code === 4004) { leaving = true; window.location.replace('lobby.html'); return; }
      Net.goToLogin(Net.FATAL_MESSAGES[code] || 'La sesión terminó.', code === 4002);
    }
  });

  // Detección local de manipulación del token
  const poll = setInterval(() => {
    if (localStorage.getItem('token') !== originalToken) {
      clearInterval(poll);
      leaving = true;
      conn.close(1000, 'token tampered client-side');
      Net.goToLogin('Sesión cerrada: se detectó una modificación no autorizada del token de sesión.');
    }
  }, 2000);
}

// Al volver al lobby se cierra la conexión sin intentar reconectar
window.addEventListener('pagehide', () => { leaving = true; if (conn) conn.close(1000, 'leaving page'); });

if (!originalToken) {
  Net.goToLogin('Debes iniciar sesión para acceder al tablero.');
} else {
  connect();
  loadProgress();
}

// Para la demo de autoridad: `state` es local. Modificarlo desde DevTools solo
// cambia esta pantalla; el próximo game_state del servidor lo sobrescribe.
window.getGameState = () => state;
