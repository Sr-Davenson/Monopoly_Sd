// ─────────────────────────────────────────────────────────────────────────────
// Motor del juego (servidor autoritativo).
//
// El cliente solo manda ACCIONES ("tirar dados", "comprar", "construir"...).
// Todo lo demás —dados, movimiento, rentas, cartas, deudas— lo decide este
// módulo. Si una acción no es válida se lanza GameError y el estado no cambia.
//
// No depende de WebSocket ni de Express: se puede probar aislado
// (ver monopoly.test.js).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('node:crypto');
const eco = require('./economy');
const { SPACE, SPACES, GROUPS, BOARD_SIZE, JAIL_POSITION, isOwnable } = require('./board');
const { DECKS } = require('./cards');
const { findTheme, findSkin, starterSkin } = require('./themes');

class GameError extends Error {}

const PLAYER_COLORS = ['#f43f5e', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#06b6d4'];
const LOG_LIMIT = 40;

// rng.int(min, maxExclusive) — inyectable para pruebas
const defaultRng = { int: (min, max) => crypto.randomInt(min, max) };

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toAmount(v) {
  const n = Number(v || 0);
  if (!Number.isInteger(n) || n < 0) throw new GameError('Monto inválido');
  return n;
}

function spaceIds(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 40) throw new GameError('Lista de propiedades inválida');
  const ids = list.map(Number);
  if (ids.some(id => !Number.isInteger(id) || !SPACES[id] || !isOwnable(SPACES[id]))) {
    throw new GameError('Propiedad inválida');
  }
  if (new Set(ids).size !== ids.length) throw new GameError('Propiedades repetidas');
  return ids;
}

class MonopolyGame {
  constructor({ rng = defaultRng } = {}) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.phase      = 'lobby';         // lobby | playing | finished
    this.players    = [];              // en orden de turno
    this.hostId     = null;
    this.properties = {};              // spaceId -> { ownerId, level, mortgaged }
    for (const s of SPACES) {
      if (isOwnable(s)) this.properties[s.id] = { ownerId: null, level: 0, mortgaged: false };
    }
    this.decks = {
      general: shuffle(DECKS.general.map((_, i) => i), this.rng),
      special: shuffle(DECKS.special.map((_, i) => i), this.rng)
    };
    this.pot        = 0;               // Fondo de Donaciones
    this.turn       = null;
    this.trade      = null;
    this.nextTrade  = 1;
    this.winnerId   = null;
    this.lastCard   = null;
    this.log        = [];
    this.version    = 0;
    this.matchId    = null;            // id único de cada partida (para las misiones)
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  getPlayer(id) {
    return this.players.find(p => p.id === String(id)) || null;
  }

  requirePlayer(id) {
    const p = this.getPlayer(id);
    if (!p) throw new GameError('No estás en la partida');
    if (p.bankrupt) throw new GameError('Estás en bancarrota');
    return p;
  }

  requirePlaying() {
    if (this.phase !== 'playing') throw new GameError('La partida no está en curso');
  }

  current() {
    return this.turn ? this.getPlayer(this.turn.playerId) : null;
  }

  requireTurn(id) {
    this.requirePlaying();
    const p = this.requirePlayer(id);
    if (this.turn.playerId !== p.id) throw new GameError('No es tu turno');
    return p;
  }

  requireStage(...stages) {
    if (!stages.includes(this.turn.stage)) {
      throw new GameError(`Acción no permitida en esta etapa del turno (${this.turn.stage})`);
    }
  }

  activePlayers() {
    return this.players.filter(p => !p.bankrupt);
  }

  groupSpaces(groupId) {
    return SPACES.filter(s => s.type === SPACE.PROPERTY && s.group === groupId);
  }

  ownsGroup(ownerId, groupId) {
    return this.groupSpaces(groupId).every(s => this.properties[s.id].ownerId === ownerId);
  }

  countOwned(ownerId, type) {
    return SPACES.filter(s => s.type === type && this.properties[s.id].ownerId === ownerId).length;
  }

  ownedProperty(p, spaceId) {
    const id = Number(spaceId);
    const space = SPACES[id];
    if (!space || !isOwnable(space)) throw new GameError('Casilla inválida');
    const prop = this.properties[id];
    if (prop.ownerId !== p.id) throw new GameError('Esa propiedad no es tuya');
    return { space, prop };
  }

