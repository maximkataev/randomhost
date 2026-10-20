"use strict";

/*
 * Сервер «Блэкджека»: HTTP (создание комнаты, health, long-poll) + WebSocket (игра). docs/blackjack-spec.md §10,
 * контракт движка — docs/blackjack-protocol.md. Скелет — oneword/server.js (а туда — из crowd, wave, fibs, quip, bomb,
 * roulette и auction через общий lib/, см. docs/shared-lib.md): комнаты, токены, грация офлайна, лимиты, дамп,
 * poll-транспорт работают так же и по тем же причинам. Протокол входа и присутствия — docs/multiplayer-join-protocol.md.
 * Из roulette взяты боты режима разработки и снимки разной скрытности: доска знает закрытую карту дилера и сюжет
 * с начала фазы dealer, телефоны — только в последний revealAt, когда экран всё показал. Поэтому у каждого свой снимок,
 * а события с `secret: true` (сюжет, блэкджек дилера) уходят только доске.
 * Тайны сервера — закрытая карта и добор дилера, карты-пакости на руках, «Подгляд»: они живут в состоянии комнаты
 * и в дампе на диске; снимки для клиентов собирает game.snapshot(now, forPlayer), который чужого не отдаёт.
 * settings.solo движка сервер не трогает: соло живёт в браузере без комнаты (§9).
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 4100)
 * Разработка: NODE_ENV=development STATIC=.. node server.js — статика сайта с того же origin и боты (?bots=N при создании).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { WebSocketServer } = require("ws");
const { roomCode } = require("../lib/codes");
const { clientIp, createGuessLimiter, rateOk: netRateOk, send } = require("../lib/net");
const { Game, cleanName, nameKey, NAME_MAX, MAX_PLAYERS } = require("./game");
const names = require("../lib/names");
const seats = require("../lib/seats");
const presence = require("../lib/presence");
const bots = require("./bots");

const PORT = Number(process.env.PORT || 4100);
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
// Быстрый пинг только для комнат «в игре» (как в crowd/oneword): общий цикл SWEEP — 25 с × 3 промаха; в игре быстрее,
// иначе молчание посреди волны решений видно только через десятки секунд, а волна ждёт офлайн-игрока до таймера.
const PING_MS = Math.max(1000, Number(process.env.PING_MS || 8000));
const GAME_PONG_MISSES = Math.max(1, Number(process.env.GAME_PONG_MISSES || 2));
const GAME_DEAD_MS = Math.max(20000, Number(process.env.GAME_DEAD_MS || 20000));
const SEND_BUFFER_LIMIT = Number(process.env.SEND_BUFFER_LIMIT || 1048576);
const MSG_RATE = Number(process.env.MSG_RATE || 40);
// игровые команды (фишки, решения, карты) — отдельный лимит: каждая успешная рассылает снимки всем 13 экранам.
// Фишки кладут тапами, поэтому мягче, чем 5/с у oneword.
const CMD_RATE = Number(process.env.CMD_RATE || 8);
const MAX_ANON_PER_ROOM = Number(process.env.MAX_ANON_PER_ROOM || 30);
// телефон открывает сокет до ввода имени, а вся компания обычно за одним NAT: 10 не хватало на 11–12 игроков
const MAX_ANON_PER_IP = Number(process.env.MAX_ANON_PER_IP || 30);
const ANON_TTL_MS = Number(process.env.ANON_TTL_MS || 30000);
// ожидающий «Это ты?» сокет живёт CLAIM_WAIT_MS, а не ANON_TTL_MS (lib/seats)
const CLAIM_WAIT_MS = seats.CLAIM_WAIT_MS;
const CLAIM_GRACE_MS = Number(process.env.CLAIM_GRACE_MS || seats.CLAIM_GRACE_MS);
// офлайн-место в лобби/итогах живёт GHOST_TTL_MS (U-07); в игре — никогда
const GHOST_TTL_MS = presence.GHOST_TTL_MS;
// Посреди партии у места есть тайны: карты-пакости на руках и «Подгляд» (me.peekHole) — подхват по имени запрещён,
// иначе чужие карты достались бы тому, кто назвал имя. Вернуться можно только по токену (как в oneword).
const SECRET_PHASES = ["betting", "closing", "dealing", "insurance", "deciding", "dealer", "payout"];
const CLAIMABLE_PHASES = ["lobby", "finished"];
const MP_OFF = process.env.MP_OFF === "1";
const POLL_GAP_MS = Number(process.env.POLL_GAP_MS || 12000);
const MAX_MSG_BYTES = 8192;
const CHAT_MAX = 80;
const LOG = "[blackjack]";

// случайность — криптографическая: порядок шуза не должен угадываться по прошлым раздачам
const rnd = (n) => crypto.randomInt(n);

// ---------- комнаты ----------

const rooms = new Map(); // code → room

// Код комнаты — слово с двумя цифрами: читается вслух и не перебирается (см. guessBlocked)
const newCode = () => roomCode((c) => rooms.has(c));

// Перебор кодов: адрес, промахнувшийся GUESS_LIMIT раз за окно, до конца окна не получает ни одной комнаты
const { blocked: guessBlocked, missed: guessMissed } = createGuessLimiter(Number(process.env.GUESS_LIMIT || 60));
function roomFor(req, url) {
  const ip = clientIp(req);
  const code = (url.searchParams.get("r") || "").toUpperCase();
  const room = rooms.get(code);
  if (room) return !guessBlocked(ip) || room.knownIps.has(ip) ? room : null;
  if (!guessBlocked(ip)) guessMissed(ip);
  return null;
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
  room.bots = room.bots.filter((b) => ids.has(b.playerId));
}

function newRoom({ code, ip = "", hostToken, game, tokens = {}, touched = Date.now(), speed = 1 }) {
  return {
    code, ip, hostToken, game, tokens,
    knownIps: new Set(ip ? [ip] : []),
    sockets: new Set(), // {ws, playerId?, host?}
    offlineTimers: new Map(),
    closedAt: new Map(), // playerId → когда закрылся последний сокет места (для graceMs подхвата по имени)
    timer: null,
    touched,
    speed,
    skew: 0,
    bots: [], // {playerId, strategy} — только разработка
    botTimer: null,
    botMark: "", // что боты уже сделали: фаза+раздача, чтобы не ставить дважды
  };
}

function createRoom({ settings = {}, speed = 1, ip = "", bots: nBots = 0 } = {}) {
  if (ip) {
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    if (mine >= MAX_ROOMS_PER_IP && !evictOldestEmpty(ip)) throw new Error("too many rooms from this address");
  }
  if (rooms.size >= MAX_ROOMS && !evictOldestEmpty()) throw new Error("too many rooms");
  const code = newCode();
  // соло — только в браузере (§9): комната с settings.solo превращала бы стол на двоих в стол на одного
  const clean = Object.assign({}, settings && typeof settings === "object" ? settings : {}, { solo: false });
  const room = newRoom({
    code,
    ip,
    hostToken: crypto.randomBytes(12).toString("base64url"),
    game: Game.create({ settings: clean, code, rnd }),
    speed: DEV ? Math.max(1, Math.min(20, Number(speed) || 1)) : 1,
  });
  rooms.set(room.code, room);
  if (DEV && nBots > 0) addBots(room, Math.min(MAX_PLAYERS, Number(nBots) || 0));
  return room;
}

function notifyRate(client, action) {
  const t = now();
  if (client.rn && t - client.rn < 700) return;
  client.rn = t;
  send(client.ws, { type: "rejected", action, reason: "rate" });
}

function cmdOk(client) {
  const t = now();
  if (!client.cl || t - client.cl.ts >= 1000) client.cl = { ts: t, n: 0 };
  return ++client.cl.n <= CMD_RATE;
}

const rateOk = (client) => netRateOk(client, MSG_RATE);

const now = () => Date.now();
// Часы комнаты: при speed > 1 (только разработка) таймер просыпается раньше и комната «догоняет» срок (как в roulette)
const clock = (room) => now() + (room.skew || 0);

// Тик — к ближайшему сроку движка (s.deadline): закрытие ставок, конец волны, последний revealAt дилера, выплаты.
// На паузе и в лобби/итогах срока нет — таймер не ставим.
function schedule(room) {
  clearTimeout(room.timer);
  const s = room.game.s;
  if (s.paused || s.deadline == null) return;
  const wait = Math.max(0, (s.deadline - clock(room)) / room.speed);
  room.timer = setTimeout(() => {
    try {
      const at = room.game.s.deadline;
      if (at != null) room.skew += Math.max(0, at - clock(room));
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
  statBlips++;
  console.log(`${LOG} ${room.code}: ${name} потерял связь, ждём ${grace} мс`);
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

// последний сокет места закрылся — запоминаем когда: подхват по имени ждёт грацию (lib/seats «pending»)
function noteClosed(room, client) {
  const id = client.playerId;
  if (!id) return;
  if ([...room.sockets].some((c) => c !== client && c.playerId === id)) return;
  room.closedAt.set(id, now());
}

const isBotId = (room, id) => room.bots.some((b) => b.playerId === id);

/*
 * Офлайн-призраки лобби и итогов (U-07, класс A). Место без связи старше GHOST_TTL_MS уходит; в игре — никогда.
 * В итогах трогаем только зрителей: у бывших игроков там место и стек партии.
 */
