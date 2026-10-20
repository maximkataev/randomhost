"use strict";

// Тесты базовой стратегии и подсказок Марго (blackjack-spec.md §12): node --test test-strategy.js
const test = require("node:test");
const assert = require("node:assert");
const S = require("./strategy");
const { advise, hint, PHRASES, UP } = S;

/*
 * Эталон — независимая запись таблицы для 6 колод, S17, DAS, без сдачи (wizardofodds / «Blackjack Attack»),
 * строка — рука, столбцы — карта дилера 2..A. Буквы: H ещё, S хватит, D удвоить (нельзя — ещё), Ds удвоить (нельзя — хватит),
 * P сплит. Записана отдельно от strategy.js, чтобы ошибка в таблице не повторилась в тесте.
 */
const REF_HARD = {
  8: "H H H H H H H H H H", 9: "H D D D D H H H H H", 10: "D D D D D D D D H H", 11: "D D D D D D D D D H",
  12: "H H S S S H H H H H", 13: "S S S S S H H H H H", 14: "S S S S S H H H H H", 15: "S S S S S H H H H H", 16: "S S S S S H H H H H",
  17: "S S S S S S S S S S",
};
const REF_SOFT = {
  13: "H H H D D H H H H H", 14: "H H H D D H H H H H", 15: "H H D D D H H H H H", 16: "H H D D D H H H H H", 17: "H D D D D H H H H H",
  18: "S Ds Ds Ds Ds S S H H H", 19: "S S S S S S S S S S", 20: "S S S S S S S S S S",
};
const REF_PAIRS = {
  A: "P P P P P P P P P P", 2: "P P P P P P H H H H", 3: "P P P P P P H H H H", 4: "H H H P P H H H H H", 5: "D D D D D D D D H H",
  6: "P P P P P H H H H H", 7: "P P P P P P H H H H", 8: "P P P P P P P P P P", 9: "P P P P P S P P S S", 10: "S S S S S S S S S S",
};
const WORD = { H: "hit", S: "stand", D: "double", Ds: "double", P: "split" };

// составить жёсткую руку без пары и без туза, нужной суммы (5..17); для 18–21 — тоже без пары
function hardHand(total) {
  const combos = { 5: [2, 3], 6: [2, 4], 7: [2, 5], 8: [2, 6], 9: [2, 7], 10: [2, 8], 11: [2, 9], 12: [3, 9], 13: [3, 10], 14: [4, 10], 15: [5, 10], 16: [6, 10], 17: [7, 10], 18: [8, 10], 19: [9, 10], 20: [7, 10, 3], 21: [7, 10, 4] };
  return combos[total].map((v) => ({ r: String(v), s: "s" }));
}
const softHand = (total) => [{ r: "A", s: "s" }, { r: String(total - 11), s: "h" }];
const pairHand = (r) => [{ r: r, s: "s" }, { r: r, s: "h" }];
const up = (r) => ({ r: r, s: "d" });
const cols = (row) => row.split(/\s+/);

test("жёсткие руки 5–21 × 10 карт дилера — по эталону (с удвоением и без него)", () => {
  for (let total = 5; total <= 21; total++) {
    const row = cols(REF_HARD[Math.min(17, Math.max(8, total))]);
    UP.forEach((u, i) => {
      const a = advise({ cards: hardHand(total), canDouble: true, canSplit: true }, up(u));
      assert.strictEqual(a.action, WORD[row[i]], `жёсткие ${total} против ${u}`);
      const noD = advise({ cards: hardHand(total), canDouble: false }, up(u));
      assert.strictEqual(noD.action, row[i] === "D" ? "hit" : WORD[row[i]], `жёсткие ${total} против ${u} без удвоения`);
      if (row[i] === "D") assert.strictEqual(a.fallback, "hit");
    });
  }
  // три карты — удвоения нет, остаётся запасной ход
  assert.strictEqual(advise({ cards: [{ r: "2", s: "s" }, { r: "4", s: "s" }, { r: "5", s: "s" }], canDouble: true }, up("6")).action, "hit");
});

