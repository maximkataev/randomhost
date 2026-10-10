"use strict";

/*
 * Сервер «Как все»: HTTP (создание комнаты, health, long-poll) + WebSocket (игра). docs/crowd-spec.md §10.
 * Скелет перенесён из wave/server.js (а туда — из fibs, quip, bomb, roulette и auction): комнаты, токены, грация офлайна,
 * лимиты, дамп, poll-транспорт работают так же и по тем же причинам (подробности — в комментариях там).
 * Тайны сервера — чужие голоса, ва-банк, мнения и порядок показа до раскрытия: они живут только в состоянии комнаты
 * и в дампе на диске; снимки для клиентов собирает game.snapshot, который их не отдаёт.
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 3900)
 * Разработка: NODE_ENV=development STATIC=.. node server.js — статика сайта с того же origin.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { WebSocketServer } = require("ws");
const { roomCode } = require("../lib/codes");
const { clientIp, createGuessLimiter, rateOk: netRateOk, send } = require("../lib/net");
const { Game, clampSettings, cleanName, nameKey } = require("./game");
const CONTENT = require("./content");
const stats = require("./stats");

const PORT = Number(process.env.PORT || 3900);
const STATIC = process.env.STATIC ? path.resolve(process.env.STATIC) : null;
const DEV = process.env.NODE_ENV === "development";
const DUMP = process.env.DUMP_FILE || path.join(__dirname, "state", "rooms.json");
const ROOM_TTL = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);
const SWEEP = Math.min(25000, Math.max(1000, Math.floor(ROOM_TTL / 4)));
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 20);
const MAX_SOCKETS_PER_ROOM = Number(process.env.MAX_SOCKETS_PER_ROOM || 100);
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS || 3000);
// с одного адреса — не больше этого во всех комнатах: доска в своей комнате (по hostToken) не анонимна и не истекает,
// и один адрес сотней «досок» в двадцати своих комнатах занимал весь MAX_TOTAL_SOCKETS — сервер вставал для всех
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP || 300);
const EVICT_GRACE_MS = Number(process.env.EVICT_GRACE_MS || 10000);
const OFFLINE_GRACE_MS = Number(process.env.OFFLINE_GRACE_MS || 8000);
const PONG_MISSES = Number(process.env.PONG_MISSES || 3);
const SEND_BUFFER_LIMIT = Number(process.env.SEND_BUFFER_LIMIT || 1048576);
const MSG_RATE = Number(process.env.MSG_RATE || 40);
// игровые команды (голос, ва-банк, «Готово», мнение) — отдельный, более строгий лимит: каждая успешная рассылает снимки всем (§10)
const CMD_RATE = Number(process.env.CMD_RATE || 5);
const MAX_ANON_PER_ROOM = Number(process.env.MAX_ANON_PER_ROOM || 30);
// телефон открывает сокет до ввода имени, а вся компания обычно за одним NAT: 10 (как в wave) не хватало на 11–12 игроков
const MAX_ANON_PER_IP = Number(process.env.MAX_ANON_PER_IP || 30);
const ANON_TTL_MS = Number(process.env.ANON_TTL_MS || 30000);
const POLL_GAP_MS = Number(process.env.POLL_GAP_MS || 12000);
const MAX_MSG_BYTES = 8192;
const LOG = "[crowd]";

// случайность — криптографическая: порядок показа голосов задаётся от seed раунда, он не должен предсказываться
const rnd = (n) => crypto.randomInt(n);

// ---------- комнаты ----------

const rooms = new Map(); // code → room

// Код комнаты — слово с двумя цифрами: читается вслух и не перебирается (см. guessBlocked)

const newCode = () => roomCode((c) => rooms.has(c));

// Перебор кодов: адрес, промахнувшийся GUESS_LIMIT раз за окно, до конца окна не получает ни одной комнаты
const { blocked: guessBlocked, missed: guessMissed } = createGuessLimiter(Number(process.env.GUESS_LIMIT || 60));
function roomFor(req, url) {
  const ip = clientIp(req);
  if (guessBlocked(ip)) return null;
  const room = rooms.get((url.searchParams.get("r") || "").toUpperCase());
  if (!room) guessMissed(ip);
  return room || null;
}

function socketsFrom(ip) {
  let n = 0;
  for (const r of rooms.values()) for (const c of r.sockets) if (c.ip === ip) n++;
  return n;
}

function totalSockets() {
  let n = 0;
  for (const r of rooms.values()) n += r.sockets.size;
  return n;
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  for (const t of room.offlineTimers.values()) clearTimeout(t);
  room.offlineTimers.clear();
  for (const c of room.sockets) {
    try {
      if (c.poll || c.ws.readyState !== 1) { send(c.ws, { type: "error", error: "room_expired" }); c.ws.terminate(); continue; }
      const ws = c.ws;
      const kill = setTimeout(() => { try { ws.terminate(); } catch {} }, 1000);
      ws.send(JSON.stringify({ type: "error", error: "room_expired" }), () => { clearTimeout(kill); try { ws.close(4000, "room_expired"); } catch {} setTimeout(() => { try { ws.terminate(); } catch {} }, 1000).unref(); });
    } catch {}
  }
  for (const [sid, c] of pollClients) if (c.room === room) pollClients.delete(sid);
  rooms.delete(room.code);
}

function evictOldestEmpty(ip) {
  let victim = null;
  const cutoff = now() - EVICT_GRACE_MS;
  for (const r of rooms.values()) {
    if (ip && r.ip !== ip) continue;
    if (![...r.sockets].some((c) => !isAnon(c)) && r.touched < cutoff && (r.game.s.phase === "lobby" || r.game.s.phase === "finished")) {
      if (!victim || r.touched < victim.touched) victim = r;
    }
  }
  if (!victim) return false;
  destroyRoom(victim);
  return true;
}

function revokeOtherTokens(room, playerId, keep) {
  for (const [t, id] of Object.entries(room.tokens)) if (id === playerId && t !== keep) delete room.tokens[t];
}

function pruneTokens(room) {
  const ids = new Set(room.game.s.players.map((p) => p.id));
  for (const [t, id] of Object.entries(room.tokens)) if (!ids.has(id)) delete room.tokens[t];
  // и счётчики обрывов ушедших: иначе цикл join/leave в лобби копил их без конца
  for (const id of room.dropCounts.keys()) if (!ids.has(id)) room.dropCounts.delete(id);
}

function newRoom({ code, ip = "", hostToken, game, tokens = {}, touched = Date.now(), speed = 1 }) {
  return {
    code, ip, hostToken, game, tokens,
    sockets: new Set(), // {ws, playerId?, host?}
    offlineTimers: new Map(),
    dropCounts: new Map(),
    timer: null,
    touched,
    speed,
    skew: 0,
    // speed < 1 (агенты-игроки в разработке): часы комнаты идут медленнее настоящих, иначе первое же действие
    // после реального срока закрывало фазу через tick — таймер ждал, а часы в handle шли по-настоящему
    vBase: Date.now(),
    rBase: Date.now(),
  };
}

function createRoom({ settings = {}, speed = 1, ip = "" } = {}) {
  if (ip) {
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    if (mine >= MAX_ROOMS_PER_IP && !evictOldestEmpty(ip)) throw new Error("too many rooms from this address");
  }
  if (rooms.size >= MAX_ROOMS && !evictOldestEmpty()) throw new Error("too many rooms");
  const code = newCode();
  const room = newRoom({
    code,
    ip,
    hostToken: crypto.randomBytes(12).toString("base64url"),
    game: Game.create({ settings, code, rnd, content: CONTENT }),
    speed: DEV ? Math.max(0.05, Math.min(20, Number(speed) || 1)) : 1, // <1 — замедление для агентов-игроков, только в разработке
  });
  rooms.set(room.code, room);
  return room;
}

function cmdOk(client) {
  const t = now();
  if (!client.cl || t - client.cl.ts >= 1000) client.cl = { ts: t, n: 0 };
  return ++client.cl.n <= CMD_RATE;
}

const rateOk = (client) => netRateOk(client, MSG_RATE);

const now = () => Date.now();
// Часы комнаты: при speed > 1 (только разработка) таймер просыпается раньше и комната «догоняет» дедлайн,
// при speed < 1 — идут медленнее настоящих (см. newRoom)
const clock = (room) => (room.speed < 1 ? room.vBase + (now() - room.rBase) * room.speed : now() + (room.skew || 0));

function schedule(room) {
  clearTimeout(room.timer);
  const at = room.game.nextDeadline();
  if (at == null) return;
  const wait = Math.max(0, (at - clock(room)) / room.speed);
  room.timer = setTimeout(() => {
    try {
      if (room.speed > 1) room.skew += Math.max(0, at - clock(room));
      afterChange(room, room.game.tick(clock(room)));
    } catch (err) {
      console.error(`${LOG} шаг таймера упал:`, err);
    }
  }, wait);
}

let statBlips = 0, statBack = 0, statDrops = 0;

function scheduleOffline(room, playerId, grace = OFFLINE_GRACE_MS) {
  if (!playerId) return;
  if ([...room.sockets].some((c) => c.playerId === playerId)) return;
  if (room.offlineTimers.has(playerId)) return;
  const name = room.game.player(playerId)?.name || playerId;
  const nth = (room.dropCounts.get(playerId) || 0) + 1;
  room.dropCounts.set(playerId, nth);
  statBlips++;
  console.log(`${LOG} ${room.code}: ${name} потерял связь (обрыв №${nth} за партию), ждём ${OFFLINE_GRACE_MS} мс`);
  const t = setTimeout(() => {
    room.offlineTimers.delete(playerId);
    if (!rooms.has(room.code)) return;
    if ([...room.sockets].some((c) => c.playerId === playerId)) return;
    statDrops++;
    console.log(`${LOG} ${room.code}: ${name} не вернулся — offline`);
    // исключение в таймере непойманное — уронило бы процесс со всеми комнатами
    try {
      afterChange(room, [{ type: "offline", playerId }, ...room.game.setOnline(playerId, false, clock(room))]);
    } catch (err) {
      console.error(`${LOG} офлайн-таймер упал:`, err);
    }
  }, grace);
  if (t.unref) t.unref();
  room.offlineTimers.set(playerId, t);
}

function cancelOffline(room, playerId) {
  const t = room.offlineTimers.get(playerId);
  if (!t) return;
  clearTimeout(t);
  room.offlineTimers.delete(playerId);
  statBack++;
}

function afterChange(room, events = []) {
  room.touched = now();
  broadcastState(room);
  for (const e of events) {
    // счётчики вопросов для калибровки колоды (§6): на диск, клиентам не уходят
    if (e.type === "qstat") { stats.record(room.code, e); continue; }
    broadcastEvent(room, e);
  }
  schedule(room);
}

/*
 * Снимки: доске — общий вид, телефону — ещё и свой голос, ва-банк и мнение. Собираем по одному разу на вид, а не на каждый сокет.
 */
