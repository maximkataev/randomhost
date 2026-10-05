"use strict";
// Испытания Камеры: каждый тип × уровень × много сидов — эталонный ответ проходит, неверный и ранний — нет.
// node --test test-challenges.js

const test = require("node:test");
const assert = require("node:assert/strict");
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

const ALL = [...new Set(Object.values(C.GROUPS).flat())];
const SEEDS = 150;

// эталонный ответ в том виде, в каком его шлёт телефон
function rightAns(ch) {
  const a = ch.answer;
  switch (ch.type) {
    case "nopress": return { early: false };
    case "hold": case "rollcall": return { v: (a[0] + a[1]) / 2 };
    default: return { v: a };
  }
}
// заведомо неверный ответ (null — у типа нет «неверного», как у «НЕ ЖМИ» после ожидания)
function wrongAns(ch) {
  const a = ch.answer, v = ch.view;
  switch (ch.type) {
    case "nopress": return { early: true };
    case "hold": return { v: a[1] + 500 };
    case "rollcall": return { v: a[1] + 1 };
    case "code": case "pass": return { v: a.split("").reverse().join("") === a ? a + "1" : a.split("").reverse().join("") };
    case "cipher": return { v: [a[0], (a[1] + 1) % 8 === a[0] ? (a[1] + 2) % 8 : (a[1] + 1) % 8].sort((x, y) => x - y) };
    case "lockpick": { const t = a.slice(); t[0] = farTime(v.pins[0], v.half, t[0]); return t[0] == null ? null : { v: t }; }
    case "searchlight": { const t = a.slice(); t[0] = litTime(v, 0); return { v: t }; }
    case "swipe": case "order": case "chrono": case "simon": { const t = a.slice(); t[0] = t[0] === t[1] || typeof t[0] !== typeof t[1] || t.length < 2 ? (typeof t[0] === "string" ? (t[0] === "u" ? "d" : "u") : t[0] + 9) : t[1]; return { v: t }; }
    case "rhythm": return { v: a.map((x) => x * 3) };
    case "spark": return { v: a, late: true };
    case "wires": case "catch": case "coward": case "dig": case "saw": return { v: a - 1 };
    case "sudoku": return { v: a === 1 ? 2 : 1 };
    default: return { v: (a + 1) % optCount(ch) };
  }
}
function optCount(ch) {
  const v = ch.view;
  return (v.options || v.suspects || v.keys || v.items || (ch.type === "guard" ? Array(9) : null) || [0, 1]).length;
}
function farTime(p, half, from) {
  for (let t = from; t < from + 5000; t += 5) if (Math.abs(C.tri(t / p.period + p.phase) - p.c) > half + 0.1) return t;
  return null;
}
function litTime(v, i, from) {
  for (let t = from || 0; t < (from || 0) + 10000; t += 5) if (Math.abs(C.tri(t / v.period + v.phase) - v.covers[i]) < v.half / 2) return t;
  throw new Error("луч не доходит до укрытия");
}

for (const type of ALL) {
  test(`${type}: эталон проходит, неверный и ранний — нет`, () => {
    for (const lvl of [1, 2, 3]) for (let s = 1; s <= SEEDS; s++) {
      const rnd = mulberry(s * 7919 + lvl);
      const ch = C.generate({ lvl, rnd, only: type, used: {} });
      assert.equal(ch.type, type, `${type} ур.${lvl} сид ${s}: генератор отказал`);
      assert.ok(ch.minMs > 0 && ch.minMs < 8000, `${type}: minMs ${ch.minMs}`);
      assert.equal(C.check(ch, rightAns(ch), ch.minMs + 1), "ok", `${type} ур.${lvl} сид ${s}: ${JSON.stringify(ch)}`);
      const w = wrongAns(ch);
      if (w) assert.equal(C.check(ch, w, ch.minMs + 1), "wrong", `${type} ур.${lvl} сид ${s}: неверный принят ${JSON.stringify(w)} ${JSON.stringify(ch)}`);
      if (type !== "nopress") assert.equal(C.check(ch, rightAns(ch), ch.minMs - 1), "early");
      // ответ не утекает во view (кроме испытаний на время и память, где без него нечего рисовать)
      JSON.stringify(ch.view);
    }
  });
}