  // ── Sala de espera ─────────────────────────────────────────────────────────
  // skinId es opcional: si no se envía se usa la ficha inicial de la temática.
  // Que la ficha esté DESBLOQUEADA lo valida el coordinador (necesita el
  // progreso del usuario, que vive en el auth-service).
  join(id, username, themeId, skinId) {
    id = String(id);
    const theme = findTheme(themeId);
    if (!theme) throw new GameError('Temática inválida');
    const skin = skinId ? findSkin(theme, skinId) : starterSkin(theme);
    if (!skin) throw new GameError('Esa ficha no pertenece a la temática elegida');
    const existing = this.getPlayer(id);

    if (this.phase !== 'lobby') {
      if (existing) return; // reconexión
      throw new GameError('La partida ya comenzó');
    }

    // En la sala se puede cambiar de temática o ficha; al iniciar queda fija.
    if (existing) {
      existing.themeId = theme.id;
      existing.skin = { ...skin };
      return;
    }

    if (this.players.length >= eco.MAX_PLAYERS) throw new GameError('La partida está llena');

    const used = new Set(this.players.map(p => p.color));
    this.players.push({
      id,
      username,
      themeId: theme.id,
      skin: { ...skin },
      color: PLAYER_COLORS.find(c => !used.has(c)),
      money: eco.STARTING_MONEY,
      position: 0,
      inJail: false,
      jailTurns: 0,
      jailCards: [],
      bankrupt: false,
      connected: true,
      stats: { bought: 0, built: 0 }   // para las misiones de desbloqueo
    });
    if (!this.hostId) this.hostId = id;
    this.addLog(`${username} se unió con la temática ${theme.name}`);
  }

  leave(id) {
    if (this.phase !== 'lobby') throw new GameError('Solo puedes salir antes de iniciar (usa Rendirse)');
    const p = this.getPlayer(id);
    if (!p) throw new GameError('No estás en la partida');
    this.players = this.players.filter(x => x !== p);
    if (this.hostId === p.id) this.hostId = this.players[0] ? this.players[0].id : null;
    this.addLog(`${p.username} salió de la sala`);
  }

  start(id) {
    if (this.phase !== 'lobby') throw new GameError('La partida ya comenzó');
    if (String(id) !== this.hostId) throw new GameError('Solo el anfitrión puede iniciar');
    if (this.players.length < eco.MIN_PLAYERS) {
      throw new GameError(`Se necesitan al menos ${eco.MIN_PLAYERS} jugadores`);
    }
    this.players = shuffle(this.players, this.rng);
    this.phase = 'playing';
    this.matchId = crypto.randomUUID();
    this.addLog(`¡Comienza la partida! Orden: ${this.players.map(p => p.username).join(', ')}`);
    this.beginTurn(this.players[0]);
  }

  restart(id) {
    if (this.phase !== 'finished') throw new GameError('La partida no ha terminado');
    if (String(id) !== this.hostId) throw new GameError('Solo el anfitrión puede reiniciar');
    const keep = this.players.map(p => ({ id: p.id, username: p.username, themeId: p.themeId, skinId: p.skin.id, connected: p.connected }));
    const host = this.hostId;
    const version = this.version;
    this.reset();
    this.version = version;            // la versión nunca retrocede (replicación)
    for (const k of keep) {
      this.join(k.id, k.username, k.themeId, k.skinId);
      this.getPlayer(k.id).connected = k.connected;
    }
    this.hostId = host;
  }

  // ── Turnos ─────────────────────────────────────────────────────────────────
  beginTurn(p) {
    this.turn = {
      playerId: p.id,
      stage: 'roll',          // roll | buy | debt | end
      dice: null,
      doubles: 0,
      rollAgain: false,
      pendingBuy: null,
      debt: null              // { total, payees: [{ id, amount }] }
    };
    this.addLog(`Turno de ${p.username}`);
  }

  nextTurn() {
    if (this.trade) this.cancelTradeInternal('El turno terminó');
    const idx = this.players.findIndex(p => p.id === this.turn.playerId);
    for (let k = 1; k <= this.players.length; k++) {
      const next = this.players[(idx + k) % this.players.length];
      if (!next.bankrupt) return this.beginTurn(next);
    }
  }

