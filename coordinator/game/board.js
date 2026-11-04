// ─────────────────────────────────────────────────────────────────────────────
// Tablero: 40 casillas. Las 4 esquinas son fijas y cada lado (9 casillas)
// pertenece a un integrante.
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
//
// Los nombres entre [corchetes] son plantillas para que cada integrante los
// reemplace con su temática.
// ─────────────────────────────────────────────────────────────────────────────

const economy = require('./economy');
const { MEMBERS } = require('./members');

const SPACE = Object.freeze({
  START:        'start',
  JAIL:         'jail',
  REST:         'rest',          // "Descanso": cobra el Fondo de Donaciones
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
  '#ef4444', '#f97316', // David
  '#22c55e', '#14b8a6', // Jossef
  '#3b82f6', '#6366f1', // Sebastian
  '#a855f7', '#ec4899'  // Santiago
];

const CORNERS = [
  { type: SPACE.START,      name: 'Salida' },
  { type: SPACE.JAIL,       name: 'Cárcel' },
  { type: SPACE.REST,       name: 'Descanso' },
  { type: SPACE.GO_TO_JAIL, name: 'Ve a la cárcel' }
];

// Placeholder de donación: a quién se le dona lo define cada integrante.
const DONATION_TARGETS = [
  '[Personaje de David]',
  '[Personaje de Jossef]',
  '[Personaje de Sebastian]',
  '[Personaje de Santiago]'
];

function buildGroups() {
  return economy.GROUP_PRICES.map((g, index) => {
    const member = MEMBERS[Math.floor(index / 2)];
    const letter = index % 2 === 0 ? 'A' : 'B';
    return {
      id: index,
      name: `[Grupo ${letter} de ${member.name}]`,
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
    const member = MEMBERS[side];
    const base   = side * 10;
    const gA     = side * 2;
    const gB     = side * 2 + 1;
    const pricesA = economy.GROUP_PRICES[gA].prices;
    const pricesB = economy.GROUP_PRICES[gB].prices;

    // Esquina que abre el lado
    spaces.push({ ...CORNERS[side], side, memberId: null });

    const prop = (group, idx, price) => ({
      type: SPACE.PROPERTY,
      name: `[Propiedad ${group % 2 === 0 ? 'A' : 'B'}${idx} de ${member.name}]`,
      group,
      price,
      houseCost: groups[group].houseCost,
      rents: economy.rentTable(price)
    });

    const sideSpaces = [
      prop(gA, 1, pricesA[0]),
      { type: SPACE.CARD_GENERAL, name: 'Tarjeta General' },
      prop(gA, 2, pricesA[1]),
      {
        type: SPACE.DONATION,
        name: `Dona a ${DONATION_TARGETS[side]}`,
        amount: economy.DONATION_AMOUNTS[side],
        target: DONATION_TARGETS[side]
      },
      { type: SPACE.TRANSPORT, name: `[Transporte de ${member.name}]`, price: economy.TRANSPORT_PRICE },
      prop(gB, 1, pricesB[0]),
      side % 2 === 0
        ? { type: SPACE.CARD_SPECIAL, name: 'Tarjeta Especial' }
        : { type: SPACE.SERVICE, name: `[Servicio de ${member.name}]`, price: economy.SERVICE_PRICE },
      prop(gB, 2, pricesB[1]),
      prop(gB, 3, pricesB[2])
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
