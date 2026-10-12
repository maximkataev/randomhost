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
let serverEnv = {}; // дополнительные переменные окружения следующего запуска (флаги правил, таймеры)

function startServer() {
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300", ...serverEnv },
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
const SETTINGS = { groups: { hands: true, eyes: true, head: false, crowd: false } };

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
    case "spark": return { v: v.n };
    case "coward": return { v: v.hits };
    case "rhythm": return { v: v.gaps };
    case "simon": return { v: v.seq };
    case "blink": return { v: v.cell };
    case "flashes": return { v: v.options.indexOf(v.count) };
    case "diff": return { v: v.top.findIndex((x, i) => x !== v.bottom[i]) };
    case "shells": { let at = v.start; for (const [a, b] of v.swaps) { if (at === a) at = b; else if (at === b) at = a; } return { v: at }; }
    case "slots": {
      // момент, когда бомба в окне, — по той же формуле, что у сервера
      const bomb = v.syms.indexOf("💣");
      return { v: v.reels.map((r) => ((((bomb / 6 - r.phase) % 1) + 1) % 1) * r.period + 2 * r.period) };
    }
    default: throw new Error("тест не умеет решать " + c.type);
  }
}
const minWait = (c) => Math.max(c.minMs || 0, c.type === "nopress" ? c.view.wait : c.type === "code" ? 1400 : c.type === "hold" ? c.view.from : 1000) + 150;

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
    // диапазон фитиля (правило владельца 04.10): ни «min»/«max» у бомб и печатей, ни state.fuse в кадрах до взрыва
    for (const r of c.raw.slice(0, boomAt)) {
      let m; try { m = JSON.parse(r); } catch { continue; }
      const st = m.state || (m.type === "state" ? m : null);
      if (!st || st.phase === "lobby") continue;
      assert.strictEqual(st.fuse, undefined, "state.fuse ушёл клиенту");
      for (const x of [...(st.bombs || []), ...(st.seals || [])]) {
        assert.ok(!("min" in x) && !("max" in x), "min/max фитиля ушли клиенту");
      }
    }
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

test("сообщение больше 8 КБ рвёт только этот сокет, сервер жив", async () => {
  const room = await createRoom({}, 1);
  const big = client(room.code);
  await big.open;
  const closed = new Promise((res) => big.ws.once("close", res));
  big.send({ type: "join", name: "x".repeat(20000) });
  await closed;
  await sleep(200);
  const h = await (await fetch(`http://127.0.0.1:${port}/bomb/api/health`)).json();
  assert.ok(h.ok, "сервер упал от большого сообщения");
});

test("тело запроса не объект (null, массив, строка) — ответ, а не падение процесса", async () => {
  for (const body of ["null", "[]", "\"x\"", "42", "{\"sid\":null,\"msg\":null}"]) {
    for (const p of ["/bomb/api/msg", "/bomb/api/rooms"]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body });
      assert.ok(r.status < 500, `${p} ${body} → ${r.status}`);
    }
  }
  assert.ok((await (await fetch(`http://127.0.0.1:${port}/bomb/api/health`)).json()).ok, "сервер жив");
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
  for (let i = 0; i < 30; i++) host.send({ type: "settings", settings: { fuse: ["short", "normal", "long"][i % 3] } });
  await sleep(400);
  const got = watcher.msgs.filter((m) => m.type === "state").length - before;
  assert.ok(got >= 1 && got <= 5, `снимков от 30 команд: ${got}`);
  for (const c of socks) c.close();
});

test("long-poll: второй опрос той же сессии отпускает первый, сообщения приходят сразу", async () => {
  const room = await createRoom({}, 1);
  const B = `http://127.0.0.1:${port}/bomb/api`;
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
  assert.ok((await (await fetch(`http://127.0.0.1:${port}/bomb/api/health`)).json()).ok, "сервер жив");
});

