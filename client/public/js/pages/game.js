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
const PARAMS          = new URLSearchParams(location.search);
const ROOM_ID         = PARAMS.get('sala');
// Coordinador anfitrión de la sala: el cliente se cambia a él al entrar.
const ROOM_HOST       = PARAMS.get('coord');
// Modo espectador: ?espectador=1. Se conecta SIN token (anónimo, solo lectura).
const SPECTATOR       = PARAMS.get('espectador') === '1';

let conn = null;            // conexión con el coordinador (net.js)
let config = null;          // tablero, temáticas, economía (estático)
let state = null;           // estado de la partida de ESTA sala (lo manda el servidor)
let myId = null;
let progress = null;        // progreso del usuario: { stats, themes, prefs }
let selectedTheme = null;
let selectedSkin = null;
let selectedColor = null;
let selectedDice = null;
let selectedSpace = null;
let lastRollT = 0;
let lastCardSeq = 0;
let leaving = false;
let recoverUntil = 0;       // ventana tras perder el coordinador para recuperar el asiento
let rejoinTried = -1;       // versión del estado en la que ya se intentó volver a unirse
let lastSeat = null;        // temática/ficha con la que estábamos en la sala de espera
let tradeDraft = emptyDraft();

const WORLD_COLOR = { david: 'var(--galaxy)', jossef: 'var(--fantasy)', sebastian: 'var(--viking)', santiago: 'var(--letters)' };

// Utilidades de DOM compartidas (js/lib/dom.js) e iconos SVG (js/lib/icons.js)
const { $, el } = Dom;
const icon = (name, cls) => Icons.svg(name, cls);
const clean = Icons.clean;
// Botón con icono + texto (el icono refuerza la acción, el texto la nombra)
const ibtn = (name, label, attrs = {}) => el('button', { type: 'button', ...attrs }, icon(name), el('span', {}, label));

// Iconos fijos del HTML
(function paintStaticIcons() {
  for (const a of document.querySelectorAll('[data-icon]')) a.prepend(icon(a.dataset.icon));
  $('zoom-in').append(icon('plus'));
  $('zoom-out').append(icon('minus'));
  $('zoom-fit').append(icon('fit'));
  $('view-3d').append(icon('cube'), el('span', {}, '3D'));
  $('table-toggle').append(icon('chevron'));
  $('trade-win-close').append(icon('close'));
  document.querySelector('.float-win-grip').append(icon('grip'));
  $('trade-btn').prepend(icon('trade'));
})();

function money(n) {
  const sym = config ? config.economy.currency.symbol : '¤';
  return `${sym}${Number(n).toLocaleString('es-CO')}`;
}

