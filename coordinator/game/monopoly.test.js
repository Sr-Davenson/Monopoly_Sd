// Pruebas del motor: node --test coordinator/game
const test = require('node:test');
const assert = require('node:assert/strict');
const { MonopolyGame, GameError } = require('./monopoly');
const eco = require('./economy');
const { SPACES } = require('./board');

// RNG determinista: los dados salen de una cola; el barajado no cambia el orden.
function scriptedRng() {
  const dice = [];
  return {
    dice,
    int(min, max) {
      if (min === 1 && max === 7) {
        if (!dice.length) throw new Error('Sin dados programados');
        return dice.shift();
      }
      return max - 1; // barajado: j = i (identidad)
    }
  };
}

function newGame(n = 2) {
  const rng = scriptedRng();
  const g = new MonopolyGame({ rng });
  const themes = ['tema_david', 'tema_jossef', 'tema_sebastian', 'tema_santiago'];
  for (let i = 1; i <= n; i++) g.handle(String(i), `p${i}`, 'join', { themeId: themes[(i - 1) % 4] });
  g.handle('1', 'p1', 'start');
  const [a, b] = g.players;
  return { g, rng, a, b };
}

test('la partida arranca con el dinero inicial y la ficha de la temática elegida', () => {
  const { g, a } = newGame();
  assert.equal(g.phase, 'playing');
  assert.equal(a.money, eco.STARTING_MONEY);
  assert.equal(g.turn.playerId, a.id);
  assert.ok(a.skin.starter);
});

test('solo el anfitrión inicia y no se puede unir nadie después', () => {
  const g = new MonopolyGame({ rng: scriptedRng() });
  g.handle('1', 'p1', 'join', { themeId: 'tema_david' });
  g.handle('2', 'p2', 'join', { themeId: 'tema_jossef' });
  assert.throws(() => g.handle('2', 'p2', 'start'), GameError);
  g.handle('1', 'p1', 'start');
  assert.throws(() => g.handle('3', 'p3', 'join', { themeId: 'tema_david' }), /ya comenzó/);
});

test('comprar y cobrar renta (doble con el grupo completo)', () => {
  const { g, rng, a, b } = newGame();
  rng.dice.push(1, 2);              // a → casilla 3 (A2 de David)
  g.handle(a.id, '', 'roll');
  assert.equal(g.turn.stage, 'buy');
  g.handle(a.id, '', 'buy');
  assert.equal(a.money, eco.STARTING_MONEY - SPACES[3].price);
  g.handle(a.id, '', 'end_turn');

  rng.dice.push(1, 2);              // b cae en la propiedad de a
  g.handle(b.id, '', 'roll');
  assert.equal(b.money, eco.STARTING_MONEY - SPACES[3].rents[0]);

  g.properties[1].ownerId = a.id;   // a completa el grupo A
  assert.equal(g.computeRent(SPACES[3], g.properties[3]), SPACES[3].rents[0] * 2);
});

test('pasar por Salida paga el salario', () => {
  const { g, a } = newGame();
  a.position = 38;
  g.moveBy(a, 4);
  assert.equal(a.position, 2);
  assert.equal(a.money, eco.STARTING_MONEY + eco.SALARY);
});

test('tres dobles seguidos mandan a la cárcel', () => {
  const { g, rng, a } = newGame();
  rng.dice.push(1, 1, 2, 2, 3, 3);
  g.handle(a.id, '', 'roll');                 // 2 → Tarjeta General
  if (g.turn.stage === 'buy') g.handle(a.id, '', 'decline');
  a.position = 0; a.inJail = false;           // aislar el efecto de la carta
  g.turn.stage = 'roll'; g.turn.rollAgain = true;
  g.handle(a.id, '', 'roll');
  if (g.turn.stage === 'buy') g.handle(a.id, '', 'decline');
  g.handle(a.id, '', 'roll');
  assert.equal(a.inJail, true);
  assert.equal(a.position, 10);
  assert.equal(g.turn.stage, 'end');
});

