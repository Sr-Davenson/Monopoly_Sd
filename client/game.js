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

  for (const s of config.spaces) {
    const { row, col } = gridPos(s.id);
    const member = s.memberId ? memberById(s.memberId) : null;
    const corner = ['start', 'jail', 'rest', 'go_to_jail'].includes(s.type);
    const cell = el('div', {
      class: `space ${corner ? 'corner' : ''}`,
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

    const tokens = el('div', { class: 'tokens' });
    for (const p of state.players) {
      if (p.bankrupt || p.position !== s.id) continue;
      const t = tokenOf(p.skin, '', p.color);
      if (p.id === turnId) t.classList.add('current');
      t.title = `${p.username} — ${p.skin.name}${p.inJail ? ' (en el calabozo)' : ''}`;
      tokens.append(t);
    }
    if (s.price && !owner && !corner) parts.push(el('div', { class: 'price' }, money(s.price)));
    else if (s.type === 'donation') parts.push(el('div', { class: 'price' }, money(s.amount)));
    parts.push(tokens);

    cell.replaceChildren(...parts);
  }
}

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
      p.connected ? '' : 'desconectado',
      p.id === state.hostId ? 'anfitrión' : ''
    ].filter(Boolean).join(' · ');
    return el('li', {
      class: `${state.turn && state.turn.playerId === p.id ? 'turn' : ''} ${p.bankrupt ? 'bankrupt' : ''}`,
      '--player-color': p.color
    },
      tokenOf(p.skin, '', p.color),
      el('div', { class: 'pname' },
        el('div', {}, p.username, p.id === myId ? ' (tú)' : ''),
        el('div', { class: 'pmeta' }, meta)
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

function renderTrade() {
  const incoming = $('trade-incoming');
  const form = $('trade-form');
  incoming.replaceChildren();
  form.replaceChildren();
  if (state.phase !== 'playing') return;

  const t = state.trade;
  if (t) {
    const from = playerById(t.fromId), to = playerById(t.toId);
    const box = el('div', { class: 'trade-box' },
      el('div', {}, el('strong', {}, from.username), ' ofrece: ', describeSide(t.offer)),
      el('div', {}, 'a ', el('strong', {}, to.username), ' a cambio de: ', describeSide(t.request))
    );
    if (t.toId === myId) {
      box.append(el('div', { class: 'row' },
        el('button', { class: 'btn btn-success', onclick: () => act('trade_respond', { tradeId: t.id, accept: true }) }, 'Aceptar'),
        el('button', { class: 'btn btn-danger', onclick: () => act('trade_respond', { tradeId: t.id, accept: false }) }, 'Rechazar')
      ));
    } else if (t.fromId === myId) {
      box.append(el('div', { class: 'row' },
        el('span', { class: 'text-muted' }, 'Esperando respuesta...'),
        el('button', { class: 'btn btn-ghost', onclick: () => act('trade_cancel', { tradeId: t.id }) }, 'Cancelar')
      ));
    }
    incoming.append(box);
    return;
  }

  const mine = me();
  if (!isMyTurn() || state.turn.stage === 'buy') {
    form.append(el('span', { class: 'text-muted small' }, 'Puedes proponer intercambios durante tu turno.'));
    return;
  }

  const others = state.players.filter(p => !p.bankrupt && p.id !== myId);
  if (!others.find(p => p.id === tradeDraft.toId)) tradeDraft = { ...emptyDraft(), toId: others[0] ? others[0].id : '' };
  const target = playerById(tradeDraft.toId);
  if (!target) return;

  const select = el('select', { onchange: (ev) => { tradeDraft = { ...emptyDraft(), toId: ev.target.value }; render(); } },
    others.map(p => el('option', { value: p.id, selected: p.id === tradeDraft.toId }, p.username)));

  const column = (title, owner, side) => {
    const checks = ownedBy(owner.id).filter(isTradeable).map(s =>
      el('label', {},
        el('input', {
          type: 'checkbox', checked: side.properties.has(s.id),
          onchange: (ev) => { ev.target.checked ? side.properties.add(s.id) : side.properties.delete(s.id); }
        }),
        s.name)
    );
    return el('div', { class: 'trade-col' },
      el('strong', {}, title),
      el('label', {}, 'Dinero'),
      el('input', { type: 'number', min: 0, max: owner.money, step: 10, value: side.money,
        oninput: (ev) => { side.money = Math.max(0, Math.floor(Number(ev.target.value) || 0)); } }),
      owner.jailCards ? el('label', {}, 'Cartas de salida',
        el('input', { type: 'number', min: 0, max: owner.jailCards, value: side.jailCards,
          oninput: (ev) => { side.jailCards = Math.max(0, Math.floor(Number(ev.target.value) || 0)); } })) : '',
      el('div', { class: 'checks' }, checks.length ? checks : el('span', { class: 'text-muted' }, 'Sin propiedades intercambiables'))
    );
  };

  form.append(
    el('label', {}, 'Proponer a'), select,
    el('div', { class: 'trade-cols' }, column('Ofreces', mine, tradeDraft.offer), column(`Pides a ${target.username}`, target, tradeDraft.request)),
    el('button', { class: 'btn btn-small', type: 'button', onclick: () => {
      const side = s => ({ money: s.money, properties: [...s.properties], jailCards: s.jailCards });
      act('trade_propose', { toId: tradeDraft.toId, offer: side(tradeDraft.offer), request: side(tradeDraft.request) });
      tradeDraft = emptyDraft();
    } }, 'Proponer intercambio')
  );
}

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
}

$('join-btn').addEventListener('click', () => act('join', { themeId: selectedTheme, skinId: selectedSkin }));
$('leave-btn').addEventListener('click', () => { selectedTheme = null; selectedSkin = null; act('leave'); });
$('start-btn').addEventListener('click', () => act('start'));

// ── Conexión (Taller 6: GET /coordinator → WS; reconexión a otro coordinador) ─
$('me-name').textContent = currentUsername;
$('room-name').textContent = ROOM_ID;

async function loadProgress() {
  try { progress = await Net.fetchProgress(originalToken); } catch { progress = null; }
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
      buildBoard();
      render();
      break;
    case 'game_state':
      state = msg.data;
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
