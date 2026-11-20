// ── VARIABLE GLOBAL EXPUESTA PARA DEMO DE AUTORIDAD ──────────────────────
// Modificar lastState desde DevTools solo cambia esta pantalla: el servidor
// la sobrescribe en el siguiente tick.
window.lastState = { t: Date.now(), players: [] };

const originalToken   = localStorage.getItem('token');
const currentUsername = localStorage.getItem('username') || 'Jugador';
const { $, el, coordColor, coordTag } = Dom;   // js/lib/dom.js

let conn = null;
let myId = null;
let worldConfig = { width: 800, height: 600, playerRadius: 18, tickRate: 20 };
let gameConfig = null;      // temáticas, economía (game_config)
let rooms = [];
let players = [];
let mesh = null;
let progress = null;
let progressError = false;
let leaving = false;

const STATUS_LABEL = { vacia: 'Vacía', sin_iniciar: 'Sin iniciar', en_curso: 'En curso', finalizada: 'Finalizada' };
// Emblemas disponibles al crear una sala (el coordinador valida la lista)
const ROOM_STYLE = {
  galaxia:   { icon: 'planet',  label: 'Galaxia',   color: 'var(--galaxy)' },
  nave:      { icon: 'rocket',  label: 'Nave',      color: 'var(--galaxy)' },
  yggdrasil: { icon: 'tree',    label: 'Yggdrasil', color: 'var(--fantasy)' },
  dragon:    { icon: 'dragon',  label: 'Dragón',    color: 'var(--fantasy)' },
  drakkar:   { icon: 'ship',    label: 'Drakkar',   color: 'var(--viking)' },
  martillo:  { icon: 'hammer',  label: 'Mjölnir',   color: 'var(--viking)' },
  babel:     { icon: 'book',    label: 'Babel',     color: 'var(--letters)' },
  pluma:     { icon: 'feather', label: 'Pluma',     color: 'var(--letters)' }
};
const WORLD_COLOR = { david: 'var(--galaxy)', jossef: 'var(--fantasy)', sebastian: 'var(--viking)', santiago: 'var(--letters)' };

function setConnState(state, text) {
  $('conn-status').dataset.state = state;
  $('conn-status-text').textContent = text;
}

function allSkins() {
  return gameConfig ? gameConfig.themes.flatMap(t => t.skins.map(s => ({ ...s, theme: t }))) : [];
}

function unlocked(skin) {
  if (skin.starter || !skin.unlock) return true;
  const theme = skin.theme || (gameConfig && gameConfig.themes.find(t => t.skins.some(s => s.id === skin.id)));
  return !!theme && Collection.skinUnlocked(theme, theme.skins.find(s => s.id === skin.id), progress);
}

// Preferencias guardadas (auth-service + copia local)
function prefs() {
  return { ...Collection.Prefs.get(), ...((progress && progress.prefs) || {}) };
}

// ── Salas ───────────────────────────────────────────────────────────────
function myActiveRoom() {
  return rooms.find(r => r.status !== 'finalizada' && r.players.some(p => p.id === myId && !p.bankrupt));
}

function myCoordinator() {
  return (mesh && mesh.coordinatorId) || (conn && conn.info && conn.info.coordinatorId) || null;
}

