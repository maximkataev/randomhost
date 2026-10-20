"use strict";

/*
 * Сервер «Утиного сплава»: HTTP (создание комнаты, health) + WebSocket (заплыв в реальном времени). duck-rapids-spec.md.
 * Скелет — floe/server.js («Царь льдины»): комнаты с кодом-словом, токены, лимиты, защита от перебора кодов,
 * один общий цикл 20 раз в секунду двигает все заплывы и рассылает снимки.
 * Физика и правила — только здесь (game.js); клиент присылает руль и рисует снимки.
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 3800)
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

const PORT = Number(process.env.PORT || 3800);
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
const MAX_VIEWERS = 4;                    // экранов «только показ» на комнату
const HOST_RESERVE_MS = 180000;           // сколько ждём ведущего с телефона, прежде чем им станет первый вошедший
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP || 60);
const HOST_HANDOFF_MS = 10000;                                   // ведущий комнаты пропал на 10 с — права следующему
// Числа правил и защит из env С ПРОВЕРКОЙ ДИАПАЗОНА. FLOE_CFG/RAPIDS_CFG читаются только при NODE_ENV=development,
// поэтому в проде откат правила без пересборки кода — только эти переменные (compose environment). Мусор → значение по умолчанию.
function envNum(name, def, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= min && v <= max) return v;
  console.warn(`[rapids] ${name}=${JSON.stringify(raw)} вне диапазона ${min}…${max} — беру ${def}`);
  return def;
}

// Блок PROD_ENV (T-W0-21): всё, чем откатывают правило в проде. Значения по умолчанию = поведение «как сейчас».
const PROD_ENV = {
  INPUT_STALE_MS: envNum("INPUT_STALE_MS", 1200, 200, 60000),      // нет руля дольше — руль в ноль (раньше константа STEER_TTL)
  GHOST_TTL_MS: envNum("GHOST_TTL_MS", 120000, 5000, 3600000),     // офлайн в лобби/итогах дольше — убираем из списка (U-07: 120 с; в заплыве — никогда)
  PONG_MISSES: envNum("PONG_MISSES", 3, 1, 30),                    // пропущенных пингов (по 20 с) до разрыва сокета
  ANON_TTL_MS: envNum("ANON_TTL_MS", 30000, 3000, 600000),         // не вошёл за это время — не держит место
  CLAIM_WAIT_MS: envNum("CLAIM_WAIT_MS", 120000, 1000, 3600000),   // ожидание подтверждения «Это ты?» (потребитель — W1)
  MAX_ANON_PER_IP: envNum("MAX_ANON_PER_IP", 10, 1, 100),
};
const { INPUT_STALE_MS: STEER_TTL, GHOST_TTL_MS, PONG_MISSES, ANON_TTL_MS, MAX_ANON_PER_IP, CLAIM_WAIT_MS } = PROD_ENV;
const NAME_MAX = 15;
const MP_OFF = process.env.MP_OFF === "1";
const START_GHOST_GRACE_MS = 8000;   // офлайн дольше этого перед новым заплывом в него не переходят и из комнаты уходят
const CLAIM_IN_GAME_GRACE_MS = 10000;
const SEND_BUFFER_LIMIT = Number(process.env.SEND_BUFFER_LIMIT || 262144);
const MSG_RATE = Number(process.env.MSG_RATE || 70);
// Сверх общего MSG_RATE ввод `i` не выбрасывается молча (иначе пропадали рывок и финальный «0» — floe-014/rapids-036), а
// запоминается: последнее значение применится в ближайшем тике. Разбирать JSON разрешено только до жёсткого потолка в секунду;
// дальше — отбрасываем, как и раньше (защита от флуда не ослаблена, общий лимитер не отключён)
const MSG_HARD = Math.max(MSG_RATE, Number(process.env.MSG_HARD || 120));             // руль до 30/с + пинги
const MAX_MSG_BYTES = 1024;
const LOG = "[rapids]";
// только в разработке: RAPIDS_CFG='{"LEN":800}' — короткие заплывы для тестов
const DEV_CFG = DEV && process.env.RAPIDS_CFG ? JSON.parse(process.env.RAPIDS_CFG) : undefined;
// правила-флаги движка (класс B, по умолчанию «как сейчас»; включает владелец после «да» — env, без пересборки)
const RULE_U51_COUNTDOWN_LEAVE = process.env.RULE_U51_COUNTDOWN_LEAVE === "1";   // U-51: добровольный выход в отсчёте — не «неудачник»
const RULE_U53_NO_SPECTATOR_DASH = process.env.RULE_U53_NO_SPECTATOR_DASH === "1";   // U-53: рывок зрителя в идущем заплыве запрещён (в лобби остаётся)
const GAME_CFG = Object.assign({ RULE_U51_COUNTDOWN_LEAVE, RULE_U53_NO_SPECTATOR_DASH }, DEV_CFG);
// U-01, класс B: подхват места по имени посреди заплыва (>= 10 с офлайна, тот же IP, с подтверждением). Без флага в заплыве — только токен.
const RULE_U01_CLAIM_IN_GAME = process.env.RULE_U01_CLAIM_IN_GAME === "1";

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
const isActive = (room) => room.game.phase === "countdown" || room.game.phase === "race";

function newRoom({ code, ip = "", hostToken, seed }) {
  const room = {
    code, ip, hostToken,
    game: createGame({ rng: rngFor(seed), cfg: GAME_CFG }),
    tokens: {},              // token → playerId
    meta: new Map(),         // playerId → { joinedAt, ping, lastSeq, offlineAt, left }
    hostId: null,
    sockets: new Set(),
    touched: now(),
    lastTickAt: 0,           // стенное время прошлого тика комнаты: игровое время идёт по часам, а не по числу тиков
    tickN: 0,
  };
  return room;
}

// Физика и жребий ничьей — на сервере, сид непредсказуем снаружи
function rngFor(seed) {
  const buf = crypto.randomBytes(4);
  let a = (seed ?? buf.readUInt32LE(0)) >>> 0;
  // mulberry32: сид трассы и жребий дорожек на старте
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

// ---------- имена и цвета уток ----------

// lib/names: срез по символам (эмодзи на границе не превращается в «�»), ключ сравнения общий для всех игр (U-05)
const cleanName = (s) => names.cleanName(s, NAME_MAX);
const nameKey = names.nameKey;
const COLORS = 20;
function freeColor(room, want, except) {
  const used = new Set(room.game.players.filter((p) => p.id !== except && !room.meta.get(p.id)?.left).map((p) => p.ci));
  if (Number.isInteger(want) && want >= 0 && want < COLORS && !used.has(want)) return want;
  for (let i = 0; i < COLORS; i++) if (!used.has(i)) return i;
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

// Снимок: одинаковый для всех, собирается один раз за тик. Трасса — только сид: клиент строит ту же реку сам
function snapMsg(room, t) {
  const g = room.game;
  const s = g.snapshot();
  const msg = {
    type: "s", t, ph: s.phase, pt: s.phaseT, cl: s.clock, sd: s.seed, ch: s.champion, host: s.host,
    // в лобби плавают все, в заплыве — только участники
    p: s.players.filter((p) => s.phase === "lobby" || p.inGame).filter((p) => !room.meta.get(p.id)?.left || p.inGame).map((p) => [
      p.id, p.x, p.y, p.vx, p.vy, p.ang, p.st, p.place, p.online ? 1 : 0, room.meta.get(p.id)?.lastSeq || 0, p.tcd,
    ]),
  };
  return JSON.stringify(msg);
}

const EVENT_TYPES = new Set(["go", "phase", "course", "bump", "rock", "log", "whirl", "whirlOut", "turbo", "finish", "champion", "host", "over", "removed", "aborted", "offline", "online"]);

// ---------- игровой цикл ----------

const MIN_DT = 0.02, MAX_DT = 0.15;
// по секциям тика (шаг движка / обслуживание / рассылка) — чтобы «ВНИМАНИЕ: тик» говорило, где время
let tickCost = 0, tickMax = 0, tickCount = 0, secStep = 0, secMaintain = 0, secSend = 0, secStepMax = 0;
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
  // пустое лобби и законченная партия без игроков не тикают; в простое счёт часов сбрасывается
  if (!online && !isActive(room)) { room.lastTickAt = 0; return flushRoster(room); }
  room.tickN++;
  // игровое время — по часам: задержанный тик (GC, нагрузка) не растягивает заплыв (rapids-020). Потолок 0,15 с — после
  // паузы процесса игра не прыгает; пол 0,02 с — два тика подряд не удваивают время
  const dt = room.lastTickAt ? Math.min(MAX_DT, Math.max(MIN_DT, (t - room.lastTickAt) / 1000)) : TICK_MS / 1000;
  room.lastTickAt = t;
  flushPendingInput(room);
  const s0 = performance.now();
  g.step(dt);
  const s1 = performance.now();
  maintain(room, t);
  const s2 = performance.now();
  secStep += s1 - s0; secMaintain += s2 - s1; secStepMax = Math.max(secStepMax, s1 - s0);
  const events = g.drainEvents().filter((e) => EVENT_TYPES.has(e.type));
  // список игроков — раньше снимка: клиент по нему решает, играет он в этой партии или смотрит
  if (events.some((e) => e.type === "phase" || e.type === "removed" || e.type === "offline" || e.type === "online")) sendRoster(room);
  flushRoster(room);
  if (events.length) broadcast(room, JSON.stringify({ type: "ev", list: events.map(slimEvent) }));
  broadcast(room, snapMsg(room, t));
  if (events.some((e) => e.type === "over")) console.log(`${LOG} ${room.code}: заплыв окончен за ${g.clock.toFixed(1)} с`);
  secSend += performance.now() - s2;
}

function slimEvent(e) {
  const o = Object.assign({}, e);
  delete o.t;
  if (typeof o.clock === "number") o.clock = Math.round(o.clock * 100) / 100;
  if (typeof o.x === "number") o.x = Math.round(o.x * 10) / 10;
  if (typeof o.y === "number") o.y = Math.round(o.y * 10) / 10;
  if (typeof o.power === "number") o.power = Math.round(o.power);
  return o;
}

// ведущий комнаты, призраки лобби и брошенный руль
function maintain(room, t) {
  const g = room.game;
  // клиент шлёт руль каждые 0.5 с; нет ввода дольше STEER_TTL — вкладка в фоне или сеть встала молча: руль в ноль,
  // иначе утка часами прижата к берегу последним рулём (плейтест 04.10)
  for (const p of g.players) {
    if (!p.steer) continue;
    const m = room.meta.get(p.id);
    if (m && t - (m.inputAt || 0) > STEER_TTL) g.setInput(p.id, 0);
  }
  const host = room.hostId && g.byId.get(room.hostId);
  const hostMeta = host && room.meta.get(host.id);
  const reserved = !room.hostId && room.hostReservedAt && t - room.hostReservedAt < HOST_RESERVE_MS;
  if (!reserved && (!host || hostMeta.left || (!host.online && t - (hostMeta.offlineAt || t) > HOST_HANDOFF_MS))) {
    const next = g.players
      .filter((p) => p.online && !room.meta.get(p.id)?.left)
      .sort((a, b) => room.meta.get(a.id).joinedAt - room.meta.get(b.id).joinedAt)[0];
    if (next && next.id !== room.hostId) {
      room.hostId = next.id;
      console.log(`${LOG} ${room.code}: ведущий комнаты теперь ${next.name}`);
      sendRoster(room);
    }
  }
  // призраки: в лобби и итогах офлайн дольше GHOST_TTL_MS уходит из списка; в заплыве уходят только не участвующие (R1)
  const drop = presence.ghostsToDrop({ players: presenceView(room, t), now: t, stage: "lobby", ttlMs: GHOST_TTL_MS, protect: protectInGame(room) });
  if (drop.length) {
    // токен не отзываем (К-17): вернувшийся по токену/имени получит место заново
    for (const id of drop) dropPlayer(room, id, { ghost: true });
    sendRoster(room);
  }
}

// представление игроков для lib/presence: офлайн без метки времени получает её сейчас
function presenceView(room, t) {
  return room.game.players.map((p) => {
    const m = room.meta.get(p.id) || {};
    if (!p.online && !m.offlineAt) m.offlineAt = t || now();
    return { id: p.id, online: p.online, offSince: p.online ? undefined : m.offlineAt, left: !!m.left };
  });
}
// в countdown/race место участника заплыва не освобождается никогда; в лобби и итогах защищать некого
const protectInGame = (room) => (id) => {
  const g = room.game;
  if (g.phase !== "countdown" && g.phase !== "race") return false;
  const p = g.byId.get(id);
  return !!(p && p.inGame);
};

// opts.kick — убрал ведущий: в отсчёте это не наказание (U-51, класс A); добровольный выход решает RULE_U51_COUNTDOWN_LEAVE.
// opts.ghost — место снято по таймеру/вытеснением: токен не отзывается (К-17), вернётся по токену или имени
function dropPlayer(room, id, opts) {
  const m = room.meta.get(id);
  if (m) m.left = true;
  room.game.removePlayer(id, opts);
  if (!room.game.byId.has(id)) room.meta.delete(id);
  if (opts && opts.ghost) return;
  for (const [tok, pid] of Object.entries(room.tokens)) if (pid === id) delete room.tokens[tok];
}
// у места есть живой сокет (не «завис»: два пропущенных pong подряд — офлайн)
const hasLiveSocket = (room, id) => [...room.sockets].some((c) => c.playerId === id && c.ws.readyState === 1);
const isStaleSeat = (room, id) => { const cs = [...room.sockets].filter((c) => c.playerId === id); return cs.length > 0 && cs.every((c) => (c.misses || 0) >= 2); };
// прежние токены места отзываются: подхват по имени отдаёт место новому устройству, старое возвращается только по имени
function revokeTokens(room, id) {
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
  if (url.pathname === "/rapids/api/health") return json(200, { ok: true, rooms: rooms.size, active: activeGames() });
  if (url.pathname === "/rapids/api/rooms" && req.method === "POST") {
    req.resume();
    try {
      const room = createRoom(clientIp(req));
      console.log(`${LOG} комната ${room.code} создана`);
      return json(200, { code: room.code, hostToken: room.hostToken });
    } catch (err) {
      return json(429, { error: err.message });
    }
  }
  // «Такой комнаты нет» против «занято»: статус рукопожатия WebSocket браузер не видит. Промах считается как угадывание кода
  if (url.pathname === "/rapids/api/room" && req.method === "GET") {
    const room = roomFor(req, url);
    return room ? json(200, { ok: true }) : json(404, { error: "no_room" });
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
  if (url.pathname !== "/rapids/ws") return socket.destroy();
  const room = roomFor(req, url);
  if (!room) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  // ждущий подтверждения «Это ты?» — не «пустой» аноним: у него свои потолки в lib/seats
  const freeAnon = (c) => !c.playerId && !c.viewer && !seats.isPending(c);
  const anon = [...room.sockets].filter(freeAnon).length;
  const ip = clientIp(req);
  // с одного адреса — офис целиком, но не сотни сокетов (у wave то же самое)
  const anonIp = [...room.sockets].filter((c) => freeAnon(c) && c.ip === ip).length;
  if (room.sockets.size >= MAX_SOCKETS_PER_ROOM || totalSockets() >= MAX_TOTAL_SOCKETS || anon >= MAX_ANON_PER_ROOM || anonIp >= MAX_ANON_PER_IP || socketsFromIp(ip) >= MAX_SOCKETS_PER_IP) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(room, ws, ip));
}

// что клиенту нужно, чтобы построить ту же реку и предсказывать свою утку той же физикой, что у сервера
const PREDICT_CFG = ["DR", "FLOW", "BANK_K", "STREAM_K", "LILY_K", "RELAX", "STEER", "POOL_STEER", "LOG_SLIDE", "COUNTDOWN", "RACE_T", "LEN", "TURBO_T", "TURBO_K", "TURBO_RELAX", "TURBO_CD"];
const cfgFor = (g) => Object.fromEntries(PREDICT_CFG.map((k) => [k, g.cfg[k]]));

function onConnection(room, ws, ip) {
  const client = { ws, playerId: null, misses: 0, ip, opened: now() };
  room.sockets.add(client);
  ws.on("pong", () => (client.misses = 0));
  const hello = { type: "hello", code: room.code, cfg: cfgFor(room.game), tick: TICK_MS, max: MAX_PLAYERS, limits: { name: NAME_MAX } };
  if (MP_OFF) hello.mp = false;   // аварийный выключатель mp-common.js на клиентах
  send(ws, hello);
  send(ws, rosterMsg(room));
  ws.on("message", (raw) => {
    if (!rateOk(client)) return coalesceOver(client, raw);
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

// сообщение пришло сверх MSG_RATE: если это руль и до потолка MSG_HARD ещё есть запас — запоминаем последний руль
// (финальный «0» не теряется, rapids-036); рывок `t` сверх лимита не копится — он разовый и защищён перезарядкой
function coalesceOver(client, raw) {
  if (!client.playerId || !client.rl || client.rl.n > MSG_HARD) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== "object" || msg.type !== "i") return;
  client.pendingI = { st: msg.st, s: msg.s };
}
// применяем отложенный руль раз за тик (после этого очередь пуста)
function flushPendingInput(room) {
  for (const c of room.sockets) {
    if (!c.pendingI) continue;
    const m = c.pendingI;
    c.pendingI = null;
    if (c.playerId) handle(room, c, { type: "i", st: m.st, s: m.s });
  }
}

// вход/reload в фазе «итог»: событие over было один раз при финише — повторяем его вошедшему (late), иначе итог не нарисовать
function sendLateOver(room, client) {
  const g = room.game;
  if (g.phase !== "over" || !g.stats) return;
  const e = { type: "over", host: g.host, champion: g.champion, championName: (g.byId.get(g.champion) || {}).name || "", stats: g.stats, late: true };
  send(client.ws, { type: "ev", list: [slimEvent(e)] });
}

function handle(room, client, msg) {
  if (!msg || typeof msg !== "object") return;
  const g = room.game;
  const me = client.playerId;
  const reply = (o) => send(client.ws, o);
  const isHost = () => me && me === room.hostId;

  switch (msg.type) {
    case "i": {
      // руль: -1…1, движок сам обрежет и округлит
      if (!me) return;
      g.setInput(me, Number(msg.st));
      const m = room.meta.get(me);
      if (m) m.inputAt = now();
      if (m && Number.isInteger(msg.s) && msg.s > m.lastSeq && msg.s < 2 ** 31) m.lastSeq = msg.s;
      return;
    }
    case "t": {
      // рывок: готовность и допуски проверяет движок
      if (me) g.useTurbo(me);
      return;
    }
    case "ping": {
      if (me && Number.isFinite(msg.rtt)) { const m = room.meta.get(me); if (m) m.ping = Math.max(0, Math.min(9999, Math.round(msg.rtt))); }
      return reply({ type: "pong", c: typeof msg.c === "number" ? msg.c : 0, t: now() });
    }
    case "view": {
      // «экран»: комп только показывает партию, играют с телефонов. Не игрок, к анонимам не причисляется, живёт без таймаута
      const viewers = [...room.sockets].filter((c) => c.viewer && c !== client).length;
      if (me || (!client.viewer && viewers >= MAX_VIEWERS)) return;
      client.viewer = true;
      // ведущий придёт с телефона по ссылке с токеном: пока он не вошёл, первый вошедший ведущим не становится
      if (typeof msg.hostToken === "string" && msg.hostToken === room.hostToken && !room.hostId) room.hostReservedAt = now();
      send(client.ws, JSON.parse(snapMsg(room, now())));
      sendLateOver(room, client);
      return;
    }
    case "join": {
      room.touched = now();
      let id = typeof msg.token === "string" && room.tokens[msg.token];
      if (id && !g.byId.has(id)) { delete room.tokens[msg.token]; id = null; }
      // один сокет — один игрок: новый вход без токена с уже вошедшего сокета новых уток не плодит
      // (иначе один сокет набивал комнату «вечно онлайн» фантомами — ревью безопасности 29.09)
      if (!id && me && g.byId.has(me) && !room.meta.get(me)?.left) {
        reply({ type: "joined", playerId: me, token: client.token, name: g.byId.get(me).name, resumed: true });
        return sendLateOver(room, client);
      }
      if (id && me && id !== me) releasePlayer(room, client, me);
      let resumed = !!id, joinName = null, renamed = false;
      if (!id) {
        // вход по имени: решение — lib/seats.decideJoin (токена нет или он не найден)
        const cleaned = cleanName(msg.name);
        if (!cleaned) return reply({ type: "error", error: "bad_name" });
        const inPlay = g.phase === "countdown" || g.phase === "race";
        const t = now();
        const live = g.players.filter((p) => !room.meta.get(p.id)?.left);
        const decision = seats.decideJoin({
          players: g.players.map((p) => ({ id: p.id, name: p.name, left: !!room.meta.get(p.id)?.left })),
          name: cleaned,
          token: null,
          phase: g.phase,
          // в заплыве имя подхватывается только под правилом U-01 (≥ 10 с офлайна, тот же IP, с подтверждением)
          claimablePhases: RULE_U01_CLAIM_IN_GAME ? ["lobby", "over", "countdown", "race"] : ["lobby", "over"],
          policy: "claim",
          now: t,
          graceMs: inPlay ? CLAIM_IN_GAME_GRACE_MS : seats.CLAIM_GRACE_MS,
          hasLiveSocket: (pid) => hasLiveSocket(room, pid),
          isStale: (pid) => isStaleSeat(room, pid),
          closedAt: (pid) => room.meta.get(pid)?.offlineAt || null,
          caps: Array.isArray(msg.caps) ? msg.caps.filter((x) => typeof x === "string").slice(0, 8) : [],
          claim: msg.claim === true,
          fresh: msg.fresh === true,
          max: NAME_MAX,
          legacyClaim: false,
        });
        // в заплыве место возвращается только с того же адреса: иначе знающий код отбирал бы утку у лагающего друга
        let act = decision;
        if (act.action === "claim" || act.action === "prompt") {
          const seat = act.player && room.meta.get(act.player.id);
          if (inPlay && (!seat || !seat.ip || seat.ip !== client.ip)) act = { action: "create", name: names.nextFreeName(cleaned, names.takenKeysOf(g.players, { skipLeft: true }), NAME_MAX), kind: "phase_blocked" };
        }
        if (act.action === "deny") return reply({ type: "error", error: "bad_name" });
        const place = act.player ? g.byId.get(act.player.id) : null;
        if (act.action === "prompt" || act.action === "retry") {
          const mp = seats.markPending(client, { sockets: room.sockets, now: t, ip: client.ip });
          if (!mp.ok) return reply({ type: "error", error: "name_taken", reason: mp.reason, retry: false, online: false });
          if (act.action === "retry") return reply({ type: "error", error: "name_claim", name: place ? place.name : cleaned, retry: true, retryInMs: act.retryInMs });
          return reply({ type: "error", error: "name_claim", name: place.name, summary: seats.claimSummary(place, ["ci"]) });
        }
        if (act.action === "claim" && place) {
          // подхват: прежние токены места отозваны, прежний сокет получит `replaced`; в заплыве — к своей утке
          id = place.id;
          resumed = true;
          joinName = place.name;
          revokeTokens(room, id);
          const token = crypto.randomBytes(12).toString("base64url");
          room.tokens[token] = id;
          msg.token = token;
        } else {
          // новый игрок (taken/create): при заполнении комнаты вытесняем самого давнего офлайн старше порога, иначе room_full
          if (client.joinedAt && t - client.joinedAt < 2000) return;
          if (live.length >= MAX_PLAYERS) {
            const victim = presence.evictOldestGhost(presenceView(room, t), { now: t, stage: "lobby", protect: protectInGame(room), minAgeMs: GHOST_TTL_MS });
            if (!victim) return reply({ type: "error", error: "room_full" });
            dropPlayer(room, victim, { ghost: true });
            sendRoster(room);
          }
          const nm = act.name || act.suggested || cleaned;
          renamed = nameKey(nm) !== nameKey(cleaned);
          joinName = nm;
          id = "u_" + crypto.randomBytes(5).toString("hex");
          g.addPlayer(id, nm, freeColor(room, Number(msg.ci), id));
          room.meta.set(id, { joinedAt: now(), ping: 0, lastSeq: 0, offlineAt: 0, left: false, ip: client.ip });
          const token = crypto.randomBytes(12).toString("base64url");
          room.tokens[token] = id;
          msg.token = token;
          client.joinedAt = now();
          console.log(`${LOG} ${room.code}: вошёл ${nm} (${g.players.length})`);
        }
      }
      // ведущий комнаты — тот, кто её создал (у него host-токен), иначе первый вошедший
      if (typeof msg.hostToken === "string" && msg.hostToken === room.hostToken) { room.hostId = id; room.creatorId = id; }
      if (!room.hostId && !(room.hostReservedAt && now() - room.hostReservedAt < HOST_RESERVE_MS)) room.hostId = id;
      for (const c of room.sockets) if (c !== client && c.playerId === id) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      seats.clearPending(client);
      client.playerId = id;
      client.token = msg.token;
      const m = room.meta.get(id);
      if (m) { m.offlineAt = 0; m.lastSeq = 0; m.ip = client.ip; }
      g.setOnline(id, true);
      reply({ type: "joined", playerId: id, token: msg.token, name: joinName || g.byId.get(id).name, renamed, resumed });
      sendRoster(room);
      sendLateOver(room, client);
      return;
    }
    case "color": {
      if (!me || g.phase !== "lobby") return;
      const p = g.byId.get(me);
      if (p) { p.ci = freeColor(room, Number(msg.ci), me); sendRoster(room); }
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
      // офлайн дольше грации в новый заплыв не переходят: чистим перед стартом (токен не отзывается, К-17)
      for (const id of presence.pruneOfflineForNewGame(presenceView(room, now()), { now: now(), graceMs: START_GHOST_GRACE_MS })) {
        const mm = room.meta.get(id);
        if (mm) mm.left = true;
      }
      for (const p of [...g.players]) if (room.meta.get(p.id)?.left) { g.removePlayer(p.id); room.meta.delete(p.id); }
      if (!g.start()) return reply({ type: "error", error: "need_two" });
      console.log(`${LOG} ${room.code}: заплыв на ${g.inPlay().length}`);
      sendRoster(room);
      return;
    }
    case "lobby": {
      if (!isHost() || g.phase !== "over") return;
      for (const p of [...g.players]) if (room.meta.get(p.id)?.left) { g.removePlayer(p.id); room.meta.delete(p.id); }
      g.toLobby();
      sendRoster(room);
      return;
    }
    case "kick": {
      if (!isHost() || msg.playerId === me || !g.byId.has(msg.playerId)) return;
      // создателя, пока он офлайн, не убрать: вернувшись с токеном, он иначе оказался бы «чужим» в своей комнате (rapids-005)
      if (msg.playerId === room.creatorId && !g.byId.get(msg.playerId).online) return reply({ type: "error", error: "creator_away" });
      for (const c of room.sockets) if (c.playerId === msg.playerId) { c.playerId = null; send(c.ws, { type: "kicked" }); }
      dropPlayer(room, msg.playerId, { kick: true });
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
      // ждущий подтверждения «Это ты?» живёт CLAIM_WAIT_MS с name_claim, а не ANON_TTL_MS (иначе экран умирал на 31 с)
      if (!c.playerId && !c.viewer) {
        const pend = seats.isPending(c);
        if (t - (pend ? c.pendingClaimAt : c.opened) > (pend ? CLAIM_WAIT_MS : ANON_TTL_MS)) { try { c.ws.terminate(); } catch {} }
      }
    }
    if (room.sockets.size || isActive(room)) room.touched = t;
    if (t - room.touched > ROOM_TTL) { console.log(`${LOG} комната ${room.code} закрыта по времени`); destroyRoom(room); }
  }
  const mem = process.memoryUsage();
  const rss = Math.round(mem.rss / 1048576), heap = Math.round(mem.heapUsed / 1048576);
  if (rooms.size || tickCount) {
    console.log(`${LOG} комнат ${rooms.size}, в бою ${activeGames()}, соединений ${totalSockets()}, тик ср. ${(tickCost / Math.max(1, tickCount)).toFixed(2)} мс / макс ${tickMax.toFixed(1)} мс, куча ${heap} МБ, RSS ${rss} МБ`);
  }
  if (tickMax > TICK_MS * 0.6) console.warn(`${LOG} ВНИМАНИЕ: тик ${tickMax.toFixed(1)} мс при бюджете ${TICK_MS} мс (за окно: шаг ${secStep.toFixed(0)} мс, макс. шага комнаты ${secStepMax.toFixed(1)}, обслуживание ${secMaintain.toFixed(0)}, рассылка ${secSend.toFixed(0)})`);
  tickCost = 0; tickCount = 0; tickMax = 0; secStep = 0; secMaintain = 0; secSend = 0; secStepMax = 0;
}, 20000);

// Дамп: заплыв короткий, после рестарта он отменяется, а комнаты с людьми, цветами и токенами — живут дальше (в лобби)
function dump() {
  try {
    const data = [...rooms.values()].map((r) => ({
      code: r.code, ip: r.ip, hostToken: r.hostToken, tokens: r.tokens, hostId: r.hostId, creatorId: r.creatorId || null, touched: r.touched,
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
      room.creatorId = r.creatorId || null;
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
