"use strict";

// Проверка банка фактов (fibs-spec.md §6): node --test test-content.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { load, LANGS, TOPICS } = require("./content");
const { isTruth } = require("./game");
const { normalize } = require("./normalize");

const C = load(path.join(__dirname, "content"));
const MIN = { regular: 300, final: 60 };

for (const lang of LANGS) {
  const facts = C[lang];

  test(`${lang}: объёмы банка не меньше спеки`, () => {
    assert.ok(facts.filter((f) => !f.final).length >= MIN.regular, `${lang}: обычных ${facts.filter((f) => !f.final).length} < ${MIN.regular}`);
    assert.ok(facts.filter((f) => f.final).length >= MIN.final, `${lang}: финальных ${facts.filter((f) => f.final).length} < ${MIN.final}`);
  });

  test(`${lang}: у каждого факта один пропуск, короткий ответ, источник, известная тема`, () => {
    for (const f of facts) {
      assert.ok(f.id && typeof f.id === "string", "нет id");
      assert.ok(TOPICS.includes(f.topic), `${f.id}: тема ${f.topic}`);
      assert.strictEqual((f.text.match(/_{3,}/g) || []).length, 1, `${f.id}: пропусков не один`);
      assert.ok(f.text.length <= 160, `${f.id}: длинный текст (${f.text.length})`);
      assert.ok(f.answer && Array.from(f.answer).length <= 25, `${f.id}: ответ «${f.answer}»`);
      assert.ok(/^https?:\/\//.test(f.source || ""), `${f.id}: нет источника`);
    }
  });

  test(`${lang}: у каждого факта ≥ 6 лжей, ни одна не равна правде, лжи не совпадают между собой`, () => {
    for (const f of facts) {
      assert.ok(Array.isArray(f.lies) && f.lies.length >= 6, `${f.id}: лжей ${f.lies && f.lies.length}`);
      const keys = new Set();
      for (const l of f.lies) {
        assert.ok(typeof l === "string" && l.trim() && Array.from(l).length <= 25, `${f.id}: ложь «${l}»`);
        assert.ok(!isTruth(l, f), `${f.id}: ложь «${l}» совпадает с правдой`);
        keys.add(normalize(l));
      }
      assert.strictEqual(keys.size, f.lies.length, `${f.id}: лжи повторяются после нормализации`);
    }
  });

  test(`${lang}: нет дублей фактов и управляющих символов`, () => {
    const ids = facts.map((f) => f.id);
    assert.strictEqual(new Set(ids).size, ids.length, "дубли id");
    const texts = facts.map((f) => f.text.trim().toLowerCase());
    assert.strictEqual(new Set(texts).size, texts.length, "дубли текста");
    const bad = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;
    assert.ok(!bad.test(JSON.stringify(facts).replace(/\\n/g, "")), "найден управляющий символ");
  });
}

// alts (T-W2-40, fibs-048): варианты написания правды — калька, транслит, формы короткого слова
for (const lang of LANGS) {
  test(`${lang}: alts — непустые строки без дублей, не равны ответу и не совпадают ни с одной ложью факта`, () => {
    const lit = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
    for (const f of C[lang]) {
      if (f.alts === undefined) continue;
      assert.ok(Array.isArray(f.alts), `${f.id}: alts не массив`);
      const seen = new Set([lit(f.answer)]);
      for (const a of f.alts) {
        assert.ok(typeof a === "string" && lit(a), `${f.id}: пустой alt`);
        assert.ok(!seen.has(lit(a)), `${f.id}: alt «${a}» дублирует ответ или другой alt`);
        seen.add(lit(a));
        for (const l of f.lies) assert.notStrictEqual(lit(l), lit(a), `${f.id}: alt «${a}» совпадает с ложью`);
      }
    }
  });
}

test("alts закрывают транслит и формы короткого слова: «фелт-тип пен», «мох» при «мха»", () => {
  const ru = C.ru;
  const pen = ru.find((f) => f.id === "space-aldrin-felt-pen");
  assert.ok(isTruth("фелт-тип пен", pen), "фелт-тип пен");
  assert.ok(isTruth("фетровый маркер", pen), "фетровый маркер");
  assert.ok(!isTruth("карандаш", pen), "карандаш — ложь");
  const moss = ru.find((f) => f.id === "nature-glacier-mice-moss");
  assert.ok(isTruth("мох", moss) && isTruth("мхом", moss), "формы «мха»");
  assert.ok(!isTruth("лишайник", moss), "лишайник — ложь");
  const bear = C.en.find((f) => f.id === "food-toblerone-bear");
  assert.ok(isTruth("a bear", bear) && isTruth("bears", bear), "a bear / bears");
});

test("id совпадают во всех языках", () => {
  const ru = C.ru.map((f) => f.id).sort().join();
  for (const lang of LANGS) assert.strictEqual(C[lang].map((f) => f.id).sort().join(), ru, lang);
});