function ghostProtect(room) {
  const ph = room.game.s.phase;
  return (id) => isBotId(room, id) || (ph === "finished" && !(room.game.player(id) || {}).spectator);
}

function evictGhost(room) {
  const g = room.game;
  const ph = g.s.phase;
  if (ph !== "lobby" && ph !== "finished") return false;
  const id = presence.evictOldestGhost(g.s.players, { now: now(), minAgeMs: GHOST_TTL_MS, stage: ph, protect: ghostProtect(room), protectEarned: false });
  if (!id) return false;
  for (const c of room.sockets) if (c.playerId === id) c.playerId = null;
  g.removePlayer(id, clock(room));
  pruneTokens(room);
  return true;
}

function sweepGhosts(room) {
  const g = room.game;
  const ph = g.s.phase;
  if (ph !== "lobby" && ph !== "finished") return;
  const ids = presence.ghostsToDrop({ players: g.s.players, now: now(), stage: ph, ttlMs: GHOST_TTL_MS, protect: ghostProtect(room), protectEarned: false });
  if (!ids.length) return;
  const events = [];
  for (const id of ids) events.push(...g.removePlayer(id, clock(room)));
  pruneTokens(room);
  for (const id of ids) room.closedAt.delete(id);
  afterChange(room, events);
}

