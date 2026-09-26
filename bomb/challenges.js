"use strict";

/*
 * Микро-испытания бомбы (bomb-spec.md §5). Чистые функции: генератор и проверка.
 * Генератор отдаёт { type, group, lvl, view, answer, minMs }:
 *   view   — что рисует телефон (и доска): уходит клиентам;
 *   answer — правильный ответ: живёт только на сервере;
 *   minMs  — быстрее этого ответ не принимаем (живой человек не успеет — значит, скрипт).
 * Тексты из банка вопросов идут во view сразу на трёх языках: язык выбирает клиент.
 */

const GROUPS = {
  hands: ["wires", "swipe", "hold", "order", "nopress", "catch"],
  eyes: ["color", "odd", "code", "count", "letter", "sad"],
  head: ["quiz", "sudoku", "seq", "math", "tf", "heavy", "chrono"],
};
const TYPE_GROUP = {};
for (const [g, types] of Object.entries(GROUPS)) for (const t of types) TYPE_GROUP[t] = g;
// испытания режима «Эрудит»: только вопросы из банка
const QUIZ_TYPES = ["quiz", "tf", "heavy", "chrono"];
const BANK_TYPES = new Set(QUIZ_TYPES);

// Если держатель завис на испытании — выдаём другое (§5)
const CHALLENGE_TTL = 12000;
// Минимальное время ответа: руки и глаза — 400 мс, голова — 800 мс (§5)
const MIN_FAST = 400;
const MIN_HEAD = 800;

let BANK = null;
function bank() {
  if (BANK) return BANK;
  try { BANK = require("./questions.json"); } catch { BANK = {}; }
  for (const k of QUIZ_TYPES) if (!Array.isArray(BANK[k])) BANK[k] = [];
  return BANK;
}
function setBank(b) { BANK = b; for (const k of QUIZ_TYPES) if (!Array.isArray(BANK[k])) BANK[k] = []; }

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
      const len = kind === "pattern2" ? 5 : 5 + rnd(2);
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
};

// Уровень по прошедшему времени раунда (оно видно всем): 0–20 с, 20–45 с, дальше (§5)
function levelFor(elapsedMs) {
  return elapsedMs < 20000 ? 1 : elapsedMs < 45000 ? 2 : 3;
}

/*
 * Новое испытание. groups — включённые группы из настроек, quizOnly — режим «Эрудит»,
 * last — тип прошлого испытания этого игрока (два одинаковых подряд не даём),
 * used — номера вопросов банка, уже выпавших в партии ({quiz:[], tf:[], heavy:[], chrono:[]}).
 */
function generate({ lvl, rnd, groups, quizOnly, last, used, only }) {
  const b = bank();
  let types = only ? [only] : quizOnly ? QUIZ_TYPES.slice() : Object.keys(GROUPS).filter((g) => groups[g] !== false).flatMap((g) => GROUPS[g]);
  types = types.filter((t) => !BANK_TYPES.has(t) || b[t].length >= (t === "chrono" ? 3 : 1));
  if (!types.length) types = GROUPS.hands.slice();
  if (types.length > 1 && last) types = types.filter((t) => t !== last);
  for (const t of shuffle(types, rnd)) {
    const c = GEN[t](lvl, rnd, used);
    if (c) return { type: t, group: TYPE_GROUP[t], lvl, ...c };
  }
  const c = GEN.wires(lvl, rnd);
  return { type: "wires", group: "hands", lvl, ...c };
}

const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/*
 * Проверка ответа. elapsed — сколько прошло с выдачи испытания по часам сервера.
 * Возвращает "ok" | "wrong" | "early" (слишком быстро: отказ без провала, это не ошибка игрока).
 */
function check(ch, ans, elapsed) {
  if (!ch) return "wrong";
  if (ch.type === "nopress" && ans && ans.early === true) return "wrong";
  if (elapsed < ch.minMs) return ch.type === "nopress" ? "wrong" : "early";
  const a = ch.answer;
  const v = ans && typeof ans === "object" ? ans.v : undefined;
  switch (ch.type) {
    case "wires": case "catch": return v === a ? "ok" : "wrong";
    case "swipe": case "order": case "chrono": return sameArr(v, a) ? "ok" : "wrong";
    case "hold": return typeof v === "number" && v >= a[0] && v <= a[1] ? "ok" : "wrong";
    case "nopress": return "ok";
    case "code": return String(v) === a ? "ok" : "wrong";
    case "sudoku": return v === a ? "ok" : "wrong";
    default: return v === a ? "ok" : "wrong"; // индекс варианта
  }
}

module.exports = { GROUPS, TYPE_GROUP, QUIZ_TYPES, CHALLENGE_TTL, COLOR_KEYS, generate, check, levelFor, setBank, bank };
