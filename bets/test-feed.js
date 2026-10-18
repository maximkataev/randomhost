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
  const g = new Game(mulberry(4), { intro: () => 0, prepareLive: () => ({ input: { sigma: 40 }, meta: {} }) });
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
  for (const [a, b, phi] of [["laugh", "heart", 1.4], ["dewiki", "frwiki", 1.4], ["frwiki", "ruwiki", 1.4]]) {
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

test("киты: пороговые рынки по λ за час: P(≥1 за 20 с) ≈ доле окон с китом (допуск 5 п.п.; φ=1,7)", () => {
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
  assert.equal(p.input.phi, 1.4);
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
// 5 реальных раундов quicknet с подписями (снято с api.drand.sh, сверено с drand.cloudflare.com) + ответ /info
const DR = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "fixtures", "drand-rounds.json"), "utf8"));
const DRB = new Map(DR.rounds.map((o) => [o.round, o]));
const R0 = DR.rounds[0].round;
// «подделка»: подпись другая (96 hex), randomness честно посчитан от неё — проходит sha256, но не BLS
const forge = (r) => {
  const sig = crypto.createHash("sha256").update("forged" + r).digest("hex") + crypto.createHash("sha256").update("f2" + r).digest("hex").slice(0, 32);
  return { round: r, signature: sig, randomness: drand.sha256hex(sig) };
};
// fetch по relay/chain/public/N и /info: раунд доступен только после времени публикации; доступны только раунды фикстуры
function drandFetch(clock, { down = [], bad = [], forged = [], info = DR.info } = {}) {
  return async (url) => {
    const m = /^(https:\/\/[^/]+)\/([0-9a-f]{64})\/(info|public\/(?:latest|\d+))$/.exec(url);
    if (!m || m[2] !== drand.CHAIN) return notFound;
    const relay = m[1];
    if (down.includes(relay)) throw new Error("ECONNREFUSED");
    if (m[3] === "info") return okJson(info);
    const q = m[3].slice(7);
    let r = q === "latest" ? Math.min(drand.roundAt(clock.now()), R0 + 4) : Number(q);
    if (drand.roundTime(r) > clock.now()) return notFound;
    let o = DRB.get(r);
    if (!o) return notFound;
    if (forged.includes(relay)) o = forge(r);
    o = { ...o };
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

test("drand: реальные раунды (фикстура) проходят BLS; испорченная подпись/рандомность/номер раунда — нет", () => {
  assert.equal(DR.rounds.length, 5);
  assert.equal(DR.info.public_key, drand.PUBLIC_KEY, "зашитый ключ = ключ из /info");
  for (const o of DR.rounds) {
    assert.ok(drand.verifySig(o.round, o.signature), "BLS " + o.round);
    assert.ok(drand.validRound(o, o.round), "validRound " + o.round);
  }
  for (const o of SAMPLES.drand) assert.ok(drand.validRound(o, o.round), o.relay);
  const o = DR.rounds[0], r = o.round;
  // randomness не от этой подписи
  assert.ok(!drand.validRound({ ...o, randomness: "00".repeat(32) }, r));
  // один бит подписи изменён (и randomness пересчитан, чтобы sha256 сошёлся) — BLS не проходит
  const flip = (hex) => hex.slice(0, 10) + ((parseInt(hex[10], 16) ^ 1).toString(16)) + hex.slice(11);
  const sig2 = flip(o.signature);
  assert.ok(!drand.verifySig(r, sig2));
  assert.ok(!drand.validRound({ round: r, signature: sig2, randomness: drand.sha256hex(sig2) }, r));
  // подмена номера раунда: ответ другого раунда, выданный за r (с переписанным полем round — как и без)
  const other = DR.rounds[1];
  assert.ok(!drand.validRound(other, r), "чужой номер раунда");
  assert.ok(!drand.validRound({ ...other, round: r }, r), "подпись чужого раунда с подставленным номером");
  assert.ok(!drand.verifySig(r + 1, o.signature));
  assert.ok(!drand.validRound(o, r + 1));
  // подделка целиком (валидный sha256, чужая подпись), мусор и не-hex
  assert.ok(!drand.validRound(forge(r), r));
  assert.ok(!drand.verifySig(r, "00".repeat(48)), "нулевая подпись");
  assert.ok(!drand.verifySig(r, "zz".repeat(48)));
  assert.ok(!drand.verifySig(r, o.signature.slice(2)), "обрезанная");
  assert.ok(!drand.verifySig(0, o.signature));
  assert.ok(!drand.verifySig(r, null));
});

test("drand.begin: ждёт публикации раунда, проверяет BLS, берёт randomness, подтверждает вторым ретранслятором; hex идёт в рынки digit/even/quarter", async () => {
  const clock = new Clock(drand.roundTime(R0 + 1) + 500);
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
  assert.equal(r, R0 + 3);
  assert.equal(s.done, "resolve", String(s.aborted));
  assert.equal(s.resolved, DRB.get(r).randomness);
  assert.ok(drand.roundTime(r) >= closeAt + 3000);
  const last = s.live[s.live.length - 1];
  assert.deepEqual([last.kind, last.n, last.randomness], ["round", r, s.resolved]);
  const ev = R.rebuild("drand", {});
  const lastDigit = s.resolved.slice(-1);
  assert.ok(ev.markets.find((m) => m.id === "digit:" + lastDigit).test(s.resolved));
  assert.equal(ev.markets.filter((m) => m.group === "digit" && m.test(s.resolved)).length, 1);
  assert.match(mod.status().note, /подтверждено (двумя|тремя)/);
  assert.match(mod.status().note, /BLS/);
  mod.stop();
});

async function runDrand(opts, extraDeps = {}, adv = 10000) {
  const clock = new Clock(drand.roundTime(R0 + 1) + 100);
  const mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock, opts), ...extraDeps }));
  const s = sink();
  mod.begin("drand", { closeAt: clock.now(), ...s.opts });
  await clock.advance(adv);
  return { clock, mod, s };
}

