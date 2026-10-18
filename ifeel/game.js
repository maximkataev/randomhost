"use strict";

/*
 * Движок «Айфилю»: чистая логика без сети и таймеров (docs/ifeel-spec.md v1).
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1 — только в выборе категорий, наборов, пар, троек и рассадки;
 * счёт — чистая функция от порядка мишени и ответов (scoreQ).
 *
 * Партия: lobby → раунд 1 [pick → rank → ходы] → scores → раунд 2 [write → rank → ходы] → scores → finished.
 * Ход: tintro → ask (вопрос 1, 2, 3) → reveal. Мишень T, угадывающий G (в ходе бывает и двое, см. buildTurns), остальные смотрят доску.
 * Тайна (§5, §10): порядок мишени не уходит ни на один клиент до раскрытия хода — ни доске, ни G, ни самой мишени.
 */

const presence = require("../lib/presence");

// Сочинение и расстановка получают надбавку ROUND_EXTRA_SEC (0…60), по умолчанию +15 с, как в quip, fibs и wave (§8)
const EXTRA_MS = Math.round(Math.max(0, Math.min(60, Number(process.env.ROUND_EXTRA_SEC ?? 15) || 0)) * 1000);

const T = {
  pick: 15000,
  write: 75000 + EXTRA_MS,
  rank: 45000 + EXTRA_MS,
  tintro: 3000, // «Петя угадывает Машу»: G должен успеть понять, что сейчас его ход
  q: [10000, 12000, 20000],
  reveal: 8000,
  scores: 6000,
  pause: 60000, // «Ждём игроков»: меньше 3 на связи
};

const DEFAULTS = { mode: "safe", lang: "ru" };
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;
const NAME_MAX = 15;
const SET_SIZE = 5;
const CARD_MAX = 40;
const Q1_PTS = 300;
const Q2_PTS = [300, 100]; // по расстоянию от названного места до настоящего: точно 300, на одно место мимо 100, дальше 0 (решение владельца 18.10)
const Q3_PTS = [300, 200, 100, 0]; // по числу переставленных пар
const TURN_MAX = 900;
const LOUD_MIN = 300; // недобор (по отвеченным вопросам) должен быть строго больше — иначе это не «громкое раскрытие» (§7)
const LOUD_TOP = 3;

const COLORS = ["#e0115f", "#1438e0", "#0a8a4a", "#e25a00", "#7b1fd6", "#008b9a", "#b8006e", "#6b4a00", "#2c2cad", "#b31010", "#3d6b00", "#c77700"];
const AVATARS = ["🐙", "🦊", "🐸", "🦉", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐳", "🦩"];
const AVATAR_CHOICES = [...new Set(AVATARS.concat(["🐱", "🐶", "🐰", "🐻", "🐨", "🐯", "🐷", "🐮", "🦝", "🦥", "🦦", "🐲", "👽", "🤖", "👻", "🤡", "🥑", "🍕", "🌮", "🍩", "🧀", "🌵", "🍄", "🪩"]))];

function clampSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const s = { ...DEFAULTS };
  if (input.mode === "safe" || input.mode === "edgy") s.mode = input.mode;
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  return s;
}

