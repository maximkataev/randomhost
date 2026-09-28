"use strict";

// Тесты сервера «На одной волне» через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `wave-test-${process.pid}.json`);
const port = 6100 + (process.pid % 500);
let proc = null;

function startServer() {
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300", ANON_TTL_MS: "1500", ...(startServer.env || {}) },
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
  const r = await fetch(`http://127.0.0.1:${port}/wave/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}

function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/wave/ws?r=${code}`);
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


// все выбирают шкалу 0 и пишут подсказку
async function allClue(ps) {
  for (const p of ps) {
    await p.wait(statePred((s) => s.phase === "clue" && s.me && s.me.card));
    p.send({ type: "pick", i: 0 });
    await p.wait(statePred((s) => s.me.card.pick === 0));
    p.send({ type: "clue", text: "подсказка " + "абвгд"[ps.indexOf(p)] });
  }
}

test("сервер", async (t) => {
  await startServer();
  t.after(() => stopServer());

  await t.test("подхват по имени: не посреди раунда и не у того, кто на связи", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася")];
    b.send({ type: "start" });
    await allClue(ps);
    await b.wait(statePred((s) => s.phase === "guess"));
    const author = b.state.card.author;
    const victim = ps.find((p) => p.id === author);
    // экран у автора погас на мгновение — вор пытается войти под его именем
    victim.close();
    await sleep(50);
    const thief = client(room.code);
    await thief.open;
    thief.send({ type: "join", name: victim.state.players.find((p) => p.id === author).name });
    const r = await thief.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.type, "error");
    assert.strictEqual(r.error, "name_taken");
    assert.ok(!thief.raw.some((x) => x.includes('"target"')), "вор не видел сектор");
    // хозяин возвращается по токену — всё на месте
    const back = await player(room.code, "", victim.token);
    assert.strictEqual(back.id, author);
    thief.close(); b.close(); back.close(); ps.forEach((p) => p.close());
  });

  await t.test("анонимный сокет без входа закрывается по ANON_TTL_MS", async () => {
    const room = await createRoom({ lang: "ru" });
    const a = client(room.code);
    await a.open;
    const closed = await Promise.race([a.closed.then(() => true), sleep(6000).then(() => false)]);
    assert.ok(closed, "аноним не держит место в комнате");
  });

  await t.test("рестарт посреди подсказок: вернувшийся не закрывает фазу за остальных", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "А1"), await player(room.code, "Б1"), await player(room.code, "В1"), await player(room.code, "Г1")];
    b.send({ type: "start" });
    await ps[0].wait(statePred((s) => s.phase === "clue" && s.me && s.me.card));
    ps[0].send({ type: "pick", i: 0 });
    await ps[0].wait(statePred((s) => s.me.card.pick === 0));
    ps[0].send({ type: "clue", text: "первая" });
    await ps[0].wait(statePred((s) => !!s.me.card.clue));
    await sleep(5200); // дамп раз в 5 с
    await stopServer();
    await startServer();
    const p1 = await player(room.code, "", ps[1].token);
    await p1.wait(statePred((s) => s.phase === "clue" && s.me && s.me.card));
    p1.send({ type: "pick", i: 0 });
    await p1.wait(statePred((s) => s.me.card.pick === 0));
    p1.send({ type: "clue", text: "вторая" });
    await p1.wait(statePred((s) => !!s.me.card.clue));
    await sleep(300);
    assert.strictEqual(p1.state.phase, "clue", "фаза ждёт остальных после рестарта");
    p1.close();
  });
});
