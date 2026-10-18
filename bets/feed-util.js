"use strict";

/*
 * Общие кирпичи живых источников (bets/feed-*.js): внедрение зависимостей, управляемый WebSocket и SSE
 * с переподключением и «молчанием», оценщик интенсивности (EWMA), разбор RSS, подбор пары для дуэли.
 * Всё внешнее (часы, таймеры, fetch, WebSocket, rnd) приходит через deps — тесты идут на моках без сети.
 */
const crypto = require("crypto");

// Достраиваем зависимости значениями по умолчанию. rnd(n) → целое [0, n), как у game.js.
function withDefaults(d = {}) {
  const deps = Object.assign({}, d);
  deps.env = d.env || process.env;
  deps.log = d.log || (() => {});
  deps.now = d.now || Date.now;
  deps.rnd = d.rnd || ((n) => crypto.randomInt(n));
  deps.setTimeout = d.setTimeout || ((f, ms) => setTimeout(f, ms));
  deps.clearTimeout = d.clearTimeout || ((h) => clearTimeout(h));
  deps.setInterval = d.setInterval || ((f, ms) => setInterval(f, ms));
  deps.clearInterval = d.clearInterval || ((h) => clearInterval(h));
  if (!deps.fetch && typeof fetch === "function") deps.fetch = fetch;
  if (!deps.WebSocket) { try { deps.WebSocket = require("ws"); } catch (e) { deps.WebSocket = null; } }
  return deps;
}

// ---- интенсивность потока: события с метками времени, EWMA с полураспадом по окну ----
// λ = Σ w_e / ∫w, w = 0.5^(возраст/half); знаменатель считается аналитически, окно усечено аптаймом потока.
class RateTracker {
  constructor({ keep = 30 * 60 * 1000 } = {}) { this.keep = keep; this.ts = []; }
  add(t) { this.ts.push(t); }
  prune(now) {
    const cut = now - this.keep;
    let i = 0;
    while (i < this.ts.length && this.ts[i] < cut) i++;
    if (i > 0) this.ts.splice(0, i);
  }
  // события в секунду; since — когда мы начали слушать поток (до этого момента событий не видели)
  rate(now, { windowMs = 300000, halfMs = 90000, since = 0 } = {}) {
    const W = Math.min(windowMs, Math.max(0, now - since)) / 1000;
    if (W <= 0) return 0;
    const h = halfMs / 1000, k = Math.LN2 / h;
    let num = 0;
    for (let i = this.ts.length - 1; i >= 0; i--) {
      const age = (now - this.ts[i]) / 1000;
      if (age > W) break;
      if (age < 0) continue;
      num += Math.exp(-k * age);
    }
    const den = (1 - Math.exp(-k * W)) / k;
    return num / den;
  }
  count(now, windowMs) {
    let n = 0;
    for (let i = this.ts.length - 1; i >= 0 && now - this.ts[i] <= windowMs; i--) n++;
    return n;
  }
}

// ---- управляемый WebSocket: список конечных точек (основная, запасные), переподключение, «молчание» ----
// endpoint: { name, url, onOpen(ws), onMessage(text, t) }
function managedWs(deps, endpoints, { silentMs = 15000, retryPrimaryMs = 300000, onState = () => {}, name = "ws" } = {}) {
  let idx = 0, ws = null, stopped = false, backoff = 1000, fails = 0, lastMsgAt = 0, wd = null, retry = null, connected = false, onFallbackSince = 0;
  const WS = () => deps.WebSocket;
  function state(s, extra) { onState(Object.assign({ state: s, endpoint: endpoints[idx].name }, extra)); }
  function closeWs() { if (ws) { try { ws.removeAllListeners && ws.removeAllListeners(); ws.on && ws.on("error", () => {}); ws.terminate ? ws.terminate() : ws.close(); } catch (e) { /* уже закрыт */ } ws = null; } }
  function schedule(ms) { if (stopped) return; deps.clearTimeout(retry); retry = deps.setTimeout(connect, ms); }
  function fail(why) {
    connected = false;
    closeWs();
    fails++;
    deps.log(`[${name}] ${endpoints[idx].name}: ${why}`);
    if (fails >= 2 && endpoints.length > 1) { idx = (idx + 1) % endpoints.length; fails = 0; if (idx !== 0) onFallbackSince = deps.now(); }
    state("down", { why });
    backoff = Math.min(30000, backoff * 2);
    schedule(backoff);
  }
  function connect() {
    if (stopped) return;
    if (!WS()) { state("down", { why: "no WebSocket" }); return; }
    const ep = endpoints[idx];
    let sock;
    try { sock = new (WS())(ep.url); } catch (e) { return fail("ctor " + e.message); }
    ws = sock;
    lastMsgAt = deps.now();
    sock.on("open", () => { if (ws !== sock) return; try { ep.onOpen && ep.onOpen(sock); } catch (e) { /* подписка не ушла: молчание это поймает */ } state("open"); });
    sock.on("message", (data) => {
      if (ws !== sock) return;
      const t = deps.now();
      lastMsgAt = t;
      if (!connected) { connected = true; fails = 0; backoff = 1000; state("live"); }
      try { ep.onMessage(typeof data === "string" ? data : data.toString("utf8"), t); } catch (e) { deps.log(`[${name}] parse: ${e.message}`); }
    });
    sock.on("error", (e) => { if (ws === sock) fail("error " + (e && e.message)); });
    sock.on("close", () => { if (ws === sock) fail("close"); });
  }
  function watchdog() {
    if (stopped) return;
    const t = deps.now();
    if (ws && t - lastMsgAt > silentMs) fail("silent " + (t - lastMsgAt) + "ms");
    // на запасной точке время от времени проверяем основную
    if (idx !== 0 && onFallbackSince && t - onFallbackSince > retryPrimaryMs) { idx = 0; onFallbackSince = 0; closeWs(); backoff = 1000; schedule(0); }
  }
  return {
    start() { stopped = false; wd = deps.setInterval(watchdog, 2000); connect(); },
    stop() { stopped = true; deps.clearInterval(wd); deps.clearTimeout(retry); closeWs(); },
    endpoint: () => endpoints[idx].name,
    isLive: () => connected && deps.now() - lastMsgAt < silentMs,
    lastMsgAt: () => lastMsgAt,
  };
}