function afterChange(room, events = []) {
  room.touched = now();
  broadcastState(room);
  for (const e of events) broadcastEvent(room, e);
  schedule(room);
}

/*
 * Снимки: доске — полный (закрытая карта, добор и сюжет с начала фазы dealer), телефонам — свой: чужие карты-пакости
 * числом, закрытая карта дилера только владельцу «Подгляда», итог — в последний revealAt. Собираем по одному разу на вид.
 */
function stateFor(room, c, cache) {
  const t = clock(room);
  if (c.host || c.wasHost) return cache.board || (cache.board = JSON.stringify({ type: "state", state: room.game.snapshot(t, "board") }));
  // сокет без места — «anon», не null: null в snapshot означает доску, и аноним посреди хода дилера увидел бы закрытую карту
  const key = c.playerId || "anon";
  if (!cache[key]) cache[key] = JSON.stringify({ type: "state", state: room.game.snapshot(t, key) });
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

// события с secret (сюжет дилера, его блэкджек) — только доске: телефон узнаёт итог из снимка в последний revealAt
function broadcastEvent(room, e) {
  const data = JSON.stringify({ type: "event", event: e });
  for (const c of room.sockets) if (c.ws.readyState === 1 && (!e.secret || c.host || c.wasHost)) c.ws.send(data);
}

function sendHello(room, c) {
  const hello = { type: "hello", code: room.code, state: room.game.snapshot(clock(room), c.host ? "board" : c.playerId || "anon"), limits: { name: NAME_MAX, chat: CHAT_MAX } };
  if (MP_OFF) hello.mp = false;
  send(c.ws, hello);
}

// ---------- боты (только разработка) ----------

/*
 * Боты из bots.js играют по своим стратегиям: ставят через пару секунд после начала ставок (с картой-пакостью, если есть),
 * отвечают на страховку, решают по каждой руке в каждой волне. В дамп комнаты с ботами не идут.
 */
function addBots(room, n) {
  const g = room.game;
  for (let i = 0; i < n && g.s.players.filter((p) => !p.left && !p.spectator).length < MAX_PLAYERS; i++) {
    const strategy = bots.STRATEGIES[room.bots.length % bots.STRATEGIES.length];
    const id = "bot_" + crypto.randomBytes(4).toString("hex");
    const r = g.addPlayer({ id, name: `🤖 ${strategy} ${room.bots.length + 1}` });
    if (r.ok) room.bots.push({ playerId: id, strategy });
  }
  if (!room.botTimer) {
    room.botTimer = setInterval(() => {
      try { botsAct(room); } catch (err) { console.error(`${LOG} боты упали:`, err); }
    }, 2000 / room.speed);
    if (room.botTimer.unref) room.botTimer.unref();
  }
}

function botsAct(room) {
  const g = room.game;
  const s = g.s;
  const t = clock(room);
  const ev = [];
  let changed = false;
  if (s.phase === "betting" && !s.paused) {
    const mark = "bet:" + s.game + ":" + s.hand;
    if (room.botMark === mark) return;
    room.botMark = mark;
    for (const b of room.bots) {
      const p = g.player(b.playerId);
      if (!p || p.out || p.left || s.phase !== "betting") continue;
      const bet = bots.decideBet(b.strategy, { game: g, player: p, rnd });
      const r = bet.allIn ? g.allIn(p.id) : g.setBets(p.id, bet);
      if (r.ok) { changed = true; ev.push(...(r.events || [])); }
      if (s.settings.cards) {
        const c = bots.playCard(b.strategy, { game: g, player: p, rnd });
        if (c) { const rc = g.playCard(p.id, c.card, c.target); if (rc.ok) ev.push(...rc.events); }
      }
      const rr = g.ready(p.id, true, t);
      if (rr.ok) { changed = true; ev.push(...rr.events); }
    }
  } else if (s.phase === "insurance" && s.dealer && s.dealer.insurance) {
    for (const b of room.bots) {
      const p = g.player(b.playerId);
      if (!p || !p.inHand || p.insDecided || s.phase !== "insurance") continue;
      const r = g.insure(p.id, bots.decideInsurance(b.strategy, { player: p }), t);
      if (r.ok) { changed = true; ev.push(...r.events); }
    }
  } else if (s.phase === "deciding") {
    for (const b of room.bots) {
      const p = g.player(b.playerId);
      if (!p || !p.inHand || s.phase !== "deciding") continue;
      for (let i = 0; i < p.hands.length && s.phase === "deciding"; i++) {
        const h = p.hands[i];
        if (h.done || h.decision) continue;
        const action = bots.decideAction(b.strategy, { hand: h, up: s.dealer.cards[0], options: g.options(p, h) });
        const r = g.decide(p.id, i, action, t);
        if (r.ok) { changed = true; ev.push(...r.events); }
      }
    }
  }
  if (changed) afterChange(room, ev);
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".woff2": "font/woff2" };

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400); return res.end(); }
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
  noteClosed(room, client);
  scheduleOffline(room, client.playerId);
}

