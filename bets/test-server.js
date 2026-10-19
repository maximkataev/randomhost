"use strict";

// Тесты сервера «Ставок» через настоящий WebSocket: node --test --test-concurrency=1 test-server.js
// Время партии ускоряется BETS_TIME_SCALE (часы комнаты прыгают к дедлайну), game.js не трогаем.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const WebSocket = require("ws");
const BetsShared = require("../bets-shared");

let nextPort = 4400 + (process.pid % 300) * 2;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bets-test-"));

// ---------- сервер ----------

const BASE_ENV = { BETS_PACE: "auto", BETS_INTRO_MS: "0", BETS_TIME_SCALE: "3", OFFLINE_GRACE_MS: "300", GHOST_TTL_MS: "2000", CHAT_GAP_MS: "400", REACT_GAP_MS: "300" };

async function withServer(env, fn) {
  const port = nextPort++;
  const dump = path.join(TMP, `rooms-${port}.json`);
  const srv = { port, proc: null, base: `http://127.0.0.1:${port}/bets` };
  const start = () => {
    const proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, ...BASE_ENV, ...env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: dump },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    proc.stdout.on("data", (d) => (log += d));
    proc.stderr.on("data", (d) => (log += d));
    srv.proc = proc;
    srv.log = () => log;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("сервер не поднялся: " + log)), 5000);
      proc.stdout.on("data", () => { if (/порт/.test(log)) { clearTimeout(t); resolve(); } });
    });
  };
  const stop = () => new Promise((resolve) => {
    if (!srv.proc || srv.proc.exitCode !== null) return resolve();
    srv.proc.once("exit", resolve);
    srv.proc.kill("SIGTERM");
  });
  srv.restart = async () => { await stop(); await start(); };
  srv.createRoom = async (settings = {}) => (await fetch(`${srv.base}/api/rooms`, { method: "POST", body: JSON.stringify({ settings }) })).json();
  await start();
  const clients = [];
  srv.client = (code) => { const c = client(srv, code); clients.push(c); return c; };
  try {
    await fn(srv);
  } finally {
    for (const c of clients) { try { c.ws.terminate(); } catch {} }
    await stop();
  }
}

// ---------- клиент ----------

