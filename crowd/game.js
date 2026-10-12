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
  pause: 60000, // «Ждём игроков»: меньше 3 на связи
  passive: 5000, // «Мало голосов»: все на связи, но два раунда подряд не набрали 3 голосов
};
const REVEAL_STEP = 600;
const REVEAL_OPINION = 3500;
const REVEAL_VOID = 3000;

const DEFAULTS = {
  short: false, // короткая партия: 6 вопросов и один ва-банк
  opinion: true, // фаза «Мнение» (работает только при ≥ 4 игроках)
  lang: "ru",
};

// RULE_U08_GHOST_OUT (класс B, T-W2-35): офлайн к началу партии — не в партии (помечается left, запись и токен живы).
// По умолчанию выкл — как раньше: призрак входит в партию с нулём. Читаем при каждом вызове (флаг виден и в тестах).
const ghostOut = () => process.env.RULE_U08_GHOST_OUT === "1";
const presence = require("../lib/presence");

// RULE_U47_CROWD_DECIDER = now | v1 | v2 (класс B, T-W2-37; U-47). now (по умолчанию) — как раньше: единодушие/ничья в
// решающем вопросе дают всем +50 и партия кончается («Раскол» = +50). v1 — в решающем +50 нет: очки только за
// «угадал большинство» (+100/0), единодушие/ничья — 0 всем; v2 — v1 и при равенстве лидеров ещё один решающий (≤ 2).
// Читаем при каждом вызове: флаг виден и в тестах. Имя без суффикса (RULE_U47_DECIDER) — как в плане, тоже принимается.
const deciderRule = () => {
  const v = String(process.env.RULE_U47_CROWD_DECIDER || process.env.RULE_U47_DECIDER || "now").toLowerCase();
  return v === "v2" ? 2 : v === "v1" || v === "1" ? 1 : 0;
};
const MAX_DECIDERS = 2;

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;
const MIN_CAST = 3; // меньше голосов — раунд аннулируется
const OPINION_MIN_PLAYERS = 4;
const TOTAL = { full: 10, short: 6 };
const BANKS = { full: 2, short: 1 };
const MAX_VOIDS = 2; // замен аннулированных вопросов за партию
const MAX_VOID_RUN = 4; // аннулированных раундов подряд (с одной «пассивной» паузой между парами) — и партия останавливается
const NAME_MAX = 15;
const SD_MIN = { full: 3, short: 1 }; // вопросов spicy/dark за партию (острая основа колоды)
const CAP_TAG = 2; // pick / edge — не больше двух за партию
const AB_SHARE = [0.3, 0.7]; // доля «А или Б» в партии
const POINTS = { win: 100, flat: 50, bankWin: 200, bankLoss: -200 };
const UNANIMOUS_MIN = 4;
const WOLF_MIN = 4;
const ILLUSION_MIN = 4;
const OPINION_AGG_MIN = 3; // агрегат мнений показывается только при стольких ответивших (a+b)
const ILLUSION_SHARE = 0.6;
const LEAN_B_MIN = 0.4; // доля вопросов партии с ожидаемым большинством «НЕТ»/«Б» (§5); в целых — вниз: из 6 допустимо 2–3
const LEAN_B_MAX = 0.5;

// цвета и аватары — как в соседних играх (имя заметно на любой заливке)
const COLORS = ["#e0115f", "#1438e0", "#0a8a4a", "#e25a00", "#7b1fd6", "#008b9a", "#b8006e", "#6b4a00", "#2c2cad", "#b31010", "#3d6b00", "#c77700"];
const AVATARS = ["🐙", "🦊", "🐸", "🦉", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐳", "🦩"];
// из чего игрок выбирает сам (первые — те, что раздаются по умолчанию)
const AVATAR_CHOICES = [...new Set(AVATARS.concat(["🐱", "🐶", "🐰", "🐻", "🐨", "🐯", "🐷", "🐮", "🦝", "🦥", "🦦", "🐲", "👽", "🤖", "👻", "🤡", "🥑", "🍕", "🌮", "🍩", "🧀", "🌵", "🍄", "🪩"]))];

function clampSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
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
// латиница/кириллица/греческий-двойники не отличают «Саша» от «Сaшa»; диакритика снимается (NFKD), i/l/1 и o/0 сведены в одно
const SKEL = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ё: "e",
  і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w", һ: "h", ӏ: "l", ѵ: "v", ѡ: "w",
  α: "a", β: "b", ε: "e", η: "h", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "y", χ: "x", ς: "c", ω: "w", γ: "y", ϲ: "c" };