  // Recalcula la etapa del turno después de cualquier resolución
  updateStage() {
    const p = this.current();
    if (this.turn.debt) this.turn.stage = 'debt';
    else if (this.turn.pendingBuy !== null) this.turn.stage = 'buy';
    else if (this.turn.rollAgain && !p.inJail) this.turn.stage = 'roll';
    else this.turn.stage = 'end';
  }

  rollDice() {
    return [this.rng.int(1, 7), this.rng.int(1, 7)];
  }

  roll(id) {
    const p = this.requireTurn(id);
    this.requireStage('roll');

    const dice = this.rollDice();
    const [d1, d2] = dice;
    const isDouble = d1 === d2;
    this.turn.dice = dice;
    this.turn.rollAgain = false;
    this.addLog(`${p.username} sacó ${d1} + ${d2}${isDouble ? ' (dobles)' : ''}`);

    if (p.inJail) {
      if (isDouble) {
        p.inJail = false;
        p.jailTurns = 0;
        this.addLog(`${p.username} sale del calabozo con dobles`);
        this.moveBy(p, d1 + d2);
        this.resolveLanding(p);
      } else {
        p.jailTurns++;
        if (p.jailTurns >= eco.MAX_JAIL_TURNS) {
          // Regla de la casa: al tercer intento paga la multa y sale, pero no se mueve este turno.
          p.inJail = false;
          p.jailTurns = 0;
          this.addLog(`${p.username} cumplió ${eco.MAX_JAIL_TURNS} turnos y paga la multa de ${eco.JAIL_FINE}`);
          this.charge(p, eco.JAIL_FINE, [{ id: null, amount: eco.JAIL_FINE }]);
        } else {
          this.addLog(`${p.username} sigue en el calabozo (intento ${p.jailTurns}/${eco.MAX_JAIL_TURNS})`);
        }
      }
      this.updateStage();
      return;
    }

    if (isDouble) {
      this.turn.doubles++;
      if (this.turn.doubles >= eco.MAX_DOUBLES) {
        this.addLog(`${p.username} sacó ${eco.MAX_DOUBLES} dobles seguidos`);
        this.sendToJail(p);
        this.updateStage();
        return;
      }
    }

    this.moveBy(p, d1 + d2);
    this.resolveLanding(p);
    this.turn.rollAgain = isDouble && !p.inJail;
    this.updateStage();
  }

  endTurn(id) {
    this.requireTurn(id);
    this.requireStage('end');
    this.nextTurn();
  }

  // ── Movimiento ─────────────────────────────────────────────────────────────
  moveBy(p, steps) {
    const target = p.position + steps;
    if (target >= BOARD_SIZE) {
      p.money += eco.SALARY;
      this.addLog(`${p.username} pasa por Salida y cobra ${eco.SALARY}`);
    }
    p.position = target % BOARD_SIZE;
  }

  moveTo(p, position) {
    const steps = (position - p.position + BOARD_SIZE) % BOARD_SIZE;
    this.moveBy(p, steps === 0 ? BOARD_SIZE : steps);
  }

  sendToJail(p) {
    p.position = JAIL_POSITION;
    p.inJail = true;
    p.jailTurns = 0;
    this.turn.rollAgain = false;
    this.addLog(`${p.username} va al calabozo`);
  }

  // ── Casillas ───────────────────────────────────────────────────────────────
  resolveLanding(p, { rentMultiplier = 1 } = {}) {
    const space = SPACES[p.position];
    this.addLog(`${p.username} cae en ${space.name}`);

    switch (space.type) {
      case SPACE.START:
      case SPACE.JAIL:
        return;

      case SPACE.REST:
        if (this.pot > 0) {
          p.money += this.pot;
          this.addLog(`${p.username} se lleva el Fondo de Donaciones: ${this.pot}`);
          this.pot = 0;
        }
        return;

      case SPACE.GO_TO_JAIL:
        return this.sendToJail(p);

      case SPACE.DONATION:
        return this.charge(p, space.amount, [{ id: 'pot', amount: space.amount }]);

      case SPACE.CARD_GENERAL:
        return this.drawCard(p, 'general');

      case SPACE.CARD_SPECIAL:
        return this.drawCard(p, 'special');

      default: {
        const prop = this.properties[space.id];
        if (!prop.ownerId) {
          this.turn.pendingBuy = space.id;
          return;
        }
        if (prop.ownerId === p.id) return;
        if (prop.mortgaged) {
          this.addLog(`${space.name} está hipotecada: no se paga renta`);
          return;
        }
        const rent = this.computeRent(space, prop) * rentMultiplier;
        const owner = this.getPlayer(prop.ownerId);
        this.addLog(`${p.username} debe pagar ${rent} de renta a ${owner.username}`);
        this.charge(p, rent, [{ id: owner.id, amount: rent }]);
      }
    }
  }