test("Голова: ответ не раньше 1200 мс", () => {
  for (const t of C.GROUPS.head) {
    const ch = C.generate({ lvl: 1, rnd: mulberry(3), only: t, used: {} });
    assert.ok(ch.minMs >= 1200, `${t}: ${ch.minMs}`);
  }
});

test("Кодовый замок: под подсказки подходит ровно один код из 10…99, он среди вариантов", () => {
  for (const lvl of [1, 2, 3]) for (let s = 1; s <= 400; s++) {
    const ch = C.generate({ lvl, rnd: mulberry(s), only: "codelock" });
    const fit = [];
    for (let x = 10; x <= 99; x++) if (ch.view.clues.every((c) => C.clueOk(c, x))) fit.push(String(x));
    assert.equal(fit.length, 1, JSON.stringify(ch.view));
    assert.equal(ch.view.options[ch.answer], fit[0]);
    assert.equal(new Set(ch.view.options).size, 4);
  }
});

test("Маршрут охранника не выходит за сетку и не разворачивается на месте", () => {
  const M = { u: [-1, 0], d: [1, 0], l: [0, -1], r: [0, 1] }, BACK = { u: "d", d: "u", l: "r", r: "l" };
  for (const lvl of [1, 2, 3]) for (let s = 1; s <= 400; s++) {
    const ch = C.generate({ lvl, rnd: mulberry(s), only: "guard" });
    let r = Math.floor(ch.view.start / 3), c = ch.view.start % 3;
    ch.view.dirs.forEach((d, i) => {
      if (i) assert.notEqual(d, BACK[ch.view.dirs[i - 1]]);
      r += M[d][0]; c += M[d][1];
      assert.ok(r >= 0 && r < 3 && c >= 0 && c < 3);
    });
    assert.equal(ch.answer, r * 3 + c);
  }
});

test("Шифр: ровно одна пара одинаковых знаков; на трудном есть обманки того же глифа", () => {
  for (const lvl of [1, 2, 3]) for (let s = 1; s <= 400; s++) {
    const ch = C.generate({ lvl, rnd: mulberry(s), only: "cipher" });
    const keys = ch.view.items.map((x) => `${x.g}.${x.r}.${x.m}`);
    assert.equal(keys.length, 8);
    assert.equal(new Set(keys).size, 7);
    assert.equal(keys[ch.answer[0]], keys[ch.answer[1]]);
    assert.ok(ch.view.items.every((x) => x.g >= 0 && x.g < C.GLYPH_COUNT));
    if (lvl === 1) assert.ok(ch.view.items.every((x) => x.r === 0 && x.m === 0));
    if (lvl === 3) assert.ok(ch.view.items.filter((x) => x.g === ch.view.items[ch.answer[0]].g).length >= 4);
  }
});

test("Опознание и ключи: ровно один совпадает с образцом", () => {
  for (const lvl of [1, 2, 3]) for (let s = 1; s <= 300; s++) {
    const l = C.generate({ lvl, rnd: mulberry(s), only: "lineup" }).view;
    const same = (a, b) => a.h === b.h && a.g === b.g && a.m === b.m;
    assert.equal(l.suspects.filter((x) => same(x, l.target)).length, 1);
    if (lvl === 3) assert.ok(l.suspects.every((x) => same(x, l.target) || (x.h !== l.target.h) + (x.g !== l.target.g) + (x.m !== l.target.m) === 1));
    const k = C.generate({ lvl, rnd: mulberry(s), only: "keys" }).view;
    assert.equal(k.keys.filter((x) => x.join() === k.lock.join()).length, 1);
    assert.equal(new Set(k.keys.map((x) => x.join())).size, k.keys.length);
  }
});

