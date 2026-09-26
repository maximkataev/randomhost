"use strict";

/*
 * Движок рулетки: чистая логика без сети и таймеров (roulette-spec.md).
 * Всё состояние лежит в plain-объекте `this.s`, чтобы его можно было дампить в JSON и поднимать обратно.
 * Время приходит снаружи (`now` в миллисекундах): сервер зовёт tick(now), когда истекает ближайший deadline.
 * Случайность тоже снаружи (`rnd(n)` → целое 0..n-1): сервер даёт crypto.randomInt, тесты — детерминированную.
 * Каждый метод возвращает список событий для эффектов на клиентах ({type, ...}).
 *
 * Все играют против казино. Казино не разоряется, преимущество зеро уходит ему — фишки из игры
 * постепенно утекают, а растущий минимум (как блайнды) не даёт отсидеться.
 */

// ---------- стол ----------

// Порядок ячеек на европейском колесе по часовой стрелке, начиная с зеро
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n) => (n === 0 ? "green" : RED.has(n) ? "red" : "black");

// Выплата определяется числом покрытых номеров: 35:1 за одно, 1:1 за восемнадцать
const PAYOUT = { 1: 35, 2: 17, 3: 11, 4: 8, 6: 5, 12: 2, 18: 1 };

/*
 * Все допустимые ставки. Ключ — то, что шлёт клиент: внутренние ставки как «n:17», «sp:1-2»,
 * «st:1-2-3», «co:1-2-4-5», «sl:1-2-3-4-5-6» (номера по возрастанию), внешние — по имени.
 * Стол — 12 рядов по 3: в ряду r (0..11) числа 3r+1, 3r+2, 3r+3.
 */
function buildBets() {
  // без прототипа: иначе BETS["__proto__"] или BETS["constructor"] проходили бы проверку ключа
  const bets = Object.create(null);
  const add = (type, numbers, key) => {
    numbers = numbers.slice().sort((a, b) => a - b);
    key = key || `${type}:${numbers.join("-")}`;
    bets[key] = { key, type, numbers, pays: PAYOUT[numbers.length] };
  };
  const at = (r, c) => 3 * r + c + 1;
  for (let n = 0; n <= 36; n++) add("n", [n]);
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 2; c++) add("sp", [at(r, c), at(r, c + 1)]);
    if (r < 11) for (let c = 0; c < 3; c++) add("sp", [at(r, c), at(r + 1, c)]);
    add("st", [at(r, 0), at(r, 1), at(r, 2)]);
    if (r < 11) {
      for (let c = 0; c < 2; c++) add("co", [at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)]);
      add("sl", [at(r, 0), at(r, 1), at(r, 2), at(r + 1, 0), at(r + 1, 1), at(r + 1, 2)]);
    }
  }
  add("sp", [0, 1]); add("sp", [0, 2]); add("sp", [0, 3]);
  add("st", [0, 1, 2]); add("st", [0, 2, 3]);
  add("co", [0, 1, 2, 3]);
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  for (let d = 0; d < 3; d++) add("dz", range(12 * d + 1, 12 * d + 12), `dz:${d + 1}`);
  for (let c = 0; c < 3; c++) add("col", range(0, 11).map((r) => at(r, c)), `col:${c + 1}`);
  const all = range(1, 36);
  add("red", all.filter((n) => RED.has(n)), "red");
  add("black", all.filter((n) => !RED.has(n)), "black");
  add("even", all.filter((n) => n % 2 === 0), "even");
  add("odd", all.filter((n) => n % 2 === 1), "odd");
  add("low", range(1, 18), "low");
  add("high", range(19, 36), "high");
  return bets;
}
const BETS = buildBets();

// ---------- партия ----------

// Минимальная ставка в процентах от стартового стека, по уровням (§4). Последний уровень держится до конца.
const LEVELS = [1, 2, 3, 5, 8, 12, 18, 25, 35, 50];
/*
 * Овертайм: после последнего уровня минимум растёт от среднего стека живых игроков (25 → 50 → 100%).
 * Без него игрок, сорвавший 35:1 в начале, сидел с 35 стартовыми стеками против минимума в полстека,
 * и партия на 12 человек в каждой десятой игре тянулась больше полутора часов (стенд sim.js).
 * Считаем от среднего, а не от своего стека: доля своего стека превращала финал в монетку для всех,
 * накопленное преимущество ничего не стоило, и «ставлю ровно минимум» выигрывал 36% партий на шестерых.
 * Средний стек фиксируется в начале спина (s.avgStack), чтобы минимум не прыгал во время ставок.
 */
