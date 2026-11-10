// Archivo por defecto si se sirve de forma estática en vez de node server.js.
// Taller 6: el cliente ya NO tiene la URL del coordinador; se la pide al
// auth-service con GET /coordinator (ver net.js).
window.APP_CONFIG = window.APP_CONFIG || {
  AUTH_URL: 'https://onboard-pantyhose-written.ngrok-free.dev',
  GOOGLE_CLIENT_ID: '786041305351-sj20hhmusecqdqtg9qactcnjqcq3o3ta.apps.googleusercontent.com'
};