function client(srv, code) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/bets/ws?r=${code}`);
  const c = { ws, msgs: [], state: null, events: [], chat: [], reacts: [], lives: [] };
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "state" || m.type === "hello") c.state = m.state;
    if (m.type === "event") c.events.push(m.event);
    if (m.type === "chat") c.chat.push(m);
    if (m.type === "react") c.reacts.push(m);
    if (m.type === "live") c.lives.push(m);
    for (const w of waiters.slice()) if (w.pred(m, c)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(m); }
  });
  c.open = new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error("не дождались: " + pred.toString() + "\nпоследнее состояние: " + JSON.stringify(c.state && { phase: c.state.phase, idx: c.state.idx }))); }, ms);
    waiters.push(w);
  });
  c.close = () => ws.close();
  return c;
}

const statePred = (f) => (m) => m.type === "state" && f(m.state);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function board(srv, code, hostToken) {
  const b = srv.client(code);
  await b.open;
  b.send({ type: "host", token: hostToken });
  for (let i = 0; i < 100 && !(b.msgs.some((m) => m.type === "host_ok") && b.msgs.some((m) => m.type === "state")); i++) await sleep(30);
  assert.ok(b.msgs.some((m) => m.type === "host_ok"), "доска не получила host_ok");
  return b;
}

async function player(srv, code, name, token) {
  const p = srv.client(code);
  await p.open;
  p.send({ type: "join", name, token });
  const j = await p.wait((m) => m.type === "joined" || (m.type === "error" && /token_gone|room_full|game_started|name_taken|bad_name/.test(m.error)));
  if (j.type === "error") { p.err = j.error; return p; }
  p.id = j.playerId;
  p.token = j.token;
  return p;
}

// игрок-автомат: в каждом новом окне ставит минимум на первый рынок и сдаёт купон
function autoplay(p, pick = (st) => st.ev.markets[0].id) {
  let seen = -1;
  p.ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== "state" || m.state.phase !== "bets" || !p.id || m.state.ev.n === seen) return;
    const me = m.state.players.find((x) => x.id === p.id);
    if (!me || !me.alive) return;
    seen = m.state.ev.n;
    p.send({ type: "bet", marketId: pick(m.state), stake: Math.max(10, me.min || 10) });
    p.send({ type: "submit" });
  });
}

const stackSum = (st) => st.players.reduce((a, p) => a + p.stack, 0);

// ---------- тесты ----------

test("12 игроков + доска: 13-й не входит, черновики скрыты, купоны открываются при запирании, исход — доске раньше", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "scenic", betMs: 30000, events: 8 });
    assert.match(code, /^[A-Z]+[2-9]{2}$/);
    const b = await board(srv, code, hostToken);
    const ps = [];
    for (let i = 1; i <= 12; i++) ps.push(await player(srv, code, "И" + i));
    assert.ok(ps.every((p) => p.id));
    const late = await player(srv, code, "Лишний");
    assert.strictEqual(late.err, "room_full");
    assert.strictEqual(b.state.players.length, 12);
    b.send({ type: "start" });
    const first = await b.wait(statePred((s) => s.phase === "bets"));
    const mk = first.state.ev.markets;
    assert.ok(mk.length > 2 && mk[0].p !== undefined, "доске приходят вероятности рынков");
    const phone0 = await ps[0].wait(statePred((s) => s.phase === "bets"));
    assert.strictEqual(phone0.state.ev.markets[0].p, undefined, "телефону вероятности не нужны");
    // первый игрок ставит; остальные ещё нет
    ps[0].send({ type: "bet", marketId: mk[0].id, stake: 50 });
    await ps[0].wait(statePred((s) => s.players.find((x) => x.id === ps[0].id).draft?.[mk[0].id] === 50));
    ps[0].send({ type: "bet", marketId: mk[0].id, stake: 20 }); // добавляется к уже поставленной
    await ps[0].wait(statePred((s) => s.players.find((x) => x.id === ps[0].id).draft?.[mk[0].id] === 70));
    // чужого черновика нет ни у соседа, ни на доске
    assert.ok(ps[1].state.players.every((x) => x.id === ps[1].id || x.draft === undefined), "чужих черновиков нет");
    assert.ok(b.state.players.every((x) => x.draft === undefined));
    // повторная сдача идемпотентна
    ps[0].send({ type: "submit" });
    ps[0].send({ type: "submit" });
    await ps[0].wait((m) => m.type === "rejected" && m.action === "submit" && m.reason === "submitted");
    // остальные сдают купоны (последний сдаёт — окно закрывается досрочно)
    for (let i = 1; i < 12; i++) {
      ps[i].send({ type: "bet", marketId: mk[i % mk.length].id, stake: 30 });
      ps[i].send({ type: "submit" });
    }
    const locked = await ps[3].wait(statePred((s) => s.phase === "locked"));
    for (const x of locked.state.players) assert.ok(x.coupon && x.coupon.bets.length >= 1, "купоны открыты всем после запирания");
    const c0 = locked.state.players.find((x) => x.id === ps[0].id).coupon;
    assert.strictEqual(c0.bets[0].stake, 70);
    assert.strictEqual(c0.bets[0].kc, mk[0].kc, "коэффициент зафиксирован при запирании");
    // игра дальше идёт сама
    const pay = await ps[3].wait(statePred((s) => s.phase === "payout"), 40000);
    // скрытность: телефон не видел исход до развязки, доска — видела со стадии запирания
    const phoneStates = ps[3].msgs.filter((m) => m.type === "state" && (m.state.phase === "locked" || m.state.phase === "scene"));
    assert.ok(phoneStates.length > 0);
    for (const m of phoneStates) { assert.strictEqual(m.state.ev.outcome, undefined); assert.strictEqual(m.state.ev.seed, undefined); }
    const boardStates = b.msgs.filter((m) => m.type === "state" && (m.state.phase === "locked" || m.state.phase === "scene"));
    assert.ok(boardStates.length > 0 && boardStates.every((m) => m.state.ev.outcome !== undefined && m.state.ev.seed !== undefined));
    assert.deepStrictEqual(pay.state.ev.outcome, boardStates[0].state.ev.outcome, "в развязке телефон видит тот же исход");
    // выплаты сходятся с купонами
    for (const x of pay.state.players) {
      const won = x.last.lines.reduce((a, l) => a + (l.result === "win" ? BetsShared.payout(l.stake, l.kc) : 0), 0);
      assert.strictEqual(x.last.won, won);
      assert.strictEqual(x.last.stack, x.stack);
    }
    await sleep(150); // события идут следом за состоянием
    for (const t of ["lock", "scene", "settle", "submitted", "event"]) assert.ok(b.events.some((e) => e.type === t), "событие " + t);
  });
});

test("отказы приходят только автору и не роняют сервер", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "scenic", betMs: 30000 });
    const b = await board(srv, code, hostToken);
    const a = await player(srv, code, "Аня");
    const p = await player(srv, code, "Петя");
    a.send({ type: "start" }); // не ведущий
    b.send({ type: "start" });
    const st = await a.wait(statePred((s) => s.phase === "bets"));
    const m0 = st.state.ev.markets[0].id;
    a.send({ type: "bet", marketId: "__proto__", stake: 50 });
    await a.wait((m) => m.type === "rejected" && m.action === "bet" && m.reason === "bad_market");
    a.send({ type: "bet", marketId: m0, stake: 5 });
    await a.wait((m) => m.type === "rejected" && m.reason === "bad_stake");
    a.send({ type: "bet", marketId: m0, stake: 12.5 });
    a.send({ type: "bet", marketId: m0, stake: 5000 });
    await a.wait((m) => m.type === "rejected" && m.reason === "no_money");
    a.send({ type: "settings", patch: { stack: 2000 } }); // не ведущий
    b.send({ type: "settings", patch: { stack: 2000 } }); // партия идёт
    await b.wait((m) => m.type === "rejected" && m.action === "settings");
    a.send({ type: "kick", playerId: p.id });
    a.send({ type: "end" });
    a.send({ type: "next_game" });
    a.ws.send("{не json");
    a.send(null);
    a.send({ type: "nope" });
    await a.wait((m) => m.type === "error" && m.error === "unknown message");
    a.send({ type: "submit" });
    a.send({ type: "bet", marketId: m0, stake: 100 });
    await a.wait((m) => m.type === "rejected" && m.action === "bet" && m.reason === "submitted");
    assert.strictEqual((await (await fetch(`${srv.base}/api/health`)).json()).ok, true);
    assert.ok(!p.msgs.some((m) => m.type === "rejected" || m.type === "kicked"), "чужие отказы Пете не приходят");
    assert.ok(b.state.phase !== "done", "не-ведущий не закончил партию");
  });
});

test("сообщение больше лимита рвёт только свой сокет; кривые запросы не роняют процесс; перебор кодов по /64", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom();
    const b = await board(srv, code, hostToken);
    const a = await player(srv, code, "Аня");
    const closed = new Promise((r) => a.ws.once("close", r));
    a.ws.send(JSON.stringify({ type: "chat", text: "y".repeat(9000) }));
    await closed;
    b.send({ type: "ping", c: 1 });
    await b.wait((m) => m.type === "pong");
    assert.equal((await fetch(`${srv.base}/api/msg`, { method: "POST", body: "null" })).status, 410);
    assert.equal((await fetch(`${srv.base}/api/rooms`, { method: "POST", body: "null" })).status, 200);
    for (const extra of ["", "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"]) {
      await new Promise((res) => { const s = net.connect(srv.port, "127.0.0.1", () => s.write(`GET //[ HTTP/1.1\r\nHost: x\r\n${extra}\r\n`)); s.on("data", () => s.destroy()); s.on("close", res); s.on("error", res); setTimeout(() => { s.destroy(); res(); }, 500); });
    }
    assert.equal((await (await fetch(`${srv.base}/api/health`)).json()).ok, true);
    const room = await srv.createRoom();
    for (let i = 1; i <= 60; i++) await fetch(`${srv.base}/api/session?r=NOPE${i}`, { headers: { "x-real-ip": `2001:db8:7:7::${i.toString(16)}` } });
    const r = await fetch(`${srv.base}/api/session?r=${room.code}`, { headers: { "x-real-ip": "2001:db8:7:7:abcd::1" } });
    assert.equal(r.status, 404);
  });
});

