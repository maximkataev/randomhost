"use strict";

/*
 * Стенд баланса рулетки (roulette-spec.md §11): партии на ботах без сети и таймеров.
 *   node sim.js [партий=500]
 * Считает длительность партий по реальному времени фаз (ставки людей берём как ~18 с в среднем),
 * победы стратегий и перекос, который даёт каждая карта-пакость.
 */

const { Game, BETS, T } = require("./game");
const { decide, playCard, STRATEGIES } = require("./bots");

const GAMES = Number(process.argv[2] || 500);
const HUMAN_BET_MS = 18000; // среднее время фазы ставок с людьми (таймер 25 с, кто-то жмёт «Готово» раньше)

function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x % n;
  };
}

// Одна партия. seats — список стратегий; bonus — {seat, card}: этот игрок получает лишнюю карту на старте
function play(seats, seed, { pace = "normal", cards = true, bonus = null } = {}) {
  const rnd = rng(seed);
  const g = Game.create({ settings: { pace, cards }, rnd });
  seats.forEach((st, i) => g.addPlayer({ id: `p${i}`, name: `${st}${i}` }));
  g.start(0);
  if (bonus) g.s.players[bonus.seat].hand.push(bonus.card);
  const mem = {};
  let ms = 0;
  let spins = 0;
  const played = {};
  while (g.s.phase !== "finished" && spins < 400) {
    const s = g.s;
    if (s.phase === "betting") {
      spins++;
      for (const p of g.alive()) {
        const st = seats[Number(p.id.slice(1))];
        const m = (mem[p.id] = mem[p.id] || {});
        if (!p.frozen) {
          const bets = decide(st, { game: g, player: p, mem: m, rnd });
          const r = g.setBets(p.id, bets);
          if (!r.ok) throw new Error(`${st}: ${r.reason} ${JSON.stringify(bets)} stack ${p.stack}`);
        }
        if (cards) {
          const c = playCard(st, { game: g, player: p, rnd });
          if (c) {
            const r = g.playCard(p.id, c.card, c.target);
            if (r.ok) (played[p.id] = played[p.id] || []).push(c.card);
          }
        }
      }
      ms += HUMAN_BET_MS;
      g.close(ms);
      const r = s.result;
      ms = r.revealAt;
      g.tick(r.spinAt);
      g.tick(r.revealAt);
      // выплаты: запоминаем исход для стратегий, которым он нужен (мартингейл)
      for (const p of s.players) {
        const x = r.perPlayer[p.id];
        if (x && mem[p.id]) mem[p.id].lastNet = x.net;
      }
      ms += r.story.jackpot ? T.payoutJackpot : T.payout;
      g.tick(s.deadline);
    } else {
      g.tick(s.deadline || ms);
    }
  }
  return { winner: g.s.winnerId, minutes: ms / 60000, spins, reason: g.s.finishedReason, played, stories: g.s.storyCount };
}

const pct = (a, q) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function lengthReport() {
  console.log("\n=== длительность (смешанный стол, темп normal) ===");
  for (const n of [2, 4, 6, 8, 12]) {
    for (const pace of ["fast", "normal", "slow"]) {
      const mins = [];
      const spins = [];
      let capped = 0;
      for (let i = 0; i < GAMES; i++) {
        const seats = Array.from({ length: n }, (_, k) => STRATEGIES[(k + i) % STRATEGIES.length]);
        const r = play(seats, 1000 + i * 7919 + n, { pace });
        mins.push(r.minutes);
        spins.push(r.spins);
        if (r.spins >= 400) capped++;
      }
      console.log(`${String(n).padStart(2)} игроков, ${pace.padEnd(6)}: медиана ${pct(mins, 0.5).toFixed(1)} мин, p10 ${pct(mins, 0.1).toFixed(1)}, p90 ${pct(mins, 0.9).toFixed(1)}; спинов медиана ${pct(spins, 0.5)}, p90 ${pct(spins, 0.9)}${capped ? `, упёрлись в потолок: ${capped}` : ""}`);
    }
  }
}

