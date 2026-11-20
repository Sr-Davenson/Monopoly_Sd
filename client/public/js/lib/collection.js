// ─────────────────────────────────────────────────────────────────────────────
// Colección: desbloqueos (fichas y dados), preferencias del jugador y dados.
//
//   Collection.skinUnlocked(theme, skin, progress)
//   Collection.diceUnlocked(config, diceId, progress)
//   Collection.allDice(config)                → [{ ...dado, theme }]
//   Collection.findDice(config, id)
//   Collection.dieNode(style, value, cls)     → <div class="die">
//   Collection.Prefs.get() / .merge(p) / .save(token, patch)
//
// La regla de desbloqueo es la misma que valida el coordinador
// (coordinator/game/themes.js): por grupo de temática y en orden.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  function statOf(progress, themeId, stat) {
    const v = progress && progress.themes && progress.themes[themeId] && progress.themes[themeId][stat];
    return Number.isFinite(Number(v)) ? Number(v) : 0;
  }

  function itemUnlocked(theme, list, index, progress) {
    const item = list[index];
    if (!item) return false;
    if (item.starter || !item.unlock) return true;
    if (index > 0 && !itemUnlocked(theme, list, index - 1, progress)) return false;
    return statOf(progress, theme.id, item.unlock.stat) >= item.unlock.count;
  }

  // Estado de un elemento: 'unlocked' | 'next' (es el siguiente de la cadena) | 'locked'
  function itemState(theme, list, index, progress) {
    if (itemUnlocked(theme, list, index, progress)) return 'unlocked';
    return index === 0 || itemUnlocked(theme, list, index - 1, progress) ? 'next' : 'locked';
  }

  const skinUnlocked = (theme, skin, progress) => itemUnlocked(theme, theme.skins, theme.skins.indexOf(skin), progress);

  function allDice(config) {
    if (!config) return [];
    return [{ ...config.defaultDice, theme: null }, ...config.themes.flatMap(t => (t.dice || []).map(d => ({ ...d, theme: t })))];
  }

  function findDice(config, id) {
    return allDice(config).find(d => d.id === id) || null;
  }

  function diceUnlocked(config, diceId, progress) {
    const d = findDice(config, diceId);
    if (!d) return false;
    if (!d.theme) return true;
    return itemUnlocked(d.theme, d.theme.dice, d.theme.dice.findIndex(x => x.id === d.id), progress);
  }

  // ── Dados ───────────────────────────────────────────────────────────────────
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

  function applyDiceStyle(node, style) {
    const s = style || {};
    const face = s.face || ['#fbf5e6', '#e8dcc0'];
    node.style.setProperty('--die-face1', face[0]);
    node.style.setProperty('--die-face2', face[1] || face[0]);
    node.style.setProperty('--die-pip', s.pip || '#2a1e10');
    node.style.setProperty('--die-edge', s.edge || '#b8995a');
    node.style.setProperty('--die-glow', s.glow || 'transparent');
    node.dataset.mark = s.mark || '';
  }

  function setDieValue(node, value) {
    const pips = PIPS[value] || [];
    node.replaceChildren(...Array.from({ length: 9 }, (_, i) => {
      const p = document.createElement('span');
      p.className = pips.includes(i) ? 'pip on' : 'pip';
      return p;
    }));
    node.dataset.value = value || '';
    node.setAttribute('aria-label', value ? `Dado: ${value}` : 'Dado');
  }

  function dieNode(style, value, cls = '') {
    const node = document.createElement('div');
    node.className = `die ${cls}`.trim();
    applyDiceStyle(node, style);
    setDieValue(node, value);
    return node;
  }

  // ── Preferencias (ficha, color, dado, grupo en liberación) ─────────────────
  // Se guardan en el auth-service (replicado) y en una copia local por usuario
  // para pintarlas al instante, incluso si el auth tarda en responder.
  const Prefs = (function () {
    const key = () => `prefs:${localStorage.getItem('username') || ''}`;
    let pending = {};
    let timer = null;

    function get() {
      try { return JSON.parse(localStorage.getItem(key())) || {}; } catch { return {}; }
    }
    function merge(prefs) {
      const next = { ...get(), ...(prefs || {}) };
      try { localStorage.setItem(key(), JSON.stringify(next)); } catch { /* sin storage */ }
      return next;
    }
    // Guarda en local de inmediato y en el auth (al líder) agrupando cambios seguidos
    function save(token, patch, delay = 600) {
      merge(patch);
      Object.assign(pending, patch);
      clearTimeout(timer);
      return new Promise((resolve) => {
        timer = setTimeout(async () => {
          const body = pending;
          pending = {};
          try {
            const res = await AuthApi.request('/me/prefs', {
              method: 'POST', body, leader: true, rounds: 3,
              headers: { Authorization: `Bearer ${token}` }
            });
            if (res.ok && res.data.prefs) merge(res.data.prefs);
            resolve(res.ok);
          } catch {
            resolve(false);
          }
        }, delay);
      });
    }
    return { get, merge, save };
  })();

  window.Collection = {
    statOf, itemUnlocked, itemState, skinUnlocked, allDice, findDice, diceUnlocked,
    dieNode, setDieValue, applyDiceStyle, Prefs
  };
})();
