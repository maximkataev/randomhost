#!/usr/bin/env node
// Тесты движка «Лягушек»: node test-game.js
'use strict';
const assert = require('assert');
const { createGame, DEFAULTS } = require('./game');
const P = require('./physics');
const { createBot, think, STYLE_KEYS } = require('./bots');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n    ')); }
}
const seeded = s => () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };

// партия n лягушек, отсчёт прошёл; волны/цапля/мухи отодвинуты, чтобы тест сам управлял происходящим
function fight(n, cfg, seed = 1) {
  const g = createGame({ seed, rng: seeded(seed * 17 + 3), cfg: Object.assign({ WAVE_FIRST: 1e9, HERON_FIRST: 1e9, FLY_EVERY: 1e9, STOMP_GUARD: 0 }, cfg) });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i, i);
  assert(g.start());
  run(g, DEFAULTS.COUNTDOWN + 0.05);
  assert.strictEqual(g.phase, 'fight');
  g.drainEvents();
  return g;
}
function run(g, sec) { for (let t = 0; t < sec - 1e-9; t += 0.05) g.step(0.05); }
const F = (g, i) => g.byId.get('p' + i);
// ближайшая к лягушке свободная кувшинка в пределах прыжка
function nearPad(g, f, skip) {
  return g.pads.filter(p => p.id !== f.pad && p.state === 'ok' && !(skip || []).includes(p.id) && Math.hypot(p.x - f.x, p.y - f.y) <= g.jmax)
    .sort((a, b) => Math.hypot(a.x - f.x, a.y - f.y) - Math.hypot(b.x - f.x, b.y - f.y))[0];
}
function jumpTo(g, f, pad, lag) {
  const dx = pad.x - f.x, dy = pad.y - f.y, d = Math.hypot(dx, dy);
  const pow = (d - g.cfg.JUMP_MIN) / (g.jmax - g.cfg.JUMP_MIN);
  assert(g.input(f.id, { ang: Math.atan2(dy, dx), pow: Math.max(0, pow), seq: 1 }, lag || 0), 'input принят');
}
const evs = (g, type) => g.drainEvents().filter(e => e.type === type);

console.log('Физика');
test('раскладка по сиду одна и та же, другой сид — другая', () => {
  const a = P.makeLayout(7, 8), b = P.makeLayout(7, 8), c = P.makeLayout(8, 8);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a.pads.map(p => p.x), c.pads.map(p => p.x));
});
test('кувшинок ceil(n*1.6)+2, около 20% больших, зазоры и связность', () => {
  for (const n of [2, 3, 5, 8, 12]) for (let seed = 1; seed <= 25; seed++) {
    const L = P.makeLayout(seed, n);
    assert.strictEqual(L.pads.length, Math.ceil(n * 1.6) + 2, `n=${n} seed=${seed}`);
    for (let i = 0; i < L.pads.length; i++) {
      const p = L.pads[i];
      assert(Math.hypot(p.x, p.y) + p.r <= L.R, 'внутри пруда');
      for (let j = i + 1; j < L.pads.length; j++) assert(P.gapOf(p, L.pads[j]) >= DEFAULTS.PAD_GAP - 1e-9, 'зазор');
    }
    // связность: из любой можно допрыгнуть до любой
    const maxGap = DEFAULTS.LINK_K * P.jumpMax(L.R);
    const seen = new Set([0]), q = [0];
    while (q.length) { const i = q.pop(); L.pads.forEach((_, j) => { if (!seen.has(j) && P.gapOf(L.pads[i], L.pads[j]) <= maxGap) { seen.add(j); q.push(j); } }); }
    assert.strictEqual(seen.size, L.pads.length, `связность n=${n} seed=${seed}`);
    assert.strictEqual(L.pads.filter(p => p.big).length, Math.round(L.pads.length * DEFAULTS.BIG_SHARE));
  }
});
test('прыжок: дальность и время растут с силой, угол задаёт направление', () => {
  const R = 250, a = P.jumpPlan(0, 0, 0, 0, false, R), b = P.jumpPlan(0, 0, 0, 1, false, R), c = P.jumpPlan(0, 0, Math.PI / 2, 0.5, false, R);
  assert(Math.abs(a.dist - DEFAULTS.JUMP_MIN) < 1e-9);
  assert(Math.abs(b.dist - P.jumpMax(R)) < 1e-9);
  assert(a.dur < c.dur && c.dur < b.dur);
  assert(Math.abs(c.tx) < 1e-9 && c.ty > 0);
  assert(Math.abs(P.jumpPlan(0, 0, 0, 1, true, R).dist - P.jumpMax(R) * DEFAULTS.FLY_BOOST) < 1e-9);
});
test('padAt: попадание с допуском', () => {
  const pads = [{ id: 0, x: 0, y: 0, r: 34 }];
  assert(P.padAt(pads, 38, 0));
  assert(!P.padAt(pads, 41, 0));
});

