"use strict";

// Проверка колод (quip-spec.md §6): node --test test-content.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { load, LANGS } = require("./content");
const { normalize, normalizeList } = require("./normalize");

const C = load(path.join(__dirname, "content"));
const MIN = { duel: 400, emoji: 150, final: 120 };

for (const lang of LANGS) {
  test(`${lang}: объёмы колод не меньше спеки`, () => {
    for (const [deck, n] of Object.entries(MIN)) assert.ok(C[lang][deck].length >= n, `${lang}/${deck}: ${C[lang][deck].length} < ${n}`);
  });

  test(`${lang}: вопросы ≤ 90, подсказки ≤ 60 (пункты финала ≤ 40), по 6 (финал — 5 наборов по 3)`, () => {
    for (const c of C[lang].duel) {
      assert.ok(c.q && c.q.length <= 90, "длинный вопрос: " + c.q);
      assert.strictEqual(c.h.length, 6, "подсказок не 6: " + c.q);
      for (const h of c.h) assert.ok(typeof h === "string" && h.trim() && h.length <= 60, `подсказка «${h}» к «${c.q}»`);
    }
    for (const c of C[lang].emoji) {
      assert.ok(c.e && Array.from(c.e).length <= 12, "сцена: " + c.e);
      assert.strictEqual(c.h.length, 6, "подписей не 6: " + c.e);
      for (const h of c.h) assert.ok(typeof h === "string" && h.trim() && h.length <= 60, `подпись «${h}» к ${c.e}`);
    }
    for (const c of C[lang].final) {
      assert.ok(c.q && c.q.length <= 90, "длинный вопрос: " + c.q);
      assert.strictEqual(c.h.length, 5, "наборов не 5: " + c.q);
      for (const set of c.h) {
        assert.ok(Array.isArray(set) && set.length === 3, "набор не из трёх: " + c.q);
        for (const x of set) assert.ok(typeof x === "string" && x.trim() && x.length <= 40, `пункт «${x}» к «${c.q}»`);
      }
    }
  });

  test(`${lang}: нет дублей вопросов, у вопроса подсказки не совпадают между собой (иначе джинкс сам с собой)`, () => {
    for (const deck of ["duel", "emoji", "final"]) {
      const keys = C[lang][deck].map((c) => (c.q || c.e).trim().toLowerCase());
      assert.strictEqual(new Set(keys).size, keys.length, `${lang}/${deck}: есть дубли`);
      for (const c of C[lang][deck]) {
        const hk = c.h.map((h) => (Array.isArray(h) ? normalizeList(h) : normalize(h)));
        assert.strictEqual(new Set(hk).size, hk.length, `подсказки совпадают после нормализации: ${c.q || c.e}`);
      }
    }
  });

  test(`${lang}: нет управляющих и невидимых символов`, () => {
    const bad = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;
    const all = JSON.stringify(C[lang]);
    assert.ok(!bad.test(all.replace(/\\n/g, "")), "найден управляющий символ");
  });
}
