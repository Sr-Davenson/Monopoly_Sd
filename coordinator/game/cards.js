// ─────────────────────────────────────────────────────────────────────────────
// CARTAS
//
// Dos mazos:
//   - General  : efectos mayormente de dinero, suaves y algo favorables.
//   - Especial : efectos de movimiento y riesgo (más varianza).
//
// Cada carta tiene:
//   title  → texto temático (mezcla de los cuatro mundos)
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
//   { kind: 'go_to_jail' }                  directo al calabozo
//   { kind: 'jail_free' }                   carta para salir del calabozo (se guarda)
//   { kind: 'repairs', perHouse, perHotel } paga por cada construcción
//
// Los montos están balanceados en docs/ECONOMIA.md (valor esperado por carta).
// ─────────────────────────────────────────────────────────────────────────────

const GENERAL_DECK = [
  { title: '¡Cofre del tesoro desenterrado!',             text: 'Cobra 200.',                          effect: { kind: 'collect', amount: 200 } },
  { title: 'El Rey Arturo premia tu lealtad',             text: 'Cobra 100.',                          effect: { kind: 'collect', amount: 100 } },
  { title: 'Botín de un saqueo exitoso',                  text: 'Cobra 100.',                          effect: { kind: 'collect', amount: 100 } },
  { title: 'Regalías de tu primera novela',               text: 'Cobra 50.',                           effect: { kind: 'collect', amount: 50 } },
  { title: 'Un hada deja una moneda bajo tu almohada',    text: 'Cobra 25.',                           effect: { kind: 'collect', amount: 25 } },
  { title: 'Vendes pieles en el mercado de Hedeby',       text: 'Cobra 20.',                           effect: { kind: 'collect', amount: 20 } },
  { title: 'Un doblón brilla en la arena',                text: 'Cobra 10.',                           effect: { kind: 'collect', amount: 10 } },
  { title: 'Fiesta del solsticio: todos te traen regalos', text: 'Cada jugador te paga 10.',           effect: { kind: 'collect_each', amount: 10 } },
  { title: 'Viento a favor: regresas a puerto',           text: 'Avanza hasta Salida.',                effect: { kind: 'move_to', position: 0 } },
  { title: 'La ganzúa de Arsène Lupin',                   text: 'Sal del calabozo gratis (guárdala).', effect: { kind: 'jail_free' } },
  { title: 'El grifo cobra peaje',                        text: 'Paga 50.',                            effect: { kind: 'pay', amount: 50 } },
  { title: 'Multa del Gremio de Escribas',                text: 'Paga 100.',                           effect: { kind: 'pay', amount: 100 } },
  { title: 'Ofrenda a los dioses del Norte',              text: 'Dona 50 al Fondo de Donaciones.',     effect: { kind: 'donate', amount: 50 } },
  { title: 'Una colecta para la piedra de Sísifo',        text: 'Dona 100 al Fondo de Donaciones.',    effect: { kind: 'donate', amount: 100 } },
  { title: 'Tormenta en el puerto',                       text: 'Reparaciones: paga 40 por casa y 115 por hotel.', effect: { kind: 'repairs', perHouse: 40, perHotel: 115 } },
  { title: '¡Te atrapó la Armada Real!',                  text: 'Ve directo al calabozo.',             effect: { kind: 'go_to_jail' } }
];

const SPECIAL_DECK = [
  { title: 'El Kraken te arrastra hasta Salida',      text: 'Avanza hasta Salida.',                          effect: { kind: 'move_to', position: 0 } },
  { title: 'Se abre un portal feérico',               text: 'Avanza hasta el Bosque de Brocelianda.',        effect: { kind: 'move_to', position: 11 } },
  { title: '¡Drakkars a la vista: a saquear!',        text: 'Avanza hasta el Monasterio de Lindisfarne.',    effect: { kind: 'move_to', position: 21 } },
  { title: 'Mariposas amarillas te guían',            text: 'Avanza hasta Macondo.',                         effect: { kind: 'move_to', position: 39 } },
  { title: 'Barbanegra te recluta',                   text: "Avanza hasta el Galeón Queen Anne's Revenge.",  effect: { kind: 'move_to', position: 5 } },
  { title: 'Sleipnir galopa por ti',                  text: 'Avanza al siguiente transporte. Si tiene dueño, paga el doble.', effect: { kind: 'nearest_transport' } },
  { title: 'La vuelta al mundo en 80 días',           text: 'Avanza al siguiente transporte. Si tiene dueño, paga el doble.', effect: { kind: 'nearest_transport' } },
  { title: 'Amaneces convertido en insecto',          text: 'Retrocede 3 casillas.',                         effect: { kind: 'move_back', steps: 3 } },
  { title: 'Te acusan sin saber de qué (El proceso)', text: 'Ve directo al calabozo.',                       effect: { kind: 'go_to_jail' } },
  { title: 'Pergamino de liberación de Merlín',       text: 'Sal del calabozo gratis (guárdala).',           effect: { kind: 'jail_free' } },
  { title: 'El dragón deja caer parte de su tesoro',  text: 'Cobra 150.',                                    effect: { kind: 'collect', amount: 150 } },
  { title: 'Un mapa te lleva a un pequeño cofre',     text: 'Cobra 50.',                                     effect: { kind: 'collect', amount: 50 } },
  { title: 'Pagas al barquero',                       text: 'Paga 15.',                                      effect: { kind: 'pay', amount: 15 } },
  { title: 'Banquete en el Valhalla: invitas tú',     text: 'Paga 50 a cada jugador.',                       effect: { kind: 'pay_each', amount: 50 } },
  { title: 'Los trolls dañan tus construcciones',     text: 'Reparaciones: paga 25 por casa y 100 por hotel.', effect: { kind: 'repairs', perHouse: 25, perHotel: 100 } },
  { title: 'Tributo al Cofre de Davy Jones',          text: 'Dona 50 al Fondo de Donaciones.',               effect: { kind: 'donate', amount: 50 } }
];

const DECKS = {
  general: GENERAL_DECK.map((c, i) => ({ ...c, id: `general_${i}`, deck: 'general' })),
  special: SPECIAL_DECK.map((c, i) => ({ ...c, id: `special_${i}`, deck: 'special' }))
};

module.exports = { DECKS };