test("drand: падение/подделка одного ретранслятора не мешают; подделка у всех, расхождение, недоступность → abort", async () => {
  const ALL = ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh"];
  // первый лежит, остальные отвечают
  let x = await runDrand({ down: [ALL[0]] });
  assert.equal(x.s.done, "resolve", String(x.s.aborted));
  // у первого randomness не от подписи → его ответ отвергнут, берём остальные
  x = await runDrand({ bad: [ALL[0]] });
  assert.equal(x.s.done, "resolve");
  assert.equal(x.s.resolved, DRB.get(R0 + 3).randomness);
  // у первого подпись подделана (sha256 сходится, BLS нет) → отвергнут
  x = await runDrand({ forged: [ALL[0]] });
  assert.equal(x.s.done, "resolve");
  assert.equal(x.s.resolved, DRB.get(R0 + 3).randomness);
  // подделка у ВСЕХ ретрансляторов — «сойдёт» нельзя: abort, ставки возвращаются
  x = await runDrand({ forged: ALL }, {}, 13000);
  assert.equal(x.s.done, "abort");
  assert.match(String(x.s.aborted), /BLS/);
  // два валидных, но разных значения (недостижимо в жизни: проверка подменена) → abort «разошлись»
  x = await runDrand({ forged: [ALL[1]] }, { drandVerify: (o) => /^[0-9a-f]{96}$/.test(o.signature) });
  assert.equal(x.s.done, "abort", "ретрансляторы разошлись");
  assert.match(String(x.s.aborted), /разошлись/);
  // все недоступны → таймаут
  x = await runDrand({ down: ALL }, {}, 13000);
  assert.equal(x.s.done, "abort");
  x.mod.start(); await x.clock.advance(50);
  assert.equal(x.mod.prepare(), null, "источник мёртв — слот заменяется");
  x.mod.stop();
});

