"use strict";

/*
 * Движок «Последнего вопроса»: чистая логика без сети и таймеров (lastq-spec.md).
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1. Банк вопросов — снаружи (content[lang] = [{id, tag, lvl, final, q, a, fun}]),
 * в состояние копируется только разыгрываемый вопрос.
 *
 * Вопрос идёт по фазам (§3): read (3 с, кнопок нет) → answer (20 с) → reveal (раскрытие + палач выбирает набор)
 * → cell (Камера) → verdict (отлёты) → следующий вопрос. Перед каждым актом — intro.
 * Финал (§5): stake (ставки) → fread → fanswer → fshow (верный ответ) → fcell (если кто-то ошибся) → freveal (по одному снизу вверх) → finished.
 * Тайны (§8): верный ответ, чужие ответы, кто ошибся (палач, узники), ставки и ответы испытаний не уходят в снимки до раскрытия.
 */

const CH = require("./challenges.js");

// Акты (§2): очки за верный ответ, максимум бонуса за скорость, отлёт
const ACTS = {
  1: { right: 100, speed: 50, knock: 100 },
  2: { right: 200, speed: 100, knock: 250 },
};
const QUESTIONS = { normal: [1, 1, 1, 1, 2, 2, 2, 2], short: [1, 1, 2, 2] };
// уровни вопросов по актам (§2) и веса: плейтест агентами (05.10) — лёгкие вопросы брали все, Камеры почти не было
const ACT_LVL = { 1: [1, 2], 2: [2, 3] };
const ACT_LVL_W = { 1: { 1: 0.3, 2: 0.7 }, 2: { 2: 0.3, 3: 0.7 } };

const T = {
  intro: 3500, // заставка акта
  read: 3000, // вопрос виден, кнопок нет (§3)
  answer: 20000,
  reveal: 6000, // раскрытие + выбор палача
  revealMin: 4000, // палач выбрал раньше — раскрытие всё равно не короче
  revealClean: 4000, // «Чисто!» — Камеры нет
  verdict: 3000,
  verdictStep: 600, // + на каждого отлетевшего
  stake: 15000,
  fread: 3000,
  fanswer: 20000,
  fshow: 4000, // финал: верный ответ на экране, потом Камера или раскрытие ставок
  frevealStep: 3000, // раскрытие ставки одного игрока
  frevealTail: 2000,
};
const PASS_SILENCE = 4000; // «Передачка»: подсказчик молчит — код на доску (§4.2)
const BET_POINTS = 20; // угаданная ставка на спасение (§4.1)
const BET_WINDOW = 3000; // ставки — только первые 3 с после «Приготовься», по одной на узника: позже исход уже виден (§4.1)
const STAKE_FLOOR = 200; // в финале можно поставить до 200, даже если очков меньше (§5)
const GROUPS_OFFERED = ["hands", "eyes", "head"];

const DEFAULTS = {
  short: false, // 2 + 2 вопроса и финал
  final: true, // финал со ставками (решение владельца: настройка комнаты)
  lang: "ru",
};

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const REACT_GAP = 2000;
const REACTIONS = ["😂", "😱", "😈", "👏", "🙏"];