test('donación va al Fondo y Descanso lo cobra', () => {
  const { g, rng, a, b } = newGame();
  rng.dice.push(1, 3);                        // a → 4 (Donación de David)
  g.handle(a.id, '', 'roll');
  assert.equal(g.pot, eco.DONATION_AMOUNTS[0]);
  g.handle(a.id, '', 'end_turn');
  b.position = 15;
  rng.dice.push(2, 3);                        // b → 20 (Descanso)
  g.handle(b.id, '', 'roll');
  assert.equal(g.pot, 0);
  assert.equal(b.money, eco.STARTING_MONEY + eco.DONATION_AMOUNTS[0]);
});

test('construcción pareja y venta al 50%', () => {
  const { g, a } = newGame();
  g.properties[1].ownerId = a.id;
  g.properties[3].ownerId = a.id;
  g.handle(a.id, '', 'build', { spaceId: 1 });
  assert.throws(() => g.handle(a.id, '', 'build', { spaceId: 1 }), /pareja/);
  g.handle(a.id, '', 'build', { spaceId: 3 });
  assert.equal(g.properties[1].level, 1);
  const before = a.money;
  g.handle(a.id, '', 'sell_building', { spaceId: 3 });
  assert.equal(a.money, before + SPACES[3].houseCost / 2);
});

test('no se puede hipotecar con construcciones en el grupo', () => {
  const { g, a } = newGame();
  g.properties[1].ownerId = a.id;
  g.properties[3].ownerId = a.id;
  g.handle(a.id, '', 'build', { spaceId: 1 });
  assert.throws(() => g.handle(a.id, '', 'mortgage', { spaceId: 3 }), /construcciones/);
});

test('deuda: hipotecar para pagar y luego seguir', () => {
  const { g, rng, a, b } = newGame();
  g.properties[39].ownerId = b.id;
  g.properties[39].level = 5;                 // hotel
  g.properties[5].ownerId = a.id;
  a.position = 35;
  a.money = 1800;
  const rent = SPACES[39].rents[5];           // 1880
  rng.dice.push(1, 3);                        // a → 39
  g.handle(a.id, '', 'roll');
  assert.equal(g.turn.stage, 'debt');
  assert.throws(() => g.handle(a.id, '', 'end_turn'), GameError);
  g.handle(a.id, '', 'mortgage', { spaceId: 5 });   // +100 → 1900 ≥ 1880
  assert.equal(g.turn.debt, null);
  assert.equal(g.turn.stage, 'end');
  assert.equal(a.money, 1900 - rent);
  assert.equal(b.money, eco.STARTING_MONEY + rent);
});

test('bancarrota: los bienes pasan al acreedor y gana el último', () => {
  const { g, rng, a, b } = newGame();
  g.properties[39].ownerId = b.id;
  g.properties[39].level = 5;
  g.properties[1].ownerId = a.id;
  a.position = 35;
  a.money = 10;
  rng.dice.push(1, 3);
  g.handle(a.id, '', 'roll');
  g.handle(a.id, '', 'bankrupt');
  assert.equal(a.bankrupt, true);
  assert.equal(g.properties[1].ownerId, b.id);
  assert.equal(g.phase, 'finished');
  assert.equal(g.winnerId, b.id);
});

test('intercambio: dinero por propiedad', () => {
  const { g, a, b } = newGame();
  g.properties[11].ownerId = b.id;
  g.handle(a.id, '', 'trade_propose', { toId: b.id, offer: { money: 300 }, request: { properties: [11] } });
  assert.throws(() => g.handle(a.id, '', 'trade_respond', { tradeId: g.trade.id, accept: true }), /no es para ti/);
  g.handle(b.id, '', 'trade_respond', { tradeId: g.trade.id, accept: true });
  assert.equal(g.properties[11].ownerId, a.id);
  assert.equal(a.money, eco.STARTING_MONEY - 300);
  assert.equal(b.money, eco.STARTING_MONEY + 300);
});