function stateFor(room, c, cache) {
  const t = clock(room);
  if (c.host || c.wasHost) return cache.board || (cache.board = JSON.stringify({ type: "state", state: room.game.snapshot(t, "board") }));
  const key = c.playerId || "";
  if (!cache[key]) cache[key] = JSON.stringify({ type: "state", state: room.game.snapshot(t, c.playerId || null) });
  return cache[key];
}

function broadcastState(room) {
  const cache = {};
  for (const c of room.sockets) {
    if (c.ws.readyState !== 1) continue;
    if (!c.poll && c.ws.bufferedAmount > SEND_BUFFER_LIMIT) {
      console.log(`${LOG} ${room.code}: сокет не читает, буфер ${Math.round(c.ws.bufferedAmount / 1024)} КБ — рвём`);
      c.ws.terminate();
      continue;
    }
    c.ws.send(stateFor(room, c, cache));
  }
}

function broadcastEvent(room, e) {
  const data = JSON.stringify({ type: "event", event: e });
  for (const c of room.sockets) if (c.ws.readyState === 1) c.ws.send(data);
}

function sendHello(room, c) {
  send(c.ws, { type: "hello", code: room.code, state: room.game.snapshot(clock(room), c.host ? "board" : c.playerId || null) });
}


// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".woff2": "font/woff2" };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(STATIC, urlPath === "/" ? "index.html" : urlPath);
  // с разделителем: иначе «/../randomhost-old/x» проходил проверку префикса как соседний каталог
  if (!file.startsWith(STATIC + path.sep) || path.basename(file).startsWith(".")) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const type = MIME[path.extname(file)] || "application/octet-stream";
    if (/text|javascript|json|svg/.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && data.length > 1024) {
      return zlib.gzip(data, (e, gz) => {
        if (e) { res.writeHead(200, { "Content-Type": type }); return res.end(data); }
        res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
        res.end(gz);
      });
    }
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "", done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => { body += c; if (body.length > 10000) { finish({}); req.destroy(); } });
    // Только объект: тело `null` превращало `body.sid` в TypeError в async-обработчике —
    // unhandledRejection и падение процесса со всеми комнатами от одного запроса.
    req.on("end", () => { try { const v = JSON.parse(body || "{}"); finish(v && typeof v === "object" && !Array.isArray(v) ? v : {}); } catch { finish({}); } });
    req.on("error", () => finish({}));
  });
}




