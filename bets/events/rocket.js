"use strict";

// Ракета: P(M ≥ x) = (1 − e)/x, цель x = коэффициент (bets-spec.md §4.4)
const { market } = require("../odds");

const EDGE = 0.06;
const CAP = 1000;
const TARGETS = [1.2, 1.5, 2, 3, 5, 10, 20, 50, 100];

// Рынок «долетит до цели x» (x кратен 0,01, ≥ 1,01). Вероятность задаёт формула, коэффициент — сам x.
function targetMarket(x) {
  const cents = Math.round(x * 100);
  if (cents < 101 || cents > CAP * 100) return null;
  const xx = cents / 100;
  const p = (1 - EDGE) / xx;
  if (p >= 1) return null;
  return market(`target:${xx}`, "target", p, EDGE, (m) => m >= xx);
}

// Взрыв ровно на 1,00× (цели ≥ 1,01× не берут): 1 − (1−e)/1,01
function instantMarket() {
  const p = 1 - (1 - EDGE) / 1.01;
  return market("instant", "exotic", p, EDGE, (m) => m === 1);
}

function build() {
  const list = TARGETS.map(targetMarket);
  list.push(instantMarket());
  return {
    type: "rocket",
    params: { edge: EDGE },
    input: {},
    markets: list.filter(Boolean),
    // индивидуальная цель игрока: рынок строится по запросу, коэффициент = цель
    marketFor: targetMarket,
    draw(rnd) {
      const u = rnd(2 ** 32) / 2 ** 32;
      return Math.min(CAP, Math.max(1, Math.floor(100 * (1 - EDGE) / (1 - u)) / 100));
    },
  };
}

module.exports = { build, targetMarket, instantMarket, EDGE, CAP };