test('intercambio inválido: ofrecer algo ajeno o fuera de turno', () => {
  const { g, a, b } = newGame();
  g.properties[11].ownerId = b.id;
  assert.throws(() => g.handle(a.id, '', 'trade_propose', { toId: b.id, offer: { properties: [11] } }), /no es de/);
  assert.throws(() => g.handle(b.id, '', 'trade_propose', { toId: a.id, offer: { money: 1 } }), /No es tu turno/);
  assert.throws(() => g.handle(a.id, '', 'trade_propose', { toId: b.id, offer: { money: -5 } }), /Monto/);
});

test('cárcel: pagar multa y salir', () => {
  const { g, a } = newGame();
  g.sendToJail(a);
  g.handle(a.id, '', 'pay_jail');
  assert.equal(a.inJail, false);
  assert.equal(a.money, eco.STARTING_MONEY - eco.JAIL_FINE);
});

test('las cartas aplican su efecto', () => {
  const { g, a } = newGame();
  g.decks.general.unshift(0);                 // "Cobra 200"
  a.position = 2;
  g.resolveLanding(a);
  assert.equal(a.money, eco.STARTING_MONEY + 200);
  assert.equal(g.lastCard.deck, 'general');
});

test('acciones fuera de etapa no cambian el estado', () => {
  const { g, a } = newGame();
  const v = g.version;
  assert.throws(() => g.handle(a.id, '', 'end_turn'), GameError);
  assert.throws(() => g.handle(a.id, '', 'buy'), GameError);
  assert.equal(g.version, v);
});

// ── Taller 6: fichas, misiones y replicación ─────────────────────────────────
const { THEMES, isSkinUnlocked, isDiceUnlocked, isItemUnlocked } = require('./themes');

test('se puede elegir una ficha de la temática y se rechaza una ajena', () => {
  const g = new MonopolyGame({ rng: scriptedRng() });
  g.handle('1', 'p1', 'join', { themeId: 'tema_santiago', skinId: 'santiago_sisifo' });
  assert.equal(g.getPlayer('1').skin.id, 'santiago_sisifo');
  assert.throws(() => g.handle('2', 'p2', 'join', { themeId: 'tema_david', skinId: 'santiago_samsa' }), /no pertenece/);
});

test('cada temática tiene una ficha inicial, misiones en las demás y 4 dados', () => {
  for (const t of THEMES) {
    assert.equal(t.skins.filter(s => s.starter).length, 1, t.id);
    assert.equal(t.dice.length, 4, t.id);
    for (const s of t.skins.filter(x => !x.starter)) {
      assert.ok(s.unlock && s.unlock.count > 0, s.id);
      assert.equal(isSkinUnlocked(t, s, {}), false);
    }
    for (const d of t.dice) assert.equal(isDiceUnlocked(d.id, {}), false, d.id);
  }
  assert.equal(isDiceUnlocked('dado_clasico', {}), true);
});

test('las fichas de un grupo se liberan en orden y solo con el progreso de ese grupo', () => {
  const t = THEMES[0];
  const second = t.skins[2];
  // Cumple la misión de la 3.ª ficha, pero no la de la 2.ª → sigue bloqueada
  const onlyThird = { themes: { [t.id]: { [second.unlock.stat]: second.unlock.count } } };
  assert.equal(isSkinUnlocked(t, second, onlyThird), false);
  const both = { themes: { [t.id]: { [t.skins[1].unlock.stat]: 99, [second.unlock.stat]: second.unlock.count } } };
  assert.equal(isSkinUnlocked(t, second, both), true);
  // El progreso de OTRO grupo no cuenta
  const other = { themes: { [THEMES[1].id]: both.themes[t.id] } };
  assert.equal(isItemUnlocked(t, t.skins, 1, other), false);
});

