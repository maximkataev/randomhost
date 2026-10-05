"use strict";
/*
 * Стенд баланса Камеры (lastq-spec.md §4.3). Настоящие генераторы и правила (решётка, minMs, веса),
 * модель игрока — время и вероятность ошибки по типу испытания.
 *
 *   node bench-cell.js            — таблица: спасаемость по наборам и ступеням, честный и тыкальщик
 *   node bench-cell.js b2=10000   — то же с другим бюджетом ступени; LQ_LEVELS='{"hands":[2,2,3],…}' — другая таблица уровней
 *   node bench-cell.js --types    — среднее время и ошибка каждого испытания (для подбора уровней)
 *
 * Цели (§4.3): тыкальщик ≤ 30 %; разброс наборов у честного ≤ ±10 п. п.; честный ≈ 75 / 60 / 45 %.
 * Модель честного игрока — оценка (не замер); после плейтеста агентами поправить таблицу HUMAN.
 */
const C = require("./challenges.js");

function mulberry(seed) {
  return (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

// Честный игрок: сколько мс он тратит сверх неизбежного (показ, анимация, minMs) и как часто ошибается.
// [доп. время на уровнях 1/2/3, вероятность ошибки на уровнях 1/2/3]
const HUMAN = {
  // ловкость: время в основном — сами тапы/ожидание, его считает base()
  wires: [[700, 900, 1100], [0.02, 0.03, 0.05]],
  swipe: [[900, 1200, 1500], [0.04, 0.06, 0.08]],
  hold: [[900, 900, 900], [0.04, 0.07, 0.12]],
  order: [[900, 1300, 1800], [0.02, 0.04, 0.06]],
  nopress: [[700, 700, 700], [0.08, 0.12, 0.18]],
  catch: [[900, 1300, 1700], [0.02, 0.04, 0.06]],
  spark: [[800, 1000, 1200], [0.08, 0.15, 0.25]],
  rhythm: [[400, 400, 400], [0.1, 0.15, 0.25]],
  coward: [[1000, 1300, 1700], [0.03, 0.05, 0.08]],
  dig: [[600, 800, 1000], [0.0, 0.0, 0.0]],
  saw: [[900, 1600, 2300], [0.0, 0.0, 0.0]],
  lockpick: [[700, 900, 1100], [0.12, 0.2, 0.3]],
  searchlight: [[800, 1000, 1200], [0.08, 0.15, 0.22]],
  // внимание
  color: [[1200, 1500, 1900], [0.08, 0.12, 0.16]],
  odd: [[1000, 1400, 2200], [0.02, 0.05, 0.12]],
  code: [[900, 1300, 1800], [0.03, 0.08, 0.15]],
  count: [[2000, 2800, 3500], [0.06, 0.12, 0.2]],
  letter: [[1500, 2200, 3000], [0.03, 0.05, 0.1]],
  sad: [[1000, 1500, 2200], [0.02, 0.05, 0.12]],
  shells: [[800, 800, 900], [0.1, 0.2, 0.35]],
  simon: [[1200, 1500, 1900], [0.06, 0.12, 0.22]],
  blink: [[800, 900, 1000], [0.15, 0.25, 0.4]],
  flashes: [[900, 900, 900], [0.06, 0.12, 0.2]],
  diff: [[2200, 3800, 4800], [0.04, 0.08, 0.15]],
  lineup: [[1300, 1600, 2000], [0.05, 0.12, 0.25]],
  rollcall: [[300, 300, 300], [0.05, 0.1, 0.18]],
  keys: [[1400, 3300, 4300], [0.04, 0.1, 0.2]],
  cipher: [[2000, 3800, 4800], [0.04, 0.1, 0.2]],
  pass: [[4500, 4500, 5000], [0.05, 0.08, 0.1]],
  // голова (сверх MIN_HEAD = 1200)
  quiz: [[3000, 3600, 4200], [0.15, 0.25, 0.35]],
  sudoku: [[2000, 3500, 5000], [0.05, 0.1, 0.18]],
  seq: [[1500, 2500, 3500], [0.06, 0.12, 0.22]],
  math: [[800, 1800, 2800], [0.03, 0.08, 0.15]],
  tf: [[2000, 2400, 2800], [0.25, 0.3, 0.35]],
  heavy: [[1200, 1500, 1800], [0.15, 0.2, 0.25]],
  chrono: [[3500, 4500, 5500], [0.15, 0.25, 0.35]],
  manual: [[3500, 4500, 5500], [0.12, 0.2, 0.3]],
  rebus: [[2500, 3500, 4500], [0.2, 0.3, 0.4]],
  oddmeaning: [[1200, 1600, 2400], [0.04, 0.08, 0.15]],
  dice: [[1200, 1800, 2600], [0.03, 0.06, 0.1]],
  codelock: [[3000, 4500, 6000], [0.08, 0.15, 0.25]],
  scales: [[2300, 2800, 3600], [0.05, 0.1, 0.18]],
  clock: [[1200, 2000, 3500], [0.05, 0.1, 0.2]],
  guard: [[700, 800, 900], [0.06, 0.12, 0.22]],
};

// Неизбежное время: показ, анимации, расписание тапов — из самого испытания
function base(ch) {
  const v = ch.view, a = ch.answer;
  switch (ch.type) {
    case "wires": return v.n * 250;
    case "order": return v.n * 300;
    case "catch": return v.hits * 450;
    case "coward": return v.hits * 500;
    case "spark": return v.n * 280;
    case "swipe": return v.dirs.length * 350;
    case "dig": return v.n * 140;
    case "saw": return v.bars * v.strokes * 260;
    case "lockpick": case "searchlight": return a[a.length - 1] + 300;
    case "rollcall": return a[0] + 250;
    case "hold": return v.from + 200;
    case "rhythm": { const S = v.gaps.reduce((a, b) => a + b, 0); return v.lead + S + 500 + S; } // слушает, потом выстукивает
    case "pass": return 0;
    default: return ch.minMs;
  }
}
// у тыкальщика выбор наугад: столько вариантов
function choices(ch) {
  const v = ch.view;
  switch (ch.type) {
    case "tf": case "heavy": return 2;
    case "chrono": return 6;
    case "sudoku": return v.options.length;
    case "odd": case "letter": case "sad": case "blink": case "oddmeaning": return v.items.length;
    case "diff": return v.side * v.side;
    case "guard": return 9;
    case "cipher": return 28;
    case "shells": return v.cups;
    case "lineup": return 4;
    case "keys": return v.keys.length;
    case "manual": return v.wires.length;
    default: return v.options ? v.options.length : 0; // 0 — наугад не ответить, надо делать
  }
}

// множители модели: времени «думания», ошибок; RTT — сеть + проверка сервером на каждое испытание
const MODEL = { tm: 1, em: 1, rtt: 200 };
function lognorm(rnd, mean) {
  // разброс ±40 % вокруг среднего
  const u = (rnd(10000) + 0.5) / 10000;
  return mean * Math.exp(0.35 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * ((rnd(10000) + 0.5) / 10000)) - 0.06);
}

// одна Камера: need испытаний за budget мс; mode — "honest" | "tapper"
function cell({ lvl, stage, group, need, budget, mode, rnd, canPass }) {
  let t = 0, done = 0, last = null;
  const seen = [], used = {};
  while (t < budget) {
    const ch = C.generate({ lvl, stage, rnd, group, last, seen, used, canPass });
    seen.push(ch.type); last = ch.type;
    const n = choices(ch);
    let dt, ok;
    if (mode === "tapper" && n > 0) {
      dt = ch.minMs + MODEL.rtt; // жмёт сразу, как только примут
      ok = rnd(n) === 0;
    } else {
      const [extra, err] = HUMAN[ch.type] || [[2000, 2000, 2000], [0.1, 0.1, 0.1]];
      dt = Math.max(ch.minMs, base(ch) + lognorm(rnd, extra[lvl - 1] * MODEL.tm)) + MODEL.rtt;
      ok = rnd(1000) >= Math.min(0.95, err[lvl - 1] * MODEL.em) * 1000;
    }
    t += dt;
    if (t > budget) break;
    if (ok) { done++; if (done >= need) return { escaped: true, t }; }
    else t += C.WRONG_LOCK_MS;
  }
  return { escaped: false, t };
}

// уровень испытаний набора на этой ступени — по таблице C.LEVELS, время — C.cellMs(набор, ступень)
function rate(opts, runs) {
  opts = { ...opts, stage: opts.lvl, lvl: C.levelFor(opts.group, opts.lvl), budget: opts.budget || C.cellMs(opts.group, opts.lvl) };
  const rnd = mulberry(opts.seed || 1);
  let esc = 0, tsum = 0;
  for (let i = 0; i < runs; i++) { const r = cell({ ...opts, rnd }); if (r.escaped) { esc++; tsum += r.t; } }
  return { p: esc / runs, t: esc ? tsum / esc / 1000 : 0 };
}

const RUNS = 4000;
// ручки стенда: LQ_LEVELS / LQ_CELL (JSON) подменяют таблицы на месте — только здесь, прод их не читает
if (process.env.LQ_LEVELS) Object.assign(C.LEVELS, JSON.parse(process.env.LQ_LEVELS));
if (process.env.LQ_CELL) JSON.parse(process.env.LQ_CELL).forEach((x, i) => Object.assign(C.CELL[i].ms, x));
const STAGES = [
  { name: "Акт 1", lvl: 1, need: C.CELL[0].need, target: 0.75 },
  { name: "Акт 2", lvl: 2, need: C.CELL[1].need, target: 0.6 },
  { name: "Финал", lvl: 3, need: C.CELL[2].need, target: 0.45 },
];
const MEAN_TOL = 0.07; // среднее ступени — в пределах ±7 п. п. от цели

if (process.argv.includes("--types")) {
  const rnd = mulberry(5);
  for (const lvl of [1, 2, 3]) {
    console.log(`\nуровень ${lvl}: тип — среднее время честного, с; ошибка`);
    const rows = [];
    for (const t of Object.values(C.GROUPS).flat()) {
      let s = 0;
      for (let i = 0; i < 300; i++) {
        const ch = C.generate({ lvl, rnd, only: t, used: {} });
        const [extra] = HUMAN[t];
        s += Math.max(ch.minMs + 60, base(ch) + extra[lvl - 1]);
      }
      rows.push([t, s / 300 / 1000, HUMAN[t][1][lvl - 1]]);
    }
    rows.sort((a, b) => b[1] - a[1]);
    for (const [t, sec, e] of rows) console.log(`  ${t.padEnd(12)} ${sec.toFixed(1).padStart(4)} с  ${(e * 100).toFixed(0).padStart(2)} %`);
  }
} else {
  const run = (quiet) => {
    let bad = 0;
    const out = [];
    for (const st of STAGES) {
      const ps = [];
      const lines = [];
      for (const group of Object.keys(C.GROUPS)) {
        const h = rate({ ...st, group, mode: "honest", canPass: true }, RUNS);
        // в «Ловкости» угадывать нечего — тыкальщик там просто играет честно, считаем только где есть выбор
        const k = group === "hands" ? null : rate({ ...st, group, mode: "tapper", canPass: true }, RUNS);
        ps.push(h.p);
        if (k && k.p > 0.3) bad++;
        lines.push(`  ${group.padEnd(6)} ${(C.cellMs(group, st.lvl) / 1000).toFixed(1).padStart(4)} с, ур. ${C.levelFor(group, st.lvl)}   честный ${(h.p * 100).toFixed(0).padStart(3)} %   тыкальщик ${k ? (k.p * 100).toFixed(0).padStart(3) + " %" : "  —"}${k && k.p > 0.3 ? "  ← > 30 %" : ""}`);
      }
      const spread = Math.max(...ps) - Math.min(...ps);
      const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
      if (spread > 0.2) bad++;
      if (Math.abs(avg - st.target) > MEAN_TOL) bad++;
      out.push({ name: st.name, avg, spread, ps });
      if (!quiet) {
        console.log(`\n${st.name}: ${st.need} испытания, цель честного ${st.target * 100} % ± ${MEAN_TOL * 100}`);
        lines.forEach((l) => console.log(l));
        console.log(`  среднее ${(avg * 100).toFixed(0)} %, разброс наборов ${(spread * 100).toFixed(0)} п. п. (норма ≤ 20)`);
      }
    }
    return { bad, out };
  };
  const main = run(false);
  console.log(main.bad ? `\nНЕ В НОРМЕ: ${main.bad}` : "\nвсё в норме");
  // чувствительность: люди медленнее/быстрее модели, ошибаются чаще
  console.log("\nчувствительность (среднее / разброс по ступеням):");
  for (const [name, m] of [["время ×0,8", { tm: 0.8 }], ["время ×1,3", { tm: 1.3 }], ["ошибки ×1,5", { em: 1.5 }]]) {
    Object.assign(MODEL, { tm: 1, em: 1 }, m);
    const r = run(true);
    console.log(`  ${name.padEnd(12)} ` + r.out.map((x) => `${x.name} ${(x.avg * 100).toFixed(0)} % / ${(x.spread * 100).toFixed(0)}`).join("   "));
  }
  process.exitCode = main.bad ? 1 : 0;
}