const SKEL_RE = new RegExp("[" + Object.keys(SKEL).join("") + "]", "g");
const nameKey = (n) => String(n || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(SKEL_RE, (ch) => SKEL[ch]).replace(/[il1|]/g, "l").replace(/0/g, "o").replace(/[\s‍]+/g, "");
const cleanName = (name) => cleanText(name, NAME_MAX);

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
      deciderRuns: 0, // решающих вопросов в партии (старые дампы: deciderDone => 1, см. deciderRuns())
      sensUsed: 0,
      leanB: 0,
      drawn: 0,
      sdUsed: 0, // острых (spicy/dark) основных вопросов партии
      abUsed: 0, // «А или Б» среди основных
      tagUsed: {}, // pick / edge: потолок на партию
      partyIds: [], // id вопросов этой партии: не повторяются, даже когда банк «забывается»
      voidRun: 0, // аннулированных раундов подряд (сбрасывается раундом с итогом)
      pauseReason: null, // offline | passive
      pauseIdle: [],
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

  // ушедший посреди партии (left) — тот же человек, если вернулся с тем же именем: кошелёк у него один
  findLeft(name) {
    const key = nameKey(cleanName(name));
    if (!key) return null;
    return this.s.players.find((p) => p.left && nameKey(p.name) === key) || null;
  }

  // записи ушедших без очков, статистики и голоса в текущем раунде не нужны никому: чистим, чтобы они не копились
  compactPlayers() {
    const s = this.s;
    const r = s.round;
    const keep = (p) => !p.left || p.score !== 0 || p.stats.hits + p.stats.misses + p.stats.wolf + p.stats.banksUsed > 0
      || !!(r && (r.votes[p.id] || r.confirmed[p.id] || r.opinions[p.id] || (r.only && r.only.includes(p.id))));
    s.players = s.players.filter(keep);
    // потолок записей: самых давних ушедших вытесняем, но присутствующих (≤ 12) это не касается
    while (s.players.length >= MAX_PLAYERS * 3) {
      const i = s.players.findIndex((p) => p.left);
      if (i < 0) break;
      s.players.splice(i, 1);
    }
  }

  // самое давнее офлайн-место (не в партии) уходит; true, если место освободилось
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
      // комната полна офлайн-местами: в лобби/итогах вытесняем самое давнее (старше GHOST_TTL_MS, lib/presence);
      // посреди партии место не освобождается (R1)
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
    if (p) presence.setOnline(p, online, now);
    return this.maybeAdvance(now);
  }

  // ---------- банк вопросов ----------

  bank() {
    const lang = this.s.settings.lang;
    return this.content[lang] || this.content.ru || [];
  }

  /*
   * Вопрос без повторов в комнате (банк пройден — забываем сыгранное, но не вопросы этой партии).
   * Баланс партии (§5): 40–50 % вопросов с ожидаемым большинством «НЕТ»/«Б» (в целых вниз: из 6 — 2…3, из 10 — 4…5);
   * острая основа: не меньше SD_MIN вопросов spicy/dark; pick и edge — не больше CAP_TAG каждого; «А или Б» — 30–70 %;
   * «чувствительный» вопрос — не больше одного и не в первых двух.
   * Банк забываем не «когда свободных меньше 8», а когда в свободных не хватает вопросов нужного вида на оставшиеся слоты.
   */
  takeQuestion(kind) {
    const s = this.s;
    const lang = s.settings.lang;
    const all = this.bank();
    const main = kind === "normal" || kind === "final";
    const total = this.total();
    const slots = main ? Math.max(0, total - (s.drawn || 0)) : 0; // основных вопросов осталось, считая этот
    const party = new Set(s.partyIds || []);
    const isB = (x) => x.lean === "b";
    const isSD = (x) => x.tag === "spicy" || x.tag === "dark";
    const minB = Math.floor(LEAN_B_MIN * total), maxB = Math.floor(LEAN_B_MAX * total);
    const rest = all.filter((x) => !party.has(x.id));
    const cnt = (list, f) => list.reduce((n, x) => n + (f(x) ? 1 : 0), 0);
    const sdMin = s.settings.short ? SD_MIN.short : SD_MIN.full;
    // сколько каждого вида ещё нужно партии, но не больше, чем вообще есть в банке
    const needB = Math.min(Math.max(0, minB - (s.leanB || 0)), cnt(rest, isB));
    const needA = Math.min(Math.max(0, slots - (maxB - (s.leanB || 0))), cnt(rest, (x) => !isB(x)));
    const needSD = Math.min(Math.max(0, sdMin - (s.sdUsed || 0)), cnt(rest, isSD));
    let used = new Set(s.used[lang] || []);
    let free = all.filter((x) => !used.has(x.id) && !party.has(x.id));
    const enough = (l) => l.length >= Math.max(slots, 1) + 1 && cnt(l, isB) >= needB && cnt(l, (x) => !isB(x)) >= needA && cnt(l, isSD) >= needSD;
    let reset = false;
    const forget = () => { reset = true; s.used[lang] = [...party]; return rest.length ? rest : all.slice(); };
    if (!enough(free)) free = forget();
    const select = (list) => {
      let pool = list, miss = false;
      // forced: условие обязательное — если в свободных нет подходящего, это «промах» (тогда банк забываем и пробуем снова)
      const take = (f, forced) => { const sub = pool.filter(f); if (sub.length) pool = sub; else if (forced) miss = true; };
      // «чувствительный» вопрос — не больше одного за партию, не в первых двух, не в финал и не в решающий (T-W2-37)
      const sensBlocked = (s.sensUsed || 0) >= 1 || (main && (s.drawn || 0) < 2) || kind === "final" || kind === "decider";
      if (sensBlocked) take((x) => !x.sensitive);
      const tu = s.tagUsed || {};
      take((x) => !((x.tag === "pick" || x.tag === "edge") && (tu[x.tag] || 0) >= CAP_TAG));
      if (main) {
        // приоритет по убыванию: баланс «ДА/НЕТ» → острый минимум → доля «А или Б»; мягкое пожелание (острый по жребию) — последним
        if (needB >= slots && needB > 0) take(isB, true);
        else if ((s.leanB || 0) >= maxB) take((x) => !isB(x), true);
        if (needSD >= slots && needSD > 0) take(isSD, true);
        const abMin = Math.ceil(AB_SHARE[0] * total), abMax = Math.floor(AB_SHARE[1] * total);
        const abUsed = s.abUsed || 0, ynUsed = (s.drawn || 0) - abUsed;
        const isAb = (x) => x.kind === "ab";
        if (abUsed >= abMax) take((x) => !isAb(x), true);
        else if (ynUsed >= total - abMin) take(isAb, true);
        else if (abMin - abUsed >= slots) take(isAb, true);
        else if (total - abMax - ynUsed >= slots) take((x) => !isAb(x), true);
        if (needSD > 0 && needSD < slots && this.rnd(slots) < needSD) take(isSD);
      }
      return { pool, miss };
    };
    let sel = select(free);
    if (sel.miss && !reset && rest.length) sel = select(forget());
    const pool = sel.pool;
    const q = pool[this.rnd(pool.length)] || all[this.rnd(Math.max(1, all.length))];
    (s.used[lang] = s.used[lang] || []).push(q.id);
    (s.partyIds = s.partyIds || []).push(q.id);
    if (q.sensitive) s.sensUsed = (s.sensUsed || 0) + 1;
    if (main) {
      s.drawn = (s.drawn || 0) + 1;
      if (q.lean === "b") s.leanB = (s.leanB || 0) + 1;
      if (q.kind === "ab") s.abUsed = (s.abUsed || 0) + 1;
      if (isSD(q)) s.sdUsed = (s.sdUsed || 0) + 1;
      if (q.tag === "pick" || q.tag === "edge") { s.tagUsed = s.tagUsed || {}; s.tagUsed[q.tag] = (s.tagUsed[q.tag] || 0) + 1; }
    }
    return { id: q.id, q: q.q, a: q.a, b: q.b, kind: q.kind === "ab" ? "ab" : "yn", tag: q.tag || "" };
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    let ps = this.present();
    // RULE_U08_GHOST_OUT: офлайн к старту — не в партии; играют те, кто на связи
    const ghosts = ghostOut() ? ps.filter((p) => p.online === false) : [];
    if (ghosts.length) ps = ps.filter((p) => p.online !== false);
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    if (this.bank().length < 8) return { ok: false, reason: "no_content" };
    s.game++;
    s.n = 0;
    s.voidsUsed = 0;
    s.replNext = 0;
    s.voidStreak = 0;
    s.extraDone = false;
    s.deciderDone = false;
    s.deciderRuns = 0;
    s.sensUsed = 0;
    s.leanB = 0;
    s.drawn = 0;
    s.sdUsed = 0;
    s.abUsed = 0;
    s.tagUsed = {};
    s.partyIds = [];
    s.voidRun = 0;
    s.pauseReason = null;
    s.pauseIdle = [];
    s.round = null;
    s.next = null;
    s.awards = null;
    s.finishedReason = null;
    // ушедшие в прошлой партии больше не нужны; офлайн-места (RULE_U08_GHOST_OUT) — left без очков: вернутся через findLeft
    for (const p of ghosts) { p.left = true; p.score = 0; p.stats = this.freshStats(); p.banks = this.banksTotal(); p.joinedAt = null; }
    s.players = ps.concat(ghosts);
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
      repl: kind === "normal" || kind === "final" ? s.replNext || 0 : 0, // номер замены (1..MAX_VOIDS), если это вопрос вместо аннулированного
      start: null,
      result: null,
    };
    s.next = null;
    s.replNext = 0;
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
    if (typeof on !== "boolean") return { ok: false, reason: "bad_value" };
    const want = on;
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
    if (s.phase === "pause") {
      const online = this.onlineCount() >= MIN_PLAYERS;
      if (s.pauseReason === "passive") {
        // на связи все, ждём только короткую паузу; а если связь пропала — это уже «ждём игроков»
        return online ? [] : this.pause(s.next, now, "offline");
      }
      return online ? this.resume(now) : [];
    }
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
      bankLate: {}, replace: false,
    };
    r.result = res;
    // ва-банк включён, а «Готово» не нажато: не засчитывается (правило не менялось), но игрок должен это видеть
    if (this.bankAllowed()) {
      for (const id of cast) {
        const p = this.player(id);
        if (r.bank[id] && !r.confirmed[id] && p && p.banks > 0) res.bankLate[id] = true;
      }
    }
    if (res.void) {
      // заменят ли вопрос — решает afterRound тем же условием; номер замены — для подписи «замена 1/2»
      res.replace = (r.kind === "normal" || r.kind === "final") && s.voidsUsed < MAX_VOIDS;
      if (res.replace) { res.replaceNo = s.voidsUsed + 1; res.replaceMax = MAX_VOIDS; }
      for (const id of cast) res.votes[id] = r.votes[id];
      for (const id of Object.keys(r.bank)) if (r.confirmed[id]) res.bankBack[id] = true;
      return this.afterVote(now);
    }
    res.tie = res.a === res.b;
    res.side = res.tie ? null : res.a > res.b ? "a" : "b";
    res.unanimous = cast.length >= UNANIMOUS_MIN && (res.a === 0 || res.b === 0);
    const m = this.mult();
    const decides = !!r.only && deciderRule() >= 1;
    for (const id of cast) {
      const vote = r.votes[id];
      res.votes[id] = vote;
      const p = this.player(id);
      let base;
      let decisive = false;
      if (decides && (res.tie || res.unanimous)) base = 0; // решающий (v1/v2): «Раскол»/«Как один!» очков не дают, лидеры остаются равными
      else if (res.tie || res.unanimous) base = POINTS.flat;
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
    let opA = 0, opB = 0; // для статистики вопроса — сырые счётчики, даже если агрегат скрыт
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
        // меньше трёх ответивших — агрегат раскрывает мнение одного-двух людей: не показываем
        opA = oa; opB = ob;
        res.opinions = oa + ob >= OPINION_AGG_MIN ? { a: oa, b: ob, skip } : null;
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
      events.push({ type: "qstat", id: r.q.id, a: res.a, b: res.b, oa: opA, ob: opB });
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
      s.voidRun = (s.voidRun || 0) + 1;
      if (main && s.voidsUsed < MAX_VOIDS) { s.voidsUsed++; s.replNext = s.voidsUsed; next = { to: "round" }; }
      else { s.replNext = 0; if (main) s.n++; next = this.planAfter(r.kind, res); }
    } else {
      s.voidStreak = 0;
      s.voidRun = 0;
      s.replNext = 0;
      if (main) s.n++;
      next = this.planAfter(r.kind, res);
    }
    if (next.to !== "finish") {
      if (this.onlineCount() < MIN_PLAYERS) return this.pause(next, now, "offline");
      if (s.voidStreak >= 2) {
        // все на связи, но голосов не набирается: короткая пауза с объяснением; и не бесконечно —
        // ещё два аннулированных раунда после неё, и партия останавливается (очки сохранены)
        if (s.voidRun >= MAX_VOID_RUN) return this.finish("idle", now);
        const voted = new Set(Object.keys(res.votes || {}));
        return this.pause(next, now, "passive", this.voters().filter((p) => !voted.has(p.id)).map((p) => p.id));
      }
    }
    return this.run(next, now);
  }

  planAfter(kind, res) {
    const s = this.s;
    if (kind === "normal") return { to: "round" };
    if (kind === "final" && res.tie && !s.extraDone) return { to: "extra" };
    // лидеры с равным счётом решают отдельным вопросом; при v2 после решающего, не разделившего лидеров, — ещё один
    const runs = this.deciderRuns();
    const again = kind === "decider" ? deciderRule() >= 2 && runs < MAX_DECIDERS : runs === 0;
    if (again) {
      const ps = this.present();
      const top = Math.max(...ps.map((p) => p.score));
      const tied = ps.filter((p) => p.score === top).map((p) => p.id);
      if (tied.length >= 2) return { to: "decider", only: tied };
    }
    return { to: "finish" };
  }

  // сколько решающих вопросов уже было; дамп прежней версии помнил только deciderDone
  deciderRuns() {
    const s = this.s;
    return typeof s.deciderRuns === "number" ? s.deciderRuns : s.deciderDone ? 1 : 0;
  }

  run(plan, now) {
    const s = this.s;
    if (plan.to === "round") return this.startRound("normal", now);
    if (plan.to === "extra") { s.extraDone = true; return this.startRound("extra", now); }
    if (plan.to === "decider") { s.deciderRuns = this.deciderRuns() + 1; s.deciderDone = true; return this.startRound("decider", now, plan.only); }
    return this.finish("done", now);
  }

  pause(plan, now, reason = "offline", idle = []) {
    const s = this.s;
    s.next = plan;
    s.phase = "pause";
    s.pauseReason = reason;
    s.pauseIdle = reason === "passive" ? idle : [];
    s.phaseStart = now;
    s.phaseEnd = now + (reason === "passive" ? T.passive : T.pause);
    return [{ type: "pause" }];
  }

  resume(now) {
    const s = this.s;
    const plan = s.next || { to: "round" };
    s.next = null;
    s.voidStreak = 0;
    s.pauseReason = null;
    s.pauseIdle = [];
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
      case "pause":
        if (this.onlineCount() >= MIN_PLAYERS) return this.resume(now);
        // короткая «пассивная» пауза кончилась, а связь пропала: даём полную минуту дождаться игроков
        return s.pauseReason === "passive" ? this.pause(s.next, now, "offline") : this.finish("paused", now);
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
    s.pauseReason = null;
    s.pauseIdle = [];
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
  // Свой аватар: в лобби и между партиями, из списка, не занятый другим игроком
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
        repl: r.repl || undefined,
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
        bankLate: shown && r.result && r.result.bankLate ? !!r.result.bankLate[me.id] : false,
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
      pauseReason: s.phase === "pause" ? s.pauseReason || "offline" : null,
      pauseIdle: s.phase === "pause" && s.pauseReason === "passive" ? (s.pauseIdle || []).filter((id) => { const p = this.player(id); return p && !p.left; }) : [],
      minPlayers: MIN_PLAYERS,
      avatarChoices: s.phase === "lobby" || s.phase === "finished" ? AVATAR_CHOICES : null,
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
  POINTS, COLORS, AVATARS, AVATAR_CHOICES, NAME_MAX, MAX_VOID_RUN, clampSettings, cleanName, cleanText, nameKey, revealOrder,
};