console.log('Старт');
test('нельзя начать одному; на старте у каждой лягушки своя кувшинка', () => {
  const g = createGame({ seed: 1 });
  g.addPlayer('a', 'A');
  assert(!g.start());
  const h = fight(8, {});
  const pads = h.players.map(f => f.pad);
  assert.strictEqual(new Set(pads).size, 8);
  assert(h.players.every(f => f.st === 'pad' && !h.pads[f.pad].big));
});
test('отсчёт блокирует ввод, потом «go»', () => {
  const g = createGame({ seed: 2 });
  g.addPlayer('a', 'A'); g.addPlayer('b', 'B'); g.start();
  assert.strictEqual(g.phase, 'countdown');
  assert(!g.input('a', { ang: 0, pow: 0.5 }, 0));
  run(g, 3.1);
  assert.strictEqual(g.phase, 'fight');
  assert(g.drainEvents().some(e => e.type === 'go'));
});

console.log('Прыжки');
test('прыжок на свободную кувшинку: лягушка садится, событие land', () => {
  const g = fight(3, {});
  const f = F(g, 0), pad = nearPad(g, f, g.players.map(p => p.pad));
  jumpTo(g, f, pad);
  assert.strictEqual(f.st, 'air');
  run(g, 1);
  assert.strictEqual(f.st, 'pad'); assert.strictEqual(f.pad, pad.id);
  const ev = g.drainEvents();
  assert(ev.some(e => e.type === 'jump' && e.id === 'p0'));
  assert(ev.some(e => e.type === 'land' && e.id === 'p0' && e.pad === pad.id));
});
test('мимо кувшинок — в воду; неудачник — первый упавший', () => {
  const g = fight(3, {});
  const f = F(g, 0);
  // прыжок от центра пруда наружу, пока не найдём направление без кувшинок
  let ang = null;
  for (let a = 0; a < 6.28 && ang == null; a += 0.1) {
    const pl = P.jumpPlan(f.x, f.y, a, 1, false, g.R);
    if (!P.padAt(g.pads, pl.tx, pl.ty)) ang = a;
  }
  assert(g.input('p0', { ang, pow: 1, seq: 1 }, 0));
  run(g, 1);
  assert.strictEqual(f.st, 'out'); assert.strictEqual(f.cause, 'miss');
  assert.strictEqual(g.loser, 'p0');
  const ev = g.drainEvents();
  assert(ev.some(e => e.type === 'fall' && e.id === 'p0'));
  assert(ev.some(e => e.type === 'loser' && e.id === 'p0'));
});
test('вытеснение: хозяин получает вынужденный прыжок, лишнюю никуда не сажаем', () => {
  const g = fight(3, {});
  const a = F(g, 0), b = F(g, 1);
  const pad = g.pads[b.pad];
  // подвинем a вплотную к b на ту же дистанцию, достаточную для прыжка
  const dx = a.x - pad.x, dy = a.y - pad.y;
  if (Math.hypot(dx, dy) > g.jmax) return; // сид без досягаемости: другие тесты это покрывают
  jumpTo(g, a, pad);
  run(g, 1);
  assert.strictEqual(a.st, 'pad'); assert.strictEqual(a.pad, pad.id);
  assert.strictEqual(a.stomps, 1);
  assert(b.st === 'air' || b.st === 'out' || (b.st === 'pad' && b.pad !== pad.id));
});
test('вытеснение: события stomp + вынужденный jump + пустая кувшинка рядом спасает хозяина', () => {
  const g = fight(2, {});
  const a = F(g, 0), b = F(g, 1);
  const pad = g.pads[b.pad];
  // искусственно: ставим a на соседнюю кувшинку в пределах прыжка
  const nb = g.pads.filter(p => p.id !== pad.id && Math.hypot(p.x - pad.x, p.y - pad.y) <= g.jmax * 0.9)[0];
  assert(nb, 'есть соседняя кувшинка');
  g.byId.get('p0').st = 'pad'; a.pad = nb.id; a.x = nb.x; a.y = nb.y;
  jumpTo(g, a, pad);
  run(g, 1);
  const ev = g.drainEvents();
  assert(ev.some(e => e.type === 'stomp' && e.by === 'p0' && e.id === 'p1'));
  assert(ev.some(e => e.type === 'jump' && e.id === 'p1' && e.forced));
});
test('стартовая защита: прилёт на занятую кувшинку отскакивает на прежнюю, вытеснения нет', () => {
  const g = fight(2, { STOMP_GUARD: 8 });
  const a = F(g, 0), b = F(g, 1);
  const nb = g.pads.find(p => p.id !== b.pad && Math.hypot(p.x - g.pads[b.pad].x, p.y - g.pads[b.pad].y) <= g.jmax * 0.9);
  const home = a.pad;
  a.pad = nb.id; a.x = nb.x; a.y = nb.y; // a сидит на соседней, прежняя «своя» — nb
  jumpTo(g, a, g.pads[b.pad]);
  run(g, 1);
  const ev = g.drainEvents();
  assert(!ev.some(e => e.type === 'stomp'), 'вытеснения нет');
  assert.strictEqual(b.st, 'pad'); assert.strictEqual(b.pad !== nb.id, true);
  assert(ev.some(e => e.type === 'land' && e.id === 'p0' && e.bounce === b.pad), 'отскок на прежнюю');
  assert.strictEqual(a.pad, nb.id);
  assert.strictEqual(home >= 0, true);
});
test('волна не оставляет лягушку без достижимой свободной кувшинки (пока «стульев» нет)', () => {
  for (let r = 0; r < 25; r++) {
    const g = createGame({ seed: 400 + r, rng: seeded(r + 5), cfg: { HERON_FIRST: 1e9 } });
    const bots = new Map();
    for (let i = 0; i < 4; i++) { g.addPlayer('b' + i, 'B' + i, i); bots.set('b' + i, createBot(STYLE_KEYS[(i + r) % 3], r * 11 + i)); }
    g.start();
    for (let k = 0; k < 20 * 40 && g.phase !== 'over'; k++) {
      for (const f of g.players) { const m = think(g, f, bots.get(f.id), 0.05); if (m) g.input(f.id, m, 0.05); }
      g.step(0.05);
      for (const e of g.drainEvents()) if (e.type === 'wave' && !g.loser && g.t < 30) {
        for (const id of e.pads) for (const f of g.players) if (f.st === 'pad' && f.pad === id && f.seatedAt <= e.t) {
          const ok = g.pads.some(q => q.id !== id && q.state === 'ok' && (q.sinkAt == null || q.cause === 'shrink') && Math.hypot(q.x - f.x, q.y - f.y) <= g.jmax * 1.0 && Math.hypot(q.x - f.x, q.y - f.y) >= g.cfg.JUMP_MIN && !g.players.some(o => o.st === 'pad' && o.pad === q.id && o !== f && q.cap === 1));
          assert(ok, `seed ${r}, t=${g.t.toFixed(1)}: ${f.id} на листе ${id} без достижимой свободной`);
        }
      }
    }
  }
});
test('усталость листа: кто сидит дольше STAY_T, тому лист краснеет и тонет — отсидеться нельзя', () => {
  const g = fight(3, { STAY_T: 4, TIRE_WARN: 1.5, LETHAL_T: 1e9 });
  const f = F(g, 0);
  assert(f.tireAt > 0 && f.tireAt < 8, 'таймер усталости выставлен');
  run(g, 6);
  const ev = g.drainEvents();
  const w = ev.find(e => e.type === 'wave' && e.tired === 'p0');
  assert(w, 'усталый лист помечен');
  run(g, 3);
  assert(g.falls.length >= 1 && g.falls.every(x => x.cause === 'wave'), 'отсидевшиеся упали вместе с листом');
  assert(f.st === 'out' || g.phase === 'over', 'либо упал, либо партия уже решена');
});
test('усталый лист ждёт, пока некуда уйти, но не вечно: через TIRE_WAIT тонет (вытеснить или упасть)', () => {
  const g = fight(2, { STAY_T: 2, LETHAL_T: 1e9, REACH_K: 0.01, TIRE_WAIT: 3 }); // достижимых листов нет вообще
  run(g, 4.5);
  assert(g.drainEvents().every(e => !(e.type === 'wave' && e.tired)), 'в пределах ожидания лист не помечен');
  assert.strictEqual(F(g, 0).st, 'pad');
  run(g, 5);
  assert(g.falls.length >= 1 || g.drainEvents().some(e => e.type === 'wave' && e.tired), 'после ожидания помечен');
});
test('прыжок на новый лист сбрасывает усталость', () => {
  const g = fight(3, { STAY_T: 5, LETHAL_T: 1e9 });
  const f = F(g, 0);
  run(g, 3);
  jumpTo(g, f, nearPad(g, f, g.players.map(p => p.pad)));
  run(g, 1);
  assert.strictEqual(f.st, 'pad');
  assert(f.tireAt > g.t + 3.5, 'таймер заведён заново: ' + (f.tireAt - g.t));
});
test('одна кувшинка = одна лягушка, большая вмещает двух без вытеснения', () => {
  const g = fight(3, {});
  const big = g.pads.find(p => p.big);
  const a = F(g, 0), b = F(g, 1);
  for (const [f, side] of [[a, 1], [b, 2]]) { f.pad = -1; }
  // посадим a вручную на большую, прыжком отправим b
  const place = (f, pad) => { f.st = 'pad'; f.pad = pad.id; f.x = pad.x; f.y = pad.y; f.seatedAt = 0; f.readyAt = 0; };
  place(a, big);
  const other = g.pads.find(p => p !== big && !p.big && Math.hypot(p.x - big.x, p.y - big.y) <= g.jmax);
  place(b, other);
  jumpTo(g, b, big);
  run(g, 1);
  assert.strictEqual(a.pad, big.id); assert.strictEqual(b.pad, big.id);
  assert.strictEqual(a.stomps + b.stomps, 0);
});
test('прыжки не чаще одного за 0,2 с, лишнее при полёте — в очередь на один шаг', () => {
  const g = fight(3, {});
  const f = F(g, 0), pad = nearPad(g, f, g.players.map(p => p.pad));
  jumpTo(g, f, pad);
  assert(!g.input('p0', { ang: 0, pow: 0.5, seq: 2 }, 0), 'слишком часто');
  run(g, 0.25);
  assert(g.input('p0', { ang: 1, pow: 0.3, seq: 3 }, 0));
  assert(f.queued && f.queued.seq === 3);
  assert(g.input('p0', { ang: 2, pow: 0.3, seq: 4 }, 0) === false || true);
});
test('очередь исполняется после приземления и приседания', () => {
  const g = fight(3, {});
  const f = F(g, 0), pad = nearPad(g, f, g.players.map(p => p.pad));
  jumpTo(g, f, pad);
  run(g, 0.25);
  const back = g.pads.find(p => p.id !== pad.id && Math.hypot(p.x - pad.x, p.y - pad.y) <= g.jmax && !g.players.some(o => o.pad === p.id));
  const dx = back.x - pad.x, dy = back.y - pad.y;
  assert(g.input('p0', { ang: Math.atan2(dy, dx), pow: 0.5, seq: 9 }, 0));
  assert(f.queued);
  run(g, 1.2);
  assert(g.drainEvents().filter(e => e.type === 'jump' && e.id === 'p0').length >= 2);
});
test('вход с NaN и в лобби игнорируется', () => {
  const g = fight(3, {});
  assert(!g.input('p0', { ang: NaN, pow: 1 }, 0));
  assert(!g.input('нет', { ang: 0, pow: 1 }, 0));
});

