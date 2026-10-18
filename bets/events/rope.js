"use strict";

// Канат: 41 рывок, побеждает выигравший больше (bets-spec.md §4.7)
const { MARGIN, market, clean } = require("../odds");
const { binomDist } = require("../mathx");

const PULLS = 41;
const NEED = 21;       // побеждает при ≥ 21 выигранном рывке
const TRAIL = 5;       // «камбэк»: победитель отставал не менее чем на 5
const BIG = 9;         // «с перевесом»: разница не менее 9 рывков

// Вероятность, что A выиграет и в какой-то момент отставал на TRAIL (разница рывков ≤ −TRAIL)
function comebackP(pa) {
  let st = new Map([["0|0", 1]]);
  for (let i = 0; i < PULLS; i++) {
    const nx = new Map();
    for (const [key, v] of st) {
      const [d, f] = key.split("|").map(Number);
      for (const [dd, pr] of [[1, pa], [-1, 1 - pa]]) {
        const nd = d + dd, nf = f || nd <= -TRAIL ? 1 : 0;
        const k2 = nd + "|" + nf;
        nx.set(k2, (nx.get(k2) || 0) + v * pr);
      }
    }
    st = nx;
  }
  let p = 0;
  for (const [key, v] of st) { const [d, f] = key.split("|").map(Number); if (d > 0 && f) p += v; }
  return p;
}

function build(rnd, fixedS) {
  const s = fixedS || 460 + rnd(81); // сила A в ‰ за рывок, 0,46–0,54
  const pa = s / 1000;
  const dist = binomDist(PULLS, pa);
  const pAwin = dist.slice(NEED).reduce((x, y) => x + y, 0), pBwin = 1 - pAwin;
  const margin = (wins) => (wins * 2 - PULLS); // разность рывков

  const list = [];
  const add = (id, group, cls, p, test) => list.push(market(id, group, p, MARGIN[cls], test));
  add("win:A", "winner", "main", pAwin, (o) => o.winner === "A");
  add("win:B", "winner", "main", pBwin, (o) => o.winner === "B");
  const minWinsBig = (PULLS + BIG) / 2; // 25
  add("big:A", "side", "side", dist.slice(minWinsBig).reduce((x, y) => x + y, 0), (o) => o.winner === "A" && margin(o.winsA) >= BIG);
  add("big:B", "side", "side", dist.slice(0, PULLS - minWinsBig + 1).reduce((x, y) => x + y, 0), (o) => o.winner === "B" && -margin(o.winsA) >= BIG);
  add("comeback:A", "exotic", "exotic", comebackP(pa), (o) => o.winner === "A" && o.minDiff <= -TRAIL);
  add("comeback:B", "exotic", "exotic", comebackP(1 - pa), (o) => o.winner === "B" && o.maxDiff >= TRAIL);

  return {
    type: "rope",
    params: { s },
    input: { s },
    markets: clean(list),
    draw(r) {
      const pulls = [];
      let d = 0, min = 0, max = 0, winsA = 0;
      for (let i = 0; i < PULLS; i++) {
        const a = r(1000) < s;
        pulls.push(a ? 1 : 0);
        d += a ? 1 : -1; if (a) winsA++;
        if (d < min) min = d; if (d > max) max = d;
      }
      return { pulls, winsA, winner: winsA >= NEED ? "A" : "B", minDiff: min, maxDiff: max };
    },
  };
}

module.exports = { build, comebackP, PULLS };
