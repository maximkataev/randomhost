"use strict";

/*
 * Движок «На одной волне»: чистая логика без сети и таймеров (wave-spec.md).
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1. Банк шкал — снаружи (content[lang] = [{id, l, r, tag}]).
 *
 * Партия: раунды (×1, ×2), в раунде — фаза подсказок (все пишут разом) и по очереди угадывание каждой шкалы:
 * intro → clue → (guess → reveal)×N → scores → следующий раунд или finished.
 * Тайны (§7): центр сектора видит только автор, чужие стрелки до раскрытия не видит никто,
 * две шкалы на выбор — только их владелец.
 */

const { normalize } = require("./normalize");

const ROUNDS = [{ mult: 1 }, { mult: 2 }];

const T = {
  intro: 3000, // заставка раунда
  clue: 45000, // выбор шкалы + подсказка (§3)
  guess: 25000,
  reveal: 3800, // + REVEAL_STEP на каждую стрелку: очки вскрываются по одной, от дальнего промаха к ближнему
  scores: 6000,
};

const DEFAULTS = {
  short: false, // короткая партия: только раунд 1
  lang: "ru",
};

const MAX_PLAYERS = 12;
const OPTIONS = 4; // шкал на выбор каждому (решение владельца 30.09: «больше вариантов + ещё»)
const REROLLS = 3; // «Другие шкалы» — сколько раз за раунд можно перетасовать
const MIN_PLAYERS = 3;
const CLUE_MAX = 40;
const CLUE_MIN = 2;
const TARGET_MIN = 10; // центр сектора — 10…170°, чтобы крайняя полоса не вылезала за шкалу
const TARGET_MAX = 170;
// полосы сектора (§2): расстояние до центра в градусах → очки
const BANDS = [[4, 400], [12, 300], [20, 200]];
const WAVE_BONUS = 200; // «На одной волне!» — все угадавшие набрали от 300
const WAVE_MIN = 300;
const REVEAL_STEP = 450;
const REACT_GAP = 2000;
const REACTIONS = ["😂", "😱", "🤯", "👏", "🙈"];