function renderRooms() {
  const box = $('rooms');
  const mine = myActiveRoom();
  const here = myCoordinator();

  if (!rooms.length) {
    box.replaceChildren(el('p', { class: 'rooms-empty' },
      'Todavía no hay salas. Crea una arriba: la verán los jugadores de todos los coordinadores.'));
    return;
  }

  box.replaceChildren(...rooms.map(r => {
    const style = ROOM_STYLE[r.emblem] || { icon: 'dice', color: 'var(--gold)' };
    const amIn = r.players.some(p => p.id === myId);

    const seats = el('div', { class: 'seats', 'aria-label': `${r.players.length} de ${r.maxPlayers} asientos ocupados` });
    for (let i = 0; i < r.maxPlayers; i++) {
      const p = r.players[i];
      if (p) {
        const t = Tokens.node(p.skin, '', p.color);
        if (!p.connected) t.classList.add('offline');
        t.title = `${p.username} — ${p.skin.name}${p.connected ? '' : ' (desconectado)'}`;
        seats.append(t);
      } else {
        seats.append(el('span', { class: `seat ${i < r.minPlayers ? 'min' : ''}`, title: i < r.minPlayers ? 'Asiento necesario para iniciar' : 'Asiento libre' }, i + 1));
      }
    }

    const list = el('ul', { class: 'room-players' });
    if (!r.players.length) list.append(el('li', { class: 'empty' }, 'Nadie en esta sala todavía.'));
    for (const p of r.players) {
      list.append(el('li', { class: p.connected ? '' : 'offline' },
        Tokens.node(p.skin, 'sm', p.color),
        el('span', { class: 'pn' }, p.username, p.id === myId ? ' (tú)' : '', p.id === r.hostId ? Icons.svg('crown', 'host-ic') : '', p.bankrupt ? ' · eliminado' : ''),
        p.connected && p.coordinatorId ? coordTag(p.coordinatorId) : el('span', { class: 'small text-muted' }, p.connected ? 'en la sala' : 'desconectado')
      ));
    }

    const meta = el('div', { class: 'room-meta' },
      el('strong', {}, `${r.players.length}/${r.maxPlayers}`), ' jugadores · mínimo ', el('strong', {}, r.minPlayers), ' para iniciar',
      r.spectators.length ? ` · ${r.spectators.length} observando` : '',
      r.createdBy ? ` · creada por ${r.createdBy.username}` : ''
    );

    // Coordinador que aloja la sala. Si no es el mío, al entrar me cambio a él.
    const host = el('div', { class: 'room-host' },
      'Alojada en', coordTag(r.host, `Coordinador anfitrión: ${r.host}`),
      here && r.host !== here ? el('span', { class: 'switch-note' }, `· al entrar pasarás de ${here} a ${r.host}`) : el('span', {}, '· tu coordinador')
    );

    let btn;
    const go = () => enterRoom(r);
    if (amIn && r.status !== 'finalizada') btn = el('button', { class: 'btn', onclick: go }, 'Volver a mi partida');
    else if (r.status === 'en_curso') btn = el('button', { class: 'btn btn-ghost', onclick: go }, 'Observar partida');
    else if (r.status === 'finalizada') btn = el('button', { class: 'btn btn-ghost', onclick: go }, amIn ? 'Ver resultados' : 'Ver sala');
    else if (r.players.length >= r.maxPlayers) btn = el('button', { class: 'btn btn-ghost', onclick: go }, 'Sala llena · observar');
    else if (mine && mine.id !== r.id) btn = el('button', { class: 'btn', disabled: true, title: `Ya estás en ${mine.name}` }, `Ya estás en ${mine.name}`);
    else btn = el('button', { class: 'btn', onclick: go }, 'Unirme a la sala');

    return el('article', { class: 'room-card', '--rc': style.color, 'data-status': r.status },
      el('header', { class: 'room-head' },
        el('span', { class: 'room-emblem', 'aria-hidden': 'true' }, Icons.svg(style.icon)),
        el('div', { class: 'room-title' }, el('h3', {}, r.name), el('span', { class: 'room-id' }, r.id)),
        el('span', { class: `status-pill ${r.status}` }, STATUS_LABEL[r.status] || r.status)
      ),
      host, seats, meta, list, btn
    );
  }));
}

// Entrar a una sala: el tablero se conecta al coordinador ANFITRIÓN de la sala
// (game.html?coord=...). Si es otro distinto al mío, el cambio es automático.
function enterRoom(room) {
  leaving = true;
  if (conn) conn.close(1000, 'entering room');
  const qs = new URLSearchParams({ sala: room.id });
  if (room.host) qs.set('coord', room.host);
  window.location.href = `game.html?${qs}`;
}

// ── Crear sala ──────────────────────────────────────────────────────────
function showCreateError(text) {
  const box = $('create-room-error');
  box.textContent = text || '';
  box.classList.toggle('show', !!text);
}

function renderEmblemPicker() {
  $('room-emblem-input').replaceChildren(...Object.entries(ROOM_STYLE).map(([id, st]) =>
    el('option', { value: id }, st.label)));
}