// ---------- запасной транспорт: long-polling ----------

const pollClients = new Map(); // sid → client

function openPoll(room, opts = {}) {
  const sid = crypto.randomBytes(12).toString("base64url");
  const shim = {
    readyState: 1,
    queue: [],
    waiter: null,
    bufferedAmount: 0,
    send: (data) => { shim.queue.push(data); if (shim.waiter) { const w = shim.waiter; shim.waiter = null; w(); } },
    ping: () => {},
    terminate: () => closePoll(sid),
  };
  const client = { ws: shim, playerId: null, host: false, poll: true, room, sid, lastSeen: now(), opened: now(), inflight: false, ip: opts.ip || "" };
  room.sockets.add(client);
  pollClients.set(sid, client);
  sendHello(room, client);
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
  scheduleOffline(room, client.playerId);
}

const isAnon = (c) => !c.playerId && !c.host && !c.wasHost;
function anonCount(room, ip) {
  let n = 0;
  for (const c of room.sockets) if (isAnon(c) && (ip === undefined || c.ip === ip)) n++;
  return n;
}
function roomHasSpace(room, ip) {
  if (room.sockets.size >= MAX_SOCKETS_PER_ROOM || totalSockets() >= MAX_TOTAL_SOCKETS) return false;
  if (ip && socketsFrom(ip) >= MAX_SOCKETS_PER_IP) return false;
  if (anonCount(room) >= MAX_ANON_PER_ROOM) return false;
  return !ip || anonCount(room, ip) < MAX_ANON_PER_IP;
}

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/crowd/api/session") {
    const room = roomFor(req, url);
    if (!room) return json(404, { error: "no such room" });
    const ip = clientIp(req);
    if (!roomHasSpace(room, ip)) return json(503, { error: "busy" });
    const client = openPoll(room, { ip });
    const first = client.ws.queue.splice(0);
    return json(200, { sid: client.sid, messages: first.map((d) => JSON.parse(d)) });
  }
  if (url.pathname === "/crowd/api/poll") {
    const client = pollClients.get(String(url.searchParams.get("sid") || ""));
    if (!client) return json(410, { error: "session gone" });
    if (!rateOk(client)) return json(429, { error: "slow down" });
    client.lastSeen = now();
    // один висящий запрос на сессию: новый закрывает прежний (иначе 300 запросов на один sid держали 300 таймеров)
    if (client.ws.waiter) client.ws.waiter();
    const flush = () => { client.inflight = false; client.lastSeen = now(); json(200, { messages: client.ws.queue.splice(0).map((d) => JSON.parse(d)) }); };
    if (client.ws.queue.length) return flush();
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); client.ws.waiter = null; flush(); };
    const t = setTimeout(finish, 20000);
    client.ws.waiter = finish;
    client.inflight = true;
    res.on("close", () => {
      if (done) return;
      done = true; clearTimeout(t); client.inflight = false; client.lastSeen = now();
      if (client.ws.waiter === finish) client.ws.waiter = null;
    });
    return;
  }
  if (url.pathname === "/crowd/api/msg" && req.method === "POST") {
    const body = await readJson(req);
    const client = pollClients.get(String(body.sid || ""));
    if (!client) return json(410, { error: "session gone" });
    if (!rateOk(client)) return json(429, { error: "slow down" });
    try { handle(client.room, client, body.msg || {}); } catch (err) { send(client.ws, { type: "error", error: err.message }); }
    return json(200, { ok: true });
  }
  if (url.pathname === "/crowd/api/health") return json(200, { ok: true, rooms: rooms.size });
  if (url.pathname === "/crowd/api/rooms" && req.method === "POST") {
    const body = await readJson(req);
    try {
      const room = createRoom({ settings: body.settings, speed: body.speed, ip: clientIp(req) });
      return json(200, { code: room.code, hostToken: room.hostToken });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }
  if (STATIC && req.method === "GET") return serveStatic(req, res);
  res.writeHead(404);
  res.end();
}

