"use strict";

/*
 * Живые источники для «Ставок» (docs/bets-protocol.md §7, bets-spec.md §10).
 *
 *   const feed = createFeed({ log, now, rnd, fetch, WebSocket, env });
 *   feed.start(); feed.stop();
 *   feed.prepare(type) → { input, meta } | null
 *   feed.begin(type, { closeAt, onLive(data), onResolve(outcome, voids?), onAbort() }) → { cancel() }
 *   feed.status() → { [type]: { ok, lastAt, note, enabled } }
 *
 * Включение: env.BETS_LIVE = "btc,btceth,…" | "all" | "none" (по умолчанию none). Выключенный тип: prepare → null,
 * begin → немедленный onAbort. Всё внешнее внедряется (fetch, WebSocket, часы, таймеры, rnd(n) → целое [0,n)),
 * поэтому тесты идут на моках. Адаптеры лежат в bets/feed-*.js; здесь только маршрутизация, флаги и статус.
 *
 * Серверу: begin() нужно звать в момент запирания окна, closeAt = серверное время запирания (мс) и ОБЯЗАТЕЛЬНО
 * передавать input/meta события (ev.input / ev.meta из game.js): адаптеры берут пару, список вики, темы и набор
 * категорий оттуда. Состояние «последнего prepare» на процесс остаётся лишь запасным вариантом: при двух комнатах
 * и после рестарта сервера внутри окна ставок оно не совпадает с тем, что видел игрок.
 *   feed.why(type) → "no_pair" | "warming" | "down": почему prepare вернул null (для ev.fallbackWhy).
 */
const { withDefaults } = require("./feed-util");

const REAL = ["btc", "btceth", "news", "emoji", "wikiduel", "wikiedit", "whales", "lightning", "airport", "lang", "wikinext", "drand"];
const MODULES = [
  ["./feed-prices", ["btc", "btceth"]],
  ["./feed-bsky", ["emoji", "lang"]],
  ["./feed-wiki", ["wikiduel", "wikiedit", "wikinext"]],
  ["./feed-whales", ["whales"]],
  ["./feed-drand", ["drand"]],
  ["./feed-news", ["news"]],
  ["./feed-lightning", ["lightning"]],
  ["./feed-airport", ["airport"]],
];

function parseFlags(v) {
  const s = String(v == null ? "none" : v).trim().toLowerCase();
  if (!s || s === "none") return new Set();
  if (s === "all") return new Set(REAL);
  return new Set(s.split(/[,\s]+/).filter((t) => REAL.includes(t)));
}

function createFeed(d = {}) {
  const deps = withDefaults(d);
  const enabled = parseFlags(deps.env.BETS_LIVE);
  const mods = new Map();          // тип → адаптер
  const uniq = new Set();
  for (const [file, types] of MODULES) {
    if (!types.some((t) => enabled.has(t))) continue;
    const mod = (d.modules && d.modules[file]) || require(file).create(deps);
    uniq.add(mod);
    for (const t of types) mods.set(t, mod);
  }
  const active = new Set();
  let started = false;

  function start() {
    if (started) return;
    started = true;
    for (const m of uniq) { try { m.start(); } catch (e) { deps.log(`[feed] start: ${e.message}`); } }
  }
  function stop() {
    started = false;
    for (const h of active) { try { h.cancel(); } catch (e) { /* уже закончилось */ } }
    active.clear();
    for (const m of uniq) { try { m.stop(); } catch (e) { /* ok */ } }
  }

  function prepare(type) {
    if (!enabled.has(type)) return null;
    const m = mods.get(type);
    if (!m) return null;
    try {
      const r = m.prepare(type);
      if (!r || !r.input) return null;
      return { input: r.input, meta: r.meta || {} };
    } catch (e) {
      deps.log(`[feed] prepare ${type}: ${e.message}`);
      return null;
    }
  }

  // Почему prepare вернул null: "down" — источник молчит/выключен, "warming" — мало данных, "no_pair" — нет подходящей пары/набора
  function why(type) {
    if (!enabled.has(type) || !mods.get(type)) return "down";
    try {
      const m = mods.get(type);
      if (typeof m.why === "function") { const w = m.why(type); if (w) return w; }
      return m.status().ok ? "no_pair" : "down";
    } catch (e) { return "down"; }
  }

  function begin(type, opts = {}) {
    const abort = (why) => { deps.setTimeout(() => opts.onAbort && opts.onAbort(why), 0); return { cancel() {} }; };
    if (!enabled.has(type) || !mods.get(type)) return abort("выключено");
    let finished = false, inner = null;
    const wrap = {
      closeAt: opts.closeAt, deadline: opts.deadline, input: opts.input, meta: opts.meta, log: opts.log,
      skin: opts.skin, wikis: opts.wikis, kinds: opts.kinds, split: opts.split,
      onLive: (data) => { if (!finished && opts.onLive) { try { opts.onLive(data); } catch (e) { /* ошибка сервера не ломает источник */ } } },
      onResolve: (o, voids) => { if (finished) return; finished = true; active.delete(handle); if (opts.onResolve) opts.onResolve(o, voids); },
      onAbort: (why) => { if (finished) return; finished = true; active.delete(handle); if (opts.onAbort) opts.onAbort(why); },
    };
    const handle = { cancel() { finished = true; active.delete(handle); if (inner) inner.cancel(); } };
    try { inner = mods.get(type).begin(type, wrap); } catch (e) { deps.log(`[feed] begin ${type}: ${e.message}`); finished = true; return abort(e.message); }
    active.add(handle);
    return handle;
  }

  function status() {
    const out = {};
    for (const t of REAL) {
      if (!enabled.has(t)) { out[t] = { ok: false, lastAt: 0, note: "выключено (BETS_LIVE)", enabled: false }; continue; }
      let s;
      try { s = mods.get(t).status(); } catch (e) { s = { ok: false, lastAt: 0, note: e.message }; }
      out[t] = Object.assign({ enabled: true }, s);
      if (!out[t].ok) out[t].why = "down";
    }
    return out;
  }

  return { start, stop, prepare, begin, status, why, enabled: () => [...enabled], _mods: mods };
}

module.exports = { createFeed, parseFlags, REAL };
