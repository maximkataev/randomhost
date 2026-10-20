"use strict";

/*
 * Стенд баланса блэкджека (blackjack-spec.md §12): партии на ботах без сети и таймеров.
 *   node sim.js [партий=500] [раздел=all|length|cards|story]
 * Длительность считаем по таймингам фаз движка; на «люди думают» кладём ~10 с в ставках и волнах
 * (таймер ставок 20 с, кто-то жмёт «Готово» раньше; волна 1 — 12 с, волны 2+ — 8 с).
 * Отчёт: медиана/p90 длительности и число раздач по форматам и числу игроков, доля побед стратегий против 1/N,
 * вклад каждой карты-пакости, доля сюжетов режиссёра.
 */

const { Game, T } = require("./game");
const { decideBet, decideAction, decideInsurance, playCard, STRATEGIES } = require("./bots");

const GAMES = Number(process.argv[2] || 500);
const HUMAN_MS = 10000; // «люди думают»: ставки и каждая волна решений
const FORMATS = ["last", "hands", "tournament"];

function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x % n;
  };
}

// Одна партия. seats — стратегии по местам; bonus — {seat, card}: игрок получает лишнюю карту-пакость на старте
function play(seats, seed, opts) {
  opts = opts || {};
  const rnd = rng(seed);
  const settings = { format: opts.format || "last", pace: opts.pace || "normal", cards: opts.cards !== false, handsTotal: opts.handsTotal || 20 };
  const g = Game.create({ settings, rnd });
  seats.forEach((st, i) => g.addPlayer({ id: `p${i}`, name: `${st}${i}` }));
  const r = g.start(0);
  if (!r.ok) throw new Error(r.reason);
  if (bonusOk(opts.bonus)) g.s.players[opts.bonus.seat].trick.push(opts.bonus.card);
  const mem = {};
  let ms = 0;
  let hands = 0;
  const plots = {};
  let guard = 0;
  while (g.s.phase !== "finished" && guard++ < 20000) {
    const s = g.s;
    if (s.phase === "betting") {
      hands++;
      for (const p of g.alive()) {
        const st = seats[Number(p.id.slice(1))];
        const m = (mem[p.id] = mem[p.id] || {});
        const b = decideBet(st, { game: g, player: p, mem: m, rnd });
        const res = b.allIn ? g.allIn(p.id) : g.setBets(p.id, b);
        if (!res.ok) throw new Error(`${st}: ${res.reason} ${JSON.stringify(b)} stack ${p.stack}`);
        if (settings.cards) {
          const c = playCard(st, { game: g, player: p, rnd });
          if (c) g.playCard(p.id, c.card, c.target);
        }
      }
      ms += Math.min(HUMAN_MS, s.deadline - ms);
      g.closeBets(ms);
    } else if (s.phase === "insurance") {
      if (s.dealer.insurance) {
        for (const p of g.inHand()) {
          if (g.s.phase !== "insurance") break;
          g.insure(p.id, decideInsurance(seats[Number(p.id.slice(1))], { game: g, player: p, rnd }), ms + T.insurance);
        }
      }
      if (g.s.phase === "insurance") { ms = s.deadline; g.tick(ms); } else ms += T.insurance;
    } else if (s.phase === "deciding") {
      const wave = s.wave;
      const start = s.waveStart;
      const think = Math.min(HUMAN_MS, s.deadline - start);
      for (const x of g.pending()) {
        if (g.s.phase !== "deciding" || g.s.wave !== wave) break;
        const st = seats[Number(x.p.id.slice(1))];
        const a = decideAction(st, { game: g, player: x.p, hand: x.h, handIdx: x.i, up: s.dealer.cards[0], options: g.options(x.p, x.h), rnd });
        const res = g.decide(x.p.id, x.i, a, start + think);
        if (!res.ok) throw new Error(`${st}: decide ${a} ${res.reason}`);
      }
      if (g.s.phase === "deciding" && g.s.wave === wave) { ms = s.deadline; g.tick(ms); } else ms = start + think;
    } else {
      if (s.phase === "dealer") plots[s.dealer.plot] = (plots[s.dealer.plot] || 0) + 1;
      ms = s.deadline;
      g.tick(ms);
    }
  }
  if (guard >= 20000) throw new Error("партия зациклилась");
  return { winner: g.s.winnerId, winnerIds: g.s.winnerIds, minutes: ms / 60000, hands, reason: g.s.finishedReason, plots };
}

function bonusOk(b) {
  return b && Number.isInteger(b.seat) && b.card;
}

const pct = (a, q) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const f1 = (x) => x.toFixed(1);

