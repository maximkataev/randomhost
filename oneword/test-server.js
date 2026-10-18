"use strict";

// Тесты сервера «Сто к одному» через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `oneword-test-${process.pid}.json`);
const CDIR = fs.mkdtempSync(path.join(os.tmpdir(), "oneword-content-"));
let port = 0;
let proc = null;
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require("node:net").createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

// синтетический банк: серверу нужно ≥ 4 темы
for (const lang of ["ru", "en", "el"]) {
  const topics = Array.from({ length: 20 }, (_, i) => ({ id: lang + "-" + i, topic: "Тема " + i }));
  fs.writeFileSync(path.join(CDIR, lang + ".json"), JSON.stringify({ topics }));
}

async function startServer(env = {}) {
  if (!port) port = await freePort();
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, CONTENT_DIR: CDIR, OFFLINE_GRACE_MS: "300", ANON_TTL_MS: "1500", ...env },
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
  const r = await fetch(`http://127.0.0.1:${port}/oneword/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}

function client(code, headers = {}, query = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/oneword/ws?r=${code}${query}`, { headers });
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
  const j = await p.wait((m) => m.type === "joined" || m.type === "error");
  if (j.type === "error") throw new Error("join failed: " + j.error);
  p.id = j.playerId;
  p.token = j.token;
  return p;
}

