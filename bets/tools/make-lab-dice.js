"use strict";

// Генерирует ../bets-lab-dice-data.js: рынки костей из настоящего движка и серия бросков.
const fs = require("fs");
const path = require("path");
const dice = require("../events/dice");

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}
const rnd = mulberry(18102026);
const ev = dice.build();
const markets = ev.markets.map((m) => ({ id: m.id, group: m.group, kc: m.kc }));
const rolls = [];
for (let i = 0; i < 80; i++) {
  const o = ev.draw(rnd);
  rolls.push({ o, win: ev.markets.filter((m) => m.test(o)).map((m) => m.id) });
}
fs.writeFileSync(path.join(__dirname, "..", "..", "bets-lab-dice-data.js"), "window.LAB_DICE = " + JSON.stringify({ markets, rolls }) + ";\n");
console.log("markets:", markets.length, "rolls:", rolls.length);
