"use strict";

// Проверка банка «Айфилю»: node --test test-content.js  (или npm run content)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load, validate, LANGS } = require("./content");
const { cardKey, CARD_MAX } = require("./game");

const DIR = path.join(__dirname, "content");
const quiet = null; // без предупреждений в выводе тестов

for (const lang of LANGS) {
  const file = path.join(DIR, lang + ".json");
  test(`${lang}.json: формат и объём банка (§10)`, { skip: !fs.existsSync(file) && `${lang}.json ещё нет — комната играет русский банк` }, () => {
    const problems = [];
    const bank = validate(JSON.parse(fs.readFileSync(file, "utf8")), problems);
    assert.deepStrictEqual(problems, [], "битые записи");
    assert.ok(bank);
    for (const mode of ["safe", "edgy"]) {
      const cats = bank.categories.filter((c) => c.mode === mode);
      assert.ok(cats.length >= 40, `${mode}: категорий ${cats.length} < 40`);
      assert.ok(cats.filter((c) => c.pref).length >= 12, `${mode}: категорий о предпочтениях мало — по одной на тройку при 12 игроках`);
      for (const c of cats) {
        assert.ok(c.items.length >= 12, `${c.id}: пунктов ${c.items.length} < 12`);
        const keys = c.items.map((x) => cardKey(x.t));
        assert.strictEqual(new Set(keys).size, keys.length, `${c.id}: повтор пункта`);
      }
      const prompts = bank.prompts.filter((p) => p.mode === mode);
      assert.ok(prompts.length >= 30, `${mode}: подсказок R2 ${prompts.length} < 30`);
      for (const p of prompts) {
        assert.ok(p.prompt.includes("{name}"), `${p.id}: нет {name}`);
        assert.ok(p.examples.length >= 12, `${p.id}: примеров ${p.examples.length} < 12`);
        for (const e of p.examples) assert.ok(Array.from(e).length <= CARD_MAX, `${p.id}: пример длиннее ${CARD_MAX}: ${e}`);
        assert.ok(new Set(p.examples.map(cardKey)).size >= 6, `${p.id}: пример для вето и добора должен найтись`);
      }
      assert.ok(bank.random.scales.filter((x) => x.mode === mode).length >= 15, `${mode}: шкал «🎲» < 15`);
    }
    assert.ok(bank.random.pool.length >= 250, `пул «🎲» ${bank.random.pool.length} < 250`);
  });
}

test("нет файла языка — комната получает русский банк; available честно перечисляет настоящие языки", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ifeel-c-"));
  fs.copyFileSync(path.join(DIR, "ru.json"), path.join(dir, "ru.json"));
  const c = load(dir, quiet);
  assert.deepStrictEqual(c.available, ["ru"]);
  assert.strictEqual(c.en, c.ru);
  assert.strictEqual(c.el, c.ru);
});

test("битый или неполный файл языка — тоже русский банк, а не падение", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ifeel-c-"));
  fs.copyFileSync(path.join(DIR, "ru.json"), path.join(dir, "ru.json"));
  fs.writeFileSync(path.join(dir, "en.json"), "{ это не json");
  fs.writeFileSync(path.join(dir, "el.json"), JSON.stringify({ categories: [{ id: "x", mode: "safe", title: "t", top: "a", bottom: "b", items: ["1", "2", "3", "4", "5", "6", "7"] }], prompts: [], random: { pool: [], scales: [] } }));
  const c = load(dir, quiet);
  assert.deepStrictEqual(c.available, ["ru"]);
  assert.strictEqual(c.en, c.ru);
  assert.strictEqual(c.el, c.ru);
});

test("валидатор выбрасывает битые записи по одной, не весь банк", () => {
  const ru = JSON.parse(fs.readFileSync(path.join(DIR, "ru.json"), "utf8"));
  ru.categories.push({ id: "bad-1", mode: "safe", title: "мало пунктов", top: "a", bottom: "b", items: [{ t: "x" }] });
  ru.categories.push({ id: ru.categories[0].id, mode: "safe", title: "повтор id", top: "a", bottom: "b", items: ru.categories[0].items });
  ru.prompts.push({ id: "bad-2", mode: "edgy", prompt: "без примеров {name}", top: "a", bottom: "b", examples: [] });
  const problems = [];
  const bank = validate(ru, problems);
  assert.ok(bank);
  assert.strictEqual(problems.length, 3);
  assert.ok(!bank.categories.some((c) => c.id === "bad-1"));
  assert.ok(!bank.prompts.some((p) => p.id === "bad-2"));
});

test("черновики и вырезанное не читаются", () => {
  const c = load(DIR, quiet);
  const ids = new Set(c.ru.categories.map((x) => x.id));
  for (const sub of ["draft", "cut"]) {
    const d = path.join(DIR, sub);
    if (!fs.existsSync(d)) continue;
    // в банк попадает только ru.json: число категорий совпадает с файлом
    assert.strictEqual(ids.size, JSON.parse(fs.readFileSync(path.join(DIR, "ru.json"), "utf8")).categories.length);
  }
});
