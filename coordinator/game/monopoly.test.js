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
