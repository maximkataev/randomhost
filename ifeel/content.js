"use strict";

/*
 * Банк «Айфилю» (docs/ifeel-spec.md §10): content/{ru,en,el}.json →
 *   { categories: [{id, mode, title, top, bottom, items:[{t, e?}], pref?}],
 *     prompts:    [{id, mode, prompt (с {name}), top, bottom, examples:[str]}],
 *     random:     { pool:[{t, e?}], scales:[{id, mode, title, top, bottom}] } }
 * Банки RU/EN/EL — не переводы, а разные наборы. Язык, которого нет (или файл битый), подменяется русским:
 * комната с языком EN без en.json играет русский банк, а доска честно показывает флажок RU (game.contentLang).
 * Черновики (content/draft, content/cut) не читаем.
 */

const fs = require("fs");
const path = require("path");

const LANGS = ["ru", "en", "el"];
const MODES = ["safe", "edgy"];
const SET_SIZE = 5;
const TEXT_MAX = 80;

const str = (v, max = TEXT_MAX) => (typeof v === "string" && v.trim() && Array.from(v).length <= max ? v.trim() : null);
function item(x) {
  if (typeof x === "string") return str(x) ? { t: x.trim() } : null;
  if (!x || typeof x !== "object") return null;
  const t = str(x.t);
  if (!t) return null;
  const e = str(x.e, 16);
  return e ? { t, e } : { t };
}

/*
 * Проверка файла: битые записи выбрасываются по одной (с причиной в problems), а язык годен, только если
 * в каждом режиме есть хотя бы 3 категории (из них ≥ 1 о предпочтениях), подсказка R2 и шкала «🎲»,
 * а в общем пуле ≥ 10 вещей. Иначе — null, и вызывающий берёт русский банк.
 */
function validate(data, problems = []) {
  if (!data || typeof data !== "object") { problems.push("не объект"); return null; }
  const ids = new Set();
  const uniq = (id, what) => {
    if (typeof id !== "string" || !id) { problems.push(`${what}: нет id`); return false; }
    if (ids.has(id)) { problems.push(`${what}: повтор id ${id}`); return false; }
    ids.add(id);
    return true;
  };
  const categories = [];
  for (const c of Array.isArray(data.categories) ? data.categories : []) {
    if (!c || !uniq(c.id, "категория")) continue;
    const items = (Array.isArray(c.items) ? c.items : []).map(item).filter(Boolean);
    if (!MODES.includes(c.mode) || !str(c.title, 160) || !str(c.top) || !str(c.bottom) || items.length < SET_SIZE + 2) {
      problems.push(`категория ${c.id}: неполная`);
      continue;
    }
    categories.push({ id: c.id, mode: c.mode, title: c.title.trim(), top: c.top.trim(), bottom: c.bottom.trim(), items, pref: c.pref === true });
  }
  const prompts = [];
  for (const p of Array.isArray(data.prompts) ? data.prompts : []) {
    if (!p || !uniq(p.id, "подсказка")) continue;
    const examples = (Array.isArray(p.examples) ? p.examples : []).map((x) => str(x, 40)).filter(Boolean);
    if (!MODES.includes(p.mode) || !str(p.prompt, 200) || !str(p.top) || !str(p.bottom) || examples.length < SET_SIZE) {
      problems.push(`подсказка ${p.id}: неполная`);
      continue;
    }
    prompts.push({ id: p.id, mode: p.mode, prompt: p.prompt.trim(), top: p.top.trim(), bottom: p.bottom.trim(), examples });
  }
  const rnd = data.random && typeof data.random === "object" ? data.random : {};
  const pool = (Array.isArray(rnd.pool) ? rnd.pool : []).map(item).filter(Boolean);
  const scales = [];
  for (const sc of Array.isArray(rnd.scales) ? rnd.scales : []) {
    if (!sc || !uniq(sc.id, "шкала")) continue;
    if (!MODES.includes(sc.mode) || !str(sc.title, 160) || !str(sc.top) || !str(sc.bottom)) { problems.push(`шкала ${sc.id}: неполная`); continue; }
    scales.push({ id: sc.id, mode: sc.mode, title: sc.title.trim(), top: sc.top.trim(), bottom: sc.bottom.trim() });
  }
  let ok = pool.length >= 10;
  if (!ok) problems.push("пул «🎲» меньше 10");
  for (const m of MODES) {
    const cs = categories.filter((c) => c.mode === m);
    if (cs.length < 3 || !cs.some((c) => c.pref)) { problems.push(`${m}: мало категорий или нет pref`); ok = false; }
    if (!prompts.some((p) => p.mode === m)) { problems.push(`${m}: нет подсказок R2`); ok = false; }
    if (!scales.some((x) => x.mode === m)) { problems.push(`${m}: нет шкал`); ok = false; }
  }
  return ok ? { categories, prompts, random: { pool, scales } } : null;
}

function load(dir = path.join(__dirname, "content"), log = console) {
  const out = { available: [] };
  for (const lang of LANGS) {
    const file = path.join(dir, lang + ".json");
    out[lang] = null;
    if (!fs.existsSync(file)) continue;
    const problems = [];
    let bank = null;
    try { bank = validate(JSON.parse(fs.readFileSync(file, "utf8")), problems); } catch (err) { problems.push("JSON: " + err.message); }
    if (problems.length && log) log.warn(`[ifeel] ${lang}.json: ${problems.length} замечаний (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "; …" : ""})`);
    if (bank) { out[lang] = bank; out.available.push(lang); }
  }
  // нет языка — русский банк (а нет и его — пустой: старт партии откажет no_content)
  for (const lang of LANGS) if (!out[lang]) out[lang] = out.ru || null;
  return out;
}

// CONTENT_DIR — для тестов и разработки (другая папка с банками)
module.exports = load(process.env.CONTENT_DIR || undefined);
module.exports.load = load;
module.exports.validate = validate;
module.exports.LANGS = LANGS;
module.exports.MODES = MODES;
