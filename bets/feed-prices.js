"use strict";

/*
 * Котировки BTC и ETH для событий btc и btceth (bets-spec.md §4.5, §4.6).
 *
 * Источник: Binance (поток сделок BTCUSDT/ETHUSDT), запасной Coinbase (ticker BTC-USD/ETH-USD).
 * В спецификации названы blockchain.info/mempool.space, но у них нет курса ETH и секундных котировок;
 * Binance и Coinbase отдают оба актива из одного потока (отклонение от §4.5 записано в отчёте).
 *
 * Защита: S0 и S1 берутся из ОДНОГО источника по серверным меткам времени (момент прихода сообщения, а не
 * время биржи). Нет котировки моложе 3 с в момент S0 или S1 — abort, ставки возвращаются.
 *
 * Оценка волатильности: приращения за 5 с (а не за 1 с: отскок bid/ask раздувает секундную дисперсию),
 * EWMA с полураспадом 180 с по последним 10 минутам, делим дисперсию на 5. Длинная оценка (полураспад 1 ч,
 * до 3 ч) нужна для отсечки всплесков: короткая больше длинной втрое — событие снимается.
 */
const { withDefaults, managedWs, makeHandle } = require("./feed-util");

const T_SEC = 20;            // окно рынка, с
const LAG = 5;               // лаг приращений для оценки, с
const SHORT_SEC = 600, SHORT_HALF = 180;
const LONG_SEC = 10800, LONG_HALF = 3600;
const MAX_AGE = 3000;        // максимум возраста котировки в S0/S1, мс
const MIN_VALID = 300;       // из 600 секунд должно быть хотя бы столько с ценой
const RHO_MIN = 0.3;         // §4.6: монеты «расклеились» — события нет
const SPIKE = 3;             // §4.5: s(10 мин) / s(3 ч) > 3 — события нет
const SIGMA_MIN_USD = 0.2;   // вырожденная оценка (рынок стоит) — не предлагаем

// ---- оценка (чистая функция: массивы цен по секундам, NaN — нет цены) ----
function lagReturns(P, lag) {
  const r = new Array(P.length).fill(NaN);
  for (let i = lag; i < P.length; i++) if (P[i] > 0 && P[i - lag] > 0) r[i] = Math.log(P[i] / P[i - lag]);
  return r;
}
function ewmaMoments(ra, rb, half, minValid) {
  const n = ra.length, k = Math.LN2 / half;
  let w = 0, aa = 0, bb = 0, ab = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const a = ra[i], b = rb ? rb[i] : 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const wi = Math.exp(-k * (n - 1 - i));
    w += wi; aa += wi * a * a; ab += wi * a * b; bb += wi * b * b; cnt++;
  }
  if (cnt < minValid || w <= 0) return null;
  return { aa: aa / w / LAG, bb: bb / w / LAG, ab: ab / w / LAG, cnt };
}
// A, B — массивы цен по секундам (B можно опустить). Возвращает секундные σ (доли цены), ρ и σ длинной оценки.
function estimateVol(A, B) {
  const tail = (X, n) => X.slice(-n);
  const rA = lagReturns(A, LAG), rB = B ? lagReturns(B, LAG) : null;
  const m = ewmaMoments(tail(rA, SHORT_SEC), rB ? tail(rB, SHORT_SEC) : null, SHORT_HALF, MIN_VALID);
  if (!m) return null;
  const out = { sA: Math.sqrt(m.aa), cnt: m.cnt };
  if (B) { out.sB = Math.sqrt(m.bb); out.rho = m.ab / Math.sqrt(m.aa * m.bb); }
  if (A.length >= 1800 + LAG) {
    const ml = ewmaMoments(tail(rA, LONG_SEC), rB ? tail(rB, LONG_SEC) : null, LONG_HALF, 900);
    if (ml) { out.sALong = Math.sqrt(ml.aa); if (B) out.sBLong = Math.sqrt(ml.bb); }
  }
  return out;
}

