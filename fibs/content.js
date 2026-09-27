"use strict";

/*
 * Банк фактов (fibs-spec.md §6): content/{ru,en,el}.json → { facts: [{id, topic, final, text, answer, alts, lies, source}] }.
 * id общий для всех языков: «уже сыгранные» в живой комнате не путаются при правке текста.
 */

const fs = require("fs");
const path = require("path");

const LANGS = ["ru", "en", "el"];
const TOPICS = ["animals", "food", "history", "laws", "records", "inventions", "space", "body", "places", "culture", "language", "nature", "sport"];

function load(dir = path.join(__dirname, "content")) {
  const out = {};
  for (const lang of LANGS) {
    const file = path.join(dir, lang + ".json");
    out[lang] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).facts || [] : [];
  }
  return out;
}

module.exports = load();
module.exports.load = load;
module.exports.LANGS = LANGS;
module.exports.TOPICS = TOPICS;
