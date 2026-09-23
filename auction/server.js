"use strict";

/*
 * Сервер аукциона: HTTP (создание комнаты, health) + WebSocket (игра).
 * Состояние комнат в памяти, дамп в JSON раз в 5 с, чтобы деплой не убивал живые партии.
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 3000)
 * Разработка: STATIC=.. node server.js — раздаёт статику сайта из родительской папки, чтобы открывать
 * auction.html / auction-board.html с того же origin, что и WebSocket.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { Game, clampSettings } = require("./game");
const { judge } = require("./judge");
const { MODES } = require("./modes");
const { decide, STRATEGIES } = require("./bots");

const PORT = Number(process.env.PORT || 3000);
const STATIC = process.env.STATIC ? path.resolve(process.env.STATIC) : null;
const DEV = process.env.NODE_ENV === "development";
const DUMP = process.env.DUMP_FILE || path.join(__dirname, "state", "rooms.json");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const ROOM_TTL = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000); // комната без активности 30 минут — удаляется (короче — только для тестов)
const SWEEP = Math.min(25000, Math.max(1000, Math.floor(ROOM_TTL / 4))); // ping/pong и уборка комнат
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);
const MAX_PLAYERS = 100; // по сути без лимита; минимум для старта — 2
// ---- лимиты против исчерпания ресурсов ----
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 20); // сколько живых комнат на один адрес
const MAX_SOCKETS_PER_ROOM = Number(process.env.MAX_SOCKETS_PER_ROOM || 200); // сокетов+poll-сессий на комнату
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS || 3000); // сокетов+poll-сессий на процесс
const MAX_JUDGE_CALLS = Number(process.env.MAX_JUDGE_CALLS || 12); // платных запросов к OpenAI на комнату
const EVICT_GRACE_MS = Number(process.env.EVICT_GRACE_MS || 10000); // свежую пустую комнату не вытесняем — доска ещё подключается (0 — только для тестов)
const MSG_RATE = Number(process.env.MSG_RATE || 40); // сообщений в секунду на один сокет
const MAX_MSG_BYTES = 8192; // максимум на одно входящее сообщение
// Карточки лотов по языкам: data/<kind>.json — русские, data/<lang>/<kind>.json — переводы.
// Категории, для которых перевода ещё нет, отдаются по-русски: игра должна работать и с неполным
// переводом, а не падать на отсутствующем файле.
const LANGS = ["ru", "en", "el"];
const KINDS_BY_LANG = { ru: {} };
for (const f of fs.readdirSync(path.join(__dirname, "data"))) {
  if (f.endsWith(".json")) KINDS_BY_LANG.ru[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(__dirname, "data", f), "utf8"));
}
for (const lang of LANGS.slice(1)) {
  const dir = path.join(__dirname, "data", lang);
  KINDS_BY_LANG[lang] = Object.assign({}, KINDS_BY_LANG.ru);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const kind = f.slice(0, -5);
    const cards = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    // перевод обязан совпадать по длине с русским: иначе номера карт в дампе поедут
    if (KINDS_BY_LANG.ru[kind] && cards.length === KINDS_BY_LANG.ru[kind].length) KINDS_BY_LANG[lang][kind] = cards;
    else console.warn(`[auction] ${lang}/${f}: длина не совпадает с русской колодой, беру русскую`);
  }
}
const KINDS = KINDS_BY_LANG.ru; // список категорий и запасная колода
const cardsFor = (kind, lang) => (KINDS_BY_LANG[lang] || KINDS_BY_LANG.ru)[kind] || KINDS[kind];
if (!OPENAI_API_KEY) console.warn("[auction] OPENAI_API_KEY не задан — судья будет через голосование");

// Номера карт в колоде категории. Game.create тасует через slice, поэтому объекты в room.game.s.deck —
// это те же объекты, что в KINDS[kind]: колоду можно дампить списком номеров вместо самих карточек.
// Без этого в файл уходила вся колода на каждую комнату (305 КБ против 2,5 КБ), дамп 100 комнат
// разгонял RSS до 400 МБ при mem_limit 256m, а restore делал каждой комнате свою глубокую копию колоды.
// Индекс нужен на каждый язык: у перевода свои объекты карточек, и номер карты имеет смысл
// только внутри колоды своего языка.
const CARD_INDEX = {};
for (const lang of LANGS) {
  CARD_INDEX[lang] = {};
  for (const [kind, cards] of Object.entries(KINDS_BY_LANG[lang])) {
    const m = new Map();
    cards.forEach((c, i) => m.set(c, i));
    CARD_INDEX[lang][kind] = m;
  }
}
const langOf = (state) => (state && state.settings && state.settings.lang) || "ru";

// ---------- комнаты ----------

const rooms = new Map(); // code → room
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // без похожих символов

function newCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

// суммарное число живых соединений (WebSocket + long-polling) по всем комнатам
function totalSockets() {
  let n = 0;
  for (const r of rooms.values()) n += r.sockets.size;
  return n;
}

// снести комнату целиком: погасить таймеры, оповестить и разорвать соединения, вычистить poll-сессии
function destroyRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.voteTimer);
  clearInterval(room.botTimer);
  for (const c of room.sockets) { try { send(c.ws, { type: "error", error: "room_expired" }); c.ws.terminate(); } catch {} }
  for (const [sid, c] of pollClients) if (c.room === room) pollClients.delete(sid);
  rooms.delete(room.code);
}

// вытеснить самую старую пустую (без соединений) комнату в лобби/финале — чтобы griefer,
// набивший процесс пустыми комнатами, не блокировал создание новых игр всем остальным
function evictOldestEmpty(ip) {
  let victim = null;
  const cutoff = now() - EVICT_GRACE_MS;
  for (const r of rooms.values()) {
    if (ip && r.ip !== ip) continue; // вытесняем только брошенные комнаты того же адреса
    if (r.sockets.size === 0 && r.touched < cutoff && (r.game.s.phase === "lobby" || r.game.s.phase === "finished")) {
      if (!victim || r.touched < victim.touched) victim = r;
    }
  }
  if (!victim) return false;
  destroyRoom(victim);
  return true;
}

function createRoom({ kind = "artist", settings = {}, speed = 1, ip = "" } = {}) {
  if (!KINDS[kind]) throw new Error("unknown kind");
  if (ip) {
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    // Упёрлись в лимит — сначала пробуем освободить брошенную комнату этого же адреса.
    // Отказ только если все его комнаты живые: так лимит не запирает того, кто просто переигрывает,
    // и ошибка в проксировании адреса не превращается в отказ всему сайту.
    if (mine >= MAX_ROOMS_PER_IP && !evictOldestEmpty(ip)) throw new Error("too many rooms from this address");
  }
  if (rooms.size >= MAX_ROOMS && !evictOldestEmpty()) throw new Error("too many rooms");
  const code = newCode();
  const room = {
    code,
    ip,
    hostToken: crypto.randomBytes(12).toString("base64url"),
    game: Game.create({ kind, cards: cardsFor(kind, clampSettings(settings, kind).lang), settings }),
    tokens: {}, // playerToken → playerId
    sockets: new Set(), // {ws, playerId?, host?}
    timer: null,
    voteTimer: null,
    touched: Date.now(),
    speed: DEV ? Math.max(1, Math.min(20, Number(speed) || 1)) : 1,
    skew: 0,
    bots: [], // {playerId, strategy}
    botTimer: null,
    judging: false,
    judgeCalls: 0,
  };
  rooms.set(code, room);
  return room;
}

// частота входящих сообщений на один сокет: флуд по одному соединению не жжёт CPU всей комнаты
function rateOk(client) {
  const t = now();
  if (!client.rl || t - client.rl.ts >= 1000) client.rl = { ts: t, n: 0 };
  return ++client.rl.n <= MSG_RATE;
}

const now = () => Date.now();
// Часы комнаты. При speed > 1 (только в разработке) таймер просыпается раньше дедлайна,
// поэтому комната держит свой сдвиг и «догоняет» дедлайн — иначе tick ничего не делал бы.
const clock = (room) => now() + (room.skew || 0);

// таймеры игры: после каждого изменения пересчитываем ближайший deadline
function schedule(room) {
  clearTimeout(room.timer);
  const s = room.game.s;
  if (!s.deadline || s.paused || s.phase === "finished" || s.phase === "lobby") return;
  const wait = Math.max(0, (s.deadline - clock(room)) / room.speed);
  room.timer = setTimeout(() => {
    try {
      const deadline = room.game.s.deadline;
      if (deadline) room.skew += Math.max(0, deadline - clock(room));
      afterChange(room, room.game.tick(clock(room)));
    } catch (err) {
      console.error("[auction] шаг таймера упал:", err);
    }
  }, wait);
}

function afterChange(room, events = []) {
  room.touched = now();
  const s = room.game.s;
  broadcast(room, { type: "state", state: snapshotWithVoting(room) });
  for (const e of events) broadcast(room, { type: "event", event: e });
  // судейство запускаем ровно один раз: пока идёт голосование или запрос к судье — не трогаем
  // startJudging асинхронна: без catch любая её ошибка стала бы unhandledRejection и уронила процесс
  if (s.phase === "finished" && !s.results && !s.voting && !room.judging) {
    startJudging(room).catch((err) => { room.judging = false; console.error("[auction] судейство упало:", err.message); });
  }
  schedule(room);
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const c of room.sockets) if (c.ws.readyState === 1) c.ws.send(data);
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------- судья ----------

async function startJudging(room) {
  const g = room.game;
  const s = g.s;
  room.judging = true;
  const players = s.players.filter((p) => !p.left && p.lots.length);
  if (players.length < 2) {
    const r = players.map((p) => ({ playerId: p.id, score: 100, verdict: "" }));
    afterChange(room, g.setJudgeResults(r, "Судить некого — играли не все."));
    room.judging = false;
    return;
  }
  if (s.settings.judge === "chatgpt" && OPENAI_API_KEY && room.judgeCalls < MAX_JUDGE_CALLS) {
    room.judgeCalls++;
    broadcast(room, { type: "event", event: { type: "judging" } });
    const lineups = players.map((p, i) => ({ pid: `p${i + 1}`, playerId: p.id, lots: p.lots }));
    try {
      const verdict = await judge({ kind: s.kind, lineups, slots: s.settings.slots, mode: s.settings.mode, lang: s.settings.lang, apiKey: OPENAI_API_KEY, model: OPENAI_MODEL });
      const byPid = Object.fromEntries(lineups.map((l) => [l.pid, l]));
      const names = Object.fromEntries(lineups.map((l) => [l.pid, g.player(l.playerId).name]));
      // p1/{{p1}} → имена; выдуманный игрок (p9, которого нет) превращается в нейтральное «игрок»
      const fix = (t) =>
        String(t || "")
          .replace(/\{\{\s*p(\d+)\s*\}\}/g, (m, n) => names[`p${n}`] || "игрок")
          .replace(/\bp(\d+)\b/g, (m, n) => names[`p${n}`] || "игрок")
          .slice(0, 400);
      const ranking = verdict.results
        .filter((r) => byPid[r.player])
        .map((r) => ({ playerId: byPid[r.player].playerId, score: r.score, verdict: fix(r.verdict) }))
        .sort((a, b) => b.score - a.score || g.player(a.playerId).spent - g.player(b.playerId).spent);
      if (ranking.length !== lineups.length) throw new Error("в вердикте не все игроки");
      afterChange(room, g.setJudgeResults(ranking, fix(verdict.summary)));
      room.judging = false;
      return;
    } catch (err) {
      console.warn(`[auction] судья не ответил (${err.message}) — голосование`);
      broadcast(room, { type: "event", event: { type: "judge_failed" } });
    }
  }
  // голосование: 30 с, потом подсчёт
  s.results = null;
  s.voting = { deadline: clock(room) + 30000 };
  room.judging = false;
  armVoting(room);
  broadcast(room, { type: "state", state: snapshotWithVoting(room) });
}

// таймер голосования живёт отдельно от room.timer: любой afterChange (например, чужой голос)
// зовёт schedule(), а тот гасит room.timer — раньше из-за этого голосование не закрывалось никогда.
function armVoting(room) {
  clearTimeout(room.voteTimer);
  const v = room.game.s.voting;
  if (!v) return;
  const wait = Math.max(0, (v.deadline - clock(room)) / room.speed);
  room.voteTimer = setTimeout(() => finishVoting(room), wait);
}

function snapshotWithVoting(room) {
  const snap = room.game.snapshot(clock(room));
  snap.voting = room.game.s.voting || null;
  return snap;
}

function finishVoting(room) {
  clearTimeout(room.voteTimer);
  const s = room.game.s;
  if (s.phase !== "finished" || s.results) return;
  s.voting = null;
  afterChange(room, room.game.closeVotes());
}

// ---------- боты (только в разработке) ----------

function addBots(room, n) {
  const names = Object.keys(STRATEGIES);
  for (let i = 0; i < n && room.game.s.players.length < MAX_PLAYERS; i++) {
    const strategy = names[i % names.length];
    const id = "bot_" + crypto.randomBytes(4).toString("hex");
    room.game.addPlayer({ id, name: `🤖 ${strategy}` });
    room.bots.push({ playerId: id, strategy });
  }
  if (!room.botTimer) {
    room.botTimer = setInterval(() => {
      const s = room.game.s;
      if (s.phase === "lobby" || s.phase === "finished") return;
      const snap = room.game.snapshot(clock(room));
      let changed = [];
      for (const b of room.bots) {
        const amount = decide(b.strategy, snap, b.playerId);
        if (amount != null) {
          const r = room.game.bid(b.playerId, amount, clock(room));
          if (r.ok) changed.push(...r.events);
        }
        const me = snap.players.find((p) => p.id === b.playerId);
        if (snap.phase === "pickup" && me?.canTake && Math.random() < 0.8) {
          const r = room.game.take(b.playerId, clock(room));
          if (r.ok) changed.push(...r.events);
        }
      }
      if (changed.length) afterChange(room, changed);
    }, 700 / room.speed);
  }
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(STATIC, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(STATIC) || path.basename(file).startsWith(".")) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "", done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    // тело больше 10 КБ — обрываем и сразу отвечаем пустым (иначе промис висел бы вечно и держал соединение)
    req.on("data", (c) => { body += c; if (body.length > 10000) { finish({}); req.destroy(); } });
    req.on("end", () => { try { finish(JSON.parse(body || "{}")); } catch { finish({}); } });
    req.on("error", () => finish({}));
  });
}

// адрес клиента похож на IP; всё остальное — подделка, её игнорируем
const looksLikeIp = (s) => /^[0-9a-fA-F:.]{3,45}$/.test(s) && /[.:]/.test(s);

function clientIp(req) {
  // Главный источник — X-Real-IP: его ставит ВНЕШНИЙ nginx ($remote_addr) и затирает всё,
  // что прислал клиент, а внутренний nginx пробрасывает как есть. Хвост X-Forwarded-For для
  // этого не годится: при двух прокси там лежит адрес внешнего nginx, один на всех, и лимит
  // комнат на адрес схлопнулся бы на весь сайт.
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (looksLikeIp(real)) return real;
  // Запасной путь для одного прокси: последний элемент цепочки дописал он сам, подделать его нельзя.
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(looksLikeIp);
  return chain.length ? chain[chain.length - 1] : (req.socket.remoteAddress || "");
}

// ---------- запасной транспорт: long-polling (когда прокси не пропускает WebSocket и буферизует потоки) ----------
// GET /auction/api/session?r=CODE → {sid, hello}; GET /auction/api/poll?sid=… → ждёт до 20 с и отдаёт накопленные сообщения;
// POST /auction/api/msg {sid, msg} — действие. Сессия умирает, если её не опрашивали 40 с.

const pollClients = new Map(); // sid → client

function openPoll(room) {
  const sid = crypto.randomBytes(12).toString("base64url");
  const shim = {
    readyState: 1,
    queue: [],
    waiter: null,
    send: (data) => { shim.queue.push(data); if (shim.waiter) { const w = shim.waiter; shim.waiter = null; w(); } },
    ping: () => {},
    terminate: () => closePoll(sid),
  };
  const client = { ws: shim, playerId: null, host: false, alive: true, poll: true, room, sid, lastSeen: now() };
  room.sockets.add(client);
  pollClients.set(sid, client);
  send(shim, { type: "hello", code: room.code, state: snapshotWithVoting(room), kinds: Object.keys(KINDS) });
  return client;
}

function closePoll(sid) {
  const client = pollClients.get(sid);
  if (!client) return;
  const room = client.room;
  client.ws.readyState = 3;
  room.sockets.delete(client);
  pollClients.delete(sid);
  if (client.ws.waiter) { const w = client.ws.waiter; client.ws.waiter = null; w(); }
  if (client.playerId && ![...room.sockets].some((c) => c.playerId === client.playerId)) {
    room.game.setOnline(client.playerId, false);
    afterChange(room, [{ type: "offline", playerId: client.playerId }]);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/auction/api/session") {
    const room = rooms.get((url.searchParams.get("r") || "").toUpperCase());
    if (!room) return json(404, { error: "no such room" });
    if (room.sockets.size >= MAX_SOCKETS_PER_ROOM || totalSockets() >= MAX_TOTAL_SOCKETS) return json(503, { error: "busy" });
    const client = openPoll(room);
    const first = client.ws.queue.splice(0);
    return json(200, { sid: client.sid, messages: first.map((d) => JSON.parse(d)) });
  }
  if (url.pathname === "/auction/api/poll") {
    const client = pollClients.get(String(url.searchParams.get("sid") || ""));
    if (!client) return json(410, { error: "session gone" });
    client.lastSeen = now();
    const flush = () => json(200, { messages: client.ws.queue.splice(0).map((d) => JSON.parse(d)) });
    if (client.ws.queue.length) return flush();
    // ждём новых сообщений до 20 с (короче любых таймаутов прокси)
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); client.ws.waiter = null; flush(); };
    const t = setTimeout(finish, 20000);
    client.ws.waiter = finish;
    req.on("close", () => { done = true; clearTimeout(t); if (client.ws.waiter === finish) client.ws.waiter = null; });
    return;
  }
  if (url.pathname === "/auction/api/msg" && req.method === "POST") {
    const body = await readJson(req);
    const client = pollClients.get(String(body.sid || ""));
    if (!client) return json(410, { error: "session gone" });
    client.lastSeen = now();
    if (!rateOk(client)) return json(429, { error: "slow down" });
    try { handle(client.room, client, body.msg || {}); } catch (err) { send(client.ws, { type: "error", error: err.message }); }
    return json(200, { ok: true });
  }
  if (url.pathname === "/auction/api/health") return json(200, { ok: true, rooms: rooms.size, judge: OPENAI_API_KEY ? "chatgpt" : "vote" });
  if (url.pathname === "/auction/api/kinds") return json(200, Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.length])));
  if (url.pathname === "/auction/api/modes") return json(200, MODES);
  if (url.pathname === "/auction/api/rooms" && req.method === "POST") {
    const body = await readJson(req);
    try {
      const room = createRoom({ kind: body.kind, settings: body.settings, speed: body.speed, ip: clientIp(req) });
      return json(200, { code: room.code, hostToken: room.hostToken });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }
  if (STATIC && req.method === "GET") return serveStatic(req, res);
  res.writeHead(404);
  res.end();
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/auction/ws") return socket.destroy();
  const room = rooms.get((url.searchParams.get("r") || "").toUpperCase());
  if (!room) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  // потолок соединений на комнату и на процесс: без него один клиент открывает тысячи сокетов
  if (room.sockets.size >= MAX_SOCKETS_PER_ROOM || totalSockets() >= MAX_TOTAL_SOCKETS) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(room, ws));
});

function onConnection(room, ws) {
  const client = { ws, playerId: null, host: false, alive: true };
  room.sockets.add(client);
  ws.on("pong", () => (client.alive = true));
  send(ws, { type: "hello", code: room.code, state: snapshotWithVoting(room), kinds: Object.keys(KINDS) });

  ws.on("message", (raw) => {
    if (!rateOk(client)) return; // флуд по одному сокету не тратит CPU всей комнаты
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(room, client, msg); } catch (err) { send(ws, { type: "error", error: err.message }); }
  });

  ws.on("close", () => {
    room.sockets.delete(client);
    if (client.playerId && ![...room.sockets].some((c) => c.playerId === client.playerId)) {
      room.game.setOnline(client.playerId, false);
      afterChange(room, [{ type: "offline", playerId: client.playerId }]);
    }
  });
}

function handle(room, client, msg) {
  const g = room.game;
  const t = clock(room);
  room.touched = now();
  const reply = (obj) => send(client.ws, obj);

  switch (msg.type) {
    case "host": {
      if (msg.token !== room.hostToken) return reply({ type: "error", error: "bad host token" });
      // одна доска на комнату: предыдущая доска становится зрителем
      for (const c of room.sockets) if (c.host && c !== client) c.host = false;
      client.host = true;
      return reply({ type: "host_ok" });
    }
    case "join": {
      let playerId = msg.token && room.tokens[msg.token];
      if (playerId && g.player(playerId)?.left) playerId = null;
      // потерял localStorage, но игра идёт: то же имя, что у offline-игрока, — продолжаем его партию
      if (!playerId && g.s.phase !== "lobby") {
        const name = String(msg.name || "").trim();
        const ghost = g.s.players.find((p) => !p.online && !p.left && p.name === name && ![...room.sockets].some((c) => c.playerId === p.id));
        if (ghost) {
          playerId = ghost.id;
          const token = crypto.randomBytes(12).toString("base64url");
          room.tokens[token] = playerId;
          msg.token = token;
        }
      }
      if (!playerId) {
        if (g.s.phase !== "lobby") return reply({ type: "error", error: "game_started" });
        if (g.activePlayers().length >= MAX_PLAYERS) return reply({ type: "error", error: "room_full" });
        playerId = "u_" + crypto.randomBytes(5).toString("hex");
        const token = crypto.randomBytes(12).toString("base64url");
        room.tokens[token] = playerId;
        g.addPlayer({ id: playerId, name: String(msg.name || "") });
        reply({ type: "joined", playerId, token });
      } else {
        reply({ type: "joined", playerId, token: msg.token });
      }
      // второе устройство той же сессии заменяет первое
      for (const c of room.sockets) if (c !== client && c.playerId === playerId) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      client.playerId = playerId;
      g.setOnline(playerId, true);
      const events = [{ type: "online", playerId }];
      // партия стояла на автопаузе «ждём игроков» — вернулся хотя бы один, продолжаем
      if (g.s.paused && g.s.paused.auto) events.push(...g.resume(t));
      return afterChange(room, events);
    }
    case "bid": {
      if (!client.playerId) return;
      const r = g.bid(client.playerId, msg.amount, t, msg.expectedPrice);
      if (!r.ok) return reply({ type: "rejected", action: "bid", ...r });
      return afterChange(room, r.events);
    }
    case "take": {
      if (!client.playerId) return;
      const r = g.take(client.playerId, t);
      if (!r.ok) return reply({ type: "rejected", action: "take", ...r });
      return afterChange(room, r.events);
    }
    case "vote": {
      if (!client.playerId) return;
      const r = g.vote(client.playerId, msg.for);
      if (!r.ok) return reply({ type: "rejected", action: "vote", ...r });
      afterChange(room, r.events);
      if (Object.keys(g.s.votes).length >= g.activePlayers().filter((p) => p.lots.length).length) finishVoting(room);
      return;
    }
    case "leave": {
      if (!client.playerId) return;
      const events = g.removePlayer(client.playerId);
      client.playerId = null;
      return afterChange(room, events);
    }
    // ---- хост ----
    case "settings": {
      if (!client.host) return;
      if (g.s.phase !== "lobby") return reply({ type: "error", error: "game_started" });
      const wasKind = g.s.kind, wasLang = g.s.settings.lang;
      if (msg.kind && KINDS[msg.kind]) g.s.kind = msg.kind;
      // clampSettings знает категорию и сам сбрасывает задание, доступное только прежней;
      // пересчитываем и когда пришла одна категория без настроек — иначе задание осталось бы чужим
      if (msg.settings) {
        g.s.settings = clampSettings({ ...g.s.settings, ...msg.settings }, g.s.kind);
        for (const p of g.s.players) p.money = g.s.settings.budget;
      } else if (msg.kind) {
        g.s.settings = clampSettings(g.s.settings, g.s.kind);
      }
      // колода зависит и от категории, и от языка: карточки на другом языке — другие объекты
      if (g.s.kind !== wasKind || g.s.settings.lang !== wasLang) {
        g.s.deck = Game.create({ kind: g.s.kind, cards: cardsFor(g.s.kind, g.s.settings.lang) }).s.deck;
      }
      return afterChange(room, []);
    }
    case "start": {
      if (!client.host) return;
      return afterChange(room, g.start(t));
    }
    case "skip_lot": return client.host ? afterChange(room, g.hostSkip(t)) : undefined;
    case "pause": return client.host ? afterChange(room, g.pause(t)) : undefined;
    case "resume": return client.host ? afterChange(room, g.resume(t)) : undefined;
    case "kick": {
      if (!client.host) return;
      const events = g.removePlayer(msg.playerId);
      for (const c of room.sockets) if (c.playerId === msg.playerId) { c.playerId = null; send(c.ws, { type: "kicked" }); }
      return afterChange(room, events);
    }
    case "end": {
      if (!client.host) return;
      return afterChange(room, g.s.phase === "finished" ? [] : g.finish("host_ended"));
    }
    case "next_game": {
      if (!client.host) return;
      const kind = KINDS[msg.kind] ? msg.kind : g.s.kind;
      const fresh = Game.create({ kind, cards: cardsFor(kind, g.s.settings.lang), settings: g.s.settings });
      for (const p of g.activePlayers()) fresh.addPlayer({ id: p.id, name: p.name });
      // онлайн определяем по живым соединениям (боты считаются подключёнными всегда)
      for (const p of fresh.s.players) p.online = room.bots.some((b) => b.playerId === p.id) || [...room.sockets].some((c) => c.playerId === p.id);
      clearTimeout(room.voteTimer);
      room.judging = false;
      room.game = fresh;
      return afterChange(room, [{ type: "new_game" }]);
    }
    case "bots": {
      if (!client.host || !DEV) return;
      addBots(room, Math.min(7, Number(msg.n) || 3));
      return afterChange(room, []);
    }
    default:
      return reply({ type: "error", error: "unknown message" });
  }
}

// ---------- обслуживание: ping, TTL, дамп ----------

setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.sockets) {
      if (c.poll) { if (now() - c.lastSeen > 40000) closePoll(c.sid); continue; }
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
    // Идущая партия живёт, пока к ней кто-то подключён: на паузе и в разборе игровых тиков нет,
    // а room.touched двигают только сообщения — иначе живая игра умирала бы под людьми.
    // Лобби так не продлеваем: комната, в которой полчаса никто ничего не сделал, — брошенная,
    // и открытая доска с кодом на экране этого не меняет. Игроки увидят внятный экран «комната
    // была неактивна», а не молча мёртвый код.
    if (room.sockets.size && room.game.s.phase !== "lobby") room.touched = now();
    if (now() - room.touched > ROOM_TTL) destroyRoom(room);
  }
  // Одна строка в лог на каждый обход: по `docker logs randomhost-auction` видно, сколько комнат,
  // соединений и памяти было в момент поломки. При лимите 256m рост RSS — единственный признак
  // близкого OOM, и без этой строки после убийства контейнера не остаётся никаких следов.
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  if (rooms.size) console.log(`[auction] комнат ${rooms.size}, соединений ${totalSockets()}, RSS ${rssMb} МБ`);
  if (rssMb > 180) console.warn(`[auction] ВНИМАНИЕ: RSS ${rssMb} МБ при лимите контейнера 256 МБ, комнат ${rooms.size}`);
}, SWEEP);

// колода комнаты → список номеров карт; null, если карточки не из текущей колоды категории
// (данные поменялись между сборками) — тогда дампим колоду как есть
function deckIndexes(s) {
  const idx = (CARD_INDEX[langOf(s)] || CARD_INDEX.ru)[s.kind];
  if (!idx || !Array.isArray(s.deck)) return null;
  const out = [];
  for (const c of s.deck) {
    const i = idx.get(c);
    if (i === undefined) return null;
    out.push(i);
  }
  return out;
}

let dumpWasEmpty = false;
function dump() {
  try {
    const data = [...rooms.values()]
      .filter((r) => !r.bots.length)
      .map((r) => {
        const s = r.game.s;
        const deckIdx = deckIndexes(s);
        // judgeCalls тоже сохраняем: без него перезапуск обнулял счётчик платных запросов к судье,
        // и в цикле падений каждая доигранная комната заказывала вердикт заново
        return {
          code: r.code, ip: r.ip, hostToken: r.hostToken, tokens: r.tokens, touched: r.touched, judgeCalls: r.judgeCalls,
          state: deckIdx ? { ...s, deck: null, deckIdx } : s,
        };
      });
    // нечего сохранять и в прошлый раз было нечего — не трогаем диск каждые 5 секунд
    if (!data.length && dumpWasEmpty) return;
    dumpWasEmpty = !data.length;
    fs.mkdirSync(path.dirname(DUMP), { recursive: true });
    fs.writeFileSync(DUMP + ".tmp", JSON.stringify(data));
    fs.renameSync(DUMP + ".tmp", DUMP);
  } catch (err) {
    console.warn("[auction] дамп не удался:", err.message);
  }
}

function restore() {
  try {
    if (!fs.existsSync(DUMP)) return;
    for (const r of JSON.parse(fs.readFileSync(DUMP, "utf8"))) {
      if (now() - r.touched > ROOM_TTL) continue;
      // колода сохранена номерами — поднимаем её теми же объектами, что в KINDS (общая память, не копия).
      // Старый формат (колода целиком) читается как есть: дамп с прошлой версии не теряется.
      if (Array.isArray(r.state.deckIdx)) {
        const cards = cardsFor(r.state.kind, langOf(r.state)) || [];
        const deck = r.state.deckIdx.map((i) => cards[i]);
        if (deck.every(Boolean)) {
          r.state.deck = deck;
        } else {
          // карточки категории изменились между сборками — номера ведут не туда. Партию не бросаем:
          // берём свежую тасовку. Купленные лоты лежат у игроков, текущий лот сохранён отдельно,
          // а будущих ещё никто не видел, поэтому подмена незаметна.
          r.state.deck = Game.create({ kind: r.state.kind, cards }).s.deck;
          r.state.rounds = Math.min(r.state.rounds, r.state.deck.length);
          console.warn(`[auction] комната ${r.code}: колода категории изменилась, лоты перетасованы заново`);
        }
        delete r.state.deckIdx;
      }
      const room = { code: r.code, ip: r.ip || "", hostToken: r.hostToken, game: Game.from(r.state), tokens: r.tokens, sockets: new Set(), timer: null, voteTimer: null, touched: r.touched, speed: 1, skew: 0, bots: [], botTimer: null, judging: false, judgeCalls: Number(r.judgeCalls) || 0 };
      for (const p of room.game.s.players) p.online = false;
      rooms.set(room.code, room);
      schedule(room);
      // партия успела закончиться до перезапуска: досудить или добрать голоса, иначе финал зависнет
      const s = room.game.s;
      if (s.phase === "finished" && !s.results) {
        if (s.voting) armVoting(room);
        else startJudging(room).catch((err) => console.error("[auction] судейство при восстановлении упало:", err.message));
      }
    }
    console.log(`[auction] восстановлено комнат: ${rooms.size}`);
  } catch (err) {
    console.warn("[auction] восстановление не удалось:", err.message);
  }
}

restore();
setInterval(dump, 5000);
process.on("SIGTERM", () => { dump(); process.exit(0); });

server.listen(PORT, () => console.log(`[auction] порт ${PORT}, категорий ${Object.keys(KINDS).length}${STATIC ? ", статика из " + STATIC : ""}${DEV ? ", режим разработки (боты)" : ""}`));
