"use strict";

/*
 * Движок «Ставок»: чистая логика без сети и таймеров (bets-spec.md §5, §6).
 * Всё состояние лежит в plain-объекте `this.s`, его можно дампить в JSON; рынки текущего события
 * пересобираются из `s.ev.type` и `s.ev.input` (registry.rebuild), поэтому коэффициенты после рестарта те же.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) по ближайшему deadline.
 * Случайность тоже снаружи (`rnd(n)` → целое 0..n-1).
 * Каждый метод возвращает список событий для эффектов на клиентах ({type, ...}).
 *
 * Одновременные ставки в окне 20 с, затем запирание, сцена, выплаты. Займов нет: ноль фишек — вылет.
 */
const { payout, MIN_STAKE } = require("./odds");
const R = require("./registry");

const MAX_PLAYERS = 12;
const MAX_BETS = 6;          // разных рынков в купоне
const LOCK_MS = 2000;
const PAYOUT_MS = 7000;
const LIVE_SCENE_MS = 3000;  // реальный исход пришёл: вспышка, проверка купонов
// минимальная ставка на событие в процентах от стартового стека (§6.3)
const LEVELS = [3, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25];

const DEFAULTS = { stack: 1000, betMs: 20000, events: 12, mode: "mixed" };
const ALLOWED = { stack: [500, 1000, 2000], betMs: [15000, 20000, 30000], events: [8, 12, 16, 0], mode: ["mixed", "real", "scenic"] };

class Game {
  constructor(rnd, opts = {}) {
    this.rnd = rnd;
    // prepareLive(type) → входные данные реального события из feed.js или null (источник недоступен)
    this.prepareLive = opts.prepareLive || (() => null);
    // какие реальные события включены (сервер отдаёт список из feed); по умолчанию все — для тестов движка
    this.liveTypes = opts.liveTypes || (() => R.REAL);
    this.cur = null; // собранное событие с функциями test (в дамп не идёт)
    this.s = {
      phase: "lobby",
      settings: { ...DEFAULTS },
      players: {},
      order: [],
      schedule: [],
      idx: -1,
      ev: null,
      deadline: 0,
      winner: null,
      stats: {},
    };
  }

  static restore(s, rnd, opts) {
    const g = new Game(rnd, opts);
    g.s = s;
    if (s.ev) g.cur = R.rebuild(s.ev.type, s.ev.input);
    return g;
  }

  dump() { return this.s; }

  // ---------- лобби ----------

  addPlayer(id, name) {
    const s = this.s;
    if (s.phase !== "lobby" || s.players[id] || s.order.length >= MAX_PLAYERS) return [];
    s.players[id] = { id, name: String(name).slice(0, 20), stack: 0, alive: true, online: true, draft: {}, submitted: false, coupon: null, last: null, maxWin: 0, outAt: null };
    s.order.push(id);
    return [{ type: "join", id }];
  }

  removePlayer(id) {
    const s = this.s;
    if (!s.players[id]) return [];
    if (s.phase === "lobby") {
      delete s.players[id];
      s.order = s.order.filter((x) => x !== id);
    } else {
      // посреди партии игрок остаётся в таблице, но больше не ставит
      s.players[id].alive = false;
      s.players[id].outAt = s.idx;
    }
    return [{ type: "leave", id }];
  }

  setOnline(id, online) { if (this.s.players[id]) this.s.players[id].online = !!online; }

