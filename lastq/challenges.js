"use strict";

/*
 * Испытания Камеры «Последнего вопроса» (lastq-spec.md §4). Форк bomb/challenges.js:
 * бомбовые генераторы взяты как есть, к ним добавлены свои испытания побега и правила Камеры.
 * Дальше живут отдельно от «Бомбы» — правка здесь бомбу не трогает и наоборот.
 *
 * Генератор отдаёт { type, group, lvl, view, answer, minMs }:
 *   view   — что рисует телефон: уходит клиенту;
 *   answer — правильный ответ: живёт только на сервере;
 *   minMs  — быстрее этого ответ не принимаем (живой человек не успеет — значит, скрипт или тыканье).
 * Тексты из банка вопросов идут во view сразу на трёх языках: язык выбирает клиент.
 *
 * Файл работает и в node (сервер, тесты), и в браузере (lastq-lab.html): там банк кладётся через setBank.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LQ_CHALLENGES = factory();
})(typeof self !== "undefined" ? self : this, function () {

const GROUPS = {
  hands: ["wires", "swipe", "hold", "order", "nopress", "catch", "spark", "rhythm", "coward", "dig", "saw", "lockpick", "searchlight"],
  eyes: ["color", "odd", "code", "count", "letter", "sad", "shells", "simon", "blink", "flashes", "diff", "lineup", "rollcall", "keys", "cipher", "pass"],
  head: ["quiz", "sudoku", "seq", "math", "tf", "heavy", "chrono", "manual", "rebus", "oddmeaning", "dice", "codelock", "scales", "clock", "guard"],
};
const TYPE_GROUP = {};
for (const [g, types] of Object.entries(GROUPS)) for (const t of types) TYPE_GROUP[t] = g;
// свои испытания: в Камере выпадают вдвое чаще бомбовых (§4.1)
const OWN = new Set(["dig", "saw", "lockpick", "searchlight", "lineup", "rollcall", "keys", "cipher", "codelock", "scales", "clock", "guard", "pass"]);
const OWN_WEIGHT = 2;
// долгие (5–8 с): три таких не влезают в Камеру Актов 1–2 (11–12 с) — даём только в финальной (§4.1)
const SLOW = new Set(["chrono", "manual", "rebus"]);
// на запоминание: доска их не рисует, иначе они тривиальны (§4.1). Код «Передачки» доска показывает отдельно, после тишины (§4.2)
const MEMORY_TYPES = ["code", "lineup", "guard", "simon", "shells", "blink", "flashes"];
const QUIZ_TYPES = ["quiz", "tf", "heavy", "chrono", "rebus"];
const BANK_TYPES = new Set(QUIZ_TYPES);

// Минимальное время ответа: руки и глаза — 400 мс, голова — 1200 мс (§4.1, против тыканья наугад)
const MIN_FAST = 400;
const MIN_HEAD = 1200;
// Ошибся — решётка захлопывается на 1,5 с, потом следующее испытание (§4.1)
const WRONG_LOCK_MS = 1500;
// Баланс наборов (стенд bench-cell.js, §4.3): ступень Камеры (1 — Акт 1, 2 — Акт 2, 3 — финал) → уровень испытаний набора.
// «Ловкость» сама по себе быстрая, «Голова» — медленная: без сдвига разброс спасаемости 30–45 п. п.
// Значения подобраны стендом; стенд меняет их на месте (объекты общие), прод — никогда.
const LEVELS = { hands: [2, 2, 3], eyes: [1, 2, 3], head: [1, 1, 2] };
// Камера по ступеням: сколько испытаний пройти и за сколько мс — время своё у каждого набора (плавная ручка баланса, §4.3)
const CELL = [
  { need: 3, ms: { hands: 12000, eyes: 12000, head: 12500 } }, // стенд 05.10: 74 / 77 / 73 %
  { need: 3, ms: { hands: 10500, eyes: 14000, head: 11500 } }, //            58 / 66 / 63 %
  { need: 5, ms: { hands: 22000, eyes: 27000, head: 27000 } }, //            44 / 52 / 56 %
];
// перед первым испытанием — секунда «Приготовься» вне бюджета: в этот момент узник смотрит на доску (§4.1)
const CELL_READY_MS = 1000;
const stageIdx = (stage) => Math.max(1, Math.min(3, stage || 1)) - 1;
function levelFor(group, stage) { return (LEVELS[group] || LEVELS.hands)[stageIdx(stage)]; }
function cellMs(group, stage) { const m = CELL[stageIdx(stage)].ms; return m[group] || m.hands; }
// глифов «Шифра на стене» — столько же нарисовано в lastq-challenges.js
const GLYPH_COUNT = 10;

let BANK = null;
function bank() {
  if (BANK) return BANK;
  try { BANK = require("./questions.json"); } catch (e) { BANK = {}; }
  for (const k of QUIZ_TYPES) if (!Array.isArray(BANK[k])) BANK[k] = [];
  return BANK;
}
function setBank(b) { BANK = b || {}; for (const k of QUIZ_TYPES) if (!Array.isArray(BANK[k])) BANK[k] = []; }

// ---------- мелочи ----------

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pick = (arr, rnd) => arr[rnd(arr.length)];
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const by = (lvl, a, b, c) => [a, b, c][Math.max(1, Math.min(3, lvl)) - 1];

// ответ + три отвлекающих числа рядом с ним, всё положительное и без повторов
function numberOptions(right, rnd, near) {
  const set = new Set([right]);
  const cands = shuffle((near || []).concat([right + 1, right - 1, right + 2, right - 2, right + 10, right - 10, right * 2]), rnd);
  for (const c of cands) { if (set.size >= 4) break; if (Number.isInteger(c) && c >= 0 && c !== right) set.add(c); }
  for (let k = 3; set.size < 4; k++) set.add(right + k);
  const options = shuffle([...set], rnd);
  return { options, answer: options.indexOf(right) };
}

// индекс в банке, который ещё не выпадал в партии; кончились — начинаем круг заново
function takeIndex(list, used, rnd, filter) {
  let idx = range(0, list.length - 1).filter((i) => !used.includes(i) && (!filter || filter(list[i])));
  if (!idx.length) {
    used.length = 0;
    idx = range(0, list.length - 1).filter((i) => !filter || filter(list[i]));
  }
  if (!idx.length) return -1;
  const i = pick(idx, rnd);
  used.push(i);
  return i;
}

// ---------- генераторы ----------

const COLOR_KEYS = ["red", "blue", "green", "yellow", "purple", "orange"];
const ODD_PAIRS = [
  [["🐶", "🐱"], ["🍎", "🍌"], ["⚽", "🏀"], ["🚗", "🚲"], ["🌞", "🌧️"], ["🐸", "🐙"]],
  [["🐶", "🐺"], ["🍎", "🍅"], ["🐱", "🦁"], ["🍋", "🍌"], ["🐝", "🪲"], ["🚕", "🚗"]],
  [["😀", "😃"], ["🙂", "🙃"], ["🕐", "🕑"], ["😐", "😑"], ["🌕", "🌝"], ["🐤", "🐥"]],
];
const LETTER_PAIRS = [[["O", "Q"], ["E", "F"], ["X", "Y"]], [["B", "8"], ["M", "N"], ["P", "R"]], [["O", "0"], ["I", "l"], ["S", "5"]]];
const HAPPY = [["😀", "😄", "😁", "😊", "😃", "😆"], ["😀", "😄", "😊", "🙂", "😃"], ["🙂"]];
const SAD = [["😢", "😭"], ["🙁", "😞"], ["🙁"]];
const PATTERN = ["🍏", "🍌", "🍒", "🍇", "🥝", "🍊"];
const DIRS = ["u", "d", "l", "r"];
// треугольная волна 0…1…0 с периодом 1: так ходят штифты «Отмычки» и луч «Прожектора»
function tri(x) { const f = ((x % 1) + 1) % 1; return f < 0.5 ? f * 2 : 2 - f * 2; }

// подсказки «Кодового замка»: данные, текст рисует клиент (cl_<k>)
function makeClue(kind, a, b, code, rnd) {
  switch (kind) {
    case "sum": return { k: "sum", n: a + b };
    case "diff": return a > b ? { k: "diff", n: a - b } : { k: "less", n: b - a };
    case "prod": return { k: "prod", n: a * b };
    case "twice": return b === a * 2 ? { k: "twice" } : a === b * 2 ? { k: "twice1" } : null;
    case "parity": { const pos = rnd(2), d = pos ? b : a; return { k: (d % 2 ? "odd" : "even") + pos }; }
    case "cmp": {
      if (rnd(2)) { const n = code - 1 - rnd(15); return n >= 10 ? { k: "gt", n } : null; }
      const n = code + 1 + rnd(15);
      return n <= 99 ? { k: "lt", n } : null;
    }
  }
  return null;
}
function clueOk(c, x) {
  const a = Math.floor(x / 10), b = x % 10;
  switch (c.k) {
    case "sum": return a + b === c.n;
    case "diff": return a - b === c.n;
    case "less": return b - a === c.n;
    case "prod": return a * b === c.n;
    case "twice": return b === a * 2;
    case "twice1": return a === b * 2;
    case "even0": return a % 2 === 0;
    case "odd0": return a % 2 === 1;
    case "even1": return b % 2 === 0;
    case "odd1": return b % 2 === 1;
    case "gt": return x > c.n;
    case "lt": return x < c.n;
  }
  return false;
}

const GEN = {
  // ---- ловкость ----
  wires(lvl) {
    const n = by(lvl, 3, 5, 7);
    return { view: { n }, answer: n, minMs: MIN_FAST + n * 90 };
  },
  swipe(lvl, rnd) {
    const n = by(lvl, 1, 2, 3);
    const dirs = [];
    for (let i = 0; i < n; i++) dirs.push(pick(DIRS.filter((d) => d !== dirs[i - 1]), rnd));
    return { view: { dirs }, answer: dirs, minMs: MIN_FAST + (n - 1) * 150 };
  },
  hold(lvl, rnd) {
    // полоса заполняется за 2 с; зелёная зона тем уже, чем выше уровень
    const full = 2000;
    const width = by(lvl, 600, 420, 260);
    const from = 700 + rnd(full - 700 - width - 100);
    return { view: { full, from, to: from + width }, answer: [from - 80, from + width + 80], minMs: Math.max(MIN_FAST, from - 80) };
  },
  order(lvl) {
    const n = by(lvl, 5, 7, 9);
    return { view: { n }, answer: range(1, n), minMs: MIN_FAST + n * 110 };
  },
  nopress(lvl, rnd) {
    const wait = 1800 + rnd(by(lvl, 600, 1000, 1400));
    return { view: { wait, fakes: by(lvl, 0, 1, 2) }, answer: wait, minMs: wait };
  },
  catch(lvl) {
    const hits = by(lvl, 2, 3, 4);
    return { view: { hits, speed: by(lvl, 1, 1.3, 1.6) }, answer: hits, minMs: MIN_FAST + hits * 180 };
  },

  // ---- внимание ----
  color(lvl, rnd) {
    const options = shuffle(COLOR_KEYS, rnd).slice(0, by(lvl, 3, 4, 6));
    const ink = pick(options, rnd);
    const word = pick(options.filter((c) => c !== ink), rnd);
    return { view: { word, ink, options }, answer: options.indexOf(ink), minMs: MIN_FAST };
  },
  odd(lvl, rnd) {
    const n = by(lvl, 4, 6, 9);
    const [a, b] = shuffle(pick(ODD_PAIRS[lvl - 1], rnd), rnd);
    const at = rnd(n);
    const items = range(0, n - 1).map((i) => (i === at ? b : a));
    return { view: { items }, answer: at, minMs: MIN_FAST };
  },
  code(lvl, rnd) {
    const n = by(lvl, 2, 3, 4);
    let digits = "";
    for (let i = 0; i < n; i++) digits += String(rnd(10));
    return { view: { digits, show: 1000 }, answer: digits, minMs: 1000 + MIN_FAST };
  },
  count(lvl, rnd) {
    const total = by(lvl, 9, 12, 16);
    const ducks = 3 + rnd(by(lvl, 4, 6, 7));
    const others = by(lvl, ["🐔"], ["🐥", "🐔"], ["🐥", "🐤", "🐔"]);
    const items = shuffle(range(1, total).map((i) => (i <= ducks ? "🦆" : pick(others, rnd))), rnd);
    const { options, answer } = numberOptions(ducks, rnd, [ducks + 1, ducks - 1, ducks + 2]);
    return { view: { items, options }, answer, minMs: MIN_FAST + 300 };
  },
  letter(lvl, rnd) {
    const n = by(lvl, 12, 16, 20);
    const [a, b] = pick(LETTER_PAIRS[lvl - 1], rnd);
    const at = rnd(n);
    return { view: { items: range(0, n - 1).map((i) => (i === at ? b : a)) }, answer: at, minMs: MIN_FAST };
  },
  sad(lvl, rnd) {
    const n = by(lvl, 6, 9, 12);
    const at = rnd(n);
    const items = range(0, n - 1).map((i) => (i === at ? pick(SAD[lvl - 1], rnd) : pick(HAPPY[lvl - 1], rnd)));
    return { view: { items }, answer: at, minMs: MIN_FAST };
  },

  // ---- голова ----
  sudoku(lvl, rnd) {
    const N = lvl === 1 ? 3 : 4;
    const rows = shuffle(range(0, N - 1), rnd), cols = shuffle(range(0, N - 1), rnd), sym = shuffle(range(1, N), rnd);
    const grid = rows.map((r) => cols.map((c) => sym[(r + c) % N]));
    const tr = rnd(N), tc = rnd(N);
    const cells = grid.map((row) => row.slice());
    const value = cells[tr][tc];
    cells[tr][tc] = null;
    if (lvl === 3) {
      // ещё три пустые клетки, но одна линия через «?» остаётся полной — ответ однозначен
      const keepRow = rnd(2) === 0;
      const free = [];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (r === tr && c === tc) continue;
        if (keepRow ? r === tr : c === tc) continue;
        free.push([r, c]);
      }
      for (const [r, c] of shuffle(free, rnd).slice(0, 3)) cells[r][c] = null;
    }
    return { view: { n: N, cells, target: [tr, tc], options: range(1, N) }, answer: value, minMs: MIN_HEAD };
  },
  seq(lvl, rnd) {
    const kinds = by(lvl, ["arith", "pattern2", "days"], ["arith", "geo2", "pattern3", "days2", "down"], ["squares", "fib", "geo3", "pattern_abb", "arith_big", "alt"]);
    const kind = pick(kinds, rnd);
    let items, right, near = [];
    if (kind === "days" || kind === "days2") {
      const step = kind === "days" ? 1 : 2;
      const s0 = rnd(7);
      items = range(0, 3).map((i) => (s0 + i * step) % 7);
      right = (s0 + 4 * step) % 7;
      const opts = shuffle([right, ...shuffle(range(0, 6).filter((d) => d !== right), rnd).slice(0, 3)], rnd);
      return { view: { kind: "days", items, options: opts }, answer: opts.indexOf(right), minMs: MIN_HEAD };
    }
    if (kind.startsWith("pattern")) {
      const e = shuffle(PATTERN, rnd);
      const unit = kind === "pattern2" ? [e[0], e[1]] : kind === "pattern3" ? [e[0], e[1], e[2]] : [e[0], e[1], e[1]];
      // узор показан минимум дважды целиком — иначе «🍒🥝🥝🍒🥝 ?» читается как угодно
      const len = unit.length * 2 + 1 + rnd(unit.length - 1);
      items = range(0, len - 1).map((i) => unit[i % unit.length]);
      right = unit[len % unit.length];
      const opts = shuffle([right, ...shuffle(e.filter((x) => x !== right), rnd).slice(0, 3)], rnd);
      return { view: { kind: "emoji", items, options: opts }, answer: opts.indexOf(right), minMs: MIN_HEAD };
    }
    if (kind === "arith" || kind === "arith_big" || kind === "down") {
      const d = kind === "arith" ? pick([1, 2, 5, 10], rnd) : kind === "arith_big" ? 11 + rnd(15) : -(3 + rnd(7));
      const a = kind === "down" ? 50 + rnd(40) : 1 + rnd(kind === "arith" ? 10 : 30);
      items = range(0, 3).map((i) => a + i * d);
      right = a + 4 * d;
      near = [right + d, right - 1, right + 1, right - d * 2];
    } else if (kind === "geo2" || kind === "geo3") {
      const q = kind === "geo2" ? 2 : 3;
      const a = 1 + rnd(3);
      items = range(0, 3).map((i) => a * q ** i);
      right = a * q ** 4;
      near = [items[3] * (q - 1) + items[3] / q, items[3] + items[2], right + a, right - a];
    } else if (kind === "squares") {
      const a = 1 + rnd(4);
      items = range(a, a + 3).map((i) => i * i);
      right = (a + 4) ** 2;
      near = [items[3] + (items[3] - items[2]), right + 1, right - 1];
    } else if (kind === "fib") {
      const a = 1 + rnd(3), b = a + 1 + rnd(3);
      items = [a, b];
      while (items.length < 5) items.push(items[items.length - 1] + items[items.length - 2]);
      right = items[3] + items[4];
      near = [items[4] * 2, right + 1, right - 1, items[4] + items[2]];
    } else {
      // чередование: +a, −b
      const a = 3 + rnd(6), b = 1 + rnd(a - 1);
      items = [10 + rnd(10)];
      while (items.length < 5) items.push(items[items.length - 1] + (items.length % 2 ? a : -b));
      right = items[4] + (items.length % 2 ? a : -b);
      near = [items[4] - (items.length % 2 ? a : -b), right + 1, right - 1, items[4] + a];
    }
    const { options, answer } = numberOptions(right, rnd, near);
    return { view: { kind: "num", items, options }, answer, minMs: MIN_HEAD };
  },
  math(lvl, rnd) {
    let text, right, near = [];
    if (lvl === 1) {
      const a = 2 + rnd(11), b = 2 + rnd(11);
      text = `${a} + ${b}`; right = a + b; near = [right + 10, right - 1, right + 1];
    } else if (lvl === 2) {
      if (rnd(2)) { const a = 2 + rnd(8), b = 2 + rnd(8); text = `${a} × ${b}`; right = a * b; near = [a * b + a, a * b - b, a + b]; }
      else { const a = 10 + rnd(30), b = 2 + rnd(15), c = 2 + rnd(9); text = `${a} + ${b} − ${c}`; right = a + b - c; near = [a + b + c, right + 10, right - 1]; }
    } else if (rnd(2)) {
      const a = 2 + rnd(19), b = 2 + rnd(8), c = 2 + rnd(8);
      text = `${a} + ${b} × ${c}`; right = a + b * c; near = [(a + b) * c, right + c, right - b];
    } else {
      const b = 2 + rnd(6), a = b + 2 + rnd(9), c = 2 + rnd(8);
      text = `(${a} − ${b}) × ${c}`; right = (a - b) * c; near = [a - b * c, right + c, right - c];
    }
    const { options, answer } = numberOptions(right, rnd, near.filter((x) => x > 0));
    return { view: { text, options }, answer, minMs: MIN_HEAD };
  },
  quiz(lvl, rnd, used) {
    const list = bank().quiz;
    let i = takeIndex(list, used.quiz, rnd, (q) => (q.lvl || 1) === lvl);
    if (i < 0) i = takeIndex(list, used.quiz, rnd);
    if (i < 0) return null;
    const q = list[i];
    const options = shuffle([q.right, ...q.wrong], rnd);
    return { view: { q: q.q, options }, answer: options.indexOf(q.right), minMs: MIN_HEAD };
  },
  tf(lvl, rnd, used) {
    const list = bank().tf;
    let i = takeIndex(list, used.tf, rnd, (q) => (q.lvl || 1) === lvl);
    if (i < 0) i = takeIndex(list, used.tf, rnd);
    if (i < 0) return null;
    return { view: { q: list[i].q }, answer: list[i].a ? 0 : 1, minMs: MIN_HEAD };
  },
  heavy(lvl, rnd, used) {
    const list = bank().heavy;
    const i = takeIndex(list, used.heavy, rnd);
    if (i < 0) return null;
    const h = list[i];
    const flip = rnd(2) === 1;
    const options = flip ? [h.b, h.a] : [h.a, h.b];
    const heavier = h.heavier === "a" ? 0 : 1;
    return { view: { options }, answer: flip ? 1 - heavier : heavier, minMs: MIN_HEAD };
  },
  rebus(lvl, rnd, used) {
    const list = bank().rebus;
    let i = takeIndex(list, used.rebus, rnd, (q) => (q.lvl || 1) === lvl);
    if (i < 0) i = takeIndex(list, used.rebus, rnd);
    if (i < 0) return null;
    const q = list[i];
    const options = shuffle([q.right, ...q.wrong], rnd);
    return { view: { q: q.q, options }, answer: options.indexOf(q.right), minMs: MIN_HEAD };
  },
  chrono(lvl, rnd, used) {
    const list = bank().chrono;
    if (list.length < 3) return null;
    const gap = by(lvl, 300, 60, 15);
    for (let tries = 0; tries < 40; tries++) {
      const picked = [];
      for (const i of shuffle(range(0, list.length - 1).filter((k) => !used.chrono.includes(k)), rnd)) {
        if (picked.every((j) => Math.abs(list[j].year - list[i].year) >= gap)) picked.push(i);
        if (picked.length === 3) break;
      }
      if (picked.length < 3) { used.chrono.length = 0; continue; }
      used.chrono.push(...picked);
      const items = picked.map((i) => list[i].t);
      const answer = range(0, 2).sort((x, y) => list[picked[x]].year - list[picked[y]].year);
      return { view: { items }, answer, minMs: MIN_HEAD + 400 };
    }
    return null;
  },

  // ---- ловкость: новые ----
  spark(lvl) {
    // искра ползёт по фитилю к бомбе; успей тапнуть по ней n раз
    const n = by(lvl, 4, 5, 6), travel = by(lvl, 4500, 3800, 3200);
    return { view: { n, travel }, answer: n, minMs: MIN_FAST + n * 120 };
  },
  rhythm(lvl, rnd) {
    // бомба тикает 4 раза — простучи так же; сравниваем промежутки
    const beats = by(lvl, [[500, 500, 500]], [[400, 400, 800], [800, 400, 400], [400, 800, 400]], [[300, 300, 600], [600, 300, 300], [300, 600, 300], [300, 300, 300]]);
    const gaps = pick(beats, rnd);
    const S = gaps.reduce((a, b) => a + b, 0);
    // ответ возможен только после прослушивания (lead + Σ + 500) и своего выстукивания (≈ Σ)
    return { view: { gaps, lead: 600 }, answer: gaps, minMs: 600 + S + 500 + Math.round(S * 0.7) };
  },
  coward(lvl) {
    const hits = by(lvl, 3, 3, 4), jump = by(lvl, 700, 550, 450);
    return { view: { hits, jump }, answer: hits, minMs: MIN_FAST + hits * 220 };
  },

  // ---- внимание: новые ----
  shells(lvl, rnd) {
    const cups = by(lvl, 3, 3, 4), n = by(lvl, 4, 6, 8), swapMs = by(lvl, 420, 340, 280);
    const start = rnd(cups);
    const swaps = [];
    let at = start;
    for (let i = 0; i < n; i++) {
      const a = rnd(cups);
      let b = rnd(cups - 1);
      if (b >= a) b++;
      swaps.push([a, b]);
      if (at === a) at = b; else if (at === b) at = a;
    }
    return { view: { cups, start, swaps, swapMs, show: 900 }, answer: at, minMs: 900 + n * swapMs };
  },
  simon(lvl, rnd) {
    const len = by(lvl, 3, 4, 5), step = by(lvl, 600, 500, 420);
    const seq = [];
    for (let i = 0; i < len; i++) seq.push(pick(range(0, 3).filter((x) => x !== seq[i - 1]), rnd));
    return { view: { seq, step, lead: 500 }, answer: seq, minMs: 500 + len * step + len * 150 };
  },
  blink(lvl, rnd) {
    const n = by(lvl, 9, 12, 16);
    const pool = shuffle(["😀", "😎", "🤓", "😴", "🤠", "😇", "🥸", "😜", "🤔", "😬", "🙃", "😏", "🤖", "👽", "🐸", "🐵", "🦊", "🐼"], rnd);
    const items = pool.slice(0, n);
    const at = rnd(n);
    const showAt = 700 + rnd(1200), dur = by(lvl, 700, 450, 300);
    // какая клетка моргнёт, телефону знать приходится — иначе нечего показывать (как цифры в «Коде»)
    return { view: { items, to: pool[n], showAt, dur, cell: at }, answer: at, minMs: showAt + dur };
  },
  flashes(lvl, rnd) {
    const count = by(lvl, 3, 4, 5) + rnd(3), gap = by(lvl, 450, 350, 280);
    const { options, answer } = numberOptions(count, rnd, [count + 1, count - 1, count + 2]);
    return { view: { count, gap, lead: 600, options }, answer, minMs: 600 + count * gap };
  },
  diff(lvl, rnd) {
    const side = by(lvl, 3, 4, 4), n = side * side;
    const pool = ["🍎", "🚗", "⚽", "🎈", "🐱", "🌵", "🍩", "🎸", "🌙", "🔑", "🧦", "🍄", "🐙", "🎁", "📎", "🦆"];
    const items = range(1, n).map(() => pick(pool, rnd));
    const at = rnd(n);
    // на трудном — подмена на похожее, на лёгком — на что угодно другое
    const similar = { "🍎": "🍅", "🚗": "🚕", "⚽": "🏐", "🎈": "🎀", "🐱": "🐯", "🌵": "🌴", "🍩": "🥯", "🎸": "🎻", "🌙": "⭐", "🔑": "🗝️", "🧦": "🧤", "🍄": "🌰", "🐙": "🦑", "🎁": "📦", "📎": "🖇️", "🦆": "🐤" };
    const other = lvl === 3 ? similar[items[at]] : pick(pool.filter((x) => x !== items[at]), rnd);
    const second = items.slice();
    second[at] = other;
    return { view: { side, top: items, bottom: second }, answer: at, minMs: MIN_FAST + 300 };
  },

  // ---- голова: новые ----
  manual(lvl, rnd) {
    // инструкция сапёра: провода и правило, какой резать
    const RULES = by(lvl, ["last_yellow", "even"], ["red", "blue", "white"], ["same", "black", "green", "red"]);
    const [lo, hi] = by(lvl, [3, 4], [4, 5], [5, 6]);
    for (let tries = 0; tries < 200; tries++) {
      const n = lo + rnd(hi - lo + 1);
      const wires = range(1, n).map(() => pick(WIRE_KEYS, rnd));
      const rule = pick(RULES, rnd);
      const ans = MANUAL[rule](wires);
      if (ans == null || ans < 0 || ans >= n) continue;
      return { view: { wires, rule }, answer: ans, minMs: MIN_HEAD + 400 };
    }
    return null;
  },
  oddmeaning(lvl, rnd) {
    // на трудном — соседние по смыслу наборы (фрукт среди овощей), иначе — далёкие
    const cats = Object.keys(MEANING);
    const close = (x, y) => CLOSE_CATS.some((p) => p.includes(x) && p.includes(y));
    let a, b;
    if (lvl === 3) [a, b] = shuffle(pick(CLOSE_CATS, rnd), rnd);
    else { a = pick(cats, rnd); b = pick(cats.filter((c) => c !== a && !close(a, c)), rnd); }
    const n = by(lvl, 4, 4, 5);
    const items = shuffle(MEANING[a], rnd).slice(0, n - 1);
    const odd = pick(MEANING[b], rnd);
    const at = rnd(n);
    items.splice(at, 0, odd);
    return { view: { items }, answer: at, minMs: MIN_HEAD };
  },
  dice(lvl, rnd) {
    const dice = range(1, by(lvl, 2, 3, 4)).map(() => 1 + rnd(6));
    const sum = dice.reduce((x, y) => x + y, 0);
    const { options, answer } = numberOptions(sum, rnd, [sum + 1, sum - 1, sum + 2, sum - 2]);
    return { view: { dice, options }, answer, minMs: MIN_HEAD };
  },

  // ======== свои испытания Камеры (lastq-spec.md §4.2) ========

  // ---- ловкость ----
  dig(lvl) {
    // подкоп: барабанить по лопате n раз
    const n = by(lvl, 12, 18, 24);
    return { view: { n }, answer: n, minMs: n * 60 };
  },
  saw(lvl) {
    // пила: каждый прут — strokes смен направления пальца
    const bars = by(lvl, 1, 2, 3), strokes = 4;
    return { view: { bars, strokes }, answer: bars * strokes, minMs: bars * strokes * 120 };
  },
  lockpick(lvl, rnd) {
    // штифты скачут вверх-вниз (треугольная волна 0…1); тапнуть, когда штифт в щели, по очереди.
    // Положение штифта в момент t (мс от показа): tri((t / period + phase) mod 1), tri(f) = f < .5 ? 2f : 2 − 2f
    const k = by(lvl, 2, 3, 4), half = by(lvl, 0.15, 0.11, 0.08);
    const pins = range(1, k).map(() => ({ period: by(lvl, 1600, 1300, 1000) + rnd(400), phase: rnd(1000) / 1000, c: 0.3 + rnd(41) / 100 }));
    let t0 = 500;
    const answer = pins.map((p) => {
      let t = t0;
      while (Math.abs(tri(t / p.period + p.phase) - p.c) >= half * 0.5) t += 10;
      t0 = t + 250;
      return t;
    });
    return { view: { pins, half }, answer, minMs: 500 + k * 250 };
  },
  searchlight(lvl, rnd) {
    // луч ходит по двору (tri, 0…1); беглец на укрытии i жмёт «Беги», когда луч дальше half
    const n = by(lvl, 2, 3, 4), half = by(lvl, 0.16, 0.19, 0.22);
    const period = by(lvl, 2400, 2000, 1600) + rnd(300), phase = rnd(1000) / 1000;
    const covers = range(0, n - 1).map((i) => Math.round((0.12 + (0.76 * i) / Math.max(1, n - 1)) * 100) / 100);
    let t0 = 500;
    const answer = covers.map((x) => {
      let t = t0;
      while (Math.abs(tri(t / period + phase) - x) <= half + 0.05) t += 10;
      t0 = t + 450;
      return t;
    });
    return { view: { n, half, period, phase, covers, dash: 400 }, answer, minMs: 400 + n * 350 };
  },

  // ---- внимание ----
  lineup(lvl, rnd) {
    // фоторобот: шляпа 0–3, очки 0–2, усы 0–2; подозреваемые отличаются от него на diff признаков
    const show = by(lvl, 1800, 1500, 1300);
    const rand = () => ({ h: rnd(4), g: rnd(3), m: rnd(3) });
    const key = (f) => `${f.h}${f.g}${f.m}`;
    const dist = (a, b) => (a.h !== b.h) + (a.g !== b.g) + (a.m !== b.m);
    const target = rand();
    const seen = new Set([key(target)]);
    const others = [];
    while (others.length < 3) {
      const f = rand();
      const d = dist(f, target);
      const want = lvl === 3 ? d === 1 : lvl === 2 ? (others.length === 0 ? d === 1 : d >= 2) : d >= 2;
      if (!want || seen.has(key(f))) continue;
      seen.add(key(f));
      others.push(f);
    }
    const at = rnd(4);
    const suspects = others.slice();
    suspects.splice(at, 0, target);
    return { view: { target, suspects, show }, answer: at, minMs: show + MIN_FAST };
  },
  rollcall(lvl, rnd) {
    // лента номеров, по одному на step мс; тапнуть, пока на экране твой
    const digits = shuffle(range(0, 9), rnd).slice(0, 3);
    if (digits[0] === 0) [digits[0], digits[1]] = [digits[1], digits[0]];
    const mine = digits.join("");
    const len = by(lvl, 6, 7, 8), k = 3 + rnd(len - 3);
    const step = by(lvl, 900, 750, 600), lead = 600;
    const perms = [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map((p) => p.map((i) => digits[i]).join("")).filter((s) => s[0] !== "0");
    const list = [];
    const used = new Set([mine]);
    while (list.length < len - 1) {
      let s;
      if (lvl === 3 && rnd(3) < 2 && perms.length) s = pick(perms, rnd);
      else if (lvl >= 2 && rnd(2)) s = digits[0] + String(rnd(10)) + String(rnd(10));
      else s = String(100 + rnd(900));
      if (used.has(s)) { if (lvl === 3 && perms.every((p) => used.has(p))) perms.length = 0; continue; }
      used.add(s);
      list.push(s);
    }
    list.splice(k, 0, mine);
    // окно: пока номер на экране + 250 мс на реакцию
    return { view: { mine, list, step, lead }, answer: [lead + k * step, lead + (k + 1) * step + 250], minMs: lead + k * step };
  },
  keys(lvl, rnd) {
    // бородка из 4 (на трудном 5) зубцов высотой 1–4; ровно один ключ совпадает
    const len = by(lvl, 4, 4, 5), n = by(lvl, 3, 5, 6);
    const cut = () => range(1, len).map(() => 1 + rnd(4));
    const key = (k) => k.join("");
    const diff = (a, b) => a.reduce((s, x, i) => s + (x !== b[i]), 0);
    let lock = cut();
    while (lvl === 3 && key(lock) === key(lock.slice().reverse())) lock = cut();
    const seen = new Set([key(lock)]);
    const keys = [];
    if (lvl === 3) { keys.push(lock.slice().reverse()); seen.add(key(keys[0])); }
    while (keys.length < n - 1) {
      let k;
      if (lvl >= 2 && rnd(2)) { k = lock.slice(); const i = rnd(len); k[i] = 1 + ((k[i] - 1 + 1 + rnd(3)) % 4); }
      else k = cut();
      if (lvl === 1 && diff(k, lock) < 2) continue;
      if (seen.has(key(k))) continue;
      seen.add(key(k));
      keys.push(k);
    }
    const at = rnd(n);
    keys.splice(at, 0, lock.slice());
    return { view: { lock, keys }, answer: at, minMs: MIN_FAST + 300 };
  },
  cipher(lvl, rnd) {
    // 8 знаков на стене, ровно два одинаковые. Знак = {g: глиф, r: поворот 0–3, m: зеркало 0/1}.
    // Глифы несимметричные (lastq-challenges.js), поэтому разные {g,r,m} всегда выглядят по-разному.
    const N = 8;
    const sym = (g) => ({ g, r: lvl === 1 ? 0 : rnd(4), m: lvl === 1 ? 0 : rnd(2) });
    const key = (s) => `${s.g}.${s.r}.${s.m}`;
    const glyphs = shuffle(range(0, GLYPH_COUNT - 1), rnd);
    const pair = sym(glyphs[0]);
    const items = [pair, { ...pair }];
    const seen = new Set([key(pair)]);
    // на трудном 2–3 обманки — тот же глиф, но повёрнут или отражён
    const decoys = lvl === 3 ? 2 + rnd(2) : lvl === 2 ? rnd(2) : 0;
    while (items.length < 2 + decoys) {
      const s = { g: pair.g, r: rnd(4), m: rnd(2) };
      if (seen.has(key(s))) continue;
      seen.add(key(s));
      items.push(s);
    }
    let gi = 1;
    while (items.length < N) {
      const s = sym(glyphs[gi++ % glyphs.length]);
      if (seen.has(key(s))) continue;
      seen.add(key(s));
      items.push(s);
    }
    const order = shuffle(range(0, N - 1), rnd);
    const placed = order.map((i) => items[i]);
    const answer = [order.indexOf(0), order.indexOf(1)].sort((a, b) => a - b);
    return { view: { items: placed }, answer, minMs: MIN_FAST + 300 };
  },

  // ---- голова ----
  codelock(lvl, rnd) {
    // двузначный код и две подсказки, под которые подходит ровно один код из 10…99
    const kinds = by(lvl, [["sum", "diff"]], [["sum", "diff"], ["sum", "prod"], ["prod", "diff"], ["twice", "sum"], ["sum", "cmp"]], [["prod", "cmp"], ["parity", "sum"], ["twice", "cmp"], ["prod", "parity"], ["diff", "parity"]]);
    const all = range(10, 99);
    const dg = (x) => [Math.floor(x / 10), x % 10];
    for (let tries = 0; tries < 500; tries++) {
      const code = 10 + rnd(90);
      const [a, b] = dg(code);
      if (a === b) continue;
      const clues = pick(kinds, rnd).map((k) => makeClue(k, a, b, code, rnd)).filter(Boolean);
      if (clues.length !== 2) continue;
      const fit = (x) => clues.every((c) => clueOk(c, x));
      if (all.filter(fit).length !== 1) continue;
      // обманки: подходят под одну подсказку из двух — тогда их не отбросить с полувзгляда
      const near = shuffle(all.filter((x) => x !== code && clues.some((c) => clueOk(c, x))), rnd);
      const opts = [code, ...near.slice(0, 3)];
      for (const x of shuffle(all, rnd)) { if (opts.length >= 4) break; if (!opts.includes(x)) opts.push(x); }
      const options = shuffle(opts, rnd).map(String);
      return { view: { clues, options }, answer: options.indexOf(String(code)), minMs: MIN_HEAD + 800 };
    }
    return null;
  },
  scales(lvl, rnd) {
    // цепочка равенств: 🍎 = 🍌🍌, 🍌 = 🍇🍇🍇 → сколько 🍇 в 🍎
    const steps = by(lvl, 2, 2, 3);
    const ks = range(1, steps).map(() => 2 + rnd(by(lvl, 2, 3, 2)));
    const items = shuffle(["🍎", "🍌", "🍇", "🍒", "🥕", "🧀", "🥚", "🍩"], rnd).slice(0, steps + 1);
    const eq = ks.map((k, i) => [items[i], items[i + 1], k]);
    const right = ks.reduce((x, y) => x * y, 1);
    const sum = ks.reduce((x, y) => x + y, 0);
    const { options, answer } = numberOptions(right, rnd, [sum, right + ks[0], right - ks[ks.length - 1], right * 2]);
    return { view: { eq: lvl === 1 ? eq : shuffle(eq, rnd), ask: [items[0], items[steps]], options }, answer, minMs: MIN_HEAD };
  },
  clock(lvl, rnd) {
    // стрелочные часы; на трудном — «сколько будет через H ч M мин»
    const h = 1 + rnd(12);
    const m = lvl === 1 ? 30 * rnd(2) : 5 * rnd(12);
    const fmt = (H, M) => { const t = ((((H - 1) * 60 + M) % 720) + 720) % 720; return `${Math.floor(t / 60) + 1}:${String(t % 60).padStart(2, "0")}`; };
    let plus = null, right, near;
    if (lvl === 3) {
      plus = [1 + rnd(3), 10 + 5 * rnd(9)];
      right = fmt(h + plus[0], m + plus[1]);
      near = [fmt(h + plus[0], m + plus[1] + 10), fmt(h + plus[0] + 1, m + plus[1]), fmt(h - plus[0], m - plus[1]), fmt(h + plus[0], m + plus[1] - 10), fmt(h + plus[0] - 1, m + plus[1])];
    } else {
      right = fmt(h, m);
      // стрелки перепутаны: часовая читается как минутная и наоборот
      const swapped = fmt(Math.round(m / 5) || 12, (h % 12) * 5);
      near = [swapped, fmt(h, m + 5), fmt(h + 1, m), fmt(h - 1, m), fmt(h, m - 5), fmt(h, m + 30)];
    }
    const opts = [right];
    for (const x of near) { if (opts.length >= 4) break; if (!opts.includes(x)) opts.push(x); }
    const options = shuffle(opts, rnd);
    return { view: { h, m, plus, options }, answer: options.indexOf(right), minMs: MIN_HEAD };
  },
  guard(lvl, rnd) {
    // охранник ходит по сетке 3×3 (клетки 0…8), назад сразу не поворачивает
    const n = by(lvl, 3, 4, 5), stepMs = by(lvl, 600, 520, 460), lead = 500;
    const MOVES = { u: [-1, 0], d: [1, 0], l: [0, -1], r: [0, 1] };
    const BACK = { u: "d", d: "u", l: "r", r: "l" };
    const start = rnd(9);
    let r = Math.floor(start / 3), c = start % 3;
    const dirs = [];
    for (let i = 0; i < n; i++) {
      const ok = Object.keys(MOVES).filter((d) => d !== BACK[dirs[i - 1]] && r + MOVES[d][0] >= 0 && r + MOVES[d][0] < 3 && c + MOVES[d][1] >= 0 && c + MOVES[d][1] < 3);
      const d = pick(ok, rnd);
      dirs.push(d);
      r += MOVES[d][0]; c += MOVES[d][1];
    }
    return { view: { start, dirs, stepMs, lead }, answer: r * 3 + c, minMs: lead + n * stepMs };
  },

  // ---- передачка: переделка бомбового «Зала» ----
  pass(lvl, rnd) {
    // у кого код (телефон свободного игрока или доска после 4 с тишины) — решает движок, он знает игроков
    const n = by(lvl, 3, 3, 4);
    let code = "";
    for (let i = 0; i < n; i++) code += String(1 + rnd(9));
    return { view: { n }, answer: code, minMs: 1200 };
  },
};

// Инструкция сапёра: правило → номер провода (с нуля) или null, если к этим проводам правило не подходит
const WIRE_KEYS = ["red", "blue", "yellow", "green", "white", "black"];
const MANUAL = {
  last_yellow: (w) => (w[w.length - 1] === "yellow" ? 0 : w.length - 1),
  even: (w) => (w.length % 2 === 0 ? w.length - 2 : 0),
  red: (w) => (w.filter((c) => c === "red").length > 1 ? w.lastIndexOf("red") : 1),
  blue: (w) => (w.includes("blue") ? w.indexOf("blue") : 2),
  white: (w) => (w.filter((c) => c === "white").length === 1 ? w.indexOf("white") : w.length - 1),
  same: (w) => { const i = w.indexOf(w[0], 1); return i > 0 ? i : null; },
  black: (w) => (!w.includes("black") ? null : w[0] === "black" ? 1 : w.indexOf("black")),
  green: (w) => { const i = w.indexOf("green"); return i >= 0 && i < w.length - 1 ? i + 1 : null; },
};

// «Лишний по смыслу»: наборы без пограничных случаев (помидор, авокадо — не берём)
const MEANING = {
  fruit: ["🍎", "🍌", "🍇", "🍓", "🍉", "🍍", "🍒", "🍑", "🍐"],
  veg: ["🥕", "🥦", "🌽", "🥔", "🍆", "🥒", "🧅", "🧄"],
  pets: ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼"],
  sea: ["🐟", "🐠", "🐙", "🦀", "🐬", "🐳", "🦈", "🦑"],
  cars: ["🚗", "🚕", "🚌", "🚓", "🚑", "🚒", "🚜"],
  air: ["✈️", "🚁", "🚀", "🛸", "🎈"],
  balls: ["⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏉"],
  music: ["🎸", "🎹", "🎺", "🎻", "🥁", "🎷"],
  drinks: ["☕", "🍵", "🥛", "🧃", "🍺", "🍷", "🥤"],
  clothes: ["👕", "👖", "👗", "🧥", "👔", "🧦", "🧢"],
  bugs: ["🐝", "🐞", "🦋", "🐛", "🐜"],
};
const CLOSE_CATS = [["fruit", "veg"], ["cars", "air"], ["pets", "sea"], ["bugs", "pets"], ["drinks", "fruit"]];

/*
 * Новое испытание для узника. group — набор, который выбрал палач (или случай),
 * last — тип прошлого испытания (два одинаковых подряд не даём),
 * seen — типы, уже выпадавшие этому узнику за партию (не повторяем, пока пул группы не исчерпан),
 * used — номера вопросов банка, уже выпавших в комнате ({quiz:[], tf:[], …}),
 * canPass — можно ли «Передачку»: есть свободный игрок и игроков ≥ 3 (решает движок),
 * only — конкретный тип (тесты, lastq-lab.html).
 */
