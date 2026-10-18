"use strict";

// Генерирует ../bets-lab-data.js: гонки из настоящего движка (веса формы, коэффициенты, порядок финиша) для страниц-лабораторий.
const fs = require("fs");
const path = require("path");
const dogs = require("../events/dogs");

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}

const rnd = mulberry(20261018);
const races = [];
for (let i = 0; i < 60; i++) {
  const ev = dogs.build(rnd);
  const by = Object.fromEntries(ev.markets.map((m) => [m.id, m]));
  const col = (g) => [1, 2, 3].map((n) => (by[`${g}:${n}`] ? by[`${g}:${n}`].kc : null));
  races.push({ w: ev.params.weights, win: col("win"), top2: col("top2"), last: col("last"), order: ev.draw(rnd) });
}
fs.writeFileSync(path.join(__dirname, "..", "..", "bets-lab-data.js"), "window.LAB_RACES = " + JSON.stringify(races) + ";\n");
console.log("races:", races.length);