$('create-room-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('room-name-input').value.trim();
  if (name.length < 3) return showCreateError('El nombre debe tener al menos 3 caracteres.');
  showCreateError('');
  if (!conn || !conn.send({ type: 'create_room', data: { name, emblem: $('room-emblem-input').value } })) {
    return showCreateError('No hay conexión con el coordinador. Espera un momento.');
  }
  $('create-room-btn').disabled = true;
  setTimeout(() => { $('create-room-btn').disabled = false; }, 1500);
});

// ── Jugadores en línea ──────────────────────────────────────────────────
let lastListRender = 0;
function renderPlayersList() {
  lastListRender = Date.now();
  const listEl = $('players-list');
  $('players-count').textContent = `${players.length} ${players.length === 1 ? 'conectado' : 'conectados'}`;
  if (!players.length) {
    listEl.replaceChildren(el('li', { class: 'player-item' }, el('span', { class: 'text-muted' }, 'No hay jugadores conectados')));
    return;
  }
  const roomName = (id) => (rooms.find(r => r.id === id) || {}).name || id;
  const artOf = {};
  for (const p of window.lastState.players || []) if (p.extras && p.extras.art) artOf[p.userId] = p.extras;

  const sorted = [...players].sort((a, b) => (b.userId === myId) - (a.userId === myId) || a.username.localeCompare(b.username));
  listEl.replaceChildren(...sorted.map(p => {
    const isMe = p.userId === myId;
    const ex = artOf[p.userId];
    return el('li', { class: `player-item ${isMe ? 'is-me' : ''}` },
      el('div', { class: 'player-info' },
        ex ? Tokens.node({ art: ex.art }, 'sm', ex.color) : el('span', { class: 'status-dot' }),
        el('strong', {}, p.username),
        isMe ? el('span', { class: 'badge' }, 'Tú') : '',
        el('span', { title: p.provider === 'google' ? 'Cuenta Google' : 'Cuenta local' }, p.provider === 'google' ? Icons.svg('globe') : '')
      ),
      el('div', { class: 'right' },
        coordTag(p.coordinatorId),
        el('span', { class: 'where' }, p.view === 'board' ? `en ${roomName(p.roomId)}` : 'en la plaza')
      )
    );
  }));
}

// ── Colección y misiones ────────────────────────────────────────────────
// Un grupo (temática) a la vez: las estadísticas de cada partida cuentan para
// el grupo en liberación, y dentro de él fichas y dados se liberan en orden.
function missionLine(theme, list, i) {
  const item = list[i];
  const st = Collection.itemState(theme, list, i, progress);
  const have = item.unlock ? Math.min(Collection.statOf(progress, theme.id, item.unlock.stat), item.unlock.count) : 0;
  if (item.starter || !item.unlock) return { st: 'unlocked', text: 'Inicial · disponible', have, total: 0 };
  if (st === 'unlocked') return { st, text: `Liberado · ${item.unlock.text}`, have, total: item.unlock.count };
  if (st === 'next') return { st, text: `Misión: ${item.unlock.text} (${have}/${item.unlock.count})`, have, total: item.unlock.count };
  return { st, text: `Libera antes "${list[i - 1].name}" · luego: ${item.unlock.text}`, have, total: item.unlock.count };
}

function setUnlockTheme(themeId) {
  progress = progress || { stats: {}, themes: {}, prefs: {} };
  progress.prefs = { ...(progress.prefs || {}), unlockTheme: themeId };
  renderCollection();
  Collection.Prefs.save(originalToken, { unlockTheme: themeId }, 0).then(ok => {
    if (!ok) { progressError = true; renderCollection(); }
  });
}

