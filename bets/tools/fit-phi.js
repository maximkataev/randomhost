#!/usr/bin/env node
"use strict";

/*
 * Калибровка живых рынков «Ставок» по записи tools/record-feed.js (bets-spec.md §12, «Калибровка по записям»).
 *   node tools/fit-phi.js tools/records/feed-….jsonl.gz [--json out.json]
 *
 * Счётные рынки (duel, thresholds): окна по 20 с; в начале каждого окна λ оценивается тем же RateTracker,
 * что в адаптерах (EWMA, те же полураспады и «разогрев»), потом сравнивается с тем, что реально случилось
 * в окне. Для каждого φ ∈ [1,0 … 4,0] считаются лог-потери вероятностей из events/live.js и берётся минимум;
 * второй независимый способ — дисперсионный: φ̂ = среднее (N − λ̂T)² / (λ̂T) (λ̂ та же оценка, что у модели,
 * поэтому шум самой оценки λ входит в φ — это правильно: рынок видит именно λ̂).
 * Точечная оценка — по окнам с фазами 0,5,10,15 с (больше данных, но коррелированных), доверительный
 * интервал — блочный бутстрап по 100-секундным блокам времени (учитывает и общие всплески, и перекрытие).
 *
 * BTC: доли |ΔS| > zσ за 20 с против 2(1−Φ(z)), σ — оценка адаптера (estimateVol) на момент S0;
 * интервалы Уилсона по непересекающимся окнам. BTC–ETH: ρ̂ против выборочной, ортанты и «разрывы».
 */
const fs = require("fs");
const zlib = require("zlib");
const { RateTracker, duelOk } = require("../feed-util");
const live = require("../events/live");
const { Phi } = require("../mathx");
const { estimateVol } = require("../feed-prices");
const { PAIRS } = require("../feed-bsky");
const { WIKIS, TOPICS } = require("../feed-wiki");
const { LEVELS } = require("../feed-whales");

const T = 20;
const GRID = []; for (let p = 10; p <= 40; p += 1) GRID.push(p / 10);
const PHASES = [0, 5, 10, 15];
const BLOCK = 100;                       // с, блок бутстрапа
const NBOOT = 400;

const argv = process.argv.slice(2);
const file = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--json", "--ltg"].includes(argv[i - 1])));
const ltgFile = argv.includes("--ltg") ? argv[argv.indexOf("--ltg") + 1] : null;
const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
if (!file) { console.error("usage: fit-phi.js <record.jsonl.gz> [--json out]"); process.exit(1); }

// ---- чтение (терпим обрезанный gzip) ----
const raw = zlib.gunzipSync(fs.readFileSync(file), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
const bsky = new Map(), wiki = new Map(), px = new Map(), tx = [];
let tMin = Infinity, tMax = 0, meta = [];
for (const line of raw.split("\n")) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch (e) { continue; }
  if (o.k === "bsky") bsky.set(o.s, o); else if (o.k === "wiki") wiki.set(o.s, o);
  else if (o.k === "px") px.set(o.s, o); else if (o.k === "tx") tx.push(o); else if (o.k === "meta") meta.push(o);
  const s = o.s || (o.t ? Math.floor(o.t / 1000) : 0);
  if (s && o.k !== "meta") { if (s < tMin) tMin = s; if (s > tMax) tMax = s; }
}
const start = meta.find((m) => m.ev === "start");
const t0 = start ? Math.floor(start.t / 1000) : tMin;
const t1 = tMax - 1;                      // последняя полная секунда
const NSEC = t1 - t0 + 1;
console.log(`файл ${file}\nсекунд записи ${NSEC} (${(NSEC / 60).toFixed(1)} мин); bsky-секунд ${bsky.size}, wiki ${wiki.size}, px ${px.size}, tx ${tx.length}`);