const COLORS = ["#d62828", "#1d4ed8", "#b45309", "#047857", "#7c3aed", "#c2410c", "#0e7490", "#be185d", "#4d7c0f", "#475569"];
const AVATARS = ["🦊", "🐸", "🦉", "🐙", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐝", "🐳", "🦩", "🐢", "🦔", "🐻"];

function clampSettings(input = {}) {
  const out = { ...DEFAULTS };
  if (typeof input.short === "boolean") out.short = input.short;
  if (typeof input.final === "boolean") out.final = input.final;
  if (["ru", "en", "el"].includes(input.lang)) out.lang = input.lang;
  return out;
}

const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
function cleanText(text, max) {
  // обрезка по UTF-16 могла разрезать эмодзи пополам — висящую половину суррогатной пары убираем
  return String(text == null ? "" : text).replace(CTRL, "").replace(/\s+/g, " ").trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, "").trim();
}
const cleanName = (name) => cleanText(name, 16);
const round10 = (x) => Math.round(x / 10) * 10;

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
      phase: "lobby", // lobby | intro | read | answer | reveal | cell | verdict | stake | fread | fanswer | fcell | freveal | finished
      players: [],
      game: 0,
      plan: [], // акт каждого вопроса партии
      qn: -1, // номер вопроса в партии
      act: 0, // 1, 2 или 3 (финал)
      phaseStart: null,
      phaseEnd: null,
      openAt: null, // когда открылись кнопки (бонус за скорость, §2)
      q: null, // разыгрываемый вопрос: {id, tag, lvl, final, text, options, right}
      answers: {}, // playerId → {i, ms}
      eligible: [], // кто отвечает на этот вопрос (вошедшие позже — со следующего)
      palach: null,
      group: null, // набор испытаний Камеры
      prisoners: [],
      cell: {}, // playerId → {done, need, ch, lockUntil, seen, last, escaped, burned, at}
      cellNeed: 0,
      bets: {}, // playerId → {prisonerId: true|false}
      result: null, // итог раскрытия/приговора
      stakes: {}, // финал: playerId → ставка
      fsteps: null, // финал: раскрытие по одному
      used: { ru: [], en: [], el: [] }, // сыгранные id вопросов в комнате: не повторяем, пока банк не пройден
      usedBank: {}, // вопросы бомбового банка в испытаниях: не повторяем в комнате
      lastTags: [],
      paused: null, // все офлайн — время стоит (§8)
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
      stats: Game.freshStats(),
      lastReact: null,
    };
    // ушедшие посреди партии копятся в списке (их очки нужны итогам); но не бесконечно — иначе пара join/leave в цикле
    // раздувает каждый снимок до мегабайт (как в wave)
    if (s.players.length >= MAX_PLAYERS * 3) return { ok: false, reason: "room_full" };
    s.players.push(p);
    // вошёл посреди партии — отвечает со следующего вопроса с 0 очков (§8)
    return { ok: true, player: p };
  }

  static freshStats() {
    return { right: 0, msSum: 0, escapes: 0, cells: 0, knocks: 0, betHits: 0, minScore: 0, stake: null, finalMs: null };
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
    p.online = false;
    const ev = [{ type: "left", playerId: id }];
    if (this.present().length < MIN_PLAYERS) return ev.concat(this.finish("few", now));
    if (this.present().every((x) => !x.online)) { this.pause(now); return ev; }
    return ev.concat(this.onGone(id, now));
  }

  setOnline(id, online, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p) return [];
    const was = p.online;
    p.online = online;
    if (online) {
      const ev = this.resume(now);
      // вернулся из офлайна посреди Камеры — играет оставшееся время; испытание новое (расписание от момента показа),
      // решётка остаётся. Повторный вход онлайн-игрока испытание НЕ меняет — иначе перебор до лёгкого.
      const c = s.cell[id];
      if (!was && c && !c.escaped && !c.burned && (s.phase === "cell" || s.phase === "fcell")) this.issue(id, now, Math.max(now, c.lockUntil || 0));
      // после паузы: кто так и не вернулся — как ушедший (палач → набор сразу и т. п.)
      if (ev.length) for (const x of this.present()) if (!x.online) ev.push(...this.onGone(x.id, now));
      return ev.concat(this.maybeAdvance(now));
    }
    if (this.present().every((x) => !x.online)) { this.pause(now); return []; }
    return this.onGone(id, now);
  }

  // ушёл или выпал: палач — набор случайно сразу; подсказчик «Передачки» — узнику новое испытание; фаза может закончиться
  onGone(id, now) {
    const s = this.s;
    if (s.phase === "reveal" && s.palach === id && !s.group) this.pickGroup(id, null, now, true);
    if (s.phase === "cell" || s.phase === "fcell") {
      for (const [pid, c] of Object.entries(s.cell)) {
        if (c.ch && c.ch.type === "pass" && c.ch.view.helper === id && !c.escaped) this.issue(pid, now);
      }
    }
    return this.maybeAdvance(now);
  }

  // ---------- пауза: все офлайн — время стоит (§8) ----------

  pause(now) {
    const s = this.s;
    if (s.paused != null || s.phase === "lobby" || s.phase === "finished") return;
    s.paused = now;
  }

  resume(now) {
    const s = this.s;
    if (s.paused == null) return [];
    const d = now - s.paused;
    s.paused = null;
    for (const k of ["phaseStart", "phaseEnd", "openAt"]) if (s[k] != null) s[k] += d;
    for (const c of Object.values(s.cell)) {
      if (c.lockUntil) c.lockUntil += d;
      if (c.ch) { c.ch.at += d; if (c.ch.passAt) c.ch.passAt += d; }
    }
    return [{ type: "resumed" }];
  }

  // ---------- банк ----------

  bank() {
    const lang = this.s.settings.lang;
    return this.content[lang] || this.content.ru || [];
  }

  // вопрос акта: уровень по акту, не сыгранный в комнате, тема не как у двух прошлых
  pickQuestion(act) {
    const s = this.s;
    const lang = s.settings.lang;
    const final = act === 3;
    const all = this.bank().filter((q) => !!q.final === final);
    const used = new Set(s.used[lang] || []);
    let free = all.filter((q) => !used.has(q.id));
    if (!free.length) {
      // банк пройден: забываем сыгранное этого вида
      s.used[lang] = (s.used[lang] || []).filter((id) => !all.some((q) => q.id === id));
      free = all;
    }
    if (!free.length) return null;
    const lv = final ? null : ACT_LVL[act];
    // целевой уровень по весам акта; нет такого — любой уровень акта
    let want = null;
    if (!final) { const w = ACT_LVL_W[act]; want = this.rnd(100) < w[lv[0]] * 100 ? lv[0] : lv[1]; }
    const tries = [
      (q) => (want == null || q.lvl === want) && !s.lastTags.includes(q.tag),
      (q) => (!lv || lv.includes(q.lvl)) && !s.lastTags.includes(q.tag),
      (q) => !lv || lv.includes(q.lvl),
      () => true,
    ];
    for (const f of tries) {
      const c = free.filter(f);
      if (c.length) return c[this.rnd(c.length)];
    }
    return null;
  }

  takeQuestion(raw) {
    const s = this.s;
    const lang = s.settings.lang;
    (s.used[lang] = s.used[lang] || []).push(raw.id);
    s.lastTags = [raw.tag, ...s.lastTags].slice(0, 2);
    // варианты перемешиваем: верный a[0] встаёт на случайное место
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const j = this.rnd(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    s.q = {
      id: raw.id,
      tag: raw.tag,
      lvl: raw.lvl,
      final: !!raw.final,
      text: raw.q,
      options: order.map((k) => raw.a[k]),
      right: order.indexOf(0), // только на сервере до раскрытия
    };
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    const ps = this.present();
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    if (!this.bank().some((q) => !q.final)) return { ok: false, reason: "no_content" };
    s.game++;
    s.plan = (s.settings.short ? QUESTIONS.short : QUESTIONS.normal).slice();
    s.qn = -1;
    s.act = 0;
    s.lastTags = [];
    s.finishedReason = null;
    s.awards = null;
    s.ranking = null;
    s.paused = null;
    // 10: ушедшие прошлой партии не висят серыми, ставки прошлого финала не видны
    s.players = s.players.filter((p) => !p.left);
    s.stakes = {};
    s.fsteps = null;
    for (const p of ps) { p.score = 0; p.stats = Game.freshStats(); p.seen = {}; }
    return { ok: true, events: [{ type: "started", game: s.game }, ...this.nextQuestion(now)] };
  }

  clearQuestion() {
    const s = this.s;
    s.q = null;
    s.answers = {};
    s.eligible = [];
    s.palach = null;
    s.group = null;
    s.prisoners = [];
    s.cell = {};
    s.cellNeed = 0;
    s.bets = {};
    s.result = null;
    s.openAt = null;
    s.groupAuto = null;
  }

  nextQuestion(now) {
    const s = this.s;
    this.clearQuestion();
    s.qn++;
    if (s.qn >= s.plan.length) {
      if (s.settings.final && this.bank().some((q) => q.final)) return this.startFinal(now);
      return this.finish("done", now);
    }
    const act = s.plan[s.qn];
    if (act !== s.act) {
      s.act = act;
      s.phase = "intro";
      s.phaseStart = now;
      s.phaseEnd = now + T.intro;
      s.qn--; // вопрос ещё не начат: intro → nextQuestion снова
      s.introDone = act;
      return [{ type: "act", act }];
    }
    const raw = this.pickQuestion(act);
    if (!raw) return this.finish("no_content", now);
    this.takeQuestion(raw);
    s.eligible = this.present().map((p) => p.id);
    s.phase = "read";
    s.phaseStart = now;
    s.phaseEnd = now + T.read;
    return [{ type: "question", qn: s.qn }];
  }

  answer(id, i, now) {
    const s = this.s;
    const final = s.phase === "fanswer";
    if (s.phase !== "answer" && !final) return { ok: false, reason: "not_now" };
    if (!s.eligible.includes(id)) return { ok: false, reason: "not_in_question" };
    if (s.answers[id]) return { ok: false, reason: "already" };
    if (!Number.isInteger(i) || i < 0 || i > 3) return { ok: false, reason: "bad" };
    s.answers[id] = { i, ms: Math.max(0, now - s.openAt) };
    return { ok: true, events: [{ type: "answered", playerId: id }, ...this.maybeAdvance(now)] };
  }

  allAnswered() {
    const s = this.s;
    return s.eligible.every((id) => { const p = this.player(id); return s.answers[id] || !p || p.left || !p.online; });
  }

  // раскрытие: очки верным, палач — самый быстрый из верных, узники — ошибившиеся и молчавшие (§2–§3)
  reveal(now) {
    const s = this.s;
    const A = ACTS[s.act];
    const right = [], wrong = [];
    const gain = {};
    for (const id of s.eligible) {
      const p = this.player(id);
      if (!p || p.left) continue;
      const a = s.answers[id];
      if (a && a.i === s.q.right) {
        const k = Math.max(0, 1 - a.ms / T.answer);
        gain[id] = A.right + round10(A.speed * k);
        p.score += gain[id];
        p.stats.right++;
        p.stats.msSum += a.ms;
        right.push(id);
      } else wrong.push(id);
    }
    right.sort((x, y) => s.answers[x].ms - s.answers[y].ms);
    s.palach = right.length && wrong.length ? right[0] : null;
    s.prisoners = wrong;
    s.result = { gain, picks: [0, 1, 2, 3].map((k) => s.eligible.filter((id) => s.answers[id] && s.answers[id].i === k)) };
    s.phase = "reveal";
    s.phaseStart = now;
    s.phaseEnd = now + (wrong.length ? T.reveal : T.revealClean);
    const ev = [{ type: "reveal", right: s.q.right, clean: !wrong.length }];
    // все ошиблись — набор выбирает случай; палач офлайн — тоже, сразу
    if (wrong.length && (!s.palach || !this.player(s.palach).online)) this.pickGroup(s.palach, null, now, true);
    return ev;
  }

  pickGroup(id, group, now, auto = false) {
    const s = this.s;
    if (s.phase !== "reveal" || !s.prisoners.length) return { ok: false, reason: "not_now" };
    if (s.group) return { ok: false, reason: "already" };
    if (!auto && id !== s.palach) return { ok: false, reason: "not_palach" };
    if (!auto && !GROUPS_OFFERED.includes(group)) return { ok: false, reason: "bad" };
    s.group = auto ? GROUPS_OFFERED[this.rnd(GROUPS_OFFERED.length)] : group;
    s.groupAuto = auto;
    // палач выбрал раньше — раскрытие всё равно не короче revealMin
    if (!auto) s.phaseEnd = Math.max(s.phaseStart + T.revealMin, now);
    return { ok: true, events: [{ type: "group", group: s.group, auto }] };
  }

  // ---------- Камера ----------

  stage() {
    return this.s.act === 3 ? 3 : this.s.act;
  }

  openCell(now) {
    const s = this.s;
    const final = s.act === 3;
    if (!s.group) { s.group = GROUPS_OFFERED[this.rnd(GROUPS_OFFERED.length)]; s.groupAuto = true; }
    const cfg = CH.CELL[this.stage() - 1];
    const ready = now + CH.CELL_READY_MS;
    s.cellNeed = cfg.need;
    s.cell = {};
    for (const id of s.prisoners) {
      const p = this.player(id);
      p.stats.cells++;
      s.cell[id] = { done: 0, need: cfg.need, ch: null, lockUntil: 0, last: null, escaped: false, burned: false, at: null };
      if (p.online) this.issue(id, now, ready);
    }
    s.bets = {};
    s.phase = final ? "fcell" : "cell";
    s.phaseStart = now;
    s.phaseEnd = ready + CH.cellMs(s.group, this.stage());
    s.cellReady = ready;
    return [{ type: "cell", prisoners: s.prisoners.slice(), group: s.group }].concat(this.maybeAdvance(now));
  }

  // свободные: кто не в Камере и может ставить/подсказывать
  free() {
    const s = this.s;
    return this.present().filter((p) => !s.prisoners.includes(p.id) && s.eligible.includes(p.id));
  }

  issue(id, now, at = now) {
    const s = this.s;
    const c = s.cell[id];
    if (!c || c.escaped || c.burned) return;
    const helpers = this.free().filter((p) => p.online);
    const canPass = helpers.length >= 1 && this.present().length >= 3;
    // испытание не повторяется узнику за партию, пока пул набора не исчерпан (§4.1)
    const p = this.player(id);
    p.seen = p.seen || {};
    const seen = (p.seen[s.group] = p.seen[s.group] || []);
    // не выдаём то, что заведомо не успеть до конца Камеры (плейтест: «Перекличка» за 4 с до конца при нужных 6):
    // до 8 попыток, иначе — самое короткое из выпавших
    const left = s.phaseEnd != null && (s.phase === "cell" || s.phase === "fcell") ? s.phaseEnd - at : Infinity;
    let ch = null;
    for (let k = 0; k < 8; k++) {
      const x = CH.generate({ lvl: CH.levelFor(s.group, this.stage()), stage: this.stage(), rnd: this.rnd, group: s.group, last: c.last, seen, used: s.usedBank, canPass });
      if (!ch || x.minMs < ch.minMs) ch = x;
      if (x.minMs + 800 <= left) { ch = x; break; }
    }
    ch.id = ++s.seq;
    ch.at = at;
    if (ch.type === "pass") {
      const h = helpers[this.rnd(helpers.length)];
      ch.view.where = "phone";
      ch.view.helper = h.id;
      ch.passAt = at + PASS_SILENCE;
    }
    seen.push(ch.type);
    if (seen.length >= CH.poolFor({ lvl: ch.lvl, group: s.group, canPass: true, stage: this.stage() }).length) seen.length = 0;
    c.last = ch.type;
    c.ch = ch;
  }

  cellAnswer(id, cid, ans, now) {
    const s = this.s;
    if (s.phase !== "cell" && s.phase !== "fcell") return { ok: false, reason: "not_now" };
    const c = s.cell[id];
    if (!c || c.escaped || c.burned || !c.ch) return { ok: false, reason: "not_prisoner" };
    if (c.ch.id !== cid) return { ok: false, reason: "stale" };
    // битый ответ (не объект) — отказ без решётки: опечатка не должна стоить попытки
    if (!ans || typeof ans !== "object" || Array.isArray(ans)) return { ok: false, reason: "bad" };
    if (now < c.lockUntil) return { ok: false, reason: "locked" };
    const r = CH.check(c.ch, ans, now - c.ch.at);
    if (r === "early") return { ok: false, reason: "early" };
    if (r === "ok") {
      c.done++;
      if (c.done >= c.need) {
        c.escaped = true;
        c.at = now - s.phaseStart;
        c.ch = null;
        return { ok: true, events: [{ type: "escaped", playerId: id }, ...this.maybeAdvance(now)] };
      }
      this.issue(id, now);
      return { ok: true, events: [{ type: "cellOk", playerId: id, done: c.done }] };
    }
    // ошибка — решётка на 1,5 с, следующее испытание показывается после неё (§4.1)
    c.lockUntil = now + CH.WRONG_LOCK_MS;
    this.issue(id, now, c.lockUntil);
    return { ok: true, events: [{ type: "cellWrong", playerId: id }] };
  }

  bet(id, prisoner, escape, now) {
    const s = this.s;
    if (s.phase !== "cell" && s.phase !== "fcell") return { ok: false, reason: "not_now" };
    if (!this.free().some((p) => p.id === id)) return { ok: false, reason: "not_free" };
    if (!s.prisoners.includes(prisoner)) return { ok: false, reason: "bad" };
    if (typeof escape !== "boolean") return { ok: false, reason: "bad" };
    if (now > s.cellReady + BET_WINDOW) return { ok: false, reason: "closed" };
    if (s.bets[id] && s.bets[id][prisoner] != null) return { ok: false, reason: "already" };
    (s.bets[id] = s.bets[id] || {})[prisoner] = escape;
    return { ok: true, events: [] };
  }

  cellOver() {
    const s = this.s;
    return s.prisoners.every((id) => { const c = s.cell[id]; const p = this.player(id); return c.escaped || c.burned || !p || p.left || !p.online; });
  }

  // приговор: сгоревшие отлетают, угаданные ставки — +20 (§4.1)
  closeCell(now) {
    const s = this.s;
    const delta = {}, betGain = {};
    const escaped = [], burned = [];
    for (const id of s.prisoners) {
      const c = s.cell[id];
      const p = this.player(id);
      if (c.escaped) { escaped.push(id); if (p) p.stats.escapes++; }
      else { c.burned = true; burned.push(id); }
    }
    for (const [bid, picks] of Object.entries(s.bets)) {
      const b = this.player(bid);
      if (!b) continue;
      for (const [pid, esc] of Object.entries(picks)) {
        if (esc === s.cell[pid].escaped) {
          betGain[bid] = (betGain[bid] || 0) + BET_POINTS;
          b.stats.betHits++;
        }
      }
      if (betGain[bid]) b.score += betGain[bid];
    }
    if (s.act !== 3) {
      const N = ACTS[s.act].knock;
      for (const id of burned) {
        const p = this.player(id);
        if (!p) continue;
        p.score -= N; // пола нет — счёт уходит в минус (решение владельца)
        p.stats.knocks++;
        delta[id] = -N;
      }
    }
    for (const p of this.present()) p.stats.minScore = Math.min(p.stats.minScore, p.score);
    s.result = { ...(s.result || {}), escaped, burned, delta, betGain, bets: s.bets };
    if (s.act === 3) return this.finalReveal(now);
    s.phase = "verdict";
    s.phaseStart = now;
    s.phaseEnd = now + T.verdict + T.verdictStep * burned.length;
    return [{ type: "verdict", escaped, burned }];
  }

  // ---------- финал (§5) ----------

  startFinal(now) {
    const s = this.s;
    const raw = this.pickQuestion(3);
    if (!raw) return this.finish("done", now);
    this.clearQuestion();
    this.takeQuestion(raw);
    s.act = 3;
    s.stakes = {};
    s.eligible = this.present().map((p) => p.id);
    s.phase = "stake";
    s.phaseStart = now;
    s.phaseEnd = now + T.stake;
    return [{ type: "act", act: 3 }];
  }

  maxStake(p) {
    return Math.max(p.score, STAKE_FLOOR);
  }

  stake(id, n, now) {
    const s = this.s;
    if (s.phase !== "stake") return { ok: false, reason: "not_now" };
    if (!s.eligible.includes(id)) return { ok: false, reason: "not_in_question" };
    const p = this.player(id);
    if (!Number.isInteger(n) || n < 0 || n > this.maxStake(p)) return { ok: false, reason: "bad" };
    s.stakes[id] = n;
    return { ok: true, events: this.maybeAdvance(now) };
  }

  allStaked() {
    const s = this.s;
    return s.eligible.every((id) => { const p = this.player(id); return s.stakes[id] != null || !p || p.left || !p.online; });
  }

  finalAnswerClose(now) {
    const s = this.s;
    const wrong = [];
    for (const id of s.eligible) {
      const p = this.player(id);
      if (!p || p.left) continue;
      if (s.stakes[id] == null) s.stakes[id] = 0;
      p.stats.stake = s.stakes[id];
      const a = s.answers[id];
      if (a && a.i === s.q.right) p.stats.finalMs = a.ms;
      else wrong.push(id);
    }
    s.prisoners = wrong;
    s.result = { picks: [0, 1, 2, 3].map((k) => s.eligible.filter((id) => s.answers[id] && s.answers[id].i === k)) };
    if (wrong.length) { s.group = GROUPS_OFFERED[this.rnd(GROUPS_OFFERED.length)]; s.groupAuto = true; }
    // зал видит верный ответ финала, потом — Камера ошибившимся или сразу раскрытие ставок
    s.phase = "fshow";
    s.phaseStart = now;
    s.phaseEnd = now + T.fshow;
    return [{ type: "reveal", right: s.q.right, final: true }];
  }

  // по одному снизу таблицы вверх: верно +ставка, спасся −½, сгорел −вся (§5)
  finalReveal(now) {
    const s = this.s;
    const ids = s.eligible.filter((id) => { const p = this.player(id); return p && !p.left; });
    ids.sort((x, y) => this.player(x).score - this.player(y).score);
    s.fsteps = ids.map((id) => {
      const p = this.player(id);
      const st = s.stakes[id] || 0;
      const right = !!(s.answers[id] && s.answers[id].i === s.q.right);
      const c = s.cell[id];
      const escaped = right ? null : !!(c && c.escaped);
      const d = right ? st : escaped ? -Math.floor(st / 2) : -st;
      const before = p.score;
      p.score += d;
      p.stats.minScore = Math.min(p.stats.minScore, p.score);
      return { id, stake: st, right, escaped, delta: d, before, after: p.score };
    });
    s.phase = "freveal";
    s.phaseStart = now;
    s.phaseEnd = now + T.frevealStep * s.fsteps.length + T.frevealTail;
    return [{ type: "freveal" }];
  }

  // ---------- такт ----------

  maybeAdvance(now) {
    const s = this.s;
    if (s.paused != null) return [];
    if ((s.phase === "answer" || s.phase === "fanswer") && this.allAnswered()) {
      return s.phase === "answer" ? this.reveal(now) : this.finalAnswerClose(now);
    }
    if (s.phase === "stake" && this.allStaked()) return this.openFinalQuestion(now);
    if ((s.phase === "cell" || s.phase === "fcell") && this.cellOver()) return this.closeCell(now);
    return [];
  }

  openFinalQuestion(now) {
    const s = this.s;
    s.phase = "fread";
    s.phaseStart = now;
    s.phaseEnd = now + T.fread;
    return [{ type: "question", qn: "final" }];
  }

  // ближайший срок: конец фазы, «Передачка», которой пора на доску, или показ испытания после решётки (now — часы комнаты)
  nextDeadline(now) {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished" || s.paused != null) return null;
    let t = s.phaseEnd;
    for (const c of Object.values(s.cell)) {
      if (c.ch && c.ch.passAt && c.ch.view.where === "phone" && c.ch.passAt < t) t = c.ch.passAt;
      // испытание показывается в момент открытия решётки / конца «Приготовься» — снимок должен уйти ровно тогда
      if (now != null && c.ch && c.ch.at > now && c.ch.at < t) t = c.ch.at;
    }
    return t;
  }

  tick(now) {
    const s = this.s;
    if (s.paused != null) return [];
    const ev = [];
    for (const [id, c] of Object.entries(s.cell)) {
      if (c.ch && c.ch.passAt && c.ch.view.where === "phone" && now >= c.ch.passAt) {
        c.ch.view.where = "tv";
        ev.push({ type: "passTv", playerId: id });
      }
    }
    if (s.phaseEnd == null || now < s.phaseEnd) return ev;
    switch (s.phase) {
      case "intro": return ev.concat(this.nextQuestion(now));
      case "read":
        s.phase = "answer";
        s.phaseStart = now;
        s.openAt = now;
        s.phaseEnd = now + T.answer;
        return ev.concat([{ type: "open" }], this.maybeAdvance(now));
      case "answer": return ev.concat(this.reveal(now));
      case "reveal": return ev.concat(s.prisoners.length ? this.openCell(now) : this.nextQuestion(now));
      case "cell": case "fcell": return ev.concat(this.closeCell(now));
      case "verdict": return ev.concat(this.nextQuestion(now));
      case "stake": return ev.concat(this.openFinalQuestion(now));
      case "fread":
        s.phase = "fanswer";
        s.phaseStart = now;
        s.openAt = now;
        s.phaseEnd = now + T.fanswer;
        return ev.concat([{ type: "open" }], this.maybeAdvance(now));
      case "fanswer": return ev.concat(this.finalAnswerClose(now));
      case "fshow": return ev.concat(s.prisoners.length ? this.openCell(now) : this.finalReveal(now));
      case "freveal": return ev.concat(this.finish("done", now));
      default: return ev;
    }
  }

  // ---------- итоги ----------

  // место: очки → быстрее верный в финале → меньше отлётов → быстрее средний верный → делят (§2)
  ranking() {
    const ps = this.present();
    const avg = (p) => (p.stats.right ? p.stats.msSum / p.stats.right : Infinity);
    const fin = (p) => (p.stats.finalMs == null ? Infinity : p.stats.finalMs);
    const d = (x, y) => (x === y ? 0 : x - y); // Infinity − Infinity = NaN ломал ничью
    const cmp = (a, b) => b.score - a.score || d(fin(a), fin(b)) || a.stats.knocks - b.stats.knocks || d(avg(a), avg(b));
    const sorted = ps.slice().sort(cmp);
    let place = 0;
    return sorted.map((p, i) => {
      if (i === 0 || cmp(sorted[i - 1], p) !== 0) place = i + 1;
      return { id: p.id, place, score: p.score };
    });
  }

  // награды (§2): лучший по счётчику; награду, которую делят больше двоих, не показываем
  awards() {
    const ps = this.present();
    const s = this.s;
    const best = (val, ok = () => true, low = false) => {
      const c = ps.filter(ok).map((p) => [p, val(p)]).filter(([, v]) => v != null && isFinite(v));
      if (!c.length) return null;
      const m = low ? Math.min(...c.map(([, v]) => v)) : Math.max(...c.map(([, v]) => v));
      const ids = c.filter(([, v]) => v === m).map(([p]) => p.id);
      return ids.length <= 2 ? { ids, n: m } : null;
    };
    const pos = (x) => (x && x.n > 0 ? x : null);
    return {
      unkillable: pos(best((p) => p.stats.escapes)),
      regular: pos(best((p) => p.stats.cells)),
      rocket: best((p) => p.stats.msSum / p.stats.right, (p) => p.stats.right >= 3, true),
      kamikaze: s.settings.final ? pos(best((p) => p.stats.stake)) : null,
      seer: pos(best((p) => p.stats.betHits)),
      bottom: (() => { const b = best((p) => p.stats.minScore, () => true, true); return b && b.n < 0 ? b : null; })(),
    };
  }

  finish(reason, now) {
    const s = this.s;
    s.phase = "finished";
    s.phaseStart = now;
    s.phaseEnd = null;
    s.paused = null;
    s.finishedReason = reason;
    s.awards = this.awards();
    s.ranking = this.ranking();
    return [{ type: "final", reason }];
  }

  // ---------- ведущий ----------

  toLobby(now) {
    const s = this.s;
    const ev = s.phase === "lobby" || s.phase === "finished" ? [] : this.finish("host", now);
    s.phase = "lobby";
    s.players = s.players.filter((p) => !p.left);
    this.clearQuestion();
    s.fsteps = null;
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

  // испытание для клиента: без ответа и служебных полей
  static chView(ch) {
    if (!ch) return null;
    return { id: ch.id, type: ch.type, group: ch.group, lvl: ch.lvl, view: ch.view, at: ch.at, minMs: ch.minMs };
  }

  /*
   * view: "board" — доска, иначе id игрока (или null — зритель).
   * До раскрытия никому: верный ответ, чужие ответы, палач и узники (выдают, кто ошибся), дельты очков.
   * Ставки — только их авторам до приговора. Ответы испытаний — никому.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const ph = s.phase;
    const qShown = ["read", "answer", "reveal", "cell", "verdict", "fread", "fanswer", "fshow", "fcell", "freveal"].includes(ph);
    const revealed = ["reveal", "cell", "verdict", "freveal", "fshow", "fcell"].includes(ph);
    const inCell = ph === "cell" || ph === "fcell";
    const afterCell = ph === "verdict" || ph === "freveal";
    const q = s.q;
    const lang = s.settings.lang;
    const tx = (o) => (o && typeof o === "object" ? o[lang] || o.ru || "" : o);

    let cell = null;
    if (inCell || afterCell) {
      cell = s.prisoners.map((id) => {
        const c = s.cell[id] || {};
        // пока открыто окно ставок — прогресс узника не показываем никому, кроме него самого (исход не должен подсказывать ставку)
        const hide = inCell && now < s.cellReady + BET_WINDOW;
        const x = { id, done: hide ? 0 : c.done || 0, need: c.need || s.cellNeed, escaped: !hide && !!c.escaped, burned: !!c.burned, locked: !hide && c.lockUntil > now, type: c.ch ? c.ch.type : null };
        // доске — вопрос «Головы» (не на память), чтобы зал подсказывал; и код «Передачки» после 4 с тишины
        if (board && c.ch && c.ch.at <= now && c.ch.group === "head" && !CH.MEMORY_TYPES.includes(c.ch.type)) x.ch = Game.chView(c.ch);
        if (board && c.ch && c.ch.type === "pass" && c.ch.view.where === "tv") x.passCode = c.ch.answer;
        return x;
      });
    }

    let mePart = null;
    if (me) {
      const c = s.cell[me.id];
      const a = s.answers[me.id];
      // подсказчик «Передачки»: код и своя ставка на этого узника рядом (§4.2)
      const hints = [];
      if (inCell) for (const [pid, pc] of Object.entries(s.cell)) {
        if (pc.ch && pc.ch.type === "pass" && pc.ch.view.helper === me.id && !pc.escaped) {
          hints.push({ prisoner: pid, code: pc.ch.answer, bet: s.bets[me.id] ? s.bets[me.id][pid] ?? null : null });
        }
      }
      mePart = {
        id: me.id,
        inQuestion: s.eligible.includes(me.id),
        answer: a ? a.i : null,
        palach: ph === "reveal" && s.palach === me.id && !s.group,
        cell: c && (inCell || afterCell) ? { done: c.done, need: c.need, escaped: c.escaped, burned: c.burned, lockUntil: c.lockUntil, ch: inCell && !c.escaped && c.ch && c.ch.at <= now ? Game.chView(c.ch) : null, readyAt: c.ch ? c.ch.at : null } : null,
        free: inCell && this.free().some((p) => p.id === me.id),
        bets: s.bets[me.id] || {},
        passHints: hints,
        stake: s.stakes[me.id] ?? null,
        maxStake: ph === "stake" ? this.maxStake(me) : null,
        gain: revealed && s.result && s.result.gain ? s.result.gain[me.id] || 0 : null,
      };
    }

    return {
      phase: ph,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      game: s.game,
      // на заставке акта qn ещё не увеличен — показываем номер следующего вопроса
      qn: ph === "intro" ? s.qn + 1 : s.qn,
      qTotal: s.plan.length,
      act: s.act,
      points: ACTS[s.act] || null,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      openAt: s.openAt,
      paused: s.paused != null,
      // финал: тему видно на ставках, вопрос — с fread
      question: q && (qShown || ph === "stake") ? {
        tag: q.tag,
        lvl: q.lvl,
        final: q.final,
        text: ph === "stake" ? null : tx(q.text),
        options: ph === "stake" ? null : q.options.map(tx),
      } : null,
      answered: ph === "answer" || ph === "fanswer" ? Object.keys(s.answers) : null,
      eligible: s.eligible,
      right: revealed && q ? q.right : null,
      picks: revealed && s.result ? s.result.picks : null,
      gain: revealed && s.result ? s.result.gain || null : null,
      palach: revealed && ph !== "fcell" && ph !== "fshow" ? s.palach : null,
      prisoners: revealed ? s.prisoners : null,
      group: revealed ? s.group : null,
      groupAuto: revealed ? !!s.groupAuto : null,
      cellEnd: inCell ? s.phaseEnd : null,
      betUntil: inCell ? s.cellReady + BET_WINDOW : null,
      cell,
      betN: inCell ? Object.keys(s.bets).length : null,
      freeN: inCell ? this.free().filter((p) => p.online).length : null,
      verdict: afterCell && s.result ? { escaped: s.result.escaped, burned: s.result.burned, delta: s.result.delta, betGain: s.result.betGain, bets: s.result.bets } : null,
      stakedN: ph === "stake" ? Object.keys(s.stakes).length : null,
      fsteps: ph === "freveal" ? s.fsteps : null,
      awards: ph === "finished" ? s.awards || null : null,
      ranking: ph === "finished" ? s.ranking || null : null,
      finishedReason: ph === "finished" ? s.finishedReason : null,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      me: mePart,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        online: p.online,
        left: p.left,
        // во время раскрытия финала очки показываем «до»: доска двигает их по шагам
        score: ph === "freveal" && s.fsteps ? (s.fsteps.find((x) => x.id === p.id) || { before: p.score }).before : p.score,
      })),
    };
  }
}

module.exports = { Game, ACTS, QUESTIONS, ACT_LVL, ACT_LVL_W, T, PASS_SILENCE, BET_POINTS, BET_WINDOW, STAKE_FLOOR, GROUPS_OFFERED, DEFAULTS, MAX_PLAYERS, MIN_PLAYERS, REACTIONS, COLORS, AVATARS, clampSettings, cleanName, cleanText };