function renderCollection() {
  if (!gameConfig) return;
  const s = (progress && progress.stats) || {};
  const statDefs = [
    ['gamesPlayed', 'Partidas jugadas'], ['gamesWon', 'Partidas ganadas'], ['propertiesBought', 'Propiedades compradas'],
    ['buildingsBuilt', 'Casas y hoteles'], ['hotelsBuilt', 'Hoteles'], ['rentCollected', 'Renta cobrada'],
    ['tradesDone', 'Intercambios'], ['cardsDrawn', 'Tarjetas'], ['lapsCompleted', 'Vueltas'],
    ['jailVisits', 'Visitas al calabozo'], ['potWins', 'Fondos ganados'], ['doublesRolled', 'Dobles'], ['groupsCompleted', 'Grupos completos']
  ];
  $('stats').replaceChildren(...statDefs.map(([k, label]) =>
    el('div', { class: 'stat' }, el('div', { class: 'v' }, progress ? (s[k] || 0).toLocaleString('es-CO') : '–'), el('div', { class: 'l' }, label))));

  const active = prefs().unlockTheme;
  const activeTheme = gameConfig.themes.find(t => t.id === active);
  $('unlock-banner').replaceChildren(activeTheme
    ? el('span', {}, Icons.svg('unlock'), ' Liberando: ', el('strong', {}, activeTheme.name), ' · tus partidas cuentan para sus misiones')
    : el('span', {}, Icons.svg('unlock'), ' Sin grupo elegido · cuenta la temática con la que juegues'));

  $('collection').replaceChildren(
    ...(progressError ? [el('p', { class: 'alert alert-warning show' }, 'No se pudo leer o guardar tu progreso en el auth-service; se muestran solo los elementos iniciales.')] : []),
    ...gameConfig.themes.map(t => {
      const member = gameConfig.members.find(m => m.id === t.memberId);
      const color = WORLD_COLOR[t.memberId] || 'var(--gold)';
      const isActive = active === t.id;
      const doneSkins = t.skins.filter((_, i) => Collection.itemUnlocked(t, t.skins, i, progress)).length;
      const doneDice = t.dice.filter((_, i) => Collection.itemUnlocked(t, t.dice, i, progress)).length;
      const row = (item, i, list, visual) => {
        const m = missionLine(t, list, i);
        return el('div', { class: `skin-row ${m.st === 'unlocked' ? '' : 'locked'} ${m.st === 'next' ? 'next' : ''}` },
          visual,
          el('div', { class: 'sk' },
            el('div', { class: 'sk-name' }, m.st === 'unlocked' ? '' : Icons.svg('lock'), item.name),
            el('div', { class: `rarity ${item.rarity}` }, gameConfig.rarities && gameConfig.rarities[item.rarity] ? gameConfig.rarities[item.rarity].label : item.rarity),
            el('div', { class: 'sk-sub' }, m.text),
            m.st === 'next' ? el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': m.total, 'aria-valuenow': m.have },
              el('span', { style: `width:${(m.have / m.total) * 100}%` })) : ''));
      };
      return el('div', { class: `theme-col ${isActive ? 'unlocking' : ''}`, '--wc': color },
        el('h3', {}, t.name),
        el('div', { class: 'tdesc' }, `${member ? member.world + ' · de ' + member.name : ''}. ${t.description}`),
        el('div', { class: 'unlock-row' },
          isActive
            ? el('span', { class: 'unlock-active' }, Icons.svg('unlock'), ' Liberando este grupo')
            : el('button', { class: 'btn btn-small', type: 'button', onclick: () => setUnlockTheme(t.id) }, 'Liberar este grupo'),
          el('span', { class: 'small text-muted' }, `${doneSkins}/${t.skins.length} fichas · ${doneDice}/${t.dice.length} dados`)),
        el('div', { class: 'col-sub' }, 'Fichas'),
        ...t.skins.map((sk, i) => {
          const ok = Collection.itemUnlocked(t, t.skins, i, progress);
          const node = Tokens.node(sk, 'lg', ok ? color : '#4a4356');
          if (!ok) node.classList.add('locked');
          return row(sk, i, t.skins, node);
        }),
        el('div', { class: 'col-sub' }, 'Dados'),
        ...t.dice.map((d, i) => {
          const ok = Collection.itemUnlocked(t, t.dice, i, progress);
          const node = Collection.dieNode(d.style, 5, 'die-sm');
          if (!ok) node.classList.add('locked');
          return row(d, i, t.dice, node);
        })
      );
    })
  );
  renderArtPicker();
}

let pickersFromPrefs = false;