test("перебор кодов: промахи считаются на сеть IPv6 /64, кривой путь «//bomb%2Fws» не роняет процесс", async () => {
  const room = await createRoom({}, 1);
  const B = `http://127.0.0.1:${port}/bomb/api`;
  const as = (ip) => ({ headers: { "x-real-ip": ip } });
  // 60 промахов с разных адресов одной /64 — блок для всей сети, соседний адрес настоящий код уже не получает
  for (let i = 0; i < 61; i++) await fetch(`${B}/session?r=NOPE${i}`, as(`2001:db8:5:6::${(i + 1).toString(16)}`));
  assert.strictEqual((await fetch(`${B}/session?r=${room.code}`, as("2001:db8:5:6:ffff::9"))).status, 404, "сосед по /64 обошёл блок");
  assert.strictEqual((await fetch(`${B}/session?r=${room.code}`, as("2001:db8:5:7::1"))).status, 200, "другая /64 не заблокирована");
  const net = require("node:net");
  await new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write("GET //bomb%2Fws?r=X HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"));
    s.on("error", resolve);
    s.on("close", resolve);
    setTimeout(() => { s.destroy(); resolve(); }, 1000);
  });
  await sleep(100);
  assert.ok((await (await fetch(`${B}/health`)).json()).ok, "сервер жив");
});

test("pass с b/n по сокету: повтор после потерянного подтверждения — rejected stale, без b/n как раньше (T-W0-28)", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const ps = [await player(code, "Аня"), await player(code, "Петя"), await player(code, "Оля")];
  b.send({ type: "start" });
  await b.wait(statePred((s) => s.phase === "live"), 6000);
  const holder = ps.find((p) => p.id === b.state.bombs[0].holder);
  const m = await holder.wait(statePred((s) => s.me && s.me.challenge));
  const c = m.state.me.challenge;
  await sleep(minWait(c));
  holder.send({ type: "answer", cid: c.id, ans: solveView(c) });
  const armed = await holder.wait(statePred((s) => s.me && s.me.armed));
  const n = armed.state.me.passN[0];
  assert.strictEqual(n, 0);
  const to = ps.find((p) => p !== holder).id;
  const third = ps.find((p) => p !== holder && p.id !== to).id;
  holder.send({ type: "pass", to, b: 0, n });
  await b.wait(statePred((s) => s.bombs[0].holder === to && s.passes === 1));
  // тот же бросок ещё раз (подтверждение потерялось): бомба не двигается
  holder.send({ type: "pass", to: third, b: 0, n });
  await holder.wait((x) => x.type === "rejected" && x.action === "pass" && x.reason === "stale");
  await sleep(150);
  assert.strictEqual(b.state.bombs[0].holder, to);
  assert.strictEqual(b.state.passes, 1);
  for (const x of [b, ...ps]) x.close();
});

// ---- T-W0-05: сканер секретов (tools/testkit/scan.js) по трём видам: доска, игрок, сокет без токена ----
const { scanFrames } = require("../tools/testkit/scan");

