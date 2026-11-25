// ─────────────────────────────────────────────────────────────────────────────
// Iconos SVG de línea (sustituyen a los emojis en toda la interfaz).
//   Icons.svg('dice')                → <svg class="ic">
//   Icons.svg('dice', 'ic-lg')       → con clase extra
//   Icons.html('dice')               → texto HTML (para innerHTML)
// Todos usan currentColor, así que toman el color del texto que los rodea.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const P = {
    dice:     '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.1" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.1" fill="currentColor"/>',
    trade:    '<path d="M4 8h14"/><path d="m14 4 4 4-4 4"/><path d="M20 16H6"/><path d="m10 12-4 4 4 4"/>',
    counter:  '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    chat:     '<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
    send:     '<path d="M21 3 10 14"/><path d="M21 3 14.5 21l-4.5-7-7-4.5z"/>',
    sound:    '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    mute:     '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 5"/><path d="m21 9-5 5"/>',
    back:     '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
    close:    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check:    '<path d="M20 6 9 17l-5-5"/>',
    trophy:   '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3"/><path d="M17 6h3v1a3 3 0 0 1-3 3"/>',
    alert:    '<path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
    tag:      '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor"/>',
    coins:    '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.6-2.4-2.9-5.5-3"/>',
    cash:     '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5"/><path d="M18 9.5v5"/>',
    home:     '<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    hotel:    '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/><path d="M11 21v-3h2v3"/>',
    key:      '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m16 7 3 3"/><path d="m18 5 2 2"/>',
    clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    hammer:   '<path d="m14 6 4 4"/><path d="M11.5 3.5 16 8l-2.5 2.5L9 6z"/><path d="M12 9 4 17a1.4 1.4 0 0 0 2 2l8-8"/>',
    bank:     '<path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 21h18"/>',
    deal:     '<path d="m7 12 3 3 7-7"/><circle cx="12" cy="12" r="9"/>',
    out:      '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="m17 8 4 4"/><path d="m21 8-4 4"/>',
    flag:     '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    medal:    '<circle cx="12" cy="15" r="6"/><path d="m8.5 3 3.5 6 3.5-6"/><path d="m12 12.5.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z" fill="currentColor" stroke="none"/>',
    lock:     '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    unlock:   '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>',
    crown:    '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
    star:     '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
    bars:     '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M8 3.5v17M12 3.5v17M16 3.5v17"/>',
    card:     '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    heart:    '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
    bolt:     '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    train:    '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14"/><circle cx="9" cy="14" r=".8" fill="currentColor"/><circle cx="15" cy="14" r=".8" fill="currentColor"/><path d="m8 21 1.5-4M16 21l-1.5-4"/>',
    cup:      '<path d="M5 8h11v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3v2M11 3v2M14 3v2"/>',
    gavel:    '<path d="m14 13-7.5 7.5a1.5 1.5 0 0 1-2-2L12 11"/><path d="m9.5 6.5 8 8"/><path d="m12 4 8 8"/><path d="M8.5 7.5 13 3M16.5 15.5 21 11"/>',
    globe:    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
    eye:      '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    plus:     '<path d="M12 5v14M5 12h14"/>',
    minus:    '<path d="M5 12h14"/>',
    fit:      '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    cube:     '<path d="M12 2.8 20.5 7.5v9L12 21.2 3.5 16.5v-9z"/><path d="M3.5 7.5 12 12l8.5-4.5"/><path d="M12 12v9.2"/>',
    square:   '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
    grip:     '<path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" stroke-width="3"/>',
    rocket:   '<path d="M12 2c3.5 2.5 5 6.5 4 11l-2 3h-4l-2-3c-1-4.5.5-8.5 4-11z"/><circle cx="12" cy="9" r="1.6"/><path d="m8 13-3 3 3 1M16 13l3 3-3 1M10.5 19.5 12 22l1.5-2.5"/>',
    planet:   '<circle cx="12" cy="12" r="5.5"/><path d="M3.5 15.5C1.8 17.6 2 19 4 19c2.6 0 7.7-2.6 12-6.2S21.9 5.6 20 5c-1-.3-2.4.1-4 .9"/>',
    tree:     '<path d="M12 22v-6"/><path d="M12 3 6 11h3l-4 5h14l-4-5h3z"/>',
    dragon:   '<path d="M4 18c2-1 3-3 3-6a5 5 0 0 1 10 0c0 3 1 5 3 6"/><path d="M9 9 7 4l4 3M15 9l2-5-4 3"/><circle cx="10" cy="12" r=".7" fill="currentColor"/><circle cx="14" cy="12" r=".7" fill="currentColor"/><path d="M10 16h4"/>',
    ship:     '<path d="M3 16h18l-3 5H6z"/><path d="M12 3v13"/><path d="M12 4 5 13h7"/><path d="M12 6l6 7h-6"/>',
    book:     '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20"/><path d="M9 7h7"/>',
    feather:  '<path d="M20 4c-8 0-14 6-14 14v2"/><path d="M20 4c0 7-4 12-11 12"/><path d="M6 18l4-4"/>',
    anchor:   '<circle cx="12" cy="5" r="2"/><path d="M12 7v14"/><path d="M5 13a7 7 0 0 0 14 0"/><path d="M9 10h6"/>',
    flame:    '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6.5-4-10-2.5 2-3 4-3 6-1-1-2-2-2-3.5C7.5 9.5 5 12 5 15a7 7 0 0 0 7 7z"/>',
    axe:      '<path d="M14 6 4 20"/><path d="M12.5 8.2C10 6 10.5 3 13 2c3 1.5 6 4.5 7.5 7.5-1 2.5-4 3-6.2.5"/>',
    orb:      '<circle cx="12" cy="10" r="6.5"/><path d="M7 20h10"/><path d="M9 16.5 8 20M15 16.5l1 3.5"/><path d="M9.5 8a3 3 0 0 1 3-2"/>',
    users:    '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8"/><path d="M22 21a7 7 0 0 0-4-6.3"/>',
    list:     '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8" fill="currentColor"/><circle cx="4.5" cy="12" r=".8" fill="currentColor"/><circle cx="4.5" cy="18" r=".8" fill="currentColor"/>',
    layers:   '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    chevron:  '<path d="m6 9 6 6 6-6"/>',
    info:     '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".6" fill="currentColor"/>',
    sparkle:  '<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z"/>'
  };

  function html(name, cls = '') {
    const body = P[name] || P.sparkle;
    return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  const tpl = document.createElement('template');
  function svg(name, cls = '') {
    tpl.innerHTML = html(name, cls);
    return tpl.content.firstChild;
  }

  // Quita emojis y pictogramas de textos que vienen del servidor (registro,
  // tarjetas) para que la interfaz se vea uniforme.
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/gu;
  const clean = (text) => String(text == null ? '' : text).replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();

  window.Icons = { svg, html, clean, names: Object.keys(P) };
})();
