"use strict";

/*
 * Сервер «Ставок»: HTTP (создание комнаты, health, long-poll) + WebSocket (игра). Контракт — docs/bets-protocol.md.
 * Скелет перенесён из roulette/server.js — комнаты, токены, грация офлайна, лимиты, дамп, poll-транспорт
 * работают так же и по тем же причинам (подробности и история — в комментариях там).
 * Отличия по сути:
 *  - снимок у доски и телефона разный (game.snapshot(now, forPlayer): доска — undefined, телефон — свой id, зритель — null);
 *  - движок без таймеров: сервер планирует tick(now) по game.nextDeadline() и рассылает события;
 *  - реальные события: при запирании окна зовём feed.begin(...) (bets/feed.js), без feed.js или при BETS_LIVE=none
 *    prepareLive возвращает null — движок заменяет слот сценическим событием;
 *  - чат на доске (50 последних, в память, не в дамп) и реакции.
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 4300)
 * Разработка: NODE_ENV=development STATIC=.. node server.js — статика сайта с того же origin и боты.
 * Время: BETS_TIME_SCALE=N (1..50) ускоряет часы партии в N раз (тесты, стенд); на проде не задаётся.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { WebSocketServer } = require("ws");
const { roomCode } = require("../lib/codes");
const { clientIp, createGuessLimiter, rateOk: netRateOk, send } = require("../lib/net");
const names = require("../lib/names");
const seats = require("../lib/seats");
const presence = require("../lib/presence");
const { Game, MAX_PLAYERS } = require("./game");
const { MIN_STAKE } = require("./odds");
const { decide, STRATEGIES } = require("./bots");

const PORT = Number(process.env.PORT || 4300);
const STATIC = process.env.STATIC ? path.resolve(process.env.STATIC) : null;
const DEV = process.env.NODE_ENV === "development";
const DUMP = process.env.DUMP_FILE || path.join(__dirname, "state", "rooms.json");
const ROOM_TTL = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);
const SWEEP = Math.min(25000, Math.max(1000, Math.floor(ROOM_TTL / 4)));
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 20);
const MAX_SOCKETS_PER_ROOM = Number(process.env.MAX_SOCKETS_PER_ROOM || 100);
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS || 3000);
// с одного адреса — не больше этого во всех комнатах (почему — см. roulette/server.js)
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP || 300);
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
const NAME_MAX = 16;
const CHAT_MAX = 80;            // символов в сообщении
const CHAT_KEEP = 50;           // сообщений в ленте доски
const CHAT_GAP_MS = Number(process.env.CHAT_GAP_MS || 3000);
const REACT_GAP_MS = Number(process.env.REACT_GAP_MS || 1000);
const TIME_SCALE = Math.max(1, Math.min(50, Number(process.env.BETS_TIME_SCALE) || 1));
const CLAIM_WAIT_MS = seats.CLAIM_WAIT_MS;
const GHOST_TTL_MS = presence.GHOST_TTL_MS;
const RULE_U01_CLAIM_IN_GAME = process.env.RULE_U01_CLAIM_IN_GAME === "1";
const MP_OFF = process.env.MP_OFF === "1";
const LOG = "[bets]";

// реакции — общий список с клиентами (bets-shared.js); в образе файл лежит рядом (/app/bets-shared.js)
let REACTIONS = ["🔥", "😱", "😂", "👏", "💀", "🤡"];
try { const sh = require("../bets-shared"); if (Array.isArray(sh.REACTIONS) && sh.REACTIONS.length) REACTIONS = sh.REACTIONS; } catch {}

// случайность партии — криптографическая: исход выбирается после запирания ставок и не должен угадываться
const rnd = (n) => crypto.randomInt(n);

// ---------- живые источники (bets/feed.js) ----------

// feed.js пишет другой пакет: нет модуля или BETS_LIVE=none — реальных событий нет, слоты станут сценическими
const LIVE_ENV = String(process.env.BETS_LIVE || "none").trim().toLowerCase();
let feed = null;
if (LIVE_ENV && LIVE_ENV !== "none") {
  try {
    const mod = require(process.env.BETS_FEED_MODULE || "./feed"); // BETS_FEED_MODULE — подмена для тестов
    const make = mod.createFeed || mod;
    feed = make({ log: (m) => console.log(`${LOG} feed: ${m}`), now: () => Date.now(), rnd, env: process.env });
    if (feed && typeof feed.start === "function") feed.start();
    console.log(`${LOG} живые события: ${LIVE_ENV}`);
  } catch (err) {
    feed = null;
    console.warn(`${LOG} feed.js недоступен (${err.code === "MODULE_NOT_FOUND" ? "нет модуля" : err.message}) — все события сценические`);
  }
}
function prepareLive(type) {
  if (!feed) return null;
  try { return feed.prepare(type) || null; } catch (err) { console.warn(`${LOG} feed.prepare(${type}) упал:`, err.message); return null; }
}

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
  clearInterval(room.botTimer);
  for (const t of room.botTimeouts) clearTimeout(t);
  cancelLive(room);
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
    if (r.sockets.size === 0 && r.touched < cutoff && (r.game.s.phase === "lobby" || r.game.s.phase === "done")) {
      if (!victim || r.touched < victim.touched) victim = r;
    }
  }
  if (!victim) return false;
  destroyRoom(victim);
  return true;
}

const playersOf = (room) => Object.values(room.game.s.players);

function pruneTokens(room) {
  const ids = new Set(Object.keys(room.game.s.players).filter((id) => !room.left.has(id)));
  for (const [t, id] of Object.entries(room.tokens)) if (!ids.has(id)) delete room.tokens[t];
  for (const id of room.dropCounts.keys()) if (!ids.has(id)) room.dropCounts.delete(id);
}

function newGame(state) {
  const opts = { intro: process.env.BETS_INTRO_MS !== undefined ? () => Math.max(0, Number(process.env.BETS_INTRO_MS) || 0) : undefined, prepareLive, liveTypes: () => (feed ? (typeof feed.enabled === "function" ? feed.enabled() : require("./registry").REAL) : []) };
  return state ? Game.restore(state, rnd, opts) : new Game(rnd, opts);
}

function newRoom({ code, ip = "", hostToken, game, tokens = {}, touched = Date.now(), speed = TIME_SCALE, left = [] }) {
  return {
    code, ip, hostToken, game, tokens,
    sockets: new Set(), // {ws, playerId?, host?}
    offlineTimers: new Map(),
    dropCounts: new Map(),
    closedAt: new Map(), // playerId → когда закрылся последний сокет места (грация подхвата по имени)
    left: new Set(left), // игроки, убранные посреди партии (кик/выход): место остаётся в таблице, вернуться нельзя
    timer: null,
    touched,
    speed,
    skew: 0,
    chat: [],            // последние CHAT_KEEP сообщений для доски (только в памяти)
    chatSeq: 0,
    chatAt: new Map(),   // playerId → когда писал последний раз
    reactAt: new Map(),
    liveSeq: 0,
    liveToken: null,
    liveHandle: null,
    bots: [],            // {playerId, strategy, mem}
    botTimer: null,
    botTimeouts: new Set(),
    botEv: -1,
  };
}

function createRoom({ settings = {}, speed, ip = "" } = {}) {
  if (ip) {
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    if (mine >= MAX_ROOMS_PER_IP && !evictOldestEmpty(ip)) throw new Error("too many rooms from this address");
  }
  if (rooms.size >= MAX_ROOMS && !evictOldestEmpty()) throw new Error("too many rooms");
  const game = newGame();
  game.setSettings(settings && typeof settings === "object" ? settings : {});
  game.s.settings.chat = settings && settings.chat === false ? false : true;
  const room = newRoom({
    code: newCode(),
    ip,
    hostToken: crypto.randomBytes(12).toString("base64url"),
    game,
    speed: DEV && Number(speed) ? Math.max(1, Math.min(50, Number(speed))) : TIME_SCALE,
  });
  rooms.set(room.code, room);
  return room;
}

const rateOk = (client) => netRateOk(client, MSG_RATE);

const now = () => Date.now();
// Часы комнаты: при speed > 1 (разработка, тесты) таймер просыпается раньше и комната «догоняет» дедлайн
const clock = (room) => now() + (room.skew || 0);

function schedule(room) {
  clearTimeout(room.timer);
  const g = room.game;
  const at = g.nextDeadline();
  if (!at || g.s.phase === "lobby" || g.s.phase === "done") return;
  const wait = Math.max(0, (at - clock(room)) / room.speed);
  room.timer = setTimeout(() => {
    try {
      const due = room.game.nextDeadline();
      if (due) room.skew += Math.max(0, due - clock(room));
      afterChange(room, room.game.tick(clock(room)));
    } catch (err) {
      console.error(`${LOG} шаг таймера упал:`, err);
    }
  }, Math.min(wait, 2 ** 31 - 1));
}

let statBlips = 0, statBack = 0, statDrops = 0;

function scheduleOffline(room, playerId) {
  if (!playerId) return;
  if ([...room.sockets].some((c) => c.playerId === playerId)) return;
  if (room.offlineTimers.has(playerId)) return;
  const p = room.game.s.players[playerId];
  if (!p || isBotId(room, playerId)) return;
  const nth = (room.dropCounts.get(playerId) || 0) + 1;
  room.dropCounts.set(playerId, nth);
  statBlips++;
  console.log(`${LOG} ${room.code}: ${p.name} потерял связь (обрыв №${nth} за партию), ждём ${OFFLINE_GRACE_MS} мс`);
  const t = setTimeout(() => {
    room.offlineTimers.delete(playerId);
    if (!rooms.has(room.code)) return;
    if ([...room.sockets].some((c) => c.playerId === playerId)) return;
    statDrops++;
    console.log(`${LOG} ${room.code}: ${p.name} не вернулся — offline`);
    // исключение в таймере непойманное — уронило бы процесс со всеми комнатами
    try {
      const pl = room.game.s.players[playerId];
      if (pl) presence.setOnline(pl, false, now());
      afterChange(room, [{ type: "offline", playerId }, ...earlyLock(room)]);
    } catch (err) {
      console.error(`${LOG} офлайн-таймер упал:`, err);
    }
  }, OFFLINE_GRACE_MS);
  if (t.unref) t.unref();
  room.offlineTimers.set(playerId, t);
}

// Окно ставок закрывается досрочно, когда сдали все живые онлайн-игроки. game.submit проверяет это сам,
// но если последний несдавший ушёл офлайн/был убран — повода позвать submit нет, проверяем здесь.
function earlyLock(room) {
  const g = room.game;
  if (g.s.phase !== "bets") return [];
  const alive = g.alive().filter((p) => p.online);
  if (alive.length && alive.every((p) => p.submitted)) return g.lock(clock(room));
  return [];
}

function noteClosed(room, client) {
  const id = client.playerId;
  if (!id) return;
  if ([...room.sockets].some((c) => c !== client && c.playerId === id)) return;
  room.closedAt.set(id, now());
}

const isBotId = (room, id) => room.bots.some((b) => b.playerId === id);

/*
 * Офлайн-призраки лобби (U-07, класс A). Место без связи старше GHOST_TTL_MS уходит; в игре и в итогах — никогда
 * (в итогах у мест есть фишки и место в таблице).
 */