test("секреты не в кадрах: доска / игрок / сокет без токена — до взрыва нет fuse/min/max/fuseMs/salt/explodeAt/answer и чужих токенов", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const ps = [await player(code, "Аня"), await player(code, "Петя"), await player(code, "Оля")];
  const anon = client(code); // сокет без join/host: только то, что отдают всем
  await anon.open;
  b.send({ type: "start" });
  const live = await b.wait(statePred((s) => s.phase === "live"), 6000);
  const holder = ps.find((p) => p.id === live.state.bombs[0].holder);
  await solveAndThrow(holder, ps.map((p) => p.id));
  await b.wait(statePred((s) => s.passes === 1));
  // вторая доска посреди live: hello с полным снимком
  const b2 = await board(code, hostToken);
  await b2.wait(statePred((s) => s.phase === "live"));
  const late = await player(code, "", ps[0].token); // возврат по токену посреди live
  await sleep(300);

  // граница «до взрыва/итогов»: после неё печать вскрывается (fuseMs/salt — штатно)
  const cut = (c) => {
    const i = c.raw.findIndex((r) => r.includes('"type":"boom"') || r.includes('"phase":"boom"') || r.includes('"phase":"finished"'));
    return (i < 0 ? c.raw : c.raw.slice(0, i)).map((r) => JSON.parse(r));
  };
  // fuse — режим фитиля: в лобби/итогах его видят все, вне них — только доска (settings.fuse); верхнего state.fuse нет ни у кого
  const FORBIDDEN = ["fuseMs", "salt", "explodeAt", "min", "max", "answer", "hostToken",
    (p, k) => k === "fuse" && !/(^|\.)settings\.fuse$/.test(p) && "state.fuse"];
  const clients = [["board", b], ["board", b2], ["player", ps[0]], ["player", ps[1]], ["player", ps[2]], ["player", late], ["anon", anon]];
  let scanned = 0;
  for (const [view, c] of clients) {
    const frames = cut(c);
    scanned += frames.length;
    const foreign = ps.map((p) => p.token).filter((t) => t && t !== c.token);
    const subs = view === "board" ? foreign : foreign.concat(hostToken); // чужие токены игроков никому, токен ведущего — не-доске
    const v = scanFrames(frames.map((f) => ({ view, frame: f })), {
      forbiddenKeys: FORBIDDEN,
      forbiddenSubstrings: subs,
      phases: ["lobby", "countdown", "live"],
    });
    assert.deepStrictEqual(v, [], `${view}: ${JSON.stringify(v.slice(0, 3))}`);
    // фитиль-режим: вне лобби/итогов у не-доски settings.fuse отсутствует (правило владельца 04.10)
    if (view !== "board") {
      const inGame = frames.map((f) => f.state || (f.type === "state" ? f : null)).filter((s) => s && (s.phase === "countdown" || s.phase === "live"));
      for (const s of inGame) assert.strictEqual(s.settings && s.settings.fuse, undefined, `${view}: settings.fuse ушёл в фазе ${s.phase}`);
    }
  }
  assert.ok(scanned > 10, "кадров мало — проверка пустая: " + scanned);
  assert.ok(cut(b2).some((m) => m.type === "hello" && m.state && m.state.phase === "live"), "hello посреди live не получен");
  // сам сканер ловит подмену (защита от «слепого» теста)
  assert.ok(scanFrames([{ state: { phase: "live", bombs: [{ min: 20 }] } }], { forbiddenKeys: ["min"] }).length === 1);
  b.send({ type: "end" });
  for (const c of [b, b2, anon, late, ...ps]) c.close();
});

