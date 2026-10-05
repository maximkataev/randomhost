"use strict";

// Тесты сервера «Вопроса ребром» через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `quip-test-${process.pid}.json`);
const port = 4900 + (process.pid % 500);
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
  const r = await fetch(`http://127.0.0.1:${port}/quip/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}

function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/quip/ws?r=${code}`);
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

// все отвечают на свои вопросы
async function answerAll(ps, text = (p, pr) => `ответ ${p.id} ${pr.id}`) {
  for (const p of ps) {
    const m = await p.wait(statePred((s) => s.phase === "answer" && s.me));
    for (const pr of m.state.me.prompts) p.send({ type: "answer", mid: pr.id, ans: pr.deck === "final" ? ["раз " + p.id, "два", "три"] : text(p, pr) });
  }
}

test.before(async () => { try { fs.unlinkSync(DUMP); } catch {} await startServer(); });
test.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

test("колоды загружены на всех языках", async () => {
  const r = await (await fetch(`http://127.0.0.1:${port}/quip/api/health`)).json();
  assert.ok(r.ok);
  const C = require("./content");
  for (const lang of ["ru", "en", "el"]) for (const d of ["duel", "emoji", "final"]) assert.ok(C[lang][d].length > 0, `${lang}/${d} пустая`);
});

test("партия втроём до конца; авторы и подсказки не утекают ни в одно сообщение до раскрытия", async () => {
  const room = await createRoom({ short: true }, 20);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "Аня"), await player(room.code, "Боря"), await player(room.code, "Вика")];
  b.send({ type: "start" });
  // Аня тянет подсказку на первый вопрос
  const m = await ps[0].wait(statePred((s) => s.phase === "answer" && s.me && s.me.prompts.length));
  const first = m.state.me.prompts[0];
  ps[0].send({ type: "hint", mid: first.id });
  const hinted = await ps[0].wait(statePred((s) => s.me && s.me.prompts.some((p) => p.id === first.id && p.done)));
  const hintText = hinted.state.me.prompts.find((p) => p.id === first.id).answer.text;
  assert.ok(hintText, "подсказка пришла владельцу");
  // остальные сообщения до раскрытия не содержат текст подсказки с отметкой и авторов
  await answerAll(ps);
  await b.wait(statePred((s) => s.phase === "vote"));
  for (const c of [b, ...ps]) {
    for (const raw of c.raw) {
      assert.ok(!raw.includes('"pool"'), "пул подсказок утёк");
      assert.ok(!raw.includes('"key"'), "ключ сравнения утёк");
      const msg = JSON.parse(raw);
      const cur = msg.state && msg.state.current;
      if (cur && msg.state.phase === "vote") for (const a of cur.answers || []) assert.ok(!("playerId" in a) && !("hint" in a), "автор утёк до раскрытия");
    }
  }
  // голосуют все, партия идёт до итогов
  let guard = 0;
  while (guard++ < 80) {
    const s = b.state;
    if (s.phase === "finished") break;
    if (s.phase === "answer") await answerAll(ps.filter((p) => p.state.me && p.state.me.prompts.some((x) => !x.done)));
    if (s.phase === "vote") {
      for (const p of ps) {
        const st = p.state;
        if (!st.me || !st.me.canVote || st.me.voted || st.current?.id !== s.current?.id) continue;
        const picks = [];
        st.current.answers.forEach((a, i) => { if (!a.mine && picks.length < st.me.votesFor) picks.push(i); });
        p.send({ type: "vote", mid: st.current.id, picks });
      }
    }
    await sleep(200);
  }
  assert.strictEqual(b.state.phase, "finished");
  const total = b.state.players.reduce((a, p) => a + p.score, 0);
  assert.ok(total > 0, "очки начислены");
  for (const c of [b, ...ps]) c.close();
});

