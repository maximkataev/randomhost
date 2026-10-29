"use strict";

// Проверка банков «Позывного» (callsign-spec.md §6): node --test test-content.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const content = require("./content");
const { boardClash } = require("./game");

const RX = {
  ru: /^[А-ЯЁа-яё]{3,14}$/,
  en: /^[A-Za-z]{3,14}$/,
  el: /^[Α-Ωα-ωάέήίόύώϊϋΐΰΆΈΉΊΌΎΏ]{3,14}$/,
};

for (const lang of ["ru", "en", "el"]) {
  test(`слова ${lang}: объём, формат, дубли`, () => {
    const words = content[lang];
    assert.ok(words.length >= 700, `слов ${words.length} < 700`);
    const seen = new Set();
    for (const w of words) {
      assert.equal(typeof w, "string");
      assert.match(w, RX[lang], `«${w}»: не по формату`);
      const k = w.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
      assert.ok(!seen.has(k), `дубль: ${w}`);
      seen.add(k);
    }
  });

  test(`слова ${lang}: пары с общим началом: допустимо, поле их не сводит (boardClash)`, () => {
    // допустимо: бессвязные пары с общим началом (байка/Байкал). Больше порога — значит банк испорчен.
    const words = content[lang];
    let clashes = 0;
    for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) if (boardClash(words[i], words[j])) clashes++;
    assert.ok(clashes <= 40, `пар с общей основой: ${clashes}`);
  });
}

test("картинки: файлы, серость, группы", () => {
  const pics = content.pics;
  assert.ok(pics.length >= 300, `картинок ${pics.length} < 300`);
  assert.ok(new Set(pics.map((p) => p.g)).size >= 15);
  const ids = new Set();
  for (const p of pics) {
    assert.ok(!ids.has(p.id), `дубль ${p.id}`);
    ids.add(p.id);
    const file = path.join(__dirname, "pics", p.id + ".svg");
    assert.ok(fs.existsSync(file), `нет файла ${p.id}.svg`);
    const svg = fs.readFileSync(file, "utf8");
    // все цвета — серые: #rrggbb с равными каналами, #rgb с равными цифрами
    for (const m of svg.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
      assert.ok(h.slice(0, 2) === h.slice(2, 4) && h.slice(2, 4) === h.slice(4, 6), `${p.id}: цветной ${m[0]}`);
    }
    assert.ok(!/rgb\(/.test(svg), `${p.id}: rgb()`);
  }
});
