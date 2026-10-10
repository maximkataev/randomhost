"use strict";

/*
 * Движок «Как все»: чистая логика без сети и таймеров (docs/crowd-spec.md v2).
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1. Банк вопросов — снаружи (content[lang] = [{id, q, a, b, kind, tag, lean, sensitive}]).
 *
 * Раунд: [intro (финал/допвопрос/решающий)] → vote → [opinion] → reveal → scores → следующий раунд или finished.
 * Тайны (§8, §10): до начала раскрытия никому не уходят чужие голоса, ва-банк других, мнения и порядок показа.
 * Очки считаются при закрытии голосования, но начисляются и показываются только с начала раскрытия.
 */

const T = {
  intro: 3000, // заставка финала / допвопроса / решающего
  vote: 25000, // 5 с читают (кнопки уже активны) + 20 с на голос
  opinion: 6000,
  reveal: 4000, // + REVEAL_STEP на каждый голос (+ REVEAL_OPINION, если было «Мнение»)
  scores: 4000,
  pause: 60000,
};
const REVEAL_STEP = 600;
const REVEAL_OPINION = 3500;
const REVEAL_VOID = 3000;

const DEFAULTS = {
  short: false, // короткая партия: 6 вопросов и один ва-банк
  opinion: true, // фаза «Мнение» (работает только при ≥ 4 игроках)
  lang: "ru",
};

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;
const MIN_CAST = 3; // меньше голосов — раунд аннулируется
const OPINION_MIN_PLAYERS = 4;
const TOTAL = { full: 10, short: 6 };
const BANKS = { full: 2, short: 1 };
const MAX_VOIDS = 2; // замен аннулированных вопросов за партию
const POINTS = { win: 100, flat: 50, bankWin: 200, bankLoss: -200 };
const UNANIMOUS_MIN = 4;
const WOLF_MIN = 4;
const ILLUSION_MIN = 4;
const ILLUSION_SHARE = 0.6;
const LEAN_B_MIN = 0.4; // доля вопросов партии с ожидаемым большинством «НЕТ»/«Б» (§5)
const LEAN_B_MAX = 0.5;

