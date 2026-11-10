const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');

const PORT = Number(process.env.PORT || 3000);
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:4000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '786041305351-sj20hhmusecqdqtg9qactcnjqcq3o3ta.apps.googleusercontent.com';

const app = express();
app.use(cors());

// Expone las configuraciones al frontend de forma dinámica.
// (Taller 6: no se expone ningún coordinador; el cliente se lo pide al auth.)
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(
    `window.APP_CONFIG = ${JSON.stringify({
      AUTH_URL,
      GOOGLE_CLIENT_ID
    })};\n`
  );
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.listen(PORT, () => {
  console.log(`Cliente Web corriendo en http://localhost:${PORT}`);
  console.log(`  -> AUTH_URL: ${AUTH_URL}`);
  console.log('  -> El coordinador se obtiene en tiempo de ejecución con GET /coordinator');
  console.log(`  -> GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}`);
});
