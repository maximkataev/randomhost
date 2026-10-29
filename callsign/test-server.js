"use strict";

// Тесты сервера «Позывного» через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `callsign-test-${process.pid}.json`);
const port = 6600 + (process.pid % 500);
let proc = null;

function startServer() {
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300", ANON_TTL_MS: "1500", GHOST_TTL_MS: "1500", PING_MS: "1000", ...(startServer.env || {}) },
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
  const r = await fetch(`http://127.0.0.1:${port}/callsign/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}

function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/callsign/ws?r=${code}`);
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
  c.closed = new Promise((res) => ws.once("close", res));
  c.send = (m) => ws.send(typeof m === "string" ? m : JSON.stringify(m));
  c.wait = (pred, ms = 10000) => new Promise((resolve, reject) => {
    if (c.state && pred({ type: "state", state: c.state }, c)) return resolve({ type: "state", state: c.state });
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
  await b.wait((m) => m.type === "host_ok");
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

const statePred = (f) => (m) => (m.type === "state" || m.type === "hello") && m.state && f(m.state);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const TEAMS = ["red", "blue"];

// 6 игроков: первые трое красные, остальные синие
async function six(room) {
  const names = ["Оля", "Петя", "Вася", "Маша", "Коля", "Даша"];
  const ps = [];
  for (const n of names) ps.push(await player(room.code, n));
  ps.forEach((p, i) => p.send({ type: "team", team: i < 3 ? "red" : "blue" }));
  return ps;
}

const capId = (b, team) => b.state.caps[team];

test("сервер", async (t) => {
  await startServer();
  t.after(() => stopServer());

  await t.test("партия: ключ видят только капитаны, тап открывает, ловушка кончает", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const ps = await six(room);
    await b.wait(statePred((s) => s.players.filter((p) => p.team).length === 6));
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "clue"));
    const team = b.state.team;
    const capP = ps.find((p) => p.id === capId(b, team));
    const opP = ps.find((p) => p.state && p.state.players.find((x) => x.id === p.id).team === team && p.id !== capP.id);
    const foeCap = ps.find((p) => p.id === capId(b, team === "red" ? "blue" : "red"));
    await Promise.all(ps.map((p) => p.wait(statePred((s) => s.phase === "clue" && s.me))));
    // ключ: капитанам виден, остальным и доске — нет
    assert.ok(capP.state.board.every((c) => c.t), "капитан видит ключ");
    assert.ok(foeCap.state.board.every((c) => c.t), "чужой капитан видит ключ");
    assert.ok(opP.state.board.every((c) => c.t === undefined), "оперативник не видит ключ");
    assert.ok(b.state.board.every((c) => c.t === undefined), "доска не видит ключ");
    for (const c of [opP, b]) assert.ok(!c.raw.some((x) => /"t":"(red|blue|n|x)"/.test(x)), "ключ не уходил оперативнику/доске");
    // оперативник не может подсказывать, капитан — может
    opP.send({ type: "clue", text: "море", n: 2 });
    assert.strictEqual((await opP.wait((m) => m.type === "rejected" && m.action === "clue")).reason, "not_captain");
    capP.send({ type: "clue", text: "подсказка", n: 2 });
    await b.wait(statePred((s) => s.phase === "guess" && s.clue && s.clue.word === "подсказка"));
    await sleep(1400); // защита от случайного касания после подсказки
    // капитан открывать не может
    capP.send({ type: "open", i: 0 });
    assert.strictEqual((await capP.wait((m) => m.type === "rejected" && m.action === "open")).reason, "captain");
    // оперативник открывает свою карточку — цвет теперь виден всем
    const mine = capP.state.board.findIndex((c) => c.t === team);
    opP.send({ type: "open", i: mine });
    await b.wait(statePred((s) => s.board[mine].o && s.board[mine].t === team));
    assert.strictEqual(b.state.opened, 1);
    // ловушка — конец партии, ключ раскрыт всем
    const x = capP.state.board.findIndex((c) => c.t === "x");
    await sleep(300); // не упираться в лимит тапов
    opP.send({ type: "open", i: x });
    await b.wait(statePred((s) => s.phase === "finished"));
    assert.strictEqual(b.state.finishedReason, "assassin");
    assert.strictEqual(b.state.winner, team === "red" ? "blue" : "red");
    assert.ok(b.state.board.every((c) => c.t), "после конца ключ виден доске");
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("старт с командой из одного — rejected team_small", async () => {
    const room = await createRoom({});
    const b = await board(room.code, room.hostToken);
    const ps = [];
    for (const n of ["А", "Б", "В", "Г"]) ps.push(await player(room.code, n));
    for (const p of ps.slice(0, 3)) p.send({ type: "team", team: "red" });
    ps[3].send({ type: "team", team: "blue" });
    await b.wait(statePred((s) => s.players.filter((p) => p.team).length === 4));
    b.send({ type: "start" });
    const r = await b.wait((m) => m.type === "rejected" && m.action === "start");
    assert.strictEqual(r.reason, "team_small");
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("подхват по имени в игре запрещён: капитан не утекает", async () => {
    const room = await createRoom({});
    const b = await board(room.code, room.hostToken);
    const ps = await six(room);
    await b.wait(statePred((s) => s.players.filter((p) => p.team).length === 6));
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "clue"));
    const cap = ps.find((p) => p.id === capId(b, b.state.team));
    const name = cap.state.players.find((x) => x.id === cap.id).name;
    cap.close();
    await sleep(50);
    const thief = client(room.code);
    await thief.open;
    thief.send({ type: "join", name });
    const r = await thief.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.error, "name_taken");
    assert.ok(!thief.raw.some((x) => /"t":"(red|blue|n|x)"/.test(x)), "вор не видел ключ");
    thief.close(); b.close(); ps.forEach((p) => p.close());
  });

  await t.test("тапы не чаще 4 в секунду с сокета", async () => {
    const room = await createRoom({});
    const b = await board(room.code, room.hostToken);
    const ps = await six(room);
    await b.wait(statePred((s) => s.players.filter((p) => p.team).length === 6));
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "clue"));
    const team = b.state.team;
    const capP = ps.find((p) => p.id === capId(b, team));
    const opP = ps.find((p) => p.state.players.find((x) => x.id === p.id).team === team && p.id !== capP.id);
    capP.send({ type: "clue", text: "подсказка", n: 9 });
    await b.wait(statePred((s) => s.phase === "guess"));
    await sleep(1400);
    const mine = capP.state.board.map((c, i) => [c, i]).filter(([c]) => c.t === team).map(([, i]) => i);
    for (const i of mine.slice(0, 7)) opP.send({ type: "open", i });
    await sleep(400);
    assert.ok(opP.msgs.some((m) => m.type === "rejected" && m.reason === "slow_down"), "лишние тапы отклонены");
    assert.ok(b.state.board.filter((c) => c.o).length <= 4);
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("комната на 12: 13-й получает отказ", async () => {
    const room = await createRoom({});
    const ps = [];
    for (let i = 0; i < 12; i++) ps.push(await player(room.code, "И" + i));
    const extra = client(room.code);
    await extra.open;
    extra.send({ type: "join", name: "Лишний" });
    const r = await extra.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.error, "room_full");
    extra.close(); ps.forEach((p) => p.close());
  });

  await t.test("рестарт сервера посреди хода: игрок возвращается по токену, раскладка цела", async () => {
    const room = await createRoom({});
    const b = await board(room.code, room.hostToken);
    const ps = await six(room);
    await b.wait(statePred((s) => s.players.filter((p) => p.team).length === 6));
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "clue"));
    const team = b.state.team;
    const capP = ps.find((p) => p.id === capId(b, team));
    capP.send({ type: "clue", text: "подсказка", n: 2 });
    await b.wait(statePred((s) => s.phase === "guess"));
    const key = capP.state.board.map((c) => c.t).join();
    const token = capP.token, id = capP.id;
    ps.forEach((p) => p.close()); b.close();
    await stopServer();
    await startServer();
    const again = client(room.code);
    await again.open;
    again.send({ type: "join", token });
    const j = await again.wait((m) => m.type === "joined");
    assert.strictEqual(j.playerId, id);
    await again.wait(statePred((s) => s.phase === "guess" && s.clue && s.clue.word === "подсказка" && s.me && s.me.captain));
    assert.strictEqual(again.state.board.map((c) => c.t).join(), key);
    again.close();
  });

  await t.test("три пустых хода подряд — пауза, «Играем!» продолжает; смена капитана объясняется", async () => {
    const room = await createRoom({}, 40); // ускорение 40× только в разработке
    const b = await board(room.code, room.hostToken);
    const ps = await six(room);
    await b.wait(statePred((s) => s.players.filter((p) => p.team).length === 6));
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "paused"), 30000);
    assert.strictEqual(b.state.phaseEnd, null);
    assert.strictEqual(b.state.log.filter((e) => e.end === "noclue").length, 3);
    ps[0].send({ type: "resume" });
    await b.wait(statePred((s) => s.phase === "clue"));
    ps[0].send({ type: "resume" });
    assert.strictEqual((await ps[0].wait((m) => m.type === "rejected" && m.action === "resume")).reason, "bad_phase");
    // капитан красных пропадает — после 45 игровых секунд (≈1 с при 40×) роль переходит, причина видна всем
    const team = b.state.team;
    const capP = ps.find((p) => p.id === b.state.caps[team]);
    capP.close();
    await b.wait(statePred((s) => s.capChange && s.capChange.team === team), 15000);
    assert.strictEqual(b.state.capChange.reason, "offline");
    assert.notStrictEqual(b.state.caps[team], capP.id);
    b.close(); ps.forEach((p) => p.close());
  });
});