// ---- T-W0-31: restore из дампа прошлой версии без новых полей (шаблон — tools/testkit/restore.js) ----
// passN в состоянии не хранится: это passCount(b) по s.log (формат записи {b,from,to,at,held} не менялся с первого коммита),
// поэтому «старый» дамп — тот же формат. Кейс проверяет именно это: после рестарта посреди live телефон получает верный
// passN, бросок с {b,n} проходит, повтор с устаревшим n — rejected stale.
test("restore-from-prev-dump: passN после рестарта считается по s.log; pass с b/n проходит, повтор — stale (T-W0-31)", async () => {
  const restore = require("../tools/testkit/restore");
  // «длинный» фитиль: кейс идёт в реальном времени (бросок, рестарт сервера, испытание) — с коротким (20–45 с)
  // бомба иногда взрывалась до конца кейса, и тест мигал
  const { code, hostToken } = await createRoom({ fuse: "long" });
  let b = await board(code, hostToken);
  const ps = [await player(code, "Аня"), await player(code, "Петя"), await player(code, "Оля")];
  b.send({ type: "start" });
  const live = await b.wait(statePred((s) => s.phase === "live"), 6000);
  const holder = ps.find((p) => p.id === live.state.bombs[0].holder);
  const to = await solveAndThrow(holder, ps.map((p) => p.id)); // бомба перешла один раз: s.log.length === 1
  await b.wait(statePred((s) => s.bombs[0].holder === to && s.passes === 1));
  const tokens = Object.fromEntries(ps.map((p) => [p.id, p.token]));
  for (const c of [b, ...ps]) c.close();
  await stopServer();
  const dump = JSON.parse(fs.readFileSync(DUMP, "utf8"));
  const rec = dump.find((r) => r.code === code);
  assert.ok(rec, "комната в дампе");
  assert.strictEqual(rec.state.log.length, 1);
  assert.ok(!("passN" in rec.state), "passN в состоянии не хранится");
  fs.writeFileSync(DUMP, JSON.stringify(restore.makeOldDump(dump, ["passN"])));
  await startServer();
  b = await board(code, hostToken);
  const hb = await b.wait(statePred((s) => s.phase === "live"));
  assert.strictEqual(hb.state.passes, 1);
  const back = await player(code, "", tokens[to]);
  await back.wait(statePred((s) => s.me && s.me.challenge));
  // после рестарта испытание у держателя могло протухнуть (TTL) и смениться новым — отвечаем на актуальное, до 4 попыток
  let armed = null;
  for (let attempt = 0; attempt < 4 && !armed; attempt++) {
    const c = back.state.me.challenge;
    await sleep(minWait(c));
    back.send({ type: "answer", cid: c.id, ans: solveView(c) });
    try { armed = await back.wait(statePred((s) => s.me && s.me.armed), 2500); } catch { /* испытание сменилось — берём новое */ }
  }
  assert.ok(armed, "держатель вооружился после рестарта");
  assert.strictEqual(armed.state.me.passN[0], 1, "passN восстановлен из log");
  // не «обратно отправителю» (тот, кто бросил первым, — holder): по умолчанию это запрещено
  const target = ps.find((p) => p.id !== to && p.id !== holder.id).id;
  back.send({ type: "pass", to: target, b: 0, n: 1 });
  await b.wait(statePred((s) => s.bombs[0].holder === target && s.passes === 2));
  // повтор с тем же n — устарел
  back.send({ type: "pass", to: ps.find((p) => p.id !== to && p.id !== target).id, b: 0, n: 1 });
  await back.wait((x) => x.type === "rejected" && x.action === "pass" && x.reason === "stale");
  b.send({ type: "end" });
  await b.wait(statePred((s) => s.phase === "finished"));
  for (const x of [b, back]) x.close();
});

// ---- T-W2-14: бросок на офлайн — за RULE_U26_BOMB_ONLINE ----
for (const flag of [true, false]) {
  test(`бросок в закрывшегося: ${flag ? "RULE_U26_BOMB_ONLINE=1 — rejected offline" : "флаг выкл — бросок проходит, как в спеке §4"}`, async () => {
    await stopServer();
    serverEnv = flag ? { RULE_U26_BOMB_ONLINE: "1" } : {};
    await startServer();
    try {
      const { code, hostToken } = await createRoom({ fuse: "long" });
      const b = await board(code, hostToken);
      const ps = [await player(code, "Аня"), await player(code, "Петя"), await player(code, "Оля")];
      b.send({ type: "start" });
      const live = await b.wait(statePred((s) => s.phase === "live"), 6000);
      const holder = ps.find((p) => p.id === live.state.bombs[0].holder);
      const rest = ps.filter((p) => p !== holder);
      // один из двух остальных закрыл вкладку; ждём, пока сервер отметит его «нет связи» (OFFLINE_GRACE_MS=300)
      rest[0].close();
      await b.wait(statePred((s) => s.players.some((p) => p.id === rest[0].id && p.online === false)), 4000);
      const m = await holder.wait(statePred((s) => s.me && s.me.challenge));
      const c = m.state.me.challenge;
      await sleep(minWait(c));
      holder.send({ type: "answer", cid: c.id, ans: solveView(c) });
      await holder.wait(statePred((s) => s.me && s.me.armed));
      holder.send({ type: "pass", to: rest[0].id });
      if (flag) {
        await holder.wait((x) => x.type === "rejected" && x.action === "pass" && x.reason === "offline");
        assert.strictEqual(b.state.bombs[0].holder, holder.id, "бомба не ушла");
        holder.send({ type: "pass", to: rest[1].id }); // живому — можно
        await b.wait(statePred((s) => s.bombs[0].holder === rest[1].id && s.passes === 1));
      } else {
        await b.wait(statePred((s) => s.bombs[0].holder === rest[0].id && s.passes === 1));
      }
      for (const x of [b, ...ps]) x.close();
    } finally {
      await stopServer();
      serverEnv = {};
      await startServer();
    }
  });
}

