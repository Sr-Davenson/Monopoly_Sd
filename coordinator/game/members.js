// ─────────────────────────────────────────────────────────────────────────────
// INTEGRANTES Y SUS MUNDOS
//
// Cada integrante es dueño de un lado del tablero (9 casillas entre dos
// esquinas). El resto del juego (tablero, temáticas, fichas) lee estos datos.
//
//   lado 0 → casillas 1-9   (entre Salida y Calabozo)          — Star Wars
//   lado 1 → casillas 11-19 (entre Calabozo y Taberna)         — Fantasía
//   lado 2 → casillas 21-29 (entre Taberna y Ve al Calabozo)   — Vikingos
//   lado 3 → casillas 31-39 (entre Ve al Calabozo y Salida)    — Literatura
// ─────────────────────────────────────────────────────────────────────────────

const MEMBERS = [
  {
    id: 'david',
    name: 'David',
    side: 0,
    color: '#e05a47',
    world: 'Star Wars',
    sectionName: 'Galaxia Muy Lejana',
    idea: 'Del Borde Exterior a los mundos de la República: de una cantina de Tatooine al Templo Jedi.'
  },
  {
    id: 'jossef',
    name: 'Jossef',
    side: 1,
    color: '#46b98a',
    world: 'Fantasía',
    sectionName: 'Reinos Encantados',
    idea: 'Bosques feéricos, magos y dragones: el mundo de las leyendas artúricas.'
  },
  {
    id: 'sebastian',
    name: 'Sebastian',
    side: 2,
    color: '#5b9bd5',
    world: 'Vikingos',
    sectionName: 'Tierras del Norte',
    idea: 'Fiordos helados, saqueos y el camino hacia el Valhalla.'
  },
  {
    id: 'santiago',
    name: 'Santiago',
    side: 3,
    color: '#c58b4f',
    world: 'Literatura',
    sectionName: 'Barrio de las Letras',
    idea: 'Lugares de los grandes libros: Kafka, Orwell, Huxley, Camus, Leblanc y García Márquez.'
  }
];

module.exports = { MEMBERS };
