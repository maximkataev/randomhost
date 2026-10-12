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

  test(`${lang}: слова полюсов ≥ 4 букв отвергаются как подсказка (V3)`, () => {
    // служебные слова полюса («Все», «Никто») сами по себе не полюс — их checkClue пропускает намеренно
    const SERVICE = new Set(("все всё это как для что так там тут или при без над под про его еще уже очень чем где кто мне нас вас них она они оно был быть свой твой мой себя " +
      "the and for not you are was but with very too all any can get its has have your our their from that this than " +
      "και για που από στο στη στην στον στα τον την του της των δεν μην πολύ όλα ένα μια είναι σαν").split(" ").map((w) => normalize(w)));
    for (const s of CONTENT[lang]) {
      const stems = (x) => new Set(normalize(x).split(" "));
      const L = stems(s.l), R = stems(s.r);
      for (const [pole, own, other] of [[s.l, L, R], [s.r, R, L]]) {
        for (const raw of pole.split(/\s+/)) {
          const w = raw.replace(/[^\p{L}]/gu, "");
          const st = normalize(w);
          if (Array.from(w).length < 4 || st.length < 3 || SERVICE.has(st) || other.has(st) || !own.has(st)) continue;
          assert.strictEqual(checkClue(w, s).reason, "pole", `${s.id}: «${w}» из «${pole}» принято`);
        }
      }
    }
  });

  // строгий режим (RULE_U34_WAVE_RULES) ничего не разрешает сверх нестрогого: слово полюса отвергается так же,
  // а 🙂 проходит у каждой шкалы; «numeral» допустим только для слова, которое само — числительное
  test(`${lang}: строгий валидатор — слова полюсов отвергаются, 🙂 проходит`, () => {
    for (const s of CONTENT[lang]) {
      assert.ok(checkClue("🙂", s, { strict: true }).ok, s.id);
      for (const raw of (s.l + " " + s.r).split(/\s+/)) {
        const w = raw.replace(/[^\p{L}]/gu, "");
        if (Array.from(w).length < 4) continue;
        const a = checkClue(w, s), b = checkClue(w, s, { strict: true });
        if (!a.ok) assert.ok(!b.ok, `${s.id}: «${w}» строго принято`);
      }
    }
  });
}