const OVERTIME = [25, 50, 100];
const TOP_LEVEL = LEVELS.length + OVERTIME.length - 1;
// Через сколько спинов поднимается уровень
const PACE = { fast: 2, normal: 3, slow: 4 };

const DEFAULTS = {
  stack: 1000, // 500 | 1000 | 2000
  pace: "normal",
  betTime: 25000, // 20 | 25 | 30 | 45 с
  cards: true,
  chat: true,
  calm: false, // «без укачивания»: камера доски без полёта за шариком
  lang: "ru",
};

const T = {
  closeBase: 1800, // «ставок больше нет» без карт
  closePerCard: 1100, // на открытие каждой карты
  payout: 5000,
  payoutJackpot: 6500,
  spinMin: 9000,
  spinMax: 14000,
};

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 2;
const HAND = 3;
const CHAT_LEN = 80;
const CHAT_GAP = 3000;
const CHAT_KEEP = 50;
const REACT_GAP = 1000;
const REACTIONS = ["🔥", "😱", "😂", "👏", "🙏", "💀"];

// Цвета игроков: ни один не спорит с красным, чёрным и зелёным стола (§10)
const COLORS = ["#f2c14e", "#4ea8f2", "#b57bff", "#ff8fc7", "#5de0d0", "#ff9a3c", "#e8e8e8", "#9ad14b", "#7f8cff", "#d9a86c", "#ff6f91", "#62c6ff"];

const CARD_TYPES = ["double", "freeze", "share", "eye", "shield"];
const CARD_COPIES = 3;

function clampSettings(input = {}) {
  const s = { ...DEFAULTS };
  if ([500, 1000, 2000].includes(Number(input.stack))) s.stack = Number(input.stack);
  if (PACE[input.pace]) s.pace = input.pace;
  if ([20000, 25000, 30000, 45000].includes(Number(input.betTime))) s.betTime = Number(input.betTime);
  for (const k of ["cards", "chat", "calm"]) if (typeof input[k] === "boolean") s[k] = input[k];
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  return s;
}

