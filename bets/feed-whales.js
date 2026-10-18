"use strict";

/*
 * Киты в мемпуле (R7, §10.3): «будет ли за 20 с транзакция больше X BTC».
 * Источник: blockchain.info WebSocket (op=utx, непотверждённые транзакции). Сумма транзакции — сумма выходов.
 * Дубликаты по хешу не считаются. Серверная метка — момент прихода сообщения.
 *
 * Запасной источник: у mempool.space нет потока всех транзакций (REST /api/mempool/recent отдаёт только
 * 10 последних — для порога по большим суммам это смещённая выборка), поэтому запасного нет: при молчании
 * blockchain.info prepare даёт null, слот заменяется сценическим событием.
 */
const { withDefaults, RateTracker, managedWs, round, makeHandle } = require("./feed-util");
const live = require("./events/live");

const URLS = ["wss://ws.blockchain.info/inv"];
const T_SEC = 20, PHI = 1.2;   // φ нужно подобрать по записи реального мемпула (tools/); пока умеренная
const HISTORY = 60 * 60 * 1000;
const LEVELS = [10, 50, 100, 500];          // BTC
const SAT = 1e8;

function create(d) {
  const deps = withDefaults(d);
  const rates = {};
  for (const l of LEVELS) rates[l] = new RateTracker({ keep: HISTORY });
  const seen = new Map();
  const listeners = new Set();
  let since = 0, lastAt = 0, conn = null, n = 0;

  function onTx(x, t) {
    if (!x || !x.hash || !Array.isArray(x.out)) return;
    if (seen.has(x.hash)) return;                           // повторы и RBF-замены считаем один раз
    seen.set(x.hash, t);
    if (!since) since = t;
    lastAt = t;
    n++;
    let sats = 0;
    for (const o of x.out) sats += Number(o.value) || 0;
    const btc = sats / SAT;
    for (const l of LEVELS) if (btc >= l) rates[l].add(t);
    if (n % 500 === 0) { for (const r of Object.values(rates)) r.prune(t); for (const [k, v] of seen) { if (t - v > 600000) seen.delete(k); else break; } }
    for (const f of listeners) f({ t, hash: x.hash, btc });
  }

  const endpoints = URLS.map((url) => ({
    name: "blockchain.info", url,
    onOpen(ws) { ws.send(JSON.stringify({ op: "unconfirmed_sub" })); },
    onMessage(text, t) { const m = JSON.parse(text); if (m && m.op === "utx") onTx(m.x, t); },
  }));

  function prepare() {
    if (!conn || !conn.isLive() || !since || deps.now() - since < 600000) return null;
    const now = deps.now();
    const kinds = [];
    for (const l of LEVELS) {
      const lam = rates[l].rate(now, { windowMs: HISTORY, halfMs: 1800000, since });
      if (lam > 0) kinds.push({ id: "w" + l, lam: round(lam, 6) });
    }
    const opts = { T: T_SEC, phi: PHI, ks: [1, 2] };
    const ev = live.thresholds(kinds, opts);
    if (!ev.markets.length) return null;
    const labels = {};
    for (const l of LEVELS) labels["w" + l] = `${l} BTC`;
    return { input: { kinds, opts }, meta: { labels } };
  }

  function begin(type, opts) {
    const h = makeHandle(deps, opts, { timeoutMs: T_SEC * 1000 + 5000 });
    const closeAt = opts.closeAt, endAt = closeAt + T_SEC * 1000;
    const out = { first: null };
    for (const l of LEVELS) out["w" + l] = 0;
    let lastItem = 0;
    const fn = (e) => {
      if (e.t <= closeAt || e.t > endAt) return;
      let big = false;
      for (const l of LEVELS) if (e.btc >= l) { out["w" + l]++; big = true; if (out.first === null) out.first = "w" + l; }
      if (big || (e.btc >= 1 && e.t - lastItem >= 250)) { lastItem = e.t; h.live({ kind: "item", id: e.hash.slice(0, 10), text: e.hash.slice(0, 10), amount: round(e.btc, 4) }); }
    };
    listeners.add(fn);
    h.later(closeAt + 5000 - deps.now(), () => { if (lastAt <= closeAt) { listeners.delete(fn); h.abort("мемпул молчит"); } });
    h.later(endAt + 20 - deps.now(), () => { listeners.delete(fn); h.resolve(Object.assign({}, out)); });
    return { cancel: () => { listeners.delete(fn); h.cancel(); } };
  }

  return {
    types: ["whales"],
    start() { conn = managedWs(deps, endpoints, { name: "whales", silentMs: 20000 }); conn.start(); },
    stop() { if (conn) conn.stop(); conn = null; },
    status() { const ok = !!conn && conn.isLive(); return { ok, lastAt, note: ok ? `транзакций ${n}` : "blockchain.info молчит" }; },
    prepare, begin, _onTx: onTx, _setConn(c) { conn = c; }, _since(t) { since = t; }, LEVELS,
  };
}

module.exports = { create, LEVELS };