const isAnon = (c) => !c.playerId && !c.host && !c.wasHost;
// ждущий «Это ты?» сокет — не «пустой» аноним: его не вытесняет ANON_TTL_MS и не считает MAX_ANON (у него потолки lib/seats)
const isFreeAnon = (c) => isAnon(c) && !seats.isPending(c);
function anonExpired(c, t) {
  if (!isAnon(c)) return false;
  if (seats.isPending(c)) return t - c.pendingClaimAt > CLAIM_WAIT_MS;
  return !!c.opened && t - c.opened > ANON_TTL_MS;
}
function anonCount(room, ip) {
  let n = 0;
  for (const c of room.sockets) if (isFreeAnon(c) && (ip === undefined || c.ip === ip)) n++;
  return n;
}
function evictAnon(room, ip) {
  let victim = null;
  for (const c of room.sockets) if (isFreeAnon(c) && (ip === undefined || c.ip === ip) && (!victim || (c.opened || 0) < (victim.opened || 0))) victim = c;
  if (!victim) return false;
  room.sockets.delete(victim);
  if (victim.poll) closePoll(victim.sid);
  else { try { victim.ws.terminate(); } catch {} }
  return true;
}
function authedQuery(room, url) {
  const h = url.searchParams.get("h"), t = url.searchParams.get("t");
  return !!((h && h === room.hostToken) || (t && room.tokens[t]));
}
function roomHasSpace(room, ip, authed = false) {
  if (room.sockets.size >= MAX_SOCKETS_PER_ROOM || totalSockets() >= MAX_TOTAL_SOCKETS) return false;
  if (ip && socketsFrom(ip) >= MAX_SOCKETS_PER_IP) return false;
  if (authed) return true;
  if (anonCount(room) >= MAX_ANON_PER_ROOM && !(ip && evictAnon(room, ip)) && !evictAnon(room)) return false;
  if (ip && anonCount(room, ip) >= MAX_ANON_PER_IP && !evictAnon(room, ip)) return false;
  return true;
}
function noteKnown(room, ip) {
  if (ip && room.knownIps.size < 64) room.knownIps.add(ip);
}

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/blackjack/api/session") {
    const room = roomFor(req, url);
    if (!room) return json(404, { error: "no such room" });
    const ip = clientIp(req);
    if (!roomHasSpace(room, ip, authedQuery(room, url))) return json(503, { error: "busy" });
    noteKnown(room, ip);
    const client = openPoll(room, { ip });
    const first = client.ws.queue.splice(0);
    return json(200, { sid: client.sid, messages: first.map((d) => JSON.parse(d)) });
  }
  if (url.pathname === "/blackjack/api/poll") {
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
  if (url.pathname === "/blackjack/api/msg" && req.method === "POST") {
    const body = await readJson(req);
    const client = pollClients.get(String(body.sid || ""));
    if (!client) return json(410, { error: "session gone" });
    if (!rateOk(client)) return json(429, { error: "slow down" });
    try { handle(client.room, client, body.msg || {}); } catch (err) { send(client.ws, { type: "error", error: err.message }); }
    return json(200, { ok: true });
  }
  if (url.pathname === "/blackjack/api/health") return json(200, { ok: true, rooms: rooms.size });
  if (url.pathname === "/blackjack/api/rooms" && req.method === "POST") {
    const body = await readJson(req);
    try {
      const room = createRoom({ settings: body.settings, speed: body.speed, ip: clientIp(req), bots: DEV ? Number(url.searchParams.get("bots") || body.bots || 0) : 0 });
      return json(200, { code: room.code, hostToken: room.hostToken });
    } catch (err) {
      if (/^too many rooms/.test(err.message)) return json(400, { error: err.message });
      console.error(`${LOG} создание комнаты не удалось:`, err);
      return json(400, { error: "bad request" });
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
  // кривой адрес («//%5B/../blackjack/ws» nginx нормализует и пропускает как есть) — new URL бросает,
  // а исключение в обработчике upgrade непойманное и роняет процесс со всеми комнатами
  try { url = new URL(req.url, "http://x"); } catch { return socket.destroy(); }
  if (url.pathname !== "/blackjack/ws") return socket.destroy();
  const room = roomFor(req, url);
  if (!room) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  const ip = clientIp(req);
  if (!roomHasSpace(room, ip, authedQuery(room, url))) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return socket.destroy();
  }
  noteKnown(room, ip);
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(room, ws, { ip }));
});

