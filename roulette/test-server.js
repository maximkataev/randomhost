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
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300" },
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

test("возврат по токену посреди партии; чужое имя без токена в идущую партию не пускает", async () => {
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
  const x = client(code);
  await x.open;
  x.send({ type: "join", name: "Чужой" });
  await x.wait((m) => m.type === "error" && m.error === "game_started");
  for (const c of [a2, p, b, x]) c.close();
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
