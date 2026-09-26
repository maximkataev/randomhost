"use strict";

/*
 * Сервер рулетки: HTTP (создание комнаты, health, long-poll) + WebSocket (игра). roulette-spec.md §9.
 * Скелет перенесён из auction/server.js — комнаты, токены, грация офлайна, лимиты, дамп, poll-транспорт
 * работают так же и по тем же причинам (подробности и история — в комментариях там).
 * Отличие по сути одно: снимок состояния не общий. Доска знает выпавшее число с момента броска,
 * телефоны — только в revealAt, когда шарик остановился, поэтому каждый получает свой снимок.
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 3100)
 * Разработка: NODE_ENV=development STATIC=.. node server.js — статика сайта с того же origin и боты.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { WebSocketServer } = require("ws");
const { Game, clampSettings, cleanName, MAX_PLAYERS } = require("./game");
const { decide, playCard, STRATEGIES } = require("./bots");

const PORT = Number(process.env.PORT || 3100);
const STATIC = process.env.STATIC ? path.resolve(process.env.STATIC) : null;
const DEV = process.env.NODE_ENV === "development";
const DUMP = process.env.DUMP_FILE || path.join(__dirname, "state", "rooms.json");
const ROOM_TTL = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);
const SWEEP = Math.min(25000, Math.max(1000, Math.floor(ROOM_TTL / 4)));
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 20);
const MAX_SOCKETS_PER_ROOM = Number(process.env.MAX_SOCKETS_PER_ROOM || 100);
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS || 3000);
const EVICT_GRACE_MS = Number(process.env.EVICT_GRACE_MS || 10000);
const OFFLINE_GRACE_MS = Number(process.env.OFFLINE_GRACE_MS || 8000);
const PONG_MISSES = Number(process.env.PONG_MISSES || 3);
const SEND_BUFFER_LIMIT = Number(process.env.SEND_BUFFER_LIMIT || 1048576);
const MSG_RATE = Number(process.env.MSG_RATE || 40);
const MAX_ANON_PER_ROOM = Number(process.env.MAX_ANON_PER_ROOM || 30);
const MAX_ANON_PER_IP = Number(process.env.MAX_ANON_PER_IP || 10);
const ANON_TTL_MS = Number(process.env.ANON_TTL_MS || 30000);
const POLL_GAP_MS = Number(process.env.POLL_GAP_MS || 12000);
const MAX_MSG_BYTES = 8192;
const LOG = "[roulette]";

// случайность партии — криптографическая: число на колесе не должно угадываться по прошлым
const rnd = (n) => crypto.randomInt(n);

// ---------- комнаты ----------

const rooms = new Map(); // code → room

// Код комнаты — слово с двумя цифрами: читается вслух и не перебирается (см. guessBlocked)
const ROOM_WORDS = (
  "ACE BANK BET BLACK CASINO CHIP CLUB CROWN DEALER DIAMOND DICE DOUBLE EIGHT EMERALD FORTUNE GOLD " +
  "GRAND JACK JOKER KING LUCKY MAGIC MARBLE MONACO NOIR ONYX OPAL PEARL QUEEN RED ROUGE ROYAL RUBY " +
  "SPADE SPIN STAR TIGER TOPAZ VEGAS VELVET WHEEL ZERO AMBER BRASS COPPER SILVER WALNUT COBALT " +
  "COMET ORBIT PLANET NOVA LUNA SOLAR STORM OCEAN RIVER CORAL CANYON FOREST MEADOW VALLEY ISLAND " +
  "HARBOR CASTLE TOWER BRIDGE PALACE ROCKET TURBO NEON LASER PIXEL ROBOT MAGNET RADAR DISCO TANGO " +
  "SALSA RUMBA BANJO CELLO PIANO GUITAR VIOLIN JAZZ BLUES OPERA SILK DENIM PANDA OTTER LLAMA ZEBRA " +
  "FALCON RAVEN EAGLE BISON BADGER GECKO COBRA SHARK WHALE PUFFIN TOUCAN PARROT MANGO LEMON PEACH"
).trim().split(/\s+/);
const CODE_DIGITS = "23456789";

function newCode() {
  for (;;) {
    const code = ROOM_WORDS[crypto.randomInt(ROOM_WORDS.length)] +
      CODE_DIGITS[crypto.randomInt(CODE_DIGITS.length)] + CODE_DIGITS[crypto.randomInt(CODE_DIGITS.length)];
    if (!rooms.has(code)) return code;
  }
}

// Перебор кодов: адрес, промахнувшийся GUESS_LIMIT раз за окно, до конца окна не получает ни одной комнаты
const GUESS_LIMIT = Number(process.env.GUESS_LIMIT || 60);
const GUESS_WINDOW_MS = 10 * 60 * 1000;
const guesses = new Map();
function guessBlocked(ip) {
  const g = guesses.get(ip);
  if (g && Date.now() - g.since > GUESS_WINDOW_MS) { guesses.delete(ip); return false; }
  return !!g && g.n >= GUESS_LIMIT;
}
function guessMissed(ip) {
  const g = guesses.get(ip);
  if (!g || Date.now() - g.since > GUESS_WINDOW_MS) guesses.set(ip, { n: 1, since: Date.now() });
  else g.n += 1;
  if (guesses.size > 10000) for (const [k, v] of guesses) if (Date.now() - v.since > GUESS_WINDOW_MS) guesses.delete(k);
}
function roomFor(req, url) {
  const ip = clientIp(req);
  if (guessBlocked(ip)) return null;
  const room = rooms.get((url.searchParams.get("r") || "").toUpperCase());
  if (!room) guessMissed(ip);
  return room || null;
}

function totalSockets() {
  let n = 0;
  for (const r of rooms.values()) n += r.sockets.size;
  return n;
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  clearInterval(room.botTimer);
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
    if (r.sockets.size === 0 && r.touched < cutoff && (r.game.s.phase === "lobby" || r.game.s.phase === "finished")) {
      if (!victim || r.touched < victim.touched) victim = r;
    }
  }
  if (!victim) return false;
  destroyRoom(victim);
  return true;
}

function pruneTokens(room) {
  const ids = new Set(room.game.s.players.map((p) => p.id));
  for (const [t, id] of Object.entries(room.tokens)) if (!ids.has(id)) delete room.tokens[t];
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
    bots: [], // {playerId, strategy, mem}
    botTimer: null,
  };
}

function createRoom({ settings = {}, speed = 1, ip = "" } = {}) {
  if (ip) {
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    if (mine >= MAX_ROOMS_PER_IP && !evictOldestEmpty(ip)) throw new Error("too many rooms from this address");
  }
  if (rooms.size >= MAX_ROOMS && !evictOldestEmpty()) throw new Error("too many rooms");
  const room = newRoom({
    code: newCode(),
    ip,
    hostToken: crypto.randomBytes(12).toString("base64url"),
    game: Game.create({ settings, rnd }),
    speed: DEV ? Math.max(1, Math.min(20, Number(speed) || 1)) : 1,
  });
  rooms.set(room.code, room);
  return room;
}

function rateOk(client) {
  const t = now();
  if (!client.rl || t - client.rl.ts >= 1000) client.rl = { ts: t, n: 0 };
  return ++client.rl.n <= MSG_RATE;
}

const now = () => Date.now();
// Часы комнаты: при speed > 1 (только разработка) таймер просыпается раньше и комната «догоняет» дедлайн
const clock = (room) => now() + (room.skew || 0);

function schedule(room) {
  clearTimeout(room.timer);
  const s = room.game.s;
  if (s.phase === "finished" || s.phase === "lobby" || s.paused || !s.deadline) return;
  const wait = Math.max(0, (s.deadline - clock(room)) / room.speed);
  room.timer = setTimeout(() => {
    try {
      const at = room.game.s.deadline;
      if (at) room.skew += Math.max(0, at - clock(room));
      afterChange(room, room.game.tick(clock(room)));
    } catch (err) {
      console.error(`${LOG} шаг таймера упал:`, err);
    }
  }, wait);
}

let statBlips = 0, statBack = 0, statDrops = 0;

function scheduleOffline(room, playerId) {
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
    afterChange(room, [{ type: "offline", playerId }, ...room.game.setOnline(playerId, false, clock(room))]);
  }, OFFLINE_GRACE_MS);
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
  for (const e of events) broadcastEvent(room, e);
  schedule(room);
}

/*
 * Снимки: доске — полный (число с момента броска), телефонам — общий без числа до revealAt,
 * плюс своя рука карт. Собираем по одному разу на вид, а не на каждый сокет.
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

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------- боты (только разработка) ----------

function addBots(room, n) {
  const g = room.game;
  for (let i = 0; i < n && g.s.players.filter((p) => !p.left).length < MAX_PLAYERS; i++) {
    const strategy = STRATEGIES[(room.bots.length + i) % STRATEGIES.length];
    const id = "bot_" + crypto.randomBytes(4).toString("hex");
    const r = g.addPlayer({ id, name: `🤖 ${strategy} ${room.bots.length + 1}` });
    if (r.ok) room.bots.push({ playerId: id, strategy, mem: {} });
  }
  if (!room.botTimer) {
    room.botTimer = setInterval(() => {
      const s = room.game.s;
      // знакомство с картами: боты «прочитали» и готовы
      if (s.phase === "briefing") {
        const lazy = room.bots.filter((b) => { const p = g.player(b.playerId); return p && !p.ready && !p.out && !p.left; });
        if (!lazy.length) return;
        const ev = [];
        for (const b of lazy) { const r = g.setReady(b.playerId, true, clock(room)); if (r.ok) ev.push(...r.events); }
        afterChange(room, ev);
        return;
      }
      if (s.phase !== "betting") { room.botSpin = null; return; }
      if (room.botSpin === s.spin) return; // ставят один раз за спин, через пару секунд после начала
      room.botSpin = s.spin;
      const ev = [];
      for (const b of room.bots) {
        const p = g.player(b.playerId);
        if (!p || p.out || p.left) continue;
        if (!p.frozen) g.setBets(p.id, decide(b.strategy, { game: g, player: p, mem: b.mem, rnd }));
        const c = playCard(b.strategy, { game: g, player: p, rnd });
        if (c) { const r = g.playCard(p.id, c.card, c.target); if (r.ok) ev.push(...r.events); }
        const r = g.setReady(p.id, true, clock(room));
        if (r.ok) ev.push(...r.events);
      }
      afterChange(room, ev);
    }, 2000 / room.speed);
  }
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".woff2": "font/woff2" };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(STATIC, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(STATIC) || path.basename(file).startsWith(".")) { res.writeHead(404); return res.end(); }
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
    req.on("end", () => { try { finish(JSON.parse(body || "{}")); } catch { finish({}); } });
    req.on("error", () => finish({}));
  });
}

const looksLikeIp = (s) => /^[0-9a-fA-F:.]{3,45}$/.test(s) && /[.:]/.test(s);

function clientIp(req) {
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (looksLikeIp(real)) return real;
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(looksLikeIp);
  return chain.length ? chain[chain.length - 1] : (req.socket.remoteAddress || "");
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
  if (anonCount(room) >= MAX_ANON_PER_ROOM) return false;
  return !ip || anonCount(room, ip) < MAX_ANON_PER_IP;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/roulette/api/session") {
    const room = roomFor(req, url);
    if (!room) return json(404, { error: "no such room" });
    const ip = clientIp(req);
    if (!roomHasSpace(room, ip)) return json(503, { error: "busy" });
    const client = openPoll(room, { ip });
    const first = client.ws.queue.splice(0);
    return json(200, { sid: client.sid, messages: first.map((d) => JSON.parse(d)) });
  }
  if (url.pathname === "/roulette/api/poll") {
    const client = pollClients.get(String(url.searchParams.get("sid") || ""));
    if (!client) return json(410, { error: "session gone" });
    client.lastSeen = now();
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
  if (url.pathname === "/roulette/api/msg" && req.method === "POST") {
    const body = await readJson(req);
    const client = pollClients.get(String(body.sid || ""));
    if (!client) return json(410, { error: "session gone" });
    if (!rateOk(client)) return json(429, { error: "slow down" });
    try { handle(client.room, client, body.msg || {}); } catch (err) { send(client.ws, { type: "error", error: err.message }); }
    return json(200, { ok: true });
  }
  if (url.pathname === "/roulette/api/health") return json(200, { ok: true, rooms: rooms.size });
  if (url.pathname === "/roulette/api/rooms" && req.method === "POST") {
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
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/roulette/ws") return socket.destroy();
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
  const client = { ws, playerId: null, host: false, misses: 0, ip: opts.ip || "" };
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
  // ответ на действие игрока: отказ — только ему, успех — всем
  const act = (action, r) => {
    if (!r.ok) return reply({ type: "rejected", action, reason: r.reason });
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
      return sendHello(room, client); // доске — полный снимок, с числом
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
        // Только игрок, который уже числится офлайн (грация истекла): иначе любой, кто знает код комнаты,
        // занимал место моргнувшего Wi-Fi, просто вписав его имя.
        const ghost = g.s.players.find((p) => !p.left && !p.online && p.name === name && ![...room.sockets].some((c) => c.playerId === p.id));
        if (ghost) {
          playerId = ghost.id;
          const token = crypto.randomBytes(12).toString("base64url");
          room.tokens[token] = playerId;
          msg.token = token;
        }
      }
      if (!playerId) {
        if (client.newPlayerAt && now() - client.newPlayerAt < 3000) return reply({ type: "error", error: "too_fast" });
        client.newPlayerAt = now();
        // имена уникальны: тёзке дописываем номер, иначе подхват по имени перепутал бы игроков
        let name = cleanName(msg.name);
        if (!name) return reply({ type: "error", error: "bad_name" });
        const taken = new Set(g.s.players.filter((p) => !p.left).map((p) => p.name));
        for (let i = 2; taken.has(name); i++) name = `${Array.from(cleanName(msg.name)).slice(0, 13).join("")} ${i}`;
        playerId = "u_" + crypto.randomBytes(5).toString("hex");
        const r = g.addPlayer({ id: playerId, name });
        if (!r.ok) return reply({ type: "error", error: r.reason });
        const token = crypto.randomBytes(12).toString("base64url");
        room.tokens[token] = playerId;
        client.token = token;
        reply({ type: "joined", playerId, token });
      } else {
        client.token = msg.token;
        reply({ type: "joined", playerId, token: msg.token });
      }
      for (const c of room.sockets) if (c !== client && c.playerId === playerId) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      client.playerId = playerId;
      cancelOffline(room, playerId);
      return afterChange(room, [{ type: "online", playerId }, ...g.setOnline(playerId, true)]);
    }
    case "leave": {
      if (!me) return;
      const events = g.removePlayer(me, t);
      client.playerId = null;
      pruneTokens(room);
      return afterChange(room, events);
    }
    // ---- игрок ----
    case "bet": return me ? act("bet", g.bet(me, String(msg.key || ""), msg.amount)) : undefined;
    case "set_bets": return me ? act("set_bets", g.setBets(me, msg.bets)) : undefined;
    case "ready": return me ? act("ready", g.setReady(me, msg.ready !== false, t)) : undefined;
    case "card": return me ? act("card", g.playCard(me, String(msg.card || ""), String(msg.target || ""))) : undefined;
    case "chat": return me ? act("chat", g.chat(me, msg.text, t)) : undefined;
    case "react": {
      if (!me) return;
      const r = g.react(me, String(msg.emoji || ""), t);
      if (!r.ok) return;
      // реакция — только событие, снимок не меняется: не гоняем state всем
      for (const e of r.events) broadcastEvent(room, e);
      return;
    }
    // ---- ведущий (только доска) ----
    case "settings": {
      if (!client.host) return;
      if (g.s.phase !== "lobby") return reply({ type: "error", error: "game_started" });
      g.s.settings = clampSettings({ ...g.s.settings, ...(msg.settings || {}) });
      for (const p of g.s.players) p.stack = g.s.settings.stack;
      return afterChange(room, []);
    }
    case "start": {
      if (!client.host) return;
      const r = g.start(t);
      if (!r.ok) return reply({ type: "rejected", action: "start", reason: r.reason });
      return afterChange(room, r.events);
    }
    case "go": return client.host ? afterChange(room, g.hostGo(t)) : undefined;
    case "pause": return client.host ? afterChange(room, g.pause(t)) : undefined;
    case "resume": {
      // доска умерла — продолжить может любой игрок, но только пока ни одной доски нет
      const noBoard = ![...room.sockets].some((c) => c.host);
      if (!client.host && !(noBoard && me)) return;
      return afterChange(room, g.resume(t));
    }
    case "kick": {
      if (!client.host) return;
      const events = g.removePlayer(String(msg.playerId || ""), t);
      pruneTokens(room);
      for (const c of room.sockets) if (c.playerId === msg.playerId) { c.playerId = null; send(c.ws, { type: "kicked" }); }
      return afterChange(room, events);
    }
    case "hide_msg": return client.host ? afterChange(room, g.hideMessage(Number(msg.id))) : undefined;
    case "mute": return client.host ? afterChange(room, g.mute(String(msg.playerId || ""), msg.muted !== false)) : undefined;
    case "end": return client.host ? afterChange(room, g.finishNow(t)) : undefined;
    case "next_game": {
      if (!client.host) return;
      const events = g.reset();
      for (const p of g.s.players) p.online = room.bots.some((b) => b.playerId === p.id) || [...room.sockets].some((c) => c.playerId === p.id);
      for (const b of room.bots) b.mem = {};
      pruneTokens(room);
      return afterChange(room, events);
    }
    case "bots": {
      if (!client.host || !DEV) return;
      if (g.s.phase !== "lobby") return;
      addBots(room, Math.min(11, Number(msg.n) || 3));
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
      if (c.poll) continue;
      if (c.misses >= PONG_MISSES) { c.ws.terminate(); continue; }
      c.misses = (c.misses || 0) + 1;
      c.ws.ping();
    }
    const ph = room.game.s.phase;
    if (room.sockets.size && ph !== "lobby" && ph !== "finished" && !room.game.s.paused) room.touched = now();
    if (now() - room.touched > ROOM_TTL) destroyRoom(room);
  }
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  if (rooms.size) {
    const drops = statBlips ? `, обрывов ${statBlips} (вернулись ${statBack}, выпали ${statDrops})` : "";
    console.log(`${LOG} комнат ${rooms.size}, соединений ${totalSockets()}, RSS ${rssMb} МБ${drops}`);
  }
  statBlips = statBack = statDrops = 0;
  if (rssMb > 180) console.warn(`${LOG} ВНИМАНИЕ: RSS ${rssMb} МБ при лимите контейнера 256 МБ, комнат ${rooms.size}`);
}, SWEEP);

setInterval(() => {
  const t = now();
  for (const c of pollClients.values()) {
    const idle = !c.inflight && t - c.lastSeen > POLL_GAP_MS;
    const anon = !c.playerId && !c.host && !c.wasHost && t - c.opened > ANON_TTL_MS;
    if (idle || anon || t - c.lastSeen > 40000) closePoll(c.sid);
  }
}, 2000).unref();

let dumpWasEmpty = false;
function dump() {
  try {
    const data = [...rooms.values()]
      .filter((r) => !r.bots.length)
      // чат в дамп не пишем (§9): он живёт только в памяти комнаты
      .map((r) => ({ code: r.code, ip: r.ip, hostToken: r.hostToken, tokens: r.tokens, touched: r.touched, state: { ...r.game.s, chat: [] } }));
    if (!data.length && dumpWasEmpty) return;
    dumpWasEmpty = !data.length;
    fs.mkdirSync(path.dirname(DUMP), { recursive: true });
    fs.writeFileSync(DUMP + ".tmp", JSON.stringify(data));
    fs.renameSync(DUMP + ".tmp", DUMP);
  } catch (err) {
    console.warn(`${LOG} дамп не удался:`, err.message);
  }
}

/*
 * После перезапуска посреди спина: если шарик уже был брошен (closing/spinning), доигрываем его —
 * число и сид траектории лежат в дампе, доска построит ту же анимацию, а сроки сдвигаем на время простоя,
 * чтобы игроки успели вернуться. В фазе ставок ставим паузу: без людей таймер закрыл бы ставки впустую.
 */
