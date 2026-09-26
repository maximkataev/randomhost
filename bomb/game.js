"use strict";

/*
 * Движок бомбы: чистая логика без сети и таймеров (bomb-spec.md).
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1, bytes(n) → Buffer (соль печати).
 * Каждый метод возвращает события для эффектов на клиентах ({type, ...}).
 *
 * Честность (§3): длина фитиля выбирается при создании раунда, наружу уходит только хеш-печать.
 * Время взрыва (`explodeAt`) и соль не попадают ни в один снимок до взрыва — поэтому в снимке
 * нет и общего `deadline` в фазе игры: по нему взрыв вычислялся бы с точностью до миллисекунды.
 */

const crypto = require("crypto");
const CH = require("./challenges");

const FUSES = {
  short: [20, 45],
  normal: [30, 90],
  long: [60, 150],
};
const MODES = ["classic", "elim", "two", "quiz"];

const DEFAULTS = {
  mode: "classic",
  fuse: "normal",
  returnOk: false, // можно сразу вернуть бомбу тому, кто её кинул (§4)
  groups: { hands: true, eyes: true, head: true },
  lang: "ru",
};

const T = {
  countdown: 3000, // печать на экране + 3-2-1
  boom: 4500, // вспышка и «Стендап ведёт…»
};

const MAX_PLAYERS = 16;
const MIN_PLAYERS = 2;
const TWO_BOMBS_MIN = 6;
const REACT_GAP = 2000;
const REACTIONS = ["😂", "😱", "🔥", "🙏", "😈"];

// 16 цветов карточек: ярко и различимо на светлом комиксовом фоне
const COLORS = ["#ff4d4d", "#2f80ff", "#ffb800", "#18b377", "#a259ff", "#ff7a1a", "#00b8d9", "#ff4fa3", "#6e7d2c", "#8a5a2b", "#3c4bd6", "#e0457b", "#0f9d8a", "#c77dff", "#d4a100", "#5b6b7a"];

function clampSettings(input = {}) {
  const s = { ...DEFAULTS, groups: { ...DEFAULTS.groups } };
  if (MODES.includes(input.mode)) s.mode = input.mode;
  if (FUSES[input.fuse]) s.fuse = input.fuse;
  if (typeof input.returnOk === "boolean") s.returnOk = input.returnOk;
  if (input.groups && typeof input.groups === "object") {
    for (const g of Object.keys(DEFAULTS.groups)) if (typeof input.groups[g] === "boolean") s.groups[g] = input.groups[g];
    // все группы выключить нельзя — остаётся ловкость
    if (!Object.values(s.groups).some(Boolean)) s.groups.hands = true;
  }
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  return s;
}

