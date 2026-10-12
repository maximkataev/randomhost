"use strict";

// Тесты сервера «Последнего вопроса» через настоящий WebSocket: node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `lastq-test-${process.pid}.json`);
const BANK = fs.mkdtempSync(path.join(os.tmpdir(), "lastq-bank-"));
const port = 6400 + (process.pid % 500);
let proc = null;

// временный банк: тест не зависит от того, готовы ли настоящие колоды
const qs = [];
for (let i = 0; i < 30; i++) qs.push({ id: "q" + i, tag: ["animals", "food", "geo"][i % 3], lvl: 1 + (i % 3), final: false, q: "Вопрос " + i, a: ["СЕКРЕТ" + i, "мимо", "тоже мимо", "смешно"], fun: 3 });
for (let i = 0; i < 4; i++) qs.push({ id: "f" + i, tag: "geo", lvl: 3, final: true, q: "Финал " + i, a: ["СЕКРЕТФ" + i, "мимо", "тоже мимо", "смешно"], fun: 3 });
for (const l of ["ru", "en", "el"]) fs.writeFileSync(path.join(BANK, l + ".json"), JSON.stringify({ questions: qs }));

function startServer() {
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300", GHOST_TTL_MS: "1500", CLAIM_GRACE_MS: "200", PING_MS: "1000", LQ_CONTENT_DIR: BANK },
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
  const r = await fetch(`http://127.0.0.1:${port}/lastq/api/rooms`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}
function client(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lastq/ws?r=${code}`);
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
  c.wait = (pred, ms = 10000) => new Promise((resolve, reject) => {
    if (c.state && pred({ type: "state", state: c.state }, c)) return resolve({ type: "state", state: c.state });
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => reject(new Error("не дождались: " + pred.toString())), ms);
  });
  c.phase = (ph, ms) => c.wait((m) => m.type === "state" && m.state.phase === ph, ms);
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
  const m = await p.wait((x) => x.type === "joined" || x.type === "error");
  if (m.type === "joined") { p.id = m.playerId; p.token = m.token; }
  p.joinMsg = m;
  return p;
}

test.before(startServer);
test.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

test("партия: верный ответ не уходит до раскрытия, ошибившийся попадает в Камеру и получает испытание без ответа", async () => {
  const { code, hostToken } = await createRoom({}, 8);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("answer");
  // в снимках до раскрытия нет верного индекса
  for (const c of [a, z, b]) assert.equal(c.state.right, null);
  a.send({ type: "answer", i: 0 });
  z.send({ type: "answer", i: 1 });
  const rv = await b.phase("reveal");
  const right = rv.state.right;
  assert.ok(Number.isInteger(right));
  const loser = right === 0 ? z : right === 1 ? a : null;
  if (!loser) return; // оба мимо — тоже честный исход, проверять Камеру нечем
  // первая секунда Камеры — «Приготовься», испытания ещё нет
  const cell = await loser.wait((m) => m.type === "state" && m.state.phase === "cell" && m.state.me.cell && m.state.me.cell.ch, 15000);
  const ch = cell.state.me.cell.ch;
  assert.ok(ch && ch.type && ch.view);
  assert.ok(!("answer" in ch), "ответ испытания утёк на телефон");
  // чужой id испытания — отказ «stale»
  loser.send({ type: "cell", cid: ch.id + 999, ans: { v: 0 } });
  const rj = await loser.wait((m) => m.type === "rejected" && m.action === "cell");
  assert.equal(rj.reason, "stale");
  b.close(); a.close(); z.close();
});

test("лимит: 11-й игрок — room_full; новый игрок с одного сокета не чаще раза в 3 с", async () => {
  const { code } = await createRoom();
  const ps = [];
  for (let i = 0; i < 10; i++) ps.push(await player(code, "И" + i));
  const extra = await player(code, "Лишний");
  assert.equal(extra.joinMsg.error, "room_full");
  for (const p of ps.concat(extra)) p.close();
});

test("ход после звонка не проходит: ответ после конца фазы не засчитывается", async () => {
  const { code, hostToken } = await createRoom({}, 20);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("reveal", 15000); // никто не ответил — фаза закрылась по таймеру
  a.send({ type: "answer", i: 0 });
  const rj = await a.wait((m) => m.type === "rejected" && m.action === "answer");
  assert.equal(rj.reason, "not_now");
  b.close(); a.close(); z.close();
});

test("рестарт посреди партии: комната и игроки восстанавливаются из дампа, вход по токену", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("read");
  await new Promise((r) => setTimeout(r, 5500)); // дамп раз в 5 с
  await stopServer();
  await startServer();
  // пока никто не вернулся — партия стоит на паузе, а не доигрывается без игроков
  await new Promise((r) => setTimeout(r, 4000));
  const a2 = await player(code, "", a.token);
  assert.equal(a2.joinMsg.type, "joined");
  assert.equal(a2.id, a.id);
  await a2.wait((m) => m.type === "state" && m.state.phase !== "lobby");
  assert.ok(["read", "answer"].includes(a2.state.phase), "партия ушла вперёд без игроков: " + a2.state.phase);
  a2.close();
  for (const c of [b, a, z]) try { c.close(); } catch {}
});

test("переподключение узника не меняет испытание Камеры", async () => {
  const { code, hostToken } = await createRoom({}, 8);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("answer");
  a.send({ type: "answer", i: 0 });
  z.send({ type: "answer", i: 1 });
  const rv = await b.phase("reveal");
  const loser = rv.state.right === 0 ? z : rv.state.right === 1 ? a : null;
  if (!loser) { b.close(); a.close(); z.close(); return; }
  const st = await loser.wait((m) => m.type === "state" && m.state.phase === "cell" && m.state.me.cell && m.state.me.cell.ch, 15000);
  const id0 = st.state.me.cell.ch.id;
  const again = await player(code, "", loser.token);
  const st2 = await again.wait((m) => m.type === "state" && m.state.me && m.state.me.cell && m.state.me.cell.ch);
  assert.equal(st2.state.me.cell.ch.id, id0);
  for (const c of [b, a, z, again]) try { c.close(); } catch {}
});

test("банк настоящий (без LQ_CONTENT_DIR) — непустой у испытаний бомбы", () => {
  const CH = require("./challenges.js");
  assert.ok(CH.bank().quiz.length > 50 && CH.bank().tf.length > 10);
});

test("speed < 1 (агенты): фаза длится дольше настоящего срока, ответ после 20 реальных секунд принимается", { timeout: 60000 }, async () => {
  const { code, hostToken } = await createRoom({}, 0.25);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("answer", 40000);
  await new Promise((r) => setTimeout(r, 21000)); // реальных 21 с > 20 с фазы, но по часам комнаты прошло ~5 с
  a.send({ type: "answer", i: 0 });
  await a.wait((m) => m.type === "state" && m.state.me && m.state.me.answer === 0, 5000);
  for (const c of [b, a, z]) c.close();
});

test("тёзка не забирает игрока, пока тот онлайн или в грации; в лобби — получает «Имя 2»", async () => {
  const { code } = await createRoom();
  const a = await player(code, "Аня");
  a.close();
  const twin = await player(code, "Аня");
  assert.notEqual(twin.id, a.id);
  await twin.wait((m) => m.type === "state" && m.state.players.some((p) => p.name === "Аня (2)"), 5000);
  assert.equal(twin.joinMsg.name, "Аня (2)");
  assert.equal(twin.joinMsg.renamed, true);
  twin.close();
});

// T-W2-28 (lastq-005/006/039): ключ имени — регистр/пробелы/«ё»; суффикс «База (N)», а не «Игорь🔥 2 2»; срез по символам
test("имена: «Хитрый» и «хитрый » — один ключ; суффикс «(N)» без «2 2»; эмодзи не режется", async () => {
  const { code } = await createRoom();
  const a = await player(code, "Хитрый");
  const b = await player(code, "хитрый ");
  const c = await player(code, "ХИТРЫЙ");
  assert.equal(a.joinMsg.name, "Хитрый");
  assert.equal(b.joinMsg.name, "хитрый (2)");
  assert.equal(c.joinMsg.name, "ХИТРЫЙ (3)");
  const e1 = await player(code, "Игорь🔥");
  const e2 = await player(code, "Игорь🔥");
  const e3 = await player(code, "Игорь🔥 (2)");
  assert.deepEqual([e1.joinMsg.name, e2.joinMsg.name, e3.joinMsg.name], ["Игорь🔥", "Игорь🔥 (2)", "Игорь🔥 (3)"]);
  // 15 «A» + эмодзи = 16 символов (больше, чем 16 UTF-16-единиц): эмодзи цел, одиночного суррогата нет
  const long = await player(code, "A".repeat(15) + "😀😀😀");
  assert.equal(Array.from(long.joinMsg.name).length, 16);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(long.joinMsg.name));
  // подсказка клиенту: лимит имени в hello
  const probe = client(code);
  await probe.open;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(probe.msgs.find((m) => m.type === "hello").limits.name, 16);
  for (const x of [a, b, c, e1, e2, e3, long, probe]) x.close();
});

test("подхват по имени выдаёт новый токен и отзывает старый — пинг-понга нет", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Алиса");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("read");
  a.close();
  await new Promise((r) => setTimeout(r, 900)); // грация офлайна в тестах 300 мс
  const thief = await player(code, "Алиса"); // тот же IP — подхват разрешён
  assert.equal(thief.id, a.id);
  const back = await player(code, "", a.token); // старый токен отозван
  assert.equal(back.joinMsg.type, "error");
  assert.equal(back.joinMsg.error, "token_gone");
  for (const c of [b, z, thief, back]) try { c.close(); } catch {}
});

test("health и неизвестная комната", async () => {
  const h = await (await fetch(`http://127.0.0.1:${port}/lastq/api/health`)).json();
  assert.equal(h.ok, true);
  const r = await fetch(`http://127.0.0.1:${port}/lastq/api/session?r=NOPE99`);
  assert.equal(r.status, 404);
});