test('contraoferta: quien recibe la reemplaza y el otro puede aceptarla', () => {
  const { g, rng, a, b } = newGame();
  rng.dice.push(1, 2);
  g.handle(a.id, '', 'roll');
  g.handle(a.id, '', 'buy');
  const sid = Object.keys(g.properties).find(k => g.properties[k].ownerId === a.id);
  g.handle(a.id, '', 'trade_propose', { toId: b.id, offer: { properties: [Number(sid)] }, request: { money: 500 } });
  const first = g.trade.id;
  g.handle(b.id, '', 'trade_counter', { tradeId: first, offer: { money: 200 }, request: { properties: [Number(sid)] } });
  assert.equal(g.trade.fromId, b.id);
  assert.equal(g.trade.toId, a.id);
  assert.throws(() => g.handle(b.id, '', 'trade_respond', { tradeId: g.trade.id, accept: true }), /no es para ti/);
  const moneyA = a.money;
  g.handle(a.id, '', 'trade_respond', { tradeId: g.trade.id, accept: true });
  assert.equal(g.properties[sid].ownerId, b.id);
  assert.equal(a.money, moneyA + 200);
  assert.equal(a.stats.tradesDone, 1);
});

test('join respeta el color pedido si está libre y asigna otro si no', () => {
  const g = new MonopolyGame({ rng: scriptedRng() });
  g.handle('1', 'p1', 'join', { themeId: 'tema_david', color: '#ec4899', diceId: 'dado_sith' });
  g.handle('2', 'p2', 'join', { themeId: 'tema_david', color: '#EC4899' });
  assert.equal(g.getPlayer('1').color, '#ec4899');
  assert.notEqual(g.getPlayer('2').color, '#ec4899');
  assert.equal(g.getPlayer('1').dice.id, 'dado_sith');
  assert.equal(g.getPlayer('2').dice.id, 'dado_clasico');
});

test('serialize/load reproduce la partida completa en otra instancia', () => {
  const { g, rng, a } = newGame(3);
  rng.dice.push(1, 2);
  g.handle(a.id, '', 'roll');
  g.handle(a.id, '', 'buy');
  const copy = new MonopolyGame({ rng: scriptedRng() });
  copy.load(g.serialize());
  assert.deepEqual(copy.toJSON(), g.toJSON());
  assert.deepEqual(copy.decks, g.decks);
  assert.equal(copy.getPlayer(a.id).stats.propertiesBought, 1);
});

test('al terminar, results() reporta ganador y estadísticas', () => {
  const { g, a, b } = newGame();
  g.handle(b.id, '', 'forfeit');
  const r = g.results();
  assert.ok(r.matchId);
  assert.equal(r.players.find(p => p.userId === a.id).won, true);
  assert.equal(r.players.find(p => p.userId === b.id).won, false);
});

test('el turno tiene 90 s; al vencer pasa al siguiente jugador', () => {
  const { g, a, b } = newGame(3);
  const id = g.turn.playerId;
  assert.ok(g.turn.deadline > Date.now());
  assert.equal(g.timeoutTurn(id), false, 'antes de tiempo no hace nada');
  g.turn.deadline = Date.now() - 1;
  assert.equal(g.timeoutTurn(id), true);
  assert.notEqual(g.turn.playerId, id);
  assert.ok(!a.bankrupt && !b.bankrupt);
});

test('desconectado más de 30 s queda fuera; si vuelve antes no', () => {
  const { g, a, b } = newGame(3);
  g.setConnected(b.id, false);
  assert.equal(g.expelDisconnected(b.id, 30000), false, 'aún dentro de la gracia');
  g.setConnected(b.id, true);
  assert.equal(b.disconnectedAt, null);
  g.setConnected(b.id, false);
  b.disconnectedAt = Date.now() - 31000;
  assert.equal(g.expelDisconnected(b.id, 30000), true);
  assert.ok(b.bankrupt);
  assert.equal(g.phase, 'playing');
  // si solo queda uno, gana
  const c = g.players[2];
  g.setConnected(c.id, false);
  c.disconnectedAt = Date.now() - 31000;
  g.expelDisconnected(c.id, 30000);
  assert.equal(g.phase, 'finished');
  assert.equal(g.winnerId, a.id);
});

