"use strict";

// Прогон банка через isTruth с типовыми вариантами написания правды (T-W4-01, fibs-048/051/052).
// Печатает расхождения «вариант не принят» по классам; метрика «до/после» = число фактов с расхождением.
//   node tools/audit-alts.js            — сводка и списки
//   node tools/audit-alts.js --json     — машинный вывод
// Классы (каждый — вариант, который живой игрок впишет как правду, и isTruth обязан принять):
//   case   : регистр, ё/е, точка, кавычки, лишние пробелы, дефис вместо пробела
//   art    : (EN) «the/a/an» впереди ответа и без него
//   spell  : (EN) британское ↔ американское написание из списка
//   fleet  : (RU) беглая гласная: «ветер» → «ветра», «пёс» → «пса» (формы последнего слова)
//   plural : (EN) число последнего слова: «dog» ↔ «dogs»
//   head   : (все, ответ из 2+ слов) одно слово-голова («лёгких» при «овечьих лёгких») — справочно
// Плюс «lieSyn»: в одном факте правда/alt и ложь — синонимы из ручного списка (SYN) или две лжи-синонима.
const path = require("path");
const { load, LANGS } = require("../content");
const { isTruth } = require(process.env.AUDIT_GAME || "../game");

const C = load(path.join(__dirname, "..", "content"));

const SYN = {
  ru: [["томат", "помидор"], ["машина", "автомобиль", "авто"], ["конь", "лошадь"], ["пёс", "собака"], ["бегемот", "гиппопотам"], ["картошка", "картофель"], ["велосипед", "велик"], ["самолёт", "аэроплан"], ["кабачок", "цуккини"], ["пластырь", "лейкопластырь"], ["телефон", "мобильник"], ["тюлень", "нерпа"], ["чайка", "чайки"], ["варенье", "джем"], ["сок", "нектар"], ["лук", "луковица"], ["мясо", "мякоть"], ["кино", "фильм"], ["сапоги", "ботфорты"], ["шторы", "занавески"], ["диван", "софа"], ["собаки", "псы"], ["грибы", "шампиньоны"], ["вертолёт", "геликоптер"], ["мопед", "скутер"], ["очки", "окуляры"], ["рюкзак", "ранец"], ["щенок", "собачонок"]],
  en: [["car", "automobile"], ["bike", "bicycle"], ["phone", "telephone"], ["couch", "sofa"], ["pants", "trousers"], ["tv", "television"], ["rabbit", "bunny"], ["sneakers", "trainers"], ["cookie", "biscuit"], ["candy", "sweets"], ["movie", "film"], ["truck", "lorry"], ["garbage", "trash", "rubbish"], ["elevator", "lift"], ["flashlight", "torch"], ["gas", "petrol"], ["eggplant", "aubergine"], ["zucchini", "courgette"], ["cilantro", "coriander"], ["arugula", "rocket"], ["shrimp", "prawn"], ["tomato", "tomatoes"], ["helicopter", "chopper"], ["moped", "scooter"], ["glasses", "spectacles"], ["backpack", "rucksack"], ["puppy", "pup"], ["jam", "jelly"], ["soda", "pop"]],
  el: [["ντομάτα", "τομάτα"], ["αυτοκίνητο", "αμάξι"], ["τηλεόραση", "τιβι"], ["ποδήλατο", "ποδήλατα"], ["σκύλος", "σκυλί"], ["γάτα", "γατί"], ["καναπές", "ντιβάνι"], ["κινητό", "τηλέφωνο"], ["ελικόπτερο", "ελικοφόρο"], ["παντελόνι", "βράκα"], ["μοτοσικλέτα", "μηχανή"], ["ταινία", "φιλμ"]],
};

const BRIT = [["colour", "color"], ["grey", "gray"], ["tyre", "tire"], ["favourite", "favorite"], ["centre", "center"], ["theatre", "theater"], ["litre", "liter"], ["metre", "meter"], ["jewellery", "jewelry"], ["aluminium", "aluminum"], ["mould", "mold"], ["plough", "plow"], ["cheque", "check"], ["pyjamas", "pajamas"], ["whisky", "whiskey"], ["moustache", "mustache"], ["defence", "defense"], ["travelling", "traveling"], ["armour", "armor"], ["harbour", "harbor"], ["neighbour", "neighbor"], ["honour", "honor"], ["flavour", "flavor"], ["labour", "labor"], ["odour", "odor"], ["sulphur", "sulfur"], ["catalogue", "catalog"], ["dialogue", "dialog"], ["programme", "program"], ["cosy", "cozy"], ["doughnut", "donut"], ["mum", "mom"]];

const lit = (s) => String(s).toLowerCase().replace(/ё/g, "е").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");