test("чат и реакции: лента только на доске, ≤80 символов, ≤1 за интервал, 50 последних, при выключенном чате молчим", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({});
    let b = await board(srv, code, hostToken);
    const a = await player(srv, code, "Аня");
    const p = await player(srv, code, "Петя");
    a.send({ type: "chat", text: "  всем   привет\n\t " + "я".repeat(200) });
    const c1 = await b.wait((m) => m.type === "chat");
    assert.strictEqual(c1.name, "Аня");
    assert.strictEqual(c1.playerId, a.id);
    assert.ok(c1.text.startsWith("всем привет я"));
    assert.strictEqual([...c1.text].length, 80);
    a.send({ type: "chat", text: "второе сразу" });
    await a.wait((m) => m.type === "rejected" && m.action === "chat" && m.reason === "too_fast");
    assert.strictEqual(b.chat.length, 1);
    assert.strictEqual(p.chat.length, 0, "телефонам лента не уходит");
    await sleep(450);
    a.send({ type: "chat", text: "   " }); // пустое — молча
    a.send({ type: "chat", text: "третье" });
    await b.wait((m) => m.type === "chat" && m.text === "третье");
    // реакции: только из списка и ≤ 1 за интервал
    a.send({ type: "react", emoji: "🔥" });
    a.send({ type: "react", emoji: "💩" });
    a.send({ type: "react", emoji: "😂" });
    await b.wait((m) => m.type === "react" && m.emoji === "🔥");
    await sleep(100);
    assert.strictEqual(b.reacts.length, 1, "чужая эмодзи и частые реакции отброшены");
    assert.strictEqual(p.reacts.length, 0);
    // 50 последних: 60 сообщений от двух игроков, новая доска получает хвост
    for (let i = 0; i < 30; i++) {
      a.send({ type: "chat", text: "a" + i }); p.send({ type: "chat", text: "p" + i });
      await sleep(410);
    }
    b.close();
    b = await board(srv, code, hostToken);
    await sleep(150);
    const replay = b.chat.filter((m) => m.replay);
    assert.strictEqual(replay.length, 50);
    assert.deepStrictEqual(replay.slice(-2).map((m) => m.text).sort(), ["a29", "p29"]);
    // чат выключен: молчим
    b.send({ type: "settings", patch: { chat: false } });
    await b.wait(statePred((s) => s.settings.chat === false));
    const n = b.chat.length;
    await sleep(450);
    const rej = a.msgs.filter((m) => m.type === "rejected").length;
    a.send({ type: "chat", text: "тишина" });
    a.send({ type: "react", emoji: "🔥" });
    await sleep(300);
    assert.strictEqual(b.chat.length, n);
    assert.strictEqual(b.reacts.length, 0, "реакций при выключенном чате нет (доска новая, до этого реакций не было)");
    assert.strictEqual(a.msgs.filter((m) => m.type === "rejected").length, rej, "и отказа игроку тоже нет — молчим");
  });
});

