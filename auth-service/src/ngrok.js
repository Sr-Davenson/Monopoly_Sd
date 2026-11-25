// ─────────────────────────────────────────────────────────────────────────────
// Detección del túnel de ngrok de ESTE auth
//
// Si no se pasó --public-url, el auth busca un túnel que apunte a su puerto en
// la API local de los agentes de ngrok (http://127.0.0.1:4040..4045). Cuando lo
// encuentra lo usa como URL pública y se lo anuncia a los demás auths. Así:
//   · /peers devuelve la URL https de cada auth (no http://localhost:400x);
//   · clientes y coordinadores la descubren solos y pueden pasarse a otro auth
//     aunque en su .env solo tengan uno;
//   · leaderUrl (respuestas 503 not_leader) apunta a una URL alcanzable.
// Da igual si ngrok se abrió antes o después del auth.
// ─────────────────────────────────────────────────────────────────────────────
const { config } = require('./config');

// (4045 no: fetch lo bloquea como "bad port")
const API_PORTS = [4040, 4041, 4042, 4043, 4044, 4046, 4047];
const LOCAL_URL = `http://localhost:${config.PORT}`;
let onChange = () => {};

function matchesPort(addr) {
  if (addr === undefined || addr === null) return false;
  const a = String(addr);
  return a === String(config.PORT) || new RegExp(`:${config.PORT}/?$`).test(a);
}

async function findTunnel() {
  for (const p of API_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/tunnels`, { signal: AbortSignal.timeout(800) });
      if (!res.ok) continue;
      const { tunnels = [] } = await res.json();
      const t = tunnels.find(t => /^https:/.test(t.public_url) && matchesPort(t.config && t.config.addr))
             || tunnels.find(t => matchesPort(t.config && t.config.addr));
      if (t) return String(t.public_url).replace(/\/+$/, '');
    } catch { /* ese puerto no tiene agente */ }
  }
  return null;
}

let detected = null;
async function poll() {
  const found = await findTunnel();
  if (found && found !== config.PUBLIC_URL) {
    detected = found;
    config.PUBLIC_URL = found;
    console.log(`[NGROK] Túnel detectado: ${found} → localhost:${config.PORT}. Se anuncia a los demás auths.`);
    onChange(found);
  } else if (!found && detected) {
    console.log(`[NGROK] El túnel ${detected} ya no existe. Se anuncia ${LOCAL_URL} hasta que vuelva.`);
    detected = null;
    config.PUBLIC_URL = LOCAL_URL;
    onChange(LOCAL_URL);
  }
}

function start(cb) {
  if (config.PUBLIC_URL_FIXED) return;
  onChange = cb || onChange;
  poll();
  setInterval(poll, 3000).unref();
}

module.exports = { start };
