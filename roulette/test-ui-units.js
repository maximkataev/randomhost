"use strict";

// Юнит-тесты чистых функций клиента (roulette-shared.js): node --test test-ui-units.js
// Файл грузится в чистый vm-контекст с заглушками window/document/navigator.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "roulette-shared.js"), "utf8");

function load(opts) {
  opts = opts || {};
  const calls = [];
  const ctx = { console, calls };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.document = { addEventListener() {}, createElement() { return {}; }, hidden: false };
  ctx.navigator = Object.assign({ vibrate: (p) => { calls.push(p); return true; } }, opts.nav || {});
  if (opts.lang) ctx.I18N = { lang: opts.lang };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "roulette-shared.js" });
  return { ev: (code) => vm.runInContext(code, ctx), calls, ctx };
}

test("hitKey: середина таблички — число, у линии — сплит/каре", () => {
  const { ev } = load();
  const W = 300, H = 650;
  // центр ячейки числа n (ряд r+1, колонка c)
  const centre = (n) => { const r = Math.floor((n - 1) / 3), c = (n - 1) % 3; return [(c + 0.5) / 3, (r + 1.5) / 13]; };
  for (const n of [1, 17, 18, 36]) {
    const [fx, fy] = centre(n);
    assert.strictEqual(ev(`hitKey(${fx}, ${fy}, ${W}, ${H})`), "n:" + n);
  }
  assert.strictEqual(ev(`hitKey(0.5, 0.01, ${W}, ${H})`), "n:0");
  // у нижней кромки ячейки 1 по центру — сплит 1-4
  const [fx, fy] = centre(1);
  assert.strictEqual(ev(`hitKey(${fx}, ${fy + 0.5 / 13 - 0.002}, 0, 0)`), "sp:1-4");
  // стык четырёх ячеек — каре
  assert.strictEqual(ev(`hitKey(${1 / 3 - 0.005}, ${2 / 13 - 0.002}, 0, 0)`), "co:1-2-4-5");
  // любой ключ существует в таблице ставок
  for (let i = 0; i < 400; i++) {
    const k = ev(`hitKey(${(i * 0.6180339) % 1}, ${(i * 0.3247) % 1}, 0, 0)`);
    assert.ok(k && ev(`!!RL_BETS[${JSON.stringify(k)}]`), "ключ " + k);
  }
});

test("hitKey: на 320×568 (строка 22 px) сплит у линии — полоса не уже 4 px (roulette-020)", () => {
  const { ev } = load();
  const W = 224, H = 22.3 * 13, ch = H / 13;
  // число 17: ряд 6 (r=5), колонка 1; fy в долях зоны чисел
  const rowTop = (r) => (r + 1) * ch; // строка 0 — зеро
  const keyAtY = (n, yPx) => { // yPx — от верха строки числа n
    const r = Math.floor((n - 1) / 3), c = (n - 1) % 3;
    return ev(`hitKey(${(c + 0.5) / 3}, ${(rowTop(r) + yPx) / H}, ${W}, ${H})`);
  };
  assert.strictEqual(keyAtY(17, ch / 2), "n:17");
  assert.strictEqual(keyAtY(17, ch / 2 + 6), "n:17"); // в таблице номера
  assert.strictEqual(keyAtY(17, 3), "sp:14-17");    // 3 px от верхней линии — сплит с верхним
  assert.strictEqual(keyAtY(17, ch - 3), "sp:17-20"); // 3 px от нижней — с нижним
  assert.strictEqual(keyAtY(17, 4.5), "n:17");       // за полосой — число
  // крупный экран: таблица номера не уже прежнего (≤13 px от центра)
  assert.strictEqual(ev(`hitKey(${1.5 / 3}, ${(6.5 * 44.2 + 12) / (44.2 * 13)}, 316, ${44.2 * 13})`), "n:17");
});

test("initials: слова, эмодзи бота, кодовые точки", () => {
  const { ev } = load();
  assert.strictEqual(ev(`initials("Маша Иванова")`), "МИ");
  assert.strictEqual(ev(`initials("Маша")`), "М");
  assert.strictEqual(ev(`initials("🤖 Бот Боб")`), "ББ");
  assert.strictEqual(ev(`initials("😀 Emoji Cat")`), "😀E");
  assert.strictEqual(ev(`initials("")`), "?");
  assert.strictEqual(ev(`initials("a b c d")`), "AB");
  // тёзки «База (N)»: буква и номер, а не «М(»
  assert.strictEqual(ev(`initials("Маша (2)")`), "М2");
  assert.strictEqual(ev(`initials("Маша Иванова (3)")`), "М3");
  assert.strictEqual(ev(`initials("Agent 7")`), "A7");
});

test("rlAmount: разделители по языку", () => {
  const { ev } = load();
  const norm = (s) => s.replace(/[   ]/g, " ");
  assert.strictEqual(norm(ev(`rlAmount(1250, "ru")`)), "1 250");
  assert.strictEqual(ev(`rlAmount(1250, "en")`), "1,250");
  assert.strictEqual(ev(`rlAmount(12500, "ru")`), "12,5k");
  assert.strictEqual(ev(`rlAmount(12500, "en")`), "12.5k");
  assert.strictEqual(ev(`rlAmount(950, "en")`), "950");
  assert.strictEqual(ev(`rlAmount("x", "en")`), "0");
  assert.strictEqual(load({ lang: "en" }).ev(`rlAmount(2500)`), "2,500");
});

test("rlBuzz: не вибрирует до первого тапа", () => {
  let t = load({ nav: { userActivation: { hasBeenActive: false } } });
  assert.strictEqual(t.ev("rlBuzz(8)"), false);
  assert.strictEqual(t.calls.length, 0);
  t = load({ nav: { userActivation: { hasBeenActive: true } } });
  assert.strictEqual(t.ev("rlBuzz([20, 40, 20])"), true);
  assert.strictEqual(JSON.stringify(t.calls), "[[20,40,20]]");
  // нет userActivation (старые браузеры) — как раньше
  t = load();
  t.ev("rlBuzz(5)");
  assert.strictEqual(JSON.stringify(t.calls), "[5]");
  // нет vibrate вовсе (iOS) и исключение — тихо
  t = load({ nav: { vibrate: undefined } });
  assert.strictEqual(t.ev("rlBuzz(5)"), false);
  t = load({ nav: { vibrate() { throw new Error("x"); } } });
  assert.strictEqual(t.ev("rlBuzz(5)"), false);
});