  computeRent(space, prop) {
    if (space.type === SPACE.PROPERTY) {
      if (prop.level > 0) return space.rents[prop.level];
      const full = this.ownsGroup(prop.ownerId, space.group);
      return space.rents[0] * (full ? eco.GROUP_RENT_MULTIPLIER : 1);
    }
    if (space.type === SPACE.TRANSPORT) {
      const n = this.countOwned(prop.ownerId, SPACE.TRANSPORT);
      return eco.TRANSPORT_RENTS[n - 1];
    }
    if (space.type === SPACE.SERVICE) {
      const n = this.countOwned(prop.ownerId, SPACE.SERVICE);
      const dice = this.turn.dice || [0, 0];
      return (dice[0] + dice[1]) * eco.SERVICE_MULTIPLIERS[n - 1];
    }
    return 0;
  }

  // ── Dinero y deudas ────────────────────────────────────────────────────────
  // payees: [{ id: playerId | null (banco) | 'pot' (Fondo), amount }]
  charge(p, total, payees) {
    if (total <= 0) return;
    if (this.turn.debt) {
      this.turn.debt.total += total;
      this.turn.debt.payees.push(...payees);
      return;
    }
    if (p.money >= total) {
      p.money -= total;
      this.distribute(payees);
      return;
    }
    this.turn.debt = { total, payees };
    this.addLog(`${p.username} no tiene suficiente dinero: debe ${total}. Hipoteca, vende o declárate en bancarrota.`);
  }

  distribute(payees) {
    for (const { id, amount } of payees) {
      if (id === 'pot') this.pot += amount;
      else if (id) {
        const r = this.getPlayer(id);
        if (r && !r.bankrupt) r.money += amount;
      }
    }
  }

  tryResolveDebt() {
    const p = this.current();
    const debt = this.turn && this.turn.debt;
    if (!debt || p.money < debt.total) return;
    p.money -= debt.total;
    this.distribute(debt.payees);
    this.turn.debt = null;
    this.addLog(`${p.username} pagó su deuda de ${debt.total}`);
    this.updateStage();
  }

  // ── Cartas ─────────────────────────────────────────────────────────────────
  drawCard(p, deckName) {
    const deck = this.decks[deckName];
    const index = deck.shift();
    const card = DECKS[deckName][index];
    const e = card.effect;

    if (e.kind === 'jail_free') p.jailCards.push({ deck: deckName, index });
    else deck.push(index);

    this.lastCard = { deck: deckName, title: card.title, text: card.text, playerId: p.id, seq: this.version + 1 };
    this.addLog(`${p.username} toma Tarjeta ${deckName === 'general' ? 'General' : 'Especial'}: ${card.text}`);

    switch (e.kind) {
      case 'collect':
        p.money += e.amount;
        break;
      case 'pay':
        this.charge(p, e.amount, [{ id: null, amount: e.amount }]);
        break;
      case 'donate':
        this.charge(p, e.amount, [{ id: 'pot', amount: e.amount }]);
        break;
      case 'collect_each':
        // Los demás pagan lo que puedan (fuera de su turno no se generan deudas)
        for (const o of this.activePlayers()) {
          if (o === p) continue;
          const paid = Math.min(o.money, e.amount);
          o.money -= paid;
          p.money += paid;
        }
        break;
      case 'pay_each': {
        const others = this.activePlayers().filter(o => o !== p);
        this.charge(p, e.amount * others.length, others.map(o => ({ id: o.id, amount: e.amount })));
        break;
      }
      case 'move_to':
        this.moveTo(p, e.position);
        this.resolveLanding(p);
        break;
      case 'move_back':
        p.position = (p.position - e.steps + BOARD_SIZE) % BOARD_SIZE;
        this.resolveLanding(p);
        break;
      case 'nearest_transport': {
        let pos = p.position;
        do { pos = (pos + 1) % BOARD_SIZE; } while (SPACES[pos].type !== SPACE.TRANSPORT);
        this.moveTo(p, pos);
        this.resolveLanding(p, { rentMultiplier: 2 });
        break;
      }
      case 'go_to_jail':
        this.sendToJail(p);
        break;
      case 'jail_free':
        break;
      case 'repairs': {
        let houses = 0, hotels = 0;
        for (const [id, prop] of Object.entries(this.properties)) {
          if (prop.ownerId !== p.id || SPACES[id].type !== SPACE.PROPERTY) continue;
          if (prop.level === eco.MAX_BUILDING_LEVEL) hotels++;
          else houses += prop.level;
        }
        const cost = houses * e.perHouse + hotels * e.perHotel;
        this.charge(p, cost, [{ id: null, amount: cost }]);
        break;
      }
    }
  }

