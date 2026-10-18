"use strict";

/*
 * Математика для рынков (bets-spec.md §3, §10): нормальное распределение, гамма, отрицательное биномиальное.
 * Только встроенные средства, без зависимостей. Точность ~1e-9 — на порядки выше нужной для коэффициентов в сотых.
 */

// erf рядом Тейлора: для |x| ≤ 4,3 (z ≤ 6) потеря точности от знакопеременных членов не больше ~1e-9
function erf(x) {
  const ax = Math.abs(x);
  if (ax > 6) return Math.sign(x);
  let term = ax, sum = ax;
  for (let n = 1; n < 300; n++) {
    term *= -ax * ax / n;
    const t = term / (2 * n + 1);
    sum += t;
    if (Math.abs(t) < 1e-18 * Math.abs(sum)) break;
  }
  return Math.sign(x) * 2 / Math.sqrt(Math.PI) * sum;
}

const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

const LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = LG[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LG[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Счёт за окно: среднее mean, дисперсия phi·mean (phi ≥ 1; phi = 1 — Пуассон, иначе отрицательное биномиальное)
function countPmf(mean, phi, kMax) {
  const out = new Array(kMax + 1);
  if (phi <= 1 + 1e-9) {
    for (let k = 0; k <= kMax; k++) out[k] = Math.exp(-mean + k * Math.log(mean) - lgamma(k + 1));
  } else {
    const r = mean / (phi - 1), pr = 1 / phi;
    for (let k = 0; k <= kMax; k++) {
      out[k] = Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(pr) + k * Math.log(1 - pr));
    }
  }
  return out;
}

// Хвост берём с запасом: 12 «сигм» + 30
function countSupport(mean, phi) {
  return Math.ceil(mean + 12 * Math.sqrt(Math.max(phi, 1) * mean) + 30);
}

function binomDist(n, p) {
  let d = [1];
  for (let i = 0; i < n; i++) {
    const nd = new Array(d.length + 1).fill(0);
    d.forEach((v, k) => { nd[k] += v * (1 - p); nd[k + 1] += v * p; });
    d = nd;
  }
  return d;
}

// Распределение числа успехов при разных вероятностях (Пуассон — Бернулли)
function poissonBinomial(ps) {
  let d = [1];
  for (const p of ps) {
    const nd = new Array(d.length + 1).fill(0);
    d.forEach((v, k) => { nd[k] += v * (1 - p); nd[k + 1] += v * p; });
    d = nd;
  }
  return d;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

module.exports = { erf, Phi, lgamma, countPmf, countSupport, binomDist, poissonBinomial, sum };
