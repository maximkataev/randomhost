#!/usr/bin/env node
"use strict";

/*
 * Запись живых потоков для калибровки «Ставок» (bets-spec.md §12, «Калибровка по записям»).
 * Те же эндпоинты, что у адаптеров: Bluesky Jetstream, Wikimedia recentchange (SSE),
 * blockchain.info (непотверждённые транзакции), Binance (сделки BTCUSDT/ETHUSDT).
 *
 * Запуск (Node ≥ 22: используется встроенный WebSocket, пакет ws не нужен):
 *   node tools/record-feed.js [--min 40] [--out tools/records/feed-<метка>.jsonl.gz]
 * Процесс сам завершается по таймеру (и по SIGINT/SIGTERM), файл дописывается порциями — обрезанный
 * файл читается (gzip-хвост теряется, fit-phi.js это терпит).
 *
 * Формат: по строке JSON на секунду и поток (кроме whale — по строке на транзакцию):
 *   {"k":"bsky","s":<unix-сек>,"n":постов,"c":{ключ эмодзи:счёт},"l":{язык:счёт}}
 *   {"k":"wiki","s":..,"n":правок,"w":{wiki:счёт},"t":{тема:счёт},"b":ботов,"x":{категория wikinext:счёт}}
 *   {"k":"tx","t":<мс>,"h":хеш(10),"btc":сумма}
 *   {"k":"px","s":..,"BTC":цена,"ETH":цена}   — последняя цена секунды
 *   {"k":"ltg","start":мс,"end":мс,"seen":мс,"total":N,"pts":[[lat,lon],…]} — окно молний (--only ltg)
 *   {"k":"meta",...} — начало/конец и счётчики подключений
 * Метка секунды — момент прихода сообщения (как у адаптеров), не время источника.
 * Записи в bets/tools/records/ не коммитятся.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { M } = require("../feed-bsky");
const { TOPICS, nextCat } = require("../feed-wiki");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const MIN = Number(arg("min", 40));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const ONLY = arg("only", "");                 // "ltg" — только молнии (storm API), иначе все остальные потоки
const OUT = arg("out", path.join(__dirname, "records", `feed-${stamp}.jsonl.gz`));
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const gz = zlib.createGzip({ level: 6 });
gz.pipe(fs.createWriteStream(OUT));
const emit = (o) => gz.write(JSON.stringify(o) + "\n");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const stat = { bsky: { conns: 0, msgs: 0 }, wiki: { conns: 0, msgs: 0 }, tx: { conns: 0, msgs: 0 }, px: { conns: 0, msgs: 0 }, ltg: { conns: 0, msgs: 0 } };
let stopped = false;
const closers = [];

// ---- посекундные накопители ----
const acc = { bsky: null, wiki: null, px: null };
const sec = (t) => Math.floor(t / 1000);
const inc = (o, k, v = 1) => { o[k] = (o[k] || 0) + v; };
function flush(kind, s, force) {
  const a = acc[kind];
  if (!a) return;
  if (!force && a.s === s) return;
  acc[kind] = null;
  emit(Object.assign({ k: kind }, a));
}

function bskyPost(rec, t) {
  const s = sec(t);
  flush("bsky", s);
  const a = acc.bsky || (acc.bsky = { s, n: 0, c: {}, l: {} });
  a.n++;
  const text = rec.text || "";
  for (const k of Object.keys(M)) if (M[k].test(text)) inc(a.c, k);
  if (Array.isArray(rec.langs) && rec.langs.length) inc(a.l, String(rec.langs[0]).toLowerCase().split("-")[0]);
}
function wikiChange(c, t) {
  if (!c || (c.type !== "edit" && c.type !== "new")) return;
  const s = sec(t);
  flush("wiki", s);
  const a = acc.wiki || (acc.wiki = { s, n: 0, w: {}, t: {}, b: 0, x: {} });
  a.n++;
  inc(a.w, c.wiki || "?");
  if (c.bot) a.b++;
  const server = c.server_name || "", title = String(c.title || "");
  if (c.namespace === 0 && /\.wikipedia\.org$/.test(server)) for (const [id, re] of TOPICS) if (re.test(title)) inc(a.t, id);
  inc(a.x, nextCat(server));
}
function price(sym, p, t) {
  const s = sec(t);
  flush("px", s);
  const a = acc.px || (acc.px = { s });
  a[sym] = p;
}

// ---- WebSocket с переподключением ----
function ws(name, urls, { onOpen, onMsg, silentMs = 20000 }) {
  let idx = 0, sock = null, last = 0, backoff = 1000, timer = null;
  const wd = setInterval(() => {
    if (stopped || !sock) return;
    if (Date.now() - last > silentMs) { log(name, "тишина, переподключение"); try { sock.close(); } catch (e) { /* уже закрыт */ } }
  }, 3000);
  function connect() {
    if (stopped) return;
    const url = urls[idx % urls.length];
    let s;
    try { s = new WebSocket(url); } catch (e) { log(name, "ctor", e.message); idx++; timer = setTimeout(connect, backoff); return; }
    sock = s;
    last = Date.now();
    s.onopen = () => { stat[name].conns++; log(name, "открыт", url); onOpen && onOpen(s); };
    s.onmessage = (ev) => { last = Date.now(); backoff = 1000; stat[name].msgs++; try { onMsg(typeof ev.data === "string" ? ev.data : String(ev.data), last); } catch (e) { /* битое сообщение */ } };
    const re = (why) => { if (sock !== s) return; sock = null; log(name, "закрыт", why); idx++; backoff = Math.min(15000, backoff * 2); if (!stopped) timer = setTimeout(connect, backoff); };
    s.onerror = () => re("error");
    s.onclose = () => re("close");
  }
  connect();
  closers.push(() => { clearInterval(wd); clearTimeout(timer); const s = sock; sock = null; try { s && s.close(); } catch (e) { /* ok */ } });
}

