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

// Полная скорость (м/с) слева/справа от τ — односторонние разности 2-го порядка, в мире или в системе ротора
function speed(tr, tau, side, frame, h = 0.25) {
  const P = (t) => {
    const s = tr.sampleTau(t);
    const a = frame === "rotor" ? s.phi : s.theta;
    return [s.r * Math.cos(a), s.y, s.r * Math.sin(a)];
  };
  const p0 = P(tau + side * 1e-7), p1 = P(tau + side * h), p2 = P(tau + side * 2 * h);
  let q = 0;
  for (let k = 0; k < 3; k++) { const v = (-3 * p0[k] + 4 * p1[k] - p2[k]) / (2 * h); q += v * v; }
  return Math.sqrt(q) * 1000;
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

  /*
   * 3) в контакте (трек, склон, докат) скорость относительно ротора не растёт без удара;
   *    в полёте её не меряем — там шарик баллистический (см. тест «физика» ниже);
   * 4) сквозь фретки не проходит
   */
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
    const air = cur.air || prev.air;
    if (!air && !near(tau, h) && rate > prevRate * (1 + 1e-6) + 1e-9) { errs.push(`speed-up at τ=${tau.toFixed(1)} (${cur.phase})`); break; }
    const pen = fretPenetration(G, M.PA, cur.phi, cur.r, cur.y);
    if (pen > 1e-6) { errs.push(`fret pass ${pen.toFixed(5)} at τ=${tau.toFixed(1)} (${cur.phase})`); break; }
    prevRate = air ? Infinity : rate;
    prev = cur;
    prevTau = tau;
  }

  // 3б) удар (ромб, фретка, дно ячейки) энергию только забирает: полная скорость в системе поверхности
  //     (ротор — в системе ротора, ромб и склон — в мире) после удара меньше, чем до; разгоняет лишь бросок
  const typeAt = new Map(tr.events.map((e) => [e.tau, e.type]));
  for (const x of imp) {
    if (tr.kicks.includes(x)) continue;
    const frame = ["diamond", "slopeLand"].includes(typeAt.get(x)) ? "world" : "rotor";
    const vb = speed(tr, x, -1, frame), va = speed(tr, x, +1, frame);
    if (!(va <= vb * 0.98 + 1e-6)) errs.push(`${typeAt.get(x)} at τ=${x.toFixed(1)} gains energy: ${vb.toFixed(3)} → ${va.toFixed(3)} м/с`);
    // «выпрыгнул из ячейки почти стоя» — отскок без скорости на входе
    if (vb < 0.02 && va > 0.02) errs.push(`hop from rest at τ=${x.toFixed(1)}`);
  }
  const kickTypes = tr.events.filter((e) => tr.kicks.includes(e.tau)).map((e) => e.type);
  if (kickTypes.some((k) => k !== "launch")) errs.push("unexpected kick");

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
    // шарик падает в ложную ячейку, отскакивает в ней (на экране — в замедлении, ~0,4 с и дольше)
    // и уходит по кромке фретки в выпавшую
    const land = tr.events.find((e) => e.type === "fakeLand");
    const out = tr.events.find((e) => e.type === "hopOut");
    if (!land || !out || out.t - land.t < 350) errs.push(`fake dwell too short ${land && out ? (out.t - land.t).toFixed(0) : "-"}`);
    else {
      const mid = tr.sample((land.t + out.t) / 2);
      if (M.WHEEL[wrapPocket(M, mid.phi)] !== inp.story.fakeFrom) errs.push("fake lands in wrong pocket");
      if (!(tr.sample(land.t + 1).air && tr.sample(out.t - 1).air)) errs.push("fake: no bounce in the fake pocket");
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

/*
 * Физика (жалоба владельца: «шарик выпрыгивает в соседнюю ячейку — нравится, но без нарушения физики»).
 * Путь кусочно-аналитический, поэтому разрывы возможны только на границах сегментов — их проверяем точно,
 * а полёт и контакт — сэмплами по 1 мс:
 *  • нет телепортов (разрыв положения) и скачков скорости без удара;
 *  • в полёте по горизонтали — прямая в мире с постоянной скоростью, по вертикали — постоянное ускорение вниз;
 *  • в полёте не ниже поверхности, в контакте — ровно на ней (склон, кольцо, дно ячейки);
 *  • каждый отскок по ротору начинается и кончается на опоре: кромка фретки, дно ячейки или край ротора;
 *  • покадрово (60 к/с, реальное время с замедлением) шарик не прыгает дальше, чем позволяет скорость.
 */
const PHYS_RUNS = Number(process.env.PHYS_RUNS) || 2000;
test(`физика ${PHYS_RUNS} траекторий: непрерывность, баллистика, опоры`, async () => {
  const M = await load();
  const G = M.GEOM;
  const SLOPE_COS = Math.cos(Math.atan((G.statorOuterY - G.statorInnerY) / (G.statorOuterR - G.statorInnerR)));
  const ySlope = (r) => M.statorY(r) + G.ballR / SLOPE_COS;
  const yRest = G.floorY + G.ballR, yFret = G.fretTopY + G.ballR;
  const world = (s) => [s.r * Math.cos(s.theta), s.y, s.r * Math.sin(s.theta)];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const vel = (tr, tau, side) => {
    const h = 0.25, p0 = world(tr.sampleTau(tau + side * 1e-7)), p1 = world(tr.sampleTau(tau + side * h)), p2 = world(tr.sampleTau(tau + side * 2 * h));
    return [0, 1, 2].map((k) => ((side * (-3 * p0[k] + 4 * p1[k] - p2[k])) / (2 * h)) * 1000);
  };
  const rnd = lcg(4242);
  const fails = [];
  for (let i = 0; i < PHYS_RUNS && fails.length < 5; i++) {
    const inp = makeInput(M, rnd);
    const tr = M.buildTrajectory(inp);
    const errs = [];
    const isImpact = (tau) => tr.impacts.some((x) => Math.abs(x - tau) < 1e-6);
    const bounds = new Set();
    for (const s of tr.segs) {
      if (s.t0 > tr.tau.launch && s.t0 < tr.tau.settle + 1) bounds.add(s.t0);
      if (s.airFrom != null) { bounds.add(s.airFrom); bounds.add(s.airUntil); }
    }
    for (const b of bounds) {
      const jump = dist(world(tr.sampleTau(b - 1e-6)), world(tr.sampleTau(b + 1e-6)));
      if (jump > 1e-5) errs.push(`teleport ${(jump * 1000).toFixed(2)} мм at τ=${b.toFixed(1)}`);
      if (!isImpact(b)) {
        const vl = vel(tr, b, -1), vr = vel(tr, b, +1);
        const dv = Math.hypot(vl[0] - vr[0], vl[1] - vr[1], vl[2] - vr[2]);
        if (dv > 0.01) errs.push(`velocity jump ${dv.toFixed(3)} м/с without impact at τ=${b.toFixed(1)}`);
      }
    }
    const nearBound = (tau) => { for (const b of bounds) if (Math.abs(b - tau) < 1.2) return true; return false; };
    // полёт и контакт
    let flight = null; // вертикальное ускорение текущего полёта
    for (let tau = tr.tau.drop - 50; tau < tr.tau.settle + 100 && errs.length < 3; tau += 1) {
      const s = tr.sampleTau(tau);
      if (s.air) {
        if (nearBound(tau)) { flight = null; continue; }
        const h = 0.5, p0 = world(tr.sampleTau(tau - h)), p1 = world(s), p2 = world(tr.sampleTau(tau + h));
        const a = [0, 1, 2].map((k) => ((p0[k] - 2 * p1[k] + p2[k]) / (h * h)) * 1e6);
        if (!(a[1] < -0.5)) errs.push(`air without gravity at τ=${tau}`);
        if (Math.hypot(a[0], a[2]) > 0.02 * -a[1]) errs.push(`curves in the air: ${Math.hypot(a[0], a[2]).toFixed(2)} м/с² at τ=${tau} (${s.phase})`);
        if (flight != null && Math.abs(a[1] - flight) > 0.01 * -flight) errs.push(`gravity changes mid-flight at τ=${tau}`);
        flight = a[1];
        let floor = null;
        if (s.r >= G.statorInnerR) floor = ySlope(Math.min(s.r, 0.386));
        else if (s.r >= G.ringInnerR && s.r <= G.rotorR) floor = M.ringY(s.r) + G.ballR;
        else if (s.r >= G.pocketInnerR && s.r < G.pocketOuterR) floor = yRest;
        if (floor != null && s.y < floor - 1e-4) errs.push(`below surface ${((floor - s.y) * 1000).toFixed(2)} мм at τ=${tau}`);
      } else {
        flight = null;
        if (s.phase === "rim" || s.phase === "slope") {
          // у внутренней кромки склона шарик плавно переходит на номерное кольцо (оно на 2 мм ниже)
          const lo = s.r < G.statorInnerR ? Math.min(ySlope(s.r), M.ringY(Math.min(s.r, G.rotorR)) + G.ballR) : ySlope(s.r);
          if (s.y < lo - 1e-6 || s.y > ySlope(s.r) + 1e-6) errs.push(`floats/clips on the slope ${((s.y - ySlope(s.r)) * 1000).toFixed(2)} мм at τ=${tau}`);
        } else if (["settle", "ride"].includes(s.phase)) {
          if (Math.abs(s.y - yRest) > 1e-9 || Math.abs(s.r - G.pocketR) > 1e-9) errs.push(`not on the pocket floor at τ=${tau}`);
        }
      }
    }
    // отскоки по ротору: опоры на концах
    const support = (tau) => {
      const s = tr.sampleTau(tau);
      const onFret = Math.abs(s.y - yFret) < 1e-6 && Math.abs(s.phi - (Math.round(s.phi / M.PA - 0.5) + 0.5) * M.PA) * s.r < 1e-4;
      const x = s.phi - Math.round(s.phi / M.PA) * M.PA;
      const onFloor = Math.abs(s.y - yRest) < 1e-6 && Math.abs(x) <= M.X_MAX + 1e-9;
      const onRing = s.r <= G.rotorR && s.r >= G.ringInnerR && Math.abs(s.y - (M.ringY(s.r) + G.ballR)) < 1e-6;
      return onFret || onFloor || onRing;
    };
    for (const h of tr.hops) {
      if (!support(h.t0 + 1e-7)) errs.push(`hop starts in mid-air at τ=${h.t0.toFixed(1)}`);
      if (!support(h.t1 - 1e-7)) errs.push(`hop ends in mid-air at τ=${h.t1.toFixed(1)}`);
    }
    // покадрово, по реальному времени (кадр, внутри которого удар, сравнивать не с чем — там излом пути)
    const hitT = tr.impacts.map((x) => tr.toReal(x));
    const F = 1000 / 60;
    let prevP = null, prevD = null;
    for (let t = tr.times.launch + 20; t < inp.spinMs; t += F) {
      const p = world(tr.sample(t));
      if (prevP) {
        const d = dist(p, prevP);
        const kink = hitT.some((x) => x > t - 2 * F && x <= t);
        if (prevD != null && !kink && d > 3 * prevD + 0.004) errs.push(`frame jump ${(d * 1000).toFixed(1)} мм after ${(prevD * 1000).toFixed(1)} at t=${t.toFixed(0)}`);
        prevD = d;
      }
      prevP = p;
    }
    if (errs.length) fails.push({ i, inp, errs: errs.slice(0, 4) });
  }
  if (fails.length) console.log(JSON.stringify(fails, null, 1));
  assert.equal(fails.length, 0, "траектории нарушают физику");
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