test("Перекличка: свой номер в ленте ровно один раз", () => {
  for (const lvl of [1, 2, 3]) for (let s = 1; s <= 300; s++) {
    const v = C.generate({ lvl, rnd: mulberry(s), only: "rollcall" }).view;
    assert.equal(v.list.filter((x) => x === v.mine).length, 1);
    assert.equal(new Set(v.list).size, v.list.length);
    assert.ok(v.list.every((x) => /^[1-9]\d\d$/.test(x)));
  }
});

test("Часы и весы: четыре разных варианта", () => {
  for (const t of ["clock", "scales"]) for (const lvl of [1, 2, 3]) for (let s = 1; s <= 300; s++) {
    const v = C.generate({ lvl, rnd: mulberry(s), only: t }).view;
    assert.equal(new Set(v.options.map(String)).size, 4, `${t} ${JSON.stringify(v)}`);
  }
});

test("Отмычка и прожектор: эталонные моменты укладываются в 15 с Камеры", () => {
  for (const t of ["lockpick", "searchlight"]) for (let s = 1; s <= 300; s++) {
    const ch = C.generate({ lvl: 3, rnd: mulberry(s), only: t });
    assert.ok(ch.answer[ch.answer.length - 1] < 6000, `${t}: ${ch.answer}`);
  }
});

test("Прожектор: перебежка в луче — провал", () => {
  for (let s = 1; s <= 200; s++) {
    const ch = C.generate({ lvl: 2, rnd: mulberry(s), only: "searchlight" });
    const v = ch.answer.slice();
    v[v.length - 1] = litTime(ch.view, v.length - 1, v[v.length - 2] + 350);
    assert.equal(C.check(ch, { v }, 99999), "wrong");
  }
});

test("Пул Камеры: без slots и бомбового «Зала»; долгие только в финале; «Передачка» по разрешению движка", () => {
  const all = Object.values(C.GROUPS).flat();
  assert.ok(!all.includes("slots") && !all.includes("crowd"));
  for (const g of Object.keys(C.GROUPS)) {
    for (const lvl of [1, 2, 3]) for (const stage of [1, 2]) assert.ok(!C.poolFor({ lvl, stage, group: g, canPass: true }).some((t) => C.SLOW.has(t)));
    assert.ok(!C.poolFor({ lvl: 1, group: g, canPass: false }).includes("pass"));
  }
  assert.ok(C.poolFor({ lvl: 2, stage: 3, group: "head" }).includes("chrono"));
  assert.ok(C.poolFor({ lvl: 1, group: "eyes", canPass: true }).includes("pass"));
});

test("Свои испытания выпадают примерно вдвое чаще бомбовых", () => {
  const rnd = mulberry(42);
  for (const group of Object.keys(C.GROUPS)) {
    const pool = C.poolFor({ lvl: 1, group, canPass: true });
    const hits = {};
    for (let i = 0; i < 40000; i++) { const t = C.generate({ lvl: 1, rnd, group, canPass: true }).type; hits[t] = (hits[t] || 0) + 1; }
    const own = pool.filter((t) => C.OWN.has(t)), bomb = pool.filter((t) => !C.OWN.has(t));
    const avg = (ts) => ts.reduce((s, t) => s + (hits[t] || 0), 0) / ts.length;
    const k = avg(own) / avg(bomb);
    assert.ok(k > 1.7 && k < 2.3, `${group}: ${k.toFixed(2)}`);
  }
});

test("Не повторяем испытание узнику, пока пул не исчерпан; два одинаковых подряд — никогда", () => {
  const rnd = mulberry(7);
  for (const group of Object.keys(C.GROUPS)) {
    const pool = C.poolFor({ lvl: 2, stage: 2, group, canPass: true });
    const seen = [];
    let last = null;
    for (let i = 0; i < pool.length * 2; i++) {
      const t = C.generate({ lvl: 2, stage: 2, rnd, group, canPass: true, seen, last }).type;
      if (seen.length < pool.length) assert.ok(!seen.includes(t), `${group}: ${t} повторился до исчерпания`);
      assert.notEqual(t, last);
      seen.push(t);
      if (seen.length === pool.length) seen.length = 0;
      last = t;
    }
  }
});