// ---- SSE ----
async function sse(name, url, headers, onData) {
  let backoff = 1000, ctrl = null;
  closers.push(() => { try { ctrl && ctrl.abort(); } catch (e) { /* ok */ } });
  while (!stopped) {
    ctrl = new AbortController();
    const my = ctrl;
    let lastAt = Date.now();
    const wd = setInterval(() => { if (Date.now() - lastAt > 20000) { log(name, "тишина"); my.abort(); } }, 3000);
    try {
      const res = await fetch(url, { headers: Object.assign({ Accept: "text/event-stream" }, headers), signal: my.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      stat[name].conns++;
      log(name, "открыт");
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        lastAt = Date.now();
        backoff = 1000;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line.startsWith("data:")) { stat[name].msgs++; try { onData(line.slice(5).trim(), lastAt); } catch (e) { /* битое */ } }
        }
      }
    } catch (e) { if (!stopped) log(name, e.message); }
    clearInterval(wd);
    if (!stopped) { await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(15000, backoff * 2); }
  }
}

const seenTx = new Map();
// ---- молнии: окна GOES GLM по 20 с из storm API проекта (как feed-lightning), пишем окно целиком ----
// {"k":"ltg","start":мс,"end":мс,"seen":мс,"total":N,"pts":[[lat,lon],…]} — одна строка на окно
async function lightning() {
  const base = arg("storm", "https://randomhost.online");
  let lastStart = 0;
  const seen = new Set();
  const iv = setInterval(async () => {
    try {
      const res = await fetch(`${base}/storm/api/stream?since=${Math.max(0, lastStart)}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const j = await res.json();
      stat.ltg.msgs++;
      for (const w of j.wins || []) {
        if (seen.has(w.start)) continue;
        seen.add(w.start);
        if (w.start > lastStart) lastStart = w.start;
        emit({ k: "ltg", start: w.start, end: w.end, seen: Date.now(), total: w.total, pts: (w.pts || []).map((p) => [p[0], p[1]]) });
      }
    } catch (e) { /* следующий опрос */ }
  }, 8000);
  closers.push(() => clearInterval(iv));
}

function start() {
  emit({ k: "meta", ev: "start", t: Date.now(), min: MIN, node: process.version, only: ONLY || null });
  log("запись в", OUT, "на", MIN, "мин", ONLY);
  if (ONLY === "ltg") { lightning(); return; }
  ws("bsky", ["wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post", "wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post"], {
    onMsg(text, t) {
      const m = JSON.parse(text), c = m && m.commit;
      if (m.kind !== "commit" || !c || c.operation !== "create" || c.collection !== "app.bsky.feed.post" || !c.record) return;
      bskyPost(c.record, t);
    },
  });
  sse("wiki", "https://stream.wikimedia.org/v2/stream/recentchange", { "User-Agent": "randomhost-bets-calibration/1.0 (https://randomhost.online; maximkakataev@gmail.com)" }, (text, t) => wikiChange(JSON.parse(text), t));
  ws("tx", ["wss://ws.blockchain.info/inv"], {
    onOpen(s) { s.send(JSON.stringify({ op: "unconfirmed_sub" })); },
    onMsg(text, t) {
      const m = JSON.parse(text);
      if (!m || m.op !== "utx" || !m.x || !m.x.hash || !Array.isArray(m.x.out)) return;
      if (seenTx.has(m.x.hash)) return;
      seenTx.set(m.x.hash, t);
      if (seenTx.size > 20000) for (const [k, v] of seenTx) { if (t - v > 600000) seenTx.delete(k); else break; }
      let sats = 0;
      for (const o of m.x.out) sats += Number(o.value) || 0;
      emit({ k: "tx", t, h: m.x.hash.slice(0, 10), btc: sats / 1e8 });
    },
  });
  ws("px", ["wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade"], {
    onMsg(text, t) {
      const d = JSON.parse(text).data;
      if (!d || d.e !== "trade") return;
      const sym = d.s === "BTCUSDT" ? "BTC" : d.s === "ETHUSDT" ? "ETH" : null;
      const p = parseFloat(d.p);
      if (sym && p > 0) price(sym, p, t);
    },
  });
  // секундный сброс накопителей, даже если поток замолчал
  const iv = setInterval(() => { const s = sec(Date.now()); for (const k of Object.keys(acc)) flush(k, s); gz.flush(); }, 1000);
  closers.push(() => clearInterval(iv));
  const prog = setInterval(() => log("сообщений", JSON.stringify(stat)), 60000);
  closers.push(() => clearInterval(prog));
}

function finish() {
  if (stopped) return;
  stopped = true;
  for (const c of closers) c();
  for (const k of Object.keys(acc)) flush(k, 0, true);
  emit({ k: "meta", ev: "end", t: Date.now(), stat });
  gz.end(() => { log("готово", JSON.stringify(stat)); setTimeout(() => process.exit(0), 200); });
}
process.on("SIGINT", finish);
process.on("SIGTERM", finish);
setTimeout(finish, MIN * 60000);
start();