function onConnection(room, ws, opts = {}) {
  const client = { ws, playerId: null, host: false, misses: 0, gameMisses: 0, alive: now(), ip: opts.ip || "", opened: now() };
  room.sockets.add(client);
  ws.on("pong", () => { client.misses = 0; client.gameMisses = 0; client.alive = now(); });
  sendHello(room, client);
  ws.on("message", (raw) => {
    client.alive = now();
    client.gameMisses = 0;
    if (!rateOk(client)) return notifyRate(client, "flood");
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(room, client, msg); } catch (err) { send(ws, { type: "error", error: err.message }); }
  });
  // Без обработчика ошибка сокета (например, сообщение больше maxPayload) становится непойманной
  // и роняет процесс со всеми комнатами (хотфикс abfc991). Рвём только этот сокет — close ниже уберёт его из комнаты.
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

function handle(room, client, msg) {
  const g = room.game;
  const t = clock(room);
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") return send(client.ws, { type: "pong", t, c: typeof msg.c === "number" ? msg.c : undefined });
  room.touched = now();
  const reply = (obj) => send(client.ws, obj);
  const notHost = (action) => reply({ type: "rejected", action, reason: "not_host" });
  const me = client.playerId;
  // срок мог наступить, пока сокет молчал: сначала двигаем фазу, потом применяем действие
  const due = g.tick(t);
  if (due.length) afterChange(room, due);
  // ответ на действие игрока: отказ — только ему, успех — всем
  const act = (action, r) => {
    if (!r.ok) return reply({ type: "rejected", action, reason: r.reason });
    return afterChange(room, r.events || []);
  };
  // игровая команда: только от вошедшего и не чаще CMD_RATE
  const cmd = (action, fn) => {
    if (!me) return reply({ type: "rejected", action, reason: "not_player" });
    if (!cmdOk(client)) return notifyRate(client, action);
    return act(action, fn());
  };

  switch (msg.type) {
    case "host": {
      if (msg.token !== room.hostToken) return reply({ type: "error", error: "bad host token" });
      // одна доска на комнату: прежняя становится зрителем и узнаёт об этом
      for (const c of room.sockets) if (c.host && c !== client) { c.host = false; c.wasHost = true; send(c.ws, { type: "host_lost" }); }
      client.host = true;
      client.wasHost = true;
      reply({ type: "host_ok" });
      return sendHello(room, client); // доске — полный снимок
    }
    case "join": {
      if (me && g.player(me) && !g.player(me).left) return reply({ type: "joined", playerId: me, token: client.token, name: g.player(me).name, renamed: false, resumed: true });
      let playerId = msg.token && room.tokens[msg.token];
      if (playerId && !g.player(playerId)) {
        delete room.tokens[msg.token];
        if (!String(msg.name || "").trim()) return reply({ type: "error", error: "token_gone" });
        playerId = null;
      }
      if (msg.token && !playerId && !String(msg.name || "").trim()) return reply({ type: "error", error: "token_gone" });
      // покинувшее место (leave/kick посреди партии) по токену не возвращается: фишки сгорели, вход заново — зрителем
      if (playerId && g.player(playerId)?.left) playerId = null;
      let joinName = null, renamed = false, resumed = !!playerId, viaName = false;
      let createName = null;
      // Вход по имени (токена нет или он не найден): решение — lib/seats.decideJoin. Офлайн-место в лобби/итогах —
      // «Это ты?»; посреди партии — name_taken{secret}: у места карты-пакости и «Подгляд».
      if (!playerId) {
        const cleaned = cleanName(msg.name);
        if (!cleaned) return reply({ type: "error", error: "bad_name" });
        const phase = g.s.phase;
        const inGame = phase !== "lobby" && phase !== "finished";
        const tkReply = (d) => reply({ type: "error", error: "name_taken", reason: d.reason, retry: !!d.retry, online: !!d.online });
        let decision = seats.decideJoin({
          players: g.s.players.map((p) => ({ id: p.id, name: nameKey(p.name), left: p.left })),
          name: nameKey(cleaned),
          token: null,
          phase,
          claimablePhases: CLAIMABLE_PHASES,
          secretPhases: SECRET_PHASES,
          graceMs: CLAIM_GRACE_MS,
          now: now(),
          // бот числится онлайн без сокета: имя «🤖 …» занять по имени нельзя
          hasLiveSocket: (id) => isBotId(room, id) || [...room.sockets].some((c) => c.playerId === id && c.ws.readyState === 1),
          isStale: (id) => { const cs = [...room.sockets].filter((c) => c.playerId === id); return cs.length > 0 && cs.every((c) => (c.misses || 0) >= 2); },
          closedAt: (id) => (room.closedAt.has(id) ? room.closedAt.get(id) : null),
          caps: Array.isArray(msg.caps) ? msg.caps.filter((x) => typeof x === "string").slice(0, 8) : [],
          claim: msg.claim === true,
          fresh: msg.fresh === true,
          max: NAME_MAX,
        });
        if (decision.action === "deny") return reply({ type: "error", error: "bad_name" });
        const place = decision.player ? g.player(decision.player.id) : null;
        if (decision.action === "taken") {
          if (inGame) return tkReply(decision);
          decision = { action: "create", kind: decision.kind };
        }
        if (decision.action === "prompt" || decision.action === "retry") {
          const mp = seats.markPending(client, { sockets: room.sockets, now: now(), ip: client.ip });
          if (!mp.ok) return tkReply({ reason: mp.reason, retry: false });
          if (decision.action === "retry") {
            return reply({ type: "error", error: "name_claim", name: place ? place.name : cleaned, retry: true, retryInMs: decision.retryInMs });
          }
          return reply({ type: "error", error: "name_claim", name: place.name, summary: seats.claimSummary(place, ["stack", "color"]) });
        }
        if (decision.action === "claim" && place) {
          playerId = place.id;
          resumed = true;
          viaName = true;
          joinName = place.name;
          const claimToken = crypto.randomBytes(12).toString("base64url");
          room.tokens[claimToken] = playerId;
          msg.token = claimToken;
          revokeOtherTokens(room, playerId, claimToken);
        } else {
          // новое место: у «Маши» при живой «Маше» — «Маша 2», о чём игрок узнает из joined.renamed
          const takenKeys = new Set(g.s.players.filter((p) => !p.left).map((p) => nameKey(p.name)));
          createName = names.nextFreeName(cleaned, (k) => takenKeys.has(nameKey(k)), NAME_MAX) || cleaned;
          if (inGame && nameKey(createName) !== nameKey(cleaned)) return reply({ type: "error", error: "name_taken", reason: "phase", retry: false, online: false });
          renamed = nameKey(createName) !== nameKey(cleaned);
        }
      }
      if (!playerId) {
        if (client.newPlayerAt && now() - client.newPlayerAt < 3000) return reply({ type: "rejected", action: "join", reason: "rate" });
        playerId = "u_" + crypto.randomBytes(5).toString("hex");
        let r = g.addPlayer({ id: playerId, name: createName });
        // лобби/итоги заполнены: место освобождает самый давний офлайн старше GHOST_TTL_MS (U-07), в игре — никогда
        if (!r.ok && r.reason === "room_full" && evictGhost(room)) r = g.addPlayer({ id: playerId, name: createName });
        if (!r.ok) return reply({ type: "error", error: r.reason });
        client.newPlayerAt = now();
        const token = crypto.randomBytes(12).toString("base64url");
        room.tokens[token] = playerId;
        client.token = token;
        reply({ type: "joined", playerId, token, name: r.player.name, renamed, resumed: false, spectator: !!r.player.spectator });
      } else {
        client.token = msg.token;
        // у игрока один живой токен: иначе каждый подхват по имени добавлял токен, а выбитый вход возвращался по старому
        revokeOtherTokens(room, playerId, msg.token);
        reply({ type: "joined", playerId, token: msg.token, name: joinName || g.player(playerId).name, renamed: false, resumed, viaName });
      }
      seats.clearPending(client);
      room.closedAt.delete(playerId);
      for (const c of room.sockets) if (c !== client && c.playerId === playerId) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      client.playerId = playerId;
      cancelOffline(room, playerId);
      const joinEvents = viaName ? [{ type: "rejoin", playerId }] : [];
      return afterChange(room, [{ type: "online", playerId }, ...joinEvents, ...g.setOnline(playerId, true, t)]);
    }
    case "leave": {
      if (!me) return;
      const events = g.removePlayer(me, t);
      client.playerId = null;
      pruneTokens(room);
      return afterChange(room, events);
    }
    // ---- игрок (docs/blackjack-protocol.md §2) ----
    case "bet": return cmd("bet", () => g.bet(me, msg.amount));
    case "side_bet": return cmd("side_bet", () => g.sideBet(me, String(msg.box || ""), msg.amount));
    case "unbet": return cmd("unbet", () => g.unbet(me));
    case "clear": return cmd("clear", () => g.clearBets(me));
    case "repeat": return cmd("repeat", () => g.repeatBet(me));
    case "set_bets": return cmd("set_bets", () => g.setBets(me, { main: msg.main, pp: msg.pp, tp: msg.tp }));
    case "all_in": return cmd("all_in", () => g.allIn(me));
    case "ready": return cmd("ready", () => g.ready(me, msg.ready !== false, t));
    case "play_card": return cmd("play_card", () => g.playCard(me, String(msg.card || ""), msg.target == null ? null : String(msg.target)));
    case "insure": return cmd("insure", () => g.insure(me, msg.choice === "evenMoney" ? "evenMoney" : msg.choice === true || msg.choice === "yes", t));
    case "decide": return cmd("decide", () => g.decide(me, Math.max(0, Math.floor(Number(msg.hand) || 0)), String(msg.action || ""), t));
    case "hint": {
      if (!me) return reply({ type: "rejected", action: "hint", reason: "not_player" });
      const r = g.setHint(me, msg.on !== false);
      if (!r.ok) return reply({ type: "rejected", action: "hint", reason: r.reason });
      // подсказка — личная настройка: снимок только этому телефону, остальных не дёргаем
      return reply({ type: "state", state: g.snapshot(t, me) });
    }
    case "chat": {
      if (!me) return reply({ type: "rejected", action: "chat", reason: "not_player" });
      // движок сам чистит управляющие и режет до 80 символов; сверх MAX_MSG_BYTES сокет и так не пропустит
      return act("chat", g.chat(me, typeof msg.text === "string" ? msg.text.slice(0, CHAT_MAX * 4) : "", t));
    }
    case "react": {
      if (!me) return;
      const r = g.react(me, String(msg.emoji || ""), t, msg.forId == null ? null : String(msg.forId));
      if (!r.ok) return reply({ type: "rejected", action: "react", reason: r.reason });
      // реакция — только событие, снимок не меняется: не гоняем state всем
      for (const e of r.events) broadcastEvent(room, e);
      return;
    }
    // ---- ведущий (только доска) ----
    case "settings": {
      if (!client.host) return notHost(msg.type);
      const r = g.setSettings(Object.assign({}, msg.patch || msg.settings || {}, { solo: false }));
      if (!r.ok) return reply({ type: "rejected", action: "settings", reason: r.reason });
      // в лобби стек на экране — из настроек: иначе до старта все видели бы старый
      for (const p of g.s.players) if (!p.spectator) p.stack = g.s.settings.stack;
      return afterChange(room, r.events);
    }
    case "start": {
      if (!client.host) return notHost(msg.type);
      const r = g.start(t);
      if (!r.ok) return reply({ type: "rejected", action: "start", reason: r.reason });
      return afterChange(room, r.events);
    }
    case "pause": return client.host ? afterChange(room, g.pause(t)) : notHost(msg.type);
    case "resume": {
      // доска умерла — продолжить может любой игрок, но только пока ни одной доски нет
      const noBoard = ![...room.sockets].some((c) => c.host);
      if (!client.host && !(noBoard && me)) return notHost(msg.type);
      return afterChange(room, g.resume(t));
    }
    case "end": return client.host ? afterChange(room, g.finishNow(t)) : notHost(msg.type);
    case "kick": {
      if (!client.host) return notHost(msg.type);
      const kid = String(msg.playerId || "");
      const events = g.removePlayer(kid, t);
      pruneTokens(room);
      for (const c of room.sockets) if (c.playerId === kid) { c.playerId = null; send(c.ws, { type: "kicked" }); }
      return afterChange(room, events);
    }
    case "mute": return client.host ? afterChange(room, g.mute(String(msg.playerId || ""), msg.muted !== false)) : notHost(msg.type);
    case "hide":
    case "hide_msg": return client.host ? afterChange(room, g.hideMessage(Number(msg.id))) : notHost(msg.type);
    case "next_game": {
      if (!client.host) return notHost(msg.type);
      if (g.s.phase !== "finished" && g.s.phase !== "lobby") return reply({ type: "rejected", action: "next_game", reason: "started" });
      // офлайн без сокета и не бот не переходят в новую партию (U-07): токен их места отзывается вместе с местом
      presence.pruneOfflineForNewGame(g.s.players.filter((p) => !isBotId(room, p.id)), { now: now(), graceMs: OFFLINE_GRACE_MS });
      const events = g.reset();
      for (const p of g.s.players) p.online = isBotId(room, p.id) || [...room.sockets].some((c) => c.playerId === p.id);
      for (const id of [...room.closedAt.keys()]) if (!g.player(id)) room.closedAt.delete(id);
      pruneTokens(room);
      return afterChange(room, events);
    }
    case "bots": {
      if (!client.host || !DEV) return notHost(msg.type);
      if (g.s.phase !== "lobby") return reply({ type: "rejected", action: "bots", reason: "started" });
      addBots(room, Math.min(MAX_PLAYERS, Number(msg.n) || 3));
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
  if (rssMb > 100) console.warn(`${LOG} ВНИМАНИЕ: RSS ${rssMb} МБ при лимите контейнера 128 МБ, комнат ${rooms.size}`);
}, SWEEP);

setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    const ph = room.game.s.phase;
    if (ph === "lobby" || ph === "finished" || !room.sockets.size) continue;
    for (const c of room.sockets) {
      if (c.poll || !c.ws || c.ws.readyState !== 1) continue;
      if (c.gameMisses >= GAME_PONG_MISSES && t - (c.alive || t) >= GAME_DEAD_MS) {
        console.log(`${LOG} ${room.code}: сокет молчит ${Math.round((t - c.alive) / 1000)} с — закрываем`);
        c.ws.terminate();
        continue;
      }
      c.gameMisses = (c.gameMisses || 0) + 1;
      try { c.ws.ping(); } catch {}
    }
  }
}, PING_MS).unref();