  // ── Compra ─────────────────────────────────────────────────────────────────
  buy(id) {
    const p = this.requireTurn(id);
    this.requireStage('buy');
    const space = SPACES[this.turn.pendingBuy];
    if (p.money < space.price) {
      throw new GameError(`No te alcanza: cuesta ${space.price} y tienes ${p.money}. Puedes hipotecar o rechazar.`);
    }
    p.money -= space.price;
    this.properties[space.id].ownerId = p.id;
    p.stats.bought++;
    this.turn.pendingBuy = null;
    this.addLog(`${p.username} compró ${space.name} por ${space.price}`);
    this.updateStage();
  }

  decline(id) {
    const p = this.requireTurn(id);
    this.requireStage('buy');
    const space = SPACES[this.turn.pendingBuy];
    this.turn.pendingBuy = null;
    this.addLog(`${p.username} no compró ${space.name}`);
    this.updateStage();
  }

  // ── Cárcel ─────────────────────────────────────────────────────────────────
  payJail(id) {
    const p = this.requireTurn(id);
    this.requireStage('roll');
    if (!p.inJail) throw new GameError('No estás en el calabozo');
    if (p.money < eco.JAIL_FINE) throw new GameError('No te alcanza para la multa');
    p.money -= eco.JAIL_FINE;
    p.inJail = false;
    p.jailTurns = 0;
    this.addLog(`${p.username} pagó ${eco.JAIL_FINE} y sale del calabozo`);
  }

  useJailCard(id) {
    const p = this.requireTurn(id);
    this.requireStage('roll');
    if (!p.inJail) throw new GameError('No estás en el calabozo');
    const card = p.jailCards.pop();
    if (!card) throw new GameError('No tienes cartas para salir del calabozo');
    this.decks[card.deck].push(card.index);
    p.inJail = false;
    p.jailTurns = 0;
    this.addLog(`${p.username} usa su carta y sale del calabozo`);
  }

  // ── Construcción e hipotecas (solo en tu turno) ────────────────────────────
  build(id, spaceId) {
    const p = this.requireTurn(id);
    if (this.turn.stage === 'debt') throw new GameError('Primero paga tu deuda');
    const { space, prop } = this.ownedProperty(p, spaceId);
    if (space.type !== SPACE.PROPERTY) throw new GameError('Solo se construye en propiedades');
    if (!this.ownsGroup(p.id, space.group)) throw new GameError('Necesitas el grupo completo para construir');
    const group = this.groupSpaces(space.group).map(s => this.properties[s.id]);
    if (group.some(g => g.mortgaged)) throw new GameError('No puedes construir con propiedades hipotecadas en el grupo');
    if (prop.level >= eco.MAX_BUILDING_LEVEL) throw new GameError('Ya tiene hotel');
    if (prop.level > Math.min(...group.map(g => g.level))) {
      throw new GameError('Construye de forma pareja: primero en las demás propiedades del grupo');
    }
    if (p.money < space.houseCost) throw new GameError(`No te alcanza (${space.houseCost})`);
    p.money -= space.houseCost;
    prop.level++;
    p.stats.built++;
    this.addLog(`${p.username} construyó en ${space.name} (${prop.level === 5 ? 'hotel' : prop.level + ' casa(s)'})`);
  }

  sellBuilding(id, spaceId) {
    const p = this.requireTurn(id);
    const { space, prop } = this.ownedProperty(p, spaceId);
    if (space.type !== SPACE.PROPERTY || prop.level === 0) throw new GameError('No hay construcciones para vender');
    const group = this.groupSpaces(space.group).map(s => this.properties[s.id]);
    if (prop.level < Math.max(...group.map(g => g.level))) {
      throw new GameError('Vende de forma pareja: primero en las propiedades con más construcciones');
    }
    const refund = Math.floor(space.houseCost * eco.BUILDING_SELL_RATE);
    prop.level--;
    p.money += refund;
    this.addLog(`${p.username} vendió una construcción de ${space.name} por ${refund}`);
    this.tryResolveDebt();
  }

