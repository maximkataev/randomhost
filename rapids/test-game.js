#!/usr/bin/env node
// Тесты движка «Утиного сплава»: node test-game.js
'use strict';
const assert = require('assert');
const { createGame, makeCourse, moveDuck, DEFAULTS, GATE_Y } = require('./game');
const Bots = require('./bots');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n    ')); }
}

// заплыв с n утками, отсчёт уже прошёл
function race(n, seed = 1, cfg) {
  const g = createGame({ seed, cfg });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i, i);
  assert(g.start());
  run(g, DEFAULTS.COUNTDOWN + 0.05);
  assert.strictEqual(g.phase, 'race');
  g.drainEvents();
  return g;
}
const P = (g, i) => g.byId.get('p' + i);
function run(g, sec, each) {
  for (let t = 0; t < sec; t += 1 / 60) { if (each) each(); g.step(1 / 60); if (g.phase === 'over' && !each) break; }
}
const place = (d, x, y) => { d.x = x; d.y = y; d.vx = 0; d.vy = 0; };
// остальных — убрать с поля, но оставить плывущими (иначе в реке одна утка и заплыв сразу кончается):
// «водоворот» далеко за берегом, который никогда не отпускает
function parkFinished(g, except) {
  for (const d of g.players) if (!except.includes(d)) { d.st = 'c'; d.cap = { p: { x: -900, y: -900, r: 1, dir: 1 }, a: 0, r: 0, t: -1e9 }; d.x = d.y = -900; }
}

console.log('Русло');
test('река по сиду одна и та же', () => {
  const a = makeCourse(777), b = makeCourse(777), c = makeCourse(778);
  assert.deepStrictEqual(a.rocks.map(r => [r.x, r.y, r.r]), b.rocks.map(r => [r.x, r.y, r.r]));
  assert.deepStrictEqual(a.streams, b.streams);
  assert.strictEqual(a.riverCx(1234), b.riverCx(1234));
  assert.notDeepStrictEqual(a.rocks.map(r => r.x), c.rocks.map(r => r.x));
});
test('препятствия есть всех видов, финишная прямая чистая', () => {
  for (let s = 1; s <= 30; s++) {
    const c = makeCourse(s);
    assert(c.rocks.length && c.logs.length && c.pools.length && c.lilies.length && c.streams.length, 'сид ' + s);
    const lastObstacle = Math.max(...c.slots.map(x => x.y));
    assert(lastObstacle < c.FINISH_Y - c.CLEAN, 'сид ' + s);
  }
});
test('везде есть проход: камень — берег, камень — камень, бревно — дальний берег', () => {
  const need = DEFAULTS.DR * 2 + 4;
  for (let s = 1; s <= 200; s++) {
    const c = makeCourse(s);
    for (const r of c.rocks) {
      const cx = c.riverCx(r.y), hw = c.riverHw(r.y);
      const gapL = r.x - r.r - (cx - hw), gapR = cx + hw - (r.x + r.r);
      assert(gapL > need && gapR > need, `сид ${s}: камень у берега ${gapL.toFixed(0)}/${gapR.toFixed(0)}`);
      for (const o of c.rocks) if (o !== r) assert(Math.hypot(o.x - r.x, o.y - r.y) - o.r - r.r > need, `сид ${s}: камни впритык`);
    }
    for (const L of c.logs) {
      const far = c.riverCx(L.y2) + Math.sign(L.x2 - L.x1) * c.riverHw(L.y2);
      assert(Math.abs(far - L.x2) - L.r > need, `сид ${s}: бревно перегородило реку`);
    }
  }
});

console.log('Старт');
test('нужно двое в сети; утки у шлюза, за шлюз в отсчёте не проплыть', () => {
  const g = createGame({ seed: 3 });
  g.addPlayer('p0', 'A', 0);
  assert.strictEqual(g.start(), false);
  g.addPlayer('p1', 'B', 1);
  g.setOnline('p1', false);
  assert.strictEqual(g.start(), false);
  g.setOnline('p1', true);
  assert(g.start());
  assert.strictEqual(g.phase, 'countdown');
  for (const d of g.players) assert(d.inGame && d.y < GATE_Y);
  run(g, DEFAULTS.COUNTDOWN - 0.2);
  for (const d of g.players) assert(d.y < GATE_Y, 'проплыл шлюз в отсчёте');
  run(g, 0.4);
  assert.strictEqual(g.phase, 'race');
  assert(g.drainEvents().some(e => e.type === 'go'));
});
test('12 уток — в один ряд у шлюза, без перекрытий (второй ряд проигрывал)', () => {
  const g = createGame({ seed: 7 });
  for (let i = 0; i < 12; i++) g.addPlayer('p' + i, 'P' + i, i);
  assert(g.start());
  const ys = g.players.map(d => d.y);
  assert(Math.max(...ys) - Math.min(...ys) <= 6.01, 'ряды: ' + ys.join(','));
  for (const a of g.players) for (const b of g.players) if (a !== b) assert(Math.hypot(a.x - b.x, a.y - b.y) >= DEFAULTS.DR * 2 - 0.5, 'утки перекрываются');
});
test('новая трасса на каждый заплыв', () => {
  const g = createGame({ seed: 5 });
  g.addPlayer('p0', 'A', 0); g.addPlayer('p1', 'B', 1);
  const s0 = g.seed;
  g.start();
  assert.notStrictEqual(g.seed, s0);
});