// цвета и аватары — как в соседних играх (имя заметно на любой заливке)
const COLORS = ["#e0115f", "#1438e0", "#0a8a4a", "#e25a00", "#7b1fd6", "#008b9a", "#b8006e", "#6b4a00", "#2c2cad", "#b31010", "#3d6b00", "#c77700"];
const AVATARS = ["🐙", "🦊", "🐸", "🦉", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐳", "🦩"];

function clampSettings(input = {}) {
  const s = { ...DEFAULTS };
  if (typeof input.short === "boolean") s.short = input.short;
  if (typeof input.opinion === "boolean") s.opinion = input.opinion;
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  return s;
}

// без управляющих и невидимых символов, без лишних пробелов
const CTRL = /[\u0000-\u001f\u007f-\u009f­͏᠎​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const INVIS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const ZWJ_OK = /(\p{Extended_Pictographic}️?)‍(?=\p{Extended_Pictographic})/gu;
function cleanText(text, max) {
  const t = String(text == null ? "" : text).replace(CTRL, "").replace(ZWJ_OK, "$1\u0001").replace(INVIS, "").replace(/\u0001/g, "‍");
  return Array.from(t.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}
// латиница/кириллица/греческий-двойники не отличают «Саша» от «Сaшa»
const SKEL = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ё: "e",
  α: "a", β: "b", ε: "e", η: "h", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "y", χ: "x", ς: "c" };
const skeleton = (w) => w.replace(/[авекмнорстухёαβεηικμνορτυχς]/g, (ch) => SKEL[ch]);
const nameKey = (n) => skeleton(String(n || "").normalize("NFKC").toLowerCase()).replace(/[\s‍]+/g, "");
const cleanName = (name) => cleanText(name, 16);

// детерминированный ГСЧ для порядка показа голосов (от seed раунда)
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

/*
 * Режиссёрский порядок показа голосов (§8). Итог не меняет, только порядок появления.
 * k — голосов за победившую сторону, m — за проигравшую (при «Расколе» k = m).
 */
function revealOrder(sideA, sideB, winner, seed) {
  const rand = mulberry32(seed);
  const a = shuffled(sideA, rand), b = shuffled(sideB, rand);
  if (!winner) {
    // «Раскол»: чередуем, старт по seed
    const first = rand() < 0.5 ? a : b, second = first === a ? b : a;
    return interleave(first, second);
  }
  const maj = winner === "a" ? a : b, min = winner === "a" ? b : a;
  const diff = maj.length - min.length;
  if (diff >= 3) return shuffled(a.concat(b), rand);
  // diff 1 или 2: чередуем, начиная с меньшинства; остаток большинства — в конце (решающий голос последним)
  return interleave(min, maj);
}
function interleave(first, second) {
  const out = [];
  const x = first.slice(), y = second.slice();
  while (x.length || y.length) {
    if (x.length) out.push(x.shift());
    if (y.length) out.push(y.shift());
  }
  return out;
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
      phase: "lobby", // lobby | intro | vote | opinion | reveal | scores | pause | finished
      players: [],
      game: 0,
      n: 0, // сыгранных вопросов партии (без допвопроса и решающего)
      voidsUsed: 0,
      voidStreak: 0,
      extraDone: false,
      deciderDone: false,
      sensUsed: 0,
      leanB: 0,
      drawn: 0,
      phaseStart: null,
      phaseEnd: null,
      round: null, // текущий раунд (см. startRound)
      next: null, // что запускать после «scores» / паузы
      used: { ru: [], en: [], el: [] }, // сыгранные id вопросов: не повторяем, пока банк не пройден
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

  total() {
    return this.s.settings.short ? TOTAL.short : TOTAL.full;
  }

  banksTotal() {
    return this.s.settings.short ? BANKS.short : BANKS.full;
  }

  freshStats() {
    return { hits: 0, misses: 0, wolf: 0, bankNet: 0, banksUsed: 0 };
  }

  addPlayer({ id, name, now = null }) {
    const s = this.s;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    if (this.present().length >= MAX_PLAYERS) return { ok: false, reason: "room_full" };
    name = cleanName(name);
    if (!name) return { ok: false, reason: "bad_name" };
    // ушедшие посреди партии копятся в списке (их очки нужны итогам), но не бесконечно
    if (s.players.length >= MAX_PLAYERS * 3) return { ok: false, reason: "room_full" };
    const used = new Set(this.present().map((p) => p.color));
    const usedAv = new Set(this.present().map((p) => p.avatar));
    const inGame = s.phase !== "lobby" && s.phase !== "finished";
    const left = Math.max(0, this.total() - s.n);
    const p = {
      id,
      name,
      color: COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length],
      avatar: AVATARS.find((a) => !usedAv.has(a)) || AVATARS[s.players.length % AVATARS.length],
      online: true,
      left: false,
      score: 0,
      // вошедший посреди партии получает ва-банки пропорционально оставшимся вопросам, минимум один (§2)
      banks: inGame ? Math.max(1, Math.round((this.banksTotal() * left) / this.total())) : this.banksTotal(),
      stats: this.freshStats(),
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

  // ---------- банк вопросов ----------

  bank() {
    const lang = this.s.settings.lang;
    return this.content[lang] || this.content.ru || [];
  }

  /*
   * Вопрос без повторов в комнате (банк пройден — забываем сыгранное).
   * Баланс партии (§5): не меньше 40 % вопросов с ожидаемым большинством «НЕТ»/«Б» и не больше 50 %;
   * «чувствительный» вопрос — не чаще одного за партию.
   */
  takeQuestion(kind) {
    const s = this.s;
    const lang = s.settings.lang;
    const all = this.bank();
    let used = new Set(s.used[lang] || []);
    let free = all.filter((x) => !used.has(x.id));
    if (free.length < 8) { s.used[lang] = []; used = new Set(); free = all.slice(); }
    let pool = free.filter((x) => !(x.sensitive && s.sensUsed >= 1));
    if (!pool.length) pool = free;
    const main = kind === "normal" || kind === "final";
    if (main) {
      const total = this.total();
      const needB = Math.ceil(LEAN_B_MIN * total) - s.leanB;
      const slots = total - s.drawn;
      const maxB = Math.floor(LEAN_B_MAX * total);
      let want = null;
      if (needB >= slots) want = "b";
      else if (s.leanB >= maxB) want = "a";
      if (want) {
        const sub = pool.filter((x) => (x.lean === "b" ? "b" : "a") === want);
        if (sub.length) pool = sub;
      }
    }
    const q = pool[this.rnd(pool.length)] || all[this.rnd(Math.max(1, all.length))];
    (s.used[lang] = s.used[lang] || []).push(q.id);
    if (q.sensitive) s.sensUsed++;
    if (main) { s.drawn++; if (q.lean === "b") s.leanB++; }
    return { id: q.id, q: q.q, a: q.a, b: q.b, kind: q.kind === "ab" ? "ab" : "yn", tag: q.tag || "" };
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    const ps = this.present();
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    if (this.bank().length < 8) return { ok: false, reason: "no_content" };
    s.game++;
    s.n = 0;
    s.voidsUsed = 0;
    s.voidStreak = 0;
    s.extraDone = false;
    s.deciderDone = false;
    s.sensUsed = 0;
    s.leanB = 0;
    s.drawn = 0;
    s.round = null;
    s.next = null;
    s.awards = null;
    s.finishedReason = null;
    s.players = ps; // ушедшие в прошлой партии больше не нужны
    for (const p of ps) { p.score = 0; p.banks = this.banksTotal(); p.stats = this.freshStats(); p.joinedAt = null; }
    return { ok: true, events: [{ type: "started", game: s.game }, ...this.startRound("normal", now)] };
  }

  // kind: normal | final | extra | decider. Основные вопросы партии определяют normal/final по счётчику
  startRound(kind, now, only = null) {
    const s = this.s;
    if (kind === "normal" || kind === "final") kind = s.n >= this.total() - 1 ? "final" : "normal";
    const q = this.takeQuestion(kind);
    s.round = {
      kind,
      num: kind === "normal" || kind === "final" ? s.n + 1 : null,
      q,
      votes: {}, // playerId → 'a'|'b' (выбранная сторона)
      confirmed: {},
      bank: {},
      opinions: {}, // playerId → 'a'|'b'|'skip'
      seed: this.rnd(1 << 30),
      only, // решающий вопрос: очки только у этих игроков
      start: null,
      result: null,
    };
    s.next = null;
    if (kind === "normal") return this.openVote(now);
    s.phase = "intro";
    s.phaseStart = now;
    s.phaseEnd = now + T.intro;
    return [{ type: "intro", kind }];
  }

  openVote(now) {
    const s = this.s;
    s.phase = "vote";
    s.phaseStart = now;
    s.phaseEnd = now + T.vote;
    s.round.start = now;
    return [{ type: "question", kind: s.round.kind }];
  }

  mult() {
    const k = this.s.round && this.s.round.kind;
    return k === "final" || k === "extra" ? 2 : 1;
  }

  bankAllowed() {
    return !!this.s.round && this.s.round.kind === "normal";
  }

  // кто участвует в голосовании этого раунда: присутствующие, вошедшие не позже начала вопроса
  voters() {
    const r = this.s.round;
    return this.present().filter((p) => !(p.joinedAt != null && r && r.start != null && p.joinedAt > r.start));
  }

  vote(id, side, now) {
    const s = this.s;
    if (s.phase !== "vote") return { ok: false, reason: "not_vote" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    const r = s.round;
    if (p.joinedAt != null && p.joinedAt > r.start) return { ok: false, reason: "late" };
    if (side !== "a" && side !== "b") return { ok: false, reason: "bad_side" };
    if (r.confirmed[id]) return { ok: false, reason: "confirmed" };
    if (r.votes[id] === side) return { ok: true, events: [], noop: true };
    r.votes[id] = side;
    return { ok: true, events: [] };
  }

  bankToggle(id, on, now) {
    const s = this.s;
    if (s.phase !== "vote") return { ok: false, reason: "not_vote" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    const r = s.round;
    if (!this.bankAllowed()) return { ok: false, reason: "no_bank_here" };
    if (p.joinedAt != null && p.joinedAt > r.start) return { ok: false, reason: "late" };
    if (r.confirmed[id]) return { ok: false, reason: "confirmed" };
    const want = !!on;
    if (want && p.banks < 1) return { ok: false, reason: "no_banks" };
    if (!!r.bank[id] === want) return { ok: true, events: [], noop: true };
    if (want) r.bank[id] = true; else delete r.bank[id];
    return { ok: true, events: [] };
  }

  confirm(id, now) {
    const s = this.s;
    if (s.phase !== "vote") return { ok: false, reason: "not_vote" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    const r = s.round;
    if (p.joinedAt != null && p.joinedAt > r.start) return { ok: false, reason: "late" };
    if (!r.votes[id]) return { ok: false, reason: "pick_first" };
    if (r.confirmed[id]) return { ok: true, events: [], noop: true };
    r.confirmed[id] = true;
    return { ok: true, events: [{ type: "ready", playerId: id }, ...this.maybeAdvance(now)] };
  }

  opinion(id, side, now) {
    const s = this.s;
    if (s.phase !== "opinion") return { ok: false, reason: "not_opinion" };
    const r = s.round;
    if (!r.votes[id] || !r.cast.includes(id)) return { ok: false, reason: "not_voter" };
    const v = side === "skip" ? "skip" : side;
    if (v !== "a" && v !== "b" && v !== "skip") return { ok: false, reason: "bad_side" };
    if (r.opinions[id]) return { ok: false, reason: "answered" };
    r.opinions[id] = v;
    return { ok: true, events: this.maybeAdvance(now) };
  }

  readyToClose() {
    const s = this.s;
    const r = s.round;
    if (this.onlineCount() < MIN_PLAYERS) return false; // иначе «все подтвердили» было бы истинно и при нуле игроков
    const need = this.voters().filter((p) => p.online);
    if (s.phase === "vote") return need.every((p) => r.confirmed[p.id]);
    if (s.phase === "opinion") return need.filter((p) => r.cast.includes(p.id)).every((p) => r.opinions[p.id]);
    return false;
  }

  maybeAdvance(now) {
    const s = this.s;
    if (s.phase === "pause") return this.onlineCount() >= MIN_PLAYERS ? this.resume(now) : [];
    if ((s.phase === "vote" || s.phase === "opinion") && this.readyToClose()) {
      return s.phase === "vote" ? this.closeVote(now) : this.startReveal(now);
    }
    return [];
  }

  /*
   * Голосование закрыто: считаем итог (§2), но очки не начисляем и не показываем — они выходят с началом раскрытия.
   */
  closeVote(now) {
    const s = this.s;
    const r = s.round;
    const cast = this.voters().filter((p) => r.votes[p.id]).map((p) => p.id);
    r.cast = cast;
    const sideA = cast.filter((id) => r.votes[id] === "a");
    const sideB = cast.filter((id) => r.votes[id] === "b");
    const res = {
      void: cast.length < MIN_CAST,
      a: sideA.length, b: sideB.length, cast: cast.length,
      side: null, tie: false, unanimous: false, wolf: null,
      votes: {}, pts: {}, banked: {}, bankBack: {}, order: [],
      opinions: null, illusion: null,
    };
    r.result = res;
    if (res.void) {
      for (const id of cast) res.votes[id] = r.votes[id];
      for (const id of Object.keys(r.bank)) if (r.confirmed[id]) res.bankBack[id] = true;
      return this.afterVote(now);
    }
    res.tie = res.a === res.b;
    res.side = res.tie ? null : res.a > res.b ? "a" : "b";
    res.unanimous = cast.length >= UNANIMOUS_MIN && (res.a === 0 || res.b === 0);
    const m = this.mult();
    for (const id of cast) {
      const vote = r.votes[id];
      res.votes[id] = vote;
      const p = this.player(id);
      let base;
      let decisive = false;
      if (res.tie || res.unanimous) base = POINTS.flat;
      else { base = vote === res.side ? POINTS.win : 0; decisive = true; }
      let pts = base;
      const wantsBank = r.bank[id] && r.confirmed[id] && this.bankAllowed() && p.banks > 0;
      if (wantsBank && decisive) { pts = vote === res.side ? POINTS.bankWin : POINTS.bankLoss; res.banked[id] = true; }
      else if (wantsBank) res.bankBack[id] = true; // «Раскол» / «Как один!»: ва-банк возвращается
      res.pts[id] = pts * m;
    }
    if (r.only) for (const id of Object.keys(res.pts)) if (!r.only.includes(id)) delete res.pts[id];
    // «Одиночка»: ровно один против всех (§2)
    if (cast.length >= WOLF_MIN && !res.tie) {
      const loneSide = res.a === 1 ? "a" : res.b === 1 ? "b" : null;
      if (loneSide && res.side !== loneSide) res.wolf = cast.find((id) => r.votes[id] === loneSide) || null;
    }
    res.order = revealOrder(sideA, sideB, res.side, r.seed);
    return this.afterVote(now);
  }

  opinionOn() {
    return this.s.settings.opinion && this.present().length >= OPINION_MIN_PLAYERS && !this.s.round.result.void;
  }

  afterVote(now) {
    const s = this.s;
    if (!this.opinionOn()) return this.startReveal(now);
    s.phase = "opinion";
    s.phaseStart = now;
    s.phaseEnd = now + T.opinion;
    return [{ type: "opinion" }];
  }

  // раскрытие: здесь начисляются очки и считается «Иллюзия»
  startReveal(now) {
    const s = this.s;
    const r = s.round;
    const res = r.result;
    const hadOpinion = s.phase === "opinion";
    if (!res.void) {
      const decider = !!r.only;
      for (const [id, pts] of Object.entries(res.pts)) {
        const p = this.player(id);
        if (!p) continue;
        p.score += pts;
        if (res.banked[id]) { p.banks = Math.max(0, p.banks - 1); p.stats.banksUsed++; p.stats.bankNet += pts; }
      }
      if (!decider) {
        for (const id of res.order) {
          const p = this.player(id);
          if (!p || res.tie || res.unanimous) continue;
          if (res.votes[id] === res.side) p.stats.hits++; else p.stats.misses++;
        }
        const w = res.wolf && this.player(res.wolf);
        if (w) w.stats.wolf++;
      }
      if (hadOpinion) {
        let oa = 0, ob = 0, skip = 0;
        for (const v of Object.values(r.opinions)) { if (v === "a") oa++; else if (v === "b") ob++; else skip++; }
        res.opinions = { a: oa, b: ob, skip };
        const tot = oa + ob;
        if (tot >= ILLUSION_MIN && res.side && oa !== ob) {
          const opSide = oa > ob ? "a" : "b";
          const voteShare = Math.max(res.a, res.b) / res.cast;
          const opShare = Math.max(oa, ob) / tot;
          if (opSide !== res.side && voteShare >= ILLUSION_SHARE && opShare >= ILLUSION_SHARE) res.illusion = { vote: res.side, opinion: opSide };
        }
      }
    }
    s.phase = "reveal";
    s.phaseStart = now;
    s.phaseEnd = now + (res.void ? REVEAL_VOID : T.reveal + REVEAL_STEP * res.order.length + (res.opinions ? REVEAL_OPINION : 0));
    const events = [{ type: "reveal", void: res.void, tie: res.tie, side: res.side }];
    if (res.illusion) events.push({ type: "illusion" });
    if (!res.void && !r.only && res.cast >= 4) {
      events.push({ type: "qstat", id: r.q.id, a: res.a, b: res.b, oa: res.opinions ? res.opinions.a : 0, ob: res.opinions ? res.opinions.b : 0 });
    }
    return events;
  }

  /*
   * После «scores»: считаем ход партии и решаем, что дальше (§2, §5).
   * Аннулированный основной вопрос заменяется (не более MAX_VOIDS за партию); два аннулирования подряд — пауза.
   */
  afterRound(now) {
    const s = this.s;
    const r = s.round;
    const res = r.result;
    const main = r.kind === "normal" || r.kind === "final";
    let next;
    if (res.void) {
      s.voidStreak++;
      if (main && s.voidsUsed < MAX_VOIDS) { s.voidsUsed++; next = { to: "round" }; }
      else { if (main) s.n++; next = this.planAfter(r.kind, res); }
    } else {
      s.voidStreak = 0;
      if (main) s.n++;
      next = this.planAfter(r.kind, res);
    }
    if (next.to !== "finish" && (s.voidStreak >= 2 || this.onlineCount() < MIN_PLAYERS)) return this.pause(next, now);
    return this.run(next, now);
  }

  planAfter(kind, res) {
    const s = this.s;
    if (kind === "normal") return { to: "round" };
    if (kind === "final" && res.tie && !s.extraDone) return { to: "extra" };
    if (kind === "decider") return { to: "finish" };
    // финал / допвопрос закончены: лидеры с равным счётом решают отдельным вопросом
    if (!s.deciderDone) {
      const ps = this.present();
      const top = Math.max(...ps.map((p) => p.score));
      const tied = ps.filter((p) => p.score === top).map((p) => p.id);
      if (tied.length >= 2) return { to: "decider", only: tied };
    }
    return { to: "finish" };
  }

  run(plan, now) {
    const s = this.s;
    if (plan.to === "round") return this.startRound("normal", now);
    if (plan.to === "extra") { s.extraDone = true; return this.startRound("extra", now); }
    if (plan.to === "decider") { s.deciderDone = true; return this.startRound("decider", now, plan.only); }
    return this.finish("done", now);
  }

  pause(plan, now) {
    const s = this.s;
    s.next = plan;
    s.phase = "pause";
    s.phaseStart = now;
    s.phaseEnd = now + T.pause;
    return [{ type: "pause" }];
  }

  resume(now) {
    const s = this.s;
    const plan = s.next || { to: "round" };
    s.next = null;
    s.voidStreak = 0;
    return this.run(plan, now);
  }

  nextDeadline() {
    const s = this.s;
    return s.phase === "lobby" || s.phase === "finished" ? null : s.phaseEnd;
  }

  tick(now) {
    const s = this.s;
    if (s.phaseEnd == null || now < s.phaseEnd) return [];
    switch (s.phase) {
      case "intro": return this.openVote(now);
      case "vote": return this.closeVote(now);
      case "opinion": return this.startReveal(now);
      case "reveal": {
        s.phase = "scores";
        s.phaseStart = now;
        s.phaseEnd = now + T.scores;
        return [{ type: "scores" }];
      }
      case "scores": return this.afterRound(now);
      case "pause": return this.onlineCount() >= MIN_PLAYERS ? this.resume(now) : this.finish("paused", now);
      default: return [];
    }
  }

  // награды партии (§7): лучший по счётчику; делят больше двоих — не показываем
  computeAwards() {
    const ps = this.present();
    const top = (val) => {
      const vals = ps.map((p) => ({ id: p.id, v: val(p) }));
      const max = Math.max(0, ...vals.map((x) => x.v));
      const ids = vals.filter((x) => x.v === max).map((x) => x.id);
      return max > 0 && ids.length <= 2 ? { ids, n: max } : null;
    };
    return {
      crowd: top((p) => p.stats.hits),
      crow: top((p) => p.stats.misses),
      risk: top((p) => p.stats.bankNet),
      wolf: top((p) => p.stats.wolf),
    };
  }

  finish(reason, now) {
    const s = this.s;
    s.phase = "finished";
    s.phaseStart = now;
    s.phaseEnd = null;
    s.finishedReason = reason;
    s.awards = this.computeAwards();
    return [{ type: "final", reason }];
  }

  // ---------- ведущий ----------

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
   * view: "board" — доска, иначе id игрока.
   * До раскрытия никому не уходят: чужие голоса и мнения, ва-банк других, порядок показа, seed, разбивка по сторонам.
   * Доске во время голосования — только «готов / не готов» и счётчик; во время мнения — только счётчик.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const r = s.round;
    const shown = s.phase === "reveal" || s.phase === "scores";
    const inRound = r && (s.phase === "intro" || s.phase === "vote" || s.phase === "opinion" || shown);
    let round = null;
    if (inRound) {
      round = {
        kind: r.kind,
        num: r.num,
        q: r.q,
        mult: this.mult(),
        bankAllowed: this.bankAllowed(),
        only: r.only,
      };
      if (s.phase === "vote") {
        round.ready = this.voters().filter((p) => r.confirmed[p.id]).map((p) => p.id);
        round.voters = this.voters().filter((p) => p.online).map((p) => p.id);
      }
      if (s.phase === "opinion") {
        round.answered = Object.keys(r.opinions).length;
        round.askN = r.cast.length;
      }
      if (shown) round.result = r.result;
    }
    let mePart = null;
    if (me) {
      const mine = r && s.phase !== "intro";
      mePart = {
        id: me.id,
        banks: me.banks,
        inRound: !!r && !(me.joinedAt != null && r.start != null && me.joinedAt > r.start),
        vote: mine ? r.votes[me.id] || null : null,
        confirmed: mine ? !!r.confirmed[me.id] : false,
        bank: mine ? !!r.bank[me.id] : false,
        opinion: r && (s.phase === "opinion" || shown) ? r.opinions[me.id] || null : null,
        asked: !!r && s.phase === "opinion" && Array.isArray(r.cast) && r.cast.includes(me.id),
        gain: shown && r.result && !r.result.void ? r.result.pts[me.id] ?? null : null,
        bankBack: shown && r.result ? !!r.result.bankBack[me.id] : false,
      };
    }
    return {
      phase: s.phase,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      game: s.game,
      n: s.n,
      total: this.total(),
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      round,
      awards: s.phase === "finished" ? s.awards || null : null,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      minPlayers: MIN_PLAYERS,
      opinionMin: OPINION_MIN_PLAYERS,
      me: mePart,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        online: p.online,
        left: p.left,
        score: p.score,
        // ва-банк чужих игроков до раскрытия не показываем; число оставшихся — только в итогах
        banks: s.phase === "finished" ? p.banks : undefined,
        stats: s.phase === "finished" ? p.stats : undefined,
      })),
    };
  }
}

module.exports = {
  Game, T, REVEAL_STEP, REVEAL_OPINION, REVEAL_VOID, DEFAULTS, MAX_PLAYERS, MIN_PLAYERS, MIN_CAST, TOTAL, BANKS, MAX_VOIDS,
  POINTS, COLORS, AVATARS, clampSettings, cleanName, cleanText, nameKey, revealOrder,
};
