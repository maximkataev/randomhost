"use strict";

/*
 * Генератор синтетических фикстур для test-feed.js (реалистичные распределения, детерминированно по сиду):
 *   prices-synth.json.gz  — 24 ч секундных котировок BTC и ETH (в центах): стохастическая волатильность (OU по логу),
 *                           лёгкие хвосты (t, 6 степеней свободы), корреляция монет ρ = 0,8, отскок bid/ask.
 *   streams-synth.json.gz — 4 ч счётных потоков (метки в мс от старта): процесс Кокса с гамма-модуляцией
 *                           интенсивности по 10-секундным блокам (сверхдисперсия φ ≈ 1,5–2), языки постов, киты.
 * Запуск: node bets/fixtures/gen.js (перезаписывает файлы рядом).
 */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rngMain = mulberry32(20261018), rngAlt = mulberry32(18102026);
let rng = rngMain;                      // переключается на время генерации пачек китов, чтобы остальные потоки не сдвигались
const rnd = () => rng();
const normal = () => { const u = 1 - rnd(), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function chi2(k) { let s = 0; for (let i = 0; i < k; i++) { const z = normal(); s += z * z; } return s; }
const tdist = (df) => normal() / Math.sqrt(chi2(df) / df) * Math.sqrt((df - 2) / df);   // единичная дисперсия
function gamma(k) { // Marsaglia-Tsang для k ≥ 1; для k < 1 бустим
  if (k < 1) return gamma(k + 1) * Math.pow(rnd(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = normal(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = rnd(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
function poisson(m) { if (m > 40) return Math.max(0, Math.round(m + Math.sqrt(m) * normal())); const L = Math.exp(-m); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; }

// ---- цены ----
const N = 24 * 3600, RHO = 0.8;
let lb = Math.log(81000), le = Math.log(2370), x = 0;
const btc = new Array(N), eth = new Array(N);
const theta = Math.log(2) / 7200;          // полураспад режима волатильности 2 ч
let bounceB = 1, bounceE = 1;
for (let i = 0; i < N; i++) {
  x += -theta * x + 0.004 * normal();         // стационарное σ_x ≈ 0,004/√(2θ) ≈ 0,29: волатильность гуляет на ±30%
  const vol = 2.2e-5 * Math.exp(x);
  const z1 = tdist(6), z2 = tdist(6);
  const zB = z1, zE = RHO * z1 + Math.sqrt(1 - RHO * RHO) * z2;
  lb += vol * zB; le += 1.25 * vol * zE;
  bounceB = rnd() < 0.5 ? -1 : 1; bounceE = rnd() < 0.5 ? -1 : 1;
  btc[i] = Math.round(Math.exp(lb + 6e-6 * bounceB) * 100);
  eth[i] = Math.round(Math.exp(le + 6e-6 * bounceE) * 100);
}
const delta = (a) => a.map((v, i) => (i ? v - a[i - 1] : v));
const prices = { startSec: 1790000000, n: N, btc: delta(btc), eth: delta(eth) };

// ---- потоки ----
const DUR = 4 * 3600;
const kinds = {
  laugh: 0.55, heart: 0.45, dewiki: 0.9, frwiki: 0.8, ruwiki: 0.6, w100: 0.012, w500: 0.002, post: 4,
};
const PHI_BLOCK = 0.1;   // дисперсия множителя гамма-модуляции: для 20 с при λ=0,5 даёт φ ≈ 1,5
const CLUSTER = { w100: 0.45, w500: 0.45 };   // средний «хвост» пачки китов; φ синтетики ≈ 1,7 как на записи
const streams = { durationSec: DUR, events: {} };
for (const [name, lam] of Object.entries(kinds)) {
  const ts = [];
  for (let b = 0; b < DUR / 10; b++) {
    const mult = gamma(1 / PHI_BLOCK) * PHI_BLOCK;     // среднее 1, дисперсия PHI_BLOCK
    const cnt = poisson(lam * 10 * mult);
    for (let k = 0; k < cnt; k++) ts.push(Math.round((b * 10 + rnd() * 10) * 1000));
  }
  if (CLUSTER[name]) {
    // киты приходят пачками (калибровка 18.10: φ ≈ 1,7 при реальных ≥ 10 BTC): кластер = 1 + Пуассон(c) транзакций за ≤ 2 с.
    // Прежние обращения к ГПСЧ выше сделаны, поэтому языки и другие потоки остаются теми же, что до правки.
    rng = rngAlt;
    ts.length = 0;
    const c = CLUSTER[name];
    for (let b = 0; b < DUR / 10; b++) {
      const mult = gamma(1 / PHI_BLOCK) * PHI_BLOCK;
      const nCl = poisson(lam * 10 * mult / (1 + c));
      for (let k = 0; k < nCl; k++) { const t0 = b * 10 + rnd() * 10, sz = 1 + poisson(c); for (let j = 0; j < sz; j++) ts.push(Math.round((t0 + rnd() * 2) * 1000)); }
    }
    rng = rngMain;
  }
  ts.sort((a, b) => a - b);
  streams.events[name] = ts;
}
// языки постов: доли примерно как в живом Jetstream
const LANG = [["en", 0.5], ["ja", 0.17], ["pt", 0.07], ["es", 0.05], ["de", 0.04], ["ru", 0.005], ["fr", 0.04], ["ko", 0.03], ["tr", 0.02], ["it", 0.015]];
streams.langCodes = LANG.map((x) => x[0]);   // langs — строка цифр: индекс в langCodes для каждого поста
streams.langs = streams.events.post.map(() => { let u = rnd() * LANG.reduce((a, b) => a + b[1], 0); for (let i = 0; i < LANG.length; i++) { if ((u -= LANG[i][1]) <= 0) return i; } return 0; }).join("");

const dir = __dirname;
fs.writeFileSync(path.join(dir, "prices-synth.json.gz"), zlib.gzipSync(JSON.stringify(prices), { level: 9 }));
fs.writeFileSync(path.join(dir, "streams-synth.json.gz"), zlib.gzipSync(JSON.stringify(streams), { level: 9 }));
console.log("ok", fs.statSync(path.join(dir, "prices-synth.json.gz")).size, fs.statSync(path.join(dir, "streams-synth.json.gz")).size);
