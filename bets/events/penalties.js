"use strict";

// Серия пенальти: 5+5 ударов всегда, затем «до первой ошибки» (bets-spec.md §4.2)
const { MARGIN, market, clean } = require("../odds");
const { poissonBinomial } = require("../mathx");

const Q_POST = 40;       // вероятность штанги на удар, ‰
const KICKS = 5;
const SD_MAX = 60;       // страховка цикла «до первой ошибки»

// Исходы удара: гол s‰, штанга 40‰, остаток делится на сейв (70%) и мимо
function kickRes(s, r) {
  const rest = 1000 - s - Q_POST, save = Math.floor(rest * 0.7);
  const x = r(1000);
  if (x < s) return "goal";
  if (x < s + Q_POST) return "post";
  if (x < s + Q_POST + save) return "save";
  return "miss";
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function genTeam(rnd) {
  const base = 620 + rnd(220);
  return Array.from({ length: KICKS }, () => clamp(base + rnd(161) - 80, 550, 900));
}

function build(rnd, fixed) {
  const sA = fixed ? fixed.A : genTeam(rnd), sB = fixed ? fixed.B : genTeam(rnd);
  // класс команды для серии «до первой ошибки» — средняя вероятность гола, в ‰
  const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const aSD = mean(sA), bSD = mean(sB);

  const dA = poissonBinomial(sA.map((s) => s / 1000)), dB = poissonBinomial(sB.map((s) => s / 1000));
  let pTie = 0, pAreg = 0, pBreg = 0;
  const joint = [];
  for (let i = 0; i <= KICKS; i++) {
    joint.push([]);
    for (let j = 0; j <= KICKS; j++) {
      const p = dA[i] * dB[j];
      joint[i].push(p);
      if (i > j) pAreg += p; else if (i < j) pBreg += p; else pTie += p;
    }
  }
  const a = aSD / 1000, b = bSD / 1000;
  const sdA = a * (1 - b) / (a * (1 - b) + b * (1 - a));
  const pA = pAreg + pTie * sdA, pB = pBreg + pTie * (1 - sdA);

  const list = [];
  const add = (id, group, cls, p, test) => list.push(market(id, group, p, MARGIN[cls], test));
  add("winner:A", "winner", "main", pA, (o) => o.winner === "A");
  add("winner:B", "winner", "main", pB, (o) => o.winner === "B");

  // тотал голов за 10 ударов: линия, ближайшая к 50%, и соседние, если p в 20–80%
  const overP = (L) => { let p = 0; for (let i = 0; i <= KICKS; i++) for (let j = 0; j <= KICKS; j++) if (i + j > L) p += joint[i][j]; return p; };
  const lines = [];
  for (let L = 2.5; L <= 9.5; L += 1) lines.push({ L, p: overP(L) });
  lines.sort((x, y) => Math.abs(x.p - 0.5) - Math.abs(y.p - 0.5));
  lines.forEach(({ L, p }, idx) => {
    if (idx > 0 && (p < 0.2 || p > 0.8)) return;
    if (idx > 2) return;
    add(`over:${L}`, "total", "main", p, (o) => o.goalsA + o.goalsB > L);
    add(`under:${L}`, "total", "main", 1 - p, (o) => o.goalsA + o.goalsB < L);
  });

  for (let i = 0; i <= KICKS; i++) for (let j = 0; j <= KICKS; j++) {
    add(`score:${i}-${j}`, "score", "exotic", joint[i][j], (o) => o.goalsA === i && o.goalsB === j);
  }
  let both3 = 0;
  for (let i = 3; i <= KICKS; i++) for (let j = 3; j <= KICKS; j++) both3 += joint[i][j];
  add("both3", "side", "side", both3, (o) => o.goalsA >= 3 && o.goalsB >= 3);
  add("post", "exotic", "exotic", 1 - Math.pow(1 - Q_POST / 1000, 2 * KICKS), (o) => o.posts > 0);
  for (let n = 0; n < KICKS; n++) {
    add(`shooter:A${n + 1}`, "shooters", "side", sA[n] / 1000, (o) => o.kicks[2 * n].res === "goal");
    add(`shooter:B${n + 1}`, "shooters", "side", sB[n] / 1000, (o) => o.kicks[2 * n + 1].res === "goal");
  }

  return {
    type: "penalties",
    params: { A: sA, B: sB, sd: { A: aSD, B: bSD } },
    input: { A: sA, B: sB },
    markets: clean(list),
    draw(r) {
      const kicks = [];
      let goalsA = 0, goalsB = 0, posts = 0;
      for (let n = 0; n < KICKS; n++) {
        const ra = kickRes(sA[n], r), rb = kickRes(sB[n], r);
        kicks.push({ team: "A", n, res: ra }, { team: "B", n, res: rb });
        if (ra === "goal") goalsA++; if (rb === "goal") goalsB++;
        if (ra === "post") posts++; if (rb === "post") posts++;
      }
      const sd = [];
      let winner = goalsA > goalsB ? "A" : goalsB > goalsA ? "B" : null;
      for (let k = 0; !winner && k < SD_MAX; k++) {
        const ga = r(1000) < aSD, gb = r(1000) < bSD;
        sd.push({ a: ga, b: gb });
        if (ga !== gb) winner = ga ? "A" : "B";
      }
      if (!winner) winner = r(2) ? "A" : "B"; // вероятность ~1e-20, страховка от вечного цикла
      return { kicks, sd, goalsA, goalsB, posts, winner };
    },
  };
}

module.exports = { build, kickRes, Q_POST, KICKS };
