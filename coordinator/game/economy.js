// ─────────────────────────────────────────────────────────────────────────────
// Economía del juego (balance general).
//
// Todos los valores están en Doblones (Đ), la moneda común de los cuatro mundos. Ningún otro archivo
// debe tener montos "quemados": todo sale de este módulo.
//
// El razonamiento detrás de cada número está en docs/ECONOMIA.md.
// ─────────────────────────────────────────────────────────────────────────────

const CURRENCY = {
  name:   'Doblones',
  symbol: 'Đ'
};

// ── Flujo de dinero básico ────────────────────────────────────────────────────
const STARTING_MONEY = 1500;  // dinero inicial de cada jugador
const SALARY         = 200;   // se cobra al pasar o caer en Salida

// ── Cárcel ────────────────────────────────────────────────────────────────────
const JAIL_FINE      = 50;    // pagar para salir
const MAX_JAIL_TURNS = 3;     // al tercer intento fallido se paga la multa obligatoriamente
const MAX_DOUBLES    = 3;     // 3 dobles seguidos → a la cárcel

// ── Hipotecas y construcciones ────────────────────────────────────────────────
const MORTGAGE_RATE        = 0.5;  // el banco presta el 50% del precio
const UNMORTGAGE_INTEREST  = 0.1;  // levantar la hipoteca cuesta 50% + 10% de interés
const BUILDING_SELL_RATE   = 0.5;  // las construcciones se revenden al 50%
const MAX_BUILDING_LEVEL   = 5;    // 1-4 = casas, 5 = hotel

// ── Grupos de propiedades ─────────────────────────────────────────────────────
// 8 grupos, 2 por integrante (A = 2 propiedades, B = 3 propiedades).
// El precio sube a medida que se avanza en el tablero.
const GROUP_PRICES = [
  { prices: [60, 80],        houseCost: 50  }, // g0 — David A
  { prices: [100, 100, 120], houseCost: 50  }, // g1 — David B
  { prices: [140, 160],      houseCost: 100 }, // g2 — Jossef A
  { prices: [180, 180, 200], houseCost: 100 }, // g3 — Jossef B
  { prices: [220, 240],      houseCost: 150 }, // g4 — Sebastian A
  { prices: [260, 260, 280], houseCost: 150 }, // g5 — Sebastian B
  { prices: [300, 320],      houseCost: 200 }, // g6 — Santiago A
  { prices: [350, 350, 400], houseCost: 200 }  // g7 — Santiago B
];

// Renta como fracción del precio según el nivel de construcción:
// [sin casas, 1 casa, 2 casas, 3 casas, 4 casas, hotel]
// Sin casas la renta es baja (7%): una propiedad sola casi no rinde.
// La rentabilidad real aparece al completar el grupo y construir.
const RENT_FRACTIONS = [0.07, 0.35, 1.0, 2.8, 3.8, 4.7];
const GROUP_RENT_MULTIPLIER = 2;   // renta sin casas ×2 si se tiene el grupo completo

function roundTo5(n) {
  return Math.max(5, Math.round(n / 5) * 5);
}

// Tabla de rentas de una propiedad: [base, 1c, 2c, 3c, 4c, hotel]
function rentTable(price) {
  return RENT_FRACTIONS.map((f, level) =>
    level === 0 ? Math.max(2, Math.round(price * f)) : roundTo5(price * f)
  );
}

// ── Transportes (4, uno por integrante) ───────────────────────────────────────
const TRANSPORT_PRICE = 200;
const TRANSPORT_RENTS = [25, 50, 100, 200]; // según cuántos transportes tiene el dueño

// ── Servicios (2) ─────────────────────────────────────────────────────────────
const SERVICE_PRICE       = 150;
const SERVICE_MULTIPLIERS = [4, 10];        // renta = dados × multiplicador (1 o 2 servicios)

// ── Donaciones (estilo "Tío Rico") ────────────────────────────────────────────
// Lo donado va al Fondo de Donaciones; quien cae en "Descanso" se lo lleva.
const DONATION_AMOUNTS = [50, 75, 100, 150]; // una por lado del tablero (más cara al avanzar)

// ── Límites ───────────────────────────────────────────────────────────────────
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

module.exports = {
  CURRENCY,
  STARTING_MONEY,
  SALARY,
  JAIL_FINE,
  MAX_JAIL_TURNS,
  MAX_DOUBLES,
  MORTGAGE_RATE,
  UNMORTGAGE_INTEREST,
  BUILDING_SELL_RATE,
  MAX_BUILDING_LEVEL,
  GROUP_PRICES,
  RENT_FRACTIONS,
  GROUP_RENT_MULTIPLIER,
  rentTable,
  TRANSPORT_PRICE,
  TRANSPORT_RENTS,
  SERVICE_PRICE,
  SERVICE_MULTIPLIERS,
  DONATION_AMOUNTS,
  MIN_PLAYERS,
  MAX_PLAYERS
};
