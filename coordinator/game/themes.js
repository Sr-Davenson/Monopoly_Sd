// ─────────────────────────────────────────────────────────────────────────────
// PLANTILLA DE TEMÁTICAS, SKINS (FICHAS) Y CAJAS
//
// Cada integrante tiene una temática. Al unirse a una partida, el jugador
// escoge con qué temática inicia, y recibe la ficha inicial (`starter: true`)
// de esa temática. Solo se elige al inicio; no se cambia durante la partida.
//
// Las demás skins se obtienen abriendo cajas (lootboxes). La apertura de cajas
// y el inventario de cada usuario aún NO están implementados: necesitan
// persistencia en base de datos. Esta plantilla define el contenido para que
// cada integrante complete el suyo.
//
// Para completar tu temática:
//   - name / description     → nombre y descripción de tu temática
//   - skins[].name / icon    → nombre e ícono (emoji o, más adelante, ruta a imagen)
//   - box.name / box.price   → nombre y precio de tu caja (moneda meta, por definir)
// ─────────────────────────────────────────────────────────────────────────────

const RARITIES = {
  common:    { label: 'Común',     weight: 70 },
  rare:      { label: 'Rara',      weight: 25 },
  epic:      { label: 'Épica',     weight: 5  }
};

function themeTemplate(memberId, memberName, icons) {
  return {
    id: `tema_${memberId}`,
    memberId,
    name: `[Temática de ${memberName}]`,
    description: `[Descripción de la temática de ${memberName} por definir]`,
    skins: [
      { id: `${memberId}_ficha_1`, name: `[Ficha inicial de ${memberName}]`, icon: icons[0], rarity: 'common', starter: true },
      { id: `${memberId}_ficha_2`, name: `[Ficha común de ${memberName}]`,   icon: icons[1], rarity: 'common' },
      { id: `${memberId}_ficha_3`, name: `[Ficha rara de ${memberName}]`,    icon: icons[2], rarity: 'rare' },
      { id: `${memberId}_ficha_4`, name: `[Ficha épica de ${memberName}]`,   icon: icons[3], rarity: 'epic' }
    ],
    box: {
      id: `caja_${memberId}`,
      name: `[Caja de ${memberName}]`,
      price: null, // por definir
      // Probabilidad de cada rareza al abrir (suma 100)
      odds: Object.fromEntries(Object.entries(RARITIES).map(([k, r]) => [k, r.weight]))
    }
  };
}

// Íconos provisionales (se reemplazan por los de cada temática)
const THEMES = [
  themeTemplate('david',     'David',     ['▲', '△', '⬟', '★']),
  themeTemplate('jossef',    'Jossef',    ['■', '□', '⬢', '✦']),
  themeTemplate('sebastian', 'Sebastian', ['●', '○', '◉', '✪']),
  themeTemplate('santiago',  'Santiago',  ['◆', '◇', '❖', '✸'])
];

function findTheme(themeId) {
  return THEMES.find(t => t.id === themeId) || null;
}

function starterSkin(theme) {
  return theme.skins.find(s => s.starter) || theme.skins[0];
}

module.exports = { THEMES, RARITIES, findTheme, starterSkin };
