"use strict";

// Тесты сервера «Блэкджека» через настоящий WebSocket (docs/blackjack-spec.md §12): node --test test-server.js
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const WebSocket = require("ws");

const DUMP = path.join(os.tmpdir(), `blackjack-test-${process.pid}.json`);
let port = 0;
let proc = null;
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require("node:net").createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function startServer(env = {}) {
  if (!port) port = await freePort();
  proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DUMP_FILE: DUMP, OFFLINE_GRACE_MS: "300", ANON_TTL_MS: "1500", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  proc.log = () => log;
  return new Promise((resolve, reject) => {
    // 15 с, а не 5: на нагруженной машине (соседние сессии гоняют свои стенды) node с ws поднимается дольше
    const t = setTimeout(() => reject(new Error("сервер не поднялся: " + log)), 15000);
    proc.stdout.on("data", () => { if (/порт/.test(log)) { clearTimeout(t); resolve(); } });
  });
}

function stopServer(signal = "SIGTERM") {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    const p = proc;
    // не вышел за 3 с — добиваем, иначе раннер висит вечно
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 3000);
    p.once("exit", () => { clearTimeout(kill); resolve(); });
    p.kill(signal);
  });
}

async function createRoom(settings = {}, speed = 1, bots = 0) {
  const r = await fetch(`http://127.0.0.1:${port}/blackjack/api/rooms${bots ? "?bots=" + bots : ""}`, { method: "POST", body: JSON.stringify({ settings, speed }) });
  return r.json();
}

