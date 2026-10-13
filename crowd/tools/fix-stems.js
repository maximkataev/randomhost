#!/usr/bin/env node
"use strict";

/*
 * Миграция заголовков А/Б «законченный вопрос» (T-W4-02, crowd-016..020; docs/crowd-spec.md §6).
 *   node tools/fix-stems.js            — переписать crowd/content/{ru,en,el}.json
 *   node tools/fix-stems.js --dry      — только отчёт «было → стало», файлы не трогать
 * Идемпотентно: заголовки, которые уже заканчиваются на «?» / «;», не меняются.
 * Правила: механические по шаблонам + ручные таблицы по id (всё, что шаблоном не берётся).
 * Греческий: вопросительные уже с «;», а «Ώρα:» / «Στο σπίτι…» — продолжение (допустимо по спеке) — не трогаем.
 */

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "content");
const DRY = process.argv.includes("--dry");
const Q_MAX = 80;

// ---- EN: ручные, по id (то, что шаблонами «Worse …» / «Better …» не покрыть) ----
const EN_MANUAL = {
  // «Which …» без глагола и «You'd rather …»
  "en-117": "What's worse at your funeral?",
  "en-118": "Which would you rather know?",
  "en-120": "Which would you rather choose?",
  "en-122": "Which would you take?",
  "en-127": "Which power would you take for a day?",
  "en-153": "Which would you rather do?",
  "en-158": "Which would you rather have?",
  "en-161": "Which would you rather do?",
  "en-163": "Which wedding gift is better?",
  "en-165": "Which habit is cheaper?",
  "en-187": "Which would you rather have?",
  "en-221": "Which is more annoying?",
  "en-291": "Which are you prouder of?",
  "en-294": "Which would you rather be?",
  "en-313": "Which curse is worse?",
  "en-314": "Which fear is worse?",
  "en-315": "Which animal would you rather fight?",
  "en-316": "Which is more embarrassing?",
  "en-317": "Which smell is worse?",
  "en-318": "Which roommate would you pick?",
  "en-319": "Which job would you take?",
  "en-320": "Which sound would you rather hear forever?",
  "en-321": "Which pet would you keep?",
  "en-322": "Which curse is worse?",
  "en-323": "Which accent would you take for life?",
  "en-458": "Which is more attractive?",
  "en-479": "Which would you rather be?",
  "en-509": "Which would you rather do?",
  "en-551": "Which is more forgivable?",
  "en-554": "Which would you rather have?",
  "en-555": "Which would you rather do?",
  "en-571": "Which is harder?",
  "en-572": "Which is more romantic?",
  "en-542": "Who do you tell first?",
  "en-087": "Who do you forgive first?",
  "en-078": "Who would you rather date?",
  "en-121": "Which is the worst fate?",
  "en-076": "Which is worse to hear?",
  // слишком длинные (>80), смысл сохранён
  "en-058": "Would you like your ex's new partner's post and pretend it was nothing?",
  "en-129": "Would you hold a party with drinks instead of a quiet funeral?",
  "en-570": "Would you date someone far more successful than you?",
};
// ---- RU: ручные по id (существительное/«Выбери …» -> вопрос) ----
const RU_MANUAL = {
  "ru-009": "Какую карту выберешь?",
  "ru-030": "Что для тебя важнее?",
  "ru-034": "Какую жизнь выберешь?",
  "ru-036": "Куда нажать, чтобы включить свет?",
  "ru-041": "Как должна висеть туалетная бумага?",
  "ru-044": "Какой салат лучше?",
  "ru-056": "Какой ресторан лучше?",
  "ru-079": "Какую сторону света выберешь?",
  "ru-080": "Какой город выберешь?",
  "ru-089": "Что выберешь?",
  "ru-091": "Какое время выберешь?",
  "ru-100": "Что делать, если друг встречается с твоим бывшим?",
  "ru-112": "Какая грань кубика лучше?",
  "ru-114": "Какое число выберешь?",
  "ru-118": "От чего ревность сильнее?",
  "ru-124": "Какую кухню выберешь на ужин?",
  "ru-126": "Какой хлеб лучше?",
  "ru-127": "Какое слово тебе ближе?",
  "ru-129": "Какой день недели выберешь?",
  "ru-152": "Какое время суток лучше?",
  "ru-153": "Какая фигура лучше?",
  "ru-160": "Как отметишь свой день рождения?",
  "ru-167": "Какие наушники лучше?",
  "ru-188": "Какая яичница лучше?",
  "ru-190": "Как платить по счёту на свидании?",
  "ru-199": "Какое число выберешь?",
  "ru-214": "Какое место в кинозале лучше?",
  "ru-233": "Какую цифру выберешь?",
  "ru-241": "До скольки гулять на вечеринке?",
  "ru-242": "Что ответишь на вопрос «Как дела»?",
  "ru-247": "Какое число выберешь?",
  "ru-252": "Что делать после ссоры в офисе?",
  "ru-263": "Как лучше есть борщ?",
  "ru-284": "Как лучше попасть на свидание вслепую?",
  "ru-287": "Какой подарок партнёру лучше?",
  "ru-299": "Что страшнее показать в начале романа?",
  "ru-300": "Что делать с романом на работе?",
  "ru-302": "Что отключить?",
  "ru-303": "Какой смайлик выберешь?",
  "ru-304": "Какой начальник лучше?",
  "ru-309": "С кем лучше работать?",
  "ru-312": "Какое место в самолёте лучше?",
  "ru-316": "Что отключить навсегда?",
  "ru-336": "Какой партнёр лучше по возрасту?",
  "ru-350": "Какая смерть лучше?",
  "ru-355": "Что кладёшь в тарелку первым?",
  "ru-359": "Что помогает утром после вечеринки?",
  "ru-361": "К кому ревность острее?",
  "ru-362": "На что не жалко тратить?",
  "ru-371": "Что лучше получить от бывшего?",
  "ru-373": "Какая работа лучше?",
  "ru-381": "Что сделаешь, если друг просит денег в долг?",
  "ru-382": "Что сделаешь, если новая пассия друга — не пара?",
  "ru-386": "На что лучше тратить?",
  "ru-393": "Какая свадьба лучше?",
  "ru-394": "Какой ужин лучше?",
  "ru-395": "Что сделаешь сначала?",
  "ru-399": "Что удалить?",
  "ru-406": "Какая пицца лучше?",
  "ru-419": "Что хуже, если партнёр забыл?",
  "ru-432": "Что заказать на первом свидании?",
  "ru-446": "Как лучше узнать об измене?",
  "ru-447": "Какой красный флаг сильнее?",
  "ru-334": "Чего боишься сильнее?",
  "ru-347": "Какой день недели выберешь?",
  "ru-168": "Какую работу выберешь?",
  "ru-201": "Кого легче терпеть?",
  // слишком длинное (>80)
  "ru-464": "Остался бы с тем, кто зарабатывает намного больше, хоть это давит на гордость?",
};
// ---- EL: только слишком длинные (>80); «;» уже стоит, продолжения («Ώρα:», «Στο σπίτι…») допустимы ----
const EL_MANUAL = {
  "el-130": "Θα άφηνες το κινητό σου ξεκλείδωτο σε φίλο που θα «δει μόνο μια φωτογραφία»;",
  "el-238": "Θα έπαιρνες το μέρος του φίλου σου σε καβγά με τον σύντροφό σου, αν έχει άδικο;",
  "el-440": "Θα παράτησες μια σταθερή δουλειά για ένα όνειρο, με αποταμίευση για έναν χρόνο;",
  "el-454": "Θα φορούσες μια μέρα πινακίδα με το χειρότερο μυστικό σου για 10.000 ευρώ;",
  "el-224": "Θα έτρωγες το άθλιο φαγητό του συντρόφου σου για να μην τον στενοχωρήσεις;",
  "el-288": "Θα έβαζες τη μισή σου περιουσία σε κορώνα-γράμματα για να τη διπλασιάσεις;",
  "el-442": "Θα έλεγες στον συνάδελφό σου ότι δεν τα καταφέρνει, αν βουλιάζετε και οι δύο;",
  "el-417": "Θα κρυφοκοίταζες το Instagram του νέου σου συναδέλφου πριν τη δεύτερη μέρα;",
  "el-362": "Θα ζούσες ένα χρόνο σε νησί με έναν άγνωστο για 1 εκατομμύριο;",
  "el-246": "Θα έκοβες φίλο που φέρεται άσχημα στον σύντροφό σου, αν είναι ο παλιότερός σου;",
  "el-220": "Θα προτιμούσες να σε φοβούνται...",
};

