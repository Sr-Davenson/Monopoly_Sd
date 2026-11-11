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
    name: 'Una Galaxia Muy, Muy Lejana',
    description: 'Cantinas de mala fama, templos Jedi y la flota imperial: que la Fuerza acompañe a tus inversiones.',
    skins: [
      { id: 'david_vader',    art: 'casco_vader',     icon: '⚫', name: 'Casco de Darth Vader',            rarity: 'common', starter: true },
      { id: 'david_tie',      art: 'caza_tie',        icon: '🛸', name: 'Caza TIE Imperial',               rarity: 'rare',
        unlock: mission('gamesPlayed', 1, 'Juega 1 partida completa') },
      { id: 'david_rex',      art: 'casco_rex',       icon: '🪖', name: 'Casco del Capitán Rex (Fase II)', rarity: 'rare',
        unlock: mission('propertiesBought', 6, 'Compra 6 propiedades') },
      { id: 'david_xwing',    art: 'caza_xwing',      icon: '🚀', name: 'Caza Ala-X',                      rarity: 'epic',
        unlock: mission('gamesPlayed', 3, 'Juega 3 partidas completas') },
      { id: 'david_boba',     art: 'casco_boba',      icon: '🎯', name: 'Casco de Boba Fett',              rarity: 'epic',
        unlock: mission('buildingsBuilt', 5, 'Construye 5 casas u hoteles') },
      { id: 'david_estrella', art: 'estrella_muerte', icon: '🌑', name: 'Estrella de la Muerte',           rarity: 'legendary',
        unlock: mission('gamesWon', 2, 'Gana 2 partidas') }
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
      { id: 'jossef_unicornio', art: 'unicornio',     icon: '🦄', name: 'Unicornio de Brocelianda', rarity: 'rare',
        unlock: mission('propertiesBought', 6, 'Compra 6 propiedades') },
      { id: 'jossef_grial',   art: 'grial',           icon: '🏆', name: 'Santo Grial',         rarity: 'epic',
        unlock: mission('gamesPlayed', 4, 'Juega 4 partidas completas') },
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
      { id: 'sebastian_escudo',  art: 'escudo_runico', icon: '🛡', name: 'Escudo Rúnico',    rarity: 'rare',
        unlock: mission('propertiesBought', 6, 'Compra 6 propiedades') },
      { id: 'sebastian_fenrir',  art: 'fenrir',        icon: '🐺', name: 'Lobo Fenrir',      rarity: 'epic',
        unlock: mission('gamesPlayed', 4, 'Juega 4 partidas completas') },
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
      { id: 'santiago_mariposas', art: 'mariposas', icon: '🦋', name: 'Mariposas amarillas de Macondo',    rarity: 'rare',
        unlock: mission('propertiesBought', 6, 'Compra 6 propiedades') },
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
