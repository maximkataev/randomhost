"use strict";

// Бокс: 5 раундов; в каждом раунде нокаут одного из бойцов или очко раунда; без нокаута побеждает набравший ≥ 3 раундов (ничьих нет).
const { MARGIN, market, clean } = require("../odds");

const ROUNDS = 5;
const WIN_ROUNDS = 3;

// Распределение исходов бою (точное, ДП по раундам). Параметры в ‰: kA — нокаут A за раунд, kB — нокаут B за раунд,
// q — доля раундов без нокаута, которые берёт A.
function outcomes(kA, kB, q) {
  const pKA = kA / 1000, pKB = kB / 1000, rest = 1 - pKA - pKB, pa = rest * q / 1000, pb = rest * (1 - q / 1000);
  const list = [];
  let dp = new Map([["0|0", 1]]); // (раундов взял A, B) → вероятность «нокаута не было»
  for (let r = 1; r <= ROUNDS; r++) {
    let alive = 0;
    const nx = new Map();
    for (const [key, v] of dp) {
      alive += v;
      const [a, b] = key.split("|").map(Number);
      nx.set((a + 1) + "|" + b, (nx.get((a + 1) + "|" + b) || 0) + v * pa);
      nx.set(a + "|" + (b + 1), (nx.get(a + "|" + (b + 1)) || 0) + v * pb);
    }
    list.push({ winner: "A", method: "KO", round: r, P: alive * pKA });
    list.push({ winner: "B", method: "KO", round: r, P: alive * pKB });
    dp = nx;
  }
  let pDecA = 0, pDecB = 0;
  for (const [key, v] of dp) { const a = +key.split("|")[0]; if (a >= WIN_ROUNDS) pDecA += v; else pDecB += v; }
  list.push({ winner: "A", method: "DEC", round: ROUNDS, P: pDecA });
  list.push({ winner: "B", method: "DEC", round: ROUNDS, P: pDecB });
  return list;
}

const GEN = [
  // шаблоны бойцов: [kA, kB, q]
  [90, 50, 550], [70, 70, 500], [110, 40, 520], [50, 90, 470], [60, 60, 580], [100, 100, 500],
];

function build(rnd, fixed) {
  let kA, kB, q;
  if (fixed) ({ kA, kB, q } = fixed);
  else {
    const t = GEN[rnd(GEN.length)];
    kA = Math.max(20, Math.min(140, t[0] + rnd(21) - 10)); kB = Math.max(20, Math.min(140, t[1] + rnd(21) - 10));
    q = Math.max(380, Math.min(620, t[2] + rnd(41) - 20));
  }
  const omega = outcomes(kA, kB, q);
  const pOf = (test) => omega.reduce((s, x) => s + (test(x) ? x.P : 0), 0);
  const list = [];
  const add = (id, group, cls, test) => list.push(market(id, group, pOf(test), MARGIN[cls], test));
  add("win:A", "winner", "main", (o) => o.winner === "A");
  add("win:B", "winner", "main", (o) => o.winner === "B");
  add("method:KO", "method", "side", (o) => o.method === "KO");
  add("method:DEC", "method", "side", (o) => o.method === "DEC");
  for (const w of ["A", "B"]) for (const m of ["KO", "DEC"]) add(`combo:${w}-${m}`, "combo", "exotic", (o) => o.winner === w && o.method === m);
  for (let r = 1; r <= ROUNDS; r++) add(`ko:${r}`, "round", "exotic", (o) => o.method === "KO" && o.round === r);

  return {
    type: "boxing",
    params: { kA, kB, q },
    input: { kA, kB, q },
    markets: clean(list),
    // раунды разыгрываются последовательно целочисленными выборами (как в DP)
    draw(r) {
      const rounds = [];
      let a = 0, b = 0;
      for (let k = 1; k <= ROUNDS; k++) {
        const x = r(1000);
        if (x < kA) return { winner: "A", method: "KO", round: k, rounds, koBy: "A" };
        if (x < kA + kB) return { winner: "B", method: "KO", round: k, rounds, koBy: "B" };
        if (r(1000) < q) { rounds.push("A"); a++; } else { rounds.push("B"); b++; }
      }
      return { winner: a >= WIN_ROUNDS ? "A" : "B", method: "DEC", round: ROUNDS, rounds, scoreA: a, scoreB: b };
    },
  };
}

module.exports = { build, outcomes, ROUNDS };
