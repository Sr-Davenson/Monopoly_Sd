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

// Utilidades de DOM compartidas (js/lib/dom.js)
const { $, el } = Dom;

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

// Desbloqueos (misma regla que valida el coordinador: por grupo y en orden)
function themeOfSkin(skin) {
  return config.themes.find(t => t.skins.some(s => s.id === skin.id)) || null;
}
function isUnlocked(skin) {
  if (skin.starter || !skin.unlock) return true;
  const theme = themeOfSkin(skin);
  return !!theme && Collection.skinUnlocked(theme, theme.skins.find(s => s.id === skin.id), progress);
}
function isDiceUnlocked(diceId) {
  return Collection.diceUnlocked(config, diceId, progress);
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

  function apply() {
    clamp();
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    $('zoom-level').textContent = `${Math.round((scale / fitScale) * 100)}%`;
    vp.classList.toggle('zoomed', scale > fitScale * 1.01);
  }

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
    info.replaceChildren(el('strong', {}, w ? `🏆 ¡${w.username} gana la partida!` : 'Partida terminada'));
    if (state.hostId === myId) actions.append(el('button', { class: 'btn btn-success', onclick: () => act('restart') }, 'Nueva partida'));
    renderDice(null, null);
    $('charge-now').hidden = true;
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

  renderDice(current, t.dice);
  const rollEntry = [...state.log].reverse().find(l => l.text.includes(' sacó '));
  if (rollEntry && rollEntry.t !== lastRollT) {
    lastRollT = rollEntry.t;
    for (const d of $('dice-row').querySelectorAll('.die')) {
      d.classList.remove('rolling'); void d.offsetWidth; d.classList.add('rolling');
    }
  }
  renderChargeNow(t);

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
    view = { kind: 'debt', icon: '⚠', label: `${current.username} debe pagar`, amount: t.debt.total, sub: 'Vende construcciones, hipoteca o declárate en bancarrota' };
  } else if (t.stage === 'buy' && t.pendingBuy !== null) {
    const s = config.spaces[t.pendingBuy];
    view = { kind: 'buy', icon: '🏷', label: `${s.name} está a la venta`, amount: s.price, sub: `Renta base ${money(s.rents ? s.rents[0] : 0)}` };
  } else {
    // Último cobro registrado desde que empezó este turno
    const start = state.log.map(l => l.text).lastIndexOf(`Turno de ${current.username}`);
    const since = start >= 0 ? state.log.slice(start + 1) : [];
    for (let i = since.length - 1; i >= 0 && !view; i--) {
      const text = since[i].text;
      let m;
      if ((m = /^(.+) debe pagar (\d+) de renta a (.+)$/.exec(text))) {
        view = { kind: 'rent', icon: '💸', label: `${m[1]} paga renta a ${m[3]}`, amount: Number(m[2]), sub: 'Renta cobrada en este turno' };
      } else if ((m = /^(.+) pagó (\d+) y sale del calabozo$/.exec(text)) || (m = /^(.+) cumplió \d+ turnos y paga la multa de (\d+)$/.exec(text))) {
        view = { kind: 'fine', icon: '⛓', label: `${m[1]} paga la multa`, amount: Number(m[2]), sub: 'Calabozo' };
      } else if ((m = /^(.+) compró (.+) por (\d+)$/.exec(text))) {
        view = { kind: 'bought', icon: '🏠', label: `${m[1]} compró ${m[2]}`, amount: Number(m[3]), sub: 'Pagado al banco' };
      }
    }
    if (!view) {
      const s = config.spaces[current.position];
      if (s && s.type === 'donation' && since.some(l => l.text === `${current.username} cae en ${s.name}`)) {
        view = { kind: 'fine', icon: '♥', label: `${current.username} dona al Fondo`, amount: s.amount, sub: s.name };
      }
    }
  }
  box.hidden = !view;
  if (!view) return;
  box.dataset.kind = view.kind;
  box.style.setProperty('--player-color', current.color);
  box.replaceChildren(
    el('span', { class: 'charge-icon', 'aria-hidden': 'true' }, view.icon),
    el('div', { class: 'charge-text' },
      el('div', { class: 'charge-label' }, view.label),
      el('div', { class: 'charge-amount' }, money(view.amount)),
      el('div', { class: 'charge-sub' }, view.sub))
  );
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
  const active = currentRent(s);
  const row = (k, v, key) => rows.push(el('tr', { class: active && key && active.row === key ? 'rent-active' : '' },
    el('td', {}, k), el('td', {}, v, active && key && active.row === key ? el('span', { class: 'rent-now' }, ' ← se cobra') : '')));

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

