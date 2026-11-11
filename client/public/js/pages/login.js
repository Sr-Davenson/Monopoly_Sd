// ── Los cuatro mundos con su ficha inicial ────────────────────────────────
(function renderWorlds() {
  const worlds = [
    { name: 'Piratas',    sub: 'Mar de los Corsarios', art: 'sombrero_pirata', color: 'var(--pirate)' },
    { name: 'Fantasía',   sub: 'Reinos Encantados',    art: 'pocion',          color: 'var(--fantasy)' },
    { name: 'Vikingos',   sub: 'Tierras del Norte',    art: 'casco_vikingo',   color: 'var(--viking)' },
    { name: 'Literatura', sub: 'Barrio de las Letras', art: 'samsa',           color: 'var(--letters)' }
  ];
  const row = document.getElementById('worlds-row');
  for (const w of worlds) {
    const chip = document.createElement('div');
    chip.className = 'world-chip';
    chip.style.setProperty('--wc', w.color);
    chip.append(Tokens.node({ art: w.art, name: w.name }, '', w.color));
    const text = document.createElement('div');
    text.className = 'wc-text';
    const n = document.createElement('div'); n.className = 'wc-name'; n.textContent = w.name;
    const s = document.createElement('div'); s.className = 'wc-sub';  s.textContent = w.sub;
    text.append(n, s);
    chip.append(text);
    row.append(chip);
  }
})();

// Limpiar posibles valores antiguos guardados en localStorage para forzar uso exclusivo de .env
localStorage.removeItem('CUSTOM_AUTH_URL');
localStorage.removeItem('CUSTOM_COORDINATOR_WS');
localStorage.removeItem('CUSTOM_GOOGLE_CLIENT_ID');

const DEFAULT_GOOGLE_CLIENT_ID = '786041305351-sj20hhmusecqdqtg9qactcnjqcq3o3ta.apps.googleusercontent.com';

// Configuración tomada de variables de entorno (.env vía config.js)
const config = window.APP_CONFIG || {
  AUTH_URL: 'http://localhost:4000',
  GOOGLE_CLIENT_ID: DEFAULT_GOOGLE_CLIENT_ID
};

function getAuthUrl() {
  return (config.AUTH_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

function getGoogleClientId() {
  const id = (config && config.GOOGLE_CLIENT_ID) ? config.GOOGLE_CLIENT_ID.trim() : '';
  return id || DEFAULT_GOOGLE_CLIENT_ID;
}

const alertBox = document.getElementById('global-alert');
function showAlert(msg, type = 'error') {
  alertBox.textContent = msg;
  alertBox.className = `alert alert-${type} show`;
}

const modalAlertBox = document.getElementById('modal-alert');
function showModalAlert(msg, type = 'error') {
  modalAlertBox.textContent = msg;
  modalAlertBox.className = `alert alert-${type} show`;
}

// Mostrar mensaje si viene redirigido desde el lobby
const sessionReason = sessionStorage.getItem('session_message');
if (sessionReason) {
  showAlert(sessionReason, 'warning');
  sessionStorage.removeItem('session_message');
}

// Solo letras, dígitos y guion bajo: evita caracteres especiales / inyecciones
const SAFE_USERNAME_RE = /^[a-zA-Z0-9_]+$/;

// Normalizar automáticamente a minúsculas
['reg-username', 'login-username', 'google-username-input'].forEach((id) => {
  const input = document.getElementById(id);
  if (input) {
    input.addEventListener('blur', () => {
      input.value = input.value.trim().toLowerCase();
    });
  }
});

// Registro Local
document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim().toLowerCase();
  const password = document.getElementById('reg-password').value;

  if (!SAFE_USERNAME_RE.test(username)) {
    return showAlert('El usuario solo puede contener letras, números y guion bajo (_).', 'error');
  }

  try {
    const res = await fetch(`${getAuthUrl()}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      return showAlert(data.error || `Error ${res.status} al registrar usuario`, 'error');
    }

    showAlert(`Usuario "${data.username}" creado con éxito. Ya puedes iniciar sesión.`, 'success');
    document.getElementById('login-username').value = data.username;
    document.getElementById('login-password').value = '';
    document.getElementById('register-form').reset();
  } catch (err) {
    showAlert(`No se pudo conectar al Servicio de Auth en ${getAuthUrl()}`, 'error');
  }
});

// Login Local
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;

  if (!SAFE_USERNAME_RE.test(username)) {
    return showAlert('El usuario solo puede contener letras, números y guion bajo (_).', 'error');
  }

  try {
    const res = await fetch(`${getAuthUrl()}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      return showAlert(data.error || 'Credenciales inválidas', 'error');
    }

    localStorage.setItem('token', data.token);
    localStorage.setItem('username', data.username);
    window.location.href = 'lobby.html';
  } catch (err) {
    showAlert(`No se pudo conectar al Servicio de Auth en ${getAuthUrl()}`, 'error');
  }
});