// цвета игроков — заметны на любой заливке фона и на белой шкале; чёрного нет: он сливается с центром сектора и стрелкой
const COLORS = ["#e0115f", "#1438e0", "#0a8a4a", "#e25a00", "#7b1fd6", "#008b9a", "#b8006e", "#6b4a00", "#2c2cad", "#b31010", "#3d6b00", "#c77700"];
const AVATARS = ["🐙", "🦊", "🐸", "🦉", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐳", "🦩"];

function clampSettings(input = {}) {
  const s = { ...DEFAULTS };
  if (typeof input.short === "boolean") s.short = input.short;
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  return s;
}

// без управляющих и невидимых символов, без лишних пробелов
// невидимые (мягкий перенос, word joiner…) — прочь; ZWJ (U+200D) оставляем: на нём держатся составные эмодзи
const CTRL = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// и вообще всё невидимое (теги U+E0020…, U+206A…, нотные форматтеры): ZWJ живёт только между двумя эмодзи
const INVIS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const ZWJ_OK = /(\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
function cleanText(text, max) {
  const t = String(text == null ? "" : text).replace(CTRL, "").replace(ZWJ_OK, "$1\u0001").replace(INVIS, "").replace(/\u0001/g, "\u200D");
  return Array.from(t.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}
// ключ сравнения имён: регистр, NFKC и двойники не отличают «Саша» от «саша»/«Сaшa»
const nameKey = (n) => skeleton(String(n || "").normalize("NFKC").toLowerCase()).replace(/[\s\u200D]+/g, "");
const cleanName = (name) => cleanText(name, 16);

// Латиница, кириллица и греческий в одном слове — почти всегда обход запрета полюсов двойниками («Hоt» с кириллической о)
const SKEL = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ё: "e",
  α: "a", β: "b", ε: "e", η: "h", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "y", χ: "x", ς: "c" };
const skeleton = (w) => w.replace(/[авекмнорстухёαβεηικμνορτυχς]/g, (ch) => SKEL[ch]);
const scripts = (w) => (/[a-z]/i.test(w) ? 1 : 0) + (/[а-яё]/i.test(w) ? 1 : 0) + (/[α-ωάέήίόύώϊϋΐΰ]/i.test(w) ? 1 : 0);

// очки угадавшего по расстоянию от стрелки до центра сектора (без множителя)
function points(angle, target) {
  const d = Math.abs(angle - target);
  for (const [lim, pts] of BANDS) if (d <= lim) return pts;
  return 0;
}

// Служебные слова полюсов не запрещают подсказку: «Все знают» — не повод отклонять «про всё сразу»
const STOP = new Set(("все всё это как для что так там тут или при без над под про его еще уже очень чем где кто мне нас вас них она они оно был быть свой твой мой себя " +
  "the and for not you are was but with very too all any can get its has have your our their from that this than " +
  "και για που από στο στη στην στον στα τον την του της των δεν μην πολύ όλα ένα μια είναι σαν").split(" ").map((w) => normalize(w)));

/*
 * Подсказка по правилам (§4): без цифр и без слов полюсов. Слова сравниваем по основам (normalize):
 * «горячий» при полюсе «Горячее» — нельзя. Основы короче трёх букв («не», «в») и служебные слова не считаются.
 */
function checkClue(text, scale) {
  const t = cleanText(text, CLUE_MAX);
  if (/[\p{N}\u{1F51F}]/u.test(t)) return { ok: false, reason: "digits" };
  // буквы или эмодзи обязательны: «🔥🔥» — подсказка, «!!» — нет
  if (!/[\p{L}\p{Extended_Pictographic}]/u.test(t) || (Array.from(t).length < CLUE_MIN && !/\p{Extended_Pictographic}/u.test(t))) return { ok: false, reason: "empty" };
  if (scale) {
    // слово, общее для обоих полюсов («pet» в «Normal pet ↔ Questionable pet»), направление не выдаёт — его можно
    const stems = (x) => new Set(normalize(x).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)));
    const L = stems(scale.l), R = stems(scale.r);
    const poles = new Set([...L, ...R].filter((w) => !(L.has(w) && R.has(w))));
    // двойники из другого алфавита («Живoe», «Hоt», «κρύo»): слово из смеси алфавитов не принимаем
    if (t.split(/\s+/).some((w) => scripts(w.replace(/[^\p{L}]/gu, "")) > 1)) return { ok: false, reason: "mixed" };
    const words = normalize(t.replace(/\u200D/g, "")).split(" ");
    // та же основа или одна продолжает другую («горяч» → «горячительн»); короткие основы — только целиком, иначе «кот» запретил бы «котлету»
    const clash = (w) => poles.has(w) || [...poles].some((p) => Math.min(p.length, w.length) >= 4 && (w.startsWith(p) || p.startsWith(w)));
    if (words.some(clash)) return { ok: false, reason: "pole" };
  }
  return { ok: true, text: t };
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
      phase: "lobby", // lobby | intro | clue | guess | reveal | scores | finished
      players: [],
      game: 0,
      ri: -1, // индекс раунда
      phaseStart: null,
      phaseEnd: null,
      cards: {}, // playerId → {options: [scale, scale], pick: null|0|1, target, clue, at}
      queue: [], // авторы шкал раунда в порядке показа
      qi: -1,
      guesses: {}, // playerId → угол зафиксированной стрелки (текущая шкала)
      result: null, // итог раскрытия текущей шкалы
      history: [], // сыгранные шкалы партии (для итогов): {author, scale, clue, target, guesses, pts, authorPts}
      used: { ru: [], en: [], el: [] }, // сыгранные id шкал: не повторяем, пока банк не пройден
      worstMiss: null, // «Мимо кассы»
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

  addPlayer({ id, name, now = null }) {
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
      stats: this.freshStats(),
      lastReact: null,
      joinedAt: now,
    };
    // ушедшие посреди партии копятся в списке (их очки нужны итогам); но не бесконечно — иначе пара join/leave в цикле раздувает каждый снимок
    if (s.players.length >= MAX_PLAYERS * 3) return { ok: false, reason: "room_full" };
    s.players.push(p);
    // вошёл посреди партии — угадывает сразу, подсказку пишет со следующего раунда (§7)
    return { ok: true, player: p };
  }

  freshStats() {
    return { bulls: 0, authorSum: 0, authorN: 0, skipped: 0 };
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
    // ушёл автор текущей шкалы — её не доигрываем: иначе он мог бы вернуться новым игроком и угадать свою же
    if (s.phase === "guess" && id === this.author()) return ev.concat(this.nextCard(now));
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

  // n шкал без повторов в комнате; банк пройден — забываем сыгранное
  takeScales(n) {
    const s = this.s;
    const lang = s.settings.lang;
    const all = this.bank();
    let used = new Set(s.used[lang] || []);
    let free = all.filter((x) => !used.has(x.id));
    if (free.length < n) { s.used[lang] = []; used = new Set(); free = all.slice(); }
    const out = [];
    while (out.length < n && free.length) out.push(free.splice(this.rnd(free.length), 1)[0]);
    for (const x of out) (s.used[lang] = s.used[lang] || []).push(x.id);
    return out.map((x) => ({ id: x.id, l: x.l, r: x.r }));
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    const ps = this.present();
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    if (this.bank().length < 2) return { ok: false, reason: "no_content" };
    s.game++;
    s.ri = -1;
    s.history = [];
    s.worstMiss = null;
    s.finishedReason = null;
    s.players = ps; // ушедшие в прошлой партии больше не нужны
    for (const p of ps) { p.score = 0; p.stats = this.freshStats(); }
    return { ok: true, events: [{ type: "started", game: s.game }, ...this.nextRound(now)] };
  }

  rounds() {
    return this.s.settings.short ? 1 : ROUNDS.length;
  }

  mult() {
    return (ROUNDS[this.s.ri] || ROUNDS[0]).mult;
  }

  nextRound(now) {
    const s = this.s;
    s.ri++;
    if (s.ri >= this.rounds()) return this.finish("done", now);
    this.clearRound();
    s.phase = "intro";
    s.phaseStart = now;
    s.phaseEnd = now + T.intro;
    return [{ type: "round", index: s.ri, mult: this.mult() }];
  }

  clearRound() {
    const s = this.s;
    s.cards = {};
    s.queue = [];
    s.qi = -1;
    s.guesses = {};
    s.result = null;
  }

  // Каждому, кто в игре, — две шкалы на выбор и тайный центр сектора
  openClues(now) {
    const s = this.s;
    const ps = this.present();
    const scales = this.takeScales(ps.length * OPTIONS);
    s.cards = {};
    ps.forEach((p, i) => {
      const options = scales.slice(i * OPTIONS, (i + 1) * OPTIONS);
      while (options.length < 2) options.push(scales[options.length % scales.length]);
      s.cards[p.id] = { options, pick: null, rerolls: 0, target: TARGET_MIN + this.rnd(TARGET_MAX - TARGET_MIN + 1), clue: null, at: null };
    });
    s.phase = "clue";
    s.phaseStart = now;
    s.phaseEnd = now + T.clue;
    return [{ type: "clues" }];
  }

  pickScale(id, i, now) {
    const s = this.s;
    if (s.phase !== "clue") return { ok: false, reason: "not_clue" };
    const c = s.cards[id];
    if (!c) return { ok: false, reason: "not_in_round" };
    if (c.pick != null) return { ok: false, reason: "picked" };
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n >= c.options.length) return { ok: false, reason: "bad_pick" };
    c.pick = n;
    return { ok: true, events: [] };
  }

  // «Другие шкалы»: новые варианты вместо нынешних, пока шкала не выбрана; не больше REROLLS за раунд
  reroll(id, now) {
    const s = this.s;
    if (s.phase !== "clue") return { ok: false, reason: "not_clue" };
    const c = s.cards[id];
    if (!c) return { ok: false, reason: "not_in_round" };
    if (c.pick != null) return { ok: false, reason: "picked" };
    if ((c.rerolls || 0) >= REROLLS) return { ok: false, reason: "no_rerolls" };
    const was = new Set(c.options.map((o) => o.id));
    // нынешние варианты уже помечены сыгранными, так что свежие с ними не совпадут (разве что колода кончилась и пошла по кругу)
    let fresh = this.takeScales(OPTIONS).filter((o) => !was.has(o.id));
    if (fresh.length < OPTIONS) fresh = fresh.concat(this.takeScales(OPTIONS).filter((o) => !was.has(o.id) && !fresh.some((f) => f.id === o.id))).slice(0, OPTIONS);
    if (fresh.length < 2) return { ok: false, reason: "no_rerolls" };
    c.options = fresh;
    c.rerolls = (c.rerolls || 0) + 1;
    return { ok: true, events: [] };
  }

  clue(id, text, now) {
    const s = this.s;
    if (s.phase !== "clue") return { ok: false, reason: "not_clue" };
    const c = s.cards[id];
    if (!c) return { ok: false, reason: "not_in_round" };
    if (c.pick == null) return { ok: false, reason: "pick_first" };
    if (c.clue) return { ok: false, reason: "done" };
    const r = checkClue(text, c.options[c.pick]);
    if (!r.ok) return r;
    c.clue = r.text;
    c.at = now;
    return { ok: true, events: [{ type: "clued", playerId: id }, ...this.maybeAdvance(now)] };
  }

  allClued() {
    const s = this.s;
    return Object.keys(s.cards).every((id) => {
      const p = this.player(id);
      return !p || p.left || !p.online || s.cards[id].clue;
    });
  }

  // подсказки собраны: очередь шкал в случайном порядке; без подсказки — пропуск и 🐌 (§3)
  closeClues(now) {
    const s = this.s;
    const q = [];
    for (const [id, c] of Object.entries(s.cards)) {
      const p = this.player(id);
      if (c.clue && p && !p.left) q.push(id);
      else if (p) p.stats.skipped++;
    }
    for (let i = q.length - 1; i > 0; i--) { const j = this.rnd(i + 1); [q[i], q[j]] = [q[j], q[i]]; }
    s.queue = q;
    s.qi = -1;
    return this.nextCard(now);
  }

  nextCard(now) {
    const s = this.s;
    s.qi++;
    s.guesses = {};
    s.result = null;
    // автор, ушедший из партии, — его шкалу пропускаем
    while (s.qi < s.queue.length && (this.player(s.queue[s.qi]) || { left: true }).left) s.qi++;
    if (s.qi >= s.queue.length) {
      s.phase = "scores";
      s.phaseStart = now;
      s.phaseEnd = now + T.scores;
      return [{ type: "scores" }];
    }
    s.phase = "guess";
    s.phaseStart = now;
    s.phaseEnd = now + T.guess;
    return [{ type: "card", author: s.queue[s.qi] }];
  }

  author() {
    const s = this.s;
    return s.phase === "guess" || s.phase === "reveal" ? s.queue[s.qi] || null : null;
  }

  // стрелка фиксируется один раз; своя шкала — нельзя
  lock(id, angle, now) {
    const s = this.s;
    if (s.phase !== "guess") return { ok: false, reason: "not_guess" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (id === this.author()) return { ok: false, reason: "own" };
    if (s.guesses[id] != null) return { ok: false, reason: "locked" };
    if (p.joinedAt != null && p.joinedAt > s.phaseStart) return { ok: false, reason: "late" };
    const a = typeof angle === "number" ? angle : NaN; // null, [], "" — не угол 0
    if (!Number.isFinite(a) || a < 0 || a > 180) return { ok: false, reason: "bad_angle" };
    s.guesses[id] = Math.round(a * 10) / 10;
    return { ok: true, events: [{ type: "locked", playerId: id }, ...this.maybeAdvance(now)] };
  }

  guessers() {
    const author = this.author();
    const s = this.s;
    // вошедший уже после начала шкалы её не угадывает — ждёт следующую
    return this.present().filter((p) => p.id !== author && !(p.joinedAt != null && p.joinedAt > s.phaseStart));
  }

  allLocked() {
    const s = this.s;
    return this.guessers().every((p) => !p.online || s.guesses[p.id] != null);
  }

  // Подсчёт шкалы (§2)
  reveal(now) {
    const s = this.s;
    const m = this.mult();
    const authorId = this.author();
    const card = s.cards[authorId];
    const target = card.target;
    const pts = {};
    const raw = [];
    for (const [pid, a] of Object.entries(s.guesses)) {
      const n = points(a, target);
      raw.push(n);
      pts[pid] = n * m;
      const p = this.player(pid);
      if (p) {
        p.score += n * m;
        if (n === BANDS[0][1]) p.stats.bulls++;
      }
      const dist = Math.abs(a - target);
      if (!s.worstMiss || dist > s.worstMiss.dist) {
        const sc = card.options[card.pick];
        s.worstMiss = { dist: Math.round(dist), playerId: pid, author: authorId, clue: card.clue, l: sc.l, r: sc.r };
      }
    }
    let authorPts = 0;
    let wave = false;
    if (raw.length) {
      const avg = raw.reduce((a, b) => a + b, 0) / raw.length;
      authorPts = Math.floor(avg / 50) * 50 * m;
      wave = raw.every((n) => n >= WAVE_MIN);
      if (wave) authorPts += WAVE_BONUS * m;
    }
    const a = this.player(authorId);
    if (a) {
      a.score += authorPts;
      if (raw.length) { a.stats.authorSum += raw.reduce((x, y) => x + y, 0) / raw.length; a.stats.authorN++; }
    }
    const sc = card.options[card.pick];
    s.result = { author: authorId, target, guesses: { ...s.guesses }, pts, authorPts, wave };
    s.history.push({ author: authorId, l: sc.l, r: sc.r, clue: card.clue, target, guesses: { ...s.guesses } });
    s.phase = "reveal";
    s.phaseStart = now;
    s.phaseEnd = now + T.reveal + REVEAL_STEP * raw.length;
    return [{ type: "reveal", wave }];
  }

  maybeAdvance(now) {
    const s = this.s;
    if (s.phase === "clue" && this.allClued()) return this.closeClues(now);
    if (s.phase === "guess" && this.allLocked()) return this.reveal(now);
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
      case "intro": return this.openClues(now);
      case "clue": return this.closeClues(now);
      case "guess": return this.reveal(now);
      case "reveal": return this.nextCard(now);
      case "scores": return this.nextRound(now);
      default: return [];
    }
  }

  // награды партии (§2): лучший по счётчику; делят больше двоих — не показываем
  awards() {
    const ps = this.present();
    const top = (val) => {
      const vals = ps.map((p) => ({ id: p.id, v: val(p) })).filter((x) => x.v != null);
      const max = Math.max(0, ...vals.map((x) => x.v));
      const ids = vals.filter((x) => x.v === max).map((x) => x.id);
      return max > 0 && ids.length <= 2 ? { ids, n: Math.round(max) } : null;
    };
    const w = this.s.worstMiss;
    return {
      telepath: top((p) => p.stats.bulls),
      clear: top((p) => (p.stats.authorN ? p.stats.authorSum / p.stats.authorN : null)),
      miss: w && w.dist >= 40 && this.player(w.playerId) ? w : null,
    };
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
    this.clearRound();
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
   * view: "board" — доска, иначе id игрока.
   * До раскрытия никому не уходят: центр сектора (кроме автора), чужие стрелки, чужие шкалы на выбор.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const authorId = this.author();
    const revealed = s.phase === "reveal";
    let card = null;
    if (authorId) {
      const c = s.cards[authorId];
      const sc = c.options[c.pick];
      card = { author: authorId, l: sc.l, r: sc.r, clue: c.clue, n: s.qi + 1, of: s.queue.length };
      if (revealed) Object.assign(card, s.result);
    }
    let mePart = null;
    if (me) {
      const c = s.cards[me.id];
      mePart = {
        id: me.id,
        // своя карточка: на выбор — пока не выбрал, дальше — выбранная шкала, сектор и подсказка
        card: c && (s.phase === "clue" || s.phase === "guess" || s.phase === "reveal") ? {
          options: c.pick == null ? c.options.map((o) => ({ l: o.l, r: o.r })) : null,
          rerollsLeft: c.pick == null ? Math.max(0, REROLLS - (c.rerolls || 0)) : 0,
          pick: c.pick,
          l: c.pick != null ? c.options[c.pick].l : null,
          r: c.pick != null ? c.options[c.pick].r : null,
          target: c.pick != null ? c.target : null,
          clue: c.clue,
        } : null,
        inRound: !!c,
        guess: s.phase === "guess" || revealed ? s.guesses[me.id] ?? null : null,
        myCard: authorId === me.id,
        gain: revealed ? (authorId === me.id ? s.result.authorPts : s.result.pts[me.id] ?? null) : null,
      };
    }
    return {
      phase: s.phase,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      game: s.game,
      ri: s.ri,
      rounds: this.rounds(),
      mult: s.ri >= 0 ? this.mult() : 1,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      clued: s.phase === "clue" ? Object.keys(s.cards).filter((id) => s.cards[id].clue) : null,
      roster: s.phase === "clue" ? Object.keys(s.cards) : null,
      card,
      locked: s.phase === "guess" ? Object.keys(s.guesses) : null,
      guessers: s.phase === "guess" ? this.guessers().filter((p) => p.online).map((p) => p.id) : null,
      history: s.phase === "finished" ? s.history : null,
      awards: s.phase === "finished" ? s.awards || null : null,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      minPlayers: MIN_PLAYERS,
      clueMax: CLUE_MAX,
      bands: BANDS,
      me: mePart,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        online: p.online,
        left: p.left,
        score: p.score,
      })),
    };
  }
}

module.exports = { Game, ROUNDS, T, REVEAL_STEP, DEFAULTS, OPTIONS, REROLLS, MAX_PLAYERS, MIN_PLAYERS, CLUE_MAX, BANDS, WAVE_BONUS, REACTIONS, COLORS, AVATARS, clampSettings, cleanName, cleanText, checkClue, points, nameKey };