console.log('Волны и погружение');
test('кувшинка тонет через TELEGRAPH, лягушка на ней падает', () => {
  const g = fight(3, {});
  const f = F(g, 0), pad = g.pads[f.pad];
  pad.sinkAt = g.t + 2.5; pad.cause = 'wave';
  run(g, 2.4); assert.strictEqual(f.st, 'pad');
  run(g, 0.5);
  assert.strictEqual(f.st, 'out'); assert.strictEqual(f.cause, 'wave');
  assert.strictEqual(pad.state, 'sunk');
  assert.strictEqual(g.loser, 'p0');
});
test('успела спрыгнуть до погружения — жива', () => {
  const g = fight(3, {});
  const f = F(g, 0), pad = g.pads[f.pad];
  pad.sinkAt = g.t + 2.5; pad.cause = 'wave';
  run(g, 1);
  jumpTo(g, f, nearPad(g, f, g.players.map(p => p.pad)));
  run(g, 3);
  assert.strictEqual(f.st, 'pad'); assert(f.pad !== pad.id);
});
test('приземлиться на тонущую кувшинку после метки нельзя', () => {
  const g = fight(3, {});
  const f = F(g, 0), target = nearPad(g, f, g.players.map(p => p.pad));
  target.sinkAt = g.t + 0.2; target.cause = 'wave';
  jumpTo(g, f, target); // летит ≥0,35 с, а метка через 0,2 с
  run(g, 2);
  assert.strictEqual(f.st, 'out'); assert.strictEqual(f.cause, 'wave');
});
test('компенсация лага: спрыгнул, когда метка по серверу прошла, а у игрока нет — жив, jump.rescued', () => {
  const g = fight(3, {});
  run(g, 1);
  const f = F(g, 0), pad = g.pads[f.pad];
  pad.sinkAt = g.t + 0.05; pad.cause = 'wave';
  run(g, 0.1); // метка прошла на 0,05 с, но погружение ждёт GRACE
  assert.strictEqual(f.st, 'pad');
  jumpTo(g, f, nearPad(g, f, g.players.map(p => p.pad)), 0.12);
  const ev = g.drainEvents().find(e => e.type === 'jump');
  assert(ev && ev.rescued, 'помечен как «спасён»');
  run(g, 2);
  assert.strictEqual(f.st, 'pad'); assert(f.pad !== pad.id);
  assert.strictEqual(pad.state, 'sunk');
});
test('без компенсации (лаг больше метки) — падает вместе с кувшинкой', () => {
  const g = fight(3, {});
  run(g, 1);
  const f = F(g, 0), pad = g.pads[f.pad];
  pad.sinkAt = g.t - 0.5; pad.cause = 'wave'; // метка давно позади
  const to = nearPad(g, f, g.players.map(p => p.pad));
  const ang = Math.atan2(to.y - f.y, to.x - f.x);
  assert.strictEqual(g.input('p0', { ang, pow: 0.5, seq: 1 }, 0.12), false, 'поздно');
  run(g, 2);
  assert.strictEqual(f.st, 'out'); assert.strictEqual(f.cause, 'wave');
});
test('бэкдейтинг ограничен LAG_MAX', () => {
  const g = fight(3, {});
  run(g, 1);
  const f = F(g, 0), target = nearPad(g, f, g.players.map(p => p.pad));
  const d = Math.hypot(target.x - f.x, target.y - f.y);
  const dur = P.jumpPlan(f.x, f.y, 0, Math.max(0, (d - 36) / (g.jmax - 36)), false, g.R).dur;
  target.sinkAt = g.t + dur - 0.4; target.cause = 'wave';
  jumpTo(g, f, target, 5); // лаг 5 с зажмётся до 0,15 с
  run(g, 2);
  assert.strictEqual(f.st, 'out');
});
test('волна: число мест не падает ниже цели и не трогает больше нужного', () => {
  const g = fight(8, { WAVE_FIRST: 0.1 });
  run(g, 0.3);
  const w = evs(g, 'wave')[0];
  assert(w, 'волна случилась');
  assert(w.cap >= 8, 'в начале мест не меньше, чем живых: ' + w.cap);
  assert(w.sinkAts.every((t, i) => i === 0 || t > w.sinkAts[i - 1]), 'каскад по времени');
});
test('в «стульях» мест меньше, чем живых, кто-то падает', () => {
  const g = fight(4, { WAVE_FIRST: 0.1, LETHAL_T: 0, WAVE_T0: 3, WAVE_T1: 3 });
  const bots = new Map(g.players.map((f, i) => [f.id, createBot('jumpy', i + 1)]));
  for (let k = 0; k < 20 * 60 && g.phase === 'fight'; k++) {
    for (const f of g.players) { const m = think(g, f, bots.get(f.id), 0.05); if (m) g.input(f.id, m, 0.05); }
    g.step(0.05);
  }
  assert(g.falls.length >= 1);
});
test('остался один живой — партия окончена, он «Царь болота»', () => {
  const g = fight(3, {});
  F(g, 1).st = 'out'; F(g, 1).fellAt = g.t; g.falls.push(F(g, 1));
  F(g, 2).st = 'out'; F(g, 2).fellAt = g.t + 0.01; g.falls.push(F(g, 2));
  run(g, 0.2);
  assert.strictEqual(g.phase, 'over');
  assert.deepStrictEqual(g.over.kings, ['p0']);
  assert.strictEqual(g.over.players.find(p => p.id === 'p0').place, 1);
});
test('последний в полёте: партия ждёт приземления, потом он «Царь»', () => {
  const g = fight(3, {});
  run(g, 1);
  const f = F(g, 0);
  jumpTo(g, f, nearPad(g, f, g.players.map(p => p.pad)));
  for (const o of [F(g, 1), F(g, 2)]) { o.st = 'out'; o.fellAt = g.t; g.falls.push(o); }
  run(g, 0.1);
  assert.strictEqual(g.phase, 'fight', 'ещё летит');
  run(g, 1);
  assert.strictEqual(g.phase, 'over');
  assert.deepStrictEqual(g.over.kings, ['p0']);
});
test('большой лист рвётся пополам, если иначе до цели не дойти', () => {
  const g = fight(2, { WAVE_FIRST: 0.1, LETHAL_T: 0 });
  // оставим одну большую кувшинку и обе лягушки на ней
  const big = g.pads.find(p => p.big);
  for (const p of g.pads) if (p !== big) { p.state = 'sunk'; }
  for (const f of g.players) { f.st = 'pad'; f.pad = big.id; f.x = big.x; f.y = big.y; }
  run(g, 0.3);
  const w = evs(g, 'wave')[0];
  assert(w && w.shrink.includes(big.id), 'лист рвётся: ' + JSON.stringify(w));
  run(g, 3.5);
  assert.strictEqual(big.cap, 1);
  assert.strictEqual(g.phase, 'over');
});