function evictGhost(room) {
  const g = room.game;
  if (g.s.phase !== "lobby") return false;
  const id = presence.evictOldestGhost(playersOf(room), { now: now(), minAgeMs: GHOST_TTL_MS, stage: "lobby", protect: (pid) => isBotId(room, pid), protectEarned: false });
  if (!id) return false;
  for (const c of room.sockets) if (c.playerId === id) c.playerId = null;
  g.removePlayer(id);
  pruneTokens(room);
  return true;
}

function sweepGhosts(room) {
  const g = room.game;
  if (g.s.phase !== "lobby") return;
  const ids = presence.ghostsToDrop({ players: playersOf(room), now: now(), stage: "lobby", ttlMs: GHOST_TTL_MS, protect: (pid) => isBotId(room, pid), protectEarned: false });
  if (!ids.length) return;
  const events = [];
  for (const id of ids) events.push(...g.removePlayer(id));
  pruneTokens(room);
  for (const id of ids) room.closedAt.delete(id);
  afterChange(room, events);
}

function cancelOffline(room, playerId) {
  const t = room.offlineTimers.get(playerId);
  if (!t) return;
  clearTimeout(t);
  room.offlineTimers.delete(playerId);
  statBack++;
}

// ---------- живые события ----------

function cancelLive(room) {
  room.liveToken = null;
  const h = room.liveHandle;
  room.liveHandle = null;
  if (h && typeof h.cancel === "function") { try { h.cancel(); } catch {} }
}

