// ─────────────────────────────────────────────────────────────────────────────
// Widget de chat compartido (lobby, tablero y vista de espectador).
//
//   const chat = Chat.create(container, {
//     title: 'Chat de la plaza',
//     myId: () => myId,                      // para marcar mis mensajes
//     canSend: true | false,                 // false = solo lectura (espectador)
//     send(text) → boolean,                  // envía por el WS; false si no hay conexión
//     themeOf(msg) → themeId | null          // para el sonido de cada temática
//   });
//   chat.setHistory(msgs)  chat.add(msg)  chat.error(data)  chat.setCanSend(bool)
//
// SEGURIDAD: el texto de cada mensaje se inserta SIEMPRE con textContent (nodos
// de texto), nunca como HTML, así que <script>, <img onerror=…> etc. se ven
// como texto plano y no se ejecutan (XSS).
//
// ORDEN: cada mensaje trae (lc, origin, seq), el reloj de Lamport del
// coordinador de origen. El widget los mantiene ordenados por esa tupla: si un
// mensaje llega tarde y le toca ir antes de otros ya mostrados, se inserta en su
// lugar (con un breve destello) en vez de ir al final. Así todos los clientes,
// aunque estén en coordinadores distintos, terminan viendo la misma conversación.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const { el, coordTag } = window.Dom;

  const cmp = (a, b) => (a.lc - b.lc) || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0) || (a.seq - b.seq);

  const ERRORS = {
    rate_limited: (d) => `Vas muy rápido. Espera ${Math.max(1, Math.ceil((d.retryMs || 1000) / 1000))} s.`,
    muted: (d) => `Silenciado por enviar demasiados mensajes. Podrás escribir en ${Math.max(1, Math.ceil((d.retryMs || 1000) / 1000))} s.`,
    too_long: (d) => `Mensaje demasiado largo (máximo ${d.max || 200} caracteres).`,
    empty: () => 'Escribe algo antes de enviar.'
  };

  function create(container, opts = {}) {
    const state = { msgs: [], nodes: new Map(), max: 200, canSend: opts.canSend !== false, unread: 0, collapsed: false };

    const unreadBadge = el('span', { class: 'chat-unread', hidden: true });
    const logEl = el('ul', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': opts.title || 'Chat' });
    const errEl = el('div', { class: 'chat-error', role: 'alert', hidden: true });
    const input = el('input', {
      class: 'chat-input', type: 'text', maxlength: String(state.max), autocomplete: 'off',
      placeholder: 'Escribe un mensaje…', 'aria-label': 'Mensaje'
    });
    const counter = el('span', { class: 'chat-counter' }, `0/${state.max}`);
    const sendBtn = el('button', { class: 'btn chat-send', type: 'submit' }, 'Enviar');
    const form = el('form', { class: 'chat-form', autocomplete: 'off' }, input, sendBtn, counter);
    const readonly = el('div', { class: 'chat-readonly' }, opts.readOnlyNote || '👁 Solo lectura: los espectadores no pueden escribir.');
    const toggle = el('button', { class: 'chat-toggle', type: 'button', 'aria-expanded': 'true', title: 'Plegar o desplegar el chat' }, '▾');
    const head = el('div', { class: 'chat-head' },
      el('h3', {}, opts.title || 'Chat'), unreadBadge,
      opts.collapsible ? toggle : '');
    const body = el('div', { class: 'chat-body' }, logEl, errEl, form, readonly);
    container.replaceChildren(el('div', { class: 'chat' }, head, body));

    let errTimer = null;
    function showError(text) {
      errEl.textContent = text;
      errEl.hidden = !text;
      clearTimeout(errTimer);
      if (text) errTimer = setTimeout(() => { errEl.hidden = true; }, 4000);
    }

    function applyMode() {
      form.hidden = !state.canSend;
      readonly.hidden = state.canSend;
    }

    function nearBottom() {
      return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
    }

    function renderMsg(m) {
      const mine = opts.myId && String(opts.myId()) === String(m.userId);
      const time = new Date(m.ts);
      const hh = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
      return el('li', { class: `chat-msg${mine ? ' mine' : ''}`, 'data-id': m.id },
        el('div', { class: 'chat-meta' },
          el('strong', { class: 'chat-user' }, m.username),
          coordTag(m.origin, `Enviado desde ${m.origin} · reloj lógico ${m.lc}`),
          el('time', { class: 'chat-time', title: `reloj de Lamport: ${m.lc}` }, hh)),
        el('div', { class: 'chat-text' }, m.text));            // ← textContent, nunca HTML
    }

    function insert(m, flash) {
      if (state.nodes.has(m.id)) return false;
      let i = state.msgs.length;
      while (i > 0 && cmp(m, state.msgs[i - 1]) < 0) i--;
      state.msgs.splice(i, 0, m);
      const node = renderMsg(m);
      if (flash) node.classList.add('late');
      state.nodes.set(m.id, node);
      const next = state.msgs[i + 1] && state.nodes.get(state.msgs[i + 1].id);
      logEl.insertBefore(node, next || null);
      return true;
    }

    function trim() {
      while (state.msgs.length > 100) {
        const old = state.msgs.shift();
        state.nodes.get(old.id).remove();
        state.nodes.delete(old.id);
      }
    }

    function setUnread(n) {
      state.unread = n;
      unreadBadge.textContent = String(n);
      unreadBadge.hidden = n === 0;
    }

    const api = {
      setHistory(msgs, meta) {
        if (meta && meta.max) { state.max = meta.max; input.maxLength = meta.max; counter.textContent = `${input.value.length}/${meta.max}`; }
        state.msgs = []; state.nodes.clear(); logEl.replaceChildren();
        for (const m of msgs || []) insert(m, false);
        logEl.scrollTop = logEl.scrollHeight;
      },
      add(m, late) {
        const stick = nearBottom();
        const mine = opts.myId && String(opts.myId()) === String(m.userId);
        if (!insert(m, late)) return;
        trim();
        if (stick || mine) logEl.scrollTop = logEl.scrollHeight;
        if (!mine) {
          if (state.collapsed || document.hidden) setUnread(state.unread + 1);
          if (window.Sound) Sound.play('chatIn', opts.themeOf ? opts.themeOf(m) : null);
        }
      },
      error(data) {
        const f = ERRORS[data && data.code];
        showError(f ? f(data) : 'No se pudo enviar el mensaje.');
      },
      setCanSend(v) { state.canSend = !!v; applyMode(); },
      setReadOnlyNote(t) { readonly.textContent = t; },
      focus() { input.focus(); }
    };

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (!opts.send || !opts.send(text)) return showError('Sin conexión con el coordinador.');
      showError('');
      input.value = '';
      counter.textContent = `0/${state.max}`;
      if (window.Sound) Sound.play('chatOut', opts.themeOf ? opts.themeOf(null) : null);
    });
    input.addEventListener('input', () => {
      counter.textContent = `${input.value.length}/${state.max}`;
      counter.classList.toggle('near', input.value.length > state.max * 0.9);
    });
    // No dejar que las teclas del juego (WASD en la plaza) se vayan al canvas mientras se escribe
    input.addEventListener('keydown', (ev) => ev.stopPropagation());
    input.addEventListener('keyup', (ev) => ev.stopPropagation());

    toggle.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      body.hidden = state.collapsed;
      toggle.textContent = state.collapsed ? '▸' : '▾';
      toggle.setAttribute('aria-expanded', String(!state.collapsed));
      if (!state.collapsed) { setUnread(0); logEl.scrollTop = logEl.scrollHeight; }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.collapsed) setUnread(0); });

    applyMode();
    return api;
  }

  window.Chat = { create };
})();
