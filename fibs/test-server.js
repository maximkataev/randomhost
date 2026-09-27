"use strict";

// Тесты сервера «Не верю!» через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `fibs-test-${process.pid}.json`);
const port = 5400 + (process.pid % 500);
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

async function createRoom(settings = {}, speed = 1) {
  const r = await fetch(`http://127.0.0.1:${port}/fibs/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}

function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fibs/ws?r=${code}`);
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

// ведёт партию до конца: тема — первая, ложь — уникальная, правда — первый не свой вариант
async function playThrough(b, ps, { lie = (p, n) => `выдумка ${p.id} ${n}` } = {}) {
  let guard = 0, n = 0;
  while (guard++ < 300) {
    const s = b.state;
    if (s.phase === "finished") return;
    for (const p of ps) {
      const st = p.state;
      if (!st || !st.me) continue;
      if (st.phase === "topic" && st.me.chooser && !p.sentTopic) { p.sentTopic = st.fi + ":" + st.ri; p.send({ type: "topic", topic: st.topics[0] }); }
      if (st.phase === "lie" && st.me.inRound && !st.me.lie && p.sentLie !== st.ri + ":" + st.fi) { p.sentLie = st.ri + ":" + st.fi; p.send({ type: "lie", text: lie(p, ++n) }); }
      if (st.phase === "choose" && st.options && !st.me.picks && p.sentPick !== st.ri + ":" + st.fi) {
        p.sentPick = st.ri + ":" + st.fi;
        const i = st.options.findIndex((o) => !o.mine);
        p.send({ type: "choose", picks: [i] });
      }
      if (st.phase !== "topic") p.sentTopic = null;
    }
    await sleep(150);
  }
}

test.before(async () => { try { fs.unlinkSync(DUMP); } catch {} await startServer(); });
test.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

test("банк фактов загружен на всех языках", async () => {
  const r = await (await fetch(`http://127.0.0.1:${port}/fibs/api/health`)).json();
  assert.ok(r.ok);
  const C = require("./content");
  for (const lang of ["ru", "en", "el"]) {
    assert.ok(C[lang].filter((f) => !f.final).length > 0, `${lang}: нет обычных фактов`);
    assert.ok(C[lang].filter((f) => f.final).length > 0, `${lang}: нет финальных фактов`);
  }
});

test("партия втроём до конца; правда, авторы, ловушки и пул лжи не утекают до раскрытия", async () => {
  const room = await createRoom({ short: true }, 20);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "Аня"), await player(room.code, "Боря"), await player(room.code, "Вика")];
  b.send({ type: "start" });
  await playThrough(b, ps);
  assert.strictEqual(b.state.phase, "finished");
  assert.ok(b.state.players.reduce((a, p) => a + p.score, 0) > 0, "очки начислены");
  const C = require("./content");
  const byText = new Map(C.ru.map((f) => [f.text, f]));
  for (const c of [b, ...ps]) {
    for (const raw of c.raw) {
      assert.ok(!raw.includes('"pool"') && !raw.includes('"alts"') && !raw.includes('"key"'), "служебное поле утекло");
      const msg = JSON.parse(raw);
      const s = msg.state;
      if (!s || !s.fact) continue;
      const f = byText.get(s.fact.text);
      if (s.phase === "lie" || s.phase === "choose" || s.phase === "topic") {
        assert.strictEqual(s.truth, null, "правда до раскрытия");
        if (s.options) for (const o of s.options) assert.deepStrictEqual(Object.keys(o).filter((k) => k !== "text" && k !== "mine"), [], "у варианта лишние поля до раскрытия");
        // в фазе лжи правды нет нигде в сообщении
        if (f && s.phase === "lie") assert.ok(!raw.includes(JSON.stringify(f.answer).slice(1, -1)) || s.fact.text.includes(f.answer), "ответ в сообщении фазы лжи");
      }
    }
  }
  for (const c of [b, ...ps]) c.close();
});

test("вписанная правда отклоняется только автору; мусорные сообщения не роняют сервер", async () => {
  const room = await createRoom({}, 1);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "A"), await player(room.code, "B"), await player(room.code, "C")];
  b.send({ type: "start" });
  // выбирающий тему выбирает, дальше фаза лжи
  const t = await Promise.race(ps.map((p) => p.wait(statePred((s) => s.phase === "topic" && s.me && s.me.chooser)).then(() => p)));
  t.send({ type: "topic", topic: t.state.topics[0] });
  await ps[0].wait(statePred((s) => s.phase === "lie"));
  const C = require("./content");
  const f = C.ru.find((x) => x.text === ps[0].state.fact.text);
  const before = ps[1].msgs.length;
  ps[0].send({ type: "lie", text: f.answer });
  const rj = await ps[0].wait((x) => x.type === "rejected" && x.action === "lie");
  assert.strictEqual(rj.reason, "truth");
  await sleep(200);
  assert.ok(!ps[1].msgs.slice(before).some((x) => x.type === "rejected"), "отказ ушёл не тому");
  ps[1].send("not json");
  ps[1].send({ type: "lie", text: { evil: true } });
  ps[1].send({ type: "lie", text: "x".repeat(5000) });
  ps[1].send({ type: "choose", picks: "0,1" });
  ps[1].send({ type: "like", opt: { $gt: 1 } });
  ps[1].send({ type: "topic", topic: ["a"] });
  ps[1].send({ type: "start" });
  ps[1].send({ type: "settings", settings: { hints: 99 } });
  ps[1].send({ type: "kick", playerId: ps[0].id });
  ps[1].send({ type: "__proto__" });
  ps[1].send(null);
  ps[1].send(42);
  await sleep(300);
  const h = await (await fetch(`http://127.0.0.1:${port}/fibs/api/health`)).json();
  assert.ok(h.ok, "сервер жив");
  assert.ok(b.state.players.some((p) => p.id === ps[0].id && !p.left), "игрок не кикнут чужими руками");
  assert.strictEqual(b.state.settings.hints, 2);
  // длинная ложь обрезана до 25 символов
  const mine = ps[1].state.me.lie;
  if (mine) assert.ok(Array.from(mine.text).length <= 25);
  const big = client(room.code);
  await big.open;
  big.send({ type: "join", name: "x".repeat(20000) });
  await big.closed;
  assert.ok((await (await fetch(`http://127.0.0.1:${port}/fibs/api/health`)).json()).ok);
  for (const c of [b, ...ps]) c.close();
});

