"use strict";

/*
 * Движок «Сто к одному» (oneword, docs/oneword-spec.md): чистая логика без сети и таймеров.
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1. Банк тем — снаружи (content[lang] = [{id, topic}]).
 *
 * Раунд: answer → guessPopular → guessRare → reveal → scores → следующий раунд или finished.
 * Тайны (§5): до раскрытия никому не уходят чужие ответы темы, чужие guess'ы и кластеры с подсчитанным count.
 * Нормализация и подсчёт очков — чистые функции, экспортированы отдельно и покрыты test-game.js напрямую.
 */

const T = {
  answer: 20000, // тема + ответ одним словом
  guessPopular: 15000,
  guessRare: 15000,
  reveal: 7000, // + REVEAL_STEP за каждый кластер — пауза на раскрытие разброса
  scores: 4000,
  pause: 60000, // «Ждём игроков»: меньше MIN_PLAYERS на связи
};
const REVEAL_STEP = 500;

const DEFAULTS = {
  rounds: 8, // §11.2: черновой ориентир 8–10 — выбрано 8, как в quip/fibs; владелец может изменить
  lang: "ru",
};

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 2; // §11: спеки не фиксируют минимум; 2 достаточно для работы формул (N−count), ниже не имеет смысла
const WORD_MAX = 24; // одно слово: достаточно для длинных составных слов, но не для фразы
const NAME_MAX = 15;

const COLORS = ["#e0115f", "#1438e0", "#0a8a4a", "#e25a00", "#7b1fd6", "#008b9a", "#b8006e", "#6b4a00", "#2c2cad", "#b31010", "#3d6b00", "#c77700"];
const AVATARS = ["🐙", "🦊", "🐸", "🦉", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐳", "🦩"];
const AVATAR_CHOICES = [...new Set(AVATARS.concat(["🐱", "🐶", "🐰", "🐻", "🐨", "🐯", "🐷", "🐮", "🦝", "🦥", "🦦", "🐲", "👽", "🤖", "👻", "🤡", "🥑", "🍕", "🌮", "🍩", "🧀", "🌵", "🍄", "🪩"]))];

function clampSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const s = { ...DEFAULTS };
  if (Number.isFinite(input.rounds)) s.rounds = Math.max(4, Math.min(16, Math.round(input.rounds)));
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  return s;
}

// без управляющих и невидимых символов, без лишних пробелов (как в crowd/game.js cleanText)
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

// ---------- слово-ответ: одно слово, без пробелов (§4) ----------

// пробел обрезает до первого токена (§4: «решить при реализации» — выбран обрез, а не запрет, чтобы не путать игрока)
function cleanWord(word) {
  const cleaned = cleanText(word, WORD_MAX * 4); // сначала общая чистка, потом обрезаем до первого слова
  const first = cleaned.split(/\s+/)[0] || "";
  return Array.from(first).slice(0, WORD_MAX).join("");
}

/*
 * Нормализация (§2): trim + lowercase + ё→е + убрать знаки на концах слова. Без фонетики и синонимов —
 * осознанный компромисс (§11.4): «драгонфрут» и «фрукт дракона» — разные ответы.
 * Знаки на концах — любые не-буквенно-цифровые символы Unicode (кавычки, точки, дефисы-висяки и т. п.).
 */
// эмодзи — полноценные «буквы» ответа (🍎 — это ответ, а не знак препинания); цифры и буквы любых алфавитов тоже
const EDGE_PUNCT = /^[^\p{L}\p{N}\p{Extended_Pictographic}]+|[^\p{L}\p{N}\p{Extended_Pictographic}]+$/gu;
// диакритика не различает ответы в латинице и греческом («Μήλο» = «μηλο», «café» = «cafe»); в кириллице знаки значимы
// (й ≠ и), поэтому снимаем их только после латинской/греческой буквы
const LATIN_GREEK_MARKS = /([\p{Script=Latin}\p{Script=Greek}])\p{M}+/gu;
function normalizeWord(word) {
  return String(word == null ? "" : word)
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/ё/g, "е")
    .replace(/ς/g, "σ")
    .normalize("NFD")
    .replace(LATIN_GREEK_MARKS, "$1")
    .normalize("NFC")
    .replace(EDGE_PUNCT, "");
}