  setSettings(patch) {
    if (this.s.phase !== "lobby") return false;
    for (const [k, v] of Object.entries(patch || {})) {
      if (ALLOWED[k] && ALLOWED[k].includes(v)) this.s.settings[k] = v;
    }
    return true;
  }

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" || s.order.length < 2) return [];
    const n = s.settings.events || 40; // «без лимита»: расписание на запас, конец — по выжившим
    s.schedule = R.makeSchedule(n, this.rnd, s.settings.mode, this.liveTypes().filter((t) => R.REAL.includes(t)));
    for (const p of Object.values(s.players)) { p.stack = s.settings.stack; p.alive = true; }
    s.idx = -1;
    return [{ type: "start" }, ...this.nextEvent(now)];
  }

  // ---------- событие ----------

  minStake(p) {
    const pct = LEVELS[Math.min(this.s.idx, LEVELS.length - 1)];
    return Math.min(p.stack, Math.max(MIN_STAKE, Math.ceil(this.s.settings.stack * pct / 100)));
  }

  nextEvent(now) {
    const s = this.s;
    s.idx++;
    let type = s.schedule[s.idx];
    let input = null, fallback = null;
    this.cur = null;
    if (R.REAL.includes(type)) {
      const prep = this.prepareLive(type); // { input, meta } от feed.js или null
      input = prep ? prep.input : null;
      if (!input) { // источник молчит: заменяем сценическим событием, расписание не ломается (§2.3)
        fallback = type;
        const prev = s.schedule[s.idx - 1];
        const pool = R.SCENIC.filter((t) => t !== prev);
        type = pool[this.rnd(pool.length)];
      } else {
        this.cur = R.rebuild(type, input);
        this.cur.meta = prep.meta || {};
      }
    }
    if (!this.cur) {
      this.cur = R.makeScenic(type, this.rnd);
      input = this.cur.input;
    }
    s.schedule[s.idx] = type;
    s.ev = { type, input, meta: this.cur.meta || R.describe(type, this.rnd), live: R.REAL.includes(type), fallback, outcome: null, hasOutcome: false, voidAll: false, voids: [], revealAt: 0, n: s.idx + 1 };
    s.phase = "bets";
    s.deadline = now + s.settings.betMs;
    for (const p of Object.values(s.players)) { p.draft = {}; p.submitted = false; p.coupon = null; p.last = null; p.stackBefore = p.stack; }
    return [{ type: "event", idx: s.idx, kind: type, fallback, min: this.alive().map((p) => [p.id, this.minStake(p)]) }];
  }

  alive() { return this.s.order.map((id) => this.s.players[id]).filter((p) => p.alive); }

  getMarket(id) {
    const c = this.cur;
    if (!c) return null;
    if (!c.byId) c.byId = new Map(c.markets.map((m) => [m.id, m]));
    if (c.byId.has(id)) return c.byId.get(id);
    if (c.marketFor && /^target:[0-9.]+$/.test(id)) {
      const m = c.marketFor(Number(id.slice(7)));
      if (m && m.id === id) { c.byId.set(id, m); return m; }
    }
    return null;
  }

  // ---------- купон ----------

  draftTotal(p) { return Object.values(p.draft).reduce((a, b) => a + b, 0); }

  bet(pid, marketId, stake) {
    const s = this.s, p = s.players[pid];
    if (s.phase !== "bets" || !p || !p.alive || p.submitted) return [];
    if (!Number.isInteger(stake) || stake < MIN_STAKE) return [];
    const m = this.getMarket(marketId);
    if (!m) return [];
    if (!(marketId in p.draft) && Object.keys(p.draft).length >= MAX_BETS) return [];
    if (this.draftTotal(p) + stake > p.stack) return [];
    p.draft[marketId] = (p.draft[marketId] || 0) + stake;
    return [{ type: "draft", id: pid }];
  }

  unbet(pid, marketId) {
    const p = this.s.players[pid];
    if (this.s.phase !== "bets" || !p || p.submitted) return [];
    delete p.draft[marketId];
    return [{ type: "draft", id: pid }];
  }

  clearBets(pid) {
    const p = this.s.players[pid];
    if (this.s.phase !== "bets" || !p || p.submitted) return [];
    p.draft = {};
    return [{ type: "draft", id: pid }];
  }

  // Сдать купон: один раз, идемпотентно. Когда сдали все живые онлайн-игроки, окно закрывается досрочно.
  submit(pid, now) {
    const s = this.s, p = s.players[pid];
    if (s.phase !== "bets" || !p || !p.alive || p.submitted) return [];
    p.submitted = true;
    const ev = [{ type: "submitted", id: pid }];
    if (this.alive().filter((x) => x.online).every((x) => x.submitted)) ev.push(...this.lock(now));
    return ev;
  }

  // ---------- запирание ----------

  lock(now) {
    const s = this.s;
    if (s.phase !== "bets") return [];
    const out = [{ type: "lock" }];
    for (const p of this.alive()) {
      const bets = [];
      if (p.submitted) {
        for (const [id, stake] of Object.entries(p.draft)) {
          const m = this.getMarket(id);
          if (m && stake <= p.stack) bets.push({ id, stake, kc: m.kc });
        }
      }
      let staked = bets.reduce((a, b) => a + b.stake, 0);
      if (staked > p.stack) { bets.length = 0; staked = 0; }
      const min = this.minStake(p);
      const penalty = Math.min(p.stack - staked, Math.max(0, min - staked)); // штраф за недобор, не больше остатка
      p.stack -= staked + penalty;
      p.coupon = { bets, staked, penalty, min };
      if (penalty > 0) out.push({ type: "penalty", id: p.id, amount: penalty });
    }
    s.phase = "locked";
    s.deadline = now + LOCK_MS;
    // сценическое событие: исход выбирается сейчас, когда ставки уже нельзя менять (§3.4)
    s.ev.seed = this.rnd(2 ** 31); // сид сцены: доска строит одну и ту же анимацию после переподключения
    if (!s.ev.live) {
      s.ev.outcome = this.cur.draw(this.rnd);
      s.ev.hasOutcome = true;
      s.ev.revealAt = now + LOCK_MS + R.SCENE_MS[s.ev.type](s.ev.outcome);
    } else {
      s.ev.liveDeadline = now + LOCK_MS + R.LIVE_WAIT_MS[s.ev.type];
    }
    return out;
  }

  // Реальный исход пришёл от feed.js. voids — id рынков, которые возвращаются (точная ничья).
  resolveLive(outcome, now, voids = []) {
    const s = this.s;
    if (!s.ev || !s.ev.live || s.ev.hasOutcome || (s.phase !== "locked" && s.phase !== "scene")) return [];
    s.ev.outcome = outcome;
    s.ev.hasOutcome = true;
    s.ev.voids = voids;
    s.ev.revealAt = Math.max(now, s.phase === "locked" ? s.deadline : now) + LIVE_SCENE_MS;
    return [{ type: "resolved" }];
  }

  // ---------- выплаты ----------

  settle(now) {
    const s = this.s;
    const out = [{ type: "settle" }];
    const ev = s.ev;
    for (const p of this.alive()) {
      const c = p.coupon || { bets: [], staked: 0, penalty: 0, min: 0 };
      let won = 0;
      const lines = [];
      for (const b of c.bets) {
        const m = this.getMarket(b.id);
        let back = 0, result = "lose";
        if (ev.voidAll || ev.voids.includes(b.id)) { back = b.stake; result = "void"; }
        else if (m && m.test(ev.outcome)) { back = payout(b.stake, b.kc); result = "win"; }
        won += back;
        lines.push({ id: b.id, stake: b.stake, kc: b.kc, result, back });
        if (result === "win" && (!s.stats.longestWin || b.kc > s.stats.longestWin.kc)) s.stats.longestWin = { id: p.id, kc: b.kc, ev: s.idx, market: b.id };
      }
      p.stack += won;
      const net = won - c.staked - c.penalty;
      p.last = { staked: c.staked, penalty: c.penalty, won, net, lines, stack: p.stack };
      if (net > p.maxWin) p.maxWin = net;
      if (won - c.staked > (s.stats.bestWin ? s.stats.bestWin.amount : 0)) s.stats.bestWin = { id: p.id, amount: won - c.staked, ev: s.idx };
      if (p.stack <= 0) { p.alive = false; p.outAt = s.idx; out.push({ type: "out", id: p.id }); }
    }
    s.phase = "payout";
    s.deadline = now + PAYOUT_MS;
    return out;
  }

  voidAllAndSettle(now) {
    this.s.ev.voidAll = true;
    this.s.ev.hasOutcome = true;
    return this.settle(now);
  }

  finish(now) {
    const s = this.s;
    const players = s.order.map((id) => s.players[id]);
    const alive = players.filter((p) => p.alive);
    let pool = alive;
    if (alive.length === 0) { // все вылетели в одном событии: у кого было больше фишек до него
      const best = Math.max(...players.map((p) => p.stackBefore || 0));
      pool = players.filter((p) => (p.stackBefore || 0) === best);
      pool.sort((a, b) => (b.coupon ? b.coupon.staked : 0) - (a.coupon ? a.coupon.staked : 0));
      pool = pool.filter((p) => (p.coupon ? p.coupon.staked : 0) === (pool[0].coupon ? pool[0].coupon.staked : 0));
    } else if (alive.length > 1) { // лимит событий: у кого больше фишек, затем больший выигрыш за событие
      const top = Math.max(...alive.map((p) => p.stack));
      pool = alive.filter((p) => p.stack === top);
      const mw = Math.max(...pool.map((p) => p.maxWin));
      pool = pool.filter((p) => p.maxWin === mw);
    }
    s.winner = pool[pool.length > 1 ? this.rnd(pool.length) : 0].id;
    s.phase = "done";
    s.deadline = 0;
    return [{ type: "done", winner: s.winner }];
  }

  // Ведущий: «Закончить сейчас» — побеждает тот, у кого больше фишек
  endNow(now) {
    if (this.s.phase === "lobby" || this.s.phase === "done") return [];
    const s = this.s;
    const players = this.alive();
    const top = Math.max(...players.map((p) => p.stack));
    const pool = players.filter((p) => p.stack === top);
    s.winner = pool[this.rnd(pool.length)].id;
    s.phase = "done";
    s.deadline = 0;
    return [{ type: "done", winner: s.winner }];
  }

  // ---------- часы ----------

  tick(now) {
    const s = this.s;
    switch (s.phase) {
      case "bets":
        return now >= s.deadline ? this.lock(now) : [];
      case "locked":
        if (now < s.deadline) return [];
        s.phase = "scene";
        return [{ type: "scene" }, ...this.tick(now)];
      case "scene":
        if (s.ev.hasOutcome) return now >= s.ev.revealAt ? this.settle(now) : [];
        if (s.ev.live && now >= s.ev.liveDeadline) return this.voidAllAndSettle(now); // реальный исход не пришёл: возврат
        return [];
      case "payout": {
        if (now < s.deadline) return [];
        const aliveN = this.alive().length;
        const limit = s.settings.events;
        if (aliveN <= 1 || (limit && s.idx + 1 >= limit) || s.idx + 1 >= s.schedule.length) return this.finish(now);
        return this.nextEvent(now);
      }
      default:
        return [];
    }
  }

  // ближайший момент, когда нужно позвать tick
  nextDeadline() {
    const s = this.s;
    if (s.phase === "scene") return s.ev.hasOutcome ? s.ev.revealAt : s.ev.liveDeadline;
    return s.deadline || 0;
  }

  // ---------- вид для клиентов ----------

  snapshot(now, forPlayer) {
    const s = this.s, ev = s.ev;
    const board = forPlayer === undefined; // общий экран
    const locked = s.phase !== "lobby" && s.phase !== "bets";
    const revealed = s.phase === "payout" || s.phase === "done" || (board && ev && ev.hasOutcome && s.phase === "scene");
    const players = s.order.map((id) => {
      const p = s.players[id];
      const own = id === forPlayer;
      return {
        id, name: p.name, stack: p.stack, alive: p.alive, online: p.online, maxWin: p.maxWin, outAt: p.outAt,
        submitted: s.phase === "bets" ? p.submitted : undefined,
        draft: own && s.phase === "bets" ? p.draft : undefined,
        coupon: (locked && p.coupon) || (own && s.phase === "bets" ? { bets: [], draft: true } : null),
        last: s.phase === "payout" || s.phase === "done" ? p.last : null,
        min: s.phase === "bets" && p.alive ? this.minStake(p) : undefined,
      };
    });
    return {
      liveN: this.liveTypes().length, me: board ? undefined : forPlayer, phase: s.phase, settings: s.settings, now, deadline: s.deadline, idx: s.idx, total: s.settings.events || null,
      players, winner: s.winner, stats: s.stats,
      ev: ev && {
        type: ev.type, live: ev.live, fallback: ev.fallback, n: ev.n, meta: ev.meta, input: ev.input,
        markets: this.cur ? this.cur.markets.map((m) => ({ id: m.id, group: m.group, kc: m.kc, p: board ? m.p : undefined })) : [],
        // исход видит доска, как только он выбран (строит сцену), телефон — в момент развязки
        outcome: ev.hasOutcome && (board || revealed) ? ev.outcome : undefined,
        revealAt: ev.hasOutcome ? ev.revealAt : undefined,
        seed: ev.seed !== undefined && (board || revealed) ? ev.seed : undefined,
        sceneMs: ev.hasOutcome && !ev.live ? R.SCENE_MS[ev.type](ev.outcome) : undefined,
        voidAll: ev.voidAll || undefined,
        // выигравшие рынки видны всем с развязки: доска подсвечивает их на табло
        winners: ev.hasOutcome && !ev.voidAll && (s.phase === "payout" || s.phase === "done") && this.cur
          ? this.cur.markets.filter((m) => ev.voids.indexOf(m.id) < 0 && m.test(ev.outcome)).map((m) => m.id) : undefined,
      },
    };
  }
}

module.exports = { Game, LEVELS, MAX_PLAYERS, MAX_BETS, LOCK_MS, PAYOUT_MS, DEFAULTS };