// без управляющих и невидимых символов, без лишних пробелов (как в crowd)
const CTRL = /[\u0000-\u001f\u007f-\u009f­͏᠎​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const INVIS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const ZWJ_OK = /(\p{Extended_Pictographic}️?)‍(?=\p{Extended_Pictographic})/gu;
function cleanText(text, max) {
  const t = String(text == null ? "" : text).replace(CTRL, "").replace(ZWJ_OK, "$1\u0001").replace(INVIS, "").replace(/\u0001/g, "‍");
  return Array.from(t.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}
const SKEL = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ё: "e",
  і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w", һ: "h", ӏ: "l", ѵ: "v", ѡ: "w",
  α: "a", β: "b", ε: "e", η: "h", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "y", χ: "x", ς: "c", ω: "w", γ: "y", ϲ: "c" };
const SKEL_RE = new RegExp("[" + Object.keys(SKEL).join("") + "]", "g");
const nameKey = (n) => String(n || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(SKEL_RE, (ch) => SKEL[ch]).replace(/[il1|]/g, "l").replace(/0/g, "o").replace(/[\s‍]+/g, "");
const cleanName = (name) => cleanText(name, NAME_MAX);

// ключ карточки для «без повторов»: регистр, ё/е, диакритика, пунктуация и пробелы не различают карточки
const cardKey = (t) => String(t || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");

// карточки R2 не модерируем (§9), но ссылки и разметку не пропускаем — как ответы в quip
const LINK_RE = /(?:https?:|ftp:|\bwww\.|\bt\.me\/|[\p{L}\p{N}-]{2,}\.(?:ru|com|net|org|io|me|su|рф|gr|info|xyz|online|site|link|ly|gg|tv|cc|app|dev|top|club|pro|biz|ua|by|kz|de|uk|co)(?:\/|\b))/iu;
const HTML_RE = /[<>]|&#?\w+;/;
function cardProblem(t) {
  if (!t) return "empty";
  if (LINK_RE.test(t)) return "link";
  if (HTML_RE.test(t)) return "html";
  return null;
}

// ---------- счёт: чистые функции ----------

// позиция пункта в порядке мишени (0 — первое место)
const posOf = (order, x) => order.indexOf(x);
// число переставленных пар (расстояние Кендалла) ответа ans относительно порядка order
function kendall(order, ans) {
  let n = 0;
  for (let i = 0; i < ans.length; i++) for (let j = i + 1; j < ans.length; j++) if (posOf(order, ans[i]) > posOf(order, ans[j])) n++;
  return n;
}
// место, о котором спрашивает вопрос 2 (1..5). "first"/"last" — вопросы до 18.10 (могли остаться в дампе комнаты)
const askedPlace = (q, n = SET_SIZE) => (q.kind === "place" ? q.n : q.kind === "first" ? 1 : n);
const isPlaceQ = (q) => q.kind === "place" || q.kind === "first" || q.kind === "last";
/*
 * Очки за один вопрос (§5). q: {kind:"pair", a, b} (соседние места мишени) | {kind:"place", n} | {kind:"triple", items:[x,y,z]}.
 * v — ответ (пункт или тройка в порядке игрока), null — не ответил (0).
 */
function scoreQ(order, q, v) {
  if (v == null || !validAnswer(q, v)) return 0;
  if (q.kind === "pair") {
    const other = v === q.a ? q.b : q.a;
    return posOf(order, v) < posOf(order, other) ? Q1_PTS : 0;
  }
  if (isPlaceQ(q)) return Q2_PTS[Math.abs(posOf(order, v) + 1 - askedPlace(q, order.length))] || 0;
  if (q.kind === "triple") return Q3_PTS[kendall(order, v)] ?? 0;
  return 0;
}
function validAnswer(q, v) {
  if (q.kind === "pair") return v === q.a || v === q.b;
  if (isPlaceQ(q)) return Number.isInteger(v) && v >= 0 && v < SET_SIZE;
  if (q.kind === "triple") {
    return Array.isArray(v) && v.length === 3 && new Set(v).size === 3 && v.every((x) => q.items.includes(x));
  }
  return false;
}
const scoreTurn = (order, qs, answers) => qs.map((q, i) => scoreQ(order, q, answers ? answers[i] : null));
// недобор хода — только по отвеченным вопросам (§7): не ответил до таймера — это молчание, а не промах
const missOf = (answers, pts) => answers.reduce((a, v, i) => a + (v == null ? 0 : Q1_PTS - (pts[i] || 0)), 0);
/*
 * Самый яркий промах хода (для карточки ленты §7): вопрос с наибольшей потерей очков; при равенстве — тот, что проще
 * рассказать одной фразой: «место» с разлётом ≥ 2 («думал 1-е, а у неё 5-е»), потом неверная пара, потом тройка.
 * mag — разлёт (place: на сколько мест мимо; pair: 1; triple: сколько пар переставлено). null — промахов нет.
 */
function worstQ(order, qs, answers, pts) {
  let best = null;
  qs.forEach((q, i) => {
    const v = answers[i];
    if (v == null || (pts[i] || 0) >= Q1_PTS) return;
    const lost = Q1_PTS - (pts[i] || 0);
    const mag = q.kind === "pair" ? 1 : isPlaceQ(q) ? Math.abs(posOf(order, v) + 1 - askedPlace(q, order.length)) : kendall(order, v);
    const w = lost * 10 + (isPlaceQ(q) ? mag * 2 + 0.5 : q.kind === "pair" ? 2 : 1);
    if (!best || w > best.w) best = { qi: i, lost, mag, w };
  });
  return best ? { qi: best.qi, lost: best.lost, mag: best.mag } : null;
}

function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

class Game {
  constructor(state, rnd, content) {
    this.s = state;
    this.rnd = rnd;
    this.content = content || {};
  }

  static create({ settings, code = "", rnd, content } = {}) {
    return new Game({
      code,
      settings: clampSettings(settings),
      phase: "lobby", // lobby | pick | write | rank | tintro | ask | reveal | scores | pause | finished
      players: [],
      game: 0,
      seats: [], // рассадка по кругу (§2); на старте раунда 2 достраивается опоздавшими
      round: null, // текущий раунд (см. startRound)
      turn: null, // текущий ход (см. startTurn)
      r1g: {}, // кто угадывал мишень в раунде 1: во втором угадывает другой
      party: { cats: [], prompts: [], scales: [], dealt: [] }, // что уже было в партии: категории, подсказки, шкалы, ключи карточек
      used: {}, // «lang:mode» → id категорий, уже предложенных в этой комнате: не повторяем, пока банк не пройден
      log: [], // раскрытые ходы партии (по записи на угадывающего) — для ленты громких раскрытий
      loud: null,
      aborted: false, // партию прервали возвратом в лобби: следующий старт — «перезапуск»
      restarted: false,
      phaseStart: null,
      phaseEnd: null,
      next: null, // что запускать после паузы
      pauseReason: null,
      finishedReason: null,
    }, rnd, content);
  }

  static from(state, rnd, content) {
    return new Game(state, rnd, content);
  }

  // ---------- участники ----------

  player(id) { return this.s.players.find((p) => p.id === id); }
  present() { return this.s.players.filter((p) => !p.left); }
  online(id) { const p = this.player(id); return !!p && !p.left && p.online !== false; }
  onlineCount() { return this.present().filter((p) => p.online !== false).length; }

  findLeft(name) {
    const key = nameKey(cleanName(name));
    if (!key) return null;
    return this.s.players.find((p) => p.left && nameKey(p.name) === key) || null;
  }

  // записи ушедших без очков и без места в раунде не нужны никому
  compactPlayers() {
    const s = this.s;
    const inRound = new Set(s.round ? s.round.cast : []);
    s.players = s.players.filter((p) => !p.left || p.score !== 0 || inRound.has(p.id) || s.seats.includes(p.id));
    while (s.players.length >= MAX_PLAYERS * 3) {
      const i = s.players.findIndex((p) => p.left);
      if (i < 0) break;
      s.players.splice(i, 1);
    }
  }

  evictGhost(now) {
    const s = this.s;
    if (now == null || (s.phase !== "lobby" && s.phase !== "finished")) return false;
    presence.ensureOffSince(this.present(), now);
    const id = presence.evictOldestGhost(this.present(), { now, stage: s.phase });
    if (!id) return false;
    s.players = s.players.filter((x) => x.id !== id);
    return true;
  }

  addPlayer({ id, name, now = null }) {
    const s = this.s;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    if (this.present().length >= MAX_PLAYERS) {
      if (!this.evictGhost(now)) return { ok: false, reason: "room_full" };
    }
    name = cleanName(name);
    if (!name) return { ok: false, reason: "bad_name" };
    const inGame = s.phase !== "lobby" && s.phase !== "finished";
    const used = new Set(this.present().map((p) => p.color));
    const back = inGame ? this.findLeft(name) : null;
    if (back) {
      back.left = false;
      back.online = true;
      if (used.has(back.color)) back.color = COLORS.find((c) => !used.has(c)) || back.color;
      return { ok: true, player: back, restored: true };
    }
    this.compactPlayers();
    const usedAv = new Set(this.present().map((p) => p.avatar));
    const p = {
      id,
      name,
      color: COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length],
      avatar: AVATARS.find((a) => !usedAv.has(a)) || AVATARS[s.players.length % AVATARS.length],
      online: true,
      left: false,
      score: 0,
      joinedAt: now,
    };
    s.players.push(p);
    return { ok: true, player: p };
  }

  removePlayer(id, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p) return [];
    if (s.phase === "lobby" || s.phase === "finished") {
      s.players = s.players.filter((x) => x !== p);
      return [{ type: "left", playerId: id }];
    }
    if (p.left) return [];
    p.left = true;
    const ev = [{ type: "left", playerId: id }];
    if (this.present().length < MIN_PLAYERS) return ev.concat(this.finish("few", now));
    return ev.concat(this.maybeAdvance(now));
  }

  setOnline(id, online, now) {
    const p = this.player(id);
    if (p) presence.setOnline(p, online, now);
    return this.maybeAdvance(now);
  }

  setAvatar(id, avatar) {
    const s = this.s;
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "game_started" };
    if (!AVATAR_CHOICES.includes(avatar)) return { ok: false, reason: "bad_avatar" };
    if (this.present().some((x) => x !== p && x.avatar === avatar)) return { ok: false, reason: "avatar_taken" };
    if (p.avatar === avatar) return { ok: true, events: [], noop: true };
    p.avatar = avatar;
    return { ok: true, events: [{ type: "avatar", playerId: id }] };
  }

  // ---------- банк ----------

  // язык банка, который реально играет комната: нет файла языка — русский (content.js)
  contentLang() {
    const lang = this.s.settings.lang;
    const av = this.content.available;
    return Array.isArray(av) && !av.includes(lang) ? "ru" : lang;
  }
  bank() { return this.content[this.s.settings.lang] || this.content.ru || null; }
  cats() { const b = this.bank(); return b ? b.categories.filter((c) => c.mode === this.s.settings.mode) : []; }
  prompts() { const b = this.bank(); return b ? b.prompts.filter((p) => p.mode === this.s.settings.mode) : []; }
  scales() { const b = this.bank(); return b ? b.random.scales.filter((x) => x.mode === this.s.settings.mode) : []; }
  pool() { const b = this.bank(); return b ? b.random.pool : []; }
  pick(list) { return list.length ? list[this.rnd(list.length)] : null; }

  /*
   * Тройки категорий на раунд 1 (§3). Порядок требований (слабеет, только если банк кончился):
   * не повторять в партии; не предлагать категорию, в которой ≥ 2 пункта уже встречались в предложенных
   * (звёзды повторяются между категориями — иначе двоим достанутся одни и те же лица); ещё не игранные в комнате.
   * Тройка (решение владельца 18.10): ровно один «🎲 Случайный набор» + ≥ 1 категория о предпочтениях (pref) + любая третья.
   * У «🎲» своя шкала из режима комнаты, без повторов в партии. Нет шкал или пула — тройка из трёх категорий, как раньше.
   */
  buildOffers(cast) {
    const s = this.s;
    const cats = this.cats();
    const ukey = this.contentLang() + ":" + s.settings.mode;
    let roomUsed = new Set(s.used[ukey] || []);
    if (cats.filter((c) => !roomUsed.has(c.id)).length < cast.length * 3) { roomUsed = new Set(); s.used[ukey] = []; }
    const party = new Set(s.party.cats);
    const seen = new Set();
    const nSeen = (c) => c.items.reduce((n, x) => n + (seen.has(cardKey(x.t)) ? 1 : 0), 0);
    const tiers = [
      (c) => !party.has(c.id) && nSeen(c) < 2 && !roomUsed.has(c.id),
      (c) => !party.has(c.id) && nSeen(c) < 2,
      (c) => !party.has(c.id),
      () => true,
    ];
    const take = (want, ex) => {
      for (const tier of tiers) {
        const list = cats.filter((c) => !ex.has(c.id) && want(c) && tier(c));
        if (list.length) return this.pick(list);
      }
      return null;
    };
    const scales = this.scales();
    const withRnd = scales.length > 0 && this.pool().length >= SET_SIZE;
    const out = {};
    cast.forEach((pid, i) => {
      const ex = new Set();
      const triple = [];
      const pref = take((c) => c.pref, ex);
      if (pref) { triple.push(pref); ex.add(pref.id); }
      // категорий о предпочтениях мало (по одной на тройку): в добор берём их, только если хватит остальным тройкам
      const prefLeft = () => cats.filter((c) => c.pref && !party.has(c.id) && !ex.has(c.id)).length;
      while (triple.length < (withRnd ? 2 : 3)) {
        const spare = prefLeft() > cast.length - i - 1;
        const c = take((x) => spare || !x.pref, ex) || take(() => true, ex);
        if (!c) break;
        triple.push(c);
        ex.add(c.id);
      }
      for (const c of triple) {
        party.add(c.id);
        s.party.cats.push(c.id);
        (s.used[ukey] = s.used[ukey] || []).push(c.id);
        for (const x of c.items) seen.add(cardKey(x.t));
      }
      const offers = triple.map((c) => ({ kind: "cat", id: c.id, title: c.title, top: c.top, bottom: c.bottom, pref: c.pref || undefined }));
      if (withRnd) {
        const fresh = scales.filter((x) => !s.party.scales.includes(x.id));
        const sc = this.pick(fresh.length ? fresh : scales);
        s.party.scales.push(sc.id);
        offers.push({ kind: "rnd", id: "rnd:" + sc.id, title: sc.title, top: sc.top, bottom: sc.bottom });
      }
      out[pid] = shuffled(offers, this.rnd);
    });
    return out;
  }

  // 5 карточек из списка: сначала те, что ещё не раздавались в партии
  dealItems(items) {
    const s = this.s;
    const dealt = new Set(s.party.dealt);
    const fresh = shuffled(items.filter((x) => !dealt.has(cardKey(x.t))), this.rnd);
    const rest = shuffled(items.filter((x) => dealt.has(cardKey(x.t))), this.rnd);
    const keys = new Set();
    const out = [];
    for (const x of fresh.concat(rest)) {
      const k = cardKey(x.t);
      if (keys.has(k)) continue;
      keys.add(k);
      out.push(x.e ? { t: x.t, e: x.e } : { t: x.t });
      if (out.length === SET_SIZE) break;
    }
    for (const x of out) s.party.dealt.push(cardKey(x.t));
    return out;
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    const ps = this.present();
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    if (!this.bank() || this.cats().length < 3 || !this.prompts().length) return { ok: false, reason: "no_content" };
    s.game++;
    s.players = ps;
    for (const p of ps) { p.score = 0; p.joinedAt = null; }
    s.seats = shuffled(ps.map((p) => p.id), this.rnd);
    s.party = { cats: [], prompts: [], scales: [], dealt: [] };
    s.r1g = {};
    s.log = [];
    s.loud = null;
    // ведущий вернул недоигранную партию в лобби и начал заново — телефоны покажут «партия перезапущена» с режимом (§9)
    s.restarted = !!s.aborted;
    s.aborted = false;
    s.round = null;
    s.turn = null;
    s.next = null;
    s.pauseReason = null;
    s.finishedReason = null;
    return { ok: true, events: [{ type: "started", game: s.game }, ...this.startRound(1, now)] };
  }

  /*
   * Раунд n. Круг — рассадка без ушедших; на старте раунда 2 новички встают в конец круга (§6).
   * Пары (§2): R1 — T угадывает T−1; R2 — пишет T−1, угадывает T−2. Если круг изменился (новички, ушедшие),
   * угадывающий R2 может совпасть с угадывающим R1 — тогда угадывающие меняются местами (repairR2).
   */
  startRound(n, now) {
    const s = this.s;
    if (this.onlineCount() < MIN_PLAYERS) return this.pause({ to: "round", n }, now);
    const present = new Set(this.present().map((p) => p.id));
    s.seats = s.seats.filter((id) => present.has(id));
    if (n === 2) for (const p of this.present()) if (!s.seats.includes(p.id)) s.seats.push(p.id);
    const cast = s.seats.slice();
    if (cast.length < MIN_PLAYERS) return this.finish("few", now);
    const N = cast.length;
    const at = (i) => cast[((i % N) + N) % N];
    const guess = {}, author = {};
    cast.forEach((t, i) => {
      if (n === 1) guess[t] = at(i - 1);
      else { author[t] = at(i - 1); guess[t] = at(i - 2); }
    });
    s.round = { n, cast, guess, author, offers: {}, choice: {}, writes: {}, sets: {}, orders: {}, veto: {}, turns: [], ti: -1 };
    s.turn = null;
    if (n === 1) {
      s.r1g = { ...guess };
      s.round.offers = this.buildOffers(cast);
      return this.enter("pick", T.pick, now, [{ type: "round", n }]);
    }
    this.assignR2();
    const prompts = this.prompts();
    for (const t of cast) {
      const fresh = prompts.filter((p) => !s.party.prompts.includes(p.id));
      const p = this.pick(fresh.length ? fresh : prompts);
      s.party.prompts.push(p.id);
      const name = (this.player(t) || {}).name || "?";
      s.round.writes[author[t]] = { target: t, prompt: { id: p.id, text: p.prompt.split("{name}").join(name), top: p.top, bottom: p.bottom, examples: p.examples.slice() }, cards: null };
    }
    return this.enter("write", T.write, now, [{ type: "round", n }]);
  }

  // угадывающий не мишень, не автор и (в R2) не тот, кто угадывал её в R1
  validPair(t, g) {
    const r = this.s.round;
    return g !== t && g !== r.author[t] && (r.n !== 2 || g !== this.s.r1g[t]);
  }

  /*
   * Угадывающие R2: по умолчанию T−2; если круг изменился и пара нечестна (тот же, кто угадывал в R1), ищем перебором
   * ближайшее честное назначение — каждый угадывает ровно раз. Перебор с возвратом, первым пробуется T−2, потом по кругу:
   * при N ≤ 12 это мгновенно. Честного назначения нет (бывает только при совсем малом и перекроенном круге) — остаётся T−2.
   */
  assignR2() {
    const r = this.s.round;
    const cast = r.cast;
    const N = cast.length;
    const used = new Set();
    const out = {};
    const go = (i) => {
      if (i === N) return true;
      const t = cast[i];
      const pref = r.guess[t];
      const order = [pref].concat(Array.from({ length: N }, (_, k) => cast[(i + N - 2 - k + N * 2) % N]).filter((x) => x !== pref));
      for (const g of order) {
        if (used.has(g) || !this.validPair(t, g)) continue;
        used.add(g); out[t] = g;
        if (go(i + 1)) return true;
        used.delete(g); delete out[t];
      }
      return false;
    };
    if (go(0)) r.guess = out;
  }

  enter(phase, ms, now, events = []) {
    const s = this.s;
    s.phase = phase;
    s.phaseStart = now;
    s.phaseEnd = ms == null ? null : now + ms;
    return events.concat([{ type: "phase", phase }]);
  }

  // ---------- раунд 1: выбор категории ----------

  choose(id, idx, now) {
    const s = this.s;
    if (s.phase !== "pick") return { ok: false, reason: "not_pick" };
    const r = s.round;
    if (!r.offers[id]) return { ok: false, reason: "not_in_round" };
    if (!Number.isInteger(idx) || idx < 0 || idx >= r.offers[id].length) return { ok: false, reason: "bad_pick" };
    if (r.choice[id] === idx) return { ok: true, events: [], noop: true };
    r.choice[id] = idx;
    return { ok: true, events: [{ type: "picked", playerId: id }, ...this.maybeAdvance(now)] };
  }

  closePick(now) {
    const s = this.s;
    const r = s.round;
    const byId = new Map(this.cats().map((c) => [c.id, c]));
    const scales = new Map(this.scales().map((x) => [x.id, x]));
    for (const t of r.cast) {
      // не выбрал — берётся первая (§3)
      const o = r.offers[t][r.choice[t] ?? 0] || r.offers[t][0];
      if (!o) continue;
      let set;
      if (o.kind === "rnd") {
        const sc = scales.get(o.id.slice(4)) || o;
        set = { kind: "rnd", title: sc.title, top: sc.top, bottom: sc.bottom, items: this.dealItems(this.pool()) };
      } else {
        const c = byId.get(o.id);
        if (!c) continue;
        set = { kind: "cat", id: c.id, title: c.title, top: c.top, bottom: c.bottom, items: this.dealItems(c.items) };
      }
      r.sets[t] = set;
    }
    return this.enter("rank", T.rank, now);
  }

  // ---------- раунд 2: карточки пишут игроки ----------

  writeCards(id, cards, now) {
    const s = this.s;
    if (s.phase !== "write") return { ok: false, reason: "not_write" };
    const w = s.round.writes[id];
    if (!w) return { ok: false, reason: "not_author" };
    if (!Array.isArray(cards) || cards.length > SET_SIZE) return { ok: false, reason: "bad_cards" };
    const list = [];
    const keys = new Set();
    for (let i = 0; i < cards.length; i++) {
      const raw = typeof cards[i] === "string" ? cards[i] : "";
      if (Array.from(raw.trim()).length > CARD_MAX) return { ok: false, reason: "too_long", idx: i };
      const t = cleanText(raw, CARD_MAX);
      if (!t) continue; // пустое поле добьётся примером из пула (§4)
      const bad = cardProblem(t);
      if (bad) return { ok: false, reason: "bad_card", idx: i };
      const k = cardKey(t);
      if (!k) return { ok: false, reason: "bad_card", idx: i };
      if (keys.has(k)) return { ok: false, reason: "dup", idx: i };
      keys.add(k);
      list.push(t);
    }
    if (!list.length) return { ok: false, reason: "empty" };
    if (w.cards) {
      if (w.cards.length === list.length && w.cards.every((x, i) => x === list[i])) return { ok: true, events: [], noop: true };
      return { ok: false, reason: "sent" };
    }
    w.cards = list;
    return { ok: true, events: [{ type: "wrote", playerId: id }, ...this.maybeAdvance(now)] };
  }

  // недописанное — примерами из пула подсказки, а их не хватит — вещами из общего пула «🎲»
  fillCards(have, examples) {
    const keys = new Set(have.map(cardKey));
    const out = have.map((t) => ({ t }));
    const add = (t) => { const k = cardKey(t); if (!k || keys.has(k) || out.length >= SET_SIZE) return; keys.add(k); out.push({ t }); };
    for (const t of shuffled(examples, this.rnd)) add(t);
    for (const x of shuffled(this.pool(), this.rnd)) add(x.t);
    return out;
  }

  closeWrite(now) {
    const s = this.s;
    const r = s.round;
    for (const [aid, w] of Object.entries(r.writes)) {
      const items = shuffled(this.fillCards(w.cards || [], w.prompt.examples), this.rnd);
      r.sets[w.target] = { kind: "r2", author: aid, title: w.prompt.text, top: w.prompt.top, bottom: w.prompt.bottom, items, examples: w.prompt.examples, filled: (w.cards || []).length < SET_SIZE ? SET_SIZE - (w.cards || []).length : 0 };
    }
    return this.enter("rank", T.rank, now);
  }

  /*
   * Вето мишени в R2 (§4): одну карточку — на случайную, один раз, до «Готово». Замена (решение владельца 18.10):
   * пример из пула той же подсказки, которого среди карточек набора нет (сравнение по cardKey, не по точному тексту);
   * пул исчерпан — пример любой подсказки того же режима; нет и их — вещь из общего пула «🎲».
   */
  veto(id, idx, aid, now) {
    const s = this.s;
    if (s.phase !== "rank") return { ok: false, reason: "not_rank" };
    const r = s.round;
    if (r.n !== 2) return { ok: false, reason: "no_veto" };
    const set = r.sets[id];
    if (!set) return { ok: false, reason: "not_in_round" };
    if (r.orders[id]) return { ok: false, reason: "ranked" };
    const v = r.veto[id];
    if (v) return v.idx === idx && aid != null && v.aid === aid ? { ok: true, events: [], noop: true } : { ok: false, reason: "veto_used" };
    if (!Number.isInteger(idx) || idx < 0 || idx >= set.items.length) return { ok: false, reason: "bad_card" };
    const keys = new Set(set.items.map((x) => cardKey(x.t)));
    const free = (list) => {
      const seen = new Set();
      return list.filter((x) => { const k = cardKey(x.t); if (!k || keys.has(k) || seen.has(k)) return false; seen.add(k); return true; });
    };
    const own = free((set.examples || []).map((t) => ({ t })));
    const mode = own.length ? [] : free([].concat(...this.prompts().map((p) => p.examples)).map((t) => ({ t })));
    const pickFrom = own.length ? own : mode.length ? mode : free(this.pool());
    if (!pickFrom.length) return { ok: false, reason: "no_spare" };
    const x = pickFrom[this.rnd(pickFrom.length)];
    set.items[idx] = x.e ? { t: x.t, e: x.e } : { t: x.t };
    r.veto[id] = { idx, aid: aid == null ? null : aid };
    return { ok: true, events: [{ type: "veto", playerId: id }] };
  }

  // ---------- расстановка ----------

  rank(id, order, now) {
    const s = this.s;
    if (s.phase !== "rank") return { ok: false, reason: "not_rank" };
    const r = s.round;
    const set = r.sets[id];
    if (!set) return { ok: false, reason: "not_in_round" };
    const n = set.items.length;
    if (!Array.isArray(order) || order.length !== n || !order.every((x) => Number.isInteger(x) && x >= 0 && x < n) || new Set(order).size !== n) {
      return { ok: false, reason: "bad_order" };
    }
    const had = r.orders[id];
    if (had) return had.every((x, i) => x === order[i]) ? { ok: true, events: [], noop: true } : { ok: false, reason: "ranked" };
    r.orders[id] = order.slice();
    return { ok: true, events: [{ type: "ranked", playerId: id }, ...this.maybeAdvance(now)] };
  }

  closeRank(now) {
    this.buildTurns();
    return this.nextTurn(now);
  }

  /*
   * Ходы раунда — по кругу мишеней (§2). Мишень без расстановки пропускается (§6), а её угадывающий берёт следующую
   * расставленную мишень по кругу. У той «два хода» играются одним ходом с двумя угадывающими: отдельный второй ход
   * после раскрытия был бы угадыванием уже показанного порядка. Каждому угадывающему — свои очки, максимум 900.
   */
  buildTurns() {
    const r = this.s.round;
    const N = r.cast.length;
    const at = (i) => r.cast[((i % N) + N) % N];
    const ranked = (t) => !!r.orders[t] && !!r.sets[t];
    const turns = r.cast.filter(ranked).map((t) => ({ target: t, guessers: [r.guess[t]], author: r.author[t] || null }));
    r.cast.forEach((t, i) => {
      if (ranked(t)) return;
      const g = r.guess[t];
      for (let k = 1; k < N; k++) {
        const t2 = at(i + k);
        const turn = turns.find((x) => x.target === t2);
        if (!turn || t2 === g || turn.author === g || turn.guessers.includes(g)) continue;
        turn.guessers.push(g);
        break;
      }
    });
    r.turns = turns;
    r.ti = -1;
  }

  nextTurn(now) {
    const s = this.s;
    const r = s.round;
    if (r.ti + 1 >= r.turns.length) {
      s.turn = null;
      return this.enter("scores", T.scores, now, [{ type: "scores", n: r.n }]);
    }
    if (this.onlineCount() < MIN_PLAYERS) return this.pause({ to: "turn" }, now);
    r.ti++;
    return this.startTurn(now);
  }

  /*
   * Начало хода. Угадывающий без связи — ход переходит к следующему подключённому игроку по кругу
   * (не мишени и не автору, §6). Вопросы хода тянутся сразу, но клиенты видят только уже заданные.
   */
  startTurn(now) {
    const s = this.s;
    const r = s.round;
    const base = r.turns[r.ti];
    const N = r.cast.length;
    const at = (i) => r.cast[((i % N) + N) % N];
    const guessers = [];
    const swapped = [];
    for (const g of base.guessers) {
      if (this.online(g) && !guessers.includes(g)) { guessers.push(g); continue; }
      const from = Math.max(0, r.cast.indexOf(g));
      let rep = null;
      for (let k = 1; k < N; k++) {
        const c = at(from + k);
        if (c === base.target || c === base.author || guessers.includes(c) || base.guessers.includes(c) || !this.online(c)) continue;
        rep = c;
        break;
      }
      if (rep) { guessers.push(rep); swapped.push({ from: g, to: rep }); }
    }
    // вопросы (§5, решение владельца 18.10): пара соседних мест мишени (1–2, 2–3, 3–4 или 4–5 поровну) в случайном порядке;
    // «что на N-м месте» для N из 1..5; тройка, в которой нет обоих пунктов пары. Места пары в вопрос не попадают: только сами карточки
    const order = r.orders[base.target];
    const at0 = this.rnd(SET_SIZE - 1);
    const pair = shuffled([order[at0], order[at0 + 1]], this.rnd);
    const place = 1 + this.rnd(SET_SIZE);
    const triples = [];
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) for (let c = b + 1; c < 5; c++) {
      const t = [a, b, c];
      if (!(t.includes(pair[0]) && t.includes(pair[1]))) triples.push(t);
    }
    const triple = shuffled(triples[this.rnd(triples.length)], this.rnd);
    s.turn = {
      target: base.target,
      author: base.author,
      guessers,
      swapped,
      qs: [{ kind: "pair", a: pair[0], b: pair[1] }, { kind: "place", n: place }, { kind: "triple", items: triple }],
      qi: -1,
      answers: Object.fromEntries(guessers.map((g) => [g, [null, null, null]])),
      qStart: [],
      result: null,
    };
    return this.enter("tintro", T.tintro, now, [{ type: "turn", target: base.target, guessers }]);
  }

  // зрители хода: все присутствующие, кроме мишени и угадывающих. Они только смотрят доску (решение владельца 18.10: зала нет)
  watcherIds() {
    const t = this.s.turn;
    if (!t) return [];
    return this.present().filter((p) => p.id !== t.target && !t.guessers.includes(p.id)).map((p) => p.id);
  }

  ask(qi, now) {
    const t = this.s.turn;
    t.qi = qi;
    t.qStart[qi] = now;
    const ev = this.enter("ask", T.q[qi], now, [{ type: "ask", qi }]);
    // угадывающие пропали — их вопросы закрываются сразу (0 очков), ход идёт к раскрытию без ожидания
    return this.askDone() ? ev.concat(this.closeAsk(now)) : ev;
  }

  answer(id, qi, v, now) {
    const s = this.s;
    if (s.phase !== "ask") return { ok: false, reason: "not_ask" };
    const t = s.turn;
    if (qi !== t.qi) return { ok: false, reason: "q_closed" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (id === t.target) return { ok: false, reason: "target" };
    if (!t.guessers.includes(id)) return { ok: false, reason: "not_guesser" };
    const q = t.qs[qi];
    if (!validAnswer(q, v)) return { ok: false, reason: "bad_answer" };
    const box = t.answers[id];
    const had = box[qi];
    if (had != null) return JSON.stringify(had) === JSON.stringify(v) ? { ok: true, events: [], noop: true } : { ok: false, reason: "answered" };
    box[qi] = Array.isArray(v) ? v.slice() : v;
    return { ok: true, events: [{ type: "answer", playerId: id, qi }, ...this.maybeAdvance(now)] };
  }

  // вопрос закрывается, когда ответили (или пропали) все угадывающие; угадывающих нет вовсе — сразу
  askDone() {
    const t = this.s.turn;
    return t.guessers.every((g) => t.answers[g][t.qi] != null || !this.online(g));
  }

  closeAsk(now) {
    const t = this.s.turn;
    if (t.qi < 2) return this.ask(t.qi + 1, now);
    return this.startReveal(now);
  }

  // раскрытие хода: здесь начисляются очки, и только отсюда порядок мишени попадает в снимки
  startReveal(now) {
    const s = this.s;
    const r = s.round;
    const t = s.turn;
    const order = r.orders[t.target];
    const pts = {};
    for (const g of t.guessers) {
      pts[g] = scoreTurn(order, t.qs, t.answers[g]);
      const p = this.player(g);
      if (p) p.score += pts[g].reduce((a, b) => a + b, 0);
    }
    t.result = { order: order.slice(), pts };
    const set = r.sets[t.target];
    for (const g of t.guessers) {
      const answers = t.answers[g].slice();
      s.log.push({
        round: r.n, target: t.target, guesser: g, title: set.title, items: set.items, order: order.slice(), qs: t.qs,
        answers, pts: pts[g], miss: missOf(answers, pts[g]), worst: worstQ(order, t.qs, answers, pts[g]),
      });
    }
    return this.enter("reveal", T.reveal, now, [{ type: "reveal", target: t.target }]);
  }

  // ---------- переходы ----------

  readyToClose() {
    const s = this.s;
    const r = s.round;
    if (this.onlineCount() < MIN_PLAYERS) return false; // иначе «все готовы» было бы истинно и при нуле игроков
    const live = r.cast.filter((id) => this.online(id));
    if (s.phase === "pick") return live.every((id) => r.choice[id] != null);
    if (s.phase === "write") return Object.keys(r.writes).filter((id) => this.online(id)).every((id) => r.writes[id].cards);
    if (s.phase === "rank") return live.filter((id) => r.sets[id]).every((id) => r.orders[id]);
    return false;
  }

  maybeAdvance(now) {
    const s = this.s;
    if (s.phase === "pause") return this.onlineCount() >= MIN_PLAYERS ? this.resume(now) : [];
    if ((s.phase === "pick" || s.phase === "write" || s.phase === "rank") && this.readyToClose()) {
      if (s.phase === "pick") return this.closePick(now);
      if (s.phase === "write") return this.closeWrite(now);
      return this.closeRank(now);
    }
    if (s.phase === "ask" && this.askDone()) return this.closeAsk(now);
    return [];
  }

  pause(plan, now) {
    const s = this.s;
    s.next = plan;
    s.pauseReason = "offline";
    return this.enter("pause", T.pause, now, [{ type: "pause" }]);
  }

  resume(now) {
    const s = this.s;
    const plan = s.next || { to: "turn" };
    s.next = null;
    s.pauseReason = null;
    if (plan.to === "round") return this.startRound(plan.n, now);
    return this.nextTurn(now);
  }

  nextDeadline() {
    const s = this.s;
    return s.phase === "lobby" || s.phase === "finished" ? null : s.phaseEnd;
  }

  tick(now) {
    const s = this.s;
    if (s.phaseEnd == null || now < s.phaseEnd) return [];
    switch (s.phase) {
      case "pick": return this.closePick(now);
      case "write": return this.closeWrite(now);
      case "rank": return this.closeRank(now);
      case "tintro": return this.ask(0, now);
      case "ask": return this.closeAsk(now);
      case "reveal": return this.nextTurn(now);
      case "scores": return s.round.n === 1 ? this.startRound(2, now) : this.finish("done", now);
      case "pause": return this.onlineCount() >= MIN_PLAYERS ? this.resume(now) : this.finish("paused", now);
      default: return [];
    }
  }

  /*
   * Лента «самых громких раскрытий» (§7, решение владельца 18.10): до 3 ходов с наибольшим недобором. Недобор считается
   * только по отвеченным вопросам: таймаут — молчание, а не промах. Громко — строго больше 300. На одну мишень — не больше
   * одного хода (самого громкого): иначе лента из одной Маши. При равенстве выше ход с более ярким промахом (worst.mag).
   */
  computeLoud() {
    const list = this.s.log.map((x) => (x.worst === undefined ? { ...x, miss: missOf(x.answers || [], x.pts || []), worst: worstQ(x.order, x.qs, x.answers || [], x.pts || []) } : x))
      .filter((x) => x.miss > LOUD_MIN && x.worst)
      .sort((a, b) => b.miss - a.miss || b.worst.mag - a.worst.mag);
    const seen = new Set();
    const out = [];
    for (const x of list) {
      if (seen.has(x.target)) continue;
      seen.add(x.target);
      out.push(x);
      if (out.length === LOUD_TOP) break;
    }
    return out;
  }

  finish(reason, now) {
    const s = this.s;
    s.phase = "finished";
    s.phaseStart = now;
    s.phaseEnd = null;
    s.finishedReason = reason;
    s.pauseReason = null;
    s.next = null;
    s.loud = this.computeLoud();
    return [{ type: "final", reason }];
  }

  // ---------- ведущий ----------

  toLobby(now) {
    const s = this.s;
    if (s.phase !== "lobby" && (s.phase !== "finished" || s.finishedReason === "host")) s.aborted = true;
    const ev = s.phase === "lobby" || s.phase === "finished" ? [] : this.finish("host", now);
    s.phase = "lobby";
    s.players = s.players.filter((p) => !p.left);
    s.round = null;
    s.turn = null;
    s.next = null;
    return ev.concat([{ type: "lobby" }]);
  }

  abort(now) {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished") return [];
    return this.finish("host", now);
  }

  // ---------- снимок для клиентов ----------

  publicSet(set) {
    return set ? { kind: set.kind, title: set.title, top: set.top, bottom: set.bottom, items: set.items.map((x) => (x.e ? { t: x.t, e: x.e } : { t: x.t })), author: set.author || null } : null;
  }

  /*
   * view: "board" — доска, иначе id игрока.
   * Никому до раскрытия хода: порядок мишени (r.orders) — даже ей самой: свой порядок телефон помнит сам.
   * Ответы угадывающих — всем сразу (доска показывает их по мере ответа, §5). Свой набор игрок видит только сам,
   * чужой — только в ходе этой мишени.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const r = s.round;
    const t = s.turn;
    const inTurn = t && (s.phase === "tintro" || s.phase === "ask" || s.phase === "reveal");
    let round = null;
    if (r && s.phase !== "lobby" && s.phase !== "finished") {
      round = { n: r.n, cast: r.cast.slice(), turnsTotal: r.turns.length, ti: r.ti };
      if (s.phase === "pick") round.done = r.cast.filter((id) => r.choice[id] != null);
      if (s.phase === "write") {
        round.writers = Object.keys(r.writes);
        round.done = round.writers.filter((id) => r.writes[id].cards);
      }
      if (s.phase === "rank") {
        round.ranking = r.cast.filter((id) => r.sets[id]);
        round.done = round.ranking.filter((id) => r.orders[id]);
        round.vetoed = Object.keys(r.veto);
      }
    }
    let turn = null;
    if (inTurn) {
      const asked = s.phase === "reveal" ? 3 : s.phase === "ask" ? t.qi + 1 : 0;
      turn = {
        target: t.target,
        author: t.author,
        guessers: t.guessers.slice(),
        swapped: t.swapped,
        set: this.publicSet(r.sets[t.target]),
        vetoed: !!r.veto[t.target],
        qi: s.phase === "ask" ? t.qi : s.phase === "reveal" ? 3 : -1,
        qs: t.qs.slice(0, asked),
        // ответы угадывающих — на уже заданные вопросы
        answers: Object.fromEntries(t.guessers.map((g) => [g, t.answers[g].slice(0, asked)])),
      };
      if (s.phase === "reveal" && t.result) turn.result = { order: t.result.order, pts: t.result.pts };
    }
    let mePart = null;
    if (me) {
      const inCast = !!r && r.cast.includes(me.id);
      mePart = { id: me.id, inCast };
      if (r && s.phase === "pick" && r.offers[me.id]) { mePart.offers = r.offers[me.id]; mePart.choice = r.choice[me.id] ?? null; }
      if (r && s.phase === "write" && r.writes[me.id]) {
        const w = r.writes[me.id];
        mePart.write = { target: w.target, prompt: w.prompt.text, top: w.prompt.top, bottom: w.prompt.bottom, examples: w.prompt.examples, cards: w.cards };
      }
      if (r && s.phase === "rank" && r.sets[me.id]) {
        mePart.set = this.publicSet(r.sets[me.id]);
        mePart.ranked = !!r.orders[me.id];
        mePart.veto = r.n === 2 ? (r.veto[me.id] ? { used: true, idx: r.veto[me.id].idx } : { used: false }) : null;
      }
      if (r && s.phase === "rank" && !r.sets[me.id]) {
        // автор видит свою мишень: «Маша расставляет твои карточки» (сами карточки после вето — не показываем)
        const w = r.writes[me.id];
        if (w) mePart.wroteFor = w.target;
      }
      if (inTurn) {
        // watch — зритель: смотрит доску, на телефоне без кнопок (§5)
        const role = me.id === t.target ? "target" : t.guessers.includes(me.id) ? "guesser" : "watch";
        mePart.role = role;
        if (role === "guesser") mePart.answered = [0, 1, 2].map((i) => t.answers[me.id][i] != null);
        if (s.phase === "reveal" && t.result && role === "guesser") mePart.pts = t.result.pts[me.id];
      }
    }
    return {
      phase: s.phase,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      contentLang: this.contentLang(),
      game: s.game,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      round,
      turn,
      seats: s.phase === "lobby" ? [] : s.seats.slice(),
      loud: s.phase === "finished" ? s.loud || [] : null,
      restarted: s.phase !== "lobby" && s.phase !== "finished" && !!s.restarted,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      pauseReason: s.phase === "pause" ? s.pauseReason || "offline" : null,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      avatarChoices: s.phase === "lobby" || s.phase === "finished" ? AVATAR_CHOICES : null,
      me: mePart,
      players: s.players.map((p) => ({ id: p.id, name: p.name, color: p.color, avatar: p.avatar, online: p.online !== false, left: p.left, score: p.score })),
    };
  }
}

module.exports = {
  Game, T, EXTRA_MS, DEFAULTS, MAX_PLAYERS, MIN_PLAYERS, NAME_MAX, SET_SIZE, CARD_MAX, Q1_PTS, Q2_PTS, Q3_PTS, TURN_MAX, LOUD_MIN,
  COLORS, AVATARS, AVATAR_CHOICES, clampSettings, cleanName, cleanText, nameKey, cardKey, cardProblem, kendall, scoreQ, scoreTurn, validAnswer,
  missOf, worstQ,
};