// Любая ошибка в обработке запроса — 500 этому запросу, а не падение процесса со всеми комнатами
const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error(`${LOG} запрос ${req.method} ${String(req.url).slice(0, 80)} упал:`, err);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {}
  }
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  let url;
  // кривой адрес («//%5B/../crowd/ws» nginx нормализует и пропускает как есть) — new URL бросает,
  // а исключение в обработчике upgrade непойманное и роняет процесс со всеми комнатами
  try { url = new URL(req.url, "http://x"); } catch { return socket.destroy(); }
  if (url.pathname !== "/crowd/ws") return socket.destroy();
  const room = roomFor(req, url);
  if (!room) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  const ip = clientIp(req);
  if (!roomHasSpace(room, ip)) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(room, ws, { ip }));
});

function onConnection(room, ws, opts = {}) {
  const client = { ws, playerId: null, host: false, misses: 0, ip: opts.ip || "", opened: now() };
  room.sockets.add(client);
  ws.on("pong", () => (client.misses = 0));
  sendHello(room, client);
  ws.on("message", (raw) => {
    if (!rateOk(client)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(room, client, msg); } catch (err) { send(ws, { type: "error", error: err.message }); }
  });
  // Без обработчика ошибка сокета (например, сообщение больше maxPayload) становится непойманной
  // и роняет процесс со всеми комнатами. Рвём только этот сокет — close ниже уберёт его из комнаты.
  ws.on("error", (err) => {
    console.log(`${LOG} ${room.code}: ошибка сокета (${err.message}) — рвём`);
    try { ws.terminate(); } catch {}
  });
  ws.on("close", () => {
    room.sockets.delete(client);
    scheduleOffline(room, client.playerId);
  });
}

