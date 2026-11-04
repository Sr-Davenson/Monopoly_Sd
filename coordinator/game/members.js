// ─────────────────────────────────────────────────────────────────────────────
// PLANTILLA DE INTEGRANTES
//
// Cada integrante es dueño de un lado del tablero (9 casillas entre dos
// esquinas). Aquí cada uno escribe su idea central; el resto del juego
// (tablero, temáticas, skins) lee estos datos.
//
// Para completar tu sección:
//   1. Escribe tu idea central en `idea`.
//   2. Pon el nombre de tu sección en `sectionName`.
//   3. Ve a board.js y renombra tus propiedades / grupos.
//   4. Ve a themes.js y define tus fichas (skins) y tu caja.
// ─────────────────────────────────────────────────────────────────────────────

const MEMBERS = [
  {
    id: 'david',
    name: 'David',
    side: 0,                 // casillas 1-9  (entre Salida y Cárcel)
    color: '#ef4444',
    sectionName: '[Sección de David]',
    idea: '[Idea central de David por definir]'
  },
  {
    id: 'jossef',
    name: 'Jossef',
    side: 1,                 // casillas 11-19 (entre Cárcel y Descanso)
    color: '#22c55e',
    sectionName: '[Sección de Jossef]',
    idea: '[Idea central de Jossef por definir]'
  },
  {
    id: 'sebastian',
    name: 'Sebastian',
    side: 2,                 // casillas 21-29 (entre Descanso y Ve a la cárcel)
    color: '#3b82f6',
    sectionName: '[Sección de Sebastian]',
    idea: '[Idea central de Sebastian por definir]'
  },
  {
    id: 'santiago',
    name: 'Santiago',
    side: 3,                 // casillas 31-39 (entre Ve a la cárcel y Salida)
    color: '#a855f7',
    sectionName: '[Sección de Santiago]',
    idea: '[Idea central de Santiago por definir]'
  }
];

module.exports = { MEMBERS };