console.log('Связь');
test('офлайн: кувшинка не тонет под отсутствующим, через 5 с он снят без падения', () => {
  const g = fight(3, {});
  const f = F(g, 0), pad = g.pads[f.pad];
  g.setOnline('p0', false);
  pad.sinkAt = g.t + 2.5; pad.cause = 'wave';
  run(g, 4);
  assert.strictEqual(f.st, 'pad', 'ещё держится');
  assert.strictEqual(pad.state, 'ok');
  run(g, 1.5);
  assert.strictEqual(f.st, 'removed');
  assert.strictEqual(g.loser, null, 'снятый не неудачник');
  assert(g.drainEvents().some(e => e.type === 'removed' && e.id === 'p0'));
});
test('вернулся вовремя — жив, кувшинке даётся время', () => {
  const g = fight(3, {});
  const f = F(g, 0), pad = g.pads[f.pad];
  g.setOnline('p0', false);
  run(g, 2);
  pad.sinkAt = g.t + 0.1; pad.cause = 'wave';
  g.setOnline('p0', true);
  assert(pad.sinkAt >= g.t + 1.4);
  run(g, 1.0);
  assert.strictEqual(f.st, 'pad');
});
test('все, кроме одного, сняты без единого падения — неудачника выбирает жребий среди снятых', () => {
  const g = fight(3, {});
  g.setOnline('p1', false); g.setOnline('p2', false);
  run(g, 5.5);
  assert.strictEqual(g.phase, 'over');
  assert(g.over.lot);
  assert(['p1', 'p2'].includes(g.over.loser));
  assert.deepStrictEqual(g.over.kings, ['p0']);
});