test("мягкие руки 13–21 × 10 карт дилера — по эталону; A+A без сплита — ещё", () => {
  for (let total = 13; total <= 21; total++) {
    const row = cols(REF_SOFT[Math.min(20, total)]);
    UP.forEach((u, i) => {
      const a = advise({ cards: softHand(total), canDouble: true }, up(u));
      assert.strictEqual(a.action, WORD[row[i]], `мягкие ${total} против ${u}`);
      const noD = advise({ cards: softHand(total), canDouble: false }, up(u));
      assert.strictEqual(noD.action, row[i] === "D" ? "hit" : row[i] === "Ds" ? "stand" : WORD[row[i]], `мягкие ${total} против ${u} без удвоения`);
      assert.ok(a.soft || total === 21);
    });
  }
  for (const u of UP) assert.strictEqual(advise({ cards: pairHand("A"), canSplit: false }, up(u)).action, "hit", "A+A без сплита — мягкие 12");
});

test("пары × 10 карт дилера — по эталону; без сплита — как обычная рука; K+10 — пара десяток", () => {
  for (const r of Object.keys(REF_PAIRS)) {
    const row = cols(REF_PAIRS[r]);
    UP.forEach((u, i) => {
      const a = advise({ cards: pairHand(r), canDouble: true, canSplit: true }, up(u));
      assert.strictEqual(a.action, WORD[row[i]], `пара ${r} против ${u}`);
      const noP = advise({ cards: pairHand(r), canDouble: true, canSplit: false }, up(u));
      assert.notStrictEqual(noP.action, "split");
      if (row[i] === "P") assert.strictEqual(noP.action, a.fallback, `запасной ход пары ${r} против ${u}`);
    });
  }
  assert.strictEqual(advise({ cards: [{ r: "K", s: "s" }, { r: "10", s: "h" }], canSplit: true }, up("6")).action, "stand");
  assert.strictEqual(advise({ cards: pairHand("8"), canSplit: true, fromSplit: true }, up("6")).action, "stand", "после сплита ре-сплита нет: 16 против 6 — хватит");
  assert.strictEqual(advise({ cards: pairHand("A"), canSplit: true }, up("A")).key, "split_aces");
  assert.strictEqual(advise({ cards: pairHand("8"), canSplit: true }, up("10")).key, "split_eights");
  assert.strictEqual(advise({ cards: [{ r: "A", s: "s" }, { r: "K", s: "s" }] }, up("10")).key, "blackjack");
  assert.strictEqual(advise({ cards: [{ r: "A", s: "s" }, { r: "K", s: "s" }], fromSplit: true }, up("10")).key, "twentyone");
});

// слова-действия, с которых может начинаться подсказка (на каждом языке)
const LEADS = {
  ru: { hit: ["Бери", "Ещё"], stand: ["Стой", "Хватит"], double: ["Удваивай"], split: ["Сплит", "Дели"] },
  en: { hit: ["Hit"], stand: ["Stand", "Hold"], double: ["Double"], split: ["Split"] },
  el: { hit: ["Τράβα"], stand: ["Στοπ", "Μείνε"], double: ["Διπλό"], split: ["Σπλιτ"] },
};
const NEUTRAL_LEADS = { ru: ["Блэкджек", "Перебор"], en: ["Blackjack", "Bust"], el: ["Μπλακτζάκ", "Κάηκες"] };
const words = (t) => t.split(/\s+/).filter((w) => w && !/^[—–-]$/.test(w));