// ---- посекундные ряды ----
function series(map, pick) { const a = new Float64Array(NSEC); for (let i = 0; i < NSEC; i++) { const o = map.get(t0 + i); a[i] = o ? pick(o) : 0; } return a; }
const S = {};                              // ключ потока → Float64Array по секундам
for (const k of Object.keys(require("../feed-bsky").M)) S["bsky:" + k] = series(bsky, (o) => (o.c && o.c[k]) || 0);
for (const w of Object.keys(WIKIS)) S["wiki:" + w] = series(wiki, (o) => (o.w && o.w[w]) || 0);
for (const [id] of TOPICS) S["topic:" + id] = series(wiki, (o) => (o.t && o.t[id]) || 0);
S["bsky:all"] = series(bsky, (o) => o.n); S["wiki:all"] = series(wiki, (o) => o.n);
const WH_LEVELS = [1, 2, 5, ...LEVELS];    // 1/2/5 BTC — для оценки φ самого потока (редкие уровни дают мало данных)
for (const l of WH_LEVELS) { const a = new Float64Array(NSEC); for (const x of tx) if (x.btc >= l) { const i = Math.floor(x.t / 1000) - t0; if (i >= 0 && i < NSEC) a[i]++; } S["tx:" + l] = a; }
const prefix = {}; for (const k of Object.keys(S)) { const p = new Float64Array(NSEC + 1); for (let i = 0; i < NSEC; i++) p[i + 1] = p[i] + S[k][i]; prefix[k] = p; }
const cnt = (k, a, b) => prefix[k][b] - prefix[k][a];                // [a,b) секунды от t0

// λ̂ на момент i (секунда i — первая секунда окна), точно как RateTracker.rate: метки в середине секунды
function rateAt(k, i, { windowMs = 300000, halfMs = 90000 } = {}) {
  const now = (i) * 1000;                                            // граница окна = начало секунды i
  const W = Math.min(windowMs, now) / 1000;
  if (W <= 0) return 0;
  const kk = Math.LN2 / (halfMs / 1000);
  let num = 0;
  const lo = Math.max(0, i - Math.ceil(W));
  for (let j = i - 1; j >= lo; j--) {
    const age = (now - (j * 1000 + 500)) / 1000;
    if (age > W) break;
    num += S[k][j] * Math.exp(-kk * age);
  }
  return num / ((1 - Math.exp(-kk * W)) / kk);
}

