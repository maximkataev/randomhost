"use strict";

/*
 * Движок «Не верю!»: чистая логика без сети и таймеров (fibs-spec.md).
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1. Банк фактов — снаружи (content[lang] = [{id, topic, final, text, answer, alts, lies, source}]),
 * в состояние копируется только разыгрываемый факт.
 *
 * Партия: раунды (разминка → двойные ставки → финал), в раунде — факты. Факт идёт по фазам:
 * topic (игрок выбирает тему) → lie (все врут) → choose (ищут правду) → reveal (раскрытие) → scores.
 * Тайны (§8): правда, авторы вариантов, ловушки и чужой выбор не уходят ни в один снимок до раскрытия.
 */

const { normalize } = require("./normalize");

// Раунды (§2): очки за правду и за каждого обманутого
const ROUNDS = {
  r1: { truth: 1000, fool: 500, facts: 3, shortFacts: 2 },
  r2: { truth: 2000, fool: 1000, facts: 3, shortFacts: 2 },
  final: { truth: 3000, fool: 1500, facts: 1, shortFacts: 1 },
};
const PLAN = ["r1", "r2", "final"];

// Добавка ко времени на ответ (просьба владельца 04.10: «дольше на 10–20 с»). Настраивается
// переменной окружения ROUND_EXTRA_SEC (0…60), по умолчанию +15 с; голосования и раскрытия не трогает.
const EXTRA_MS = Math.round(Math.max(0, Math.min(60, Number(process.env.ROUND_EXTRA_SEC ?? 15) || 0)) * 1000);

const T = {
  intro: 3500, // заставка раунда
  topic: 8000,
  lie: 33000 + EXTRA_MS, // 3 с на чтение факта + 30 с на ложь (§3) + добавка
  choose: 15000,
  step: 2500, // раскрытие варианта, который кто-то выбрал
  stepEmpty: 1000, // вариант, который никто не выбрал
  truth: 4000,
  scores: 4000,
};

const DEFAULTS = {
  hints: 2, // «Соври за меня» на партию (§4): 1–3
  short: false, // короткая партия: 2 + 2 + финал
  lang: "ru",
};

const MAX_PLAYERS = 16;
const MIN_PLAYERS = 3;
const MIN_OPTIONS = 6; // вариантов на экране не меньше, недостающее — ловушки игры (§4)
const TOPICS_OFFERED = 4;
const LIE_MAX = 25;
const LIKE_GRACE = 2500; // все выбрали — ещё 2,5 с на лайки, потом раскрытие (последний выбравший тоже успевает)
const LIKES_PER_FACT = 2;
const LIKE_POINTS = 100;
const REACT_GAP = 2000;
const REACTIONS = ["😂", "😱", "🤥", "👏", "🤯"];

