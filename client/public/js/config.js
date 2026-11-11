// Configuración por defecto, usada solo si public/ se sirve sin `node server.js`
// (por ejemplo con Live Server). Con server.js esta ruta la genera el servidor
// a partir del .env. El cliente NO tiene la URL del coordinador: se la pide al
// auth-service con GET /coordinator (ver js/lib/net.js).
window.APP_CONFIG = window.APP_CONFIG || {
  AUTH_URL: 'https://onboard-pantyhose-written.ngrok-free.dev',
  GOOGLE_CLIENT_ID: '786041305351-sj20hhmusecqdqtg9qactcnjqcq3o3ta.apps.googleusercontent.com'
};