test("повторный вход по токену посреди окна ставок сохраняет черновик; игрок офлайн; опоздавший — game_started; чужое имя не угнать", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "scenic", betMs: 30000 });
    const b = await board(srv, code, hostToken);
    const a = await player(srv, code, "Аня");
    const p = await player(srv, code, "Петя");
    b.send({ type: "start" });
    const st = await a.wait(statePred((s) => s.phase === "bets"));
    const m0 = st.state.ev.markets[0].id;
    a.send({ type: "bet", marketId: m0, stake: 40 });
    await a.wait(statePred((s) => s.players.find((x) => x.id === a.id).draft?.[m0] === 40));
    a.close();
    await b.wait(statePred((s) => s.players.find((x) => x.id === a.id).online === false), 3000);
    const a2 = await player(srv, code, "", a.token);
    assert.strictEqual(a2.id, a.id);
    const back = await a2.wait(statePred((s) => s.players.find((x) => x.id === a.id).online && s.players.find((x) => x.id === a.id).draft?.[m0] === 40));
    assert.ok(back);
    // токен чужой комнаты/выдуманный
    const ghost = await player(srv, code, "", "выдуманный");
    assert.strictEqual(ghost.err, "token_gone");
    // опоздавший: партия идёт — новых игроков не берём
    const x = await player(srv, code, "Чужой");
    assert.strictEqual(x.err, "game_started");
    // занять место живого по имени нельзя
    const y = await player(srv, code, "Петя");
    assert.ok(y.err && y.err !== "joined");
    assert.strictEqual(b.state.players.length, 2);
    // «вылетевший по кику»: после кика токен мёртв
    b.send({ type: "kick", playerId: p.id });
    await p.wait((m) => m.type === "kicked");
    const p2 = await player(srv, code, "", p.token);
    assert.strictEqual(p2.err, "token_gone");
    assert.strictEqual(b.state.players.find((q) => q.id === p.id).alive, false);
  });
});

test("боты (режим разработки) доигрывают партию на 8 событиях до победителя; next_game начинает новую", async () => {
  await withServer({ BETS_TIME_SCALE: "40" }, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ events: 8, stack: 2000, mode: "mixed" });
    const b = await board(srv, code, hostToken);
    const humans = [await player(srv, code, "Аня"), await player(srv, code, "Петя")];
    for (const h of humans) autoplay(h);
    b.send({ type: "bots", n: 9 });
    await b.wait(statePred((s) => s.players.length === 11));
    b.send({ type: "start" });
    const fin = await b.wait(statePred((s) => s.phase === "done"), 90000);
    const st = fin.state;
    await sleep(150); // события идут следом за состоянием
    assert.ok(st.winner && st.players.some((x) => x.id === st.winner));
    assert.ok(st.idx >= 0 && st.idx < 8);
    assert.ok(st.players.length === 11);
    assert.ok(b.events.filter((e) => e.type === "event").length >= 1);
    assert.ok(b.events.some((e) => e.type === "done"));
    // каждое событие дошло до выплат: на каждое settle было lock
    assert.strictEqual(b.events.filter((e) => e.type === "settle").length, b.events.filter((e) => e.type === "lock").length);
    // фолбэк реальных слотов: источника нет — ни одно событие не живое
    const evStates = b.msgs.filter((m) => m.type === "state" && m.state.ev).map((m) => m.state.ev);
    assert.ok(evStates.length && evStates.every((e) => e.live === false));
    assert.ok(evStates.every((e) => !e.fallback && !e.live), "без включённых живых источников расписание целиком сценическое, без плашек «источник недоступен»");
    // новая партия в той же комнате: игроки на месте, стеки сброшены
    b.send({ type: "next_game" });
    const lobby = await b.wait(statePred((s) => s.phase === "lobby"));
    assert.strictEqual(lobby.state.players.length, 11);
    assert.strictEqual(lobby.state.settings.events, 8);
    assert.strictEqual(lobby.state.winner, null);
  });
});

test("рестарт посреди сцены: те же коэффициенты и исход, игроки возвращаются по токену, выплаты доигрываются", async () => {
  await withServer({ BETS_TIME_SCALE: "3" }, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "scenic", betMs: 30000 });
    let b = await board(srv, code, hostToken);
    let a = await player(srv, code, "Аня");
    let p = await player(srv, code, "Петя");
    b.send({ type: "start" });
    const st = await a.wait(statePred((s) => s.phase === "bets"));
    const mk = st.state.ev.markets;
    a.send({ type: "bet", marketId: mk[0].id, stake: 100 });
    a.send({ type: "bet", marketId: mk[1].id, stake: 60 });
    p.send({ type: "bet", marketId: mk[mk.length - 1].id, stake: 80 });
    a.send({ type: "submit" });
    p.send({ type: "submit" });
    const scene = await b.wait(statePred((s) => s.phase === "scene"), 10000);
    const before = scene.state;
    assert.ok(before.ev.outcome !== undefined && before.ev.seed !== undefined);
    await sleep(100);
    const tokens = [a.token, p.token], ids = [a.id, p.id];
    for (const c of [a, p, b]) c.ws.terminate();
    await srv.restart();
    b = await board(srv, code, hostToken);
    assert.strictEqual(b.state.phase, "scene", "сцена продолжается");
    assert.deepStrictEqual(b.state.ev.outcome, before.ev.outcome, "исход тот же");
    assert.strictEqual(b.state.ev.seed, before.ev.seed, "сид сцены тот же");
    assert.deepStrictEqual(b.state.ev.markets, before.ev.markets, "рынки и коэффициенты те же");
    assert.deepStrictEqual(b.state.ev.meta, before.ev.meta);
    assert.deepStrictEqual(b.state.players.map((x) => x.coupon), before.players.map((x) => x.coupon), "купоны те же");
    assert.ok(b.state.players.every((x) => x.online === false), "после рестарта все офлайн, пока не вернулись");
    a = await player(srv, code, "", tokens[0]);
    p = await player(srv, code, "", tokens[1]);
    assert.deepStrictEqual([a.id, p.id], ids);
    const pay = await a.wait(statePred((s) => s.phase === "payout"), 20000);
    assert.deepStrictEqual(pay.state.ev.outcome, before.ev.outcome);
    for (const x of pay.state.players) {
      const won = x.last.lines.reduce((s, l) => s + (l.result === "win" ? BetsShared.payout(l.stake, l.kc) : 0), 0);
      assert.strictEqual(x.last.won, won);
    }
    // игра продолжается следующим событием
    const next = await b.wait(statePred((s) => s.phase === "bets" && s.idx === 1), 20000);
    assert.ok(next.state.ev.markets.length > 0);
  });
});

