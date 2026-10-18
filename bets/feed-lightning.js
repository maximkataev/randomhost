"use strict";

/*
 * ⚡ Молнии (R8, §10.2): север против юга или запад против востока по очередной порции GOES GLM (20 с).
 * Источник — сервис storm/ проекта (HTTP): GET {BETS_STORM_URL}/storm/api/stream?since=<мс>
 *   → { serverNow, wins:[{start,end,total,pts:[[lat,lon,t],...]}] }; pts прорежены до ~800 (total — настоящее число),
 * поэтому счёт стороны = число точек стороны × total / длину pts.
 *
 * Окно подсчёта — первая готовая порция с start > closeAt. Она готова не раньше, чем через 20 с после старта
 * плюс задержка спутника (lag, измеряется как «когда мы увидели порцию − её end»). Поэтому событие берётся в
 * расписание, только если lag + 40 с укладывается в ожидание LIVE_WAIT_MS.lightning (registry.js) + 2 с слака,
 * иначе prepare даёт null. Сейчас в registry.js LIVE_WAIT_MS.lightning = 40000, значит событие практически
 * всегда выключено; чтобы включить — поднять ожидание до ~100000 (BETS_LIGHTNING_WAIT_MS — это значение для feed).
 */
const { withDefaults, duelOk, round, makeHandle } = require("./feed-util");
const live = require("./events/live");

// φ по записи 18.10 (124 окна GLM по 20 с из storm API за 41 минуту, ≈358 вспышек на окно, 240 пар-окон): счёт стороны
// недодисперсный (дисперсия 0,67 от пуассоновской, ИИ 0,55–0,83), минимум лог-потерь на нижней границе φ = 1 (ИИ 1,0–2,4);
// ничьих было 2,5% против 1,2% у модели при φ = 3. Было 3; берём 1,3 — одна гроза за один вечер, запас на другие условия.
const T_SEC = 20, PHI = 1.3, MIN_WINDOWS = 3, POLL_MS = 8000;

function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; }

function create(d) {
  const deps = withDefaults(d);
  const base = (deps.env.BETS_STORM_URL || "http://storm:3200").replace(/\/$/, "");
  let waitMs = Number(deps.env.BETS_LIGHTNING_WAIT_MS) || 0;
  if (!waitMs) { try { waitMs = require("./registry").LIVE_WAIT_MS.lightning; } catch (e) { waitMs = 40000; } }
  const wins = new Map();       // start → { win, seenAt }
  let lastOk = 0, iv = null, note = "не запущен", lastStart = 0, busy = false;
  const lastPrepared = {};

  async function fetchWins(since) {
    try {
      const res = await deps.fetch(`${base}/storm/api/stream?since=${since}`);
      if (!res.ok) return null;
      const j = await res.json();
      return j && Array.isArray(j.wins) ? j.wins : null;
    } catch (e) { return null; }
  }
  function ingest(list, t) {
    for (const w of list) {
      if (!wins.has(w.start)) wins.set(w.start, { win: w, seenAt: t });
      if (w.start > lastStart) lastStart = w.start;
    }
    if (wins.size > 12) { const ks = [...wins.keys()].sort((a, b) => a - b); for (const k of ks.slice(0, ks.length - 12)) wins.delete(k); }
  }
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const l = await fetchWins(Math.max(0, lastStart));
      if (l) { lastOk = deps.now(); ingest(l, lastOk); note = `окон ${wins.size}`; }
      else note = "storm не отвечает";
    } finally { busy = false; }
  }

  function side(pt, split) { return split.axis === "lat" ? pt[0] > split.at : pt[1] > split.at; }  // A: севернее / восточнее
  function countWin(w, split) {
    const n = w.pts.length;
    if (!n) return { a: 0, b: 0 };
    let a = 0;
    for (const p of w.pts) if (side(p, split)) a++;
    const k = w.total / n;
    return { a: Math.round(a * k), b: Math.round((n - a) * k) };
  }
  const lag = () => median([...wins.values()].map((x) => x.seenAt - x.win.end));

  function prepare() {
    if (!(lastOk > 0 && deps.now() - lastOk < 60000)) return null;
    const list = [...wins.values()].sort((a, b) => a.win.start - b.win.start).slice(-4).map((x) => x.win);
    if (list.length < MIN_WINDOWS) return null;
    const lg = lag();
    if (!(lg >= 0) || lg + 2 * T_SEC * 1000 > waitMs + 2000) return null;     // порция не успеет к дедлайну
    const axis = deps.rnd(2) === 0 ? "lat" : "lon";
    const vals = [];
    for (const w of list) for (const p of w.pts) vals.push(axis === "lat" ? p[0] : p[1]);
    const at = round(median(vals), 1);
    if (!Number.isFinite(at)) return null;
    const split = { axis, at };
    const cA = list.map((w) => countWin(w, split).a), cB = list.map((w) => countWin(w, split).b);
    const lamA = cA.reduce((a, b) => a + b, 0) / list.length / T_SEC, lamB = cB.reduce((a, b) => a + b, 0) / list.length / T_SEC;
    if (!duelOk(lamA, lamB, T_SEC, PHI, { minTotal: 20 })) return null;
    const ev = live.duel({ lamA, lamB, T: T_SEC, phi: PHI });
    const ids = ev.markets.map((m) => m.id);
    if (!ids.includes("A") || !ids.includes("B")) return null;
    lastPrepared.split = split;
    const labels = axis === "lat" ? { A: "Север", B: "Юг" } : { A: "Восток", B: "Запад" };
    return { input: { lamA: round(lamA, 3), lamB: round(lamB, 3), T: T_SEC, phi: PHI }, meta: { labels, split } };
  }

  function begin(type, opts) {
    const split = opts.split || lastPrepared.split;
    const h = makeHandle(deps, opts, { timeoutMs: waitMs });
    if (!split) { deps.setTimeout(() => h.abort("разделитель не подготовлен"), 0); return { cancel: () => h.cancel() }; }
    const closeAt = opts.closeAt;
    let busy2 = false;
    async function tick() {
      if (h.done || busy2) return;
      busy2 = true;
      try {
        const l = await fetchWins(closeAt);
        if (h.done || !l) return;
        ingest(l, deps.now());
        const w = l.filter((x) => x.start > closeAt).sort((a, b) => a.start - b.start)[0];
        if (!w) return;
        const c = countWin(w, split);
        let sent = 0;
        for (const p of w.pts) { if (sent++ >= 40) break; h.live({ kind: "item", side: side(p, split) ? "a" : "b", text: `${p[0]},${p[1]}` }); }
        h.live({ kind: "count", a: c.a, b: c.b });
        h.resolve({ nA: c.a, nB: c.b });
      } finally { busy2 = false; }
    }
    h.later(closeAt - deps.now(), () => { tick(); h.every(2000, tick); });
    return { cancel: () => h.cancel() };
  }

  return {
    types: ["lightning"],
    start() { poll(); iv = deps.setInterval(poll, POLL_MS); },
    stop() { deps.clearInterval(iv); },
    status() { const ok = lastOk > 0 && deps.now() - lastOk < 60000; return { ok, lastAt: lastOk, note: `${note}${lag() >= 0 ? ", lag " + Math.round(lag() / 1000) + " с" : ""}` }; },
    prepare, begin, _poll: poll, _countWin: countWin,
  };
}

module.exports = { create };