function handle(room, client, msg) {
  const g = room.game;
  const t = clock(room);
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") return send(client.ws, { type: "pong", t, c: typeof msg.c === "number" ? msg.c : undefined });
  room.touched = now();
  const reply = (obj) => send(client.ws, obj);
  const me = client.playerId;
  // Срок наступил, а таймер ещё не проснулся: сначала закрываем фазу, потом действие.
  // Иначе ответ или голос, пришедший после звонка, успел бы проскочить.
  const due = g.tick(t);
  if (due.length) afterChange(room, due);
  // ответ на действие игрока: отказ — только ему, успех — всем
  const act = (action, r) => {
    if (!r.ok) return reply({ type: "rejected", action, reason: r.reason });
    // повторное нажатие той же кнопки ничего не меняет: снимки всем не гоним
    if (r.noop) return undefined;
    return afterChange(room, r.events || []);
  };

  switch (msg.type) {
    case "host": {
      if (msg.token !== room.hostToken) return reply({ type: "error", error: "bad host token" });
      // одна доска на комнату: прежняя становится зрителем и узнаёт об этом
      for (const c of room.sockets) if (c.host && c !== client) { c.host = false; c.wasHost = true; send(c.ws, { type: "host_lost" }); }
      client.host = true;
      client.wasHost = true;
      reply({ type: "host_ok" });
      return sendHello(room, client);
    }
    case "join": {
      if (me && g.player(me) && !g.player(me).left) return reply({ type: "joined", playerId: me, token: client.token });
      let playerId = msg.token && room.tokens[msg.token];
      if (playerId && !g.player(playerId)) {
        delete room.tokens[msg.token];
        if (!String(msg.name || "").trim()) return reply({ type: "error", error: "token_gone" });
        playerId = null;
      }
      if (msg.token && !playerId && !String(msg.name || "").trim()) return reply({ type: "error", error: "token_gone" });
      if (playerId && g.player(playerId)?.left) playerId = null;
      // потерял localStorage, но игра идёт: то же имя у никем не занятого игрока — продолжаем его партию
      if (!playerId) {
        const name = cleanName(msg.name);
        // Только того, кто уже признан офлайн, и не посреди партии: иначе любой, зная имя с доски, пока у игрока
        // погас экран, входил за него и видел его голос и ва-банк
        const secret = g.s.phase !== "lobby" && g.s.phase !== "finished";
        const same = g.s.players.find((p) => !p.left && nameKey(p.name) === nameKey(name));
        const ghost = same && !secret && !same.online && ![...room.sockets].some((c) => c.playerId === same.id) ? same : null;
        // посреди раунда тёзку не заводим: он выглядел бы на доске как тот же человек; в лобби — «Саша 2», как раньше
        if (same && !ghost && secret) return reply({ type: "error", error: "name_taken" });
        if (ghost) {
          playerId = ghost.id;
          const token = crypto.randomBytes(12).toString("base64url");
          room.tokens[token] = playerId;
          msg.token = token;
          revokeOtherTokens(room, playerId, token);
        }
      }
      if (!playerId) {
        // новый игрок с одного сокета — не чаще раза в 3 с; отказ (идёт раунд) попытку не тратит
        if (client.newPlayerAt && now() - client.newPlayerAt < 3000) return;
        // имена уникальны: тёзке дописываем номер, иначе подхват по имени перепутал бы игроков
        let name = cleanName(msg.name);
        if (!name) return reply({ type: "error", error: "bad_name" });
        const taken = new Set(g.s.players.filter((p) => !p.left).map((p) => nameKey(p.name)));
        for (let i = 2; taken.has(nameKey(name)); i++) name = `${Array.from(cleanName(msg.name)).slice(0, 13).join("")} ${i}`; // по символам: эмодзи не рвём пополам
        playerId = "u_" + crypto.randomBytes(5).toString("hex");
        const r = g.addPlayer({ id: playerId, name, now: t });
        if (!r.ok) return reply({ type: "error", error: r.reason });
        client.newPlayerAt = now();
        const token = crypto.randomBytes(12).toString("base64url");
        room.tokens[token] = playerId;
        client.token = token;
        reply({ type: "joined", playerId, token });
      } else {
        client.token = msg.token;
        // у игрока один действующий токен: вернулся по своему — выданные за него подхватом по имени больше не работают
        revokeOtherTokens(room, playerId, msg.token);
        reply({ type: "joined", playerId, token: msg.token });
      }
      for (const c of room.sockets) if (c !== client && c.playerId === playerId) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      client.playerId = playerId;
      cancelOffline(room, playerId);
      return afterChange(room, [{ type: "online", playerId }, ...g.setOnline(playerId, true, t)]);
    }
    case "leave": {
      if (!me) return;
      const events = g.removePlayer(me, t);
      client.playerId = null;
      pruneTokens(room);
      return afterChange(room, events);
    }
    // ---- игрок ----
    case "vote": return me && cmdOk(client) ? act("vote", g.vote(me, msg.side, t)) : undefined;
    case "bank": return me && cmdOk(client) ? act("bank", g.bankToggle(me, msg.on, t)) : undefined;
    case "confirm": return me && cmdOk(client) ? act("confirm", g.confirm(me, t)) : undefined;
    case "opinion": return me && cmdOk(client) ? act("opinion", g.opinion(me, msg.side, t)) : undefined;
    // ---- ведущий (только доска) ----
    case "settings": {
      if (!client.host) return;
      if (g.s.phase !== "lobby" && g.s.phase !== "finished") return reply({ type: "error", error: "game_started" });
      g.s.settings = clampSettings({ ...g.s.settings, ...(msg.settings || {}) });
      return afterChange(room, []);
    }
    case "start": {
      if (!client.host) return;
      const r = g.start(t);
      if (!r.ok) return reply({ type: "rejected", action: "start", reason: r.reason });
      return afterChange(room, r.events);
    }
    case "kick": {
      if (!client.host) return;
      const events = g.removePlayer(String(msg.playerId || ""), t);
      pruneTokens(room);
      for (const c of room.sockets) if (c.playerId === msg.playerId) { c.playerId = null; send(c.ws, { type: "kicked" }); }
      return afterChange(room, events);
    }
    case "end": return client.host ? afterChange(room, g.abort(t)) : undefined;
    case "lobby": {
      if (!client.host) return;
      const events = g.toLobby(t);
      for (const p of g.s.players) p.online = [...room.sockets].some((c) => c.playerId === p.id);
      pruneTokens(room);
      return afterChange(room, events);
    }
    default:
      return reply({ type: "error", error: "unknown message" });
  }
}