test("drand: сверка /info — совпадает: работает; ключ или параметры иные: событие выключено, лог, abort; нет ответа /info — не мешает", async () => {
  const logs = [];
  // совпадает
  let clock = new Clock(drand.roundTime(R0 + 1) + 100);
  let mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock), log: (m) => logs.push(m) }));
  mod.start(); await clock.advance(50);
  assert.ok(mod.prepare());
  mod.stop();
  assert.deepEqual(logs, []);
  // чужой публичный ключ
  clock = new Clock(drand.roundTime(R0 + 1) + 100);
  mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock, { info: { ...DR.info, public_key: "a" + DR.info.public_key.slice(1) } }), log: (m) => logs.push(m) }));
  mod.start(); await clock.advance(50);
  assert.equal(mod.prepare(), null, "ключ расходится — событие выключено");
  assert.equal(mod.status().ok, false);
  assert.match(mod.status().note, /public_key/);
  assert.ok(logs.some((m) => /drand/.test(m) && /public_key/.test(m)));
  const s = sink();
  mod.begin("drand", { closeAt: clock.now(), ...s.opts });
  await clock.advance(10000);
  assert.equal(s.done, "abort", "идущее событие тоже abort");
  // период другой
  clock = new Clock(drand.roundTime(R0 + 1) + 100);
  mod = drand.create(mkDeps(clock, { fetch: drandFetch(clock, { info: { ...DR.info, period: 30 } }) }));
  mod.start(); await clock.advance(50);
  assert.equal(mod.prepare(), null);
  // восстановление: через сутки /info снова верен
  let flip = true;
  clock = new Clock(drand.roundTime(R0 + 1) + 100);
  mod = drand.create(mkDeps(clock, { fetch: (u) => (/\/info$/.test(u) && flip ? drandFetch(clock, { info: { ...DR.info, schemeID: "pedersen-bls-chained" } })(u) : drandFetch(clock)(u)) }));
  mod.start(); await clock.advance(50);
  assert.equal(mod.prepare(), null);
  flip = false;
  await clock.advance(24 * 3600 * 1000 + 100);
  assert.ok(mod.prepare(), "через сутки сверка прошла — событие снова включено");
  mod.stop();
  // /info недоступен совсем — не повод выключать (подпись всё равно проверяется зашитым ключом)
  clock = new Clock(drand.roundTime(R0 + 1) + 100);
  const f2 = drandFetch(clock);
  mod = drand.create(mkDeps(clock, { fetch: (u) => (/\/info$/.test(u) ? notFound : f2(u)) }));
  mod.start(); await clock.advance(50);
  assert.ok(mod.prepare());
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

// ================= ✈ Аэропорт-дуэль: ADS-B (adsb.lol + adsb.fi) =================
const airportMod = require("./feed-airport");
const AGEN = require("./fixtures/gen-airport");
const ASYNTH = gz("airport-synth.json.gz");
const ALOL = JSON.parse(fs.readFileSync(path.join(FX, "airport-lol-lhr.json"), "utf8"));
const AFI = JSON.parse(fs.readFileSync(path.join(FX, "airport-fi-fra.json"), "utf8"));
const A_AP = airportMod.AIRPORTS;
const acJson = (lat, hexv, o) => Object.assign({ hex: hexv, lat, lon: 0, category: "A3" }, o);

test("airport/detect: реальные образцы (lol и fi) — один кадр взлётов не даёт, суда на земле запоминаются", () => {
  for (const [ap, r] of [["LHR", ALOL], ["FRA", AFI]]) {
    const st = new Map();
    const ev = airportMod.detect(ap, r, 1000, st);
    // по ground-пути (земля → набор) один кадр взлёта не даёт; «climb» допустим только для судна, реально набирающего высоту у земли
    assert.equal(ev.filter((e) => e.kind === "ground").length, 0, "в одном кадре земля→воздух не видна");
    for (const e of ev) { const a = (r.ac || r.aircraft).find((x) => x.hex === e.hex); assert.ok(a.baro_rate >= 700 && a.gs >= 110 && a.alt_baro < 2500, "climb только при крутом наборе"); }
    assert.ok([...st.values()].filter((x) => x.g).length >= 3, `${ap}: на земле запомнены`);
    // тот же кадр ещё раз — тоже ничего
    assert.equal(airportMod.detect(ap, r, 3400, st).length, 0, "тот же кадр повторно: дублей нет");
  }
});

