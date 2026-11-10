// ─────────────────────────────────────────────────────────────────────────────
// TEMÁTICAS, FICHAS Y MISIONES DE DESBLOQUEO
//
// Cada integrante tiene una temática. Al unirse a una sala, el jugador escoge
// su temática y una ficha de esa temática:
//   - La ficha inicial (`starter: true`) está disponible desde el principio.
//   - Las demás se desbloquean cumpliendo MISIONES ("Juega 3 partidas",
//     "Gana 1 partida", "Compra 10 propiedades"...).
//
// El progreso de cada usuario lo guarda el auth-service (tabla user_stats) y
// lo actualizan los coordinadores al terminar cada partida.
//
// `art` es el id del dibujo SVG de la ficha (client/tokens.js); `icon` es un
// emoji de respaldo por si el dibujo no está disponible.
// ─────────────────────────────────────────────────────────────────────────────

const RARITIES = {
  common:    { label: 'Común' },
  rare:      { label: 'Rara' },
  epic:      { label: 'Épica' },
  legendary: { label: 'Legendaria' }
};

// Estadísticas que cuentan para las misiones (las acumula el auth-service).
const STATS = {
  gamesPlayed:       'partidas jugadas',
  gamesWon:          'partidas ganadas',
  propertiesBought:  'propiedades compradas',
  buildingsBuilt:    'casas u hoteles construidos'
};

const mission = (stat, count, text) => ({ stat, count, text });

const THEMES = [
  {
    id: 'tema_david',
    memberId: 'david',
    name: 'Corsarios del Caribe',
    description: 'Navega entre islas malditas, entierra tesoros y cobra como un verdadero bucanero.',
    skins: [
      { id: 'david_sombrero', art: 'sombrero_pirata', icon: '☠', name: 'Sombrero Pirata',    rarity: 'common', starter: true },
      { id: 'david_mapa',     art: 'mapa_tesoro',     icon: '🗺', name: 'Mapa del Tesoro',    rarity: 'rare',
        unlock: mission('gamesPlayed', 1, 'Juega 1 partida completa') },
      { id: 'david_garfio',   art: 'garfio',          icon: '🪝', name: 'Garfio del Capitán', rarity: 'epic',
        unlock: mission('propertiesBought', 8, 'Compra 8 propiedades') },
      { id: 'david_calavera', art: 'calavera',        icon: '💀', name: 'Calavera y Tibias',  rarity: 'legendary',
        unlock: mission('gamesWon', 1, 'Gana 1 partida') }
    ]
  },
  {
    id: 'tema_jossef',
    memberId: 'jossef',
    name: 'Reinos de Fantasía',
    description: 'Magia artúrica, bosques feéricos y un dragón que vigila su tesoro.',
    skins: [
      { id: 'jossef_pocion',  art: 'pocion',          icon: '🧪', name: 'Poción Arcana',       rarity: 'common', starter: true },
      { id: 'jossef_sombrero', art: 'sombrero_mago',  icon: '🧙', name: 'Sombrero de Merlín',  rarity: 'rare',
        unlock: mission('gamesPlayed', 2, 'Juega 2 partidas completas') },
      { id: 'jossef_espada',  art: 'espada_piedra',   icon: '🗡', name: 'Espada en la Piedra', rarity: 'epic',
        unlock: mission('buildingsBuilt', 5, 'Construye 5 casas u hoteles') },
      { id: 'jossef_dragon',  art: 'dragon',          icon: '🐉', name: 'Dragón Ancestral',    rarity: 'legendary',
        unlock: mission('gamesWon', 2, 'Gana 2 partidas') }
    ]
  },
  {
    id: 'tema_sebastian',
    memberId: 'sebastian',
    name: 'Saga Vikinga',
    description: 'Saquea monasterios, cruza el Bifröst y gánate un lugar en el Valhalla.',
    skins: [
      { id: 'sebastian_casco',   art: 'casco_vikingo', icon: '⛑', name: 'Casco del Jarl',  rarity: 'common', starter: true },
      { id: 'sebastian_drakkar', art: 'drakkar',       icon: '⛵', name: 'Drakkar',          rarity: 'rare',
        unlock: mission('gamesPlayed', 2, 'Juega 2 partidas completas') },
      { id: 'sebastian_mjolnir', art: 'mjolnir',       icon: '🔨', name: 'Mjölnir',          rarity: 'epic',
        unlock: mission('buildingsBuilt', 6, 'Construye 6 casas u hoteles') },
      { id: 'sebastian_cuervo',  art: 'cuervo',        icon: '🐦', name: 'Cuervo de Odín',   rarity: 'legendary',
        unlock: mission('gamesWon', 1, 'Gana 1 partida') }
    ]
  },
  {
    id: 'tema_santiago',
    memberId: 'santiago',
    name: 'Mundos de Papel',
    description: 'Fichas salidas de los libros: Kafka, Camus, Leblanc, Huxley y Orwell.',
    skins: [
      { id: 'santiago_samsa',     art: 'samsa',      icon: '🪳', name: 'Gregorio Samsa en su cama',         rarity: 'common', starter: true },
      { id: 'santiago_marranito', art: 'marranito',  icon: '🐖', name: 'Marranito de Rebelión en la granja', rarity: 'rare',
        unlock: mission('gamesPlayed', 1, 'Juega 1 partida completa') },
      { id: 'santiago_lupin',     art: 'lupin',      icon: '🎩', name: 'Sombrero de Arsène Lupin',          rarity: 'epic',
        unlock: mission('propertiesBought', 10, 'Compra 10 propiedades') },
      { id: 'santiago_sisifo',    art: 'sisifo',     icon: '🪨', name: 'Sísifo y su piedra',                rarity: 'epic',
        unlock: mission('gamesPlayed', 5, 'Juega 5 partidas (hay que imaginarlo feliz)') },
      { id: 'santiago_feto',      art: 'feto',       icon: '🧬', name: 'Feto de Un mundo feliz',            rarity: 'legendary',
        unlock: mission('gamesWon', 2, 'Gana 2 partidas') }
    ]
  }
];

function findTheme(themeId) {
  return THEMES.find(t => t.id === themeId) || null;
}

function starterSkin(theme) {
  return theme.skins.find(s => s.starter) || theme.skins[0];
}

function findSkin(theme, skinId) {
  return theme.skins.find(s => s.id === skinId) || null;
}

// ¿El usuario con estas estadísticas ya desbloqueó la ficha?
function isUnlocked(skin, stats) {
  if (skin.starter || !skin.unlock) return true;
  const value = stats && Number(stats[skin.unlock.stat]);
  return Number.isFinite(value) && value >= skin.unlock.count;
}

module.exports = { THEMES, RARITIES, STATS, findTheme, findSkin, starterSkin, isUnlocked };