// ---- T-W2-15: вход по имени (lib/seats), лобби-призраки (lib/presence), left в итогах ----
async function withServerEnv(env, fn) {
  await stopServer();
  serverEnv = env;
  await startServer();
  try { await fn(); } finally {
    await stopServer();
    serverEnv = {};
    await startServer();
  }
}

// клиент с caps:["claim"] — как новая вкладка с MP.joinFlow
async function capsJoin(code, name, extra = {}) {
  const c = client(code);
  await c.open;
  c.send({ type: "join", name, caps: ["claim"], ...extra });
  return c;
}
const isClaim = (m) => m.type === "error" && m.error === "name_claim";

test("тёзка в лобби получает «Имя (2)», joined.name и renamed (bomb-017/038); без caps — то же имя", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Маша");
  const t = await capsJoin(code, "Маша");
  const j = await t.wait((m) => m.type === "joined");
  assert.strictEqual(j.name, "Маша (2)");
  assert.strictEqual(j.renamed, true);
  assert.strictEqual(j.resumed, false);
  const leg = client(code);
  await leg.open;
  leg.send({ type: "join", name: "Маша" });
  const j2 = await leg.wait((m) => m.type === "joined");
  assert.strictEqual(j2.name, "Маша (3)");
  await b.wait(statePred((s) => s.players.filter((p) => !p.left).length === 3));
  assert.deepStrictEqual(b.state.players.map((p) => p.name).sort(), ["Маша", "Маша (2)", "Маша (3)"]);
  for (const c of [b, a, t, leg]) c.close();
});

test("офлайн-место в лобби: клиент с caps — «Это ты?», подтверждение возвращает тот же playerId и отзывает старый токен", async () => {
  await withServerEnv({ CLAIM_GRACE_MS: "300" }, async () => {
    const { code, hostToken } = await createRoom();
    const b = await board(code, hostToken);
    const a = await player(code, "Аня");
    const oldToken = a.token, oldId = a.id;
    a.close();
    await b.wait(statePred((s) => s.players.some((p) => p.id === oldId && p.online === false)), 4000);
    await sleep(350); // грация подхвата (CLAIM_GRACE_MS) прошла
    const c = await capsJoin(code, "аня"); // регистр не важен
    const prompt = await c.wait(isClaim);
    assert.strictEqual(prompt.name, "Аня");
    assert.ok(!c.msgs.some((m) => m.type === "joined"), "без подтверждения место не отдано");
    c.send({ type: "join", name: "аня", caps: ["claim"], claim: true });
    const j = await c.wait((m) => m.type === "joined");
    assert.strictEqual(j.playerId, oldId);
    assert.strictEqual(j.resumed, true);
    assert.strictEqual(j.name, "Аня");
    assert.notStrictEqual(j.token, oldToken);
    // старый токен отозван
    const old = client(code);
    await old.open;
    old.send({ type: "join", token: oldToken });
    await old.wait((m) => m.type === "error" && m.error === "token_gone");
    for (const x of [b, c, old]) x.close();
  });
});

