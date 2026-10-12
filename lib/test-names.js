"use strict";
// node --test lib/test-names.js   (T-W1-01)
const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanName, nameKey, baseOf, nextFreeName, takenKeysOf, LIMITS } = require("./names");

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])/;
const LONE_LOW = /(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

// сервер: берёт имя, заводит его в «занятые», возвращает итоговое
function joinAll(names, max) {
  const taken = new Set();
  return names.map((n) => {
    const got = nextFreeName(n, taken, max);
    taken.add(nameKey(got));
    return got;
  });
}

test("три «Маша» подряд -> «Маша», «Маша (2)», «Маша (3)»", () => {
  assert.deepEqual(joinAll(["Маша", "Маша", "Маша"]), ["Маша", "Маша (2)", "Маша (3)"]);
});

test("ввод «Маша (2)» при занятом -> «Маша (3)», без «Маша (2) (2)»", () => {
  const taken = new Set(["маша", "маша(2)"]);
  assert.equal(nextFreeName("Маша (2)", taken), "Маша (3)");
  assert.equal(nextFreeName("Маша", taken), "Маша (3)");
});

test("«Маша (5)» при свободном остаётся как есть", () => {
  assert.equal(nextFreeName("Маша (5)", new Set(["маша"])), "Маша (5)");
});

test("«Маша 2» (старый формат) не режется и не даёт «Маша 2 2»", () => {
  const taken = new Set([nameKey("Маша 2")]);
  assert.equal(nextFreeName("Маша 2", taken), "Маша 2 (2)");
  assert.equal(baseOf("Маша 2"), "Маша 2");
});

test("«хитрый » = «Хитрый»: один ключ, регистр, пробелы, ё", () => {
  assert.equal(nameKey("хитрый "), nameKey("Хитрый"));
  assert.equal(nameKey("Ёж"), nameKey("еж"));
  assert.equal(nameKey("Ма ша"), nameKey("маша"));
  assert.equal(nextFreeName("хитрый ", new Set([nameKey("Хитрый")])), "хитрый (2)");
});

test("ключ: NFKC и невидимые символы", () => {
  assert.equal(nameKey("ＡＢＣ"), "abc");
  assert.equal(nameKey("A​B"), "ab");
});

test("«10×😀» режется по символам, без одиночного суррогата", () => {
  const raw = "😀".repeat(10) + "x";
  for (const max of [3, 5, 15, 16]) {
    const c = cleanName(raw, max);
    assert.equal(Array.from(c).length, Math.min(max, 11));
    assert.ok(!LONE.test(c) && !LONE_LOW.test(c), "одиночный суррогат при max=" + max);
  }
  assert.equal(cleanName("😀".repeat(10), 16), "😀".repeat(10));
});

test("одиночные суррогаты на входе вырезаются", () => {
  assert.equal(cleanName("a\ud83db", 16), "ab");
  assert.equal(cleanName("a\ude00b", 16), "ab");
});

test("«Room 101» и «Агент 7» целы; baseOf режет только хвост « (N)»", () => {
  assert.equal(baseOf("Room 101"), "Room 101");
  assert.equal(baseOf("Агент 7"), "Агент 7");
  assert.equal(baseOf("Маша (2)"), "Маша");
  assert.equal(baseOf("Маша(2)"), "Маша(2)");
  assert.equal(baseOf("(2)"), "(2)");
  assert.equal(baseOf("Маша (2) (3)"), "Маша (2)");
  assert.equal(baseOf("Маша (x)"), "Маша (x)");
  assert.equal(nextFreeName("Room 101", new Set(["room101"])), "Room 101 (2)");
});

test("cleanName: <>, управляющие, схлопывание пробелов, хвостовые «-» и «.»", () => {
  assert.equal(cleanName("  <b>Ваня</b>  ", 16), "bВаня/b");
  assert.equal(cleanName("Ма\u0000​ша", 16), "Маша");
  assert.equal(cleanName("Ма   ша", 16), "Ма ша");
  assert.equal(cleanName("Маша-.. -", 16), "Маша");
  assert.equal(cleanName("   ", 16), "");
  assert.equal(cleanName(null, 16), "");
  assert.equal(cleanName(42, 16), "");
  assert.equal(cleanName("<>", 16), "");
});

test("cleanName: «<3» в имени сохраняет цифру, угловая скобка вырезана (только для имён)", () => {
  assert.equal(cleanName("<img onerror=x>", 30), "img onerror=x");
});

test("лимиты 15/16/24: срез и усечение базы под суффикс", () => {
  const long = "Александрина-Виктория-Элеонора";
  assert.equal(Array.from(cleanName(long, 15)).length <= 15, true);
  assert.equal(LIMITS.AUCTION, 24);
  for (const max of [15, 16, 24]) {
    const base = "Я".repeat(max);
    const taken = new Set([nameKey(base)]);
    const a = nextFreeName(base, taken, max);
    assert.equal(a, "Я".repeat(max - 4) + " (2)");
    assert.equal(Array.from(a).length, max);
    taken.add(nameKey(a));
    const b = nextFreeName(base, taken, max);
    assert.equal(b, "Я".repeat(max - 4) + " (3)");
    // повторный вход с уже усечённым именем не плодит суффиксы
    // (базы «Я»×(max-4) ещё нет — она и выдаётся, без второго суффикса)
    assert.equal(nextFreeName(a, taken, max), "Я".repeat(max - 4));
    taken.add(nameKey("Я".repeat(max - 4)));
    assert.equal(nextFreeName(a, taken, max), "Я".repeat(max - 4) + " (3)");
  }
});

test("двузначные номера и усечение эмодзи-базы по символам", () => {
  const base = "😀".repeat(16);
  const taken = new Set([nameKey(base)]);
  const a = nextFreeName(base, taken, 16);
  assert.equal(a, "😀".repeat(12) + " (2)");
  assert.ok(!LONE.test(a));
  const names = joinAll(Array(12).fill("Миша"), 16);
  assert.equal(names[11], "Миша (12)");
  assert.equal(new Set(names.map(nameKey)).size, 12);
});

test("taken: Set, массив и функция; пустое имя -> пустая строка", () => {
  assert.equal(nextFreeName("Аня", ["аня"]), "Аня (2)");
  assert.equal(nextFreeName("Аня", (k) => k === "аня"), "Аня (2)");
  assert.equal(nextFreeName("", new Set()), "");
  assert.equal(nextFreeName("***", new Set(), 16), "***");
});

test("takenKeysOf: skipId и skipLeft", () => {
  const ps = [{ id: 1, name: "Аня" }, { id: 2, name: "Боря", left: true }, { id: 3, name: "Вика" }];
  assert.deepEqual([...takenKeysOf(ps)].sort(), ["аня", "боря", "вика"]);
  assert.deepEqual([...takenKeysOf(ps, { skipId: 1, skipLeft: true })], ["вика"]);
});

test("без побочных эффектов на импорте: модуль чистый (нет таймеров/сокетов)", () => {
  assert.equal(typeof cleanName, "function");
});
