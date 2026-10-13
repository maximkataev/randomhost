#!/usr/bin/env node
// Тесты движка «Царя льдины»: node test-game.js
'use strict';
const assert = require('assert');
const { createGame, generateFloe, floeRadius, DEFAULTS, pointInPoly, polyArea } = require('./game');
const Bots = require('./bots');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n    ')); }
}

// партия с n игроками, отсчёт уже прошёл
function fight(n, seed = 1, cfg) {
  const g = createGame({ seed, cfg });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i, i);
  assert(g.start());
  for (let t = 0; t < DEFAULTS.COUNTDOWN + 0.02; t += 0.1) g.step(0.1);
  assert.strictEqual(g.phase, 'fight');
  g.players.forEach(p => { p.cd = 0; });   // защиту старта проверяет отдельный тест
  g.drainEvents();
  return g;
}
const P = (g, i) => g.byId.get('p' + i);
const place = (p, x, y) => { p.x = x; p.y = y; p.vx = 0; p.vy = 0; };
// точка на краю льдины по направлению угла a (последняя точка на льду)
function edgePoint(g, a) {
  let r = 0;
  while (g.onIce(Math.cos(a) * (r + 1), Math.sin(a) * (r + 1))) r++;
  return [Math.cos(a) * r, Math.sin(a) * r];
}
function run(g, sec, each) {
  for (let t = 0; t < sec; t += 1 / 60) { if (each) each(); g.step(1 / 60); }
}
// остальных — в центр, чтобы не мешали
function parkOthers(g, except) {
  let k = 0;
  for (const p of g.players) {
    if (except.includes(p)) continue;
    place(p, -30 + (k % 3) * 22, -30 + Math.floor(k / 3) * 22);
    k++;
  }
}

console.log('Льдина');
test('льдина по сиду одна и та же, осколки без дыр', () => {
  const a = generateFloe(123, 150), b = generateFloe(123, 150);
  assert.deepStrictEqual(a.shards.map(s => s.poly), b.shards.map(s => s.poly));
  const hullA = polyArea(a.hull);
  assert(Math.abs(a.area0 - hullA) / hullA < 0.01, `площадь осколков ${a.area0} vs контур ${hullA}`);
  assert(a.shards.length > 30);
});
test('размер льдины растёт с числом игроков, площадь на пингвина одна', () => {
  const r2 = floeRadius(2, DEFAULTS), r6 = floeRadius(6, DEFAULTS), r12 = floeRadius(12, DEFAULTS);
  assert(r2 >= DEFAULTS.R_MIN && r2 < r6 && r6 < r12);
  assert(Math.abs((Math.PI * r12 * r12) / 12 - DEFAULTS.AREA_PER_PLAYER) < 1);
});

console.log('Падения и «кто столкнул»');
test('сам ушёл за край — выбыл, ведёт дейлик, падение «сам»', () => {
  const g = fight(3);
  const a = P(g, 0);
  parkOthers(g, [a]);
  const [x, y] = edgePoint(g, 0);
  place(a, x - 5, y);
  run(g, 0.6, () => g.setInput('p0', 1, 0, false));
  assert.strictEqual(a.st === 'fall' || a.st === 'swim', true);
  assert(g.host && g.host.id === 'p0');
  assert.strictEqual(a.selfFall, true);
  const ev = g.drainEvents().find(e => e.type === 'fall');
  assert.strictEqual(ev.by, null);
});
test('рывок в соперника у края — он в воде, столкнувшему засчитано', () => {
  const g = fight(3);
  const a = P(g, 0), b = P(g, 1);
  parkOthers(g, [a, b]);
  const [x, y] = edgePoint(g, 0);
  place(b, x - 12, y);
  place(a, x - 50, y);
  a.dir = 0;
  g.setInput('p0', 1, 0, true);
  run(g, 0.1);
  g.setInput('p0', -1, 0, false);   // после удара тормозит
  run(g, 0.9);
  assert(b.st !== 'ice', 'цель должна упасть');
  assert.strictEqual(a.st, 'ice');
  assert.strictEqual(b.by, 'p0');
  assert.strictEqual(a.kos, 1);
  assert.strictEqual(a.hits, 1);
  assert.strictEqual(g.host.id, 'p1');
});
test('касание старше окна не засчитывается', () => {
  const g = fight(3);
  const a = P(g, 0);
  parkOthers(g, [a]);
  a.lastTouch = { by: 'p1', t: g.time - DEFAULTS.TOUCH_WINDOW - 0.1, dash: true };
  const [x, y] = edgePoint(g, Math.PI);
  place(a, x + 3, y);
  run(g, 0.5, () => g.setInput('p0', -1, 0, false));
  assert.strictEqual(a.by, null);
  assert.strictEqual(P(g, 1).kos, 0);
});
test('рывок лоб в лоб — обоих отбрасывает', () => {
  const g = fight(2, 7);
  const a = P(g, 0), b = P(g, 1);
  place(a, -30, 0); place(b, 30, 0);
  a.dir = 0; b.dir = Math.PI;
  g.setInput('p0', 1, 0, true);
  g.setInput('p1', -1, 0, true);
  let clash = false;
  run(g, 0.3, () => { for (const e of g.drainEvents()) if (e.type === 'hit' && e.clash) clash = true; });
  assert(clash);
  assert(a.vx < 0 && b.vx > 0);
});