// ---- статистика ----
const clip = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
function bootstrapCI(items, stat) {            // items: {blk, ...}; stat(items) → число
  const blocks = new Map();
  for (const it of items) { if (!blocks.has(it.blk)) blocks.set(it.blk, []); blocks.get(it.blk).push(it); }
  const ids = [...blocks.keys()];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const out = [];
  for (let b = 0; b < NBOOT; b++) {
    const s = [];
    for (let i = 0; i < ids.length; i++) for (const it of blocks.get(ids[Math.floor(rnd() * ids.length)])) s.push(it);
    const v = stat(s);
    if (Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out.length ? [out[Math.floor(out.length * 0.05)], out[Math.floor(out.length * 0.95)]] : [NaN, NaN];
}
const argminPhi = (loss) => { let best = 0; for (let i = 1; i < loss.length; i++) if (loss[i] < loss[best]) best = i; return GRID[best]; };
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—");

// ---- дуэли: каждый элемент = одна пара в одном окне ----
function duelItems(pairs, { warm = 90, minTotal, phiFilter, rateOpts, wide = false }) {
  const items = [];
  for (const ph of PHASES) {
    for (let i = warm + ph; i + T <= NSEC; i += T) {
      for (const [a, b] of pairs) {
        const la = rateAt(a, i, rateOpts), lb = rateAt(b, i, rateOpts);
        if (!duelOk(la, lb, T, phiFilter, wide ? { minTotal, maxRatio: 1e9, mu: 1e9 } : { minTotal })) continue;
        const nA = cnt(a, i, i + T), nB = cnt(b, i, i + T);
        items.push({ blk: Math.floor(i / BLOCK), ph, la, lb, nA, nB, pair: a + "/" + b, t: i });
      }
    }
  }
  return items;
}
function evalDuel(name, items, phiNow) {
  if (!items.length) { console.log(`\n== ${name}: нет окон`); return null; }
  const probs = (it, phi) => live.duelProbs(it.la, it.lb, T, phi);
  const lossAt = (set) => GRID.map((phi) => {
    let s = 0;
    for (const it of set) { const p = probs(it, phi); const o = it.nA > it.nB ? p.pA : it.nB > it.nA ? p.pB : p.tie; s -= Math.log(clip(o)); }
    return s / set.length;
  });
  const disp = (set) => {
    let s = 0, n = 0;
    for (const it of set) for (const [N, l] of [[it.nA, it.la], [it.nB, it.lb]]) { s += (N - l * T) ** 2 / (l * T); n++; }
    return s / n;
  };
  const loss = lossAt(items);
  const best = argminPhi(loss);
  // CI минимума лог-потерь: дорого (экспо) — считаем на 120 бутстрэпах по сетке 0,2
  const coarse = GRID.filter((_, i) => i % 2 === 0);
  const idxs = coarse.map((g) => GRID.indexOf(g));
  const cache = items.map((it) => GRID.map((phi, gi) => { if (!idxs.includes(gi)) return null; const p = probs(it, phi); return -Math.log(clip(it.nA > it.nB ? p.pA : it.nB > it.nA ? p.pB : p.tie)); }));
  items.forEach((it, i) => { it.c = cache[i]; });
  const bestOf = (set) => { let bi = -1, bv = Infinity; for (const gi of idxs) { let s = 0; for (const it of set) s += it.c[gi]; if (s < bv) { bv = s; bi = gi; } } return GRID[bi]; };
  const ciLL = bootstrapCI(items, bestOf);
  const dispPoint = disp(items), ciD = bootstrapCI(items, disp);
  const nWin = new Set(items.map((x) => x.ph + ":" + x.t)).size;
  const nonOv = items.filter((x) => x.ph === 0);
  // откалибровано ли «ничья»: предсказанная и наблюдаемая доли, при текущем φ и при лучшем
  const calib = (phi) => { let pt = 0, ot = 0, pa = 0, oa = 0; for (const it of items) { const p = probs(it, phi); pt += p.tie; ot += it.nA === it.nB ? 1 : 0; pa += p.pA + p.pB; oa += it.nA !== it.nB ? 1 : 0; } return { tie: [pt / items.length, ot / items.length] }; };
  const cNow = calib(phiNow), cBest = calib(best);
  console.log(`\n== ${name}: пар-окон ${items.length} (из них непересекающихся, фаза 0: ${nonOv.length}), блоков по ${BLOCK} с: ${new Set(items.map((x) => x.blk)).size}`);
  console.log(`   средний счёт стороны за 20 с: ${f2(items.reduce((s, x) => s + x.nA + x.nB, 0) / items.length / 2)}`);
  console.log(`   лог-потери: φ=1,0 ${f3(loss[0])} | φ=${phiNow} ${f3(loss[GRID.indexOf(phiNow)] ?? NaN)} | лучшая φ=${best} ${f3(Math.min(...loss))}`);
  console.log(`   φ по лог-потерям: ${best} (90% ИИ ${ciLL.map(f2).join("…")}); φ по дисперсии: ${f2(dispPoint)} (90% ИИ ${ciD.map(f2).join("…")})`);
  console.log(`   доля ничьих: модель(φ=${phiNow}) ${f3(cNow.tie[0])}, модель(φ=${best}) ${f3(cBest.tie[0])}, факт ${f3(cNow.tie[1])}`);
  return { name, n: items.length, nonOverlap: nonOv.length, phiLL: best, ciLL, phiDisp: dispPoint, ciDisp: ciD, lossNow: loss[GRID.indexOf(phiNow)], lossBest: Math.min(...loss), loss1: loss[0] };
}

const results = [];
// ---- 1. эмодзи-пары ----
{
  const pairs = PAIRS.map((p) => ["bsky:" + p.a, "bsky:" + p.b]);
  const items = duelItems(pairs, { minTotal: 10, phiFilter: 1.6 });
  results.push(evalDuel("duel: эмодзи (Bluesky), фильтр как в feed-bsky (minTotal 10)", items, 1.6));
  const perPair = {};
  for (const it of items) (perPair[it.pair] = perPair[it.pair] || []).push(it);
  for (const [pair, set] of Object.entries(perPair)) if (set.length >= 20) {
    let s = 0, n = 0; for (const it of set) for (const [N, l] of [[it.nA, it.la], [it.nB, it.lb]]) { s += (N - l * T) ** 2 / (l * T); n++; }
    console.log(`   · ${pair.replace(/bsky:/g, "")}: окон ${set.length}, φ по дисперсии ${f2(s / n)}, средний счёт ${f2(set.reduce((a, x) => a + x.nA + x.nB, 0) / set.length / 2)}`);
  }
  const wideItems = duelItems(pairs, { minTotal: 4, phiFilter: 1.6, wide: true });
  results.push(evalDuel("duel: эмодзи, ШИРОКИЙ отбор (любые соотношения, сумма ≥ 4) — для оценки φ потоков", wideItems, 1.6));
  // отдельно тяжёлые пары (большие счёты) и «все возможные» без фильтра
  const bigItems = duelItems(pairs, { minTotal: 10, phiFilter: 1.6 }).filter((x) => (x.nA + x.nB) / 2 >= 8);
  if (bigItems.length >= 30) results.push(evalDuel("duel: эмодзи, только счёт стороны ≥ 8", bigItems, 1.6));
  // для сравнения: общий поток постов (φ всего потока, без фильтра)
  const all = []; for (const ph of PHASES) for (let i = 90 + ph; i + T <= NSEC; i += T) { const l = rateAt("bsky:all", i); const n = cnt("bsky:all", i, i + T); all.push({ blk: Math.floor(i / BLOCK), l, n }); }
  const d = all.reduce((s, x) => s + (x.n - x.l * T) ** 2 / (x.l * T), 0) / all.length;
  console.log(`   общий поток постов: λ≈${f2(all.reduce((s, x) => s + x.l, 0) / all.length)}/с, φ по дисперсии ${f2(d)} (окон ${all.length})`);
}
// ---- 2. Wikidata/правки между проектами ----
{
  const names = Object.keys(WIKIS), pairs = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) pairs.push(["wiki:" + names[i], "wiki:" + names[j]]);
  const items = duelItems(pairs, { minTotal: 16, phiFilter: 1.8 });
  results.push(evalDuel("duel: wikiduel (recentchange), фильтр как в feed-wiki (minTotal 16)", items, 1.8));
  {
    const isBot = (it) => /wikidatawiki|commonswiki/.test(it.pair);
    results.push(evalDuel("duel: wikiduel, только пары БЕЗ Wikidata/Commons", items.filter((x) => !isBot(x)), 1.8));
    const withBot = items.filter(isBot);
    if (withBot.length >= 20) results.push(evalDuel("duel: wikiduel, только пары С Wikidata/Commons (боты, всплески)", withBot, 1.8));
  }
  { const perPair = {}; for (const it of items) (perPair[it.pair] = perPair[it.pair] || []).push(it); console.log("   пары, прошедшие фильтр: " + Object.entries(perPair).sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([k, v]) => `${k.replace(/wiki:/g, "")}×${v.length}`).join(", ")); }
  const wideW = duelItems(pairs, { minTotal: 16, phiFilter: 1.8, wide: true });
  results.push(evalDuel("duel: wikiduel, ШИРОКИЙ отбор (любые соотношения, сумма ≥ 16)", wideW, 1.8));
  const allw = []; for (const ph of PHASES) for (let i = 90 + ph; i + T <= NSEC; i += T) { const l = rateAt("wiki:all", i); const n = cnt("wiki:all", i, i + T); allw.push((n - l * T) ** 2 / (l * T)); }
  console.log(`   общий поток правок: φ по дисперсии ${f2(allw.reduce((a, b) => a + b, 0) / allw.length)} (окон ${allw.length})`);
}

