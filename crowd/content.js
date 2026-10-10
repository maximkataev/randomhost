"use strict";

/*
 * Банк вопросов (crowd-spec.md §6): content/{ru,en,el}.json → { questions: [{id, q, a, b, kind, tag, lean, sensitive}] }.
 * Колоды пишутся под каждый язык отдельно; id уникален внутри языка — по нему комната помнит сыгранные вопросы.
 */

const fs = require("fs");
const path = require("path");

const LANGS = ["ru", "en", "el"];
// pick — «выбери из двух» (цвет, число, сторона…), taste — вкусы, absurd — нелепые дилеммы, habits — мелкие привычки,
// spicy — острые и неловкие дилеммы (отношения, эго, постыдное), dark — чёрный юмор и «цена вопроса»,
// social — житейские ситуации, work/money/tech — по названию, edge — редкие «сомнительные» абстрактные вопросы
const TAGS = ["spicy", "dark", "pick", "taste", "absurd", "habits", "social", "work", "money", "tech", "edge"];

function load(dir = path.join(__dirname, "content")) {
  const out = {};
  for (const lang of LANGS) {
    const file = path.join(dir, lang + ".json");
    out[lang] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).questions || [] : [];
  }
  return out;
}

// CONTENT_DIR — для тестов и разработки (другая папка с колодами)
module.exports = load(process.env.CONTENT_DIR || undefined);
module.exports.load = load;
module.exports.LANGS = LANGS;
module.exports.TAGS = TAGS;