test("отказы приходят только автору; мусорные сообщения не роняют сервер", async () => {
  const room = await createRoom({}, 1);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "A"), await player(room.code, "B"), await player(room.code, "C")];
  b.send({ type: "start" });
  const m = await ps[0].wait(statePred((s) => s.phase === "answer" && s.me && s.me.prompts.length));
  const mid = m.state.me.prompts[0].id;
  const before = ps[1].msgs.length;
  ps[0].send({ type: "vote", mid, picks: [0] });
  await ps[0].wait((x) => x.type === "rejected" && x.action === "vote");
  await sleep(200);
  assert.ok(!ps[1].msgs.slice(before).some((x) => x.type === "rejected"), "отказ ушёл не тому");
  // мусор: не JSON, неверные типы, огромные массивы, чужие команды ведущего
  ps[1].send("not json");
  ps[1].send({ type: "answer", mid: "x", ans: { evil: true } });
  ps[1].send({ type: "answer", mid, ans: Array(10000).fill("a") });
  ps[1].send({ type: "vote", mid: null, picks: "0,1" });
  ps[1].send({ type: "hint", mid: { $gt: 1 } });
  ps[1].send({ type: "start" });
  ps[1].send({ type: "settings", settings: { hints: 99 } });
  ps[1].send({ type: "kick", playerId: ps[0].id });
  ps[1].send({ type: "__proto__" });
  ps[1].send(null);
  ps[1].send(42);
  await sleep(300);
  const h = await (await fetch(`http://127.0.0.1:${port}/quip/api/health`)).json();
  assert.ok(h.ok, "сервер жив");
  assert.ok(b.state.players.some((p) => p.id === ps[0].id && !p.left), "игрок не кикнут чужими руками");
  assert.strictEqual(b.state.settings.hints, 2);
  // сообщение больше 8 КБ — сокет закрывается, сервер жив
  const big = client(room.code);
  await big.open;
  big.send({ type: "join", name: "x".repeat(20000) });
  await big.closed;
  assert.ok((await (await fetch(`http://127.0.0.1:${port}/quip/api/health`)).json()).ok);
  for (const c of [b, ...ps]) c.close();
});

test("HTML в ответе — просто текст: сервер хранит как есть, без изменений", async () => {
  const room = await createRoom({ short: true }, 1);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "A"), await player(room.code, "B"), await player(room.code, "C")];
  b.send({ type: "start" });
  const evil = `<img src=x onerror=alert(1)>`;
  await answerAll(ps, () => evil + Math.random().toString(36).slice(2, 6));
  const v = await b.wait(statePred((s) => s.phase === "vote" && s.current));
  assert.ok(v.state.current.answers.every((a) => a.text.startsWith(evil)), "текст дошёл как есть (экранирует клиент)");
  for (const c of [b, ...ps]) c.close();
});

test("возврат по токену посреди фазы ответов: вопросы на месте", async () => {
  const room = await createRoom({}, 1);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "A"), await player(room.code, "B"), await player(room.code, "C")];
  b.send({ type: "start" });
  const m = await ps[0].wait(statePred((s) => s.phase === "answer" && s.me && s.me.prompts.length));
  const ids = m.state.me.prompts.map((p) => p.id);
  ps[0].close();
  await sleep(100);
  const back = await player(room.code, "", ps[0].token);
  assert.strictEqual(back.id, ps[0].id);
  const again = await back.wait(statePred((s) => s.phase === "answer" && s.me));
  assert.deepStrictEqual(again.state.me.prompts.map((p) => p.id), ids);
  for (const c of [b, back, ...ps.slice(1)]) c.close();
});

test("перезапуск посреди голосования: ответы, порядок и голоса на месте", async () => {
  const room = await createRoom({}, 1);
  const b = await board(room.code, room.hostToken);
  const ps = [await player(room.code, "A"), await player(room.code, "B"), await player(room.code, "C")];
  b.send({ type: "start" });
  await answerAll(ps);
  const v = await b.wait(statePred((s) => s.phase === "vote" && s.current));
  const answersBefore = v.state.current.answers.map((a) => a.text);
  await sleep(5500); // дамп раз в 5 с
  for (const c of [b, ...ps]) c.close();
  await stopServer();
  await startServer();
  const b2 = await board(room.code, room.hostToken);
  const s = await b2.wait(statePred((x) => x.phase === "vote" || x.phase === "reveal"));
  assert.deepStrictEqual(s.state.current.answers.map((a) => a.text), answersBefore);
  b2.close();
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
  const r = await fetch(`http://127.0.0.1:${port}/quip/api/session?r=NOPE22`);
  assert.strictEqual(r.status, 404);
});

