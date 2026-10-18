"use strict";

// Собачьи бега: 3 собаки, порядок финиша по модели Плакетта — Льюса (bets-spec.md §4.1)
const { MARGIN, market, clean } = require("../odds");

const N = 3;

const PERMS = [];
(function rec(rest, pre) {
  if (!rest.length) { PERMS.push(pre); return; }
  for (const i of rest) rec(rest.filter((x) => x !== i), [...pre, i]);
})([0, 1, 2], []);

// P(порядок) = Π w_i / (сумма весов оставшихся)
function permProb(w, perm) {
  let rest = w.reduce((a, b) => a + b, 0), p = 1;
  for (const i of perm) { p *= w[i] / rest; rest -= w[i]; }
  return p;
}

// Шаблоны формы (сумма ≈ 100); фаворит 34–58%, аутсайдер не меньше 12% (иначе k победы и «последней» уходит за потолок)
const TEMPLATES = [
  [48, 32, 20],  // фаворит
  [40, 34, 26],  // открытая гонка
  [55, 27, 18],  // сильный фаворит
  [36, 36, 28],  // два лидера
];

function genWeights(rnd) {
  for (;;) {
    const t = TEMPLATES[rnd(TEMPLATES.length)].slice();
    for (let i = t.length - 1; i > 0; i--) { const j = rnd(i + 1); [t[i], t[j]] = [t[j], t[i]]; }
    const w = t.map((x) => Math.max(1, x + rnd(5) - 2));
    const S = w.reduce((a, b) => a + b, 0);
    const mx = Math.max(...w) / S, mn = Math.min(...w) / S;
    if (mx >= 0.34 && mx <= 0.58 && mn >= 0.12) return w;
  }
}

function build(rnd, fixedWeights) {
  const w = fixedWeights || genWeights(rnd);
  const probs = PERMS.map((perm) => ({ perm, P: permProb(w, perm) }));
  const pOf = (test) => { let p = 0; for (const { perm, P } of probs) if (test(perm)) p += P; return p; };
  const list = [];
  const add = (id, group, cls, test) => list.push(market(id, group, pOf(test), MARGIN[cls], test));

  for (let i = 0; i < N; i++) {
    add(`win:${i + 1}`, "win", "main", (o) => o[0] === i);
    add(`top2:${i + 1}`, "place", "side", (o) => o.indexOf(i) < 2);
    add(`last:${i + 1}`, "exotic", "exotic", (o) => o[N - 1] === i);
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i !== j) add(`ex:${i + 1}-${j + 1}`, "forecast", "forecast", (o) => o[0] === i && o[1] === j);
  }
  const duels = [];

  return {
    type: "dogs",
    params: { weights: w, duels },
    input: { weights: w, duels },
    markets: clean(list),
    // порядок строится последовательными целочисленными выборами
    draw(r) {
      const rest = [0, 1, 2], order = [];
      while (rest.length) {
        const S = rest.reduce((a, i) => a + w[i], 0);
        let x = r(S), k = 0;
        while (x >= w[rest[k]]) { x -= w[rest[k]]; k++; }
        order.push(rest.splice(k, 1)[0]);
      }
      return order;
    },
  };
}

module.exports = { build, PERMS, permProb };