  mortgage(id, spaceId) {
    const p = this.requireTurn(id);
    const { space, prop } = this.ownedProperty(p, spaceId);
    if (prop.mortgaged) throw new GameError('Ya está hipotecada');
    if (space.type === SPACE.PROPERTY &&
        this.groupSpaces(space.group).some(s => this.properties[s.id].level > 0)) {
      throw new GameError('Vende primero las construcciones del grupo');
    }
    const value = Math.floor(space.price * eco.MORTGAGE_RATE);
    prop.mortgaged = true;
    p.money += value;
    this.addLog(`${p.username} hipotecó ${space.name} por ${value}`);
    this.tryResolveDebt();
  }

  unmortgage(id, spaceId) {
    const p = this.requireTurn(id);
    if (this.turn.stage === 'debt') throw new GameError('Primero paga tu deuda');
    const { space, prop } = this.ownedProperty(p, spaceId);
    if (!prop.mortgaged) throw new GameError('No está hipotecada');
    const cost = this.unmortgageCost(space);
    if (p.money < cost) throw new GameError(`No te alcanza (${cost})`);
    p.money -= cost;
    prop.mortgaged = false;
    this.addLog(`${p.username} levantó la hipoteca de ${space.name} por ${cost}`);
  }

  unmortgageCost(space) {
    return Math.ceil(space.price * eco.MORTGAGE_RATE * (1 + eco.UNMORTGAGE_INTEREST));
  }

  // ── Intercambios (los propone el jugador en turno) ─────────────────────────
  normalizeSide(side) {
    side = side || {};
    return {
      money: toAmount(side.money),
      properties: spaceIds(side.properties),
      jailCards: toAmount(side.jailCards)
    };
  }

  validateSide(player, side) {
    if (player.money < side.money) throw new GameError(`${player.username} no tiene ${side.money}`);
    if (player.jailCards.length < side.jailCards) throw new GameError(`${player.username} no tiene esas cartas del calabozo`);
    for (const sid of side.properties) {
      const space = SPACES[sid];
      if (this.properties[sid].ownerId !== player.id) {
        throw new GameError(`${space.name} no es de ${player.username}`);
      }
      if (space.type === SPACE.PROPERTY &&
          this.groupSpaces(space.group).some(s => this.properties[s.id].level > 0)) {
        throw new GameError(`${space.name}: vende las construcciones del grupo antes de intercambiar`);
      }
    }
  }

  proposeTrade(id, { toId, offer, request } = {}) {
    const p = this.requireTurn(id);
    if (this.turn.stage === 'buy') throw new GameError('Decide primero si compras la propiedad');
    if (this.trade) throw new GameError('Ya hay un intercambio pendiente');
    const target = this.getPlayer(toId);
    if (!target || target.bankrupt || target === p) throw new GameError('Jugador destino inválido');

    offer = this.normalizeSide(offer);
    request = this.normalizeSide(request);
    const empty = s => s.money === 0 && s.properties.length === 0 && s.jailCards === 0;
    if (empty(offer) && empty(request)) throw new GameError('El intercambio está vacío');
    this.validateSide(p, offer);
    this.validateSide(target, request);

    this.trade = { id: this.nextTrade++, fromId: p.id, toId: target.id, offer, request };
    this.addLog(`${p.username} propone un intercambio a ${target.username}`);
  }

  respondTrade(id, { tradeId, accept } = {}) {
    this.requirePlaying();
    const t = this.trade;
    if (!t || t.id !== Number(tradeId)) throw new GameError('Intercambio no encontrado');
    if (t.toId !== String(id)) throw new GameError('Este intercambio no es para ti');
    const from = this.getPlayer(t.fromId);
    const to = this.getPlayer(t.toId);

    if (!accept) {
      this.trade = null;
      this.addLog(`${to.username} rechazó el intercambio`);
      return;
    }

    // Revalidar: el estado pudo cambiar desde la propuesta
    this.validateSide(from, t.offer);
    this.validateSide(to, t.request);

    const move = (giver, receiver, side) => {
      giver.money -= side.money;
      receiver.money += side.money;
      for (const sid of side.properties) this.properties[sid].ownerId = receiver.id;
      for (let i = 0; i < side.jailCards; i++) receiver.jailCards.push(giver.jailCards.pop());
    };
    move(from, to, t.offer);
    move(to, from, t.request);
    this.trade = null;
    this.addLog(`${to.username} aceptó el intercambio con ${from.username}`);
    this.tryResolveDebt();
  }

