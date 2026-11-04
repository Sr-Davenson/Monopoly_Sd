require('dotenv').config();
const path = require('node:path');
const express = require('express');
const cors = require('cors');

const PORT = Number(process.env.PORT || 3000);
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:4000';
const COORDINATOR_WS = process.env.COORDINATOR_WS || 'ws://localhost:5000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

const app = express();
app.use(cors());

// Expone las configuraciones al frontend de forma dinámica
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(
    `window.APP_CONFIG = ${JSON.stringify({
      AUTH_URL,
      COORDINATOR_WS,
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
  console.log(`  -> COORDINATOR_WS: ${COORDINATOR_WS}`);
  if (GOOGLE_CLIENT_ID) {
    console.log(`  -> GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}`);
  }
});
