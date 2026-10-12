"use strict";

// Тесты сервера рулетки через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `roulette-test-${process.pid}.json`);
let port = 3900 + (process.pid % 500);
let proc = null;

function startServer() {
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300", GHOST_TTL_MS: "2000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  proc.log = () => log;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("сервер не поднялся: " + log)), 5000);
    proc.stdout.on("data", () => { if (/порт/.test(log)) { clearTimeout(t); resolve(); } });
  });
}

function stopServer(signal = "SIGTERM") {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once("exit", resolve);
    proc.kill(signal);
  });
}

async function createRoom(settings = {}, speed = 20) {
  const r = await fetch(`http://127.0.0.1:${port}/roulette/api/rooms`, { method: "POST", body: JSON.stringify({ settings: { cards: false, ...settings }, speed }) });
  return r.json();
}

// Клиент: копит сообщения, умеет ждать нужное
function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/roulette/ws?r=${code}`);
  const c = { ws, msgs: [], state: null, events: [] };
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "state" || m.type === "hello") c.state = m.state;
    if (m.type === "event") c.events.push(m.event);
    for (const w of waiters.slice()) if (w.pred(m, c)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  c.open = new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find((m) => pred(m, c));
    if (hit && pred.past) return resolve(hit);
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => reject(new Error("не дождались: " + pred.toString())), ms);
  });
  c.close = () => ws.close();
  return c;
}

async function board(code, hostToken) {
  const b = client(code);
  await b.open;
  b.send({ type: "host", token: hostToken });
  // первый hello — анонимный, второй после host_ok — полный, с числом, если шарик уже брошен
  for (let i = 0; i < 100 && !(b.msgs.some((m) => m.type === "host_ok") && b.msgs.filter((m) => m.type === "hello").length >= 2); i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(b.msgs.some((m) => m.type === "host_ok"), "доска не получила host_ok");
  return b;
}

async function player(code, name, token) {
  const p = client(code);
  await p.open;
  p.send({ type: "join", name, token });
  const j = await p.wait((m) => m.type === "joined");
  p.id = j.playerId;
  p.token = j.token;
  return p;
}

const statePred = (f) => (m) => m.type === "state" && f(m.state);

test.before(async () => { try { fs.unlinkSync(DUMP); } catch {} await startServer(); });
test.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

test("партия: доска знает число с броска, телефоны — только после остановки шарика", async () => {
  const { code, hostToken } = await createRoom();
  assert.match(code, /^[A-Z]+[2-9]{2}$/);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "betting"));
  a.send({ type: "bet", key: "red", amount: 50 });
  p.send({ type: "set_bets", bets: { "n:17": 10, black: 20 } });
  await b.wait(statePred((s) => s.players.find((x) => x.name === "Петя")?.betTotal === 30));
  // чужие ставки видны всем
  await a.wait(statePred((s) => s.players.find((x) => x.name === "Петя")?.bets["n:17"] === 10));
  a.send({ type: "ready" });
  p.send({ type: "ready" });
  const closing = await b.wait(statePred((s) => s.phase === "closing"));
  assert.ok(Number.isInteger(closing.state.result.number));
  assert.ok(closing.state.result.story);
  const n = closing.state.result.number;
  const phoneClosing = await a.wait(statePred((s) => s.phase === "closing"));
  assert.strictEqual(phoneClosing.state.result.number, undefined, "телефон не должен знать число до остановки");
  const spinningPhone = await a.wait(statePred((s) => s.phase === "spinning"));
  assert.strictEqual(spinningPhone.state.result.number, undefined);
  const payout = await a.wait(statePred((s) => s.phase === "payout"), 20000);
  assert.strictEqual(payout.state.result.number, n);
  const me = payout.state.players.find((x) => x.id === a.id);
  const red = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  assert.strictEqual(me.stack, red.has(n) ? 1050 : 950);
  for (const c of [a, p, b]) c.close();
});

test("отказы приходят только автору и не роняют сервер", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "betting"));
  a.send({ type: "bet", key: "__proto__", amount: 5 });
  await a.wait((m) => m.type === "rejected" && m.reason === "bad_bet");
  a.send({ type: "bet", key: "red", amount: 5000 });
  await a.wait((m) => m.type === "rejected" && m.reason === "no_money");
  a.send({ type: "set_bets", bets: "мусор" });
  await a.wait((m) => m.type === "rejected");
  a.send({ type: "start" }); // не ведущий
  a.send({ type: "kick", playerId: p.id });
  a.ws.send("{не json");
  a.send(null);
  a.send({ type: "card", card: "double", target: p.id }); // карты выключены
  await a.wait((m) => m.type === "rejected" && m.reason === "no_cards");
  const res = await fetch(`http://127.0.0.1:${port}/roulette/api/health`);
  assert.strictEqual((await res.json()).ok, true);
  assert.ok(!p.msgs.some((m) => m.type === "rejected"));
  assert.ok(!p.msgs.some((m) => m.type === "kicked"));
  for (const c of [a, p, b]) c.close();
});