// ---------- реальные события: подменный feed ----------

const MOCK_FEED = `
"use strict";
const MODE = process.env.MOCK_FEED || "resolve";
const duel = { lamA: 0.2, lamB: 0.2 };
const thr = { kinds: [{ id: "a", lam: 0.05 }, { id: "b", lam: 0.05 }], opts: { ks: [1] } };
const cats = { counts: { a: 10, b: 10, c: 10 } };
const IN = { btc: { sigma: 5 }, btceth: { sigB: 0.0005, sigE: 0.0007, rho: 0.6 }, news: cats, emoji: duel, wikiduel: duel, wikiedit: thr, whales: thr, lightning: duel, airport: duel, lang: cats, wikinext: cats, drand: {} };
const OUT = { btc: 3.1, btceth: { rB: 0.001, rE: -0.001 }, news: "a", emoji: { nA: 3, nB: 1 }, wikiduel: { nA: 3, nB: 1 }, wikiedit: { a: 1, b: 0, first: "a" }, whales: { a: 1, b: 0, first: "a" }, lightning: { nA: 3, nB: 1 }, airport: { nA: 3, nB: 1 }, lang: "a", wikinext: "a", drand: "abcdef0" };
exports.createFeed = () => ({
  start() {}, stop() {},
  status() { return { mock: { ok: true, lastAt: 1, note: MODE } }; },
  prepare(type) { return IN[type] ? { input: IN[type], meta: { title: "mock " + type } } : null; },
  begin(type, o) {
    o.onLive({ kind: "echo", input: o.input, meta: o.meta, deadline: o.deadline });   // сервер обязан передать input/meta события
    o.onLive({ kind: "price", t: 1, btc: 100 });
    o.onLive({ kind: "count", a: 1, b: 0 });
    o.onLive({ kind: "count", a: 2, b: 0 });
    const t = setTimeout(() => { if (MODE === "resolve") o.onResolve(OUT[type]); else if (MODE === "abort") o.onAbort("mock lost"); else if (MODE === "garbage") o.onResolve(null); }, 100);
    return { cancel() { clearTimeout(t); } };
  },
});
`;
const MOCK_PATH = path.join(TMP, "mock-feed.js");
fs.writeFileSync(MOCK_PATH, MOCK_FEED);
const liveEnv = (mode, extra = {}) => ({ BETS_PACE: "auto", BETS_INTRO_MS: "0", BETS_TIME_SCALE: "10", BETS_LIVE: "all", BETS_FEED_MODULE: MOCK_PATH, MOCK_FEED: mode, ...extra });

async function twoPlayersToLocked(srv, settings) {
  const { code, hostToken } = await srv.createRoom({ mode: "real", betMs: 30000, ...settings });
  const b = await board(srv, code, hostToken);
  const a = await player(srv, code, "Аня");
  const p = await player(srv, code, "Петя");
  b.send({ type: "start" });
  const st = await a.wait(statePred((s) => s.phase === "bets"));
  assert.strictEqual(st.state.ev.live, true, "реальное событие принято feed.prepare");
  assert.strictEqual(st.state.ev.fallback, null);
  const mk = st.state.ev.markets;
  a.send({ type: "bet", marketId: mk[0].id, stake: 100 });
  p.send({ type: "bet", marketId: mk[1].id, stake: 100 });
  a.send({ type: "submit" });
  p.send({ type: "submit" });
  return { code, hostToken, b, a, p, mk };
}

test("реальное событие: feed.begin при запирании, live рассылается, liveState в снимке, onResolve → выплаты", async () => {
  await withServer(liveEnv("resolve"), async (srv) => {
    const { code, b, a, p } = await twoPlayersToLocked(srv, {});
    const pay = await a.wait(statePred((s) => s.phase === "payout"), 15000);
    assert.ok(a.lives.length >= 3 && p.lives.length >= 3 && b.lives.length >= 3, "live дошёл всем");
    assert.deepStrictEqual(a.lives.map((m) => m.seq), a.lives.map((_, i) => a.lives[0].seq + i), "seq идёт подряд");
    assert.ok(a.lives.some((m) => m.data.kind === "price"), "поток live содержит котировки");
    assert.strictEqual(pay.state.ev.live, true);
    assert.ok(pay.state.ev.outcome !== undefined && !pay.state.ev.voidAll);
    assert.ok(pay.state.players.every((x) => x.last.lines.every((l) => l.result !== "void")));
  });
});

