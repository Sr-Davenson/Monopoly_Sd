// ─────────────────────────────────────────────────────────────────────────────
// Servidor del cliente web. Solo entrega archivos estáticos de public/:
//   public/*.html        páginas (login, lobby, tablero)
//   public/css/          hojas de estilo
//   public/js/lib/       módulos compartidos (dom, net, tokens, sounds)
//   public/js/pages/     lógica de cada página
//
// /js/config.js se genera aquí con las variables del .env. El cliente NO tiene
// la URL de ningún coordinador: se la pide al auth-service (GET /coordinator).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');

const PORT = Number(process.env.PORT || 3000);
// Taller 7: lista de auth-services replicados (separados por coma).
// AUTH_URL (uno solo) sigue funcionando por compatibilidad.
const clean = (u) => {
  if (!u) return '';
  let s = String(u).trim().replace(/\/+$/, '');
  if (/^https?\/\//i.test(s)) s = s.replace(/^https?\/\//i, (m) => m.toLowerCase().startsWith('https') ? 'https://' : 'http://');
  return s;
};
const CONFIGURED = String(process.env.AUTH_URLS || process.env.AUTH_URL ||
  'http://localhost:4000,http://localhost:4001,http://localhost:4002,http://localhost:4003')
  .split(',').map(clean).filter(Boolean);

// ── Descubrimiento de los demás auths ────────────────────────────────────────
// Aunque el .env tenga UNA sola URL, cada 15 s se pide GET /peers a algún auth
// que responda y se guardan las URLs públicas (túneles ngrok) de todo el
// clúster en .auth-peers.json. Así, si el auth de siempre se cae (incluso con
// este servidor recién reiniciado), el navegador ya recibe la lista completa.
const fs = require('node:fs');
const PEERS_FILE = path.join(__dirname, '.auth-peers.json');
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);
let discovered = [];
try { discovered = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8')).map(clean).filter(Boolean); } catch { /* aún no hay */ }
const authUrls = () => [...new Set([...CONFIGURED, ...discovered])];
const AUTH_URLS = authUrls();   // para el log de arranque

async function discoverAuths() {
  for (const url of authUrls()) {
    try {
      const res = await fetch(`${url}/peers`, { headers: { 'ngrok-skip-browser-warning': 'true' }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const { peers = [] } = await res.json();
      const urls = peers.map(p => p && p.publicUrl)
        .filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).map(clean)
        .filter(u => !isLocalUrl(u) || CONFIGURED.some(isLocalUrl));
      if (!urls.length) continue;
      const added = urls.filter(u => !authUrls().includes(u));
      discovered = urls;
      if (added.length) console.log(`  -> Auths descubiertos vía ${url}: ${added.join(', ')}`);
      try { fs.writeFileSync(PEERS_FILE, JSON.stringify(discovered, null, 2)); } catch { /* solo lectura */ }
      return;
    } catch { /* ese auth no responde: siguiente */ }
  }
}
discoverAuths();
setInterval(discoverAuths, 15000).unref();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '786041305351-sj20hhmusecqdqtg9qactcnjqcq3o3ta.apps.googleusercontent.com';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(cors());

// Configuración dinámica para el frontend
app.get('/js/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.APP_CONFIG = ${JSON.stringify({ AUTH_URLS: authUrls(), GOOGLE_CLIENT_ID })};\n`);
});

// La raíz siempre entrega el login
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`Cliente Web corriendo en http://localhost:${PORT}`);
  console.log(`  -> AUTH_URLS: ${AUTH_URLS.join(', ')}`);
  console.log('  -> El coordinador se obtiene en tiempo de ejecución con GET /coordinator');
});