function variants(f, lang) {
  const out = []; // [класс, вариант]
  const a = f.answer;
  out.push(["case", a.toUpperCase()], ["case", a.toLowerCase()], ["case", a + "."], ["case", "«" + a + "»"], ["case", a.replace(/ /g, "  ")], ["case", a.replace(/ё/g, "е")], ["case", a.replace(/-/g, " ")]);
  if (lang === "en") {
    const bare = a.replace(/^(the|a|an) /i, "");
    out.push(["art", "the " + bare], ["art", "a " + bare], ["art", bare]);
    for (const [b, am] of BRIT) {
      const re = new RegExp("\\b" + b + "\\b", "i"), re2 = new RegExp("\\b" + am + "\\b", "i");
      if (re.test(a)) out.push(["spell", a.replace(re, am)]);
      if (re2.test(a)) out.push(["spell", a.replace(re2, b)]);
    }
  }
  if (lang === "en") {
    // число: «dog» ↔ «dogs», «berry» ↔ «berries» (последнее слово)
    const w = a.split(" ");
    const last = w[w.length - 1];
    const forms = [];
    if (/[^s]s$/i.test(last)) forms.push(last.replace(/s$/i, ""));
    else if (/[^aeiou]y$/i.test(last)) forms.push(last.replace(/y$/i, "ies"));
    else if (/(s|x|ch|sh)$/i.test(last)) forms.push(last + "es");
    else forms.push(last + "s");
    for (const x of forms) out.push(["plural", [...w.slice(0, -1), x].join(" ")]);
  }
  if (lang === "ru") {
    // беглая гласная в последнем слове: явные суффиксы (-ец, -ок, -ёл, -ёс), формы «а, у, ом, е»
    const w = a.split(" ");
    const last = w[w.length - 1];
    const rules = [[/ец$/i, "ц"], [/([бвгджзклмнпрстфхцчшщ])ок$/i, "$1к"], [/ёл$/i, "л"], [/ёс$/i, "с"]];
    const NOT_FLEET = ["мотбок"]; // заимствования без беглой гласной
    for (const [re, rep] of rules) {
      if (re.test(last) && Array.from(last).length >= 4 && !NOT_FLEET.includes(last.toLowerCase())) {
        const stem = last.replace(re, rep);
        for (const e of ["а", "у", "ом", "е"]) out.push(["fleet", [...w.slice(0, -1), stem + e].join(" ")]);
        break;
      }
    }
  }
  const words = a.split(" ").filter(Boolean);
  if (words.length >= 2) out.push(["head", words[words.length - 1]]);
  return out;
}

function lieSyn(f, lang) {
  const groups = SYN[lang] || [];
  const forms = [["правда", f.answer], ...(f.alts || []).map((x) => ["alt", x]), ...f.lies.map((x) => ["ложь", x])];
  const hits = [];
  for (const g of groups) {
    const found = forms.filter(([, t]) => g.some((s) => lit(t) === lit(s)));
    const distinct = new Set(found.map(([, t]) => lit(t)));
    if (distinct.size >= 2 && found.some(([k]) => k === "ложь")) hits.push(found.map(([k, t]) => `${k}:${t}`).join(" ~ "));
  }
  return hits;
}

function run() {
  const res = { langs: {} };
  for (const lang of LANGS) {
    const byClass = {};
    const facts = new Set();
    let probes = 0;
    for (const f of C[lang]) {
      for (const [cls, v] of variants(f, lang)) {
        if (cls === "head") continue; // справочно ниже
        if (lit(v) === lit(f.answer) && cls !== "case") continue;
        probes++;
        if (!isTruth(v, f)) {
          (byClass[cls] = byClass[cls] || []).push({ id: f.id, answer: f.answer, variant: v });
          facts.add(f.id);
        }
      }
    }
    const head = C[lang].filter((f) => f.answer.split(" ").filter(Boolean).length >= 2 && !(f.alts || []).some((x) => x.split(" ").length === 1));
    const syn = [];
    for (const f of C[lang]) for (const h of lieSyn(f, lang)) syn.push({ id: f.id, hit: h });
    res.langs[lang] = { facts: C[lang].length, probes, failFacts: facts.size, byClass, headNoSingleAlt: head.map((f) => f.id), lieSyn: syn };
  }
  return res;
}

if (require.main === module) {
  const r = run();
  if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 1));
  else {
    for (const [lang, d] of Object.entries(r.langs)) {
      console.log(`\n== ${lang}: фактов ${d.facts}, проб ${d.probes}, фактов с расхождением ${d.failFacts}, 2+ слов без однословного alt ${d.headNoSingleAlt.length}, синонимы в лжи ${d.lieSyn.length}`);
      for (const [cls, list] of Object.entries(d.byClass)) {
        console.log(`  [${cls}] ${list.length}`);
        for (const x of list) console.log(`    ${x.id}: «${x.answer}» ← «${x.variant}»`);
      }
      for (const s of d.lieSyn) console.log(`  [lieSyn] ${s.id}: ${s.hit}`);
    }
  }
}
module.exports = { run, variants, lieSyn };
