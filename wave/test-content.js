"use strict";

// Проверка банка шкал (wave-spec.md §5): node --test test-content.js
const test = require("node:test");
const assert = require("node:assert");
const CONTENT = require("./content");
const { normalize } = require("./normalize");
const { checkClue } = require("./game");

const MIN = 300;
const POLE_MAX = 24;

for (const lang of CONTENT.LANGS) {
  test(`${lang}: объём, длины, дубли`, () => {
    const list = CONTENT[lang];
    assert.ok(list.length >= MIN, `${lang}: ${list.length} < ${MIN}`);
    const ids = new Set();
    const pairs = new Set();
    for (const s of list) {
      assert.ok(s.id && !ids.has(s.id), `id ${s.id}`);
      ids.add(s.id);
      for (const pole of [s.l, s.r]) {
        assert.ok(typeof pole === "string" && pole.trim() === pole && pole.length > 0, `${s.id}: пустой полюс`);
        assert.ok(Array.from(pole).length <= POLE_MAX, `${s.id}: «${pole}» длиннее ${POLE_MAX}`);
        assert.ok(!/\p{Nd}/u.test(pole), `${s.id}: цифры в «${pole}»`);
        assert.ok(!/[.]$/.test(pole), `${s.id}: точка в конце «${pole}»`);
      }
      assert.notStrictEqual(normalize(s.l), normalize(s.r), `${s.id}: одинаковые полюса`);
      assert.ok(CONTENT.TAGS.includes(s.tag), `${s.id}: тег ${s.tag}`);
      const key = [normalize(s.l), normalize(s.r)].sort().join("|");
      assert.ok(!pairs.has(key), `${s.id}: дубль ${s.l} ↔ ${s.r}`);
      pairs.add(key);
    }
  });

  test(`${lang}: у каждой шкалы проходит хоть какая-то подсказка`, () => {
    // полюс из одних коротких слов не должен блокировать обычные подсказки
    for (const s of CONTENT[lang]) assert.ok(checkClue("🙂", s).ok, s.id);
  });
}
