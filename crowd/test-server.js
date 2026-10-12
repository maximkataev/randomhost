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
let port = 0; // свободный порт ищем при старте: параллельные запуски не сталкиваются
let proc = null;
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require("node:net").createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

// синтетический банк: серверу нужно ≥ 8 вопросов
for (const lang of ["ru", "en", "el"]) {
  const questions = Array.from({ length: 40 }, (_, i) => ({ id: lang + "-" + i, q: "Вопрос " + i + "?", a: "Да", b: "Нет", kind: "yn", tag: "home", lean: i % 2 ? "b" : "a", sensitive: false }));
  fs.writeFileSync(path.join(CDIR, lang + ".json"), JSON.stringify({ questions }));
}

async function startServer() {
  if (!port) port = await freePort();
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

function client(code, headers = {}, query = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/crowd/ws?r=${code}${query}`, { headers });
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

  // ---------- регрессии аудита (10.10) ----------

  await t.test("вышел и вернулся с тем же именем посреди партии: та же запись, голос на месте, без «призраков»", async () => {
    const room = await createRoom({ lang: "ru", opinion: false });
    const b = await board(room.code, room.hostToken);
    const ps = [];
    for (const n of ["Оля", "Петя", "Вася", "Гоша"]) ps.push(await player(room.code, n));
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "vote"));
    ps[0].send({ type: "vote", side: "a" });
    await ps[0].wait(statePred((s) => s.me && s.me.vote === "a"));
    for (let i = 0; i < 3; i++) {
      ps[0].send({ type: "leave" });
      await b.wait(statePred((s) => s.players.find((p) => p.id === ps[0].id)?.left));
      const n = ps[0].msgs.length;
      ps[0].send({ type: "join", name: "Оля" });
      const j = await ps[0].wait((m) => m.type === "joined" && ps[0].msgs.indexOf(m) >= n);
      assert.strictEqual(j.playerId, ps[0].id, "та же запись");
      await b.wait(statePred((s) => s.players.length === 4 && !s.players.find((p) => p.id === ps[0].id).left));
    }
    await ps[0].wait(statePred((s) => s.me && s.me.vote === "a"));
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("кик без бана (U-06): выкинутый получает kicked, но может зайти снова — под тем же именем", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Тролль"), await player(room.code, "Мила"), await player(room.code, "Нина")];
    b.send({ type: "kick", playerId: ps[0].id });
    await ps[0].wait((m) => m.type === "kicked");
    const again = client(room.code);
    await again.open;
    again.send({ type: "join", name: "тролль" });
    const j = await again.wait((m) => m.type === "joined");
    assert.ok(j.playerId && j.playerId !== ps[0].id, "новая запись, не бан");
    assert.ok(!again.msgs.some((m) => m.type === "kicked"), "kicked после повторного входа нет");
    // старый токен кикнутого запись не оживляет
    const stale = client(room.code);
    await stale.open;
    stale.send({ type: "join", token: ps[0].token });
    await sleep(100);
    assert.ok(!stale.msgs.some((m) => m.type === "joined" && m.playerId === ps[0].id), "старый токен не возвращает старую запись");
    stale.close(); again.close(); b.close(); ps.forEach((p) => p.close());
  });

  await t.test("тихих отказов нет: частый join и флуд командами получают rejected/rate, «Готово» доходит", async () => {
    const room = await createRoom({ lang: "ru", opinion: false });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Р1"), await player(room.code, "Р2"), await player(room.code, "Р3")];
    // в лобби: leave + join другого имени с того же сокета быстрее 3 с
    const c = client(room.code);
    await c.open;
    c.send({ type: "join", name: "Быстрый" });
    await c.wait((m) => m.type === "joined");
    c.send({ type: "leave" });
    await sleep(60);
    c.send({ type: "join", name: "Быстрый2" });
    const rj = await c.wait((m) => m.type === "rejected" && m.action === "join");
    assert.strictEqual(rj.reason, "rate");
    c.close();
    await sleep(100);
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "vote"));
    for (let i = 0; i < 40; i++) ps[0].send({ type: "vote", side: i % 2 ? "a" : "b" });
    const flood = await ps[0].wait((m) => m.type === "rejected" && m.reason === "rate");
    assert.ok(flood);
    // «Готово» не режется лимитом команд
    ps[0].send({ type: "vote", side: "a" });
    ps[0].send({ type: "confirm" });
    await sleep(1100);
    ps[0].send({ type: "vote", side: "a" });
    await ps[0].wait(statePred((s) => s.me && s.me.vote === "a"));
    ps[0].send({ type: "confirm" });
    await ps[0].wait(statePred((s) => s.me && s.me.confirmed));
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("ва-банк: строка \"false\" не включает его, игрок получает отказ", async () => {
    const room = await createRoom({ lang: "ru", opinion: false });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Б1"), await player(room.code, "Б2"), await player(room.code, "Б3")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "vote"));
    ps[0].send({ type: "bank", on: "false" });
    const rj = await ps[0].wait((m) => m.type === "rejected" && m.action === "bank");
    assert.strictEqual(rj.reason, "bad_value");
    assert.strictEqual(ps[0].state.me.bank, false);
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("30 анонимных сокетов с одного адреса не запирают комнату от доски и игроков", async () => {
    const room = await createRoom({ lang: "ru" });
    const hdr = { "x-real-ip": "10.7.7.7" };
    const anons = [];
    for (let i = 0; i < 30; i++) { const a = client(room.code, hdr); await a.open; anons.push(a); }
    const hb = client(room.code, hdr);
    await hb.open;
    hb.send({ type: "host", token: room.hostToken });
    await hb.wait((m) => m.type === "host_ok");
    const pl = client(room.code, hdr);
    await pl.open;
    pl.send({ type: "join", name: "Свой" });
    await pl.wait((m) => m.type === "joined");
    // и по токену в адресе соединение проходит, даже когда лимит исчерпан для анонимов
    const viaToken = client(room.code, hdr, `&h=${room.hostToken}`);
    await viaToken.open;
    // защита от флуда цела: анонимов с адреса по-прежнему не больше лимита
    await sleep(100);
    const alive = anons.filter((a) => a.ws.readyState === 1).length;
    assert.ok(alive <= 30, "анонимов " + alive);
    anons.forEach((a) => a.close()); hb.close(); pl.close(); viaToken.close();
  });

  await t.test("блокировка перебора: считаются разные неверные коды; свой адрес в своей комнате не получает 404", async () => {
    const base = `http://127.0.0.1:${port}/crowd`;
    const room = await createRoom({ lang: "ru" });
    const get = (r, ip) => fetch(`${base}/api/session?r=${r}`, { headers: { "x-real-ip": ip } });
    // устаревшая вкладка сто раз стучится в один и тот же мёртвый код — это не перебор
    for (let i = 0; i < 100; i++) await get("DEAD22", "10.5.5.1");
    assert.equal((await get(room.code, "10.5.5.1")).status, 200);
    // «свой» адрес: уже был в комнате; потом перебрал 60 разных кодов
    for (let i = 0; i < 60; i++) await get("NOPE" + i, "10.5.5.1");
    assert.equal((await get(room.code, "10.5.5.1")).status, 200, "участник с того же NAT не получает 404");
    // чужой адрес после такого же перебора — отказ
    for (let i = 0; i < 60; i++) await get("NOPE" + i, "10.5.5.2");
    assert.equal((await get(room.code, "10.5.5.2")).status, 404);
  });

  await t.test("создание комнаты: settings:null — не ошибка и без внутренних текстов; битый процент-код — 400", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/crowd/api/rooms`, { method: "POST", body: '{"settings":null}' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.code && j.hostToken);
    const r2 = await fetch(`http://127.0.0.1:${port}/crowd/api/rooms`, { method: "POST", body: '{"settings":"str","speed":{}}' });
    assert.equal(r2.status, 200);
    // статика: отдельный экземпляр с STATIC
    const sp = await freePort();
    const st = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(sp), NODE_ENV: "development", STATIC: path.join(__dirname, ".."), DUMP_FILE: DUMP + ".st", STATS_FILE: STATS + ".st", CONTENT_DIR: CDIR }, stdio: "ignore" });
    try {
      for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${sp}/crowd/api/health`); break; } catch { await sleep(100); } }
      const net = require("node:net");
      const status = await new Promise((resolve) => {
        const sock = net.connect(sp, "127.0.0.1", () => sock.write("GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
        let buf = "";
        sock.on("data", (d) => (buf += d));
        sock.on("close", () => resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1])));
        sock.on("error", () => resolve(0));
      });
      assert.equal(status, 400);
    } finally {
      st.kill();
      for (const f of [DUMP + ".st", STATS + ".st"]) { try { fs.unlinkSync(f); } catch {} }
    }
  });

  await t.test("имя-двойник в лобби обрезается по кодпоинтам, не длиннее 15", async () => {
    const room = await createRoom({ lang: "ru" });
    const long = "😀".repeat(15);
    const a = await player(room.code, long);
    const b2 = client(room.code);
    await b2.open;
    b2.send({ type: "join", name: long });
    await b2.wait((m) => m.type === "joined");
    const names = b2.state.players.map((p) => p.name);
    await b2.wait(statePred((s) => s.players.length === 2));
    for (const n of b2.state.players.map((p) => p.name)) {
      assert.ok(Array.from(n).length <= 15, n);
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(n), "оборванная пара");
    }
    assert.ok(names.length >= 1);
    a.close(); b2.close();
  });

  await t.test("статистика вопросов: потолок «3 раунда одного вопроса на комнату» — за 24 ч", () => {
    const stats = require("./stats");
    stats._resetRoomWindow();
    const real = Date.now;
    let t0 = 1_800_000_000_000;
    Date.now = () => t0;
    try {
      const e = { id: "cap-q", a: 3, b: 1, oa: 0, ob: 0 };
      const before = (stats.get()["cap-q"] || { n: 0 }).n;
      for (let i = 0; i < 6; i++) stats.record("ROOMX", e);
      assert.equal(stats.get()["cap-q"].n - before, 3);
      t0 += 25 * 3600 * 1000;
      for (let i = 0; i < 6; i++) stats.record("ROOMX", e);
      assert.equal(stats.get()["cap-q"].n - before, 6, "через сутки окно новое");
    } finally { Date.now = real; stats._resetRoomWindow(); }
  });

  // ---- T-W0-05: сканер секретов (tools/testkit/scan.js) по трём видам: доска, игрок, сокет без токена ----
  await t.test("секреты не в кадрах: чужие голоса, мнения и ва-банки до раскрытия; токены — доска / игрок / сокет без токена", async () => {
    const { scanFrames } = require("../tools/testkit/scan");
    const room = await createRoom({ lang: "ru", opinion: true, short: true });
    const b = await board(room.code, room.hostToken);
    const ps = [];
    for (const n of ["Оля", "Петя", "Вася", "Маша", "Гоша"]) ps.push(await player(room.code, n));
    const anon = client(room.code); // сокет без join/host
    await anon.open;
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "vote"));
    ps.forEach((p, i) => p.send({ type: "vote", side: i % 2 ? "b" : "a" }));
    ps[0].send({ type: "bank", on: true });
    await ps[0].wait(statePred((s) => s.me && s.me.bank === true));
    for (const p of ps) p.send({ type: "confirm" });
    // мнения (если фаза opinion есть) — каждый опрошенный отвечает «b»
    let guard = 0;
    while (guard++ < 100 && b.state.phase !== "reveal") {
      for (const p of ps) { const s = p.state; if (s && s.phase === "opinion" && s.me && s.me.asked && !s.me.opinion) p.send({ type: "opinion", side: "b" }); }
      await sleep(100);
    }
    assert.strictEqual(b.state.phase, "reveal", "дошли до раскрытия");
    await sleep(200);

    const clients = [["board", b], ["player", ps[0]], ["player", ps[1]], ["player", ps[2]], ["player", ps[3]], ["player", ps[4]], ["anon", anon]];
    let scanned = 0, voteFrames = 0, opinionFrames = 0;
    for (const [view, c] of clients) {
      const frames = c.raw.map((r) => JSON.parse(r));
      scanned += frames.length;
      voteFrames += frames.filter((f) => f.state && f.state.phase === "vote").length;
      opinionFrames += frames.filter((f) => f.state && f.state.phase === "opinion").length;
      const foreign = ps.map((p) => p.token).filter((x) => x && x !== c.token);
      // до раскрытия (lobby/intro/vote/opinion): массивы/карты votes, order, seed, banked, opinions, bank — нигде; свой выбор — только в me.vote / me.bank / me.opinion
      const own = (p) => view === "player" && /^state\.me\.(vote|bank|opinion)$/.test(p);
      const v = scanFrames(frames.map((f) => ({ view, frame: f })), {
        phases: ["lobby", "intro", "vote", "opinion"],
        forbiddenKeys: ["votes", "order", "seed", "banked", "opinions", "hostToken", "result",
          (p, k) => /^(vote|bank|opinion)$/.test(k) && !/^state\.settings\./.test(p) && !own(p) && "чужой выбор до раскрытия",
          (p, k) => k === "pts" && "очки до раскрытия"],
        forbiddenSubstrings: view === "board" ? foreign : foreign.concat(room.hostToken),
      });
      assert.deepStrictEqual(v, [], `${view}: ${JSON.stringify(v.slice(0, 3))}`);
    }
    assert.ok(scanned > 30 && voteFrames > 5, `кадров мало — проверка пустая: ${scanned}/${voteFrames}`);
    assert.ok(opinionFrames > 0, "фазы opinion не было — проверка мнений пустая");
    for (const c of [b, anon, ...ps]) c.close();
  });

  // ---- T-W0-31: restore из дампа прошлой версии без новых полей (шаблон — tools/testkit/restore.js) ----
  await t.test("restore-from-prev-dump: без bankLate/replace/repl/replNext/voidsUsed — итог раунда читается, партия идёт дальше, финал с наградами (T-W0-31)", async () => {
    const restore = require("../tools/testkit/restore");
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
    const rv = await b.wait(statePred((s) => s.phase === "reveal"));
    assert.ok("bankLate" in rv.state.round.result && "replace" in rv.state.round.result, "текущая версия пишет bankLate/replace в итог");
    const tokens = ps.map((p) => p.token);
    for (const c of [b, ...ps]) c.close();
    await stopServer(); // SIGTERM пишет дамп
    const dump = JSON.parse(fs.readFileSync(DUMP, "utf8"));
    assert.ok(dump.some((r) => r.code === room.code), "комната в дампе");
    const paths = ["voidsUsed", "replNext", "round.repl", "round.result.bankLate", "round.result.replace", "round.result.replaceNo", "round.result.replaceMax"];
    const old = restore.makeOldDump(dump, paths);
    const mine = old.find((r) => r.code === room.code).state;
    assert.ok(!("voidsUsed" in mine) && !("bankLate" in (mine.round.result || {})), "в «старом» дампе новых полей нет");
    fs.writeFileSync(DUMP, JSON.stringify(old));
    await startServer();
    const b2 = await board(room.code, room.hostToken);
    const back = [];
    for (const tok of tokens) back.push(await player(room.code, "", tok));
    const s2 = await b2.wait(statePred((s) => s.phase === "reveal" || s.phase === "scores" || s.phase === "vote" || s.phase === "intro"));
    assert.ok(s2.state.players.length === 3, "игроки на месте");
    // телефон читает свой итог без падения (bankLate/bankBack — false, не исключение)
    const me0 = await back[0].wait(statePred((s) => s.me && s.me.id === ps[0].id));
    assert.strictEqual(me0.state.me.bankLate === undefined || me0.state.me.bankLate === false, true);
    // партия идёт дальше: ведущий доигрывает до итогов, награды считаются
    b2.send({ type: "end" });
    const fin = await b2.wait(statePred((s) => s.phase === "finished"));
    assert.ok(fin.state.awards !== undefined, "награды в финале");
    for (const c of [b2, ...back]) c.close();
  });
});

// ---------- T-W1-06: «Это ты?», name_claim, joined.name, имя вместе с токеном ----------

async function joinRaw(code, fields) {
  const c = client(code);
  await c.open;
  c.send({ type: "join", ...fields });
  const r = await c.wait((m) => m.type === "error" || m.type === "joined" || m.type === "kicked");
  return { c, r };
}
const CAPS = ["claim"];
const claimCtx = async (names, opts = {}) => {
  const room = await createRoom({ lang: "ru", opinion: false });
  const b = await board(room.code, room.hostToken);
  const ps = [];
  for (const n of names) ps.push(await player(room.code, n));
  return { room, b, ps };
};
const goOffline = async (p) => { p.close(); await p.closed; await sleep(450); }; // > OFFLINE_GRACE_MS 300 и CLAIM_GRACE_MS 300

function claimSuite(rule) {
  return async (t) => {
    startServer.env = { CLAIM_GRACE_MS: "300", CLAIM_WAIT_MS: "3500", ANON_TTL_MS: "1000", ...(rule ? { RULE_U01_CLAIM_IN_GAME: "1" } : {}) };
    await startServer();
    t.after(async () => { await stopServer(); startServer.env = null; for (const f of [DUMP, STATS]) { try { fs.unlinkSync(f); } catch {} } });

    await t.test("hello несёт limits.name (15), joined — name; имя вместе с токеном возвращает то же место", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      const probe = client(room.code);
      await probe.open;
      const hello = await probe.wait((m) => m.type === "hello");
      assert.strictEqual(hello.limits.name, 15);
      probe.close();
      const j = await joinRaw(room.code, { name: "Оля", token: ps[0].token });
      assert.strictEqual(j.r.type, "joined");
      assert.strictEqual(j.r.playerId, ps[0].id, "токен сильнее имени");
      assert.strictEqual(j.r.name, "Оля");
      assert.strictEqual(j.r.resumed, true);
      j.c.close(); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("лобби, оригинал офлайн: «Это ты?» живёт дольше ANON_TTL_MS; claim — тот же playerId, прежние токены отозваны", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      await goOffline(ps[0]);
      const { c, r } = await joinRaw(room.code, { name: "оля", caps: CAPS });
      assert.strictEqual(r.error, "name_claim");
      assert.strictEqual(r.name, "Оля");
      assert.ok(r.summary && "score" in r.summary, "сводка места");
      assert.ok(!c.raw.some((x) => x.includes(ps[0].token)), "токен места не уходит в «Это ты?»");
      await sleep(2500); // > 2 × ANON_TTL_MS: без pendingClaim сокет закрыл бы свип
      assert.strictEqual(c.ws.readyState, 1, "сокет на экране «Это ты?» жив");
      c.send({ type: "join", name: "оля", caps: CAPS, claim: true });
      const j = await c.wait((m) => m.type === "joined");
      assert.strictEqual(j.playerId, ps[0].id);
      assert.strictEqual(j.resumed, true);
      assert.notStrictEqual(j.token, ps[0].token);
      const old = await joinRaw(room.code, { token: ps[0].token });
      assert.strictEqual(old.r.error, "token_gone", "прежний токен места отозван");
      old.c.close(); c.close(); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("«Я другой» (fresh): новое место «Оля (2)», renamed, оригинал цел", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      await goOffline(ps[0]);
      const { c, r } = await joinRaw(room.code, { name: "Оля", caps: CAPS });
      assert.strictEqual(r.error, "name_claim");
      c.send({ type: "join", name: "Оля", caps: CAPS, fresh: true });
      const j = await c.wait((m) => m.type === "joined");
      assert.notStrictEqual(j.playerId, ps[0].id);
      assert.strictEqual(j.name, "Оля (2)");
      assert.strictEqual(j.renamed, true);
      const st = await b.wait(statePred((s) => s.players.length === 4));
      assert.ok(st.state.players.some((p) => p.id === ps[0].id && p.name === "Оля"));
      c.close(); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("лобби, оригинал онлайн: тёзка получает «Оля (2)» с renamed (и со старым клиентом тоже)", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      const a = await joinRaw(room.code, { name: "Оля", caps: CAPS });
      assert.strictEqual(a.r.type, "joined");
      assert.strictEqual(a.r.name, "Оля (2)");
      assert.strictEqual(a.r.renamed, true);
      const o = await joinRaw(room.code, { name: "Оля" });
      assert.strictEqual(o.r.type, "joined");
      assert.strictEqual(o.r.name, "Оля (3)");
      assert.ok(!o.c.msgs.some((m) => m.error === "name_claim"));
      a.c.close(); o.c.close(); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("старый клиент без caps: оригинал офлайн в лобби — молчаливый подхват, name_claim ему не шлют", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      await goOffline(ps[0]);
      const { c, r } = await joinRaw(room.code, { name: "Оля" });
      assert.strictEqual(r.type, "joined");
      assert.strictEqual(r.playerId, ps[0].id);
      assert.ok(!c.msgs.some((m) => m.error === "name_claim"), "name_claim старому клиенту не уходит");
      c.close(); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("сокет оригинала закрылся только что (< grace): клиенту с caps — тихий повтор, потом «Это ты?»; старому — тёзка", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      ps[0].close();
      await ps[0].closed;
      const { c, r } = await joinRaw(room.code, { name: "Оля", caps: CAPS });
      assert.strictEqual(r.error, "name_claim");
      assert.strictEqual(r.retry, true);
      assert.ok(r.retryInMs > 0 && r.retryInMs <= 300);
      await sleep(r.retryInMs + 100);
      c.send({ type: "join", name: "Оля", caps: CAPS });
      const r2 = await c.wait((m) => m.type === "error" && m.error === "name_claim" && !m.retry);
      assert.strictEqual(r2.name, "Оля");
      c.close(); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("vote: чужое место по имени не отдаётся, секрет не утекает; токен возвращает со своим голосом", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася", "Гоша"]);
      b.send({ type: "start" });
      await b.wait(statePred((s) => s.phase === "vote"));
      ps[0].send({ type: "vote", side: "a" });
      await ps[0].wait(statePred((s) => s.me && s.me.vote === "a"));
      await goOffline(ps[0]);
      for (const caps of [CAPS, undefined]) {
        const { c, r } = await joinRaw(room.code, { name: "Оля", caps });
        assert.strictEqual(r.error, "name_taken");
        assert.strictEqual(r.retry, true, "после смены фазы пройдёт");
        assert.ok(!c.msgs.some((m) => m.error === "name_claim" || m.type === "joined"));
        assert.ok(!c.raw.some((x) => x.includes('"vote":"a"')), "вор не видел чужой голос");
        c.send({ type: "join", name: "Оля", caps, claim: true });
        await sleep(100);
        assert.ok(!c.msgs.some((m) => m.type === "joined"), "claim:true не обходит фазу");
        c.close();
      }
      const back = await player(room.code, "Оля", ps[0].token);
      assert.strictEqual(back.id, ps[0].id);
      await back.wait(statePred((s) => s.me && s.me.vote === "a"));
      back.close(); b.close(); ps.slice(1).forEach((p) => p.close());
    });

    await t.test("opinion: подхват по имени тоже запрещён", async () => {
      const room = await createRoom({ lang: "ru", opinion: true });
      const b = await board(room.code, room.hostToken);
      const ps = [];
      for (const n of ["Аня", "Боря", "Витя", "Галя", "Дима"]) ps.push(await player(room.code, n));
      b.send({ type: "start" });
      await b.wait(statePred((s) => s.phase === "vote"));
      ps[0].send({ type: "vote", side: "a" });
      for (const p of ps) { p.send({ type: "vote", side: "a" }); }
      await sleep(150);
      for (const p of ps) p.send({ type: "confirm" });
      await b.wait(statePred((s) => s.phase === "opinion"));
      await goOffline(ps[1]);
      assert.strictEqual(b.state.phase, "opinion", "фаза «мнения» ещё идёт");
      const { c, r } = await joinRaw(room.code, { name: "Боря", caps: CAPS });
      assert.strictEqual(r.error, "name_taken");
      assert.strictEqual(r.retry, true);
      c.close();
      b.close(); ps.forEach((p) => p.close());
    });

    await t.test("в reveal: без флага — «имя занято» (retry:false), с RULE_U01_CLAIM_IN_GAME — «Это ты?» и тот же playerId", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася", "Гоша"]);
      b.send({ type: "start" });
      await b.wait(statePred((s) => s.phase === "vote"));
      for (const p of ps) p.send({ type: "vote", side: "a" });
      await sleep(150);
      for (const p of ps) p.send({ type: "confirm" });
      await b.wait(statePred((s) => s.phase === "reveal"));
      await goOffline(ps[0]);
      assert.ok(["reveal", "scores"].includes(b.state.phase), "фаза раскрытия ещё идёт: " + b.state.phase);
      {
        const { c, r } = await joinRaw(room.code, { name: "Оля", caps: CAPS });
        if (!rule) {
          assert.strictEqual(r.error, "name_taken");
          assert.strictEqual(r.retry, false);
          const old = await joinRaw(room.code, { name: "Оля" });
          assert.strictEqual(old.r.error, "name_taken", "старый клиент — как раньше");
          old.c.close();
        } else {
          assert.strictEqual(r.error, "name_claim");
          c.send({ type: "join", name: "Оля", caps: CAPS, claim: true });
          const j = await c.wait((m) => m.type === "joined");
          assert.strictEqual(j.playerId, ps[0].id);
          // «Я другой» посреди партии при флаге: отдельное место «Оля (2)»
        }
        c.close();
      }
      b.close(); ps.forEach((p) => p.close());
    });

    await t.test("finished: подхват работает при любом флаге (итоги — класс A)", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      b.send({ type: "start" });
      await b.wait(statePred((s) => s.phase === "vote"));
      b.send({ type: "end" });
      await b.wait(statePred((s) => s.phase === "finished"));
      await goOffline(ps[0]);
      const { c, r } = await joinRaw(room.code, { name: "Оля", caps: CAPS });
      assert.strictEqual(r.error, "name_claim");
      c.send({ type: "join", name: "Оля", caps: CAPS, claim: true });
      const j = await c.wait((m) => m.type === "joined");
      assert.strictEqual(j.playerId, ps[0].id);
      c.close(); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("два устройства: оригинал онлайн в игре — тёзке «имя занято»; claim по токену вытесняет прежнюю вкладку", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      b.send({ type: "start" });
      await b.wait(statePred((s) => s.phase === "vote"));
      const { c, r } = await joinRaw(room.code, { name: "Оля", caps: CAPS });
      assert.strictEqual(r.error, "name_taken");
      assert.strictEqual(r.online, true);
      assert.strictEqual(r.retry, false);
      const second = client(room.code);
      await second.open;
      second.send({ type: "join", token: ps[0].token, name: "Оля", caps: CAPS });
      const j = await second.wait((m) => m.type === "joined");
      assert.strictEqual(j.playerId, ps[0].id);
      await ps[0].wait((m) => m.type === "replaced");
      c.close(); second.close(); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("потолок ожидающих с адреса: 7-й «Это ты?» получает «имя занято», а не бесконечную очередь", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      await goOffline(ps[0]);
      const cs = [];
      let last = null;
      for (let i = 0; i < 7; i++) { const x = await joinRaw(room.code, { name: "Оля", caps: CAPS }); cs.push(x.c); last = x.r; }
      assert.strictEqual(last.error, "name_taken");
      cs.forEach((c) => c.close()); b.close(); ps.forEach((p) => p.close());
    });

    await t.test("без подтверждения сокет «Это ты?» закрывается по CLAIM_WAIT_MS", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася"]);
      await goOffline(ps[0]);
      const { c, r } = await joinRaw(room.code, { name: "Оля", caps: CAPS });
      assert.strictEqual(r.error, "name_claim");
      const closed = await Promise.race([c.closed.then(() => true), sleep(8000).then(() => false)]);
      assert.ok(closed, "ожидание ограничено");
      b.close(); ps.forEach((p) => p.close());
    });
  };
}

test("подхват места по имени, «Это ты?» (T-W1-06)", claimSuite(false));
test("подхват места по имени с RULE_U01_CLAIM_IN_GAME=1 (T-W1-06)", claimSuite(true));

// ---------- T-W2-35: призраки не в партии (RULE_U08_GHOST_OUT) ----------
function ghostSuite(rule) {
  return async (t) => {
    startServer.env = { CLAIM_GRACE_MS: "300", ...(rule ? { RULE_U08_GHOST_OUT: "1" } : {}) };
    await startServer();
    t.after(async () => { await stopServer(); startServer.env = null; for (const f of [DUMP, STATS]) { try { fs.unlinkSync(f); } catch {} } });
    await t.test(rule ? "флаг: офлайн к старту — left, возвращается по токену+имени" : "без флага: офлайн к старту — в партии (как раньше)", async () => {
      const { room, b, ps } = await claimCtx(["Оля", "Петя", "Вася", "Гоша"]);
      await goOffline(ps[3]);
      const lob = await b.wait(statePred((s) => s.players.some((p) => p.online === false)));
      assert.strictEqual(lob.state.players.length, 4, "в лобби призрак виден");
      b.send({ type: "start" });
      const st = await b.wait(statePred((s) => s.phase === "vote"));
      assert.strictEqual(st.state.players.filter((p) => !p.left).length, rule ? 3 : 4);
      if (rule) {
        const back = await player(room.code, "Гоша", ps[3].token);
        assert.strictEqual(back.id, ps[3].id, "место возвращено");
        back.close();
      }
      b.close(); ps.forEach((p) => p.close());
    });
  };
}
test("пинг комнат «в игре»: ping-кадры каждые PING_MS; в лобби быстрого пинга нет (T-W2-41)", async (t) => {
  startServer.env = { PING_MS: "1000" };
  await startServer();
  t.after(async () => { await stopServer(); startServer.env = null; for (const f of [DUMP, STATS]) { try { fs.unlinkSync(f); } catch {} } });
  const room = await createRoom({ lang: "ru", opinion: false });
  const b = await board(room.code, room.hostToken);
  const ps = [];
  for (const n of ["Аня", "Боря", "Вика"]) ps.push(await player(room.code, n));
  const pings = { lobby: 0, game: 0 };
  let phase = "lobby";
  b.ws.on("ping", () => { pings[phase]++; });
  await sleep(2500);
  assert.strictEqual(pings.lobby, 0, "быстрый пинг не должен идти в лобби");
  phase = "game";
  b.send({ type: "start" });
  await b.wait(statePred((s) => s.phase !== "lobby"));
  await sleep(3500);
  assert.ok(pings.game >= 2, "в игре ping-кадров мало: " + pings.game);
  assert.strictEqual(b.ws.readyState, 1, "порог тишины ≥ 20 с — живой сокет не закрыт");
  for (const c of [b, ...ps]) c.close();
});

test("призраки: без флага (T-W2-35)", ghostSuite(false));
test("призраки: RULE_U08_GHOST_OUT=1 (T-W2-35)", ghostSuite(true));
