#!/usr/bin/env node
// Сетевые тесты «Утиного сплава»: node test-server.js — сам поднимает сервер на случайном порту
"use strict";
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const NetBot = require("./netbot");

const PORT = 5900 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + String(e.stack || e).split("\n").slice(0, 3).join("\n    ")); }
}

function startServer(env = {}) {
  const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: "development", DUMP_FILE: path.join(require("os").tmpdir(), `rapids-test-${PORT}.json`), RAPIDS_CFG: JSON.stringify({ LEN: 1600 }) }, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.log = "";
  srv.stdout.on("data", (d) => (srv.log += d));
  srv.stderr.on("data", (d) => (srv.log += d));
  return srv;
}

async function up() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/rapids/api/health"); if (r.ok) return; } catch {}
    await wait(100);
  }
  throw new Error("сервер не поднялся");
}

function rawWs(code) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/rapids/ws?r=${code}`);
    ws.msgs = [];
    ws.on("message", (m) => ws.msgs.push(JSON.parse(m)));
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}

(async () => {
  const srv = startServer();
  try {
    await up();
    console.log("Сервер");

    await test("health и создание комнаты", async () => {
      const h = await (await fetch(BASE + "/rapids/api/health")).json();
      assert.strictEqual(h.ok, true);
      const r = await NetBot.createRoom(BASE);
      assert.match(r.code, /^[A-Z]+[2-9]{2}$/);
      assert(r.hostToken.length > 10);
    });

    await test("неверный код — 404 на ws", async () => {
      await assert.rejects(rawWs("NOPE99"));
    });

    let room, bots;
    await test("шестеро входят, ведущий — создатель", async () => {
      room = await NetBot.createRoom(BASE);
      const host = await NetBot.connect({ base: BASE, code: room.code, name: "Хост", hostToken: room.hostToken, style: "pro" });
      const rest = await Promise.all([1, 2, 3, 4, 5].map((i) => NetBot.connect({ base: BASE, code: room.code, name: "Бот", style: ["novice", "casual", "bully", "pro"][i % 4] })));
      bots = [host, ...rest];
      await host.until((b) => b.roster && b.roster.length === 6, 3000);
      assert.strictEqual(host.hostId, host.id);
      const names = host.roster.map((p) => p.name).sort();
      assert.deepStrictEqual(names, ["Бот", "Бот (2)", "Бот (3)", "Бот (4)", "Бот (5)", "Хост"]);
      assert.strictEqual(new Set(host.roster.map((p) => p.ci)).size, 6, "цвета разные");
      await host.until((b) => b.snap && b.snap.ph === "lobby", 2000);
    });

    await test("не ведущий не может начать", async () => {
      bots[1].send({ type: "start" });
      await wait(300);
      assert.strictEqual(bots[0].phase, "lobby");
    });

    await test("заплыв по сети доходит до конца: у всех один ведущий дейлика и чемпион", async () => {
      bots[0].send({ type: "start" });
      await bots[0].until((b) => b.phase === "countdown" || b.phase === "race", 2000);
      await Promise.all(bots.map((b) => b.until((x) => x.phase === "over", 60000)));
      await wait(300);
      const hosts = bots.map((b) => b.snap.host && b.snap.host.id);
      assert(hosts[0], "ведущий определён");
      assert(hosts.every((h) => h === hosts[0]));
      const champs = bots.map((b) => b.snap.ch);
      assert(champs[0] && champs.every((c) => c === champs[0]) && champs[0] !== hosts[0]);
      const evHost = bots[0].events.filter((e) => e.type === "host");
      assert.strictEqual(evHost.length, 1);
      const over = bots[0].events.find((e) => e.type === "over");
      assert(over && over.stats && over.stats.players.length === 6);
      assert(bots[0].events.some((e) => e.type === "turbo"), "боты жали рывок — событие дошло");
      // снимок держится в разумном размере
      const perSnap = bots[0].bytes / bots[0].recv;
      assert(perSnap < 1200, `средний размер сообщения ${perSnap.toFixed(0)} Б`);
    });

    await test("reload в фазе over: join по токену сразу получает итог (ev over, late:true), с именами и цветами", async () => {
      const tok = bots[4].token, id = bots[4].id;
      const ws = await rawWs(room.code);
      ws.send(JSON.stringify({ type: "join", token: tok }));
      await wait(300);
      const joined = ws.msgs.find((m) => m.type === "joined");
      assert.strictEqual(joined.playerId, id);
      const evs = ws.msgs.filter((m) => m.type === "ev").flatMap((m) => m.list).filter((e) => e.type === "over");
      assert.strictEqual(evs.length, 1, "over-событий " + evs.length);
      const e = evs[0];
      assert.strictEqual(e.late, true);
      assert(e.host && e.host.id && e.host.name, "имя ведущего в событии");
      assert(e.champion && e.championName, "имя чемпиона в событии");
      assert.strictEqual(e.stats.players.length, 6);
      assert(e.stats.players.every((p) => p.name && Number.isInteger(p.ci)), "имя и цвет у каждого");
      // новый игрок без токена в фазе over тоже получает итог
      const ws2 = await rawWs(room.code);
      ws2.send(JSON.stringify({ type: "join", name: "Поздний" }));
      await wait(300);
      const late = ws2.msgs.filter((m) => m.type === "ev").flatMap((m) => m.list).find((x) => x.type === "over" && x.late);
      assert(late, "новый игрок получил итог");
      ws.close(); ws2.close();
      await wait(100);
    });

    await test("реванш и возврат в лобби — только ведущий", async () => {
      bots[2].send({ type: "lobby" });
      await wait(200);
      assert.strictEqual(bots[0].phase, "over");
      bots[0].send({ type: "lobby" });
      await bots[0].until((b) => b.phase === "lobby", 2000);
    });

    await test("переподключение по токену — тот же игрок", async () => {
      const b = bots[3];
      const id = b.id, tok = b.token;
      b.close();
      await bots[0].until((x) => x.roster.find((p) => p.id === id && !p.online), 2000);
      const back = await NetBot.connect({ base: BASE, code: room.code, name: "другое имя", token: tok });
      assert.strictEqual(back.id, id);
      await bots[0].until((x) => x.roster.find((p) => p.id === id && p.online), 2000);
      bots[3] = back;
    });

    await test("выгнать может только ведущий", async () => {
      const victim = bots[5];
      bots[4].send({ type: "kick", playerId: victim.id });
      await wait(200);
      assert(bots[0].roster.some((p) => p.id === victim.id));
      bots[0].send({ type: "kick", playerId: victim.id });
      await bots[0].until((x) => !x.roster.some((p) => p.id === victim.id), 2000);
    });

    await test("ведущий пропал на 10 с — права следующему", async () => {
      const old = bots[0];
      old.close();
      await bots[1].until((b) => b.hostId && b.hostId !== old.id, 14000);
      // боты входили одновременно — кто «следующий по времени входа», решает случай; важно, что права у живого игрока
      const online = bots[1].roster.filter((p) => p.online).map((p) => p.id);
      assert(online.includes(bots[1].hostId) && bots[1].hostId !== old.id);
    });

    await test("мусор не роняет сервер; сверхдлинное сообщение рвёт только этот сокет", async () => {
      const ws = await rawWs(room.code);
      for (const m of ["{", "null", "[]", "42", JSON.stringify({ type: "i", st: "x" }), JSON.stringify({ type: "i", st: 1e9 }), JSON.stringify({ type: "join", name: "" }), JSON.stringify({ type: "join", name: "<img src=x>".repeat(5) }), JSON.stringify({ type: "color", ci: 1e9 }), JSON.stringify({ type: "ping", rtt: -5 })]) ws.send(m);
      await wait(200);
      const joined = ws.msgs.find((m) => m.type === "joined");
      assert(joined, "вход с именем-тегом прошёл как текст");
      const r = ws.msgs.filter((m) => m.type === "roster").pop();
      const p = r.players.find((x) => x.id === joined.playerId);
      assert(p.name.length <= 15);
      const closed = new Promise((res) => ws.on("close", res));
      ws.send("x".repeat(5000));
      await closed;
      const h = await (await fetch(BASE + "/rapids/api/health")).json();
      assert.strictEqual(h.ok, true);
    });

    await test("флуд вводом режется лимитом, сервер жив", async () => {
      const ws = await rawWs(room.code);
      ws.send(JSON.stringify({ type: "join", name: "Флудер" }));
      await wait(100);
      for (let i = 0; i < 2000; i++) ws.send(JSON.stringify({ type: "i", st: 1, s: i }));
      await wait(300);
      const h = await (await fetch(BASE + "/rapids/api/health")).json();
      assert.strictEqual(h.ok, true);
      ws.close();
    });

    await test("рывок: флуд «t» даёт один рывок, в снимке виден заряд, перерыв отсчитывается", async () => {
      const r = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r.code, name: "Рывок", hostToken: r.hostToken, think: false });
      const o = await NetBot.connect({ base: BASE, code: r.code, name: "Второй", think: false });
      await a.until((b) => b.roster && b.roster.length === 2, 3000);
      a.send({ type: "start" });
      await a.until((b) => b.phase === "race", 6000);
      for (let i = 0; i < 40; i++) a.send({ type: "t" });
      await wait(400);
      const mine = a.events.filter((e) => e.type === "turbo" && e.id === a.id);
      assert.strictEqual(mine.length, 1, "рывков " + mine.length);
      const row = a.snap.p.find((p) => p[0] === a.id);
      assert(row[10] > 3.5 && row[10] <= 4.9, "заряд в снимке " + row[10]);
      a.send({ type: "t" });
      await wait(200);
      assert.strictEqual(a.events.filter((e) => e.type === "turbo" && e.id === a.id).length, 1, "пока копится — второго нет");
      a.send({ type: "leave" }); o.send({ type: "leave" });
    });

    await test("в комнате не больше 12 игроков", async () => {
      const r2 = await NetBot.createRoom(BASE);
      const list = [];
      for (let i = 0; i < 12; i++) list.push(await NetBot.connect({ base: BASE, code: r2.code, name: "П" + i, think: false }));
      await assert.rejects(NetBot.connect({ base: BASE, code: r2.code, name: "Лишний", think: false }), /room_full/);
      list.forEach((b) => b.close());
    });

    await test("офлайн посреди заплыва: утку несёт течение, заплыв доходит до конца", async () => {
      const r3 = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r3.code, name: "А", hostToken: r3.hostToken, style: "pro" });
      const b = await NetBot.connect({ base: BASE, code: r3.code, name: "Б", style: "pro" });
      const c = await NetBot.connect({ base: BASE, code: r3.code, name: "В", think: false });
      await a.until((x) => x.roster && x.roster.length === 3, 2000);
      a.send({ type: "start" });
      await a.until((x) => x.phase === "race", 5000);
      c.close();
      await a.until((x) => x.phase === "over", 40000);
      const st = a.events.find((e) => e.type === "over").stats.players;
      assert.strictEqual(st.length, 3);
      assert(st.find((p) => p.id === c.id).progress > 0.3, "офлайн утку не несло");
      a.close(); b.close();
    });

    await test("ушёл посреди заплыва — сошёл и ведёт дейлик", async () => {
      const r7 = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r7.code, name: "А", hostToken: r7.hostToken, style: "novice" });
      const b = await NetBot.connect({ base: BASE, code: r7.code, name: "Б", style: "novice" });
      const c = await NetBot.connect({ base: BASE, code: r7.code, name: "В", style: "pro" });
      await a.until((x) => x.roster && x.roster.length === 3, 2000);
      a.send({ type: "start" });
      await a.until((x) => x.phase === "race", 5000);
      c.send({ type: "leave" });
      await a.until((x) => x.phase === "over", 40000);
      assert.strictEqual(a.snap.host.id, c.id);
      assert(a.snap.host.dnf);
      a.close(); b.close(); c.close();
    });

    await test("кривая строка запроса не роняет сервер", async () => {
      const net = require("net");
      for (const line of ["GET //rapids%2Fapi/health HTTP/1.1", "GET //rapids%2Fws?r=A HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13"]) {
        await new Promise((res) => { const c = net.connect(PORT, "localhost", () => c.write(line + "\r\nHost: x\r\n\r\n")); c.on("data", () => c.destroy()); c.on("close", res); c.on("error", res); setTimeout(() => { c.destroy(); res(); }, 500); });
      }
      await wait(200);
      const h = await (await fetch(BASE + "/rapids/api/health")).json();
      assert.strictEqual(h.ok, true);
    });

    await test("один сокет — один игрок: повторные входы не плодят фантомов", async () => {
      const r5 = await NetBot.createRoom(BASE);
      const ws = await rawWs(r5.code);
      for (let i = 0; i < 6; i++) { ws.send(JSON.stringify({ type: "join", name: "Фантом" + i })); await wait(2100); }
      const roster = ws.msgs.filter((m) => m.type === "roster").pop();
      assert.strictEqual(roster.players.length, 1, "игроков: " + roster.players.length);
      ws.close();
    });

    await test("флуд «color»/«join» не размножает рассылку списка: не чаще раза за тик", async () => {
      const r7 = await NetBot.createRoom(BASE);
      const obs = await rawWs(r7.code), att = await rawWs(r7.code);
      obs.send(JSON.stringify({ type: "join", name: "Зритель" }));
      att.send(JSON.stringify({ type: "join", name: "Флудер" }));
      await wait(300);
      const tok = att.msgs.find((m) => m.type === "joined").token;
      const before = obs.msgs.filter((m) => m.type === "roster").length;
      for (let i = 0; i < 60; i++) att.send(JSON.stringify(i % 2 ? { type: "color", ci: i % 20 } : { type: "join", token: tok }));
      await wait(500);
      const n = obs.msgs.filter((m) => m.type === "roster").length - before;
      assert(n <= 12, "списков за 0.5 с: " + n);
      obs.close(); att.close();
    });

    await test("с одного адреса не больше 10 анонимных сокетов в комнате", async () => {
      const r6 = await NetBot.createRoom(BASE);
      const list = [];
      let refused = 0;
      for (let i = 0; i < 12; i++) { try { list.push(await rawWs(r6.code)); } catch { refused++; } }
      assert.strictEqual(list.length, 10);
      assert.strictEqual(refused, 2);
      list.forEach((w) => w.close());
    });

    await test("игровое время по часам: паузы процесса по 100 мс не растягивают rapids (clock ≈ wall ± 0,3 с)", async () => {
      const r = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r.code, name: "А", hostToken: r.hostToken, think: false });
      const b = await NetBot.connect({ base: BASE, code: r.code, name: "Б", think: false });
      await a.until((x) => x.roster && x.roster.length === 2, 3000);
      a.send({ type: "start" });
      await a.until((x) => x.phase === "race" && x.snap && x.snap.ph === "race", 8000);
      await wait(200);
      const s1 = a.snap;
      // 12 пауз процесса по 100 мс: старый код терял по ~0,1 с игрового времени на каждой
      for (let i = 0; i < 12; i++) {
        process.kill(srv.pid, "SIGSTOP");
        await wait(100);
        process.kill(srv.pid, "SIGCONT");
        await wait(150);
      }
      await wait(200);
      const s2 = a.snap;
      assert.strictEqual(s2.ph, "race", "ещё идёт: " + s2.ph);
      const wall = (s2.t - s1.t) / 1000, game = s2.cl - s1.cl;
      assert(Math.abs(wall - game) < 0.3, `по часам ${wall.toFixed(2)} с, в игре ${game.toFixed(2)} с`);
      a.close(); b.close();
    });

    await test("PROD_ENV: в проде (NODE_ENV=production) env меняет политику — GHOST_TTL_MS=6000 убирает офлайн из лобби за ~6 с", async () => {
      const port2 = PORT + 300;
      const base2 = `http://localhost:${port2}`;
      const env2 = Object.assign({}, process.env, { PORT: String(port2), NODE_ENV: "production", DUMP_FILE: path.join(require("os").tmpdir(), `rapids-test-${port2}.json`), GHOST_TTL_MS: "6000", PONG_MISSES: "abc" }, {});
      const s2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      s2.stdout.on("data", (d) => (log += d)); s2.stderr.on("data", (d) => (log += d));
      try {
        for (let i = 0; i < 50; i++) { try { if ((await fetch(base2 + "/rapids/api/health")).ok) break; } catch {} await wait(100); }
        const r = await NetBot.createRoom(base2);
        const a = await NetBot.connect({ base: base2, code: r.code, name: "А", hostToken: r.hostToken, think: false });
        const b = await NetBot.connect({ base: base2, code: r.code, name: "Б", think: false });
        await a.until((x) => x.roster && x.roster.length === 2, 3000);
        const t0 = Date.now();
        b.close();
        await a.until((x) => x.roster.length === 1, 16000);
        const dt = Date.now() - t0;
        assert(dt < 12000, "убран за " + dt + " мс (по умолчанию было бы ≥ 120 с)");
        assert(/PONG_MISSES="abc" вне диапазона/.test(log), "мусор в env отвергнут с предупреждением");
        a.close();
      } finally { s2.kill("SIGTERM"); }
    });

    await test("брошенный руль: нет ввода дольше INPUT_STALE_MS (env, прод) — руль в ноль, утка не прижата к берегу", async () => {
      const { makeCourse, DEFAULTS } = require("./game");
      async function run(stale, off) {
        const port2 = PORT + off;
        const base2 = `http://localhost:${port2}`;
        const env2 = Object.assign({}, process.env, { PORT: String(port2), NODE_ENV: "production", DUMP_FILE: path.join(require("os").tmpdir(), `rapids-test-${port2}.json`), INPUT_STALE_MS: String(stale) });
        const s2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
        try {
          for (let i = 0; i < 50; i++) { try { if ((await fetch(base2 + "/rapids/api/health")).ok) break; } catch {} await wait(100); }
          const r = await NetBot.createRoom(base2);
          const ws = await new Promise((res, rej) => { const w = new WebSocket(`ws://localhost:${port2}/rapids/ws?r=${r.code}`); w.msgs = []; w.on("message", (m) => w.msgs.push(JSON.parse(m))); w.on("open", () => res(w)); w.on("error", rej); });
          ws.send(JSON.stringify({ type: "join", name: "Заморожен", hostToken: r.hostToken }));
          const other = await NetBot.connect({ base: base2, code: r.code, name: "Второй", think: false });
          await wait(300);
          const me = ws.msgs.find((m) => m.type === "joined").playerId;
          ws.send(JSON.stringify({ type: "start" }));
          for (let i = 0; i < 160 && !ws.msgs.some((m) => m.type === "s" && m.ph === "race"); i++) await wait(50);
          const cfg = Object.assign({}, DEFAULTS, ws.msgs.find((m) => m.type === "hello").cfg);
          const first = ws.msgs.filter((m) => m.type === "s").pop();
          const row0 = first.p.find((p) => p[0] === me);
          const off0 = row0[1] - makeCourse(first.sd, cfg).riverCx(row0[2]);
          ws.send(JSON.stringify({ type: "i", st: off0 > 0 ? -1 : 1, s: 1 }));   // к дальнему берегу, и тишина
          await wait(3000);
          const last = ws.msgs.filter((m) => m.type === "s").pop();
          const row = last.p.find((p) => p[0] === me);
          const off = row[1] - makeCourse(last.sd, cfg).riverCx(row[2]);
          ws.close(); other.close();
          return Math.abs(off - off0);
        } finally { s2.kill("SIGTERM"); }
      }
      const held = await run(300, 301), free = await run(60000, 302);
      assert(held < free - 20, `со сбросом руля сдвиг ${held.toFixed(0)}, без — ${free.toFixed(0)}`);
    });

    await test("сверх лимита руль не теряется: последний руль из пачки >70 сообщений применяется; флуд 5000/с — сервер жив", async () => {
      const { makeCourse, DEFAULTS } = require("./game");
      const r = await NetBot.createRoom(BASE);
      const host = await NetBot.connect({ base: BASE, code: r.code, name: "Хост", hostToken: r.hostToken, think: false });
      const ws = await rawWs(r.code);
      ws.send(JSON.stringify({ type: "join", name: "Спамер" }));
      await wait(300);
      const me = ws.msgs.find((m) => m.type === "joined").playerId;
      host.send({ type: "start" });
      for (let i = 0; i < 160 && !ws.msgs.some((m) => m.type === "s" && m.ph === "race"); i++) await wait(50);
      const cfg = Object.assign({}, DEFAULTS, ws.msgs.find((m) => m.type === "hello").cfg);
      const offOf = (s) => { const row = s.p.find((p) => p[0] === me); return row[1] - makeCourse(s.sd, cfg).riverCx(row[2]); };
      const snapLast = () => ws.msgs.filter((m) => m.type === "s").pop();
      const off0 = offOf(snapLast());
      const dir = off0 > 0 ? -1 : 1;
      // первые 70 — «руль 0» (принимаются), следующие 30 — «руль к дальнему берегу» (сверх лимита: раньше пропадали)
      for (let i = 1; i <= 100; i++) ws.send(JSON.stringify({ type: "i", st: i <= 70 ? 0 : dir, s: i }));
      await wait(900);
      const moved = Math.abs(offOf(snapLast()) - off0);
      assert(moved > 25, "руль из сообщений сверх лимита применён, сдвиг " + moved.toFixed(0));
      for (let i = 0; i < 5000; i++) ws.send(JSON.stringify({ type: "i", st: 1, s: 1000 + i }));
      await wait(400);
      const h = await (await fetch(BASE + "/rapids/api/health")).json();
      assert.strictEqual(h.ok, true);
      ws.close(); host.close();
    });

    await test("кик в отсчёте: кикнутый не «неудачник», при одной утке — aborted и лобби, ведущий дейлика не назначен (U-51 A)", async () => {
      const r = await NetBot.createRoom(BASE);
      const host = await NetBot.connect({ base: BASE, code: r.code, name: "Хост", hostToken: r.hostToken, think: false });
      const b = await NetBot.connect({ base: BASE, code: r.code, name: "Боб", think: false });
      host.send({ type: "start" });
      await host.until((x) => x.phase === "countdown", 3000);
      host.send({ type: "kick", playerId: b.id });
      await host.until((x) => x.events.some((e) => e.type === "aborted"), 3000);
      await host.until((x) => x.phase === "lobby", 3000);
      assert(!host.events.some((e) => e.type === "host" || e.type === "over"), "дейлика нет");
      assert(!host.events.some((e) => e.type === "removed" && !e.early), "наказания нет");
      await wait(300);
      assert.strictEqual(host.roster.length, 1);
      host.close(); b.close();
    });

    // ----- призраки, подхват по имени, создатель (T-W2-39) -----
    const joinRaw = async (code, msg) => {
      const ws = await rawWs(code);
      ws.send(JSON.stringify(Object.assign({ type: "join" }, msg)));
      await wait(250);
      ws.last = (t) => ws.msgs.filter((m) => m.type === t).pop();
      return ws;
    };

    await test("подхват по имени: офлайн ≥ 2 с + caps -> «Это ты?», после подтверждения тот же playerId, старый токен отозван", async () => {
      const r = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r.code, name: "Ася", hostToken: r.hostToken, think: false });
      const b = await NetBot.connect({ base: BASE, code: r.code, name: "Боб", think: false });
      const oldTok = b.token, bid = b.id;
      b.close();
      await wait(300);
      // < 2 с: тихий повтор
      const early = await joinRaw(r.code, { name: "боб", caps: ["claim"] });
      assert.strictEqual(early.last("error").error, "name_claim");
      assert.strictEqual(early.last("error").retry, true);
      early.close();
      await wait(2000);
      // клиент без caps — прежнее поведение: «Боб (2)»
      const legacy = await joinRaw(r.code, { name: "Боб" });
      assert.strictEqual(legacy.last("joined").name, "Боб (2)");
      assert.strictEqual(legacy.last("joined").renamed, true);
      legacy.close();
      await wait(200);
      const w = await joinRaw(r.code, { name: "БОБ", caps: ["claim"] });
      const ask = w.last("error");
      assert.strictEqual(ask.error, "name_claim");
      assert.strictEqual(ask.name, "Боб");
      assert(!w.last("joined"), "без подтверждения место не отдано");
      w.send(JSON.stringify({ type: "join", name: "БОБ", caps: ["claim"], claim: true }));
      await wait(250);
      const j = w.last("joined");
      assert.strictEqual(j.playerId, bid);
      assert.strictEqual(j.resumed, true);
      assert.strictEqual(j.name, "Боб");
      assert.notStrictEqual(j.token, oldTok, "выдан новый токен");
      // старый токен больше не открывает место
      const old = await joinRaw(r.code, { token: oldTok });
      assert(!old.last("joined") || old.last("joined").playerId !== bid);
      assert(a.roster.filter((p) => p.id === bid).length <= 1);
      old.close(); w.close(); a.close();
    });

    await test("«Я другой» (fresh) и онлайн-тёзка: «Имя (2)»; joined.name и resumed по токену", async () => {
      const r = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r.code, name: "Ася", hostToken: r.hostToken, think: false });
      const x = await joinRaw(r.code, { name: "ася", caps: ["claim"] });
      assert.strictEqual(x.last("joined").name, "ася (2)");
      const tok = x.last("joined").token;
      x.close();
      await wait(2300);
      const f = await joinRaw(r.code, { name: "ася (2)", caps: ["claim"], fresh: true });
      assert.strictEqual(f.last("joined").name, "ася (3)");
      f.close();
      const back = await joinRaw(r.code, { token: tok });
      assert.strictEqual(back.last("joined").resumed, true);
      back.close(); a.close();
    });

    await test("в заплыве без флага: имя офлайн-игрока не подхватывается (новый вход — зритель «Имя (2)»), по токену — своя утка", async () => {
      const r = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r.code, name: "Ася", hostToken: r.hostToken, style: "pro" });
      const b = await NetBot.connect({ base: BASE, code: r.code, name: "Боб", style: "pro" });
      a.send({ type: "start" });
      await a.until((x) => x.phase === "race", 6000);
      const tok = b.token, bid = b.id;
      b.close();
      await wait(2500);
      const w = await joinRaw(r.code, { name: "Боб", caps: ["claim"] });
      assert(!w.last("error") || w.last("error").error !== "name_claim", "в заплыве подтверждения по имени нет");
      assert.strictEqual(w.last("joined").name, "Боб (2)");
      assert.notStrictEqual(w.last("joined").playerId, bid);
      const ret = await joinRaw(r.code, { token: tok });
      assert.strictEqual(ret.last("joined").playerId, bid, "по токену — к своей утке");
      assert.strictEqual(ret.last("joined").resumed, true);
      ret.close(); w.close(); a.close();
    });

    await test("кик офлайн-создателя запрещён (creator_away); онлайн-создателя ведущий убрать может", async () => {
      const r = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r.code, name: "Ася", hostToken: r.hostToken, think: false });
      const b = await NetBot.connect({ base: BASE, code: r.code, name: "Боб", think: false });
      const aid = a.id;
      a.close();
      await b.until((x) => x.hostId === b.id, 14000);
      b.errors.length = 0;
      b.send({ type: "kick", playerId: aid });
      await b.until((x) => x.errors.includes("creator_away"), 3000);
      assert(b.roster.some((p) => p.id === aid), "создатель остался в списке");
      b.close();
    });

    // отдельный сервер с коротким сроком призраков (минимум env — 5 с) и короткой жизнью анонимов
    {
      const port3 = PORT + 400;
      const base3 = `http://localhost:${port3}`;
      const env3 = Object.assign({}, process.env, { PORT: String(port3), NODE_ENV: "development", DUMP_FILE: path.join(require("os").tmpdir(), `rapids-test-${port3}.json`), RAPIDS_CFG: JSON.stringify({ LEN: 1600 }), GHOST_TTL_MS: "5000", ANON_TTL_MS: "3000" });
      const s3 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env3, stdio: ["ignore", "pipe", "pipe"] });
      s3.stdout.on("data", () => {}); s3.stderr.on("data", () => {});
      const raw3 = (code) => new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${port3}/rapids/ws?r=${code}`); ws.msgs = []; ws.on("message", (m) => ws.msgs.push(JSON.parse(m))); ws.on("open", () => res(ws)); ws.on("error", rej); });
      try {
        for (let i = 0; i < 50; i++) { try { if ((await fetch(base3 + "/rapids/api/health")).ok) break; } catch {} await wait(100); }

        await test("призраки: зритель в заплыве уходит через GHOST_TTL_MS, участник — нет; в итогах уходит и участник (120 с по умолчанию, тут 5 с)", async () => {
          const r = await NetBot.createRoom(base3);
          const a = await NetBot.connect({ base: base3, code: r.code, name: "А", hostToken: r.hostToken, style: "pro" });
          const b = await NetBot.connect({ base: base3, code: r.code, name: "Б", style: "pro" });
          const c = await NetBot.connect({ base: base3, code: r.code, name: "В", style: "pro" });
          a.send({ type: "start" });
          await a.until((x) => x.phase === "race", 6000);
          const d = await NetBot.connect({ base: base3, code: r.code, name: "Зритель", think: false });
          await a.until((x) => x.roster.length === 4, 2000);
          d.close(); c.close();
          await wait(6200);
          assert(!a.roster.some((p) => p.name === "Зритель"), "офлайн-зритель убран в заплыве");
          assert(a.roster.some((p) => p.name === "В"), "офлайн-участник остался в заплыве");
          assert.strictEqual(a.phase, "race", "заплыв ещё идёт");
          await a.until((x) => x.phase === "over", 30000);
          await a.until((x) => !x.roster.some((p) => p.name === "В"), 9000);
          a.close(); b.close();
        });

        await test("вытеснение: 12 мест, один офлайн — 13-й входит после порога, не раньше", async () => {
          const r = await NetBot.createRoom(base3);
          const list = [];
          for (let i = 0; i < 12; i++) list.push(await NetBot.connect({ base: base3, code: r.code, name: "П" + i, hostToken: i === 0 ? r.hostToken : undefined, think: false }));
          list[11].close();
          await wait(1500);
          await assert.rejects(NetBot.connect({ base: base3, code: r.code, name: "Лишний", think: false }), /room_full/);
          await wait(4200);
          const extra = await NetBot.connect({ base: base3, code: r.code, name: "Лишний", think: false });
          assert(extra.id);
          await list[0].until((x) => x.roster.length === 12 && x.roster.some((q) => q.name === "Лишний"), 2000);
          extra.close(); list.forEach((x) => x.close());
        });

        await test("ожидание подтверждения: сокет с name_claim живёт дольше ANON_TTL_MS (CLAIM_WAIT_MS), пустой аноним — рвётся", async () => {
          const r = await NetBot.createRoom(base3);
          const a = await NetBot.connect({ base: base3, code: r.code, name: "Ася", hostToken: r.hostToken, think: false });
          const b = await NetBot.connect({ base: base3, code: r.code, name: "Боб", think: false });
          b.close();
          await wait(2300);
          const w = await raw3(r.code);
          w.send(JSON.stringify({ type: "join", name: "Боб", caps: ["claim"] }));
          const anon = await raw3(r.code);
          await wait(200);
          assert(w.msgs.some((m) => m.error === "name_claim"));
          // очистка раз в 20 с: ждём один её проход после ANON_TTL_MS
          await wait(24000);
          assert.strictEqual(anon.readyState, 3, "пустой аноним закрыт");
          assert.strictEqual(w.readyState, 1, "ждущий подтверждения жив");
          w.close(); a.close();
        });
      } finally { s3.kill("SIGTERM"); }
    }

    await test("рестарт сервера: комната и токены живы, партия отменена", async () => {
      const r4 = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r4.code, name: "Ася", hostToken: r4.hostToken, think: false });
      const tok = a.token, id = a.id;
      await wait(10500);   // дамп раз в 10 с
      srv.kill("SIGTERM");
      await wait(700);
      const srv2 = startServer();
      try {
        await up();
        const back = await NetBot.connect({ base: BASE, code: r4.code, name: "x", token: tok, hostToken: r4.hostToken, think: false });
        assert.strictEqual(back.id, id);
        await back.until((b) => b.phase === "lobby", 3000);
        back.close();
      } finally { srv2.kill("SIGTERM"); }
    });
  } finally {
    try { srv.kill("SIGTERM"); } catch {}
  }
  if (failed) console.log("\nлог сервера (хвост):\n" + srv.log.split("\n").slice(-20).join("\n"));
  console.log(`\n${passed} прошло, ${failed} упало`);
  process.exit(failed ? 1 : 0);
})();
