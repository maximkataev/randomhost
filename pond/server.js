"use strict";

/*
 * Сервер «Лягушек на кувшинках»: HTTP (создание комнаты, health) + WebSocket (игра в реальном времени). frog-pond-spec.md §7, §10.
 * Скелет — как у floe/server.js (комнаты с кодом-словом, токены, лимиты, защита от перебора кодов, общий lib/),
 * но позиции по сети не ходят: сервер шлёт события (прыжок, приземление, волна…) с метками времени партии,
 * клиент сам считает дуги прыжков (physics.js). Полный снимок — раз в секунду и при входе, он закрывает любую потерю.
 * Решения принимаются по меткам времени, а не по тикам (game.js); задержку игрока сервер меряет сам (hb/hbr), клиенту не верит.
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 4200)
 * Разработка: NODE_ENV=development STATIC=.. node server.js — статика сайта с того же origin.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { WebSocketServer } = require("ws");
const { roomCode } = require("../lib/codes");
const names = require("../lib/names");
const seats = require("../lib/seats");
const presence = require("../lib/presence");
const { clientIp, createGuessLimiter, rateOk: netRateOk, send } = require("../lib/net");
const { createGame, DEFAULTS } = require("./game");

const PORT = Number(process.env.PORT || 4200);
const STATIC = process.env.STATIC ? path.resolve(process.env.STATIC) : null;
const DEV = process.env.NODE_ENV === "development";
const DUMP = process.env.DUMP_FILE || path.join(__dirname, "state", "rooms.json");
const TICK_MS = 50;                                              // 20 шагов в секунду; решения идут по меткам времени, не по тикам
const SNAP_MS = 1000;                                            // полный снимок раз в секунду в бою
const HB_MS = 2000;                                              // пульс сервера: заодно меряет задержку игрока
const HB_DEAD_MS = 6000;                                         // нет ответа на пульс — сокет мёртвый (мобильные сети рвутся молча)
const ROOM_TTL = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 300);
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE || 100);        // партий в бою одновременно (§10)
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 15);
const MAX_PLAYERS = 12;
const MAX_SOCKETS_PER_ROOM = Number(process.env.MAX_SOCKETS_PER_ROOM || 24);
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS || 3000);
const MAX_ANON_PER_ROOM = 12;
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP || 60);
const HOST_HANDOFF_MS = 10000;                                   // ведущий комнаты пропал на 10 с — права следующему
// Числа правил и защит из env С ПРОВЕРКОЙ ДИАПАЗОНА; мусор → значение по умолчанию (как у floe)
function envNum(name, def, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= min && v <= max) return v;
  console.warn(`[pond] ${name}=${JSON.stringify(raw)} вне диапазона ${min}…${max} — беру ${def}`);
  return def;
}
const PROD_ENV = {
  GHOST_TTL_MS: envNum("GHOST_TTL_MS", 120000, 5000, 3600000),     // офлайн в лобби/итоге дольше — убираем из списка
  PONG_MISSES: envNum("PONG_MISSES", 3, 1, 30),                    // пропущенных ws-пингов (по 20 с) до разрыва сокета
  ANON_TTL_MS: envNum("ANON_TTL_MS", 30000, 3000, 600000),
  CLAIM_WAIT_MS: envNum("CLAIM_WAIT_MS", 120000, 1000, 3600000),
  MAX_ANON_PER_IP: envNum("MAX_ANON_PER_IP", 10, 1, 100),
};
const RULE_U01_CLAIM_IN_GAME = /^(1|true|on)$/i.test(process.env.RULE_U01_CLAIM_IN_GAME || "");
const NAME_MAX = names.LIMITS.SHORT;   // 15
const { GHOST_TTL_MS, PONG_MISSES, ANON_TTL_MS, MAX_ANON_PER_IP, CLAIM_WAIT_MS } = PROD_ENV;
const SEND_BUFFER_LIMIT = Number(process.env.SEND_BUFFER_LIMIT || 262144);
const MSG_RATE = Number(process.env.MSG_RATE || 30);
const MAX_MSG_BYTES = 1024;
const LOG = "[pond]";
const REACTIONS = new Set(["🔥", "😂", "😱", "👏"]);
const HATS = 16;
// только в разработке: POND_CFG='{"MAX_T":20}' — короткие партии для тестов
const DEV_CFG = DEV && process.env.POND_CFG ? JSON.parse(process.env.POND_CFG) : undefined;
const GAME_CFG = Object.assign({}, DEV_CFG);

// ---------- комнаты ----------

const rooms = new Map(); // code → room
const newCode = () => roomCode((c) => rooms.has(c));

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
const isActive = (room) => room.game.phase === "countdown" || room.game.phase === "fight";

// Жребий (рассадка, тай-брейки, выбор кувшинок) — из crypto: сид пруда уходит клиентам, состояние PRNG не должно восстанавливаться
function cryptoDraw() { return crypto.randomInt(0, 2 ** 32) / 4294967296; }

function newRoom({ code, ip = "", hostToken }) {
  return {
    code, ip, hostToken,
    game: createGame({ seed: crypto.randomInt(1, 2 ** 32), rng: cryptoDraw, cfg: GAME_CFG }),
    tokens: {},              // token → playerId
    meta: new Map(),         // playerId → { joinedAt, ping, lastSeq, offlineAt, left }
    hostId: null,
    sockets: new Set(),
    touched: now(),
    lastTickAt: 0,           // стенное время прошлого тика: игровое время идёт по часам, а не по числу тиков
    snapAt: 0,
    rosterDirty: false,
    reactAt: new Map(),
    tickN: 0,
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

// ---------- имена и цвета ----------

const cleanName = (s) => names.cleanName(s, NAME_MAX);
const nameKey = names.nameKey;
function freeHat(room, want, except) {
  const used = new Set(room.game.players.filter((p) => p.id !== except).map((p) => p.ci));
  if (Number.isInteger(want) && want >= 0 && want < HATS && !used.has(want)) return want;
  for (let i = 0; i < HATS; i++) if (!used.has(i)) return i;
  return 0;
}

// ---------- рассылка ----------

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
// Рассылка списка копится и уходит раз за тик (флуд «hat»/«join» не множит roster)
function sendRoster(room) { room.rosterDirty = true; }
function flushRoster(room) {
  if (!room.rosterDirty) return;
  room.rosterDirty = false;
  broadcast(room, JSON.stringify(rosterMsg(room)));
}

// числа в событиях — до миллисекунды: траектория считается на клиенте из этих чисел, лишние знаки только раздувают трафик
function slim(o) {
  const r = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    r[k] = typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
  }
  return r;
}
const snapMsg = (room) => JSON.stringify(Object.assign({ type: "snap" }, room.game.snapshot(), { ts: now() }));
function sendSnap(room, client) { send(client.ws, JSON.parse(snapMsg(room))); }

// ---------- игровой цикл ----------

const MIN_DT = 0.02, MAX_DT = 0.15;
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
  if (!online && !isActive(room)) { room.lastTickAt = 0; return flushRoster(room); }
  room.tickN++;
  // игровое время — по часам: задержанный тик (GC, нагрузка) не растягивает партию
  const dt = room.lastTickAt ? Math.min(MAX_DT, Math.max(MIN_DT, (t - room.lastTickAt) / 1000)) : TICK_MS / 1000;
  room.lastTickAt = t;
  const was = g.phase;
  g.step(dt);
  maintain(room, t);
  const events = g.drainEvents();
  if (events.some((e) => ["go", "over", "removed", "offline", "online", "start"].includes(e.type))) sendRoster(room);
  flushRoster(room);
  if (events.length) broadcast(room, JSON.stringify({ type: "ev", gt: g.clock(), list: events.map(slim) }));
  // снимок: на смене фазы сразу, в бою раз в секунду
  if (g.phase !== was || (isActive(room) && t - room.snapAt >= SNAP_MS)) { room.snapAt = t; broadcast(room, snapMsg(room)); }
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
  // призраки: в лобби и в итоге офлайн-место живёт GHOST_TTL_MS; в бою не освобождается никогда
  if (g.phase === "lobby" || g.phase === "over") {
    let changed = false;
    for (const p of [...g.players]) {
      const m = room.meta.get(p.id);
      if (m && !m.left && !p.online && t - (m.offlineAt || t) > GHOST_TTL_MS && (g.phase === "lobby" || !p.inGame)) {
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

const server = http.createServer((req, res) => {
  try { route(req, res); } catch (err) {
    console.warn(`${LOG} запрос упал: ${String(err && err.message).slice(0, 120)}`);
    try { res.writeHead(400); res.end(); } catch {}
  }
});
function route(req, res) {
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/pond/api/health") return json(200, { ok: true, rooms: rooms.size, active: activeGames() });
  // есть ли комната: 200 — есть (отказ сокета тогда не «нет комнаты», а 503 «полно»/сеть), 404 — нет
  if (url.pathname === "/pond/api/room" && req.method === "GET") {
    const room = roomFor(req, url);
    if (!room) return json(404, { error: "no_room" });
    return json(200, { ok: true, phase: room.game.phase, players: room.game.players.filter((p) => !room.meta.get(p.id)?.left).length });
  }
  if (url.pathname === "/pond/api/rooms" && req.method === "POST") {
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
  if (url.pathname !== "/pond/ws") return socket.destroy();
  const room = roomFor(req, url);
  if (!room) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  const freeAnon = (c) => !c.playerId && !seats.isPending(c);
  const anon = [...room.sockets].filter(freeAnon).length;
  const ip = clientIp(req);
  const anonIp = [...room.sockets].filter((c) => freeAnon(c) && c.ip === ip).length;
  if (room.sockets.size >= MAX_SOCKETS_PER_ROOM || totalSockets() >= MAX_TOTAL_SOCKETS || anon >= MAX_ANON_PER_ROOM || anonIp >= MAX_ANON_PER_IP || socketsFromIp(ip) >= MAX_SOCKETS_PER_IP) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(room, ws, ip));
}

// что клиенту нужно, чтобы считать те же прыжки: все числа правил движка
const cfgFor = (g) => Object.fromEntries(Object.entries(g.cfg).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));

function onConnection(room, ws, ip) {
  const client = { ws, playerId: null, misses: 0, ip, opened: now(), createdAt: now(), rtt: 0, hbN: 0, hbAt: 0, hbSent: new Map(), lastHbr: now() };
  room.sockets.add(client);
  ws.on("pong", () => (client.misses = 0));
  const helloMsg = { type: "hello", code: room.code, cfg: cfgFor(room.game), tick: TICK_MS, max: MAX_PLAYERS, limits: { name: NAME_MAX }, ts: now(), gt: room.game.clock() };
  if (process.env.MP_OFF === "1") helloMsg.mp = false;
  send(ws, helloMsg);
  send(ws, rosterMsg(room));
  ws.on("message", (raw) => {
    if (!netRateOk(client, MSG_RATE)) return;
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

function releasePlayer(room, client, id) {
  client.playerId = null;
  if (![...room.sockets].some((c) => c !== client && c.playerId === id) && room.game.byId.has(id)) {
    room.game.setOnline(id, false);
    const m = room.meta.get(id);
    if (m) m.offlineAt = now();
  }
}

// вход/reload в фазе «итог»: событие over шло один раз при финише — повторяем вошедшему (late)
function sendLateOver(room, client) {
  const g = room.game;
  if (g.phase !== "over" || !g.over) return;
  send(client.ws, { type: "ev", gt: g.clock(), list: [slim(Object.assign({ type: "over", late: true }, g.over))] });
}

// Пульс сервера: клиент отвечает тем же номером; разница — настоящая задержка игрока (клиенту о ней верить нельзя).
// EMA, чтобы один выброс не менял поправку на лаг.
function heartbeat(room, client, t) {
  if (client.ws.readyState !== 1) return;
  if (t - client.lastHbr > HB_DEAD_MS) { try { client.ws.terminate(); } catch {} return; }
  const c = ++client.hbN;
  client.hbSent.set(c, t);
  if (client.hbSent.size > 8) client.hbSent.delete(client.hbSent.keys().next().value);
  send(client.ws, { type: "hb", c, gt: room.game.clock(), ts: t });
}

function handle(room, client, msg) {
  if (!msg || typeof msg !== "object") return;
  const g = room.game;
  const me = client.playerId;
  const reply = (o) => send(client.ws, o);
  const isHost = () => me && me === room.hostId;

  switch (msg.type) {
    case "j": {
      // прыжок: угол, сила, номер. Дубликаты (повтор неподтверждённого) отбрасываем по номеру, но подтверждаем
      if (!me) return;
      const m = room.meta.get(me);
      if (!m || !Number.isInteger(msg.s) || msg.s < 1 || msg.s >= 2 ** 31) return;
      if (msg.s <= m.lastSeq) return reply({ type: "ack", s: msg.s, dup: true });
      m.lastSeq = msg.s;
      const lag = (client.rtt || 0) / 2000;
      const ok = g.input(me, { ang: Math.round(Number(msg.a) * 1000) / 1000, pow: Math.round(Number(msg.p) * 1000) / 1000, seq: msg.s }, lag);
      return reply({ type: "ack", s: msg.s, ok, gt: g.clock() });
    }
    case "hbr": {
      const sent = client.hbSent.get(msg.c);
      if (sent == null) return;
      client.hbSent.delete(msg.c);
      client.lastHbr = now();
      const rtt = Math.max(0, now() - sent);
      client.rtt = client.rtt ? client.rtt * 0.7 + rtt * 0.3 : rtt;
      if (me) {
        const m = room.meta.get(me);
        if (m) {
          const np = Math.max(0, Math.min(9999, Math.round(client.rtt)));
          const moved = Math.abs(np - m.ping) >= 25 || (np > 250) !== (m.ping > 250) || (!m.ping && np > 0);
          m.ping = np;
          if (moved && now() - (room.pingRosterAt || 0) > 3000) { room.pingRosterAt = now(); sendRoster(room); }
        }
      }
      return;
    }
    case "ping": {
      // для синхронизации часов клиента: отвечаем сразу, с часами партии и стенными часами сервера
      return reply({ type: "pong", c: typeof msg.c === "number" ? msg.c : 0, gt: g.clock(), ts: now() });
    }
    case "react": {
      if (!me || !REACTIONS.has(msg.e)) return;
      const last = room.reactAt.get(me) || 0;
      if (now() - last < 2000) return;
      room.reactAt.set(me, now());
      broadcast(room, JSON.stringify({ type: "ev", gt: g.clock(), list: [{ type: "react", id: me, e: msg.e }] }));
      return;
    }
    case "join": {
      room.touched = now();
      let id = typeof msg.token === "string" && room.tokens[msg.token];
      if (id && !g.byId.has(id)) { delete room.tokens[msg.token]; id = null; }
      if (!id && me && g.byId.has(me) && !room.meta.get(me)?.left) { reply({ type: "joined", playerId: me, token: client.token, name: g.byId.get(me).name, renamed: false, resumed: true }); sendSnap(room, client); return sendLateOver(room, client); }
      if (id && me && id !== me) releasePlayer(room, client, me);
      let joinName = null, renamed = false, resumed = !!id;
      if (!id) {
        if (client.joinedAt && now() - client.joinedAt < 2000) return reply({ type: "error", error: "too_fast" });
        const name = cleanName(msg.name);
        if (!name) return reply({ type: "error", error: "bad_name" });
        const live = g.players.filter((p) => !room.meta.get(p.id)?.left);
        const inGame = isActive(room);
        const key = nameKey(name);
        const seat = live.find((p) => nameKey(p.name) === key) || null;
        const seatMeta = seat && room.meta.get(seat.id);
        let phase = g.phase, policy = "claim", graceMs = seats.CLAIM_GRACE_MS;
        if (inGame && seat) {
          if (seat.st === "removed" && !seat.online) phase = "lobby";
          else if (RULE_U01_CLAIM_IN_GAME && !seat.online) { phase = "lobby"; policy = "strict"; graceMs = 10000; }
        }
        const decision = seats.decideJoin({
          players: live.map((p) => ({ id: p.id, name: p.name })),
          name, token: null, phase, claimablePhases: ["lobby", "over"],
          policy, graceMs, sameIp: !!(seatMeta && seatMeta.ip && seatMeta.ip === client.ip),
          now: now(),
          hasLiveSocket: (pid) => [...room.sockets].some((c) => c.playerId === pid && c.ws.readyState === 1),
          isStale: (pid) => { const cs = [...room.sockets].filter((c) => c.playerId === pid); return cs.length > 0 && cs.every((c) => (c.misses || 0) >= 2); },
          closedAt: (pid) => room.meta.get(pid)?.offlineAt || null,
          caps: Array.isArray(msg.caps) ? msg.caps.filter((x) => typeof x === "string").slice(0, 8) : [],
          claim: msg.claim === true, fresh: msg.fresh === true,
          max: NAME_MAX, legacyClaim: false,
        });
        if (decision.action === "deny") return reply({ type: "error", error: "bad_name" });
        const place = decision.player ? g.byId.get(decision.player.id) : null;
        if (decision.action === "prompt" || decision.action === "retry") {
          const mp = seats.markPending(client, { sockets: room.sockets, now: now(), ip: client.ip });
          if (!mp.ok) return reply({ type: "error", error: "name_taken", reason: mp.reason, retry: false, online: false });
          if (decision.action === "retry") return reply({ type: "error", error: "name_claim", name: place ? place.name : name, retry: true, retryInMs: decision.retryInMs });
          return reply({ type: "error", error: "name_claim", name: place.name, summary: { ci: place.ci } });
        }
        if (decision.action === "claim" && place) {
          id = place.id;
          resumed = true;
          joinName = place.name;
          for (const [tok, pid] of Object.entries(room.tokens)) if (pid === id) delete room.tokens[tok];
          const token = crypto.randomBytes(12).toString("base64url");
          room.tokens[token] = id;
          msg.token = token;
          client.joinedAt = now();
          broadcast(room, JSON.stringify({ type: "ev", gt: g.clock(), list: [{ type: "claimed", id }] }));
          console.log(`${LOG} ${room.code}: ${place.name} вернулся по имени`);
        } else {
          let nm = decision.name || decision.suggested || name;
          if (live.length >= MAX_PLAYERS) {
            const vict = !inGame && presence.evictOldestGhost(live.map((p) => ({ id: p.id, online: p.online, offSince: room.meta.get(p.id)?.offlineAt || undefined, played: p.inGame ? 1 : 0 })),
              { now: now(), minAgeMs: GHOST_TTL_MS, stage: g.phase === "lobby" ? "lobby" : "finished" });
            if (!vict) return reply({ type: "error", error: "room_full" });
            dropPlayer(room, vict);
            sendRoster(room);
          }
          const taken = names.takenKeysOf(g.players.filter((p) => !room.meta.get(p.id)?.left));
          nm = names.nextFreeName(nm, taken, NAME_MAX) || nm;
          renamed = nameKey(nm) !== key;
          joinName = nm;
          id = "u_" + crypto.randomBytes(5).toString("hex");
          g.addPlayer(id, nm, freeHat(room, Number(msg.ci), id));
          room.meta.set(id, { joinedAt: now(), ping: 0, lastSeq: 0, offlineAt: 0, left: false, ip: client.ip });
          const token = crypto.randomBytes(12).toString("base64url");
          room.tokens[token] = id;
          msg.token = token;
          client.joinedAt = now();
          console.log(`${LOG} ${room.code}: вошёл ${nm} (${g.players.length})`);
        }
      }
      if (typeof msg.hostToken === "string" && msg.hostToken === room.hostToken) room.hostId = id;
      if (!room.hostId) room.hostId = id;
      for (const c of room.sockets) if (c !== client && c.playerId === id) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      client.playerId = id;
      client.token = msg.token;
      const m = room.meta.get(id);
      if (m) { m.offlineAt = 0; m.lastSeq = 0; }
      seats.clearPending(client);
      g.setOnline(id, true);
      reply({ type: "joined", playerId: id, token: msg.token, name: joinName || g.byId.get(id).name, renamed, resumed });
      sendRoster(room);
      sendSnap(room, client);       // вернувшийся сразу получает полную картину, без ожидания секундного снимка
      sendLateOver(room, client);
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
      if (g.phase === "over") { for (const p of [...g.players]) if (room.meta.get(p.id)?.left) room.meta.delete(p.id); g.toLobby(); }
      // офлайн дольше 8 с в партию не берём (lib/presence): токен не отзывается — вернуться можно, зрителем
      const ghosts = presence.pruneOfflineForNewGame(g.players.map((p) => ({ id: p.id, online: p.online, offSince: room.meta.get(p.id)?.offlineAt || now(), left: !!room.meta.get(p.id)?.left })), { now: now() });
      for (const gid of ghosts) { const gm = room.meta.get(gid); if (gm) gm.left = true; }
      for (const p of [...g.players]) if (room.meta.get(p.id)?.left) { g.removePlayer(p.id); room.meta.delete(p.id); }
      if (!g.start()) return reply({ type: "error", error: "need_two" });
      room.snapAt = 0;
      console.log(`${LOG} ${room.code}: партия на ${g.inPlay().length}`);
      sendRoster(room);
      return;
    }
    case "lobby": {
      if (!isHost() || g.phase !== "over") return;
      for (const p of [...g.players]) if (room.meta.get(p.id)?.left) room.meta.delete(p.id);
      g.toLobby();
      sendRoster(room);
      broadcast(room, snapMsg(room));
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
  for (const room of rooms.values()) for (const c of room.sockets) heartbeat(room, c, t);
}, HB_MS);

setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    for (const c of room.sockets) {
      if (c.misses >= PONG_MISSES) { c.ws.terminate(); continue; }
      c.misses++;
      try { c.ws.ping(); } catch {}
      if (!c.playerId && seats.anonExpired(c, t, { anonTtlMs: ANON_TTL_MS, claimWaitMs: CLAIM_WAIT_MS })) { try { c.ws.close(4000, "anon_timeout"); } catch {} }
    }
    if (room.sockets.size || isActive(room)) room.touched = t;
    if (t - room.touched > ROOM_TTL) { console.log(`${LOG} комната ${room.code} закрыта по времени`); destroyRoom(room); }
  }
  const mem = process.memoryUsage();
  if (rooms.size || tickCount) {
    console.log(`${LOG} комнат ${rooms.size}, в бою ${activeGames()}, соединений ${totalSockets()}, тик ср. ${(tickCost / Math.max(1, tickCount)).toFixed(2)} мс / макс ${tickMax.toFixed(1)} мс, куча ${Math.round(mem.heapUsed / 1048576)} МБ, RSS ${Math.round(mem.rss / 1048576)} МБ`);
  }
  if (tickMax > TICK_MS * 0.6) console.warn(`${LOG} ВНИМАНИЕ: тик ${tickMax.toFixed(1)} мс при бюджете ${TICK_MS} мс`);
  tickCost = 0; tickCount = 0; tickMax = 0;
}, 20000);

// Дамп: после рестарта партия отменяется, а комнаты с людьми, цветами и токенами живут дальше (в лобби)
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

module.exports = { rooms, handle, createRoom, dump, loop, DEFAULTS, PROD_ENV };