// ── Subasta de bienes en bancarrota ──────────────────────────────────────────
test('subasta: al quebrar con 3+ jugadores sus propiedades se subastan una a una', () => {
  const { g, a, b } = newGame(3);
  const c = g.players[2];
  g.properties[1].ownerId = b.id;
  g.properties[3].ownerId = b.id;
  b.money = 500;
  g.handle(b.id, '', 'forfeit');
  assert.ok(b.bankrupt);
  assert.ok(g.auction, 'se abrió la subasta');
  assert.equal(g.properties[1].ownerId, null);
  assert.equal(g.auction.current, 1);
  assert.equal(g.auction.total, 2);

  // durante la subasta el resto del juego se bloquea
  assert.throws(() => g.handle(g.turn.playerId, '', 'roll'), /subasta/);

  assert.throws(() => g.handle(a.id, '', 'auction_bid', { amount: 5 }), /mínima/);
  g.handle(a.id, '', 'auction_bid', { amount: 60 });
  assert.throws(() => g.handle(a.id, '', 'auction_bid', { amount: 100 }), /mejor oferta/);
  assert.throws(() => g.handle(c.id, '', 'auction_bid', { amount: 60 }), /mínima/);
  assert.throws(() => g.handle(c.id, '', 'auction_bid', { amount: c.money + 1 }), /No tienes/);
  g.handle(c.id, '', 'auction_bid', { amount: 70 });
  g.handle(a.id, '', 'auction_pass');
  // a pasó y c va ganando: nadie más puede superar → se adjudica y sigue la siguiente
  assert.equal(g.properties[1].ownerId, c.id);
  assert.equal(c.money, eco.STARTING_MONEY - 70);
  assert.equal(g.auction.current, 3);

  // nadie oferta por la segunda: vence el reloj y vuelve al banco
  g.auction.deadline = Date.now() - 1;
  assert.equal(g.auctionTimeout(), true);
  assert.equal(g.properties[3].ownerId, null);
  assert.equal(g.auction, null);
  assert.ok(g.turn.deadline > Date.now(), 'el turno se reanuda con tiempo completo');

});

test('subasta: con solo 2 jugadores no hay subasta (la partida termina)', () => {
  const { g, a, b } = newGame(2);
  g.properties[1].ownerId = b.id;
  g.handle(b.id, '', 'forfeit');
  assert.equal(g.phase, 'finished');
  assert.equal(g.auction, null);
  assert.equal(g.properties[1].ownerId, null);
  assert.equal(g.winnerId, a.id);
});

test('subasta: si quien va ganando se rinde, la propiedad se reabre', () => {
  const { g, a, b } = newGame(4);
  const c = g.players[2];
  g.properties[1].ownerId = b.id;
  g.handle(b.id, '', 'forfeit');
  g.handle(a.id, '', 'auction_bid', { amount: 100 });
  g.handle(a.id, '', 'forfeit');
  assert.ok(a.bankrupt);
  assert.ok(g.auction || g.properties[1].ownerId === null);
  assert.equal(g.properties[1].ownerId, null);
  assert.ok(c);
});

test('subasta: serialize/load la conserva', () => {
  const { g, a, b } = newGame(3);
  g.properties[1].ownerId = b.id;
  g.handle(b.id, '', 'forfeit');
  g.handle(a.id, '', 'auction_bid', { amount: 40 });
  const copy = new MonopolyGame({ rng: scriptedRng() });
  copy.load(g.serialize());
  assert.deepEqual(copy.toJSON().auction, g.toJSON().auction);
  assert.equal(copy.toJSON().auction.bid, 40);
});