// stage — ступень Камеры (1, 2 — акты, 3 — финал); долгие испытания — только в финале
function poolFor({ lvl, group, canPass, stage = 3 }) {
  const b = bank();
  return (GROUPS[group] || GROUPS.hands).filter((t) => {
    if (t === "pass" && !canPass) return false;
    if (stage < 3 && SLOW.has(t)) return false;
    if (BANK_TYPES.has(t) && b[t].length < (t === "chrono" ? 3 : 1)) return false;
    return true;
  });
}
function generate({ lvl, rnd, group, last, seen, used, canPass, only, stage }) {
  used = used || {};
  for (const k of QUIZ_TYPES) if (!Array.isArray(used[k])) used[k] = [];
  let types = only ? [only] : poolFor({ lvl, group, canPass, stage });
  if (!only && seen && seen.length) {
    const fresh = types.filter((t) => !seen.includes(t));
    if (fresh.length) types = fresh;
  }
  if (types.length > 1 && last) types = types.filter((t) => t !== last);
  // взвешенный порядок: свои испытания вдвое чаще
  const order = [];
  let left = types.slice();
  while (left.length) {
    const total = left.reduce((s, t) => s + (OWN.has(t) ? OWN_WEIGHT : 1), 0);
    let x = rnd(total);
    const t = left.find((u) => (x -= OWN.has(u) ? OWN_WEIGHT : 1) < 0);
    order.push(t);
    left = left.filter((u) => u !== t);
  }
  for (const t of order) {
    const c = GEN[t](lvl, rnd, used);
    if (c) return { type: t, group: TYPE_GROUP[t], lvl, ...c };
  }
  const c = GEN.dig(lvl, rnd);
  return { type: "dig", group: "hands", lvl, ...c };
}

