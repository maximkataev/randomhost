"use strict";

// Математика рынков: эталонные таблицы из bets-spec.md, инварианты книги, частоты розыгрышей.
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkBook, bookSum, payout, quote } = require("./odds");
const { Phi } = require("./mathx");
const dice = require("./events/dice");
const dogs = require("./events/dogs");
const pen = require("./events/penalties");
const rope = require("./events/rope");
const rocket = require("./events/rocket");
const boxing = require("./events/boxing");
const live = require("./events/live");

// детерминированный rnd(n) → 0..n-1
function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}
const byId = (ev) => Object.fromEntries(ev.markets.map((m) => [m.id, m]));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} ${a} ≉ ${b} (±${eps})`);

// Частота каждого рынка за N розыгрышей в пределах 4,5σ от p; заодно выигрышный RTP каждого
function monteCarlo(ev, rnd, N) {
  const hits = new Map(ev.markets.map((m) => [m.id, 0]));
  for (let i = 0; i < N; i++) {
    const o = ev.draw(rnd);
    for (const m of ev.markets) if (m.test(o)) hits.set(m.id, hits.get(m.id) + 1);
  }
  for (const m of ev.markets) {
    const f = hits.get(m.id) / N, sd = Math.sqrt(m.p * (1 - m.p) / N);
    assert.ok(Math.abs(f - m.p) <= 4.5 * sd + 1e-9, `${ev.type}/${m.id}: частота ${f} против p ${m.p} (σ ${sd})`);
  }
}

test("quote и payout", () => {
  assert.equal(quote(0.5, 0.06), 188);
  assert.equal(quote(0.95, 0.06), null); // k < 1,05
  assert.equal(quote(0.001, 0.06), null); // k > 200
  assert.equal(payout(100, 188), 188);
  assert.equal(payout(10, 105), 10); // floor(10,5)
  assert.equal(payout(333, 313), 1042); // floor(1042,29)
});

test("Φ и erf против известных значений", () => {
  near(Phi(0), 0.5, 1e-12);
  near(Phi(1), 0.8413447460685429, 1e-9);
  near(Phi(-2), 0.022750131948179195, 1e-9);
  near(Phi(2.5), 0.9937903346742238, 1e-9);
});

test("кости: эталон из спеки и сумма P = 1", () => {
  const ev = dice.build();
  near(dice.OMEGA.reduce((s, x) => s + x.P, 0), 1, 1e-12);
  const m = byId(ev);
  assert.equal(m["sum:10-11"].kc, 376);
  assert.equal(m["sum:7-14"].kc, 662);
  assert.equal(m["sum:3-18"].kc, 9720);
  assert.equal(m["big"].kc, 193);
  assert.equal(m["small"].kc, 193);
  assert.equal(m["odd"].kc, 193);
  assert.equal(m["has:1"].kc, 223);
  assert.equal(m["triple"].kc, 3240);
  assert.equal(m["exact:8"].kc, 925);
  assert.equal(m["exact:10"].kc, 720);
  near(m["big"].p, 105 / 216, 1e-12);
  assert.deepEqual(checkBook(ev.markets), []);
  monteCarlo(ev, mulberry(1), 200000);
});

test("собаки (3): эталонная таблица", () => {
  const W = [50, 30, 20];
  const ev = dogs.build(mulberry(2), W);
  near(dogs.PERMS.reduce((s, p) => s + dogs.permProb(W, p), 0), 1, 1e-12);
  assert.equal(dogs.PERMS.length, 6);
  const m = byId(ev);
  const expect = { 1: [188, 109, 560], 2: [313, 136, 276], 3: [470, 189, 175] };
  for (const [i, [w, t2, last]] of Object.entries(expect)) {
    assert.equal(m[`win:${i}`].kc, w, `win ${i}`);
    assert.equal(m[`top2:${i}`].kc, t2, `top2 ${i}`);
    assert.equal(m[`last:${i}`].kc, last, `last ${i}`);
  }
  assert.equal(m["ex:1-2"].kc, 293);
  assert.equal(m["ex:3-2"].kc, 1173);
  // сумма обратных коэффициентов по победителям ≈ 1/(1 − m) (с поправкой на округление вниз)
  const bs = bookSum(ev.markets.filter((x) => x.group === "win"));
  assert.ok(bs >= 1 / 0.94 - 1e-9 && bs < 1 / 0.94 + 0.02, `книга ${bs}`);
  assert.deepEqual(checkBook(ev.markets), []);
  monteCarlo(ev, mulberry(3), 200000);
});

test("собаки (3): генератор весов держит ограничения и рынки в диапазоне", () => {
  const rnd = mulberry(4);
  for (let i = 0; i < 300; i++) {
    const ev = dogs.build(rnd);
    const w = ev.params.weights, S = w.reduce((a, b) => a + b, 0);
    assert.equal(w.length, 3);
    assert.ok(Math.max(...w) / S >= 0.34 && Math.max(...w) / S <= 0.58 && Math.min(...w) / S >= 0.12);
    assert.deepEqual(checkBook(ev.markets), []);
    assert.ok(ev.markets.some((m) => m.id.startsWith("win:")), "победа хотя бы одной собаки в игре");
    assert.deepEqual([...ev.draw(rnd)].sort(), [0, 1, 2]);
  }
});

test("пенальти: пример из спеки", () => {
  const ev = pen.build(mulberry(5), { A: [850, 800, 750, 700, 650], B: [800, 750, 750, 700, 600] });
  const m = byId(ev);
  near(m["winner:A"].p, 0.5523170240384616, 1e-12);
  assert.equal(m["winner:A"].kc, 170);
  assert.equal(m["winner:B"].kc, 209);
  near(m["post"].p, 1 - Math.pow(0.96, 10), 1e-12);
  assert.deepEqual(checkBook(ev.markets), []);
  // линия тотала: «больше 5,5» (p ≈ 90%) в игру не берётся
  assert.ok(!m["over:5.5"], "линия с p>80% не должна быть второй/третьей");
  monteCarlo(ev, mulberry(6), 200000);
});

test("пенальти: случайные составы, инварианты и сходимость", () => {
  const rnd = mulberry(7);
  for (let i = 0; i < 40; i++) {
    const ev = pen.build(rnd);
    assert.deepEqual(checkBook(ev.markets), []);
    const pw = ev.markets.filter((x) => x.group === "winner").reduce((s, x) => s + x.p, 0);
    near(pw, 1, 1e-9, "победитель A+B");
    for (let k = 0; k < 20; k++) { const o = ev.draw(rnd); assert.ok(o.winner === "A" || o.winner === "B"); assert.equal(o.kicks.length, 10); }
  }
  monteCarlo(pen.build(mulberry(8)), mulberry(9), 150000);
});

test("канат: эталон из спеки", () => {
  const ev = rope.build(mulberry(10), 550);
  const m = byId(ev);
  near(m["win:A"].p, 0.7408, 5e-5);
  assert.equal(m["win:A"].kc, 126);
  assert.equal(m["win:B"].kc, 362);
  near(m["comeback:A"].p, 0.0651, 5e-5);
  assert.equal(m["comeback:A"].kc, 1382);
  assert.deepEqual(checkBook(ev.markets), []);
  monteCarlo(ev, mulberry(11), 200000);
  const even = byId(rope.build(mulberry(12), 500));
  assert.equal(even["win:A"].kc, 188);
  near(even["win:A"].p, 0.5, 1e-12);
});

test("ракета: коэффициент равен цели при любой цели, RTP одинаков", () => {
  for (const x of [1.01, 1.2, 1.37, 2, 3.33, 7.5, 10, 99.99, 1000]) {
    const mk = rocket.targetMarket(x);
    if (x < 1.06) { assert.equal(mk, null, `цель ${x}: k < 1,05 не предлагаем`); continue; }
    if (x > 200) { assert.equal(mk, null, `цель ${x}: k > 200 не предлагаем`); continue; }
    assert.equal(mk.kc, Math.round(x * 100), `цель ${x}`);
    near(mk.p * mk.kc / 100, 0.94, 0.01 * mk.p + 1e-9);
  }
  assert.equal(rocket.targetMarket(1.0), null);
  const inst = rocket.instantMarket();
  near(inst.p, 1 - 0.94 / 1.01, 1e-12);
  assert.equal(inst.kc, 1356);
  const ev = rocket.build();
  assert.deepEqual(checkBook(ev.markets), []);
  monteCarlo(ev, mulberry(13), 400000);
});

test("BTC выше/ниже: таблица порогов", () => {
  const ev = live.btc(40);
  const m = byId(ev);
  // нулевой порог — полцента от σ=40: p чуть меньше 50%
  near(m["up:0"].p, 0.5, 1e-4);
  near(m["up:1"].p, 1 - Phi(1 / 1.2), 1e-4); // пороги считаются с запасом по хвосту (σ×1,2)
  assert.equal(m["up:0.5"].kc, Math.floor(0.92 / m["up:0.5"].p * 100 + 1e-9));
  assert.deepEqual(checkBook(ev.markets), []);
  // порог 2σ при марже 10% и запасе по хвосту: ≈ 18,8 (без запаса было 39,5)
  assert.ok(m["up:2"].kc >= 1850 && m["up:2"].kc <= 1900, String(m["up:2"].kc));
  near(m["up:0"].p, 0.5, 1e-4); // «выше/ниже нуля» от запаса не зависит
  // исходы: движение ровно на пороге Δ не выигрывает «выше Δ»
  assert.equal(m["up:1"].test(40.005), false);
  assert.equal(m["up:1"].test(40.01), true);
});

test("BTC против ETH: формулы ортантов", () => {
  const ev = live.btcEth(0.0003, 0.0004, 0.8);
  const m = byId(ev);
  near(m["bothUp"].p, 0.25 + Math.asin(0.8) / (2 * Math.PI), 1e-12);
  assert.equal(m["bothUp"].kc, 226);
  assert.equal(m["mixed"].kc, 439);
  near(2 * m["bothUp"].p + m["mixed"].p, 1, 1e-12);
  assert.deepEqual(checkBook(ev.markets), []);
  // проверка Монте-Карло для двумерной нормали с ρ
  const rnd = mulberry(14), N = 300000;
  const gauss = () => { const u = (rnd(1e9) + 1) / (1e9 + 1), v = rnd(1e9) / 1e9; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const hit = { bothUp: 0, mixed: 0 };
  for (let i = 0; i < N; i++) {
    const z1 = gauss(), z2 = gauss();
    const rB = z1, rE = 0.8 * z1 + 0.6 * z2;
    if (rB > 0 && rE > 0) hit.bothUp++;
    if (rB * rE < 0) hit.mixed++;
  }
  near(hit.bothUp / N, m["bothUp"].p, 4.5 * Math.sqrt(0.4 * 0.6 / N));
  near(hit.mixed / N, m["mixed"].p, 4.5 * Math.sqrt(0.2 * 0.8 / N));
});

test("дуэль счётчиков: сумма вероятностей, симметрия, сходимость", () => {
  const ev = live.duel({ lamA: 2.4, lamB: 2.1, T: 20, phi: 1.5 });
  const { pA, pB, tie } = ev.probs;
  near(pA + pB + tie, 1, 1e-9);
  assert.ok(pA > pB && tie > 0.02 && tie < 0.06, `tie ${tie}`);
  // зеркальная пара
  const sym = live.duel({ lamA: 2.1, lamB: 2.4, T: 20, phi: 1.5 }).probs;
  near(sym.pA, pB, 1e-12);
  assert.deepEqual(checkBook(ev.markets), []);
  // сверка с Монте-Карло отрицательного биномиального (гамма–пуассон смесь)
  const rnd = mulberry(15), N = 120000;
  const gammaPoisson = (mean, phi) => {
    // NB как смесь: λ ~ Gamma(shape r, scale (φ−1)), N|λ ~ Poisson(λ)
    const r = mean / (phi - 1);
    let g = 0; // сумма экспонент для целой части формы + дробная часть через Марсальи—Цанга
    const gam = (a) => { // Marsaglia–Tsang, a ≥ 1
      const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
      for (;;) {
        let x, v;
        do { const u1 = (rnd(1e9) + 1) / (1e9 + 1), u2 = rnd(1e9) / 1e9; x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
        v = v * v * v;
        const u = (rnd(1e9) + 1) / (1e9 + 1);
        if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
      }
    };
    const lam = (r >= 1 ? gam(r) : gam(r + 1) * Math.pow((rnd(1e9) + 1) / (1e9 + 1), 1 / r)) * (phi - 1);
    let k = 0, L = Math.exp(-lam), p = 1;
    if (lam > 500) return Math.round(lam);
    do { k++; p *= (rnd(1e9) + 1) / (1e9 + 1); } while (p > L);
    return k - 1;
  };
  let a = 0, b = 0, t = 0;
  for (let i = 0; i < N; i++) { const x = gammaPoisson(48, 1.5), y = gammaPoisson(42, 1.5); if (x > y) a++; else if (y > x) b++; else t++; }
  near(a / N, pA, 4.5 * Math.sqrt(pA * (1 - pA) / N), "A");
  near(b / N, pB, 4.5 * Math.sqrt(pB * (1 - pB) / N), "B");
  near(t / N, tie, 4.5 * Math.sqrt(tie * (1 - tie) / N), "tie");
});

test("пороги: хотя бы одно событие", () => {
  const ev = live.thresholds([{ id: "wiki", lam: 1 / 40 }, { id: "whale", lam: 1 / 100 }], { T: 20, phi: 1, ks: [1, 2] });
  const m = byId(ev);
  near(m["wiki:ge1"].p, 1 - Math.exp(-0.5), 1e-9);
  assert.equal(m["wiki:ge1"].kc, 223);
  assert.ok(!m["wiki:ge2"], "p 9% < 15% — не показываем");
  assert.ok(m["whale:ge1"], "p 18% ≥ 15% — показываем");
  assert.ok(!m["whale:ge2"], "p 1,75% < 15% — не показываем");
});

test("пороги: рынок в диапазоне 15–85% идёт на табло", () => {
  const ev = live.thresholds([{ id: "whale", lam: 1 / 100 }], { T: 20, phi: 1, ks: [1, 2], pMin: 0.01 });
  const m = byId(ev);
  near(m["whale:ge1"].p, 1 - Math.exp(-0.2), 1e-9);
  assert.equal(m["whale:ge1"].kc, 485);
  assert.equal(m["whale:ge2"].kc, 5021);
});

test("категориальные рулетки и drand", () => {
  const ev = live.categorical({ en: 4200, ja: 2500, pt: 1300, es: 700, de: 500, ru: 400, fr: 200, ko: 100 });
  const sum = ev.markets.reduce((s, m) => s + m.p, 0);
  near(sum, 1, 1e-9);
  assert.ok(ev.markets.every((m) => m.p >= 0.03));
  assert.ok(ev.markets.find((m) => m.id === "cat:other"), "мелкие объединены");
  assert.deepEqual(checkBook(ev.markets), []);
  const d = byId(live.drand());
  assert.equal(d["digit:a"].kc, 1520);
  assert.equal(d["even"].kc, 190);
  assert.equal(d["num"].kc, 152);
  assert.equal(d["letter"].kc, 253);
  assert.equal(d["quarter:2"].kc, 380);
  assert.equal(d["digit:7"].test("abc7"), true);
  assert.equal(d["letter"].test("00ff"), true);
});

test("бокс: эталон, сумма P = 1, частоты сходятся с вероятностями", () => {
  const fixed = { kA: 90, kB: 50, q: 550 };
  const ev = boxing.build(mulberry(31), fixed);
  near(boxing.outcomes(90, 50, 550).reduce((s, x) => s + x.P, 0), 1, 1e-12);
  const m = byId(ev);
  assert.equal(m["win:A"].kc, 151);
  assert.equal(m["win:B"].kc, 247);
  assert.equal(m["method:KO"].kc, 173);
  assert.equal(m["method:DEC"].kc, 195);
  assert.equal(m["ko:1-2"].p > 0.2, true);
  near(m["win:A"].p + m["win:B"].p, 1, 1e-12);
  assert.deepEqual(checkBook(ev.markets), []);
  monteCarlo(ev, mulberry(32), 250000);
  // случайные бойцы: рынки в диапазоне, исход непротиворечив
  const rnd = mulberry(33);
  for (let i = 0; i < 100; i++) {
    const e = boxing.build(rnd);
    assert.deepEqual(checkBook(e.markets), []);
    const o = e.draw(rnd);
    assert.ok(o.winner === "A" || o.winner === "B");
    if (o.method === "KO") assert.equal(o.rounds.length, o.round - 1); else assert.equal(o.rounds.length, 5);
  }
});
