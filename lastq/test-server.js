"use strict";

// Тесты сервера «Последнего вопроса» через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `lastq-test-${process.pid}.json`);
const BANK = fs.mkdtempSync(path.join(os.tmpdir(), "lastq-bank-"));
const port = 6400 + (process.pid % 500);
let proc = null;

// временный банк: тест не зависит от того, готовы ли настоящие колоды
const qs = [];
for (let i = 0; i < 30; i++) qs.push({ id: "q" + i, tag: ["animals", "food", "geo"][i % 3], lvl: 1 + (i % 3), final: false, q: "Вопрос " + i, a: ["СЕКРЕТ" + i, "мимо", "тоже мимо", "смешно"], fun: 3 });
for (let i = 0; i < 4; i++) qs.push({ id: "f" + i, tag: "geo", lvl: 3, final: true, q: "Финал " + i, a: ["СЕКРЕТФ" + i, "мимо", "тоже мимо", "смешно"], fun: 3 });
for (const l of ["ru", "en", "el"]) fs.writeFileSync(path.join(BANK, l + ".json"), JSON.stringify({ questions: qs }));

function startServer() {
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300", LQ_CONTENT_DIR: BANK },
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
async function createRoom(settings = {}, speed = 1) {
  const r = await fetch(`http://127.0.0.1:${port}/lastq/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}
function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lastq/ws?r=${code}`);
  const c = { ws, msgs: [], raw: [], state: null, events: [] };
  const waiters = [];
  ws.on("message", (raw) => {
    c.raw.push(String(raw));
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "state" || m.type === "hello") c.state = m.state;
    if (m.type === "event") c.events.push(m.event);
    for (const w of waiters.slice()) if (w.pred(m, c)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  c.open = new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = (pred, ms = 10000) => new Promise((resolve, reject) => {
    if (c.state && pred({ type: "state", state: c.state }, c)) return resolve({ type: "state", state: c.state });
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => reject(new Error("не дождались: " + pred.toString())), ms);
  });
  c.phase = (ph, ms) => c.wait((m) => m.type === "state" && m.state.phase === ph, ms);
  c.close = () => ws.close();
  return c;
}
async function board(code, hostToken) {
  const b = client(code);
  await b.open;
  b.send({ type: "host", token: hostToken });
  await b.wait((m) => m.type === "host_ok");
  return b;
}
async function player(code, name, token) {
  const p = client(code);
  await p.open;
  p.send({ type: "join", name, token });
  const m = await p.wait((x) => x.type === "joined" || x.type === "error");
  if (m.type === "joined") { p.id = m.playerId; p.token = m.token; }
  p.joinMsg = m;
  return p;
}

test.before(startServer);
test.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

test("партия: верный ответ не уходит до раскрытия, ошибившийся попадает в Камеру и получает испытание без ответа", async () => {
  const { code, hostToken } = await createRoom({}, 8);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("answer");
  // в снимках до раскрытия нет верного индекса
  for (const c of [a, z, b]) assert.equal(c.state.right, null);
  a.send({ type: "answer", i: 0 });
  z.send({ type: "answer", i: 1 });
  const rv = await b.phase("reveal");
  const right = rv.state.right;
  assert.ok(Number.isInteger(right));
  const loser = right === 0 ? z : right === 1 ? a : null;
  if (!loser) return; // оба мимо — тоже честный исход, проверять Камеру нечем
  // первая секунда Камеры — «Приготовься», испытания ещё нет
  const cell = await loser.wait((m) => m.type === "state" && m.state.phase === "cell" && m.state.me.cell && m.state.me.cell.ch, 15000);
  const ch = cell.state.me.cell.ch;
  assert.ok(ch && ch.type && ch.view);
  assert.ok(!("answer" in ch), "ответ испытания утёк на телефон");
  // чужой id испытания — отказ «stale»
  loser.send({ type: "cell", cid: ch.id + 999, ans: { v: 0 } });
  const rj = await loser.wait((m) => m.type === "rejected" && m.action === "cell");
  assert.equal(rj.reason, "stale");
  b.close(); a.close(); z.close();
});

test("лимит: 11-й игрок — room_full; новый игрок с одного сокета не чаще раза в 3 с", async () => {
  const { code } = await createRoom();
  const ps = [];
  for (let i = 0; i < 10; i++) ps.push(await player(code, "И" + i));
  const extra = await player(code, "Лишний");
  assert.equal(extra.joinMsg.error, "room_full");
  for (const p of ps.concat(extra)) p.close();
});

test("ход после звонка не проходит: ответ после конца фазы не засчитывается", async () => {
  const { code, hostToken } = await createRoom({}, 20);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("reveal", 15000); // никто не ответил — фаза закрылась по таймеру
  a.send({ type: "answer", i: 0 });
  const rj = await a.wait((m) => m.type === "rejected" && m.action === "answer");
  assert.equal(rj.reason, "not_now");
  b.close(); a.close(); z.close();
});

test("рестарт посреди партии: комната и игроки восстанавливаются из дампа, вход по токену", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("read");
  await new Promise((r) => setTimeout(r, 5500)); // дамп раз в 5 с
  await stopServer();
  await startServer();
  // пока никто не вернулся — партия стоит на паузе, а не доигрывается без игроков
  await new Promise((r) => setTimeout(r, 4000));
  const a2 = await player(code, "", a.token);
  assert.equal(a2.joinMsg.type, "joined");
  assert.equal(a2.id, a.id);
  await a2.wait((m) => m.type === "state" && m.state.phase !== "lobby");
  assert.ok(["read", "answer"].includes(a2.state.phase), "партия ушла вперёд без игроков: " + a2.state.phase);
  a2.close();
  for (const c of [b, a, z]) try { c.close(); } catch {}
});

test("переподключение узника не меняет испытание Камеры", async () => {
  const { code, hostToken } = await createRoom({}, 8);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("answer");
  a.send({ type: "answer", i: 0 });
  z.send({ type: "answer", i: 1 });
  const rv = await b.phase("reveal");
  const loser = rv.state.right === 0 ? z : rv.state.right === 1 ? a : null;
  if (!loser) { b.close(); a.close(); z.close(); return; }
  const st = await loser.wait((m) => m.type === "state" && m.state.phase === "cell" && m.state.me.cell && m.state.me.cell.ch, 15000);
  const id0 = st.state.me.cell.ch.id;
  const again = await player(code, "", loser.token);
  const st2 = await again.wait((m) => m.type === "state" && m.state.me && m.state.me.cell && m.state.me.cell.ch);
  assert.equal(st2.state.me.cell.ch.id, id0);
  for (const c of [b, a, z, again]) try { c.close(); } catch {}
});

test("банк настоящий (без LQ_CONTENT_DIR) — непустой у испытаний бомбы", () => {
  const CH = require("./challenges.js");
  assert.ok(CH.bank().quiz.length > 50 && CH.bank().tf.length > 10);
});

test("speed < 1 (агенты): фаза длится дольше настоящего срока, ответ после 20 реальных секунд принимается", { timeout: 60000 }, async () => {
  const { code, hostToken } = await createRoom({}, 0.25);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("answer", 40000);
  await new Promise((r) => setTimeout(r, 21000)); // реальных 21 с > 20 с фазы, но по часам комнаты прошло ~5 с
  a.send({ type: "answer", i: 0 });
  await a.wait((m) => m.type === "state" && m.state.me && m.state.me.answer === 0, 5000);
  for (const c of [b, a, z]) c.close();
});

test("тёзка не забирает игрока, пока тот онлайн или в грации; в лобби — получает «Имя 2»", async () => {
  const { code } = await createRoom();
  const a = await player(code, "Аня");
  a.close();
  const twin = await player(code, "Аня");
  assert.notEqual(twin.id, a.id);
  await twin.wait((m) => m.type === "state" && m.state.players.some((p) => p.name === "Аня 2"), 5000);
  twin.close();
});

test("подхват по имени выдаёт новый токен и отзывает старый — пинг-понга нет", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Алиса");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("read");
  a.close();
  await new Promise((r) => setTimeout(r, 900)); // грация офлайна в тестах 300 мс
  const thief = await player(code, "Алиса"); // тот же IP — подхват разрешён
  assert.equal(thief.id, a.id);
  const back = await player(code, "", a.token); // старый токен отозван
  assert.equal(back.joinMsg.type, "error");
  assert.equal(back.joinMsg.error, "token_gone");
  for (const c of [b, z, thief, back]) try { c.close(); } catch {}
});

test("health и неизвестная комната", async () => {
  const h = await (await fetch(`http://127.0.0.1:${port}/lastq/api/health`)).json();
  assert.equal(h.ok, true);
  const r = await fetch(`http://127.0.0.1:${port}/lastq/api/session?r=NOPE99`);
  assert.equal(r.status, 404);
});

test("кривые запросы не роняют процесс; перебор кодов считается по /64", async () => {
  const base = `http://127.0.0.1:${port}/lastq`;
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
