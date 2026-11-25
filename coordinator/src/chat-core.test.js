// Pruebas del núcleo del chat: node --test src/chat-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LamportClock, compareMessages, sanitizeText, normalizeRemote, ChatLog, RateLimiter, createFloodGuard, MAX_LEN
} = require('./chat-core');

const msg = (origin, seq, lc, text = 'x') => ({ id: `${origin}#${seq}`, ch: 'global', userId: '1', username: 'u', text, ts: 0, lc, origin, seq });

test('sanitizeText: quita controles, colapsa espacios y limita la longitud', () => {
  assert.equal(sanitizeText('  hola \u0000\u0007  mundo\n\tx '), 'hola mundo x');
  assert.equal(sanitizeText('a‮b'), 'a b');           // RTL override
  assert.equal(sanitizeText('   '), null);
  assert.equal(sanitizeText('\u0000\u0001'), null);
  assert.equal(sanitizeText(42), null);
  assert.equal(sanitizeText('a'.repeat(MAX_LEN)).length, MAX_LEN);
  assert.equal(sanitizeText('a'.repeat(MAX_LEN + 1)), null);
  // el HTML no se toca aquí: el cliente usa textContent
  assert.equal(sanitizeText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('reloj de Lamport: tick crece y observe adopta el mayor', () => {
  const c = new LamportClock();
  assert.equal(c.tick(), 1);
  c.observe(10);
  assert.equal(c.tick(), 11);
  c.observe(3);
  assert.equal(c.tick(), 12);
});

test('orden total: lc, luego origin, luego seq', () => {
  const list = [msg('coord-b', 1, 5), msg('coord-a', 7, 5), msg('coord-a', 2, 4), msg('coord-a', 8, 5)];
  list.sort(compareMessages);
  assert.deepEqual(list.map(m => m.id), ['coord-a#2', 'coord-a#7', 'coord-a#8', 'coord-b#1']);
});

test('tres coordinadores que reciben en distinto orden ven la misma conversación', () => {
  const sent = [msg('coord-a', 1, 1, 'hola'), msg('coord-b', 1, 1, 'qué tal'), msg('coord-c', 1, 2, 'ey')];
  const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2]];
  const views = orders.map(order => {
    const log = new ChatLog(50);
    for (const i of order) log.add(sent[i]);
    return log.list().map(m => m.id).join(',');
  });
  assert.equal(new Set(views).size, 1);
  assert.equal(views[0], 'coord-a#1,coord-b#1,coord-c#1');
});

test('ChatLog: sin duplicados, tope M y descarta lo más viejo que el historial', () => {
  const log = new ChatLog(3);
  assert.ok(log.add(msg('a', 1, 10)));
  assert.equal(log.add(msg('a', 1, 10)), null, 'duplicado');
  log.add(msg('a', 2, 11)); log.add(msg('a', 3, 12));
  const r = log.add(msg('a', 4, 13));
  assert.equal(r.atEnd, true);
  assert.equal(log.list().length, 3);
  assert.equal(log.list()[0].seq, 2);
  assert.equal(log.add(msg('b', 1, 1)), null, 'más viejo que todo el historial');
  const mid = log.add(msg('b', 9, 12));            // llega tarde pero cabe en medio
  assert.equal(mid.atEnd, false);
  assert.deepEqual(log.list().map(m => m.id), ['a#3', 'b#9', 'a#4']);
});

test('normalizeRemote: valida todo y fija el origen', () => {
  const ok = { ch: 'global', userId: 7, username: 'ana', text: ' hola ', ts: 1, lc: 3, seq: 2, origin: 'coord-a' };
  const n = normalizeRemote(ok, 'coord-a');
  assert.equal(n.id, 'coord-a#2');
  assert.equal(n.text, 'hola');
  assert.equal(n.userId, '7');
  assert.equal(normalizeRemote({ ...ok, ch: 'room:../etc' }, 'coord-a'), null);
  assert.equal(normalizeRemote({ ...ok, text: 'a'.repeat(5000) }, 'coord-a'), null);
  assert.equal(normalizeRemote({ ...ok, lc: -1 }, 'coord-a'), null);
  assert.equal(normalizeRemote({ ...ok, username: '' }, 'coord-a'), null);
  assert.equal(normalizeRemote(null, 'coord-a'), null);
  assert.equal(normalizeRemote({ ...ok, ch: 'room:sala-abcd1234' }, 'coord-a').ch, 'room:sala-abcd1234');
});

test('RateLimiter: ráfaga permitida, luego limita, luego silencia y se recupera', () => {
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 1, strikesToMute: 3, strikeWindowMs: 10000, muteMs: 5000 });
  const t = 1_000_000;
  assert.ok(rl.take('u', t).ok && rl.take('u', t).ok && rl.take('u', t).ok);
  const r1 = rl.take('u', t);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'rate_limited');
  assert.ok(r1.retryMs > 0 && r1.retryMs <= 1000);
  assert.equal(rl.take('u', t + 10).reason, 'rate_limited');
  assert.equal(rl.take('u', t + 20).reason, 'muted');        // 3.ª falta: silenciado
  assert.equal(rl.take('u', t + 3000).reason, 'muted');
  assert.ok(rl.take('u', t + 6000).ok, 'pasado el silencio vuelve a poder hablar');
  assert.ok(rl.take('otro', t).ok, 'otro usuario no se afecta');
});

test('RateLimiter: el ritmo sostenido de 1 por segundo no se limita', () => {
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
  let t = 5_000_000;
  for (let i = 0; i < 30; i++) { assert.ok(rl.take('u', t).ok, `mensaje ${i}`); t += 1000; }
});

test('createFloodGuard: 1000 mensajes/segundo superan el límite', () => {
  const exceeded = createFloodGuard(60, 1000);
  let tripped = 0;
  for (let i = 0; i < 1000; i++) if (exceeded(10_000 + i / 10)) tripped++;
  assert.ok(tripped > 900);
  assert.equal(exceeded(12_000), false, 'ventana nueva');
});
