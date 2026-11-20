// ─────────────────────────────────────────────────────────────────────────────
// Eventos recientes para el panel del auth.
//
// Todo el auth-service escribe en consola con el formato "[TAG] mensaje".
// Aquí se copian esas líneas a un buffer circular, así el panel muestra lo
// mismo que la consola (elecciones, votos, sync, escrituras...) sin tener que
// tocar cada console.log. Las peticiones GET /coordinator se omiten (son muchas).
// ─────────────────────────────────────────────────────────────────────────────
const MAX_EVENTS = 300;
const events = [];

function push(tag, msg) {
  events.push({ t: Date.now(), tag, msg });
  if (events.length > MAX_EVENTS) events.shift();
}

for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    const line = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
    const m = line.match(/^\s*\[([A-Z ]+)\]\s*([\s\S]*)$/);
    if (!m || /GET \/coordinator\b/.test(m[2])) return;
    push(m[1].trim(), m[2].trim());
  };
}

module.exports = { events, push };