// ---- шаблоны EN ----
const EN_PREP = /^(in|at|on|with|for|about|to|online)\b(?!-)/i;
function enRule(q) {
  if (/[?;]$/.test(q)) return q;
  if (q === "Worse") return "Which is worse?";
  if (q === "Better") return "Which is better?";
  if (q === "Pick one") return "Which one do you pick?";
  if (/^Which\b/.test(q) || /^(What's|What)\b/.test(q)) return q + "?";
  let m = /^Worse (.+)$/.exec(q);
  if (m) return EN_PREP.test(m[1]) ? `Which is worse ${m[1]}?` : `Which is the worse ${m[1]}?`;
  m = /^Better (.+)$/.exec(q);
  if (m) return `Which is the better ${m[1]}?`;
  return null;
}

// ---- шаблоны RU ----
const RU_INTERROG = /^(Что|Кого|Кому|Кем|Какой|Какая|Какое|Какую|Какие|Кто|Чья|Чьи|Куда|Где|Чего|С кем|На что|Как)(?=\s|$)/u;
function ruRule(q) {
  if (/[?;]$/.test(q)) return q;
  return RU_INTERROG.test(q) ? q + "?" : null;
}

function migrate(lang, x) {
  if (x.kind !== "ab" && Array.from(x.q).length <= Q_MAX) return x.q;
  const manual = { en: EN_MANUAL, ru: RU_MANUAL, el: EL_MANUAL }[lang][x.id];
  if (manual) return manual;
  if (x.kind !== "ab") return x.q;
  if (lang === "en") return enRule(x.q);
  if (lang === "ru") return ruRule(x.q);
  return x.q; // el: «;» уже есть, продолжения допустимы
}

let bad = 0;
const report = [];
for (const lang of ["ru", "en", "el"]) {
  const file = path.join(DIR, lang + ".json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const x of data.questions) {
    const next = migrate(lang, x);
    if (next === null) { console.error(`НЕ РАЗОБРАН: ${x.id} «${x.q}»`); bad++; continue; }
    if (next !== x.q) { report.push([x.id, x.q, next]); x.q = next; }
    if (Array.from(x.q).length > Q_MAX) { console.error(`ДЛИННЫЙ ${Array.from(x.q).length}: ${x.id} «${x.q}»`); bad++; }
  }
  if (!DRY) fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
}
for (const [id, a, b] of report) console.log(`${id}\t${a}\t->\t${b}`);
console.error(`изменено: ${report.length}${DRY ? " (dry)" : ""}, проблем: ${bad}`);
process.exit(bad ? 1 : 0);