test("сообщение больше лимита рвёт только свой сокет, сервер живёт", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const closed = new Promise((r) => a.ws.once("close", r));
  a.ws.send(JSON.stringify({ type: "chat", text: "y".repeat(9000) }));
  await closed;
  const res = await fetch(`http://127.0.0.1:${port}/roulette/api/health`);
  assert.strictEqual((await res.json()).ok, true);
  b.send({ type: "ping", c: 1 });
  await b.wait((m) => m.type === "pong");
  b.close();
});

test("чат и реакции: доска видит ленту, телефоны — нет; ведущий скрывает и глушит", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  a.send({ type: "chat", text: "  всем привет  " });
  const st = await b.wait(statePred((s) => s.chat.length === 1));
  assert.strictEqual(st.state.chat[0].text, "всем привет");
  assert.deepStrictEqual(a.state.chat, []);
  a.send({ type: "react", emoji: "🔥" });
  await b.wait((m) => m.type === "event" && m.event.type === "react" && m.event.emoji === "🔥");
  b.send({ type: "hide_msg", id: st.state.chat[0].id });
  await b.wait(statePred((s) => s.chat.length === 0));
  b.send({ type: "mute", playerId: a.id });
  await a.wait(statePred((s) => s.me && s.me.muted));
  a.send({ type: "chat", text: "эй" });
  await a.wait((m) => m.type === "rejected" && m.reason === "muted");
  for (const c of [a, b]) c.close();
});

test("возврат по токену посреди партии; опоздавший — зритель; место по имени не угнать", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "betting"));
  a.send({ type: "bet", key: "red", amount: 30 });
  await a.wait(statePred((s) => s.players.find((x) => x.id === a.id).betTotal === 30));
  a.close();
  const a2 = await player(code, "", a.token);
  assert.strictEqual(a2.id, a.id);
  assert.strictEqual(a2.state.players.find((x) => x.id === a.id).betTotal, 30);
  // опоздавший садится зрителем, а не получает отказ
  const x = await player(code, "Чужой");
  const sx = (await x.wait(statePred((st) => st.players.some((q) => q.id === x.id)))).state;
  const me = sx.players.find((q) => q.id === x.id);
  assert.ok(me && me.spectator && me.out);
  x.send({ type: "bet", key: "red", amount: 10 });
  await x.wait((m) => m.type === "rejected");
  // занять место игрока по имени нельзя, пока он на связи
  const y = client(code);
  await y.open;
  y.send({ type: "join", name: "Петя" });
  const jy = await y.wait((m) => m.type === "joined");
  assert.notStrictEqual(jy.playerId, p.id);
  for (const c of [a2, p, b, x, y]) c.close();
});

test("перезапуск посреди вращения: спин доигрывается с тем же числом, игроки возвращаются по токену", async () => {
  const { code, hostToken } = await createRoom({}, 1);
  let b = await board(code, hostToken);
  let a = await player(code, "Аня");
  let p = await player(code, "Петя");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "betting"));
  a.send({ type: "bet", key: "odd", amount: 100 });
  p.send({ type: "bet", key: "even", amount: 100 });
  await b.wait(statePred((s) => s.players.every((x) => x.betTotal === 100)));
  a.send({ type: "ready" });
  p.send({ type: "ready" });
  const closing = await b.wait(statePred((s) => s.phase === "closing"));
  const n = closing.state.result.number;
  await new Promise((r) => setTimeout(r, 5600)); // дамп раз в 5 с
  for (const c of [a, p, b]) c.close();
  await stopServer();
  await startServer();
  b = await board(code, hostToken);
  assert.strictEqual(b.state.result.number, n, "число после рестарта то же");
  a = await player(code, "", a.token);
  p = await player(code, "", p.token);
  const payout = await a.wait(statePred((s) => s.phase === "payout"), 30000);
  assert.strictEqual(payout.state.result.number, n);
  const total = payout.state.players.reduce((x, y) => x + y.stack, 0);
  assert.strictEqual(total, n === 0 ? 1800 : 2000);
  // следующий спин встаёт на паузу — ждём, пока ведущий продолжит
  const next = await b.wait(statePred((s) => s.phase === "betting"), 15000);
  assert.ok(next.state.paused);
  for (const c of [a, p, b]) c.close();
});