let toastTimer = null;
function toast(text, kind = 'error', ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast ${kind === 'info' ? 'info' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function act(action, data = {}) {
  if (SPECTATOR) return toast('Modo espectador: no puedes jugar.');
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

// Desbloqueos (misma regla que valida el coordinador: por grupo y en orden)
function themeOfSkin(skin) {
  return config.themes.find(t => t.skins.some(s => s.id === skin.id)) || null;
}
function isUnlocked(skin, prog = progress) {
  if (skin.starter || !skin.unlock) return true;
  const theme = themeOfSkin(skin);
  return !!theme && Collection.skinUnlocked(theme, theme.skins.find(s => s.id === skin.id), prog);
}
function isDiceUnlocked(diceId, prog = progress) {
  return Collection.diceUnlocked(config, diceId, prog);
}

// ── Consultas sobre el estado ────────────────────────────────────────────────
const me = () => state && myId && state.players.find(p => p.id === myId);
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

// Renta que cobra AHORA una casilla con dueño (lo mismo que calcula el servidor).
//   → { row, value, text } · row identifica la fila de la tabla de rentas activa
function currentRent(s) {
  const prop = state.properties[s.id];
  if (!prop || !prop.ownerId) return null;
  if (prop.mortgaged) return { row: 'mortgaged', value: 0, text: 'Hipotecada' };
  const e = config.economy;
  if (s.type === 'property') {
    if (prop.level > 0) return { row: `l${prop.level}`, value: s.rents[prop.level], text: money(s.rents[prop.level]) };
    const full = groupSpaces(s.group).every(g => state.properties[g.id].ownerId === prop.ownerId);
    const v = s.rents[0] * (full ? (e.groupRentMultiplier || 2) : 1);
    return { row: full ? 'full' : 'l0', value: v, text: money(v) };
  }
  const n = config.spaces.filter(x => x.type === s.type && state.properties[x.id] && state.properties[x.id].ownerId === prop.ownerId).length;
  if (s.type === 'transport') {
    const v = e.transportRents[n - 1];
    return { row: `n${n}`, value: v, text: money(v) };
  }
  if (s.type === 'service') {
    const m = e.serviceMultipliers[n - 1];
    return { row: `n${n}`, value: null, text: `dados × ${m}` };
  }
  return null;
}

// ── Tablero ──────────────────────────────────────────────────────────────────
function gridPos(i) {
  if (i <= 10) return { row: 11, col: 11 - i };
  if (i <= 20) return { row: 11 - (i - 10), col: 1 };
  if (i <= 30) return { row: 1, col: 1 + (i - 20) };
  return { row: 1 + (i - 30), col: 11 };
}

// Icono SVG por tipo de casilla (las propiedades se reconocen por su franja de color)
const SPACE_ICONS = {
  start: 'flag', jail: 'bars', rest: 'cup', go_to_jail: 'gavel',
  card_general: 'card', card_special: 'star', donation: 'heart', transport: 'train', service: 'bolt'
};

// Qué hace cada esquina (se muestra bajo su nombre en el tablero)
const CORNER_SUB = {
  start: (cfg) => `Cobra ${money(cfg.economy.salary)}`,
  jail: () => 'De visita / preso',
  rest: () => 'Cobra el Fondo',
  go_to_jail: () => 'Directo al calabozo'
};
// Etiqueta corta de las tarjetas en el tablero
const CARD_SUB = { card_general: 'Mazo General', card_special: 'Mazo Especial' };

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
    cell.classList.toggle('auctioning', !!(state.auction && state.auction.current === s.id));
    cell.classList.toggle('is-card', s.type === 'card_general' || s.type === 'card_special');
    cell.classList.toggle('card-general', s.type === 'card_general');
    cell.classList.toggle('card-special', s.type === 'card_special');
    if (owner) cell.style.setProperty('--owner-color', owner.color);

    const parts = [];
    if (s.type === 'property') {
      parts.push(el('div', { class: 'strip', '--group-color': config.groups[s.group].color }));
    } else if (SPACE_ICONS[s.type]) {
      parts.push(el('div', { class: `sicon sicon-${s.type}` }, icon(SPACE_ICONS[s.type])));
    }
    parts.push(el('div', { class: 'name' }, clean(s.name)));
    if (corner && CORNER_SUB[s.type]) parts.push(el('div', { class: 'corner-sub' }, CORNER_SUB[s.type](config)));
    if (CARD_SUB[s.type]) parts.push(el('div', { class: 'card-sub' }, CARD_SUB[s.type]));

    if (prop && prop.level > 0) {
      const b = el('div', { class: 'buildings' });
      if (prop.level === 5) b.append(el('span', { class: 'hotel' }));
      else for (let i = 0; i < prop.level; i++) b.append(el('span', { class: 'house' }));
      parts.push(b);
    }

    if (s.price && !owner && !corner) parts.push(el('div', { class: 'price' }, money(s.price)));
    else if (owner) {
      // Con dueño: se resalta la renta que se cobra ahora mismo
      const r = currentRent(s);
      if (r) parts.push(el('div', { class: `rent-tag ${r.row === 'mortgaged' ? 'off' : ''}`, title: `Renta actual de ${s.name}` },
        r.row === 'mortgaged' ? 'Sin renta' : r.text));
    } else if (s.type === 'donation') parts.push(el('div', { class: 'price' }, money(s.amount)));

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
      // .ptoken se desplaza; .ptoken-stand la pone de pie en la vista 3D
      const wrap = el('div', { class: 'ptoken fresh', '--tc': p.color }, el('div', { class: 'ptoken-stand' }, art));
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

// ── Tablero expansivo: zoom con la rueda y desplazamiento arrastrando ────────
// El tablero (#board) mide lo mismo que el área visible (rectangular, se ajusta
// a la ventana) con un mínimo para que las casillas se lean. #board-stage se
// escala y se traslada con transform: las fichas usan offsetLeft/Top dentro
// del tablero, así que no se ven afectadas por el zoom.
const BoardView = (() => {
  const MIN_W = 1000, MIN_H = 640, MAX_ZOOM = 3.5;
  const vp = $('board-viewport');
  const stage = $('board-stage');
  let W = 0, H = 0, scale = 1, tx = 0, ty = 0, fitScale = 1;
  let drag = null, justPanned = false;

  function clamp() {
    const vw = vp.clientWidth, vh = vp.clientHeight;
    const sw = W * scale, sh = H * scale;
    const margin = 80;
    // Si cabe, se centra; si no, no se deja salir más allá de un margen
    tx = sw <= vw ? (vw - sw) / 2 : Math.min(margin, Math.max(vw - sw - margin, tx));
    ty = sh <= vh ? (vh - sh) / 2 : Math.min(margin, Math.max(vh - sh - margin, ty));
  }

  // Nitidez: mientras se hace zoom o se arrastra, el escenario va en su propia
  // capa (fluido); al soltar se quita `will-change` para que el navegador lo
  // vuelva a dibujar a la escala real. Con la capa fija el texto se veía
  // pixelado al acercar, porque se estiraba la imagen dibujada al 100 %.
  let settleTimer = null;
  function moving() {
    stage.classList.add('moving');
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => stage.classList.remove('moving'), 180);
  }

  function apply() {
    clamp();
    moving();
    // Posiciones enteras: evita el desenfoque de medio píxel
    stage.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px) scale(${scale})`;
    $('zoom-level').textContent = `${Math.round((scale / fitScale) * 100)}%`;
    vp.classList.toggle('zoomed', scale > fitScale * 1.01);
  }

  // Vista 3D (tablero inclinado, fichas de pie) o plana. Se recuerda.
  let is3d = true;
  try { is3d = localStorage.getItem('board_3d') !== '0'; } catch { /* sin storage */ }
  function set3d(on) {
    is3d = on;
    vp.classList.toggle('is-3d', on);
    $('view-3d').setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('board_3d', on ? '1' : '0'); } catch { /* sin storage */ }
  }
  set3d(is3d);
  $('view-3d').addEventListener('click', () => set3d(!is3d));

  function resize() {
    const vw = vp.clientWidth, vh = vp.clientHeight;
    if (!vw || !vh) return;
    const prevFit = fitScale;
    const wasFit = Math.abs(scale - prevFit) < 0.001;
    // Misma proporción que el área visible (el tablero llena el rectángulo),
    // agrandada lo justo para respetar el tamaño mínimo legible.
    const k = Math.max(1, MIN_W / vw, MIN_H / vh);
    W = vw * k;
    H = vh * k;
    stage.style.width = `${W}px`;
    stage.style.height = `${H}px`;
    fitScale = Math.min(vw / W, vh / H);
    if (wasFit || scale < fitScale) scale = fitScale;
    apply();
    if (state && config && $('token-layer')) placeTokens();
  }

  function zoomAt(factor, cx, cy) {
    const next = Math.min(MAX_ZOOM, Math.max(fitScale, scale * factor));
    if (next === scale) return;
    // Mantener fijo el punto bajo el cursor
    tx = cx - (cx - tx) * (next / scale);
    ty = cy - (cy - ty) * (next / scale);
    scale = next;
    apply();
  }

  function fit() { resize(); scale = fitScale; apply(); }

  vp.addEventListener('wheel', (ev) => {
    if (ev.target.closest('.board-hud, .event-feed')) return;
    ev.preventDefault();
    const r = vp.getBoundingClientRect();
    zoomAt(Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015)), ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });

  vp.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (ev.target.closest('button, a, input, select, textarea, .board-hud')) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, tx, ty, moved: false };
  });
  vp.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; vp.setPointerCapture(ev.pointerId); vp.classList.add('panning'); }
    tx = drag.tx + dx;
    ty = drag.ty + dy;
    apply();
  });
  const endDrag = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (drag.moved) { justPanned = true; setTimeout(() => { justPanned = false; }, 0); }
    vp.classList.remove('panning');
    drag = null;
  };
  vp.addEventListener('pointerup', endDrag);
  vp.addEventListener('pointercancel', endDrag);
  // Un arrastre no debe seleccionar la casilla donde se soltó el mouse
  vp.addEventListener('click', (ev) => { if (justPanned) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  vp.addEventListener('dblclick', (ev) => { if (!ev.target.closest('button, .board-hud, .actions')) fit(); });

  const center = () => [vp.clientWidth / 2, vp.clientHeight / 2];
  $('zoom-in').addEventListener('click', () => zoomAt(1.3, ...center()));
  $('zoom-out').addEventListener('click', () => zoomAt(1 / 1.3, ...center()));
  $('zoom-fit').addEventListener('click', fit);
  window.addEventListener('keydown', (ev) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || $('game-area').hidden) return;
    if (ev.key === '+' || ev.key === '=') zoomAt(1.2, ...center());
    else if (ev.key === '-') zoomAt(1 / 1.2, ...center());
    else if (ev.key === '0') fit();
    else if (ev.key === 'v' || ev.key === 'V') set3d(!is3d);
  });
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(vp);
  window.addEventListener('resize', resize);

  return { fit, resize };
})();

// ── Centro: turno, dados y acciones ──────────────────────────────────────────
function renderCenter() {
  const info = $('turn-info');
  const actions = $('actions');
  actions.replaceChildren();

  if (state.phase === 'finished') {
    const w = state.winnerId && playerById(state.winnerId);
    info.replaceChildren(icon('trophy', 'ic-gold'), el('strong', {}, w ? `${w.username} gana la partida` : 'Partida terminada'));
    if (state.hostId === myId) actions.append(ibtn('counter', 'Nueva partida', { class: 'btn btn-cta', onclick: () => act('restart') }));
    renderDice(null, null);
    $('charge-now').hidden = true;
    renderPot();
    return;
  }

  const current = playerById(state.turn.playerId);
  const t = state.turn;
  const stageText = { roll: 'tira los dados', buy: 'decide si compra', debt: 'debe pagar', end: 'gestiona su turno' }[t.stage];
  info.replaceChildren(
    el('span', { class: 'turn-dot', '--player-color': current.color }),
    el('strong', { style: `color:${current.color}` }, current.id === myId ? 'Tu turno' : current.username),
    el('span', {}, current.id === myId ? '' : ` · ${stageText}`),
    current.connected ? '' : el('span', { class: 'turn-off' }, ' · desconectado')
  );

  renderDice(current, t.dice);
  const rollEntry = [...state.log].reverse().find(l => l.text.includes(' sacó '));
  if (rollEntry && rollEntry.t !== lastRollT) {
    lastRollT = rollEntry.t;
    for (const d of $('dice-row').querySelectorAll('.die')) {
      d.classList.remove('rolling'); void d.offsetWidth; d.classList.add('rolling');
    }
  }
  renderChargeNow(t);

  // Ley de Fitts y de Hick: una sola acción principal, grande y en el centro;
  // las secundarias, más pequeñas al lado.
  const mine = me();
  if (state.auction) {
    actions.append(el('span', { class: 'text-muted small' }, 'Subasta en curso: el turno se reanuda al terminar.'));
    if (mine && !mine.bankrupt) {
      actions.append(confirmButton('Rendirse', '¿Seguro? Confirmar rendición', 'btn btn-ghost btn-small', () => act('forfeit')));
    }
    renderPot();
    return;
  }
  if (!mine) {
    actions.append(el('span', { class: 'actions-note' }, icon('eye'), SPECTATOR ? 'Estás observando la partida' : 'Espectador'));
  } else if (isMyTurn()) {
    const e = config.economy;
    if (t.stage === 'roll') {
      if (mine.inJail) {
        actions.append(ibtn('dice', 'Intentar dobles', { class: 'btn btn-cta', onclick: () => act('roll') }));
        actions.append(ibtn('cash', `Pagar ${money(e.jailFine)}`, { class: 'btn btn-secondary', onclick: () => act('pay_jail'), disabled: mine.money < e.jailFine }));
        if (mine.jailCards > 0) actions.append(ibtn('key', 'Usar carta', { class: 'btn btn-secondary', onclick: () => act('use_jail_card') }));
      } else {
        actions.append(ibtn('dice', 'Tirar dados', { class: 'btn btn-cta', onclick: () => act('roll') }));
      }
    } else if (t.stage === 'buy') {
      const s = config.spaces[t.pendingBuy];
      actions.append(
        ibtn('tag', `Comprar ${money(s.price)}`, { class: 'btn btn-cta', onclick: () => act('buy'), disabled: mine.money < s.price }),
        ibtn('close', 'Pasar', { class: 'btn btn-secondary', onclick: () => act('decline') })
      );
      if (mine.money < s.price) actions.append(el('span', { class: 'actions-note warn' }, icon('info'), 'Hipoteca para completar'));
    } else if (t.stage === 'debt') {
      actions.append(
        el('span', { class: 'actions-note bad' }, icon('alert'), `Debes ${money(t.debt.total)}: vende o hipoteca`),
        confirmButton('Bancarrota', 'Confirmar bancarrota', 'btn btn-danger', () => act('bankrupt'))
      );
    } else if (t.stage === 'end') {
      actions.append(ibtn('check', 'Terminar turno', { class: 'btn btn-cta', onclick: () => act('end_turn') }));
    }
  } else if (!mine.bankrupt) {
    actions.append(el('span', { class: 'actions-note' }, icon('clock'), 'Esperando tu turno'));
  }

  if (mine && !mine.bankrupt) {
    const f = confirmButton('Rendirse', 'Confirmar', 'btn btn-quiet', () => act('forfeit'));
    f.prepend(icon('flag'));
    f.title = 'Abandonar la partida (pide confirmación)';
    actions.append(el('div', { class: 'actions-sub' }, f));
  }

  renderPot();
}

// Dados con la skin del jugador en turno (se reutilizan los nodos para que la
// animación de tirada no se corte)
function renderDice(player, dice) {
  const row = $('dice-row');
  const style = player && player.dice ? player.dice.style : (config.defaultDice && config.defaultDice.style);
  while (row.children.length < 2) row.append(Collection.dieNode(style, null));
  [...row.children].forEach((node, i) => {
    Collection.applyDiceStyle(node, style);
    const v = dice ? dice[i] : null;
    if (node.dataset.value !== String(v || '')) Collection.setDieValue(node, v);
  });
  row.title = player && player.dice ? `${player.dice.name} de ${player.username}` : '';
}

// Lo que se está cobrando AHORA en este turno (renta, impuesto, multa, compra
// o deuda), bien visible en el centro del tablero.
function renderChargeNow(t) {
  const box = $('charge-now');
  const current = playerById(t.playerId);
  let view = null;
  if (t.stage === 'debt' && t.debt) {
    view = { kind: 'debt', icon: 'alert', label: `${current.username} debe pagar`, amount: t.debt.total, sub: 'Vende o hipoteca para cubrirlo' };
  } else if (t.stage === 'buy' && t.pendingBuy !== null) {
    const s = config.spaces[t.pendingBuy];
    view = { kind: 'buy', icon: 'tag', label: `${s.name} está a la venta`, amount: s.price, sub: `Renta base ${money(s.rents ? s.rents[0] : 0)}` };
  } else {
    // Último cobro registrado desde que empezó este turno
    const start = state.log.map(l => l.text).lastIndexOf(`Turno de ${current.username}`);
    const since = start >= 0 ? state.log.slice(start + 1) : [];
    for (let i = since.length - 1; i >= 0 && !view; i--) {
      const text = since[i].text;
      let m;
      if ((m = /^(.+) debe pagar (\d+) de renta a (.+)$/.exec(text))) {
        view = { kind: 'rent', icon: 'cash', label: `${m[1]} paga renta a ${m[3]}`, amount: Number(m[2]), sub: 'Renta de este turno' };
      } else if ((m = /^(.+) pagó (\d+) y sale del calabozo$/.exec(text)) || (m = /^(.+) cumplió \d+ turnos y paga la multa de (\d+)$/.exec(text))) {
        view = { kind: 'fine', icon: 'bars', label: `${m[1]} paga la multa`, amount: Number(m[2]), sub: 'Calabozo' };
      } else if ((m = /^(.+) compró (.+) por (\d+)$/.exec(text))) {
        view = { kind: 'bought', icon: 'home', label: `${m[1]} compró ${m[2]}`, amount: Number(m[3]), sub: 'Pagado al banco' };
      }
    }
    if (!view) {
      const s = config.spaces[current.position];
      if (s && s.type === 'donation' && since.some(l => l.text === `${current.username} cae en ${s.name}`)) {
        view = { kind: 'fine', icon: 'heart', label: `${current.username} dona al Fondo`, amount: s.amount, sub: s.name };
      }
    }
  }
  box.hidden = !view;
  if (!view) return;
  box.dataset.kind = view.kind;
  box.style.setProperty('--player-color', current.color);
  box.replaceChildren(
    el('span', { class: 'charge-icon' }, icon(view.icon)),
    el('div', { class: 'charge-text' },
      el('div', { class: 'charge-label' }, view.label),
      el('div', { class: 'charge-amount' }, money(view.amount)),
      el('div', { class: 'charge-sub' }, view.sub))
  );
}

function renderPot() {
  const pot = $('pot');
  pot.title = 'Fondo de Donaciones: se lo lleva quien cae en Descanso';
  pot.replaceChildren(icon('coins'), el('span', {}, 'Fondo'), el('strong', {}, money(state.pot)));

  const c = state.lastCard;
  const box = $('last-card');
  if (!c) { box.hidden = true; return; }
  const who = playerById(c.playerId);
  const special = c.deck === 'special';
  box.hidden = false;
  box.dataset.deck = c.deck;
  box.replaceChildren(
    el('div', { class: 'card-deck' }, icon(c.deck === 'general' ? 'card' : 'star'), `${c.deck === 'general' ? 'General' : 'Especial'} · ${who ? who.username : ''}`),
    el('div', { class: 'card-title' }, clean(c.title)),
    el('div', {}, clean(c.text))
  );
  if (c.seq !== lastCardSeq) {
    if (lastCardSeq !== 0) toast(`${who ? who.username : ''}: ${clean(c.text)}`, 'info', 6000);
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
      `${owned} ${owned === 1 ? 'título' : 'títulos'}`,
      p.inJail ? 'en el calabozo' : '',
      p.jailCards ? `${p.jailCards} carta${p.jailCards > 1 ? 's' : ''} de salida` : ''
    ].filter(Boolean).join(' · ');
    return el('li', {
      class: `${state.turn && state.turn.playerId === p.id ? 'turn' : ''} ${p.bankrupt ? 'bankrupt' : ''}`,
      '--player-color': p.color
    },
      tokenOf(p.skin, '', p.color),
      el('div', { class: 'pname' },
        el('div', { class: 'pname-row', title: theme ? theme.name : '' }, p.username, p.id === myId ? el('span', { class: 'you' }, 'tú') : '',
          p.id === state.hostId ? el('span', { class: 'host', title: 'Anfitrión de la sala' }, icon('crown')) : ''),
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
  const active = currentRent(s);
  const row = (k, v, key) => rows.push(el('tr', { class: active && key && active.row === key ? 'rent-active' : '' },
    el('td', {}, k), el('td', {}, v, active && key && active.row === key ? el('span', { class: 'rent-now' }, 'ahora') : '')));

  if (s.price) row('Precio', money(s.price));
  if (s.type === 'property') {
    const g = config.groups[s.group];
    row('Grupo', g.name);
    row('Renta base', money(s.rents[0]), 'l0');
    row('Con grupo completo', money(s.rents[0] * (e.groupRentMultiplier || 2)), 'full');
    for (let i = 1; i <= 4; i++) row(`${i} casa${i > 1 ? 's' : ''}`, money(s.rents[i]), `l${i}`);
    row('Hotel', money(s.rents[5]), 'l5');
    row('Costo por construcción', money(s.houseCost));
  }
  if (s.type === 'transport') e.transportRents.forEach((r, i) => row(`Con ${i + 1} transporte${i ? 's' : ''}`, money(r), `n${i + 1}`));
  if (s.type === 'service') e.serviceMultipliers.forEach((m, i) => row(`Con ${i + 1} servicio${i ? 's' : ''}`, `dados × ${m}`, `n${i + 1}`));
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

// ── La mesa: títulos de propiedad ────────────────────────────────────────────
// Pestañas: "Mis títulos" (por defecto), cada rival y "Todos". Los títulos de
// un mismo grupo de color van juntos en una sola línea (ley de proximidad), y
// un título hipotecado se voltea y muestra el reverso, como en el juego físico.
let dealtCards = null;     // "spaceId:ownerId" ya mostradas (para animar las nuevas)
let flippedSeen = null;    // "spaceId:ownerId" que ya se mostraban hipotecadas
let tableView = 'me';      // 'me' | 'all' | id de un jugador
try { tableView = localStorage.getItem('table_view') || 'me'; } catch { /* sin storage */ }

function deedRows(s) {
  const e = config.economy;
  if (s.type === 'property') {
    return [
      ['l0', 'Renta', s.rents[0]],
      ['full', 'Grupo completo', s.rents[0] * (e.groupRentMultiplier || 2)],
      ['l1', '1 casa', s.rents[1]], ['l2', '2 casas', s.rents[2]], ['l3', '3 casas', s.rents[3]], ['l4', '4 casas', s.rents[4]],
      ['l5', 'Hotel', s.rents[5]]
    ].map(([k, label, v]) => [k, label, money(v)]);
  }
  if (s.type === 'transport') return e.transportRents.map((r, i) => [`n${i + 1}`, `${i + 1} transporte${i ? 's' : ''}`, money(r)]);
  if (s.type === 'service') return e.serviceMultipliers.map((m, i) => [`n${i + 1}`, `${i + 1} servicio${i ? 's' : ''}`, `dados × ${m}`]);
  return [];
}

function buildingsNode(level) {
  if (!level) return '';
  return el('div', { class: 'deed-build', title: level === 5 ? 'Hotel' : `${level} casa${level > 1 ? 's' : ''}` },
    level === 5 ? icon('hotel', 'b-hotel') : Array.from({ length: level }, () => icon('home', 'b-house')));
}

function deedCard(s, ownerId, isNew, flip) {
  const prop = state.properties[s.id];
  const member = s.memberId ? memberById(s.memberId) : null;
  const rent = currentRent(s);
  const color = s.type === 'property' ? config.groups[s.group].color : (member ? member.color : '#64748b');
  const kind = s.type === 'property' ? 'Título de propiedad' : s.type === 'transport' ? 'Transporte' : 'Servicio';
  const e = config.economy;
  const front = el('div', { class: 'deed-face deed-front' },
    el('div', { class: 'deed-head' },
      el('span', { class: 'deed-kind' }, kind),
      el('span', { class: 'deed-name' }, clean(s.name))),
    el('div', { class: 'deed-now' },
      el('span', {}, 'Cobra'),
      el('strong', {}, rent ? rent.text : '—')),
    el('table', { class: 'deed-rents' }, el('tbody', {}, deedRows(s).map(([k, label, v]) =>
      el('tr', { class: rent && rent.row === k ? 'on' : '' }, el('td', {}, label), el('td', {}, v))))),
    buildingsNode(prop.level),
    el('div', { class: 'deed-foot' }, member ? member.world : '', s.price ? ` · ${money(s.price)}` : ''));
  // Reverso: lo que se ve cuando está hipotecada
  const back = el('div', { class: 'deed-face deed-back' },
    el('div', { class: 'deed-back-band' }),
    el('span', { class: 'deed-back-icon' }, icon('bank')),
    el('strong', { class: 'deed-back-title' }, 'Hipotecada'),
    el('span', { class: 'deed-back-name' }, clean(s.name)),
    el('span', { class: 'deed-back-line' }, 'Recibió ', el('b', {}, money(Math.floor(s.price * e.mortgageRate)))),
    el('span', { class: 'deed-back-line' }, 'Levantar ', el('b', {}, money(unmortgageCost(s)))),
    el('span', { class: 'deed-back-foot' }, 'No cobra renta'));
  return el('button', {
    type: 'button',
    class: `deed deed-${member ? member.id : 'neutral'} ${prop.mortgaged ? 'mortgaged' : ''} ${flip || ''} ${isNew ? 'dealt' : ''} ${selectedSpace === s.id ? 'selected' : ''}`,
    '--group-color': color,
    title: `${clean(s.name)} · ${prop.mortgaged ? 'hipotecada' : `cobra ${rent ? rent.text : '—'}`}`,
    onclick: () => { selectedSpace = s.id; render(); }
  }, el('div', { class: 'deed-inner' }, front, back));
}

// Agrupa los títulos de un jugador: grupos de color en orden del tablero,
// luego transportes y servicios.
function deedSets(ownerId) {
  const props = ownedBy(ownerId);
  const sets = new Map();
  for (const s of props) {
    const key = s.type === 'property' ? `g${s.group}` : s.type;
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(s);
  }
  const order = (k) => k === 'transport' ? 1000 : k === 'service' ? 2000 : Number(k.slice(1));
  return [...sets.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([key, list]) => {
    list.sort((a, b) => a.id - b.id);
    if (key === 'transport' || key === 'service') {
      const total = config.spaces.filter(x => x.type === key).length;
      return { key, list, label: key === 'transport' ? 'Transportes' : 'Servicios', color: '#8a8fa3', have: list.length, total };
    }
    const g = config.groups[list[0].group];
    const total = groupSpaces(list[0].group).length;
    return { key, list, label: g.name, color: g.color, have: list.length, total };
  });
}

function renderSets(ownerId, seen, flipped) {
  const sets = deedSets(ownerId);
  if (!sets.length) return [el('div', { class: 'seat-empty' }, 'Sin títulos')];
  return sets.map(set => el('div', { class: `deed-set ${set.have === set.total ? 'complete' : ''}`, '--group-color': set.color },
    el('div', { class: 'set-head' },
      el('span', { class: 'set-swatch' }),
      el('span', { class: 'set-name' }, clean(set.label)),
      el('span', { class: 'set-count', title: set.have === set.total ? 'Grupo completo' : `${set.have} de ${set.total}` },
        set.have === set.total ? icon('check') : '', `${set.have}/${set.total}`)),
    el('div', { class: 'set-cards' }, set.list.map(s => {
      const key = `${s.id}:${ownerId}`;
      const mort = state.properties[s.id].mortgaged;
      seen.add(key);
      if (mort) flipped.add(key);
      // Animación de volteo solo cuando cambia el estado de hipoteca
      const flip = flippedSeen === null ? '' : mort && !flippedSeen.has(key) ? 'flip-in' : !mort && flippedSeen.has(key) ? 'flip-out' : '';
      return deedCard(s, ownerId, dealtCards !== null && !dealtCards.has(key), flip);
    }))));
}

function renderTableTabs() {
  const mine = me();
  const players = state.players.filter(p => !p.bankrupt || ownedBy(p.id).length);
  if (tableView === 'me' && !mine) tableView = 'all';
  if (tableView !== 'me' && tableView !== 'all' && !players.some(p => p.id === tableView)) tableView = 'me';
  const tab = (id, label, extra = {}) => el('button', {
    type: 'button', role: 'tab', class: 'seg-btn', 'aria-selected': String(tableView === id), ...extra,
    onclick: () => { tableView = id; try { localStorage.setItem('table_view', id); } catch { /* sin storage */ } renderTableCards(); }
  }, ...label);
  const tabs = [];
  if (mine) tabs.push(tab('me', [icon('layers'), el('span', {}, 'Mis títulos'), el('b', {}, ownedBy(myId).length)]));
  for (const p of players.filter(p => p.id !== myId)) {
    tabs.push(tab(p.id, [el('span', { class: 'seg-dot' }), el('span', {}, p.username), el('b', {}, ownedBy(p.id).length)], { '--player-color': p.color }));
  }
  tabs.push(tab('all', [icon('users'), el('span', {}, 'Todos')]));
  $('table-tabs').replaceChildren(...tabs);
}

function renderTableCards() {
  renderTableTabs();
  const box = $('table-cards');
  const seen = new Set();
  const flipped = new Set();
  const players = state.players.filter(p => !p.bankrupt || ownedBy(p.id).length);
  // Se recorren todos (aunque no se vean) para que las animaciones de
  // "repartir" y "voltear" no se disparen al cambiar de pestaña.
  const byPlayer = new Map(players.map(p => [p.id, renderSets(p.id, seen, flipped)]));
  const ownerOf = tableView === 'me' ? myId : tableView;

  let content;
  if (tableView === 'all') {
    box.dataset.view = 'all';
    content = players.map(p => el('div', { class: `tseat ${p.id === myId ? 'is-me' : ''} ${state.turn && state.turn.playerId === p.id ? 'turn' : ''}`, '--player-color': p.color },
      el('div', { class: 'seat-head' },
        tokenOf(p.skin, 'sm', p.color),
        el('strong', {}, p.username),
        el('span', { class: 'seat-money' }, money(p.money)),
        el('span', { class: 'seat-count' }, `${ownedBy(p.id).length} títulos`)),
      el('div', { class: 'seat-sets' }, byPlayer.get(p.id))));
  } else {
    box.dataset.view = 'single';
    content = byPlayer.get(ownerOf) || [el('div', { class: 'seat-empty' }, 'Sin títulos')];
  }

  // Resumen de la vista actual (en una línea, sin explicaciones)
  const ids = tableView === 'all' ? players.map(p => p.id) : [ownerOf];
  const all = ids.flatMap(id => ownedBy(id));
  const mortgaged = all.filter(s => state.properties[s.id].mortgaged).length;
  const complete = ids.reduce((n, id) => n + deedSets(id).filter(x => x.key[0] === 'g' && x.have === x.total).length, 0);
  $('table-summary').replaceChildren(
    el('span', {}, el('b', {}, all.length), ' títulos'),
    complete ? el('span', { class: 'sum-ok' }, icon('check'), el('b', {}, complete), complete === 1 ? ' grupo completo' : ' grupos completos') : '',
    mortgaged ? el('span', { class: 'sum-warn' }, icon('bank'), el('b', {}, mortgaged), mortgaged === 1 ? ' hipotecada' : ' hipotecadas') : '');

  dealtCards = seen;
  flippedSeen = flipped;
  box.replaceChildren(...content);
}

// Mostrar u ocultar la mesa
$('table-toggle').addEventListener('click', () => {
  const wrap = $('table-wrap');
  const hidden = wrap.classList.toggle('collapsed');
  $('table-toggle').title = hidden ? 'Mostrar la mesa' : 'Ocultar la mesa';
  $('table-toggle').setAttribute('aria-expanded', String(!hidden));
  requestAnimationFrame(() => BoardView.fit());
});

// Alto de la mesa: se arrastra el borde superior (se recuerda)
(function tableResize() {
  const wrap = $('table-wrap');
  const handle = $('table-resize');
  const MIN = 150;
  const max = () => Math.max(MIN, Math.round(window.innerHeight * 0.6));
  const setH = (h) => {
    const v = Math.max(MIN, Math.min(max(), Math.round(h)));
    wrap.style.setProperty('--table-h', `${v}px`);
    return v;
  };
  try { const saved = Number(localStorage.getItem('table_h')); if (saved) setH(saved); } catch { /* sin storage */ }
  let drag = null;
  handle.addEventListener('pointerdown', (ev) => {
    drag = { y: ev.clientY, h: wrap.getBoundingClientRect().height };
    handle.setPointerCapture(ev.pointerId);
    wrap.classList.add('resizing');
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    setH(drag.h + (drag.y - ev.clientY));
    BoardView.resize();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    wrap.classList.remove('resizing');
    try { localStorage.setItem('table_h', String(Math.round(wrap.getBoundingClientRect().height))); } catch { /* sin storage */ }
    BoardView.fit();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { wrap.style.removeProperty('--table-h'); try { localStorage.removeItem('table_h'); } catch { /* sin storage */ } BoardView.fit(); });
})();

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
        btns.push(ibtn(prop.level === 4 ? 'hotel' : 'home', `${prop.level === 4 ? 'Hotel' : 'Casa'} −${money(s.houseCost)}`, { class: 'btn btn-success', disabled: !myTurn, onclick: () => act('build', { spaceId: s.id }) }));
      }
      if (prop.level > 0) {
        btns.push(ibtn('hammer', `Vender +${money(Math.floor(s.houseCost * e.buildingSellRate))}`, { class: 'btn btn-secondary', disabled: !myTurn, onclick: () => act('sell_building', { spaceId: s.id }) }));
      }
    }
    if (!prop.mortgaged && !(s.type === 'property' && groupHasBuildings(s.group))) {
      btns.push(ibtn('bank', `Hipotecar +${money(Math.floor(s.price * e.mortgageRate))}`, { class: 'btn btn-secondary', disabled: !myTurn, onclick: () => act('mortgage', { spaceId: s.id }) }));
    }
    if (prop.mortgaged && !inDebt) {
      btns.push(ibtn('unlock', `Levantar −${money(unmortgageCost(s))}`, { class: 'btn btn-secondary', disabled: !myTurn, onclick: () => act('unmortgage', { spaceId: s.id }) }));
    }
    const status = prop.mortgaged ? el('span', { class: 'prop-badge bad' }, 'Hipotecada')
      : prop.level ? el('span', { class: 'prop-badge' }, prop.level === 5 ? 'Hotel' : `${prop.level} casa${prop.level > 1 ? 's' : ''}`) : '';
    return el('div', { class: `prop-row ${prop.mortgaged ? 'is-mortgaged' : ''}`, '--group-color': s.type === 'property' ? config.groups[s.group].color : '#64748b' },
      el('div', { class: 'prop-name' }, el('span', {}, clean(s.name)), status),
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
  return el('span', { class: 'prop-chip', '--group-color': color }, clean(s.name));
}

function sideView(title, player, side) {
  const items = [];
  if (side.money) items.push(el('span', { class: 'money-chip' }, money(side.money)));
  for (const id of side.properties) items.push(propChip(id));
  if (side.jailCards) items.push(el('span', { class: 'prop-chip' }, icon('key'), `${side.jailCards} carta${side.jailCards > 1 ? 's' : ''} de salida`));
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

const toSet = (side) => ({ money: side.money || 0, properties: new Set(side.properties || []), jailCards: side.jailCards || 0 });
const sidePayload = (s) => ({ money: s.money, properties: [...s.properties], jailCards: s.jailCards });

// Empieza una contraoferta: parte de la oferta recibida con los lados invertidos
// (lo que me piden pasa a ser lo que ofrezco y viceversa) para ajustarla.
function startCounter(t) {
  tradeDraft = { toId: t.fromId, counterOf: t.id, offer: toSet(t.request), request: toSet(t.offer) };
  tradeWin.mode = 'counter';
  buildTradeWindow();
}

function buildTradeWindow() {
  const body = $('trade-win-body');
  const foot = $('trade-win-foot');
  const title = $('trade-win-title');
  const t = state.trade;

  if (tradeWin.mode === 'offer' && t) {
    const from = playerById(t.fromId), to = playerById(t.toId);
    tradeWin.tradeId = t.id;
    const isCounter = t.round > 0;
    title.textContent = t.toId === myId
      ? `${isCounter ? 'Contraoferta' : 'Oferta'} de ${from.username}`
      : `Tu ${isCounter ? 'contraoferta' : 'oferta'} a ${to.username}`;
    const actions = [];
    if (t.toId === myId) {
      actions.push(
        ibtn('close', 'Rechazar', { class: 'btn btn-quiet', onclick: () => act('trade_respond', { tradeId: t.id, accept: false }) }),
        ibtn('counter', 'Contraofertar', { class: 'btn btn-secondary', onclick: () => startCounter(t), title: 'Cambiar los términos y devolverla' }),
        ibtn('check', 'Aceptar', { class: 'btn btn-success', onclick: () => act('trade_respond', { tradeId: t.id, accept: true }) })
      );
    } else if (t.fromId === myId) {
      actions.push(
        el('span', { class: 'foot-note waiting-dots' }, `Esperando a ${to.username}`),
        ibtn('close', 'Cancelar oferta', { class: 'btn btn-quiet', onclick: () => act('trade_cancel', { tradeId: t.id }) })
      );
    }
    body.replaceChildren(
      isCounter ? el('div', { class: 'trade-round' }, icon('counter'), `Contraoferta ${t.round}`) : '',
      el('div', { class: 'trade-compare' },
        sideView('Entrega', from, t.offer),
        el('div', { class: 'trade-arrows' }, icon('trade')),
        sideView('Entrega', to, t.request)
      )
    );
    foot.replaceChildren(...actions);
    return;
  }

  // Modo proponer o contraofertar: formulario
  const counter = tradeWin.mode === 'counter';
  if (counter && (!t || t.toId !== myId)) { closeTradeWindow(); return; }
  title.textContent = counter ? `Contraoferta a ${playerById(t.fromId).username}` : 'Proponer intercambio';
  const mine = me();
  const others = state.players.filter(p => !p.bankrupt && p.id !== myId);
  if (counter) {
    if (tradeDraft.counterOf !== t.id) { startCounter(t); return; }
  } else if (!others.find(p => p.id === tradeDraft.toId) || tradeDraft.counterOf) {
    tradeDraft = { ...emptyDraft(), toId: others[0] ? others[0].id : '' };
  }
  const target = playerById(tradeDraft.toId);
  if (!mine || !target) { body.replaceChildren(el('p', { class: 'text-muted' }, 'No hay con quién intercambiar.')); foot.replaceChildren(); return; }

  const targets = counter
    ? el('div', { class: 'trade-targets' }, el('span', { class: 'trade-target', 'aria-pressed': 'true', '--player-color': target.color },
        tokenOf(target.skin, 'sm', target.color), el('span', {}, target.username), el('small', {}, money(target.money))))
    : el('div', { class: 'trade-targets', role: 'radiogroup', 'aria-label': 'Con quién' }, others.map(p =>
      el('button', {
        type: 'button', class: 'trade-target', 'aria-pressed': String(p.id === tradeDraft.toId), '--player-color': p.color,
        onclick: () => { tradeDraft = { ...emptyDraft(), toId: p.id }; buildTradeWindow(); }
      }, tokenOf(p.skin, 'sm', p.color), el('span', {}, p.username), el('small', {}, money(p.money)))
    ));

  const sendBtn = ibtn(counter ? 'counter' : 'send', counter ? 'Enviar contraoferta' : 'Enviar oferta', { class: 'btn btn-cta-sm' });
  const isEmpty = () => [tradeDraft.offer, tradeDraft.request].every(s => !s.money && !s.properties.size && !s.jailCards);
  const refreshSend = () => {
    sendBtn.disabled = isEmpty();
    sendBtn.title = sendBtn.disabled ? 'Añade algo a la oferta' : '';
  };

  const column = (heading, owner, side) => {
    const props = ownedBy(owner.id).filter(isTradeable);
    return el('div', { class: 'trade-col', '--player-color': owner.color },
      el('div', { class: 'trade-col-title' }, heading),
      el('label', { class: 'trade-money' }, el('span', {}, 'Dinero ', el('small', {}, `máx. ${money(owner.money)}`)),
        el('input', { type: 'number', min: 0, max: owner.money, step: 10, value: side.money, inputmode: 'numeric',
          oninput: (ev) => { side.money = Math.max(0, Math.min(owner.money, Math.floor(Number(ev.target.value) || 0))); refreshSend(); } })),
      owner.jailCards ? el('label', { class: 'trade-money' }, 'Cartas de salida',
        el('input', { type: 'number', min: 0, max: owner.jailCards, value: side.jailCards,
          oninput: (ev) => { side.jailCards = Math.max(0, Math.min(owner.jailCards, Math.floor(Number(ev.target.value) || 0))); refreshSend(); } })) : '',
      el('div', { class: 'checks' }, props.length
        ? props.map(s => el('label', { class: 'check-prop', '--group-color': s.type === 'property' ? config.groups[s.group].color : '#64748b' },
            el('input', { type: 'checkbox', checked: side.properties.has(s.id),
              onchange: (ev) => { if (ev.target.checked) side.properties.add(s.id); else side.properties.delete(s.id); refreshSend(); } }),
            el('span', {}, clean(s.name)),
            state.properties[s.id].mortgaged ? el('small', { class: 'check-mort' }, 'hipotecada') : ''))
        : el('span', { class: 'text-muted small' }, 'Nada intercambiable'))
    );
  };

  sendBtn.addEventListener('click', () => {
    if (isEmpty()) return;
    if (counter) {
      act('trade_counter', { tradeId: t.id, offer: sidePayload(tradeDraft.offer), request: sidePayload(tradeDraft.request) });
    } else {
      act('trade_propose', { toId: tradeDraft.toId, offer: sidePayload(tradeDraft.offer), request: sidePayload(tradeDraft.request) });
    }
    tradeDraft = emptyDraft();
    tradeWin.mode = 'offer';   // se mostrará la oferta enviada cuando llegue el estado
    sendBtn.disabled = true;
  });
  refreshSend();

  body.replaceChildren(
    counter ? '' : el('div', { class: 'trade-label' }, 'Con quién'),
    targets,
    el('div', { class: 'trade-cols' },
      column(counter ? 'Tú entregas' : 'Tú ofreces', mine, tradeDraft.offer),
      column(`Pides a ${target.username}`, target, tradeDraft.request))
  );
  // Las acciones van en el pie fijo: siempre visibles aunque el formulario
  // sea más alto que la ventana (antes quedaban fuera de la pantalla).
  foot.replaceChildren(
    counter
      ? ibtn('back', 'Volver a la oferta', { class: 'btn btn-quiet', onclick: () => { tradeDraft = emptyDraft(); tradeWin.mode = 'offer'; buildTradeWindow(); } })
      : ibtn('close', 'Cerrar', { class: 'btn btn-quiet', onclick: closeTradeWindow }),
    sendBtn
  );
}

// Botón de intercambio arriba a la izquierda del tablero
function renderTradeButton() {
  const btn = $('trade-btn');
  const hint = $('trade-hint');
  const t = state.phase === 'playing' ? state.trade : null;
  const mine = me();
  btn.hidden = !mine || mine.bankrupt || state.phase !== 'playing';
  btn.classList.remove('has-offer');
  const label = (text) => btn.replaceChildren(icon('trade'), el('span', {}, text));
  if (t) {
    const from = playerById(t.fromId), to = playerById(t.toId);
    const involved = t.fromId === myId || t.toId === myId;
    btn.disabled = !involved;
    label(t.toId === myId ? 'Tienes una oferta' : involved ? 'Ver mi oferta' : 'Intercambio en curso');
    if (t.toId === myId) btn.classList.add('has-offer');
    hint.textContent = `${from.username} y ${to.username}${t.round ? ` · ronda ${t.round + 1}` : ''}`;
    btn.onclick = () => openTradeWindow('offer');
  } else {
    const ok = canPropose();
    btn.disabled = !ok;
    label('Intercambiar');
    hint.textContent = ok ? '' : (state.phase === 'playing' ? 'En tu turno' : '');
    btn.onclick = () => openTradeWindow('propose');
  }
}

function renderTrade() {
  const t = state.phase === 'playing' ? state.trade : null;
  renderTradeButton();

  // Ventana flotante
  const involved = t && (t.fromId === myId || t.toId === myId);
  const editingCounter = tradeWin.open && tradeWin.mode === 'counter' && t && tradeDraft.counterOf === t.id;
  if (involved && !editingCounter && t.id !== tradeWin.dismissedTradeId && !(tradeWin.open && tradeWin.mode === 'offer' && tradeWin.tradeId === t.id)) {
    openTradeWindow('offer'); // llega una oferta nueva (o la acabo de enviar)
    return;
  }
  if (!tradeWin.open) return;
  if ((tradeWin.mode === 'offer' || tradeWin.mode === 'counter') && !t) { closeTradeWindow(); return; }
  if (tradeWin.mode === 'counter' && !editingCounter) { closeTradeWindow(); return; }
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
    if ((tradeWin.mode === 'offer' || tradeWin.mode === 'counter') && state && state.trade) tradeWin.dismissedTradeId = state.trade.id;
    if (tradeWin.mode === 'counter') tradeDraft = emptyDraft();
    closeTradeWindow();
  });
})();

// ── Eventos de la partida → sonidos (según la temática de quien actúa) ───────
let seenLog = null;   // claves de las entradas del registro ya procesadas
let clockOffset = 0;  // serverNow - Date.now() (para las cuentas regresivas)

const LOG_SOUNDS = [
  [/^🔨 Subasta de /, 'auction'],
  [/ ofrece \d+ por /, 'bid'],
  [/^🔨 ¡Vendida! /, 'sold'],
  [/ compró /, 'buy'],
  [/ construyó /, 'build'],
  [/ de renta a | pagó su deuda| paga la multa| pagó .* sale del calabozo/, 'pay'],
  [/ pasa por Salida| se lleva el Fondo/, 'collect'],
  [/ toma Tarjeta /, 'card'],
  [/ va al calabozo| dobles seguidos/, 'jail'],
  [/ aceptó el intercambio /, 'tradeOk'],
  [/ propone un intercambio a /, 'trade'],
  [/^Se acabó el tiempo de /, 'timeout'],
  [/ no se reconectó a tiempo| quebró| quedó eliminado| se rinde/, 'expel']
];

// Avisos grandes sobre el tablero. Cada regla: [regex, tipo, icono, (match) → texto]
const EVENT_RULES = [
  [/^(.+) debe pagar (\d+) de renta a (.+)$/, 'rent', 'cash', m => [`${m[1]} paga renta a ${m[3]}`, money(m[2])]],
  [/^(.+) compró (.+) por (\d+)$/, 'buy', 'home', m => [`${m[1]} compró ${m[2]}`, money(m[3])]],
  [/^(.+) construyó en (.+) \((.+)\)$/, 'build', 'hammer', m => [`${m[1]} construyó en ${m[2]}`, m[3]]],
  [/^(.+) pasa por Salida y cobra (\d+)$/, 'collect', 'flag', m => [`${m[1]} pasa por Salida`, `+${money(m[2])}`]],
  [/^(.+) se lleva el Fondo de Donaciones: (\d+)$/, 'collect', 'coins', m => [`${m[1]} se lleva el Fondo`, `+${money(m[2])}`]],
  [/^(.+) toma Tarjeta (General|Especial): (.+)$/, 'card', 'card', m => [`${m[1]} · Tarjeta ${m[2]}`, m[3]]],
  [/^(.+) va al calabozo$/, 'jail', 'bars', m => [`${m[1]} va al calabozo`, '']],
  [/^(.+) no tiene suficiente dinero: debe (\d+)/, 'debt', 'alert', m => [`${m[1]} no puede pagar`, `Debe ${money(m[2])}`]],
  [/^(.+) pagó su deuda de (\d+)$/, 'pay', 'check', m => [`${m[1]} pagó su deuda`, money(m[2])]],
  [/^(.+) hipotecó (.+) por (\d+)$/, 'mortgage', 'bank', m => [`${m[1]} hipotecó ${m[2]}`, `+${money(m[3])}`]],
  [/^(.+) aceptó el intercambio con (.+)$/, 'trade', 'deal', m => [`${m[1]} y ${m[2]} cerraron un intercambio`, '']],
  [/^(.+) hace una contraoferta a (.+)$/, 'trade', 'counter', m => [`${m[1]} contraoferta a ${m[2]}`, '']],
  [/^(.+) propone un intercambio a (.+)$/, 'trade', 'trade', m => [`${m[1]} propone un intercambio a ${m[2]}`, '']],
  [/^(.+) rechazó el intercambio$/, 'reject', 'close', m => [`${m[1]} rechazó el intercambio`, '']],
  [/^(.+) quebró: sus bienes pasan a (.+)$/, 'out', 'out', m => [`${m[1]} quebró`, `Sus bienes pasan a ${m[2]}`]],
  [/^(.+) quedó eliminado/, 'out', 'out', m => [`${m[1]} quedó eliminado`, '']],
  [/^(.+) se rinde$/, 'out', 'flag', m => [`${m[1]} se rinde`, '']]
];

function eventFor(text) {
  text = clean(text);
  for (const [re, kind, iconName, fmt] of EVENT_RULES) {
    const m = re.exec(text);
    if (m) { const [title, detail] = fmt(m); return { kind, icon: iconName, title, detail }; }
  }
  return null;
}

function showEvent(ev, player) {
  const feed = $('event-feed');
  const mine = player && player.id === myId;
  const node = el('div', { class: `event-card ev-${ev.kind} ${mine ? 'is-mine' : ''}`, '--player-color': player ? player.color : 'var(--gold)' },
    el('span', { class: 'event-icon' }, icon(ev.icon)),
    el('div', { class: 'event-text' },
      el('div', { class: 'event-title' }, ev.title),
      ev.detail ? el('div', { class: 'event-detail' }, ev.detail) : ''));
  feed.prepend(node);
  while (feed.children.length > 2) feed.lastChild.remove();
  setTimeout(() => { node.classList.add('leaving'); setTimeout(() => node.remove(), 450); }, ev.kind === 'rent' || ev.kind === 'debt' ? 5500 : 4200);
}

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
    const text = clean(entry.text);
    // Aviso visible (cuando la ficha termina de caminar, si se está moviendo)
    const ev = eventFor(text);
    if (ev) {
      const who = playerFromText(text);
      const anim = who && tokenAnim.get(who.id);
      const fire = () => showEvent(ev, who);
      if (anim && anim.busy) (anim.after = anim.after || []).push(fire);
      else fire();
    }
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
  const t = state.phase === 'playing' && !state.auction ? state.turn : null;
  updateAuctionClock();
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

// ── Logros: aviso cuando se desbloquea una ficha o un dado ───────────────────
// Durante la partida el progreso guardado se suma a las estadísticas de la
// partida en curso (las manda el coordinador en cada estado). Así el logro se
// avisa en el momento en que se consigue, no al final. El auth-service lo
// guarda cuando la partida termina.
function achievementKey() { return `unlocked_skins:${currentUsername}`; }
let lastStatsSig = null;
let matchAch = [];   // logros conseguidos en esta partida: [{ item, t }]

function matchKey() {
  const start = state && state.log.find(l => l.text.startsWith('¡Comienza la partida!'));
  return `match_ach:${ROOM_ID}:${start ? start.t : ''}`;
}

function liveProgress() {
  const mine = state && state.phase === 'playing' ? me() : null;
  if (!progress || !mine || !mine.stats) return progress;
  const scope = (progress.prefs && progress.prefs.unlockTheme) || mine.themeId;
  const themes = { ...(progress.themes || {}) };
  const add = { ...(themes[scope] || {}) };
  for (const [k, v] of Object.entries(mine.stats)) add[k] = (Number(add[k]) || 0) + (Number(v) || 0);
  themes[scope] = add;
  return { ...progress, themes };
}

function checkAchievements() {
  if (!config || !progress) return;
  const prog = liveProgress();
  const live = prog !== progress;
  const skins = config.themes.flatMap(t => t.skins.map(sk => ({ ...sk, themeId: t.id, themeName: t.name })));
  const dice = config.themes.flatMap(t => (t.dice || []).map(d => ({ ...d, themeId: t.id, themeName: t.name, isDice: true })));
  const unlocked = skins.filter(sk => !sk.starter && sk.unlock && isUnlocked(sk, prog))
    .concat(dice.filter(d => isDiceUnlocked(d.id, prog)));
  let known = null;
  try { known = JSON.parse(localStorage.getItem(achievementKey()) || 'null'); } catch { known = null; }
  const ids = unlocked.map(sk => sk.id);
  // Lo ya conocido se conserva: el progreso en vivo puede ir por delante del guardado
  const merged = Array.isArray(known) ? [...new Set([...known, ...ids])] : ids;
  try { localStorage.setItem(achievementKey(), JSON.stringify(live ? merged : ids)); } catch { /* sin storage */ }
  if (!Array.isArray(known)) return; // primera vez en este navegador: solo se guarda
  const fresh = unlocked.filter(sk => !known.includes(sk.id));
  fresh.forEach((sk, k) => setTimeout(() => showAchievement(sk, live), k * 1600));
  if (live && fresh.length) {
    matchAch.push(...fresh.map(item => ({ item, t: Date.now() })));
    try { sessionStorage.setItem(matchKey(), JSON.stringify(matchAch.map(a => ({ id: a.item.id, t: a.t })))); } catch { /* sin storage */ }
    renderMatchAchievements();
  }
}

// Se llama con cada estado: solo recalcula si cambiaron mis estadísticas
function checkLiveAchievements() {
  const mine = state && state.phase === 'playing' ? me() : null;
  if (!mine || !mine.stats || !progress) return;
  const sig = JSON.stringify(mine.stats);
  if (sig === lastStatsSig) return;
  const first = lastStatsSig === null;
  lastStatsSig = sig;
  if (first) restoreMatchAchievements();
  checkAchievements();
}

function restoreMatchAchievements() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(matchKey()) || '[]');
    const all = config.themes.flatMap(t => [...t.skins.map(sk => ({ ...sk, themeId: t.id, themeName: t.name })),
      ...(t.dice || []).map(d => ({ ...d, themeId: t.id, themeName: t.name, isDice: true }))]);
    matchAch = saved.map(a => ({ item: all.find(x => x.id === a.id), t: a.t })).filter(a => a.item);
  } catch { matchAch = []; }
  renderMatchAchievements();
}

function renderMatchAchievements() {
  const panel = $('match-ach-panel');
  panel.hidden = !matchAch.length;
  if (!matchAch.length) return;
  const RARITY_COLOR = { common: '#cbd5e1', rare: '#5b9bd5', epic: '#a78bfa', legendary: '#f2c14e' };
  $('match-ach').replaceChildren(...matchAch.map(({ item }) => {
    const color = RARITY_COLOR[item.rarity] || '#f2c14e';
    return el('li', { '--rarity-color': color },
      item.isDice ? Collection.dieNode(item.style, 6, 'die-xs') : tokenOf(item, 'sm', color),
      el('div', { class: 'ma-text' },
        el('strong', {}, clean(item.name)),
        el('span', {}, [item.isDice ? 'Dado' : 'Ficha', item.themeName].filter(Boolean).join(' · '))),
      el('span', { class: 'ma-state', title: 'Se guarda en tu cuenta al terminar la partida' }, icon('clock')));
  }));
}

function showAchievement(skin, live = false) {
  const rarity = (config.rarities && config.rarities[skin.rarity]) || null;
  const RARITY_COLOR = { common: '#cbd5e1', rare: '#5b9bd5', epic: '#a78bfa', legendary: '#f2c14e' };
  const color = RARITY_COLOR[skin.rarity] || '#f2c14e';
  const card = el('div', { class: 'achievement', role: 'status', '--rarity-color': color },
    el('div', { class: 'achievement-glow', 'aria-hidden': 'true' }),
    skin.isDice ? Collection.dieNode(skin.style, 6, 'die-ach') : tokenOf(skin, 'lg', color),
    el('div', { class: 'achievement-text' },
      el('div', { class: 'achievement-kicker' }, icon(skin.isDice ? 'dice' : 'medal'), skin.isDice ? 'Dado desbloqueado' : 'Logro desbloqueado'),
      el('div', { class: 'achievement-title' }, clean(skin.name)),
      el('div', { class: 'achievement-sub' },
        [rarity ? rarity.label : skin.rarity, skin.themeName].filter(Boolean).join(' · ')),
      live ? el('div', { class: 'achievement-sub' }, 'Se guarda al terminar la partida') : ''
    ),
    el('button', { class: 'achievement-close', type: 'button', 'aria-label': 'Cerrar', onclick: () => dismiss() }, icon('close'))
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
    el('span', { class: 'rank' }, i === 0 && p.id === state.winnerId ? icon('trophy') : `${i + 1}`),
    tokenOf(p.skin, 'sm', p.color),
    el('span', { class: 'rname' }, p.username, p.id === myId ? ' (tú)' : ''),
    el('span', { class: 'rmeta' }, p.bankrupt ? 'eliminado' : money(p.money))
  )));

  const close = () => {
    modal.hidden = true;
    try { sessionStorage.setItem('end_dismissed', key); } catch { /* sin storage */ }
  };
  const actions = [
    el('a', { class: 'btn btn-ghost', href: SPECTATOR ? 'spectate.html' : 'lobby.html' }, SPECTATOR ? 'Ver otras partidas' : 'Volver al lobby'),
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
  b.replaceChildren(icon(on ? 'sound' : 'mute'));
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Silenciar sonidos' : 'Activar sonidos';
}
$('sound-btn').addEventListener('click', () => { Sound.setMuted(!Sound.isMuted()); syncSoundBtn(); });
syncSoundBtn();

// ── Registro ─────────────────────────────────────────────────────────────────
function renderLog() {
  $('log').replaceChildren(...state.log.map(l => {
    const ev = eventFor(l.text);
    return el('li', { class: ev ? `log-${ev.kind}` : '' }, ev ? icon(ev.icon) : el('span', { class: 'log-dot' }), el('span', {}, clean(l.text)));
  }));
}

// ── Sala de espera ───────────────────────────────────────────────────────────
function renderWaitingRoom() {
  const mine = me();
  if (mine && !selectedTheme) {
    selectedTheme = mine.themeId; selectedSkin = mine.skin.id;
    selectedColor = mine.color; selectedDice = mine.dice ? mine.dice.id : config.defaultDice.id;
  }
  applySavedPrefs();

  $('theme-grid').replaceChildren(...config.themes.map(t => {
    const m = memberById(t.memberId);
    const color = WORLD_COLOR[t.memberId] || m.color;
    const free = t.skins.filter(s => isUnlocked(s)).length;
    const freeDice = t.dice.filter(d => isDiceUnlocked(d.id)).length;
    const unlocking = progress && progress.prefs && progress.prefs.unlockTheme === t.id;
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
      el('span', { class: 'theme-member' }, `${m.world} · ${m.name}`, unlocking ? el('span', { class: 'unlocking' }, icon('unlock'), 'liberando') : ''),
      el('strong', {}, t.name),
      el('span', { class: 'small text-muted' }, t.description),
      el('span', { class: 'theme-tokens' }, t.skins.map(s => {
        const n = tokenOf(s, 'sm', isUnlocked(s) ? color : '#4a4356');
        if (!isUnlocked(s)) n.classList.add('locked');
        return n;
      })),
      el('span', { class: 'small' }, `${free}/${t.skins.length} fichas · ${freeDice}/${t.dice.length} dados`)
    );
  }));

  // Fichas de la temática elegida (las bloqueadas muestran su misión)
  const theme = config.themes.find(t => t.id === selectedTheme);
  $('skins-title').hidden = !theme;
  $('skin-grid').replaceChildren(...(theme ? theme.skins.map((s, i) => {
    const ok = isUnlocked(s);
    const st = Collection.itemState(theme, theme.skins, i, progress);
    const color = WORLD_COLOR[theme.memberId];
    const have = s.unlock ? Math.min(Collection.statOf(progress, theme.id, s.unlock.stat), s.unlock.count) : 0;
    const node = tokenOf(s, 'xl', ok ? (selectedSkin === s.id && selectedColor ? selectedColor : color) : '#4a4356');
    if (!ok) node.classList.add('locked');
    return el('button', {
      type: 'button',
      class: 'skin-option',
      disabled: !ok,
      'aria-pressed': String(selectedSkin === s.id),
      onclick: () => { selectedSkin = s.id; render(); }
    },
      node,
      el('span', { class: 'sname' }, ok ? '' : icon('lock'), clean(s.name)),
      el('span', { class: 'smission' }, s.starter ? 'Ficha inicial'
        : ok ? 'Desbloqueada'
        : st === 'next' ? `${s.unlock.text} (${have}/${s.unlock.count})`
        : `Libera antes "${theme.skins[i - 1].name}"`)
    );
  }) : []));

  // Colores: no se pueden repetir dentro de la sala
  const taken = new Map(state.players.filter(p => p.id !== myId).map(p => [p.color.toLowerCase(), p.username]));
  if (mine && selectedColor && taken.has(selectedColor.toLowerCase())) selectedColor = mine.color;
  const palette = config.playerColors || [];
  const swatch = (c) => {
    const owner = taken.get(c.toLowerCase());
    return el('button', {
      type: 'button', class: 'color-swatch', role: 'radio', '--sw': c,
      'aria-checked': String((selectedColor || '').toLowerCase() === c.toLowerCase()),
      disabled: !!owner,
      title: owner ? `Lo usa ${owner}` : c,
      onclick: () => { selectedColor = c; render(); }
    });
  };
  const custom = el('label', { class: 'color-custom', title: 'Otro color' },
    el('input', { type: 'color', value: selectedColor || '#d9b45a',
      onchange: (ev) => { selectedColor = ev.target.value; render(); } }), 'Otro');
  $('color-grid').replaceChildren(...palette.map(swatch), custom);

  // Dados: el clásico y los de cada temática (cadena por grupo)
  const diceGroups = [{ label: 'Clásico', list: [config.defaultDice], theme: null }]
    .concat(config.themes.map(t => ({ label: t.name, list: t.dice, theme: t })));
  $('dice-grid').replaceChildren(...diceGroups.map(g => el('div', { class: 'dice-group' },
    el('div', { class: 'dice-group-title' }, g.label),
    el('div', { class: 'dice-options' }, g.list.map((d, i) => {
      const ok = isDiceUnlocked(d.id);
      const st = g.theme ? Collection.itemState(g.theme, g.theme.dice, i, progress) : 'unlocked';
      const have = d.unlock ? Math.min(Collection.statOf(progress, g.theme.id, d.unlock.stat), d.unlock.count) : 0;
      const face = Collection.dieNode(d.style, 5, 'die-sm');
      return el('button', {
        type: 'button', class: `dice-option ${ok ? '' : 'locked'}`, disabled: !ok,
        'aria-pressed': String(selectedDice === d.id),
        title: ok ? d.name : (st === 'next' ? `${d.unlock.text} (${have}/${d.unlock.count})` : `Libera antes "${g.theme.dice[i - 1].name}"`),
        onclick: () => { selectedDice = d.id; render(); }
      }, face, el('span', { class: 'dice-name' }, ok ? '' : icon('lock'), clean(d.name)),
        !ok ? el('span', { class: 'smission' }, st === 'next' ? `${d.unlock.text} (${have}/${d.unlock.count})` : 'Bloqueado') : '');
    }))
  )));

  const join = $('join-btn');
  const unchanged = mine && mine.themeId === selectedTheme && mine.skin.id === selectedSkin &&
    (mine.color || '').toLowerCase() === (selectedColor || '').toLowerCase() && (mine.dice ? mine.dice.id : '') === selectedDice;
  join.disabled = !selectedTheme || !selectedSkin || unchanged;
  join.textContent = mine ? 'Guardar cambios (temática / ficha / color / dado)' : 'Unirme a la partida';
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
        p.dice ? Collection.dieNode(p.dice.style, 6, 'die-xs') : '',
        el('strong', {}, p.username), p.id === myId ? ' (tú)' : '',
        el('span', { class: 'text-muted small' }, ` · ${p.skin.name} · ${theme ? theme.name : ''}${p.dice ? ` · ${p.dice.name}` : ''}`, ''), p.id === state.hostId ? el('span', { class: 'host', title: 'Anfitrión' }, icon('crown')) : ''
      );
    })
    : [el('li', { class: 'text-muted' }, 'Aún no hay jugadores')]));
}

// Preselección con lo guardado (auth-service o copia local): temática, ficha,
// color y dado de la última vez. Solo si están desbloqueados.
let prefsApplied = false;
function applySavedPrefs() {
  if (!config) return;
  const p = { ...Collection.Prefs.get(), ...((progress && progress.prefs) || {}) };
  if (!prefsApplied) {
    const theme = config.themes.find(t => t.id === p.themeId);
    if (!selectedTheme && theme) {
      selectedTheme = theme.id;
      const skin = theme.skins.find(s => s.id === p.skinId);
      selectedSkin = skin && isUnlocked(skin) ? skin.id : (theme.skins.find(s => s.starter) || theme.skins[0]).id;
    }
    if (!selectedColor && p.color) selectedColor = p.color;
    if (!selectedDice && p.diceId && isDiceUnlocked(p.diceId)) selectedDice = p.diceId;
    prefsApplied = !!progress;   // se reintenta cuando llega el progreso del auth
  }
  if (!selectedDice || !isDiceUnlocked(selectedDice)) selectedDice = config.defaultDice.id;
  if (selectedSkin && selectedTheme) {
    const theme = config.themes.find(t => t.id === selectedTheme);
    const skin = theme && theme.skins.find(s => s.id === selectedSkin);
    if (skin && !isUnlocked(skin) && progress) selectedSkin = (theme.skins.find(s => s.starter) || theme.skins[0]).id;
  }
}

function joinWithSelection() {
  const data = { themeId: selectedTheme, skinId: selectedSkin, diceId: selectedDice || config.defaultDice.id };
  if (selectedColor) data.color = selectedColor;
  act('join', data);
  // Se recuerda para la próxima partida (y tras cerrar sesión)
  Collection.Prefs.save(originalToken, { themeId: data.themeId, skinId: data.skinId, diceId: data.diceId, ...(data.color ? { color: data.color } : {}) });
}

// ── Render principal ─────────────────────────────────────────────────────────
function render() {
  if (!config || !state) return;
  const lobby = state.phase === 'lobby';
  const wasHidden = $('game-area').hidden;
  $('waiting-room').hidden = !lobby;
  $('game-area').hidden = lobby;
  document.body.classList.toggle('in-game', !lobby);
  renderPlayers();
  if (lobby) return renderWaitingRoom();
  if (wasHidden) requestAnimationFrame(() => BoardView.fit());
  renderBoard();
  renderAuction();
  renderCenter();
  renderSpaceDetail();
  renderMyProps();
  renderTableCards();
  renderTrade();
  renderLog();
  processEvents();
  checkLiveAchievements();
  updateTimers();
  renderEndModal();
}

$('join-btn').addEventListener('click', joinWithSelection);
$('leave-btn').addEventListener('click', () => { selectedTheme = null; selectedSkin = null; prefsApplied = false; act('leave'); });
$('start-btn').addEventListener('click', () => act('start'));

// ── Conexión (Taller 6: GET /coordinator → WS; reconexión a otro coordinador) ─
$('me-name').textContent = SPECTATOR ? 'Espectador' : currentUsername;
$('room-name').textContent = ROOM_ID;
if (SPECTATOR) {
  document.body.classList.add('is-spectator');
  $('spectator-badge').hidden = false;
  $('spectator-banner').hidden = false;
  $('back-link').href = 'spectate.html';
  $('back-link').textContent = '← Otras partidas';
  document.querySelector('.game-title').href = 'spectate.html';
}

// ── Chat de la sala ──────────────────────────────────────────────────────────
// Los espectadores leen pero no escriben (el servidor ignora su chat_send).
const chat = Chat.create($('chat-panel'), {
  title: '💬 Chat de la sala',
  myId: () => myId,
  canSend: !SPECTATOR,
  collapsible: true,
  readOnlyNote: '👁 Eres espectador: puedes leer el chat, pero no escribir.',
  send: (text) => !!conn && conn.send({ type: 'chat_send', data: { text } }),
  themeOf: (m) => {
    if (!state) return null;
    const p = m ? state.players.find(x => x.id === String(m.userId)) : me();
    return p ? p.themeId : null;
  }
});

// ── Subasta de los bienes de un jugador en bancarrota ────────────────────────
let auctionDraft = '';

function updateAuctionClock() {
  const a = state && state.phase === 'playing' ? state.auction : null;
  const clock = $('auction-clock');
  if (!a || !clock) return;
  const left = a.deadline - serverNow();
  clock.textContent = `${fmtClock(left)} para cerrar`;
  clock.dataset.level = left <= 5000 ? 'danger' : 'ok';
}

function renderAuction() {
  const box = $('auction');
  const a = state.phase === 'playing' ? state.auction : null;
  if (!a || a.current === null) { box.hidden = true; box.replaceChildren(); return; }

  const s = config.spaces[a.current];
  const leader = a.bidderId ? playerById(a.bidderId) : null;
  const mine = me();
  const iLead = !!mine && a.bidderId === myId;
  const iPassed = !!mine && a.passed.includes(myId);
  const canBid = !!mine && !mine.bankrupt && mine.connected && !iLead && !iPassed && mine.money >= a.minBid;

  const wasFocused = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  const base = a.bidderId ? a.bid : 0;
  const quick = [a.minBid, base + 50, base + 100, base + 200]
    .filter((v, i, arr) => arr.indexOf(v) === i && v >= a.minBid && (!mine || v <= mine.money));

  const controls = [];
  if (!mine) {
    controls.push(el('span', { class: 'small text-muted' }, '👁 Solo los jugadores pueden ofertar.'));
  } else if (mine.bankrupt) {
    controls.push(el('span', { class: 'small text-muted' }, 'Estás fuera de la partida.'));
  } else if (iLead) {
    controls.push(el('span', { class: 'small', style: 'color:#9fe3c2' }, '✔ Tienes la mejor oferta. Espera a que cierre.'));
  } else if (iPassed) {
    controls.push(el('span', { class: 'small text-muted' }, 'Pasaste en esta propiedad.'));
  } else if (!canBid) {
    controls.push(el('span', { class: 'small text-muted' }, `No te alcanza para la oferta mínima (${money(a.minBid)}).`));
    controls.push(el('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => act('auction_pass') }, 'Pasar'));
  } else {
    const input = el('input', {
      class: 'auction-input', type: 'number', min: a.minBid, max: mine.money, step: 10,
      placeholder: String(a.minBid), value: auctionDraft, 'aria-label': 'Tu oferta',
      oninput: (ev) => { auctionDraft = ev.target.value; },
      onkeydown: (ev) => { if (ev.key === 'Enter') bidFrom(input); }
    });
    const bidFrom = (inp) => {
      const v = Math.floor(Number(inp.value));
      if (!Number.isFinite(v) || v < a.minBid) return toast(`La oferta mínima es ${money(a.minBid)}`);
      auctionDraft = '';
      act('auction_bid', { amount: v });
    };
    controls.push(
      el('div', { class: 'auction-quick' }, quick.map(v =>
        el('button', { class: 'btn btn-small', type: 'button', onclick: () => { auctionDraft = ''; act('auction_bid', { amount: v }); } }, money(v)))),
      el('div', { class: 'auction-custom' }, input,
        el('button', { class: 'btn btn-success btn-small', type: 'button', onclick: () => bidFrom(input) }, 'Ofertar'),
        el('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => act('auction_pass') }, 'Pasar'))
    );
  }

  box.hidden = false;
  box.replaceChildren(
    el('div', { class: 'auction-kicker' }, `🔨 Subasta · bienes de ${a.fromName}`,
      a.total > 1 ? el('span', { class: 'auction-count' }, ` · ${a.total - a.remaining} de ${a.total}`) : ''),
    el('div', { class: 'auction-item' }, s.icon ? `${s.icon} ` : '', s.name),
    el('div', { class: 'auction-sub' }, `Valor de lista ${money(s.price)} · se adjudica al mejor postor`),
    el('div', { class: 'auction-bid' }, leader
      ? ['Mejor oferta: ', el('strong', { style: `color:${leader.color}` }, money(a.bid)), ` de ${leader.username}`]
      : ['Sin ofertas · mínima ', el('strong', {}, money(a.minBid))]),
    el('div', { class: 'auction-clock', id: 'auction-clock' }),
    el('div', { class: 'auction-controls' }, controls)
  );
  updateAuctionClock();
  if (wasFocused) { const i = box.querySelector('input'); if (i) i.focus(); }
}

async function loadProgress() {
  if (SPECTATOR) return;
  try {
    progress = await Net.fetchProgress(originalToken);
    if (progress && progress.prefs) Collection.Prefs.merge(progress.prefs);
  } catch { progress = null; }
  checkAchievements();
  render();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.you.userId == null ? null : String(msg.you.userId);
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
        if (mine) lastSeat = { themeId: mine.themeId, skinId: mine.skin.id, color: mine.color, diceId: mine.dice && mine.dice.id };
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
      toast(clean(msg.data.message));
      // Si el error era de un intercambio, la ventana vuelve a su estado real
      if (tradeWin.open && state) buildTradeWindow();
      break;
    case 'spectator_readonly':
      toast(msg.data.message, 'info');
      break;
    case 'chat_history':
      chat.setHistory(msg.data.messages, msg.data);
      break;
    case 'chat_message':
      chat.add(msg.data.msg, msg.data.late);
      break;
    case 'chat_error':
      chat.error(msg.data);
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
    token: SPECTATOR ? null : originalToken,
    params: { view: 'board', room: ROOM_ID },
    prefer: ROOM_HOST,
    onStatus(stateName, text, info) {
      setConn(stateName, stateName === 'connected' && info ? info.coordinatorId : text);
    },
    onOpen() {
      $('lost-banner').hidden = true;
      setTimeout(flushChatOutbox, 800);
    },
    onRedirect(from, to) {
      // La sala vive en otro coordinador: nos cambiamos a él automáticamente.
      recoverUntil = Date.now() + 15000;
      const b = $('lost-banner');
      b.hidden = false;
      b.textContent = `Esta sala la atiende ${to}. Cambiando de ${from} a ${to}…`;
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
      if (SPECTATOR) {   // el espectador no tiene sesión: nunca se le manda al login
        leaving = true;
        if (code === 4004) { window.location.replace('spectate.html'); return; }
        const b = $('lost-banner');
        b.hidden = false;
        b.textContent = Net.FATAL_MESSAGES[code] || 'Se cerró la conexión de espectador.';
        return;
      }
      if (code === 4004) { leaving = true; window.location.replace('lobby.html'); return; }
      Net.goToLogin(Net.FATAL_MESSAGES[code] || 'La sesión terminó.', code === 4002);
    }
  });

  if (SPECTATOR) return;
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

if (!ROOM_ID) {
  window.location.replace(SPECTATOR ? 'spectate.html' : 'lobby.html');
} else if (!SPECTATOR && !originalToken) {
  Net.goToLogin('Debes iniciar sesión para acceder al tablero.');
} else {
  connect();
  loadProgress();
}

// Para la demo de autoridad: `state` es local. Modificarlo desde DevTools solo
// cambia esta pantalla; el próximo game_state del servidor lo sobrescribe.
window.getGameState = () => state;

// El indicador del auth (lib/auth.js) va en el encabezado para no tapar la mesa
document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
  const b = document.getElementById('auth-badge');
  if (b) document.querySelector('.game-header-left').append(b);
}, 0));
