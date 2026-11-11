// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de DOM compartidas por todas las páginas del cliente.
//   Dom.$('id')                    → document.getElementById
//   Dom.el('div', attrs, ...hijos) → crea un nodo (class, style, on*, --vars css)
//   Dom.coordColor('coord-a')      → color estable por coordinador
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const $ = (id) => document.getElementById(id);

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

  // Color estable por coordinador (para distinguirlos a simple vista)
  const COORD_COLORS = ['#f2d48a', '#7fd1ae', '#8fbdf0', '#f0a58f', '#c9b8ff', '#f5b8d0'];
  function coordColor(id) {
    if (!id) return 'var(--text-muted)';
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COORD_COLORS[h % COORD_COLORS.length];
  }

  function coordTag(id, title) {
    return el('span', { class: 'coord-tag', '--cc': coordColor(id), title: title || `Conectado a ${id}` }, id || '—');
  }

  window.Dom = { $, el, coordColor, coordTag };
})();