// ── La mesa: títulos de propiedad de cada jugador ────────────────────────────
// Cada propiedad comprada aparece como una carta (al estilo de los títulos del
// Monopoly) con el estilo de la temática de su sección. La fila de renta que se
// cobra ahora va resaltada.
let dealtCards = null;   // "spaceId:ownerId" ya mostradas (para animar las nuevas)

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

function deedCard(s, isNew) {
  const prop = state.properties[s.id];
  const member = s.memberId ? memberById(s.memberId) : null;
  const rent = currentRent(s);
  const color = s.type === 'property' ? config.groups[s.group].color : (member ? member.color : '#64748b');
  const kind = s.type === 'property' ? 'Título de propiedad' : s.type === 'transport' ? 'Transporte' : 'Servicio';
  const card = el('button', {
    type: 'button',
    class: `deed deed-${member ? member.id : 'neutral'} ${prop.mortgaged ? 'mortgaged' : ''} ${isNew ? 'dealt' : ''} ${selectedSpace === s.id ? 'selected' : ''}`,
    '--group-color': color,
    title: `${s.name} — renta actual: ${rent ? rent.text : '—'}`,
    onclick: () => { selectedSpace = s.id; render(); }
  },
    el('div', { class: 'deed-head' },
      el('span', { class: 'deed-kind' }, kind),
      el('span', { class: 'deed-name' }, s.icon ? `${s.icon} ` : '', s.name)),
    el('div', { class: 'deed-now' },
      el('span', {}, prop.mortgaged ? 'Hipotecada' : 'Cobra ahora'),
      el('strong', {}, prop.mortgaged ? '—' : rent ? rent.text : '—')),
    el('table', { class: 'deed-rents' }, el('tbody', {}, deedRows(s).map(([k, label, v]) =>
      el('tr', { class: rent && rent.row === k ? 'on' : '' }, el('td', {}, label), el('td', {}, v))))),
    prop.level > 0 ? el('div', { class: 'deed-build' }, prop.level === 5 ? '🏨 Hotel' : '🏠'.repeat(prop.level)) : '',
    el('div', { class: 'deed-foot' }, member ? member.world : '', s.price ? ` · ${money(s.price)}` : '')
  );
  return card;
}

function renderTableCards() {
  const box = $('table-cards');
  const seen = new Set();
  const seats = state.players.filter(p => !p.bankrupt || ownedBy(p.id).length).map(p => {
    const rank = (s) => (s.type === 'property' ? 0 : s.type === 'transport' ? 100 : 200) + s.id;
    const props = ownedBy(p.id).sort((a, b) => rank(a) - rank(b));
    const cards = props.map(s => {
      const key = `${s.id}:${p.id}`;
      seen.add(key);
      return deedCard(s, dealtCards !== null && !dealtCards.has(key));
    });
    return el('div', { class: `tseat ${p.id === myId ? 'is-me' : ''} ${state.turn && state.turn.playerId === p.id ? 'turn' : ''}`, '--player-color': p.color },
      el('div', { class: 'seat-head' },
        tokenOf(p.skin, 'sm', p.color),
        el('strong', {}, p.username, p.id === myId ? ' (tú)' : ''),
        el('span', { class: 'seat-money' }, money(p.money)),
        el('span', { class: 'seat-count' }, `${props.length} título${props.length === 1 ? '' : 's'}`)),
      el('div', { class: 'seat-cards' }, cards.length ? cards : el('div', { class: 'seat-empty' }, 'Sin títulos todavía')));
  });
  dealtCards = seen;
  box.replaceChildren(...seats);
}

