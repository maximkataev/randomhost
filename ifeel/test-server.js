"use strict";

// Тесты сервера «Айфилю» через настоящий WebSocket и HTTP: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `ifeel-test-${process.pid}.json`);
let port = 0;
let proc = null;
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require("node:net").createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function spawnServer(p, env = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(p), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300", ANON_TTL_MS: "1500", ROUND_EXTRA_SEC: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.log = () => log;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("сервер не поднялся: " + log)), 5000);
    child.stdout.on("data", () => { if (/порт/.test(log)) { clearTimeout(t); resolve(child); } });
  });
}
async function startServer() {
  if (!port) port = await freePort();
  proc = await spawnServer(port);
}
function stopServer(child = proc, signal = "SIGTERM") {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill(signal);
  });
}

const base = () => `http://127.0.0.1:${port}/ifeel`;
async function createRoom(settings = {}, speed = 1) {
  const r = await fetch(`${base()}/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}

function client(code, headers = {}, query = "", p = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ifeel/ws?r=${code}${query}`, { headers });
  const c = { ws, msgs: [], raw: [], state: null, events: [] };
  const waiters = [];
  ws.on("message", (raw) => {
    c.raw.push(String(raw));
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "state" || m.type === "hello") c.state = m.state;
    if (m.type === "event") c.events.push(m.event);
    if (c.onMsg) c.onMsg(m);
    for (const w of waiters.slice()) if (w.pred(m, c)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  ws.on("error", () => {});
  c.open = new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  c.closed = new Promise((res) => ws.once("close", res));
  c.send = (m) => { if (ws.readyState === 1) ws.send(typeof m === "string" ? m : JSON.stringify(m)); };
  c.wait = (pred, ms = 15000) => new Promise((resolve, reject) => {
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
  if (j.type === "error") throw new Error(j.error);
  p.id = j.playerId;
  p.token = j.token;
  return p;
}

const statePred = (f) => (m) => (m.type === "state" || m.type === "hello") && m.state && f(m.state);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let aidN = 0;
const aid = () => "t" + ++aidN;

// бот: на каждый снимок делает то, что от него ждут (выбор, карточки, расстановка, ответы)
function bot(p, { skipRank = false } = {}) {
  const done = new Set();
  p.onMsg = (m) => {
    if (m.type !== "state" && m.type !== "hello") return;
    const s = m.state;
    const me = s.me;
    if (!me) return;
    const key = (k) => { const x = s.game + ":" + (s.round ? s.round.n : 0) + ":" + (s.round ? s.round.ti : "") + ":" + k; if (done.has(x)) return false; done.add(x); return true; };
    if (s.phase === "pick" && me.offers && me.choice == null && key("pick")) p.send({ type: "pick", idx: 0, aid: aid() });
    if (s.phase === "write" && me.write && !me.write.cards && key("write")) p.send({ type: "cards", cards: ["Карточка " + p.id, "Ещё одна " + p.id], aid: aid() });
    if (s.phase === "rank" && me.set && !me.ranked && !skipRank && key("rank")) p.send({ type: "rank", order: [4, 3, 2, 1, 0], aid: aid() });
    if (s.phase === "ask" && s.turn && me.role === "guesser" && !me.answered[s.turn.qi] && key("a" + s.turn.qi)) {
      const q = s.turn.qs[s.turn.qi];
      const v = q.kind === "pair" ? q.a : q.kind === "triple" ? q.items.slice() : 0;
      p.send({ type: "answer", qi: s.turn.qi, v, aid: aid() });
    }
  };
}

function hasKey(obj, keys) {
  if (!obj || typeof obj !== "object") return false;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k)) return true;
    if (hasKey(v, keys)) return true;
  }
  return false;
}

test("сервер", async (t) => {
  await startServer();
  t.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

  await t.test("партия ботами: лобби → итоги; ни в одном кадре до раскрытия нет порядка мишени; зала нет нигде", async () => {
    const room = await createRoom({ lang: "ru", mode: "edgy" }, 10);
    const b = await board(room.code, room.hostToken);
    const ps = [];
    for (const n of ["Оля", "Петя", "Вася", "Маша"]) { const p = await player(room.code, n); bot(p); ps.push(p); }
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "finished"), 60000);
    assert.strictEqual(b.state.finishedReason, "done");
    assert.ok(b.state.settings.mode === "edgy");
    for (const c of [b, ...ps]) {
      let reveals = 0;
      for (const raw of c.raw) {
        const m = JSON.parse(raw);
        if (!m.state) continue;
        assert.ok(!hasKey(m.state, ["hall", "hallCount", "shadow", "myAnswers"]), "следы зала в фазе " + m.state.phase);
        if (m.state.phase === "reveal") { reveals++; continue; }
        if (m.state.phase === "finished") continue;
        assert.ok(!hasKey(m.state, ["order", "orders"]), "утечка в фазе " + m.state.phase);
      }
      assert.ok(reveals > 0);
    }
    const total = b.state.players.reduce((a, p) => a + p.score, 0);
    assert.ok(total > 0, "очки начислены");
    // зрители хода — role "watch": ответов от них сервер не принимает
    assert.ok(ps.some((p) => p.raw.some((x) => x.includes('"role":"watch"'))), "у кого-то из телефонов была роль зрителя");
    assert.ok(!ps.some((p) => p.msgs.some((m) => m.type === "rejected" && m.action === "answer")), "боты отвечали только в свой ход");
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("идемпотентность по aid: повтор действия — ack без второго применения; отказ несёт aid", async () => {
    const room = await createRoom({ lang: "ru" }, 1);
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "А"), await player(room.code, "Б"), await player(room.code, "В")];
    b.send({ type: "start" });
    await ps[0].wait(statePred((s) => s.phase === "pick" && s.me && s.me.offers));
    ps[0].send({ type: "pick", idx: 1, aid: "x1" });
    await ps[0].wait((m) => m.type === "ack" && m.aid === "x1");
    await sleep(150);
    const n = ps[1].raw.length;
    ps[0].send({ type: "pick", idx: 1, aid: "x1" });
    const dup = await ps[0].wait((m) => m.type === "ack" && m.aid === "x1" && m.dup);
    assert.ok(dup.dup);
    await sleep(100);
    assert.strictEqual(ps[1].raw.length, n, "повтор не рассылает снимки");
    ps[0].send({ type: "pick", idx: 9, aid: "x2" });
    const rj = await ps[0].wait((m) => m.type === "rejected" && m.aid === "x2");
    assert.strictEqual(rj.reason, "bad_pick");
    ps[0].send({ type: "rank", order: [0, 1, 2, 3, 4], aid: "x3" });
    const rj2 = await ps[0].wait((m) => m.type === "rejected" && m.aid === "x3");
    assert.strictEqual(rj2.reason, "not_rank");
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("R2: вето — одно, повтор того же aid — ack, второе — отказ; доска видит, кто заменил", async () => {
    const room = await createRoom({ lang: "ru" }, 10);
    const b = await board(room.code, room.hostToken);
    const ps = [];
    for (const n of ["К1", "К2", "К3"]) { const p = await player(room.code, n); bot(p); ps.push(p); }
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "write"), 30000);
    // боты уже отправили свои; проверим отказ на свежем авторе через отдельную комнату не нужно — шлём заведомо битое
    ps.forEach((p) => { p.onMsg = null; });
    await b.wait(statePred((s) => s.phase === "rank"), 30000);
    const p = ps[0];
    p.send({ type: "veto", idx: 1, aid: "v1" });
    await p.wait((m) => m.type === "ack" && m.aid === "v1");
    p.send({ type: "veto", idx: 1, aid: "v1" });
    await p.wait((m) => m.type === "ack" && m.aid === "v1" && m.dup);
    p.send({ type: "veto", idx: 2, aid: "v2" });
    const rj = await p.wait((m) => m.type === "rejected" && m.aid === "v2");
    assert.strictEqual(rj.reason, "veto_used");
    await b.wait(statePred((s) => s.round && (s.round.vetoed || []).includes(p.id)));
    b.close(); ps.forEach((x) => x.close());
  });

  await t.test("карточки: ссылка и повтор отклоняются с номером поля", async () => {
    const room = await createRoom({ lang: "ru" }, 10);
    const b = await board(room.code, room.hostToken);
    const ps = [];
    for (const n of ["Л1", "Л2", "Л3"]) { const p = await player(room.code, n); bot(p); ps.push(p); }
    const author = ps[0];
    author.onMsg = (m) => { if (m.state && m.state.phase === "pick" && m.state.me && m.state.me.choice == null && !author.picked) { author.picked = true; author.send({ type: "pick", idx: 0 }); } };
    b.send({ type: "start" });
    // раунд 1 — до конца: автор отвечает сам только на выбор; расстановку пропускает (его ход будет пропущен)
    await author.wait(statePred((s) => s.phase === "write" && s.me && s.me.write), 60000);
    author.send({ type: "cards", cards: ["норм", "www.example.com"], aid: "c1" });
    const r1 = await author.wait((m) => m.type === "rejected" && m.aid === "c1");
    assert.strictEqual(r1.reason, "bad_card");
    assert.strictEqual(r1.idx, 1);
    author.send({ type: "cards", cards: ["Кот", "кот"], aid: "c2" });
    const r2 = await author.wait((m) => m.type === "rejected" && m.aid === "c2");
    assert.strictEqual(r2.reason, "dup");
    author.send({ type: "cards", cards: ["Кот", "Пёс"], aid: "c3" });
    await author.wait((m) => m.type === "ack" && m.aid === "c3");
    b.close(); ps.forEach((x) => x.close());
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

  await t.test("имя длиннее 15 знаков обрезается по кодпоинтам", async () => {
    const room = await createRoom({ lang: "ru" });
    const p = await player(room.code, "😀".repeat(20));
    await p.wait(statePred((s) => s.players.some((x) => x.id === p.id)));
    const me = p.state.players.find((x) => x.id === p.id);
    assert.strictEqual(Array.from(me.name).length, 15);
    p.close();
  });

  await t.test("настройки safe/edgy и язык — только у ведущего и только до старта", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Н1"), await player(room.code, "Н2"), await player(room.code, "Н3")];
    ps[0].send({ type: "settings", settings: { mode: "edgy" } });
    const rj = await ps[0].wait((m) => m.type === "rejected");
    assert.strictEqual(rj.reason, "not_host");
    b.send({ type: "settings", settings: { mode: "edgy", lang: "en" } });
    await b.wait(statePred((s) => s.settings.mode === "edgy" && s.settings.lang === "en"));
    // en.json нет — комната играет русский банк и честно говорит об этом
    assert.ok(["en", "ru"].includes(b.state.contentLang));
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "pick"));
    b.send({ type: "settings", settings: { mode: "safe" } });
    const e = await b.wait((m) => m.type === "error");
    assert.strictEqual(e.error, "game_started");
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("кривые запросы не роняют процесс; readJson только объект; перебор кодов по /64", async () => {
    assert.equal((await fetch(`${base()}/api/msg`, { method: "POST", body: "null" })).status, 410);
    assert.equal((await fetch(`${base()}/api/msg`, { method: "POST", body: "[1,2]" })).status, 410);
    assert.equal((await fetch(`${base()}/api/rooms`, { method: "POST", body: "null" })).status, 200);
    const net = require("node:net");
    for (const extra of ["", "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"]) {
      await new Promise((res) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET //[ HTTP/1.1\r\nHost: x\r\n${extra}\r\n`)); s.on("data", () => s.destroy()); s.on("close", res); s.on("error", res); setTimeout(() => { s.destroy(); res(); }, 500); });
    }
    assert.equal((await (await fetch(`${base()}/api/health`)).json()).ok, true);
    const room = await (await fetch(`${base()}/api/rooms`, { method: "POST", body: "{}" })).json();
    assert.match(room.code, /^[A-Z]+[2-9]{2}$/, "код — слово и две цифры");
    for (let i = 1; i <= 60; i++) await fetch(`${base()}/api/session?r=NOPE${i}`, { headers: { "x-real-ip": `2001:db8:7:7::${i.toString(16)}` } });
    const r = await fetch(`${base()}/api/session?r=${room.code}`, { headers: { "x-real-ip": "2001:db8:7:7:abcd::1" } });
    assert.equal(r.status, 404, "соседний адрес из той же /64 тоже заблокирован");
  });

  await t.test("мусорные сообщения не роняют сервер", async () => {
    const room = await createRoom({ lang: "ru" });
    const c = client(room.code);
    await c.open;
    const p = await player(room.code, "Мусор");
    for (const junk of ["null", "[]", "42", '{"type":"answer","qi":{},"v":[1,{}]}', '{"type":"rank","order":"x"}', '{"type":"cards","cards":[{},null,7]}', '{"type":"veto","idx":"1"}', "{not json", '{"type":"host","token":null}']) { c.send(junk); p.send(junk); }
    await sleep(200);
    assert.equal((await (await fetch(`${base()}/api/health`)).json()).ok, true);
    c.close(); p.close();
  });

  await t.test("один висящий poll на sid: новый закрывает прежний", async () => {
    const room = await createRoom({ lang: "ru" });
    const s = await (await fetch(`${base()}/api/session?r=${room.code}`)).json();
    const first = fetch(`${base()}/api/poll?sid=${s.sid}`).then((r) => r.json());
    await sleep(100);
    const second = fetch(`${base()}/api/poll?sid=${s.sid}`);
    const got = await Promise.race([first.then(() => "first"), sleep(3000).then(() => "timeout")]);
    assert.strictEqual(got, "first", "прежний запрос отпущен сразу");
    // второй висит до 20 с — отпустим его сообщением
    await fetch(`${base()}/api/msg`, { method: "POST", body: JSON.stringify({ sid: s.sid, msg: { type: "ping", c: 1 } }) });
    assert.strictEqual((await second).status, 200);
  });

  await t.test("кик и команды ведущего без токена", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const p = await player(room.code, "Кик");
    const q = await player(room.code, "Не ведущий");
    q.send({ type: "start" });
    assert.strictEqual((await q.wait((m) => m.type === "rejected")).reason, "not_host");
    b.send({ type: "kick", playerId: p.id });
    await p.wait((m) => m.type === "kicked");
    b.close(); p.close(); q.close();
  });

  await t.test("рестарт посреди расстановки: расстановка сохранена, фаза не закрывается за отставших", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Р1"), await player(room.code, "Р2"), await player(room.code, "Р3"), await player(room.code, "Р4")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "pick"));
    for (const p of ps) p.send({ type: "pick", idx: 0 });
    await ps[0].wait(statePred((s) => s.phase === "rank" && s.me && s.me.set));
    ps[0].send({ type: "rank", order: [1, 0, 2, 3, 4], aid: "r1" });
    await ps[0].wait(statePred((s) => s.me && s.me.ranked));
    await sleep(5300); // дамп раз в 5 с
    await stopServer();
    await startServer();
    const p1 = await player(room.code, "", ps[1].token);
    await p1.wait(statePred((s) => s.phase === "rank"));
    p1.send({ type: "rank", order: [0, 1, 2, 3, 4] });
    await sleep(300);
    assert.strictEqual(p1.state.phase, "rank", "фаза ждёт остальных после рестарта");
    const p0 = await player(room.code, "", ps[0].token);
    await p0.wait(statePred((s) => s.me && s.me.ranked));
    assert.ok(!p0.raw.some((x) => x.includes('"order"')), "свой порядок не приходит даже себе");
    p0.close(); p1.close();
  });
});