test("реальное событие: сервер передаёт feed.begin input/meta/deadline события; мусорный исход → возврат с voidReason", async () => {
  await withServer(liveEnv("garbage"), async (srv) => {
    const { a } = await twoPlayersToLocked(srv, {});
    const pay = await a.wait(statePred((s) => s.phase === "payout"), 15000);
    const echo = a.lives.find((m) => m.data.kind === "echo").data;
    assert.ok(echo.input && echo.meta && /^mock /.test(echo.meta.title), "input/meta дошли до feed.begin");
    assert.ok(echo.deadline > 0);
    assert.strictEqual(pay.state.ev.voidAll, true);
    assert.match(pay.state.ev.voidReason, /^bad_outcome/);
  });
});

test("реальное событие: источник пропал — причина в ev.voidReason", async () => {
  await withServer(liveEnv("abort"), async (srv) => {
    const { a } = await twoPlayersToLocked(srv, {});
    const pay = await a.wait(statePred((s) => s.phase === "payout"), 15000);
    assert.match(pay.state.ev.voidReason, /^source_lost: mock lost/);
  });
});

test("реальное событие: последнее значение каждого вида живых данных лежит в ev.liveState для тех, кто подключился позже", async () => {
  await withServer(liveEnv("hang", { BETS_TIME_SCALE: "5" }), async (srv) => {
    const { code, hostToken, b, a } = await twoPlayersToLocked(srv, {});
    await a.wait(statePred((s) => s.phase === "scene" || s.phase === "locked"), 8000);
    assert.ok(a.lives.some((m) => m.data.kind === "count"));
    const b2 = await board(srv, code, hostToken);
    const ls = b2.state.ev.liveState;
    assert.ok(ls && ls.price && ls.count, "liveState в hello");
    assert.strictEqual(ls.count.a, 2, "именно последнее значение вида");
    assert.strictEqual(b2.state.ev.n, 1);
    b.close();
  });
});

test("реальное событие: источник пропал (onAbort) — все ставки возвращаются", async () => {
  await withServer(liveEnv("abort"), async (srv) => {
    const { a } = await twoPlayersToLocked(srv, {});
    const pay = await a.wait(statePred((s) => s.phase === "payout"), 15000);
    assert.strictEqual(pay.state.ev.voidAll, true);
    for (const x of pay.state.players) {
      assert.ok(x.last.lines.every((l) => l.result === "void"));
      assert.strictEqual(x.stack, 1000 - x.last.penalty, "ставка вернулась, штрафа нет или он только за недобор");
    }
  });
});

test("реальное событие ждёт исхода, сервер перезапускается — ставки возвращаются (voidAllAndSettle)", async () => {
  await withServer(liveEnv("hang", { BETS_TIME_SCALE: "5" }), async (srv) => {
    const { code, hostToken, b, a, p } = await twoPlayersToLocked(srv, {});
    await b.wait(statePred((s) => s.phase === "scene" || s.phase === "locked"), 8000);
    const tokens = [a.token, p.token];
    for (const c of [a, p, b]) c.ws.terminate();
    await srv.restart();
    const b2 = await board(srv, code, hostToken);
    assert.strictEqual(b2.state.phase, "payout", "реальное событие без исхода после рестарта сразу в выплатах");
    assert.strictEqual(b2.state.ev.voidAll, true);
    const a2 = await player(srv, code, "", tokens[0]);
    const pay = await a2.wait(statePred((s) => s.players.find((x) => x.id === a2.id).last));
    assert.ok(pay.state.players.every((x) => x.last.lines.every((l) => l.result === "void")));
    assert.strictEqual(pay.state.players.find((x) => x.id === a2.id).stack, 1000 - pay.state.players.find((x) => x.id === a2.id).last.penalty);
  });
});

test("без feed.js (BETS_LIVE=none) режим «только реальные» заменяется сценическими событиями, расписание целое", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "real", events: 8 });
    const b = await board(srv, code, hostToken);
    const a = await player(srv, code, "Аня");
    await player(srv, code, "Петя");
    b.send({ type: "start" });
    const st = await a.wait(statePred((s) => s.phase === "bets"));
    assert.strictEqual(st.state.ev.live, false);
    assert.ok(!st.state.ev.fallback && !st.state.ev.live, "режим «только реальные» без источников дал сценические события, без плашки");
    assert.ok(["dice", "dogs", "penalties", "rocket", "rope"].includes(st.state.ev.type));
    assert.strictEqual(st.state.ev.markets.length > 0, true);
    // BETS_LIVE выставлен, но модуль не найден — тоже сценические
  });
  await withServer({ BETS_LIVE: "btc", BETS_FEED_MODULE: path.join(TMP, "нет-такого.js") }, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "real" });
    const b = await board(srv, code, hostToken);
    await player(srv, code, "Аня"); await player(srv, code, "Петя");
    b.send({ type: "start" });
    const st = await b.wait(statePred((s) => s.phase === "bets"));
    assert.strictEqual(st.state.ev.live, false);
    assert.ok(!st.state.ev.fallback, "модуль feed не найден — живых типов нет, расписание сценическое без плашки");
  });
});

