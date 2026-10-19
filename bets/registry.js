"use strict";

/*
 * Реестр событий: расписание партии (bets-spec.md §2.3), сборка и пересборка события по типу и входным данным.
 * Сценические события (S1–S5) собираются из rnd; реальные (R1–R12) получают входные данные от bets/feed.js.
 */
const dice = require("./events/dice");
const dogs = require("./events/dogs");
const pen = require("./events/penalties");
const rope = require("./events/rope");
const rocket = require("./events/rocket");
const live = require("./events/live");

const SCENIC = ["dice", "dogs", "penalties", "rocket", "rope"];
const REAL = ["btc", "btceth", "news", "emoji", "wikiduel", "wikiedit", "whales", "lightning", "airport", "lang", "wikinext"];

// какой математикой считается реальное событие
const LIVE_KIND = {
  btc: "btc", btceth: "btceth", news: "categorical", emoji: "duel", wikiduel: "duel", lightning: "duel", airport: "duel",
  wikiedit: "thresholds", whales: "thresholds", lang: "categorical", wikinext: "categorical", drand: "drand",
};

// длительность сцены сценических событий, мс (по исходу)
const SCENE_MS = {
  dice: () => 7500,
  dogs: () => 30000,
  penalties: (o) => 3000 + (o.kicks.length + 2 * o.sd.length) * 3300,
  rope: () => 34000,
  rocket: (m) => Math.min(40000, 3000 + Math.round(Math.log(m) / 0.2 * 1000)),
};
// окно ожидания реального исхода и сцена после него, мс
const LIVE_WAIT_MS = { btc: 20000, btceth: 20000, news: 45000, emoji: 20000, wikiduel: 20000, wikiedit: 20000, whales: 20000, lightning: 100000, airport: 90000, lang: 10000, wikinext: 10000, drand: 12000 };

// Имена героев сцен (сервер выбирает один раз, доска и телефоны видят одни и те же)
const DOG_NAMES = ["Борщ", "Шпала", "Капуста", "Турбо", "Баклажан", "Карма", "Лютик", "Чебурек", "Молния", "Кекс", "Пельмень", "Бумер", "Тапок", "Хрущ", "Гром", "Огурчик", "Бублик", "Шашлык", "Ракета", "Зефир", "Дизель", "Мандарин", "Бусинка", "Пончик"];
const TEAMS = [["Лаймы", "Маджента"], ["Огурцы", "Помидоры"], ["Тапки", "Валенки"], ["Совы", "Жаворонки"]];
const MEN_A = ["Шашков", "Коробов", "Лютиков", "Бубнов", "Клюшкин", "Пирогов", "Сковородкин"];
const MEN_B = ["Гвоздев", "Пончиков", "Кубиков", "Тапкин", "Рельсов", "Самоваров", "Бидонов"];
const HEROES = [["Бугай", "Жила"], ["Танк", "Шнурок"], ["Батя", "Малой"], ["Кувалда", "Спичка"]];
function takeN(pool, n, rnd) { const p = pool.slice(), out = []; while (out.length < n) out.push(p.splice(rnd(p.length), 1)[0]); return out; }

// Метаданные события для клиентов: подписи героев. Живые события получают подписи от feed.js.
function describe(type, rnd) {
  switch (type) {
    case "dogs": return { names: takeN(DOG_NAMES, 3, rnd) };
    case "penalties": { const t = TEAMS[rnd(TEAMS.length)]; return { A: { name: t[0], men: takeN(MEN_A, 5, rnd) }, B: { name: t[1], men: takeN(MEN_B, 5, rnd) } }; }
    case "rope": { const h = HEROES[rnd(HEROES.length)]; return { A: h[0], B: h[1] }; }
    default: return {};
  }
}

function makeScenic(type, rnd) {
  switch (type) {
    case "dice": return dice.build();
    case "dogs": return dogs.build(rnd);
    case "penalties": return pen.build(rnd);
    case "rope": return rope.build(rnd);
    case "rocket": return rocket.build();
  }
  throw new Error("unknown scenic " + type);
}

// Пересборка после рестарта: тот же набор рынков с теми же коэффициентами
function rebuild(type, input) {
  switch (type) {
    case "dice": return dice.build();
    case "dogs": return dogs.build(null, input.weights);
    case "penalties": return pen.build(null, input);
    case "rope": return rope.build(null, input.s);
    case "rocket": return rocket.build();
  }
  const kind = LIVE_KIND[type];
  if (!kind) throw new Error("unknown event " + type);
  let ev;
  switch (kind) {
    case "btc": ev = live.btc(input.sigma); break;
    case "btceth": ev = live.btcEth(input.sigB, input.sigE, input.rho); break;
    case "duel": ev = live.duel(input); break;
    case "thresholds": ev = live.thresholds(input.kinds, input.opts); break;
    case "categorical": ev = live.categorical(input.counts, input.minShare, type === "news" ? "news" : "categ"); break;
    case "drand": ev = live.drand(); break;
  }
  ev.input = input;
  ev.slot = type;
  return ev;
}

// Расписание: пары «реальное / сценическое», порядок внутри пары случайный (§2.3).
// mode: "mixed" | "real" | "scenic". Подряд одинаковых нет, в первой половине типы не повторяются, всего не больше двух.
function makeSchedule(n, rnd, mode = "mixed", realPool = REAL) {
  if (!realPool.length) mode = "scenic"; // нет включённых живых источников — только сценические
  const pick = (pool, used, last) => {
    const firstHalf = used.total < Math.ceil(n / 2);
    let cands = pool.filter((t) => t !== last && (used.count[t] || 0) < (firstHalf ? 1 : 2));
    if (!cands.length) cands = pool.filter((t) => t !== last);
    if (!cands.length) cands = pool;
    return cands[rnd(cands.length)];
  };
  const used = { count: {}, total: 0 };
  const out = [];
  let last = null;
  const push = (t) => { out.push(t); used.count[t] = (used.count[t] || 0) + 1; used.total++; last = t; };
  for (let i = 0; i < n; i += 2) {
    if (mode === "real") { push(pick(realPool, used, last)); if (i + 1 < n) push(pick(realPool, used, last)); continue; }
    if (mode === "scenic") { push(pick(SCENIC, used, last)); if (i + 1 < n) push(pick(SCENIC, used, last)); continue; }
    const realFirst = rnd(2) === 0;
    const a = realFirst ? realPool : SCENIC, b = realFirst ? SCENIC : realPool;
    push(pick(a, used, last));
    if (i + 1 < n) push(pick(b, used, last));
  }
  return out;
}

module.exports = { describe, SCENIC, REAL, LIVE_KIND, SCENE_MS, LIVE_WAIT_MS, makeScenic, rebuild, makeSchedule };