// Окно реального события закрылось: просим feed.js собрать данные и принести исход
function startLive(room) {
  const g = room.game, ev = g.s.ev;
  if (!ev || !ev.live || ev.hasOutcome) return;
  cancelLive(room);
  ev.liveState = {};
  if (!feed) return; // источника нет (рестарт с другим BETS_LIVE): тик по liveDeadline вернёт ставки
  const token = {};
  room.liveToken = token;
  const same = () => room.liveToken === token && rooms.has(room.code);
  try {
    const handle = feed.begin(ev.type, {
      closeAt: now(),
      deadline: ev.liveDeadline,
      log: (m) => console.log(`${LOG} ${room.code} ${ev.type}: ${m}`),
      onLive: (data) => {
        if (!same() || !data || typeof data !== "object") return;
        const key = data.kind + (data.side ? ":" + data.side : "");
        if (g.s.ev) { g.s.ev.liveState = g.s.ev.liveState || {}; g.s.ev.liveState[key] = data; }
        const msg = JSON.stringify({ type: "live", seq: ++room.liveSeq, data });
        for (const c of room.sockets) if (c.ws.readyState === 1) c.ws.send(msg);
      },
      onResolve: (outcome, voids) => {
        if (!same()) return;
        room.liveToken = null;
        try { afterChange(room, g.resolveLive(outcome, clock(room), Array.isArray(voids) ? voids : [])); } catch (err) { console.error(`${LOG} onResolve упал:`, err); }
      },
      onAbort: () => {
        if (!same()) return;
        room.liveToken = null;
        const e = g.s.ev;
        if (e && e.live && !e.hasOutcome && (g.s.phase === "locked" || g.s.phase === "scene")) {
          console.log(`${LOG} ${room.code}: источник ${e.type} пропал — ставки возвращены`);
          try { afterChange(room, g.voidAllAndSettle(clock(room))); } catch (err) { console.error(`${LOG} onAbort упал:`, err); }
        }
      },
    });
    if (room.liveToken === token) room.liveHandle = handle || null;
  } catch (err) {
    console.error(`${LOG} feed.begin(${ev.type}) упал — ставки возвращены:`, err);
    room.liveToken = null;
    if (g.s.ev && !g.s.ev.hasOutcome && (g.s.phase === "locked" || g.s.phase === "scene")) g.voidAllAndSettle(clock(room));
  }
}

