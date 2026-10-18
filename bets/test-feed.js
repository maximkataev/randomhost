"use strict";

/*
 * Тесты живых источников (bets/feed*.js) на моках и фикстурах, БЕЗ сети.
 * Запуск: node --test bets/test-feed.js
 * Фикстуры: fixtures/live-samples.json (реальные образцы потоков, снятые 18.10.2026),
 *           fixtures/prices-synth.json.gz и streams-synth.json.gz (синтетика, fixtures/gen.js).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const { createFeed, parseFlags } = require("./feed");
const prices = require("./feed-prices");
const bsky = require("./feed-bsky");
const wiki = require("./feed-wiki");
const whales = require("./feed-whales");
const drand = require("./feed-drand");
const news = require("./feed-news");
const lightning = require("./feed-lightning");
const { RateTracker, parseRss } = require("./feed-util");
const live = require("./events/live");
const R = require("./registry");
const { Game } = require("./game");
const { Phi } = require("./mathx");

const FX = path.join(__dirname, "fixtures");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, f))));
const SAMPLES = JSON.parse(fs.readFileSync(path.join(FX, "live-samples.json"), "utf8"));

// ---- инструменты: фальшивые часы, WebSocket, fetch ----
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

class Clock {
  constructor(t = 1_790_000_000_000) { this.t = t; this.q = []; this.id = 0; }
  now = () => this.t;
  setTimeout = (f, ms) => { const id = ++this.id; this.q.push({ id, at: this.t + Math.max(0, ms || 0), f, iv: 0 }); return id; };
  setInterval = (f, ms) => { const id = ++this.id; this.q.push({ id, at: this.t + ms, f, iv: ms }); return id; };
  clear = (id) => { this.q = this.q.filter((x) => x.id !== id); };
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let nxt = null;
      for (const x of this.q) if (x.at <= end && (!nxt || x.at < nxt.at || (x.at === nxt.at && x.id < nxt.id))) nxt = x;
      if (!nxt) break;
      this.t = Math.max(this.t, nxt.at);
      if (nxt.iv) nxt.at += nxt.iv; else this.q = this.q.filter((x) => x !== nxt);
      nxt.f();
    }
    this.t = end;
    await flush();
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}

class MockWS {
  static all = [];
  constructor(url) { this.url = url; this.h = {}; this.sent = []; MockWS.all.push(this); }
  on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
  removeAllListeners() { this.h = {}; }
  send(s) { this.sent.push(s); }
  close() { this.closed = true; this.emit("close"); }
  terminate() { this.closed = true; }
  emit(e, ...a) { for (const f of this.h[e] || []) f(...a); }
}
MockWS.reset = () => { MockWS.all = []; };

const okJson = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const okText = (t) => ({ ok: true, status: 200, text: async () => t });
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => "" };

function mkDeps(clock, extra = {}) {
  return Object.assign({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clear, setInterval: clock.setInterval, clearInterval: clock.clear,
    rnd: mulberry(7), log: () => {}, env: {}, WebSocket: MockWS,
  }, extra);
}

// сборщик результатов begin()
function sink() {
  const r = { live: [], resolved: null, aborted: null, voids: undefined };
  r.opts = {
    onLive: (d) => r.live.push(d),
    onResolve: (o, v) => { r.resolved = o; r.voids = v; r.done = "resolve"; },
    onAbort: (w) => { r.aborted = w || true; r.done = "abort"; },
  };
  return r;
}

// ================= флаги =================
test("флаги BETS_LIVE: none по умолчанию, список, all; выключенное prepare → null, begin → abort", async () => {
  assert.equal(parseFlags(undefined).size, 0);
  assert.equal(parseFlags("none").size, 0);
  assert.deepEqual([...parseFlags("btc, drand,foo")].sort(), ["btc", "drand"]);
  assert.equal(parseFlags("all").size, R.REAL.length);
  const clock = new Clock();
  const f = createFeed(mkDeps(clock, { env: {} }));
  f.start();
  assert.equal(f.prepare("btc"), null);
  const s = sink();
  f.begin("btc", { closeAt: clock.now(), ...s.opts });
  await clock.advance(50);
  assert.ok(s.aborted, "выключенное событие сразу abort");
  const st = f.status();
  assert.equal(st.btc.enabled, false);
  assert.deepEqual(Object.keys(st).sort(), [...R.REAL].sort());
  f.stop();
  const g = createFeed(mkDeps(clock, { env: { BETS_LIVE: "drand" } }));
  assert.equal(g.prepare("btc"), null, "btc не включён");
  assert.deepEqual(g.enabled(), ["drand"]);
});

// ================= котировки: калибровка оценки σ на 24 ч синтетики =================
function loadPrices() {
  const j = gz("prices-synth.json.gz");
  const acc = (d) => { let s = 0; return d.map((v) => (s += v) / 100); };
  return { startSec: j.startSec, n: j.n, btc: acc(j.btc), eth: acc(j.eth) };
}

test("σ из EWMA по приращениям за 5 с: доли |ΔS| > zσ совпадают с 2(1−Φ(z)) (допуск §4.5)", () => {
  const P = loadPrices();
  const zs = [0.5, 1, 1.5, 2];
  const hit = zs.map(() => 0);
  let up = 0, n = 0, rhoSum = 0, rhoN = 0;
  for (let t = 3600; t + 20 < P.n; t += 20) {
    const A = P.btc.slice(t - 1900, t + 1), B = P.eth.slice(t - 1900, t + 1);
    const est = prices.estimateVol(A, B);
    assert.ok(est);
    const sigma = A[A.length - 1] * est.sA * Math.sqrt(20);
    const d = P.btc[t + 20] - P.btc[t];
    n++;
    if (d > 0) up++;
    zs.forEach((z, i) => { if (Math.abs(d) > z * sigma) hit[i]++; });
    rhoSum += est.rho; rhoN++;
  }
  assert.ok(n > 4000);
  assert.ok(Math.abs(up / n - 0.5) < 0.02, `выше нуля ${up / n}`);
  zs.forEach((z, i) => {
    const model = 2 * (1 - Phi(z)), emp = hit[i] / n;
    // центр: 1,5 п.п. (+ запас на шум выборки 4300 окон), хвосты: относительно 25%
    const ok = z <= 1 ? Math.abs(emp - model) < 0.02 : Math.abs(emp - model) / model < 0.25;
    assert.ok(ok, `z=${z}: эмпирически ${emp.toFixed(4)}, модель ${model.toFixed(4)}`);
  });
  assert.ok(Math.abs(rhoSum / rhoN - 0.8) < 0.08, `ρ ≈ ${(rhoSum / rhoN).toFixed(3)}`);
});

// наполняем модуль котировками из фикстуры (серверные метки = виртуальные часы)
function primePrices(mod, clock, P, fromT, toT) {
  mod._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => clock.now() });
  for (let t = fromT; t <= toT; t++) {
    const ms = (P.startSec + t) * 1000;
    mod._record("binance", "BTC", P.btc[t], ms);
    mod._record("binance", "ETH", P.eth[t], ms + 3);
  }
  clock.t = (P.startSec + toT) * 1000 + 500;
}

test("prices.prepare: btc → {sigma}, btceth → {sigB,sigE,rho}; рынки собираются registry.rebuild", () => {
  const P = loadPrices(), clock = new Clock();
  const mod = prices.create(mkDeps(clock));
  primePrices(mod, clock, P, 10000, 14000);
  const a = mod.prepare("btc");
  assert.ok(a && a.input.sigma > 1, JSON.stringify(a));
  const direct = prices.estimateVol(P.btc.slice(14000 - 10800, 14001), null);
  assert.ok(Math.abs(a.input.sigma / (P.btc[14000] * direct.sA * Math.sqrt(20)) - 1) < 0.1);
  const ev = R.rebuild("btc", a.input);
  assert.ok(ev.markets.length >= 8);
  const mid = ev.markets.find((m) => m.id === "up:0");
  assert.ok(mid && mid.p > 0.45 && mid.p < 0.55);
  const b = mod.prepare("btceth");
  assert.ok(b && b.input.rho > 0.6 && b.input.rho < 0.95, JSON.stringify(b));
  assert.ok(b.input.sigB > 0 && b.input.sigE > b.input.sigB * 0.8);
  const ev2 = R.rebuild("btceth", b.input);
  assert.ok(ev2.markets.some((m) => m.id === "mixed" && m.p > 0.1 && m.p < 0.4));
  assert.deepEqual(a.meta.labels, { coin: "BTC" });
  assert.deepEqual(b.meta.labels, { A: "BTC", B: "ETH" });
});

test("prices.prepare: null при молчании, нехватке данных, всплеске волатильности и ρ < 0,3", () => {
  const P = loadPrices(), clock = new Clock();
  const mod = prices.create(mkDeps(clock));
  assert.equal(mod.prepare("btc"), null, "ни одной котировки");
  primePrices(mod, clock, P, 13500, 14000);                   // 500 с < 300 валидных? хватает 600-секундной оценки по 500 точкам
  assert.ok(mod.prepare("btc"), "500 секунд котировок достаточно (≥ 300 валидных)");
  const m2 = prices.create(mkDeps(clock));
  primePrices(m2, clock, P, 13900, 14000);
  assert.equal(m2.prepare("btc"), null, "100 секунд — мало");
  // источник молчит
  const m3 = prices.create(mkDeps(clock));
  primePrices(m3, clock, P, 10000, 14000);
  m3._setConn({ endpoint: () => "binance", isLive: () => false, lastMsgAt: () => 0 });
  assert.equal(m3.prepare("btc"), null);
  // всплеск: последние 5 минут волатильность ×6 против фона
  const m4 = prices.create(mkDeps(clock));
  m4._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => clock.now() });
  const rr = mulberry(5);
  let p = 80000;
  for (let t = 0; t < 7200; t++) {
    const vol = t > 6900 ? 1.5e-3 : 1e-4;
    p *= 1 + vol * ((rr(2001) - 1000) / 577);
    m4._record("binance", "BTC", p, 1.8e12 + t * 1000);
  }
  clock.t = 1.8e12 + 7200 * 1000;
  assert.equal(m4.prepare("btc"), null, "всплеск (§4.5): событие снимается");
  // ETH «расклеился» с BTC: ρ ≈ 0
  const m5 = prices.create(mkDeps(clock));
  m5._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => clock.now() });
  let pb = 80000, pe = 2300;
  for (let t = 0; t < 1200; t++) {
    pb *= 1 + 1e-4 * ((rr(2001) - 1000) / 577); pe *= 1 + 1e-4 * ((rr(2001) - 1000) / 577);
    m5._record("binance", "BTC", pb, 1.8e12 + t * 1000); m5._record("binance", "ETH", pe, 1.8e12 + t * 1000 + 2);
  }
  clock.t = 1.8e12 + 1200 * 1000;
  assert.ok(m5.prepare("btc"));
  assert.equal(m5.prepare("btceth"), null, "ρ < 0,3 — событие снимается (§4.6)");
});

// живой «тикер» для begin(): подаёт котировки каждую секунду по функции цены
function ticker(mod, clock, fn, { from = 0, until = Infinity, src = "binance" } = {}) {
  return clock.setInterval(() => {
    const t = clock.now();
    if (t < from || t > until) return;
    const [b, e] = fn(t);
    mod._record(src, "BTC", b, t);
    mod._record(src, "ETH", e, t + 1);
  }, 250);
}

test("btc.begin: S0 по закрытию, S1 через 20 с, исход = сдвиг в $, рынки live.btc проверяются; ход цены уходит в onLive", async () => {
  const clock = new Clock();
  const mod = prices.create(mkDeps(clock));
  mod._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => clock.now() });
  const closeAt = clock.now() + 3000;
  // цена: 100000 до закрытия, +52,37 к концу окна (линейно за 20 с)
  const fn = (t) => { const k = Math.min(1, Math.max(0, (t - closeAt) / 20000)); return [100000 + 52.37 * k, 3000]; };
  ticker(mod, clock, fn);
  const s = sink();
  mod.begin("btc", { closeAt, ...s.opts });
  await clock.advance(3000 + 20000 + 400);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.equal(s.resolved, 52.37);
  assert.equal(s.voids, undefined);
  const s0 = s.live.find((x) => x.kind === "s0");
  assert.equal(s0.btc, 100000);
  const pr = s.live.filter((x) => x.kind === "price");
  assert.ok(pr.length >= 18 && pr.length <= 21, `price раз в секунду: ${pr.length}`);
  assert.ok(pr[pr.length - 1].btc > 100040);
  // совпадение с формулами live.js: σ = 40 → пороги 0, 20, 40, 60, 80
  const ev = R.rebuild("btc", { sigma: 40 });
  const win = ev.markets.filter((m) => m.test(s.resolved)).map((m) => m.id).sort();
  assert.deepEqual(win, ["down:0".replace("down", "up"), "up:0.5", "up:1"].sort());
});

test("btc.begin: нет котировки за 3 с до закрытия → abort; пропала до конца окна → abort; смена источника → abort", async () => {
  // 1) молчание перед закрытием
  let clock = new Clock();
  let mod = prices.create(mkDeps(clock));
  mod._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => clock.now() });
  mod._record("binance", "BTC", 100000, clock.now() - 6000);
  mod._record("binance", "ETH", 3000, clock.now() - 6000);
  let s = sink();
  mod.begin("btc", { closeAt: clock.now() + 1000, ...s.opts });
  await clock.advance(1500);
  assert.equal(s.done, "abort");
  // 2) тикер умирает через 10 с после закрытия: к S1 котировка старше 3 с
  clock = new Clock();
  mod = prices.create(mkDeps(clock));
  mod._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => clock.now() });
  const closeAt = clock.now() + 1000;
  ticker(mod, clock, () => [100000, 3000], { until: closeAt + 10000 });
  s = sink();
  mod.begin("btc", { closeAt, ...s.opts });
  await clock.advance(1000 + 20000 + 400);
  assert.equal(s.done, "abort");
  assert.equal(s.resolved, null);
  // 3) S0 с binance, а в конце активен другой источник: цены разных источников не смешиваются
  clock = new Clock();
  mod = prices.create(mkDeps(clock));
  let ep = "binance";
  mod._setConn({ endpoint: () => ep, isLive: () => true, lastMsgAt: () => clock.now() });
  const c3 = clock.now() + 1000;
  ticker(mod, clock, () => [100000, 3000], { until: c3 + 5000, src: "binance" });
  ticker(mod, clock, () => [100010, 3001], { from: c3 + 6000, src: "coinbase" });
  s = sink();
  mod.begin("btc", { closeAt: c3, ...s.opts });
  await clock.advance(1000 + 6000);
  ep = "coinbase";
  await clock.advance(14000 + 400);
  assert.equal(s.done, "abort", "S1 из другого источника не берётся (у binance котировка протухла)");
});

test("btc.begin: точная ничья (цена не сдвинулась) → исход 0 и voids up:0/down:0; сквозной прогон через Game", async () => {
  const clock = new Clock();
  const mod = prices.create(mkDeps(clock));
  mod._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => clock.now() });
  const closeAt = clock.now() + 1000;
  ticker(mod, clock, () => [100000, 3000]);
  const s = sink();
  mod.begin("btc", { closeAt, ...s.opts });
  await clock.advance(1000 + 20000 + 400);
  assert.equal(s.resolved, 0);
  assert.deepEqual(s.voids, ["up:0", "down:0"]);
  // Game: ставки на up:0 возвращаются, остальные проигрывают
  const g = new Game(mulberry(4), { prepareLive: () => ({ input: { sigma: 40 }, meta: {} }) });
  g.setSettings({ mode: "real" });
  g.addPlayer("a", "А"); g.addPlayer("b", "Б");
  g.start(0);
  g.s.ev.type = "btc"; g.cur = R.rebuild("btc", { sigma: 40 }); g.s.ev.input = { sigma: 40 }; g.s.ev.live = true; g.s.schedule[0] = "btc";
  g.bet("a", "up:0", 100); g.bet("a", "up:1", 100); g.submit("a", 5);
  g.bet("b", "down:0", 100); g.submit("b", 5);
  let now = 5;
  for (let i = 0; i < 20 && g.s.phase !== "scene"; i++) { now = Math.max(now, g.nextDeadline()); g.tick(now); }
  g.resolveLive(s.resolved, now + 1000, s.voids);
  for (let i = 0; i < 20 && g.s.phase !== "payout"; i++) { now = Math.max(now + 1000, g.nextDeadline()); g.tick(now); }
  assert.equal(g.s.players.a.stack, 1000 - 100, "100 вернулось, 100 проиграно");
  assert.equal(g.s.players.b.stack, 1000, "ставка на down:0 вернулась");
});

test("btceth.begin: исход {rB, rE} в долях, рынки live.btcEth; ничьи в voids", async () => {
  const clock = new Clock();
  const mod = prices.create(mkDeps(clock));
  mod._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => clock.now() });
  const closeAt = clock.now() + 1000;
  // BTC +0,0004 (0,04%), ETH −0,0002
  const fn = (t) => { const k = Math.min(1, Math.max(0, (t - closeAt) / 20000)); return [100000 * (1 + 0.0004 * k), 3000 * (1 - 0.0002 * k)]; };
  ticker(mod, clock, fn);
  const s = sink();
  mod.begin("btceth", { closeAt, ...s.opts });
  await clock.advance(1000 + 20000 + 400);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.ok(Math.abs(s.resolved.rB - 0.0004) < 1e-5 && Math.abs(s.resolved.rE + 0.0002) < 1e-5, JSON.stringify(s.resolved));
  assert.equal(s.voids, undefined);
  const ev = R.rebuild("btceth", { sigB: 0.0004, sigE: 0.0005, rho: 0.8 });
  const wins = ev.markets.filter((m) => m.test(s.resolved)).map((m) => m.id);
  assert.ok(wins.includes("mixed") && wins.includes("btcBeats") && !wins.includes("ethBeats") && !wins.includes("bothUp"));
  const s0 = s.live.find((x) => x.kind === "s0");
  assert.ok(s0.btc === 100000 && s0.eth === 3000);
  // обе монеты не сдвинулись: ничьи
  const c2 = new Clock();
  const m2 = prices.create(mkDeps(c2));
  m2._setConn({ endpoint: () => "binance", isLive: () => true, lastMsgAt: () => c2.now() });
  ticker(m2, c2, () => [100000, 3000]);
  const s2 = sink();
  m2.begin("btceth", { closeAt: c2.now() + 1000, ...s2.opts });
  await c2.advance(21400);
  assert.deepEqual(s2.voids.sort(), ["bothDown", "bothUp", "btcBeats", "ethBeats", "mixed"]);
});

// ================= потоки: калибровка оценок интенсивности на 4 ч синтетики =================
const STREAMS = gz("streams-synth.json.gz");
const BASE = 1_790_100_000_000;

test("дуэль счётчиков: EWMA-оценки λ + φ скина дают калиброванные P(A>B), P(B>A), ничья (допуск 3,5 п.п.)", () => {
  for (const [a, b, phi] of [["laugh", "heart", 1.6], ["dewiki", "frwiki", 1.8], ["frwiki", "ruwiki", 1.8]]) {
    const ta = new RateTracker({ keep: 10 * 60 * 1000 }), tb = new RateTracker({ keep: 10 * 60 * 1000 });
    const ea = STREAMS.events[a], eb = STREAMS.events[b];
    let ia = 0, ib = 0, n = 0, sA = 0, sB = 0, sT = 0, rA = 0, rB = 0, rT = 0;
    for (let t = 600_000; t + 20_000 < STREAMS.durationSec * 1000; t += 20_000) {
      while (ia < ea.length && ea[ia] <= t) ta.add(ea[ia++]);
      while (ib < eb.length && eb[ib] <= t) tb.add(eb[ib++]);
      ta.prune(t); tb.prune(t);
      const la = ta.rate(t, { since: 0 }), lb = tb.rate(t, { since: 0 });
      const pr = live.duelProbs(la, lb, 20, phi);
      let ca = 0, cb = 0;
      for (let i = ia; i < ea.length && ea[i] <= t + 20_000; i++) ca++;
      for (let i = ib; i < eb.length && eb[i] <= t + 20_000; i++) cb++;
      n++; sA += pr.pA; sB += pr.pB; sT += pr.tie;
      if (ca > cb) rA++; else if (cb > ca) rB++; else rT++;
    }
    assert.ok(Math.abs(sA / n - rA / n) < 0.035, `${a}/${b}: P(A) модель ${(sA / n).toFixed(3)}, факт ${(rA / n).toFixed(3)}`);
    assert.ok(Math.abs(sB / n - rB / n) < 0.035, `${a}/${b}: P(B) модель ${(sB / n).toFixed(3)}, факт ${(rB / n).toFixed(3)}`);
    assert.ok(Math.abs(sT / n - rT / n) < 0.035, `${a}/${b}: ничья модель ${(sT / n).toFixed(3)}, факт ${(rT / n).toFixed(3)}`);
  }
});

test("категориальные доли языков: p=(n+1)/(N+K) по 5 минутам ≈ доле следующего поста (допуск 3 п.п.)", () => {
  const clock = new Clock(BASE);
  const mod = bsky.create(mkDeps(clock));
  mod._setConn({ endpoint: () => "x", isLive: () => true, lastMsgAt: () => clock.now() });
  mod._since(BASE);
  const ts = STREAMS.events.post, codes = STREAMS.langCodes;
  let i = 0, n = 0;
  const pred = { en: 0, ja: 0 }, real = { en: 0, ja: 0 };
  for (let t = 600_000; t + 20_000 < STREAMS.durationSec * 1000; t += 20_000) {
    while (i < ts.length && ts[i] <= t) { clock.t = BASE + ts[i]; mod._onPost({ text: "", langs: [codes[+STREAMS.langs[i]]] }, BASE + ts[i]); i++; }
    clock.t = BASE + t;
    const p = mod.prepare("lang");
    assert.ok(p, "после 10 минут язык готов");
    const ev = live.categorical(p.input.counts, p.input.minShare, "categ");
    const get = (id) => (ev.markets.find((m) => m.id === "cat:" + id) || { p: 0 }).p;
    // «следующий пост» после t
    const nxt = codes[+STREAMS.langs[i]];
    n++;
    for (const l of ["en", "ja"]) { pred[l] += get(l); if (nxt === l) real[l]++; }
  }
  for (const l of ["en", "ja"]) assert.ok(Math.abs(pred[l] / n - real[l] / n) < 0.03, `${l}: модель ${(pred[l] / n).toFixed(3)}, факт ${(real[l] / n).toFixed(3)}`);
});

test("киты: пороговые рынки по λ за час: P(≥1 за 20 с) ≈ доле окон с китом (допуск 5 п.п.; φ=1,2)", () => {
  const clock = new Clock(BASE);
  const mod = whales.create(mkDeps(clock));
  mod._setConn({ endpoint: () => "x", isLive: () => true, lastMsgAt: () => clock.now() });
  mod._since(BASE);
  const e100 = STREAMS.events.w100;
  let i = 0, n = 0, pred = 0, real = 0;
  for (let t = 900_000; t + 20_000 < STREAMS.durationSec * 1000; t += 20_000) {
    while (i < e100.length && e100[i] <= t) { clock.t = BASE + e100[i]; mod._onTx({ hash: "h" + i, out: [{ value: 150e8 }] }, BASE + e100[i]); i++; }
    clock.t = BASE + t;
    const p = mod.prepare();
    if (!p) continue;
    const k = p.input.kinds.find((x) => x.id === "w100");
    const ev = live.thresholds(p.input.kinds, p.input.opts);
    const m = ev.markets.find((x) => x.id === "w100:ge1");
    if (!m) continue;
    let c = 0;
    for (let j = i; j < e100.length && e100[j] <= t + 20_000; j++) c++;
    n++; pred += m.p; if (c >= 1) real++;
    assert.ok(k && k.lam > 0);
  }
  assert.ok(n > 400, `окон ${n}`);
  assert.ok(Math.abs(pred / n - real / n) < 0.05, `модель ${(pred / n).toFixed(3)}, факт ${(real / n).toFixed(3)}`);
});

// ================= вспомогательное для потоков =================
// синхронно прокрутить часы на dur мс с шагом step, вызывая fn(t) в каждой точке
function pump(clock, dur, step, fn) {
  const t0 = clock.t;
  for (let o = step; o <= dur; o += step) { clock.t = t0 + o; fn(clock.t, o); }
}
const conn = (clock) => ({ endpoint: () => "x", isLive: () => true, lastMsgAt: () => clock.now() });
const feedAt = (clock, tAbs, f) => clock.setTimeout(f, tAbs - clock.now());

// ================= Bluesky: emoji =================
function warmBsky(clock, mod, { rnd = mulberry(3) } = {}) {
  mod._setConn(conn(clock));
  mod._since(clock.t);
  // 4 минуты: 😂 ≈ 0,55/с, ❤️ ≈ 0,45/с и немного шума (детерминированно)
  pump(clock, 240_000, 100, (t) => {
    if (rnd(1000) < 55) mod._onPost({ text: "so funny 😂", langs: ["en"] }, t);
    if (rnd(1000) < 45) mod._onPost({ text: "love ❤️", langs: ["en"] }, t);
    if (rnd(1000) < 300) mod._onPost({ text: "обычный пост", langs: ["ru"] }, t);
  });
}

test("emoji.prepare: пара подбирается по |μ_d| ≤ 0,6σ_d; λ близки к истинным; подписи A/B; null до прогрева", () => {
  const clock = new Clock(BASE);
  const mod = bsky.create(mkDeps(clock));
  assert.equal(mod.prepare("emoji"), null, "нет данных");
  mod._setConn(conn(clock));
  mod._since(clock.t);
  assert.equal(mod.prepare("emoji"), null, "поток только открыт");
  warmBsky(clock, mod);
  const p = mod.prepare("emoji");
  assert.ok(p, "пара найдена");
  assert.ok(Math.abs(p.input.lamA - 0.55) < 0.15 && Math.abs(p.input.lamB - 0.45) < 0.15, JSON.stringify(p.input));
  assert.equal(p.input.T, 20);
  assert.equal(p.input.phi, 1.6);
  assert.deepEqual(p.meta.labels, { A: "😂", B: "❤️" });
  const ev = R.rebuild("emoji", p.input);
  assert.deepEqual(ev.markets.map((m) => m.id).sort(), ["A", "B", "tie"].sort());
  // фаворит вдвое сильнее: пара не показывается
  const c2 = new Clock(BASE), m2 = bsky.create(mkDeps(c2));
  m2._setConn(conn(c2)); m2._since(c2.t);
  pump(c2, 240_000, 100, (t, o) => { if (o % 200 === 0) m2._onPost({ text: "😂😂", langs: ["en"] }, t); if (o % 1000 === 0) m2._onPost({ text: "❤️", langs: ["en"] }, t); });
  assert.equal(m2.prepare("emoji"), null, "предрешённый исход не предлагается");
});

test("emoji.begin: считаются только посты после closeAt и до closeAt+20 с; исход {nA,nB}; рынки live.duel; count раз в ~0,5 с", async () => {
  const clock = new Clock(BASE);
  const mod = bsky.create(mkDeps(clock));
  warmBsky(clock, mod);
  const p = mod.prepare("emoji");
  const closeAt = clock.now() + 2000;
  const s = sink();
  mod.begin("emoji", { closeAt, ...s.opts });
  // до закрытия: 5 смеха (не считаются); после: 7 смеха, 4 сердца; после окна: ещё 3 (не считаются)
  for (let i = 0; i < 5; i++) feedAt(clock, closeAt - 1500 + i * 100, () => mod._onPost({ text: "😂", langs: ["en"] }, clock.now()));
  for (let i = 0; i < 7; i++) feedAt(clock, closeAt + 1000 + i * 2000, () => mod._onPost({ text: "😂", langs: ["en"] }, clock.now()));
  for (let i = 0; i < 4; i++) feedAt(clock, closeAt + 1500 + i * 4000, () => mod._onPost({ text: "❤️", langs: ["en"] }, clock.now()));
  for (let i = 0; i < 3; i++) feedAt(clock, closeAt + 20500 + i * 100, () => mod._onPost({ text: "😂", langs: ["en"] }, clock.now()));
  await clock.advance(2000 + 20000 + 100);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.deepEqual(s.resolved, { nA: 7, nB: 4 });
  const counts = s.live.filter((x) => x.kind === "count");
  assert.ok(counts.length >= 38 && counts.length <= 42, `count ${counts.length}`);
  assert.deepEqual(counts[counts.length - 1], { kind: "count", a: 7, b: 4 });
  assert.ok(s.live.some((x) => x.kind === "item" && x.side === "a"));
  const ev = R.rebuild("emoji", p.input);
  assert.deepEqual(ev.markets.filter((m) => m.test(s.resolved)).map((m) => m.id), ["A"]);
  assert.deepEqual(ev.markets.filter((m) => m.test({ nA: 5, nB: 5 })).map((m) => m.id), ["tie"]);
});

test("emoji.begin: поток замолчал после закрытия → abort; cancel глушит всё", async () => {
  const clock = new Clock(BASE);
  const mod = bsky.create(mkDeps(clock));
  warmBsky(clock, mod);
  mod.prepare("emoji");
  const s = sink();
  mod.begin("emoji", { closeAt: clock.now() + 500, ...s.opts });
  await clock.advance(8000);
  assert.equal(s.done, "abort");
  const s2 = sink();
  const h = mod.begin("emoji", { closeAt: clock.now() + 500, ...s2.opts });
  h.cancel();
  await clock.advance(30000);
  assert.equal(s2.done, undefined, "после cancel ни resolve, ни abort");
});

// ================= lang и wikinext: случайный «стоп» 4–9 с =================
function langRun(rndFn, { stopLive = true, kept = null } = {}) {
  const clock = new Clock(BASE);
  const mod = bsky.create(mkDeps(clock, { rnd: rndFn }));
  mod._setConn(conn(clock)); mod._since(clock.t);
  const rr = mulberry(11);
  const langs = ["en", "ja", "pt", "es", "de", "xx"];
  pump(clock, 400_000, 50, (t) => { if (rr(100) < 40) mod._onPost({ text: "x", langs: [langs[rr(100) < 55 ? 0 : 1 + rr(5)]] }, t); });
  const p = mod.prepare("lang");
  return { clock, mod, p };
}

test("lang: стоп через 4–9 с от rnd, исход — реальный пост на этот момент; детерминизм при внедрённом rnd", async () => {
  const results = [];
  for (const rv of [0, 5000, 2500, 2500]) {
    const { clock, mod, p } = langRun((n) => (n === 5001 ? rv : 0));
    assert.ok(p && p.input.counts.en > 100 && p.input.counts.other > 0, JSON.stringify(p && p.input));
    const closeAt = clock.now() + 1000;
    const s = sink();
    mod.begin("lang", { closeAt, ...s.opts });
    // поток постов: язык меняется предсказуемо по времени, чтобы знать «реальный элемент»
    const seq = ["ja", "en", "de", "pt", "es", "en", "xx", "ja"];
    const ts = [];
    for (let o = 150; o < 12000; o += 150) {
      const lang = seq[(o / 150) % seq.length];
      ts.push([closeAt + o, lang]);
      feedAt(clock, closeAt + o, () => mod._onPost({ text: "post " + lang, langs: [lang] }, clock.now()));
    }
    await clock.advance(1000 + 12000);
    assert.equal(s.done, "resolve", String(s.aborted));
    const stopAt = closeAt + 4000 + rv;
    const first = ts.find(([t]) => t >= stopAt);
    const kept = new Set(Object.keys(p.input.counts).filter((k) => k !== "other" && p.input.counts[k] / Object.values(p.input.counts).reduce((a, b) => a + b) >= 0.03));
    assert.equal(s.resolved, kept.has(first[1]) ? first[1] : "other", `стоп +${4000 + rv} мс`);
    const iStop = s.live.findIndex((x) => x.kind === "stop");
    assert.ok(iStop > 0 && s.live[iStop - 1].kind === "reel", "stop идёт после последнего reel");
    assert.ok(s.live.filter((x) => x.kind === "reel").length > 10, "реальные элементы летят в барабан");
    assert.ok(s.live.every((x) => x.kind !== "stop" || x === s.live[iStop]));
    results.push(s.resolved);
    // исход — категория из рынков categorical
    const ev = R.rebuild("lang", p.input);
    assert.ok(ev.markets.some((m) => m.test(s.resolved)), "исход попадает в один из рынков");
  }
  assert.equal(results[2], results[3], "тот же rnd — тот же исход");
});

test("lang: нет постов после стопа → abort; нет данных → prepare null", async () => {
  const { clock, mod } = langRun(() => 0);
  const s = sink();
  mod.begin("lang", { closeAt: clock.now() + 1000, ...s.opts });
  await clock.advance(1000 + 12000);
  assert.equal(s.done, "abort");
  const c2 = new Clock(BASE), m2 = bsky.create(mkDeps(c2));
  m2._setConn(conn(c2)); m2._since(c2.t);
  assert.equal(m2.prepare("lang"), null);
  pump(c2, 120_000, 1000, (t) => m2._onPost({ langs: ["en"], text: "" }, t));
  assert.equal(m2.prepare("lang"), null, "мало постов (< 500)");
});

// ================= Wikimedia =================
const wch = (wikiName, title, extra = {}) => Object.assign({ type: "edit", wiki: wikiName, title, server_name: wikiName.replace(/wiki$/, ".wikipedia.org"), namespace: 0, bot: false }, extra);

function warmWiki(clock, mod, rr = mulberry(21), secs = 400) {
  mod._setSse({ isLive: () => true, stop() {} });
  mod._since(clock.t);
  pump(clock, secs * 1000, 100, (t) => {
    if (rr(1000) < 90) mod._onChange(wch("dewiki", "Berlin"), t);                       // 0,9/с
    if (rr(1000) < 80) mod._onChange(wch("frwiki", "Paris"), t);                        // 0,8/с
    if (rr(1000) < 60) mod._onChange(wch("ruwiki", "Москва"), t);                       // 0,6/с
    if (rr(1000) < 30) mod._onChange(wch("enwiki", "Some Football club"), t);           // футбол ≈ 0,3/с (слишком часто для порога)
    if (rr(1000) < 4) mod._onChange(wch("enwiki", "Cat breeds"), t);                   // ≈ 0,04/с
    if (rr(1000) < 3) mod._onChange(wch("dewiki", "Krieg um Kaffee"), t);              // «война» ≈ 0,03/с
    if (rr(1000) < 5) mod._onChange(wch("ruwiki", "Президент страны"), t);             // ≈ 0,05/с
    if (rr(1000) < 2) mod._onChange(wch("enwiki", "Bitcoin"), t);                      // ≈ 0,02/с
    if (rr(1000) < 40) mod._onChange({ type: "log", wiki: "enwiki", title: "log", server_name: "en.wikipedia.org", namespace: 0 }, t);   // журнал не считается
    if (rr(1000) < 20) mod._onChange(wch("wikidatawiki", "Q42", { server_name: "www.wikidata.org", namespace: 0 }), t);
    if (rr(1000) < 15) mod._onChange(wch("commonswiki", "File:A.jpg", { server_name: "commons.wikimedia.org", namespace: 6 }), t);
  });
}

test("wikiduel: prepare подбирает пару с |μ_d| ≤ 0,6σ_d; begin считает правки двух вики после closeAt; журналы игнорируются", async () => {
  const clock = new Clock(BASE);
  const mod = wiki.create(mkDeps(clock));
  assert.equal(mod.prepare("wikiduel"), null);
  warmWiki(clock, mod);
  const p = mod.prepare("wikiduel");
  assert.ok(p, "пара есть (de/fr/ru)");
  const { A, B } = p.meta.wikis;
  assert.ok(["dewiki", "frwiki", "ruwiki"].includes(A) && ["dewiki", "frwiki", "ruwiki"].includes(B) && A !== B);
  const muD = (p.input.lamA - p.input.lamB) * 20, sd = Math.sqrt(p.input.phi * (p.input.lamA + p.input.lamB) * 20);
  assert.ok(Math.abs(muD) <= 0.6 * sd);
  const closeAt = clock.now() + 1000;
  const s = sink();
  mod.begin("wikiduel", { closeAt, ...s.opts });
  for (let i = 0; i < 6; i++) feedAt(clock, closeAt + 500 + i * 3000, () => mod._onChange(wch(A, "Статья A" + i), clock.now()));
  for (let i = 0; i < 3; i++) feedAt(clock, closeAt + 800 + i * 5000, () => mod._onChange(wch(B, "Article B" + i), clock.now()));
  feedAt(clock, closeAt + 900, () => mod._onChange({ type: "log", wiki: A, title: "x", server_name: "x" }, clock.now()));
  feedAt(clock, closeAt - 100, () => mod._onChange(wch(A, "до"), clock.now()));
  feedAt(clock, closeAt + 20_500, () => mod._onChange(wch(A, "после"), clock.now()));
  await clock.advance(1000 + 20_100);
  assert.deepEqual(s.resolved, { nA: 6, nB: 3 });
  assert.ok(s.live.some((x) => x.kind === "item" && x.side === "a" && /Статья A/.test(x.text)));
});

test("wikiedit: темы с p в 15–85%, исход {id:count, first}; рынки live.thresholds", async () => {
  const clock = new Clock(BASE);
  const mod = wiki.create(mkDeps(clock));
  warmWiki(clock, mod);
  const p = mod.prepare("wikiedit");
  assert.ok(p, "тем хватает");
  assert.ok(p.input.kinds.length >= 2 && p.input.kinds.length <= 5);
  const ev = R.rebuild("wikiedit", p.input);
  assert.ok(ev.markets.length >= 2);
  for (const m of ev.markets) assert.ok(m.p >= 0.15 && m.p <= 0.85, `${m.id}: ${m.p}`);
  assert.ok(!p.input.kinds.some((k) => k.id === "football"), "слишком частая тема отсеяна (p > 85%)");
  const ids = p.input.kinds.map((k) => k.id);
  const closeAt = clock.now() + 1000;
  const s = sink();
  mod.begin("wikiedit", { closeAt, ...s.opts });
  feedAt(clock, closeAt + 3000, () => mod._onChange(wch("enwiki", "Cat toys"), clock.now()));
  feedAt(clock, closeAt + 9000, () => mod._onChange(wch("enwiki", "Cat food"), clock.now()));
  feedAt(clock, closeAt + 12000, () => mod._onChange(wch("enwiki", "Bitcoin price"), clock.now()));
  feedAt(clock, closeAt + 5000, () => mod._onChange(wch("enwiki", "Cat sandbox", { namespace: 2 }), clock.now()));   // не основное пространство
  await clock.advance(1000 + 20_100);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.equal(s.resolved.first, ids.includes("cat") ? "cat" : ids.includes("bitcoin") ? "bitcoin" : null);
  if (ids.includes("cat")) assert.equal(s.resolved.cat, 2);
  for (const id of ids) assert.equal(typeof s.resolved[id], "number");
  const win = ev.markets.filter((m) => m.test(s.resolved)).map((m) => m.id);
  if (ids.includes("cat")) assert.ok(win.includes("cat:ge1") && win.includes("cat:ge2"), win.join());
});

test("wikinext: проект следующей правки, стоп 4–9 с по rnd; прочие проекты → other", async () => {
  const clock = new Clock(BASE);
  const mod = wiki.create(mkDeps(clock, { rnd: (n) => (n === 5001 ? 1000 : 0) }));
  warmWiki(clock, mod);
  const p = mod.prepare("wikinext");
  assert.ok(p && p.input.counts.wikidata > 0 && p.input.counts.de > 0, JSON.stringify(p && p.input));
  const closeAt = clock.now() + 500;
  const s = sink();
  mod.begin("wikinext", { closeAt, ...s.opts });
  const seq = [["itwiki", "it.wikipedia.org"], ["dewiki", "de.wikipedia.org"], ["wikidatawiki", "www.wikidata.org"]];
  for (let o = 200; o < 9000; o += 200) {
    const [w, sv] = seq[(o / 200) % 3];
    feedAt(clock, closeAt + o, () => mod._onChange(wch(w, "T" + o, { server_name: sv }), clock.now()));
  }
  await clock.advance(500 + 9500);
  // стоп = closeAt + 5000: первая правка с t ≥ 5000 → o=5000: (5000/200)%3 = 25%3 = 1 → de
  assert.equal(s.resolved, "de");
  assert.ok(s.live.some((x) => x.kind === "stop"));
  const ev = R.rebuild("wikinext", p.input);
  assert.ok(ev.markets.some((m) => m.test(s.resolved)));
  assert.equal(wiki.nextCat("pl.wikipedia.org"), "other");
});

// ================= киты =================
test("whales: дубликаты по хешу не считаются, исход {w10..w500, first}; null в первые 10 минут", async () => {
  const clock = new Clock(BASE);
  const mod = whales.create(mkDeps(clock));
  mod._setConn(conn(clock)); mod._since(clock.t);
  const rr = mulberry(9);
  assert.equal(mod.prepare(), null);
  let h = 0;
  pump(clock, 700_000, 1000, (t) => {
    if (rr(100) < 30) mod._onTx({ hash: "a" + h++, out: [{ value: 12e8 }] }, t);          // ≥ 10 BTC примерно раз в 3 с
    if (rr(100) < 6) mod._onTx({ hash: "b" + h++, out: [{ value: 60e8 }] }, t);           // ≥ 50 BTC примерно раз в 17 с
    if (rr(100) < 1) mod._onTx({ hash: "c" + h++, out: [{ value: 120e8 }, { value: 1e8 }] }, t);   // ≥ 100 BTC
  });
  const p = mod.prepare();
  assert.ok(p, JSON.stringify(p));
  assert.ok(p.input.kinds.some((k) => k.id === "w100"));
  const ev = R.rebuild("whales", p.input);
  assert.ok(ev.markets.length >= 1 && ev.markets.every((m) => m.p >= 0.15 && m.p <= 0.85));
  const closeAt = clock.now() + 500;
  const s = sink();
  mod.begin("whales", { closeAt, ...s.opts });
  feedAt(clock, closeAt + 2000, () => mod._onTx({ hash: "x1", out: [{ value: 55e8 }] }, clock.now()));
  feedAt(clock, closeAt + 2100, () => mod._onTx({ hash: "x1", out: [{ value: 55e8 }] }, clock.now()));    // повтор
  feedAt(clock, closeAt + 8000, () => mod._onTx({ hash: "x2", out: [{ value: 130e8 }] }, clock.now()));
  feedAt(clock, closeAt - 200, () => mod._onTx({ hash: "x0", out: [{ value: 900e8 }] }, clock.now()));    // до закрытия
  await clock.advance(500 + 20_100);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.deepEqual(s.resolved, { first: "w10", w10: 2, w50: 2, w100: 1, w500: 0 });
  const win = ev.markets.filter((m) => m.test(s.resolved)).map((m) => m.id);
  assert.ok(win.every((id) => /ge[12]$/.test(id)));
  assert.ok(s.live.some((x) => x.kind === "item" && x.amount === 130));
  // ранний prepare
  const c2 = new Clock(BASE), m2 = whales.create(mkDeps(c2));
  m2._setConn(conn(c2)); m2._since(c2.t);
  pump(c2, 120_000, 1000, (t) => m2._onTx({ hash: "q" + t, out: [{ value: 20e8 }] }, t));
  assert.equal(m2.prepare(), null, "меньше 10 минут истории");
});

// ================= drand =================
const crypto = require("crypto");
function mkRound(r, seedByte = 1) {
  const sig = crypto.createHash("sha256").update("sig" + r + ":" + seedByte).digest("hex") + crypto.createHash("sha256").update("s2" + r).digest("hex").slice(0, 32);   // 96 hex
  return { round: r, signature: sig, randomness: drand.sha256hex(sig) };
}
// fetch по relay/chain/public/N: раунд доступен только после времени публикации
function drandFetch(clock, { down = [], bad = [], skew = [] } = {}) {
  return async (url) => {
    const m = /^(https:\/\/[^/]+)\/([0-9a-f]{64})\/public\/(latest|\d+)$/.exec(url);
    if (!m || m[2] !== drand.CHAIN) return notFound;
    const relay = m[1];
    if (down.includes(relay)) throw new Error("ECONNREFUSED");
    const r = m[3] === "latest" ? drand.roundAt(clock.now()) : Number(m[3]);
    if (drand.roundTime(r) > clock.now()) return notFound;
    const o = mkRound(r, skew.includes(relay) ? 2 : 1);
    if (bad.includes(relay)) o.randomness = "0".repeat(64);
    return okJson(o);
  };
}

test("drand: номер раунда — первый, опубликованный ≥ closeAt+3 с; границы", () => {
  const t100 = drand.roundTime(100);
  assert.equal(drand.targetRound(t100), 101);                     // ровно +3 с — подходит
  assert.equal(drand.targetRound(t100 + 1), 102);
  assert.equal(drand.targetRound(t100 - 2999), 101);
  assert.ok(drand.roundTime(drand.targetRound(t100 + 1234)) >= t100 + 1234 + 3000);
  assert.ok(drand.roundTime(drand.targetRound(t100 + 1234) - 1) < t100 + 1234 + 3000);
  assert.equal(drand.roundAt(drand.roundTime(55) + 2999), 55);
});

test("drand: реальные ответы трёх ретрансляторов (фикстура) проходят проверку sha256(signature) = randomness", () => {
  assert.equal(SAMPLES.drand.length, 3);
  for (const o of SAMPLES.drand) assert.ok(drand.validRound(o, o.round), o.relay);
  assert.ok(!drand.validRound({ ...SAMPLES.drand[0], randomness: "00".repeat(32) }, SAMPLES.drand[0].round));
  assert.ok(!drand.validRound(SAMPLES.drand[0], SAMPLES.drand[0].round + 1), "чужой номер раунда");
});

test("drand.begin: ждёт публикации раунда, берёт randomness, подтверждает вторым ретранслятором; hex идёт в рынки digit/even/quarter", async () => {
  const clock = new Clock(drand.roundTime(1000) + 500);
  const mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock) }));
  mod.start();
  await clock.advance(10);
  assert.ok(mod.prepare(), "после ping источник жив");
  const closeAt = clock.now();
  const s = sink();
  mod.begin("drand", { closeAt, ...s.opts });
  await clock.advance(2900);
  assert.equal(s.done, undefined, "раунд ещё не опубликован");
  await clock.advance(4000);
  const r = drand.targetRound(closeAt);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.equal(s.resolved, mkRound(r).randomness);
  assert.ok(drand.roundTime(r) >= closeAt + 3000);
  const last = s.live[s.live.length - 1];
  assert.deepEqual([last.kind, last.n, last.randomness], ["round", r, s.resolved]);
  const ev = R.rebuild("drand", {});
  const lastDigit = s.resolved.slice(-1);
  assert.ok(ev.markets.find((m) => m.id === "digit:" + lastDigit).test(s.resolved));
  assert.equal(ev.markets.filter((m) => m.group === "digit" && m.test(s.resolved)).length, 1);
  assert.match(mod.status().note, /подтверждено (двумя|тремя)/);
  mod.stop();
});

test("drand: падение первого ретранслятора не мешает; расхождение значений и все недоступны → abort", async () => {
  // первый лежит, второй отвечает
  let clock = new Clock(drand.roundTime(2000) + 100);
  let mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock, { down: ["https://api.drand.sh"] }) }));
  let s = sink();
  mod.begin("drand", { closeAt: clock.now(), ...s.opts });
  await clock.advance(10000);
  assert.equal(s.done, "resolve", String(s.aborted));
  // подпись не сходится с randomness (подмена) у первого → его ответ отвергнут, берём второй
  clock = new Clock(drand.roundTime(2000) + 100);
  mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock, { bad: ["https://api.drand.sh"] }) }));
  s = sink();
  mod.begin("drand", { closeAt: clock.now(), ...s.opts });
  await clock.advance(10000);
  assert.equal(s.done, "resolve");
  assert.ok(/^[0-9a-f]{64}$/.test(s.resolved));
  // оба валидны по sha256, но разные значения (разные подписи) → abort
  clock = new Clock(drand.roundTime(2000) + 100);
  mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock, { skew: ["https://drand.cloudflare.com"] }) }));
  s = sink();
  mod.begin("drand", { closeAt: clock.now(), ...s.opts });
  await clock.advance(10000);
  assert.equal(s.done, "abort", "ретрансляторы разошлись");
  // все недоступны → таймаут
  clock = new Clock(drand.roundTime(2000) + 100);
  mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock, { down: ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh"] }) }));
  s = sink();
  mod.begin("drand", { closeAt: clock.now(), ...s.opts });
  await clock.advance(13000);
  assert.equal(s.done, "abort");
  mod.start(); await clock.advance(50);
  assert.equal(mod.prepare(), null, "источник мёртв — слот заменяется");
  mod.stop();
});

// ================= новости =================
const rssXml = (items) => `<?xml version="1.0"?><rss><channel>${items.map((t, i) => `<item><title><![CDATA[${t}]]></title><guid>${t.slice(0, 30)}-${i}</guid><pubDate>Sun, 18 Oct 2026 14:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`;

test("news.classify: регион по словарю, неоднозначные → null, без совпадений → other", () => {
  assert.equal(news.classify("Biden meets Congress leaders on budget"), "us");
  assert.equal(news.classify("Putin says talks in Moscow progressing"), "ru");
  assert.equal(news.classify("Israeli strikes hit Gaza city"), "il");
  assert.equal(news.classify("Russia and Ukraine exchange prisoners"), null, "два региона — пропуск");
  assert.equal(news.classify("Floods hit southern Brazil"), "other");
  assert.equal(news.classify("Britain announces new rules"), "eu");
  assert.equal(news.classify("What is the US thinking"), "us");
  assert.equal(news.classify("Nothing about us here"), "other", "аббревиатура US — только заглавными");
});

test("news: реальные RSS (фикстура) разбираются, заголовки классифицируются", () => {
  for (const k of ["bbc", "aj"]) {
    const items = parseRss(SAMPLES.rss[k]);
    assert.ok(items.length >= 10, `${k}: ${items.length}`);
    assert.ok(items.every((i) => i.title && i.guid));
  }
});

test("news.begin: первый НОВЫЙ заголовок после закрытия; старые и неоднозначные пропускаются; нет нового за 45 с → abort", async () => {
  const clock = new Clock(BASE);
  const base = [];
  for (let i = 0; i < 24; i++) base.push(`Trump says item ${i}`, `Putin speaks about topic ${i}`, `Gaza update ${i}`, `Flood in Brazil ${i}`);
  let items = base.slice();
  const fetch = async (url) => okText(rssXml(items));
  const mod = news.create(mkDeps(clock, { fetch }));
  mod.start();
  await clock.advance(100);
  const p = mod.prepare();
  assert.ok(p && p.input.counts.us >= 20 && p.input.counts.other >= 20, JSON.stringify(p && p.input));
  assert.ok(R.rebuild("news", p.input).markets.length >= 3);
  const closeAt = clock.now() + 1000;
  const s = sink();
  mod.begin("news", { closeAt, ...s.opts });
  items = ["Brand new: Russia and Ukraine swap prisoners", ...items];    // неоднозначная — пропуск
  await clock.advance(1000 + 5000);
  assert.equal(s.done, undefined);
  items = ["Israeli forces move on Gaza city", ...items];
  await clock.advance(32000);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.equal(s.resolved, "il");
  assert.ok(s.live.some((x) => x.kind === "reel" && x.cat === "il" && /Gaza/.test(x.text)));
  // заголовки, опубликованные до закрытия (по pubDate), не считаются
  const c2 = new Clock(BASE);
  let it2 = base.slice();
  const xmlOld = (arr) => `<rss><channel>${arr.map((t, i) => `<item><title>${t}</title><guid>g${t}</guid><pubDate>${new Date(c2.now() - 600000).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`;
  const m2 = news.create(mkDeps(c2, { fetch: async () => okText(xmlOld(it2)) }));
  m2.start(); await c2.advance(100);
  const s2 = sink();
  m2.begin("news", { closeAt: c2.now() + 500, ...s2.opts });
  await c2.advance(1000);
  it2 = ["Old story about Beijing dated ten minutes ago", ...it2];
  await c2.advance(50_000);
  assert.equal(s2.done, "abort", "старая новость не считается, нового нет → таймаут и возврат");
  mod.stop(); m2.stop();
  const c3 = new Clock(BASE), m3 = news.create(mkDeps(c3, { fetch: async () => { throw new Error("down"); } }));
  m3.start(); await c3.advance(100);
  assert.equal(m3.prepare(), null, "лента недоступна");
});

// ================= молнии и аэропорт =================
test("lightning: окно после closeAt, прореженные точки масштабируются на total; без запаса по ожиданию prepare = null", async () => {
  const T0 = 1_790_200_000_000;
  const mkWin = (start, nA, nB, total) => {
    const pts = [];
    for (let i = 0; i < nA; i++) pts.push([((i + 0.5) / nA) * 20, -80 + (i % 11), 0]);       // севернее экватора
    for (let i = 0; i < nB; i++) pts.push([-((i + 0.5) / nB) * 20, -80 + (i % 11), 0]);
    return { start, end: start + 20000, total, pts };
  };
  const run = async (env) => {
    const clock = new Clock(T0);
    const all = [];
    for (let i = 0; i < 12; i++) all.push(mkWin(T0 - 20000 + i * 20000, 230, 220, 450));
    let after = null;
    const fetch = async (url) => {
      const since = Number(/since=(\d+)/.exec(url)[1]);
      const ready = all.filter((w) => w.end + 3000 <= clock.now() && w.start > since);   // порция готова через 3 с после конца
      if (after && after.start > since && after.end + 3000 <= clock.now()) ready.push(after);
      return okJson({ serverNow: clock.now(), wins: ready });
    };
    const mod = lightning.create(mkDeps(clock, { fetch, rnd: () => 0, env }));
    mod.start();
    await clock.advance(125_000);
    return { clock, mod, setAfter: (w) => { after = w; } };
  };
  // короткое ожидание (40 с): lag + 40 с не влезает → null; по умолчанию registry даёт 100 с
  const a = await run({ BETS_LIGHTNING_WAIT_MS: "40000" });
  assert.equal(a.mod.prepare(), null, "ожидание 40 с слишком короткое для порции GLM");
  a.mod.stop();
  const { clock, mod, setAfter } = await run({ BETS_LIGHTNING_WAIT_MS: "100000" });
  const p = mod.prepare();
  assert.ok(p, "с запасом по ожиданию — есть");
  assert.ok(Math.abs(p.input.lamA - 11.5) < 1.5, JSON.stringify(p.input));
  assert.deepEqual(p.meta.labels, { A: "Север", B: "Юг" });
  const closeAt = clock.now() + 1000;
  setAfter(mkWin(closeAt + 5000, 100, 50, 600));          // 100 из 150 точек на севере, масштаб 4 → 400 и 200
  const s = sink();
  mod.begin("lightning", { closeAt, ...s.opts });
  await clock.advance(1000 + 5000 + 20000 + 5000);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.equal(s.resolved.nA + s.resolved.nB, 600, "сумма = total окна");
  assert.ok(s.resolved.nA >= 380 && s.resolved.nA <= 400, `nA ${s.resolved.nA}`);   // разделитель — медиана, пара точек у линии уходит на юг
  mod.stop();
});

test("airport: честная заглушка — prepare null, begin abort", async () => {
  const clock = new Clock();
  const f = createFeed(mkDeps(clock, { env: { BETS_LIVE: "airport" } }));
  f.start();
  assert.equal(f.prepare("airport"), null);
  assert.equal(f.status().airport.ok, false);
  f.stop();
});

// ================= весь feed на реальных образцах потоков =================
const sseBody = (lines) => {
  const enc = new TextEncoder();
  let ctrl;
  const stream = new ReadableStream({ start(c) { ctrl = c; } });
  for (const l of lines) ctrl.enqueue(enc.encode(`event: message\ndata: ${l}\n\n`));
  return { ok: true, status: 200, body: stream, ctrl };
};

test("createFeed на живых образцах: разбор Binance/Coinbase/Jetstream/blockchain.info/recentchange; status; stop", async () => {
  MockWS.reset();
  const clock = new Clock(BASE);
  let sse = null;
  const fetch = async (url) => {
    if (/recentchange/.test(url)) { sse = sseBody(SAMPLES.wiki); return sse; }
    if (/drand|api2/.test(url)) return okJson(SAMPLES.drand[0]);
    if (/bbci|aljazeera/.test(url)) return okText(/bbci/.test(url) ? SAMPLES.rss.bbc : SAMPLES.rss.aj);
    return notFound;
  };
  const f = createFeed(mkDeps(clock, { env: { BETS_LIVE: "all" }, fetch }));
  f.start();
  await clock.advance(100);
  const sock = (re) => MockWS.all.filter((w) => re.test(w.url)).pop();
  const bin = sock(/binance/), bs = sock(/bsky/), bc = sock(/blockchain/);
  assert.ok(bin && bs && bc, "сокеты открыты");
  for (const w of [bin, bs, bc]) w.emit("open");
  assert.equal(bc.sent[0], JSON.stringify({ op: "unconfirmed_sub" }));
  for (const m of SAMPLES.binance) bin.emit("message", m);
  for (const m of SAMPLES.bluesky) bs.emit("message", m);
  for (const m of SAMPLES.blockchain) bc.emit("message", m);
  await clock.advance(500);
  const pm = f._mods.get("btc");
  assert.ok(pm._store.binance.ticks.BTC.length >= 1 && pm._store.binance.secs.ETH.size >= 1, "котировки разобраны");
  assert.ok(pm.latest("BTC", clock.now() + 1000, { maxAge: 1e9 }).price > 1000);
  assert.match(f.status().emoji.note, /постов 60/);
  assert.match(f.status().whales.note, /транзакций 12/);
  assert.ok(f.status().btc.ok && f.status().emoji.ok && f.status().wikiedit.ok, JSON.stringify(f.status().wikiedit));
  assert.match(f.status().wikiedit.note, /правок \d+/);
  // молчание: через 30 с без сообщений источники помечаются мёртвыми
  await clock.advance(30000);
  assert.equal(f.status().btc.ok, false);
  assert.equal(f.status().whales.ok, false);
  assert.equal(f.prepare("btc"), null);
  f.stop();
});

test("coinbase как запасной источник: после двух сбоев binance котировки идут из coinbase и помечены своим именем", async () => {
  MockWS.reset();
  const clock = new Clock(BASE);
  const mod = prices.create(mkDeps(clock));
  mod.start();
  await clock.advance(10);
  let w = MockWS.all[MockWS.all.length - 1];
  assert.match(w.url, /binance/);
  w.emit("error", new Error("451"));
  await clock.advance(3000);
  w = MockWS.all[MockWS.all.length - 1];
  w.emit("error", new Error("451"));
  await clock.advance(5000);
  w = MockWS.all[MockWS.all.length - 1];
  assert.match(w.url, /coinbase/, "переключились на запасной");
  w.emit("open");
  assert.equal(JSON.parse(w.sent[0]).channels[0], "ticker");
  for (const m of SAMPLES.coinbase) w.emit("message", m);
  assert.equal(mod.status().note, "coinbase");
  assert.ok(mod._store.coinbase.ticks.BTC.length >= 1);
  mod.stop();
});
