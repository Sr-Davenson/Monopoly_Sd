// ─────────────────────────────────────────────────────────────────────────────
// Simulador de partidas con bots, para validar el balance económico.
//
//   node coordinator/game/simulate.js [partidas] [jugadores]
//
// Los bots siguen una estrategia simple:
//   - Compran si después les queda una reserva (RESERVE).
//   - Construyen cuando tienen un grupo completo y les sobra dinero.
//   - Cada cierto tiempo intercambian para completar grupos (pagan 1.5× precio).
//   - En deuda: venden construcciones, hipotecan y, si no alcanza, quiebran.
// ─────────────────────────────────────────────────────────────────────────────

const { MonopolyGame, GameError } = require('./monopoly');
const { SPACES, GROUPS, isOwnable } = require('./board');

const RESERVE = 150;
const MAX_TURNS = 3000;
const THEMES = ['tema_david', 'tema_jossef', 'tema_sebastian', 'tema_santiago'];

function act(g, id, action, data) {
  try { g.handle(id, '', action, data); return true; } catch (e) {
    if (e instanceof GameError) return false;
    throw e;
  }
}

function botTurn(g, p, stats) {
  for (let guard = 0; guard < 200; guard++) {
    if (g.phase !== 'playing' || g.turn.playerId !== p.id) return;
    const stage = g.turn.stage;

    if (stage === 'roll') {
      if (p.inJail && p.jailCards > 0) act(g, p.id, 'use_jail_card');
      act(g, p.id, 'roll');
    } else if (stage === 'buy') {
      const space = SPACES[g.turn.pendingBuy];
      if (p.money - space.price >= RESERVE) act(g, p.id, 'buy');
      else act(g, p.id, 'decline');
    } else if (stage === 'debt') {
      const mine = Object.entries(g.properties).filter(([, pr]) => pr.ownerId === p.id);
      const withHouses = mine.filter(([, pr]) => pr.level > 0).sort((x, y) => y[1].level - x[1].level);
      if (withHouses.length && act(g, p.id, 'sell_building', { spaceId: Number(withHouses[0][0]) })) continue;
      const free = mine.filter(([, pr]) => !pr.mortgaged);
      let ok = false;
      for (const [sid] of free) if (act(g, p.id, 'mortgage', { spaceId: Number(sid) })) { ok = true; break; }
      if (!ok) act(g, p.id, 'bankrupt');
    } else if (stage === 'end') {
      tryTrade(g, p);
      // Levantar hipotecas y construir con el excedente
      for (const [sid, pr] of Object.entries(g.properties)) {
        if (pr.ownerId === p.id && pr.mortgaged && p.money > 600) act(g, p.id, 'unmortgage', { spaceId: Number(sid) });
      }
      let built = true;
      while (built) {
        built = false;
        for (const s of SPACES) {
          const pr = g.properties[s.id];
          if (!pr || pr.ownerId !== p.id || s.type !== 'property') continue;
          if (p.money - s.houseCost >= RESERVE * 2 && act(g, p.id, 'build', { spaceId: s.id })) {
            built = true;
            if (stats.firstBuildTurn === null) stats.firstBuildTurn = stats.turns;
          }
        }
      }
      act(g, p.id, 'end_turn');
    }
  }
}

// Si al bot le falta UNA propiedad de un grupo, ofrece 1.5× su precio.
function tryTrade(g, p) {
  if (g.trade) return;
  for (const group of GROUPS) {
    const spaces = SPACES.filter(s => s.type === 'property' && s.group === group.id);
    const missing = spaces.filter(s => g.properties[s.id].ownerId !== p.id);
    if (missing.length !== 1) continue;
    const target = g.properties[missing[0].id];
    if (!target.ownerId) continue;
    const owner = g.getPlayer(target.ownerId);
    const offer = Math.round(missing[0].price * 1.5);
    if (p.money - offer < RESERVE) continue;
    // El dueño acepta si no le rompe un grupo propio casi completo
    const ownerCount = spaces.filter(s => g.properties[s.id].ownerId === owner.id).length;
    if (!act(g, p.id, 'trade_propose', { toId: owner.id, offer: { money: offer }, request: { properties: [missing[0].id] } })) continue;
    act(g, owner.id, 'trade_respond', { tradeId: g.trade.id, accept: ownerCount === 1 });
    return;
  }
}

function simulate(nPlayers) {
  const g = new MonopolyGame();
  for (let i = 0; i < nPlayers; i++) g.handle(String(i + 1), `bot${i + 1}`, 'join', { themeId: THEMES[i % 4] });
  g.handle('1', '', 'start');
  const stats = { turns: 0, firstBuildTurn: null, eliminations: [] };
  let ownedAt20 = null;

  while (g.phase === 'playing' && stats.turns < MAX_TURNS) {
    const before = g.activePlayers().length;
    botTurn(g, g.current(), stats);
    stats.turns++;
    if (g.activePlayers().length < before) stats.eliminations.push(stats.turns);
    if (stats.turns === 20 * nPlayers) {
      ownedAt20 = SPACES.filter(s => isOwnable(s) && g.properties[s.id].ownerId).length;
    }
  }
  return { finished: g.phase === 'finished', turns: stats.turns, firstBuildTurn: stats.firstBuildTurn, ownedAt20, firstElim: stats.eliminations[0] || null };
}

function avg(xs) { const v = xs.filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

if (require.main === module) {
  const games = Number(process.argv[2] || 500);
  const players = Number(process.argv[3] || 4);
  const results = Array.from({ length: games }, () => simulate(players));
  const r = (x, d = 1) => (x === null ? '—' : x.toFixed(d));
  console.log(`Partidas: ${games}  Jugadores: ${players}`);
  console.log(`Terminadas (antes de ${MAX_TURNS} turnos): ${r(100 * results.filter(x => x.finished).length / games)}%`);
  console.log(`Rondas promedio hasta terminar:  ${r(avg(results.filter(x => x.finished).map(x => x.turns / players)))}`);
  console.log(`Ronda de la primera construcción: ${r(avg(results.map(x => x.firstBuildTurn === null ? null : x.firstBuildTurn / players)))}`);
  console.log(`Ronda de la primera eliminación:  ${r(avg(results.map(x => x.firstElim === null ? null : x.firstElim / players)))}`);
  console.log(`Propiedades compradas a la ronda 20: ${r(avg(results.map(x => x.ownedAt20)))} de 26`);
}

module.exports = { simulate };