test("подсказки: у каждой ситуации не меньше 5 формулировок на ru/en/el, все ситуации таблицы покрыты, подстановки заполнены", () => {
  const seen = new Set();
  const hands = [];
  for (let t = 5; t <= 21; t++) hands.push({ cards: hardHand(t) });
  for (let t = 13; t <= 21; t++) hands.push({ cards: softHand(t) });
  for (const r of Object.keys(REF_PAIRS)) hands.push({ cards: pairHand(r) });
  hands.push({ cards: [{ r: "A", s: "s" }, { r: "K", s: "s" }] });
  hands.push({ cards: [{ r: "K", s: "s" }, { r: "Q", s: "s" }, { r: "5", s: "s" }] });
  for (const h of hands) for (const u of UP) for (const canDouble of [true, false]) for (const canSplit of [true, false]) {
    seen.add(advise({ cards: h.cards, canDouble, canSplit }, up(u)).key);
  }
  const keys = Object.keys(PHRASES.ru);
  for (const k of keys) assert.ok(seen.has(k), `ситуация ${k} недостижима`);
  for (const k of seen) assert.ok(keys.indexOf(k) >= 0, `для ситуации ${k} нет текстов`);
  for (const lang of ["ru", "en", "el"]) {
    assert.deepStrictEqual(Object.keys(PHRASES[lang]).sort(), keys.slice().sort(), lang);
    for (const k of keys) {
      assert.ok(PHRASES[lang][k].length >= 5, `${lang}/${k}: ${PHRASES[lang][k].length} формулировок`);
      assert.strictEqual(new Set(PHRASES[lang][k]).size, PHRASES[lang][k].length, `${lang}/${k}: повторы`);
      for (const tpl of PHRASES[lang][k]) assert.strictEqual(tpl.split("|").length, 2, `${lang}/${k}: нужен формат «слово|причина»: ${tpl}`);
    }
  }
  // все варианты: подстановки заполнены, слово-действие первым и соответствует ходу, ≤ 10 слов, заглавная, точка в конце
  let variants = 0;
  for (const h of hands) for (const u of UP) for (const lang of ["ru", "en", "el"]) for (const canDouble of [true, false]) {
    const hand = { cards: h.cards, canDouble, canSplit: true };
    const a = advise(hand, up(u));
    const texts = new Set();
    for (let i = 0; i < 5; i++) {
      const p = S.hintParts(hand, up(u), lang, (n) => i % n);
      const t = p.text;
      assert.ok(!/[{}|]/.test(t), `${lang}: ${t}`);
      assert.ok(/[.!?]$/.test(t), `${lang}: ${t}`);
      assert.strictEqual(t.charAt(0), t.charAt(0).toUpperCase());
      assert.strictEqual(p.action, a.action);
      const okLeads = (LEADS[lang][a.action] || []).concat(NEUTRAL_LEADS[lang]);
      assert.ok(okLeads.indexOf(p.lead) >= 0, `${lang}: слово «${p.lead}» не годится для хода ${a.action}`);
      assert.ok(t.startsWith(p.lead + ". "), t);
      assert.ok(words(t).length <= 10, `${lang}: ${words(t).length} слов: ${t}`);
      texts.add(t);
    }
    if (texts.size > 1) variants++;
  }
  assert.ok(variants > hands.length * UP.length * 2, "формулировки действительно разные");
  // «что делать» на первом месте, причина коротко
  assert.strictEqual(hint({ cards: hardHand(14) }, up("6"), "ru", () => 0), "Стой. У меня шестёрка — перебрать могу я.");
  assert.strictEqual(hint({ cards: pairHand("A") }, up("9"), "ru", () => 0), "Сплит. Два туза — всегда делим.");
  assert.ok(/^Удваивай\. /.test(hint({ cards: hardHand(11) }, up("6"), "ru", () => 0)));
  assert.ok(/^Hit\. /.test(hint({ cards: softHand(17) }, up("2"), "en", () => 0)));
  assert.ok(hint({ cards: hardHand(16) }, up("A"), "el", () => 0).indexOf("άσο") > 0 || hint({ cards: hardHand(16) }, up("A"), "el", () => 1).indexOf("άσο") > 0 || hint({ cards: hardHand(16) }, up("A"), "el", () => 2).indexOf("άσο") > 0);
  // нет удвоения — слово запасного хода, не «Удваивай»
  const na = S.hintParts({ cards: hardHand(10), canDouble: false }, up("5"), "ru", () => 0);
  assert.strictEqual(na.action, "hit");
  assert.strictEqual(na.lead, "Бери");
  assert.ok(!/фишек/.test(na.text), "причина недоступности не про фишки: три карты тоже без удвоения");
  // lastHint (с префиксом или без) — не повторяем ту же фразу подряд
  const first = S.hintParts({ cards: hardHand(19) }, up("5"), "ru", () => 0).text;
  assert.notStrictEqual(hint({ cards: hardHand(19), lastHint: first }, up("5"), "ru", () => 0), first);
  // неизвестный язык — русский
  assert.strictEqual(hint({ cards: pairHand("A") }, up("9"), "xx", () => 0), "Сплит. Два туза — всегда делим.");
  // очевидные ситуации известны, остальные — с причиной
  for (const k of S.OBVIOUS_KEYS) assert.ok(keys.indexOf(k) >= 0, k);
});

