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
const AUTH_URLS = String(process.env.AUTH_URLS || process.env.AUTH_URL ||
  'http://localhost:4001,http://localhost:4002,http://localhost:4003')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '786041305351-sj20hhmusecqdqtg9qactcnjqcq3o3ta.apps.googleusercontent.com';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(cors());

// Configuración dinámica para el frontend
app.get('/js/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.APP_CONFIG = ${JSON.stringify({ AUTH_URLS, GOOGLE_CLIENT_ID })};\n`);
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