// ---- SSE поверх fetch (Node 22: res.body — ReadableStream). onData(строка data:) ----
function managedSse(deps, { url, headers = {}, onData, silentMs = 20000, name = "sse", onState = () => {} }) {
  let stopped = false, ctrl = null, lastAt = 0, wd = null, backoff = 1000, live = false, retry = null;
  async function run() {
    if (stopped) return;
    ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const my = ctrl;
    try {
      const res = await deps.fetch(url, { headers: Object.assign({ Accept: "text/event-stream" }, headers), signal: my && my.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      lastAt = deps.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped || my !== ctrl) break;
        const t = deps.now();
        lastAt = t;
        if (!live) { live = true; backoff = 1000; onState({ state: "live" }); }
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line.startsWith("data:")) { try { onData(line.slice(5).trim(), t); } catch (e) { deps.log(`[${name}] parse: ${e.message}`); } }
        }
      }
    } catch (e) {
      if (!stopped) deps.log(`[${name}] ${e.message}`);
    }
    live = false;
    onState({ state: "down" });
    if (!stopped && my === ctrl) { backoff = Math.min(30000, backoff * 2); retry = deps.setTimeout(run, backoff); }
  }
  function watchdog() {
    if (stopped || !ctrl) return;
    if (deps.now() - lastAt > silentMs) { deps.log(`[${name}] silent`); try { ctrl.abort(); } catch (e) { /* ok */ } }
  }
  return {
    start() { stopped = false; wd = deps.setInterval(watchdog, 3000); run(); },
    stop() { stopped = true; deps.clearInterval(wd); deps.clearTimeout(retry); try { ctrl && ctrl.abort(); } catch (e) { /* ok */ } },
    isLive: () => live && deps.now() - lastAt < silentMs,
    lastAt: () => lastAt,
  };
}

// ---- RSS: без зависимостей, регулярками (нам нужны только title/guid/pubDate) ----
function unxml(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).trim();
}
function parseRss(xml) {
  const out = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const it = m[0];
    const tag = (n) => { const r = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, "i").exec(it); return r ? unxml(r[1]) : ""; };
    const title = tag("title");
    if (!title) continue;
    const guid = tag("guid") || tag("link") || title;
    const pub = Date.parse(tag("pubDate"));
    out.push({ guid, title, desc: tag("description"), pubMs: Number.isFinite(pub) ? pub : null });
  }
  return out;
}

// ---- подбор пары для дуэли (§10.2): |μ_d| ≤ 0,6σ_d, фаворит не вдвое сильнее, достаточный счёт ----
function duelOk(lamA, lamB, T, phi, { minTotal = 8, maxRatio = 2, mu = 0.6 } = {}) {
  if (!(lamA > 0 && lamB > 0)) return false;
  const total = (lamA + lamB) * T;
  if (total < minTotal) return false;
  if (Math.max(lamA, lamB) / Math.min(lamA, lamB) > maxRatio) return false;
  const muD = (lamA - lamB) * T, sd = Math.sqrt(phi * total);
  return Math.abs(muD) <= mu * sd;
}

const round = (x, d) => { const k = 10 ** d; return Math.round(x * k) / k; };

// выбор случайного элемента через внедрённый rnd(n)
const pickOne = (arr, rnd) => arr[rnd(arr.length)];

// Общая обвязка begin(): таймер-таймаут, отмена, одноразовая сдача результата.
function makeHandle(deps, opts, { timeoutMs }) {
  const timers = [];
  let done = false;
  const h = {
    get done() { return done; },
    later(ms, f) { const id = deps.setTimeout(() => { if (!done) f(); }, Math.max(0, ms)); timers.push(id); return id; },
    every(ms, f) { const id = deps.setInterval(() => { if (!done) f(); }, ms); timers.push({ iv: id }); return id; },
    // периодический вызов, который стартует с closeAt (до закрытия окно ничего не шлёт)
    everyFromClose(ms, f) { h.later(opts.closeAt - deps.now(), () => h.every(ms, f)); },
    cleanup() { for (const t of timers) { if (t && t.iv !== undefined) deps.clearInterval(t.iv); else deps.clearTimeout(t); } timers.length = 0; },
    resolve(outcome, voids) { if (done) return; done = true; h.cleanup(); opts.onResolve && opts.onResolve(outcome, voids && voids.length ? voids : undefined); },
    abort(why) { if (done) return; done = true; h.cleanup(); deps.log(`[feed] abort: ${why}`); opts.onAbort && opts.onAbort(why); },
    live(d) { if (!done) { try { opts.onLive && opts.onLive(d); } catch (e) { /* клиент сервера не должен ломать источник */ } } },
    cancel() { if (done) return; done = true; h.cleanup(); },
  };
  if (timeoutMs) h.later(Math.max(0, opts.closeAt + timeoutMs - deps.now()), () => h.abort("timeout"));
  return h;
}

module.exports = { withDefaults, RateTracker, managedWs, managedSse, parseRss, duelOk, round, pickOne, makeHandle, unxml };