// ---- разбор сообщений источников ----
const SOURCES = [
  {
    name: "binance",
    url: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade",
    parse(text) {
      const m = JSON.parse(text);
      const d = m && m.data;
      if (!d || d.e !== "trade") return null;
      const sym = d.s === "BTCUSDT" ? "BTC" : d.s === "ETHUSDT" ? "ETH" : null;
      const p = parseFloat(d.p);
      return sym && p > 0 ? { sym, price: p } : null;
    },
  },
  {
    name: "coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    sub: { type: "subscribe", product_ids: ["BTC-USD", "ETH-USD"], channels: ["ticker"] },
    parse(text) {
      const d = JSON.parse(text);
      if (!d || d.type !== "ticker") return null;
      const sym = d.product_id === "BTC-USD" ? "BTC" : d.product_id === "ETH-USD" ? "ETH" : null;
      const p = parseFloat(d.price);
      return sym && p > 0 ? { sym, price: p } : null;
    },
  },
];

function create(d) {
  const deps = withDefaults(d);
  const sources = (deps.priceSources || SOURCES);
  const store = {};                       // src → { ticks: {BTC:[[t,p]], ETH:[...]}, secs: {BTC:Map, ETH:Map}, last: {BTC:t, ETH:t} }
  for (const s of sources) store[s.name] = { ticks: { BTC: [], ETH: [] }, secs: { BTC: new Map(), ETH: new Map() }, last: { BTC: 0, ETH: 0 }, firstAt: 0 };
  const listeners = new Set();
  let conn = null, state = { ok: false, lastAt: 0, note: "не запущен" };

  function record(srcName, sym, price, t) {
    const st = store[srcName];
    const arr = st.ticks[sym];
    if (!st.firstAt) st.firstAt = t;
    st.last[sym] = t;
    const prev = arr.length ? arr[arr.length - 1] : null;
    if (!prev || t - prev[0] >= 100) arr.push([t, price]);  // не больше 10 записей в секунду на монету
    // чистим тики старше 2 минут (нужны только окрестности S0 и S1)
    if (arr.length > 1500 || (arr.length && t - arr[0][0] > 120000)) { let i = 0; while (i < arr.length && t - arr[i][0] > 120000) i++; arr.splice(0, i); }
    const sec = Math.floor(t / 1000);
    const m = st.secs[sym];
    m.set(sec, price);
    if (m.size > LONG_SEC + 120 && sec % 60 === 0) for (const k of m.keys()) { if (k < sec - LONG_SEC - 60) m.delete(k); else break; }
    for (const f of listeners) f(sym, price, t, srcName);
  }

  function endpoints() {
    return sources.map((s) => ({
      name: s.name, url: s.url,
      onOpen(ws) { if (s.sub) ws.send(JSON.stringify(s.sub)); },
      onMessage(text, t) {
        const r = s.parse(text);
        if (r) record(s.name, r.sym, r.price, t);
      },
    }));
  }

  // последняя котировка с меткой ≤ t и возрастом ≤ maxAge. src — зафиксированный источник (null — любой живой)
  function latest(sym, t, { maxAge = MAX_AGE, src = null } = {}) {
    const names = src ? [src] : [conn ? conn.endpoint() : sources[0].name];
    for (const name of names) {
      const arr = store[name] && store[name].ticks[sym];
      if (!arr) continue;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i][0] <= t) return t - arr[i][0] <= maxAge ? { price: arr[i][1], t: arr[i][0], src: name } : null;
      }
    }
    return null;
  }

  // цены по секундам с протяжкой вперёд (не дальше 5 с), NaN — нет цены
  function grid(srcName, sym, endSec, n) {
    const m = store[srcName].secs[sym];
    const out = new Array(n);
    let last = NaN, lastSec = -1e9;
    // стартовое значение — последняя цена перед окном
    for (let k = 1; k <= 5; k++) { const v = m.get(endSec - n - k + 1); if (v !== undefined) { last = v; lastSec = endSec - n - k + 1; break; } }
    for (let i = 0; i < n; i++) {
      const sec = endSec - n + 1 + i, v = m.get(sec);
      if (v !== undefined) { last = v; lastSec = sec; out[i] = v; } else out[i] = sec - lastSec <= 5 ? last : NaN;
    }
    return out;
  }

  function estimate(withEth) {
    const src = conn ? conn.endpoint() : sources[0].name;
    const now = deps.now();
    const st = store[src];
    if (!st || !conn || !conn.isLive()) return { why: "источник молчит" };
    const endSec = Math.floor(now / 1000) - 1;
    const A = grid(src, "BTC", endSec, LONG_SEC);
    const B = withEth ? grid(src, "ETH", endSec, LONG_SEC) : null;
    const est = estimateVol(A, B);
    if (!est) return { why: "мало котировок" };
    return { src, est, ref: { BTC: latest("BTC", now, { src }), ETH: withEth ? latest("ETH", now, { src }) : null } };
  }

  const sig4 = (x) => Number(x.toPrecision(5));

  function prepare(type) {
    const r = estimate(type === "btceth");
    if (r.why) return null;
    const { est, ref, src } = r;
    if (!ref.BTC || (type === "btceth" && !ref.ETH)) return null;
    if (est.sALong && est.sA / est.sALong > SPIKE) return null;
    if (type === "btc") {
      const sigma = Math.round(ref.BTC.price * est.sA * Math.sqrt(T_SEC) * 100) / 100;
      if (!(sigma >= SIGMA_MIN_USD)) return null;
      return { input: { sigma }, meta: { labels: { coin: "BTC" }, source: src, ref: ref.BTC.price } };
    }
    if (est.sBLong && est.sB / est.sBLong > SPIKE) return null;
    if (!(est.rho >= RHO_MIN)) return null;
    const sigB = sig4(est.sA * Math.sqrt(T_SEC)), sigE = sig4(est.sB * Math.sqrt(T_SEC));
    if (!(sigB > 0 && sigE > 0)) return null;
    return { input: { sigB, sigE, rho: Math.min(0.99, Math.round(est.rho * 1000) / 1000) }, meta: { labels: { A: "BTC", B: "ETH" }, source: src, ref: { BTC: ref.BTC.price, ETH: ref.ETH.price } } };
  }

  function begin(type, opts) {
    const two = type === "btceth";
    const h = makeHandle(deps, opts, { timeoutMs: T_SEC * 1000 + 8000 });
    const closeAt = opts.closeAt, endAt = closeAt + T_SEC * 1000;
    let src = null, s0 = null;
    const snap = (t) => {
      const b = latest("BTC", t, { src });
      const e = two ? latest("ETH", t, { src }) : { price: 0 };
      return b && e ? { BTC: b, ETH: e } : null;
    };
    function capture() {
      // источник фиксируем по живому на момент закрытия; S0 — оба актива из него
      src = conn ? conn.endpoint() : null;
      s0 = src && snap(closeAt);
      if (!s0) return h.abort("нет котировки за 3 с до закрытия");
      h.live({ kind: "s0", btc: s0.BTC.price, eth: two ? s0.ETH.price : undefined });
      h.every(1000, () => {
        const c = snap(deps.now());
        if (c) h.live({ kind: "price", t: deps.now(), btc: c.BTC.price, eth: two ? c.ETH.price : undefined });
      });
      h.later(endAt + 50 - deps.now(), finish);
    }
    function finish() {
      const s1 = snap(endAt);
      if (!s1) return h.abort("нет котировки за 3 с до конца окна");
      if (s1.BTC.src !== src || (two && s1.ETH.src !== src)) return h.abort("источник сменился");
      if (!two) {
        const dlt = Math.round((s1.BTC.price - s0.BTC.price) * 100) / 100;
        return h.resolve(dlt, dlt === 0 ? ["up:0", "down:0"] : undefined);
      }
      const rB = (s1.BTC.price - s0.BTC.price) / s0.BTC.price, rE = (s1.ETH.price - s0.ETH.price) / s0.ETH.price;
      const voids = [];
      if (rB === rE) voids.push("btcBeats", "ethBeats");
      if (rB === 0 || rE === 0) voids.push("bothUp", "bothDown", "mixed");
      return h.resolve({ rB, rE }, voids);
    }
    h.later(closeAt - deps.now(), capture);
    if (closeAt <= deps.now()) { /* later(0) уже поставил capture */ }
    return { cancel: () => h.cancel() };
  }

  return {
    types: ["btc", "btceth"],
    start() {
      conn = managedWs(deps, endpoints(), {
        name: "prices", silentMs: 5000,
        onState(s) { state = { ok: s.state === "live", lastAt: deps.now(), note: `${s.endpoint}: ${s.state}${s.why ? " (" + s.why + ")" : ""}` }; },
      });
      conn.start();
    },
    stop() { if (conn) conn.stop(); conn = null; },
    status() {
      const ok = !!conn && conn.isLive();
      return { ok, lastAt: conn ? conn.lastMsgAt() : 0, note: ok ? conn.endpoint() : state.note };
    },
    prepare, begin, latest, estimate,
    // для тестов: подать котировку напрямую
    _record: record, _store: store, _setConn(c) { conn = c; },
  };
}

module.exports = { create, estimateVol, lagReturns, T_SEC, SOURCES };
