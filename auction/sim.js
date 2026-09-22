"use strict";

/*
 * Headless-симуляция партий: node sim.js [игр] [игроков]
 * Проверяет, что игра всегда завершается, и печатает статистику по стратегиям.
 */

const fs = require("fs");
const path = require("path");
const { Game } = require("./game");
const { decide } = require("./bots");

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cards = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "artist.json"), "utf8"));
const games = Number(process.argv[2] || 200);
const nPlayers = Number(process.argv[3] || 4);
const strategies = ["aggressive", "frugal", "passive", "afk", "frugal", "aggressive", "passive", "frugal"].slice(0, nPlayers);

const wins = {};
const stats = { rounds: [], durationMs: [], unsold: 0, pickups: 0, sold: 0, emptySlots: 0, maxLotMs: 0 };

for (let g = 0; g < games; g++) {
  const rng = mulberry32(g + 1);
  const game = Game.create({ kind: "artist", cards, settings: {}, rng });
  strategies.forEach((st, i) => game.addPlayer({ id: `p${i}`, name: `${st}${i}` }));
  let now = 0;
  game.start(now);
  let lotStart = now;
  let guard = 0;
  while (game.s.phase !== "finished" && guard++ < 200000) {
    // боты думают каждые 700 мс
    for (let i = 0; i < strategies.length; i++) {
      if (strategies[i] === "afk") continue;
      const snap = game.snapshot(now);
      const amount = decide(strategies[i], snap, `p${i}`, rng);
      if (amount != null) game.bid(`p${i}`, amount, now);
      if (snap.phase === "pickup") {
        const me = snap.players[i];
        if (me.canTake && rng() < 0.8) game.take(`p${i}`, now);
      }
    }
    now += 700;
    const events = game.tick(now);
    for (const e of events) {
      if (e.type === "sold") stats.sold++;
      if (e.type === "taken") stats.pickups++;
      if (e.type === "unsold") stats.unsold++;
      if (e.type === "lot") { stats.maxLotMs = Math.max(stats.maxLotMs, now - lotStart); lotStart = now; }
    }
  }
  if (game.s.phase !== "finished") throw new Error(`game ${g} did not finish`);
  stats.rounds.push(game.s.round);
  stats.durationMs.push(now);
  for (const p of game.s.players) stats.emptySlots += game.s.settings.slots - p.lots.length;
  // «победитель» для статистики: больше лотов, при равенстве — больше потрачено (в жизни судит ИИ)
  const best = game.s.players.slice().sort((a, b) => b.lots.length - a.lots.length || b.spent - a.spent)[0];
  wins[best.name.replace(/\d+$/, "")] = (wins[best.name.replace(/\d+$/, "")] || 0) + 1;
}

const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log(`игр: ${games}, игроков: ${nPlayers} (${strategies.join(", ")})`);
console.log(`все завершились; раундов в среднем ${avg(stats.rounds)}, длительность ${avg(stats.durationMs.map((x) => x / 60000))} мин, самый долгий лот ${(stats.maxLotMs / 1000).toFixed(0)} с`);
console.log(`продано ${stats.sold}, забрано бесплатно ${stats.pickups}, не продано ${stats.unsold}, пустых слотов на игру ${(stats.emptySlots / games).toFixed(2)}`);
console.log("побед по стратегиям (по числу лотов):", wins);
