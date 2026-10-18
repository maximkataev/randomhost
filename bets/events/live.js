"use strict";

/*
 * Модели реальных событий (bets-spec.md §4.5, §4.6, §10). Здесь только математика рынков: параметры
 * (σ, λ, φ, ρ, доли) приходят из bets/feed.js, исход приносит мир. Все вероятности — оценки модели
 * (кроме drand), поэтому маржа выше, а коэффициенты фиксируются при запуске окна ставок.
 */
const { MARGIN, market, clean } = require("../odds");
const { Phi, countPmf, countSupport } = require("../mathx");

const TAIL_INFL = 1.2; // запас по хвосту цены (калибровка 18.10, docs/bets-spec.md §12)

// ---- ₿ Биткоин: выше или ниже за 20 с (§4.5) ----
// sigma — σ_T в долларах. Пороги: Δ = округлённое до цента z·σ + полцента (точной ничьей по порогу не бывает).
function btc(sigma, zs = [0, 0.5, 1, 1.5, 2]) {
  const list = [];
  for (const z of zs) {
    const delta = Math.round(z * sigma * 100) / 100 + 0.005;
    // цены в центах: исход «d ≥ Δ+0,005» имеет вероятность 1 − Φ(Δ/σ) (центовая сетка, непрерывная поправка).
    // Пороги дальше нуля считаем с запасом по хвосту: по записи 18.10 доли |ΔS|>1,5σ и >2σ выше нормальных (20% против 13%,
    // 7,8% против 4,6%), поэтому σ в формуле вероятности завышена на TAIL_INFL. Рынок «выше/ниже нуля» от σ не зависит.
    const p = 1 - Phi(delta / (z > 0 ? sigma * TAIL_INFL : sigma));
    const cls = z >= 1 ? "liveTail" : "live";
    list.push(market(`up:${z}`, "price", p, MARGIN[cls], (d) => d > delta));
    list.push(market(`down:${z}`, "price", p, MARGIN[cls], (d) => d < -delta));
  }
  return { type: "btc", params: { sigma }, markets: clean(list) };
}

// ---- ₿Ξ BTC против ETH (§4.6): исход {rB, rE} — относительные приращения за 20 с ----
function btcEth(sigB, sigE, rho, zs = [0.5, 1, 1.5]) {
  const sd = Math.sqrt(sigB * sigB + sigE * sigE - 2 * rho * sigB * sigE);
  const up = 0.25 + Math.asin(rho) / (2 * Math.PI), mixed = 0.5 - Math.asin(rho) / Math.PI;
  const list = [
    market("bothUp", "dir", up, MARGIN.liveTail, (o) => o.rB > 0 && o.rE > 0),
    market("bothDown", "dir", up, MARGIN.liveTail, (o) => o.rB < 0 && o.rE < 0),
    market("mixed", "dir", mixed, MARGIN.liveTail, (o) => o.rB * o.rE < 0),
    market("btcBeats", "duel", 0.5, MARGIN.live, (o) => o.rB - o.rE > 0),
    market("ethBeats", "duel", 0.5, MARGIN.live, (o) => o.rE - o.rB > 0),
  ];
  for (const z of zs) {
    const p = 1 - Phi(z / TAIL_INFL); // тот же запас по хвосту, что у btc
    list.push(market(`btcGap:${z}`, "gap", p, MARGIN.liveTail, (o) => o.rB - o.rE > z * sd));
    list.push(market(`ethGap:${z}`, "gap", p, MARGIN.liveTail, (o) => o.rE - o.rB > z * sd));
  }
  return { type: "btceth", params: { sigB, sigE, rho, sd }, markets: clean(list) };
}

// ---- Дуэль счётчиков (§10.2): точная свёртка двух распределений счёта ----
// lamA, lamB — интенсивность за секунду; T — окно; phi — сверхдисперсия (≥ 1)
function duelProbs(lamA, lamB, T, phi) {
  const mA = lamA * T, mB = lamB * T;
  const K = Math.max(countSupport(mA, phi), countSupport(mB, phi));
  const pa = countPmf(mA, phi, K), pb = countPmf(mB, phi, K);
  let ca = 0, cbv = 0;
  const cumA = [], cumB = [];
  for (let i = 0; i <= K; i++) { ca += pa[i]; cumA.push(ca); cbv += pb[i]; cumB.push(cbv); }
  // P(A > B) = Σ_j P(B=j)·P(A>j); P(B > A) = Σ_i P(A=i)·P(B>i)
  let pA = 0, pB = 0;
  for (let j = 0; j <= K; j++) pA += pb[j] * (1 - cumA[j]);
  for (let i = 0; i <= K; i++) pB += pa[i] * (1 - cumB[i]);
  const tie = Math.max(0, 1 - pA - pB);
  return { pA, pB, tie };
}