function restore() {
  try {
    if (!fs.existsSync(DUMP)) return;
    for (const r of JSON.parse(fs.readFileSync(DUMP, "utf8"))) {
      if (now() - r.touched > ROOM_TTL) continue;
      const room = newRoom({ code: r.code, ip: r.ip || "", hostToken: r.hostToken, game: Game.from(r.state, rnd), tokens: r.tokens || {}, touched: r.touched });
      const s = room.game.s;
      for (const p of s.players) p.online = false;
      pruneTokens(room);
      if (s.phase === "betting" && !s.paused) room.game.pause(clock(room));
      else if (s.phase !== "lobby" && s.phase !== "finished" && s.phase !== "briefing") {
        const shift = Math.max(0, now() + 5000 - (s.deadline || 0));
        if (s.deadline) s.deadline += shift;
        if (s.result) { s.result.spinAt += shift; s.result.revealAt += shift; s.result.closedAt += shift; }
        s.pauseNext = true; // доиграем выплаты, следующие ставки — на паузе, пока люди не вернутся
      }
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
function fatal(what, err) {
  try { console.error(`${LOG} ${what}:`, (err && err.stack) || err); } catch {}
  try { dump(); } catch {}
  process.exit(1);
}
process.on("uncaughtException", (err) => fatal("непойманное исключение", err));
process.on("unhandledRejection", (err) => fatal("непойманный отказ промиса", err));

process.on("SIGTERM", () => {
  dump();
  try { server.close(); } catch {}
  for (const room of rooms.values()) {
    for (const c of room.sockets) { try { if (!c.poll) c.ws.close(1012, "restart"); } catch {} }
  }
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => console.log(`${LOG} порт ${PORT}${STATIC ? ", статика из " + STATIC : ""}${DEV ? ", режим разработки (боты)" : ""}`));

module.exports = { rooms, handle, createRoom };
