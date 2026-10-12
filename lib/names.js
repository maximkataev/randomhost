"use strict";

/*
 * Имена игроков — одна реализация вместо десяти клонов (IMPLEMENTATION-PLAN T-W1-01, пакет P1).
 * Только встроенные модули Node, без побочных эффектов на импорте; ни одна игра пока её не вызывает.
 *
 * ПУБЛИЧНЫЙ API
 *   cleanName(raw, max = 16)            -> string
 *       Имя для показа и хранения: управляющие/невидимые символы и «<» «>» вырезаны (ТОЛЬКО для имён —
 *       тексты ответов/лжи экранирует вывод), одиночные суррогаты вырезаны, пробелы схлопнуты, срез
 *       по СИМВОЛАМ (Array.from), а не по UTF-16 — «10×😀» не превращается в «�»; хвостовые «-» «.»
 *       и пробелы обрезаны. Регистр и «ё» не трогаются. Нестроки -> "".
 *   nameKey(s)                          -> string
 *       Ключ сравнения: NFKC + нижний регистр + без пробелов/невидимых + ё=е. «Хитрый » == «хитрый».
 *   baseOf(name)                        -> string
 *       Убирает ТОЛЬКО хвост « (N)»: «Маша (2)» -> «Маша»; «Агент 7», «Room 101», «Маша(2)» целы.
 *   nextFreeName(want, taken, max = 16) -> string
 *       Свободное имя в формате U-05 «База (N)». `taken` — Set/массив КЛЮЧЕЙ (nameKey), либо функция
 *       key => bool. Если очищенное `want` свободно — возвращается оно само («Маша (5)» при свободном
 *       остаётся). Иначе база = baseOf(want); сначала «База», затем «База (2)», «База (3)»…
 *       База усекается так, чтобы с суффиксом влезть в `max` (15/16/24 — лимит игры; не унифицируем).
 *       Никогда не даёт «Маша (2) (2)» и «Имя 2 2». Пустое имя -> "".
 *   takenKeysOf(players, {skipId, skipLeft}) -> Set<string>
 *       Ключи имён списка игроков {id,name,left?}: удобно подать в nextFreeName.
 *   LIMITS                              -> {DEFAULT:16, SHORT:15, AUCTION:24}  справочная константа
 *
 * ЛИМИТЫ: у floe/rapids/crowd — 15, у большинства — 16, у аукциона — 24 (maxlength телефона). Лимит
 * передаёт сам сервер игры; клиенту его отдают в `hello.limits.name`.
 */

const LIMITS = Object.freeze({ DEFAULT: 16, SHORT: 15, AUCTION: 24 });

// управляющие, DEL и C1, мягкий перенос, нулевой ширины/направления (U+200B–200F, U+202A–202E,
// U+2060–2064, U+2066–2069), BOM; плюс угловые скобки (только в именах)
const STRIP_NAME = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿<>]/g;

function stripLoneSurrogates(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { out += s[i] + s[i + 1]; i++; }
    } else if (c < 0xdc00 || c > 0xdfff) {
      out += s[i];
    }
  }
  return out;
}

// хвостовые «-», «.» и пробелы (в любом порядке)
function trimTail(s) {
  return s.replace(/[\s\-.]+$/u, "");
}

function cleanName(raw, max) {
  if (typeof raw !== "string") return "";
  const limit = Number.isInteger(max) && max > 0 ? max : LIMITS.DEFAULT;
  let t = stripLoneSurrogates(raw).replace(STRIP_NAME, "").replace(/\s+/gu, " ").trim();
  t = Array.from(t).slice(0, limit).join("");
  return trimTail(t.trim());
}

function nameKey(s) {
  if (typeof s !== "string") return "";
  return stripLoneSurrogates(s).normalize("NFKC").replace(STRIP_NAME, "").toLowerCase()
    .replace(/\s+/gu, "").replace(/ё/g, "е");
}

function baseOf(name) {
  const s = typeof name === "string" ? name : "";
  const m = s.match(/^(.*\S)\s+\(\d+\)$/u);
  return m ? m[1] : s;
}

function isTaken(taken, key) {
  if (typeof taken === "function") return !!taken(key);
  if (taken && typeof taken.has === "function") return taken.has(key);
  if (Array.isArray(taken)) return taken.indexOf(key) !== -1;
  return false;
}

function nextFreeName(want, taken, max) {
  const limit = Number.isInteger(max) && max > 0 ? max : LIMITS.DEFAULT;
  const first = cleanName(want, limit);
  if (!first) return "";
  if (!isTaken(taken, nameKey(first))) return first;
  const base = baseOf(first);
  if (base && !isTaken(taken, nameKey(base))) return base;
  for (let n = 2; n < 10000; n++) {
    const suffix = " (" + n + ")";
    const room = limit - Array.from(suffix).length;
    if (room < 1) break;
    const head = trimTail(Array.from(base).slice(0, room).join("").trim());
    if (!head) break;
    const cand = head + suffix;
    if (!isTaken(taken, nameKey(cand))) return cand;
  }
  // недостижимо при разумных лимитах; запасной вариант — хоть что-то уникальное
  return Array.from(base).slice(0, Math.max(1, limit - 7)).join("") + " (" + (Date.now() % 9000 + 1000) + ")";
}

function takenKeysOf(players, opts) {
  const o = opts || {};
  const set = new Set();
  for (const p of players || []) {
    if (!p || (o.skipId != null && p.id === o.skipId)) continue;
    if (o.skipLeft && p.left) continue;
    const k = nameKey(p.name);
    if (k) set.add(k);
  }
  return set;
}

module.exports = { cleanName, nameKey, baseOf, nextFreeName, takenKeysOf, LIMITS };
