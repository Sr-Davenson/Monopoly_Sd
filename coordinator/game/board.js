// ─────────────────────────────────────────────────────────────────────────────
// Tablero: 40 casillas. Las 4 esquinas son fijas y cada lado (9 casillas)
// pertenece a un integrante y a su mundo.
//
// Estructura de cada lado (k = posición dentro del lado, 1..9):
//   k1 Propiedad (grupo A)      k6 Propiedad (grupo B)
//   k2 Tarjeta General          k7 Tarjeta Especial (lados 0 y 2) / Servicio (lados 1 y 3)
//   k3 Propiedad (grupo A)      k8 Propiedad (grupo B)
//   k4 Donación                 k9 Propiedad (grupo B)
//   k5 Transporte
//
// Todos los lados tienen la misma estructura para que cada integrante tenga
// una sección equivalente. Solo cambian los precios (más caros al avanzar).
// Los nombres de cada lado están en WORLDS (uno por integrante).
// ─────────────────────────────────────────────────────────────────────────────

const economy = require('./economy');
const { MEMBERS } = require('./members');

const SPACE = Object.freeze({
  START:        'start',
  JAIL:         'jail',
  REST:         'rest',          // "Taberna": cobra el Fondo de Donaciones
  GO_TO_JAIL:   'go_to_jail',
  PROPERTY:     'property',
  TRANSPORT:    'transport',
  SERVICE:      'service',
  CARD_GENERAL: 'card_general',
  CARD_SPECIAL: 'card_special',
  DONATION:     'donation'
});

const JAIL_POSITION  = 10;
const BOARD_SIZE     = 40;

// Dos tonos por integrante: grupo A y grupo B.
const GROUP_COLORS = [
  '#d94841', '#f08c2e', // David     — Piratas    (rojo bandera, naranja ron)
  '#34b37a', '#8b6be0', // Jossef    — Fantasía   (esmeralda, amatista)
  '#6fa8dc', '#3b6fb6', // Sebastian — Vikingos   (hielo, fiordo profundo)
  '#c08a4a', '#a3456b'  // Santiago  — Literatura (sepia, borgoña)
];

const CORNERS = [
  { type: SPACE.START,      name: 'Salida',             icon: '⚑' },
  { type: SPACE.JAIL,       name: 'Calabozo',           icon: '⛓' },
  { type: SPACE.REST,       name: 'Taberna (Descanso)', icon: '🍺' },
  { type: SPACE.GO_TO_JAIL, name: 'Ve al Calabozo',     icon: '⚔' }
];

// Nombres de cada lado. Orden de las propiedades: A1, A2, B1, B2, B3.
const WORLDS = [
  { // David — Piratas
    groupA: 'Puertos Libres',
    groupB: 'Islas Malditas',
    props: [
      { name: 'Isla Tortuga',                 icon: '🐢' },
      { name: 'Bahía de Cartagena de Indias', icon: '🏰' },
      { name: 'Port Royal',                   icon: '⚓' },
      { name: 'Isla Calavera',                icon: '💀' },
      { name: 'Isla del Tesoro de Flint',     icon: '💰' }
    ],
    transport: { name: "Galeón Queen Anne's Revenge", icon: '⛵' },
    donation:  'el Cofre de Davy Jones'
  },
  { // Jossef — Fantasía
    groupA: 'Bosques Feéricos',
    groupB: 'Reinos de Leyenda',
    props: [
      { name: 'Bosque de Brocelianda',  icon: '🌲' },
      { name: 'Árbol de los Elfos',     icon: '🌳' },
      { name: 'Torre de Merlín',        icon: '🔮' },
      { name: 'Ávalon, la Isla Velada', icon: '🌫' },
      { name: 'Castillo de Camelot',    icon: '👑' }
    ],
    transport: { name: 'Grifo Mensajero',    icon: '🦅' },
    service:   { name: 'Pozo de los Deseos', icon: '⛲' },
    donation:  'el Dragón dormido'
  },
  { // Sebastian — Vikingos
    groupA: 'Rutas de Saqueo',
    groupB: 'Camino a Asgard',
    props: [
      { name: 'Monasterio de Lindisfarne', icon: '⛪' },
      { name: 'Mercado de Hedeby',         icon: '⚖' },
      { name: 'Aldea de Kattegat',         icon: '🛖' },
      { name: 'Bifröst, Puente Arcoíris',  icon: '🌈' },
      { name: 'Valhalla, Salón de Odín',   icon: '🛡' }
    ],
    transport: { name: 'Sleipnir, corcel de ocho patas', icon: '🐎' },
    donation:  'Odín (ofrenda en Uppsala)'
  },
  { // Santiago — Literatura
    groupA: 'Rincones de Praga y Étretat',
    groupB: 'Mundos Imposibles',
    props: [
      { name: 'Habitación de Gregorio Samsa',    icon: '🪳' },
      { name: 'La Aguja Hueca de Arsène Lupin',  icon: '🗝' },
      { name: 'Granja Manor del Sr. Jones',      icon: '🐖' },
      { name: 'Centro de Incubación de Londres', icon: '🧪' },
      { name: 'Macondo',                         icon: '🦋' }
    ],
    transport: { name: 'Globo de Phileas Fogg', icon: '🎈' },
    service:   { name: 'Biblioteca de Babel',   icon: '📚' },
    donation:  'Sísifo (para una piedra nueva)'
  }
];