test("«Это ты?» — «Я другой» (fresh) заводит «Имя (2)»; сокет без caps подхватывает место молча, как раньше", async () => {
  await withServerEnv({ CLAIM_GRACE_MS: "200" }, async () => {
    const { code, hostToken } = await createRoom();
    const b = await board(code, hostToken);
    const a = await player(code, "Петя");
    const o = await player(code, "Оля");
    a.close();
    o.close();
    await b.wait(statePred((s) => s.players.every((p) => p.online === false)), 4000);
    await sleep(250);
    const c = await capsJoin(code, "Петя");
    await c.wait(isClaim);
    c.send({ type: "join", name: "Петя", caps: ["claim"], fresh: true });
    const j = await c.wait((m) => m.type === "joined");
    assert.notStrictEqual(j.playerId, a.id);
    assert.strictEqual(j.name, "Петя (2)");
    const legacy = client(code);
    await legacy.open;
    legacy.send({ type: "join", name: "Оля" });
    const j2 = await legacy.wait((m) => m.type === "joined");
    assert.strictEqual(j2.playerId, o.id, "старая вкладка без caps — молчаливый подхват");
    assert.strictEqual(j2.resumed, true);
    for (const x of [b, c, legacy]) x.close();
  });
});

test("сразу после обрыва (в грации) клиент с caps получает name_claim retry:true, затем — «Это ты?»", async () => {
  await withServerEnv({ CLAIM_GRACE_MS: "1200" }, async () => {
    const { code, hostToken } = await createRoom();
    const b = await board(code, hostToken);
    const a = await player(code, "Игорь");
    a.close();
    await sleep(60);
    const c = await capsJoin(code, "Игорь");
    const r = await c.wait(isClaim);
    assert.strictEqual(r.retry, true);
    assert.ok(r.retryInMs > 0 && r.retryInMs <= 1200);
    await sleep(r.retryInMs + 100);
    c.send({ type: "join", name: "Игорь", caps: ["claim"] });
    const p = await c.wait((m) => isClaim(m) && !m.retry);
    assert.strictEqual(p.name, "Игорь");
    for (const x of [b, c]) x.close();
  });
});

test("лобби-призрак уходит через GHOST_TTL_MS, в игре и в итогах места не освобождаются; токен убранного — token_gone", async () => {
  await withServerEnv({ GHOST_TTL_MS: "1500" }, async () => {
    // лобби
    {
      const { code, hostToken } = await createRoom();
      const b = await board(code, hostToken);
      const a = await player(code, "Аня");
      const p = await player(code, "Петя");
      const gone = p.id, goneToken = p.token;
      p.close();
      await b.wait(statePred((s) => s.players.some((x) => x.id === gone && x.online === false)), 4000);
      await sleep(600);
      assert.ok(b.state.players.some((x) => x.id === gone), "до порога призрак на месте");
      await b.wait(statePred((s) => !s.players.some((x) => x.id === gone)), 8000);
      assert.strictEqual(b.state.players.length, 1);
      const back = client(code);
      await back.open;
      back.send({ type: "join", token: goneToken });
      await back.wait((m) => m.type === "error" && m.error === "token_gone");
      for (const x of [b, a, back]) x.close();
    }
    // игра и итоги
    {
      const { code, hostToken } = await createRoom({ fuse: "long" });
      const b = await board(code, hostToken);
      const ps = [await player(code, "Аня"), await player(code, "Петя"), await player(code, "Оля")];
      b.send({ type: "start" });
      await b.wait(statePred((s) => s.phase === "live"), 6000);
      const victim = ps[1];
      victim.close();
      await b.wait(statePred((s) => s.players.some((x) => x.id === victim.id && x.online === false)), 4000);
      await sleep(2200); // дольше GHOST_TTL_MS
      assert.ok(b.state.players.some((x) => x.id === victim.id && !x.left), "в игре место не освобождается по таймеру");
      b.send({ type: "end" });
      await b.wait(statePred((s) => s.phase === "finished"));
      await sleep(2200);
      assert.ok(b.state.players.some((x) => x.id === victim.id), "в итогах призрак тоже остаётся (на нём статистика)");
      for (const x of [b, ...ps]) x.close();
    }
  });
});