test('рывок в пустоту — событие промаха, попадание — без него', () => {
  const g = fight(2, 9);
  place(P(g, 0), -60, 0); place(P(g, 1), 60, 60);
  P(g, 0).dir = 0;
  g.setInput('p0', 1, 0, true);
  g.step(0.05); g.setInput('p0', 0, 0, false);
  let ev = [];
  run(g, 0.4, () => { ev = ev.concat(g.drainEvents()); });
  assert(ev.some(e => e.type === 'whiff' && e.id === 'p0'));
  const g2 = fight(2, 9);
  place(P(g2, 0), -30, 0); place(P(g2, 1), 0, 0);
  P(g2, 0).dir = 0;
  g2.setInput('p0', 1, 0, true);
  let ev2 = [];
  run(g2, 0.4, () => { ev2 = ev2.concat(g2.drainEvents()); });
  assert(ev2.some(e => e.type === 'hit') && !ev2.some(e => e.type === 'whiff'));
});

test('первые 2 с боя рывка нет — соседа не сбить сразу после старта', () => {
  const g = createGame({ seed: 4 });
  for (let i = 0; i < 3; i++) g.addPlayer('p' + i, 'P' + i, i);
  g.start();
  for (let t = 0; t < DEFAULTS.COUNTDOWN + 0.02; t += 0.1) g.step(0.1);
  let dashes = 0;
  for (let k = 0; k < 110; k++) { g.setInput('p0', 0, 0, true); g.step(1 / 60); dashes += g.drainEvents().filter(e => e.type === 'dash' && e.clock < DEFAULTS.START_GUARD - 0.05).length; }
  assert.strictEqual(dashes, 0);
  run(g, 0.6, () => g.setInput('p0', 0, 0, true));
  assert(g.drainEvents().some(e => e.type === 'dash'));
});