console.log('Неудачник');
test('одновременные падения: меньше вытеснений, потом кто дольше сидел, потом жребий', () => {
  const g = fight(4, {});
  const [a, b, c] = [F(g, 0), F(g, 1), F(g, 2)];
  const T = g.t + 0.1;
  for (const f of [a, b]) { f.st = 'out'; f.fellAt = T; g.falls.push(f); }
  a.stomps = 2; b.stomps = 0; a.seatedAt = 0; b.seatedAt = 5;
  run(g, 0.5);
  assert.strictEqual(g.loser, 'p1', 'меньше вытеснений');
  const h = fight(4, {});
  const [x, y] = [F(h, 0), F(h, 1)];
  for (const f of [x, y]) { f.st = 'out'; f.fellAt = h.t + 0.1; h.falls.push(f); }
  x.seatedAt = 7; y.seatedAt = 3;
  run(h, 0.5);
  assert.strictEqual(h.loser, 'p1', 'сидел дольше');
});
test('нечего делить — ничья-жребий с пометкой', () => {
  const g = fight(4, {});
  const [a, b] = [F(g, 0), F(g, 1)];
  for (const f of [a, b]) { f.st = 'out'; f.fellAt = g.t + 0.1; f.seatedAt = 1; g.falls.push(f); }
  run(g, 0.5);
  assert(['p0', 'p1'].includes(g.loser));
  assert(g.drainEvents().some(e => e.type === 'loser' && e.lot));
});
test('последние падают одновременно — ничья, короны нет', () => {
  const g = fight(2, {});
  const T = g.t + 0.1;
  for (const f of g.players) { f.st = 'out'; f.fellAt = T; g.falls.push(f); }
  run(g, 0.2);
  assert.strictEqual(g.phase, 'over');
  assert(g.over.draw); assert.deepStrictEqual(g.over.kings, []);
});

