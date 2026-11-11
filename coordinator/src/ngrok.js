// ─────────────────────────────────────────────────────────────────────────────
// Integración con ngrok
//
// Si no se pasó --public-url, el coordinador busca un túnel de ngrok que apunte
// a SU puerto consultando la API local del agente (http://127.0.0.1:4040..4045
// /api/tunnels). Cuando lo encuentra, anuncia esa URL (wss://…) al directorio.
// Así da igual si ngrok se abrió antes o después del coordinador.
//
// Con --ngrok el coordinador además lanza `ngrok http <puerto>` por su cuenta.
// ─────────────────────────────────────────────────────────────────────────────
const { spawn } = require('node:child_process');
const { config } = require('./config');
const { log } = require('./state');

const API_PORTS = [4040, 4041, 4042, 4043, 4044, 4045];
const status = { state: 'inactivo', url: null, error: null, launched: false };

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
      if (t) return t.public_url.replace(/^http/, 'ws');
    } catch { /* ese puerto no tiene agente */ }
  }
  return null;
}

function launch() {
  status.launched = true;
  log('NGROK', `Lanzando: ngrok http ${config.PORT}`);
  let child;
  try {
    // Sin shell: así al cerrar el coordinador se cierra también ngrok.
    child = spawn('ngrok', ['http', String(config.PORT), '--log', 'stdout'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    status.error = `No se pudo lanzar ngrok: ${err.message}`;
    return log('NGROK', status.error);
  }
  const onOutput = (buf) => {
    const text = String(buf);
    // Solo líneas de error (lvl=eror / lvl=crit) o códigos ERR_NGROK_xxx
    const err = text.match(/(ERR_NGROK_\d+[^\n]*)/) || text.match(/lvl=(?:eror|crit)[^\n]*?err="?([^"\n]+)/);
    if (err) {
      status.error = err[1].trim();
      log('NGROK', `ngrok: ${status.error}`);
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', (err) => {
    status.error = `ngrok no está instalado o no está en el PATH (${err.message})`;
    log('NGROK', status.error);
  });
  child.on('exit', (code) => {
    if (code) log('NGROK', `ngrok terminó con código ${code}. ¿Ya hay otro agente abierto con tu cuenta? (plan gratis = 1 agente)`);
    status.state = 'detenido';
  });
  process.on('exit', () => { try { child.kill(); } catch { /* ya terminó */ } });
}

async function poll() {
  const found = await findTunnel();
  if (found && found !== config.publicUrl) {
    config.publicUrl = found;
    status.state = 'activo';
    status.url = found;
    status.error = null;
    log('NGROK', `Túnel detectado: ${found} → localhost:${config.PORT}. Pares en ${config.getPeerUrl()}`);
  } else if (!found && status.state === 'activo') {
    status.state = 'perdido';
    log('NGROK', `El túnel ${config.publicUrl} ya no existe. Se anuncia ${config.localUrl} hasta que vuelva.`);
    config.publicUrl = null;
    status.url = null;
  } else if (!found && status.state === 'inactivo') {
    status.state = 'buscando';
  }
}

function start() {
  if (config.publicUrlFixed) {
    status.state = 'manual';
    status.url = config.publicUrl;
    return;
  }
  if (config.launchNgrok) launch();
  poll();
  setInterval(poll, 3000).unref();
}

module.exports = { start, status };