setInterval(() => {
  const t = now();
  for (const c of pollClients.values()) {
    const idle = !c.inflight && t - c.lastSeen > POLL_GAP_MS;
    const anon = anonExpired(c, t);
    if (idle || anon || t - c.lastSeen > 40000) closePoll(c.sid);
  }
  // анонимный WebSocket (не вошёл и не доска) тоже не держит место в комнате дольше ANON_TTL_MS
  for (const room of rooms.values()) {
    for (const c of room.sockets) if (!c.poll && anonExpired(c, t)) { try { c.ws.terminate(); } catch {} }
    try { sweepGhosts(room); } catch (err) { console.error(`${LOG} уборка призраков упала:`, err); }
  }
}, 2000).unref();

let dumpWasEmpty = false;
function dump() {
  try {
    const data = [...rooms.values()]
      .filter((r) => !r.bots.length)
      // чат в дамп не пишем (§10): он живёт только в памяти комнаты
      .map((r) => ({ dumpedAt: now(), code: r.code, ip: r.ip, hostToken: r.hostToken, tokens: r.tokens, touched: r.touched, state: { ...r.game.s, chat: [] } }));
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
 * После перезапуска: все сроки раздачи (deadline, waveStart, revealAt дилера) сдвигаем на время простоя — доска по тому же
 * plot и revealAt достраивает анимацию с нужного места, уже показанные карты не переигрываются. В страховке и решениях
 * оставляем не меньше 5 с, чтобы люди успели вернуться. В ставках — пауза, посреди раздачи — пауза на следующих ставках:
 * без людей таймер закрыл бы ставки впустую.
 */
function restore() {
  try {
    if (!fs.existsSync(DUMP)) return;
    for (const r of JSON.parse(fs.readFileSync(DUMP, "utf8"))) {
      if (now() - r.touched > ROOM_TTL) continue;
      const room = newRoom({ code: r.code, ip: r.ip || "", hostToken: r.hostToken, game: Game.from(r.state, rnd), tokens: r.tokens || {}, touched: r.touched });
      const s = room.game.s;
      if (!Array.isArray(s.chat)) s.chat = [];
      for (const p of s.players) p.online = false;
      presence.onRestore(s.players, now()); // после деплоя лобби не должно опустеть: срок призрака считается от рестарта
      pruneTokens(room);
      const inHand = s.phase !== "lobby" && s.phase !== "finished";
      if (inHand) {
        const down = Math.max(0, now() - (r.dumpedAt || r.touched || now()));
        let shift = down;
        if ((s.phase === "insurance" || s.phase === "deciding") && s.deadline != null) shift = Math.max(down, now() + 5000 - s.deadline);
        if (s.deadline != null) s.deadline += shift;
        if (s.waveStart != null) s.waveStart += shift;
        if (s.dealer && Array.isArray(s.dealer.revealAt)) s.dealer.revealAt = s.dealer.revealAt.map((x) => x + shift);
        if (s.phase === "betting" && !s.paused) room.game.pause(clock(room));
        else if (s.phase !== "betting") s.pauseNext = true;
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