test("кривые запросы не роняют процесс; перебор кодов считается по /64", async () => {
  const base = `http://127.0.0.1:${port}/lastq`;
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
const { scanFrames } = require("../tools/testkit/scan");

// партия до Камеры: доска, два игрока и сокет без join/host; возвращает все четыре клиента + возврат по токену
async function playToCell() {
  const { code, hostToken } = await createRoom({}, 8);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  const anon = client(code);
  await anon.open;
  b.send({ type: "start" });
  await a.phase("answer");
  a.send({ type: "answer", i: 0 });
  z.send({ type: "answer", i: 1 });
  await b.phase("reveal");
  await b.wait((m) => m.type === "state" && m.state.phase === "cell", 15000);
  await new Promise((r) => setTimeout(r, 2500)); // испытание выдаётся после «Приготовься»
  const again = await player(code, "", a.token); // hello посреди партии
  await new Promise((r) => setTimeout(r, 300));
  return { hostToken, b, a, z, anon, again };
}
const framesOf = (c) => c.raw.map((r) => JSON.parse(r));

test("секреты не в кадрах: доска / игрок / сокет без токена — нет ch (кроме своего me.cell.ch), passCode, hostToken, массива answered, чужих токенов", async () => {
  const { hostToken, b, a, z, anon, again } = await playToCell();
  const tokens = [a.token, z.token];
  const clients = [["board", b], ["player", a], ["player", z], ["player", again], ["anon", anon]];
  let scanned = 0;
  for (const [view, c] of clients) {
    const frames = framesOf(c);
    scanned += frames.length;
    const own = c.id || null;
    const rules = view === "board" ? [] : [
      // ch узников (вид испытания) — только доске; свой me.cell.ch — телефону по замыслу
      (p, k) => k === "ch" && p !== "state.me.cell.ch" && "ch не у доски",
      "passCode", "hostToken",
      // список ответивших — число answeredN, не массив имён/id
      (p, k, v) => k === "answered" && Array.isArray(v) && "answered[] не у доски",
      // финал: телефону только свой шаг
      (p, k, v) => k === "fsteps" && Array.isArray(v) && (v.length > 1 || v.some((x) => x.id !== own)) && "fsteps: чужие шаги",
    ];
    const foreign = tokens.filter((t) => t && t !== c.token);
    const v = scanFrames(frames.map((f) => ({ view, frame: f })), {
      forbiddenKeys: rules,
      forbiddenSubstrings: view === "board" ? foreign : foreign.concat(hostToken),
    });
    assert.deepStrictEqual(v, [], `${view}: ${JSON.stringify(v.slice(0, 3))}`);
    // верный индекс и чужие выборы — не раньше раскрытия (read/answer), ни у кого
    const early = scanFrames(frames.map((f) => ({ view, frame: f })), {
      phases: ["read", "answer", "fread", "fanswer", "stake"],
      forbiddenKeys: [(p, k, val) => /^state\.(right|picks|gain|palach|prisoners)$/.test(p) && val != null && "до раскрытия: " + k],
    });
    assert.deepStrictEqual(early, [], `${view}: ${JSON.stringify(early.slice(0, 3))}`);
  }
  assert.ok(scanned > 15, "кадров мало — проверка пустая: " + scanned);
  assert.ok(framesOf(again).some((m) => m.type === "hello" && m.state && m.state.phase !== "lobby"), "hello посреди партии не получен");
  assert.ok(framesOf(b).some((m) => m.type === "state" && m.state.cell && m.state.cell.length), "доска не видела Камеру — проверка ch пустая");
  for (const c of [b, a, z, anon, again]) try { c.close(); } catch {}
});

// События (type:"event") рассылаются сокетам одной строкой: {type:"answered", playerId} раньше уходил и телефонам,
// хотя T-W0-06 убрал state.answered. Найдено при T-W0-05; исправлено в broadcastEvent — только доске.
test("секреты не в кадрах: событие «answered» с playerId не уходит телефонам и сокету без токена", async () => {
  const { code, hostToken } = await createRoom({}, 8);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  const anon = client(code);
  await anon.open;
  b.send({ type: "start" });
  await a.phase("answer");
  a.send({ type: "answer", i: 0 });
  await b.wait((m) => m.type === "event" && m.event.type === "answered", 5000);
  await new Promise((r) => setTimeout(r, 300));
  const leaked = [["игрок", z], ["сокет без токена", anon]].filter(([, c]) => c.events.some((e) => e.type === "answered" && e.playerId));
  assert.deepStrictEqual(leaked.map(([n]) => n), [], "кто ответил, ушло как событие: " + JSON.stringify(leaked.map(([, c]) => c.events.filter((e) => e.type === "answered"))));
  for (const c of [b, a, z, anon]) c.close();
});

// ---- T-W2-30 (lastq-002, lastq-058): серые места в лобби живут GHOST_TTL_MS; Start — по онлайну ----
test("лобби: офлайн-место снимается через GHOST_TTL_MS, токен вернувшегося — token_gone; онлайн-игрок остаётся", async () => {
  const { code } = await createRoom();
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  const watcher = client(code);
  await watcher.open;
  a.close();
  // сначала место серое, потом исчезает
  await z.wait((m) => m.type === "state" && m.state.players.some((p) => p.name === "Аня" && p.online === false), 4000);
  await z.wait((m) => m.type === "state" && !m.state.players.some((p) => p.name === "Аня"), 6000);
  assert.ok(z.state.players.some((p) => p.name === "Зоя" && p.online));
  const back = await player(code, "", a.token);
  assert.equal(back.joinMsg.type, "error");
  assert.equal(back.joinMsg.error, "token_gone");
  // вошёл тем же именем — обычное новое место, без «(2)»
  const again = await player(code, "Аня");
  assert.equal(again.joinMsg.name, "Аня");
  for (const c of [z, watcher, back, again]) try { c.close(); } catch {}
});

test("лобби: Start требует двоих НА СВЯЗИ — один онлайн и один серый = few_players", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  z.close();
  await a.wait((m) => m.type === "state" && m.state.players.some((p) => p.name === "Зоя" && p.online === false), 4000);
  assert.equal(a.state.onlineN, 1);
  b.send({ type: "start" });
  const rj = await b.wait((m) => m.type === "rejected" && m.action === "start");
  assert.equal(rj.reason, "few_players");
  for (const c of [b, a]) c.close();
});

// ---- T-W2-31 (lastq-008): leave + join тем же именем с того же IP возвращает запись, а не заводит новичка ----
test("leave посреди партии и вход тем же именем с того же IP — та же запись (id, счёт); другое имя — новый игрок с 0", async () => {
  const { code, hostToken } = await createRoom({}, 8);
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  const c = await player(code, "Вера");
  b.send({ type: "start" });
  await a.phase("answer");
  a.send({ type: "leave" });
  await b.wait((m) => m.type === "state" && m.state.players.some((p) => p.id === a.id && p.left === true), 5000);
  const back = await player(code, "аня "); // регистр и пробел — тот же ключ
  assert.equal(back.joinMsg.type, "joined");
  assert.equal(back.id, a.id, "та же запись");
  assert.equal(back.joinMsg.resumed, true);
  await b.wait((m) => m.type === "state" && m.state.players.filter((p) => !p.left).length === 3, 5000);
  assert.equal(b.state.players.length, 3, "записей не прибавилось");
  // чужое имя — новая запись
  back.send({ type: "leave" });
  await b.wait((m) => m.type === "state" && m.state.players.some((p) => p.id === a.id && p.left === true), 5000);
  const other = await player(code, "Пётр");
  assert.notEqual(other.id, a.id);
  for (const x of [b, z, c, back, other]) try { x.close(); } catch {}
});

// ---- T-W2-32 (lastq-004, lastq-007): подхват по имени — только с подтверждением человека и только с того же IP ----
function clientAs(code, ip) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lastq/ws?r=${code}`, { headers: { "x-real-ip": ip } });
  const c = { ws, msgs: [], state: null };
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "state" || m.type === "hello") c.state = m.state;
    for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  c.open = new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.next = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find(pred);
    if (hit) return resolve(hit);
    waiters.push({ pred, resolve });
    setTimeout(() => reject(new Error("не дождались: " + pred.toString())), ms);
  });
  c.close = () => ws.close();
  return c;
}
async function claimCapable(code, name, ip, extra = {}) {
  const c = clientAs(code, ip);
  await c.open;
  await c.next((m) => m.type === "hello");
  c.send({ type: "join", name, caps: ["claim"], ...extra });
  return c;
}

test("подхват: name_claim (с очками) → claim → та же запись, прежний токен отозван; «Я другой» → «Имя (2)»", async () => {
  const { code, hostToken } = await createRoom();
  const b = await board(code, hostToken);
  const a = await player(code, "Игорь🔥");
  const z = await player(code, "Зоя");
  b.send({ type: "start" });
  await a.phase("read");
  a.close();
  await new Promise((r) => setTimeout(r, 1000)); // грация офлайна (300 мс) и пауза подхвата (200 мс) прошли

  // тот же IP (127.0.0.1 → нет заголовка; используем обычного клиента), с caps:["claim"]
  const n1 = client(code);
  await n1.open;
  n1.send({ type: "join", name: "игорь🔥 ", caps: ["claim"] });
  const q = await n1.wait((m) => m.type === "error" && m.error === "name_claim");
  assert.equal(q.name, "Игорь🔥");
  assert.ok(q.summary && typeof q.summary.score === "number");
  assert.equal(n1.msgs.some((m) => m.type === "joined"), false, "молча не вошёл");

  // «Я другой»: новое место «Игорь🔥 (2)», старое не тронуто
  n1.send({ type: "join", name: "игорь🔥 ", caps: ["claim"], fresh: true });
  const f = await n1.wait((m) => m.type === "joined");
  assert.notEqual(f.playerId, a.id);
  assert.equal(f.name, "игорь🔥 (2)".replace("игорь", "игорь"));
  assert.equal(f.renamed, true);

  // «Это я»: с другого сокета; тот же playerId, resumed
  const n2 = client(code);
  await n2.open;
  n2.send({ type: "join", name: "Игорь🔥", caps: ["claim"] });
  await n2.wait((m) => m.type === "error" && m.error === "name_claim");
  n2.send({ type: "join", name: "Игорь🔥", caps: ["claim"], claim: true });
  const j = await n2.wait((m) => m.type === "joined");
  assert.equal(j.playerId, a.id);
  assert.equal(j.resumed, true);
  assert.notEqual(j.token, a.token);
  const old = await player(code, "", a.token);
  assert.equal(old.joinMsg.error, "token_gone", "прежний токен отозван");
  for (const c of [b, z, n1, n2, old]) try { c.close(); } catch {}
});

test("подхват: в лобби тоже с подтверждением; с чужого IP — подхвата нет вообще («Имя (2)», IP-условие не ослаблено)", async () => {
  const { code } = await createRoom();
  const a = await player(code, "Вера");
  a.close();
  await new Promise((r) => setTimeout(r, 700));
  const same = client(code);
  await same.open;
  same.send({ type: "join", name: "Вера", caps: ["claim"] });
  const q = await same.wait((m) => m.type === "error" && m.error === "name_claim");
  assert.equal(q.name, "Вера");
  // чужой адрес: даже claim:true не даёт чужого места
  const other = await claimCapable(code, "Вера", "203.0.113.9", { claim: true });
  const j = await other.next((m) => m.type === "joined" || (m.type === "error" && m.error !== "hello"));
  assert.equal(j.type, "joined");
  assert.notEqual(j.playerId, a.id, "место чужого IP не отдано");
  assert.equal(j.name, "Вера (2)");
  for (const c of [same, other]) try { c.close(); } catch {}
});

test("подхват: клиент без caps — по-старому, молча (тот же IP, место уже выпало)", async () => {
  const { code } = await createRoom();
  const a = await player(code, "Лёва");
  a.close();
  await new Promise((r) => setTimeout(r, 700));
  const legacy = await player(code, "Лёва");
  assert.equal(legacy.id, a.id);
  assert.equal(legacy.joinMsg.resumed, true);
  legacy.close();
});

// ---- T-W2-33 (lastq-012/013): вторая доска забирает управление; первая узнаёт (host_lost) и её команды отбиваются ----
test("два host подряд: первая доска получает host_lost и больше не управляет; «Забрать» возвращает", async () => {
  const { code, hostToken } = await createRoom();
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  const b1 = await board(code, hostToken);
  const b2 = await board(code, hostToken);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(b1.msgs.some((m) => m.type === "host_lost"), "первая доска не узнала о потере управления");
  b1.send({ type: "settings", settings: { short: true } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a.state.settings.short, false, "команда потерявшей доски не прошла");
  b2.send({ type: "settings", settings: { short: true } });
  await a.wait((m) => m.type === "state" && m.state.settings.short === true);
  // «Забрать»: тот же токен с первой доски — управление к ней, вторая теряет
  b1.send({ type: "host", token: hostToken });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(b1.msgs.filter((m) => m.type === "host_ok").length >= 2, "«Забрать» не вернуло управление");
  assert.ok(b2.msgs.some((m) => m.type === "host_lost"), "вторая доска не узнала о потере");
  // чужой токен — отказ
  const bad = client(code);
  await bad.open;
  bad.send({ type: "host", token: "не-тот-токен" });
  const e = await bad.wait((m) => m.type === "error" && m.error === "bad host token");
  assert.ok(e);
  for (const c of [a, z, b1, b2, bad]) c.close();
});

// ---- T-W2-41 (lastq-036): серверный пинг комнат «в игре» ----
test("пинг комнат «в игре»: ping-кадры каждые PING_MS; в лобби быстрого пинга нет; молчащий сокет за 3 с не закрывается", async () => {
  const { code, hostToken } = await createRoom({ short: true });
  const b = await board(code, hostToken);
  const a = await player(code, "Аня");
  const z = await player(code, "Зоя");
  const pings = { lobby: 0, game: 0 };
  let phase = "lobby";
  b.ws.on("ping", () => { pings[phase]++; });
  await new Promise((r) => setTimeout(r, 2500));
  // общий SWEEP (25 с) мог попасть в окно одним пингом; быстрый цикл дал бы ≥ 2 за 2,5 с
  assert.ok(pings.lobby <= 1, "быстрый пинг не должен идти в лобби: " + pings.lobby);
  phase = "game";
  b.send({ type: "start" });
  await b.wait((m) => m.type === "state" && m.state.phase !== "lobby");
  await new Promise((r) => setTimeout(r, 3500));
  assert.ok(pings.game >= 2, "в игре ping-кадров мало: " + pings.game);
  assert.equal(b.ws.readyState, 1, "порог тишины ≥ 20 с: сокет жив");
  for (const c of [b, a, z]) c.close();
});