test("airport/detect: ground→набор высоты = взлёт один раз; посадка, пролёт, вертолёт, чужая зона и дубль — нет", () => {
  const A = A_AP.LHR, lat = A.lat, st = new Map();
  const g = (hexv, extra) => acJson(lat, hexv, Object.assign({ lon: A.lon, alt_baro: "ground", gs: 5 }, extra));
  const air = (hexv, extra) => acJson(lat + 0.02, hexv, Object.assign({ lon: A.lon, alt_baro: 400, gs: 150, baro_rate: 2000 }, extra));
  // кадр 1: на земле стоят «взлетающий», «садящийся», вертолёт
  assert.equal(airportMod.detect("LHR", { ac: [g("t1"), g("l1", { gs: 60 }), g("h1", { category: "A7" })] }, 1000, st).length, 0);
  // кадр 2: взлетел; садящийся остался на земле; вертолёт «взлетел» (не считаем); пролёт на эшелоне; снижающийся на подходе; далёкий взлёт
  const ev = airportMod.detect("LHR", { ac: [
    air("t1", { flight: "BAW123 " }), g("l1", { gs: 30 }), air("h1", { category: "A7" }),
    air("o1", { alt_baro: 12000, baro_rate: 0, gs: 420 }), air("a1", { alt_baro: 1200, baro_rate: -700, gs: 140 }),
    acJson(lat + 0.5, "far", { lon: A.lon, alt_baro: 300, gs: 150, baro_rate: 2000 }),
  ] }, 3400, st);
  assert.deepEqual(ev.map((e) => [e.hex, e.flight, e.kind]), [["t1", "BAW123", "ground"]]);
  // повторный кадр: дубль не считается
  assert.equal(airportMod.detect("LHR", { ac: [air("t1", { alt_baro: 900 })] }, 5800, st).length, 0);
  // судно без координат и с мусорной высотой — тихо пропускается
  assert.equal(airportMod.detect("LHR", { ac: [{ hex: "zz" }, g("n1", { lat: undefined }), air("x", { alt_baro: "??" })] }, 8200, st).length, 0);
  // нет земли, но впервые увидели низко и круто в наборе — «climb»
  const c = airportMod.detect("LHR", { ac: [air("c1", { alt_baro: 700 })] }, 9000, st);
  assert.equal(c.length, 1); assert.equal(c[0].kind, "climb");
  // а медленный/пологий — нет
  assert.equal(airportMod.detect("LHR", { ac: [air("c2", { alt_baro: 700, baro_rate: 200 }), air("c3", { gs: 80 })] }, 9500, st).length, 0);
  // fi-формат ({aircraft})
  assert.equal(airportMod.detect("LHR", { aircraft: [g("f1")] }, 10000, st).length, 0);
});

// Стенд: createFeed поверх моков, ответы строятся из истины fixtures/airport-synth.json.gz
function airportRig({ fail = () => null, env = { BETS_LIVE: "airport" } } = {}) {
  const clock = new Clock();
  const t0 = clock.now();
  const reqs = [];
  const byLat = Object.entries(A_AP).map(([ap, a]) => [ap, a]);
  const fetch = async (url, o) => {
    reqs.push({ url, t: clock.now(), ua: o && o.headers && o.headers["User-Agent"] });
    const style = /adsb\.fi/.test(url) ? "fi" : "lol";
    const m = style === "fi" ? /lat\/([\d.-]+)\/lon\/([\d.-]+)\/dist/.exec(url) : /point\/([\d.-]+)\/([\d.-]+)\//.exec(url);
    const hit = byLat.find(([, a]) => Math.abs(a.lat - +m[1]) < 1e-6 && Math.abs(a.lon - +m[2]) < 1e-6);
    const bad = fail(clock.now() - t0, style, hit[0]);
    if (bad) return bad;
    return okJson(AGEN.snapshot(ASYNTH, hit[1], hit[0], (clock.now() - t0) / 1000, style));
  };
  const f = createFeed(mkDeps(clock, { env, fetch }));
  return { clock, f, reqs, t0, mod: () => f._mods.get("airport") };
}
const takeoffsIn = (ap, from, to) => ASYNTH.truth[ap].filter((e) => e.kind === "takeoff" && e.t0 + 40 > from && e.t0 + 40 <= to).length;

