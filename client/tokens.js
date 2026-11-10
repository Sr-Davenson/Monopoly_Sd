// ─────────────────────────────────────────────────────────────────────────────
// Dibujos de las fichas (SVG, viewBox 64×64).
//
// El servidor manda en cada skin un `art` (id del dibujo) y un `icon` (emoji de
// respaldo). Aquí solo hay presentación: qué ficha tiene cada jugador y cuáles
// están desbloqueadas lo decide el servidor.
//
//   Tokens.node(skin, 'lg', color)  → <span class="token-art"> con el dibujo
//   Tokens.image(art)               → <img> cacheada para dibujar en el canvas
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const ART = {
    // ── Piratas (David) ──────────────────────────────────────────────────────
    sombrero_pirata: `
      <path d="M4 42 Q32 30 60 42 Q56 49 32 47 Q8 49 4 42Z" fill="#2a2730" stroke="#d9b45a" stroke-width="2"/>
      <path d="M8 40 Q14 16 32 14 Q50 16 56 40 Q46 33 32 35 Q18 33 8 40Z" fill="#1d1b22" stroke="#d9b45a" stroke-width="2"/>
      <circle cx="32" cy="24" r="5.5" fill="#f3ead7"/>
      <rect x="29" y="27.5" width="6" height="3.5" rx="1" fill="#f3ead7"/>
      <circle cx="30" cy="24" r="1.5" fill="#1d1b22"/><circle cx="34" cy="24" r="1.5" fill="#1d1b22"/>
      <path d="M25 30 L39 36 M39 30 L25 36" stroke="#f3ead7" stroke-width="2.2" stroke-linecap="round"/>`,

    mapa_tesoro: `
      <path d="M8 12 Q14 8 20 12 L56 10 Q60 31 56 52 L20 54 Q14 58 8 54 Q12 32 8 12Z" fill="#ead6a6" stroke="#8b6a3e" stroke-width="2"/>
      <path d="M20 12 Q16 33 20 54" fill="none" stroke="#c9ad74" stroke-width="1.5"/>
      <path d="M14 46 q5 -5 10 0 q-5 4 -10 0Z" fill="#7fb07a"/>
      <path d="M19 44 Q24 30 32 34 Q40 38 43 24" fill="none" stroke="#8b3a2a" stroke-width="2" stroke-dasharray="3 3"/>
      <path d="M40 16 L49 25 M49 16 L40 25" stroke="#c0392b" stroke-width="3.2" stroke-linecap="round"/>
      <circle cx="48" cy="44" r="5" fill="none" stroke="#8b6a3e" stroke-width="1.3"/>
      <path d="M48 37 V51 M41 44 H55" stroke="#8b6a3e" stroke-width="1.3"/>`,

    garfio: `
      <path d="M32 26 C32 9 51 7 51 21 C51 29 43 31 40 25" fill="none" stroke="#5f6670" stroke-width="7" stroke-linecap="round"/>
      <path d="M32 26 C32 9 51 7 51 21 C51 29 43 31 40 25" fill="none" stroke="#d3d9e1" stroke-width="4" stroke-linecap="round"/>
      <rect x="29" y="24" width="6" height="14" fill="#c3cad3" stroke="#5f6670" stroke-width="1.2"/>
      <rect x="17" y="36" width="30" height="7" rx="2" fill="#d9b45a" stroke="#8a6d27" stroke-width="1.2"/>
      <path d="M19 43 H45 L41 60 H23Z" fill="#7a4a24" stroke="#4a2c14" stroke-width="2"/>
      <path d="M26 46 L25 58 M32 46 V58 M38 46 L39 58" stroke="#5e3619" stroke-width="1.3"/>`,

    calavera: `
      <g stroke-linecap="round">
        <path d="M11 42 L53 60 M53 42 L11 60" stroke="#8a7f6a" stroke-width="7"/>
        <path d="M11 42 L53 60 M53 42 L11 60" stroke="#efe5cf" stroke-width="4.5"/>
      </g>
      <path d="M32 6 C18 6 11 16 11 27 C11 35 16 39 20 41 V48 H44 V41 C48 39 53 35 53 27 C53 16 46 6 32 6Z" fill="#f3ead7" stroke="#8a7f6a" stroke-width="1.6"/>
      <ellipse cx="24" cy="28" rx="5.2" ry="6" fill="#1c1923"/>
      <ellipse cx="40" cy="28" rx="5.2" ry="6" fill="#1c1923"/>
      <path d="M32 33 L29 39 H35Z" fill="#1c1923"/>
      <path d="M25 43 V48 M29 43 V48 M33 43 V48 M37 43 V48 M41 43 V48" stroke="#8a7f6a" stroke-width="1.3"/>`,

    // ── Fantasía (Jossef) ────────────────────────────────────────────────────
    pocion: `
      <rect x="26" y="3" width="12" height="7" rx="2" fill="#a0703f" stroke="#6b4423" stroke-width="1.2"/>
      <path d="M27 10 H37 V20 C48 23 54 31 54 41 C54 52 44 59 32 59 C20 59 10 52 10 41 C10 31 16 23 27 20Z" fill="rgba(255,255,255,0.1)" stroke="#d8d0ee" stroke-width="2"/>
      <path d="M12 39 C20 35 44 35 52 39 C52 52 44 57 32 57 C20 57 12 52 12 39Z" fill="#8b6be0"/>
      <path d="M14 41 C22 38 42 38 50 41" fill="none" stroke="#c3b2ff" stroke-width="1.5"/>
      <circle cx="25" cy="47" r="2.4" fill="#d9ccff"/><circle cx="36" cy="51" r="1.8" fill="#d9ccff"/><circle cx="40" cy="44" r="1.3" fill="#d9ccff"/>
      <path d="M17 28 Q16 34 19 37" fill="none" stroke="#ffffff" stroke-opacity="0.45" stroke-width="2" stroke-linecap="round"/>
      <path d="M51 6 l1.6 3.6 3.6 1.6 -3.6 1.6 -1.6 3.6 -1.6 -3.6 -3.6 -1.6 3.6 -1.6z" fill="#f2d48a"/>`,

    sombrero_mago: `
      <path d="M33 4 C28 14 21 30 14 46 H50 C45 33 41 22 39 15 C43 13 45 9 33 4Z" fill="#3b4fa8" stroke="#1f2a63" stroke-width="2"/>
      <ellipse cx="32" cy="48" rx="27" ry="7.5" fill="#2c3b85" stroke="#1f2a63" stroke-width="2"/>
      <path d="M16 41 Q32 46 48 41 L49.5 46 Q32 51 14.5 46Z" fill="#d9b45a"/>
      <path d="M27 24 l1.4 3 3 1.4 -3 1.4 -1.4 3 -1.4 -3 -3 -1.4 3 -1.4z" fill="#f2d48a"/>
      <path d="M38 31 l1 2.2 2.2 1 -2.2 1 -1 2.2 -1 -2.2 -2.2 -1 2.2 -1z" fill="#f2d48a"/>
      <path d="M34 15 a4 4 0 1 0 3 6 a3 3 0 1 1 -3 -6Z" fill="#f2d48a"/>`,

    espada_piedra: `
      <circle cx="32" cy="5" r="3.2" fill="#d9b45a" stroke="#8a6d27"/>
      <rect x="30" y="7" width="4" height="8" fill="#6b4423"/>
      <rect x="20" y="14" width="24" height="4.5" rx="2" fill="#d9b45a" stroke="#8a6d27"/>
      <path d="M29 18.5 H35 V40 H29Z" fill="#e4eaf1" stroke="#8a96a3" stroke-width="1.2"/>
      <path d="M32 19 V39" stroke="#aab4bf" stroke-width="1"/>
      <path d="M5 59 L11 41 Q19 33 32 35 Q46 33 53 41 L59 59Z" fill="#7d7f86" stroke="#4b4d53" stroke-width="2"/>
      <path d="M19 45 L24 50 L22 56 M42 44 L39 50 L44 55" fill="none" stroke="#56585e" stroke-width="1.4"/>
      <path d="M14 29 L18 32 M50 29 L46 32 M32 26 V24" stroke="#f2d48a" stroke-width="1.6" stroke-linecap="round"/>`,

    dragon: `
      <path d="M28 32 L19 6 L28 13 L34 3 L39 15 L48 8 L44 30Z" fill="#2f8f63" stroke="#1d5c40" stroke-width="1.6"/>
      <path d="M7 50 C7 40 17 34 27 34 C35 34 40 30 44 23 C47 18 53 17 57 21 L61 25 L55 27 C53 34 48 40 40 44 C34 48 27 48 23 52 C31 54 40 52 47 56 C36 62 17 60 7 50Z" fill="#46b98a" stroke="#1d5c40" stroke-width="1.6"/>
      <path d="M14 40 l2 -4 2 3 M22 36 l2 -4 2 3 M30 35 l2 -4 2 3" fill="none" stroke="#1d5c40" stroke-width="1.3"/>
      <circle cx="53" cy="22" r="1.6" fill="#f2d48a"/>
      <path d="M52 19 L49 12 L55 18Z" fill="#efe3c6"/>
      <path d="M61 25 Q64 29 61 33 Q60 30 57 29Z" fill="#f08c2e"/>`,

    // ── Vikingos (Sebastian) ─────────────────────────────────────────────────
    casco_vikingo: `
      <path d="M15 35 C4 31 4 16 10 7 C12 18 16 25 23 29Z" fill="#efe3c6" stroke="#9b8a66" stroke-width="1.6"/>
      <path d="M49 35 C60 31 60 16 54 7 C52 18 48 25 41 29Z" fill="#efe3c6" stroke="#9b8a66" stroke-width="1.6"/>
      <path d="M14 43 C14 21 50 21 50 43Z" fill="#9aa4b1" stroke="#5c6672" stroke-width="2"/>
      <path d="M32 23 V41" stroke="#5c6672" stroke-width="3"/>
      <rect x="11" y="40" width="42" height="7.5" rx="2" fill="#7a5a2e" stroke="#4a3418" stroke-width="1.2"/>
      <circle cx="18" cy="43.8" r="1.4" fill="#d9b45a"/><circle cx="25" cy="43.8" r="1.4" fill="#d9b45a"/>
      <circle cx="39" cy="43.8" r="1.4" fill="#d9b45a"/><circle cx="46" cy="43.8" r="1.4" fill="#d9b45a"/>
      <rect x="29.5" y="46" width="5" height="13" rx="2" fill="#9aa4b1" stroke="#5c6672" stroke-width="1.4"/>`,

    drakkar: `
      <path d="M32 5 V41" stroke="#6b4423" stroke-width="2.5"/>
      <rect x="19" y="8" width="26" height="23" fill="#f3ead7" stroke="#b9ab8d" stroke-width="1"/>
      <rect x="23" y="8" width="5" height="23" fill="#c0392b"/><rect x="36" y="8" width="5" height="23" fill="#c0392b"/>
      <path d="M5 40 H55 Q53 52 40 54 H22 Q9 52 5 40Z" fill="#8b5a2b" stroke="#4a2c14" stroke-width="2"/>
      <path d="M53 42 Q62 35 58 25 Q56 21 51 23 Q55 27 53 31 Q51 36 49 40" fill="#8b5a2b" stroke="#4a2c14" stroke-width="2"/>
      <circle cx="55" cy="25.5" r="1.2" fill="#f2d48a"/>
      <path d="M8 42 Q2 34 8 27" fill="none" stroke="#4a2c14" stroke-width="3" stroke-linecap="round"/>
      <circle cx="15" cy="45" r="3.3" fill="#d9b45a" stroke="#4a2c14"/><circle cx="23" cy="45" r="3.3" fill="#5b9bd5" stroke="#4a2c14"/>
      <circle cx="31" cy="45" r="3.3" fill="#d9b45a" stroke="#4a2c14"/><circle cx="39" cy="45" r="3.3" fill="#5b9bd5" stroke="#4a2c14"/>
      <circle cx="47" cy="45" r="3.3" fill="#d9b45a" stroke="#4a2c14"/>
      <path d="M2 59 Q8 55.5 14 59 T26 59 T38 59 T50 59 T62 59" stroke="#6fa8dc" fill="none" stroke-width="2"/>`,

    mjolnir: `
      <rect x="9" y="10" width="46" height="23" rx="3" fill="#8d96a3" stroke="#4f5763" stroke-width="2"/>
      <path d="M9 15 H55" stroke="#a7afba" stroke-width="1.2"/>
      <path d="M19 17 V28 M19 17 L23 21 M30 17 L28 28 M30 17 L34 28 M41 17 V28 M41 22 L45 18 M41 22 L45 26" stroke="#5b9bd5" stroke-width="1.7" fill="none" stroke-linecap="round"/>
      <rect x="28" y="33" width="8" height="20" fill="#6b4423" stroke="#3f2614" stroke-width="1.2"/>
      <path d="M28 37 L36 40 M28 42 L36 45 M28 47 L36 50" stroke="#a0703f" stroke-width="1.4"/>
      <circle cx="32" cy="56" r="4" fill="#8d96a3" stroke="#4f5763" stroke-width="1.5"/>
      <path d="M58 2 L53 10 H57 L52 18" stroke="#f2d48a" fill="none" stroke-width="2" stroke-linejoin="round"/>`,

    cuervo: `
      <path d="M9 41 C15 29 25 22 35 22 C39 14 47 12 53 16 L60 18 L54 21 C54 31 48 40 38 44 L44 56 H40 L34 46 L30 47 L32 56 H28 L26 47 C18 48 12 46 9 41Z" fill="#1b1a22" stroke="#8d89a6" stroke-width="1.6"/>
      <path d="M17 38 C23 30 33 30 42 34 C34 37 26 41 17 38Z" fill="#2f2c3d" stroke="#8d89a6" stroke-width="1"/>
      <circle cx="48.5" cy="18" r="1.8" fill="#f2d48a"/>
      <path d="M8 58 L16 52 M56 58 L48 52" stroke="#5b9bd5" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>`,

    // ── Literatura (Santiago) ────────────────────────────────────────────────
    samsa: `
      <rect x="3" y="20" width="7" height="34" rx="2" fill="#7a4a24" stroke="#4a2c14" stroke-width="1.2"/>
      <rect x="55" y="33" width="6" height="21" rx="2" fill="#7a4a24" stroke="#4a2c14" stroke-width="1.2"/>
      <rect x="9" y="41" width="48" height="8" rx="2" fill="#efe3c6"/>
      <rect x="9" y="48" width="48" height="5" fill="#7a4a24"/>
      <ellipse cx="16" cy="38.5" rx="6" ry="3.6" fill="#ffffff"/>
      <g stroke="#3e1f0d" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M24 32 l-3 -7 l-3 -2"/><path d="M29 30 l-1 -9 l-3 -3"/><path d="M34 30 l1 -9 l-2 -4"/>
        <path d="M39 31 l3 -8 l1 -3"/><path d="M44 33 l4 -6 l3 -1"/><path d="M27 31 l-6 -4"/>
        <path d="M15 35 q-6 -9 -3 -16"/><path d="M17 34 q-1 -10 5 -14"/>
      </g>
      <ellipse cx="33" cy="37" rx="14" ry="6.2" fill="#5a2e14" stroke="#3e1f0d" stroke-width="1.2"/>
      <path d="M26 33 V41 M31 31.5 V42.5 M36 31.5 V42.5 M41 33 V41" stroke="#7a4426" stroke-width="1.3"/>
      <circle cx="18.5" cy="36" r="4" fill="#3e1f0d"/>
      <path d="M40 37 Q48 33 58 37 L58 46 L40 46 Q37 41 40 37Z" fill="#6f8fbf" stroke="#4a6690" stroke-width="1.2"/>`,

    sisifo: `
      <path d="M1 61 L63 19 L63 63 L1 63Z" fill="#7d6b52" stroke="#4f4334" stroke-width="1.5"/>
      <circle cx="37" cy="22" r="12.5" fill="#a8a29a" stroke="#5b554d" stroke-width="2"/>
      <path d="M31 16 l4 4 -2 5 M41 27 l3 -3" fill="none" stroke="#6e6861" stroke-width="1.4"/>
      <g stroke="#f3ead7" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <path d="M18 43 L23 34"/>
        <path d="M23 35 L27 31 M22.5 36.5 L26 34"/>
        <path d="M18 43 L12 51 M18 43 L20 49"/>
      </g>
      <circle cx="25" cy="30" r="3.2" fill="#f3ead7"/>
      <path d="M6 58 Q10 54 14 57" stroke="#5e5040" stroke-width="1.2" fill="none"/>`,

    lupin: `
      <ellipse cx="30" cy="46" rx="25" ry="6.5" fill="#141217" stroke="#cfc6b2" stroke-width="1.4"/>
      <path d="M17 46 L19 13 Q30 9 41 13 L43 46Z" fill="#1d1a22" stroke="#cfc6b2" stroke-width="1.4"/>
      <ellipse cx="30" cy="13" rx="11" ry="3" fill="#2a2630" stroke="#cfc6b2" stroke-width="1.2"/>
      <rect x="18" y="36" width="24" height="6" fill="#8a1f33"/>
      <path d="M23 16 L22 33" stroke="#3a3542" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="51" cy="53" r="7" fill="rgba(200,230,255,0.22)" stroke="#d9b45a" stroke-width="2.4"/>
      <path d="M45 50 Q38 56 31 58" stroke="#d9b45a" fill="none" stroke-width="1.3"/>`,

    feto: `
      <path d="M25 4 H39 V9 H37 V19 C48 23 53 31 53 41 C53 53 44 60 32 60 C20 60 11 53 11 41 C11 31 16 23 27 19 V9 H25Z" fill="rgba(160,210,230,0.16)" stroke="#bfe3ef" stroke-width="2"/>
      <path d="M13 34 C21 31 43 31 51 34 C53 38 53 41 53 41 C53 53 44 58 32 58 C20 58 11 53 11 41 C11 38 12 36 13 34Z" fill="rgba(110,200,170,0.35)"/>
      <path d="M30 41 Q21 46 26 53 Q34 58 40 50 Q43 45 39 42" fill="#eaa593" stroke="#c27b6b" stroke-width="1.2"/>
      <circle cx="35" cy="38" r="7" fill="#f0b5a4" stroke="#c27b6b" stroke-width="1.2"/>
      <path d="M36.5 37 q2 1.4 3.5 0" stroke="#8a4a3e" stroke-width="1.1" fill="none"/>
      <path d="M28 50 Q21 40 27 24 Q29 18 32 14" stroke="#d98b7a" stroke-width="1.6" fill="none"/>
      <text x="32" y="8.3" text-anchor="middle" font-size="6" font-family="Georgia,serif" font-weight="700" fill="#d9b45a">α</text>`,

    marranito: `
      <path d="M13 20 L20 5 L29 17Z" fill="#f2a1b3" stroke="#c97a8d" stroke-width="1.6"/>
      <path d="M51 20 L44 5 L35 17Z" fill="#f2a1b3" stroke="#c97a8d" stroke-width="1.6"/>
      <circle cx="32" cy="35" r="22" fill="#f6b8c6" stroke="#c97a8d" stroke-width="2"/>
      <ellipse cx="32" cy="42" rx="10.5" ry="7.5" fill="#ee93a8" stroke="#c97a8d" stroke-width="1.6"/>
      <ellipse cx="28" cy="42" rx="2" ry="3" fill="#9b4b5e"/><ellipse cx="36" cy="42" rx="2" ry="3" fill="#9b4b5e"/>
      <circle cx="23.5" cy="29" r="2.8" fill="#2b1b1f"/><circle cx="40.5" cy="29" r="2.8" fill="#2b1b1f"/>
      <circle cx="24.4" cy="28" r="0.9" fill="#fff"/><circle cx="41.4" cy="28" r="0.9" fill="#fff"/>
      <path d="M48 52 V62 M48 52 H58 V57 H48" stroke="#2f6b3c" stroke-width="1.6" fill="#3f8f50"/>`
  };

  const svgCache = {};
  function svg(art) {
    if (!ART[art]) return null;
    if (!svgCache[art]) {
      svgCache[art] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">${ART[art]}</svg>`;
    }
    return svgCache[art];
  }

  // <span class="token-art"> con el dibujo (o el emoji de respaldo)
  function node(skin, size = '', color = '') {
    const span = document.createElement('span');
    span.className = `token-art ${size}`.trim();
    if (color) span.style.setProperty('--tc', color);
    const markup = skin && svg(skin.art);
    if (markup) {
      span.innerHTML = markup;            // contenido estático de este archivo
    } else {
      const e = document.createElement('span');
      e.className = 'token-emoji';
      e.textContent = (skin && skin.icon) || '●';
      span.append(e);
    }
    if (skin && skin.name) span.title = skin.name;
    return span;
  }

  // Imagen para el canvas (se carga una sola vez por dibujo)
  const imgCache = {};
  function image(art) {
    if (!ART[art]) return null;
    if (!imgCache[art]) {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(art));
      imgCache[art] = img;
    }
    return imgCache[art].complete ? imgCache[art] : null;
  }

  window.Tokens = { svg, node, image, has: (art) => !!ART[art], arts: Object.keys(ART) };
})();