console.log('Руль');
test('руль вправо уводит утку вправо, влево — влево; течение несёт вниз', () => {
  const xs = [-1, 0, 1].map(st => {
    const g = race(2, 9);
    const a = P(g, 0);
    parkFinished(g, [a]);
    g.phase = 'race';
    place(a, g.course.riverCx(GATE_Y + 100), GATE_Y + 100);
    const y0 = a.y;
    run(g, 0.8, () => g.setInput('p0', st));
    assert(a.y > y0 + 40, 'течение не несёт');
    return a.x;
  });
  assert(xs[0] < xs[1] - 30 && xs[2] > xs[1] + 30, xs.join(' '));
});
test('предсказание клиента = сервер, пока утка одна и чисто', () => {
  const g = race(2, 11);
  const a = P(g, 0);
  parkFinished(g, [a]);
  g.phase = 'race';
  place(a, g.course.riverCx(GATE_Y + 40), GATE_Y + 40);
  const pred = { x: a.x, y: a.y, vx: 0, vy: 0, ang: a.ang, spin: 0 };
  for (let i = 0; i < 60; i++) {
    const st = Math.sin(i / 9);
    g.setInput('p0', st);
    g.step(1 / 60);
    moveDuck(pred, g.course, g.cfg, 1 / 60, a.steer, true, true);
  }
  assert(Math.hypot(pred.x - a.x, pred.y - a.y) < 0.5, `${pred.x},${pred.y} vs ${a.x},${a.y}`);
});
test('офлайн утка не рулит, но течение несёт её дальше', () => {
  const g = race(2, 12);
  const a = P(g, 0);
  g.setInput('p0', 1);
  g.setOnline('p0', false);
  const y0 = a.y;
  run(g, 3);
  assert(a.y > y0 + 250);
  assert.strictEqual(a.steer, 0);
});

console.log('Препятствия');
test('бревно: утка у берега без руля выплывает к свободному концу', () => {
  for (let s = 1; s <= 40; s++) {
    const g = race(2, s);
    const a = P(g, 0);
    parkFinished(g, [a]);
    g.phase = 'race';
    const L = g.course.logs[0];
    // чуть выше бревна, у самого берега, откуда оно растёт
    const y = L.y1 - 30;
    place(a, L.x1 - Math.sign(L.x2 - L.x1) * 30 + Math.sign(L.x2 - L.x1) * 50, y);
    run(g, 6, () => g.setInput('p0', 0));
    assert(a.y > Math.max(L.y1, L.y2) + 10, `сид ${s}: застряла у бревна (${a.x.toFixed(0)}, ${a.y.toFixed(0)})`);
  }
});
test('камень: на макушке не зависнуть', () => {
  for (let s = 1; s <= 40; s++) {
    const g = race(2, s);
    const a = P(g, 0);
    parkFinished(g, [a]);
    g.phase = 'race';
    const r = g.course.rocks[3];
    place(a, r.x, r.y - r.r - 30);
    run(g, 3, () => g.setInput('p0', 0));
    assert(a.y > r.y + r.r, `сид ${s}: висит на камне`);
  }
});
test('водоворот ловит, крутит CAP_T и выбрасывает вниз по течению', () => {
  const g = race(2, 21);
  const a = P(g, 0);
  parkFinished(g, [a]);
  g.phase = 'race';
  const p = g.course.pools[0];
  place(a, p.x, p.y - 8);
  g.step(1 / 60);
  assert.strictEqual(a.st, 'c');
  assert(g.drainEvents().some(e => e.type === 'whirl' && e.id === 'p0'));
  run(g, DEFAULTS.CAP_T - 0.2, () => g.setInput('p0', 1));
  assert.strictEqual(a.st, 'c', 'выпустило раньше времени');
  run(g, 0.4);
  assert.strictEqual(a.st, 'w');
  assert(g.drainEvents().some(e => e.type === 'whirlOut'));
  assert(a.y > p.y, 'выпустило не снизу воронки');
  run(g, 1);
  assert(a.y > p.y + p.r, 'не вынесло вниз');
});
test('столкновение уток — событие bump, кто толкнул', () => {
  const g = race(3, 31);
  const a = P(g, 0), b = P(g, 1);
  parkFinished(g, [a, b]);
  g.phase = 'race';
  g.clock = 10;
  const y = GATE_Y + 120, cx = g.course.riverCx(y);
  place(a, cx - 40, y); place(b, cx, y);
  a.vx = 160;
  let ev = null;
  run(g, 0.4, () => { g.setInput('p0', 1); for (const e of g.drainEvents()) if (e.type === 'bump') ev = e; });
  assert(ev, 'нет события');
  assert.strictEqual(ev.by, 'p0');
  assert.strictEqual(ev.id, 'p1');
  assert(b.x > cx + 10, 'соседа не сдвинуло');
});
test('первые секунды после старта утки не толкаются', () => {
  const g = race(6, 32);
  let bumps = 0;
  run(g, DEFAULTS.START_GUARD - 0.1, () => { for (const e of g.drainEvents()) if (e.type === 'bump') bumps++; g.players.forEach((p, i) => g.setInput(p.id, i % 2 ? 1 : -1)); });
  assert.strictEqual(bumps, 0);
});