const statePred = (f) => (m) => (m.type === "state" || m.type === "hello") && m.state && f(m.state);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("сервер", async (t) => {
  await startServer();
  t.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

  await t.test("раунд: чужие ответы и guess'ы не утекают до раскрытия, потом очки считаются", async () => {
    const room = await createRoom({ lang: "ru", rounds: 4 });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася"), await player(room.code, "Коля")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "answer"));
    ps[0].send({ type: "answer", word: "банан" });
    ps[1].send({ type: "answer", word: "банан" });
    ps[2].send({ type: "answer", word: "киви" });
    ps[3].send({ type: "answer", word: "манго" });
    await b.wait(statePred((s) => s.phase === "guessPopular"));
    for (const p of ps) p.send({ type: "guessPopular", word: "банан" });
    await b.wait(statePred((s) => s.phase === "guessRare"));
    for (const p of ps) p.send({ type: "guessRare", word: "манго" });
    await b.wait(statePred((s) => s.phase === "reveal"));
    // до reveal ни в одном сообщении доски и чужих телефонов не было чужих слов/кластеров
    const leaked = (c) => c.raw.slice(0, c.raw.findIndex((x) => x.includes('"phase":"reveal"'))).some((x) => /"clusters"|"popularPts"|"rarePts"/.test(x));
    assert.ok(!leaked(b), "доска видела тайны до раскрытия");
    assert.ok(!leaked(ps[1]), "чужой телефон видел тайны до раскрытия");
    const round = b.state.round;
    assert.strictEqual(round.n, 4);
    const bananaCluster = round.clusters.find((c) => c.key === "банан");
    assert.strictEqual(bananaCluster.count, 2);
    for (const p of ps) {
      assert.strictEqual(round.popularPts[p.id], 2); // «банан» — 2 игрока
      assert.strictEqual(round.rarePts[p.id], 4 - 1); // «манго» уникален, N−1 = 3
    }
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("фаза закрывается досрочно, когда ответили все подключённые; лимит команд в секунду", async () => {
    const room = await createRoom({ lang: "ru", rounds: 4 });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "А"), await player(room.code, "Б"), await player(room.code, "В")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "answer"));
    for (const p of ps) p.send({ type: "answer", word: "слово" });
    await b.wait(statePred((s) => s.phase === "guessPopular"), 2000);
    // флуд guess'ами: сверх CMD_RATE (5/с) молча отбрасывается, снимки не распухают
    const n = ps[1].raw.length;
    for (let i = 0; i < 30; i++) ps[0].send({ type: "guessPopular", word: "слово" + i });
    await sleep(300);
    assert.ok(ps[1].raw.length - n < 8, "флуд не раздувает рассылку: " + (ps[1].raw.length - n));
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

  await t.test("ввод: два слова → первое, сотни символов → обрезка, одни знаки → rejected bad_word, греческий с тонами кластерится", async () => {
    const room = await createRoom({ lang: "el", rounds: 4 });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "answer"));
    ps[0].send({ type: "answer", word: "!!!" });
    const rej = await ps[0].wait((m) => m.type === "rejected");
    assert.strictEqual(rej.reason, "bad_word");
    ps[0].send({ type: "answer", word: "Μήλο κόκκινο" }); // два слова: берётся первое
    ps[1].send({ type: "answer", word: "μηλο" });
    ps[2].send({ type: "answer", word: "я".repeat(500) }); // сотни символов: режется до WORD_MAX
    await b.wait(statePred((s) => s.phase === "guessPopular"));
    for (const p of ps) p.send({ type: "guessPopular", word: "ΜΉΛΟ" });
    await b.wait(statePred((s) => s.phase === "guessRare"));
    for (const p of ps) p.send({ type: "guessRare", word: "μηλο" });
    await b.wait(statePred((s) => s.phase === "reveal"));
    const round = b.state.round;
    const apple = round.clusters.find((c) => c.key === "μηλο");
    assert.strictEqual(apple.count, 2);
    assert.strictEqual(apple.sample, "Μήλο");
    const long = round.clusters.find((c) => c.key.startsWith("я"));
    assert.ok(long.sample.length <= 24, "слово обрезано: " + long.sample.length);
    assert.strictEqual(round.popularPts[ps[0].id], 2);
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("анонимный сокет без входа закрывается по ANON_TTL_MS", async () => {
    const room = await createRoom({ lang: "ru" });
    const a = client(room.code);
    await a.open;
    const closed = await Promise.race([a.closed.then(() => true), sleep(6000).then(() => false)]);
    assert.ok(closed, "аноним не держит место в комнате");
  });

  await t.test("подхват по имени: не посреди раунда (секретные фазы)", async () => {
    const room = await createRoom({ lang: "ru", rounds: 4 });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "answer"));
    ps[0].send({ type: "answer", word: "секрет" });
    await ps[0].wait(statePred((s) => s.me && s.me.answerConfirmed === true));
    ps[0].close();
    await sleep(80);
    const thief = client(room.code);
    await thief.open;
    thief.send({ type: "join", name: "Оля" });
    const r = await thief.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.error, "name_taken");
    assert.ok(!thief.raw.some((x) => x.includes('"секрет"')), "вор не видел чужой ответ");
    const back = await player(room.code, "", ps[0].token);
    assert.strictEqual(back.id, ps[0].id);
    await back.wait(statePred((s) => s.me && s.me.answerConfirmed === true)); // вернувшийся видит свой ответ
    thief.close(); b.close(); back.close(); ps.slice(1).forEach((p) => p.close());
  });

  await t.test("рестарт посреди раунда: ответы сохранены, вернувшийся не закрывает фазу за остальных", async () => {
    const room = await createRoom({ lang: "ru", rounds: 4 });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "А"), await player(room.code, "Б"), await player(room.code, "В")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "answer"));
    ps[0].send({ type: "answer", word: "один" });
    await ps[0].wait(statePred((s) => s.me && s.me.answerConfirmed === true));
    await sleep(60); // дамп раз в 5 с в проде — здесь форсируем через рестарт процесса
    await stopServer();
    await startServer();
    const b2 = client(room.code);
    await b2.open;
    b2.send({ type: "host", token: room.hostToken });
    await b2.wait((m) => m.type === "host_ok");
    assert.strictEqual(b2.state.phase, "answer");
    const p0 = client(room.code);
    await p0.open;
    p0.send({ type: "join", name: "", token: ps[0].token });
    const j0 = await p0.wait((m) => m.type === "joined");
    assert.strictEqual(j0.playerId, ps[0].id);
    b2.close(); p0.close(); ps.forEach((p) => p.close());
  });

  await t.test("партия идёт до конца и завершается, доска и игроки видят финал", async () => {
    const room = await createRoom({ lang: "ru", rounds: 4 }, 6); // speed > 1 (только dev) — таймеры ускорены; rounds:4 — минимум clampSettings
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "А"), await player(room.code, "Б"), await player(room.code, "В")];
    b.send({ type: "start" });
    for (let round = 0; round < 4; round++) {
      await b.wait(statePred((s) => s.phase === "answer"));
      for (const p of ps) p.send({ type: "answer", word: "слово" + round });
      await b.wait(statePred((s) => s.phase === "guessPopular"));
      for (const p of ps) p.send({ type: "guessPopular", word: "слово" + round });
      await b.wait(statePred((s) => s.phase === "guessRare"));
      for (const p of ps) p.send({ type: "guessRare", word: "слово" + round });
    }
    await b.wait(statePred((s) => s.phase === "finished"), 15000);
    assert.ok(b.state.players.every((p) => p.score > 0));
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("health отвечает ok", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/oneword/api/health`);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
  });
});
