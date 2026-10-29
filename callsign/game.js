"use strict";

/*
 * Движок «Позывного»: чистая логика без сети и таймеров (callsign-spec.md).
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1. Банки — снаружи (content.ru/en/el — слова, content.pics — картинки).
 *
 * Партия: lobby → draw (жребий) → clue → guess → swap → clue → … → finished.
 * Тайна — раскладка поля: её видят только капитаны (§8); остальным и доске карточка открывает цвет, только когда открыта.
 * Любой оперативник ходящей команды открывает карточку первым же тапом (решение владельца 25.10): без кворума.
 */

const { normalize } = require("./normalize");
const presence = require("../lib/presence");

// Добавка ко времени на ответ (ROUND_EXTRA_SEC, 0…60, по умолчанию +15 с) — как в wave/quip/fibs
const EXTRA_MS = Math.round(Math.max(0, Math.min(60, Number(process.env.ROUND_EXTRA_SEC ?? 15) || 0)) * 1000);

const T = {
  draw: 3200, // жребий: кто начинает
  clue: 60000 + EXTRA_MS,
  guess: 90000 + EXTRA_MS,
  guessSolo: 60000 + EXTRA_MS, // ход, когда в команде один оперативник (обсуждать не с кем)
  swap: 1600, // пауза после хода: шторка цветом новой команды
};

const CAP_GRACE_MS = 45000; // капитан офлайн в свой ход дольше — роль переходит
const TAP_GUARD_MS = 1200; // после подсказки тап не принимается: время прочитать (двойное касание, «пальцы быстрее головы»)
const IDLE_TURNS = 3; // столько пустых ходов подряд — партия встаёт на паузу «вы тут?»
const SKIP_MIN_MS = 800;

const SIZE = 25;
const STARTER_CARDS = 9;
const OTHER_CARDS = 8;
const NEUTRAL_CARDS = 7; // + 1 ловушка = 25
const MAX_PICS_PER_GROUP = 2;
const MIN_PLAYERS = 4;
const MIN_TEAM = 2; // капитан + хотя бы один оперативник
const MAX_PLAYERS = 12;
const CLUE_MIN = 2;
const CLUE_MAX = 20;
const NUM_MAX = 9;
const REACT_GAP = 2000;
const REACTIONS = ["😂", "😱", "🤯", "👏", "🙈"];
const TEAMS = ["red", "blue"];
const other = (t) => (t === "red" ? "blue" : "red");

