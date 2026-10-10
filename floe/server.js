"use strict";

/*
 * Сервер «Царя льдины»: HTTP (создание комнаты, health) + WebSocket (игра в реальном времени). floe-battle-spec.md §8, §10.
 * Скелет — как у wave/server.js (комнаты с кодом-словом, токены, лимиты, защита от перебора кодов),
 * но игра идёт непрерывно: один общий цикл 20 раз в секунду двигает все партии и рассылает снимки.
 * Физика и правила — только здесь (game.js); клиент присылает ввод и рисует снимки.
 * Long-poll-запасного пути нет: реалтайму он не годится.
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 3700)
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
const { createGame, DEFAULTS } = require("./game");

const PORT = Number(process.env.PORT || 3700);
const STATIC = process.env.STATIC ? path.resolve(process.env.STATIC) : null;
const DEV = process.env.NODE_ENV === "development";
const DUMP = process.env.DUMP_FILE || path.join(__dirname, "state", "rooms.json");
const TICK_MS = 50;                                              // 20 шагов и снимков в секунду
const ROOM_TTL = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 150);
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE || 40);         // партий в бою одновременно (§10)
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 15);
const MAX_PLAYERS = 12;
const MAX_SOCKETS_PER_ROOM = Number(process.env.MAX_SOCKETS_PER_ROOM || 24);
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS || 1500);
const MAX_ANON_PER_ROOM = 12;
const MAX_ANON_PER_IP = Number(process.env.MAX_ANON_PER_IP || 10);
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP || 60);
const ANON_TTL_MS = 30000;
const HOST_HANDOFF_MS = 10000;                                   // ведущий комнаты пропал на 10 с — права следующему
const LOBBY_GHOST_MS = 60000;                                    // офлайн в лобби дольше минуты — убираем из списка
const PONG_MISSES = 3;
const SEND_BUFFER_LIMIT = Number(process.env.SEND_BUFFER_LIMIT || 262144);
const MSG_RATE = Number(process.env.MSG_RATE || 70);             // ввод до 30/с + пинги
const MAX_MSG_BYTES = 1024;
const LOG = "[floe]";
// только в разработке: FLOE_CFG='{"FIGHT_T":20}' — короткие партии для тестов
const DEV_CFG = DEV && process.env.FLOE_CFG ? JSON.parse(process.env.FLOE_CFG) : undefined;

// ---------- комнаты ----------

const rooms = new Map(); // code → room


const newCode = () => roomCode((c) => rooms.has(c));

// перебор кодов: адрес, промахнувшийся GUESS_LIMIT раз за окно, до конца окна не получает ни одной комнаты
const { blocked: guessBlocked, missed: guessMissed } = createGuessLimiter(Number(process.env.GUESS_LIMIT || 60));
function roomFor(req, url) {
  const ip = clientIp(req);
  if (guessBlocked(ip)) return null;
  const room = rooms.get((url.searchParams.get("r") || "").toUpperCase());
  if (!room) guessMissed(ip);
  return room || null;
}

const now = () => Date.now();
const totalSockets = () => { let n = 0; for (const r of rooms.values()) n += r.sockets.size; return n; };
const activeGames = () => { let n = 0; for (const r of rooms.values()) if (isActive(r)) n++; return n; };
const isActive = (room) => room.game.phase === "countdown" || room.game.phase === "fight" || room.game.phase === "overtime";

function newRoom({ code, ip = "", hostToken, seed }) {
  const room = {
    code, ip, hostToken,
    game: createGame({ rng: rngFor(seed), cfg: DEV_CFG }),
    tokens: {},              // token → playerId
    meta: new Map(),         // playerId → { joinedAt, ping, lastSeq, offlineAt, left }
    hostId: null,
    sockets: new Set(),
    touched: now(),
    shVer: "",               // последняя разосланная строка осколков
    shSentAt: 0,
    tickN: 0,
  };
  return room;
}

// Физика и жребий ничьей — на сервере, сид непредсказуем снаружи
function rngFor(seed) {
  const buf = crypto.randomBytes(4);
  let a = (seed ?? buf.readUInt32LE(0)) >>> 0;
  // mulberry32 в движке для льдины и старта; тай-брейк «ничья — жребий» тоже идёт через него
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRoom(ip) {
  if (ip) {
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    if (mine >= MAX_ROOMS_PER_IP && !evictOldestEmpty(ip)) throw new Error("too_many_rooms");
  }
  if (rooms.size >= MAX_ROOMS && !evictOldestEmpty()) throw new Error("too_many_rooms");
  const room = newRoom({ code: newCode(), ip, hostToken: crypto.randomBytes(12).toString("base64url") });
  rooms.set(room.code, room);
  return room;
}

function evictOldestEmpty(ip) {
  let victim = null;
  for (const r of rooms.values()) {
    if (ip && r.ip !== ip) continue;
    if ([...r.sockets].some((c) => c.playerId) || isActive(r) || now() - r.touched < 10000) continue;
    if (!victim || r.touched < victim.touched) victim = r;
  }
  if (!victim) return false;
  destroyRoom(victim);
  return true;
}

function destroyRoom(room) {
  for (const c of room.sockets) {
    try { send(c.ws, { type: "error", error: "room_expired" }); c.ws.close(4000, "room_expired"); } catch {}
  }
  rooms.delete(room.code);
}

// ---------- имена и шапки ----------

function cleanName(s) {
  return String(s || "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim().slice(0, 15);
}
const nameKey = (s) => cleanName(s).toLowerCase().replace(/ё/g, "е");
const HATS = 20;
function freeHat(room, want, except) {
  const used = new Set(room.game.players.filter((p) => p.id !== except).map((p) => p.ci));
  if (Number.isInteger(want) && want >= 0 && want < HATS && !used.has(want)) return want;
  for (let i = 0; i < HATS; i++) if (!used.has(i)) return i;
  return 0;
}

// ---------- рассылка ----------


// Одно и то же сообщение уходит всем сокетам комнаты: кодируем в байты один раз, а не на каждый сокет
function broadcast(room, data) {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  for (const c of room.sockets) {
    if (c.ws.readyState !== 1) continue;
    if (c.ws.bufferedAmount > SEND_BUFFER_LIMIT) {
      console.log(`${LOG} ${room.code}: сокет не успевает читать (${Math.round(c.ws.bufferedAmount / 1024)} КБ) — рвём`);
      c.ws.terminate();
      continue;
    }
    c.ws.send(buf, { binary: false });
  }
}

// Список игроков — отдельно от снимков: меняется редко
function rosterMsg(room) {
  const g = room.game;
  return {
    type: "roster",
    hostId: room.hostId,
    players: g.players.filter((p) => !room.meta.get(p.id)?.left).map((p) => {
      const m = room.meta.get(p.id) || {};
      return { id: p.id, name: p.name, ci: p.ci, online: p.online, inGame: p.inGame, ping: m.ping || 0 };
    }),
  };
}
// Рассылка списка копится и уходит раз за тик: иначе один сокет флудом «hat»/«join» (до MSG_RATE в секунду)
// заставлял сервер слать roster каждому сокету комнаты 70 раз в секунду (ревью безопасности 05.10)
function sendRoster(room) { room.rosterDirty = true; }
function flushRoster(room) {
  if (!room.rosterDirty) return;
  room.rosterDirty = false;
  broadcast(room, JSON.stringify(rosterMsg(room)));
}

// Снимок: одинаковый для всех, собирается один раз за тик. Осколки — только когда поменялись (и раз в 2 с на всякий случай)
function snapMsg(room, t) {
  const g = room.game;
  const s = g.snapshot();
  const force = t - room.shSentAt > 2000;
  const msg = {
    type: "s", t, ph: s.phase, pt: s.phaseT, cl: s.clock, sd: s.seed, R: s.R,
    host: s.host, kings: s.kings,
    p: s.players.filter((p) => p.st !== "gone" || p.inGame).map((p) => [
      p.id, p.x, p.y, p.vx, p.vy, p.dir, p.st, p.dash, p.cd, p.fallT, p.online ? 1 : 0, room.meta.get(p.id)?.lastSeq || 0,
    ]),
  };
  if (s.sh !== room.shVer || force) { msg.sh = s.sh; room.shVer = s.sh; room.shSentAt = t; }
  return JSON.stringify(msg);
}

const EVENT_TYPES = new Set(["hit", "bump", "dash", "whiff", "fall", "crack", "sink", "host", "go", "phase", "over", "removed", "respawn", "offline", "online"]);

// ---------- игровой цикл ----------

let tickCost = 0, tickMax = 0, tickCount = 0;
function loop() {
  const t0 = process.hrtime.bigint();
  const t = now();
  for (const room of rooms.values()) {
    // ошибка в одной комнате не должна ронять процесс со всеми остальными: закрываем только её
    try { tickRoom(room, t); } catch (err) {
      console.error(`${LOG} ${room.code}: тик упал, комната закрыта:`, err);
      destroyRoom(room);
    }
  }
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  tickCost += dt; tickCount++; tickMax = Math.max(tickMax, dt);
}

function tickRoom(room, t) {
  const g = room.game;
  const online = g.players.some((p) => p.online);
  // пустое лобби и законченная партия без игроков не тикают
  if (!online && !isActive(room)) return flushRoster(room);
  room.tickN++;
  g.step(TICK_MS / 1000);
  maintain(room, t);
  const events = g.drainEvents().filter((e) => EVENT_TYPES.has(e.type));
  // список игроков — раньше снимка: клиент по нему решает, играет он в этой партии или смотрит
  if (events.some((e) => e.type === "phase" || e.type === "removed" || e.type === "offline" || e.type === "online")) sendRoster(room);
  flushRoster(room);
  if (events.length) broadcast(room, JSON.stringify({ type: "ev", list: events.map(slimEvent) }));
  broadcast(room, snapMsg(room, t));
  if (events.some((e) => e.type === "over")) onOver(room);
}

function slimEvent(e) {
  const o = Object.assign({}, e);
  delete o.t;
  if (typeof o.clock === "number") o.clock = Math.round(o.clock * 100) / 100;
  if (typeof o.x === "number") o.x = Math.round(o.x * 10) / 10;
  if (typeof o.y === "number") o.y = Math.round(o.y * 10) / 10;
  if (typeof o.power === "number") o.power = Math.round(o.power * 100) / 100;
  return o;
}

// Повтор первого падения: движок пишет 15 кадров в секунду, клиент интерполирует
function onOver(room) {
  const r = room.game.replay;
  if (!r) return;
  broadcast(room, JSON.stringify({ type: "replay", at: r.at, host: r.host, frames: r.frames }));
}

// ведущий комнаты и призраки лобби
function maintain(room, t) {
  const g = room.game;
  const host = room.hostId && g.byId.get(room.hostId);
  const hostMeta = host && room.meta.get(host.id);
  if (!host || hostMeta.left || (!host.online && t - (hostMeta.offlineAt || t) > HOST_HANDOFF_MS)) {
    const next = g.players
      .filter((p) => p.online && !room.meta.get(p.id)?.left)
      .sort((a, b) => room.meta.get(a.id).joinedAt - room.meta.get(b.id).joinedAt)[0];
    if (next && next.id !== room.hostId) {
      room.hostId = next.id;
      console.log(`${LOG} ${room.code}: ведущий комнаты теперь ${next.name}`);
      sendRoster(room);
    }
  }
  if (g.phase === "lobby" || g.phase === "over") {
    let changed = false;
    for (const p of [...g.players]) {
      const m = room.meta.get(p.id);
      if (m && !p.online && t - (m.offlineAt || t) > LOBBY_GHOST_MS && g.phase === "lobby") {
        dropPlayer(room, p.id);
        changed = true;
      }
    }
    if (changed) sendRoster(room);
  }
}

function dropPlayer(room, id) {
  const m = room.meta.get(id);
  if (m) m.left = true;
  room.game.removePlayer(id);
  if (!room.game.byId.has(id)) room.meta.delete(id);
  for (const [tok, pid] of Object.entries(room.tokens)) if (pid === id) delete room.tokens[tok];
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(STATIC, urlPath === "/" ? "index.html" : urlPath);
  // только внутри STATIC (с разделителем: «/../randomhost-x» иначе проходил по префиксу) и без скрытых путей вроде .git/
  if (!file.startsWith(STATIC + path.sep) || path.relative(STATIC, file).split(path.sep).some((s) => s.startsWith("."))) { res.writeHead(404); return res.end(); }
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



// одна кривая строка запроса не должна ронять процесс со всеми комнатами (ревью безопасности 29.09, как в bomb)
const server = http.createServer((req, res) => {
  try { route(req, res); } catch (err) {
    console.warn(`${LOG} запрос упал: ${String(err && err.message).slice(0, 120)}`);
    try { res.writeHead(400); res.end(); } catch {}
  }
});
function route(req, res) {
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/floe/api/health") return json(200, { ok: true, rooms: rooms.size, active: activeGames() });
  if (url.pathname === "/floe/api/rooms" && req.method === "POST") {
    req.resume();
    try {
      const room = createRoom(clientIp(req));
      console.log(`${LOG} комната ${room.code} создана`);
      return json(200, { code: room.code, hostToken: room.hostToken });
    } catch (err) {
      return json(429, { error: err.message });
    }
  }
  if (STATIC && req.method === "GET") return serveStatic(req, res);
  res.writeHead(404);
  res.end();
}

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  try { upgrade(req, socket, head); } catch { try { socket.destroy(); } catch {} }
});
function socketsFromIp(ip) { let n = 0; for (const r of rooms.values()) for (const c of r.sockets) if (c.ip === ip) n++; return n; }
function upgrade(req, socket, head) {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/floe/ws") return socket.destroy();
  const room = roomFor(req, url);
  if (!room) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  const anon = [...room.sockets].filter((c) => !c.playerId).length;
  const ip = clientIp(req);
  // с одного адреса — офис целиком, но не сотни сокетов (у wave то же самое)
  const anonIp = [...room.sockets].filter((c) => !c.playerId && c.ip === ip).length;
  if (room.sockets.size >= MAX_SOCKETS_PER_ROOM || totalSockets() >= MAX_TOTAL_SOCKETS || anon >= MAX_ANON_PER_ROOM || anonIp >= MAX_ANON_PER_IP || socketsFromIp(ip) >= MAX_SOCKETS_PER_IP) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(room, ws, ip));
}

// что клиенту нужно для предсказания своего пингвина — та же физика, что у сервера
const PREDICT_CFG = ["ACC", "DRAG", "DASH_V", "DASH_T", "DASH_DRAG", "DASH_CD", "PR", "COUNTDOWN", "FIGHT_T", "OVERTIME_T"];
const cfgFor = (g) => Object.fromEntries(PREDICT_CFG.map((k) => [k, g.cfg[k]]));

function onConnection(room, ws, ip) {
  const client = { ws, playerId: null, misses: 0, ip, opened: now() };
  room.sockets.add(client);
  ws.on("pong", () => (client.misses = 0));
  send(ws, { type: "hello", code: room.code, cfg: cfgFor(room.game), tick: TICK_MS, max: MAX_PLAYERS });
  send(ws, rosterMsg(room));
  ws.on("message", (raw) => {
    if (!rateOk(client)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(room, client, msg); } catch (err) { console.error(`${LOG} ${room.code}: обработка упала:`, err); send(ws, { type: "error", error: "server_error" }); }
  });
  ws.on("error", () => { try { ws.terminate(); } catch {} });
  ws.on("close", () => {
    room.sockets.delete(client);
    const id = client.playerId;
    if (id && ![...room.sockets].some((c) => c.playerId === id) && room.game.byId.has(id)) {
      room.game.setOnline(id, false);
      const m = room.meta.get(id);
      if (m) m.offlineAt = now();
      sendRoster(room);
    }
  });
}

// сокет перестал вести игрока: если других сокетов за ним нет — игрок офлайн
function releasePlayer(room, client, id) {
  client.playerId = null;
  if (![...room.sockets].some((c) => c !== client && c.playerId === id) && room.game.byId.has(id)) {
    room.game.setOnline(id, false);
    const m = room.meta.get(id);
    if (m) m.offlineAt = now();
  }
}

const rateOk = (client) => netRateOk(client, MSG_RATE);

function handle(room, client, msg) {
  if (!msg || typeof msg !== "object") return;
  const g = room.game;
  const me = client.playerId;
  const reply = (o) => send(client.ws, o);
  const isHost = () => me && me === room.hostId;

  switch (msg.type) {
    case "i": {
      // ввод: джойстик и рывок. Всё остальное проверяет движок (длина вектора, перезарядка)
      if (!me) return;
      g.setInput(me, msg.mx, msg.my, msg.d === 1);
      const m = room.meta.get(me);
      if (m && Number.isInteger(msg.s) && msg.s > m.lastSeq && msg.s < 2 ** 31) m.lastSeq = msg.s;
      return;
    }
    case "ping": {
      if (me && Number.isFinite(msg.rtt)) { const m = room.meta.get(me); if (m) m.ping = Math.max(0, Math.min(9999, Math.round(msg.rtt))); }
      return reply({ type: "pong", c: typeof msg.c === "number" ? msg.c : 0, t: now() });
    }
    case "join": {
      room.touched = now();
      let id = typeof msg.token === "string" && room.tokens[msg.token];
      if (id && !g.byId.has(id)) { delete room.tokens[msg.token]; id = null; }
      // один сокет — один игрок: новый вход без токена с уже вошедшего сокета новых пингвинов не плодит
      // (иначе один сокет набивал комнату «вечно онлайн» фантомами — ревью безопасности 29.09)
      if (!id && me && g.byId.has(me) && !room.meta.get(me)?.left) return reply({ type: "joined", playerId: me, token: client.token });
      if (id && me && id !== me) releasePlayer(room, client, me);
      if (!id) {
        if (client.joinedAt && now() - client.joinedAt < 2000) return;
        const name = cleanName(msg.name);
        if (!name) return reply({ type: "error", error: "bad_name" });
        const live = g.players.filter((p) => !room.meta.get(p.id)?.left);
        if (live.length >= MAX_PLAYERS) return reply({ type: "error", error: "room_full" });
        let nm = name;
        const taken = new Set(live.map((p) => nameKey(p.name)));
        for (let i = 2; taken.has(nameKey(nm)); i++) nm = `${name.slice(0, 12)} ${i}`;
        id = "u_" + crypto.randomBytes(5).toString("hex");
        g.addPlayer(id, nm, freeHat(room, Number(msg.ci), id));
        room.meta.set(id, { joinedAt: now(), ping: 0, lastSeq: 0, offlineAt: 0, left: false });
        const token = crypto.randomBytes(12).toString("base64url");
        room.tokens[token] = id;
        msg.token = token;
        client.joinedAt = now();
        console.log(`${LOG} ${room.code}: вошёл ${nm} (${g.players.length})`);
      }
      // ведущий комнаты — тот, кто её создал (у него host-токен), иначе первый вошедший
      if (typeof msg.hostToken === "string" && msg.hostToken === room.hostToken) room.hostId = id;
      if (!room.hostId) room.hostId = id;
      for (const c of room.sockets) if (c !== client && c.playerId === id) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      client.playerId = id;
      client.token = msg.token;
      const m = room.meta.get(id);
      if (m) { m.offlineAt = 0; m.lastSeq = 0; }
      g.setOnline(id, true);
      reply({ type: "joined", playerId: id, token: msg.token });
      sendRoster(room);
      return;
    }
    case "hat": {
      if (!me || g.phase !== "lobby") return;
      const p = g.byId.get(me);
      if (p) { p.ci = freeHat(room, Number(msg.ci), me); sendRoster(room); }
      return;
    }
    case "leave": {
      if (!me) return;
      dropPlayer(room, me);
      client.playerId = null;
      sendRoster(room);
      return;
    }
    // ---- ведущий комнаты ----
    case "start": {
      if (!isHost()) return;
      if (g.phase !== "lobby" && g.phase !== "over") return;
      if (activeGames() >= MAX_ACTIVE) return reply({ type: "error", error: "busy" });
      // ушедшие за прошлую партию больше не числятся
      for (const p of [...g.players]) if (room.meta.get(p.id)?.left) { g.removePlayer(p.id); room.meta.delete(p.id); }
      if (!g.start()) return reply({ type: "error", error: "need_two" });
      room.shVer = "";
      console.log(`${LOG} ${room.code}: партия на ${g.inPlay().length}`);
      sendRoster(room);
      return;
    }
    case "lobby": {
      if (!isHost() || g.phase !== "over") return;
      for (const p of [...g.players]) if (room.meta.get(p.id)?.left) { g.removePlayer(p.id); room.meta.delete(p.id); }
      g.toLobby();
      room.shVer = "";
      sendRoster(room);
      return;
    }
    case "kick": {
      if (!isHost() || msg.playerId === me || !g.byId.has(msg.playerId)) return;
      for (const c of room.sockets) if (c.playerId === msg.playerId) { c.playerId = null; send(c.ws, { type: "kicked" }); }
      dropPlayer(room, msg.playerId);
      sendRoster(room);
      return;
    }
    default:
      return;
  }
}

// ---------- обслуживание ----------

setInterval(loop, TICK_MS);

setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    for (const c of room.sockets) {
      if (c.misses >= PONG_MISSES) { c.ws.terminate(); continue; }
      c.misses++;
      try { c.ws.ping(); } catch {}
      // не вошёл за 30 с — не держит место
      if (!c.playerId && t - c.opened > ANON_TTL_MS) { try { c.ws.terminate(); } catch {} }
    }
    if (room.sockets.size || isActive(room)) room.touched = t;
    if (t - room.touched > ROOM_TTL) { console.log(`${LOG} комната ${room.code} закрыта по времени`); destroyRoom(room); }
  }
  const mem = process.memoryUsage();
  const rss = Math.round(mem.rss / 1048576), heap = Math.round(mem.heapUsed / 1048576);
  if (rooms.size || tickCount) {
    console.log(`${LOG} комнат ${rooms.size}, в бою ${activeGames()}, соединений ${totalSockets()}, тик ср. ${(tickCost / Math.max(1, tickCount)).toFixed(2)} мс / макс ${tickMax.toFixed(1)} мс, куча ${heap} МБ, RSS ${rss} МБ`);
  }
  if (tickMax > TICK_MS * 0.6) console.warn(`${LOG} ВНИМАНИЕ: тик ${tickMax.toFixed(1)} мс при бюджете ${TICK_MS} мс`);
  tickCost = 0; tickCount = 0; tickMax = 0;
}, 20000);

// Дамп: партия короткая, после рестарта она отменяется, а комнаты с людьми, шапками и токенами — живут дальше (в лобби)
function dump() {
  try {
    const data = [...rooms.values()].map((r) => ({
      code: r.code, ip: r.ip, hostToken: r.hostToken, tokens: r.tokens, hostId: r.hostId, touched: r.touched,
      players: r.game.players.filter((p) => !r.meta.get(p.id)?.left).map((p) => ({ id: p.id, name: p.name, ci: p.ci, joinedAt: r.meta.get(p.id)?.joinedAt || 0 })),
    }));
    fs.mkdirSync(path.dirname(DUMP), { recursive: true });
    fs.writeFileSync(DUMP + ".tmp", JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(DUMP + ".tmp", DUMP);
  } catch (err) {
    console.warn(`${LOG} дамп не удался:`, err.message);
  }
}

function restore() {
  try {
    if (!fs.existsSync(DUMP)) return;
    for (const r of JSON.parse(fs.readFileSync(DUMP, "utf8"))) {
      if (now() - r.touched > ROOM_TTL || rooms.has(r.code)) continue;
      const room = newRoom({ code: r.code, ip: r.ip, hostToken: r.hostToken });
      room.tokens = r.tokens || {};
      room.hostId = r.hostId || null;
      room.touched = r.touched;
      for (const p of r.players || []) {
        room.game.addPlayer(p.id, cleanName(p.name) || "?", p.ci | 0);
        room.game.setOnline(p.id, false);
        room.meta.set(p.id, { joinedAt: p.joinedAt || 0, ping: 0, lastSeq: 0, offlineAt: now(), left: false });
      }
      for (const [tok, id] of Object.entries(room.tokens)) if (!room.game.byId.has(id)) delete room.tokens[tok];
      rooms.set(room.code, room);
    }
    console.log(`${LOG} восстановлено комнат: ${rooms.size}`);
  } catch (err) {
    console.warn(`${LOG} восстановление не удалось:`, err.message);
  }
}

restore();
setInterval(dump, 10000);

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
  for (const room of rooms.values()) for (const c of room.sockets) { try { c.ws.close(1012, "restart"); } catch {} }
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => console.log(`${LOG} порт ${PORT}${STATIC ? ", статика из " + STATIC : ""}${DEV ? ", режим разработки" : ""}`));

module.exports = { rooms, handle, createRoom, DEFAULTS };