/*
 * Кластеризация (§5): чистая функция от answers {playerId → word|null}. Совпавшие после нормализации
 * непустые ответы — один кластер. Игроки без ответа (null/пусто после нормализации) не входят ни в один
 * кластер и не считаются в N. Порядок кластеров — по убыванию count, затем по первому появлению (стабильно).
 */
function clusterAnswers(answers) {
  const order = [];
  const byKey = new Map(); // normKey → { key, sample, players: [] }
  for (const [playerId, raw] of Object.entries(answers || {})) {
    const norm = normalizeWord(raw);
    if (!norm) continue;
    let c = byKey.get(norm);
    if (!c) { c = { key: norm, sample: cleanWord(raw) || raw, players: [] }; byKey.set(norm, c); order.push(norm); }
    c.players.push(playerId);
  }
  const clusters = order.map((k) => byKey.get(k));
  clusters.sort((a, b) => b.players.length - a.players.length || order.indexOf(a.key) - order.indexOf(b.key));
  return clusters.map((c) => ({ key: c.key, sample: c.sample, count: c.players.length, players: c.players }));
}

/*
 * Очки за угадывание (§2), чистая функция от (guess, clusters, N):
 * - popular: count кластера, в который попал guess; 0, если guess не совпал ни с одним реальным ответом.
 * - rare: N − count кластера, в который попал guess; 0 при отсутствии совпадения. Угадать уникальный ответ
 *   (count === 1) даёт N − 1 — максимум раунда.
 */
function matchCluster(guess, clusters) {
  const key = normalizeWord(guess);
  if (!key) return null;
  return clusters.find((c) => c.key === key) || null;
}
function scorePopular(guess, clusters) {
  const c = matchCluster(guess, clusters);
  return c ? c.count : 0;
}
function scoreRare(guess, clusters, n) {
  const c = matchCluster(guess, clusters);
  return c ? Math.max(0, n - c.count) : 0;
}

