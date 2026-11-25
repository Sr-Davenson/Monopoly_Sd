// ─────────────────────────────────────────────────────────────────────────────
// TEMÁTICAS, FICHAS, DADOS Y MISIONES DE DESBLOQUEO
//
// Cada integrante tiene una temática con:
//   - 6 FICHAS: una inicial (`starter: true`) y cinco que se desbloquean.
//   - 4 DADOS temáticos que también se desbloquean (además del dado clásico,
//     que siempre está disponible).
//
// Reglas de desbloqueo ("un grupo a la vez"):
//   1. El jugador elige en el lobby qué temática está LIBERANDO (su "grupo en
//      liberación"). Las estadísticas de cada partida cuentan para ese grupo.
//      Si nunca eligió, cuenta la temática con la que jugó la partida.
//   2. Dentro de un grupo, fichas y dados se liberan EN ORDEN: cada uno exige
//      su misión y que el anterior de la lista ya esté liberado.
//
// El progreso lo guarda el auth-service (contadores por temática) y lo
// actualizan los coordinadores al terminar cada partida.
//
// `art` es el id del dibujo SVG de la ficha (client/tokens.js); `icon` es un
// emoji de respaldo. `style` describe el aspecto de cada dado.
// ─────────────────────────────────────────────────────────────────────────────

const RARITIES = {
  common:    { label: 'Común' },
  rare:      { label: 'Rara' },
  epic:      { label: 'Épica' },
  legendary: { label: 'Legendaria' }
};

// Estadísticas que cuentan para las misiones (las acumula el auth-service).
const STATS = {
  gamesPlayed:      'partidas jugadas',
  gamesWon:         'partidas ganadas',
  propertiesBought: 'propiedades compradas',
  buildingsBuilt:   'casas u hoteles construidos',
  hotelsBuilt:      'hoteles construidos',
  rentCollected:    'renta cobrada',
  tradesDone:       'intercambios cerrados',
  cardsDrawn:       'tarjetas tomadas',
  jailVisits:       'visitas al calabozo',
  lapsCompleted:    'vueltas al tablero',
  potWins:          'veces que te llevaste el Fondo',
  doublesRolled:    'dobles sacados',
  groupsCompleted:  'grupos de color completados'
};

const mission = (stat, count, text) => ({ stat, count, text });

// Dado por defecto: siempre disponible
const DEFAULT_DICE = {
  id: 'dado_clasico', name: 'Dado clásico', rarity: 'common', starter: true,
  style: { face: ['#fbf5e6', '#e8dcc0'], pip: '#2a1e10', edge: '#b8995a', glow: 'rgba(0,0,0,0)', mark: '' }
};

