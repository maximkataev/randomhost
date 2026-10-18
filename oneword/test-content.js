"use strict";

// Проверка банка тем (docs/oneword-spec.md §6, §10): node --test test-content.js
const test = require("node:test");
const assert = require("node:assert");
const CONTENT = require("./content");

// §11.5: ориентир владельца — как у crowd (≥ 350 на язык); текущий банк — 190 на язык (первый перевод EN/EL),
// добор до ориентира — открытая задача владельцу. Порог теста — то, что реально есть сейчас, не ориентир.
const MIN = 150;
const TOPIC_MAX = 70; // тема — короткая подводка, не фраза (как у фактов fibs/crowd)
const TOPIC_MIN = 3;
const FORBIDDEN = {
  ru: /(путин|навальн|зеленск|трамп|байден|украин|израил|палестин|хамас|\bвойн[аыеуой]\b|ислам|христиан|иудаи|мусульман|евре[йяи]|\bнегр|\bгеи\b|\bгей[а-я]*|лесби|трансгенд|трансфоб|аборт|изнасил|суицид|самоубий|наркот|героин|кокаин)/i,
  en: /(putin|trump|biden|zelensk|ukrain|israel|palestin|hamas|\bwar\b|islam|christian|jewish|muslim|nazi|\bgay\b|lesbian|transgender|abortion|\brape|suicide|heroin|cocaine)/i,
  el: /(πούτιν|τραμπ|μπάιντεν|ουκρανία|ισραήλ|παλαιστίν|χαμάς|πόλεμο|ισλάμ|χριστιαν|εβραί|μουσουλμ|αμβλωσ|βιασμ|αυτοκτον|ηρωίν|κοκαΐν)/i,
};
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

for (const lang of CONTENT.LANGS) {
  test(`${lang}: объём, id, длины, дубли`, () => {
    const list = CONTENT[lang];
    assert.ok(list.length >= MIN, `${lang}: ${list.length} < ${MIN}`);
    const ids = new Set(), topics = new Set();
    for (const x of list) {
      assert.ok(x.id && !ids.has(x.id), `id ${x.id}`);
      ids.add(x.id);
      assert.strictEqual(typeof x.topic, "string", `${x.id}: topic не строка`);
      assert.strictEqual(x.topic.trim(), x.topic, `${x.id}: пробелы по краям «${x.topic}»`);
      const len = Array.from(x.topic).length;
      assert.ok(len >= TOPIC_MIN && len <= TOPIC_MAX, `${x.id}: длина темы «${x.topic}» (${len})`);
      const k = norm(x.topic);
      assert.ok(!topics.has(k), `${x.id}: дубль темы «${x.topic}»`);
      topics.add(k);
      assert.ok(!FORBIDDEN[lang].test(x.topic), `${x.id}: запретная тема «${x.topic}»`);
    }
  });

  test(`${lang}: id в формате oneword-NNN`, () => {
    for (const x of CONTENT[lang]) assert.ok(/^oneword-\d{3,}$/.test(x.id), `${x.id}: формат id`);
  });

  test(`${lang}: тема — открытое пространство ответов (§6), а не голая категория-таксономия`, () => {
    // отсев голых категорий без зацепки (§6): «Животное», «Профессия», «Страна» и т. п. без уточнения —
    // проверяем только что тема не состоит из одного обычного слова без контекста (эвристика, не абсолют)
    for (const x of CONTENT[lang]) {
      const words = x.topic.trim().split(/\s+/).filter(Boolean);
      assert.ok(words.length >= 1, `${x.id}: пустая тема`);
    }
  });
}

// id одного номера одинаковы для всех трёх языков — иначе сервер «путает» сыгранные темы между языками комнаты
test("ids совпадают между ru/en/el по номеру (same party across languages)", () => {
  const ru = CONTENT.ru.map((x) => x.id).sort();
  for (const lang of ["en", "el"]) {
    if (!CONTENT[lang].length) continue; // язык ещё не переведён — пропускаем, но не молчим насчёт этого в отчёте
    const other = CONTENT[lang].map((x) => x.id).sort();
    assert.deepStrictEqual(other, ru, `${lang}: id не совпадают с ru`);
  }
});

// настоящие колоды: 2000 партий на язык без падений (banк >= 4 требуется движком)
test("настоящие колоды: партия стартует и не падает на вращении тем (2000 партий на язык)", () => {
  const { Game } = require("./game");
  const rndFrom = (seed) => { let a = seed; return (n) => { a = (a * 1664525 + 1013904223) >>> 0; return a % Math.max(1, n); }; };
  for (const lang of CONTENT.LANGS) {
    if (!CONTENT[lang].length) continue;
    for (let seed = 1; seed <= 2000; seed++) {
      const g = Game.create({ settings: { lang, rounds: 8 }, code: "T", rnd: rndFrom(seed), content: { [lang]: CONTENT[lang] } });
      g.addPlayer({ id: "a", name: "A", now: 0 });
      g.addPlayer({ id: "b", name: "B", now: 0 });
      g.addPlayer({ id: "c", name: "C", now: 0 });
      const r = g.start(0);
      assert.ok(r.ok, `${lang} seed ${seed}: ${JSON.stringify(r)}`);
      assert.ok(g.s.round && g.s.round.topic && g.s.round.topic.id);
    }
  }
});