test("статика: только внутри STATIC, без точечных файлов и выхода наверх; лимит сокетов на адрес", async () => {
  const sp = await freePort();
  const st = await spawnServer(sp, { STATIC: path.join(__dirname, ".."), DUMP_FILE: DUMP + ".st", MAX_SOCKETS_PER_IP: "3" });
  try {
    const net = require("node:net");
    const raw = (line) => new Promise((resolve) => {
      const sock = net.connect(sp, "127.0.0.1", () => sock.write(`GET ${line} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      let buf = "";
      sock.on("data", (d) => (buf += d));
      sock.on("close", () => resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1])));
      sock.on("error", () => resolve(0));
    });
    assert.equal(await raw("/%E0%A4%A"), 400);
    assert.equal(await raw("/../randomhost/ifeel.html"), 404);
    assert.equal(await raw("/%2e%2e/%2e%2e/etc/passwd"), 404);
    assert.equal(await raw("/.gitignore"), 404);
    assert.equal(await raw("/ifeel/state/rooms.json"), 404);
    assert.equal(await raw("/ifeel.html"), 200);
    // лимит сокетов на адрес: четвёртый получает 503
    const room = await (await fetch(`http://127.0.0.1:${sp}/ifeel/api/rooms`, { method: "POST", body: "{}" })).json();
    const hdr = { "x-real-ip": "10.9.9.9" };
    const cs = [];
    for (let i = 0; i < 3; i++) { const c = client(room.code, hdr, "", sp); await c.open; cs.push(c); }
    const extra = client(room.code, hdr, "", sp);
    const ok = await extra.open.then(() => true, () => false);
    assert.strictEqual(ok, false, "четвёртый сокет с адреса не открылся");
    cs.forEach((c) => c.close());
  } finally {
    await stopServer(st);
    try { fs.unlinkSync(DUMP + ".st"); } catch {}
  }
});