function renderArtPicker() {
  const sel = $('player-art-picker');
  const p = prefs();
  const savedSkin = p.skinId && allSkins().find(s => s.id === p.skinId);
  const skins = allSkins().filter(unlocked);
  // Hasta aplicar lo guardado, manda la ficha guardada; luego, lo que elija el jugador
  const fromPrefs = !pickersFromPrefs && savedSkin && unlocked(savedSkin) ? savedSkin.art : null;
  const current = fromPrefs || sel.value || (savedSkin && savedSkin.art) || localStorage.getItem('plazaArt') || (skins[0] && skins[0].art);
  sel.replaceChildren(...gameConfig.themes.map(t => {
    const og = el('optgroup', { label: t.name });
    for (const sk of t.skins.filter(sk => unlocked({ ...sk, theme: t }))) og.append(el('option', { value: sk.art }, sk.name));
    return og;
  }));
  if (skins.some(s => s.art === current)) sel.value = current;
  // Color y ánimo guardados (una sola vez, para no pisar lo que el jugador cambie)
  if (!pickersFromPrefs) {
    if (p.color) $('player-color-picker').value = p.color;
    if (p.mood !== undefined) $('player-mood-picker').value = p.mood;
    pickersFromPrefs = !!progress || progressError;
  }
  $('me-token').replaceChildren(Tokens.node({ art: sel.value }, '', $('player-color-picker').value));
}

async function loadProgress() {
  try {
    progress = await Net.fetchProgress(originalToken);
    if (progress && progress.prefs) Collection.Prefs.merge(progress.prefs);
    progressError = false;
  } catch {
    progressError = true;
  }
  renderCollection();
  sendExtras(false);
}

// ── Canvas ──────────────────────────────────────────────────────────────
const canvas = $('game-canvas');
const ctx = canvas.getContext('2d');

// Ánimo sobre la ficha: etiqueta de texto (sin emojis)
function drawMood(c, text, x, y) {
  c.save();
  c.font = '700 11px "Alegreya Sans", system-ui';
  const w = c.measureText(text).width + 12;
  c.fillStyle = 'rgba(242, 212, 138, 0.95)';
  c.beginPath();
  if (c.roundRect) c.roundRect(x - w / 2, y - 9, w, 16, 8); else c.rect(x - w / 2, y - 9, w, 16);
  c.fill();
  c.fillStyle = '#1d1406';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x, y - 1);
  c.restore();
}
let bg = null;

function seeded(seed) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}