test("тело запроса не объект (null, массив, строка) — ответ, а не падение процесса", async () => {
  for (const body of ["null", "[]", "\"x\"", "42", "{\"sid\":null,\"msg\":null}"]) {
    for (const p of ["/quip/api/msg", "/quip/api/rooms"]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body });
      assert.ok(r.status < 500, `${p} ${body} → ${r.status}`);
    }
  }
  assert.ok((await (await fetch(`http://127.0.0.1:${port}/quip/api/health`)).json()).ok, "сервер жив");
});

test("токены «__proto__»/«constructor» не находят игрока; перехват токена — не чаще раза в секунду", async () => {
  const room = await createRoom({}, 1);
  const x = client(room.code);
  await x.open;
  for (const token of ["__proto__", "constructor", "toString"]) {
    x.send({ type: "join", token });
    const m = await x.wait((mm) => mm.type === "error" || mm.type === "joined");
    assert.strictEqual(m.error, "token_gone", token);
    x.msgs.length = 0;
  }
  x.close();
  // ждём сообщение, пришедшее после отметки mark (могло прийти раньше, чем мы начали ждать)
  const after = (c, mark, pred) => c.msgs.slice(mark).find(pred) || c.wait((m) => pred(m) && c.msgs.indexOf(m) >= mark);
  const res = (m) => m.type === "joined" || m.type === "error";
  const a = await player(room.code, "A");
  let ma = a.msgs.length;
  const b = await player(room.code, "", a.token);
  assert.strictEqual(b.id, a.id);
  await after(a, ma, (m) => m.type === "replaced");
  await sleep(1100);
  // a возвращает игрока (последний вход на этом сокете был больше секунды назад) — сразу
  ma = a.msgs.length;
  let mb = b.msgs.length;
  a.send({ type: "join", token: a.token });
  assert.strictEqual((await after(a, ma, res)).type, "joined");
  await after(b, mb, (m) => m.type === "replaced");
  // b забирает обратно (его вход был давно) — можно; a тут же снова — уже нет
  ma = a.msgs.length; mb = b.msgs.length;
  b.send({ type: "join", token: a.token });
  assert.strictEqual((await after(b, mb, res)).type, "joined");
  await after(a, ma, (m) => m.type === "replaced");
  ma = a.msgs.length;
  a.send({ type: "join", token: a.token });
  assert.strictEqual((await after(a, ma, res)).error, "slow_down");
  await sleep(1100);
  ma = a.msgs.length;
  a.send({ type: "join", token: a.token });
  assert.strictEqual((await after(a, ma, res)).type, "joined");
  for (const c of [a, b]) c.close();
});

test("битый дамп: плохие комнаты пропускаются, хорошие поднимаются, сервер не падает", async () => {
  const { Game } = require("./game");
  const good = (code) => ({ code, ip: "", hostToken: "h" + code, tokens: {}, touched: Date.now(), state: Game.create({ code }).s });
  const broken = { ...good("BAD22"), state: { ...good("BAD22").state, phase: "answer", plan: ["zzz"], ri: 0, matchups: [{ id: 1, authors: ["u1"], answers: {}, pool: [] }], phaseEnd: Date.now() - 1 } };
  await stopServer();
  fs.writeFileSync(DUMP, JSON.stringify([null, { code: 5 }, { ...good("NOST22"), state: null }, broken, good("GOOD22")]));
  await startServer();
  for (const code of ["BAD22", "GOOD22"]) {
    const c = client(code);
    await c.open.catch(() => {});
    c.send({ type: "join", name: "x" });
    await sleep(200);
    c.ws.terminate();
  }
  const h = await (await fetch(`http://127.0.0.1:${port}/quip/api/health`)).json();
  assert.ok(h.ok && h.rooms >= 1, "сервер жив, хорошая комната на месте");
  const b = await board("GOOD22", "hGOOD22");
  assert.strictEqual(b.state.code, "GOOD22");
  b.close();
});