test("N1: «Выйти» в итогах не стирает запись — проигравший в итогах с именем, без «?»", async () => {
  const { code, hostToken } = await createRoom({ fuse: "short" });
  const b = await board(code, hostToken);
  const ps = [await player(code, "Аня"), await player(code, "Петя")];
  b.send({ type: "start" });
  await b.wait(statePred((s) => s.phase === "live"), 6000);
  const fin = await b.wait(statePred((s) => s.phase === "finished"), 60000);
  const loser = fin.state.loserId;
  const lp = ps.find((p) => p.id === loser);
  assert.ok(lp, "проигравший — один из игроков");
  lp.send({ type: "leave" });
  const after = await b.wait(statePred((s) => s.phase === "finished" && s.players.some((x) => x.id === loser && x.left === true)));
  const rec = after.state.players.find((x) => x.id === loser);
  assert.ok(rec && rec.name, "запись и имя на месте");
  assert.strictEqual(after.state.loserId, loser);
  for (const x of [b, ...ps]) x.close();
});

test("в игре: без RULE_U01_CLAIM_IN_GAME офлайн-место возвращается по имени молча (как раньше), с флагом — «Это ты?»", async () => {
  for (const flag of [false, true]) {
    await withServerEnv(flag ? { RULE_U01_CLAIM_IN_GAME: "1", CLAIM_GRACE_MS: "200" } : { CLAIM_GRACE_MS: "200" }, async () => {
      const { code, hostToken } = await createRoom({ fuse: "long" });
      const b = await board(code, hostToken);
      const ps = [await player(code, "Аня"), await player(code, "Петя"), await player(code, "Оля")];
      b.send({ type: "start" });
      await b.wait(statePred((s) => s.phase === "live"), 6000);
      const v = ps[0];
      v.close();
      await b.wait(statePred((s) => s.players.some((x) => x.id === v.id && x.online === false)), 4000);
      await sleep(250);
      const c = await capsJoin(code, "Аня");
      if (flag) {
        const prompt = await c.wait(isClaim);
        assert.strictEqual(prompt.name, "Аня");
        c.send({ type: "join", name: "Аня", caps: ["claim"], claim: true });
      }
      const j = await c.wait((m) => m.type === "joined");
      assert.strictEqual(j.playerId, v.id);
      assert.strictEqual(j.resumed, true);
      // новое имя посреди раунда — как раньше «раунд идёт»
      const late = await capsJoin(code, "Опоздун");
      await late.wait((m) => m.type === "error" && m.error === "game_started");
      b.send({ type: "end" });
      for (const x of [b, c, late, ...ps]) x.close();
    });
  }
});

// ---- T-W2-16: быстрый пинг комнат «в игре» ----
test("быстрый пинг в игре: сокет, не отвечающий на ping, закрывается за ~20–35 с, живой остаётся; лобби не трогаем", async () => {
  await withServerEnv({ PING_MS: "1000", GAME_DEAD_MS: "20000", GAME_PONG_MISSES: "2" }, async () => {
    const { code, hostToken } = await createRoom({ fuse: "long" });
    const b = await board(code, hostToken);
    const live = [await player(code, "Аня"), await player(code, "Петя")];
    // «мёртвый» телефон: сокет открыт, но на ping протокола не отвечает
    const dead = new WebSocket(`ws://127.0.0.1:${port}/bomb/ws?r=${code}`, { autoPong: false });
    await new Promise((res, rej) => { dead.once("open", res); dead.once("error", rej); });
    dead.send(JSON.stringify({ type: "join", name: "Тишина" }));
    await new Promise((res) => dead.on("message", (raw) => { if (JSON.parse(raw).type === "joined") res(); }));
    const closed = new Promise((res) => dead.once("close", () => res(Date.now())));
    // в лобби пока не рвём: даём ему «провисеть» 3 с без пингов игры
    await sleep(3000);
    assert.strictEqual(dead.readyState, 1, "в лобби быстрый пинг молчит");
    const t0 = Date.now();
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "live"), 6000);
    const at = await Promise.race([closed, sleep(40000).then(() => null)]);
    assert.ok(at, "мёртвый сокет закрыт сервером");
    const secs = (at - t0) / 1000;
    assert.ok(secs >= 14 && secs <= 36, "закрыт за " + secs + " с");
    assert.ok(live.every((p) => p.ws.readyState === 1), "живые сокеты на месте");
    for (const x of [b, ...live]) x.close();
  });
});