console.log('Темп и таяние (T-W3-27)');
test('START_GUARD и START_RING по умолчанию «как сейчас»: 2 с и 0,45·R; флаги меняют только их', () => {
  assert.strictEqual(DEFAULTS.START_GUARD, 2);
  assert.strictEqual(DEFAULTS.START_RING, 0.45);
  const radii = (cfg) => {
    const g = createGame({ seed: 3, cfg });
    for (let i = 0; i < 6; i++) g.addPlayer('p' + i, 'P' + i, i);
    assert(g.start());
    return { R: g.floe.R, rs: g.players.map(p => Math.hypot(p.x, p.y)), cd: g.players.map(p => p.cd) };
  };
  const a = radii(undefined), b = radii({ START_RING: 0.30, START_GUARD: 3 });
  a.rs.forEach(r => assert(Math.abs(r - a.R * 0.45) < 1e-6));
  b.rs.forEach(r => assert(Math.abs(r - b.R * 0.30) < 1e-6));
  assert(a.cd.every(c => c === 2) && b.cd.every(c => c === 3));
  // соседи на кольце 0,30·R не пересекаются при n = 2..12 (расстояние между центрами ≥ 2·PR)
  for (let n = 2; n <= 12; n++) {
    const g = createGame({ seed: n, cfg: { START_RING: 0.30 } });
    for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i, i);
    g.start();
    const ps = g.players;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert(Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y) >= 2 * DEFAULTS.PR, `n=${n}: пересеклись`);
  }
});
test('упал при сколе осколка — cause melt, не «сам себе враг»; ведущий всё равно назначен по первому падению', () => {
  const g = fight(3, 5);
  // самый дальний от центра осколок и точка внутри него
  let k = 0, far = -1;
  g.floe.shards.forEach((s, i) => { const d = Math.hypot(s.cx, s.cy); if (d > far) { far = d; k = i; } });
  const sh = g.floe.shards[k];
  parkOthers(g, [P(g, 0)]);
  place(P(g, 0), sh.cx, sh.cy);
  assert(pointInPoly(sh.cx, sh.cy, sh.poly));
  g.shardSt[k].st = 'c'; g.shardSt[k].t = 0; g.shardSt[k].dur = 0.05;
  let ev = [];
  run(g, 0.5, () => { ev = ev.concat(g.drainEvents()); });
  const f = ev.find(e => e.type === 'fall' && e.id === 'p0');
  assert(f, 'падение p0 не случилось');
  assert.strictEqual(f.cause, 'melt');
  assert.strictEqual(f.by, null);
  assert.strictEqual(P(g, 0).selfFall, false);
  assert.strictEqual(P(g, 0).melted, true);
  assert(g.host && g.host.id === 'p0');
});
test('упал сам с края — как раньше: без cause, selfFall', () => {
  const g = fight(3, 6);
  parkOthers(g, [P(g, 1)]);
  place(P(g, 1), 0, g.floe.R * 2);
  place(P(g, 0), -30, -30);
  let ev = [];
  run(g, 0.2, () => { ev = ev.concat(g.drainEvents()); });
  const f = ev.find(e => e.type === 'fall' && e.id === 'p1');
  assert(f && f.cause === undefined);
  assert.strictEqual(P(g, 1).selfFall, true);
});
test('снят один из двоих — host.of === 1 (клиент не пишет «все отвалились»); двое из трёх — of === 2', () => {
  const g = fight(2);
  g.removePlayer('p0');
  g.step(1 / 60);
  assert(g.host && g.host.lottery === true);
  assert.strictEqual(g.host.of, 1);
  const h = fight(3);
  h.removePlayer('p0'); h.removePlayer('p1');
  h.step(1 / 60);
  assert.strictEqual(h.host.of, 2);
});

console.log('Ведущий и конец партии');
test('двое упали первыми в одном тике — ведёт тот, кто меньше попадал', () => {
  const g = fight(4);
  const a = P(g, 0), b = P(g, 1);
  parkOthers(g, [a, b]);
  a.hits = 3; b.hits = 1;
  place(a, 0, g.floe.R * 2); place(b, g.floe.R * 2, 0);
  g.step(1 / 60);
  assert.strictEqual(g.host.id, 'p1');
  assert.strictEqual(g.host.tie, 'hits');
});
test('поровну попаданий — жребий, с пометкой', () => {
  const hosts = new Set();
  for (let s = 0; s < 20; s++) {
    const g = fight(4, s);
    parkOthers(g, [P(g, 0), P(g, 1)]);
    place(P(g, 0), 0, g.floe.R * 2); place(P(g, 1), g.floe.R * 2, 0);
    g.step(1 / 60);
    assert.strictEqual(g.host.tie, 'lottery');
    hosts.add(g.host.id);
  }
  assert.strictEqual(hosts.size, 2);
});
test('последний на льдине — царь; места по времени падения', () => {
  const g = fight(3);
  place(P(g, 0), 0, g.floe.R * 2);
  g.step(0.1);
  place(P(g, 1), g.floe.R * 2, 0);
  g.step(0.1);
  assert.strictEqual(g.phase, 'over');
  assert.deepStrictEqual(g.kings, ['p2']);
  assert.strictEqual(g.host.id, 'p0');
  const pl = Object.fromEntries(g.stats.players.map(p => [p.id, p.place]));
  assert.deepStrictEqual(pl, { p2: 1, p1: 2, p0: 3 });
});
test('последние двое упали вместе — цари оба', () => {
  const g = fight(3);
  place(P(g, 0), 0, g.floe.R * 2);
  g.step(0.1);
  place(P(g, 1), g.floe.R * 2, 0); place(P(g, 2), -g.floe.R * 2, 0);
  g.step(0.05);
  assert.strictEqual(g.phase, 'over');
  assert.deepStrictEqual(g.kings.sort(), ['p1', 'p2']);
});
test('60 с прошло, ведущий есть — живые делят звание', () => {
  const g = fight(4);
  place(P(g, 0), 0, g.floe.R * 2);
  g.step(0.1);
  const live = [P(g, 1), P(g, 2), P(g, 3)];
  // держим троих в центре: переставляем каждый шаг, лёд под ними — ядро
  run(g, 61, () => live.forEach((p, i) => place(p, (i - 1) * 21, 0)));
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.kings.length, 3);
});