// детерминированный ГСЧ для порядка раскрытия кластеров (от seed раунда) — как в соседних играх
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
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
      phase: "lobby", // lobby | answer | guessPopular | guessRare | reveal | scores | pause | finished
      players: [],
      game: 0,
      n: 0, // сыгранных раундов партии
      used: { ru: [], en: [], el: [] }, // сыгранные id тем: не повторяем, пока банк не пройден
      partyIds: [], // id тем этой партии — не повторяются, даже когда банк «забывается»
      round: null,
      next: null,
      phaseStart: null,
      phaseEnd: null,
      pauseReason: null,
      awards: null,
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

  onlineCount() {
    return this.present().filter((p) => p.online).length;
  }

  findLeft(name) {
    const key = nameKey(cleanName(name));
    if (!key) return null;
    return this.s.players.find((p) => p.left && nameKey(p.name) === key) || null;
  }

  compactPlayers() {
    const s = this.s;
    const keep = (p) => !p.left || p.score !== 0;
    s.players = s.players.filter(keep);
    while (s.players.length >= MAX_PLAYERS * 3) {
      const i = s.players.findIndex((p) => p.left);
      if (i < 0) break;
      s.players.splice(i, 1);
    }
  }

  addPlayer({ id, name, now = null }) {
    const s = this.s;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    if (this.present().length >= MAX_PLAYERS) return { ok: false, reason: "room_full" };
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
      popularPts: 0,
      rarePts: 0,
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
    if (p) p.online = online;
    return this.maybeAdvance(now);
  }

  setAvatar(id, avatar) {
    const s = this.s;
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "game_started" };
    if (!AVATAR_CHOICES.includes(avatar)) return { ok: false, reason: "bad_avatar" };
    if (this.present().some((x) => x !== p && x.avatar === avatar)) return { ok: false, reason: "avatar_taken" };
    p.avatar = avatar;
    return { ok: true, events: [{ type: "avatar", playerId: id }] };
  }

  // ---------- банк тем ----------

  bank() {
    const lang = this.s.settings.lang;
    return this.content[lang] || this.content.ru || [];
  }

  // тема без повторов в партии; банк «забывается» (used сбрасывается до partyIds), когда свободных не хватает
  takeTopic() {
    const s = this.s;
    const lang = s.settings.lang;
    const all = this.bank();
    const party = new Set(s.partyIds || []);
    const used = new Set(s.used[lang] || []);
    let free = all.filter((x) => !used.has(x.id) && !party.has(x.id));
    if (!free.length) {
      s.used[lang] = [...party];
      free = all.filter((x) => !party.has(x.id));
      if (!free.length) free = all.slice();
    }
    const topic = free[this.rnd(free.length)] || all[this.rnd(Math.max(1, all.length))];
    (s.used[lang] = s.used[lang] || []).push(topic.id);
    (s.partyIds = s.partyIds || []).push(topic.id);
    return { id: topic.id, topic: topic.topic };
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    const ps = this.present();
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    if (this.bank().length < 4) return { ok: false, reason: "no_content" };
    s.game++;
    s.n = 0;
    s.partyIds = [];
    s.round = null;
    s.next = null;
    s.pauseReason = null;
    s.awards = null;
    s.finishedReason = null;
    for (const p of ps) { p.score = 0; p.popularPts = 0; p.rarePts = 0; p.joinedAt = null; }
    s.players = ps;
    return { ok: true, events: [{ type: "started", game: s.game }, ...this.startRound(now)] };
  }

  startRound(now) {
    const s = this.s;
    const topic = this.takeTopic();
    s.round = {
      num: s.n + 1,
      topic,
      answers: {}, // playerId → word|null
      confirmedAnswer: {},
      guessPopular: {}, // playerId → word|null
      confirmedPopular: {},
      guessRare: {},
      confirmedRare: {},
      seed: this.rnd(1 << 30),
      start: now,
      clusters: null, // секрет до раскрытия
      result: null, // { n, clusters, popularPts:{}, rarePts:{} } — секрет до раскрытия
    };
    s.next = null;
    s.phase = "answer";
    s.phaseStart = now;
    s.phaseEnd = now + T.answer;
    return [{ type: "round", num: s.round.num }];
  }

  // присутствующие, вошедшие не позже начала раунда — те, кто участвует в этом раунде
  roundPlayers() {
    const r = this.s.round;
    return this.present().filter((p) => !(p.joinedAt != null && r && r.start != null && p.joinedAt > r.start));
  }

  answer(id, word, now) {
    const s = this.s;
    if (s.phase !== "answer") return { ok: false, reason: "not_answer" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    const r = s.round;
    if (p.joinedAt != null && p.joinedAt > r.start) return { ok: false, reason: "late" };
    if (r.confirmedAnswer[id]) return { ok: false, reason: "confirmed" };
    const w = cleanWord(word);
    if (!w || !normalizeWord(w)) return { ok: false, reason: "bad_word" }; // пусто или одни знаки препинания
    r.answers[id] = w;
    r.confirmedAnswer[id] = true;
    return { ok: true, events: this.maybeAdvance(now) };
  }

  guessPopular(id, word, now) {
    return this.submitGuess("guessPopular", id, word, now);
  }
  guessRare(id, word, now) {
    return this.submitGuess("guessRare", id, word, now);
  }

  submitGuess(phase, id, word, now) {
    const s = this.s;
    if (s.phase !== phase) return { ok: false, reason: "not_" + phase };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    const r = s.round;
    if (p.joinedAt != null && p.joinedAt > r.start) return { ok: false, reason: "late" };
    const confirmedMap = phase === "guessPopular" ? r.confirmedPopular : r.confirmedRare;
    if (confirmedMap[id]) return { ok: false, reason: "confirmed" };
    const w = cleanWord(word);
    if (!w || !normalizeWord(w)) return { ok: false, reason: "bad_word" };
    (phase === "guessPopular" ? r.guessPopular : r.guessRare)[id] = w;
    confirmedMap[id] = true;
    return { ok: true, events: this.maybeAdvance(now) };
  }

  readyToClose() {
    const s = this.s;
    const r = s.round;
    if (this.onlineCount() < MIN_PLAYERS) return false;
    const need = this.roundPlayers().filter((p) => p.online);
    if (!need.length) return false;
    if (s.phase === "answer") return need.every((p) => r.confirmedAnswer[p.id]);
    if (s.phase === "guessPopular") return need.every((p) => r.confirmedPopular[p.id]);
    if (s.phase === "guessRare") return need.every((p) => r.confirmedRare[p.id]);
    return false;
  }

  maybeAdvance(now) {
    const s = this.s;
    if (s.phase === "pause") {
      const online = this.onlineCount() >= MIN_PLAYERS;
      return online ? this.resume(now) : [];
    }
    if (!this.readyToClose()) return [];
    if (s.phase === "answer") return this.closeAnswer(now);
    if (s.phase === "guessPopular") return this.closeGuessPopular(now);
    if (s.phase === "guessRare") return this.closeGuessRare(now);
    return [];
  }

  // ответы закрыты: кластеризуем (секрет), открываем фазу «угадай популярное»
  closeAnswer(now) {
    const s = this.s;
    const r = s.round;
    r.clusters = clusterAnswers(r.answers);
    r.n = r.clusters.reduce((a, c) => a + c.count, 0);
    if (!r.n) { // никто не ответил — угадывать нечего: сразу к раскрытию, без двух пустых фаз по 15 с
      r.result = { popularPts: {}, rarePts: {} };
      return this.closeGuessRare(now);
    }
    s.phase = "guessPopular";
    s.phaseStart = now;
    s.phaseEnd = now + T.guessPopular;
    return [{ type: "guessPopular" }];
  }

  // guessPopular закрыт: считаем очки за популярное (секрет), открываем «угадай редкое»
  closeGuessPopular(now) {
    const s = this.s;
    const r = s.round;
    r.result = r.result || { popularPts: {}, rarePts: {} };
    for (const [id, word] of Object.entries(r.guessPopular)) r.result.popularPts[id] = scorePopular(word, r.clusters);
    s.phase = "guessRare";
    s.phaseStart = now;
    s.phaseEnd = now + T.guessRare;
    return [{ type: "guessRare" }];
  }

  // guessRare закрыт: считаем очки за редкое, начисляем счёт, открываем раскрытие (здесь впервые всё перестаёт быть секретом)
  closeGuessRare(now) {
    const s = this.s;
    const r = s.round;
    for (const [id, word] of Object.entries(r.guessRare)) r.result.rarePts[id] = scoreRare(word, r.clusters, r.n);
    for (const id of new Set([...Object.keys(r.result.popularPts), ...Object.keys(r.result.rarePts)])) {
      const p = this.player(id);
      if (!p) continue;
      const pop = r.result.popularPts[id] || 0;
      const rare = r.result.rarePts[id] || 0;
      p.score += pop + rare;
      p.popularPts += pop;
      p.rarePts += rare;
    }
    r.result.order = shuffled(r.clusters.map((c) => c.key), mulberry32(r.seed));
    s.phase = "reveal";
    s.phaseStart = now;
    s.phaseEnd = now + T.reveal + REVEAL_STEP * r.clusters.length;
    return [{ type: "reveal" }];
  }

  afterRound(now) {
    const s = this.s;
    s.n++;
    if (s.n >= s.settings.rounds) return this.finish("done", now);
    if (this.onlineCount() < MIN_PLAYERS) return this.pause({ to: "round" }, now);
    return this.startRound(now);
  }

  pause(plan, now) {
    const s = this.s;
    s.next = plan;
    s.phase = "pause";
    s.pauseReason = "offline";
    s.phaseStart = now;
    s.phaseEnd = now + T.pause;
    return [{ type: "pause" }];
  }

  resume(now) {
    const s = this.s;
    s.next = null;
    s.pauseReason = null;
    return this.startRound(now);
  }

  nextDeadline() {
    const s = this.s;
    return s.phase === "lobby" || s.phase === "finished" ? null : s.phaseEnd;
  }

  tick(now) {
    const s = this.s;
    if (s.phaseEnd == null || now < s.phaseEnd) return [];
    switch (s.phase) {
      case "answer": return this.closeAnswer(now);
      case "guessPopular": return this.closeGuessPopular(now);
      case "guessRare": return this.closeGuessRare(now);
      case "reveal": {
        s.phase = "scores";
        s.phaseStart = now;
        s.phaseEnd = now + T.scores;
        return [{ type: "scores" }];
      }
      case "scores": return this.afterRound(now);
      case "pause":
        return this.onlineCount() >= MIN_PLAYERS ? this.resume(now) : this.finish("paused", now);
      default: return [];
    }
  }

  computeAwards() {
    const ps = this.present();
    const top = (val) => {
      const vals = ps.map((p) => ({ id: p.id, v: val(p) }));
      const max = Math.max(0, ...vals.map((x) => x.v));
      const ids = vals.filter((x) => x.v === max).map((x) => x.id);
      return max > 0 && ids.length <= 2 ? { ids, n: max } : null;
    };
    return {
      popular: top((p) => p.popularPts), // лучший угадывающий популярное
      rare: top((p) => p.rarePts), // лучший угадывающий редкое
    };
  }

  finish(reason, now) {
    const s = this.s;
    s.phase = "finished";
    s.phaseStart = now;
    s.phaseEnd = null;
    s.finishedReason = reason;
    s.pauseReason = null;
    s.awards = this.computeAwards();
    return [{ type: "final", reason }];
  }

  toLobby(now) {
    const s = this.s;
    const ev = s.phase === "lobby" || s.phase === "finished" ? [] : this.finish("host", now);
    s.phase = "lobby";
    s.players = s.players.filter((p) => !p.left);
    s.round = null;
    s.next = null;
    return ev.concat([{ type: "lobby" }]);
  }

  abort(now) {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished") return [];
    return this.finish("host", now);
  }

  // ---------- снимок для клиентов ----------

  /*
   * view: "board" — доска, иначе id игрока. Тайны (§5): до фазы reveal никому не уходят чужие ответы темы,
   * чужие guess'ы и кластеры/count. Во время answer/guessPopular/guessRare — только счётчик подтвердивших.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const r = s.round;
    const shown = s.phase === "reveal" || s.phase === "scores";
    const inRound = !!r;
    let round = null;
    if (inRound) {
      round = {
        num: r.num,
        topic: r.topic,
        confirmed: {
          answer: this.roundPlayers().filter((p) => r.confirmedAnswer[p.id]).map((p) => p.id),
          guessPopular: this.roundPlayers().filter((p) => r.confirmedPopular[p.id]).map((p) => p.id),
          guessRare: this.roundPlayers().filter((p) => r.confirmedRare[p.id]).map((p) => p.id),
        },
        voters: this.roundPlayers().filter((p) => p.online).map((p) => p.id),
      };
      if (shown) {
        round.clusters = r.clusters;
        round.n = r.n;
        round.order = r.result.order;
        round.popularPts = r.result.popularPts;
        round.rarePts = r.result.rarePts;
      }
    }
    let mePart = null;
    if (me) {
      mePart = {
        id: me.id,
        inRound: !!r && !(me.joinedAt != null && r.start != null && me.joinedAt > r.start),
        answer: s.phase === "answer" || shown ? r.answers[me.id] || null : null,
        answerConfirmed: !!r && !!r.confirmedAnswer[me.id],
        guessPopular: s.phase === "guessPopular" || shown ? r.guessPopular[me.id] || null : null,
        guessPopularConfirmed: !!r && !!r.confirmedPopular[me.id],
        guessRare: s.phase === "guessRare" || shown ? r.guessRare[me.id] || null : null,
        guessRareConfirmed: !!r && !!r.confirmedRare[me.id],
        popularGain: shown ? r.result.popularPts[me.id] ?? null : null,
        rareGain: shown ? r.result.rarePts[me.id] ?? null : null,
      };
    }
    return {
      phase: s.phase,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      game: s.game,
      n: s.n,
      total: s.settings.rounds,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      round,
      awards: s.phase === "finished" ? s.awards || null : null,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      pauseReason: s.phase === "pause" ? s.pauseReason || "offline" : null,
      minPlayers: MIN_PLAYERS,
      avatarChoices: s.phase === "lobby" || s.phase === "finished" ? AVATAR_CHOICES : null,
      me: mePart,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        online: p.online,
        left: p.left,
        score: p.score,
        popularPts: s.phase === "finished" ? p.popularPts : undefined,
        rarePts: s.phase === "finished" ? p.rarePts : undefined,
      })),
    };
  }
}

module.exports = {
  Game, T, REVEAL_STEP, DEFAULTS, MAX_PLAYERS, MIN_PLAYERS, WORD_MAX, NAME_MAX,
  COLORS, AVATARS, AVATAR_CHOICES, clampSettings, cleanName, cleanText, cleanWord, nameKey,
  normalizeWord, clusterAnswers, scorePopular, scoreRare, matchCluster,
};