test("пересадка доски не обходит лимит анонимов; команды ведущего — не чаще 5 в секунду", async () => {
  const room = await createRoom({}, 1);
  const socks = [];
  let refused = 0;
  for (let i = 0; i < 14; i++) {
    const c = client(room.code);
    try { await c.open; } catch { refused++; continue; }
    c.send({ type: "host", token: room.hostToken });
    await c.wait((m) => m.type === "host_ok");
    socks.push(c);
  }
  assert.ok(refused > 0 && socks.length <= 11, `бывшие доски копятся: открыто ${socks.length}, отказов ${refused}`);
  const host = socks[socks.length - 1];
  const watcher = socks[0];
  await sleep(200);
  const before = watcher.msgs.filter((m) => m.type === "state").length;
  for (let i = 0; i < 30; i++) host.send({ type: "settings", settings: { hints: 1 + (i % 3) } });
  await sleep(400);
  const got = watcher.msgs.filter((m) => m.type === "state").length - before;
  assert.ok(got >= 1 && got <= 5, `снимков от 30 команд: ${got}`);
  for (const c of socks) c.close();
});

test("long-poll: второй опрос той же сессии отпускает первый, сообщения приходят сразу", async () => {
  const room = await createRoom({}, 1);
  const B = `http://127.0.0.1:${port}/quip/api`;
  const s = await (await fetch(`${B}/session?r=${room.code}`)).json();
  await fetch(`${B}/msg`, { method: "POST", body: JSON.stringify({ sid: s.sid, msg: { type: "join", name: "Поллер" } }) });
  await (await fetch(`${B}/poll?sid=${s.sid}`)).json();
  const t0 = Date.now();
  const first = fetch(`${B}/poll?sid=${s.sid}`).then((r) => r.json()).then((j) => ({ ms: Date.now() - t0, n: j.messages.length }));
  await sleep(100);
  const second = fetch(`${B}/poll?sid=${s.sid}`).then((r) => r.json()).then((j) => ({ ms: Date.now() - t0, n: j.messages.length }));
  await sleep(200);
  await fetch(`${B}/msg`, { method: "POST", body: JSON.stringify({ sid: s.sid, msg: { type: "react", emoji: "😂" } }) });
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a.ms < 1000 && a.n === 0, `первый опрос отпущен пустым: ${JSON.stringify(a)}`);
  assert.ok(b.ms < 2000 && b.n >= 1, `второй получил событие сразу: ${JSON.stringify(b)}`);
});

test("кривой путь запроса (//[) — ни обычный запрос, ни WebSocket не роняют процесс", async () => {
  const net = require("node:net");
  for (const extra of ["", "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"]) {
    await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`GET //[ HTTP/1.1\r\nHost: x\r\n${extra}\r\n`));
      s.on("data", () => s.destroy());
      s.on("error", resolve);
      s.on("close", resolve);
      setTimeout(() => { s.destroy(); resolve(); }, 1000);
    });
  }
  await sleep(100);
  assert.ok((await (await fetch(`http://127.0.0.1:${port}/quip/api/health`)).json()).ok, "сервер жив");
});

test("перебор кодов: промахи считаются на сеть IPv6 /64, кривой путь «//quip%2Fws» не роняет процесс", async () => {
  const room = await createRoom({}, 1);
  const B = `http://127.0.0.1:${port}/quip/api`;
  const as = (ip) => ({ headers: { "x-real-ip": ip } });
  // 60 промахов с разных адресов одной /64 — блок для всей сети, соседний адрес настоящий код уже не получает
  for (let i = 0; i < 61; i++) await fetch(`${B}/session?r=NOPE${i}`, as(`2001:db8:5:6::${(i + 1).toString(16)}`));
  assert.strictEqual((await fetch(`${B}/session?r=${room.code}`, as("2001:db8:5:6:ffff::9"))).status, 404, "сосед по /64 обошёл блок");
  assert.strictEqual((await fetch(`${B}/session?r=${room.code}`, as("2001:db8:5:7::1"))).status, 200, "другая /64 не заблокирована");
  const net = require("node:net");
  await new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write("GET //quip%2Fws?r=X HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"));
    s.on("error", resolve);
    s.on("close", resolve);
    setTimeout(() => { s.destroy(); resolve(); }, 1000);
  });
  await sleep(100);
  assert.ok((await (await fetch(`${B}/health`)).json()).ok, "сервер жив");
});