console.log('Таяние');
test('лёд тает только с края, островов нет, центр держится до 60 с', () => {
  const g = fight(6, 11);
  const core = g.shardSt.map((x, i) => (x.core ? i : -1)).filter(i => i >= 0);
  for (let t = 0; t < 59.5; t += 1 / 60) {
    g.players.forEach((p, i) => place(p, Math.cos(i) * 8, Math.sin(i) * 8));   // все в центре, никто не падает
    g.step(1 / 60);
    if (Math.round(t * 60) % 30 === 0) {
      const alive = g.shardSt.map((x, i) => (x.st === 's' ? i : -1)).filter(i => i >= 0);
      const seen = new Set([alive[0]]), st = [alive[0]];
      while (st.length) for (const n of g.floe.shards[st.pop()].nb) if (g.shardSt[n].st === 's' && !seen.has(n)) { seen.add(n); st.push(n); }
      assert.strictEqual(seen.size, alive.length, `остров на ${t.toFixed(1)} с`);
    }
  }
  core.forEach(i => assert.notStrictEqual(g.shardSt[i].st, 'g'));
  const left = g.solidArea();
  assert(left < Math.PI * DEFAULTS.MID_R * DEFAULTS.MID_R * 1.2, `к 60 с осталось ${left.toFixed(0)}`);
});
test('до 10 с лёд не трескается', () => {
  const g = fight(6, 12);
  run(g, 9.5, () => g.players.forEach((p, i) => place(p, Math.cos(i) * 8, Math.sin(i) * 8)));
  assert(g.shardSt.every(x => x.st === 's'));
});
test('никто не упал за 60 с — добивание решает за ≤10 с', () => {
  const g = fight(3, 13);
  let t = 0;
  // стоят в центре, пока лёд держит
  while (g.phase !== 'over' && t < 75) {
    g.players.forEach((p, i) => { if (p.st === 'ice') { p.vx = p.vy = 0; if (t < 60) place(p, (i - 1) * 21, 0); } });
    g.step(1 / 60);
    t += 1 / 60;
  }
  assert.strictEqual(g.phase, 'over');
  assert(g.host);
  assert(g.clock <= DEFAULTS.FIGHT_T + DEFAULTS.OVERTIME_T + 0.1, `кончилась на ${g.clock}`);
});

