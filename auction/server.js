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
const { decide, STRATEGIES } = require("./bots");

const PORT = Number(process.env.PORT || 3000);
const STATIC = process.env.STATIC ? path.resolve(process.env.STATIC) : null;
const DEV = process.env.NODE_ENV === "development";
const DUMP = process.env.DUMP_FILE || path.join(__dirname, "state", "rooms.json");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const ROOM_TTL = 2 * 3600 * 1000;
const MAX_ROOMS = 200;
const MAX_PLAYERS = 8;
const KINDS = {};
for (const f of fs.readdirSync(path.join(__dirname, "data"))) {
  if (f.endsWith(".json")) KINDS[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(__dirname, "data", f), "utf8"));
}
if (!OPENAI_API_KEY) console.warn("[auction] OPENAI_API_KEY не задан — судья будет через голосование");

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

function createRoom({ kind = "artist", settings = {}, speed = 1 } = {}) {
  if (rooms.size >= MAX_ROOMS) throw new Error("too many rooms");
  if (!KINDS[kind]) throw new Error("unknown kind");
  const code = newCode();
  const room = {
    code,
    hostToken: crypto.randomBytes(12).toString("base64url"),
    game: Game.create({ kind, cards: KINDS[kind], settings }),
    tokens: {}, // playerToken → playerId
    sockets: new Set(), // {ws, playerId?, host?}
    timer: null,
    touched: Date.now(),
    speed: DEV ? Math.max(1, Math.min(20, Number(speed) || 1)) : 1,
    bots: [], // {playerId, strategy}
    botTimer: null,
    judging: false,
    thumbs: {},
  };
  rooms.set(code, room);
  return room;
}

const now = () => Date.now();

// таймеры игры: после каждого изменения пересчитываем ближайший deadline
function schedule(room) {
  clearTimeout(room.timer);
  const s = room.game.s;
  if (!s.deadline || s.paused || s.phase === "finished" || s.phase === "lobby") return;
  const wait = Math.max(0, (s.deadline - now()) / room.speed);
  room.timer = setTimeout(() => {
    const events = room.game.tick(now());
    afterChange(room, events);
  }, wait);
}

function afterChange(room, events = []) {
  room.touched = now();
  const s = room.game.s;
  broadcast(room, { type: "state", state: snapshotWithVoting(room) });
  for (const e of events) broadcast(room, { type: "event", event: e });
  if (s.phase === "finished" && !s.results && !room.judging) startJudging(room);
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
  if (s.settings.judge === "chatgpt" && OPENAI_API_KEY) {
    broadcast(room, { type: "event", event: { type: "judging" } });
    const lineups = players.map((p, i) => ({ pid: `p${i + 1}`, playerId: p.id, lots: p.lots }));
    try {
      const verdict = await judge({ kind: s.kind, lineups, slots: s.settings.slots, apiKey: OPENAI_API_KEY, model: OPENAI_MODEL });
      const byPid = Object.fromEntries(lineups.map((l) => [l.pid, l]));
      const names = Object.fromEntries(lineups.map((l) => [l.pid, g.player(l.playerId).name]));
      const fix = (t) => t.replace(/\bp(\d+)\b/g, (m, n) => names[`p${n}`] || m);
      const ranking = verdict.results
        .map((r) => ({ playerId: byPid[r.player].playerId, score: r.score, verdict: fix(r.verdict) }))
        .sort((a, b) => b.score - a.score || g.player(a.playerId).spent - g.player(b.playerId).spent);
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
  s.voting = { deadline: now() + 30000 };
  broadcast(room, { type: "state", state: snapshotWithVoting(room) });
  room.judging = false;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => finishVoting(room), 30000 / room.speed);
}

function snapshotWithVoting(room) {
  const snap = room.game.snapshot(now());
  snap.voting = room.game.s.voting || null;
  return snap;
}

function finishVoting(room) {
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
      const snap = room.game.snapshot(now());
      let changed = [];
      for (const b of room.bots) {
        const amount = decide(b.strategy, snap, b.playerId);
        if (amount != null) {
          const r = room.game.bid(b.playerId, amount, now());
          if (r.ok) changed.push(...r.events);
        }
        const me = snap.players.find((p) => p.id === b.playerId);
        if (snap.phase === "pickup" && me?.canTake && Math.random() < 0.8) {
          const r = room.game.take(b.playerId, now());
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
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
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
    try { handle(client.room, client, body.msg || {}); } catch (err) { send(client.ws, { type: "error", error: err.message }); }
    return json(200, { ok: true });
  }
  if (url.pathname === "/auction/api/health") return json(200, { ok: true, rooms: rooms.size, judge: OPENAI_API_KEY ? "chatgpt" : "vote" });
  if (url.pathname === "/auction/api/kinds") return json(200, Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.length])));
  if (url.pathname === "/auction/api/rooms" && req.method === "POST") {
    const body = await readJson(req);
    try {
      const room = createRoom({ kind: body.kind, settings: body.settings, speed: body.speed });
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

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/auction/ws") return socket.destroy();
  const room = rooms.get((url.searchParams.get("r") || "").toUpperCase());
  if (!room) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(room, ws));
});

function onConnection(room, ws) {
  const client = { ws, playerId: null, host: false, alive: true };
  room.sockets.add(client);
  ws.on("pong", () => (client.alive = true));
  send(ws, { type: "hello", code: room.code, state: snapshotWithVoting(room), kinds: Object.keys(KINDS) });

  ws.on("message", (raw) => {
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
  const t = now();
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
      return afterChange(room, [{ type: "online", playerId }]);
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
      if (msg.kind && KINDS[msg.kind]) { g.s.kind = msg.kind; g.s.deck = Game.create({ kind: msg.kind, cards: KINDS[msg.kind] }).s.deck; }
      if (msg.settings) {
        g.s.settings = clampSettings({ ...g.s.settings, ...msg.settings });
        for (const p of g.s.players) p.money = g.s.settings.budget;
      }
      return afterChange(room, []);
    }
    case "start": {
      if (!client.host) return;
      return afterChange(room, g.start(t));
    }
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
      const fresh = Game.create({ kind, cards: KINDS[kind], settings: g.s.settings });
      for (const p of g.activePlayers()) fresh.addPlayer({ id: p.id, name: p.name });
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
    if (now() - room.touched > ROOM_TTL) {
      clearTimeout(room.timer);
      clearInterval(room.botTimer);
      rooms.delete(room.code);
    }
  }
}, 25000);

function dump() {
  try {
    fs.mkdirSync(path.dirname(DUMP), { recursive: true });
    const data = [...rooms.values()]
      .filter((r) => !r.bots.length)
      .map((r) => ({ code: r.code, hostToken: r.hostToken, tokens: r.tokens, touched: r.touched, state: r.game.s }));
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
      const room = { code: r.code, hostToken: r.hostToken, game: Game.from(r.state), tokens: r.tokens, sockets: new Set(), timer: null, touched: r.touched, speed: 1, bots: [], botTimer: null, judging: false, thumbs: {} };
      for (const p of room.game.s.players) p.online = false;
      rooms.set(room.code, room);
      schedule(room);
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