console.log('Финиш и кто ведёт дейлик');
test('первый за линией — чемпион; заплыв кончается, когда в реке одна утка; она ведёт дейлик', () => {
  const g = race(3, 41);
  const [a, b, c] = [P(g, 0), P(g, 1), P(g, 2)];
  const F = g.course.FINISH_Y;
  place(a, g.course.riverCx(F - 30), F - 30);
  place(b, g.course.riverCx(F - 200) - 30, F - 200);
  place(c, g.course.riverCx(F - 600), F - 600);
  const evs = [];
  run(g, 4, () => evs.push(...g.drainEvents()));
  evs.push(...g.drainEvents());
  const fin = evs.filter(e => e.type === 'finish');
  assert.deepStrictEqual(fin.map(e => e.id), ['p0', 'p1']);
  assert.strictEqual(evs.find(e => e.type === 'champion').id, 'p0');
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.host.id, 'p2');
  const over = evs.find(e => e.type === 'over');
  assert.deepStrictEqual(over.stats.players.map(p => p.id), ['p0', 'p1', 'p2']);
  assert.strictEqual(over.stats.players[2].time, null);
  assert(over.stats.players[0].time > 0);
});
test('по пределу времени — места по пройденному пути', () => {
  const g = race(3, 42, { RACE_T: 2 });
  const [a, b, c] = [P(g, 0), P(g, 1), P(g, 2)];
  place(a, g.course.riverCx(1500), 1500);
  place(b, g.course.riverCx(1200), 1200);
  place(c, g.course.riverCx(1800), 1800);
  run(g, 3);
  assert.strictEqual(g.phase, 'over');
  assert(g.host.timeUp);
  assert.strictEqual(g.host.id, 'p1');
  assert.strictEqual(g.champion, 'p2');
});
test('ушёл посреди заплыва — сошёл с дистанции и встаёт последним', () => {
  const g = race(3, 43);
  g.removePlayer('p1');
  assert(P(g, 1).dnf);
  assert(g.drainEvents().some(e => e.type === 'removed'));
  assert.strictEqual(g.phase, 'race');
  const a = P(g, 0);
  place(a, g.course.riverCx(g.course.FINISH_Y - 20), g.course.FINISH_Y - 20);
  run(g, 2);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.host.id, 'p1');
  assert(g.host.dnf);
});
test('двое: один доплыл — второй ведёт', () => {
  const g = race(2, 44);
  const a = P(g, 1);
  place(a, g.course.riverCx(g.course.FINISH_Y - 20), g.course.FINISH_Y - 20);
  run(g, 2);
  assert.strictEqual(g.host.id, 'p0');
  assert.strictEqual(g.champion, 'p1');
});
test('в лобби после заплыва все снова в заводи, сошедшие убраны, трасса новая', () => {
  const g = race(3, 45);
  g.removePlayer('p2');
  const a = P(g, 0);
  place(a, g.course.riverCx(g.course.FINISH_Y - 10), g.course.FINISH_Y - 10);
  run(g, 2);
  assert.strictEqual(g.phase, 'over');
  const s0 = g.seed;
  g.toLobby();
  assert.strictEqual(g.phase, 'lobby');
  assert.strictEqual(g.players.length, 2);
  assert(!g.byId.has('p2'));
  assert.notStrictEqual(g.seed, s0);
  for (const d of g.players) assert(d.y < GATE_Y && d.st === 'w' && !d.inGame);
});

console.log('Боты');
test('боты доплывают: 40 заплывов по 6 без пределов времени', () => {
  let timeUps = 0;
  for (let r = 0; r < 40; r++) {
    const g = createGame({ seed: 500 + r });
    const bots = new Map();
    for (let i = 0; i < 6; i++) { g.addPlayer('b' + i, 'B' + i, i); bots.set('b' + i, Bots.createBot(Bots.STYLE_KEYS[i % 4], r * 7 + i)); }
    g.start();
    for (let k = 0; k < 20 * 70 && g.phase !== 'over'; k++) {
      for (const p of g.players) g.setInput(p.id, Bots.think(g, p, bots.get(p.id), 0.05));
      g.step(0.05);
    }
    assert.strictEqual(g.phase, 'over');
    if (g.host.timeUp) timeUps++;
  }
  assert.strictEqual(timeUps, 0);
});

console.log(`\n${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
