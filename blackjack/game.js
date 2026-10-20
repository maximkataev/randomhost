"use strict";

/*
 * Движок блэкджека (docs/blackjack-spec.md): чистая логика без сети и таймеров.
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно (Game.from).
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку (s.deadline) и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1 (сервер — crypto.randomInt, соло — crypto.getRandomValues, тесты — своя).
 * Методы возвращают список событий для эффектов на клиентах ({type, ...}); те же события копятся в s.events (последние 30).
 *
 * Один и тот же файл работает на сервере (module.exports) и в браузере соло-режима (window.BlackjackGame):
 * никаких require, синтаксис не выше ES2017 (доски на проекторах — Chromium 80–83): без `?.`, `??`, spread/rest,
 * optional catch binding, `.at()`, `replaceAll`, `Object.hasOwn`, `structuredClone`. Проверяет test-game.js.
 *
 * Цикл раздачи (§4): betting → closing (штрафы, карты-пакости) → dealing → [insurance] → deciding (волны) → dealer → payout.
 * Все играют против дилера одновременно: решения принимаются волнами, карты добора сдаются при закрытии волны в порядке мест.
 * Рука дилера считается целиком в начале фазы dealer вместе с расписанием показа revealAt[] — стеки меняются только в settle().
 */
(function () {

// ---------- карты ----------

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["s", "h", "d", "c"];
const DECKS = 6;
const SHOE_SIZE = 52 * DECKS;
const CUT = 0.75; // отсечка: когда сдано 75% шуза, следующая раздача начинается с перетасовки

function cardValue(r) {
  if (r === "A") return 11;
  if (r === "K" || r === "Q" || r === "J" || r === "10") return 10;
  return Number(r);
}

// {value, soft}: туз считается 11, пока сумма не больше 21; мягкая — хотя бы один туз всё ещё считается как 11
function handValue(cards) {
  let v = 0;
  let aces = 0;
  for (const c of cards) {
    v += cardValue(c.r);
    if (c.r === "A") aces++;
  }
  while (v > 21 && aces > 0) { v -= 10; aces--; }
  return { value: v, soft: aces > 0 && v <= 21 };
}

// блэкджек — только туз + десятка первыми двумя картами руки, не после сплита (§3)
const isBlackjack = (cards, fromSplit) => !fromSplit && cards.length === 2 && handValue(cards).value === 21;
const isPair = (cards) => cards.length === 2 && cardValue(cards[0].r) === cardValue(cards[1].r); // две разные десятки — тоже пара
const suitColor = (s) => (s === "h" || s === "d" ? "red" : "black");

// Perfect Pairs (§3): две первые карты игрока. {kind, mult} или null
const PP = { mixed: 5, colored: 10, perfect: 25 };
function perfectPairs(a, b) {
  if (a.r !== b.r) return null;
  if (a.s === b.s) return { kind: "perfect", mult: PP.perfect };
  if (suitColor(a.s) === suitColor(b.s)) return { kind: "colored", mult: PP.colored };
  return { kind: "mixed", mult: PP.mixed };
}

// 21+3 (§3): две карты игрока + открытая карта дилера. Туз в стрите — и младший (A-2-3), и старший (Q-K-A)
const TP = { flush: 5, straight: 10, trips: 30, straightFlush: 40, suitedTrips: 100 };
function rankIndex(r) { return RANKS.indexOf(r); } // A=0, 2=1 … K=12
function isStraight3(cards) {
  const idx = cards.map((c) => rankIndex(c.r)).sort((x, y) => x - y);
  if (idx[0] === idx[1] || idx[1] === idx[2]) return false;
  if (idx[1] === idx[0] + 1 && idx[2] === idx[1] + 1) return true;
  return idx[0] === 0 && idx[1] === 11 && idx[2] === 12; // Q-K-A
}
function twentyOnePlusThree(a, b, up) {
  const cards = [a, b, up];
  const flush = cards[0].s === cards[1].s && cards[1].s === cards[2].s;
  const trips = cards[0].r === cards[1].r && cards[1].r === cards[2].r;
  const straight = isStraight3(cards);
  if (trips && flush) return { kind: "suitedTrips", mult: TP.suitedTrips };
  if (straight && flush) return { kind: "straightFlush", mult: TP.straightFlush };
  if (trips) return { kind: "trips", mult: TP.trips };
  if (straight) return { kind: "straight", mult: TP.straight };
  if (flush) return { kind: "flush", mult: TP.flush };
  return null;
}

// шуз хранится строками «As», «10h» — дамп компактнее; на столе карты — объекты {r, s}
const packCard = (c) => c.r + c.s;
function parseCard(str) { return { r: str.slice(0, -1), s: str.slice(-1) }; }

// ---------- партия ----------

// Минимальная основная ставка в процентах от стартового стека, по уровням (§5)
const LEVELS = [1, 2, 3, 5, 8, 12, 18, 25, 35, 50];
// Овертайм (как в рулетке): после последнего уровня минимум — доля среднего стека живых игроков
const OVERTIME = [25, 50, 100];
const TOP_LEVEL = LEVELS.length + OVERTIME.length - 1;
/*
 * Через сколько раздач поднимается уровень. Спека предлагала 2/3/4; стенд (sim.js) на 6 игроках «до последнего»
 * дал при 3 медиану 22 мин и p90 27.5 (цель 15–20 и <28), при 2 — 16.7 и 20.4. Раздача длится 45–50 с, как и задумано,
 * поэтому единственный рычаг — скорость подъёма минимума.
 */
const PACE = { fast: 1, normal: 2, slow: 3 };
const FORMATS = ["last", "hands", "tournament"];
const HANDS_TOTAL = [15, 20, 30];

const DEFAULTS = {
  format: "last", // last — до последнего | hands — N раздач | tournament — турнир с отсечением
  handsTotal: 20, // только для hands: 15 | 20 | 30
  stack: 1000, // 500 | 1000 | 2000
  pace: "normal", // fast | normal | slow
  betTime: 20000, // 15 | 20 | 30 с
  cards: true, // карты-пакости
  chat: true,
  calm: false, // «без спецэффектов» — движок не трогает, доска читает из настроек
  lang: "ru",
  solo: false, // соло-режим (§9): один игрок, без таймеров ставок и решений, без карт-пакостей
};

const SPECIAL_CHANCE = 45; // % — доля подходящих раздач, в которых режиссёр берёт квотный сюжет (longflip/cards/bust)

const T = {
  closeBase: 2000, // «ставок больше нет» без карт
  closePerCard: 1000, // + на открытие каждой карты-пакости
  dealCard: 300, // на каждую карту раздачи
  insurance: 6000, // «Страховка?» при тузе дилера
  peek: 1000, // молчаливое подглядывание при десятке
  wave1: 12000, // первая волна решений
  wave: 8000, // волны 2+
  hitCard: 350, // карта добора при закрытии волны
  payout: 4000,
  payoutJackpot: 6000,
  reshuffle: 3000, // анимация «Новый шуз» — добавляется к фазе ставок
  // ход дилера (§7.5) — слагаемые расписания revealAt
  flip: 1000, // переворот закрытой карты
  flipLong: 2400, // «долгий флип»: свет гаснет, ладонь на карте, медленный переворот
  flipBj: 1500, // подглядел — блэкджек — переворот сразу
  draw: 1000, // карта добора
  drawStep: 400, // «карта за картой»: каждая следующая медленнее
  end: 1200, // пауза после последней карты на реакцию боксов
  endBust: 2500, // «ДИЛЕР ПЕРЕБРАЛ» во весь экран
  endRescue: 1500,
  allinLead: 1800, // имя над столом перед ходом дилера
  dealerMax: 10000,
};

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 2;
const NAME_MAX = 15;
const TRICK_HAND = 3;
const CHAT_LEN = 80;
const CHAT_GAP = 3000;
const CHAT_KEEP = 50;
const REACT_GAP = 1000;
const EVENTS_KEEP = 30;
const REACTIONS = ["🔥", "😱", "😂", "👏", "🙏", "💀"];

// те же цвета и аватарки, что у oneword
const COLORS = ["#e0115f", "#1438e0", "#0a8a4a", "#e25a00", "#7b1fd6", "#008b9a", "#b8006e", "#6b4a00", "#2c2cad", "#b31010", "#3d6b00", "#c77700"];
const AVATARS = ["🐙", "🦊", "🐸", "🦉", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐳", "🦩"];

// Карты-пакости (§6): себе — peek, redeal, shield; на соседа — остальные. Щит пассивный, его не играют.
const TRICKS = ["peek", "redeal", "shield", "freeze", "extra", "swap", "tax", "doublemin"];
const SELF_TRICKS = ["peek", "redeal", "shield"];
const TRICK_COPIES = 3;

function clampSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const s = Object.assign({}, DEFAULTS);
  if (FORMATS.indexOf(input.format) >= 0) s.format = input.format;
  if (HANDS_TOTAL.indexOf(Number(input.handsTotal)) >= 0) s.handsTotal = Number(input.handsTotal);
  if ([500, 1000, 2000].indexOf(Number(input.stack)) >= 0) s.stack = Number(input.stack);
  if (PACE[input.pace]) s.pace = input.pace;
  if ([15000, 20000, 30000].indexOf(Number(input.betTime)) >= 0) s.betTime = Number(input.betTime);
  for (const k of ["cards", "chat", "calm", "solo"]) if (typeof input[k] === "boolean") s[k] = input[k];
  if (["ru", "en", "el"].indexOf(input.lang) >= 0) s.lang = input.lang;
  if (s.solo) s.cards = false; // в соло пакостить некому (§9)
  return s;
}

// имя и текст: без управляющих и невидимых символов, без лишних пробелов; режем по символам, не по единицам UTF-16
const CTRL = /[\u0000-\u001f\u007f-\u009f­͏᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
function cleanText(text, max) {
  const t = String(text == null ? "" : text).replace(CTRL, "");
  return Array.from(t.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}
const cleanName = (name) => cleanText(name, NAME_MAX);
// ключ имени для «это ты?» при возврате: без регистра, диакритики и похожих букв (как в oneword)
const SKEL = { "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ё": "e",
  "α": "a", "β": "b", "ε": "e", "η": "h", "ι": "i", "κ": "k", "μ": "m", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "y", "χ": "x", "ς": "c", "ω": "w", "γ": "y" };
const SKEL_RE = new RegExp("[" + Object.keys(SKEL).join("") + "]", "g");
const nameKey = (n) => String(n || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(SKEL_RE, (ch) => SKEL[ch]).replace(/[il1|]/g, "l").replace(/0/g, "o").replace(/\s+/g, "");

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

const defaultRnd = (n) => Math.floor(Math.random() * n);
const sumBy = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

function newHand(cards, bet, fromSplit) {
  return { cards: cards, bet: bet, done: false, doubled: false, fromSplit: !!fromSplit, decision: null, auto: false, result: null, payout: 0, evenMoney: false };
}

class Game {
  constructor(state, rnd) {
    this.s = state;
    this.rnd = rnd || defaultRnd;
  }

  static create(opts) {
    opts = opts || {};
    return new Game({
      code: opts.code || "",
      settings: clampSettings(opts.settings),
      phase: "lobby", // lobby | betting | closing | dealing | insurance | deciding | dealer | payout | finished
      players: [],
      game: 0,
      hand: 0, // номер раздачи с 1
      level: 0,
      deadline: null,
      paused: null, // {remaining} — пауза ведущего; держится только в фазе ставок
      pauseNext: false, // пауза заказана посреди раздачи — встанет на следующих ставках
      shoe: [], // карты шуза строками, сдаём с конца
      shoeDealt: 0,
      reshuffled: false, // эта раздача началась с перетасовки
      deck: [], // колода карт-пакостей
      played: [], // карты этого спина: {by, card, target}
      reveals: [], // открытые в closing: {by, card, target, outcome}
      swaps: [], // дошедшие «Обмены»: {by, target}
      dealer: null, // {cards, bj, peek, insurance, plot, revealAt, allin, jackpot, rescue, lead}
      wave: 0,
      waveStart: null,
      result: null, // итоги раздачи, считаются в dealerPlay, применяются в settle
      casino: { won: 0, paid: 0 },
      stats: { biggestWin: null, biggestBust: null, blackjacks: {}, cruelCard: null, lastBreath: {}, exact21: 0, dealerBusts: 0, sideJackpot: null },
      specialsAt: [], // раздачи с особым сюжетом (§7.5) — не чаще одного на три
      events: [],
      chat: [],
      chatSeq: 0,
      winnerId: null,
      winnerIds: [],
      draw: false,
      finishedReason: null,
      finishAfterPayout: false,
      avgStack: 0,
      startN: 0, // игроков на старте — для K турнира
      cutK: null,
    }, opts.rnd);
  }

  static from(state, rnd) {
    return new Game(state, rnd);
  }

  // ---------- служебное ----------

  log(ev, now) {
    const s = this.s;
    ev.t = now == null ? null : now;
    ev.hand = s.hand;
    s.events.push(ev);
    if (s.events.length > EVENTS_KEEP) s.events = s.events.slice(-EVENTS_KEEP);
    return ev;
  }

  player(id) {
    return this.s.players.find((p) => p.id === id);
  }

  alive() {
    return this.s.players.filter((p) => !p.out && !p.left);
  }

  // кто играет эту раздачу (поставил и не пропускает): флаг держится до конца раздачи, даже если игрок ушёл
  inHand() {
    return this.s.players.filter((p) => p.inHand).sort((a, b) => a.seat - b.seat);
  }

  minPlayers() {
    return this.s.settings.solo ? 1 : MIN_PLAYERS;
  }

  // ---------- участники ----------

  addPlayer(opts) {
    const s = this.s;
    const id = opts.id;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    const spectator = s.phase !== "lobby";
    const seated = s.players.filter((p) => !p.left && !p.spectator);
    const max = s.settings.solo ? 1 : MAX_PLAYERS;
    if (!spectator && seated.length >= max) return { ok: false, reason: "room_full" };
    const name = cleanName(opts.name);
    if (!name) return { ok: false, reason: "bad_name" };
    if (s.players.length >= MAX_PLAYERS * 3) return { ok: false, reason: "room_full" };
    const used = new Set(s.players.filter((p) => !p.left).map((p) => p.color));
    const usedAv = new Set(s.players.filter((p) => !p.left).map((p) => p.avatar));
    const seatsTaken = new Set(s.players.filter((p) => !p.left && !p.spectator).map((p) => p.seat));
    let seat = 0;
    while (seatsTaken.has(seat)) seat++;
    const p = {
      id: id,
      name: name,
      color: COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length],
      avatar: AVATARS.find((a) => !usedAv.has(a)) || AVATARS[s.players.length % AVATARS.length],
      seat: spectator ? null : seat,
      stack: spectator ? 0 : s.settings.stack,
      online: true,
      left: false,
      out: spectator,
      outHand: null,
      spectator: spectator,
      place: null,
      muted: false,
      lastChat: null,
      lastReact: null,
      hintOn: true,
      trick: [], // карты-пакости на руках
      lastBet: null, // {main, pp, tp} прошлой раздачи — для «Повторить»
    };
    this.resetHandState(p);
    s.players.push(p);
    return { ok: true, player: p };
  }

  // всё, что живёт одну раздачу
  resetHandState(p) {
    p.bet = 0;
    p.side = { pp: 0, tp: 0 };
    p.chips = []; // история фишек для «Отменить»: {box, amount}
    p.ready = false;
    p.allIn = false;
    p.inHand = false;
    p.skip = false; // не поставил — платит минимум и пропускает
    p.penalty = 0;
    p.net = 0; // итог раздачи по всем источникам: штраф, побочные, основная, страховка, налог
    p.hands = [];
    p.insurance = 0;
    p.evenMoney = false;
    p.insDecided = false;
    p.sideResults = { pp: null, tp: null };
    p.stackAtDeal = p.stack;
    p.frozen = false;
    p.extraCard = false;
    p.extraDone = false;
    p.taxTo = null;
    p.peek = false;
    p.redealAvail = false;
    p.redealt = false;
    p.doubleMin = !!p.doubleMinNext;
    p.doubleMinNext = false;
  }

  removePlayer(id, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p) return [];
    if (s.phase === "lobby" || s.phase === "finished") {
      s.players = s.players.filter((x) => x !== p);
      return [this.log({ type: "left", playerId: id }, now)];
    }
    if (p.left) return [];
    // посреди партии: игрок выбывает; его ставки этой раздачи доигрываются сами (решения — «хватит»), фишки сгорают
    p.left = true;
    p.online = false;
    if (!p.out) { p.out = true; p.outHand = s.hand; }
    if (s.phase === "betting") { p.bet = 0; p.side = { pp: 0, tp: 0 }; p.chips = []; }
    p.ready = false;
    for (const h of p.hands) if (!h.done && !h.decision) { h.decision = "stand"; h.auto = true; }
    const ev = [this.log({ type: "left", playerId: id }, now)];
    if (s.phase !== "finished" && this.alive().length <= 1 && !s.settings.solo) ev.push.apply(ev, this.finish("last", now));
    else ev.push.apply(ev, this.maybeAdvance(now));
    return ev;
  }

  setOnline(id, online, now) {
    const p = this.player(id);
    if (p) {
      if (!online) { if (p.online !== false || !Number.isFinite(p.offSince)) p.offSince = Date.now(); }
      else delete p.offSince;
      p.online = online;
    }
    return !online && now != null ? this.maybeAdvance(now) : [];
  }

  setHint(id, on) {
    const p = this.player(id);
    if (!p) return { ok: false, reason: "no_player" };
    p.hintOn = !!on;
    return { ok: true };
  }

  setSettings(patch) {
    const s = this.s;
    if (s.phase !== "lobby") return { ok: false, reason: "started" };
    s.settings = clampSettings(Object.assign({}, s.settings, patch || {}));
    return { ok: true, events: [this.log({ type: "settings" })] };
  }

  // ---------- уровни и минимум ----------

  minBet(level) {
    const s = this.s;
    if (level == null) level = s.level;
    return Math.max(1, Math.round((s.settings.stack * LEVELS[Math.min(level, LEVELS.length - 1)]) / 100));
  }

  overtime(level) {
    if (level == null) level = this.s.level;
    return level >= LEVELS.length ? OVERTIME[level - LEVELS.length] : 0;
  }

  // минимум уровня: в овертайме — доля среднего стека живых (фиксируется в начале раздачи)
  levelNeed(level) {
    if (level == null) level = this.s.level;
    const ot = this.overtime(level);
    return Math.max(this.minBet(level), Math.ceil(((this.s.avgStack || 0) * ot) / 100));
  }

  // сколько обязан поставить этот игрок: минимум (×2 под «Двойным минимумом»), но не больше своего стека — иначе ва-банк без штрафа
  need(p, level) {
    const base = this.levelNeed(level) * (p.doubleMin ? 2 : 1);
    return Math.min(p.stack, base);
  }

  // раздач на уровень: в турнире на одну больше — там выбывание делает отсечение, а не минимум (стенд: иначе 16 раздач вместо ≈20)
  paceHands() {
    return PACE[this.s.settings.pace] + (this.s.settings.format === "tournament" ? 1 : 0);
  }

  levelFor(hand) {
    const s = this.s;
    // «N раздач»: овертайм не нужен, партия кончается раньше (§5)
    const top = s.settings.format === "hands" ? LEVELS.length - 1 : TOP_LEVEL;
    return Math.min(top, Math.floor((hand - 1) / this.paceHands()));
  }

  // турнир: каждые K раздач выбывает самый бедный; K = max(2, round(20 / (N − 1)))
  static cutK(n) {
    return Math.max(2, Math.round(20 / Math.max(1, n - 1)));
  }

  cutIn() {
    const s = this.s;
    if (s.settings.format !== "tournament" || !s.cutK || !s.hand) return null;
    return s.cutK - ((s.hand - 1) % s.cutK) - 1;
  }

  // ---------- шуз ----------

  newShoe(now) {
    const s = this.s;
    const onTable = new Set();
    for (const p of s.players) for (const h of p.hands || []) for (const c of h.cards) onTable.add(c);
    const cards = [];
    for (let d = 0; d < DECKS; d++) for (const r of RANKS) for (const su of SUITS) cards.push(r + su);
    s.shoe = shuffle(cards, this.rnd);
    s.shoeDealt = 0;
    s.reshuffled = true;
    return this.log({ type: "reshuffle" }, now);
  }

  needReshuffle() {
    return this.s.shoeDealt >= Math.floor(SHOE_SIZE * CUT) || !this.s.shoe.length;
  }

  draw(now) {
    const s = this.s;
    // шуз кончился посреди раздачи (12 человек со сплитами перед отсечкой) — тасуем, не дожидаясь следующей
    if (!s.shoe.length) this.newShoe(now);
    s.shoeDealt++;
    return parseCard(s.shoe.pop());
  }

  // ---------- карты-пакости ----------

  dealTrick(p) {
    const s = this.s;
    if (p.trick.length >= TRICK_HAND) return;
    if (!s.deck.length) {
      const inHands = {};
      for (const x of s.players) for (const c of x.trick) inHands[c] = (inHands[c] || 0) + 1;
      const fresh = [];
      for (const c of TRICKS) for (let i = inHands[c] || 0; i < TRICK_COPIES; i++) fresh.push(c);
      s.deck = shuffle(fresh, this.rnd);
      if (!s.deck.length) return;
    }
    p.trick.push(s.deck.pop());
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby") return { ok: false, reason: "started" };
    const ps = this.alive().filter((p) => !p.spectator);
    if (ps.length < this.minPlayers()) return { ok: false, reason: "few_players" };
    s.game++;
    s.hand = 0;
    s.level = 0;
    s.deck = [];
    s.shoe = [];
    s.shoeDealt = 0;
    s.specialsAt = [];
    s.casino = { won: 0, paid: 0 };
    s.stats = { biggestWin: null, biggestBust: null, blackjacks: {}, cruelCard: null, lastBreath: {}, exact21: 0, dealerBusts: 0, sideJackpot: null };
    s.winnerId = null;
    s.winnerIds = [];
    s.draw = false;
    s.finishedReason = null;
    s.finishAfterPayout = false;
    s.startN = ps.length;
    s.cutK = s.settings.format === "tournament" ? Game.cutK(ps.length) : null;
    for (const p of ps) {
      p.stack = s.settings.stack;
      p.trick = [];
      p.doubleMinNext = false;
      p.place = null;
      p.outHand = null;
      p.lastBet = null;
      if (s.settings.cards) { this.dealTrick(p); this.dealTrick(p); }
    }
    const ev = [this.log({ type: "started", game: s.game, format: s.settings.format }, now)];
    return { ok: true, events: ev.concat(this.beginHand(now)) };
  }

  beginHand(now) {
    const s = this.s;
    s.hand++;
    const ev = [];
    const level = this.levelFor(s.hand);
    s.reshuffled = false;
    if (this.needReshuffle()) ev.push(this.newShoe(now));
    if (level !== s.level) {
      s.level = level;
      if (s.settings.cards) for (const p of this.alive()) this.dealTrick(p);
    }
    const alive = this.alive();
    s.avgStack = alive.length ? Math.round(sumBy(alive, (p) => p.stack) / alive.length) : 0;
    // уровень сообщаем только в момент подъёма: на первой раздаче он стартовый, событие было бы шумом на доске
    if (s.hand > 1 && this.levelFor(s.hand - 1) !== level) ev.push(this.log({ type: "level", level: level, minBet: this.levelNeed(), overtime: this.overtime() }, now));
    s.phase = "betting";
    s.played = [];
    s.reveals = [];
    s.swaps = [];
    s.dealer = null;
    s.dealing = null;
    s.result = null;
    s.wave = 0;
    s.waveStart = null;
    for (const p of s.players) this.resetHandState(p);
    const betMs = s.settings.betTime + (s.reshuffled ? T.reshuffle : 0);
    if (s.pauseNext) {
      s.pauseNext = false;
      s.paused = { remaining: betMs };
      s.deadline = null;
    } else {
      s.deadline = s.settings.solo ? null : now + betMs;
    }
    const cutIn = this.cutIn();
    ev.push(this.log({ type: "betting", hand: s.hand, cutIn: cutIn, reshuffled: s.reshuffled }, now));
    if (cutIn === 0) ev.push(this.log({ type: "cut_warning" }, now));
    return ev;
  }

  // ---------- ставки ----------

  canBet(p) {
    return this.s.phase === "betting" && !!p && !p.out && !p.left && !this.s.paused;
  }

  committed(p) {
    return p.bet + p.side.pp + p.side.tp;
  }

  // свободные фишки: до раздачи — стек минус всё на боксах; после — побочные уже решены, основная живёт в руках
  freeOf(p) {
    if (p.hands.length) return p.stack - sumBy(p.hands, (h) => h.bet) - p.insurance;
    return p.stack - this.committed(p);
  }

  // основная ставка: фишка добавляется к боксу (лимита стола нет — хоть весь стек)
  bet(id, amount) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: "closed" };
    amount = Math.floor(Number(amount));
    if (!(amount >= 1)) return { ok: false, reason: "bad_amount" };
    if (this.committed(p) + amount > p.stack) return { ok: false, reason: "no_money" };
    p.bet += amount;
    p.chips.push({ box: "main", amount: amount });
    p.ready = false;
    p.allIn = false;
    return { ok: true };
  }

  // побочная ставка (pp | tp): не больше основной и в сумме не больше стека
  sideBet(id, box, amount) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: "closed" };
    if (box !== "pp" && box !== "tp") return { ok: false, reason: "bad_box" };
    amount = Math.floor(Number(amount));
    if (!(amount >= 1)) return { ok: false, reason: "bad_amount" };
    if (p.side[box] + amount > p.bet) return { ok: false, reason: "over_main" };
    if (this.committed(p) + amount > p.stack) return { ok: false, reason: "no_money" };
    p.side[box] += amount;
    p.chips.push({ box: box, amount: amount });
    p.ready = false;
    p.allIn = false;
    return { ok: true };
  }

  // «Отменить»: снять последнюю фишку; побочные, ставшие больше основной, урезаются
  unbet(id) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: "closed" };
    const last = p.chips.pop();
    if (!last) return { ok: false, reason: "empty" };
    if (last.box === "main") p.bet -= last.amount; else p.side[last.box] -= last.amount;
    this.trimSides(p);
    p.ready = false;
    p.allIn = false;
    return { ok: true };
  }

  trimSides(p) {
    for (const box of ["pp", "tp"]) if (p.side[box] > p.bet) p.side[box] = p.bet;
  }

  clearBets(id) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: "closed" };
    p.bet = 0;
    p.side = { pp: 0, tp: 0 };
    p.chips = [];
    p.ready = false;
    p.allIn = false;
    return { ok: true };
  }

  // «Повторить прошлую»: тот же набор, урезанный до стека
  repeatBet(id) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: "closed" };
    if (!p.lastBet || !p.lastBet.main) return { ok: false, reason: "no_last" };
    const main = Math.min(p.lastBet.main, p.stack);
    const pp = Math.min(p.lastBet.pp, main, p.stack - main);
    const tp = Math.min(p.lastBet.tp, main, p.stack - main - pp);
    return this.setBets(id, { main: main, pp: pp, tp: tp });
  }

  // полный набор ставок разом: либо принят целиком, либо ничего
  setBets(id, bets) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: "closed" };
    if (!bets || typeof bets !== "object") return { ok: false, reason: "bad_bet" };
    const main = Math.floor(Number(bets.main || 0));
    const pp = Math.min(main, Math.floor(Number(bets.pp || 0)));
    const tp = Math.min(main, Math.floor(Number(bets.tp || 0)));
    if (!(main >= 0 && pp >= 0 && tp >= 0)) return { ok: false, reason: "bad_amount" };
    if (main + pp + tp > p.stack) return { ok: false, reason: "no_money" };
    p.bet = main;
    p.side = { pp: pp, tp: tp };
    p.chips = [];
    if (main) p.chips.push({ box: "main", amount: main });
    if (pp) p.chips.push({ box: "pp", amount: pp });
    if (tp) p.chips.push({ box: "tp", amount: tp });
    p.ready = false;
    p.allIn = false;
    return { ok: true };
  }

  // ва-банк: вся свободная часть стека на основную
  allIn(id) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: "closed" };
    const free = p.stack - p.side.pp - p.side.tp;
    if (free <= 0) return { ok: false, reason: "no_money" };
    p.bet = free;
    p.chips = p.chips.filter((c) => c.box !== "main");
    p.chips.push({ box: "main", amount: free });
    p.ready = false;
    p.allIn = true;
    return { ok: true, events: [this.log({ type: "allin", playerId: id, amount: free })] };
  }

  ready(id, ready, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p || p.out || p.left || s.phase !== "betting") return { ok: false, reason: "closed" };
    p.ready = ready !== false;
    const waiting = this.alive().filter((x) => x.online && !x.ready);
    if (!waiting.length && !s.paused) return { ok: true, events: this.closeBets(now) };
    return { ok: true, events: [] };
  }

  // карта-пакость играется в фазе ставок лицом вниз; одна карта за раздачу; «себе» — без цели
  playCard(id, card, targetId) {
    const s = this.s;
    const p = this.player(id);
    if (!s.settings.cards) return { ok: false, reason: "no_cards" };
    if (!p || p.out || p.left || s.phase !== "betting" || s.paused) return { ok: false, reason: "closed" };
    if (card === "shield") return { ok: false, reason: "passive" };
    if (p.trick.indexOf(card) < 0) return { ok: false, reason: "no_card" };
    if (s.played.some((x) => x.by === id)) return { ok: false, reason: "one_per_hand" };
    const self = SELF_TRICKS.indexOf(card) >= 0;
    let target = null;
    if (self) target = id;
    else {
      const t = this.player(targetId);
      if (!t || t.out || t.left || t.id === id) return { ok: false, reason: "bad_target" };
      target = t.id;
    }
    p.trick.splice(p.trick.indexOf(card), 1);
    s.played.push({ by: id, card: card, target: target });
    return { ok: true, events: [this.log({ type: "card_played", playerId: id })] };
  }

  // ---------- закрытие ставок ----------

  /*
   * «Ставок больше нет» (§4, §5): штрафы недобравшим минимум, карты-пакости открываются по одной и применяются.
   * Кто ничего не поставил — платит минимум и пропускает раздачу; кто меньше минимума — платит разницу и играет.
   */
  closeBets(now) {
    const s = this.s;
    if (s.phase !== "betting") return [];
    const ev = [this.log({ type: "closed", reveals: s.played.length }, now)];
    const min = this.levelNeed();
    for (const p of this.alive()) {
      this.trimSides(p);
      const need = this.need(p);
      if (p.bet <= 0) {
        p.skip = true;
        p.penalty = Math.min(p.stack, need);
      } else if (p.bet < need) {
        p.penalty = Math.min(need - p.bet, p.stack - this.committed(p));
      }
      if (p.penalty > 0) {
        p.stack -= p.penalty;
        p.net -= p.penalty;
        s.casino.won += p.penalty;
        ev.push(this.log({ type: "penalty", playerId: p.id, amount: p.penalty, skip: p.skip }, now));
        if (p.skip && p.stack <= 0) { p.out = true; p.outHand = s.hand; ev.push(this.log({ type: "out", playerId: p.id, reason: "penalty" }, now)); }
      }
      if (!p.skip) {
        p.inHand = true;
        // ва-банк как сюжет — когда это смело, а не вынужденно: стек заметно больше минимума («спасение» — стек ≤ 2 минимумов)
        p.allIn = p.bet + p.side.pp + p.side.tp >= p.stack && p.stack > 2 * min;
        p.stackAtDeal = p.stack;
        p.lastBet = { main: p.bet, pp: p.side.pp, tp: p.side.tp };
      }
      p.ready = false;
    }

    // карты открываются в порядке розыгрыша; на одну цель — не больше одной враждебной (§6)
    const hit = new Set();
    for (const pc of s.played) {
      const by = this.player(pc.by);
      const t = this.player(pc.target);
      const r = { by: pc.by, card: pc.card, target: pc.target, outcome: "ok" };
      const self = SELF_TRICKS.indexOf(pc.card) >= 0;
      if (!t || t.out || t.left || !t.inHand || (!self && by && !by.inHand)) r.outcome = "gone";
      else if (!self && hit.has(t.id)) {
        r.outcome = "busy";
        if (by && !by.out && by.trick.length < TRICK_HAND) by.trick.push(pc.card);
      } else if (!self && t.trick.indexOf("shield") >= 0) {
        t.trick.splice(t.trick.indexOf("shield"), 1);
        hit.add(t.id);
        r.outcome = "shielded";
      } else {
        if (!self) hit.add(t.id);
        if (pc.card === "peek") t.peek = true;
        else if (pc.card === "redeal") t.redealAvail = true;
        else if (pc.card === "freeze") t.frozen = true;
        else if (pc.card === "extra") t.extraCard = true;
        else if (pc.card === "swap") s.swaps.push({ by: pc.by, target: t.id });
        else if (pc.card === "tax") t.taxTo = pc.by;
        else if (pc.card === "doublemin") t.doubleMinNext = true;
      }
      s.reveals.push(r);
      ev.push(this.log({ type: "card_reveal", playerId: r.by, card: r.card, target: r.target, outcome: r.outcome }, now));
    }
    s.played = [];
    s.phase = "closing";
    s.deadline = now + T.closeBase + T.closePerCard * s.reveals.length;
    // никто не играет — раздача пустая: сразу к выплатам (все пропустили)
    if (!this.inHand().length) {
      s.result = { perPlayer: {}, empty: true };
      s.dealer = { cards: [], bj: false, peek: null, insurance: false, plot: "normal", revealAt: [], allin: [], jackpot: false, rescue: [], lead: 0, bust: false };
    }
    return ev;
  }

  // ---------- раздача ----------

  /*
   * Раздача двумя кругами как в казино: по карте каждому слева направо, дилеру открытую, второй круг, дилеру закрытую.
   * Побочные ставки решаются здесь же и выплачиваются сразу (§3). «Обмен» меняет руки после второго круга.
   */
  deal(now) {
    const s = this.s;
    if (s.phase !== "closing") return [];
    const players = this.inHand();
    const ev = [this.log({ type: "dealt", cards: players.length * 2 + 2 }, now)];
    const order = [];
    for (const p of players) { p.hands = [newHand([this.draw(now)], p.bet, false)]; order.push({ playerId: p.id, card: p.hands[0].cards[0] }); }
    const up = this.draw(now);
    order.push({ dealer: true, card: up });
    for (const p of players) { p.hands[0].cards.push(this.draw(now)); order.push({ playerId: p.id, card: p.hands[0].cards[1] }); }
    const hole = this.draw(now);
    order.push({ dealer: true, hidden: true });
    s.dealer = { cards: [up, hole], bj: isBlackjack([up, hole], false), peek: null, insurance: false, plot: null, revealAt: [], allin: [], jackpot: false, rescue: [], lead: 0, bust: false };

    // побочные — по картам до обмена: это ставка на свою раздачу
    for (const p of players) {
      const c = p.hands[0].cards;
      const res = { pp: null, tp: null };
      if (p.side.pp) res.pp = perfectPairs(c[0], c[1]);
      if (p.side.tp) res.tp = twentyOnePlusThree(c[0], c[1], up);
      for (const box of ["pp", "tp"]) {
        const stake = p.side[box];
        if (!stake) continue;
        const r = res[box];
        const win = r ? stake * (r.mult + 1) : 0;
        p.stack += win - stake;
        p.net += win - stake;
        s.casino.won += stake;
        s.casino.paid += win;
        if (r) {
          r.win = win;
          ev.push(this.log({ type: "side_win", playerId: p.id, box: box, kind: r.kind, mult: r.mult, win: win }, now));
          if (r.mult >= 25) s.dealer.jackpot = true;
          if (!s.stats.sideJackpot || win > s.stats.sideJackpot.amount) s.stats.sideJackpot = { playerId: p.id, box: box, kind: r.kind, amount: win };
        }
      }
      p.sideResults = res;
    }
    for (const sw of s.swaps) {
      const a = this.player(sw.by);
      const b = this.player(sw.target);
      if (!a || !b || !a.inHand || !b.inHand) continue;
      const t = a.hands[0].cards; a.hands[0].cards = b.hands[0].cards; b.hands[0].cards = t;
      ev.push(this.log({ type: "swap", playerId: a.id, target: b.id }, now));
    }
    for (const p of players) {
      if (isBlackjack(p.hands[0].cards, false)) {
        s.stats.blackjacks[p.id] = (s.stats.blackjacks[p.id] || 0) + 1;
        ev.push(this.log({ type: "blackjack", playerId: p.id }, now));
        if (p.bet >= 5 * this.levelNeed()) s.dealer.jackpot = true;
      }
    }
    s.phase = "dealing";
    s.dealing = order;
    s.deadline = now + T.dealCard * order.length;
    return ev;
  }

  // после раздачи: при тузе — страховка, при десятке — молчаливое подглядывание, иначе сразу решения
  afterDeal(now) {
    const s = this.s;
    const d = s.dealer;
    const up = d.cards[0].r;
    if (up === "A" || cardValue(up) === 10) {
      s.phase = "insurance";
      d.peek = up === "A" ? "ace" : "ten";
      d.insurance = up === "A";
      // в соло страховку ждём без таймера (§9); молчаливое подглядывание при десятке — секунда анимации везде
      s.deadline = d.insurance && s.settings.solo ? null : now + (d.insurance ? T.insurance : T.peek);
      for (const p of this.inHand()) p.insDecided = false;
      return [this.log({ type: "insurance", offered: d.insurance }, now)];
    }
    return this.startDeciding(now, 0);
  }

  // страховка — половина основной ставки; игроку с блэкджеком — «ровно 1:1» (even money) вместо неё
  insure(id, choice, now) {
    const s = this.s;
    const p = this.player(id);
    if (s.phase !== "insurance" || !s.dealer.insurance) return { ok: false, reason: "closed" };
    if (!p || !p.inHand || p.left) return { ok: false, reason: "not_in_hand" };
    if (p.insDecided) return { ok: false, reason: "decided" };
    const bj = isBlackjack(p.hands[0].cards, false);
    if (choice === "evenMoney") {
      if (!bj) return { ok: false, reason: "no_blackjack" };
      p.evenMoney = true;
    } else if (choice === true || choice === "yes") {
      if (bj) return { ok: false, reason: "even_money_only" };
      const amount = Math.floor(p.bet / 2);
      if (amount < 1) return { ok: false, reason: "bad_amount" };
      if (this.freeOf(p) < amount) return { ok: false, reason: "no_money" };
      p.insurance = amount;
    }
    p.insDecided = true;
    const waiting = this.inHand().filter((x) => x.online && !x.left && !x.insDecided);
    return { ok: true, events: waiting.length ? [] : this.resolveInsurance(now) };
  }

  // дилер подглядел: блэкджек — раздача заканчивается (все проигрывают основные, блэкджек игрока — пуш, страховка 2:1)
  resolveInsurance(now) {
    const s = this.s;
    if (s.phase !== "insurance") return [];
    if (s.dealer.bj) {
      for (const p of this.inHand()) { p.hands[0].done = true; p.hands[0].decision = "stand"; p.hands[0].auto = true; }
      return [this.log({ type: "dealer_blackjack", secret: true }, now)].concat(this.dealerPlay(now, 0));
    }
    return [this.log({ type: "no_blackjack" }, now)].concat(this.startDeciding(now, 0));
  }

  // ---------- решения волнами ----------

  startDeciding(now, lead) {
    const s = this.s;
    s.phase = "deciding";
    s.wave = 0;
    const ev = [];
    for (const p of this.inHand()) {
      const h = p.hands[0];
      if (isBlackjack(h.cards, false)) { h.done = true; h.decision = "stand"; h.auto = true; }
      else if (p.frozen) { h.done = true; h.decision = "stand"; h.auto = true; ev.push(this.log({ type: "frozen", playerId: p.id }, now)); }
      if (this.allDone(p)) ev.push.apply(ev, this.applyExtra(p, now));
    }
    return ev.concat(this.nextWave(now, lead));
  }

  allDone(p) {
    return p.hands.every((h) => h.done);
  }

  // руки, которые ещё ждут решения
  pending() {
    const out = [];
    for (const p of this.inHand()) p.hands.forEach((h, i) => { if (!h.done) out.push({ p: p, h: h, i: i }); });
    return out;
  }

  nextWave(now, lead) {
    const s = this.s;
    const pend = this.pending();
    if (!pend.length) return this.dealerPlay(now, lead);
    s.wave++;
    for (const x of pend) { x.h.decision = null; x.h.auto = false; }
    s.waveStart = now + lead;
    s.deadline = s.settings.solo ? null : now + lead + (s.wave === 1 ? T.wave1 : T.wave);
    return [this.log({ type: "wave", wave: s.wave, hands: pend.length }, now)];
  }

  // фишки, которые уже обещаны решениями других рук в этой волне (удвоение/сплит ещё не сданы)
  reserved(p, except) {
    return sumBy(p.hands, (h) => (h !== except && !h.done && (h.decision === "double" || h.decision === "split") ? h.bet : 0));
  }

  // что можно сделать с рукой прямо сейчас — те же проверки, что в decide(); для подписей кнопок на телефоне
  options(p, h) {
    const free = this.freeOf(p) - this.reserved(p, h);
    const two = h.cards.length === 2;
    return {
      hit: !p.frozen,
      stand: true,
      double: !p.frozen && two && free >= h.bet,
      split: !p.frozen && two && isPair(h.cards) && p.hands.length === 1 && free >= h.bet,
      redeal: !!p.redealAvail && !p.redealt && !p.frozen && two && p.hands.length === 1 && this.s.wave === 1,
    };
  }

  // решение по руке; «Пересдача» срабатывает сразу, остальные — при закрытии волны
  decide(id, handIdx, action, now) {
    const s = this.s;
    const p = this.player(id);
    if (s.phase !== "deciding") return { ok: false, reason: "closed" };
    if (!p || !p.inHand || p.left) return { ok: false, reason: "not_in_hand" };
    const h = p.hands[handIdx];
    if (!h) return { ok: false, reason: "bad_hand" };
    if (h.done) return { ok: false, reason: "hand_done" };
    const opt = this.options(p, h);
    if (!opt[action]) return { ok: false, reason: action in opt ? "not_allowed" : "bad_action" };
    const ev = [];
    if (action === "redeal") {
      p.redealt = true;
      p.redealAvail = false;
      h.cards = [this.draw(now), this.draw(now)];
      h.decision = null;
      ev.push(this.log({ type: "redeal", playerId: id }, now));
      if (isBlackjack(h.cards, false)) {
        h.done = true; h.decision = "stand"; h.auto = true;
        s.stats.blackjacks[p.id] = (s.stats.blackjacks[p.id] || 0) + 1;
        ev.push(this.log({ type: "blackjack", playerId: p.id }, now));
      }
    } else {
      h.decision = action;
      h.auto = false;
      ev.push(this.log({ type: "decision", playerId: id, hand: handIdx, action: action }, now));
    }
    // в соло (§9) карта приходит сразу по действию: волна = одна рука, нерешённые руки ждут следующего действия
    const waiting = this.pending().filter((x) => x.p.online && !x.p.left && !x.h.decision);
    if (s.settings.solo || !waiting.length) ev.push.apply(ev, this.closeWave(now));
    return { ok: true, events: ev };
  }

  /*
   * Закрытие волны: карты сдаются всем, кто брал, в порядке мест. Нет решения — «Хватит». Удвоение и сплит сдаются
   * в той же волне; после сплита обе руки решаются в следующей. 21 — автоматически стоп, перебор — рука закрыта.
   */
  closeWave(now) {
    const s = this.s;
    if (s.phase !== "deciding") return [];
    const ev = [];
    let dealt = 0;
    const card = (p, hi, h, why) => {
      const c = this.draw(now);
      h.cards.push(c);
      dealt++;
      const v = handValue(h.cards);
      ev.push(this.log({ type: "card", playerId: p.id, hand: hi, card: c, value: v.value, soft: v.soft, why: why }, now));
      if (v.value > 21) { h.done = true; ev.push(this.log({ type: "bust", playerId: p.id, hand: hi, value: v.value }, now)); }
      else if (v.value === 21) { h.done = true; s.stats.exact21++; ev.push(this.log({ type: "twentyone", playerId: p.id, hand: hi }, now)); }
    };
    for (const p of this.inHand()) {
      for (let i = 0; i < p.hands.length; i++) {
        const h = p.hands[i];
        if (h.done) continue;
        if (!h.decision && s.settings.solo) continue; // соло: без решения рука остаётся в игре, таймаута нет
        const action = h.decision || "stand";
        if (!h.decision) { h.decision = "stand"; h.auto = true; }
        if (action === "stand") h.done = true;
        else if (action === "hit") card(p, i, h, "hit");
        else if (action === "double" && this.freeOf(p) < h.bet) card(p, i, h, "hit"); // фишек не хватило (другая рука забрала) — просто карта
        else if (action === "split" && this.freeOf(p) < h.bet) h.done = true;
        else if (action === "double") {
          h.bet *= 2;
          h.doubled = true;
          card(p, i, h, "double");
          h.done = true;
        } else if (action === "split") {
          const second = newHand([h.cards[1]], h.bet, true);
          h.cards = [h.cards[0]];
          h.fromSplit = true;
          p.hands.push(second);
          ev.push(this.log({ type: "split", playerId: p.id }, now));
          const aces = h.cards[0].r === "A";
          card(p, i, h, "split");
          card(p, p.hands.length - 1, second, "split");
          if (aces) { h.done = true; second.done = true; } // сплит тузов — по одной карте, без добора (§3)
          i = p.hands.length; // вторую руку в этой волне не решаем
        }
      }
      if (this.allDone(p)) ev.push.apply(ev, this.applyExtra(p, now));
    }
    const lead = dealt * T.hitCard;
    return ev.concat(this.nextWave(now, lead));
  }

  // «Лишняя карта» (§6): после решений цели ей сдаётся ещё одна — в первую не перебравшую руку; блэкджек не трогаем
  applyExtra(p, now) {
    if (!p.extraCard || p.extraDone) return [];
    p.extraDone = true;
    const ev = [];
    const i = p.hands.findIndex((h) => handValue(h.cards).value <= 21 && !isBlackjack(h.cards, h.fromSplit));
    if (i < 0) return ev;
    const h = p.hands[i];
    const c = this.draw(now);
    h.cards.push(c);
    const v = handValue(h.cards);
    ev.push(this.log({ type: "card", playerId: p.id, hand: i, card: c, value: v.value, soft: v.soft, why: "extra" }, now));
    if (v.value > 21) ev.push(this.log({ type: "bust", playerId: p.id, hand: i, value: v.value }, now));
    else if (v.value === 21) { this.s.stats.exact21++; ev.push(this.log({ type: "twentyone", playerId: p.id, hand: i }, now)); }
    return ev;
  }

  // ---------- дилер ----------

  /*
   * Рука дилера считается целиком: открывает закрытую, добирает до 17 (стоит на любых 17), если есть хоть одна живая рука.
   * Итоги всех рук считаются здесь же, применяются в settle(). Режиссёр (§7.5) выбирает только темп показа — plot и revealAt.
   */
  dealerPlay(now, lead) {
    const s = this.s;
    if (s.phase !== "deciding" && s.phase !== "insurance") return [];
    const d = s.dealer;
    const players = this.inHand();
    const hands = [];
    for (const p of players) for (const h of p.hands) hands.push({ p: p, h: h });
    const live = hands.filter((x) => handValue(x.h.cards).value <= 21 && !isBlackjack(x.h.cards, x.h.fromSplit));
    if (!d.bj && live.length) while (handValue(d.cards).value < 17) d.cards.push(this.draw(now));
    const dv = handValue(d.cards);
    d.bust = dv.value > 21;
    if (d.bust) s.stats.dealerBusts++;

    const perPlayer = {};
    for (const p of players) {
      let wager = p.insurance;
      let win = 0;
      for (const h of p.hands) {
        const v = handValue(h.cards).value;
        const bj = isBlackjack(h.cards, h.fromSplit);
        wager += h.bet;
        if (v > 21) h.result = "lose";
        else if (bj && p.evenMoney) { h.result = "win"; h.evenMoney = true; } // «ровно 1:1» платит и против блэкджека дилера
        else if (d.bj) h.result = bj ? "push" : "lose";
        else if (bj) h.result = "bj";
        else if (d.bust || v > dv.value) h.result = "win";
        else if (v === dv.value) h.result = "push";
        else h.result = "lose";
        h.payout = h.result === "bj" ? Math.floor(h.bet * 2.5) : h.result === "win" ? h.bet * 2 : h.result === "push" ? h.bet : 0;
        win += h.payout;
      }
      const insWin = p.insurance && d.bj ? p.insurance * 3 : 0;
      win += insWin;
      const delta = win - wager;
      perPlayer[p.id] = { wager: wager, win: win, insWin: insWin, delta: delta, tax: 0, taxTo: null };
    }
    // «Налог» (§6): половина выигрыша цели — владельцу карты; проигрыш не делится
    for (const p of players) {
      const x = perPlayer[p.id];
      if (p.taxTo && x.delta > 0) {
        const owner = this.player(p.taxTo);
        if (owner && !owner.left) { x.tax = Math.floor(x.delta / 2); x.taxTo = owner.id; }
      }
    }
    s.result = { perPlayer: perPlayer };
    this.direct(now, lead || 0, live, hands);
    s.phase = "dealer";
    s.deadline = d.revealAt[d.revealAt.length - 1];
    return [this.log({ type: "dealer", plot: d.plot, cards: d.cards.length, revealAt: d.revealAt, secret: true }, now)];
  }

  /*
   * Режиссёр (§7.5): plot — один сюжет, флаги allin/jackpot/rescue — поверх него (они всегда).
   * Особые сюжеты longflip/cards/bust — не чаще одного на три раздачи; blackjack дилера — сам по себе.
   * «Долгий флип» зависит только от того, что видно до переворота (сколько рук стоят на 18–20), а не от итога.
   */
  direct(now, lead, live, hands) {
    const s = this.s;
    const d = s.dealer;
    const min = this.levelNeed();
    d.allin = this.inHand().filter((p) => p.allIn).map((p) => p.id);
    // «спасение»: на последних фишках и выигрыш не меньше того, что оставалось — иначе в конце партии это каждая вторая раздача
    d.rescue = this.inHand().filter((p) => p.stackAtDeal <= 2 * min && s.result.perPlayer[p.id].delta >= p.stackAtDeal).map((p) => p.id);
    const specialOk = !s.specialsAt.some((h) => s.hand - h < 3);
    let plot = "normal";
    if (d.bj) plot = "dealerbj";
    else if (d.allin.length) plot = "allin";
    else if (d.jackpot) plot = "jackpot";
    else if (d.rescue.length) plot = "rescue";
    else if (specialOk) {
      const cand = [];
      const standing = live.filter((x) => { const v = handValue(x.h.cards).value; return v >= 18 && v <= 20; }).length;
      if (standing >= 2 && standing * 2 >= live.length) cand.push("longflip");
      if (d.cards.length >= 4) cand.push("cards");
      if (d.bust && live.length >= 2) cand.push("bust");
      // подходящая ситуация — ещё не повод: берём её с вероятностью SPECIAL_CHANCE, иначе особых выходило 40%+ (цель 25–35)
      if (cand.length && this.rnd(100) < SPECIAL_CHANCE) {
        plot = cand[this.rnd(cand.length)];
        s.specialsAt.push(s.hand);
        s.specialsAt = s.specialsAt.slice(-4);
      }
    }
    d.plot = plot;
    d.lead = lead;
    // расписание: [переворот, карта добора…, итог]
    let t = now + lead + (plot === "allin" ? T.allinLead : 0);
    const at = [];
    t += plot === "longflip" ? T.flipLong : plot === "dealerbj" ? T.flipBj : T.flip;
    at.push(t);
    for (let i = 2; i < d.cards.length; i++) {
      t += T.draw + (plot === "cards" ? T.drawStep * (i - 1) : 0);
      at.push(t);
    }
    t += plot === "bust" ? T.endBust : plot === "rescue" ? T.endRescue : T.end;
    const cap = now + lead + T.dealerMax;
    d.revealAt = at.map((x) => Math.min(x, cap)).concat([Math.min(t, cap)]);
  }

  // ---------- выплаты ----------

  settle(now) {
    const s = this.s;
    const r = s.result;
    if (!r || s.phase !== "dealer") return [];
    const d = s.dealer;
    const ev = [this.log({ type: "reveal", dealer: d.cards, value: handValue(d.cards).value, bust: d.bust, bj: d.bj }, now)];
    const minNow = this.levelNeed();
    for (const p of this.inHand()) {
      const x = r.perPlayer[p.id];
      if (!x) continue;
      p.stack += x.delta - x.tax;
      p.net += x.delta - x.tax;
      s.casino.won += x.wager;
      s.casino.paid += x.win;
      if (x.tax) {
        const o = this.player(x.taxTo);
        if (o) { o.stack += x.tax; o.net += x.tax; }
        ev.push(this.log({ type: "tax", playerId: x.taxTo, target: p.id, amount: x.tax }, now));
        if (!s.stats.cruelCard || x.tax > s.stats.cruelCard.amount) s.stats.cruelCard = { by: x.taxTo, target: p.id, card: "tax", amount: x.tax };
      }
      if (x.delta > 0 && (!s.stats.biggestWin || x.delta > s.stats.biggestWin.amount)) s.stats.biggestWin = { playerId: p.id, amount: x.delta };
      for (const h of p.hands) {
        if (handValue(h.cards).value > 21 && (!s.stats.biggestBust || h.bet > s.stats.biggestBust.amount)) s.stats.biggestBust = { playerId: p.id, amount: h.bet };
      }
      if (p.stack > 0 && p.stack <= 2 * minNow) s.stats.lastBreath[p.id] = (s.stats.lastBreath[p.id] || 0) + 1;
    }
    // самая злая карта: сколько цель потеряла из-за заморозки/лишней карты/обмена — считаем проигрыш цели по основной
    for (const rv of s.reveals) {
      if (rv.outcome !== "ok" || SELF_TRICKS.indexOf(rv.card) >= 0 || rv.card === "tax" || rv.card === "doublemin") continue;
      const x = r.perPlayer[rv.target];
      const harm = x && x.delta < 0 ? -x.delta : 0;
      if (harm && (!s.stats.cruelCard || harm > s.stats.cruelCard.amount)) s.stats.cruelCard = { by: rv.by, target: rv.target, card: rv.card, amount: harm };
    }
    const busted = this.alive().filter((p) => p.stack <= 0);
    for (const p of busted) {
      p.out = true;
      p.outHand = s.hand;
      ev.push(this.log({ type: "out", playerId: p.id, reason: "bust" }, now));
    }
    s.phase = "payout";
    s.deadline = now + (d.jackpot ? T.payoutJackpot : T.payout);
    ev.push(this.log({ type: "payout", net: this.inHand().map((p) => ({ playerId: p.id, net: p.net })) }, now));

    // отсечение турнира (§2): каждые K раздач уходит самый бедный из живых
    if (s.settings.format === "tournament" && this.cutIn() === 0 && this.alive().length > 1) {
      const victims = this.alive().sort((a, b) => a.stack - b.stack || a.net - b.net);
      const poorest = victims.filter((p) => p.stack === victims[0].stack);
      let v = poorest.filter((p) => p.net === poorest[0].net); // ничья по фишкам — кто больше проиграл в этой раздаче
      const coin = v.length > 1; // и это равно — жребий на экране
      const victim = coin ? v[this.rnd(v.length)] : v[0];
      victim.out = true;
      victim.outHand = s.hand;
      ev.push(this.log({ type: "cut", playerId: victim.id, coin: coin, among: coin ? v.map((p) => p.id) : [victim.id] }, now));
    }

    const left = this.alive();
    const fmt = s.settings.format;
    if (left.length === 1 && !s.settings.solo) ev.push.apply(ev, this.finish("last", now));
    else if (left.length === 0) ev.push.apply(ev, this.finish("all_out", now, busted));
    else if (fmt === "hands" && s.hand >= s.settings.handsTotal) ev.push.apply(ev, this.finish("hands", now));
    return ev;
  }

  finish(reason, now, busted) {
    const s = this.s;
    if (s.phase === "finished" || s.finishAfterPayout) return [];
    busted = busted || [];
    const alive = this.alive();
    let winner = null;
    let ties = [];
    if (alive.length) {
      const sorted = alive.slice().sort((a, b) => b.stack - a.stack);
      winner = sorted[0];
      // «N раздач» и «Закончить»: равные верхние стеки — ничья, делится
      if (reason === "hands" || reason === "host") ties = alive.filter((p) => p.stack === winner.stack);
    } else if (busted.length) {
      // все обнулились разом: выше тот, у кого было больше до раздачи, при равенстве — кто поставил больше
      const pp = (s.result && s.result.perPlayer) || {};
      winner = busted.slice().sort((a, b) => b.stackAtDeal - a.stackAtDeal || ((pp[b.id] || {}).wager || 0) - ((pp[a.id] || {}).wager || 0))[0];
    }
    s.winnerId = winner ? winner.id : null;
    s.finishedReason = reason;
    s.draw = ties.length > 1;
    s.winnerIds = s.draw ? ties.map((p) => p.id) : s.winnerId ? [s.winnerId] : [];
    const order = s.players.filter((p) => !p.spectator).sort((a, b) => {
      if (a === winner) return -1;
      if (b === winner) return 1;
      if (!a.out && !b.out) return b.stack - a.stack;
      if (!a.out) return -1;
      if (!b.out) return 1;
      return (b.outHand || 0) - (a.outHand || 0) || b.stack - a.stack;
    });
    order.forEach((p, i) => { p.place = s.draw && s.winnerIds.indexOf(p.id) >= 0 ? 1 : i + 1; });
    if (s.phase === "payout") s.finishAfterPayout = true;
    else { s.phase = "finished"; s.deadline = null; }
    return [this.log({ type: "finished", winnerId: s.winnerId, winnerIds: s.winnerIds, draw: s.draw, reason: reason }, now)];
  }

  // ---------- таймер ----------

  // движение фаз, когда все решили раньше срока (ушёл последний, кого ждали)
  maybeAdvance(now) {
    const s = this.s;
    if (now == null) return [];
    if (s.phase === "betting" && !s.paused) {
      const waiting = this.alive().filter((x) => x.online && !x.ready);
      if (!waiting.length && this.alive().some((x) => x.online)) return this.closeBets(now);
    } else if (s.phase === "insurance" && s.dealer.insurance) {
      const waiting = this.inHand().filter((x) => x.online && !x.left && !x.insDecided);
      if (!waiting.length) return this.resolveInsurance(now);
    } else if (s.phase === "deciding") {
      const waiting = this.pending().filter((x) => x.p.online && !x.p.left && !x.h.decision);
      if (!waiting.length && this.pending().some((x) => x.h.decision)) return this.closeWave(now);
    }
    return [];
  }

  tick(now) {
    const s = this.s;
    if (s.paused || s.deadline == null || now < s.deadline) return [];
    switch (s.phase) {
      case "betting": return this.closeBets(now);
      case "closing": return s.result && s.result.empty ? this.emptyHand(now) : this.deal(now);
      case "dealing": return this.afterDeal(now);
      case "insurance": return this.resolveInsurance(now);
      case "deciding": return this.closeWave(now);
      case "dealer": return this.settle(now);
      case "payout":
        if (s.finishAfterPayout) {
          s.finishAfterPayout = false;
          s.phase = "finished";
          s.deadline = null;
          return [this.log({ type: "final" }, now)];
        }
        return this.beginHand(now);
      default: return [];
    }
  }

  // раздача, в которой никто не поставил: только штрафы, выплат нет
  emptyHand(now) {
    const s = this.s;
    s.phase = "dealer";
    s.dealer.revealAt = [now];
    return this.settle(now);
  }

  // ---------- ведущий ----------

  pause(now) {
    const s = this.s;
    if (s.phase === "betting" && !s.paused) {
      s.paused = { remaining: Math.max(3000, (s.deadline || now) - now) };
      s.deadline = null;
    } else if (s.phase !== "lobby" && s.phase !== "finished") {
      s.pauseNext = true;
    }
    return [this.log({ type: "paused" }, now)];
  }

  resume(now) {
    const s = this.s;
    s.pauseNext = false;
    if (!s.paused) return [];
    s.deadline = s.settings.solo ? null : now + s.paused.remaining;
    s.paused = null;
    return [this.log({ type: "resumed" }, now)];
  }

  finishNow(now) {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished") return [];
    // посреди раздачи итог ещё не показан — ставки этой раздачи не играют
    if (s.phase !== "payout") {
      for (const p of s.players) { if (p.inHand) { p.inHand = false; p.hands = []; } p.bet = 0; p.side = { pp: 0, tp: 0 }; p.doubleMinNext = false; }
      s.result = null;
    }
    const ev = this.finish("host", now);
    if (s.finishAfterPayout) { s.finishAfterPayout = false; s.phase = "finished"; s.deadline = null; }
    return ev;
  }

  // новая партия в той же комнате: те же игроки, всё с нуля; зрители садятся за стол, пока есть места
  reset() {
    const s = this.s;
    const players = s.players.filter((p) => !p.left);
    const fresh = Game.create({ settings: s.settings, rnd: this.rnd, code: s.code }).s;
    fresh.chat = s.chat;
    fresh.chatSeq = s.chatSeq;
    fresh.game = s.game;
    const ordered = players.filter((p) => !p.spectator).concat(players.filter((p) => p.spectator));
    const max = s.settings.solo ? 1 : MAX_PLAYERS;
    fresh.players = ordered.map((p, i) => {
      const seat = i < max;
      const q = Object.assign({}, p, { spectator: !seat, seat: seat ? i : null, stack: seat ? s.settings.stack : 0, trick: [], out: !seat, outHand: null, place: null, lastBet: null, doubleMinNext: false });
      this.resetHandState(q);
      delete q.away;
      return q;
    });
    this.s = fresh;
    return [this.log({ type: "new_game" })];
  }

  // ---------- чат и реакции ----------

  chat(id, text, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p) return { ok: false, reason: "no_player" };
    if (!s.settings.chat) return { ok: false, reason: "chat_off" };
    if (p.muted) return { ok: false, reason: "muted" };
    text = cleanText(text, CHAT_LEN);
    if (!text) return { ok: false, reason: "empty" };
    if (p.lastChat != null && now - p.lastChat < CHAT_GAP) return { ok: false, reason: "too_fast" };
    p.lastChat = now;
    const m = { id: ++s.chatSeq, pid: id, text: text, at: now, hidden: false };
    s.chat.push(m);
    if (s.chat.length > CHAT_KEEP) s.chat = s.chat.slice(-CHAT_KEEP);
    return { ok: true, events: [{ type: "chat", message: m }] };
  }

  // реакция; «Болею за…» — emoji "💛" с forId (выбывший болеет за живого)
  react(id, emoji, now, forId) {
    const p = this.player(id);
    if (!p) return { ok: false, reason: "bad" };
    let ev;
    if (emoji === "💛") {
      const t = this.player(forId);
      if (!t || t.out || t.id === id) return { ok: false, reason: "bad" };
      ev = { type: "cheer", playerId: id, forId: t.id };
    } else {
      if (REACTIONS.indexOf(emoji) < 0) return { ok: false, reason: "bad" };
      ev = { type: "react", playerId: id, emoji: emoji };
    }
    if (p.lastReact != null && now - p.lastReact < REACT_GAP) return { ok: false, reason: "too_fast" };
    p.lastReact = now;
    return { ok: true, events: [ev] };
  }

  hideMessage(msgId) {
    const m = this.s.chat.find((x) => x.id === msgId);
    if (!m) return [];
    m.hidden = true;
    return [{ type: "chat_hidden", id: msgId }];
  }

  mute(id, muted) {
    const p = this.player(id);
    if (!p) return [];
    p.muted = !!muted;
    return [{ type: "muted", playerId: id, muted: p.muted }];
  }

  // ---------- снимок для клиентов ----------

  /*
   * forPlayer: null/undefined/"board" — доска, иначе id игрока.
   * Скрытность (§10): закрытая карта и добор дилера — только доске и только с фазы dealer; телефону в фазе dealer —
   * только revealAt итога, результаты рук и сюжет — после него. Владелец «Подгляда» видит закрытую карту в me.peekHole.
   * Чужие карты-пакости — количество; сыгранные до открытия — только факт. Карты игроков открыты всем.
   */
  snapshot(now, forPlayer) {
    const s = this.s;
    const board = forPlayer == null || forPlayer === "board";
    const me = board ? null : this.player(forPlayer);
    const d = s.dealer;
    const finalAt = d && d.revealAt.length ? d.revealAt[d.revealAt.length - 1] : null;
    const dealerOpen = !!d && (s.phase === "dealer" || s.phase === "payout" || s.phase === "finished");
    // доска видит итог с начала фазы dealer; телефон — когда доска его показала
    const resultsOpen = dealerOpen && (board || s.phase !== "dealer" || now >= finalAt);
    const cardsOpen = s.phase !== "betting" && s.phase !== "lobby";
    const inHand = s.phase !== "lobby" && s.phase !== "betting" && s.phase !== "finished";

    let dealer = null;
    if (d) {
      const cards = d.cards;
      const shown = resultsOpen ? cards : cards.slice(0, 1);
      const v = handValue(shown);
      dealer = {
        up: cards[0] || null,
        hole: resultsOpen ? cards[1] || null : null,
        cards: shown,
        value: v.value,
        soft: v.soft,
        bust: resultsOpen ? d.bust : false,
        blackjack: resultsOpen ? d.bj : false,
        peek: d.peek,
        insurance: d.insurance,
        plot: resultsOpen ? d.plot : null,
        revealAt: dealerOpen ? (board ? d.revealAt : finalAt != null ? [finalAt] : []) : [],
        allin: resultsOpen ? d.allin : [],
        jackpot: cardsOpen ? d.jackpot : false,
        rescue: resultsOpen ? d.rescue : [],
      };
    }

    const players = s.players.map((p) => {
      const opts = me && me.id === p.id && s.phase === "deciding" ? p.hands.map((h) => (h.done ? null : this.options(p, h))) : null;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        seat: p.seat,
        stack: p.stack,
        free: this.freeOf(p),
        online: p.online,
        left: p.left,
        out: p.out,
        outHand: p.outHand,
        spectator: !!p.spectator,
        place: s.phase === "finished" ? p.place : null,
        ready: p.ready,
        bet: p.bet,
        side: p.side,
        need: p.out || p.left ? 0 : this.need(p),
        inHand: p.inHand,
        skip: p.skip,
        allIn: cardsOpen ? p.allIn : false,
        insurance: p.insurance,
        evenMoney: p.evenMoney,
        insDecided: p.insDecided,
        hands: p.hands.map((h, i) => {
          const v = handValue(h.cards);
          return {
            cards: h.cards,
            bet: h.bet,
            value: v.value,
            soft: v.soft,
            bust: v.value > 21,
            blackjack: isBlackjack(h.cards, h.fromSplit),
            done: h.done,
            doubled: h.doubled,
            fromSplit: h.fromSplit,
            decision: h.decision,
            auto: h.auto,
            result: resultsOpen ? h.result : null,
            payout: resultsOpen ? h.payout : 0,
            evenMoney: resultsOpen ? h.evenMoney : false,
            options: opts ? opts[i] : null,
          };
        }),
        penalty: p.penalty,
        net: resultsOpen || s.phase === "payout" ? p.net : null,
        cardsCount: p.trick.length,
        shield: p.trick.indexOf("shield") >= 0 && (board || (me && me.id === p.id)), // чужой Щит не виден
        played: s.played.some((x) => x.by === p.id),
        frozen: cardsOpen ? p.frozen : false,
        extraIncoming: cardsOpen ? p.extraCard && !p.extraDone : false,
        taxed: cardsOpen ? p.taxTo : null,
        doubleMin: p.doubleMin,
        doubleMinNext: cardsOpen ? p.doubleMinNext : false,
        peeked: cardsOpen ? p.peek : false,
        sideResults: cardsOpen ? p.sideResults : { pp: null, tp: null },
        muted: p.muted,
      };
    });

    return {
      phase: s.paused ? "paused" : s.phase,
      pausedPhase: s.paused ? s.phase : null,
      pauseNext: !!s.pauseNext,
      now: now,
      phaseEndsAt: s.deadline,
      waveStart: s.phase === "deciding" ? s.waveStart : null,
      game: s.game,
      hand: s.hand,
      level: s.level,
      levels: TOP_LEVEL + 1,
      minBet: this.levelNeed(),
      overtime: this.overtime(),
      nextMinBet: this.levelNeed(this.levelFor(s.hand + 1)),
      handsToLevel: s.phase === "lobby" ? null : this.paceHands() - ((s.hand - 1) % this.paceHands()) - 1,
      format: s.settings.format,
      handsTotal: s.settings.format === "hands" ? s.settings.handsTotal : null,
      cutIn: this.cutIn(),
      cutK: s.cutK,
      wave: s.phase === "deciding" ? s.wave : 0,
      shoe: { left: Math.max(0, SHOE_SIZE - s.shoeDealt) / SHOE_SIZE, cut: 1 - CUT, reshuffle: s.reshuffled },
      dealing: s.phase === "dealing" ? s.dealing : null,
      dealer: dealer,
      reveals: cardsOpen ? s.reveals : [],
      players: players,
      me: me ? {
        id: me.id,
        cards: me.trick,
        peekHole: me.peek && d && d.cards.length > 1 && inHand ? d.cards[1] : null,
        hintOn: me.hintOn,
        muted: me.muted,
        lastBet: me.lastBet,
        redealAvail: me.redealAvail && !me.redealt,
      } : null,
      // события с secret (сюжет и карты дилера) телефон получает, когда доска их показала
      events: resultsOpen || !d ? s.events : s.events.filter((e) => !e.secret || e.hand !== s.hand),
      chat: s.chat.filter((m) => !m.hidden).slice(-12),
      settings: s.settings,
      winnerId: s.phase === "finished" ? s.winnerId : null,
      winnerIds: s.phase === "finished" ? s.winnerIds : [],
      draw: s.phase === "finished" ? !!s.draw : false,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      stats: s.phase === "finished" ? s.stats : null,
      casino: s.casino,
      minPlayers: this.minPlayers(),
    };
  }
}