// ---------- обслуживание: ping, TTL, дамп ----------

setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.sockets) {
      if (c.poll) continue;
      if (c.misses >= PONG_MISSES) { c.ws.terminate(); continue; }
      c.misses = (c.misses || 0) + 1;
      c.ws.ping();
    }
    const ph = room.game.s.phase;
    if (room.sockets.size && ph !== "lobby" && ph !== "finished") room.touched = now();
    if (now() - room.touched > ROOM_TTL) destroyRoom(room);
  }
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  if (rooms.size) {
    const drops = statBlips ? `, обрывов ${statBlips} (вернулись ${statBack}, выпали ${statDrops})` : "";
    console.log(`${LOG} комнат ${rooms.size}, соединений ${totalSockets()}, RSS ${rssMb} МБ${drops}`);
  }
  statBlips = statBack = statDrops = 0;
  if (rssMb > 100) console.warn(`${LOG} ВНИМАНИЕ: RSS ${rssMb} МБ при лимите контейнера 128 МБ, комнат ${rooms.size}`);
}, SWEEP);

setInterval(() => {
  const t = now();
  for (const c of pollClients.values()) {
    const idle = !c.inflight && t - c.lastSeen > POLL_GAP_MS;
    const anon = !c.playerId && !c.host && !c.wasHost && t - c.opened > ANON_TTL_MS;
    if (idle || anon || t - c.lastSeen > 40000) closePoll(c.sid);
  }
  // анонимный WebSocket (не вошёл и не доска) тоже не держит место в комнате дольше ANON_TTL_MS:
  // 30 таких сокетов запирали комнату для доски и вернувшихся игроков
  for (const room of rooms.values()) for (const c of room.sockets) if (!c.poll && isAnon(c) && c.opened && t - c.opened > ANON_TTL_MS) { try { c.ws.terminate(); } catch {} }
}, 2000).unref();