// События движка, на которые сервер реагирует сам (живой источник), до рассылки
function reactToEvents(room, events) {
  const out = events.slice();
  for (const e of events) {
    if (e.type === "event" || e.type === "done" || e.type === "settle") cancelLive(room);
    if (e.type === "lock") startLive(room);
  }
  // startLive мог сразу вернуть ставки (feed.begin упал): ничего больше не делаем, состояние уже обновлено
  return out;
}

function afterChange(room, events = [], only) {
  room.touched = now();
  events = reactToEvents(room, events);
  broadcastState(room, only);
  for (const e of events) if (e.type !== "draft") broadcastEvent(room, e);
  schedule(room);
}

/*
 * Снимки: доске — полный (исход с запирания), телефонам — свой (чужие черновики скрыты, исход с развязки).
 * Собираем по одному разу на вид, а не на каждый сокет. liveState (последнее значение каждого вида живых данных)
 * движок в снимок не кладёт — дописываем здесь.
 */
function snapshotFor(room, c) {
  const t = clock(room);
  const st = room.game.snapshot(t, c.host || c.wasHost ? undefined : c.playerId || null);
  const ev = room.game.s.ev;
  if (st.ev && ev && ev.liveState && Object.keys(ev.liveState).length) st.ev.liveState = ev.liveState;
  return st;
}

function stateFor(room, c, cache) {
  const key = c.host || c.wasHost ? "\0board" : c.playerId || "";
  if (!cache[key]) cache[key] = JSON.stringify({ type: "state", state: snapshotFor(room, c) });
  return cache[key];
}

