// ─────────────────────────────────────────────────────────────────────────────
// NÚCLEO DEL CHAT DISTRIBUIDO (puro: sin red ni estado global, se prueba aislado)
//
// ORDEN DE LOS MENSAJES
//   Alice (coord-A) y Bob (coord-B) escriben casi a la vez. ¿En qué orden los
//   ve Charlie (coord-C)? Los relojes de pared no sirven (pueden estar
//   desfasados), así que cada coordinador lleva un RELOJ DE LAMPORT:
//     · al enviar un mensaje:  lc = ++reloj
//     · al recibir uno remoto: reloj = max(reloj, msg.lc)
//   El orden total de los mensajes es la tupla (lc, origin, seq). Dos mensajes
//   concurrentes tienen el mismo `lc`; el desempate por id de coordinador es
//   arbitrario pero IGUAL en todos, así que todos terminan viendo la misma
//   conversación. Si un mensaje llega tarde y le toca ir antes de otros ya
//   mostrados, el cliente lo inserta en su lugar (ver js/lib/chat.js).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LEN = Number(process.env.CHAT_MAX_LEN || 200);
const HISTORY = Number(process.env.CHAT_HISTORY || 50);

// Reloj de Lamport
class LamportClock {
  constructor() { this.value = 0; }
  tick() { return ++this.value; }
  observe(lc) { if (Number.isInteger(lc) && lc > this.value) this.value = lc; }
}

// Orden total: (lc, origin, seq)
function compareMessages(a, b) {
  if (a.lc !== b.lc) return a.lc - b.lc;
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  return a.seq - b.seq;
}

// Texto permitido: sin caracteres de control ni de formato invisibles (RTL,
// ancho cero…), espacios colapsados, longitud 1..MAX_LEN. Devuelve null si no
// queda nada. (El HTML NO se elimina aquí: el cliente siempre usa textContent.)
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;
function sanitizeText(text, max = MAX_LEN) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? null : clean;
}

const CHANNEL_RE = /^(global|room:sala-[a-z0-9-]{4,48})$/;
const isChannel = (ch) => typeof ch === 'string' && CHANNEL_RE.test(ch);

// Valida un mensaje que llegó de OTRO coordinador (no se confía en nada).
// `origin` lo fija el que recibe (el id del enlace), no el contenido.
function normalizeRemote(raw, origin) {
  if (!raw || typeof raw !== 'object') return null;
  const text = sanitizeText(raw.text);
  const username = typeof raw.username === 'string' ? raw.username.replace(FORBIDDEN, '').trim().slice(0, 32) : '';
  if (!text || !username || !isChannel(raw.ch)) return null;
  if (!Number.isInteger(raw.lc) || raw.lc < 1 || !Number.isInteger(raw.seq) || raw.seq < 1) return null;
  if (typeof raw.userId !== 'string' && typeof raw.userId !== 'number') return null;
  const msgOrigin = typeof raw.origin === 'string' ? raw.origin : origin;
  return {
    id: `${msgOrigin}#${raw.seq}`,
    ch: raw.ch,
    userId: String(raw.userId).slice(0, 64),
    username,
    text,
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    lc: raw.lc,
    origin: msgOrigin,
    seq: raw.seq
  };
}

// Últimos M mensajes de un canal, ordenados por (lc, origin, seq), sin repetidos.
class ChatLog {
  constructor(limit = HISTORY) {
    this.limit = limit;
    this.messages = [];
    this.ids = new Set();
  }

  // → null (duplicado o demasiado viejo) | { index, atEnd }
  add(msg) {
    if (this.ids.has(msg.id)) return null;
    const list = this.messages;
    if (list.length >= this.limit && compareMessages(msg, list[0]) < 0) return null; // más viejo que todo el historial

    // Inserción por el final (lo normal): O(1)
    let i = list.length;
    while (i > 0 && compareMessages(msg, list[i - 1]) < 0) i--;
    list.splice(i, 0, msg);
    this.ids.add(msg.id);
    let index = i;
    while (list.length > this.limit) {
      this.ids.delete(list.shift().id);
      index--;
    }
    return { index, atEnd: index === list.length - 1 };
  }

  list() { return this.messages.slice(); }
}

// Limitador por usuario: cubeta de fichas (ráfaga corta, ritmo sostenido bajo).
// Si insiste mientras está limitado acumula "faltas" y queda SILENCIADO un rato.
class RateLimiter {
  constructor({ capacity = 5, refillPerSec = 1, strikesToMute = 8, strikeWindowMs = 10000, muteMs = 15000 } = {}) {
    Object.assign(this, { capacity, refillPerSec, strikesToMute, strikeWindowMs, muteMs });
    this.users = new Map();   // key -> { tokens, at, strikes: [t], mutedUntil }
  }

  // → { ok: true } | { ok: false, reason: 'rate_limited' | 'muted', retryMs }
  take(key, now = Date.now()) {
    let u = this.users.get(key);
    if (!u) { u = { tokens: this.capacity, at: now, strikes: [], mutedUntil: 0 }; this.users.set(key, u); }

    if (now < u.mutedUntil) return { ok: false, reason: 'muted', retryMs: u.mutedUntil - now };

    u.tokens = Math.min(this.capacity, u.tokens + ((now - u.at) / 1000) * this.refillPerSec);
    u.at = now;
    if (u.tokens >= 1) { u.tokens -= 1; return { ok: true }; }

    u.strikes = u.strikes.filter(t => now - t < this.strikeWindowMs);
    u.strikes.push(now);
    if (u.strikes.length >= this.strikesToMute) {
      u.mutedUntil = now + this.muteMs;
      u.strikes = [];
      return { ok: false, reason: 'muted', retryMs: this.muteMs };
    }
    return { ok: false, reason: 'rate_limited', retryMs: Math.ceil(((1 - u.tokens) / this.refillPerSec) * 1000) };
  }

  // Limpieza de usuarios inactivos (para no crecer sin límite)
  sweep(now = Date.now(), idleMs = 10 * 60 * 1000) {
    for (const [k, u] of this.users) if (now - u.at > idleMs && now >= u.mutedUntil) this.users.delete(k);
  }
}

// Guardia contra inundación de un socket (cualquier tipo de mensaje):
// devuelve true cuando se superó el límite en la ventana.
function createFloodGuard(limit = 60, windowMs = 1000) {
  let start = 0, count = 0;
  return function exceeded(now = Date.now()) {
    if (now - start >= windowMs) { start = now; count = 0; }
    return ++count > limit;
  };
}

module.exports = {
  MAX_LEN, HISTORY, LamportClock, compareMessages, sanitizeText, isChannel,
  normalizeRemote, ChatLog, RateLimiter, createFloodGuard
};