const API = {
  Game: Game, T: T, SPECIAL_CHANCE: SPECIAL_CHANCE, DEFAULTS: DEFAULTS, LEVELS: LEVELS, OVERTIME: OVERTIME, TOP_LEVEL: TOP_LEVEL, PACE: PACE, FORMATS: FORMATS, HANDS_TOTAL: HANDS_TOTAL,
  MAX_PLAYERS: MAX_PLAYERS, MIN_PLAYERS: MIN_PLAYERS, NAME_MAX: NAME_MAX, COLORS: COLORS, AVATARS: AVATARS, REACTIONS: REACTIONS,
  TRICKS: TRICKS, SELF_TRICKS: SELF_TRICKS, TRICK_HAND: TRICK_HAND, RANKS: RANKS, SUITS: SUITS, DECKS: DECKS, SHOE_SIZE: SHOE_SIZE, CUT: CUT, PP: PP, TP: TP,
  clampSettings: clampSettings, cleanName: cleanName, cleanText: cleanText, nameKey: nameKey,
  cardValue: cardValue, handValue: handValue, isBlackjack: isBlackjack, isPair: isPair, perfectPairs: perfectPairs, twentyOnePlusThree: twentyOnePlusThree,
  parseCard: parseCard, packCard: packCard, shuffle: shuffle,
};
if (typeof module !== "undefined" && module.exports) module.exports = API;
else window.BlackjackGame = API;

})();
