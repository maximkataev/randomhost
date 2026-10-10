"use strict";

// Тесты сервера «Как все» через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `crowd-test-${process.pid}.json`);
const STATS = path.join(os.tmpdir(), `crowd-test-stats-${process.pid}.json`);
const CDIR = fs.mkdtempSync(path.join(os.tmpdir(), "crowd-content-"));
const port = 6600 + (process.pid % 500);
let proc = null;

// синтетический банк: серверу нужно ≥ 8 вопросов
for (const lang of ["ru", "en", "el"]) {
  const questions = Array.from({ length: 40 }, (_, i) => ({ id: lang + "-" + i, q: "Вопрос " + i + "?", a: "Да", b: "Нет", kind: "yn", tag: "home", lean: i % 2 ? "b" : "a", sensitive: false }));
  fs.writeFileSync(path.join(CDIR, lang + ".json"), JSON.stringify({ questions }));
}

function startServer() {
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, STATS_FILE: STATS, CONTENT_DIR: CDIR, OFFLINE_GRACE_MS: "300", ANON_TTL_MS: "1500", ...(startServer.env || {}) },
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
  const r = await fetch(`http://127.0.0.1:${port}/crowd/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}

function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/crowd/ws?r=${code}`);
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

test("сервер", async (t) => {
  await startServer();
  t.after(async () => { await stopServer(); for (const f of [DUMP, STATS]) { try { fs.unlinkSync(f); } catch {} } });

  await t.test("партия: чужие голоса не утекают до раскрытия, потом очки считаются", async () => {
    const room = await createRoom({ lang: "ru", opinion: false, short: true });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "vote"));
    ps[0].send({ type: "vote", side: "a" });
    ps[1].send({ type: "vote", side: "a" });
    ps[2].send({ type: "vote", side: "b" });
    await ps[2].wait(statePred((s) => s.me && s.me.vote === "b"));
    ps[0].send({ type: "bank", on: true });
    await ps[0].wait(statePred((s) => s.me && s.me.bank === true));
    for (const p of ps) p.send({ type: "confirm" });
    await b.wait(statePred((s) => s.phase === "reveal"));
    // до reveal ни в одном сообщении доски и чужих телефонов не было "votes"/"order"/"seed"
    const leaked = (c) => c.raw.slice(0, c.raw.findIndex((x) => x.includes('"phase":"reveal"'))).some((x) => /"votes"|"order"|"seed"|"banked"/.test(x));
    assert.ok(!leaked(b), "доска видела тайны до раскрытия");
    assert.ok(!leaked(ps[1]), "чужой телефон видел тайны до раскрытия");
    const res = b.state.round.result;
    assert.strictEqual(res.side, "a");
    assert.strictEqual(res.pts[ps[0].id], 200);
    assert.strictEqual(res.pts[ps[1].id], 100);
    assert.strictEqual(res.pts[ps[2].id], 0);
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("повторный голос той же стороной не рассылает снимки; лимит команд в секунду", async () => {
    const room = await createRoom({ lang: "ru", opinion: false });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "А"), await player(room.code, "Б"), await player(room.code, "В")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "vote"));
    ps[0].send({ type: "vote", side: "a" });
    await ps[0].wait(statePred((s) => s.me && s.me.vote === "a"));
    await sleep(150);
    const n = ps[1].raw.length;
    ps[0].send({ type: "vote", side: "a" });
    await sleep(150);
    assert.strictEqual(ps[1].raw.length, n, "ничего не поменялось — рассылки нет");
    // флуд голосами: сверх CMD_RATE (5/с) молча отбрасывается
    for (let i = 0; i < 30; i++) ps[0].send({ type: "vote", side: i % 2 ? "a" : "b" });
    await sleep(300);
    assert.ok(ps[1].raw.length - n < 12, "флуд не раздувает рассылку: " + (ps[1].raw.length - n));
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("13-й игрок получает «Комната заполнена»", async () => {
    const room = await createRoom({ lang: "ru" });
    const ps = [];
    for (let i = 0; i < 12; i++) { ps.push(await player(room.code, "И" + i)); await sleep(5); }
    const extra = client(room.code);
    await extra.open;
    extra.send({ type: "join", name: "Лишний" });
    const r = await extra.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.error, "room_full");
    extra.close(); ps.forEach((p) => p.close());
  });

  await t.test("анонимный сокет без входа закрывается по ANON_TTL_MS", async () => {
    const room = await createRoom({ lang: "ru" });
    const a = client(room.code);
    await a.open;
    const closed = await Promise.race([a.closed.then(() => true), sleep(6000).then(() => false)]);
    assert.ok(closed, "аноним не держит место в комнате");
  });

  await t.test("подхват по имени: не посреди партии", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "vote"));
    ps[0].send({ type: "vote", side: "a" });
    await ps[0].wait(statePred((s) => s.me && s.me.vote === "a"));
    ps[0].close();
    await sleep(80);
    const thief = client(room.code);
    await thief.open;
    thief.send({ type: "join", name: "Оля" });
    const r = await thief.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.error, "name_taken");
    assert.ok(!thief.raw.some((x) => x.includes('"vote":"a"')), "вор не видел чужой голос");
    const back = await player(room.code, "", ps[0].token);
    assert.strictEqual(back.id, ps[0].id);
    await back.wait(statePred((s) => s.me && s.me.vote === "a")); // вернувшийся видит свой голос
    thief.close(); b.close(); back.close(); ps.slice(1).forEach((p) => p.close());
  });

  await t.test("рестарт посреди голосования: голоса сохранены, вернувшийся не закрывает фазу за остальных", async () => {
    const room = await createRoom({ lang: "ru", opinion: false });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "А1"), await player(room.code, "Б1"), await player(room.code, "В1"), await player(room.code, "Г1")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "vote"));
    ps[0].send({ type: "vote", side: "a" });
    await ps[0].wait(statePred((s) => s.me.vote === "a"));
    ps[0].send({ type: "confirm" });
    await ps[0].wait(statePred((s) => s.me.confirmed));
    await sleep(5200); // дамп раз в 5 с
    await stopServer();
    await startServer();
    const p1 = await player(room.code, "", ps[1].token);
    await p1.wait(statePred((s) => s.phase === "vote"));
    p1.send({ type: "vote", side: "b" });
    p1.send({ type: "confirm" });
    await sleep(300);
    assert.strictEqual(p1.state.phase, "vote", "фаза ждёт остальных после рестарта");
    const p0 = await player(room.code, "", ps[0].token);
    await p0.wait(statePred((s) => s.me && s.me.vote === "a" && s.me.confirmed));
    p0.close(); p1.close();
  });

  await t.test("кривые запросы не роняют процесс; перебор кодов считается по /64", async () => {
    const base = `http://127.0.0.1:${port}/crowd`;
    assert.equal((await fetch(`${base}/api/msg`, { method: "POST", body: "null" })).status, 410);
    assert.equal((await fetch(`${base}/api/rooms`, { method: "POST", body: "null" })).status, 200);
    const net = require("node:net");
    for (const extra of ["", "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"]) {
      await new Promise((res) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET //[ HTTP/1.1\r\nHost: x\r\n${extra}\r\n`)); s.on("data", () => s.destroy()); s.on("close", res); s.on("error", res); setTimeout(() => { s.destroy(); res(); }, 500); });
    }
    assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
    const room = await (await fetch(`${base}/api/rooms`, { method: "POST", body: "{}" })).json();
    for (let i = 1; i <= 60; i++) await fetch(`${base}/api/session?r=NOPE${i}`, { headers: { "x-real-ip": `2001:db8:7:7::${i.toString(16)}` } });
    const r = await fetch(`${base}/api/session?r=${room.code}`, { headers: { "x-real-ip": "2001:db8:7:7:abcd::1" } });
    assert.equal(r.status, 404);
  });

  await t.test("мусорные сообщения не роняют сервер", async () => {
    const room = await createRoom({ lang: "ru" });
    const c = client(room.code);
    await c.open;
    for (const junk of ["null", "[]", "42", '{"type":"vote","side":{"a":1}}', '{"type":"opinion"}', '{"type":"bank","on":{}}', "{not json", '{"type":"host","token":null}']) c.send(junk);
    await sleep(200);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/crowd/api/health`)).json()).ok, true);
    c.close();
  });
});
