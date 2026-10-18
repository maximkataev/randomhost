"use strict";

// Генерирует ../bets-lab-rope-data.js: розыгрыши каната из настоящего движка (сила, рынки, каждый из 41 рывков).
const fs = require("fs");
const path = require("path");
const rope = require("../events/rope");

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}
const rnd = mulberry(18102026);
const list = [];
let want = 0;
for (let i = 0; i < 2000 && list.length < 40; i++) {
  const ev = rope.build(rnd);
  const o = ev.draw(rnd);
  const cb = (o.winner === "A" && o.minDiff <= -5) || (o.winner === "B" && o.maxDiff >= 5);
  // в лаборатории каждый четвёртый — с камбэком, чтобы его было видно
  if (list.length % 4 === 3 && !cb) continue;
  list.push({ s: ev.params.s, markets: ev.markets.map((m) => ({ id: m.id, group: m.group, kc: m.kc, p: m.p })), o, win: ev.markets.filter((m) => m.test(o)).map((m) => m.id) });
}
fs.writeFileSync(path.join(__dirname, "..", "..", "bets-lab-rope-data.js"), "window.LAB_ROPE = " + JSON.stringify(list) + ";\n");
console.log("ropes:", list.length, "comebacks:", list.filter((r) => (r.o.winner === "A" && r.o.minDiff <= -5) || (r.o.winner === "B" && r.o.maxDiff >= 5)).length);