function duel({ lamA, lamB, T = 20, phi = 1.5, cls = "live" }) {
  const { pA, pB, tie } = duelProbs(lamA, lamB, T, phi);
  const m = MARGIN[cls];
  const list = [
    market("A", "duel", pA, m, (o) => o.nA > o.nB),
    market("B", "duel", pB, m, (o) => o.nB > o.nA),
    market("tie", "duel", tie, MARGIN.exotic, (o) => o.nA === o.nB),
  ];
  return { type: "duel", params: { lamA, lamB, T, phi }, probs: { pA, pB, tie }, markets: clean(list) };
}

// ---- Пороги (§10.3): P(хотя бы k) для независимых видов событий ----
// kinds: [{ id, lam }]; ks — пороги числа событий; T — окно
function thresholds(kinds, { T = 20, phi = 1.5, ks = [1], cls = "thresh", pMin = 0.15, pMax = 0.85 } = {}) {
  const list = [];
  for (const { id, lam } of kinds) {
    const mean = lam * T, K = countSupport(mean, phi);
    const pmf = countPmf(mean, phi, K);
    let cum = 0;
    const cdf = pmf.map((v) => (cum += v));
    for (const k of ks) {
      const p = 1 - (k - 1 >= 0 ? cdf[k - 1] : 0);
      if (p < pMin || p > pMax) continue;
      list.push(market(`${id}:ge${k}`, id, p, MARGIN[cls], (o) => (o[id] || 0) >= k));
    }
  }
  return { type: "thresholds", params: { T, phi }, markets: clean(list) };
}

// Гонка видов: кто первым, P(i) = λ_i / Σλ при условии, что событие случилось
function firstOf(kinds, cls = "thresh") {
  const S = kinds.reduce((a, k) => a + k.lam, 0);
  const list = kinds.map(({ id, lam }) => market(`first:${id}`, "first", lam / S, MARGIN[cls], (o) => o.first === id));
  return { type: "firstOf", params: {}, markets: clean(list) };
}

// ---- Категориальные рулетки (§10.4): p_i = (n_i + 1) / (N + K) ----
function categorical(counts, minShare = 0.03, cls = "categ") {
  let total = Object.values(counts).reduce((a, b) => a + b, 0);
  // мелкие категории объединяем в «other»
  const merged = {};
  let other = 0;
  for (const [id, n] of Object.entries(counts)) {
    if (id !== "other" && n / total < minShare) other += n; else if (id === "other") other += n; else merged[id] = n;
  }
  if (other > 0) merged.other = other;
  const ids = Object.keys(merged), K = ids.length;
  const list = ids.map((id) => market(`cat:${id}`, "cat", (merged[id] + 1) / (total + K), MARGIN[cls], (o) => o === id));
  return { type: "categorical", params: { total, K }, markets: clean(list) };
}

// ---- 📡 drand (§10.5): точная равномерность, оценок нет ----
function drand() {
  const m = MARGIN.beacon;
  const list = [];
  const HEX = "0123456789abcdef";
  const last = (h) => HEX.indexOf(String(h).slice(-1).toLowerCase());
  for (let d = 0; d < 16; d++) list.push(market(`digit:${HEX[d]}`, "digit", 1 / 16, m, (h) => last(h) === d));
  list.push(market("even", "parity", 1 / 2, m, (h) => last(h) % 2 === 0));
  list.push(market("odd", "parity", 1 / 2, m, (h) => last(h) % 2 === 1));
  list.push(market("num", "kind", 10 / 16, m, (h) => last(h) < 10));
  list.push(market("letter", "kind", 6 / 16, m, (h) => last(h) >= 10));
  for (let q = 0; q < 4; q++) list.push(market(`quarter:${q}`, "quarter", 1 / 4, m, (h) => Math.floor(last(h) / 4) === q));
  return { type: "drand", params: {}, markets: clean(list) };
}

module.exports = { btc, btcEth, duel, duelProbs, thresholds, firstOf, categorical, drand };