// Fondo: cada cuadrante es un mundo (se dibuja una sola vez)
function buildBackground(w, h) {
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const g = off.getContext('2d');
  const rnd = seeded(42);
  const hw = w / 2, hh = h / 2;
  const quads = [
    { x: 0,  y: 0,  base: '#07070f', accent: '#3a3f6b', label: 'Galaxia Muy Lejana',   color: '#e05a47' },
    { x: hw, y: 0,  base: '#0f2a1f', accent: '#2f8f63', label: 'Reinos Encantados',    color: '#46b98a' },
    { x: 0,  y: hh, base: '#101d30', accent: '#6fa8dc', label: 'Tierras del Norte',    color: '#5b9bd5' },
    { x: hw, y: hh, base: '#261a10', accent: '#8a5e33', label: 'Barrio de las Letras', color: '#c58b4f' }
  ];
  quads.forEach((q, i) => {
    const grad = g.createRadialGradient(q.x + hw / 2, q.y + hh / 2, 10, q.x + hw / 2, q.y + hh / 2, hw * 0.8);
    grad.addColorStop(0, q.accent + '55');
    grad.addColorStop(1, q.base);
    g.fillStyle = grad;
    g.fillRect(q.x, q.y, hw, hh);
    g.save();
    g.beginPath(); g.rect(q.x, q.y, hw, hh); g.clip();
    g.strokeStyle = q.accent + '66';
    g.fillStyle = q.accent + '55';
    g.lineWidth = 1.5;
    if (i === 0) {        // espacio: estrellas, un planeta con anillo y una estrella de la muerte lejana
      for (let k = 0; k < 90; k++) {
        g.fillStyle = rnd() < 0.15 ? '#f2d48acc' : '#ffffff' + (rnd() < 0.5 ? '88' : 'cc');
        g.beginPath(); g.arc(q.x + rnd() * hw, q.y + rnd() * hh, rnd() * 1.4 + 0.3, 0, Math.PI * 2); g.fill();
      }
      const px = q.x + hw * 0.72, py = q.y + hh * 0.62;
      const planet = g.createRadialGradient(px - 14, py - 14, 4, px, py, 46);
      planet.addColorStop(0, '#e8a35a'); planet.addColorStop(1, '#5a2c14');
      g.fillStyle = planet;
      g.beginPath(); g.arc(px, py, 42, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#f2d48a88'; g.lineWidth = 2.5;
      g.beginPath(); g.ellipse(px, py, 68, 13, -0.35, 0, Math.PI * 2); g.stroke();
      const dx = q.x + hw * 0.24, dy = q.y + hh * 0.42;
      g.fillStyle = '#8e959e88';
      g.beginPath(); g.arc(dx, dy, 18, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4c525a99';
      g.beginPath(); g.arc(dx - 6, dy - 6, 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#4c525a99'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(dx - 18, dy + 1); g.quadraticCurveTo(dx, dy + 4, dx + 18, dy + 1); g.stroke();
    } else if (i === 1) { // bosque
      for (let k = 0; k < 26; k++) {
        const x = q.x + rnd() * hw, y = q.y + 20 + rnd() * (hh - 20), s = 8 + rnd() * 10;
        g.beginPath(); g.moveTo(x, y - s * 1.6); g.lineTo(x - s, y); g.lineTo(x + s, y); g.closePath(); g.fill();
      }
      g.fillStyle = '#f2d48a55';
      for (let k = 0; k < 30; k++) { g.beginPath(); g.arc(q.x + rnd() * hw, q.y + rnd() * hh, 1.3, 0, Math.PI * 2); g.fill(); }
    } else if (i === 2) { // montañas del fiordo
      g.fillStyle = q.accent + '33';
      for (let k = 0; k < 6; k++) {
        const x = q.x + k * (hw / 5) - 20, s = 50 + rnd() * 40;
        g.beginPath(); g.moveTo(x, q.y + hh); g.lineTo(x + s, q.y + hh - s * 1.4); g.lineTo(x + s * 2, q.y + hh); g.fill();
        g.strokeStyle = '#e6f2ff55';
        g.beginPath(); g.moveTo(x + s - 10, q.y + hh - s * 1.4 + 14); g.lineTo(x + s, q.y + hh - s * 1.4); g.lineTo(x + s + 10, q.y + hh - s * 1.4 + 14); g.stroke();
      }
    } else {              // estanterías de libros
      for (let y = q.y + 30; y < q.y + hh; y += 46) {
        g.fillStyle = q.accent + '55'; g.fillRect(q.x, y + 34, hw, 3);
        let x = q.x + 6;
        while (x < q.x + hw - 6) {
          const bw = 6 + rnd() * 8, bh = 22 + rnd() * 12;
          g.fillStyle = ['#8a3a4a', '#5a6f3a', '#3a4f7a', '#7a5a2a', '#6a4a7a'][Math.floor(rnd() * 5)] + '88';
          g.fillRect(x, y + 34 - bh, bw, bh);
          x += bw + 2;
        }
      }
    }
    g.restore();
    g.font = '700 15px Cinzel, Georgia, serif';
    g.fillStyle = q.color + 'cc';
    g.textAlign = i % 2 === 0 ? 'left' : 'right';
    g.fillText(q.label.toUpperCase(), i % 2 === 0 ? q.x + 14 : q.x + hw - 14, i < 2 ? q.y + 24 : q.y + hh - 14);
  });
  // Rosa de los vientos en el centro
  g.save();
  g.translate(hw, hh);
  g.strokeStyle = '#d9b45a88'; g.fillStyle = '#d9b45a44'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(0, 0, 34, 0, Math.PI * 2); g.stroke();
  for (let k = 0; k < 4; k++) {
    g.rotate(Math.PI / 2);
    g.beginPath(); g.moveTo(0, -46); g.lineTo(7, 0); g.lineTo(-7, 0); g.closePath(); g.fill(); g.stroke();
  }
  g.restore();
  g.strokeStyle = '#d9b45a33'; g.setLineDash([6, 6]);
  g.beginPath(); g.moveTo(hw, 0); g.lineTo(hw, h); g.moveTo(0, hh); g.lineTo(w, hh); g.stroke();
  return off;
}

function renderCanvas(list) {
  if (!bg || bg.width !== canvas.width || bg.height !== canvas.height) bg = buildBackground(canvas.width, canvas.height);
  ctx.drawImage(bg, 0, 0);
  const r = worldConfig.playerRadius || 18;

  for (const p of list) {
    const isMe = p.userId === myId;
    const ex = p.extras || {};
    const ring = ex.color || (isMe ? '#d9b45a' : '#a99f8d');

    ctx.save();
    ctx.shadowColor = ring;
    ctx.shadowBlur = isMe ? 16 : 6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1622';
    ctx.fill();
    ctx.lineWidth = isMe ? 4 : 3;
    ctx.strokeStyle = ring;
    ctx.stroke();
    ctx.restore();

    const img = ex.art && Tokens.image(ex.art);
    if (img) ctx.drawImage(img, p.x - r * 0.8, p.y - r * 0.8, r * 1.6, r * 1.6);

    ctx.textAlign = 'center';
    const mood = ex.mood ? Icons.clean(String(ex.mood)).slice(0, 14) : '';
    if (mood) drawMood(ctx, mood, p.x, p.y - r - 24);
    ctx.font = `${isMe ? '700' : '500'} 13px "Alegreya Sans", system-ui`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,8,14,0.85)';
    ctx.strokeText(p.username, p.x, p.y - r - 6);
    ctx.fillStyle = isMe ? '#f2d48a' : '#f3ead7';
    ctx.fillText(p.username, p.x, p.y - r - 6);
    if (p.coordinatorId) {
      ctx.font = '700 10px Cinzel, Georgia, serif';
      ctx.strokeText(p.coordinatorId, p.x, p.y + r + 13);
      ctx.fillStyle = coordColor(p.coordinatorId);
      ctx.fillText(p.coordinatorId, p.x, p.y + r + 13);
    }
  }
}

// ── Entrada: intents y extras ───────────────────────────────────────────
const activeKeys = { x: 0, y: 0 };
let lastSentIntent = { x: 0, y: 0 };

function sendIntent(force = false) {
  const dir = { x: activeKeys.x, y: activeKeys.y };
  if (!force && dir.x === lastSentIntent.x && dir.y === lastSentIntent.y) return;
  if (conn && conn.send({ type: 'intent', intent: { dir } })) lastSentIntent = dir;
}

// persist = true cuando el jugador cambia algo: se guarda como su ficha y color
// (los mismos que se preseleccionan en la sala de espera de cada partida).
function sendExtras(persist = true) {
  const color = $('player-color-picker').value;
  const mood  = $('player-mood-picker').value;
  const art   = $('player-art-picker').value || 'casco_vader';
  try { localStorage.setItem('plazaArt', art); } catch { /* sin almacenamiento */ }
  $('me-token').replaceChildren(Tokens.node({ art }, '', color));
  if (persist === true && gameConfig) {
    const skin = allSkins().find(s => s.art === art && unlocked(s));
    Collection.Prefs.save(originalToken, { color, mood, ...(skin ? { skinId: skin.id, themeId: skin.theme.id } : {}) });
  }
  if (conn) conn.send({ type: 'extras_update', extras: { color, mood, art } });
}

const KEYS = { arrowleft: ['x', -1], a: ['x', -1], arrowright: ['x', 1], d: ['x', 1], arrowup: ['y', -1], w: ['y', -1], arrowdown: ['y', 1], s: ['y', 1] };
function typingIn(e) { return /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName); }

window.addEventListener('keydown', (e) => {
  const k = KEYS[e.key.toLowerCase()];
  if (!k || typingIn(e)) return;
  e.preventDefault();
  activeKeys[k[0]] = k[1];
  sendIntent();
});
window.addEventListener('keyup', (e) => {
  const k = KEYS[e.key.toLowerCase()];
  if (!k) return;
  if (activeKeys[k[0]] === k[1]) activeKeys[k[0]] = 0;
  sendIntent();
});
window.addEventListener('blur', () => { activeKeys.x = 0; activeKeys.y = 0; sendIntent(); });

$('player-color-picker').addEventListener('input', () => sendExtras(true));
$('player-mood-picker').addEventListener('change', () => sendExtras(true));
$('player-art-picker').addEventListener('change', () => sendExtras(true));

// ── Mensajes del coordinador ────────────────────────────────────────────
function showCoordinator(info) {
  const id = (mesh && mesh.coordinatorId) || (info && info.coordinatorId) || '—';
  $('coord-id').textContent = id;
  $('tick-coord').textContent = id;
  $('tick-info').firstChild.textContent = `Tick: ${worldConfig.tickRate || 20} Hz · Coordinador: `;
  $('mesh-peers').textContent = mesh ? (mesh.peers.length ? mesh.peers.join(', ') : 'sin pares') : '—';
  $('create-room-coord').textContent = id;
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = String(msg.you.userId);
      if (msg.world) {
        worldConfig = msg.world;
        canvas.width = msg.world.width;
        canvas.height = msg.world.height;
      }
      mesh = msg.coordinator || null;
      showCoordinator();
      return;
    case 'game_config':
      gameConfig = msg.data;
      renderCollection();
      return;
    case 'state':
      window.lastState = msg;
      renderCanvas(msg.players);
      // La lista muestra la ficha de cada jugador (viene en el state): 1 vez/s basta
      if (Date.now() - lastListRender > 1000) renderPlayersList();
      return;
    case 'players_update':
      players = msg.players;
      renderPlayersList();
      return;
    case 'rooms_update':
      rooms = msg.data.rooms;
      renderRooms();
      renderPlayersList();
      return;
    case 'mesh_update':
      mesh = msg.data;
      showCoordinator();
      renderRooms();
      return;
    case 'room_created':
      // Sala creada en MI coordinador: entro directamente.
      $('room-name-input').value = '';
      enterRoom(msg.data.room);
      return;
    case 'room_error':
      $('create-room-btn').disabled = false;
      showCreateError(msg.data.message);
      return;
    case 'progress_changed':
      loadProgress();
      return;
    case 'auth_challenge':
      conn.send({ type: 'auth_response', data: { token: localStorage.getItem('token') } });
      return;
  }
}

