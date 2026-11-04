// ─────────────────────────────────────────────────────────────────────────────
// PLANTILLA DE CARTAS
//
// Dos mazos:
//   - General  : efectos mayormente de dinero, suaves y algo favorables.
//   - Especial : efectos de movimiento y riesgo (más varianza).
//
// Cada carta tiene:
//   title  → TEXTO TEMÁTICO POR DEFINIR (lo escribe el equipo)
//   text   → descripción del efecto que ve el jugador
//   effect → lo que realmente hace el servidor (no tocar sin revisar el motor)
//
// Efectos disponibles:
//   { kind: 'collect', amount }             cobra del banco
//   { kind: 'pay', amount }                 paga al banco
//   { kind: 'donate', amount }              paga al Fondo de Donaciones
//   { kind: 'collect_each', amount }        cada jugador te paga
//   { kind: 'pay_each', amount }            pagas a cada jugador
//   { kind: 'move_to', position }           avanza hasta la casilla (cobra salario si pasa Salida)
//   { kind: 'move_back', steps }            retrocede N casillas
//   { kind: 'nearest_transport' }           avanza al siguiente transporte; si tiene dueño paga renta ×2
//   { kind: 'go_to_jail' }                  directo a la cárcel
//   { kind: 'jail_free' }                   carta para salir de la cárcel (se guarda)
//   { kind: 'repairs', perHouse, perHotel } paga por cada construcción
//
// Los montos están balanceados en docs/ECONOMIA.md (valor esperado por carta).
// ─────────────────────────────────────────────────────────────────────────────

const T = '[Título por definir]';

const GENERAL_DECK = [
  { title: T, text: 'Cobra 200.',                         effect: { kind: 'collect', amount: 200 } },
  { title: T, text: 'Cobra 100.',                         effect: { kind: 'collect', amount: 100 } },
  { title: T, text: 'Cobra 100.',                         effect: { kind: 'collect', amount: 100 } },
  { title: T, text: 'Cobra 50.',                          effect: { kind: 'collect', amount: 50 } },
  { title: T, text: 'Cobra 25.',                          effect: { kind: 'collect', amount: 25 } },
  { title: T, text: 'Cobra 20.',                          effect: { kind: 'collect', amount: 20 } },
  { title: T, text: 'Cobra 10.',                          effect: { kind: 'collect', amount: 10 } },
  { title: T, text: 'Cada jugador te paga 10.',           effect: { kind: 'collect_each', amount: 10 } },
  { title: T, text: 'Avanza hasta Salida.',               effect: { kind: 'move_to', position: 0 } },
  { title: T, text: 'Sal de la cárcel gratis (guárdala).', effect: { kind: 'jail_free' } },
  { title: T, text: 'Paga 50.',                           effect: { kind: 'pay', amount: 50 } },
  { title: T, text: 'Paga 100.',                          effect: { kind: 'pay', amount: 100 } },
  { title: T, text: 'Dona 50 al Fondo de Donaciones.',    effect: { kind: 'donate', amount: 50 } },
  { title: T, text: 'Dona 100 al Fondo de Donaciones.',   effect: { kind: 'donate', amount: 100 } },
  { title: T, text: 'Reparaciones: paga 40 por casa y 115 por hotel.', effect: { kind: 'repairs', perHouse: 40, perHotel: 115 } },
  { title: T, text: 'Ve directo a la cárcel.',            effect: { kind: 'go_to_jail' } }
];

const SPECIAL_DECK = [
  { title: T, text: 'Avanza hasta Salida.',                              effect: { kind: 'move_to', position: 0 } },
  { title: T, text: 'Avanza hasta la primera propiedad de Jossef.',      effect: { kind: 'move_to', position: 11 } },
  { title: T, text: 'Avanza hasta la primera propiedad de Sebastian.',   effect: { kind: 'move_to', position: 21 } },
  { title: T, text: 'Avanza hasta la última propiedad de Santiago.',     effect: { kind: 'move_to', position: 39 } },
  { title: T, text: 'Avanza hasta el Transporte de David.',              effect: { kind: 'move_to', position: 5 } },
  { title: T, text: 'Avanza al siguiente transporte. Si tiene dueño, paga el doble.', effect: { kind: 'nearest_transport' } },
  { title: T, text: 'Avanza al siguiente transporte. Si tiene dueño, paga el doble.', effect: { kind: 'nearest_transport' } },
  { title: T, text: 'Retrocede 3 casillas.',                             effect: { kind: 'move_back', steps: 3 } },
  { title: T, text: 'Ve directo a la cárcel.',                           effect: { kind: 'go_to_jail' } },
  { title: T, text: 'Sal de la cárcel gratis (guárdala).',               effect: { kind: 'jail_free' } },
  { title: T, text: 'Cobra 150.',                                        effect: { kind: 'collect', amount: 150 } },
  { title: T, text: 'Cobra 50.',                                         effect: { kind: 'collect', amount: 50 } },
  { title: T, text: 'Paga 15.',                                          effect: { kind: 'pay', amount: 15 } },
  { title: T, text: 'Paga 50 a cada jugador.',                           effect: { kind: 'pay_each', amount: 50 } },
  { title: T, text: 'Reparaciones: paga 25 por casa y 100 por hotel.',   effect: { kind: 'repairs', perHouse: 25, perHotel: 100 } },
  { title: T, text: 'Dona 50 al Fondo de Donaciones.',                   effect: { kind: 'donate', amount: 50 } }
];

const DECKS = {
  general: GENERAL_DECK.map((c, i) => ({ ...c, id: `general_${i}`, deck: 'general' })),
  special: SPECIAL_DECK.map((c, i) => ({ ...c, id: `special_${i}`, deck: 'special' }))
};

module.exports = { DECKS };