// ---- пороги: каждый элемент = один рынок (вид, k) в одном окне ----
function thresholdItems(keys, { warm, rateOpts, phiFilter, ks = [1, 2], pMin = 0.15, pMax = 0.85, levelOf }) {
  const items = [];
  for (const ph of PHASES) {
    for (let i = warm + ph; i + T <= NSEC; i += T) {
      for (const key of keys) {
        const lam = rateAt(key, i, rateOpts);
        if (!(lam > 0)) continue;
        const ev = live.thresholds([{ id: "x", lam }], { T, phi: phiFilter, ks });
        const n = cnt(key, i, i + T);
        for (const k of ks) if (ev.markets.some((m) => m.id === `x:ge${k}`)) items.push({ blk: Math.floor(i / BLOCK), key, lam, k, y: n >= k ? 1 : 0, n, t: i, ph });
      }
    }
  }
  return items;
}
function evalThr(name, items, phiNow) {
  if (!items.length) { console.log(`\n== ${name}: нет рынков в диапазоне 15–85%`); return null; }
  const pAt = (it, phi) => { const m = it.lam * T; const { countPmf, countSupport } = require("../mathx"); const pm = countPmf(m, phi, countSupport(m, phi)); let c = 0; for (let j = 0; j < it.k; j++) c += pm[j]; return 1 - c; };
  const cacheIdx = GRID.map((_, i) => i);
  for (const it of items) it.c = cacheIdx.map((gi) => { const p = clip(pAt(it, GRID[gi])); return -Math.log(it.y ? p : 1 - p); });
  const lossOf = (set) => GRID.map((_, gi) => set.reduce((s, it) => s + it.c[gi], 0) / set.length);
  const loss = lossOf(items), best = argminPhi(loss);
  const bestOf = (set) => argminPhi(lossOf(set));
  const ci = bootstrapCI(items, bestOf);
  const pn = items.reduce((s, it) => s + pAt(it, phiNow), 0) / items.length, pb = items.reduce((s, it) => s + pAt(it, best), 0) / items.length, ob = items.reduce((s, it) => s + it.y, 0) / items.length;
  console.log(`\n== ${name}: рынков-окон ${items.length} (фаза 0: ${items.filter((x) => x.ph === 0).length}), видов ${new Set(items.map((x) => x.key)).size}`);
  console.log(`   лог-потери: φ=1,0 ${f3(loss[0])} | φ=${phiNow} ${f3(loss[GRID.indexOf(phiNow)] ?? NaN)} | лучшая φ=${best} ${f3(Math.min(...loss))}; φ по лог-потерям ${best} (90% ИИ ${ci.map(f2).join("…")})`);
  console.log(`   средняя P модели (φ=${phiNow}) ${f3(pn)}, (φ=${best}) ${f3(pb)}, наблюдаемая частота ${f3(ob)}`);
  return { name, n: items.length, nonOverlap: items.filter((x) => x.ph === 0).length, phiLL: best, ciLL: ci, lossNow: loss[GRID.indexOf(phiNow)], lossBest: Math.min(...loss), loss1: loss[0], pNow: pn, obs: ob };
}
function dispersionOf(keys, warm, rateOpts, minMean = 0.3) {
  let s = 0, n = 0, m = 0;
  for (const ph of PHASES) for (let i = warm + ph; i + T <= NSEC; i += T) for (const k of keys) { const l = rateAt(k, i, rateOpts); if (l * T < minMean) continue; const c = cnt(k, i, i + T); s += (c - l * T) ** 2 / (l * T); n++; m += l * T; }
  return { phi: n ? s / n : NaN, n, meanCount: n ? m / n : NaN };
}
// ---- 2b. φ по каждому потоку отдельно (дисперсионная оценка, окна с ожидаемым счётом ≥ 2) ----
{
  console.log("\n== φ по отдельным потокам (дисперсия (N−λ̂T)²/(λ̂T), окна с λ̂T ≥ 2, фазы 0/5/10/15 с):");
  const row = (title, keys, label) => {
    const out = [];
    for (const k of keys) { const d = dispersionOf([k], 90, {}, 2); if (d.n >= 20) out.push(`${label(k)}: φ=${f2(d.phi)} (n=${d.n}, счёт ${f2(d.meanCount)})`); }
    console.log(`   ${title}: ${out.join("; ") || "нет"}`);
  };
  row("emoji", Object.keys(require("../feed-bsky").M).map((k) => "bsky:" + k), (k) => k.slice(5));
  row("wiki", Object.keys(WIKIS).map((k) => "wiki:" + k), (k) => k.slice(5));
}
// ---- 3. wikiedit ----
{
  const keys = TOPICS.map(([id]) => "topic:" + id);
  const ro = { windowMs: 30 * 60 * 1000, halfMs: 900000 };
  const items = thresholdItems(keys, { warm: 300, rateOpts: ro, phiFilter: 1.5 });
  results.push(evalThr("thresholds: wikiedit (темы, k=1,2, рынки 15–85%)", items, 1.5));
  const d = dispersionOf(keys, 300, ro, 0.3);
  console.log(`   φ по дисперсии (темы с ожидаемым счётом ≥ 0,3 за окно, n=${d.n}, средний счёт ${f2(d.meanCount)}): ${f2(d.phi)}`);
}
// ---- 4. whales ----
{
  const ro = { windowMs: 3600000, halfMs: 1800000 };
  const keysAll = WH_LEVELS.map((l) => "tx:" + l);
  const items = thresholdItems(keysAll, { warm: 600, rateOpts: ro, phiFilter: 1.2 });
  results.push(evalThr("thresholds: whales (уровни 1/2/5/10/50/100/500 BTC, k=1,2, 15–85%)", items, 1.2));
  const itemsProd = items.filter((x) => LEVELS.includes(Number(x.key.slice(3))));
  results.push(evalThr("thresholds: whales, только боевые уровни 10/50/100/500 BTC", itemsProd, 1.2));
  for (const l of WH_LEVELS) {
    const tot = tx.filter((x) => x.btc >= l).length;
    const d = dispersionOf(["tx:" + l], 600, ro, 0.05);
    console.log(`   · ≥${l} BTC: транзакций ${tot} за запись, φ по дисперсии ${f2(d.phi)} (окон ${d.n}, средний счёт ${f2(d.meanCount)})`);
  }
}

