"use strict";

// Генерирует ../bets-lab-pen-data.js: серии пенальти из настоящего движка (составы, рынки, исходы ударов).
const fs = require("fs");
const path = require("path");
const pen = require("../events/penalties");

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}
const rnd = mulberry(20261018);
const shoots = [];
let tiesWanted = 0;
for (let i = 0; i < 400 && shoots.length < 40; i++) {
  const ev = pen.build(rnd);
  const o = ev.draw(rnd);
  // в лаборатории хотим видеть и серии до первой ошибки: каждая пятая — с ничьей после пяти
  const tie = o.goalsA === o.goalsB;
  if (shoots.length % 5 === 4 && !tie) continue;
  if (shoots.length % 5 !== 4 && tie && Math.random() < 0.7) continue;
  const markets = ev.markets.map((m) => ({ id: m.id, group: m.group, kc: m.kc, p: m.p }));
  shoots.push({ A: ev.params.A, B: ev.params.B, sd: ev.params.sd, markets, o, win: ev.markets.filter((m) => m.test(o)).map((m) => m.id) });
}
fs.writeFileSync(path.join(__dirname, "..", "..", "bets-lab-pen-data.js"), "window.LAB_PEN = " + JSON.stringify(shoots) + ";\n");
console.log("shootouts:", shoots.length, "with sudden death:", shoots.filter((s) => s.o.sd.length).length);