console.log('Сеть и ввод');
test('офлайн дольше 5 с — снят и ведущим не становится', () => {
  const g = fight(3);
  parkOthers(g, []);
  g.setOnline('p0', false);
  run(g, DEFAULTS.OFFLINE_T + 0.1, () => g.players.forEach((p, i) => { if (p.st === 'ice') place(p, (i - 1) * 25, 0); }));
  assert.strictEqual(P(g, 0).st, 'gone');
  assert.strictEqual(P(g, 0).removed, true);
  assert.strictEqual(g.host, null);
});
test('вернулся раньше 5 с — играет дальше', () => {
  const g = fight(3);
  g.setOnline('p0', false);
  run(g, 3, () => g.players.forEach((p, i) => place(p, (i - 1) * 25, 0)));
  g.setOnline('p0', true);
  run(g, 3, () => g.players.forEach((p, i) => place(p, (i - 1) * 25, 0)));
  assert.strictEqual(P(g, 0).st, 'ice');
});
test('упал, пока офлайн, — снятие, не падение', () => {
  const g = fight(3);
  g.setOnline('p0', false);
  place(P(g, 0), 0, g.floe.R * 2);
  g.step(1 / 60);
  assert.strictEqual(P(g, 0).removed, true);
  assert.strictEqual(g.host, null);
});
test('OFFLINE_FALL_GRACE=1,5: упал в окне после отключения — падение, ведущий он (floe-007)', () => {
  const g = fight(3, 1, { OFFLINE_FALL_GRACE: 1.5 });
  parkOthers(g, [P(g, 0)]);
  g.setOnline('p0', false);
  run(g, 0.1, () => parkOthers(g, [P(g, 0)]));
  place(P(g, 0), 0, g.floe.R * 2);
  g.step(1 / 60);
  assert.strictEqual(P(g, 0).removed, false);
  assert.strictEqual(g.host && g.host.id, 'p0');
});
test('OFFLINE_FALL_GRACE=1,5: офлайн 2 с, затем упал — снятие, не падение', () => {
  const g = fight(3, 1, { OFFLINE_FALL_GRACE: 1.5 });
  g.setOnline('p0', false);
  run(g, 2, () => parkOthers(g, []));
  assert.strictEqual(P(g, 0).st, 'ice');
  place(P(g, 0), 0, g.floe.R * 2);
  g.step(1 / 60);
  assert.strictEqual(P(g, 0).removed, true);
  assert.strictEqual(g.host, null);
});
test('OFFLINE_FALL_GRACE=1,5: leave у края — тело на льду, упало в окне — ведущий; без падения снят через 1,5 с', () => {
  const g = fight(3, 1, { OFFLINE_FALL_GRACE: 1.5 });
  parkOthers(g, [P(g, 0)]);
  g.removePlayer('p0');
  assert.strictEqual(P(g, 0).st, 'ice', 'тело остаётся на льду');
  assert.strictEqual(P(g, 0).removed, false);
  run(g, 0.1, () => parkOthers(g, [P(g, 0)]));
  place(P(g, 0), 0, g.floe.R * 2);
  g.step(1 / 60);
  assert.strictEqual(P(g, 0).removed, false);
  assert.strictEqual(g.host && g.host.id, 'p0');
  // у центра: никуда не падает — через окно снят
  const h = fight(3, 1, { OFFLINE_FALL_GRACE: 1.5 });
  h.removePlayer('p1');
  run(h, 1.0, () => parkOthers(h, []));
  assert.strictEqual(P(h, 1).st, 'ice');
  run(h, 0.7, () => parkOthers(h, []));
  assert.strictEqual(P(h, 1).st, 'gone');
  assert.strictEqual(P(h, 1).removed, true);
  assert.strictEqual(h.host, null);
});
test('OFFLINE_FALL_GRACE=0 (по умолчанию): упал сразу после отключения — всё равно снятие, leave снимает сразу', () => {
  const g = fight(3);
  parkOthers(g, [P(g, 0)]);
  g.setOnline('p0', false);
  g.step(1 / 60);
  place(P(g, 0), 0, g.floe.R * 2);
  g.step(1 / 60);
  assert.strictEqual(P(g, 0).removed, true);
  assert.strictEqual(g.host, null);
  const h = fight(3);
  h.removePlayer('p1');
  assert.strictEqual(P(h, 1).st, 'gone');
});
test('все, кроме одного, сняты без падений — ведущий по жребию среди снятых', () => {
  const g = fight(3);
  g.removePlayer('p0');
  g.removePlayer('p1');
  g.step(1 / 60);
  assert(g.host && ['p0', 'p1'].includes(g.host.id));
  assert.strictEqual(g.host.lottery, true);
  assert.strictEqual(g.phase, 'over');
  assert.deepStrictEqual(g.kings, ['p2']);
});
test('упал, затем ушёл (leave/kick) — fellAt, место и removed не меняются (floe-050)', () => {
  const g = fight(3);
  parkOthers(g, [P(g, 0)]);
  place(P(g, 0), 0, g.floe.R * 2);
  run(g, 0.2);
  assert.strictEqual(P(g, 0).st, 'fall');
  const fell = P(g, 0).fellAt;
  assert(fell >= 0);
  run(g, 3, () => parkOthers(g, [P(g, 0)]));
  assert.strictEqual(P(g, 0).st, 'swim');
  g.drainEvents();
  g.removePlayer('p0');
  run(g, 2, () => parkOthers(g, [P(g, 0)]));
  assert.strictEqual(P(g, 0).fellAt, fell, 'fellAt не переписан');
  assert.strictEqual(P(g, 0).removed, false, 'ложного «снят» нет');
  assert.strictEqual(P(g, 0).st, 'swim');
  assert(!g.drainEvents().some((e) => e.type === 'removed'), 'события removed нет');
  assert.strictEqual(g.host && g.host.id, 'p0', 'ведущий — упавший первым, как и был');
});
test('мусорный ввод и флуд рывком', () => {
  const g = fight(2);
  place(P(g, 0), 0, 0); place(P(g, 1), 60, 60);
  g.setInput('p0', NaN, 'x', false);
  g.setInput('p0', 50, 0, false);
  assert(Math.abs(Math.hypot(P(g, 0).ix, P(g, 0).iy) - 1) < 1e-9);
  let dashes = 0;
  for (let k = 0; k < 60; k++) {           // 1 с, рывок жмут каждый кадр
    g.setInput('p0', 0, 1, true);
    P(g, 0).x = 0; P(g, 0).y = 0;
    g.step(1 / 60);
    dashes += g.drainEvents().filter(e => e.type === 'dash').length;
  }
  assert.strictEqual(dashes, 1);
  g.setInput('nobody', 1, 1, true);
});
test('старт — только от двух игроков в сети', () => {
  const g = createGame({ seed: 1 });
  g.addPlayer('a', 'A', 0);
  assert.strictEqual(g.start(), false);
  g.addPlayer('b', 'B', 1);
  g.setOnline('b', false);
  assert.strictEqual(g.start(), false);
  g.setOnline('b', true);
  assert.strictEqual(g.start(), true);
});
test('в лобби падают понарошку: возрождение, ведущего нет', () => {
  const g = createGame({ seed: 2 });
  g.addPlayer('a', 'A', 0); g.addPlayer('b', 'B', 1);
  place(g.byId.get('a'), 0, g.floe.R * 2);
  g.step(1 / 60);
  assert.strictEqual(g.byId.get('a').st, 'fall');
  run(g, DEFAULTS.PRACTICE_RESPAWN + 0.1);
  assert.strictEqual(g.byId.get('a').st, 'ice');
  assert.strictEqual(g.host, null);
});
test('опоздавший в партию смотрит, в лобби — играет', () => {
  const g = fight(2);
  const c = g.addPlayer('late', 'L', 3);
  assert.strictEqual(c.inGame, false);
  assert.strictEqual(c.st, 'gone');
  g.toLobby();
  assert.strictEqual(c.st, 'ice');
});

