// Archivo por defecto si se sirve con npx serve en vez de node server.js
window.APP_CONFIG = window.APP_CONFIG || {
  AUTH_URL: 'http://localhost:4000',
  COORDINATOR_WS: 'ws://localhost:5000'
};