function client(code, headers = {}, query = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/blackjack/ws?r=${code}${query}`, { headers });
  const c = { ws, msgs: [], raw: [], state: null, states: [], events: [] };
  const waiters = [];
  ws.on("message", (raw) => {
    c.raw.push(String(raw));
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === "state" || m.type === "hello") { c.state = m.state; c.states.push(m.state); }
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
  // после host_ok сервер шлёт второй hello — уже с видом доски; первый был анонимным (телефонным), на него полагаться нельзя
  const hellos = () => b.msgs.filter((m) => m.type === "hello").length;
  for (let i = 0; hellos() < 2 && i < 500; i++) await sleep(10);
  assert.ok(hellos() >= 2, "доска не получила снимок ведущего");
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
const IN_HAND = ["closing", "dealing", "insurance", "deciding", "dealer", "payout"];

/*
 * Автопилот телефона: на каждом снимке ставит два минимума и жмёт «Готово» (если bet), на страховку отвечает «нет»,
 * по каждой руке в каждой волне — «Хватит». Каждое действие — один раз на раздачу/волну, иначе дубли на каждом снимке.
 */
function autopilot(p, opts = {}) {
  const bet = opts.bet !== false;
  const done = new Set();
  const once = (key, fn) => { if (done.has(key)) return; done.add(key); fn(); };
  p.ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== "state" && m.type !== "hello") return;
    const s = m.state;
    const me = s.players.find((x) => x.id === p.id);
    if (!me || me.out || me.left) return;
    if (s.phase === "betting" && bet && !me.ready) once("bet" + s.game + ":" + s.hand, () => {
      p.send({ type: "set_bets", main: Math.max(me.need, Math.min(me.stack, 20)), pp: 0, tp: 0 });
      p.send({ type: "ready", ready: true });
    });
    if (s.phase === "insurance" && s.dealer && s.dealer.insurance && me.inHand && !me.insDecided) once("ins" + s.hand, () => p.send({ type: "insure", choice: false }));
    if (s.phase === "deciding" && me.inHand) me.hands.forEach((h, i) => {
      if (h.options && !h.decision) once(`d${s.hand}:${s.wave}:${i}`, () => p.send({ type: "decide", hand: i, action: opts.decide || "stand" }));
    });
  });
  return p;
}

// инвариант движка (§12): фишки игроков + выигрыш казино − выплаты казино = N × стек
function chipsOk(s, n) {
  const total = s.players.filter((p) => !p.spectator).reduce((a, p) => a + p.stack, 0) + s.casino.won - s.casino.paid;
  assert.strictEqual(total, n * s.settings.stack, "фишки не сходятся: " + total);
}

test("сервер", async (t) => {
  await startServer();
  t.after(async () => { await stopServer(); try { fs.unlinkSync(DUMP); } catch {} });

  await t.test("12 игроков + доска проходят раздачу: ставки → раздача → решения → дилер → выплаты, фишки сходятся", async () => {
    const room = await createRoom({ betTime: 15000 }, 6);
    const b = await board(room.code, room.hostToken);
    const ps = [];
    for (let i = 0; i < 12; i++) { ps.push(autopilot(await player(room.code, "Игрок " + i))); await sleep(5); }
    assert.strictEqual(b.state.players.length, 12);
    const extra = client(room.code);
    await extra.open;
    extra.send({ type: "join", name: "Лишний" });
    const r = await extra.wait((m) => m.type === "error" || m.type === "joined");
    assert.strictEqual(r.error, "room_full", "13-й игрок получает «Комната заполнена»");
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "betting" && s.hand === 1));
    await b.wait(statePred((s) => s.phase === "closing"), 5000); // все «Готово» — ставки закрылись досрочно, не по таймеру
    await b.wait(statePred((s) => s.phase === "dealing"));
    assert.strictEqual(b.state.dealing.length, 26, "порядок сдачи: по две карты 12 игрокам и дилеру");
    await b.wait(statePred((s) => s.phase === "dealer"), 15000);
    assert.ok(b.state.dealer.hole, "доска знает закрытую карту с начала фазы dealer");
    assert.ok(b.state.dealer.plot, "и сюжет");
    assert.ok(b.state.dealer.revealAt.length >= 2, "расписание показа по карте");
    await b.wait(statePred((s) => s.phase === "payout"), 15000);
    chipsOk(b.state, 12);
    for (const p of b.state.players) {
      assert.ok(p.inHand, p.name + " играл раздачу");
      for (const h of p.hands) assert.ok(["win", "lose", "push", "bj"].includes(h.result), "итог руки");
    }
    await b.wait(statePred((s) => s.phase === "betting" && s.hand === 2), 15000);
    chipsOk(b.state, 12);
    const phases = b.states.map((s) => s.phase);
    for (const ph of ["betting", "closing", "dealing", "deciding", "dealer", "payout"]) assert.ok(phases.includes(ph), "доска видела фазу " + ph);
    extra.close(); b.close(); ps.forEach((p) => p.close());
  });

  await t.test("«Подгляд» видит закрытую карту только владелец; другим телефонам она и сюжет не уходят до revealAt", async () => {
    const room = await createRoom({ betTime: 15000, cards: true }, 6);
    const b = await board(room.code, room.hostToken);
    const ps = [];
    for (let i = 0; i < 12; i++) { ps.push(autopilot(await player(room.code, "И" + i), { bet: false })); await sleep(5); }
    b.send({ type: "start" });
    for (const p of ps) await p.wait(statePred((s) => s.phase === "betting" && s.me && s.me.cards.length === 2));
    // 12 игроков × 2 карты = вся колода пакостей, все три «Подгляда» на руках
    const holder = ps.find((p) => p.state.me.cards.includes("peek"));
    assert.ok(holder, "у кого-то есть «Подгляд»");
    holder.send({ type: "play_card", card: "peek" });
    await holder.wait(statePred((s) => !s.me.cards.includes("peek")));
    for (const p of ps) await p.wait(statePred((s) => s.players.find((x) => x.id === holder.id).cardsCount === 1)); // у остальных — только число карт
    const other = ps.find((p) => p !== holder);
    assert.ok(other.state.players.find((x) => x.id === holder.id).played === true, "видно, что карта сыграна, но не какая");
    // тип чужой карты до closing не утекает: вне своих карт (me.cards) и ключа dealer.peek слова «peek» в снимке нет
    assert.ok(!JSON.stringify({ ...other.state, me: null, dealer: null }).includes('"peek"'), "тип чужой карты до closing не утекает");
    assert.strictEqual(other.state.reveals.length, 0);
    for (const p of ps) { const me = p.state.players.find((x) => x.id === p.id); p.send({ type: "set_bets", main: me.need, pp: 0, tp: 0 }); p.send({ type: "ready", ready: true }); }
    await holder.wait(statePred((s) => s.me && s.me.peekHole), 15000);
    const peeked = holder.state.me.peekHole;
    await b.wait(statePred((s) => s.phase === "payout"), 20000);
    assert.deepStrictEqual(b.state.dealer.hole, peeked, "владелец «Подгляда» видел именно закрытую карту");
    assert.ok(ps.every((p) => p.state.players.find((x) => x.id === holder.id).peeked === true), "факт подгляда виден всем");
    for (const p of ps) {
      if (p === holder) continue;
      for (const s of p.states) {
        const closed = ["dealing", "insurance", "deciding"].includes(s.phase) || (s.phase === "dealer" && s.now < s.dealer.revealAt[s.dealer.revealAt.length - 1]);
        if (!closed) continue;
        assert.strictEqual(s.me.peekHole, null, "чужой телефон не видит закрытую карту");
        assert.strictEqual(s.dealer.hole, null);
        assert.strictEqual(s.dealer.cards.length, 1, "телефону — только открытая карта");
        assert.strictEqual(s.dealer.plot, null, "сюжет до показа не уходит");
        if (s.phase === "dealer") assert.strictEqual(s.dealer.revealAt.length, 1, "телефону — только revealAt итога");
        for (const x of s.players) for (const h of x.hands) assert.strictEqual(h.result, null, "итоги рук до показа не уходят");
      }
      assert.ok(!p.events.some((e) => e.secret || e.type === "dealer" || e.type === "dealer_blackjack"), "секретные события телефону не рассылаются");
      assert.ok(p.events.some((e) => e.type === "card_reveal" && e.card === "peek"), "открытие карты в closing видно всем");
    }
    assert.ok(b.events.some((e) => e.type === "dealer" && e.secret), "доска получает событие сюжета");
    await other.wait(statePred((s) => s.phase === "payout" && s.dealer.hole && s.dealer.cards.length >= 2)); // после показа телефон видит руку дилера
    b.close(); ps.forEach((p) => p.close());
  });

  await t.test("повторный вход по токену возвращает место; офлайн-игрока волна не ждёт", async () => {
    const room = await createRoom({ betTime: 15000 }, 6);
    const b = await board(room.code, room.hostToken);
    const ps = [autopilot(await player(room.code, "Оля")), autopilot(await player(room.code, "Петя")), await player(room.code, "Вася")];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "betting"));
    ps[2].send({ type: "set_bets", main: 10, pp: 0, tp: 0 });
    await ps[2].wait(statePred((s) => s.players.find((x) => x.id === ps[2].id).bet === 10));
    ps[2].close();
    await b.wait(statePred((s) => s.players.find((x) => x.id === ps[2].id).online === false), 3000);
    // двое готовы, третий офлайн — ставки закрываются без него, его ставка играет
    await b.wait(statePred((s) => IN_HAND.includes(s.phase)), 5000);
    const back = autopilot(await player(room.code, "", ps[2].token));
    assert.strictEqual(back.id, ps[2].id);
    await back.wait(statePred((s) => s.me && s.me.id === back.id && s.players.find((x) => x.id === back.id).online)); // вернулся онлайн, снимок — свой
    await b.wait(statePred((s) => s.phase === "payout"), 20000);
    chipsOk(b.state, 3);
    b.close(); ps.slice(0, 2).forEach((p) => p.close()); back.close();
  });

  await t.test("рестарт посреди хода дилера: доска после restore получает тот же сюжет и расписание, фишки сходятся", async () => {
    const room = await createRoom({ betTime: 15000 }, 1);
    const b = await board(room.code, room.hostToken);
    const ps = [autopilot(await player(room.code, "А")), autopilot(await player(room.code, "Б")), autopilot(await player(room.code, "В"))];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "dealer"), 30000);
    const d0 = b.state.dealer;
    await stopServer();
    await startServer();
    const b2 = await board(room.code, room.hostToken);
    assert.strictEqual(b2.state.phase, "dealer", "фаза дилера доигрывается");
    const d1 = b2.state.dealer;
    assert.strictEqual(d1.plot, d0.plot, "тот же сюжет");
    assert.deepStrictEqual(d1.cards, d0.cards, "те же карты дилера");
    assert.strictEqual(d1.revealAt.length, d0.revealAt.length);
    const shift = d1.revealAt[0] - d0.revealAt[0];
    assert.ok(shift >= 0, "расписание сдвинуто на простой, не назад");
    for (let i = 0; i < d0.revealAt.length; i++) assert.strictEqual(d1.revealAt[i] - d0.revealAt[i], shift, "сдвиг одинаковый для всех карт");
    assert.strictEqual(b2.state.phaseEndsAt, d1.revealAt[d1.revealAt.length - 1]);
    const back = [];
    for (const p of ps) back.push(autopilot(await player(room.code, "", p.token)));
    assert.deepStrictEqual(back.map((p) => p.id), ps.map((p) => p.id));
    await b2.wait(statePred((s) => s.phase === "payout"), 20000);
    chipsOk(b2.state, 3);
    // следующие ставки — на паузе, пока ведущий не продолжит
    await b2.wait(statePred((s) => s.phase === "paused" && s.pausedPhase === "betting"), 10000);
    b2.send({ type: "resume" });
    await b2.wait(statePred((s) => s.phase === "betting" && s.hand === 2));
    b2.close(); back.forEach((p) => p.close());
  });

  await t.test("аноним без входа посреди хода дилера не видит закрытую карту, добор и сюжет до revealAt", async () => {
    const room = await createRoom({ betTime: 15000 }, 1);
    const b = await board(room.code, room.hostToken);
    const ps = [autopilot(await player(room.code, "А")), autopilot(await player(room.code, "Б"))];
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "dealer"), 30000);
    const anon = client(room.code);
    await anon.open;
    await anon.wait(statePred((s) => s.phase === "dealer"));
    const s = anon.state;
    assert.ok(s.now < s.dealer.revealAt[s.dealer.revealAt.length - 1], "подключился до показа итога");
    assert.strictEqual(s.me, null, "снимок не доски и не игрока");
    assert.strictEqual(s.dealer.hole, null);
    assert.strictEqual(s.dealer.cards.length, 1);
    assert.strictEqual(s.dealer.plot, null);
    assert.strictEqual(s.dealer.revealAt.length, 1, "только revealAt итога");
    for (const x of s.players) for (const h of x.hands) assert.strictEqual(h.result, null);
    assert.ok(!s.events.some((e) => e.secret), "секретных событий в снимке нет");
    // и протухший токен без имени не даёт ничего, кроме token_gone
    anon.send({ type: "join", token: "stale-token" });
    const e = await anon.wait((m) => m.type === "error");
    assert.strictEqual(e.error, "token_gone");
    anon.close(); b.close(); ps.forEach((p) => p.close());
  });

  await t.test("чат и модерация: 80 символов, без управляющих, не чаще 3 с, заглушить, скрыть", async () => {
    const room = await createRoom({});
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя")];
    ps[0].send({ type: "chat", text: "При\u0000вет​!" });
    const ev = await b.wait((m) => m.type === "event" && m.event.type === "chat");
    assert.strictEqual(ev.event.message.text, "Привет!");
    await b.wait(statePred((s) => s.chat.length === 1 && s.chat[0].pid === ps[0].id));
    ps[0].send({ type: "chat", text: "ещё" });
    const fast = await ps[0].wait((m) => m.type === "rejected" && m.action === "chat");
    assert.strictEqual(fast.reason, "too_fast");
    ps[1].send({ type: "chat", text: "я".repeat(500) });
    const long = await b.wait((m) => m.type === "event" && m.event.type === "chat" && m.event.message.pid === ps[1].id);
    assert.strictEqual(Array.from(long.event.message.text).length, 80);
    b.send({ type: "hide", id: long.event.message.id });
    await b.wait(statePred((s) => s.chat.length === 1));
    await ps[0].wait(statePred((s) => s.chat.length === 1));
    b.send({ type: "mute", playerId: ps[1].id, muted: true });
    await ps[1].wait(statePred((s) => s.me.muted === true));
    await sleep(3100);
    ps[1].send({ type: "chat", text: "а я?" });
    const muted = await ps[1].wait((m) => m.type === "rejected" && m.action === "chat");
    assert.strictEqual(muted.reason, "muted");
    ps[0].send({ type: "react", emoji: "🔥" });
    const re = await b.wait((m) => m.type === "event" && m.event.type === "react");
    assert.strictEqual(re.event.playerId, ps[0].id);
    ps[0].send({ type: "react", emoji: "💩" });
    const bad = await ps[0].wait((m) => m.type === "rejected" && m.action === "react");
    assert.strictEqual(bad.reason, "bad");
    const anon = client(room.code);
    await anon.open;
    anon.send({ type: "chat", text: "без входа" });
    const np = await anon.wait((m) => m.type === "rejected" && m.action === "chat");
    assert.strictEqual(np.reason, "not_player");
    anon.close(); b.close(); ps.forEach((p) => p.close());
  });

  await t.test("действия доски без host-токена отвергаются; неверный токен ведущего — ошибка", async () => {
    const room = await createRoom({});
    const b = await board(room.code, room.hostToken);
    const ps = [await player(room.code, "Оля"), await player(room.code, "Петя")];
    for (const type of ["start", "settings", "pause", "resume", "end", "kick", "mute", "hide", "next_game"]) {
      ps[0].send({ type, playerId: ps[1].id, id: 1, patch: { stack: 500 } });
      const r = await ps[0].wait((m) => m.type === "rejected" && m.action === type);
      assert.strictEqual(r.reason, "not_host", type + " без токена");
    }
    assert.strictEqual(b.state.phase, "lobby", "партия не началась");
    assert.strictEqual(b.state.settings.stack, 1000, "настройки не изменились");
    const fake = client(room.code);
    await fake.open;
    fake.send({ type: "host", token: "nope" });
    const e = await fake.wait((m) => m.type === "error");
    assert.strictEqual(e.error, "bad host token");
    // настоящая доска: настройки лобби меняются, стек в лобби обновляется
    b.send({ type: "settings", patch: { stack: 500, format: "hands", handsTotal: 15, solo: true } });
    await b.wait(statePred((s) => s.settings.stack === 500));
    assert.strictEqual(b.state.settings.format, "hands");
    assert.strictEqual(b.state.settings.solo, false, "соло на сервере не включается");
    assert.ok(b.state.players.every((p) => p.stack === 500));
    fake.close(); b.close(); ps.forEach((p) => p.close());
  });

  await t.test("сообщение больше 8 КБ рвёт только этот сокет, сервер жив", async () => {
    const room = await createRoom({});
    const b = await board(room.code, room.hostToken);
    const p = await player(room.code, "Оля");
    p.send(JSON.stringify({ type: "chat", text: "x".repeat(9000) }));
    const closed = await Promise.race([p.closed.then(() => true), sleep(3000).then(() => false)]);
    assert.ok(closed, "сокет с перегруженным сообщением закрыт");
    const h = await (await fetch(`http://127.0.0.1:${port}/blackjack/api/health`)).json();
    assert.strictEqual(h.ok, true);
    b.send({ type: "ping", c: 7 });
    const pong = await b.wait((m) => m.type === "pong");
    assert.strictEqual(pong.c, 7, "доска в той же комнате жива");
    b.close();
  });

  await t.test("анонимный сокет без входа закрывается по ANON_TTL_MS", async () => {
    const room = await createRoom({});
    const a = client(room.code);
    await a.open;
    const closed = await Promise.race([a.closed.then(() => true), sleep(6000).then(() => false)]);
    assert.ok(closed, "аноним не держит место в комнате");
  });

  await t.test("боты в режиме разработки (?bots=N) играют раздачу сами", async () => {
    const room = await createRoom({ betTime: 15000 }, 6, 3);
    const b = await board(room.code, room.hostToken);
    assert.strictEqual(b.state.players.length, 3);
    assert.ok(b.state.players.every((p) => p.name.startsWith("🤖")));
    b.send({ type: "start" });
    await b.wait(statePred((s) => s.phase === "betting" && s.hand === 2), 30000);
    chipsOk(b.state, 3);
    b.close();
  });

  await t.test("health отвечает ok", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/blackjack/api/health`);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
  });
});