test("HTML во лжи — просто текст: сервер хранит как есть", async () => {
  const room = await createRoom({ short: true }, 20);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "A"), await player(room.code, "B"), await player(room.code, "C")];
  b.send({ type: "start" });
  const evil = `<img src=x onerror=1>`;
  playThrough(b, ps, { lie: (p, n) => (evil + n).slice(0, 25) });
  const v = await b.wait(statePred((s) => s.phase === "choose" && s.options), 20000);
  assert.ok(v.state.options.some((o) => o.text.startsWith("<img")), "текст дошёл как есть (экранирует клиент)");
  await b.wait(statePred((s) => s.phase === "finished"), 60000);
  for (const c of [b, ...ps]) c.close();
});

test("возврат по токену посреди фазы лжи: своя ложь на месте", async () => {
  const room = await createRoom({}, 1);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "A"), await player(room.code, "B"), await player(room.code, "C")];
  b.send({ type: "start" });
  const t = await Promise.race(ps.map((p) => p.wait(statePred((s) => s.phase === "topic" && s.me && s.me.chooser)).then(() => p)));
  t.send({ type: "topic", topic: t.state.topics[0] });
  await ps[0].wait(statePred((s) => s.phase === "lie"));
  ps[0].send({ type: "lie", text: "моя выдумка" });
  await ps[0].wait(statePred((s) => s.me && s.me.lie));
  ps[0].close();
  await sleep(100);
  const back = await player(room.code, "", ps[0].token);
  assert.strictEqual(back.id, ps[0].id);
  const again = await back.wait(statePred((s) => s.phase === "lie" && s.me));
  assert.strictEqual(again.state.me.lie.text, "моя выдумка");
  for (const c of [b, back, ...ps.slice(1)]) c.close();
});

test("перезапуск посреди выбора: варианты и выбор на месте", async () => {
  const room = await createRoom({}, 1);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "A"), await player(room.code, "B"), await player(room.code, "C")];
  b.send({ type: "start" });
  const t = await Promise.race(ps.map((p) => p.wait(statePred((s) => s.phase === "topic" && s.me && s.me.chooser)).then(() => p)));
  t.send({ type: "topic", topic: t.state.topics[0] });
  for (const p of ps) { await p.wait(statePred((s) => s.phase === "lie")); p.send({ type: "lie", text: "ложь " + p.id }); }
  const v = await b.wait(statePred((s) => s.phase === "choose" && s.options));
  const before = v.state.options.map((o) => o.text);
  const pv = await ps[0].wait(statePred((s) => s.phase === "choose" && s.options));
  const i = pv.state.options.findIndex((o) => !o.mine);
  ps[0].send({ type: "choose", picks: [i] });
  await ps[0].wait(statePred((s) => s.me && s.me.picks));
  await sleep(5500); // дамп раз в 5 с
  for (const c of [b, ...ps]) c.close();
  await stopServer();
  await startServer();
  const b2 = await board(room.code, room.hostToken);
  const s = await b2.wait(statePred((x) => x.phase === "choose" || x.phase === "reveal"));
  assert.deepStrictEqual(s.state.options.map((o) => o.text), before);
  const back = await player(room.code, "", ps[0].token);
  const st = await back.wait(statePred((x) => x.me));
  if (st.state.phase === "choose") assert.deepStrictEqual(st.state.me.picks, [i]);
  b2.close(); back.close();
});

test("чужой токен ведущего не даёт управлять, несуществующая комната — 404", async () => {
  const room = await createRoom({}, 1);
  const fake = client(room.code);
  await fake.open;
  fake.send({ type: "host", token: "nope" });
  await fake.wait((m) => m.type === "error");
  fake.send({ type: "start" });
  await sleep(200);
  assert.strictEqual(fake.state.phase, "lobby");
  fake.close();
  const r = await fetch(`http://127.0.0.1:${port}/fibs/api/session?r=NOPE22`);
  assert.strictEqual(r.status, 404);
});