test("знакомство с картами: первый спин — когда все нажали «Готов»; ведущий может начать сам", async () => {
  const { code, hostToken } = await createRoom({ cards: true });
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  b.send({ type: "start" });
  const br = await a.wait(statePred((s) => s.phase === "briefing"));
  assert.strictEqual(br.state.me.hand.length, 1, "свою карту видно на знакомстве");
  assert.strictEqual(br.state.players.find((x) => x.id === p.id).cards, 1);
  a.send({ type: "ready" });
  await b.wait(statePred((s) => s.players.find((x) => x.id === a.id)?.ready));
  assert.strictEqual(b.state.phase, "briefing");
  p.send({ type: "ready" });
  await b.wait(statePred((s) => s.phase === "betting" && s.spin === 1));

  const r2 = await createRoom({ cards: true });
  const b2 = await board(r2.code, r2.hostToken);
  const c = await player(r2.code, "Оля");
  const d = await player(r2.code, "Дима");
  b2.send({ type: "start" });
  await b2.wait(statePred((s) => s.phase === "briefing"));
  c.send({ type: "go" }); // не ведущий — игнор
  b2.send({ type: "go" });
  await b2.wait(statePred((s) => s.phase === "betting"));
  for (const x of [a, p, b, b2, c, d]) x.close();
});

test("боты в режиме разработки доигрывают партию до победителя", async () => {
  const { code, hostToken } = await createRoom({ pace: "fast", betTime: 20000 }, 20);
  const b = await board(code, hostToken);
  b.send({ type: "bots", n: 4 });
  await b.wait(statePred((s) => s.players.length === 4));
  b.send({ type: "start" });
  const fin = await b.wait(statePred((s) => s.phase === "finished"), 60000);
  assert.ok(fin.state.winnerId);
  assert.ok(fin.state.players.every((x) => x.place >= 1));
  b.close();
});

