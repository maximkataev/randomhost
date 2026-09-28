"use strict";

/*
 * Банк шкал (wave-spec.md §5): content/{ru,en,el}.json → { scales: [{id, l, r, tag}] }.
 * Колоды пишутся под каждый язык отдельно; id уникален внутри языка — по нему комната помнит сыгранные шкалы.
 */

const fs = require("fs");
const path = require("path");

const LANGS = ["ru", "en", "el"];
const TAGS = ["classic", "food", "people", "things", "places", "vibe", "internet", "life", "words", "pop"];

function load(dir = path.join(__dirname, "content")) {
  const out = {};
  for (const lang of LANGS) {
    const file = path.join(dir, lang + ".json");
    out[lang] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).scales || [] : [];
  }
  return out;
}

module.exports = load();
module.exports.load = load;
module.exports.LANGS = LANGS;
module.exports.TAGS = TAGS;