// ── Google Identity Services (Opción A) ──────────────────────────────────
let pendingGoogleIdToken = null;

function initGoogleSignIn() {
  const clientId = getGoogleClientId();
  const wrapper = document.getElementById('google-btn-wrapper');
  const statusMsg = document.getElementById('google-status-msg');

  // Actualizar atributo declarativo si existe
  const onloadEl = document.getElementById('g_id_onload');
  if (onloadEl) {
    onloadEl.setAttribute('data-client_id', clientId);
  }

  if (!clientId) {
    wrapper.innerHTML = '';
    statusMsg.textContent = 'Configura GOOGLE_CLIENT_ID en client/.env para habilitar el botón.';
    return;
  }
  statusMsg.textContent = '';

  if (window.google && window.google.accounts && window.google.accounts.id) {
    try {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCredentialResponse,
        auto_select: false
      });

      // Si el botón aún no tiene un iframe hijo renderizado por Google, renderizarlo programáticamente
      if (!wrapper.querySelector('iframe')) {
        window.google.accounts.id.renderButton(
          wrapper,
          {
            theme: 'outline',
            size: 'large',
            text: 'signin_with',
            shape: 'rectangular',
            logo_alignment: 'left',
            width: 280
          }
        );
      }
    } catch (e) {
      console.error('[Google GSI Error]', e);
      statusMsg.textContent = 'Error inicializando Google Sign-In: ' + e.message;
    }
  } else {
    // Reintentar cuando el script gsi cargue
    setTimeout(initGoogleSignIn, 200);
  }
}

async function handleGoogleCredentialResponse(response) {
  const idToken = response.credential;
  if (!idToken) {
    return showAlert('No se recibió la credencial de Google.', 'error');
  }

  pendingGoogleIdToken = idToken;

  try {
    const res = await fetch(`${getAuthUrl()}/auth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({ idToken })
    });
    const data = await res.json();

    // 200: Usuario existente o autenticado directamente
    if (res.status === 200 && data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('username', data.username);
      window.location.href = 'lobby.html';
      return;
    }

    // 409 username_required: Primer login con Google
    if (res.status === 409 && data.error === 'username_required') {
      showGoogleUsernameModal(data.hint || '');
      return;
    }

    if (!res.ok) {
      showAlert(data.error || 'Error al autenticar con Google.', 'error');
    }
  } catch (err) {
    showAlert(`No se pudo conectar con el Servicio de Auth en ${getAuthUrl()}`, 'error');
  }
}

// Exponer función de callback global para la API declarativa de Google
window.handleGoogleCredentialResponse = handleGoogleCredentialResponse;

function showGoogleUsernameModal(hint) {
  const modal = document.getElementById('google-username-modal');
  const input = document.getElementById('google-username-input');
  modalAlertBox.className = 'alert';
  input.value = hint || '';
  modal.hidden = false;
  input.focus();
}

function hideGoogleUsernameModal() {
  document.getElementById('google-username-modal').hidden = true;
  pendingGoogleIdToken = null;
}

document.getElementById('cancel-google-modal-btn').addEventListener('click', hideGoogleUsernameModal);

// Formulario de confirmación de username para usuario de Google
document.getElementById('google-username-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('google-username-input').value.trim().toLowerCase();

  if (!SAFE_USERNAME_RE.test(username)) {
    return showModalAlert('El usuario solo puede contener letras, números y guion bajo (_).', 'error');
  }
  if (username.length < 3 || username.length > 32) {
    return showModalAlert('El username debe tener entre 3 y 32 caracteres.', 'error');
  }

  try {
    const res = await fetch(`${getAuthUrl()}/auth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({
        idToken: pendingGoogleIdToken,
        username: username
      })
    });
    const data = await res.json();

    if (res.status === 409 && data.error === 'username_taken') {
      return showModalAlert('Ese nombre de usuario ya está registrado. Por favor elige otro.', 'error');
    }

    if (res.status === 200 && data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('username', data.username);
      window.location.href = 'lobby.html';
      return;
    }

    showModalAlert(data.error || 'Error al completar el registro con Google', 'error');
  } catch (err) {
    showModalAlert(`Error de conexión: ${err.message}`, 'error');
  }
});

// Inicializar Google Sign-In
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initGoogleSignIn);
} else {
  initGoogleSignIn();
}