// ---------- вход по имени, призраки ----------

async function joinNew(srv, code, extra) {
  const c = srv.client(code);
  await c.open;
  c.send(Object.assign({ type: "join", caps: ["claim"] }, extra));
  return c;
}
const isErr = (e) => (m) => m.type === "error" && m.error === e;

test("вход по имени: тёзка получает «Имя (2)»; вернувшийся в грацию — name_claim retry, потом «Это ты?» и подхват с новым токеном", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom();
    const b = await board(srv, code, hostToken);
    const maria = await player(srv, code, "Маша");
    const other = await joinNew(srv, code, { name: "Маша" });
    const j2 = await other.wait((m) => m.type === "joined");
    assert.strictEqual(j2.name, "Маша (2)");
    assert.strictEqual(j2.renamed, true);
    maria.close();
    await sleep(60);
    const back = await joinNew(srv, code, { name: "Маша" });
    const retry = await back.wait(isErr("name_claim"));
    assert.strictEqual(retry.retry, true);
    await sleep(500);
    back.send({ type: "join", name: "Маша", caps: ["claim"] });
    const prompt = await back.wait((m) => m.type === "error" && m.error === "name_claim" && !m.retry);
    assert.ok(prompt.summary && typeof prompt.summary.stack === "number");
    assert.ok(!back.msgs.some((m) => m.type === "joined"));
    back.send({ type: "join", name: "Маша", caps: ["claim"], claim: true });
    const jb = await back.wait((m) => m.type === "joined");
    assert.strictEqual(jb.playerId, maria.id);
    assert.strictEqual(jb.viaName, true);
    assert.notStrictEqual(jb.token, maria.token);
    await b.wait((m) => m.type === "event" && m.event.type === "rejoin" && m.event.playerId === maria.id);
    const stale = srv.client(code);
    await stale.open;
    stale.send({ type: "join", token: maria.token });
    await stale.wait(isErr("token_gone"));
  });
});

test("призраки: в лобби офлайн-место уходит через GHOST_TTL_MS, в партии — никогда", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "scenic" });
    const b = await board(srv, code, hostToken);
    const a = await player(srv, code, "Аня");
    const p = await player(srv, code, "Петя");
    p.close();
    await b.wait(statePred((s) => s.players.find((x) => x.name === "Петя")?.online === false), 4000);
    await b.wait(statePred((s) => !s.players.some((x) => x.name === "Петя")), 8000);
    const c = await player(srv, code, "Света");
    b.send({ type: "start" });
    await a.wait(statePred((s) => s.phase === "bets"));
    c.close();
    await sleep(3000);
    assert.ok(b.state.players.some((x) => x.name === "Света" && x.online === false), "в игре место не освобождается");
  });
});

test("офлайн-игрок не задерживает окно: когда сдали все, кто на связи, окно закрывается", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "scenic", betMs: 30000 });
    const b = await board(srv, code, hostToken);
    const a = await player(srv, code, "Аня");
    const p = await player(srv, code, "Петя");
    b.send({ type: "start" });
    const st = await a.wait(statePred((s) => s.phase === "bets"));
    a.send({ type: "bet", marketId: st.state.ev.markets[0].id, stake: 50 });
    a.send({ type: "submit" });
    await sleep(100);
    assert.strictEqual(b.state.phase, "bets");
    p.ws.terminate(); // Петя пропал, не сдав купон
    await b.wait(statePred((s) => s.phase === "locked"), 5000);
    const pet = b.state.players.find((x) => x.id === p.id);
    assert.ok(pet.coupon.penalty > 0, "Пете штраф за недобор");
  });
});

// ---------- лимиты, TTL, long-poll ----------

