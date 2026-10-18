"use strict";

/*
 * Стенд на ботах (bets-spec.md §12): длительность партии, победы по стратегиям, прибыль казино.
 * Запуск: node sim.js [партий на конфигурацию] [лимит событий: 12 | 0]
 * Реальные события заменяются сценическими (источника нет), mode = "scenic": математика та же.
 */
const { Game } = require("./game");

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}

const around = (g, p, share) => Math.max(10, Math.min(p.stack, Math.round(g.s.settings.stack * share / 10) * 10));

// Каждая стратегия собирает купон: [[marketId, stake], ...]
const STRATEGIES = {
  // ставит ровно минимум на самый вероятный рынок
  minimum(g, p, rnd) {
    const ms = g.cur.markets.slice().sort((a, b) => b.p - a.p);
    return [[ms[0].id, g.minStake(p)]];
  },
  // 15% стека на рынок с вероятностью около половины
  coin(g, p, rnd) {
    const ms = g.cur.markets.filter((m) => m.p > 0.35 && m.p < 0.65);
    const m = (ms.length ? ms : g.cur.markets)[rnd(ms.length || g.cur.markets.length)];
    return [[m.id, Math.max(g.minStake(p), around(g, p, 0.15))]];
  },
  // длинные коэффициенты: 20% стека на рынок с k от 8 до 40
  long(g, p, rnd) {
    const ms = g.cur.markets.filter((m) => m.kc >= 800 && m.kc <= 4000);
    if (!ms.length) return [[g.cur.markets[0].id, g.minStake(p)]];
    return [[ms[rnd(ms.length)].id, Math.max(g.minStake(p), around(g, p, 0.2))]];
  },
  // осторожно, пока впереди; ва-банк на ~3×, когда отстаёшь от среднего
  chaser(g, p, rnd) {
    const alive = g.alive();
    const avg = alive.reduce((a, x) => a + x.stack, 0) / alive.length;
    if (p.stack >= avg) return STRATEGIES.minimum(g, p, rnd);
    const ms = g.cur.markets.filter((m) => m.kc >= 250 && m.kc <= 500);
    const m = (ms.length ? ms : g.cur.markets)[rnd(ms.length || g.cur.markets.length)];
    return [[m.id, Math.max(g.minStake(p), Math.min(p.stack, Math.round(p.stack * 0.6 / 10) * 10))]];
  },
  // ва-банк на один рынок с p около трети
  allin(g, p, rnd) {
    const ms = g.cur.markets.filter((m) => m.p > 0.25 && m.p < 0.45);
    const m = (ms.length ? ms : g.cur.markets)[rnd(ms.length || g.cur.markets.length)];
    return [[m.id, p.stack]];
  },
};
const NAMES = Object.keys(STRATEGIES);

function playGame(seed, n, limit, fixed) {
  const rnd = mulberry(seed);
  const g = new Game(rnd);
  g.setSettings({ mode: "scenic", events: limit });
  const strat = {};
  for (let i = 0; i < n; i++) { g.addPlayer("p" + i, "P" + i); strat["p" + i] = fixed ? fixed[i] : NAMES[(i + seed) % NAMES.length]; }
  let now = 0;
  g.start(now);
  let staked = 0, paid = 0, guard = 0;
  while (g.s.phase !== "done" && guard++ < 2000) {
    if (g.s.phase === "bets") {
      for (const p of g.alive()) {
        for (const [id, stake] of STRATEGIES[strat[p.id]](g, p, rnd)) g.bet(p.id, id, Math.min(stake, p.stack - Object.values(p.draft).reduce((a, b) => a + b, 0)));
      }
      now += 12000; // люди сдают в среднем за 12 с
      for (const p of g.alive()) g.submit(p.id, now);
    }
    if (g.s.phase === "payout") for (const p of Object.values(g.s.players)) if (p.last) { staked += p.last.staked + p.last.penalty; paid += p.last.won; }
    now = Math.max(now, g.nextDeadline()); g.tick(now);
  }
  return { winnerId: g.s.winner, winner: strat[g.s.winner], seats: Object.values(strat), minutes: now / 60000, events: g.s.idx + 1, staked, paid };
}

function pct(a, q) { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

// Симметричный турнир: один игрок со стратегией S против остальных с базовой (честной) стратегией.
// Показывает, обыгрывает ли стратегия «среднего» игрока: победа сверх 1/N — преимущество стратегии.
function deviation(games, n, limit, base) {
  const rows = [];
  for (const dev of NAMES) {
    let wins = 0;
    for (let i = 0; i < games; i++) {
      const fixed = Array(n).fill(base); const seat = i % n; fixed[seat] = dev;
      const r = playGame(77000 + i * 13 + n, n, limit, fixed);
      if (r.winner === dev && (dev !== base)) wins += r.wonBySeat === seat ? 1 : 0;
    }
    rows.push({ dev, wins });
  }
  return rows;
}

if (require.main === module && process.argv[2] === "dev") {
  const games = Number(process.argv[3]) || 600, limit = 12;
  for (const n of [4, 6, 8]) {
    for (const base of ["coin", "minimum", "chaser"]) {
      const out = [];
      for (const dev of NAMES) {
        if (dev === base) continue;
        let w = 0;
        for (let i = 0; i < games; i++) {
          const fixed = Array(n).fill(base); const seat = i % n; fixed[seat] = dev;
          const r = playGame(1000 + i * 31 + n, n, limit, fixed);
          if (r.winnerId === "p" + seat) w++;
        }
        out.push(`${dev} ${(w / games * 100).toFixed(0)}%`);
      }
      console.log(`Игроков ${n}, остальные «${base}» (база ${(100 / n).toFixed(0)}%): ` + out.join(", "));
    }
  }
} else if (require.main === module) {
  const games = Number(process.argv[2]) || 300;
  const limit = process.argv[3] === undefined ? 12 : Number(process.argv[3]);
  console.log(`Партий на конфигурацию: ${games}, лимит событий: ${limit || "нет"}`);
  for (const n of [2, 4, 6, 8, 12]) {
    const res = [];
    for (let i = 0; i < games; i++) res.push(playGame(1000 * n + i, n, limit));
    const wins = {}, seats = {};
    res.forEach((r) => { wins[r.winner] = (wins[r.winner] || 0) + 1; r.seats.forEach((k) => (seats[k] = (seats[k] || 0) + 1)); });
    const mins = res.map((r) => r.minutes), evs = res.map((r) => r.events);
    const staked = res.reduce((a, r) => a + r.staked, 0), paid = res.reduce((a, r) => a + r.paid, 0);
    console.log(`\nИгроков ${n}: длительность медиана ${pct(mins, 0.5).toFixed(1)} мин, p90 ${pct(mins, 0.9).toFixed(1)}; событий медиана ${pct(evs, 0.5)}, p90 ${pct(evs, 0.9)}`);
    console.log("  побед на одного игрока этой стратегии (база " + (100 / n).toFixed(0) + "%): " + NAMES.map((k) => `${k} ${seats[k] ? ((wins[k] || 0) / seats[k] * 100).toFixed(0) : "-"}%`).join(", "));
    console.log(`  возврат ставок казино: ${(paid / staked * 100).toFixed(1)}% (ставки+штрафы ${staked}, выплаты ${paid})`);
  }
}

module.exports = { playGame, STRATEGIES };