let dumpWasEmpty = false;
function dump() {
  try {
    // голоса, ва-банк и мнения пишем: без них после рестарта не закрыть голосование. Файл — только на сервере (режим 0600).
    const data = [...rooms.values()].map((r) => ({ dumpedAt: now(), code: r.code, ip: r.ip, hostToken: r.hostToken, tokens: r.tokens, touched: r.touched, state: r.game.s }));
    if (!data.length && dumpWasEmpty) return;
    dumpWasEmpty = !data.length;
    fs.mkdirSync(path.dirname(DUMP), { recursive: true });
    fs.writeFileSync(DUMP + ".tmp", JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(DUMP + ".tmp", DUMP);
  } catch (err) {
    console.warn(`${LOG} дамп не удался:`, err.message);
  }
}

/*
 * После перезапуска сроки фазы сдвигаются на время простоя (dumpedAt), на голос, мнение и паузу — не меньше 20 с:
 * иначе рестарт в конце голосования закрывал фазу раньше, чем телефоны успевали переподключиться.
 */
function restore() {
  try {
    if (!fs.existsSync(DUMP)) return;
    for (const r of JSON.parse(fs.readFileSync(DUMP, "utf8"))) {
      if (now() - r.touched > ROOM_TTL) continue;
      const room = newRoom({ code: r.code, ip: r.ip || "", hostToken: r.hostToken, game: Game.from(r.state, rnd, CONTENT), tokens: r.tokens || {}, touched: r.touched });
      // простой сервера не съедает время фазы: сроки сдвигаем, а на голос, мнение и паузу оставляем хотя бы 20 с
      const s = room.game.s;
      if (s.phaseEnd != null && r.dumpedAt) {
        const down = Math.max(0, now() - r.dumpedAt);
        s.phaseEnd += down;
        if (s.phaseStart != null) s.phaseStart += down;
        if (s.phase === "vote" || s.phase === "opinion" || s.phase === "pause") s.phaseEnd = Math.max(s.phaseEnd, now() + 20000);
      }
      // рестарт — это обрыв у всех: даём 20 с вернуться, иначе первое же действие закрыло бы фазу без остальных
      pruneTokens(room);
      for (const p of room.game.s.players) if (!p.left && p.online) scheduleOffline(room, p.id, 20000);
      pruneTokens(room);
      rooms.set(room.code, room);
      schedule(room);
    }
    console.log(`${LOG} восстановлено комнат: ${rooms.size}`);
  } catch (err) {
    console.warn(`${LOG} восстановление не удалось:`, err.message);
  }
}

restore();
setInterval(dump, 5000);
stats.load();
setInterval(() => { try { stats.flush(); } catch {} }, 60000).unref();
function fatal(what, err) {
  try { console.error(`${LOG} ${what}:`, (err && err.stack) || err); } catch {}
  try { dump(); } catch {}
  try { stats.flush(); } catch {}
  process.exit(1);
}
process.on("uncaughtException", (err) => fatal("непойманное исключение", err));
process.on("unhandledRejection", (err) => fatal("непойманный отказ промиса", err));

process.on("SIGTERM", () => {
  dump();
  try { stats.flush(); } catch {}
  try { server.close(); } catch {}
  for (const room of rooms.values()) {
    for (const c of room.sockets) { try { if (!c.poll) c.ws.close(1012, "restart"); } catch {} }
  }
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => console.log(`${LOG} порт ${PORT}${STATIC ? ", статика из " + STATIC : ""}${DEV ? ", режим разработки" : ""}`));

module.exports = { rooms, handle, createRoom };