  cancelTrade(id, { tradeId } = {}) {
    const t = this.trade;
    if (!t || t.id !== Number(tradeId)) throw new GameError('Intercambio no encontrado');
    if (t.fromId !== String(id)) throw new GameError('Solo quien propone puede cancelar');
    this.cancelTradeInternal('Cancelado por quien lo propuso');
  }

  cancelTradeInternal(reason) {
    this.trade = null;
    this.addLog(`Intercambio cancelado: ${reason}`);
  }

  // ── Bancarrota / rendirse ──────────────────────────────────────────────────
  declareBankruptcy(id) {
    const p = this.requireTurn(id);
    this.requireStage('debt');
    const players = this.turn.debt.payees.filter(x => x.id && x.id !== 'pot');
    const creditor = players.length === 1 && this.turn.debt.payees.length === 1
      ? this.getPlayer(players[0].id)
      : null;
    this.eliminate(p, creditor);
  }

  forfeit(id) {
    this.requirePlaying();
    const p = this.requirePlayer(id);
    this.addLog(`${p.username} se rinde`);
    this.eliminate(p, null);
  }

  // Elimina a un jugador. Sus bienes pasan al acreedor o vuelven al banco.
  eliminate(p, creditor) {
    let buildingsValue = 0;
    for (const [sid, prop] of Object.entries(this.properties)) {
      if (prop.ownerId !== p.id) continue;
      const space = SPACES[sid];
      if (prop.level > 0) buildingsValue += prop.level * Math.floor(space.houseCost * eco.BUILDING_SELL_RATE);
      prop.level = 0;
      if (creditor) {
        prop.ownerId = creditor.id;
      } else {
        prop.ownerId = null;
        prop.mortgaged = false;
      }
    }
    if (creditor) {
      creditor.money += Math.max(0, p.money) + buildingsValue;
      creditor.jailCards.push(...p.jailCards);
    } else {
      for (const c of p.jailCards) this.decks[c.deck].push(c.index);
    }
    p.money = 0;
    p.jailCards = [];
    p.bankrupt = true;
    this.addLog(creditor
      ? `${p.username} quebró: sus bienes pasan a ${creditor.username}`
      : `${p.username} quedó eliminado: sus bienes vuelven al banco`);

    if (this.trade && (this.trade.fromId === p.id || this.trade.toId === p.id)) {
      this.cancelTradeInternal('Un jugador quedó eliminado');
    }

    const alive = this.activePlayers();
    if (alive.length <= 1) {
      this.phase = 'finished';
      this.winnerId = alive[0] ? alive[0].id : null;
      this.turn = null;
      this.addLog(alive[0] ? `🏆 ¡${alive[0].username} gana la partida!` : 'Partida terminada');
      return;
    }
    if (this.turn.playerId === p.id) {
      this.turn.debt = null;
      this.nextTurn();
    }
  }

  // ── Conexión (lo llama el coordinador) ─────────────────────────────────────
  setConnected(id, connected) {
    const p = this.getPlayer(id);
    if (p) p.connected = connected;
  }

  // Salta el turno de un jugador desconectado
  skipDisconnected(id) {
    if (this.phase !== 'playing' || !this.turn || this.turn.playerId !== String(id)) return false;
    const p = this.current();
    if (p.connected) return false;
    if (this.turn.debt) {
      this.eliminate(p, null);
    } else {
      this.addLog(`Turno de ${p.username} saltado por desconexión`);
      this.turn.pendingBuy = null;
      this.nextTurn();
    }
    return true;
  }