// имя игрока: без управляющих символов, без лишних пробелов, до 16 символов
// режем по символам, а не по единицам UTF-16: иначе эмодзи на 16-й позиции разрезался пополам
const cut = (str, n) => Array.from(str).slice(0, n).join("");
function cleanName(name) {
  return cut(String(name || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim(), 16);
}
function cleanText(text) {
  return cut(String(text || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim(), CHAT_LEN);
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const defaultRnd = (n) => Math.floor(Math.random() * n);

class Game {
  constructor(state, rnd = defaultRnd) {
    this.s = state;
    this.rnd = rnd;
  }

  static create({ settings, rnd = defaultRnd } = {}) {
    return new Game({
      settings: clampSettings(settings),
      phase: "lobby", // lobby | betting | closing | spinning | payout | finished
      players: [],
      spin: 0, // номер текущего спина с 1
      level: 0,
      deadline: null,
      paused: null, // {remaining} — пауза ведущего; держится только в фазе ставок
      pauseNext: false, // пауза заказана во время вращения — встанет на следующих ставках
      deck: [],
      played: [], // карты этого спина: {by, card, target, at}
      result: null, // см. close()
      history: [], // последние выпавшие числа, новые в начале
      chat: [], // {id, pid, text, at, hidden}
      chatSeq: 0,
      casino: { won: 0, paid: 0 }, // сколько казино забрало и выплатило за партию
      stats: { biggestWin: null, cruelCard: null, biggestPenalty: null, lastBreath: {} },
      winnerId: null,
      finishedReason: null, // last | host | all_out
      specialsAt: [], // номера спинов с «особым» сюжетом — не чаще одного на три спина (§7.4)
    }, rnd);
  }

  static from(state, rnd) {
    return new Game(state, rnd);
  }

  // ---------- участники ----------

  player(id) {
    return this.s.players.find((p) => p.id === id);
  }

  alive() {
    return this.s.players.filter((p) => !p.out && !p.left);
  }

  /*
   * Опоздавший посреди партии садится зрителем: чат и реакции есть, ставок нет, в местах финала его нет.
   * На «Ещё партию» зритель становится игроком. Без этого пришедший к 5-й минуте ждал 20 минут у экрана.
   */
  addPlayer({ id, name }) {
    const s = this.s;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    const spectator = s.phase !== "lobby";
    if (s.players.filter((p) => !p.left).length >= MAX_PLAYERS) return { ok: false, reason: "room_full" };
    name = cleanName(name);
    if (!name) return { ok: false, reason: "bad_name" };
    const used = new Set(s.players.map((p) => p.color));
    const p = {
      id,
      name,
      color: COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length],
      stack: spectator ? 0 : s.settings.stack,
      bets: {}, // key → сумма
      lastBets: {}, // ставки прошлого спина — для «Повторить»
      ready: false,
      hand: [],
      frozen: false, // заморожен на текущий спин
      out: spectator,
      outSpin: null,
      spectator,
      place: null, // итоговое место
      online: true,
      left: false,
      muted: false,
      lastChat: null,
      lastReact: null,
    };
    s.players.push(p);
    return { ok: true, player: p };
  }

  removePlayer(id, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p) return [];
    if (s.phase === "lobby") {
      s.players = s.players.filter((x) => x !== p);
      return [{ type: "left", playerId: id }];
    }
    // посреди партии: игрок выбывает, его фишки со стола сгорают — казино их не возвращает
    if (p.left) return [];
    p.left = true;
    if (!p.out) { p.out = true; p.outSpin = s.spin; }
    p.bets = {};
    p.ready = false;
    const ev = [{ type: "left", playerId: id }];
    if (s.phase !== "finished" && this.alive().length <= 1) ev.push(...this.finish("last", now));
    else ev.push(...this.briefingDone(now));
    return ev;
  }

  setOnline(id, online, now) {
    const p = this.player(id);
    if (p) p.online = online;
    // ушёл последний, кого ждали на знакомстве с картами, — начинаем без него
    return !online && now != null ? this.briefingDone(now) : [];
  }

  // ---------- ход партии ----------

  // минимум уровня — одинаковый для всех
  minBet(level = this.s.level) {
    const s = this.s;
    return Math.max(1, Math.round((s.settings.stack * LEVELS[Math.min(level, LEVELS.length - 1)]) / 100));
  }

  overtime(level = this.s.level) {
    return level >= LEVELS.length ? OVERTIME[level - LEVELS.length] : 0;
  }

  // сколько обязан поставить этот игрок: минимум уровня, в овертайме — доля среднего стека, но не больше своего стека
  need(p, level = this.s.level) {
    return Math.min(p.stack, this.levelNeed(level));
  }

  levelNeed(level = this.s.level) {
    const ot = this.overtime(level);
    return Math.max(this.minBet(level), Math.ceil(((this.s.avgStack || 0) * ot) / 100));
  }

  levelFor(spin) {
    return Math.min(TOP_LEVEL, Math.floor((spin - 1) / PACE[this.s.settings.pace]));
  }

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby") return { ok: false, reason: "started" };
    if (this.alive().length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    s.deck = [];
    for (const p of this.alive()) {
      p.stack = s.settings.stack;
      p.hand = [];
      if (s.settings.cards) this.deal(p);
    }
    // С картами — сначала знакомство: каждый читает свои карты на телефоне и жмёт «Готов».
    // Без этого первая карта прилетала в спин, где половина стола ещё не поняла, что у неё в руке.
    if (s.settings.cards) {
      s.phase = "briefing";
      s.deadline = null;
      for (const p of s.players) p.ready = false;
      return { ok: true, events: [{ type: "started" }, { type: "briefing" }] };
    }
    return { ok: true, events: [{ type: "started" }, ...this.beginSpin(now)] };
  }

  // знакомство закончено, когда готовы все живые игроки на связи; офлайн не держит стол
  briefingDone(now) {
    const s = this.s;
    if (s.phase !== "briefing") return [];
    const alive = this.alive();
    if (!alive.length || alive.some((p) => p.online && !p.ready)) return [];
    if (!alive.some((p) => p.online)) return []; // все отвалились — ждём, а не начинаем в пустоту
    return this.beginSpin(now);
  }

  // ведущий начинает, не дожидаясь зависших
  hostGo(now) {
    if (this.s.phase !== "briefing") return [];
    return this.beginSpin(now);
  }

  deal(p) {
    const s = this.s;
    if (p.hand.length >= HAND) return;
    if (!s.deck.length) {
      // колода кончилась — тасуем заново всё, чего нет на руках (§6)
      const inHands = {};
      for (const x of s.players) for (const c of x.hand) inHands[c] = (inHands[c] || 0) + 1;
      const fresh = [];
      for (const c of CARD_TYPES) for (let i = inHands[c] || 0; i < CARD_COPIES; i++) fresh.push(c);
      s.deck = shuffle(fresh, this.rnd);
      if (!s.deck.length) return;
    }
    p.hand.push(s.deck.pop());
  }

  beginSpin(now) {
    const s = this.s;
    s.spin++;
    const level = this.levelFor(s.spin);
    const ev = [];
    if (level !== s.level) {
      s.level = level;
      ev.push({ type: "level", level, minBet: this.minBet(), overtime: this.overtime() });
      if (s.settings.cards) for (const p of this.alive()) this.deal(p);
    }
    const alive = this.alive();
    s.avgStack = alive.length ? Math.round(alive.reduce((a, p) => a + p.stack, 0) / alive.length) : 0;
    s.phase = "betting";
    s.played = [];
    s.result = null;
    for (const p of s.players) {
      p.bets = {};
      p.ready = false;
      p.frozen = !!p.freezeNext && !p.out;
      p.freezeNext = false;
    }
    if (s.pauseNext) {
      s.pauseNext = false;
      s.paused = { remaining: s.settings.betTime };
      s.deadline = null;
    } else {
      s.deadline = now + s.settings.betTime;
    }
    ev.push({ type: "betting", spin: s.spin });
    return ev;
  }

  canBet(p) {
    return this.s.phase === "betting" && p && !p.out && !p.left && !p.frozen;
  }

  // одна фишка на позицию
  bet(id, key, amount) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: p && p.frozen ? "frozen" : "closed" };
    if (!BETS[key]) return { ok: false, reason: "bad_bet" };
    amount = Math.floor(Number(amount));
    if (!(amount >= 1)) return { ok: false, reason: "bad_amount" };
    if (sum(p.bets) + amount > p.stack) return { ok: false, reason: "no_money" };
    p.bets[key] = (p.bets[key] || 0) + amount;
    p.ready = false;
    return { ok: true };
  }

  /*
   * Ставки целиком: «Отменить», «Очистить», «Повторить», «Удвоить», «Как у Пети» клиент считает
   * сам и присылает итоговый набор. Сервер проверяет всё разом: либо набор принят, либо ничего.
   */
  setBets(id, bets) {
    const p = this.player(id);
    if (!this.canBet(p)) return { ok: false, reason: p && p.frozen ? "frozen" : "closed" };
    if (!bets || typeof bets !== "object" || Array.isArray(bets)) return { ok: false, reason: "bad_bet" };
    const next = Object.create(null);
    const keys = Object.keys(bets);
    if (keys.length > 200) return { ok: false, reason: "bad_bet" };
    for (const key of keys) {
      if (!BETS[key]) return { ok: false, reason: "bad_bet" };
      const a = Math.floor(Number(bets[key]));
      if (!(a >= 0)) return { ok: false, reason: "bad_amount" };
      if (a > 0) next[key] = a;
    }
    if (sum(next) > p.stack) return { ok: false, reason: "no_money" };
    p.bets = { ...next };
    p.ready = false;
    return { ok: true };
  }

  setReady(id, ready, now) {
    const s = this.s;
    const p = this.player(id);
    if (p && !p.out && !p.left && s.phase === "briefing") {
      p.ready = !!ready;
      return { ok: true, events: this.briefingDone(now) };
    }
    if (!p || p.out || p.left || s.phase !== "betting") return { ok: false, reason: "closed" };
    p.ready = !!ready;
    // все живые и подключённые нажали «Готово» — не ждём таймер (§2)
    const waiting = this.alive().filter((x) => x.online && !x.ready && !x.frozen);
    if (!waiting.length && !s.paused) return { ok: true, events: this.close(now) };
    return { ok: true, events: [] };
  }

  playCard(id, card, targetId) {
    const s = this.s;
    const p = this.player(id);
    if (!s.settings.cards) return { ok: false, reason: "no_cards" };
    if (!p || p.out || p.left || s.phase !== "betting") return { ok: false, reason: "closed" };
    if (card === "shield") return { ok: false, reason: "passive" };
    if (!p.hand.includes(card)) return { ok: false, reason: "no_card" };
    if (s.played.some((x) => x.by === id)) return { ok: false, reason: "one_per_spin" };
    const t = this.player(targetId);
    if (!t || t.out || t.left || t.id === id) return { ok: false, reason: "bad_target" };
    p.hand.splice(p.hand.indexOf(card), 1);
    s.played.push({ by: id, card, target: targetId });
    return { ok: true, events: [{ type: "card_played", playerId: id }] };
  }

  // ---------- закрытие ставок ----------

  /*
   * «Ставок больше нет»: применяем карты, считаем штрафы, разыгрываем число, выбираем сюжет спина
   * и заранее считаем все выплаты. Стеки меняются только в settle() — в момент revealAt, когда шарик
   * на доске остановился: до этого ни один снимок не должен выдать результат.
   */
  close(now) {
    const s = this.s;
    if (s.phase !== "betting") return [];
    const alive = this.alive();
    const min = this.minBet();
    const reveals = [];
    const hit = new Set(); // цели, по которым уже сработала карта в этом спине
    const effects = []; // {card, by, target} — дошедшие до цели «Доля» и «Сглаз»

    // Карты открываются в порядке розыгрыша (§6)
    for (const pc of s.played) {
      const by = this.player(pc.by);
      const t = this.player(pc.target);
      const r = { by: pc.by, card: pc.card, target: pc.target, outcome: "ok" };
      if (!t || t.out || t.left) r.outcome = "gone";
      else if (hit.has(t.id)) {
        r.outcome = "busy"; // на цель уже сыграна карта — возвращаем владельцу
        if (by && !by.out && by.hand.length < HAND) by.hand.push(pc.card);
      } else if (t.hand.includes("shield")) {
        t.hand.splice(t.hand.indexOf("shield"), 1);
        hit.add(t.id);
        r.outcome = "shielded";
      } else {
        hit.add(t.id);
        if (pc.card === "double") {
          let free = t.stack - sum(t.bets);
          let added = 0;
          for (const key of Object.keys(t.bets)) {
            const a = Math.min(t.bets[key], free);
            if (a <= 0) break;
            t.bets[key] += a;
            free -= a;
            added += a;
          }
          r.added = added;
        } else if (pc.card === "freeze") {
          t.freezeNext = true;
        } else {
          effects.push({ card: pc.card, by: pc.by, target: t.id });
        }
      }
      reveals.push(r);
    }

    // Штраф за недобор минимума (§4). Минимум не больше стека, поэтому штраф всегда оплатим.
    const penalties = {};
    for (const p of alive) {
      const short = this.need(p) - sum(p.bets);
      if (short > 0) penalties[p.id] = short;
    }

    const number = this.rnd(37);
    const perPlayer = {};
    for (const p of alive) {
      const wager = sum(p.bets);
      let win = 0;
      let top = null; // самая дорогая выигравшая ставка — для статистики и сюжета «джекпот»
      for (const [key, a] of Object.entries(p.bets)) {
        const b = BETS[key];
        if (!b.numbers.includes(number)) continue;
        const w = a * (b.pays + 1);
        win += w;
        if (!top || w > top.win) top = { key, amount: a, win: w, pays: b.pays };
      }
      const penalty = penalties[p.id] || 0;
      perPlayer[p.id] = { before: p.stack, wager, win, penalty, net: win - wager - penalty, top, share: 0, eye: 0 };
    }
    // «Доля» и «Сглаз» считаются от чистого итога цели за спин (§6)
    const transfers = [];
    for (const e of effects) {
      const t = perPlayer[e.target];
      const o = perPlayer[e.by];
      if (!t) continue;
      if (e.card === "share" && t.net > 0) {
        const a = Math.floor(t.net * 0.25);
        if (a > 0) { t.share -= a; if (o) o.share += a; transfers.push({ card: "share", by: e.by, target: e.target, amount: a }); }
      } else if (e.card === "eye" && t.net < 0) {
        const a = Math.floor(-t.net * 0.5);
        if (a > 0) { if (o) o.eye += a; transfers.push({ card: "eye", by: e.by, target: e.target, amount: a }); }
      }
    }

    const story = this.direct(number, alive, perPlayer, min);
    const spinMs = story.duration;
    const closeMs = T.closeBase + T.closePerCard * reveals.length;
    const revealAt = now + closeMs + spinMs;
    s.result = {
      number,
      color: colorOf(number),
      seed: this.rnd(2 ** 31),
      story,
      reveals,
      penalties,
      transfers,
      perPlayer,
      closedAt: now,
      spinAt: now + closeMs,
      revealAt,
    };
    s.phase = "closing";
    s.deadline = now + closeMs;
    for (const p of alive) p.ready = false;
    return [{ type: "closed", reveals: reveals.length }];
  }

  /*
   * Режиссёр спина (§7.4). Сюжет меняет только путь шарика и эффекты, число уже выбрано.
   * path: normal | fake (ложная посадка в соседнюю ячейку) | jump (длинный скачок)
   * Флаги: allin — кто-то поставил весь стек; jackpot — 35:1 от 5 минимумов; save — выигрыш на последних фишках.
   * «Ложная посадка» зависит не от того, выиграл ли тяжёлый номер, а от того, что он рядом с выпавшим
   * на колесе — включая сам выпавший: иначе сюжет выдавал бы исход заранее.
   */
  direct(number, alive, perPlayer, min) {
    const s = this.s;
    const idx = WHEEL.indexOf(number);
    const near = new Map(); // номер → насколько тяжело на нём стоят
    for (const p of alive) {
      for (const [key, a] of Object.entries(p.bets)) {
        const b = BETS[key];
        if (b.numbers.length > 4) continue;
        for (const n of b.numbers) near.set(n, (near.get(n) || 0) + a / b.numbers.length);
      }
    }
    const heavy = (n) => (near.get(n) || 0) >= min; // на номере стоит хотя бы минимум (ставка делится по покрытым номерам)
    const allin = alive.filter((p) => perPlayer[p.id].wager > 0 && perPlayer[p.id].wager >= p.stack && p.stack > min).map((p) => p.id);
    const jackpot = alive.some((p) => { const t = perPlayer[p.id].top; return t && t.pays === 35 && t.amount >= 5 * min; });
    const save = alive.filter((p) => p.stack <= 2 * min && perPlayer[p.id].net > 0).map((p) => p.id);

    const specialOk = !s.specialsAt.some((sp) => s.spin - sp < 3);
    let path = "normal";
    let fakeFrom = null;
    if (specialOk) {
      const cand = [];
      for (const d of [-2, -1, 0, 1, 2]) {
        const n = WHEEL[(idx + d + 37) % 37];
        if (heavy(n)) cand.push(n);
      }
      if (cand.length) {
        path = "fake";
        const n = cand[this.rnd(cand.length)];
        // шарик сперва ложится в тяжёлую соседнюю ячейку и уходит из неё; если тяжёлая — сама выпавшая,
        // первой становится её соседка, и отчаяние сменяется радостью
        fakeFrom = n !== number ? n : WHEEL[(idx + (this.rnd(2) ? 1 : -1) + 37) % 37];
      } else if (this.rnd(100) < 30) {
        path = "jump";
      }
      if (path !== "normal") s.specialsAt.push(s.spin);
      s.specialsAt = s.specialsAt.slice(-4);
    }
    let duration = 9000 + this.rnd(2001);
    if (path === "fake") duration += 1600;
    if (path === "jump") duration += 900;
    if (allin.length) duration += 1800;
    duration = Math.max(T.spinMin, Math.min(T.spinMax, duration));
    return { path, fakeFrom, allin, jackpot, save, zero: number === 0, duration };
  }

  // ---------- выплаты ----------

  settle(now) {
    const s = this.s;
    const r = s.result;
    if (!r || s.phase !== "spinning") return [];
    s.history.unshift(r.number);
    s.history = s.history.slice(0, 20);
    const ev = [{ type: "reveal", number: r.number }];
    const minNow = this.minBet();
    for (const p of this.alive()) {
      const x = r.perPlayer[p.id];
      if (!x) continue;
      p.stack = Math.max(0, p.stack + x.net + x.share + x.eye);
      p.lastBets = { ...p.bets };
      s.casino.won += x.wager + x.penalty; // всё, что легло на стол и в штраф
      s.casino.paid += x.win + x.eye; // выигрыши вместе с возвратом ставки и «Сглаз»
      // статистика финала
      if (x.win - x.wager > 0 && (!s.stats.biggestWin || x.win - x.wager > s.stats.biggestWin.amount)) {
        s.stats.biggestWin = { playerId: p.id, amount: x.win - x.wager, number: r.number };
      }
      if (x.penalty && (!s.stats.biggestPenalty || x.penalty > s.stats.biggestPenalty.amount)) {
        s.stats.biggestPenalty = { playerId: p.id, amount: x.penalty };
      }
      if (p.stack > 0 && p.stack <= 2 * minNow) s.stats.lastBreath[p.id] = (s.stats.lastBreath[p.id] || 0) + 1;
    }
    // самая злая карта: сколько цель потеряла из-за неё
    for (const rv of r.reveals) {
      if (rv.outcome !== "ok") continue;
      let harm = 0;
      const t = r.perPlayer[rv.target];
      if (rv.card === "double" && t && t.net < 0) harm = Math.min(-t.net, rv.added || 0);
      if (rv.card === "share") harm = (r.transfers.find((x) => x.card === "share" && x.by === rv.by) || {}).amount || 0;
      if (harm && (!s.stats.cruelCard || harm > s.stats.cruelCard.amount)) s.stats.cruelCard = { by: rv.by, target: rv.target, card: rv.card, amount: harm };
    }
    const busted = this.alive().filter((p) => p.stack <= 0);
    for (const p of busted) {
      p.out = true;
      p.outSpin = s.spin;
      ev.push({ type: "out", playerId: p.id });
    }
    s.phase = "payout";
    s.deadline = now + (r.story.jackpot ? T.payoutJackpot : T.payout);
    const left = this.alive();
    if (left.length === 1) ev.push(...this.finish("last", now));
    else if (left.length === 0) ev.push(...this.finish("all_out", now, busted));
    return ev;
  }

  finish(reason, now, busted = []) {
    const s = this.s;
    if (s.phase === "finished") return [];
    const alive = this.alive();
    let winner = null;
    if (alive.length) {
      winner = alive.slice().sort((a, b) => b.stack - a.stack)[0];
    } else if (busted.length) {
      // все обнулились разом: выше тот, у кого было больше до спина, при равенстве — кто поставил больше (§4)
      const pp = (s.result && s.result.perPlayer) || {};
      winner = busted.slice().sort((a, b) => (pp[b.id]?.before || 0) - (pp[a.id]?.before || 0) || (pp[b.id]?.wager || 0) - (pp[a.id]?.wager || 0))[0];
    }
    s.winnerId = winner ? winner.id : null;
    s.finishedReason = reason;
    // места: победитель, затем живые по фишкам, затем выбывшие — кто позже вылетел, тот выше
    const order = s.players.filter((p) => !p.spectator).sort((a, b) => {
      if (a === winner) return -1;
      if (b === winner) return 1;
      if (!a.out && !b.out) return b.stack - a.stack;
      if (!a.out) return -1;
      if (!b.out) return 1;
      return (b.outSpin || 0) - (a.outSpin || 0);
    });
    order.forEach((p, i) => { p.place = i + 1; });
    // в финале после последнего спина доска ещё доигрывает выплаты — фазу меняем, когда они покажутся
    if (s.phase === "payout") s.finishAfterPayout = true;
    else { s.phase = "finished"; s.deadline = null; }
    return [{ type: "finished", winnerId: s.winnerId, reason }];
  }

  // ---------- таймер ----------

  tick(now) {
    const s = this.s;
    if (s.paused || !s.deadline || now < s.deadline) return [];
    if (s.phase === "betting") return this.close(now);
    if (s.phase === "closing") {
      s.phase = "spinning";
      s.deadline = s.result.revealAt;
      return [{ type: "spin" }];
    }
    if (s.phase === "spinning") return this.settle(now);
    if (s.phase === "payout") {
      if (s.finishAfterPayout) {
        s.finishAfterPayout = false;
        s.phase = "finished";
        s.deadline = null;
        return [{ type: "final" }];
      }
      return this.beginSpin(now);
    }
    return [];
  }

  // ---------- ведущий ----------

  pause(now) {
    const s = this.s;
    if (s.phase === "betting" && !s.paused) {
      s.paused = { remaining: Math.max(3000, (s.deadline || now) - now) };
      s.deadline = null;
    } else if (s.phase !== "lobby" && s.phase !== "finished") {
      s.pauseNext = true; // шарик уже летит — встанем на следующих ставках
    }
    return [{ type: "paused" }];
  }

  resume(now) {
    const s = this.s;
    s.pauseNext = false;
    if (!s.paused) return [];
    s.deadline = now + s.paused.remaining;
    s.paused = null;
    return [{ type: "resumed" }];
  }

  finishNow(now) {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished") return [];
    // посреди спина результат ещё не показан — ставки этого спина не играют
    if (s.phase === "betting" || s.phase === "closing" || s.phase === "spinning") {
      for (const p of s.players) { p.bets = {}; p.freezeNext = false; }
      s.result = null;
    }
    const ev = this.finish("host", now);
    if (s.finishAfterPayout) { s.finishAfterPayout = false; s.phase = "finished"; s.deadline = null; }
    return ev;
  }

  // новая партия в той же комнате: те же игроки, всё с нуля
  reset() {
    const s = this.s;
    const players = s.players.filter((p) => !p.left);
    const fresh = Game.create({ settings: s.settings, rnd: this.rnd }).s;
    fresh.chat = s.chat;
    fresh.chatSeq = s.chatSeq;
    fresh.players = players.map((p) => ({ ...p, spectator: false, stack: s.settings.stack, bets: {}, lastBets: {}, ready: false, hand: [], frozen: false, freezeNext: false, out: false, outSpin: null, place: null }));
    this.s = fresh;
    return [{ type: "new_game" }];
  }

  // ---------- чат и реакции ----------

  chat(id, text, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p) return { ok: false, reason: "no_player" };
    if (!s.settings.chat) return { ok: false, reason: "chat_off" };
    if (p.muted) return { ok: false, reason: "muted" };
    text = cleanText(text);
    if (!text) return { ok: false, reason: "empty" };
    if (p.lastChat != null && now - p.lastChat < CHAT_GAP) return { ok: false, reason: "too_fast" };
    p.lastChat = now;
    const m = { id: ++s.chatSeq, pid: id, text, at: now, hidden: false };
    s.chat.push(m);
    if (s.chat.length > CHAT_KEEP) s.chat = s.chat.slice(-CHAT_KEEP);
    return { ok: true, events: [{ type: "chat", message: m }] };
  }

  react(id, emoji, now) {
    const p = this.player(id);
    if (!p || !REACTIONS.includes(emoji)) return { ok: false, reason: "bad" };
    if (p.lastReact != null && now - p.lastReact < REACT_GAP) return { ok: false, reason: "too_fast" };
    p.lastReact = now;
    return { ok: true, events: [{ type: "react", playerId: id, emoji }] };
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
   * view: "board" — доска ведущего, иначе id игрока.
   * До revealAt число и сюжет видит только доска; телефоны узнают результат вместе с остановкой шарика.
   * Чужие карты — только количество; сыгранные карты до «ставок больше нет» — только факт розыгрыша.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const r = s.result;
    const revealed = r && (s.phase === "payout" || s.phase === "finished");
    const cardsOpen = r && s.phase !== "betting";
    let result = null;
    if (r) {
      result = {
        spinAt: r.spinAt,
        revealAt: r.revealAt,
        closedAt: r.closedAt,
        reveals: cardsOpen ? r.reveals : [],
        penalties: r.penalties,
      };
      if (board || revealed) Object.assign(result, { number: r.number, color: r.color, seed: r.seed, story: r.story });
      if (revealed) Object.assign(result, { perPlayer: r.perPlayer, transfers: r.transfers });
    }
    return {
      phase: s.phase,
      paused: !!s.paused,
      pauseNext: !!s.pauseNext,
      spin: s.spin,
      level: s.level,
      levels: TOP_LEVEL + 1,
      minBet: this.levelNeed(),
      overtime: this.overtime(),
      nextMinBet: this.minBet(this.levelFor(s.spin + 1)),
      nextOvertime: this.overtime(this.levelFor(s.spin + 1)),
      spinsToLevel: s.phase === "lobby" || s.phase === "briefing" ? null : PACE[s.settings.pace] - ((s.spin - 1) % PACE[s.settings.pace]) - 1,
      deadline: s.deadline,
      serverNow: now,
      settings: s.settings,
      history: s.history,
      played: s.played.map((x) => (cardsOpen ? x : { by: x.by })),
      result,
      winnerId: s.phase === "finished" ? s.winnerId : null,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      stats: s.phase === "finished" ? s.stats : null,
      casino: s.casino,
      chat: board ? s.chat.filter((m) => !m.hidden).slice(-12) : [],
      me: me ? { id: me.id, hand: me.hand, muted: me.muted, lastBets: me.lastBets } : null,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        // пока шарик летит, стеки показываем «до спина»: изменения придут вместе с остановкой
        stack: p.stack,
        bets: p.bets,
        betTotal: sum(p.bets),
        need: p.out || p.left ? 0 : this.need(p),
        ready: p.ready,
        cards: p.hand.length,
        played: s.played.some((x) => x.by === p.id),
        frozen: p.frozen,
        freezeNext: cardsOpen ? !!p.freezeNext : false,
        out: p.out,
        outSpin: p.outSpin,
        spectator: !!p.spectator,
        place: s.phase === "finished" ? p.place : null,
        online: p.online,
        left: p.left,
        muted: p.muted,
      })),
    };
  }
}

module.exports = { Game, BETS, WHEEL, RED, PAYOUT, LEVELS, OVERTIME, TOP_LEVEL, PACE, DEFAULTS, T, REACTIONS, COLORS, CARD_TYPES, MAX_PLAYERS, MIN_PLAYERS, colorOf, clampSettings, cleanName, cleanText };