test("лимиты: комнат с адреса, сокетов в комнате, анонимов с адреса; бесхозная комната живёт ROOM_TTL_MS", async () => {
  await withServer({ MAX_ROOMS_PER_IP: "2", MAX_SOCKETS_PER_ROOM: "6", MAX_ANON_PER_IP: "4", ROOM_TTL_MS: "3000" }, async (srv) => {
    const ip = { "x-real-ip": "10.1.1.1" };
    const mk = () => fetch(`${srv.base}/api/rooms`, { method: "POST", body: "{}", headers: ip });
    const r1 = await (await mk()).json();
    assert.ok(r1.code);
    assert.equal((await mk()).status, 200);
    const third = await mk();
    assert.equal(third.status, 400);
    assert.match((await third.json()).error, /too many rooms/);
    // другой адрес — своя квота
    assert.equal((await fetch(`${srv.base}/api/rooms`, { method: "POST", body: "{}", headers: { "x-real-ip": "10.2.2.2" } })).status, 200);
    // анонимы с одного адреса: 4 можно, пятый — 503
    const ok = [];
    for (let i = 0; i < 4; i++) { const w = new WebSocket(`ws://127.0.0.1:${srv.port}/bets/ws?r=${r1.code}`, { headers: ip }); ok.push(w); await new Promise((res, rej) => { w.once("open", res); w.once("error", rej); }); }
    const code5 = await new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${srv.port}/bets/ws?r=${r1.code}`, { headers: ip }); w.once("unexpected-response", (_, r) => res(r.statusCode)); w.once("open", () => res(200)); w.once("error", () => {}); });
    assert.equal(code5, 503);
    for (const w of ok) w.terminate();
    // бесхозная комната (без сокетов) исчезает после TTL
    const lone = await (await fetch(`${srv.base}/api/rooms`, { method: "POST", body: "{}", headers: { "x-real-ip": "10.3.3.3" } })).json();
    assert.equal((await fetch(`${srv.base}/api/session?r=${lone.code}`, { headers: { "x-real-ip": "10.3.3.3" } })).status, 200);
    await sleep(6500);
    assert.equal((await fetch(`${srv.base}/api/session?r=${lone.code}`, { headers: { "x-real-ip": "10.3.3.3" } })).status, 404);
  });
});

test("long-poll запасной путь: сессия, вход, ставка, получение состояния", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({ mode: "scenic" });
    const b = await board(srv, code, hostToken);
    const other = await player(srv, code, "Петя");
    const ses = await (await fetch(`${srv.base}/api/session?r=${code}`)).json();
    assert.ok(ses.sid && ses.messages[0].type === "hello");
    const post = (msg) => fetch(`${srv.base}/api/msg`, { method: "POST", body: JSON.stringify({ sid: ses.sid, msg }) });
    await post({ type: "join", name: "Аня" });
    let joined = null;
    for (let i = 0; i < 5 && !joined; i++) {
      const r = await (await fetch(`${srv.base}/api/poll?sid=${ses.sid}`)).json();
      joined = r.messages.find((m) => m.type === "joined");
    }
    assert.ok(joined && joined.playerId);
    b.send({ type: "start" });
    let bets = null;
    for (let i = 0; i < 6 && !bets; i++) {
      const r = await (await fetch(`${srv.base}/api/poll?sid=${ses.sid}`)).json();
      bets = r.messages.filter((m) => m.type === "state").map((m) => m.state).find((s) => s.phase === "bets");
    }
    assert.ok(bets);
    await post({ type: "bet", marketId: bets.ev.markets[0].id, stake: 40 });
    let mine = null;
    for (let i = 0; i < 6 && !mine; i++) {
      const r = await (await fetch(`${srv.base}/api/poll?sid=${ses.sid}`)).json();
      mine = r.messages.filter((m) => m.type === "state").map((m) => m.state.players.find((x) => x.id === joined.playerId)).find((x) => x && x.draft && Object.keys(x.draft).length);
    }
    assert.ok(mine);
    void other;
    assert.equal((await fetch(`${srv.base}/api/poll?sid=нет`)).status, 410);
  });
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test("доска: host даёт один host_ok и состояние, а не новый hello (регрессия: цикл host↔hello мигал лобби и пищал)", async () => {
  await withServer({}, async (srv) => {
    const { code, hostToken } = await srv.createRoom({});
    const b = await board(srv, code, hostToken);
    await sleep(600);
    assert.equal(b.msgs.filter((m) => m.type === "hello").length, 1, "hello приходит один раз — при подключении");
    assert.equal(b.msgs.filter((m) => m.type === "host_ok").length, 1);
    const a = await player(srv, code, "Аня");
    await sleep(300);
    assert.equal(b.msgs.filter((m) => m.type === "hello").length, 1, "вход игрока не порождает hello на доске");
    // две доски: прежняя узнаёт о потере роли один раз и не забирает её сама
    const b2 = srv.client(code); await b2.open; b2.send({ type: "host", token: hostToken });
    await sleep(600);
    assert.equal(b.msgs.filter((m) => m.type === "host_lost").length, 1);
    assert.equal(b2.msgs.filter((m) => m.type === "host_ok").length, 1);
  });
});

test("темп «по кнопке»: знакомство ждёт «open» от ведущего, ставки без таймера, «lock» и «next» только от ведущего", async () => {
  await withServer({ BETS_PACE: "host" }, async (srv) => {
    const { code, hostToken } = await srv.createRoom({});
    const b = await board(srv, code, hostToken);
    const a = await player(srv, code, "Аня");
    const p = await player(srv, code, "Петя");
    b.send({ type: "start" });
    const st = await a.wait(statePred((s) => s.phase === "bets" && s.intro));
    assert.equal(st.state.gate, "open");
    assert.equal(st.state.deadline, 0, "таймера нет");
    a.send({ type: "open" });                       // игрок кнопку не нажмёт
    await sleep(400);
    assert.equal([...a.msgs].reverse().find((m) => m.type === "state").state.intro, true, "от игрока open игнорируется");
    b.send({ type: "open" });
    const bets = await a.wait(statePred((s) => s.phase === "bets" && !s.intro));
    assert.equal(bets.state.gate, "lock");
    assert.equal(bets.state.deadline, 0);
    a.send({ type: "bet", marketId: bets.state.ev.markets[0].id, stake: 100 });
    a.send({ type: "submit" });
    await sleep(500);
    assert.equal([...a.msgs].reverse().find((m) => m.type === "state").state.phase, "bets", "Петя не сдал — окно не закрывается само");
    b.send({ type: "lock" });
    await a.wait(statePred((s) => s.phase === "locked" || s.phase === "scene"));
  });
});