function buildGroups() {
  return economy.GROUP_PRICES.map((g, index) => {
    const member = MEMBERS[Math.floor(index / 2)];
    const world  = WORLDS[Math.floor(index / 2)];
    return {
      id: index,
      name: index % 2 === 0 ? world.groupA : world.groupB,
      color: GROUP_COLORS[index],
      memberId: member.id,
      houseCost: g.houseCost,
      size: g.prices.length
    };
  });
}

function buildBoard() {
  const groups = buildGroups();
  const spaces = [];

  for (let side = 0; side < 4; side++) {
    const member  = MEMBERS[side];
    const world   = WORLDS[side];
    const base    = side * 10;
    const gA      = side * 2;
    const gB      = side * 2 + 1;
    const pricesA = economy.GROUP_PRICES[gA].prices;
    const pricesB = economy.GROUP_PRICES[gB].prices;
    const [a1, a2, b1, b2, b3] = world.props;

    // Esquina que abre el lado
    spaces.push({ ...CORNERS[side], side, memberId: null });

    const prop = (group, info, price) => ({
      type: SPACE.PROPERTY,
      name: info.name,
      icon: info.icon,
      group,
      price,
      houseCost: groups[group].houseCost,
      rents: economy.rentTable(price)
    });

    const sideSpaces = [
      prop(gA, a1, pricesA[0]),
      { type: SPACE.CARD_GENERAL, name: 'Tarjeta General', icon: '📜' },
      prop(gA, a2, pricesA[1]),
      {
        type: SPACE.DONATION,
        name: `Dona a ${world.donation}`,
        icon: '♥',
        amount: economy.DONATION_AMOUNTS[side],
        target: world.donation
      },
      { type: SPACE.TRANSPORT, name: world.transport.name, icon: world.transport.icon, price: economy.TRANSPORT_PRICE },
      prop(gB, b1, pricesB[0]),
      side % 2 === 0
        ? { type: SPACE.CARD_SPECIAL, name: 'Tarjeta Especial', icon: '✶' }
        : { type: SPACE.SERVICE, name: world.service.name, icon: world.service.icon, price: economy.SERVICE_PRICE },
      prop(gB, b2, pricesB[1]),
      prop(gB, b3, pricesB[2])
    ];

    for (const s of sideSpaces) {
      spaces.push({ ...s, side, memberId: member.id });
    }

    if (spaces.length !== base + 10) throw new Error('Tablero mal formado');
  }

  spaces.forEach((s, i) => { s.id = i; });
  return { spaces, groups };
}

const { spaces: SPACES, groups: GROUPS } = buildBoard();

function isOwnable(space) {
  return space.type === SPACE.PROPERTY ||
         space.type === SPACE.TRANSPORT ||
         space.type === SPACE.SERVICE;
}

module.exports = {
  SPACE,
  SPACES,
  GROUPS,
  BOARD_SIZE,
  JAIL_POSITION,
  isOwnable
};