test("подсказки: падежи, артикли, префикс «Рука N:» после сплита, нет задвоенных слов", () => {
  const A = (r) => ({ r: r, s: "s" });
  // ru: после «против» только родительный; en: никаких «my a»; el: карта дилера не в именительном после предлога
  for (const lang of ["ru", "en", "el"]) for (const k of Object.keys(PHRASES[lang])) for (const tpl of PHRASES[lang][k]) {
    if (lang === "ru") assert.ok(!/[Пп]ротив \{dealer\}/.test(tpl), tpl);
    if (lang === "en") assert.ok(!/my \{dealer\}/.test(tpl) && !/\ban? \{hard\}/.test(tpl), tpl);
    if (lang === "el") assert.ok(!/στο \{dealer\}|το \{dealer\}/.test(tpl), tpl);
  }
  for (const u of UP) for (let i = 0; i < 5; i++) {
    for (const lang of ["ru", "en", "el"]) {
      const t = hint({ cards: [A("8"), A("8")] }, up(u), lang, (n) => i % n);
      assert.ok(!/(пара|pair|\bmy a\b|\ban a\b)\s+(пара|pair)/i.test(t), t);
    }
    assert.ok(!/my an? /.test(hint({ cards: hardHand(16) }, up(u), "en", (n) => i % n)));
  }
  const any = (list, re) => list.some((tpl) => re.test(tpl));
  assert.ok(any(PHRASES.ru.stand_vs_weak, /против \{dealerGen\}/));
  assert.ok(hint({ cards: hardHand(14) }, up("5"), "ru", () => 1).indexOf("против пятёрки") > 0);
  assert.ok(/I show a five/.test(hint({ cards: hardHand(16) }, up("5"), "en", () => 0)));
  // префикс только при fromSplit + handIdx
  const h = { cards: [A("8"), A("3")], fromSplit: true, handIdx: 1 };
  assert.strictEqual(hint(h, up("10"), "ru", () => 0).slice(0, 8), "Рука 2: ");
  assert.strictEqual(hint(h, up("10"), "en", () => 0).slice(0, 8), "Hand 2: ");
  assert.strictEqual(hint(h, up("10"), "el", () => 0).slice(0, 8), "Χέρι 2: ");
  assert.strictEqual(S.hintParts(h, up("10"), "ru", () => 0).prefix, "Рука 2");
  assert.ok(!/^Рука/.test(hint({ cards: h.cards, fromSplit: true }, up("10"), "ru", () => 0)));
  assert.ok(!/^Рука/.test(hint({ cards: h.cards, handIdx: 0 }, up("10"), "ru", () => 0)));
});

test("нарастающая подача: первые раздачи — полностью, потом короче, очевидное тише", () => {
  assert.strictEqual(S.hintMode("hit_scary", 0), "full");
  assert.strictEqual(S.hintMode("stand_high", 2), "full");
  assert.strictEqual(S.hintMode("stand_high", 3), "lead");
  assert.strictEqual(S.hintMode("stand_high", 8), "quiet");
  assert.strictEqual(S.hintMode("hit_scary", 8), "full");
  assert.strictEqual(S.hintMode("hit_scary", 12), "lead");
  assert.strictEqual(S.hintMode("double_11", undefined), "full");
});