// ── Inicio ──────────────────────────────────────────────────────────────
$('current-username').textContent = currentUsername;
renderEmblemPicker();
for (const art of Tokens.arts) Tokens.image(art); // precarga para el canvas

if (!originalToken) {
  Net.goToLogin('Debes iniciar sesión para acceder al lobby.');
} else {
  start();
}

function start() {
  conn = Net.connectCoordinator({
    token: originalToken,
    params: { view: 'canvas' },
    onStatus(state, text, info) {
      setConnState(state, state === 'connected' && info ? `Conectado a ${info.coordinatorId}` : text);
    },
    onOpen(info) {
      $('lost-banner').hidden = true;
      showCoordinator(info);
      lastSentIntent = { x: 0, y: 0 };
      setTimeout(() => { sendExtras(false); sendIntent(true); }, 100);
    },
    onRedirect(from, to) {
      // El balanceador reparte la carga (entró o salió un coordinador)
      const b = $('lost-banner');
      b.hidden = false;
      b.textContent = `Balanceo de carga: te movemos de ${from} a ${to}…`;
      setTimeout(() => { if (conn && conn.isOpen()) b.hidden = true; }, 4000);
    },
    onLost(info) {
      if (leaving) return;
      mesh = null;
      showCoordinator();
      const b = $('lost-banner');
      b.hidden = false;
      b.textContent = `Se perdió la conexión con ${info.coordinatorId}. Pidiendo un nuevo coordinador al auth-service (GET /coordinator)…`;
    },
    onMessage,
    onFatal(code) {
      if (leaving) return;
      Net.goToLogin(Net.FATAL_MESSAGES[code] || 'La sesión terminó.', code === 4002);
    }
  });
  loadProgress();

  // Detección local de manipulación del token (pestaña o DevTools)
  const tokenPoll = setInterval(() => {
    if (localStorage.getItem('token') !== originalToken) {
      clearInterval(tokenPoll);
      leaving = true;
      conn.close(1000, 'token tampered client-side');
      Net.goToLogin('Sesión cerrada: se detectó una modificación no autorizada del token de sesión.');
    }
  }, 2000);

  $('logout-btn').addEventListener('click', () => {
    clearInterval(tokenPoll);
    leaving = true;
    $('logout-btn').disabled = true;
    setConnState('disconnected', 'Desconectando...');
    conn.close(1000, 'user logout');
    setTimeout(() => Net.goToLogin('Has cerrado sesión correctamente.'), 300);
  });
}
