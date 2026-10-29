"use strict";

/*
 * Ключ сравнения ответов для «Джинкса» (quip-spec.md §5): два ответа с одинаковым ключом — оба по нулям.
 * Регистр, ё/е, греческие ударения, знаки препинания и эмодзи не важны; каждое слово приводится к основе,
 * чтобы «Кота в мешке» и «кот в мешке» совпали. Стеммер выбирается по алфавиту слова, а не по языку комнаты:
 * в русской партии кто-нибудь да напишет по-английски.
 * RU — Snowball Russian (полностью), EN и EL — облегчённые: окончания множественного числа, времени, падежа.
 */

// ---------- русский: Snowball ----------

const RU_VOWELS = "аеиоуыэюя";
const isRuVowel = (c) => RU_VOWELS.includes(c);

// longest-first, чтобы «ившись» не проиграло «ись»
const byLen = (a) => a.slice().sort((x, y) => y.length - x.length);
const RU = {
  gerund1: byLen(["в", "вши", "вшись"]),
  gerund2: byLen(["ив", "ивши", "ившись", "ыв", "ывши", "ывшись"]),
  reflexive: byLen(["ся", "сь"]),
  adjective: byLen(["ее", "ие", "ые", "ое", "ими", "ыми", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "его", "ого", "ему", "ому", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею"]),
  participle1: byLen(["ем", "нн", "вш", "ющ", "щ"]),
  participle2: byLen(["ивш", "ывш", "ующ"]),
  verb1: byLen(["ла", "на", "ете", "йте", "ли", "й", "л", "ем", "н", "ло", "но", "ет", "ют", "ны", "ть", "ешь", "нно"]),
  verb2: byLen(["ила", "ыла", "ена", "ейте", "уйте", "ите", "или", "ыли", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ило", "ыло", "ено", "ят", "ует", "уют", "ит", "ыт", "ены", "ить", "ыть", "ишь", "ую", "ю"]),
  noun: byLen(["а", "ев", "ов", "ие", "ье", "е", "иями", "ями", "ами", "еи", "ии", "и", "ией", "ей", "ой", "ий", "й", "иям", "ям", "ием", "ем", "ам", "ом", "о", "у", "ах", "иях", "ях", "ы", "ь", "ию", "ью", "ю", "ия", "ья", "я"]),
  superlative: byLen(["ейш", "ейше"]),
  derivational: byLen(["ост", "ость"]),
};

// Окончание из списка, целиком лежащее в регионе [from..]; для групп «после а/я» — и эта буква в регионе
function ruEnding(w, from, list, afterAYa) {
  for (const e of list) {
    if (!w.endsWith(e)) continue;
    const at = w.length - e.length;
    if (at < from) continue;
    if (afterAYa) {
      const prev = w[at - 1];
      if (at - 1 < from || (prev !== "а" && prev !== "я")) continue;
    }
    return e;
  }
  return null;
}
function ruCut(w, from, groups) {
  for (const [list, aya] of groups) {
    const e = ruEnding(w, from, list, aya);
    if (e) return w.slice(0, w.length - e.length);
  }
  return null;
}

function stemRu(word) {
  let w = word;
  // RV — после первой гласной; R1 — после первой согласной, идущей за гласной; R2 — то же внутри R1
  let rv = w.length;
  for (let i = 0; i < w.length; i++) if (isRuVowel(w[i])) { rv = i + 1; break; }
  const region = (start) => {
    for (let i = start; i < w.length - 1; i++) if (isRuVowel(w[i]) && !isRuVowel(w[i + 1])) return i + 2;
    return w.length;
  };
  const r1 = region(0);
  const r2 = region(r1);
  if (rv >= w.length) return w;

  // шаг 1
  const g = ruCut(w, rv, [[RU.gerund1, true], [RU.gerund2, false]]);
  if (g != null) w = g;
  else {
    const r = ruCut(w, rv, [[RU.reflexive, false]]);
    if (r != null) w = r;
    const adj = ruCut(w, rv, [[RU.adjective, false]]);
    if (adj != null) {
      w = adj;
      const part = ruCut(w, rv, [[RU.participle1, true], [RU.participle2, false]]);
      if (part != null) w = part;
    } else {
      const v = ruCut(w, rv, [[RU.verb1, true], [RU.verb2, false]]);
      if (v != null) w = v;
      else {
        const n = ruCut(w, rv, [[RU.noun, false]]);
        if (n != null) w = n;
      }
    }
  }
  // шаг 2
  if (w.endsWith("и") && w.length - 1 >= rv) w = w.slice(0, -1);
  // шаг 3
  const d = ruEnding(w, r2, RU.derivational, false);
  if (d) w = w.slice(0, w.length - d.length);
  // шаг 4
  if (w.endsWith("нн") && w.length - 2 >= rv) w = w.slice(0, -1);
  else {
    const s = ruEnding(w, rv, RU.superlative, false);
    if (s) {
      w = w.slice(0, w.length - s.length);
      if (w.endsWith("нн")) w = w.slice(0, -1);
    } else if (w.endsWith("ь") && w.length - 1 >= rv) w = w.slice(0, -1);
  }
  return w;
}

// ---------- английский: облегчённый Porter ----------

const EN_VOWEL = /[aeiouy]/;
function stemEn(word) {
  let w = word.replace(/['’]s?$/, "");
  if (w.length <= 3) return w;
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  const stripV = (suf) => {
    if (!w.endsWith(suf)) return false;
    const stem = w.slice(0, -suf.length);
    if (stem.length < 2 || !EN_VOWEL.test(stem)) return false;
    w = stem;
    // running → runn → run; hopping → hop
    if (/([bdfgmnprt])\1$/.test(w)) w = w.slice(0, -1);
    return true;
  };
  if (!w.endsWith("eed")) stripV("ing") || stripV("ed");
  for (const suf of ["ational", "ization", "fulness", "iveness", "ousness", "ation", "ness", "ment", "ful", "ly", "er", "est"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) { w = w.slice(0, -suf.length); break; }
  }
  if (w.endsWith("y") && w.length > 3) w = w.slice(0, -1) + "i";
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

// ---------- греческий: окончания без ударений ----------

const EL_SUFFIXES = byLen(["ματων", "ματος", "ματα", "ιων", "ιου", "ιας", "ιες", "εις", "ους", "ουν", "ουμε", "ετε", "ανε", "ων", "ος", "ου", "ας", "ες", "ης", "οι", "αι", "ει", "εσ", "ια", "α", "ε", "η", "ι", "ο", "υ", "ω"]);
function stemEl(word) {
  const w = word.replace(/ς/g, "σ").replace(/σ$/, "ς");
  const base = w.replace(/ς$/, "σ");
  for (const suf of EL_SUFFIXES) {
    const s = suf.replace(/ς$/, "σ");
    if (base.endsWith(s) && base.length - s.length >= 3) return base.slice(0, -s.length);
  }
  return base;
}

// ---------- ключ ответа ----------

function stemWord(w) {
  if (/[а-я]/.test(w)) return stemRu(w);
  if (/[α-ω]/.test(w)) return stemEl(w);
  if (/[a-z]/.test(w)) return stemEn(w);
  return w;
}

function normalize(text) {
  const raw = String(text == null ? "" : text).toLowerCase().replace(/ё/g, "е");
  // ударения и диалитики — прочь (NFD отделяет их как метки); й и ё уже учтены выше, й бережём
  const plain = raw.replace(/й/g, "\u0001").normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").replace(/\u0001/g, "й");
  const words = plain.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
  if (!words.length) {
    // ответ из одних эмодзи или знаков: сравниваем как есть, без пробелов
    return "#" + raw.replace(/\s+/g, "");
  }
  return words.map(stemWord).join(" ");
}

// Ключ набора из трёх пунктов (финал): порядок пунктов не важен
function normalizeList(items) {
  return (Array.isArray(items) ? items : [items]).map(normalize).filter((x) => x && x !== "#").sort().join(" | ");
}

module.exports = { normalize, normalizeList, stemRu, stemEn, stemEl };
