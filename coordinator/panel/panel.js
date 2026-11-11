// Panel del coordinador: consulta /api/panel cada segundo y lo pinta.
(function () {
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('--')) node.style.setProperty(k, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const COLORS = ['#f2d48a', '#7fd1ae', '#8fbdf0', '#f0a58f', '#c9b8ff', '#f5b8d0'];
  function colorOf(id) {
    let h = 0;
    for (const ch of id || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  const tag = (id) => el('span', { class: 'tag', '--c': colorOf(id) }, id || '—');

  function duration(s) {
    if (s === null || s === undefined) return '—';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  function setChip(id, state, text) {
    $(id).dataset.state = state;
    $(id).textContent = text;
  }

  const STATUS = { vacia: 'Vacía', sin_iniciar: 'Sin iniciar', en_curso: 'En curso', finalizada: 'Finalizada' };
  const LINK_TEXT = { yo: 'este', enlazado: 'enlazado', conectando: 'conectando', esperando: 'esperando', 'sin enlace': 'sin enlace' };

  function render(d) {
    document.title = `Panel · ${d.self.coordinatorId}`;
    $('self-id').textContent = d.self.coordinatorId;
    $('self-public').textContent = d.self.publicUrl;
    $('self-peer').textContent = d.self.peerUrl;
    $('self-auth').textContent = d.self.authUrl;
    $('self-port').textContent = d.self.port;
    $('self-players').textContent = d.self.localPlayers;
    $('self-uptime').textContent = duration(d.self.uptime);

    setChip('chip-directory', d.directory.ok ? 'ok' : d.directory.ok === false ? 'bad' : 'warn',
      d.directory.ok ? 'Directorio: registrado' : d.directory.ok === false ? 'Directorio: sin conexión' : 'Directorio: …');
    const ng = d.ngrok || {};
    setChip('chip-ngrok',
      ng.state === 'activo' || ng.state === 'manual' ? 'ok' : ng.state === 'perdido' ? 'bad' : 'warn',
      ng.state === 'manual' ? 'URL pública: manual' : `ngrok: ${ng.state || '—'}`);
    setChip('chip-leader', d.self.leader ? 'info' : 'ok', d.self.leader ? 'Rol: líder' : 'Rol: miembro');

    // Advertencias útiles
    const warn = [];
    if (/\/\/(localhost|127\.)/.test(d.self.publicUrl)) {
      warn.push(el('div', {}, 'Tu URL pública es local: los coordinadores y jugadores de otras máquinas no te alcanzan. Abre un túnel con ',
        el('code', {}, `ngrok http ${d.self.port}`), ' (se detecta solo) o reinicia con ', el('code', {}, '--ngrok'), '.'));
    }
    if (d.directory.ok === false) {
      warn.push(el('div', {}, `No se pudo hablar con el auth-service (${d.directory.error}). Revisa `, el('code', {}, '--auth-url'), '.'));
    }
    if (ng.error) warn.push(el('div', {}, `ngrok: ${ng.error}`));
    $('warning').hidden = !warn.length;
    $('warning').replaceChildren(...warn);

    // Coordinadores
    const maxLoad = Math.max(1, ...d.coordinators.map(c => c.connectedPlayers || 0));
    $('network-count').textContent = `${d.coordinators.length} ${d.coordinators.length === 1 ? 'coordinador' : 'coordinadores'} · ${d.coordinators.filter(c => c.link.state === 'enlazado').length} enlazados`;
    $('coordinators').replaceChildren(...(d.coordinators.length ? d.coordinators.map(c => {
      const link = c.link || {};
      return el('article', { class: 'coord', 'data-link': link.state },
        el('div', { class: 'coord-name' }, el('span', {}, c.coordinatorId, c.self ? ' (tú)' : ''), el('span', { class: 'coord-state' }, LINK_TEXT[link.state] || link.state)),
        el('div', { class: 'coord-row' }, 'Pública: ', el('code', {}, c.publicUrl || '—')),
        el('div', { class: 'coord-row' }, 'Pares: ', el('code', {}, c.peerUrl || '—')),
        el('div', { class: 'coord-row' },
          'Jugadores: ', el('strong', {}, c.connectedPlayers ?? '—'),
          ' · Salas alojadas: ', el('strong', {}, c.rooms),
          c.lastSeenMsAgo !== null ? ` · latido hace ${(c.lastSeenMsAgo / 1000).toFixed(1)}s` : ''),
        el('div', { class: 'load', title: 'Carga relativa' }, el('span', { style: `width:${((c.connectedPlayers || 0) / maxLoad) * 100}%` })),
        link.note ? el('div', { class: 'coord-row' }, link.note) : '',
        c.localUrl && !c.self ? el('div', { class: 'coord-error' }, 'Anuncia una URL local: solo se alcanza desde su propia máquina.') : '',
        link.error ? el('div', { class: 'coord-error' }, `Último error: ${link.error}`) : '',
        c.unlisted ? el('div', { class: 'coord-error' }, 'Enlazado pero ya no aparece en el directorio.') : ''
      );
    }) : [el('p', { class: 'muted' }, 'El directorio todavía no responde.')]));

    // Salas
    $('rooms-count').textContent = `${d.rooms.length}`;
    $('rooms').replaceChildren(...(d.rooms.length ? d.rooms.map(r => el('tr', {},
      el('td', {}, el('strong', {}, r.name), el('div', { class: 'muted small' }, r.createdBy ? `de ${r.createdBy}` : r.id)),
      el('td', {}, tag(r.host)),
      el('td', {}, STATUS[r.status] || r.status),
      el('td', {}, `${r.players}/${r.maxPlayers}`),
      el('td', {}, r.spectators)
    )) : [el('tr', { class: 'empty' }, el('td', { colspan: 5 }, 'Nadie ha creado salas todavía.'))]));

    // Jugadores
    $('players-count').textContent = `${d.players.length}`;
    $('players').replaceChildren(...(d.players.length ? d.players.map(p => el('tr', {},
      el('td', {}, p.username),
      el('td', {}, tag(p.coordinatorId)),
      el('td', {}, p.view === 'board' ? (p.room || 'sala') : 'plaza')
    )) : [el('tr', { class: 'empty' }, el('td', { colspan: 3 }, 'Sin jugadores conectados.'))]));

    // Eventos
    $('replication').textContent = `Réplica: ${d.replication.replicated} enviados · ${d.replication.received} recibidos`;
    $('events').replaceChildren(...d.events.map(e => el('li', {},
      el('span', { class: 't' }, new Date(e.t).toLocaleTimeString()),
      el('span', { class: 'tag-col' }, e.tag),
      el('span', {}, e.text)
    )));
  }

  async function refresh() {
    try {
      const res = await fetch('/api/panel', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
    } catch (err) {
      setChip('chip-directory', 'bad', 'Coordinador detenido');
    }
  }

  refresh();
  setInterval(refresh, 1000);
})();
