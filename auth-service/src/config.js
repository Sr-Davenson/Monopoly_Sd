// Configuración del auth-service (.env)
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  PORT:             Number(process.env.PORT || 4000),
  JWT_SECRET:       process.env.JWT_SECRET,
  JWT_EXPIRES_IN:   process.env.JWT_EXPIRES_IN || '1h',
  BCRYPT_ROUNDS:    Math.max(10, Number(process.env.BCRYPT_ROUNDS || 10)),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  DB_PATH:          process.env.DB_PATH
    ? path.resolve(__dirname, '..', process.env.DB_PATH)
    : path.join(__dirname, '..', 'users.db'),
  HEARTBEAT_TTL_MS: Number(process.env.HEARTBEAT_TTL_MS || 6000)
};

function validate() {
  if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) {
    console.error('[ERROR] JWT_SECRET no está definida o tiene menos de 32 caracteres.');
    process.exit(1);
  }
  if (!config.GOOGLE_CLIENT_ID) {
    console.error('[ERROR] GOOGLE_CLIENT_ID no está definida en el archivo .env');
    process.exit(1);
  }
}

module.exports = { config, validate };