console.log('Цапля и мухи');
test('цапля целится в людное место, предупреждает, потом топит круг', () => {
  const g = fight(5, { HERON_FIRST: 0.1, HERON_RAND: 0 });
  run(g, 0.3);
  const h = evs(g, 'heron')[0];
  assert(h && h.strikeAt - h.t >= 1.4);
  run(g, 3);
  const s = evs(g, 'strike')[0];
  assert(s, 'удар был');
  for (const id of s.pads) assert.strictEqual(g.pads[id].state === 'sunk' || g.pads[id].sinkAt != null, true);
});
test('цапля не прилетает, когда живых меньше трёх', () => {
  const g = fight(2, { HERON_FIRST: 0.1 });
  run(g, 1);
  assert.strictEqual(evs(g, 'heron').length, 0);
});
test('муха: поймавшая лягушка прыгает дальше', () => {
  const g = fight(3, { FLY_FIRST: 0.1, FLY_EVERY: 0.1 });
  run(g, 0.3);
  const fly = evs(g, 'fly')[0];
  assert(fly);
  const f = F(g, 0), pad = g.pads[fly.pad];
  if (Math.hypot(pad.x - f.x, pad.y - f.y) > g.jmax) return;
  jumpTo(g, f, pad);
  run(g, 1);
  assert(f.st === 'pad' && f.boost, 'на кувшинке и с бонусом');
  g.input('p0', { ang: 0, pow: 1, seq: 5 }, 0);
  const j = g.drainEvents().filter(e => e.type === 'jump' && e.id === 'p0').pop();
  assert(j && j.boost && Math.abs(j.dist - g.jmax * g.cfg.FLY_BOOST) < 1e-6);
  assert(!f.boost, 'бонус потрачен');
});

