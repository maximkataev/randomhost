"use strict";

// Проверка банка вопросов (crowd-spec.md §6): node --test test-content.js
const test = require("node:test");
const assert = require("node:assert");
const CONTENT = require("./content");

const MIN = 350;
const Q_MAX = 90;
const OPT_MAX = 20;
const FORBIDDEN = {
  ru: /(путин|навальн|зеленск|трамп|байден|украин|израил|палестин|хамас|\bвойн[аыеуой]\b|ислам|христиан|иудаи|мусульман|евре[йяи]|\bнегр|\bгеи\b|\bгей[а-я]*|лесби|трансгенд|трансфоб|аборт|изнасил|суицид|самоубий|наркот|героин|кокаин)/i,
  en: /(putin|trump|biden|zelensk|ukrain|israel|palestin|hamas|\bwar\b|islam|christian|jewish|muslim|nazi|\bgay\b|lesbian|transgender|abortion|\brape|suicide|heroin|cocaine)/i,
  el: /(πούτιν|τραμπ|μπάιντεν|ουκρανία|ισραήλ|παλαιστίν|χαμάς|πόλεμο|ισλάμ|χριστιαν|εβραί|μουσουλμ|αμβλωσ|βιασμ|αυτοκτον|ηρωίν|κοκαΐν)/i,
};
const YES = { ru: ["да", "нет"], en: ["yes", "no"], el: ["ναι", "όχι"] };
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

for (const lang of CONTENT.LANGS) {
  test(`${lang}: объём, длины, поля, дубли`, () => {
    const list = CONTENT[lang];
    assert.ok(list.length >= MIN, `${lang}: ${list.length} < ${MIN}`);
    const ids = new Set(), qs = new Set(), pairs = new Set();
    for (const x of list) {
      assert.ok(x.id && !ids.has(x.id), `id ${x.id}`);
      ids.add(x.id);
      assert.ok(typeof x.q === "string" && x.q.trim() === x.q && Array.from(x.q).length >= (x.kind === "ab" ? 3 : 8) && Array.from(x.q).length <= Q_MAX, `${x.id}: длина вопроса «${x.q}»`);
      assert.ok(["yn", "ab"].includes(x.kind), `${x.id}: kind ${x.kind}`);
      assert.ok(CONTENT.TAGS.includes(x.tag), `${x.id}: тег ${x.tag}`);
      assert.ok(x.lean === "a" || x.lean === "b", `${x.id}: lean ${x.lean}`);
      for (const o of [x.a, x.b]) assert.ok(typeof o === "string" && o.trim() === o && o.length > 0 && Array.from(o).length <= OPT_MAX, `${x.id}: подпись «${o}»`);
      assert.notStrictEqual(norm(x.a), norm(x.b), `${x.id}: одинаковые варианты`);
      if (x.kind === "yn") assert.deepStrictEqual([norm(x.a), norm(x.b)], YES[lang], `${x.id}: у yn подписи «${YES[lang]}»`);
      if (x.kind === "ab") assert.ok(!YES[lang].includes(norm(x.a)), `${x.id}: ab с подписью да/нет`);
      // у А/Б подводка может повторяться («Что предпочтёшь?»), значит смысл — в паре вариантов
      const k = x.kind === "ab" ? norm(x.q) + "|" + [norm(x.a), norm(x.b)].sort().join("|") : norm(x.q);
      assert.ok(!qs.has(k), `${x.id}: дубль вопроса`);
      qs.add(k);
      if (x.kind === "ab") {
        const key = [norm(x.a), norm(x.b)].sort().join("|");
        assert.ok(!pairs.has(key), `${x.id}: дубль пары ${x.a}/${x.b}`);
        pairs.add(key);
      }
      assert.ok(!FORBIDDEN[lang].test(x.q + " " + x.a + " " + x.b), `${x.id}: запретная тема «${x.q}»`);
      assert.ok(typeof x.sensitive === "boolean", `${x.id}: sensitive`);
    }
  });

  test(`${lang}: доли — ab, lean b, sensitive, темы`, () => {
    const list = CONTENT[lang];
    const share = (f) => list.filter(f).length / list.length;
    const ab = share((x) => x.kind === "ab");
    const b = share((x) => x.lean === "b");
    assert.ok(ab >= 0.35 && ab <= 0.8, `${lang}: доля ab ${ab.toFixed(2)}`);
    assert.ok(b >= 0.4 && b <= 0.5, `${lang}: доля lean b ${b.toFixed(2)}`);
    const sens = list.filter((x) => x.sensitive);
    assert.ok(sens.length <= 12, `${lang}: sensitive ${sens.length}`);
    assert.ok(sens.every((x) => x.tag === "edge"), `${lang}: sensitive вне edge`);
    // каждая тема представлена; ни одна не больше 25 %
    for (const t of CONTENT.TAGS) {
      const n = list.filter((x) => x.tag === t).length;
      assert.ok(n >= (t === "edge" ? 6 : 20), `${lang}: тема ${t} — ${n}`);
      assert.ok(n / list.length <= (t === "pick" ? 0.15 : t === "spicy" ? 0.35 : 0.25), `${lang}: тема ${t} слишком велика`);
    }
    // lean b встречается в каждом виде вопросов, иначе баланс партии (game.takeQuestion) не из чего собрать
    assert.ok(list.some((x) => x.kind === "ab" && x.lean === "b"));
    assert.ok(list.some((x) => x.kind === "yn" && x.lean === "b"));
  });
}