function strategyReport() {
  console.log("\n=== стратегии (6 игроков, каждая по кругу на всех местах) ===");
  const n = 6;
  const wins = {};
  const seatsPlayed = {};
  for (let i = 0; i < GAMES * 2; i++) {
    const seats = Array.from({ length: n }, (_, k) => STRATEGIES[(k + i) % STRATEGIES.length]);
    const r = play(seats, 5000 + i * 104729);
    seats.forEach((st) => { seatsPlayed[st] = (seatsPlayed[st] || 0) + 1; });
    if (r.winner) {
      const st = seats[Number(r.winner.slice(1))];
      wins[st] = (wins[st] || 0) + 1;
    }
  }
  for (const st of STRATEGIES) {
    const share = (wins[st] || 0) / seatsPlayed[st];
    console.log(`${st.padEnd(10)} ${(share * 100).toFixed(1)}% побед на место (база ${(100 / n).toFixed(1)}%)`);
  }
}

function cardReport() {
  console.log("\n=== карты: игрок 0 получает лишнюю карту на старте (6 одинаковых ботов «cards») ===");
  const n = 6;
  const base = (() => {
    let w = 0;
    for (let i = 0; i < GAMES * 4; i++) if (play(Array(n).fill("cards"), 9000 + i * 31337).winner === "p0") w++;
    return w / (GAMES * 4);
  })();
  console.log(`без лишней карты: ${(base * 100).toFixed(1)}%`);
  for (const card of ["double", "freeze", "share", "eye", "shield"]) {
    let w = 0;
    for (let i = 0; i < GAMES * 4; i++) if (play(Array(n).fill("cards"), 9000 + i * 31337, { bonus: { seat: 0, card } }).winner === "p0") w++;
    const share = w / (GAMES * 4);
    console.log(`+${card.padEnd(7)} ${(share * 100).toFixed(1)}% (${share - base >= 0 ? "+" : ""}${((share - base) * 100).toFixed(1)} п.п.)`);
  }
}

function storyReport() {
  console.log("\n=== режиссёр: доля сюжетов (6 игроков) ===");
  const c = {};
  let total = 0;
  for (let i = 0; i < GAMES; i++) {
    const rnd = rng(77 + i);
    const g = Game.create({ settings: {}, rnd });
    const seats = Array.from({ length: 6 }, (_, k) => STRATEGIES[(k + i) % STRATEGIES.length]);
    seats.forEach((st, k) => g.addPlayer({ id: `p${k}`, name: st }));
    g.start(0);
    const mem = {};
    let ms = 0;
    while (g.s.phase !== "finished" && g.s.spin < 400) {
      if (g.s.phase !== "betting") { g.tick(g.s.deadline); continue; }
      for (const p of g.alive()) if (!p.frozen) g.setBets(p.id, decide(seats[Number(p.id.slice(1))], { game: g, player: p, mem: (mem[p.id] = mem[p.id] || {}), rnd }));
      ms += HUMAN_BET_MS;
      g.close(ms);
      const st = g.s.result.story;
      total++;
      c[st.path] = (c[st.path] || 0) + 1;
      if (st.allin.length) c.allin = (c.allin || 0) + 1;
      if (st.jackpot) c.jackpot = (c.jackpot || 0) + 1;
      if (st.save.length) c.save = (c.save || 0) + 1;
      if (st.zero) c.zero = (c.zero || 0) + 1;
      g.tick(g.s.deadline);
      g.tick(g.s.deadline);
    }
  }
  for (const [k, v] of Object.entries(c)) console.log(`${k.padEnd(8)} ${((v / total) * 100).toFixed(1)}%`);
  const special = ((total - (c.normal || 0)) / total) * 100;
  console.log(`особый путь шарика: ${special.toFixed(1)}%`);
}

const which = process.argv[3] || "all";
if (which === "all" || which === "length") lengthReport();
if (which === "all" || which === "strategy") strategyReport();
if (which === "all" || which === "cards") cardReport();
if (which === "all" || which === "story") storyReport();
