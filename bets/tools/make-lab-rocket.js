"use strict";

// Генерирует ../bets-lab-rocket-data.js: рынки ракеты и серия взрывов из настоящего движка.
const fs = require("fs");
const path = require("path");
const rocket = require("../events/rocket");

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}
const rnd = mulberry(7102026);
const ev = rocket.build();
const markets = ev.markets.map((m) => ({ id: m.id, kc: m.kc, p: m.p }));
const crashes = [];
for (let i = 0; i < 400; i++) crashes.push(ev.draw(rnd));
// для лаборатории: немного «ярких» полётов впереди, остальное как в движке
const spice = crashes.filter((m) => m >= 4).slice(0, 6);
const mixed = [];
for (let i = 0; i < 60; i++) mixed.push(i % 4 === 3 && spice.length ? spice[(i >> 2) % spice.length] : crashes[i]);
const quote = (x) => { const m = rocket.targetMarket(x); return m ? { kc: m.kc, p: m.p } : null; };
const ladder = [];
for (let x = 1.1; x <= 200; x = x < 2 ? x + 0.1 : x < 5 ? x + 0.25 : x < 20 ? x + 1 : x + 10) { const q = quote(Math.round(x * 100) / 100); if (q) ladder.push({ x: Math.round(x * 100) / 100, ...q }); }
fs.writeFileSync(path.join(__dirname, "..", "..", "bets-lab-rocket-data.js"), "window.LAB_ROCKET = " + JSON.stringify({ markets, crashes: mixed, ladder, edge: rocket.EDGE }) + ";\n");
console.log("markets:", markets.length, "crashes:", mixed.length, "ladder:", ladder.length);