  // ── Despacho de acciones ───────────────────────────────────────────────────
  handle(userId, username, action, data = {}) {
    const actions = {
      join:            () => this.join(userId, username, data.themeId, data.skinId),
      leave:           () => this.leave(userId),
      start:           () => this.start(userId),
      restart:         () => this.restart(userId),
      roll:            () => this.roll(userId),
      buy:             () => this.buy(userId),
      decline:         () => this.decline(userId),
      end_turn:        () => this.endTurn(userId),
      pay_jail:        () => this.payJail(userId),
      use_jail_card:   () => this.useJailCard(userId),
      build:           () => this.build(userId, data.spaceId),
      sell_building:   () => this.sellBuilding(userId, data.spaceId),
      mortgage:        () => this.mortgage(userId, data.spaceId),
      unmortgage:      () => this.unmortgage(userId, data.spaceId),
      trade_propose:   () => this.proposeTrade(userId, data),
      trade_respond:   () => this.respondTrade(userId, data),
      trade_cancel:    () => this.cancelTrade(userId, data),
      bankrupt:        () => this.declareBankruptcy(userId),
      forfeit:         () => this.forfeit(userId)
    };
    const fn = actions[action];
    if (!fn) throw new GameError(`Acción desconocida: ${action}`);
    fn();
    this.version++;
  }

  // Estado público que se envía a todos los clientes
  toJSON() {
    return {
      version: this.version,
      phase: this.phase,
      hostId: this.hostId,
      players: this.players.map(p => ({
        id: p.id,
        username: p.username,
        themeId: p.themeId,
        skin: p.skin,
        color: p.color,
        money: p.money,
        position: p.position,
        inJail: p.inJail,
        jailTurns: p.jailTurns,
        jailCards: p.jailCards.length,
        bankrupt: p.bankrupt,
        connected: p.connected
      })),
      properties: this.properties,
      pot: this.pot,
      turn: this.turn && {
        ...this.turn,
        debt: this.turn.debt && { total: this.turn.debt.total }
      },
      trade: this.trade,
      winnerId: this.winnerId,
      lastCard: this.lastCard,
      log: this.log
    };
  }

  // ── Replicación entre coordinadores ────────────────────────────────────────
  // serialize() incluye TODO el estado interno (mazos, contador de
  // intercambios, estadísticas...) para que otro coordinador pueda continuar
  // la partida exactamente donde quedó. toJSON() es solo la vista pública.
  serialize() {
    return JSON.parse(JSON.stringify({
      phase: this.phase,
      players: this.players,
      hostId: this.hostId,
      properties: this.properties,
      decks: this.decks,
      pot: this.pot,
      turn: this.turn,
      trade: this.trade,
      nextTrade: this.nextTrade,
      winnerId: this.winnerId,
      lastCard: this.lastCard,
      log: this.log,
      version: this.version,
      matchId: this.matchId
    }));
  }

  load(snapshot) {
    const data = JSON.parse(JSON.stringify(snapshot));
    for (const key of ['phase', 'players', 'hostId', 'properties', 'decks', 'pot', 'turn', 'trade',
                       'nextTrade', 'winnerId', 'lastCard', 'log', 'version', 'matchId']) {
      if (key in data) this[key] = data[key];
    }
  }

  // Resultado de la partida para las misiones (solo cuando terminó).
  results() {
    if (this.phase !== 'finished') return null;
    return {
      matchId: this.matchId,
      players: this.players.map(p => ({
        userId: p.id,
        won: p.id === this.winnerId,
        propertiesBought: p.stats ? p.stats.bought : 0,
        buildingsBuilt: p.stats ? p.stats.built : 0
      }))
    };
  }

  // Datos estáticos que el cliente necesita una sola vez
  static config() {
    const { THEMES, RARITIES, STATS } = require('./themes');
    const { MEMBERS } = require('./members');
    return {
      spaces: SPACES,
      groups: GROUPS,
      members: MEMBERS,
      themes: THEMES,
      rarities: RARITIES,
      stats: STATS,
      economy: {
        currency: eco.CURRENCY,
        startingMoney: eco.STARTING_MONEY,
        salary: eco.SALARY,
        jailFine: eco.JAIL_FINE,
        maxJailTurns: eco.MAX_JAIL_TURNS,
        mortgageRate: eco.MORTGAGE_RATE,
        unmortgageInterest: eco.UNMORTGAGE_INTEREST,
        buildingSellRate: eco.BUILDING_SELL_RATE,
        transportRents: eco.TRANSPORT_RENTS,
        serviceMultipliers: eco.SERVICE_MULTIPLIERS,
        minPlayers: eco.MIN_PLAYERS,
        maxPlayers: eco.MAX_PLAYERS
      }
    };
  }
}

module.exports = { MonopolyGame, GameError };