test("кривые запросы не роняют процесс; перебор кодов считается по /64", async () => {
  const base = `http://127.0.0.1:${port}/roulette`;
  // тело null: раньше TypeError в async-обработчике → unhandledRejection → выход процесса со всеми комнатами
  assert.equal((await fetch(`${base}/api/msg`, { method: "POST", body: "null" })).status, 410);
  assert.equal((await fetch(`${base}/api/rooms`, { method: "POST", body: "null" })).status, 200);
  // адрес, на котором new URL бросает, — обычным запросом и рукопожатием WebSocket
  const net = require("node:net");
  for (const extra of ["", "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"]) {
    await new Promise((res) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET //[ HTTP/1.1\r\nHost: x\r\n${extra}\r\n`)); s.on("data", () => s.destroy()); s.on("close", res); s.on("error", res); setTimeout(() => { s.destroy(); res(); }, 500); });
  }
  assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
  // промахи с разных адресов одной IPv6 /64 копятся в один счётчик: верный код после 60 промахов закрыт
  const room = await (await fetch(`${base}/api/rooms`, { method: "POST", body: "{}" })).json();
  for (let i = 1; i <= 60; i++) await fetch(`${base}/api/session?r=NOPE${i}`, { headers: { "x-real-ip": `2001:db8:7:7::${i.toString(16)}` } });
  const r = await fetch(`${base}/api/session?r=${room.code}`, { headers: { "x-real-ip": "2001:db8:7:7:abcd::1" } });
  assert.equal(r.status, 404);
});

// ---------- T-W2-10 / T-W2-11: вход по имени, призраки ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// вход «как новая страница»: caps:["claim"] — клиент умеет «Это ты?» и тихие повторы
async function joinNew(code, extra) {
  const c = client(code);
  await c.open;
  c.send(Object.assign({ type: "join", caps: ["claim"] }, extra));
  return c;
}
const isErr = (e) => (m) => m.type === "error" && m.error === e;

test("T-W2-10: тёзка получает «Имя (2)» с пометкой renamed, а не «Имя 2»; вернувшийся в грацию — name_claim retry, потом «Это ты?»", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const maria = await player(code, "Маша");
  const other = await joinNew(code, { name: "Маша" });
  const j2 = await other.wait((m) => m.type === "joined");
  assert.strictEqual(j2.name, "Маша (2)");
  assert.strictEqual(j2.renamed, true);
  const third = await joinNew(code, { name: "Маша (2)" });
  const j3 = await third.wait((m) => m.type === "joined");
  assert.strictEqual(j3.name, "Маша (3)", "«Маша (2)» не превращается в «Маша (2) (2)»");

  // оригинал «моргнул»: сокет закрыт, грация (300 мс) ещё идёт — это не «стол полон» и не новое место
  maria.close();
  await sleep(60);
  const back = await joinNew(code, { name: "Маша" });
  const retry = await back.wait(isErr("name_claim"));
  assert.strictEqual(retry.retry, true);
  assert.ok(retry.retryInMs > 0);
  await sleep(500); // грация вышла: теперь «Это ты?» с выжимкой, без перехвата молча
  back.send({ type: "join", name: "Маша", caps: ["claim"] });
  const prompt = await back.wait((m) => m.type === "error" && m.error === "name_claim" && !m.retry);
  assert.strictEqual(prompt.name, "Маша");
  assert.ok(prompt.summary && typeof prompt.summary.stack === "number");
  assert.ok(!back.msgs.some((m) => m.type === "joined"), "без подтверждения место не отдано");
  back.send({ type: "join", name: "Маша", caps: ["claim"], claim: true });
  const jb = await back.wait((m) => m.type === "joined");
  assert.strictEqual(jb.playerId, maria.id);
  assert.strictEqual(jb.resumed, true);
  assert.strictEqual(jb.viaName, true);
  assert.notStrictEqual(jb.token, maria.token, "токен подхвата новый");
  await b.wait((m) => m.type === "event" && m.event.type === "rejoin" && m.event.playerId === maria.id);
  // прежний токен отозван: с ним вход возможен только по имени
  const stale = client(code);
  await stale.open;
  stale.send({ type: "join", token: maria.token });
  await stale.wait(isErr("token_gone"));
  for (const c of [b, other, third, back, stale]) c.close();
});

test("T-W2-10: клиент без caps подхватывает офлайн-место молча, как раньше; живой — получает «Имя (2)»", async () => {
  const { code } = await createRoom();
  const a = await player(code, "Аня");
  a.close();
  await sleep(700);
  const old = client(code);
  await old.open;
  old.send({ type: "join", name: "Аня" });
  const j = await old.wait((m) => m.type === "joined");
  assert.strictEqual(j.playerId, a.id);
  assert.strictEqual(j.resumed, true);
  const twin = client(code);
  await twin.open;
  twin.send({ type: "join", name: "Аня" });
  const jt = await twin.wait((m) => m.type === "joined");
  assert.notStrictEqual(jt.playerId, a.id);
  assert.strictEqual(jt.name, "Аня (2)");
  old.close(); twin.close();
});

test("T-W2-10: посреди партии офлайн-место возвращается по имени тихо (RULE_U01_CLAIM_IN_GAME выкл.), стек цел", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  await player(code, "Петя");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "betting"));
  a.send({ type: "bet", key: "red", amount: 30 });
  await a.wait(statePred((s) => s.players.find((x) => x.id === a.id).betTotal === 30));
  a.close();
  await sleep(700);
  const back = await joinNew(code, { name: "Аня" });
  const j = await back.wait((m) => m.type === "joined");
  assert.strictEqual(j.playerId, a.id);
  assert.strictEqual(j.viaName, true);
  const st = (await back.wait(statePred((s) => s.players.some((x) => x.id === a.id && x.online)))).state;
  assert.strictEqual(st.players.find((x) => x.id === a.id).betTotal, 30);
});

