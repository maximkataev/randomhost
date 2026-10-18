"use strict";

// Кости: три кубика, 216 равновероятных исходов (bets-spec.md §4.3)
const { MARGIN, market, clean, enumerateP } = require("../odds");

const OMEGA = [];
for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) OMEGA.push({ o: [a, b, c], P: 1 / 216 });

const sumOf = (o) => o[0] + o[1] + o[2];
const triple = (o) => o[0] === o[1] && o[1] === o[2];

function build() {
  const list = [];
  const add = (id, group, cls, test) => list.push(market(id, group, enumerateP(OMEGA, test), MARGIN[cls], test));

  add("big", "main", "main", (o) => !triple(o) && sumOf(o) >= 11);
  add("small", "main", "main", (o) => !triple(o) && sumOf(o) <= 10);
  add("odd", "main", "main", (o) => !triple(o) && sumOf(o) % 2 === 1);
  add("even", "main", "main", (o) => !triple(o) && sumOf(o) % 2 === 0);
  for (let n = 1; n <= 6; n++) add(`has:${n}`, "numbers", "main", (o) => o.includes(n));
  add("sum:10-11", "sums", "main", (o) => sumOf(o) === 10 || sumOf(o) === 11);
  add("sum:9-12", "sums", "main", (o) => sumOf(o) === 9 || sumOf(o) === 12);
  add("sum:8-13", "sums", "side", (o) => sumOf(o) === 8 || sumOf(o) === 13);
  add("sum:7-14", "sums", "side", (o) => sumOf(o) === 7 || sumOf(o) === 14);
  add("sum:5-6-15-16", "sums", "side", (o) => [5, 6, 15, 16].includes(sumOf(o)));
  add("sum:3-18", "exotic", "exotic", (o) => sumOf(o) === 3 || sumOf(o) === 18);
  for (let s = 4; s <= 17; s++) add(`exact:${s}`, "exact", "exotic", (o) => sumOf(o) === s);
  add("triple", "exotic", "exotic", triple);

  return {
    type: "dice",
    params: {},
    input: {},
    markets: clean(list),
    draw: (rnd) => [1 + rnd(6), 1 + rnd(6), 1 + rnd(6)],
  };
}

module.exports = { build, OMEGA };