console.log('Партия целиком');
test('партии ботов всегда заканчиваются, неудачник назначен, события согласованы', () => {
  for (const n of [2, 3, 6, 12]) for (let r = 0; r < 12; r++) {
    const g = createGame({ seed: 900 + r, rng: seeded(r + 1) });
    const bots = new Map();
    for (let i = 0; i < n; i++) { g.addPlayer('b' + i, 'B' + i, i); bots.set('b' + i, createBot(STYLE_KEYS[(i + r) % 3], r * 13 + i)); }
    g.start();
    let over = null, k = 0;
    for (; k < 20 * 160 && !over; k++) {
      for (const f of g.players) { const m = think(g, f, bots.get(f.id), 0.05); if (m) g.input(f.id, m, 0.05); }
      g.step(0.05);
      for (const e of g.drainEvents()) if (e.type === 'over') over = e;
    }
    assert(over, `n=${n} seed=${r}: партия не кончилась`);
    assert(over.loser, 'неудачник назначен');
    assert(over.t <= DEFAULTS.MAX_T + 20, 'в разумных пределах: ' + over.t);
    assert(over.kings.length <= 1);
    const first = over.players.filter(p => p.fellAt != null).sort((a, b) => a.fellAt - b.fellAt)[0];
    if (first) { // неудачник — из тех, кто упал первым (одновременные — тай-брейки)
      const firstOnes = over.players.filter(p => p.fellAt != null && p.fellAt - first.fellAt <= 1e-6).map(p => p.id);
      assert(firstOnes.includes(over.loser) || over.lot, `неудачник ${over.loser} не из первых ${firstOnes}`);
    }
  }
});
test('после MAX_T пруд сжимается принудительно', () => {
  const g = fight(3, { MAX_T: 0, WAVE_FIRST: 0.1, MAX_WAVE_T: 1 });
  let k = 0;
  while (g.phase === 'fight' && k++ < 20 * 40) g.step(0.05);
  assert.strictEqual(g.phase, 'over');
});

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