test("T-W2-11: в лобби офлайн-место уходит через GHOST_TTL_MS, в игре — никогда", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  p.close();
  await b.wait(statePred((s) => s.players.find((x) => x.name === "Петя")?.online === false), 4000);
  await b.wait(statePred((s) => !s.players.some((x) => x.name === "Петя")), 8000);
  // игра идёт: офлайн остаётся с местом сколько угодно
  const c = await player(code, "Света");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "betting"));
  c.close();
  await sleep(5500);
  assert.ok(b.state.players.some((x) => x.name === "Света" && x.online === false), "в игре место не освобождается");
  b.close(); a.close();
});

test("T-W2-11: «Ещё партию» не переносит офлайн, место освобождается для новых (12 мест)", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const ps = [];
  for (let i = 1; i <= 12; i++) ps.push(await player(code, "И" + i));
  const late = client(code);
  await late.open;
  late.send({ type: "join", name: "Лишний", caps: ["claim"] });
  await late.wait(isErr("room_full"));
  // партия до итогов
  b.send({ type: "start" });
  await b.wait(statePred((s) => s.phase === "betting"));
  b.send({ type: "end" });
  await b.wait(statePred((s) => s.phase === "finished"));
  ps[0].close(); ps[1].close();
  await sleep(1000); // вышла грация места и грация перед новой партией (по 300 мс)
  b.send({ type: "next_game" });
  const lobby = await b.wait(statePred((s) => s.phase === "lobby"));
  assert.strictEqual(lobby.state.players.length, 10, "двое офлайн не перешли в новую партию");
  assert.ok(!lobby.state.players.some((x) => x.name === "И1" || x.name === "И2"));
  // освободившееся место принимает новых
  const n13 = await player(code, "Лишний");
  assert.ok(n13.id);
  for (const c of [b, late, n13, ...ps]) c.close();
});

test("T-W2-11/roulette-019: штраф за спины без связи показывается вернувшемуся и гасится ack_away", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "betting"));
  a.close();
  await sleep(500); // грация 300 мс вышла: Аня офлайн
  p.send({ type: "bet", key: "red", amount: 50 });
  p.send({ type: "ready" });
  await p.wait(statePred((s) => s.phase === "payout"), 30000);
  const back = await player(code, "", a.token);
  const st = (await back.wait(statePred((s) => s.me && s.me.away))).state;
  assert.ok(st.me.away.spins >= 1);
  assert.ok(st.me.away.lost > 0);
  back.send({ type: "ack_away" });
  await back.wait(statePred((s) => s.me && !s.me.away));
  for (const c of [b, p, back]) c.close();
});

test("T-W2-10: RULE_U01_CLAIM_IN_GAME=1 — посреди партии офлайн-место возвращается только после «Это ты?»", async () => {
  const p2 = port + 7;
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(p2), NODE_ENV: "development", DUMP_FILE: DUMP + ".rule", OFFLINE_GRACE_MS: "300", RULE_U01_CLAIM_IN_GAME: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("не поднялся")), 5000); child.stdout.on("data", (d) => { if (/порт/.test(String(d))) { clearTimeout(t); res(); } }); });
    const saved = port;
    port = p2;
    try {
      const { code, hostToken } = await createRoom();
      const b = await board(code, hostToken);
      const a = await player(code, "Аня");
      await player(code, "Петя");
      b.send({ type: "start" });
      await a.wait(statePred((s) => s.phase === "betting"));
      a.close();
      await sleep(700);
      const back = await joinNew(code, { name: "Аня" });
      const pr = await back.wait((m) => m.type === "error" && m.error === "name_claim" && !m.retry);
      assert.strictEqual(pr.name, "Аня");
      assert.ok(!back.msgs.some((m) => m.type === "joined"));
      back.send({ type: "join", name: "Аня", caps: ["claim"], claim: true });
      const j = await back.wait((m) => m.type === "joined");
      assert.strictEqual(j.playerId, a.id);
    } finally { port = saved; }
  } finally {
    child.kill();
    try { fs.unlinkSync(DUMP + ".rule"); } catch {}
  }
});

test("T-W2-12: «Закончить» при равных стеках — draw и winnerIds у доски и телефонов", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "betting"));
  b.send({ type: "end" });
  const fin = await a.wait(statePred((s) => s.phase === "finished"));
  assert.strictEqual(fin.state.draw, true);
  assert.deepStrictEqual(fin.state.winnerIds.slice().sort(), [a.id, p.id].sort());
  assert.ok(fin.state.players.every((x) => x.place === 1));
  for (const c of [a, p, b]) c.close();
});
