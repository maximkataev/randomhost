"use strict";

/*
 * Траектории шарика (roulette-spec.md §7.2, §11): 10 000 сгенерированных спинов.
 * Модуль траектории — ES-модуль для браузера, поэтому берём его через import().
 * Проверки написаны здесь заново, а не взяты из validate() модуля: тест не должен верить сам себе.
 *
 * Запуск: node --test roulette/test-trajectory.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "roulette-trajectory.js")).href);

const TAU = Math.PI * 2;
const RUNS = Number(process.env.TRAJ_RUNS) || 10000;

// Детерминированный генератор входов, чтобы провал можно было воспроизвести по номеру
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Вход как у режиссёра game.js: сюжет, соседка для ложной посадки, длительность 9–14 с
function makeInput(M, rnd) {
  const number = Math.floor(rnd() * 37);
  const r = rnd();
  const pathName = r < 0.22 ? "fake" : r < 0.4 ? "jump" : "normal";
  const allin = rnd() < 0.2 ? ["p1"] : [];
  const idx = M.WHEEL.indexOf(number);
  const fakeFrom = pathName === "fake" ? M.WHEEL[(idx + [-2, -1, 1, 2][Math.floor(rnd() * 4)] + 37) % 37] : null;
  // длительность — как в direct(), плюс немного чистого случая по всему диапазону 9000–14000
  let spinMs = 9000 + Math.floor(rnd() * 2001) + (pathName === "fake" ? 1600 : 0) + (pathName === "jump" ? 900 : 0) + (allin.length ? 1800 : 0);
  if (rnd() < 0.15) spinMs = 9000 + Math.floor(rnd() * 5001);
  if (pathName === "fake" && spinMs < 10600) spinMs = 10600;
  spinMs = Math.min(14000, spinMs);
  const story = { path: pathName, fakeFrom, allin, jackpot: rnd() < 0.05, save: [], zero: number === 0, duration: spinMs };
  return { number, seed: Math.floor(rnd() * 2 ** 31), story, spinMs };
}

const wrapPocket = (M, phi) => {
  const k = Math.floor(((phi / M.PA + 0.5) % 37 + 37) % 37);
  return k;
};

// Своя проверка фретки: стенка толщиной fretW на угле (k+½)·PA, шарик не ниже её кромки при перекрытии
function fretPenetration(G, PA, phi, r, y) {
  if (r > G.pocketOuterR + G.ballR || r < G.pocketInnerR - G.ballR) return 0;
  const k = Math.round(phi / PA - 0.5);
  const d = Math.abs(phi - (k + 0.5) * PA) * r - G.fretW / 2;
  if (d >= G.ballR) return 0;
  const dd = Math.max(0, d);
  const need = G.fretTopY + Math.sqrt(G.ballR * G.ballR - dd * dd);
  return Math.max(0, need - y);
}

function checkOne(M, inp) {
  const G = M.GEOM;
  const tr = M.buildTrajectory(inp);
  const target = M.WHEEL.indexOf(inp.number);
  const errs = [];
  const D = inp.spinMs;

  // 1) тайминг: бросок после spinAt, шарик лежит к revealAt − 500
  const T = tr.times;
  if (!(T.launch >= 0)) errs.push("launch<0");
  if (!(T.launch < T.drop && T.drop < T.rotor && T.rotor < T.land && T.land <= T.settle)) errs.push("order");
  if (!(T.settle <= D - 500 + 1e-6)) errs.push(`late settle ${T.settle} > ${D - 500}`);
  if (!(T.drop - T.launch >= 2500)) errs.push("rim too short");
  if (!(tr.laps >= 2.5 && tr.laps <= 10)) errs.push(`laps ${tr.laps}`);

  // 2) после посадки шарик неподвижен относительно ротора и лежит в нужной ячейке
  const fin = tr.sample(D - 500);
  for (const t of [D - 500, D - 250, D, D + 3000]) {
    const s = tr.sample(t);
    if (Math.abs(s.phi - fin.phi) > 1e-9) errs.push("moves after settle");
    if (Math.abs(s.theta - (s.phi + s.wheel)) > 1e-9) errs.push("frame mismatch");
  }
  if (wrapPocket(M, fin.phi) !== target) errs.push(`pocket ${M.WHEEL[wrapPocket(M, fin.phi)]} != ${inp.number}`);
  const off = Math.abs(fin.phi - target * M.PA - Math.round((fin.phi - target * M.PA) / TAU) * TAU);
  if (off * G.pocketR + G.ballR + G.fretW / 2 > (M.PA / 2) * G.pocketR + 1e-9) errs.push("rests on a fret");
  if (Math.abs(fin.y - (G.floorY + G.ballR)) > 1e-9 || Math.abs(fin.r - G.pocketR) > 1e-9) errs.push("not on pocket floor");

  // 3) скорость относительно ротора не растёт без удара; 4) сквозь фретки не проходит
  const imp = tr.impacts;
  const near = (tau, h) => imp.some((x) => Math.abs(x - tau) <= h * 2.5);
  let prevRate = Infinity;
  let prev = tr.sampleTau(tr.tau.launch + 0.5);
  let prevTau = tr.tau.launch + 0.5;
  for (let tau = prevTau; tau < tr.tau.settle + 200; ) {
    const h = tau < tr.tau.drop - 60 ? 10 : 1.5;
    tau += h;
    const cur = tr.sampleTau(tau);
    const rate = Math.abs(cur.phi - prev.phi) / (tau - prevTau);
    if (!near(tau, h) && rate > prevRate * (1 + 1e-6) + 1e-9) { errs.push(`speed-up at τ=${tau.toFixed(1)} (${cur.phase})`); break; }
    const pen = fretPenetration(G, M.PA, cur.phi, cur.r, cur.y);
    if (pen > 1e-6) { errs.push(`fret pass ${pen.toFixed(5)} at τ=${tau.toFixed(1)} (${cur.phase})`); break; }
    prevRate = rate;
    prev = cur;
    prevTau = tau;
  }

  // 3б) удар (ромб, фретка, стенка ячейки) скорость только забирает; разгоняют лишь бросок и выпрыгивание
  for (const x of imp) {
    if (tr.kicks.includes(x)) continue;
    const a = tr.sampleTau(x - 4), b = tr.sampleTau(x - 2), c = tr.sampleTau(x + 2), d = tr.sampleTau(x + 4);
    if (Math.abs(d.phi - c.phi) > Math.abs(b.phi - a.phi) * 1.02 + 1e-9) errs.push(`impact speeds up at τ=${x.toFixed(1)}`);
  }
  const kickTypes = tr.events.filter((e) => tr.kicks.includes(e.tau)).map((e) => e.type);
  if (kickTypes.some((k) => k !== "launch" && k !== "hopOut")) errs.push("unexpected kick");

  // 5) каждый отскок в цепочке ниже предыдущего — по фактической высоте в сэмплах
  for (const chain of [0, 1]) {
    const hops = tr.hops.filter((h) => h.chain === chain);
    let last = Infinity;
    for (const h of hops) {
      let top = -Infinity;
      for (let tau = h.t0; tau <= h.t1; tau += 1) top = Math.max(top, tr.sampleTau(tau).y);
      if (!(top < last)) errs.push(`bounce not lower (chain ${chain})`);
      last = top;
    }
  }

  // 6) сюжеты
  const chain0 = tr.hops.filter((h) => h.chain === 0);
  if (inp.story.path === "normal" && tr.path === "normal" && (chain0.length < 2 || chain0.length > 5)) errs.push(`hops ${chain0.length}`);
  if (tr.path === "jump" && !(chain0[0].pockets >= 5 && chain0[0].pockets <= 9)) errs.push(`jump ${chain0[0].pockets}`);
  if (tr.path === "fake") {
    const rest = tr.events.find((e) => e.type === "rest");
    const out = tr.events.find((e) => e.type === "hopOut");
    if (!rest || !out || out.t - rest.t < 380) errs.push("fake pause too short");
    else {
      const mid = tr.sample((rest.t + out.t) / 2);
      if (M.WHEEL[wrapPocket(M, mid.phi)] !== inp.story.fakeFrom) errs.push("fake lands in wrong pocket");
    }
  }
  if (inp.story.allin.length && !tr.slow) errs.push("allin not slow");
  if (tr.path !== inp.story.path) errs.push(`path fell back ${inp.story.path} → ${tr.path}`);

  return { tr, errs };
}

test(`${RUNS} траекторий: ячейка, правдоподобие, тайминг`, async () => {
  const M = await load();
  const rnd = lcg(20260925);
  let hits = 0;
  const fails = [];
  const byPath = {};
  for (let i = 0; i < RUNS; i++) {
    const inp = makeInput(M, rnd);
    let res;
    try {
      res = checkOne(M, inp);
    } catch (e) {
      fails.push({ i, inp, errs: [String(e && e.message)] });
      continue;
    }
    if (res.tr.hit) hits++;
    byPath[res.tr.path] = (byPath[res.tr.path] || 0) + 1;
    if (res.errs.length) fails.push({ i, inp, errs: res.errs });
  }
  if (fails.length) console.log(JSON.stringify(fails.slice(0, 5), null, 1));
  assert.equal(fails.length, 0, `${fails.length} траекторий нарушают ограничения`);
  // ромб — примерно в 60% спинов (§7.2)
  const rate = hits / RUNS;
  assert.ok(rate > 0.5 && rate < 0.7, `доля ударов о ромб ${rate}`);
  assert.ok(byPath.fake > 0 && byPath.jump > 0 && byPath.normal > 0);
});

test("тот же сид — та же траектория (переподключение доски)", async () => {
  const M = await load();
  const rnd = lcg(7);
  for (let i = 0; i < 300; i++) {
    const inp = makeInput(M, rnd);
    const a = M.buildTrajectory(inp);
    const b = M.buildTrajectory(JSON.parse(JSON.stringify(inp)));
    assert.deepEqual(a.events, b.events);
    for (let k = 0; k < 40; k++) {
      const t = (inp.spinMs * k) / 39;
      assert.deepEqual(a.sample(t), b.sample(t));
    }
  }
});

test("разный сид — разный путь, но та же ячейка", async () => {
  const M = await load();
  const story = { path: "normal", fakeFrom: null, allin: [], jackpot: false, save: [], zero: false };
  const a = M.buildTrajectory({ number: 17, seed: 1, story, spinMs: 10000 });
  const b = M.buildTrajectory({ number: 17, seed: 2, story, spinMs: 10000 });
  assert.notEqual(a.sample(3000).theta, b.sample(3000).theta);
  assert.equal(M.WHEEL[wrapPocket(M, a.finalPhi)], 17);
  assert.equal(M.WHEEL[wrapPocket(M, b.finalPhi)], 17);
});

test("мусорный fakeFrom и крайние длительности не ломают построение", async () => {
  const M = await load();
  for (const fakeFrom of [null, 99, 17, "x"]) {
    for (const spinMs of [9000, 14000, 3000, 30000]) {
      const tr = M.buildTrajectory({ number: 17, seed: 5, story: { path: "fake", fakeFrom, allin: [] }, spinMs });
      assert.equal(M.WHEEL[wrapPocket(M, tr.sample(tr.spinMs).phi)], 17);
    }
  }
  assert.throws(() => M.buildTrajectory({ number: 37, seed: 1, story: {}, spinMs: 10000 }));
});

/*
 * Стыковка холостого хода со спином (жалоба «при раскрутке колесо чуть паузится»):
 * раньше угол из сида догонялся кратчайшим путём ±π, и при минусе ротор тормозил до нуля
 * и даже шёл назад прямо перед броском. Теперь — только вперёд и гладко.
 */