const THEMES = [
  {
    id: 'tema_david',
    memberId: 'david',
    name: 'Una Galaxia Muy, Muy Lejana',
    description: 'Cantinas de mala fama, templos Jedi y la flota imperial: que la Fuerza acompañe a tus inversiones.',
    skins: [
      { id: 'david_vader',    art: 'casco_vader',     icon: '⚫', name: 'Casco de Darth Vader',            rarity: 'common', starter: true },
      { id: 'david_tie',      art: 'caza_tie',        icon: '🛸', name: 'Caza TIE Imperial',               rarity: 'rare',
        unlock: mission('gamesPlayed', 3, 'Juega 3 partidas') },
      { id: 'david_rex',      art: 'casco_rex',       icon: '🪖', name: 'Casco del Capitán Rex (Fase II)', rarity: 'rare',
        unlock: mission('propertiesBought', 12, 'Compra 12 propiedades') },
      { id: 'david_xwing',    art: 'caza_xwing',      icon: '🚀', name: 'Caza Ala-X',                      rarity: 'epic',
        unlock: mission('lapsCompleted', 15, 'Da 15 vueltas al tablero (pasa por Salida)') },
      { id: 'david_boba',     art: 'casco_boba',      icon: '🎯', name: 'Casco de Boba Fett',              rarity: 'epic',
        unlock: mission('rentCollected', 4000, 'Cobra 4.000 en rentas (cazarrecompensas)') },
      { id: 'david_estrella', art: 'estrella_muerte', icon: '🌑', name: 'Estrella de la Muerte',           rarity: 'legendary',
        unlock: mission('gamesWon', 4, 'Gana 4 partidas') }
    ],
    dice: [
      { id: 'dado_holocron', name: 'Dado Holocrón', rarity: 'rare',
        style: { face: ['#1b3a5c', '#0b1a2e'], pip: '#7fd3ff', edge: '#3d8bd1', glow: 'rgba(127,211,255,.55)', mark: '◈' },
        unlock: mission('doublesRolled', 10, 'Saca 10 dobles') },
      { id: 'dado_kyber', name: 'Dado de Cristal Kyber', rarity: 'rare',
        style: { face: ['#e9fff1', '#a8f0c6'], pip: '#0f6b3c', edge: '#46d58b', glow: 'rgba(70,213,139,.6)', mark: '✦' },
        unlock: mission('cardsDrawn', 15, 'Toma 15 tarjetas') },
      { id: 'dado_sith', name: 'Dado Sith', rarity: 'epic',
        style: { face: ['#2a0a0d', '#0d0204'], pip: '#ff3b3b', edge: '#8f1111', glow: 'rgba(255,59,59,.65)', mark: '⚔' },
        unlock: mission('jailVisits', 5, 'Visita el calabozo 5 veces') },
      { id: 'dado_beskar', name: 'Dado de Beskar', rarity: 'legendary',
        style: { face: ['#e3e7ec', '#8a939e'], pip: '#1c2128', edge: '#5d6670', glow: 'rgba(227,231,236,.6)', mark: '⛉' },
        unlock: mission('groupsCompleted', 4, 'Completa 4 grupos de color') }
    ]
  },
  {
    id: 'tema_jossef',
    memberId: 'jossef',
    name: 'Reinos de Fantasía',
    description: 'Magia artúrica, bosques feéricos y un dragón que vigila su tesoro.',
    skins: [
      { id: 'jossef_pocion',    art: 'pocion',        icon: '🧪', name: 'Poción Arcana',            rarity: 'common', starter: true },
      { id: 'jossef_sombrero',  art: 'sombrero_mago', icon: '🧙', name: 'Sombrero de Merlín',       rarity: 'rare',
        unlock: mission('gamesPlayed', 3, 'Juega 3 partidas') },
      { id: 'jossef_unicornio', art: 'unicornio',     icon: '🦄', name: 'Unicornio de Brocelianda', rarity: 'rare',
        unlock: mission('cardsDrawn', 12, 'Toma 12 tarjetas') },
      { id: 'jossef_espada',    art: 'espada_piedra', icon: '🗡', name: 'Espada en la Piedra',      rarity: 'epic',
        unlock: mission('buildingsBuilt', 15, 'Construye 15 casas u hoteles') },
      { id: 'jossef_grial',     art: 'grial',         icon: '🏆', name: 'Santo Grial',              rarity: 'epic',
        unlock: mission('potWins', 3, 'Llévate el Fondo de Donaciones 3 veces') },
      { id: 'jossef_dragon',    art: 'dragon',        icon: '🐉', name: 'Dragón Ancestral',         rarity: 'legendary',
        unlock: mission('gamesWon', 4, 'Gana 4 partidas') }
    ],
    dice: [
      { id: 'dado_runas_elficas', name: 'Dado de Runas Élficas', rarity: 'rare',
        style: { face: ['#f4f1df', '#d8e9c8'], pip: '#2f6b3a', edge: '#7cb36a', glow: 'rgba(124,179,106,.55)', mark: '❦' },
        unlock: mission('lapsCompleted', 10, 'Da 10 vueltas al tablero') },
      { id: 'dado_cristal_feerico', name: 'Dado de Cristal Feérico', rarity: 'rare',
        style: { face: ['#f6e8ff', '#c9a7f5'], pip: '#5b2a86', edge: '#a46de0', glow: 'rgba(196,140,255,.65)', mark: '✧' },
        unlock: mission('tradesDone', 4, 'Cierra 4 intercambios') },
      { id: 'dado_escamas', name: 'Dado de Escamas de Dragón', rarity: 'epic',
        style: { face: ['#7a1f12', '#3b0c06'], pip: '#ffcf5a', edge: '#c2541b', glow: 'rgba(255,140,40,.65)', mark: '♨' },
        unlock: mission('rentCollected', 3000, 'Cobra 3.000 en rentas') },
      { id: 'dado_avalon', name: 'Dado de Avalon', rarity: 'legendary',
        style: { face: ['#fff8dc', '#f0d77a'], pip: '#6b4a00', edge: '#d9b45a', glow: 'rgba(242,212,138,.75)', mark: '♛' },
        unlock: mission('hotelsBuilt', 3, 'Construye 3 hoteles') }
    ]
  },
  {
    id: 'tema_sebastian',
    memberId: 'sebastian',
    name: 'Saga Vikinga',
    description: 'Saquea monasterios, cruza el Bifröst y gánate un lugar en el Valhalla.',
    skins: [
      { id: 'sebastian_casco',   art: 'casco_vikingo', icon: '⛑', name: 'Casco del Jarl',  rarity: 'common', starter: true },
      { id: 'sebastian_drakkar', art: 'drakkar',       icon: '⛵', name: 'Drakkar',         rarity: 'rare',
        unlock: mission('gamesPlayed', 3, 'Juega 3 partidas') },
      { id: 'sebastian_escudo',  art: 'escudo_runico', icon: '🛡', name: 'Escudo Rúnico',   rarity: 'rare',
        unlock: mission('tradesDone', 3, 'Cierra 3 intercambios') },
      { id: 'sebastian_mjolnir', art: 'mjolnir',       icon: '🔨', name: 'Mjölnir',         rarity: 'epic',
        unlock: mission('hotelsBuilt', 3, 'Construye 3 hoteles') },
      { id: 'sebastian_fenrir',  art: 'fenrir',        icon: '🐺', name: 'Lobo Fenrir',     rarity: 'epic',
        unlock: mission('jailVisits', 6, 'Visita el calabozo 6 veces (Fenrir también fue encadenado)') },
      { id: 'sebastian_cuervo',  art: 'cuervo',        icon: '🐦', name: 'Cuervo de Odín',  rarity: 'legendary',
        unlock: mission('gamesWon', 4, 'Gana 4 partidas') }
    ],
    dice: [
      { id: 'dado_hueso', name: 'Dado de Hueso Tallado', rarity: 'rare',
        style: { face: ['#efe6d2', '#c9b994'], pip: '#3b2a16', edge: '#8a7550', glow: 'rgba(201,185,148,.5)', mark: 'ᚠ' },
        unlock: mission('doublesRolled', 12, 'Saca 12 dobles') },
      { id: 'dado_hielo', name: 'Dado de Hielo de Niflheim', rarity: 'rare',
        style: { face: ['#e8f6ff', '#9fd3f2'], pip: '#0d4a73', edge: '#5b9bd5', glow: 'rgba(159,211,242,.7)', mark: 'ᛁ' },
        unlock: mission('propertiesBought', 10, 'Compra 10 propiedades') },
      { id: 'dado_yggdrasil', name: 'Dado de Yggdrasil', rarity: 'epic',
        style: { face: ['#4a3a22', '#2a1f10'], pip: '#a8e07a', edge: '#6f8f3a', glow: 'rgba(168,224,122,.55)', mark: 'ᛉ' },
        unlock: mission('potWins', 2, 'Llévate el Fondo de Donaciones 2 veces') },
      { id: 'dado_valhalla', name: 'Dado del Valhalla', rarity: 'legendary',
        style: { face: ['#ffe9a8', '#d4a017'], pip: '#4a1d00', edge: '#a87a0c', glow: 'rgba(255,215,90,.75)', mark: 'ᛟ' },
        unlock: mission('groupsCompleted', 3, 'Completa 3 grupos de color') }
    ]
  },
  {
    id: 'tema_santiago',
    memberId: 'santiago',
    name: 'Mundos de Papel',
    description: 'Fichas salidas de los libros: Kafka, Camus, Leblanc, Huxley y Orwell.',
    skins: [
      { id: 'santiago_samsa',     art: 'samsa',     icon: '🪳', name: 'Gregorio Samsa en su cama',         rarity: 'common', starter: true },
      { id: 'santiago_marranito', art: 'marranito', icon: '🐖', name: 'Marranito de Rebelión en la granja', rarity: 'rare',
        unlock: mission('gamesPlayed', 3, 'Juega 3 partidas') },
      { id: 'santiago_mariposas', art: 'mariposas', icon: '🦋', name: 'Mariposas amarillas de Macondo',    rarity: 'rare',
        unlock: mission('lapsCompleted', 12, 'Da 12 vueltas al tablero') },
      { id: 'santiago_lupin',     art: 'lupin',     icon: '🎩', name: 'Sombrero de Arsène Lupin',          rarity: 'epic',
        unlock: mission('rentCollected', 5000, 'Cobra 5.000 en rentas (un ladrón de guante blanco)') },
      { id: 'santiago_sisifo',    art: 'sisifo',    icon: '🪨', name: 'Sísifo y su piedra',                rarity: 'epic',
        unlock: mission('gamesPlayed', 10, 'Juega 10 partidas (hay que imaginarlo feliz)') },
      { id: 'santiago_feto',      art: 'feto',      icon: '🧬', name: 'Feto de Un mundo feliz',            rarity: 'legendary',
        unlock: mission('gamesWon', 4, 'Gana 4 partidas') }
    ],
    dice: [
      { id: 'dado_maquina', name: 'Dado de Máquina de Escribir', rarity: 'rare',
        style: { face: ['#2b2b2b', '#111111'], pip: '#f3ead7', edge: '#6b6b6b', glow: 'rgba(243,234,215,.35)', mark: '¶' },
        unlock: mission('cardsDrawn', 12, 'Toma 12 tarjetas') },
      { id: 'dado_tinta', name: 'Dado de Tinta China', rarity: 'rare',
        style: { face: ['#f7f1e3', '#e6dcc4'], pip: '#101828', edge: '#3a3a5a', glow: 'rgba(58,58,90,.45)', mark: '✒' },
        unlock: mission('buildingsBuilt', 10, 'Construye 10 casas u hoteles') },
      { id: 'dado_proceso', name: 'Dado de El Proceso', rarity: 'epic',
        style: { face: ['#d9d2c0', '#a69c84'], pip: '#3a1010', edge: '#6b5a3a', glow: 'rgba(107,90,58,.5)', mark: '§' },
        unlock: mission('jailVisits', 4, 'Visita el calabozo 4 veces') },
      { id: 'dado_macondo', name: 'Dado Dorado de Macondo', rarity: 'legendary',
        style: { face: ['#fff3a8', '#f2c94c'], pip: '#7a4b00', edge: '#c58b4f', glow: 'rgba(242,201,76,.75)', mark: '❀' },
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

// Dado por id (el clásico o uno de cualquier temática) → { dice, theme }
function findDice(diceId) {
  if (!diceId || diceId === DEFAULT_DICE.id) return { dice: DEFAULT_DICE, theme: null };
  for (const t of THEMES) {
    const d = t.dice.find(x => x.id === diceId);
    if (d) return { dice: d, theme: t };
  }
  return null;
}

// Valor de una estadística en el grupo de una temática.
//   progress = { stats: {...globales}, themes: { tema_x: {...} } }
function statOf(progress, themeId, stat) {
  const v = progress && progress.themes && progress.themes[themeId] && progress.themes[themeId][stat];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

// ¿Está liberado el elemento `index` de la lista (fichas o dados) del grupo?
// Exige su misión y que el anterior de la lista ya esté liberado.
function isItemUnlocked(theme, list, index, progress) {
  const item = list[index];
  if (!item) return false;
  if (item.starter || !item.unlock) return true;
  if (index > 0 && !isItemUnlocked(theme, list, index - 1, progress)) return false;
  return statOf(progress, theme.id, item.unlock.stat) >= item.unlock.count;
}

function isSkinUnlocked(theme, skin, progress) {
  return isItemUnlocked(theme, theme.skins, theme.skins.indexOf(skin), progress);
}

function isDiceUnlocked(diceId, progress) {
  const found = findDice(diceId);
  if (!found) return false;
  if (!found.theme) return true;
  return isItemUnlocked(found.theme, found.theme.dice, found.theme.dice.indexOf(found.dice), progress);
}

module.exports = {
  THEMES, RARITIES, STATS, DEFAULT_DICE,
  findTheme, findSkin, starterSkin, findDice, statOf, isItemUnlocked, isSkinUnlocked, isDiceUnlocked
};