// ---- 5. BTC: калибровка σ ----
{
  const A = new Array(NSEC).fill(NaN), B = new Array(NSEC).fill(NaN);
  let la = NaN, lb = NaN, ta = -99, tb = -99;
  for (let i = 0; i < NSEC; i++) {
    const o = px.get(t0 + i);
    if (o && o.BTC) { la = o.BTC; ta = i; } if (o && o.ETH) { lb = o.ETH; tb = i; }
    if (i - ta <= 5) A[i] = la; if (i - tb <= 5) B[i] = lb;     // как grid() адаптера: протяжка вперёд не дальше 5 с
  }
  const valid = A.filter(Number.isFinite).length;
  console.log(`\n== BTC/ETH: секунд с ценой BTC ${valid}/${NSEC}, ETH ${B.filter(Number.isFinite).length}`);
  const rows = [];
  for (let i = 400; i + T < NSEC; i += 5) {      // шаг 5 с; непересекающиеся — каждое 4-е (оценке нужно ≥ 300 валидных секунд)
    const est = estimateVol(A.slice(Math.max(0, i - 11000), i + 1), B.slice(Math.max(0, i - 11000), i + 1));
    if (!est || !Number.isFinite(A[i]) || !Number.isFinite(A[i + T]) || !Number.isFinite(B[i]) || !Number.isFinite(B[i + T])) continue;
    const sB = est.sA * Math.sqrt(T), sE = est.sB * Math.sqrt(T);
    const rB = A[i + T] / A[i] - 1, rE = B[i + T] / B[i] - 1;
    rows.push({ i, sB, sE, rho: est.rho, rB, rE, zB: rB / sB, zE: rE / sE, no: (i - 400) % 20 === 0 });
  }
  const no = rows.filter((r) => r.no);
  console.log(`   окон: всего (шаг 5 с, зависимые) ${rows.length}, непересекающихся ${no.length}`);
  const wilson = (k, n, z = 1.645) => { const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - h) / d, (c + h) / d]; };
  const out = { btc: [], rho: {} };
  console.log(`   z-сетка: доля |ΔS|>zσ  (модель 2(1−Φ(z))) / факт [90% Уилсон, непересекающиеся окна] / факт по всем окнам`);
  for (const z of [0.5, 1, 1.5, 2]) {
    const pm = 2 * (1 - Phi(z));
    const k = no.filter((r) => Math.abs(r.zB) > z).length, ka = rows.filter((r) => Math.abs(r.zB) > z).length;
    const [lo, hi] = wilson(k, no.length);
    console.log(`     z=${z}: модель ${f3(pm)}  факт ${f3(k / no.length)} [${f3(lo)}…${f3(hi)}] (${k}/${no.length})  по всем ${f3(ka / rows.length)}`);
    out.btc.push({ z, model: pm, obs: k / no.length, lo, hi, k, n: no.length });
  }
  const up = no.filter((r) => r.rB > 0).length, dn = no.filter((r) => r.rB < 0).length;
  console.log(`   вверх/вниз/без изменения: ${up}/${dn}/${no.length - up - dn} (модель: 0,5/0,5)`);
  const varz = (set, f) => set.reduce((s, r) => s + f(r) ** 2, 0) / set.length;
  const vz = varz(no, (r) => r.zB), vza = varz(rows, (r) => r.zB);
  // 90% ИИ дисперсии z: бутстрап по блокам
  const ci = bootstrapCI(rows.map((r) => Object.assign({ blk: Math.floor(r.i / BLOCK) }, r)), (s) => varz(s, (r) => r.zB));
  console.log(`   Var(z) = E[(ΔS/σ)²]: непересекающиеся ${f2(vz)}, все окна ${f2(vza)} (90% ИИ блочный бутстрап ${ci.map(f2).join("…")}); модель 1,00 → σ завышена/занижена в √Var раз: ${f2(Math.sqrt(vza))}`);
  out.varZ = { nonOverlap: vz, all: vza, ci };
  // BTC-ETH
  const n2 = no.length;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rhoPred = mean(no.map((r) => r.rho));
  const zEs = no.map((r) => r.zE);
  const vze = varz(rows, (r) => r.zE);
  const cor = (a, b) => { const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let k = 0; k < a.length; k++) { sab += (a[k] - ma) * (b[k] - mb); saa += (a[k] - ma) ** 2; sbb += (b[k] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
  const rhoReal = cor(rows.map((r) => r.rB), rows.map((r) => r.rE)), rhoRealNo = cor(no.map((r) => r.rB), no.map((r) => r.rE));
  const rhoRealZ = cor(rows.map((r) => r.zB), rows.map((r) => r.zE));
  const ciRho = bootstrapCI(rows.map((r) => Object.assign({ blk: Math.floor(r.i / BLOCK) }, r)), (s) => cor(s.map((r) => r.rB), s.map((r) => r.rE)));
  console.log(`   BTC–ETH: ρ̂ адаптера (среднее) ${f3(rhoPred)}; выборочная корреляция 20-с приращений: все окна ${f3(rhoReal)} (90% ИИ ${ciRho.map(f3).join("…")}), непересекающиеся ${f3(rhoRealNo)}, по z-нормированным ${f3(rhoRealZ)}; Var(zE) = ${f2(vze)}`);
  const orth = { bothUp: 0, bothDown: 0, mixed: 0, zero: 0 }, pr = { bothUp: 0, bothDown: 0, mixed: 0 };
  const gapObs = { 0.5: 0, 1: 0, 1.5: 0 }, gapPred = { 0.5: 0, 1: 0, 1.5: 0 };
  let nz = 0, nG = 0;
  for (const r of no) {
    const rho = Math.min(0.99, r.rho);
    if (r.rB === 0 || r.rE === 0) { orth.zero++; continue; }
    nz++;
    pr.bothUp += 0.25 + Math.asin(rho) / (2 * Math.PI); pr.bothDown += 0.25 + Math.asin(rho) / (2 * Math.PI); pr.mixed += 0.5 - Math.asin(rho) / Math.PI;
    if (r.rB > 0 && r.rE > 0) orth.bothUp++; else if (r.rB < 0 && r.rE < 0) orth.bothDown++; else orth.mixed++;
    const sd = Math.sqrt(r.sB ** 2 + r.sE ** 2 - 2 * rho * r.sB * r.sE);
    nG++;
    for (const z of [0.5, 1, 1.5]) { if (r.rB - r.rE > z * sd) gapObs[z]++; gapPred[z] += 1 - Phi(z); }
  }
  console.log(`   ортанты (непересекающиеся окна, n=${nz}; без нулевых): ↑↑ модель ${f3(pr.bothUp / nz)} факт ${f3(orth.bothUp / nz)}; ↓↓ ${f3(pr.bothDown / nz)} / ${f3(orth.bothDown / nz)}; разнонаправленные ${f3(pr.mixed / nz)} / ${f3(orth.mixed / nz)} (нулевых окон ${orth.zero})`);
  for (const z of [0.5, 1, 1.5]) { const [lo, hi] = wilson(gapObs[z], nG); console.log(`   разрыв BTC−ETH > ${z}·sd: модель ${f3(gapPred[z] / nG)} факт ${f3(gapObs[z] / nG)} [${f3(lo)}…${f3(hi)}] (${gapObs[z]}/${nG})`); }
  out.rho = { adapterMean: rhoPred, sample: rhoReal, ci: ciRho, sampleNonOverlap: rhoRealNo, n: n2, orth, pr, nz };
  results.push({ name: "btc", detail: out });
}
// ---- 6. молнии (storm API): λ по 4 предыдущим окнам, как в feed-lightning.prepare; цель — окно через GAP окон ----
if (ltgFile) {
  const rawL = zlib.gunzipSync(fs.readFileSync(ltgFile), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
  const byStart = new Map();
  for (const line of rawL.split("\n")) { if (!line) continue; let o; try { o = JSON.parse(line); } catch (e) { continue; } if (o.k === "ltg") byStart.set(o.start, o); }
  const W = [...byStart.values()].sort((a, b) => a.start - b.start);
  console.log(`\n== молнии: окон в записи ${W.length}, лаг (seen − end) медиана ${W.length ? (W.map((w) => w.seen - w.end).sort((a, b) => a - b)[W.length >> 1] / 1000).toFixed(0) : "—"} с, нулевых/пустых pts ${W.filter((w) => !w.pts.length).length}, средний total ${W.length ? f2(W.reduce((a, w) => a + w.total, 0) / W.length) : "—"}`);
  const med = (a) => { const q = a.slice().sort((x, y) => x - y); return q.length % 2 ? q[(q.length - 1) / 2] : (q[q.length / 2 - 1] + q[q.length / 2]) / 2; };
  const side = (p, sp) => (sp.axis === "lat" ? p[0] > sp.at : p[1] > sp.at);
  const count = (w, sp) => { const n = w.pts.length; if (!n) return { a: 0, b: 0 }; let a = 0; for (const p of w.pts) if (side(p, sp)) a++; const k = w.total / n; return { a: Math.round(a * k), b: Math.round((n - a) * k) }; };
  for (const gap of [0, 2]) {
    const items = [];
    for (let j = 4; j + gap < W.length; j++) {
      const hist = W.slice(j - 4, j), tgt = W[j + gap];
      if (hist[3].start - hist[0].start !== 60000 || tgt.start !== hist[3].start + 20000 * (1 + gap)) continue;   // нужны подряд идущие окна
      for (const axis of ["lat", "lon"]) {
        const vals = []; for (const w of hist) for (const p of w.pts) vals.push(axis === "lat" ? p[0] : p[1]);
        if (!vals.length) continue;
        const sp = { axis, at: Math.round(med(vals) * 10) / 10 };
        const cA = hist.map((w) => count(w, sp).a), cB = hist.map((w) => count(w, sp).b);
        const la = cA.reduce((x, y) => x + y, 0) / 4 / T, lb = cB.reduce((x, y) => x + y, 0) / 4 / T;
        if (!duelOk(la, lb, T, 3, { minTotal: 20 })) continue;
        const c = count(tgt, sp);
        items.push({ blk: Math.floor(j / 5), ph: 0, la, lb, nA: c.a, nB: c.b, pair: axis, t: j });
      }
    }
    results.push(evalDuel(`duel: молнии (окно через ${gap} после истории, split по медиане), фильтр feed-lightning (minTotal 20, φ=3)`, items, 3));
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