// имя игрока: без управляющих символов, без лишних пробелов, до 16 символов
function cleanName(name) {
  return String(name || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
}

// Строка печати: её хеш показывается до старта, сама она — после взрыва (§3)
function sealString(code, round, bomb, fuseMs, salt) {
  return `bomb-v1|${code}|${round}.${bomb}|${fuseMs}|${salt}`;
}
const sha256 = (str) => crypto.createHash("sha256").update(str).digest("hex");

const defaultRnd = (n) => crypto.randomInt(n);
const defaultBytes = (n) => crypto.randomBytes(n);

class Game {
  constructor(state, rnd = defaultRnd, bytes = defaultBytes) {
    this.s = state;
    this.rnd = rnd;
    this.bytes = bytes;
  }

  static create({ settings, code = "", rnd, bytes } = {}) {
    return new Game({
      code,
      settings: clampSettings(settings),
      phase: "lobby", // lobby | countdown | live | boom | finished
      players: [],
      game: 0, // номер партии в комнате
      round: 0, // сквозной номер раунда в комнате (входит в печать)
      roundInGame: 0,
      phaseEnd: null, // конец отсчёта или показа взрыва — публичный
      startedAt: null, // начало горения фитиля
      bombs: [], // {id, holder, from, since, fuseMs, salt, commit, explodeAt, min, max, alive}
      challenges: {}, // playerId → испытание (с ответом — только на сервере)
      armed: {}, // playerId → true: испытание пройдено, можно кидать
      lastType: {}, // playerId → тип прошлого испытания
      used: { quiz: [], tf: [], heavy: [], chrono: [] },
      log: [], // передачи раунда: {b, from, to, at, held}
      seals: [], // печати партии: {round, bomb, commit, min, max, fuseMs?, salt?, revealed}
      booms: [], // взрывы партии: {round, bomb, playerId, at}
      stats: null, // итоги последнего раунда (§7)
      seq: 0,
      loserId: null, // ведёт стендап
      winnerId: null, // «на выбывание»: последний выживший
      finishedReason: null, // boom | last | few | host
    }, rnd, bytes);
  }

  static from(state, rnd, bytes) {
    return new Game(state, rnd, bytes);
  }

  // ---------- участники ----------

  player(id) {
    return this.s.players.find((p) => p.id === id);
  }

  alive() {
    return this.s.players.filter((p) => !p.out && !p.left);
  }

  // кидать можно только живым участникам партии; в лобби и на итогах — вход открыт
  addPlayer({ id, name }) {
    const s = this.s;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "game_started" };
    if (s.players.filter((p) => !p.left).length >= MAX_PLAYERS) return { ok: false, reason: "room_full" };
    name = cleanName(name);
    if (!name) return { ok: false, reason: "bad_name" };
    const used = new Set(s.players.filter((p) => !p.left).map((p) => p.color));
    const p = {
      id,
      name,
      color: COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length],
      online: true,
      left: false,
      out: false,
      outRound: null,
      lastReact: null,
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
    delete s.challenges[id];
    delete s.armed[id];
    const ev = [{ type: "left", playerId: id }];
    if (this.alive().length < MIN_PLAYERS) return ev.concat(this.finish("few", now));
    // ушёл с бомбой — она достаётся случайному живому игроку: не висеть же ей в воздухе
    if (s.phase === "live") {
      for (const b of s.bombs) {
        if (!b.alive || b.holder !== id) continue;
        const alive = this.alive();
        const to = alive[this.rnd(alive.length)];
        b.holder = to.id; b.from = null; b.since = now;
        ev.push({ type: "pass", bomb: b.id, from: id, to: to.id, at: now, dropped: true });
        this.ensureChallenge(to.id, now);
      }
    }
    return ev;
  }

  setOnline(id, online) {
    const p = this.player(id);
    if (p) p.online = online;
    return [];
  }

  // ---------- ход партии ----------

  range() {
    return FUSES[this.s.settings.fuse];
  }

  bombCount() {
    return this.s.settings.mode === "two" && this.alive().length >= TWO_BOMBS_MIN ? 2 : 1;
  }

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    if (this.alive().length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    s.game++;
    s.roundInGame = 0;
    s.seals = [];
    s.booms = [];
    s.used = { quiz: [], tf: [], heavy: [], chrono: [] };
    s.loserId = null;
    s.winnerId = null;
    s.finishedReason = null;
    for (const p of s.players) { p.out = false; p.outRound = null; }
    return { ok: true, events: [{ type: "started", game: s.game }, ...this.beginRound(now)] };
  }

  // Новый раунд: фитили выбраны и запечатаны сразу, держатель — только после отсчёта (§3)
  beginRound(now) {
    const s = this.s;
    s.round++;
    s.roundInGame++;
    s.phase = "countdown";
    s.phaseEnd = now + T.countdown;
    s.startedAt = null;
    s.challenges = {};
    s.armed = {};
    s.log = [];
    s.stats = null;
    const [min, max] = this.range();
    s.bombs = [];
    for (let id = 0; id < this.bombCount(); id++) {
      const fuseMs = (min + this.rnd(max - min + 1)) * 1000;
      const salt = this.bytes(16).toString("hex");
      const commit = sha256(sealString(s.code, s.round, id, fuseMs, salt));
      s.bombs.push({ id, holder: null, from: null, since: null, fuseMs, salt, commit, explodeAt: null, min, max, alive: true });
      s.seals.push({ round: s.round, bomb: id, commit, min, max, revealed: false });
    }
    return [{ type: "round", round: s.round, bombs: s.bombs.length }];
  }

  goLive(now) {
    const s = this.s;
    s.phase = "live";
    s.phaseEnd = null;
    s.startedAt = now;
    // первые держатели — случайные и разные (две бомбы не начинают у одного)
    let pool = this.alive();
    const ev = [{ type: "live" }];
    for (const b of s.bombs) {
      if (!pool.length) pool = this.alive();
      const p = pool.splice(this.rnd(pool.length), 1)[0];
      b.holder = p.id;
      b.since = now;
      b.explodeAt = now + b.fuseMs;
      ev.push({ type: "pass", bomb: b.id, from: null, to: p.id, at: now });
      this.ensureChallenge(p.id, now);
    }
    return ev;
  }

  holding(id) {
    return this.s.bombs.filter((b) => b.alive && b.holder === id);
  }

  ensureChallenge(id, now) {
    const s = this.s;
    if (s.challenges[id] || s.armed[id]) return;
    if (!this.holding(id).length) return;
    this.issue(id, now);
  }

  issue(id, now) {
    const s = this.s;
    const lvl = CH.levelFor(now - (s.startedAt || now));
    const c = CH.generate({ lvl, rnd: this.rnd, groups: s.settings.groups, quizOnly: s.settings.mode === "quiz", last: s.lastType[id], used: s.used });
    c.id = ++s.seq;
    c.at = now;
    s.challenges[id] = c;
    s.lastType[id] = c.type;
    return c;
  }

  answer(id, cid, ans, now) {
    const s = this.s;
    if (s.phase !== "live") return { ok: false, reason: "not_live" };
    const c = s.challenges[id];
    if (!c || c.id !== cid) return { ok: false, reason: "stale" };
    const verdict = CH.check(c, ans, now - c.at);
    if (verdict === "early") return { ok: false, reason: "early" };
    if (verdict === "wrong") {
      // ошибся — новое испытание того же уровня; штраф — потерянное время
      const next = CH.generate({ lvl: c.lvl, rnd: this.rnd, groups: s.settings.groups, quizOnly: s.settings.mode === "quiz", last: c.type, used: s.used });
      next.id = ++s.seq;
      next.at = now;
      s.challenges[id] = next;
      s.lastType[id] = next.type;
      return { ok: true, events: [{ type: "wrong", playerId: id, was: c.type }] };
    }
    delete s.challenges[id];
    s.armed[id] = true;
    return { ok: true, events: [{ type: "armed", playerId: id, was: c.type }] };
  }

  // можно ли кинуть бомбу b этому игроку
  canTarget(b, fromId, toId) {
    const to = this.player(toId);
    if (!to || to.out || to.left || toId === fromId) return false;
    if (!this.s.settings.returnOk && this.alive().length > 2 && b.from === toId) return false;
    return true;
  }

  pass(id, toId, now) {
    const s = this.s;
    if (s.phase !== "live") return { ok: false, reason: "not_live" };
    const mine = this.holding(id).sort((a, b) => a.since - b.since);
    if (!mine.length) return { ok: false, reason: "no_bomb" };
    if (!s.armed[id]) return { ok: false, reason: "not_armed" };
    const b = mine[0];
    const to = this.player(toId);
    if (!to || to.out || to.left || toId === id) return { ok: false, reason: "bad_target" };
    if (!this.canTarget(b, id, toId)) return { ok: false, reason: "no_return" };
    s.log.push({ b: b.id, from: id, to: toId, at: now, held: now - b.since });
    b.from = id;
    b.holder = toId;
    b.since = now;
    delete s.armed[id];
    const ev = [{ type: "pass", bomb: b.id, from: id, to: toId, at: now }];
    // вторая бомба ещё в руках — за неё отдельное испытание (§6)
    this.ensureChallenge(id, now);
    this.ensureChallenge(toId, now);
    return { ok: true, events: ev };
  }

  // ближайший срок: конец отсчёта, взрыв или протухшее испытание (§5: 12 с)
  nextDeadline() {
    const s = this.s;
    if (s.phase === "countdown" || s.phase === "boom") return s.phaseEnd;
    if (s.phase !== "live") return null;
    let t = Infinity;
    for (const b of s.bombs) if (b.alive) t = Math.min(t, b.explodeAt);
    for (const c of Object.values(s.challenges)) t = Math.min(t, c.at + CH.CHALLENGE_TTL);
    return t === Infinity ? null : t;
  }

  tick(now) {
    const s = this.s;
    if (s.phase === "countdown" && now >= s.phaseEnd) return this.goLive(now);
    if (s.phase === "boom" && now >= s.phaseEnd) return this.afterBoom(now);
    if (s.phase !== "live") return [];
    // первым взрывается тот фитиль, чей срок раньше; держатель — по состоянию на этот момент
    const due = s.bombs.filter((b) => b.alive && b.explodeAt <= now).sort((a, b) => a.explodeAt - b.explodeAt)[0];
    if (due) return this.explode(due, now);
    const ev = [];
    for (const [pid, c] of Object.entries(s.challenges)) {
      if (now - c.at < CH.CHALLENGE_TTL) continue;
      delete s.challenges[pid];
      this.issue(pid, now);
      ev.push({ type: "swap", playerId: pid });
    }
    return ev;
  }

  explode(b, now) {
    const s = this.s;
    const at = b.explodeAt;
    const victim = b.holder;
    // остальные бомбы гаснут: первый взрыв заканчивает раунд, их печати тоже вскрываем
    for (const x of s.bombs) x.alive = false;
    this.reveal();
    s.booms.push({ round: s.round, bomb: b.id, playerId: victim, at });
    s.stats = this.roundStats(at, victim);
    s.challenges = {};
    s.armed = {};
    s.phase = "boom";
    s.phaseEnd = now + T.boom;
    if (!s.loserId) s.loserId = victim; // стендап ведёт первый взорвавшийся партии
    const ev = [{ type: "boom", bomb: b.id, playerId: victim, at }];
    if (s.settings.mode === "elim") {
      const p = this.player(victim);
      if (p) { p.out = true; p.outRound = s.roundInGame; }
      ev.push({ type: "out", playerId: victim });
    }
    return ev;
  }

  afterBoom(now) {
    const s = this.s;
    if (s.settings.mode === "elim") {
      const alive = this.alive();
      if (alive.length >= 2) return this.beginRound(now);
      return this.finish("last", now);
    }
    return this.finish("boom", now);
  }

  reveal() {
    const s = this.s;
    for (const b of s.bombs) {
      const seal = s.seals.find((x) => x.round === s.round && x.bomb === b.id);
      if (seal && !seal.revealed) Object.assign(seal, { fuseMs: b.fuseMs, salt: b.salt, revealed: true });
    }
  }

  finish(reason, now) {
    const s = this.s;
    if (s.phase === "live" || s.phase === "countdown") {
      for (const b of s.bombs) b.alive = false;
      this.reveal();
      if (!s.stats && s.phase === "live") s.stats = this.roundStats(now, null);
    }
    s.phase = "finished";
    s.phaseEnd = null;
    s.challenges = {};
    s.armed = {};
    s.finishedReason = reason;
    if (s.settings.mode === "elim") {
      const alive = this.alive();
      if (alive.length === 1) s.winnerId = alive[0].id;
    }
    return [{ type: "final", reason }];
  }

  // Итоги раунда (§7): дольше всех держал, больше всех получал, самый быстрый бросок, любимая цель
  roundStats(until, victim) {
    const s = this.s;
    const hold = {}, got = {}, pairs = {};
    let fastest = null;
    for (const x of s.log) {
      hold[x.from] = (hold[x.from] || 0) + x.held;
      got[x.to] = (got[x.to] || 0) + 1;
      pairs[x.to] = (pairs[x.to] || 0) + 1;
      if (!fastest || x.held < fastest.ms) fastest = { playerId: x.from, ms: x.held };
    }
    // бомба, что была в руках в момент конца, тоже считается
    for (const b of s.bombs) if (b.holder && b.since != null) hold[b.holder] = (hold[b.holder] || 0) + Math.max(0, until - b.since);
    const top = (o) => { let k = null; for (const id of Object.keys(o)) if (k == null || o[id] > o[k]) k = id; return k ? { playerId: k, n: o[k] } : null; };
    return {
      passes: s.log.length,
      duration: s.startedAt ? until - s.startedAt : 0,
      longest: top(hold),
      mostGot: top(got),
      fastest,
      victim,
    };
  }

  // ---------- ведущий ----------

  toLobby(now) {
    const s = this.s;
    const ev = s.phase === "lobby" || s.phase === "finished" ? [] : this.finish("host", now);
    s.phase = "lobby";
    s.players = s.players.filter((p) => !p.left);
    for (const p of s.players) { p.out = false; p.outRound = null; }
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
   * view: "board" — доска, иначе id игрока. Никому не уходят fuseMs, salt и explodeAt живых бомб,
   * ответы испытаний и общий срок фазы игры (§3). Доска видит испытания всех держателей (без ответов),
   * игрок — только своё.
   */
  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const pub = (c) => (c ? { id: c.id, type: c.type, group: c.group, lvl: c.lvl, view: c.view, at: c.at, minMs: c.minMs, ttl: CH.CHALLENGE_TTL } : null);
    const holders = {};
    for (const b of s.bombs) if (b.alive && b.holder) holders[b.holder] = true;
    return {
      phase: s.phase,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      game: s.game,
      round: s.round,
      roundInGame: s.roundInGame,
      phaseEnd: s.phase === "countdown" || s.phase === "boom" ? s.phaseEnd : null,
      startedAt: s.startedAt,
      fuse: { min: this.range()[0], max: this.range()[1] },
      bombs: s.bombs.map((b) => ({ id: b.id, holder: b.holder, from: b.from, since: b.since, alive: b.alive, commit: b.commit, min: b.min, max: b.max })),
      seals: s.seals.map((x) => (x.revealed ? { ...x, seal: sealString(s.code, x.round, x.bomb, x.fuseMs, x.salt) } : { round: x.round, bomb: x.bomb, commit: x.commit, min: x.min, max: x.max, revealed: false })),
      booms: s.booms,
      passes: s.log.length,
      lastPass: s.log.length ? s.log[s.log.length - 1] : null,
      stats: s.phase === "boom" || s.phase === "finished" ? s.stats : null,
      loserId: s.phase === "boom" || s.phase === "finished" ? s.loserId : null,
      winnerId: s.phase === "finished" ? s.winnerId : null,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      twoBombsMin: TWO_BOMBS_MIN,
      challenges: board ? Object.fromEntries(Object.entries(s.challenges).map(([k, c]) => [k, pub(c)])) : null,
      me: me ? { id: me.id, challenge: pub(s.challenges[me.id]), armed: !!s.armed[me.id], holding: this.holding(me.id).map((b) => b.id) } : null,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        online: p.online,
        left: p.left,
        out: p.out,
        outRound: p.outRound,
        holding: !!holders[p.id],
        solving: s.challenges[p.id] ? s.challenges[p.id].type : null,
        armed: !!s.armed[p.id],
      })),
    };
  }
}

module.exports = { Game, FUSES, MODES, DEFAULTS, T, MAX_PLAYERS, MIN_PLAYERS, TWO_BOMBS_MIN, REACTIONS, COLORS, clampSettings, cleanName, sealString, sha256 };