test("колесо при старте спина не тормозит, не разворачивается и не дёргается", async () => {
  const M = await load();
  const rnd = lcg(99);
  for (let i = 0; i < 400; i++) {
    const inp = makeInput(M, rnd);
    const tr = M.buildTrajectory(inp);
    const cur = rnd() * 40 - 20;
    const tCall = -6000 + rnd() * 7400; // вызов spin() от «ставок больше нет» до переподключения в начале спина
    const curSpeed = -M.IDLE_SPEED * (1 + rnd()); // после прошлого спина ротор мог ещё не сбросить скорость
    const h = M.wheelHandoff(tr, cur, curSpeed, tCall);
    const d = (((h.angle(tCall) - cur) % TAU) + TAU) % TAU;
    assert.ok(Math.min(d, TAU - d) < 1e-6, "угол в момент вызова совпадает с текущим (с точностью до оборота)");
    const step = 4;
    let prevW = null;
    for (let t = tCall + step; t < 5000; t += step) {
      const w = (h.angle(t + 0.5) - h.angle(t - 0.5)) / 0.001; // рад/с
      assert.ok(w < -0.15, `ротор почти встал или пошёл назад: ω=${w.toFixed(3)} при t=${t.toFixed(0)}`);
      if (prevW != null) assert.ok(Math.abs(w - prevW) / (step / 1000) < 14, `рывок ускорения ${((w - prevW) / (step / 1000)).toFixed(1)} рад/с² при t=${t.toFixed(0)}`);
      prevW = w;
    }
    // скорость в момент вызова равна текущей (нет скачка), а к 3 с угол — ровно из сида
    const w0 = (h.angle(tCall + 1) - h.angle(tCall)) / 0.001;
    assert.ok(Math.abs(w0 - curSpeed) < 0.05, `скачок скорости при вызове: ${w0.toFixed(3)} vs ${curSpeed.toFixed(3)}`);
    assert.ok(Math.abs(h.angle(h.until + 10) - tr.wheelAngle(h.until + 10)) < 1e-9);
  }
});