// only — id игрока, чей черновик поменялся: остальным снимок не меняется (черновик скрыт), шлём только ему
function broadcastState(room, only) {
  const cache = {};
  for (const c of room.sockets) {
    if (c.ws.readyState !== 1) continue;
    if (only && c.playerId !== only) continue;
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

const sendToBoards = (room, msg) => {
  const data = JSON.stringify(msg);
  for (const c of room.sockets) if (c.host && c.ws.readyState === 1) c.ws.send(data);
};

function sendHello(room, c) {
  const hello = { type: "hello", code: room.code, state: snapshotFor(room, c), limits: { name: NAME_MAX, chat: CHAT_MAX } };
  if (MP_OFF) hello.mp = false;
  send(c.ws, hello);
}

// ---------- боты (только разработка) ----------

function addBots(room, n) {
  const g = room.game;
  for (let i = 0; i < n && g.s.order.length < MAX_PLAYERS; i++) {
    const strategy = STRATEGIES[(room.bots.length) % STRATEGIES.length];
    const id = "bot_" + crypto.randomBytes(4).toString("hex");
    const evs = g.addPlayer(id, `🤖 ${strategy} ${room.bots.length + 1}`);
    if (evs.length) room.bots.push({ playerId: id, strategy, mem: {} });
  }
  if (!room.botTimer) {
    room.botTimer = setInterval(() => {
      const s = room.game.s;
      if (s.phase !== "bets") return;
      if (room.botEv === s.ev.n) return; // каждый бот ставит один раз за событие, с небольшой задержкой
      room.botEv = s.ev.n;
      for (const b of room.bots) {
        const delay = (500 + rnd(2500)) / room.speed;
        const h = setTimeout(() => {
          room.botTimeouts.delete(h);
          try { botPlay(room, b, s.ev.n); } catch (err) { console.error(`${LOG} бот упал:`, err); }
        }, delay);
        room.botTimeouts.add(h);
      }
    }, 250 / Math.max(1, room.speed));
  }
}

function botPlay(room, b, evN) {
  const g = room.game;
  const p = g.s.players[b.playerId];
  if (!p || !p.alive || g.s.phase !== "bets" || !g.s.ev || g.s.ev.n !== evN || p.submitted) return;
  const plan = decide(b.strategy, { game: g, player: p, mem: b.mem, rnd });
  const ev = [];
  if (plan === null) return; // «спящий» бот не сдаёт купон — получает штраф
  for (const [marketId, stake] of plan) ev.push(...g.bet(p.id, marketId, stake));
  ev.push(...g.submit(p.id, clock(room)));
  afterChange(room, ev);
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
    // Только объект: тело `null` превращало `body.sid` в TypeError в async-обработчике (см. roulette)
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
  noteClosed(room, client);
  pollClients.delete(sid);
  if (client.ws.waiter) { const w = client.ws.waiter; client.ws.waiter = null; w(); }
  scheduleOffline(room, client.playerId);
}

const isAnon = (c) => !c.playerId && !c.host && !c.wasHost;
const isFreeAnon = (c) => isAnon(c) && !seats.isPending(c);
function anonCount(room, ip) {
  let n = 0;
  for (const c of room.sockets) if (isFreeAnon(c) && (ip === undefined || c.ip === ip)) n++;
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
  if (url.pathname === "/bets/api/session") {
    const room = roomFor(req, url);
    if (!room) return json(404, { error: "no such room" });
    const ip = clientIp(req);
    if (!roomHasSpace(room, ip)) return json(503, { error: "busy" });
    const client = openPoll(room, { ip });
    const first = client.ws.queue.splice(0);
    return json(200, { sid: client.sid, messages: first.map((d) => JSON.parse(d)) });
  }
  if (url.pathname === "/bets/api/poll") {
    const client = pollClients.get(String(url.searchParams.get("sid") || ""));
    if (!client) return json(410, { error: "session gone" });
    if (!rateOk(client)) return json(429, { error: "slow down" });
    client.lastSeen = now();
    // один висящий запрос на сессию: новый закрывает прежний
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
  if (url.pathname === "/bets/api/msg" && req.method === "POST") {
    const body = await readJson(req);
    const client = pollClients.get(String(body.sid || ""));
    if (!client) return json(410, { error: "session gone" });
    if (!rateOk(client)) return json(429, { error: "slow down" });
    try { handle(client.room, client, body.msg || {}); } catch (err) { send(client.ws, { type: "error", error: err.message }); }
    return json(200, { ok: true });
  }
  if (url.pathname === "/bets/api/health") {
    const out = { ok: true, rooms: rooms.size };
    if (url.searchParams.get("full") === "1") out.live = feed && typeof feed.status === "function" ? feed.status() : null;
    return json(200, out);
  }
  if (url.pathname === "/bets/api/rooms" && req.method === "POST") {
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
  // кривой адрес — new URL бросает, а исключение в обработчике upgrade непойманное и роняет процесс
  try { url = new URL(req.url, "http://x"); } catch { return socket.destroy(); }
  if (url.pathname !== "/bets/ws") return socket.destroy();
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
  // Без обработчика ошибка сокета (например, сообщение больше maxPayload) роняет процесс со всеми комнатами
  ws.on("error", (err) => {
    console.log(`${LOG} ${room.code}: ошибка сокета (${err.message}) — рвём`);
    try { ws.terminate(); } catch {}
  });
  ws.on("close", () => {
    room.sockets.delete(client);
    noteClosed(room, client);
    scheduleOffline(room, client.playerId);
  });
}

// Причина отказа ставки/купона: движок возвращает пустой список без объяснений
function whyNot(g, me, action, msg) {
  const s = g.s, p = s.players[me];
  if (!p) return "no_player";
  if (s.phase !== "bets") return "not_betting";
  if (!p.alive) return "out";
  if (p.submitted) return "submitted";
  if (action === "bet") {
    if (!Number.isInteger(msg.stake) || msg.stake < MIN_STAKE) return "bad_stake";
    if (!g.getMarket(String(msg.marketId || ""))) return "bad_market";
    if (g.draftTotal(p) + msg.stake > p.stack) return "no_money";
    return "too_many_bets";
  }
  return "rejected";
}

function cleanChat(raw) {
  const text = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return [...text].slice(0, CHAT_MAX).join("");
}

function handle(room, client, msg) {
  const g = room.game;
  const t = clock(room);
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") return send(client.ws, { type: "pong", t, c: typeof msg.c === "number" ? msg.c : undefined });
  room.touched = now();
  const reply = (obj) => send(client.ws, obj);
  const me = client.playerId && g.s.players[client.playerId] ? client.playerId : null;
  // ответ на действие игрока: отказ — только ему, успех — всем (или только ему, если меняется один черновик)
  const act = (action, events, why, only) => {
    if (!events.length) return reply({ type: "rejected", action, reason: why() });
    return afterChange(room, events, only);
  };

  switch (msg.type) {
    case "host": {
      if (msg.token !== room.hostToken) return reply({ type: "error", error: "bad host token" });
      // одна доска на комнату: прежняя становится зрителем и узнаёт об этом
      for (const c of room.sockets) if (c.host && c !== client) { c.host = false; c.wasHost = true; send(c.ws, { type: "host_lost" }); }
      client.host = true;
      client.wasHost = true;
      reply({ type: "host_ok" });
      // доске — полный снимок, с исходом. Именно state, а не hello: на hello доска шлёт host снова — получался бесконечный цикл host↔hello (мигание лобби и звук)
      send(client.ws, { type: "state", state: snapshotFor(room, client) });
      for (const m of room.chat) send(client.ws, { type: "chat", ...m, replay: true }); // лента для вновь подключённой доски
      return;
    }
    case "join": {
      if (me && !room.left.has(me)) return reply({ type: "joined", playerId: me, token: client.token, name: g.s.players[me].name, renamed: false, resumed: true });
      let playerId = msg.token && room.tokens[msg.token];
      if (playerId && (!g.s.players[playerId] || room.left.has(playerId))) {
        delete room.tokens[msg.token];
        if (!String(msg.name || "").trim()) return reply({ type: "error", error: "token_gone" });
        playerId = null;
      }
      if (msg.token && !playerId && !String(msg.name || "").trim()) return reply({ type: "error", error: "token_gone" });
      let joinName = null, renamed = false, resumed = !!playerId, viaName = false;
      let createName = null;
      const phase = g.s.phase;
      const inGame = phase !== "lobby" && phase !== "done";
      // Вход по имени (токена нет или он не найден): решение — lib/seats.decideJoin (подробности — roulette/server.js)
      if (!playerId) {
        const cleaned = names.cleanName(msg.name, NAME_MAX);
        if (!cleaned) return reply({ type: "error", error: "bad_name" });
        let decision = seats.decideJoin({
          players: playersOf(room).map((p) => ({ id: p.id, name: p.name, left: room.left.has(p.id) })),
          name: cleaned,
          token: null,
          phase,
          // в окне ставок черновики секретны: место по имени тогда не отдаём (вернуться можно по токену или после запирания)
          claimablePhases: ["lobby", "locked", "scene", "payout", "done"],
          graceMs: OFFLINE_GRACE_MS,
          now: now(),
          hasLiveSocket: (id) => isBotId(room, id) || [...room.sockets].some((c) => c.playerId === id && c.ws.readyState === 1),
          closedAt: (id) => (room.closedAt.has(id) ? room.closedAt.get(id) : null),
          caps: Array.isArray(msg.caps) ? msg.caps.filter((x) => typeof x === "string").slice(0, 8) : [],
          claim: msg.claim === true,
          fresh: msg.fresh === true,
          max: NAME_MAX,
        });
        if (decision.action === "deny") return reply({ type: "error", error: "bad_name" });
        // посреди партии без RULE_U01_CLAIM_IN_GAME подтверждения нет: офлайн-место возвращается тихо, как раньше
        if (decision.action === "prompt" && inGame && !RULE_U01_CLAIM_IN_GAME) {
          decision = { action: "claim", kind: decision.kind, player: decision.player, silent: true };
        }
        const place = decision.player ? g.s.players[decision.player.id] : null;
        if (decision.action === "prompt" || decision.action === "retry") {
          const mp = seats.markPending(client, { sockets: room.sockets, now: now(), ip: client.ip });
          if (!mp.ok) return reply({ type: "error", error: "name_taken", reason: mp.reason, retry: false, online: false });
          if (decision.action === "retry") {
            return reply({ type: "error", error: "name_claim", name: place ? place.name : cleaned, retry: true, retryInMs: decision.retryInMs });
          }
          return reply({ type: "error", error: "name_claim", name: place.name, summary: seats.claimSummary(place, ["stack"]) });
        }
        if (decision.action === "claim" && place) {
          playerId = place.id;
          resumed = true;
          viaName = true;
          joinName = place.name;
          const claimToken = crypto.randomBytes(12).toString("base64url");
          room.tokens[claimToken] = playerId;
          msg.token = claimToken;
        } else {
          // новое место возможно только в лобби: партия уже идёт — новых игроков не берём
          if (phase !== "lobby") return reply({ type: "error", error: decision.action === "taken" ? "name_taken" : "game_started" });
          createName = decision.name || decision.suggested || cleaned;
          renamed = decision.action === "taken" ? names.nameKey(createName) !== names.nameKey(cleaned) : !!decision.renamed;
        }
      }
      if (!playerId) {
        if (client.newPlayerAt && now() - client.newPlayerAt < 3000) return reply({ type: "error", error: "too_fast" });
        client.newPlayerAt = now();
        playerId = "u_" + crypto.randomBytes(5).toString("hex");
        if (g.s.order.length >= MAX_PLAYERS && !evictGhost(room)) return reply({ type: "error", error: "room_full" });
        if (!g.addPlayer(playerId, createName).length) return reply({ type: "error", error: "room_full" });
        const token = crypto.randomBytes(12).toString("base64url");
        room.tokens[token] = playerId;
        client.token = token;
        reply({ type: "joined", playerId, token, name: g.s.players[playerId].name, renamed, resumed: false });
      } else {
        client.token = msg.token;
        // у игрока один живой токен: иначе каждый подхват по имени добавлял токен
        for (const [tk, id] of Object.entries(room.tokens)) if (id === playerId && tk !== msg.token) delete room.tokens[tk];
        reply({ type: "joined", playerId, token: msg.token, name: joinName || g.s.players[playerId].name, renamed: false, resumed, viaName });
      }
      seats.clearPending(client);
      room.closedAt.delete(playerId);
      for (const c of room.sockets) if (c !== client && c.playerId === playerId) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      client.playerId = playerId;
      cancelOffline(room, playerId);
      presence.setOnline(g.s.players[playerId], true, now());
      const joinEvents = viaName ? [{ type: "rejoin", playerId }] : [];
      return afterChange(room, [{ type: "online", playerId }, ...joinEvents]);
    }
    case "leave": {
      if (!me) return;
      const events = g.removePlayer(me);
      if (g.s.phase !== "lobby") room.left.add(me);
      client.playerId = null;
      for (const [tk, id] of Object.entries(room.tokens)) if (id === me) delete room.tokens[tk];
      pruneTokens(room);
      return afterChange(room, [...events, ...earlyLock(room)]);
    }
    // ---- игрок ----
    case "bet": return me ? act("bet", g.bet(me, String(msg.marketId || ""), msg.stake), () => whyNot(g, me, "bet", msg), me) : undefined;
    case "unbet": return me ? act("unbet", g.unbet(me, String(msg.marketId || "")), () => whyNot(g, me, "unbet", msg), me) : undefined;
    case "clear": return me ? act("clear", g.clearBets(me), () => whyNot(g, me, "clear", msg), me) : undefined;
    case "submit": return me ? act("submit", g.submit(me, t), () => whyNot(g, me, "submit", msg)) : undefined;
    case "chat": {
      if (!me || g.s.settings.chat === false) return; // чат выключен — молчим
      const text = cleanChat(msg.text);
      if (!text) return;
      if (now() - (room.chatAt.get(me) || 0) < CHAT_GAP_MS) return reply({ type: "rejected", action: "chat", reason: "too_fast" });
      room.chatAt.set(me, now());
      const m = { id: ++room.chatSeq, playerId: me, name: g.s.players[me].name, text };
      room.chat.push(m);
      if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
      sendToBoards(room, { type: "chat", ...m });
      return;
    }
    case "react": {
      if (!me || g.s.settings.chat === false) return;
      const emoji = String(msg.emoji || "");
      if (!REACTIONS.includes(emoji)) return;
      if (now() - (room.reactAt.get(me) || 0) < REACT_GAP_MS) return;
      room.reactAt.set(me, now());
      // реакция — только сообщение доске, снимок не меняется
      sendToBoards(room, { type: "react", playerId: me, emoji });
      return;
    }
    // ---- ведущий (только доска) ----
    case "settings": {
      if (!client.host) return;
      const patch = msg.patch && typeof msg.patch === "object" && !Array.isArray(msg.patch) ? msg.patch : {};
      // посреди партии ведущий может только включить/выключить чат
      if (g.s.phase !== "lobby" && Object.keys(patch).some((k) => k !== "chat")) return reply({ type: "rejected", action: "settings", reason: "game_started" });
      g.setSettings(patch);
      if (typeof patch.chat === "boolean") g.s.settings.chat = patch.chat;
      return afterChange(room, []);
    }
    case "start": {
      if (!client.host) return;
      if (g.s.phase !== "lobby") return;
      if (g.s.order.length < 2) return reply({ type: "rejected", action: "start", reason: "need_players" });
      return afterChange(room, g.start(t));
    }
    case "end": return client.host ? afterChange(room, g.endNow(t)) : undefined;
    case "kick": {
      if (!client.host) return;
      const id = String(msg.playerId || "");
      if (!g.s.players[id]) return;
      const events = g.removePlayer(id);
      if (g.s.phase !== "lobby") room.left.add(id);
      for (const [tk, pid] of Object.entries(room.tokens)) if (pid === id) delete room.tokens[tk];
      pruneTokens(room);
      for (const c of room.sockets) if (c.playerId === id) { c.playerId = null; send(c.ws, { type: "kicked" }); }
      return afterChange(room, [...events, ...earlyLock(room)]);
    }
    case "next_game": {
      if (!client.host) return;
      if (g.s.phase !== "done") return reply({ type: "rejected", action: "next_game", reason: "not_done" });
      // офлайн без сокета и не бот не переходят в новую партию (U-07)
      const old = g.s;
      const humans = old.order.map((id) => old.players[id]).filter((p) => !isBotId(room, p.id));
      presence.pruneOfflineForNewGame(humans, { now: now(), graceMs: OFFLINE_GRACE_MS });
      const keep = old.order.map((id) => old.players[id]).filter((p) => !room.left.has(p.id) && !p.left);
      cancelLive(room);
      const ng = newGame();
      ng.s.settings = { ...old.settings };
      for (const p of keep) {
        ng.addPlayer(p.id, p.name);
        const np = ng.s.players[p.id];
        const online = isBotId(room, p.id) || [...room.sockets].some((c) => c.playerId === p.id);
        presence.setOnline(np, online, now());
      }
      room.game = ng;
      room.left = new Set();
      room.botEv = -1;
      for (const id of [...room.closedAt.keys()]) if (!ng.s.players[id]) room.closedAt.delete(id);
      for (const c of room.sockets) if (c.playerId && !ng.s.players[c.playerId]) c.playerId = null;
      pruneTokens(room);
      return afterChange(room, [{ type: "new_game" }]);
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
    if (room.sockets.size && ph !== "lobby" && ph !== "done") room.touched = now();
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
    const anon = isAnon(c) && t - c.opened > (seats.isPending(c) ? CLAIM_WAIT_MS : ANON_TTL_MS);
    if (idle || anon || t - c.lastSeen > 40000) closePoll(c.sid);
  }
  // анонимный WebSocket (не вошёл и не доска) не держит место в комнате дольше ANON_TTL_MS
  for (const room of rooms.values()) {
    for (const c of room.sockets) {
      if (c.poll || !isAnon(c) || !c.opened) continue;
      const over = seats.isPending(c) ? t - c.pendingClaimAt > CLAIM_WAIT_MS : t - c.opened > ANON_TTL_MS;
      if (over) { try { c.ws.terminate(); } catch {} }
    }
    try { sweepGhosts(room); } catch (err) { console.error(`${LOG} уборка призраков упала:`, err); }
  }
}, 2000).unref();

let dumpWasEmpty = false;
function dump() {
  try {
    const data = [...rooms.values()]
      .filter((r) => !r.bots.length)
      // чат в дамп не пишем: он живёт только в памяти комнаты; clockAt нужен, чтобы после рестарта сохранить остаток времени фазы
      .map((r) => ({ code: r.code, ip: r.ip, hostToken: r.hostToken, tokens: r.tokens, touched: r.touched, clockAt: clock(r), left: [...r.left], state: r.game.dump() }));
    if (!data.length && dumpWasEmpty) return;
    dumpWasEmpty = !data.length;
    fs.mkdirSync(path.dirname(DUMP), { recursive: true });
    fs.writeFileSync(DUMP + ".tmp", JSON.stringify(data), { mode: 0o600 }); // в дампе hostToken и токены игроков
    fs.renameSync(DUMP + ".tmp", DUMP);
  } catch (err) {
    console.warn(`${LOG} дамп не удался:`, err.message);
  }
}

/*
 * После перезапуска: сценическое событие доигрывается — исход и сид уже в дампе (выбраны при запирании), коэффициенты
 * пересобираются из ev.input, доска строит ту же сцену. Сроки сдвигаются так, чтобы остаток времени фазы сохранился
 * (время простоя не считается). Реальное событие, которое ждало исхода, возвращает все ставки: источник мы не видели.
 */
function restore() {
  try {
    if (!fs.existsSync(DUMP)) return;
    for (const r of JSON.parse(fs.readFileSync(DUMP, "utf8"))) {
      if (now() - r.touched > ROOM_TTL) continue;
      try {
        const room = newRoom({ code: r.code, ip: r.ip || "", hostToken: r.hostToken, game: newGame(r.state), tokens: r.tokens || {}, touched: r.touched, left: r.left || [] });
        const s = room.game.s;
        for (const p of Object.values(s.players)) p.online = false;
        presence.onRestore(Object.values(s.players), now());
        pruneTokens(room);
        const phase = s.phase;
        if (phase !== "lobby" && phase !== "done") {
          const shift = Number.isFinite(r.clockAt) ? now() - r.clockAt : 0;
          if (s.deadline) s.deadline += shift;
          if (s.ev && s.ev.revealAt) s.ev.revealAt += shift;
          if (s.ev && s.ev.liveDeadline) s.ev.liveDeadline += shift;
          // в окне ставок люди ещё не вернулись: оставляем им минимум времени
          if (phase === "bets") s.deadline = Math.max(s.deadline, now() + 8000);
          const ev = s.ev;
          if ((phase === "locked" || phase === "scene") && ev && ev.live && !ev.hasOutcome) {
            console.log(`${LOG} ${room.code}: рестарт во время реального события ${ev.type} — ставки возвращены`);
            room.game.voidAllAndSettle(clock(room));
          }
        }
        rooms.set(room.code, room);
        schedule(room);
      } catch (err) {
        console.warn(`${LOG} комната ${r && r.code} не восстановлена:`, err.message);
      }
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
  try { if (feed && typeof feed.stop === "function") feed.stop(); } catch {}
  for (const room of rooms.values()) {
    for (const c of room.sockets) { try { if (!c.poll) c.ws.close(1012, "restart"); } catch {} }
  }
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => console.log(`${LOG} порт ${PORT}${STATIC ? ", статика из " + STATIC : ""}${DEV ? ", режим разработки (боты)" : ""}${TIME_SCALE > 1 ? `, время ×${TIME_SCALE}` : ""}`));

module.exports = { rooms, handle, createRoom };
