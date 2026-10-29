"use strict";

/*
 * Банки «Позывного» (callsign-spec.md §6): слова — content/{ru,en,el}.json (массив строк),
 * картинки — content/pics.json (массив {id, g}: имя файла pics/<id>.svg и группа — на поле не больше двух из одной).
 */

const fs = require("fs");
const path = require("path");

const LANGS = ["ru", "en", "el"];

function read(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

function load(dir = path.join(__dirname, "content")) {
  const out = {};
  for (const lang of LANGS) out[lang] = read(path.join(dir, lang + ".json"));
  out.pics = read(path.join(dir, "pics.json"));
  return out;
}

module.exports = load();
module.exports.load = load;
module.exports.LANGS = LANGS;
