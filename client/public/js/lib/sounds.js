// ─────────────────────────────────────────────────────────────────────────────
// Sonidos del tablero, sintetizados con Web Audio (sin archivos de audio).
//
// Cada temática tiene su propio "instrumento", su escala y su sonido de paso:
//   tema_david     (Piratas)   → madera que cruje, campana de barco, cañón
//   tema_jossef    (Fantasía)  → destellos de arpa y cristal, glissandos mágicos
//   tema_sebastian (Vikingos)  → tambor de guerra y cuerno
//   tema_santiago  (Letras)    → máquina de escribir, campanilla, hoja de papel
//
// Uso: Sound.play('buy', 'tema_david')
// Eventos: step, roll, turn, buy, build, pay, collect, card, jail, trade,
//          tradeOk, tick, timeout, expel, win, achievement
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const STORE_KEY = 'sound_muted';
  let ctx = null;
  let master = null;
  let muted = false;
  try { muted = localStorage.getItem(STORE_KEY) === '1'; } catch { /* sin storage */ }

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.35;
      // Compresor suave para que varios sonidos a la vez no saturen
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Los navegadores solo permiten audio después de una interacción del usuario
  const unlock = () => { audio(); };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });

  // ── Primitivas ─────────────────────────────────────────────────────────────
  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  function tone({ type = 'sine', freq = 440, to = null, at = 0, dur = 0.2, gain = 0.5,
                  attack = 0.005, release = null, filter = null, q = 1, detune = 0 }) {
    const a = audio(); if (!a) return;
    const t0 = a.currentTime + at;
    const osc = a.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    osc.detune.value = detune;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (release || dur));
    let node = osc;
    if (filter) {
      const f = a.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = filter; f.Q.value = q;
      node = node.connect(f);
    }
    node.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + (release || dur) + 0.05);
  }

  let noiseBuf = null;
  function noise({ at = 0, dur = 0.1, gain = 0.4, type = 'bandpass', freq = 1000, to = null, q = 1, attack = 0.002 }) {
    const a = audio(); if (!a) return;
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = a.currentTime + at;
    const src = a.createBufferSource();
    src.buffer = noiseBuf;
    const f = a.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  // ── Temáticas ──────────────────────────────────────────────────────────────
  // note(midi, at, dur, gain): el "instrumento" melódico de cada temática
  // step(i): sonido de cada casilla que pisa la ficha
  // special: efectos propios (tarjeta, cárcel)
  const THEMES = {
    // Piratas: acordeón/concertina, escala dórica, madera y campana de barco
    tema_david: {
      scale: [62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79],
      note(m, at, dur, gain = 0.32) {
        tone({ type: 'sawtooth', freq: hz(m), at, dur, gain: gain * 0.5, attack: 0.03, filter: 1600, q: 2 });
        tone({ type: 'square', freq: hz(m), at, dur, gain: gain * 0.25, attack: 0.03, filter: 1200, detune: 8 });
      },
      step(i) {
        const pitch = i % 2 ? 210 : 170;
        tone({ type: 'triangle', freq: pitch, to: pitch * 0.6, dur: 0.12, gain: 0.5 });
        noise({ dur: 0.07, gain: 0.25, type: 'lowpass', freq: 900 });
      },
      bell(at = 0) {
        tone({ type: 'sine', freq: 880, at, dur: 1.2, gain: 0.35 });
        tone({ type: 'sine', freq: 880 * 2.76, at, dur: 0.6, gain: 0.12 });
        tone({ type: 'sine', freq: 880 * 5.4, at, dur: 0.3, gain: 0.05 });
      },
      card() { noise({ dur: 0.5, gain: 0.3, freq: 400, to: 2400, q: 0.8 }); this.note(69, 0.2, 0.25); this.note(74, 0.4, 0.35); },
      jail() {
        noise({ dur: 0.9, gain: 0.7, type: 'lowpass', freq: 600, to: 80 });
        tone({ type: 'sine', freq: 110, to: 35, dur: 0.8, gain: 0.8 });
      }
    },

    // Fantasía: arpa y cristales, escala lidia, destellos
    tema_jossef: {
      scale: [65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83],
      note(m, at, dur, gain = 0.3) {
        tone({ type: 'triangle', freq: hz(m), at, dur: dur + 0.4, gain, attack: 0.004 });
        tone({ type: 'sine', freq: hz(m + 12), at, dur: dur + 0.2, gain: gain * 0.3, attack: 0.004 });
      },
      step(i) {
        const notes = [84, 86, 88, 91, 93];
        tone({ type: 'sine', freq: hz(notes[i % notes.length]), dur: 0.35, gain: 0.22 });
        tone({ type: 'sine', freq: hz(notes[i % notes.length] + 7), at: 0.04, dur: 0.25, gain: 0.08 });
      },
      bell(at = 0) { [96, 100, 103].forEach((m, k) => tone({ type: 'sine', freq: hz(m), at: at + k * 0.05, dur: 0.8, gain: 0.12 })); },
      card() { for (let k = 0; k < 8; k++) this.note(72 + k * 2, k * 0.04, 0.2, 0.18); },
      jail() { [69, 65, 62, 58].forEach((m, k) => tone({ type: 'triangle', freq: hz(m), at: k * 0.15, dur: 0.5, gain: 0.3 })); }
    },

    // Vikingos: cuerno de guerra y tambor, escala menor natural
    tema_sebastian: {
      scale: [50, 52, 53, 55, 57, 58, 60, 62, 64, 65, 67],
      note(m, at, dur, gain = 0.38) {
        tone({ type: 'sawtooth', freq: hz(m), at, dur, gain, attack: 0.08, filter: 900, q: 3 });
        tone({ type: 'sawtooth', freq: hz(m + 7), at, dur, gain: gain * 0.35, attack: 0.1, filter: 700, detune: -6 });
      },
      step(i) {
        tone({ type: 'sine', freq: i % 2 ? 95 : 80, to: 42, dur: 0.22, gain: 0.85 });
        noise({ dur: 0.08, gain: 0.3, type: 'lowpass', freq: 500 });
      },
      bell(at = 0) { tone({ type: 'sine', freq: 70, to: 40, at, dur: 0.5, gain: 0.9 }); noise({ at, dur: 0.3, gain: 0.4, type: 'lowpass', freq: 300 }); },
      card() { noise({ dur: 0.4, gain: 0.35, freq: 300, to: 1200, q: 1.5 }); this.note(57, 0.15, 0.4); },
      jail() {
        for (let k = 0; k < 3; k++) this.bell(k * 0.22);
        this.note(45, 0.5, 0.9, 0.45);
      }
    },

    // Letras: máquina de escribir, campanilla de fin de línea, hoja de papel
    tema_santiago: {
      scale: [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84],
      note(m, at, dur, gain = 0.28) {
        // piano/celesta suave
        tone({ type: 'sine', freq: hz(m), at, dur: dur + 0.3, gain, attack: 0.003 });
        tone({ type: 'triangle', freq: hz(m) * 2, at, dur: dur * 0.6, gain: gain * 0.25, attack: 0.003 });
      },
      step() {
        noise({ dur: 0.035, gain: 0.55, type: 'highpass', freq: 2500 });
        tone({ type: 'square', freq: 1800, to: 900, dur: 0.03, gain: 0.08 });
        noise({ at: 0.03, dur: 0.05, gain: 0.2, type: 'bandpass', freq: 700, q: 2 });
      },
      bell(at = 0) { tone({ type: 'sine', freq: 2093, at, dur: 0.9, gain: 0.25 }); tone({ type: 'sine', freq: 2093 * 2.4, at, dur: 0.4, gain: 0.06 }); },
      card() { noise({ dur: 0.35, gain: 0.35, freq: 3000, to: 600, q: 0.7 }); noise({ at: 0.18, dur: 0.2, gain: 0.25, freq: 1500, to: 4000, q: 0.7 }); },
      jail() {
        tone({ type: 'sine', freq: 140, to: 60, dur: 0.25, gain: 0.8 }); // sello
        noise({ dur: 0.12, gain: 0.5, type: 'lowpass', freq: 800 });
        [67, 64, 60].forEach((m, k) => this.note(m, 0.3 + k * 0.18, 0.3));
      }
    }
  };
  const FALLBACK = 'tema_david';

  // Melodías comunes, tocadas con el instrumento y la escala de cada temática
  function melody(th, degrees, step = 0.12, dur = 0.18, gain) {
    degrees.forEach((d, k) => th.note(th.scale[d], k * step, dur, gain));
  }

  function dice() {
    for (let k = 0; k < 6; k++) noise({ at: k * 0.055 + Math.random() * 0.02, dur: 0.04, gain: 0.35, freq: 2200 + Math.random() * 1500, q: 3 });
    noise({ at: 0.36, dur: 0.06, gain: 0.4, freq: 1400, q: 2 });
  }

  const EVENTS = {
    step: (th, i) => th.step(i || 0),
    roll: () => dice(),
    turn: (th) => melody(th, [0, 2, 4, 7], 0.11, 0.2),
    buy: (th) => { melody(th, [4, 7], 0.1, 0.2); th.bell(0.22); },
    build: (th) => { th.step(0); th.step(1); melody(th, [4, 5, 7], 0.08, 0.15); },
    pay: (th) => melody(th, [4, 2, 0], 0.13, 0.22),
    collect: (th) => melody(th, [0, 4, 7, 9], 0.07, 0.14),
    card: (th) => th.card(),
    jail: (th) => th.jail(),
    trade: (th) => melody(th, [2, 4, 7], 0.12, 0.2),
    tradeOk: (th) => { melody(th, [0, 4, 7, 10], 0.09, 0.2); th.bell(0.4); },
    tick: () => tone({ type: 'square', freq: 1250, dur: 0.04, gain: 0.12, filter: 3000 }),
    timeout: (th) => { melody(th, [7, 6, 5, 4], 0.1, 0.2); },
    expel: (th) => melody(th, [7, 4, 2, 0], 0.18, 0.35),
    win: (th) => {
      melody(th, [0, 2, 4, 7, 4, 7, 10], 0.13, 0.25);
      th.bell(0.95);
      melody(th, [7, 9, 10], 0.0, 1.0, 0.18); // acorde final
    },
    achievement: (th) => {
      melody(th, [4, 7, 9, 10], 0.08, 0.2);
      [96, 100, 103, 108].forEach((m, k) => tone({ type: 'sine', freq: hz(m), at: 0.35 + k * 0.06, dur: 0.6, gain: 0.08 }));
    }
  };

  function play(event, themeId, arg) {
    if (muted) return;
    const fn = EVENTS[event];
    if (!fn || !audio()) return;
    try { fn(THEMES[themeId] || THEMES[FALLBACK], arg); } catch (err) { console.warn('[SOUND]', err); }
  }

  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem(STORE_KEY, muted ? '1' : '0'); } catch { /* sin storage */ }
  }

  window.Sound = { play, setMuted, isMuted: () => muted };
})();