const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
const nums = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && x >= 0 && isFinite(x));

/*
 * Проверка ответа. elapsed — сколько прошло с выдачи испытания по часам сервера.
 * Возвращает "ok" | "wrong" | "early" (слишком быстро: отказ без провала, это не ошибка игрока).
 * Моменты тапов в испытаниях на время (slots-подобные) считает телефон от показа — как в бомбе.
 */
function check(ch, ans, elapsed) {
  if (!ch) return "wrong";
  if (ch.type === "nopress" && ans && ans.early === true) return "wrong";
  if (elapsed < ch.minMs) return ch.type === "nopress" ? "wrong" : "early";
  const a = ch.answer;
  const v = ans && typeof ans === "object" ? ans.v : undefined;
  switch (ch.type) {
    case "wires": case "catch": case "coward": case "dig": case "saw": return v === a ? "ok" : "wrong";
    case "swipe": case "order": case "chrono": case "simon": case "cipher": return sameArr(v, a) ? "ok" : "wrong";
    case "hold": return typeof v === "number" && v >= a[0] && v <= a[1] ? "ok" : "wrong";
    case "nopress": return "ok";
    case "code": case "pass": return String(v) === a ? "ok" : "wrong";
    case "spark": return ans && ans.late === true ? "wrong" : v === a ? "ok" : "wrong";
    case "rhythm": return Array.isArray(v) && v.length === a.length && v.every((x, i) => typeof x === "number" && Math.abs(x - a[i]) <= Math.max(110, a[i] * 0.3)) ? "ok" : "wrong";
    case "lockpick": {
      // каждый штифт пойман в щели (допуск +0,03 в пользу игрока), тапы по порядку
      const { pins, half } = ch.view;
      if (!nums(v, pins.length)) return "wrong";
      return pins.every((p, i) => (i === 0 || v[i] > v[i - 1]) && Math.abs(tri(v[i] / p.period + p.phase) - p.c) < half + 0.03) ? "ok" : "wrong";
    }
    case "searchlight": {
      // каждая перебежка — когда луч дальше half от укрытия (допуск −0,02), между перебежками ≥ 350 мс
      const w = ch.view;
      if (!nums(v, w.n)) return "wrong";
      return w.covers.every((x, i) => (i === 0 || v[i] - v[i - 1] >= 350) && Math.abs(tri(v[i] / w.period + w.phase) - x) > w.half - 0.02) ? "ok" : "wrong";
    }
    case "rollcall": return typeof v === "number" && v >= a[0] && v <= a[1] ? "ok" : "wrong";
    case "sudoku": return v === a ? "ok" : "wrong";
    default: return v === a ? "ok" : "wrong"; // индекс варианта / клетки
  }
}

return { LEVELS, CELL, CELL_READY_MS, levelFor, cellMs, GROUPS, TYPE_GROUP, OWN, SLOW, MEMORY_TYPES, QUIZ_TYPES, MIN_FAST, MIN_HEAD, WRONG_LOCK_MS, GLYPH_COUNT, COLOR_KEYS, WIRE_KEYS, MANUAL, MEANING, GEN, tri, clueOk, poolFor, generate, check, setBank, bank };
});