test("airport: опрос вежлив (≥5 с между запросами к adsb.lol и ≥2,4 с к adsb.fi, UA с адресом), оба источника чередуются, взлёты находятся без дублей", async () => {
  const rig = airportRig();
  rig.f.start();
  await rig.clock.advance(20 * 60 * 1000);
  const mod = rig.mod();
  for (const [host, gap] of [[/api\.adsb\.lol/, 5000], [/opendata\.adsb\.fi/, 2400]]) {
    const ts = rig.reqs.filter((r) => host.test(r.url)).map((r) => r.t);
    assert.ok(ts.length > 100, `${host}: ${ts.length} запросов`);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= gap, `${host}: зазор ${ts[i] - ts[i - 1]}`);
  }
  assert.ok(rig.reqs.every((r) => /randomhost\.online/.test(r.ua)), "User-Agent с адресом проекта");
  // сверка с истиной: окно 20 минут, у каждого аэропорта
  let truth = 0, found = 0;
  for (const ap of Object.keys(A_AP)) {
    const got = mod._hist.filter((e) => e.ap === ap);
    assert.equal(new Set(got.map((e) => e.hex)).size, got.length, `${ap}: дубли`);
    const tr = ASYNTH.truth[ap].filter((e) => e.kind === "takeoff" && e.t0 + 40 > 0 && e.t0 + 40 <= 20 * 60);
    truth += tr.length; found += got.length;
    const ids = new Set(tr.map((e) => e.hex));
    assert.ok(got.every((e) => ASYNTH.truth[ap].some((x) => x.hex === e.hex && x.kind === "takeoff")), `${ap}: ложные срабатывания на посадках/пролётах`);
    void ids;
  }
  assert.ok(truth > 120, `истина ${truth}`);
  assert.ok(found >= truth * 0.85 && found <= truth * 1.15, `найдено ${found} из ${truth}`);
  assert.ok(mod._total.ground > mod._total.climb, "основной путь — ground");
  assert.equal(rig.f.status().airport.ok, true);
  assert.match(rig.f.status().airport.note, /adsb\.lol\+adsb\.fi|adsb\.fi\+adsb\.lol/);
  rig.f.stop();
});

test("airport: prepare — null, пока источник не прогрет; потом пара с метками ✈ IATA, T=90, φ, |μ|≤0,6σ", async () => {
  const rig = airportRig();
  rig.f.start();
  await rig.clock.advance(2 * 60 * 1000);
  assert.equal(rig.f.prepare("airport"), null, "через 2 минуты оценка ещё не стоит");
  await rig.clock.advance(10 * 60 * 1000);
  const p = rig.f.prepare("airport");
  assert.ok(p, "через 12 минут пара готова");
  assert.equal(p.input.T, 90);
  assert.equal(p.input.phi, airportMod.PHI_AIRPORT);
  assert.ok(p.input.phi >= 1 && p.input.phi <= 1.3);
  assert.match(p.meta.labels.A, /^✈ [A-Z]{3}$/);
  assert.match(p.meta.labels.B, /^✈ [A-Z]{3}$/);
  assert.notEqual(p.meta.labels.A, p.meta.labels.B);
  assert.equal(p.meta.skin, `${p.meta.labels.A.slice(2)}-${p.meta.labels.B.slice(2)}`);
  const { lamA, lamB, T, phi } = p.input;
  assert.ok(lamA > 0.004 && lamA < 0.04 && lamB > 0.004 && lamB < 0.04, `λ ${lamA} ${lamB} (взлётов/с)`);
  const muD = (lamA - lamB) * T, sd = Math.sqrt(phi * (lamA + lamB) * T);
  assert.ok(Math.abs(muD) <= 0.6 * sd + 1e-9, "подбор пары по §10.2");
  const ev = live.duel(p.input);
  assert.ok(ev.markets.find((m) => m.id === "A") && ev.markets.find((m) => m.id === "B"));
  rig.f.stop();
});

test("airport: begin считает только взлёты после closeAt (90 с), шлёт count/item, resolve = истина окна", async () => {
  const rig = airportRig();
  rig.f.start();
  await rig.clock.advance(12 * 60 * 1000);
  const p = rig.f.prepare("airport");
  assert.ok(p);
  const [A, B] = [p.meta.labels.A.slice(2), p.meta.labels.B.slice(2)];
  await rig.clock.advance(20000);
  const closeAt = rig.clock.now(), c0 = (closeAt - rig.t0) / 1000;
  const s = sink();
  rig.f.begin("airport", { closeAt, skin: p.meta.skin, ...s.opts });
  await rig.clock.advance(90000 + 5000);
  assert.equal(s.done, "resolve", String(s.aborted));
  const wantA = takeoffsIn(A, c0, c0 + 90), wantB = takeoffsIn(B, c0, c0 + 90);
  // допуск ±1 на край окна: взлёт засчитывается в момент обнаружения (ответ опроса), а не момент отрыва
  assert.ok(Math.abs(s.resolved.nA - wantA) <= 1 && Math.abs(s.resolved.nB - wantB) <= 1, `${JSON.stringify(s.resolved)} vs ${wantA}/${wantB}`);
  const counts = s.live.filter((x) => x.kind === "count");
  assert.ok(counts.length >= 50, "счёт идёт раз в 1,5 с");
  const last = counts[counts.length - 1];
  assert.deepEqual([last.a, last.b], [s.resolved.nA, s.resolved.nB]);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i].a >= counts[i - 1].a && counts[i].b >= counts[i - 1].b, "счёт не убывает");
  const items = s.live.filter((x) => x.kind === "item");
  assert.equal(items.length > 0, s.resolved.nA + s.resolved.nB > 0);
  for (const it of items) assert.match(it.text, new RegExp(`^✈ (${A}|${B}) · \\S+$`));
  assert.equal(items.filter((x) => x.side === "a").every((x) => x.text.startsWith(`✈ ${A} `)), true);
  rig.f.stop();
});

