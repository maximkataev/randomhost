"use strict";

/*
 * Банк вопросов (lastq-spec.md §6): content/{ru,en,el}.json → { questions: [{id, tag, lvl, final, q, a, fun}] }.
 * a[0] — верный, порядок перемешивает движок. id общий для всех языков: «уже сыгранные» в комнате не путаются.
 */

const fs = require("fs");
const path = require("path");

const LANGS = ["ru", "en", "el"];
const TAGS = ["animals", "food", "geo", "body", "science", "screen", "weird", "space_nature"];

// LQ_CONTENT_DIR — другой банк (тесты сервера)
function load(dir = process.env.LQ_CONTENT_DIR || path.join(__dirname, "content")) {
  const out = {};
  for (const lang of LANGS) {
    const file = path.join(dir, lang + ".json");
    out[lang] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).questions || [] : [];
  }
  return out;
}

module.exports = load();
module.exports.load = load;
module.exports.LANGS = LANGS;
module.exports.TAGS = TAGS;
