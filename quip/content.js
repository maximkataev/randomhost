"use strict";

/*
 * Колоды вопросов (quip-spec.md §6): content/{ru,en,el}.json → { duel: [{q, h}], emoji: [{e, h}], rev: [{a, h}], final: [{q, h: [[3]]}] }.
 * id карточки — короткий хеш текста: правка колоды между выкатками не путает «уже сыгранные» в живых комнатах.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LANGS = ["ru", "en", "el"];

// Подсказка целиком в кавычках («Диван-Фит», "Every photo is her forehead") выдаёт себя на экране:
// живые люди с телефона кавычек почти не ставят (плейтест, §4 «от своего ответа не отличить»).
// Снимаем внешнюю пару, если внутри других кавычек нет — прямую речь внутри фразы не трогаем.
const WRAP = /^\s*(["«“„'])([^"«»“”„]*)(["»”“'])\s*$/;
function unwrap(x) {
  if (typeof x !== "string") return x;
  const m = WRAP.exec(x);
  return m && m[2].trim() ? m[2].trim() : x;
}
const hints = (h) => (h || []).map((x) => (Array.isArray(x) ? x.map(unwrap) : unwrap(x)));
const DECKS = ["duel", "emoji", "rev", "final"];

function load(dir = path.join(__dirname, "content")) {
  const out = {};
  for (const lang of LANGS) {
    out[lang] = { duel: [], emoji: [], rev: [], final: [] };
    const file = path.join(dir, lang + ".json");
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const deck of DECKS) {
      out[lang][deck] = (data[deck] || []).map((c) => ({
        ...c,
        h: hints(c.h),
        id: crypto.createHash("sha1").update(deck + "|" + (c.q || c.e || c.a)).digest("hex").slice(0, 10),
      }));
    }
  }
  return out;
}

module.exports = load();
module.exports.load = load;
module.exports.LANGS = LANGS;
module.exports.DECKS = DECKS;
module.exports.unwrap = unwrap;