const COLORS = ["#e0115f", "#1438e0", "#0a8a4a", "#e25a00", "#7b1fd6", "#008b9a", "#b8006e", "#6b4a00", "#2c2cad", "#b31010", "#3d6b00", "#c77700"];
const AVATARS = ["🐙", "🦊", "🐸", "🦉", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐳", "🦩"];
const AVATAR_CHOICES = [...new Set(AVATARS.concat(["🐱", "🐶", "🐰", "🐻", "🐨", "🐯", "🐷", "🐮", "🦝", "🦥", "🦦", "🐲", "👽", "🤖", "👻", "🤡", "🥑", "🍕", "🌮", "🍩", "🧀", "🌵", "🍄", "🪩"]))];

const DEFAULTS = { lang: "ru", mode: "words" };

function clampSettings(input = {}) {
  const s = { ...DEFAULTS };
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  if (["words", "pics"].includes(input.mode)) s.mode = input.mode;
  return s;
}

// без управляющих и невидимых символов, без лишних пробелов (как в wave)
const CTRL = /[\u0000-\u001f\u007f-\u009f­͏᠎​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const INVIS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const ZWJ_OK = /(\p{Extended_Pictographic}️?)‍(?=\p{Extended_Pictographic})/gu;
function cleanText(text, max) {
  const t = String(text == null ? "" : text).replace(CTRL, "").replace(ZWJ_OK, "$1\u0001").replace(INVIS, "").replace(/\u0001/g, "‍");
  return Array.from(t.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}
const SKEL = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ё: "e",
  α: "a", β: "b", ε: "e", η: "h", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "y", χ: "x", ς: "c" };
const skeleton = (w) => w.replace(/[авекмнорстухёαβεηικμνορτυχς]/g, (ch) => SKEL[ch]);
const nameKey = (n) => skeleton(String(n || "").normalize("NFKC").toLowerCase()).replace(/[\s‍]+/g, "");
const cleanName = (name) => cleanText(name, 16);
const scripts = (w) => (/[a-z]/i.test(w) ? 1 : 0) + (/[а-яё]/i.test(w) ? 1 : 0) + (/[α-ωάέήίόύώϊϋΐΰ]/i.test(w) ? 1 : 0);

// сравнение без обманок: NFKC (полноширинные), нижний регистр, без диакритики, ё=е, кириллические двойники латиницы → латиница
const fold = (w) => skeleton(String(w).normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").replace(/ё/g, "е").replace(/ς/g, "σ"));

// слова одной основы или одно продолжает другое (от 4 знаков): «море» ↔ «морской» не годится, «кот» ↔ «котлета» — можно
function wordsClash(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (x === y) return true;
  const m = Math.min(x.length, y.length);
  if (m >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
  const nx = normalize(String(a)), ny = normalize(String(b));
  if (nx === ny) return true;
  if (fold(nx) === fold(ny)) return true;
  const n = Math.min(nx.length, ny.length);
  return n >= 4 && (nx.startsWith(ny) || ny.startsWith(nx));
}

// на одном поле не должно быть слов с общей основой (префикс от 5 знаков) — они дают тривиальные подсказки
function boardClash(a, b) {
  const x = normalize(a), y = normalize(b);
  if (x === y) return true;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i >= 5 || (Math.min(x.length, y.length) >= 4 && i >= Math.min(x.length, y.length));
}

/*
 * Подсказка по правилам (§3): одно слово из букв одного алфавита, 2–20 знаков, число 1…9 и не больше остатка своих слов.
 * В режиме слов — не слово с поля (открытого или закрытого): по основе и по префиксу от 4 знаков.
 */
function checkClue(text, num, ctx = {}) {
  const t = cleanText(text, CLUE_MAX + 5);
  if (!t) return { ok: false, reason: "empty" };
  if (/\p{N}/u.test(t)) return { ok: false, reason: "digits" };
  if (/[\s\-–—]/u.test(t)) return { ok: false, reason: "one_word" };
  if (/[^\p{L}]/u.test(t)) return { ok: false, reason: "bad_chars" };
  const len = Array.from(t).length;
  if (len < CLUE_MIN) return { ok: false, reason: "short" };
  if (len > CLUE_MAX) return { ok: false, reason: "long" };
  if (scripts(t) > 1) return { ok: false, reason: "mixed" };
  if (!Number.isInteger(num) || num < 1 || num > NUM_MAX) return { ok: false, reason: "bad_number" };
  if (ctx.left != null && num > ctx.left) return { ok: false, reason: "too_many" };
  if (ctx.words) {
    const hit = ctx.words.find((w) => wordsClash(t, w));
    if (hit) return { ok: false, reason: "on_board", word: hit };
  }
  // то же слово уже звучало в этой партии (после пустого хода капитан повторял его — игра принимала)
  if (ctx.used && ctx.used.includes(fold(t))) return { ok: false, reason: "used" };
  return { ok: true, word: t, n: num };
}


class Game {
  constructor(state, rnd, content) {
    this.s = state;
    this.rnd = rnd;
    this.content = content || {};
    this.tapGuard = null; // тесты обнуляют: защита от случайного касания после подсказки (TAP_GUARD_MS)
  }

  static create({ settings, code = "", rnd, content } = {}) {
    return new Game({
      code,
      settings: clampSettings(settings),
      phase: "lobby", // lobby | draw | clue | guess | swap | finished
      players: [],
      game: 0,
      team: null, // чей ход
      starter: null,
      caps: { red: null, blue: null }, // капитаны текущей партии
      claim: { red: null, blue: null }, // «хочу быть капитаном» (лобби, итоги)
      prevCaps: { red: null, blue: null },
      board: [], // {w|p, t: "red"|"blue"|"n"|"x", o: bool, by: id|null}
      clue: null, // {word, n, team, by}
      opened: 0, // своих слов открыто в этом ходу
      turnOpens: [], // [{i, t, by}] ходa
      log: [], // завершённые ходы {team, word, n, hits:[{i,t}], end}
      lastOpen: null, // {i, t, by, seq} — для анимации переворота
      usedClues: [], // подсказки партии (свёрнутые): повторять нельзя
      idleTurns: 0, // пустых ходов подряд (без подсказки или без единого тапа)
      capChange: null, // {team, playerId, reason: offline|left, seq} — последняя смена капитана посреди партии, для табло и телефонов
      prevStarter: null,
      phaseStart: null,
      phaseEnd: null,
      winner: null,
      finishedReason: null,
      wins: { red: 0, blue: 0 },
      used: { ru: [], en: [], el: [], pics: [] }, // сыгранные слова/картинки: не повторяем, пока банк не пройден
      awards: null,
      seq: 0,
    }, rnd, content);
  }

  static from(state, rnd, content) {
    return new Game(state, rnd, content);
  }

  // ---------- участники ----------

  player(id) { return this.s.players.find((p) => p.id === id); }
  present() { return this.s.players.filter((p) => !p.left); }
  members(team) { return this.present().filter((p) => p.team === team); }
  operatives(team) { return this.members(team).filter((p) => p.id !== this.s.caps[team]); }

  addPlayer({ id, name, now = null }) {
    const s = this.s;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    if (this.present().length >= MAX_PLAYERS) {
      const stage = s.phase === "lobby" ? "lobby" : s.phase === "finished" ? "finished" : null;
      const victim = stage && Number.isFinite(now) ? presence.evictOldestGhost(this.present(), { now, stage }) : null;
      if (!victim) return { ok: false, reason: "room_full" };
      this.removePlayer(victim, now);
    }
    name = cleanName(name);
    if (!name) return { ok: false, reason: "bad_name" };
    if (s.players.length >= MAX_PLAYERS * 3) return { ok: false, reason: "room_full" };
    const used = new Set(this.present().map((p) => p.color));
    const usedAv = new Set(this.present().map((p) => p.avatar));
    const midGame = s.phase !== "lobby" && s.phase !== "finished";
    const p = {
      id,
      name,
      color: COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length],
      avatar: AVATARS.find((a) => !usedAv.has(a)) || AVATARS[s.players.length % AVATARS.length],
      online: true,
      left: false,
      team: null,
      stats: this.freshStats(),
      lastReact: null,
      joinedAt: now,
    };
    // вошёл посреди партии — оперативник в команде, где меньше людей
    if (midGame) {
      const r = this.members("red").length, b = this.members("blue").length;
      p.team = r < b ? "red" : b < r ? "blue" : TEAMS[this.rnd(2)];
    }
    s.players.push(p);
    return { ok: true, player: p };
  }

  freshStats() { return { hits: 0, misses: 0, assassin: 0 }; }

  removePlayer(id, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p) return [];
    const wasCap = TEAMS.find((t) => s.caps[t] === id);
    for (const t of TEAMS) if (s.claim[t] === id) s.claim[t] = null;
    if (s.phase === "lobby" || s.phase === "finished") {
      s.players = s.players.filter((x) => x !== p);
      return [{ type: "left", playerId: id }];
    }
    if (p.left) return [];
    p.left = true;
    const ev = [{ type: "left", playerId: id }];
    const team = p.team;
    if (team && this.members(team).length === 0) return ev.concat(this.finish("few", other(team), now));
    if (wasCap) {
      const next = this.pickCaptain(team, id);
      if (next) {
        s.caps[team] = next;
        this.noteCaptain(team, next, "left");
        ev.push({ type: "captain", team, playerId: next, reason: "left" });
        if (s.phase === "clue" && s.team === team) s.phaseEnd = now + T.clue; // новому капитану — полное время
      }
    }
    return ev;
  }

  // следующий по списку команды после prev, предпочтительно на связи
  pickCaptain(team, prev) {
    const m = this.members(team).filter((x) => x.id !== prev);
    if (!m.length) return null;
    const all = this.members(team);
    const at = all.findIndex((x) => x.id === prev);
    const ring = at < 0 ? m : all.slice(at + 1).concat(all.slice(0, at + 1)).filter((x) => x.id !== prev);
    return (ring.find((x) => x.online !== false) || ring[0]).id;
  }

  setOnline(id, online, now) {
    const p = this.player(id);
    if (p) presence.setOnline(p, online, now);
    return [];
  }

  purgeGhosts(now, ttlMs) {
    const s = this.s;
    const stage = s.phase === "lobby" ? "lobby" : s.phase === "finished" ? "finished" : null;
    if (!stage) return [];
    const ids = presence.ghostsToDrop({ players: this.present(), now, stage, ttlMs, earnedKeys: [] });
    let ev = [];
    for (const id of ids) ev = ev.concat(this.removePlayer(id, now));
    return ev;
  }

  // ---------- команды и капитаны (лобби, итоги) ----------

  setTeam(id, team) {
    const s = this.s;
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "game_started" };
    if (team !== null && !TEAMS.includes(team)) return { ok: false, reason: "bad_team" };
    p.team = team;
    for (const t of TEAMS) if (s.claim[t] === id && t !== team) s.claim[t] = null;
    return { ok: true, events: [{ type: "team", playerId: id, team }] };
  }

  // «Хочу быть капитаном»: первый нажавший; он же нажимает ещё раз — отказывается
  claimCaptain(id) {
    const s = this.s;
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "game_started" };
    if (!p.team) return { ok: false, reason: "no_team" };
    if (s.claim[p.team] === id) s.claim[p.team] = null;
    else if (s.claim[p.team]) return { ok: false, reason: "captain_taken" };
    else s.claim[p.team] = id;
    return { ok: true, events: [{ type: "claim", playerId: id, team: p.team }] };
  }

  // ---------- старт ----------

  bank() {
    const s = this.s;
    return s.settings.mode === "pics" ? this.content.pics || [] : this.content[s.settings.lang] || [];
  }

  // 25 карточек: без общих основ (слова) и не больше двух из одной группы (картинки); сыгранные не повторяем, пока банк не пройден
  pickCards() {
    const s = this.s;
    const pics = s.settings.mode === "pics";
    const key = pics ? "pics" : s.settings.lang;
    const bank = this.bank();
    const idOf = (x) => (pics ? x.id : x);
    const usedSet = () => new Set(s.used[key] || []);
    let pool = bank.filter((x) => !usedSet().has(idOf(x)));
    if (pool.length < SIZE * 2) { s.used[key] = []; pool = bank.slice(); }
    const order = pool.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = this.rnd(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    const out = [];
    const groups = {};
    for (const x of order) {
      if (out.length >= SIZE) break;
      if (pics) {
        if ((groups[x.g] || 0) >= MAX_PICS_PER_GROUP) continue;
        groups[x.g] = (groups[x.g] || 0) + 1;
        out.push({ p: x.id });
      } else {
        if (out.some((c) => boardClash(c.w, x))) continue;
        out.push({ w: x });
      }
    }
    if (out.length < SIZE) return null;
    s.used[key] = (s.used[key] || []).concat(out.map((c) => c.p || c.w)).slice(-bank.length);
    return out;
  }

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    presence.pruneOfflineForNewGame(this.present(), { now });
    const ps = this.present();
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players", need: MIN_PLAYERS - ps.length };
    // неразобранных раскидываем случайно по меньшей команде
    const loose = ps.filter((p) => !p.team);
    for (let i = loose.length - 1; i > 0; i--) { const j = this.rnd(i + 1); [loose[i], loose[j]] = [loose[j], loose[i]]; }
    for (const p of loose) {
      const r = this.members("red").length, b = this.members("blue").length;
      p.team = r < b ? "red" : b < r ? "blue" : TEAMS[this.rnd(2)];
    }
    const red = this.members("red").length, blue = this.members("blue").length;
    if (red < MIN_TEAM || blue < MIN_TEAM) {
      // распределение руками оставило команду без людей: возвращаем «неразобранных» в лобби
      for (const p of loose) p.team = null;
      return { ok: false, reason: "team_small", red, blue };
    }
    if (this.bank().length < SIZE) return { ok: false, reason: "no_content" };
    const cards = this.pickCards();
    if (!cards) return { ok: false, reason: "no_content" };
    s.game++;
    s.players = ps; // ушедшие в прошлой партии больше не нужны
    for (const p of ps) p.stats = this.freshStats();
    // капитаны: заявка → иначе по кругу после прошлого → иначе случайный
    for (const t of TEAMS) {
      const m = this.members(t);
      const claimed = m.find((x) => x.id === s.claim[t]);
      const prev = s.prevCaps[t] && m.some((x) => x.id === s.prevCaps[t]) ? s.prevCaps[t] : null;
      s.caps[t] = claimed ? claimed.id : prev ? this.pickCaptain(t, prev) : m[this.rnd(m.length)].id;
      s.claim[t] = null;
    }
    s.prevCaps = { red: s.caps.red, blue: s.caps.blue };
    s.starter = s.prevStarter ? other(s.prevStarter) : TEAMS[this.rnd(2)]; // первый ход чередуется: перевес 9:8 справедливо делится
    s.prevStarter = s.starter;
    s.team = s.starter;
    s.usedClues = [];
    s.idleTurns = 0;
    s.capChange = null;
    const tags = [];
    for (let i = 0; i < STARTER_CARDS; i++) tags.push(s.starter);
    for (let i = 0; i < OTHER_CARDS; i++) tags.push(other(s.starter));
    for (let i = 0; i < NEUTRAL_CARDS; i++) tags.push("n");
    tags.push("x");
    for (let i = tags.length - 1; i > 0; i--) { const j = this.rnd(i + 1); [tags[i], tags[j]] = [tags[j], tags[i]]; }
    s.board = cards.map((c, i) => ({ ...c, t: tags[i], o: false, by: null }));
    s.clue = null;
    s.opened = 0;
    s.turnOpens = [];
    s.log = [];
    s.lastOpen = null;
    s.winner = null;
    s.finishedReason = null;
    s.awards = null;
    s.phase = "draw";
    s.phaseStart = now;
    s.phaseEnd = now + T.draw;
    return { ok: true, events: [{ type: "started", game: s.game, starter: s.starter }] };
  }

  // ---------- ход ----------

  left(team) { return this.s.board.filter((c) => c.t === team && !c.o).length; }

  captain() { return this.s.caps[this.s.team]; }

  clue(id, text, num, now) {
    const s = this.s;
    if (s.phase !== "clue") return { ok: false, reason: "bad_phase" };
    if (id !== s.caps[s.team]) return { ok: false, reason: "not_captain" };
    const words = s.settings.mode === "words" ? s.board.map((c) => c.w) : null;
    const r = checkClue(text, num, { left: this.left(s.team), words, used: s.usedClues });
    if (!r.ok) return r.word ? { ok: false, reason: r.reason, word: r.word } : { ok: false, reason: r.reason };
    s.clue = { word: r.word, n: r.n, team: s.team, by: id, at: now };
    s.usedClues.push(fold(r.word));
    s.opened = 0;
    s.turnOpens = [];
    s.phase = "guess";
    s.phaseStart = now;
    // оперативник один — обсуждать не с кем, ход короче
    s.phaseEnd = now + (this.operatives(s.team).filter((o) => o.online !== false).length <= 1 ? T.guessSolo : T.guess);
    return { ok: true, events: [{ type: "clue", team: s.team, word: r.word, n: r.n }] };
  }

  // кто может открывать: оперативник ходящей команды; капитан — только если у команды больше никого нет
  canOpen(p) {
    const s = this.s;
    if (!p || p.left || p.team !== s.team) return false;
    if (p.id !== s.caps[s.team]) return true;
    // капитан открывает сам, когда оперативников нет вовсе или все не на связи (иначе команда стояла бы до конца таймера)
    return this.operatives(s.team).every((o) => o.online === false);
  }

  open(id, i, now) {
    const s = this.s;
    if (s.phase !== "guess") return { ok: false, reason: "bad_phase" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (p.team !== s.team) return { ok: false, reason: "not_your_turn" };
    if (!this.canOpen(p)) return { ok: false, reason: "captain" };
    const guard = this.tapGuard == null ? TAP_GUARD_MS : this.tapGuard;
    if (guard > 0 && s.clue && now - s.clue.at < guard) return { ok: false, reason: "too_soon" };
    if (!Number.isInteger(i) || i < 0 || i >= s.board.length) return { ok: false, reason: "bad_idx" };
    const c = s.board[i];
    if (c.o) return { ok: false, reason: "already_open" };
    c.o = true;
    c.by = id;
    s.seq++;
    s.lastOpen = { i, t: c.t, by: id, seq: s.seq };
    s.turnOpens.push({ i, t: c.t, by: id });
    const ev = [{ type: "open", i, t: c.t, by: id, team: s.team }];
    if (c.t === "x") {
      p.stats.assassin++;
      return { ok: true, events: ev.concat(this.finish("assassin", other(s.team), now)) };
    }
    if (c.t === s.team) p.stats.hits++; else p.stats.misses++;
    // собрал все свои — победа, даже если последнее слово открыла чужая команда
    for (const t of TEAMS) if (this.left(t) === 0) return { ok: true, events: ev.concat(this.finish("cleared", t, now)) };
    if (c.t === s.team) {
      s.opened++;
      if (s.opened >= s.clue.n) return { ok: true, events: ev.concat(this.endTurn("limit", now)) };
      return { ok: true, events: ev };
    }
    return { ok: true, events: ev.concat(this.endTurn(c.t === "n" ? "neutral" : "enemy", now)) };
  }

  // «Хватит»: закончить ход — не раньше первого открытого слова
  stop(id, now) {
    const s = this.s;
    if (s.phase !== "guess") return { ok: false, reason: "bad_phase" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (p.team !== s.team) return { ok: false, reason: "not_your_turn" };
    if (!this.canOpen(p)) return { ok: false, reason: "captain" };
    if (!s.turnOpens.length) return { ok: false, reason: "none_yet" };
    return { ok: true, events: this.endTurn("stop", now) };
  }

  endTurn(reason, now) {
    const s = this.s;
    s.log.push({ team: s.team, word: s.clue ? s.clue.word : null, n: s.clue ? s.clue.n : null, hits: s.turnOpens.map((o) => ({ i: o.i, t: o.t })), end: reason });
    if (s.log.length > 60) s.log = s.log.slice(-60);
    const ev = [{ type: "turn_end", team: s.team, reason }];
    s.idleTurns = !s.turnOpens.length && reason === "time" ? s.idleTurns + 1 : reason === "skip" ? s.idleTurns : 0;
    s.team = other(s.team);
    s.clue = null;
    s.opened = 0;
    s.turnOpens = [];
    s.phase = "swap";
    s.phaseStart = now;
    s.phaseEnd = now + T.swap;
    return ev;
  }

  // ---------- таймеры ----------

  // капитан ходящей команды оффлайн дольше CAP_GRACE_MS — срок, когда роль уходит дальше
  capDue() {
    const s = this.s;
    if (s.phase !== "clue") return null;
    const cap = this.player(s.caps[s.team]);
    if (!cap || cap.left || cap.online !== false || cap.offSince == null) return null;
    if (!this.pickCaptain(s.team, cap.id)) return null;
    return cap.offSince + CAP_GRACE_MS;
  }

  nextDeadline() {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished" || s.phaseEnd == null) return null;
    const cd = this.capDue();
    return cd != null ? Math.min(cd, s.phaseEnd) : s.phaseEnd;
  }

  // роль капитана перешла (офлайн дольше CAP_GRACE_MS или ушёл): запоминаем причину — табло и телефоны объяснят игрокам, что случилось
  noteCaptain(team, playerId, reason) {
    const s = this.s;
    s.seq++;
    s.capChange = { team, playerId, reason, seq: s.seq };
  }

  tick(now) {
    const s = this.s;
    if (s.phaseEnd == null) return [];
    const cd = this.capDue();
    if (cd != null && now >= cd && now < s.phaseEnd) {
      const old = s.caps[s.team];
      const next = this.pickCaptain(s.team, old);
      s.caps[s.team] = next;
      s.phaseStart = now;
      s.phaseEnd = now + T.clue;
      this.noteCaptain(s.team, next, "offline");
      return [{ type: "captain", team: s.team, playerId: next, reason: "offline" }];
    }
    if (now < s.phaseEnd) return [];
    switch (s.phase) {
      case "draw": s.phase = "clue"; s.phaseStart = now; s.phaseEnd = now + T.clue; return [];
      case "swap":
        // три пустых хода подряд — все ушли пить чай: партия встаёт на паузу, пока кто-нибудь не нажмёт «Играем»
        if (s.idleTurns >= IDLE_TURNS) {
          s.phase = "paused";
          s.phaseStart = now;
          s.phaseEnd = null;
          return [{ type: "paused" }];
        }
        s.phase = "clue"; s.phaseStart = now; s.phaseEnd = now + T.clue; return [];
      case "clue": {
        // капитан не успел: ход переходит к сопернику (🐌)
        const team = s.team;
        const skipped = this.skipping;
        s.log.push({ team, word: null, n: null, hits: [], end: skipped ? "skip" : "noclue" });
        if (!skipped) s.idleTurns++;
        s.team = other(team);
        s.phase = "swap";
        s.phaseStart = now;
        s.phaseEnd = now + T.swap;
        return [{ type: "turn_end", team, reason: skipped ? "skip" : "noclue" }];
      }
      case "guess": return this.endTurn(this.skipping ? "skip" : "time", now);
      default: return [];
    }
  }

  // «Играем!» после паузы: любой игрок или ведущий; ход начинается с подсказки со свежим таймером
  resume(now) {
    const s = this.s;
    if (s.phase !== "paused") return { ok: false, reason: "bad_phase" };
    s.idleTurns = 0;
    s.phase = "clue";
    s.phaseStart = now;
    s.phaseEnd = now + T.clue;
    return { ok: true, events: [{ type: "resumed" }] };
  }

  // ---------- конец ----------

  awards() {
    const s = this.s;
    const out = [];
    const top = (key, minValue) => {
      const ranked = this.present().map((p) => ({ id: p.id, v: p.stats[key] || 0 })).filter((x) => x.v >= minValue).sort((a, b) => b.v - a.v);
      if (!ranked.length || (ranked[1] && ranked[1].v === ranked[0].v)) return null;
      return ranked[0];
    };
    const sniper = top("hits", 2);
    if (sniper) out.push({ key: "sniper", playerId: sniper.id, value: sniper.v });
    const oops = top("misses", 2);
    if (oops) out.push({ key: "oops", playerId: oops.id, value: oops.v });
    const trap = this.present().find((p) => p.stats.assassin > 0);
    if (trap) out.push({ key: "trap", playerId: trap.id, value: 1 });
    // подсказка, собравшая больше всего слов за ход
    let best = null;
    for (const e of s.log) {
      const n = e.hits.filter((h) => h.t === e.team).length;
      if (e.word && n >= 2 && (!best || n > best.n)) best = { word: e.word, n, team: e.team };
    }
    if (best) out.push({ key: "clue", team: best.team, word: best.word, value: best.n });
    return out;
  }

  finish(reason, winner, now) {
    const s = this.s;
    if (s.turnOpens.length && s.clue) s.log.push({ team: s.team, word: s.clue.word, n: s.clue.n, hits: s.turnOpens.map((o) => ({ i: o.i, t: o.t })), end: reason });
    s.phase = "finished";
    s.phaseStart = now;
    s.phaseEnd = null;
    s.finishedReason = reason;
    s.winner = winner || null;
    if (winner) s.wins[winner]++;
    s.clue = null;
    s.awards = this.awards();
    return [{ type: "final", reason, winner: s.winner }];
  }

  toLobby(now) {
    const s = this.s;
    const ev = s.phase === "lobby" || s.phase === "finished" ? [] : this.finish("host", null, now);
    s.phase = "lobby";
    s.players = s.players.filter((p) => !p.left);
    s.board = [];
    s.clue = null;
    s.log = [];
    s.team = null;
    s.winner = null;
    s.lastOpen = null;
    s.wins = { red: 0, blue: 0 };
    s.claim = { red: null, blue: null };
    s.prevCaps = { red: null, blue: null };
    for (const p of s.players) p.team = null;
    return ev.concat([{ type: "lobby" }]);
  }

  // «Дальше» ведущего: фаза закрывается как по таймеру
  skip(now) {
    const s = this.s;
    if (s.phase === "paused") return this.resume(now);
    if (!["draw", "clue", "guess", "swap"].includes(s.phase) || s.phaseEnd == null) return { ok: false, reason: "bad_phase", events: [] };
    if (now - s.phaseStart < SKIP_MIN_MS) return { ok: false, reason: "too_early", events: [] };
    s.phaseEnd = now;
    this.skipping = true; // «Дальше» ведущего — не «время вышло»: в журнале ход так и подписан и пустым не считается
    try { return { ok: true, events: this.tick(now) }; } finally { this.skipping = false; }
  }

  abort(now) {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished") return [];
    return this.finish("host", null, now);
  }

  react(id, emoji, now) {
    const p = this.player(id);
    if (!p || !REACTIONS.includes(emoji)) return { ok: false, reason: "bad" };
    if (p.lastReact != null && now - p.lastReact < REACT_GAP) return { ok: false, reason: "too_fast" };
    p.lastReact = now;
    return { ok: true, events: [{ type: "react", playerId: id, emoji }] };
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

  rename(id, name) {
    const s = this.s;
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "game_started" };
    const n = cleanName(name);
    if (!n) return { ok: false, reason: "bad_name" };
    if (this.present().some((x) => x !== p && nameKey(x.name) === nameKey(n))) return { ok: false, reason: "name_taken" };
    p.name = n;
    return { ok: true, events: [{ type: "rename", playerId: id }] };
  }

  // ---------- снимок для клиентов ----------

  /*
   * view: "board" — доска, иначе id игрока. Раскладка (t) уходит только капитанам и всем — когда партия кончена;
   * на закрытой карточке остальные видят только слово/картинку.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const inGame = s.board.length > 0;
    const isCap = !!me && TEAMS.some((t) => s.caps[t] === me.id) && s.phase !== "lobby";
    const reveal = s.phase === "finished" || isCap;
    const cards = inGame ? s.board.map((c) => {
      const o = c.w !== undefined ? { w: c.w } : { p: c.p };
      o.o = c.o;
      if (c.o) o.by = c.by;
      if (c.o || reveal) o.t = c.t;
      return o;
    }) : null;
    const counts = inGame ? Object.fromEntries(TEAMS.map((t) => [t, { total: s.board.filter((c) => c.t === t).length, left: this.left(t) }])) : null;
    const mePart = me ? {
      id: me.id,
      team: me.team,
      captain: !!isCap && TEAMS.some((t) => s.caps[t] === me.id),
      canOpen: s.phase === "guess" && this.canOpen(me),
      tapAt: s.clue ? s.clue.at + TAP_GUARD_MS : null,
      claim: TEAMS.find((t) => s.claim[t] === me.id) || null,
    } : null;
    return {
      phase: s.phase,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      game: s.game,
      team: s.team,
      starter: s.starter,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      caps: s.phase === "lobby" ? { red: null, blue: null } : s.caps,
      claim: s.phase === "lobby" || s.phase === "finished" ? s.claim : null,
      board: cards,
      counts,
      clue: s.clue,
      opened: s.opened,
      lastOpen: s.lastOpen,
      capChange: s.capChange,
      paused: s.phase === "paused",
      log: s.log,
      winner: s.phase === "finished" ? s.winner : null,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      awards: s.phase === "finished" ? s.awards : null,
      wins: s.wins,
      minPlayers: MIN_PLAYERS,
      minTeam: MIN_TEAM,
      avatarChoices: s.phase === "lobby" || s.phase === "finished" ? AVATAR_CHOICES : null,
      clueMax: CLUE_MAX,
      numMax: NUM_MAX,
      me: mePart,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        online: p.online,
        left: p.left,
        team: p.team,
        cap: s.phase !== "lobby" && TEAMS.some((t) => s.caps[t] === p.id),
        ...(s.phase === "finished" ? { hits: p.stats.hits, misses: p.stats.misses } : {}),
      })),
    };
  }
}

module.exports = {
  Game, T, TAP_GUARD_MS, IDLE_TURNS, EXTRA_MS, DEFAULTS, MAX_PLAYERS, MIN_PLAYERS, MIN_TEAM, SIZE, STARTER_CARDS, OTHER_CARDS, NEUTRAL_CARDS, MAX_PICS_PER_GROUP,
  CAP_GRACE_MS, CLUE_MAX, NUM_MAX, REACTIONS, COLORS, AVATARS, AVATAR_CHOICES, TEAMS,
  clampSettings, cleanName, cleanText, checkClue, wordsClash, boardClash, nameKey, other,
};