// 16 цветов под газетную полосу: чернила и штемпели
const COLORS = ["#d62828", "#1d4ed8", "#b45309", "#047857", "#7c3aed", "#c2410c", "#0e7490", "#be185d", "#4d7c0f", "#92400e", "#3730a3", "#9f1239", "#0f766e", "#a21caf", "#a16207", "#475569"];
const AVATARS = ["🕵️", "🦊", "🐸", "🦉", "🐙", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐝", "🐳", "🦩", "🐢", "🦔"];

function clampSettings(input = {}) {
  const s = { ...DEFAULTS };
  const h = Number(input.hints);
  if ([1, 2, 3].includes(h)) s.hints = h;
  if (typeof input.short === "boolean") s.short = input.short;
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  return s;
}

// без управляющих и невидимых символов, без лишних пробелов
const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
function cleanText(text, max) {
  return Array.from(String(text == null ? "" : text).replace(CTRL, "").replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}
const cleanName = (name) => cleanText(name, 16);

// Вид варианта на экране: все строчными, без точки/«!»/«?» в конце и без кавычек вокруг.
// Правда в банке написана строчными и без знаков, а игроки пишут «Акулы!» — по заглавной букве
// и восклицательному знаку правда угадывалась с первого взгляда (замечание владельца).
function displayText(t) {
  const low = String(t || "").toLowerCase().trim();
  let x = low, prev;
  do { prev = x; x = x.replace(/^["«“„']+|["»”“']+$/g, "").replace(/[\s.!?…,;:]+$/u, "").trim(); } while (x !== prev);
  return x || low;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const x = Array.from(a), y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

// Буквальный ключ без стемминга: регистр, ё/е, ударения и знаки не важны, окончания — важны
function literal(text) {
  return String(text || "").toLowerCase().replace(/ё/g, "е").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/(\d)[\s.,\u00a0\u202f](?=\d{3}\b)/g, "$1") // 20 000 = 20000 = 20,000
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/*
 * Вписал правду? (§4) Буквальное совпадение с ответом или alts — всегда. Для ответов от 5 букв ещё и
 * совпадение по основам слов и опечатка в одну букву (кроме чисел). Короткие ответы стеммером не сравниваем:
 * «эмо» и «эму» дают одну основу, и отказ «Это правда!» подсказал бы ответ.
 */
function isTruth(text, fact) {
  const lit = literal(text);
  if (!lit) return false;
  const key = normalize(text);
  for (const t of [fact.answer, ...(fact.alts || [])]) {
    const tl = literal(t);
    if (!tl) continue;
    if (lit === tl) return true;
    if (Array.from(tl).length < 5) continue;
    if (key && key === normalize(t)) return true;
    // перефраз с правдой внутри: «бобровой железы» при ответе «бобров» — каждая основа ответа начинает слово лжи
    const need = normalize(t).split(" ").filter(Boolean);
    const have = key.split(" ");
    if (need.length && need.every((w) => w.length >= 4 && have.some((h) => h.startsWith(w)))) return true;
    // в числах опечаток не бывает: «14 часов» — не опечатка в «11 часов», а другое число
    if (lit.replace(/\D/g, "") !== tl.replace(/\D/g, "")) continue;
    if (levenshtein(lit, tl) <= 1) return true;
  }
  return false;
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
      phase: "lobby", // lobby | intro | topic | lie | choose | reveal | scores | finished
      players: [],
      game: 0,
      ri: -1, // индекс раунда в PLAN
      fi: -1, // номер факта в раунде
      factN: 0, // сквозной номер факта в партии (кто выбирает тему)
      phaseStart: null,
      phaseEnd: null,
      chooser: null, // кто выбирает тему
      topics: [], // предложенные темы
      topic: null,
      fact: null, // разыгрываемый факт: {id, topic, text, answer, alts, source, pool, poolUsed}
      roster: [], // кто врёт в этом факте
      lies: {}, // playerId → {text, key, hint, late, at}
      tries: {}, // playerId → сколько раз ложь отклонена как правда
      options: null, // варианты на экране: [{text, kind: lie|trap|truth, authors, key}]
      picks: {}, // playerId → [индексы вариантов]
      likes: {}, // playerId → [индексы вариантов]
      result: null, // итог раскрытия
      used: { ru: [], en: [], el: [] }, // сыгранные id фактов: не повторяем, пока банк не пройден
      bestLie: null, // «Любимая ложь зала»
      seq: 0,
      finishedReason: null,
    }, rnd, content);
  }

  static from(state, rnd, content) {
    return new Game(state, rnd, content);
  }

  // ---------- участники ----------

  player(id) {
    return this.s.players.find((p) => p.id === id);
  }

  present() {
    return this.s.players.filter((p) => !p.left);
  }

  addPlayer({ id, name }) {
    const s = this.s;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    if (this.present().length >= MAX_PLAYERS) return { ok: false, reason: "room_full" };
    name = cleanName(name);
    if (!name) return { ok: false, reason: "bad_name" };
    const used = new Set(this.present().map((p) => p.color));
    const usedAv = new Set(this.present().map((p) => p.avatar));
    const p = {
      id,
      name,
      color: COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length],
      avatar: AVATARS.find((a) => !usedAv.has(a)) || AVATARS[s.players.length % AVATARS.length],
      online: true,
      left: false,
      score: 0,
      hintsUsed: 0,
      stats: { fooled: 0, truths: 0, traps: 0, likes: 0 },
      lastReact: null,
    };
    s.players.push(p);
    // вошёл посреди партии — врёт со следующего факта, искать правду может сразу (§8)
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
    // ушёл выбирающий тему — тема случайная
    if (s.phase === "topic" && s.chooser === id) return ev.concat(this.pickTopic(id, null, now, true).events || []);
    return ev.concat(this.maybeAdvance(now));
  }

  setOnline(id, online, now) {
    const p = this.player(id);
    if (p) p.online = online;
    return online ? [] : this.maybeAdvance(now);
  }

  // ---------- банк ----------

  bank() {
    const lang = this.s.settings.lang;
    return this.content[lang] || this.content.ru || [];
  }

  // факты раундов 1–2 (final: false) или финальные; сыгранные в комнате — только когда банк пройден
  pool(final) {
    const s = this.s;
    const lang = s.settings.lang;
    const all = this.bank().filter((f) => !!f.final === final);
    const used = new Set(s.used[lang] || []);
    const free = all.filter((f) => !used.has(f.id));
    if (free.length) return free;
    // банк пройден: забываем сыгранное этого вида
    s.used[lang] = (s.used[lang] || []).filter((id) => !all.some((f) => f.id === id));
    return all;
  }

  takeFact(f) {
    const s = this.s;
    const lang = s.settings.lang;
    (s.used[lang] = s.used[lang] || []).push(f.id);
    s.fact = {
      id: f.id,
      topic: f.topic,
      final: !!f.final,
      text: f.text,
      answer: f.answer,
      alts: (f.alts || []).slice(),
      source: f.source || null,
      pool: (f.lies || []).filter((l) => !isTruth(l, f)), // заготовленная ложь — только на сервере
      poolUsed: [],
    };
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    const ps = this.present();
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    if (!this.bank().length) return { ok: false, reason: "no_content" };
    s.game++;
    s.ri = -1;
    s.factN = 0;
    s.playedTopics = [];
    s.bestLie = null;
    s.finishedReason = null;
    for (const p of ps) { p.score = 0; p.hintsUsed = 0; p.stats = { fooled: 0, truths: 0, traps: 0, likes: 0 }; }
    // очередь выбора темы — по кругу в перемешанном порядке
    const ring = ps.map((p) => p.id);
    for (let i = ring.length - 1; i > 0; i--) { const j = this.rnd(i + 1); [ring[i], ring[j]] = [ring[j], ring[i]]; }
    s.ring = ring;
    return { ok: true, events: [{ type: "started", game: s.game }, ...this.nextRound(now)] };
  }

  roundKey() {
    return PLAN[this.s.ri] || null;
  }

  round() {
    const k = this.roundKey();
    return k ? ROUNDS[k] : null;
  }

  factsInRound() {
    const R = this.round();
    if (!R) return 0;
    return this.s.settings.short ? R.shortFacts : R.facts;
  }

  nextRound(now) {
    const s = this.s;
    s.ri++;
    if (s.ri >= PLAN.length) return this.finish("done", now);
    s.fi = -1;
    this.clearFact();
    s.phase = "intro";
    s.phaseStart = now;
    s.phaseEnd = now + T.intro;
    return [{ type: "round", roundKey: PLAN[s.ri], index: s.ri }];
  }

  clearFact() {
    const s = this.s;
    s.fact = null;
    s.topics = [];
    s.topic = null;
    s.chooser = null;
    s.lies = {};
    s.tries = {};
    s.options = null;
    s.picks = {};
    s.likes = {};
    s.result = null;
  }

  nextFact(now) {
    const s = this.s;
    s.fi++;
    if (s.fi >= this.factsInRound()) return this.nextRound(now);
    this.clearFact();
    s.factN++;
    if (this.roundKey() === "final") {
      // в финале тем нет: факт особенно дикий (§2)
      const pool = this.pool(true);
      this.takeFact(pool[this.rnd(pool.length)]);
      return this.openLies(now);
    }
    // выбирает следующий по кругу из тех, кто ещё в игре
    const ring = (s.ring || []).filter((id) => { const p = this.player(id); return p && !p.left; });
    for (const p of this.present()) if (!ring.includes(p.id)) ring.push(p.id);
    s.ring = ring;
    s.chooser = ring[(s.factN - 1) % ring.length];
    const byTopic = {};
    for (const f of this.pool(false)) (byTopic[f.topic] = byTopic[f.topic] || []).push(f);
    // сначала темы, ещё не сыгранные в этой партии; не хватило — добираем из сыгранных
    const played = new Set(s.playedTopics || []);
    const fresh = Object.keys(byTopic).filter((t) => !played.has(t));
    const old = Object.keys(byTopic).filter((t) => played.has(t));
    const offer = [];
    while (offer.length < TOPICS_OFFERED && fresh.length) offer.push(fresh.splice(this.rnd(fresh.length), 1)[0]);
    while (offer.length < TOPICS_OFFERED && old.length) offer.push(old.splice(this.rnd(old.length), 1)[0]);
    s.topics = offer;
    s.phase = "topic";
    s.phaseStart = now;
    s.phaseEnd = now + T.topic;
    // выбирающий не на связи — не ждём
    const ch = this.player(s.chooser);
    if (!ch || !ch.online) return [{ type: "topic", chooser: s.chooser }, ...this.pickTopic(s.chooser, null, now, true).events];
    return [{ type: "topic", chooser: s.chooser }];
  }

  // выбор темы; auto — по таймеру или за ушедшего: случайная из предложенных
  pickTopic(id, topic, now, auto = false) {
    const s = this.s;
    if (s.phase !== "topic") return { ok: false, reason: "not_topic" };
    if (!auto && id !== s.chooser) return { ok: false, reason: "not_chooser" };
    if (!auto && !s.topics.includes(topic)) return { ok: false, reason: "bad_topic" };
    if (auto) topic = s.topics[this.rnd(s.topics.length)];
    const facts = this.pool(false).filter((f) => f.topic === topic);
    const list = facts.length ? facts : this.pool(false);
    this.takeFact(list[this.rnd(list.length)]);
    s.topic = topic;
    s.playedTopics = (s.playedTopics || []).concat(topic);
    return { ok: true, events: [{ type: "topicPicked", topic, auto }, ...this.openLies(now)] };
  }

  openLies(now) {
    const s = this.s;
    s.roster = this.present().map((p) => p.id);
    s.lies = {};
    s.tries = {};
    s.phase = "lie";
    s.phaseStart = now;
    s.phaseEnd = now + T.lie;
    return [{ type: "fact" }];
  }

  // ложь руками; правду не принимаем — «Это правда! Придумай ложь» (§4)
  lie(id, text, now) {
    const s = this.s;
    if (s.phase !== "lie") return { ok: false, reason: "not_lie" };
    if (!s.roster.includes(id)) return { ok: false, reason: "not_in_round" };
    if (s.lies[id]) return { ok: false, reason: "done" };
    const t = cleanText(text, LIE_MAX);
    if (!t || !normalize(t)) return { ok: false, reason: "empty" };
    // Отказ «это правда» подсказывает правду только тому, кто её и так вписал: любая неправда сразу
    // принимается как ложь, поэтому перебором нащупать ответ нельзя — лимит попыток не нужен.
    if (isTruth(t, s.fact)) return { ok: false, reason: "truth" };
    s.lies[id] = { text: displayText(t), key: normalize(t), hint: false, late: false, at: now };
    return { ok: true, events: [{ type: "lied", playerId: id }, ...this.maybeAdvance(now)] };
  }

  // «🎲 Соври за меня»: заготовленная ложь, сменить нельзя, лимит на партию
  hint(id, now) {
    const s = this.s;
    if (s.phase !== "lie") return { ok: false, reason: "not_lie" };
    if (!s.roster.includes(id)) return { ok: false, reason: "not_in_round" };
    if (s.lies[id]) return { ok: false, reason: "done" };
    const p = this.player(id);
    if (!p || p.hintsUsed >= s.settings.hints) return { ok: false, reason: "no_hints" };
    p.hintsUsed++;
    s.lies[id] = { ...this.pickCanned(), hint: true, late: false, at: now };
    return { ok: true, events: [{ type: "lied", playerId: id }, ...this.maybeAdvance(now)] };
  }

  // заготовленная ложь из пула факта, не совпадающая с уже поданной; пул кончился — ложь соседнего факта того же языка
  pickCanned() {
    const s = this.s;
    const f = s.fact;
    const taken = new Set(Object.values(s.lies).map((l) => l.key));
    const free = f.pool.map((_, i) => i).filter((i) => !f.poolUsed.includes(i) && !taken.has(normalize(f.pool[i])));
    if (free.length) {
      const i = free[this.rnd(free.length)];
      f.poolUsed.push(i);
      return { text: displayText(f.pool[i]), key: normalize(f.pool[i]) };
    }
    const bank = this.bank().filter((x) => x.id !== f.id && (x.lies || []).length);
    for (let tries = 0; tries < 30 && bank.length; tries++) {
      const other = bank[this.rnd(bank.length)];
      const cand = other.lies[this.rnd(other.lies.length)];
      if (!taken.has(normalize(cand)) && !isTruth(cand, f)) return { text: displayText(cand), key: normalize(cand) };
    }
    return { text: "…", key: "…" + s.seq++ };
  }

  allLied() {
    const s = this.s;
    return s.roster.every((id) => {
      const p = this.player(id);
      return !p || p.left || !p.online || s.lies[id];
    });
  }

  closeLies(now) {
    const s = this.s;
    // не успел — заготовленная ложь с 🐌, лимит не тратит (§3)
    for (const id of s.roster) {
      const p = this.player(id);
      if (!s.lies[id] && p && !p.left) s.lies[id] = { ...this.pickCanned(), hint: true, late: true, at: now };
    }
    // одинаковая ложь склеивается в один вариант, авторы делят его (§4)
    const byKey = new Map();
    for (const id of s.roster) {
      const l = s.lies[id];
      if (!l) continue;
      if (!byKey.has(l.key)) byKey.set(l.key, { text: l.text, kind: "lie", authors: [], key: l.key });
      byKey.get(l.key).authors.push(id);
    }
    const options = [...byKey.values()];
    options.push({ text: displayText(s.fact.answer), kind: "truth", authors: [], key: normalize(s.fact.answer) });
    // ловушки игры — пока вариантов меньше шести
    const f = s.fact;
    const taken = new Set(options.map((o) => o.key));
    // ловушка не пересекается словами с вариантами на экране: «ракун» рядом с «ракун в очках»,
    // «камера» рядом с «кинокамерой» выдают обоих
    const words = options.flatMap((o) => o.key.split(" ")).filter((w) => w.length > 2);
    const clash = (w) => w.length > 2 && words.some((x) => x === w || (Math.min(x.length, w.length) >= 4 && (x.includes(w) || w.includes(x))));
    const free = f.pool.map((_, i) => i).filter((i) => !f.poolUsed.includes(i) && !taken.has(normalize(f.pool[i])) && !normalize(f.pool[i]).split(" ").some(clash));
    while (options.length < MIN_OPTIONS && free.length) {
      const i = free.splice(this.rnd(free.length), 1)[0];
      f.poolUsed.push(i);
      taken.add(normalize(f.pool[i]));
      options.push({ text: displayText(f.pool[i]), kind: "trap", authors: [], key: normalize(f.pool[i]) });
    }
    for (let i = options.length - 1; i > 0; i--) { const j = this.rnd(i + 1); [options[i], options[j]] = [options[j], options[i]]; }
    s.options = options;
    s.picks = {};
    s.likes = {};
    s.phase = "choose";
    s.phaseStart = now;
    s.phaseEnd = now + T.choose;
    return [{ type: "choose" }];
  }

  // выбор правды: один вариант или два с подстраховкой (§4); свой нельзя, повторно нельзя
  choose(id, picks, now) {
    const s = this.s;
    if (s.phase !== "choose") return { ok: false, reason: "not_choose" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (s.picks[id]) return { ok: false, reason: "chosen" };
    const list = [...new Set((Array.isArray(picks) ? picks : [picks]).map(Number))];
    if (list.length < 1 || list.length > 2) return { ok: false, reason: "bad_pick" };
    for (const i of list) {
      if (!Number.isInteger(i) || i < 0 || i >= s.options.length) return { ok: false, reason: "bad_pick" };
      if (s.options[i].authors.includes(id)) return { ok: false, reason: "own" };
    }
    s.picks[id] = list;
    return { ok: true, events: [{ type: "chose", playerId: id }, ...this.maybeAdvance(now)] };
  }

  // 👍 чужой лжи: после своего выбора, до двух на факт, +100 автору (§5)
  like(id, opt, now) {
    const s = this.s;
    if (s.phase !== "choose") return { ok: false, reason: "not_choose" };
    if (!s.picks[id]) return { ok: false, reason: "choose_first" };
    const i = Number(opt);
    const o = Number.isInteger(i) ? s.options[i] : null;
    if (!o) return { ok: false, reason: "bad_like" };
    if (o.authors.includes(id)) return { ok: false, reason: "own" };
    const mine = (s.likes[id] = s.likes[id] || []);
    if (mine.includes(i)) return { ok: false, reason: "liked" };
    if (mine.length >= LIKES_PER_FACT) return { ok: false, reason: "no_likes" };
    mine.push(i);
    return { ok: true, events: [{ type: "liked" }] };
  }

  allChose() {
    const s = this.s;
    return this.present().every((p) => !p.online || s.picks[p.id]);
  }

  // Подсчёт факта (§5) и расписание раскрытия: сначала никем не выбранные, потом выбранные, правда последней
  reveal(now) {
    const s = this.s;
    const R = this.round();
    const opts = s.options;
    const choosers = opts.map(() => []); // [{playerId, half}]
    const gain = {}; // playerId → очки за факт
    const add = (id, n) => { gain[id] = (gain[id] || 0) + n; };
    for (const [pid, list] of Object.entries(s.picks)) {
      const half = list.length === 2;
      for (const i of list) {
        choosers[i].push({ playerId: pid, half });
        const o = opts[i];
        const p = this.player(pid);
        if (o.kind === "truth") {
          add(pid, half ? R.truth / 2 : R.truth);
          if (p) p.stats.truths += half ? 0.5 : 1; // с подстраховкой — полправды и в награде
        } else if (o.kind === "lie") {
          for (const a of o.authors) {
            add(a, half ? R.fool / 2 : R.fool);
            const ap = this.player(a);
            if (ap) ap.stats.fooled++;
          }
        } else if (p) p.stats.traps++;
      }
    }
    const likes = opts.map(() => 0);
    for (const list of Object.values(s.likes)) for (const i of list) likes[i]++;
    opts.forEach((o, i) => {
      if (!likes[i] || o.kind !== "lie") return;
      for (const a of o.authors) {
        add(a, likes[i] * LIKE_POINTS);
        const ap = this.player(a);
        if (ap) ap.stats.likes += likes[i];
      }
      // «Любимая ложь зала» — только у единоличного лидера по лайкам; ничья — награды нет
      if (!s.bestLie || likes[i] > s.bestLie.likes) s.bestLie = { text: o.text, authors: o.authors.slice(), likes: likes[i], fact: s.fact.text, tie: false };
      else if (likes[i] === s.bestLie.likes) s.bestLie.tie = true;
    });
    for (const [id, n] of Object.entries(gain)) { const p = this.player(id); if (p) p.score += n; }
    const idx = opts.map((_, i) => i).filter((i) => opts[i].kind !== "truth");
    const empty = idx.filter((i) => !choosers[i].length);
    const picked = idx.filter((i) => choosers[i].length);
    const order = [...empty, ...picked, opts.findIndex((o) => o.kind === "truth")];
    const steps = [];
    let t = 0;
    for (const i of order) {
      steps.push({ opt: i, at: t });
      t += opts[i].kind === "truth" ? T.truth : choosers[i].length ? T.step : T.stepEmpty;
    }
    s.result = { choosers, likes, gain, steps, total: t };
    s.phase = "reveal";
    s.phaseStart = now;
    s.phaseEnd = now + t;
    return [{ type: "reveal" }];
  }

  maybeAdvance(now) {
    const s = this.s;
    if (s.phase === "lie" && this.allLied()) return this.closeLies(now);
    if (s.phase === "choose" && this.allChose() && s.phaseEnd - now > LIKE_GRACE) {
      s.phaseEnd = now + LIKE_GRACE;
      return [{ type: "allChose" }];
    }
    return [];
  }

  nextDeadline() {
    const s = this.s;
    return s.phase === "lobby" || s.phase === "finished" ? null : s.phaseEnd;
  }

  tick(now) {
    const s = this.s;
    if (s.phaseEnd == null || now < s.phaseEnd) return [];
    switch (s.phase) {
      case "intro": return this.nextFact(now);
      case "topic": return this.pickTopic(s.chooser, null, now, true).events;
      case "lie": return this.closeLies(now);
      case "choose": return this.reveal(now);
      case "reveal":
        s.phase = "scores";
        s.phaseStart = now;
        s.phaseEnd = now + T.scores;
        return [{ type: "scores" }];
      case "scores": return this.nextFact(now);
      default: return [];
    }
  }

  // награды партии (§5): лучший по счётчику, ничьи — все
  awards() {
    const ps = this.present();
    const top = (k) => {
      const max = Math.max(0, ...ps.map((p) => p.stats[k]));
      const ids = ps.filter((p) => p.stats[k] === max).map((p) => p.id);
      // награда, которую делят больше двоих, ничего не говорит
      return max > 0 && ids.length <= 2 ? { ids, n: max } : null;
    };
    const b = this.s.bestLie;
    // «Любимая ложь зала» — от двух лайков и без ничьей
    return { liar: top("fooled"), detector: top("truths"), gullible: top("traps"), bestLie: b && !b.tie && b.likes >= 2 ? b : null };
  }

  finish(reason, now) {
    const s = this.s;
    s.phase = "finished";
    s.phaseStart = now;
    s.phaseEnd = null;
    s.finishedReason = reason;
    s.awards = this.awards();
    return [{ type: "final", reason }];
  }

  // ---------- ведущий ----------

  toLobby(now) {
    const s = this.s;
    const ev = s.phase === "lobby" || s.phase === "finished" ? [] : this.finish("host", now);
    s.phase = "lobby";
    s.players = s.players.filter((p) => !p.left);
    this.clearFact();
    return ev.concat([{ type: "lobby" }]);
  }

  abort(now) {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished") return [];
    return this.finish("host", now);
  }

  react(id, emoji, now) {
    const p = this.player(id);
    if (!p || !REACTIONS.includes(emoji)) return { ok: false, reason: "bad" };
    if (p.lastReact != null && now - p.lastReact < REACT_GAP) return { ok: false, reason: "too_fast" };
    p.lastReact = now;
    return { ok: true, events: [{ type: "react", playerId: id, emoji }] };
  }

  // ---------- снимок для клиентов ----------

  /*
   * view: "board" — доска, иначе id игрока. Никому не уходят: пул лжи, alts, ключи сравнения.
   * До раскрытия — ни правды (она среди вариантов без пометки), ни авторов, ни ловушек, ни чужого выбора.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const revealed = s.phase === "reveal" || s.phase === "scores";
    let options = null;
    if (s.options && (s.phase === "choose" || revealed)) {
      options = s.options.map((o, i) => {
        const x = { text: o.text };
        if (revealed) {
          Object.assign(x, {
            kind: o.kind,
            authors: o.authors,
            hint: o.authors.map((a) => !!(s.lies[a] && s.lies[a].hint)),
            late: o.authors.map((a) => !!(s.lies[a] && s.lies[a].late)),
            choosers: s.result.choosers[i],
            likes: s.result.likes[i],
          });
        } else if (me && o.authors.includes(me.id)) x.mine = true;
        return x;
      });
    }
    let mePart = null;
    if (me) {
      const l = s.lies[me.id];
      mePart = {
        id: me.id,
        inRound: s.roster.includes(me.id),
        lie: l ? { text: l.text, hint: l.hint, late: l.late } : null,
        hintsLeft: Math.max(0, s.settings.hints - me.hintsUsed),
        picks: s.picks[me.id] || null,
        likes: s.likes[me.id] || [],
        chooser: s.phase === "topic" && s.chooser === me.id,
        gain: revealed && s.result ? s.result.gain[me.id] || 0 : null,
      };
    }
    const R = this.round();
    const f = s.fact;
    return {
      phase: s.phase,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      game: s.game,
      ri: s.ri,
      roundKey: this.roundKey(),
      fi: s.fi,
      factsInRound: this.factsInRound(),
      points: R ? { truth: R.truth, fool: R.fool } : null,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      chooser: s.phase === "topic" ? s.chooser : null,
      topics: s.phase === "topic" ? s.topics : null,
      topic: s.topic,
      fact: f && s.phase !== "topic" ? { text: f.text, topic: f.topic, final: f.final } : null,
      truth: f && revealed ? { answer: displayText(f.answer), source: f.source } : null,
      lied: s.phase === "lie" ? s.roster.filter((id) => s.lies[id]) : null,
      roster: s.phase === "lie" ? s.roster : null,
      options,
      choseN: s.phase === "choose" ? Object.keys(s.picks).length : null,
      chose: s.phase === "choose" ? Object.keys(s.picks) : null,
      steps: revealed && s.result ? s.result.steps : null,
      gain: revealed && s.result ? s.result.gain : null,
      awards: s.phase === "finished" ? s.awards || null : null,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      minPlayers: MIN_PLAYERS,
      liesMax: LIE_MAX,
      me: mePart,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        online: p.online,
        left: p.left,
        score: p.score,
        hintsUsed: p.hintsUsed,
      })),
    };
  }
}

module.exports = { Game, EXTRA_MS, ROUNDS, PLAN, T, DEFAULTS, MAX_PLAYERS, MIN_PLAYERS, MIN_OPTIONS, TOPICS_OFFERED, LIE_MAX, LIKE_GRACE, LIKES_PER_FACT, LIKE_POINTS, REACTIONS, COLORS, AVATARS, clampSettings, cleanName, cleanText, displayText, isTruth, levenshtein };
