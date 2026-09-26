"use strict";

// Тесты сервера бомбы через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `bomb-test-${process.pid}.json`);
const port = 4400 + (process.pid % 500);
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

// ловкость и внимание: решаются по тому, что видит телефон (голову в тестах сервера выключаем)
const SETTINGS = { groups: { hands: true, eyes: true, head: false } };

async function createRoom(settings = {}, speed = 1) {
  const r = await fetch(`http://127.0.0.1:${port}/bomb/api/rooms`, { method: "POST", body: JSON.stringify({ settings: { ...SETTINGS, ...settings }, speed }) });
  return r.json();
}

// Клиент: копит сообщения, умеет ждать нужное
function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bomb/ws?r=${code}`);
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
  c.wait = (pred, ms = 8000) => new Promise((resolve, reject) => {
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
  for (let i = 0; i < 100 && !b.msgs.some((m) => m.type === "host_ok"); i++) await new Promise((r) => setTimeout(r, 30));
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

const statePred = (f) => (m) => (m.type === "state" || m.type === "hello") && m.state && f(m.state);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAD = new Set(["😢", "😭", "🙁", "😞"]);
const unique = (items) => items.findIndex((x) => items.filter((y) => y === x).length === 1);

// Ответ телефона по виду испытания — как решил бы человек
function solveView(c) {
  const v = c.view;
  switch (c.type) {
    case "wires": return { v: v.n };
    case "catch": return { v: v.hits };
    case "swipe": return { v: v.dirs };
    case "order": return { v: Array.from({ length: v.n }, (_, i) => i + 1) };
    case "hold": return { v: Math.round((v.from + v.to) / 2) };
    case "nopress": return { early: false };
    case "color": return { v: v.options.indexOf(v.ink) };
    case "odd": case "letter": return { v: unique(v.items) };
    case "sad": return { v: v.items.findIndex((x) => SAD.has(x)) };
    case "code": return { v: v.digits };
    case "count": return { v: v.options.indexOf(v.items.filter((x) => x === "🦆").length) };
    default: throw new Error("тест не умеет решать " + c.type);
  }
}
const minWait = (c) => (c.type === "nopress" ? c.view.wait : c.type === "code" ? 1400 : c.type === "hold" ? c.view.from : 1000) + 120;

// держатель решает и кидает; возвращает, кому кинул
async function solveAndThrow(p, targets) {
  const m = await p.wait(statePred((s) => s.me && s.me.challenge));
  const c = m.state.me.challenge;
  await sleep(minWait(c));
  p.send({ type: "answer", cid: c.id, ans: solveView(c) });
  await p.wait(statePred((s) => s.me && s.me.armed));
  const to = targets.find((t) => t !== p.id);
  p.send({ type: "pass", to });
  return to;
}

test.before(async () => { try { fs.unlinkSync(DUMP); } catch {} await startServer(); });
test.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

test("раунд: печать до старта, бросок, досрочный конец вскрывает печать", async () => {
  const { code, hostToken } = await createRoom();
  assert.match(code, /^[A-Z]+[2-9]{2}$/);
  const b = await board(code, hostToken);
  const ps = [await player(code, "Аня"), await player(code, "Петя"), await player(code, "Оля")];
  b.send({ type: "start" });
  const cd = await b.wait(statePred((s) => s.phase === "countdown"));
  const commit = cd.state.bombs[0].commit;
  assert.match(commit, /^[0-9a-f]{64}$/);
  assert.strictEqual(cd.state.bombs[0].holder, null, "держатель выбирается после печати");
  const live = await b.wait(statePred((s) => s.phase === "live"), 6000);
  const holderId = live.state.bombs[0].holder;
  const h = ps.find((p) => p.id === holderId);
  const to = await solveAndThrow(h, ps.map((p) => p.id));
  await b.wait(statePred((s) => s.bombs[0].holder === to && s.passes === 1));
  // у другого игрока своё испытание не видно чужим
  const other = ps.find((p) => p.id !== to);
  assert.strictEqual(other.state.me.challenge, null);
  assert.ok(b.state.challenges[to], "доска видит испытание держателя");
  b.send({ type: "end" });
  const fin = await b.wait(statePred((s) => s.phase === "finished"));
  const seal = fin.state.seals[0];
  assert.ok(seal.revealed);
  assert.strictEqual(crypto.createHash("sha256").update(seal.seal).digest("hex"), commit);
  assert.strictEqual(fin.state.finishedReason, "host");
  for (const c of [b, ...ps]) c.close();
});

test("тайна фитиля не уходит ни в одно сообщение до взрыва; взрыв — у держателя", async () => {
  const { code, hostToken } = await createRoom({ fuse: "short" }, 20);
  const b = await board(code, hostToken);
  const ps = [await player(code, "Аня"), await player(code, "Петя")];
  b.send({ type: "start" });
  const fin = await b.wait(statePred((s) => s.phase === "finished"), 15000);
  const seal = fin.state.seals[0];
  const [, , , fuseMs, salt] = seal.seal.split("|");
  for (const c of [b, ...ps]) {
    // снимок с фазой взрыва уходит раньше события boom — граница по тому, что пришло первым
    const boomAt = c.raw.findIndex((r) => r.includes('"type":"boom"') || r.includes('"phase":"boom"'));
    assert.ok(boomAt > 0, "взрыв дошёл");
    const before = c.raw.slice(0, boomAt).join("\n");
    assert.ok(!before.includes(salt), "соль ушла до взрыва");
    assert.ok(!before.includes('"fuseMs"'), "fuseMs ушёл до взрыва");
    assert.ok(!before.includes('"explodeAt"'), "explodeAt ушёл до взрыва");
    assert.ok(!before.includes('"answer"'), "ответ испытания ушёл клиенту");
  }
  assert.ok(Number(fuseMs) >= 20000 && Number(fuseMs) <= 45000);
  const boom = b.events.find((e) => e.type === "boom");
  assert.strictEqual(fin.state.loserId, boom.playerId);
  for (const c of [b, ...ps]) c.close();
});

test("отказы приходят только автору; опоздавший ждёт конца раунда", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  a.send({ type: "start" }); // не ведущий — игнор
  await sleep(200);
  assert.strictEqual(b.state.phase, "lobby");
  b.send({ type: "start" });
  await a.wait(statePred((s) => s.phase === "live"), 6000);
  const holder = [a, p].find((x) => x.id === b.state.bombs[0].holder);
  const other = holder === a ? p : a;
  holder.send({ type: "pass", to: other.id });
  await holder.wait((m) => m.type === "rejected" && m.reason === "not_armed");
  other.send({ type: "pass", to: holder.id });
  await other.wait((m) => m.type === "rejected" && m.reason === "no_bomb");
  assert.ok(!other.msgs.some((m) => m.type === "rejected" && m.reason === "not_armed"));
  const late = client(code);
  await late.open;
  late.send({ type: "join", name: "Опоздун" });
  await late.wait((m) => m.type === "error" && m.error === "game_started");
  b.send({ type: "end" });
  await b.wait(statePred((s) => s.phase === "finished"));
  late.send({ type: "join", name: "Опоздун" });
  await late.wait((m) => m.type === "joined");
  for (const c of [b, a, p, late]) c.close();
});

test("возврат по токену посреди раунда: испытание и бомба на месте", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  b.send({ type: "start" });
  await b.wait(statePred((s) => s.phase === "live"), 6000);
  const holder = [a, p].find((x) => x.id === b.state.bombs[0].holder);
  const cid = (await holder.wait(statePred((s) => s.me && s.me.challenge))).state.me.challenge.id;
  holder.close();
  await sleep(100);
  const back = await player(code, "", holder.token);
  assert.strictEqual(back.id, holder.id);
  const m = await back.wait(statePred((s) => s.me && s.me.challenge));
  assert.strictEqual(m.state.me.challenge.id, cid);
  assert.deepStrictEqual(m.state.me.holding, [0]);
  b.send({ type: "end" });
  for (const c of [b, a, p, back]) c.close();
});

test("перезапуск посреди раунда: печать та же, бомба у того же, взрыв по прежнему сроку", async () => {
  const { code, hostToken } = await createRoom();
  let b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const p = await player(code, "Петя");
  b.send({ type: "start" });
  const live = await b.wait(statePred((s) => s.phase === "live"), 6000);
  const { commit, holder } = live.state.bombs[0];
  for (const c of [b, a, p]) c.close();
  await stopServer();
  const dump = JSON.parse(fs.readFileSync(DUMP, "utf8"));
  assert.ok(dump.some((r) => r.code === code), "комната в дампе");
  await startServer();
  b = await board(code, hostToken);
  const again = await b.wait(statePred((s) => s.phase === "live"));
  assert.strictEqual(again.state.bombs[0].commit, commit);
  assert.strictEqual(again.state.bombs[0].holder, holder);
  b.send({ type: "end" });
  const fin = await b.wait(statePred((s) => s.phase === "finished"));
  assert.strictEqual(crypto.createHash("sha256").update(fin.state.seals[0].seal).digest("hex"), commit);
  b.close();
});

test("чужой токен ведущего не даёт управлять, несуществующая комната — 404", async () => {
  const { code } = await createRoom();
  const fake = client(code);
  await fake.open;
  fake.send({ type: "host", token: "nope" });
  await fake.wait((m) => m.type === "error" && m.error === "bad host token");
  fake.close();
  const r = await fetch(`http://127.0.0.1:${port}/bomb/api/session?r=NOPE99`);
  assert.strictEqual(r.status, 404);
  const h = await fetch(`http://127.0.0.1:${port}/bomb/api/health`);
  assert.strictEqual(h.status, 200);
});
