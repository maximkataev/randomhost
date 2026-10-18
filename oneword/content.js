"use strict";

/*
 * Банк тем раунда (docs/oneword-spec.md §6): content/{ru,en,el}.json → { topics: [{id, topic}] }.
 * Колоды пишутся под каждый язык отдельно; id уникален внутри языка — по нему комната помнит сыгранные темы.
 */

const fs = require("fs");
const path = require("path");

const LANGS = ["ru", "en", "el"];

function load(dir = path.join(__dirname, "content")) {
  const out = {};
  for (const lang of LANGS) {
    const file = path.join(dir, lang + ".json");
    out[lang] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).topics || [] : [];
  }
  return out;
}

// CONTENT_DIR — для тестов и разработки (другая папка с колодами)
module.exports = load(process.env.CONTENT_DIR || undefined);
module.exports.load = load;
module.exports.LANGS = LANGS;