test("airport: отказ одного источника (403) — работаем на втором; потеря обоих в окне — abort без вранья про ноль", async () => {
  // adsb.lol отдаёт отказ: остаётся adsb.fi
  const rig = airportRig({ fail: (t, style) => (style === "lol" ? { ok: false, status: 403, json: async () => ({}), text: async () => "" } : null) });
  rig.f.start();
  await rig.clock.advance(14 * 60 * 1000);
  assert.equal(rig.f.status().airport.ok, true);
  assert.match(rig.f.status().airport.note, /adsb\.fi/);
  assert.ok(rig.mod()._total.ground > 10, "взлёты считаются и на одном источнике");
  const lolReqs = rig.reqs.filter((r) => /adsb\.lol/.test(r.url)).length;
  assert.ok(lolReqs < 20, `отказавший источник не долбим: ${lolReqs}`);
  assert.ok(rig.f.prepare("airport"), "пара подобрана на одном источнике");
  // оба молчат с 13-й минуты 30 с: окно должно прерваться
  let dead = false;
  const rig2 = airportRig({ fail: () => (dead ? { ok: false, status: 503, json: async () => ({}), text: async () => "" } : null) });
  rig2.f.start();
  await rig2.clock.advance(12 * 60 * 1000);
  const p = rig2.f.prepare("airport");
  assert.ok(p);
  const closeAt = rig2.clock.now() + 1000;
  const s = sink();
  rig2.f.begin("airport", { closeAt, skin: p.meta.skin, ...s.opts });
  await rig2.clock.advance(30000);
  dead = true;
  await rig2.clock.advance(60000);
  assert.equal(s.done, "abort", "потеря источника → abort");
  assert.match(String(s.aborted), /ADS-B/);
  assert.equal(s.resolved, null);
  rig2.f.stop(); rig.f.stop();
});

test("airport: 429 от adsb.lol — источник отдыхает по Retry-After, дальше только adsb.fi", async () => {
  let lolHits = 0;
  const rig = airportRig({ fail: (t, style) => { if (style !== "lol") return null; lolHits++; return { ok: false, status: 429, headers: { get: () => "300" }, json: async () => ({}), text: async () => "" }; } });
  rig.f.start();
  await rig.clock.advance(4 * 60 * 1000);
  assert.equal(lolHits, 1, "после первого 429 — тишина на 300 с");
  assert.equal(rig.f.status().airport.ok, true);
  await rig.clock.advance(2 * 60 * 1000);
  assert.equal(lolHits, 2, "через 300 с пробуем снова");
  rig.f.stop();
});

test("airport: cancel до конца окна — тишина; без prepare begin → abort; выключенный тип → prepare null", async () => {
  const rig = airportRig();
  rig.f.start();
  await rig.clock.advance(12 * 60 * 1000);
  const p = rig.f.prepare("airport");
  const s = sink();
  const h = rig.f.begin("airport", { closeAt: rig.clock.now() + 1000, skin: p.meta.skin, ...s.opts });
  await rig.clock.advance(10000);
  h.cancel();
  await rig.clock.advance(120000);
  assert.equal(s.done, undefined);
  rig.f.stop();
  const off = airportRig({ env: { BETS_LIVE: "btc" } });
  assert.equal(off.f.prepare("airport"), null);
  const c2 = new Clock();
  const m2 = airportMod.create(mkDeps(c2));
  const s3 = sink();
  m2.begin("airport", { closeAt: c2.now(), skin: "xx", ...s3.opts });
  await c2.advance(10);
  assert.equal(s3.done, "abort");
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
