"use strict";
// Банк вопросов (lastq-spec.md §6): node --test test-content.js
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("./content.js");

const MIN = { regular: 200, final: 40 };
const LEN = { q: 110, a: { ru: 32, en: 32, el: 36 } };

for (const lang of C.LANGS) {
  test(`${lang}: объём, поля, длины, четыре разных варианта`, () => {
    const qs = C[lang];
    const reg = qs.filter((q) => !q.final), fin = qs.filter((q) => q.final);
    assert.ok(reg.length >= MIN.regular, `обычных ${reg.length} < ${MIN.regular}`);
    assert.ok(fin.length >= MIN.final, `финальных ${fin.length} < ${MIN.final}`);
    const bad = [];
    for (const q of qs) {
      const why = [];
      if (!C.TAGS.includes(q.tag)) why.push("тег " + q.tag);
      if (![1, 2, 3].includes(q.lvl)) why.push("lvl");
      if (q.final && q.lvl !== 3) why.push("финал не lvl 3");
      if (typeof q.q !== "string" || !q.q.trim() || q.q.length > LEN.q) why.push(`вопрос ${q.q && q.q.length}`);
      if (!Array.isArray(q.a) || q.a.length !== 4) why.push("не 4 варианта");
      else {
        if (new Set(q.a.map((x) => String(x).trim().toLowerCase())).size !== 4) why.push("варианты повторяются");
        for (const x of q.a) if (typeof x !== "string" || !x.trim() || x.length > LEN.a[lang]) why.push(`вариант «${x}» ${x && x.length}`);
      }
      if (![1, 2, 3].includes(q.fun)) why.push("fun — не неверный вариант");
      if (!/^https?:\/\//.test(q.source || "")) why.push("нет источника");
      if (why.length) bad.push(`${q.id}: ${why.join("; ")}`);
    }
    assert.deepEqual(bad, []);
  });
}

test("id одинаковые во всех языках и уникальные", () => {
  const ids = C.LANGS.map((l) => C[l].map((q) => q.id).join(","));
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[0], ids[2]);
  const list = C.ru.map((q) => q.id);
  assert.equal(new Set(list).size, list.length);
});

test("вопросы не повторяются по тексту", () => {
  for (const l of C.LANGS) {
    const seen = new Map();
    for (const q of C[l]) {
      const k = q.q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      assert.ok(!seen.has(k), `${l}: ${q.id} = ${seen.get(k)}`);
      seen.set(k, q.id);
    }
  }
});

test("на каждый акт хватает уровней: Акт 1 — lvl 1–2, Акт 2 — lvl 2–3, тем не меньше пяти", () => {
  const reg = C.ru.filter((q) => !q.final);
  assert.ok(reg.filter((q) => q.lvl <= 2).length >= 100);
  assert.ok(reg.filter((q) => q.lvl >= 2).length >= 100);
  assert.ok(new Set(reg.map((q) => q.tag)).size >= 5);
  assert.ok(new Set(C.ru.filter((q) => q.final).map((q) => q.tag)).size >= 5);
});