// длительность, число раздач и победы стратегий — один проход на каждую пару (игроков, формат)
function mainReport() {
  console.log(`\n=== партии по форматам (${GAMES} на точку, темп normal, стратегии по кругу на всех местах) ===`);
  const plotsAll = {};
  let plotsTotal = 0;
  for (const format of FORMATS) {
    console.log(`\n--- формат ${format}${format === "hands" ? " (20 раздач)" : ""} ---`);
    for (const n of [2, 4, 6, 8, 12]) {
      const mins = [];
      const hands = [];
      const wins = {};
      const seatsPlayed = {};
      let draws = 0;
      for (let i = 0; i < GAMES; i++) {
        const seats = Array.from({ length: n }, (_, k) => STRATEGIES[(k + i) % STRATEGIES.length]);
        const r = play(seats, 1000 + i * 7919 + n * 13 + FORMATS.indexOf(format), { format });
        mins.push(r.minutes);
        hands.push(r.hands);
        seats.forEach((st) => { seatsPlayed[st] = (seatsPlayed[st] || 0) + 1; });
        if (r.winnerIds.length > 1) draws++;
        for (const id of r.winnerIds) {
          const st = seats[Number(id.slice(1))];
          wins[st] = (wins[st] || 0) + 1 / r.winnerIds.length;
        }
        for (const k of Object.keys(r.plots)) { plotsAll[k] = (plotsAll[k] || 0) + r.plots[k]; plotsTotal += r.plots[k]; }
      }
      const base = 100 / n;
      const parts = STRATEGIES.map((st) => `${st} ${f1(((wins[st] || 0) / seatsPlayed[st]) * 100)}`);
      const worst = Math.max.apply(null, STRATEGIES.map((st) => ((wins[st] || 0) / seatsPlayed[st]) * 100 - base));
      console.log(`${String(n).padStart(2)} игроков: медиана ${f1(pct(mins, 0.5))} мин, p10 ${f1(pct(mins, 0.1))}, p90 ${f1(pct(mins, 0.9))}; раздач медиана ${pct(hands, 0.5)}, p10 ${pct(hands, 0.1)}, p90 ${pct(hands, 0.9)}${draws ? `; ничьих ${draws}` : ""}`);
      console.log(`            победы на место, % (база ${f1(base)}; худший перекос +${f1(worst)} п.п.): ${parts.join(", ")}`);
    }
  }
  console.log("\n=== режиссёр: доля сюжетов по всем раздачам выше ===");
  const keys = Object.keys(plotsAll).sort((a, b) => plotsAll[b] - plotsAll[a]);
  for (const k of keys) console.log(`${k.padEnd(9)} ${f1((plotsAll[k] / plotsTotal) * 100)}%`);
  console.log(`особых сюжетов (всё, кроме normal): ${f1(((plotsTotal - (plotsAll.normal || 0)) / plotsTotal) * 100)}%`);
}

// каждая карта-пакость: игрок 0 получает её лишней на старте, остальные равны (6 ботов «cards», «до последнего»)
function cardReport() {
  console.log(`\n=== карты-пакости: лишняя карта у игрока 0 на старте (6 ботов «cards», ${GAMES * 2} партий на карту) ===`);
  const n = 6;
  const runs = GAMES * 2;
  const share = (card) => {
    let w = 0;
    for (let i = 0; i < runs; i++) {
      const r = play(Array(n).fill("cards"), 9000 + i * 31337, { bonus: card ? { seat: 0, card } : null });
      if (r.winnerIds.indexOf("p0") >= 0) w += 1 / r.winnerIds.length;
    }
    return (w / runs) * 100;
  };
  const base = share(null);
  console.log(`без лишней карты: ${f1(base)}% (база ${f1(100 / n)})`);
  for (const card of ["peek", "redeal", "shield", "freeze", "extra", "swap", "tax", "doublemin"]) {
    const s = share(card);
    console.log(`+${card.padEnd(9)} ${f1(s)}% (${s - base >= 0 ? "+" : ""}${f1(s - base)} п.п.)`);
  }
}

// темп уровней: как меняется длительность «до последнего» на 6 игроков
function paceReport() {
  console.log(`\n=== темп уровней, «до последнего», 6 игроков ===`);
  for (const pace of ["fast", "normal", "slow"]) {
    const mins = [];
    const hands = [];
    for (let i = 0; i < GAMES; i++) {
      const seats = Array.from({ length: 6 }, (_, k) => STRATEGIES[(k + i) % STRATEGIES.length]);
      const r = play(seats, 4000 + i * 104729, { pace });
      mins.push(r.minutes);
      hands.push(r.hands);
    }
    console.log(`${pace.padEnd(6)}: медиана ${f1(pct(mins, 0.5))} мин, p90 ${f1(pct(mins, 0.9))}; раздач медиана ${pct(hands, 0.5)}, p90 ${pct(hands, 0.9)}`);
  }
}

const which = process.argv[3] || "all";
if (which === "all" || which === "length") mainReport();
if (which === "all" || which === "pace") paceReport();
if (which === "all" || which === "cards") cardReport();
