// Configuración por defecto, usada solo si public/ se sirve sin `node server.js`
// (por ejemplo con Live Server). Con server.js esta ruta la genera el servidor
// a partir del .env. El cliente NO tiene la URL del coordinador: se la pide al
// auth-service con GET /coordinator (ver js/lib/net.js).
//
// Taller 7: el auth-service está replicado → AUTH_URLS es una lista. El cliente
// prueba uno tras otro y sigue al líder cuando hace falta (ver js/lib/auth.js).
window.APP_CONFIG = window.APP_CONFIG || {
  AUTH_URLS: ['http://localhost:4001', 'http://localhost:4002', 'http://localhost:4003'],
  GOOGLE_CLIENT_ID: '786041305351-sj20hhmusecqdqtg9qactcnjqcq3o3ta.apps.googleusercontent.com'
};