console.log('Повтор');
test('повтор первого падения: 3 с до и ~1 с после', () => {
  const g = fight(3, 3);
  run(g, 5, () => g.players.forEach((p, i) => place(p, (i - 1) * 25, 0)));
  place(P(g, 0), 0, g.floe.R * 2);
  run(g, 2, () => [1, 2].forEach(i => place(P(g, i), (i - 1) * 25, 0)));
  const r = g.replay;
  assert(r && r.done);
  const t0 = r.frames[0].t, t1 = r.frames[r.frames.length - 1].t;
  assert(r.at - t0 >= 2.9, `до: ${(r.at - t0).toFixed(2)}`);
  assert(t1 - r.at >= 1.0, `после: ${(t1 - r.at).toFixed(2)}`);
});

console.log('Жребий (floe-016)');
test('opts.draw: рассадка берётся из draw, seed льдины остаётся детерминированным', () => {
  const mk = (extra) => {
    const g = createGame(Object.assign({ seed: 77 }, extra));
    for (let i = 0; i < 6; i++) g.addPlayer('p' + i, 'P' + i, i);
    assert(g.start());
    return g;
  };
  const a = mk({});
  let calls = 0;
  const b = mk({ draw: () => { calls++; return 0.123; } });
  assert.strictEqual(a.seed, b.seed, 'seed льдины не зависит от draw');
  assert.deepStrictEqual(a.floe.shards.map(s => s.poly), b.floe.shards.map(s => s.poly));
  assert(calls >= 6, 'draw вызван на перестановку и поворот: ' + calls);
  const posA = a.players.map(p => [p.x.toFixed(2), p.y.toFixed(2)].join()).join('|');
  const posB = b.players.map(p => [p.x.toFixed(2), p.y.toFixed(2)].join()).join('|');
  assert.notStrictEqual(posA, posB, 'рассадка другая');
  // по умолчанию draw = rng: два одинаковых создания дают одну и ту же рассадку
  const c = mk({});
  assert.strictEqual(posA, c.players.map(p => [p.x.toFixed(2), p.y.toFixed(2)].join()).join('|'));
});

console.log('Боты');
test('партия ботов всегда заканчивается и укладывается в ~70 с', () => {
  for (let s = 0; s < 30; s++) {
    const g = createGame({ seed: s });
    const bots = {};
    for (let i = 0; i < 8; i++) { g.addPlayer('b' + i, 'B', i); bots['b' + i] = Bots.createBot(Bots.STYLE_KEYS[i % 4]); }
    g.start();
    for (let k = 0; k < 30 * 80 && g.phase !== 'over'; k++) {
      for (const p of g.players) { const b = Bots.think(g, p, bots[p.id], 1 / 30); g.setInput(p.id, b.mx, b.my, b.dash); }
      g.step(1 / 30);
    }
    assert.strictEqual(g.phase, 'over', 'сид ' + s);
    assert(g.host);
  }
});

console.log(`\n${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
