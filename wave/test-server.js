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

  await t.test("кривые запросы не роняют процесс; перебор кодов считается по /64", async () => {
    const base = `http://127.0.0.1:${port}/wave`;
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

  // ---- T-W0-05: сканер секретов (tools/testkit/scan.js) по трём видам: доска, игрок, сокет без токена ----
  await t.test("секреты не в кадрах: target чужой карточки (в т.ч. после name_taken), чужие подсказки в фазе clue, токены", async () => {
    const { scanFrames } = require("../tools/testkit/scan");
    const room = await createRoom({ lang: "ru" }, 4);
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася")];
    const anon = client(room.code);
    await anon.open;
    b.send({ type: "start" });
    await allClue(ps); // подсказки: «подсказка а/б/в»
    await b.wait(statePred((s) => s.phase === "guess"));
    // вор под занятым именем — получает name_taken и не получает ни карточку, ни target
    const thief = client(room.code);
    await thief.open;
    thief.send({ type: "join", name: "Оля" });
    const r = await thief.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.error, "name_taken");
    await sleep(300);
    // все, кроме автора, фиксируют угол → раскрытие
    const author = b.state.card.author;
    for (const p of ps) if (p.id !== author) p.send({ type: "lock", angle: 90 });
    await b.wait(statePred((s) => s.phase === "reveal"), 8000);
    await sleep(200);

    const cut = (c) => c.raw.map((x) => JSON.parse(x));
    const clients = [["board", b], ["player", ps[0]], ["player", ps[1]], ["player", ps[2]], ["anon", anon], ["anon", thief]];
    let scanned = 0;
    for (const [view, c] of clients) {
      const frames = cut(c).map((f) => ({ view, frame: f }));
      scanned += frames.length;
      const foreign = ps.map((p) => p.token).filter((x) => x && x !== c.token);
      // до раскрытия (lobby/clue/guess): target — только в своей me.card (телефон автора карточки); доске и анонимам — нигде
      const v = scanFrames(frames, {
        phases: ["lobby", "clue", "guess"],
        forbiddenKeys: [(p, k) => k === "target" && !(view === "player" && p === "state.me.card.target") && "target чужой карточки", "hostToken"],
        forbiddenSubstrings: view === "board" ? foreign : foreign.concat(room.hostToken),
      });
      assert.deepStrictEqual(v, [], `${view}: ${JSON.stringify(v.slice(0, 3))}`);
    }
    // в фазе clue чужие тексты подсказок никому не уходят (кроме автора — его собственный me.card.clue)
    const ids = ["подсказка а", "подсказка б", "подсказка в"];
    ps.forEach((p, i) => {
      const others = ids.filter((_, j) => j !== i);
      const v = scanFrames(cut(p).map((f) => ({ view: "player", frame: f })), { phases: ["clue"], forbiddenSubstrings: others });
      assert.deepStrictEqual(v, [], `игрок ${i}: чужая подсказка в фазе clue ${JSON.stringify(v.slice(0, 2))}`);
    });
    const anonClue = scanFrames(cut(anon).map((f) => ({ view: "anon", frame: f })), { phases: ["clue"], forbiddenSubstrings: ids });
    assert.deepStrictEqual(anonClue, [], "сокет без токена видит подсказки в фазе clue");
    assert.ok(scanned > 15, "кадров мало — проверка пустая: " + scanned);
    assert.ok(cut(ps[0]).some((m) => m.state && m.state.me && m.state.me.card && m.state.me.card.target != null), "свой target телефон не получал — проверка пустая");
    for (const c of [b, thief, anon, ...ps]) c.close();
  });

  // ---- T-W2-22: name_taken.online, joined.name, токен-прототип ----
  await t.test("name_taken: online говорит, на связи ли владелец имени; кадры без target и карточки", async () => {
    const room = await createRoom({ lang: "ru" }, 4);
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася")];
    b.send({ type: "start" });
    await allClue(ps);
    await b.wait(statePred((s) => s.phase === "guess"));
    // владелец имени на связи
    const t1 = client(room.code);
    await t1.open;
    t1.send({ type: "join", name: "оля" }); // регистр и двойники не отличают
    const r1 = await t1.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r1.error, "name_taken");
    assert.strictEqual(r1.online, true);
    // владелец без сокета (дольше грации 300 мс): «место ждёт игрока»
    ps[1].close();
    await sleep(700);
    const t2 = client(room.code);
    await t2.open;
    t2.send({ type: "join", name: "Петя" });
    const r2 = await t2.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r2.error, "name_taken");
    assert.strictEqual(r2.online, false);
    for (const c of [t1, t2]) {
      assert.ok(!c.raw.some((x) => x.includes('"target"') || x.includes('"card":{') && x.includes('"options"')), "после name_taken нет ни сектора, ни карточки");
    }
    for (const c of [b, t1, t2, ...ps]) c.close();
  });

  await t.test("joined.name: в лобби тёзка получает «Имя 2» и сервер называет принятое имя; токен «__proto__» — token_gone", async () => {
    const room = await createRoom({ lang: "ru" });
    const first = await player(room.code, "Маша");
    const second = client(room.code);
    await second.open;
    second.send({ type: "join", name: "Маша" });
    const j = await second.wait((m) => m.type === "joined");
    assert.strictEqual(j.name, "Маша 2");
    // токен-прототип не находит свойств Object.prototype
    const bad = client(room.code);
    await bad.open;
    bad.send({ type: "join", token: "__proto__" });
    const e = await bad.wait((m) => m.type === "error");
    assert.strictEqual(e.error, "token_gone");
    // возврат по токену: joined.name — прежнее имя
    const again = await player(room.code, "", first.token);
    assert.strictEqual(again.id, first.id);
    for (const c of [first, second, bad, again]) c.close();
  });

  await t.test("призрак в лобби уходит через GHOST_TTL_MS; онлайн остаются", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const a = await player(room.code, "Аня");
    const z = await player(room.code, "Зоя");
    await b.wait(statePred((s) => s.players.length === 2));
    z.close();
    await b.wait(statePred((s) => s.players.length === 2 && s.players.some((p) => p.name === "Зоя" && p.online === false)), 5000);
    await b.wait(statePred((s) => s.players.length === 1 && s.players[0].name === "Аня"), 8000);
    // токен ушедшего больше ничего не значит
    const back = client(room.code);
    await back.open;
    back.send({ type: "join", token: z.token });
    const r = await back.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.error, "token_gone");
    for (const c of [b, a, back]) c.close();
  });

  // ---- T-W2-23: skip ----
  await t.test("skip: игроку нельзя; ведущему — в intro отказ, в clue закрывает фазу (не написавшим 🐌)", async () => {
    const room = await createRoom({ lang: "ru" });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя"), await player(room.code, "Вася")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "intro"));
    b.send({ type: "skip" });
    const rj = await b.wait((m) => m.type === "rejected" && m.action === "skip");
    assert.strictEqual(rj.reason, "bad_phase");
    await b.wait(statePred((s) => s.phase === "clue"));
    await sleep(900);
    ps[0].send({ type: "skip" }); // игрок — игнор
    await sleep(200);
    assert.strictEqual(b.state.phase, "clue");
    // пишет один: остальные получат 🐌
    ps[0].send({ type: "pick", i: 0 });
    await ps[0].wait(statePred((s) => s.me.card.pick === 0));
    ps[0].send({ type: "clue", text: "подсказка а" });
    await ps[0].wait(statePred((s) => !!s.me.card.clue));
    b.send({ type: "skip" });
    await b.wait(statePred((s) => s.phase === "guess"), 5000);
    assert.strictEqual(b.state.players.filter((p) => p.skipped === 1).length, 2);
    for (const c of [b, ...ps]) c.close();
  });

  await t.test("пинг комнат «в игре»: ping-кадры каждые PING_MS, в лобби быстрого пинга нет", async () => {
    const room = await createRoom({ short: true });
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Аня"), await player(room.code, "Боря"), await player(room.code, "Вика")];
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
    assert.strictEqual(b.ws.readyState, 1, "живой сокет не закрывается");
    for (const c of [b, ...ps]) c.close();
  });
});