$('table-toggle').addEventListener('click', () => {
  const wrap = $('table-cards').parentElement;
  const hidden = wrap.classList.toggle('collapsed');
  $('table-toggle').textContent = hidden ? 'Mostrar' : 'Ocultar';
  $('table-toggle').setAttribute('aria-expanded', String(!hidden));
  requestAnimationFrame(() => BoardView.fit());
});

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
  const title = $('trade-win-title');
  const t = state.trade;

  if (tradeWin.mode === 'offer' && t) {
    const from = playerById(t.fromId), to = playerById(t.toId);
    tradeWin.tradeId = t.id;
    const isCounter = t.round > 0;
    title.textContent = t.toId === myId
      ? `${isCounter ? 'Contraoferta' : 'Oferta'} de ${from.username}`
      : `Tu ${isCounter ? 'contraoferta' : 'oferta'} a ${to.username}`;
    const actions = el('div', { class: 'trade-actions' });
    if (t.toId === myId) {
      actions.append(
        el('button', { class: 'btn btn-success', onclick: () => act('trade_respond', { tradeId: t.id, accept: true }) }, '✔ Aceptar'),
        el('button', { class: 'btn btn-warning', onclick: () => startCounter(t), title: 'Proponer otros términos: puedes añadir o quitar propiedades y dinero' }, '↺ Contraoferta'),
        el('button', { class: 'btn btn-danger', onclick: () => act('trade_respond', { tradeId: t.id, accept: false }) }, '✖ Rechazar')
      );
    } else if (t.fromId === myId) {
      actions.append(
        el('span', { class: 'text-muted small waiting-dots' }, `Esperando a ${to.username}`),
        el('button', { class: 'btn btn-ghost btn-small', onclick: () => act('trade_cancel', { tradeId: t.id }) }, 'Cancelar oferta')
      );
    }
    body.replaceChildren(
      isCounter ? el('div', { class: 'trade-round' }, `↺ Contraoferta n.º ${t.round}`) : '',
      el('div', { class: 'trade-compare' },
        sideView('Entrega', from, t.offer),
        el('div', { class: 'trade-arrows', 'aria-hidden': 'true' }, '⇄'),
        sideView('Entrega', to, t.request)
      ),
      actions
    );
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
  if (!mine || !target) { body.replaceChildren(el('p', { class: 'text-muted' }, 'No hay con quién intercambiar.')); return; }

  const targets = counter
    ? el('div', { class: 'trade-targets' }, el('span', { class: 'trade-target', 'aria-pressed': 'true', '--player-color': target.color },
        tokenOf(target.skin, 'sm', target.color), el('span', {}, target.username), el('small', {}, money(target.money))))
    : el('div', { class: 'trade-targets' }, others.map(p =>
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

  const send = () => {
    if (counter) {
      act('trade_counter', { tradeId: t.id, offer: sidePayload(tradeDraft.offer), request: sidePayload(tradeDraft.request) });
    } else {
      act('trade_propose', { toId: tradeDraft.toId, offer: sidePayload(tradeDraft.offer), request: sidePayload(tradeDraft.request) });
    }
    tradeDraft = emptyDraft();
    tradeWin.mode = 'offer';   // se mostrará la oferta enviada cuando llegue el estado
  };

  body.replaceChildren(
    el('div', { class: 'trade-label' }, counter ? 'Contraoferta para' : 'Con quién'),
    targets,
    counter ? el('p', { class: 'small text-muted' }, 'Ajusta los términos: añade o quita propiedades, dinero o cartas de ambos lados.') : '',
    el('div', { class: 'trade-cols' },
      column(counter ? 'Tú entregas' : 'Tú ofreces', mine, tradeDraft.offer),
      column(`Pides a ${target.username}`, target, tradeDraft.request)),
    el('div', { class: 'trade-actions' },
      el('button', { class: 'btn', type: 'button', onclick: send }, counter ? '↺ Enviar contraoferta' : 'Enviar oferta'),
      counter
        ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { tradeDraft = emptyDraft(); tradeWin.mode = 'offer'; buildTradeWindow(); } }, '← Volver a la oferta')
        : el('button', { class: 'btn btn-ghost', type: 'button', onclick: closeTradeWindow }, 'Cerrar')
    )
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
  if (t) {
    const from = playerById(t.fromId), to = playerById(t.toId);
    const involved = t.fromId === myId || t.toId === myId;
    btn.disabled = !involved;
    btn.textContent = t.toId === myId ? '⇄ ¡Tienes una oferta!' : involved ? '⇄ Ver mi oferta' : '⇄ Intercambio en curso';
    if (t.toId === myId) btn.classList.add('has-offer');
    hint.textContent = `${from.username} ⇄ ${to.username}${t.round ? ` · contraoferta ${t.round}` : ''}`;
    btn.onclick = () => openTradeWindow('offer');
  } else {
    const ok = canPropose();
    btn.disabled = !ok;
    btn.textContent = '⇄ Intercambiar';
    hint.textContent = ok ? '' : (state.phase === 'playing' ? 'Disponible en tu turno' : '');
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

// Avisos grandes sobre el tablero. Cada regla: [regex, tipo, icono, (match) → texto]
const EVENT_RULES = [
  [/^(.+) debe pagar (\d+) de renta a (.+)$/, 'rent', '💸', m => [`${m[1]} paga renta a ${m[3]}`, money(m[2])]],
  [/^(.+) compró (.+) por (\d+)$/, 'buy', '🏠', m => [`${m[1]} compró ${m[2]}`, money(m[3])]],
  [/^(.+) construyó en (.+) \((.+)\)$/, 'build', '🏗', m => [`${m[1]} construyó en ${m[2]}`, m[3]]],
  [/^(.+) pasa por Salida y cobra (\d+)$/, 'collect', '⚑', m => [`${m[1]} pasa por Salida`, `+${money(m[2])}`]],
  [/^(.+) se lleva el Fondo de Donaciones: (\d+)$/, 'collect', '💰', m => [`${m[1]} se lleva el Fondo`, `+${money(m[2])}`]],
  [/^(.+) toma Tarjeta (General|Especial): (.+)$/, 'card', '📜', m => [`${m[1]} · Tarjeta ${m[2]}`, m[3]]],
  [/^(.+) va al calabozo$/, 'jail', '⛓', m => [`${m[1]} va al calabozo`, '']],
  [/^(.+) no tiene suficiente dinero: debe (\d+)/, 'debt', '⚠', m => [`${m[1]} no puede pagar`, `Debe ${money(m[2])}`]],
  [/^(.+) pagó su deuda de (\d+)$/, 'pay', '✔', m => [`${m[1]} pagó su deuda`, money(m[2])]],
  [/^(.+) hipotecó (.+) por (\d+)$/, 'mortgage', '🏦', m => [`${m[1]} hipotecó ${m[2]}`, `+${money(m[3])}`]],
  [/^(.+) aceptó el intercambio con (.+)$/, 'trade', '🤝', m => [`${m[1]} y ${m[2]} cerraron un intercambio`, '']],
  [/^(.+) hace una contraoferta a (.+)$/, 'trade', '↺', m => [`${m[1]} contraoferta a ${m[2]}`, '']],
  [/^(.+) propone un intercambio a (.+)$/, 'trade', '⇄', m => [`${m[1]} propone un intercambio a ${m[2]}`, '']],
  [/^(.+) rechazó el intercambio$/, 'reject', '✖', m => [`${m[1]} rechazó el intercambio`, '']],
  [/^(.+) quebró: sus bienes pasan a (.+)$/, 'out', '💀', m => [`${m[1]} quebró`, `Sus bienes pasan a ${m[2]}`]],
  [/^(.+) quedó eliminado/, 'out', '💀', m => [`${m[1]} quedó eliminado`, '']],
  [/^(.+) se rinde$/, 'out', '🏳', m => [`${m[1]} se rinde`, '']]
];

function eventFor(text) {
  for (const [re, kind, icon, fmt] of EVENT_RULES) {
    const m = re.exec(text);
    if (m) { const [title, detail] = fmt(m); return { kind, icon, title, detail }; }
  }
  return null;
}

function showEvent(ev, player) {
  const feed = $('event-feed');
  const mine = player && player.id === myId;
  const node = el('div', { class: `event-card ev-${ev.kind} ${mine ? 'is-mine' : ''}`, '--player-color': player ? player.color : 'var(--gold)' },
    el('span', { class: 'event-icon', 'aria-hidden': 'true' }, ev.icon),
    el('div', { class: 'event-text' },
      el('div', { class: 'event-title' }, ev.title),
      ev.detail ? el('div', { class: 'event-detail' }, ev.detail) : ''));
  feed.prepend(node);
  while (feed.children.length > 3) feed.lastChild.remove();
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
    const text = entry.text;
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
  const dice = config.themes.flatMap(t => (t.dice || []).map(d => ({ ...d, themeId: t.id, themeName: t.name, isDice: true })));
  const unlocked = skins.filter(sk => !sk.starter && sk.unlock && isUnlocked(sk))
    .concat(dice.filter(d => isDiceUnlocked(d.id)));
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
    skin.isDice ? Collection.dieNode(skin.style, 6, 'die-ach') : tokenOf(skin, 'lg', color),
    el('div', { class: 'achievement-text' },
      el('div', { class: 'achievement-kicker' }, skin.isDice ? '🎲 ¡Dado desbloqueado!' : '🏅 ¡Logro desbloqueado!'),
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
  $('log').replaceChildren(...state.log.map(l => {
    const ev = eventFor(l.text);
    return el('li', { class: ev ? `log-${ev.kind}` : '' }, ev ? `${ev.icon} ` : '', l.text);
  }));
}

// ── Chat de la partida ───────────────────────────────────────────────────────
let chatSeen = null;      // id del último mensaje visto con el chat abierto
let chatRendered = 0;

function chatOpen() { return $('chat').dataset.open === 'true'; }

function setChatOpen(open) {
  $('chat').dataset.open = String(open);
  $('chat-toggle').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('chat_open', open ? '1' : '0'); } catch { /* sin storage */ }
  if (open) { renderChat(true); setTimeout(() => $('chat-input').focus(), 50); }
}

function renderChat(force = false) {
  const msgs = (state && state.chat) || [];
  const last = msgs.length ? msgs[msgs.length - 1].id : 0;
  if (chatSeen === null) chatSeen = last;                   // al entrar no cuenta lo viejo
  if (chatOpen()) chatSeen = last;
  const unread = msgs.filter(m => m.id > chatSeen && m.userId !== myId).length;
  $('chat-unread').hidden = unread === 0;
  $('chat-unread').textContent = unread > 9 ? '9+' : String(unread);
  if (!force && last === chatRendered) return;
  chatRendered = last;

  const list = $('chat-list');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren(...(msgs.length ? msgs.map(m => {
    const time = new Date(m.t).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    return el('li', { class: `chat-msg ${m.userId === myId ? 'mine' : ''}`, '--player-color': m.color || 'var(--text-muted)' },
      el('div', { class: 'chat-meta' }, el('strong', {}, m.username), m.spectator ? ' · espectador' : '', ` · ${time}`),
      el('div', { class: 'chat-text' }, m.text));
  }) : [el('li', { class: 'chat-empty text-muted small' }, 'Nadie ha escrito todavía. ¡Saluda!')]));
  if (atBottom || force) list.scrollTop = list.scrollHeight;
}

$('chat-toggle').addEventListener('click', () => setChatOpen(!chatOpen()));
$('chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  act('chat', { text });
  input.value = '';
});
try { if (localStorage.getItem('chat_open') === '1') setChatOpen(true); } catch { /* sin storage */ }

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
    const free = t.skins.filter(isUnlocked).length;
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
      el('span', { class: 'theme-member' }, `${m.world} · ${m.name}`, unlocking ? ' · 🔓 liberando' : ''),
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
      el('span', { class: 'sname' }, s.name, ok ? '' : ' 🔒'),
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
      }, face, el('span', { class: 'dice-name' }, d.name, ok ? '' : ' 🔒'),
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
        el('span', { class: 'text-muted small' }, ` · ${p.skin.name} · ${theme ? theme.name : ''}${p.dice ? ` · ${p.dice.name}` : ''}`, p.id === state.hostId ? ' · anfitrión 👑' : '')
      );
    })
    : [el('li', { class: 'text-muted' }, 'Nadie se ha unido todavía. ¡Sé el primero!')]));
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
  $('chat').hidden = false;
  renderPlayers();
  renderChat();
  if (lobby) return renderWaitingRoom();
  if (wasHidden) requestAnimationFrame(() => BoardView.fit());
  renderBoard();
  renderCenter();
  renderSpaceDetail();
  renderMyProps();
  renderTableCards();
  renderTrade();
  renderLog();
  processEvents();
  updateTimers();
  renderEndModal();
}

$('join-btn').addEventListener('click', joinWithSelection);
$('leave-btn').addEventListener('click', () => { selectedTheme = null; selectedSkin = null; prefsApplied = false; act('leave'); });
$('start-btn').addEventListener('click', () => act('start'));

// ── Conexión (Taller 6: GET /coordinator → WS; reconexión a otro coordinador) ─
$('me-name').textContent = currentUsername;
$('room-name').textContent = ROOM_ID;

async function loadProgress() {
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
    prefer: ROOM_HOST,
    onStatus(stateName, text, info) {
      setConn(stateName, stateName === 'connected' && info ? `Conectado a ${info.coordinatorId}` : text);
      if (info) $('coord-id').textContent = stateName === 'connected' ? info.coordinatorId : '—';
    },
    onOpen() {
      $('lost-banner').hidden = true;
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
} else if (!ROOM_ID) {
  window.location.replace('lobby.html');
} else {
  connect();
  loadProgress();
}

// Para la demo de autoridad: `state` es local. Modificarlo desde DevTools solo
// cambia esta pantalla; el próximo game_state del servidor lo sobrescribe.
window.getGameState = () => state;
