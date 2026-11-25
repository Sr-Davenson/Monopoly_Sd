// ─────────────────────────────────────────────────────────────────────────────
// Elegir una sala para observar (sin login).
// Pide un coordinador al auth-service (GET /coordinator) y lee su lista pública
// de salas (GET <coordinador>/rooms). Todas las salas se replican en todos los
// coordinadores, así que con uno basta. Al observar, el tablero se cambia solo
// al coordinador que ALOJA la sala.
// ─────────────────────────────────────────────────────────────────────────────
const { $, el, coordTag } = Dom;
const STATUS = { vacia: 'Vacía', sin_iniciar: 'Sin iniciar', en_curso: 'En curso', finalizada: 'Finalizada' };
const HEADERS = { 'ngrok-skip-browser-warning': 'true' };
let base = null;           // URL http(s) del coordinador consultado
let lastFailed = null;

const toHttp = (ws) => ws.replace(/^ws/, 'http').replace(/\/+$/, '');

function banner(text) {
  const b = $('lost-banner');
  b.hidden = !text;
  b.textContent = text || '';
}

function render(list) {
  const box = $('rooms');
  const rooms = list.filter(r => r.status !== 'vacia');
  if (!rooms.length) {
    box.replaceChildren(el('p', { class: 'rooms-empty' }, 'No hay partidas con jugadores ahora mismo. Esta lista se actualiza sola.'));
    return;
  }
  box.replaceChildren(...rooms.map(r => {
    const seats = el('div', { class: 'seats' }, r.players.map(p => {
      const t = Tokens.node(p.skin, '', p.color);
      t.title = `${p.username}${p.bankrupt ? ' (eliminado)' : ''}`;
      if (p.bankrupt) t.classList.add('offline');
      return t;
    }));
    const go = () => {
      const qs = new URLSearchParams({ sala: r.id, coord: r.host, espectador: '1' });
      window.location.href = `game.html?${qs}`;
    };
    return el('article', { class: 'room-card', 'data-status': r.status },
      el('header', { class: 'room-head' },
        el('div', { class: 'room-title' }, el('h3', {}, r.name), el('span', { class: 'room-id' }, r.id)),
        el('span', { class: `status-pill ${r.status}` }, STATUS[r.status] || r.status)),
      el('div', { class: 'room-host' }, 'Alojada en', coordTag(r.host, `Coordinador anfitrión: ${r.host}`)),
      seats,
      el('div', { class: 'room-meta' }, el('strong', {}, `${r.players.length}/${r.maxPlayers}`), ' jugadores',
        r.spectators ? ` · ${r.spectators} observando` : ''),
      el('button', { class: 'btn', type: 'button', onclick: go }, '👁 Observar'));
  }));
}

async function refresh() {
  try {
    if (!base) {
      const info = await Net.requestCoordinator({ exclude: lastFailed });
      base = toHttp(info.publicUrl);
      $('coord-id').textContent = info.coordinatorId;
      lastFailed = info.coordinatorId;
    }
    const res = await fetch(`${base}/rooms`, { headers: HEADERS, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    $('coord-id').textContent = body.coordinatorId;
    banner('');
    render(body.rooms);
  } catch (err) {
    base = null;   // el siguiente intento pide otro coordinador
    banner(`No se pudo consultar el coordinador (${err.message}). Reintentando con otro…`);
  }
}

refresh();
setInterval(refresh, 3000);
