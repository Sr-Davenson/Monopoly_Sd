// Panel del auth: consulta /api/panel cada segundo y lo pinta.
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

  function duration(s) {
    if (s === null || s === undefined) return '—';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const time = (t) => new Date(t).toLocaleTimeString('es-CO', { hour12: false });

  function setChip(id, state, text) {
    $(id).dataset.state = state;
    $(id).textContent = text;
  }

  // Rol visible de un nodo a partir de su /status
  function roleOf(node) {
    if (!node.reachable || !node.status) return { key: 'down', text: 'Caído' };
    const s = node.status;
    if (s.role === 'leader') return { key: 'leader', text: 'Líder' };
    if (!s.leaderId) return { key: 'noleader', text: 'Sin líder · elección' };
    return { key: 'replica', text: 'Réplica' };
  }

  // ── Este auth ─────────────────────────────────────────────────────────────
  function renderSelf(d) {
    const s = d.self, e = d.election;
    document.title = `Panel · ${s.authId} (${s.role === 'leader' ? 'líder' : 'réplica'})`;
    $('self-id').textContent = s.authId;
    $('self-public').textContent = s.publicUrl;
    $('self-peer').textContent = s.peerUrl;
    $('self-leader-url').textContent = s.leaderUrl || 'ninguno (elección en curso)';
    $('self-seq').textContent = `${s.lastAppliedSeq}${s.role !== 'leader' ? ` (líder en ${s.leaderLastSeq}, atraso ${s.lag})` : ''}`;
    $('self-users').textContent = s.users;
    $('self-majority').textContent = `${e.majority} de ${e.clusterSize} nodos`;
    $('self-consistency').textContent = s.consistency;
    $('self-uptime').textContent = duration(d.uptime);

    const role = s.role === 'leader' ? ['info', 'Rol: LÍDER']
      : e.candidate ? ['warn', 'Rol: CANDIDATO']
      : s.leaderId ? ['ok', 'Rol: réplica']
      : ['bad', 'Rol: réplica sin líder'];
    setChip('chip-role', role[0], role[1]);
    setChip('chip-term', 'info', `Term: ${s.term}`);
    setChip('chip-leader', s.leaderId ? 'ok' : 'bad', s.leaderId ? `Líder: ${s.leaderId}` : 'Líder: ninguno');
    setChip('chip-sync', e.syncing ? 'warn' : s.lag > 0 ? 'warn' : 'ok',
      e.syncing ? 'Datos: sincronizando…' : s.lag > 0 ? `Datos: ${s.lag} atrás` : 'Datos: al día');

    // Barra del latido del líder
    const beat = $('beat');
    if (s.role === 'leader') {
      beat.dataset.level = 'leader';
      $('beat-text').textContent = `Soy el líder: mando heartbeat cada ${secs(e.heartbeatMs)} a las réplicas`;
      $('beat-hint').textContent = `${Object.keys(e.peersSeen).length} réplica(s) enlazada(s)`;
      $('beat-fill').style.width = '100%';
    } else if (s.leaderId) {
      const ratio = Math.min(1, e.msSinceLeader / e.electionTimeoutMs);
      beat.dataset.level = ratio < 0.5 ? 'ok' : ratio < 0.84 ? 'warn' : 'bad';
      $('beat-text').textContent = `Último latido de ${s.leaderId} hace ${secs(e.msSinceLeader)}`;
      $('beat-hint').textContent = `a los ${secs(e.electionTimeoutMs)} se declara muerto`;
      $('beat-fill').style.width = `${Math.round(ratio * 100)}%`;
    } else {
      beat.dataset.level = 'bad';
      $('beat-fill').style.width = '100%';
      if (e.candidate) {
        $('beat-text').textContent = `Candidato en term ${s.term}: votos de ${e.votes.join(', ')} (${e.votes.length}/${e.majority})`;
      } else {
        $('beat-text').textContent = e.votedFor ? `Sin líder · voté por ${e.votedFor} en term ${s.term}` : 'Sin líder: elección en curso';
      }
      $('beat-hint').textContent = e.nextElectionInMs !== null ? `me postulo en ${secs(e.nextElectionInMs)}` : '';
    }

    const warn = [];
    const linked = Object.keys(e.peersSeen).length + 1;
    if (e.clusterSize > 1 && linked < e.majority) {
      warn.push(el('div', {}, `Solo hay enlace con ${linked} de ${e.clusterSize} auths: sin mayoría no se puede elegir líder. Levanta los demás auths o revisa `, el('code', {}, '--cluster'), '.'));
    }
    if (/\/\/(localhost|127\.)/.test(s.publicUrl) && e.clusterSize > 1) {
      warn.push(el('div', {}, 'La URL pública es local. Sirve si todo corre en este PC; si el cliente o los coordinadores están en otros PCs, no llegarán a este auth ni podrán seguirlo como líder. En ese caso arranca con ',
        el('code', {}, '--public-url https://<tu-tunel>.ngrok-free.app'), '.'));
    }
    $('warning').hidden = !warn.length;
    $('warning').replaceChildren(...warn);
  }

  // ── Clúster ───────────────────────────────────────────────────────────────
  function renderNodes(d) {
    const up = d.nodes.filter(n => n.reachable).length;
    $('network-count').textContent = `${up} de ${d.nodes.length} vivos`;
    $('nodes').replaceChildren(...d.nodes.map((n) => {
      const r = roleOf(n);
      const s = n.status || {};
      return el('article', { class: 'coord', 'data-role': r.key },
        el('div', { class: 'coord-name' },
          el('span', {}, r.key === 'leader' ? el('span', { class: 'crown' }, '★') : null, n.authId, n.self ? el('span', { class: 'muted small' }, ' (este)') : null),
          el('span', { class: 'coord-state' }, r.text)),
        n.reachable ? el('div', { class: 'metrics' },
          el('div', { class: 'metric' }, el('b', {}, s.term), el('span', {}, 'term')),
          el('div', { class: 'metric' }, el('b', {}, s.lastAppliedSeq), el('span', {}, 'seq')),
          el('div', { class: 'metric' }, el('b', {}, s.users), el('span', {}, 'usuarios'))) : null,
        n.reachable ? el('div', { class: 'coord-row' }, 'Sigue a: ', el('strong', {}, s.leaderId || 'nadie'), s.lag ? ` · ${s.lag} entradas atrás` : '') : null,
        el('div', { class: 'coord-row' }, 'Enlace mesh: ', el('strong', {}, n.self ? 'este nodo' : n.linked ? 'conectado' : 'sin enlace')),
        el('div', { class: 'coord-row' }, el('code', {}, n.publicUrl || 'URL desconocida (aún no se ha enlazado)')),
        !n.reachable ? el('div', { class: 'coord-error' }, n.publicUrl ? 'No responde a GET /status' : 'Nunca se ha enlazado con este nodo') : null
      );
    }));
  }

  // ── BD local ──────────────────────────────────────────────────────────────
  function renderDb(d) {
    $('users-count').textContent = `${d.self.users} en total · últimos ${d.db.users.length}`;
    $('users').replaceChildren(...(d.db.users.length ? d.db.users.map(u => el('tr', {},
      el('td', {}, u.id), el('td', {}, el('strong', {}, u.username)), el('td', {}, u.provider),
      el('td', { class: 'muted small' }, u.created_at ? String(u.created_at).replace('T', ' ').slice(0, 19) : '—')))
      : [el('tr', { class: 'empty' }, el('td', { colspan: 4 }, 'Sin usuarios'))]));

    $('log').replaceChildren(...(d.db.log.length ? d.db.log.map(e => el('tr', {},
      el('td', {}, `#${e.seq}`), el('td', {}, e.term), el('td', {}, el('code', {}, e.op)), el('td', {}, e.detail)))
      : [el('tr', { class: 'empty' }, el('td', { colspan: 4 }, 'Log vacío'))]));
  }

  // ── Eventos ───────────────────────────────────────────────────────────────
  const hidden = new Set(['AUTH', 'DIRECTORY', 'BALANCE', 'PANEL', 'DB']);
  const seenTags = new Set();
  function renderEvents(d) {
    for (const e of d.events) {
      if (seenTags.has(e.tag)) continue;
      seenTags.add(e.tag);
      const box = el('input', { type: 'checkbox' });
      box.checked = !hidden.has(e.tag);
      box.addEventListener('change', () => { box.checked ? hidden.delete(e.tag) : hidden.add(e.tag); });
      $('events-filter').append(el('label', {}, box, e.tag));
    }
    const list = d.events.filter(e => !hidden.has(e.tag));
    $('events-count').textContent = `${list.length} visibles`;
    $('events').replaceChildren(...list.map(e => el('li', { 'data-tag': e.tag },
      el('span', { class: 't' }, time(e.t)),
      el('span', { class: 'tag-col' }, e.tag),
      el('span', { class: /NUEVO LÍDER|líder caído|deja de ser líder/.test(e.msg) ? 'strong' : null }, e.msg))));
  }

  async function tick() {
    try {
      const res = await fetch('/api/panel', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      renderSelf(d);
      renderNodes(d);
      renderDb(d);
      renderEvents(d);
    } catch (err) {
      setChip('chip-role', 'bad', `Sin conexión con este auth (${err.message})`);
    } finally {
      setTimeout(tick, 1000);
    }
  }
  tick();
})();
