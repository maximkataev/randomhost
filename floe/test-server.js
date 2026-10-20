#!/usr/bin/env node
// Сетевые тесты «Царя льдины»: node test-server.js — сам поднимает сервер на случайном порту
"use strict";
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const NetBot = require("./netbot");

const PORT = 5700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + String(e.stack || e).split("\n").slice(0, 6).join("\n    ")); }
}

function startServer(env = {}) {
  const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: "development", DUMP_FILE: path.join(require("os").tmpdir(), `floe-test-${PORT}.json`), FLOE_CFG: JSON.stringify({ FIGHT_T: 25, MELT_START: 3, MELT_MID: 18 }) }, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.log = "";
  srv.stdout.on("data", (d) => (srv.log += d));
  srv.stderr.on("data", (d) => (srv.log += d));
  return srv;
}

async function up() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/floe/api/health"); if (r.ok) return; } catch {}
    await wait(100);
  }
  throw new Error("сервер не поднялся");
}

function rawWs(code) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/floe/ws?r=${code}`);
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
      const h = await (await fetch(BASE + "/floe/api/health")).json();
      assert.strictEqual(h.ok, true);
      const r = await NetBot.createRoom(BASE);
      assert.match(r.code, /^[A-Z]+[2-9]{2}$/);
      assert(r.hostToken.length > 10);
    });

    await test("join сразу после leave — явный отказ too_fast; строка игрока в снимке без lastSeq (floe-017, floe-018)", async () => {
      const r = await NetBot.createRoom(BASE);
      const ws = await rawWs(r.code);
      ws.send(JSON.stringify({ type: "join", name: "Аня" }));
      for (let i = 0; i < 40 && !ws.msgs.some((m) => m.type === "joined"); i++) await wait(50);
      assert(ws.msgs.some((m) => m.type === "joined"), "не вошёл");
      for (let i = 0; i < 60 && !ws.msgs.some((m) => m.type === "s"); i++) await wait(50);
      const snap = ws.msgs.find((m) => m.type === "s");
      assert(snap && snap.p.length, "снимка нет");
      assert.strictEqual(snap.p[0].length, 11, "в строке игрока ровно 11 полей");
      ws.send(JSON.stringify({ type: "leave" }));
      await wait(100);
      ws.send(JSON.stringify({ type: "join", name: "Боря" }));
      for (let i = 0; i < 40 && !ws.msgs.some((m) => m.type === "error" && m.error === "too_fast"); i++) await wait(50);
      assert(ws.msgs.some((m) => m.type === "error" && m.error === "too_fast"), "нет too_fast");
      ws.close();
    });

    await test("неверный код — 404 на ws", async () => {
      await assert.rejects(rawWs("NOPE99"));
    });

    let room, bots;
    await test("шестеро входят, ведущий — создатель", async () => {
      room = await NetBot.createRoom(BASE);
      const host = await NetBot.connect({ base: BASE, code: room.code, name: "Хост", hostToken: room.hostToken, style: "aggressor" });
      const rest = await Promise.all([1, 2, 3, 4, 5].map((i) => NetBot.connect({ base: BASE, code: room.code, name: "Бот", style: ["novice", "cautious", "hunter", "aggressor"][i % 4] })));
      bots = [host, ...rest];
      await host.until((b) => b.roster && b.roster.length === 6, 3000);
      assert.strictEqual(host.hostId, host.id);
      const names = host.roster.map((p) => p.name).sort();
      assert.deepStrictEqual(names, ["Бот", "Бот (2)", "Бот (3)", "Бот (4)", "Бот (5)", "Хост"]);
      assert.strictEqual(new Set(host.roster.map((p) => p.ci)).size, 6, "шапки разные");
      await host.until((b) => b.snap && b.snap.ph === "lobby", 2000);
    });

    await test("не ведущий не может начать", async () => {
      bots[1].send({ type: "start" });
      await wait(300);
      assert.strictEqual(bots[0].phase, "lobby");
    });

    await test("партия по сети доходит до конца: у всех один ведущий дейлика, повтор пришёл", async () => {
      bots[0].send({ type: "start" });
      await bots[0].until((b) => b.phase === "countdown" || b.phase === "fight", 2000);
      await Promise.all(bots.map((b) => b.until((x) => x.phase === "over", 60000)));
      await wait(300);
      const hosts = bots.map((b) => b.snap.host && b.snap.host.id);
      assert(hosts[0], "ведущий определён");
      assert(hosts.every((h) => h === hosts[0]));
      assert(bots.every((b) => b.replay && b.replay.frames.length > 10), "повтор");
      const evHost = bots[0].events.filter((e) => e.type === "host");
      assert.strictEqual(evHost.length, 1);
      const over = bots[0].events.find((e) => e.type === "over");
      assert(over && over.stats && over.stats.players.length === 6);
      // снимок держится в разумном размере
      const perSnap = bots[0].bytes / bots[0].recv;
      assert(perSnap < 1600, `средний размер сообщения ${perSnap.toFixed(0)} Б`);
    });

    await test("reload в фазе over: join по токену сразу получает итог (ev over, late:true) и повтор", async () => {
      const tok = bots[4].token, id = bots[4].id;
      const ws = await rawWs(room.code);
      ws.send(JSON.stringify({ type: "join", token: tok }));
      await wait(400);
      const joined = ws.msgs.find((m) => m.type === "joined");
      assert.strictEqual(joined.playerId, id);
      const evs = ws.msgs.filter((m) => m.type === "ev").flatMap((m) => m.list).filter((e) => e.type === "over");
      assert.strictEqual(evs.length, 1, "over-событий " + evs.length);
      assert.strictEqual(evs[0].late, true);
      assert(evs[0].host && evs[0].host.id && Array.isArray(evs[0].kings));
      assert.strictEqual(evs[0].stats.players.length, 6);
      assert(ws.msgs.some((m) => m.type === "replay" && m.frames.length > 10), "повтор пришёл");
      ws.close();
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
      for (const m of ["{", "null", "[]", "42", JSON.stringify({ type: "i", mx: "x", my: null, d: 5 }), JSON.stringify({ type: "join", name: "" }), JSON.stringify({ type: "join", name: "<img src=x>".repeat(5) }), JSON.stringify({ type: "hat", ci: 1e9 }), JSON.stringify({ type: "ping", rtt: -5 })]) ws.send(m);
      await wait(200);
      const joined = ws.msgs.find((m) => m.type === "joined");
      assert(joined, "вход с именем-тегом прошёл как текст");
      const r = ws.msgs.filter((m) => m.type === "roster").pop();
      const p = r.players.find((x) => x.id === joined.playerId);
      assert(p.name.length <= 15);
      const closed = new Promise((res) => ws.on("close", res));
      ws.send("x".repeat(5000));
      await closed;
      const h = await (await fetch(BASE + "/floe/api/health")).json();
      assert.strictEqual(h.ok, true);
    });

    await test("флуд вводом режется лимитом, сервер жив", async () => {
      const ws = await rawWs(room.code);
      ws.send(JSON.stringify({ type: "join", name: "Флудер" }));
      await wait(100);
      for (let i = 0; i < 2000; i++) ws.send(JSON.stringify({ type: "i", mx: 1, my: 0, d: 1, s: i }));
      await wait(300);
      const h = await (await fetch(BASE + "/floe/api/health")).json();
      assert.strictEqual(h.ok, true);
      ws.close();
    });

    await test("в комнате не больше 12 игроков", async () => {
      const r2 = await NetBot.createRoom(BASE);
      const list = [];
      for (let i = 0; i < 12; i++) list.push(await NetBot.connect({ base: BASE, code: r2.code, name: "П" + i, think: false }));
      await assert.rejects(NetBot.connect({ base: BASE, code: r2.code, name: "Лишний", think: false }), /room_full/);
      list.forEach((b) => b.close());
    });

    await test("офлайн посреди боя — снят через 5 с, ведущим не становится", async () => {
      const r3 = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r3.code, name: "А", hostToken: r3.hostToken, think: false });
      const b = await NetBot.connect({ base: BASE, code: r3.code, name: "Б", think: false });
      const c = await NetBot.connect({ base: BASE, code: r3.code, name: "В", think: false });
      a.send({ type: "start" });
      await a.until((x) => x.phase === "fight", 5000);
      c.close();
      await a.until((x) => x.events.some((e) => e.type === "removed" && e.id === c.id), 8000);
      assert(!a.snap.host || a.snap.host.id !== c.id);
      a.close(); b.close();
    });

    await test("кривая строка запроса не роняет сервер", async () => {
      const net = require("net");
      for (const line of ["GET //floe%2Fapi/health HTTP/1.1", "GET //floe%2Fws?r=A HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13"]) {
        await new Promise((res) => { const c = net.connect(PORT, "localhost", () => c.write(line + "\r\nHost: x\r\n\r\n")); c.on("data", () => c.destroy()); c.on("close", res); c.on("error", res); setTimeout(() => { c.destroy(); res(); }, 500); });
      }
      await wait(200);
      const h = await (await fetch(BASE + "/floe/api/health")).json();
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

    await test("флуд «hat»/«join» не размножает рассылку списка: не чаще раза за тик", async () => {
      const r7 = await NetBot.createRoom(BASE);
      const obs = await rawWs(r7.code), att = await rawWs(r7.code);
      obs.send(JSON.stringify({ type: "join", name: "Зритель" }));
      att.send(JSON.stringify({ type: "join", name: "Флудер" }));
      await wait(300);
      const tok = att.msgs.find((m) => m.type === "joined").token;
      const before = obs.msgs.filter((m) => m.type === "roster").length;
      for (let i = 0; i < 60; i++) att.send(JSON.stringify(i % 2 ? { type: "hat", ci: i % 20 } : { type: "join", token: tok }));
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

    await test("игровое время по часам: паузы процесса по 100 мс не растягивают floe (clock ≈ wall ± 0,3 с)", async () => {
      const r = await NetBot.createRoom(BASE);
      const a = await NetBot.connect({ base: BASE, code: r.code, name: "А", hostToken: r.hostToken, think: false });
      const b = await NetBot.connect({ base: BASE, code: r.code, name: "Б", think: false });
      await a.until((x) => x.roster && x.roster.length === 2, 3000);
      a.send({ type: "start" });
      await a.until((x) => x.phase === "fight" && x.snap && x.snap.ph === "fight", 8000);
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
      assert.strictEqual(s2.ph, "fight", "ещё идёт: " + s2.ph);
      const wall = (s2.t - s1.t) / 1000, game = s2.cl - s1.cl;
      assert(Math.abs(wall - game) < 0.3, `по часам ${wall.toFixed(2)} с, в игре ${game.toFixed(2)} с`);
      a.close(); b.close();
    });

    await test("PROD_ENV: в проде (NODE_ENV=production) env меняет политику — GHOST_TTL_MS=6000 убирает офлайн из лобби за ~6 с", async () => {
      const port2 = PORT + 300;
      const base2 = `http://localhost:${port2}`;
      const env2 = Object.assign({}, process.env, { PORT: String(port2), NODE_ENV: "production", DUMP_FILE: path.join(require("os").tmpdir(), `floe-test-${port2}.json`), GHOST_TTL_MS: "6000", PONG_MISSES: "abc" }, {});
      const s2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      s2.stdout.on("data", (d) => (log += d)); s2.stderr.on("data", (d) => (log += d));
      try {
        for (let i = 0; i < 50; i++) { try { if ((await fetch(base2 + "/floe/api/health")).ok) break; } catch {} await wait(100); }
        const r = await NetBot.createRoom(base2);
        const a = await NetBot.connect({ base: base2, code: r.code, name: "А", hostToken: r.hostToken, think: false });
        const b = await NetBot.connect({ base: base2, code: r.code, name: "Б", think: false });
        await a.until((x) => x.roster && x.roster.length === 2, 3000);
        const t0 = Date.now();
        b.close();
        await a.until((x) => x.roster.length === 1, 16000);
        const dt = Date.now() - t0;
        assert(dt < 12000, "убран за " + dt + " мс (по умолчанию было бы ≥ 60 с)");
        assert(/PONG_MISSES="abc" вне диапазона/.test(log), "мусор в env отвергнут с предупреждением");
        a.close();
      } finally { s2.kill("SIGTERM"); }
    });

    await test("OFFLINE_FALL_GRACE: сокет закрыт у самого края после рывка — при 1,5 упавший ведёт, при 0 (как сейчас) он «снят»", async () => {
      async function run(grace, off) {
        const port2 = PORT + off;
        const base2 = `http://localhost:${port2}`;
        const env2 = Object.assign({}, process.env, { PORT: String(port2), NODE_ENV: "development", DUMP_FILE: path.join(require("os").tmpdir(), `floe-test-${port2}.json`), FLOE_CFG: JSON.stringify({ FIGHT_T: 25, START_GUARD: 0 }) });
        if (grace != null) env2.OFFLINE_FALL_GRACE = String(grace);
        const s2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
        try {
          for (let i = 0; i < 50; i++) { try { if ((await fetch(base2 + "/floe/api/health")).ok) break; } catch {} await wait(100); }
          const r = await NetBot.createRoom(base2);
          const other = await NetBot.connect({ base: base2, code: r.code, name: "Второй", hostToken: r.hostToken, think: false });
          const ws = await new Promise((res, rej) => { const w = new WebSocket(`ws://localhost:${port2}/floe/ws?r=${r.code}`); w.msgs = []; w.on("message", (m) => w.msgs.push(JSON.parse(m))); w.on("open", () => res(w)); w.on("error", rej); });
          ws.send(JSON.stringify({ type: "join", name: "Рывок" }));
          await wait(300);
          const me = ws.msgs.find((m) => m.type === "joined").playerId;
          other.send({ type: "start" });
          for (let i = 0; i < 200 && !ws.msgs.some((m) => m.type === "s" && m.ph === "fight"); i++) await wait(25);
          let closed = false, seq = 0;
          for (let i = 0; i < 400 && !closed; i++) {
            ws.send(JSON.stringify({ type: "i", mx: 1, my: 0, d: i % 40 === 0 ? 1 : 0, s: ++seq }));
            await wait(25);
            const sn = ws.msgs.filter((m) => m.type === "s").pop();
            const row = sn && sn.p.find((p) => p[0] === me);
            if (row && row[6] === "ice" && Math.hypot(row[1], row[2]) > sn.R - 22) { ws.close(); closed = true; }
          }
          assert(closed, "дошёл до края");
          await other.until((b) => b.snap && (b.snap.host || b.phase === "over"), 8000);
          await wait(300);
          const ev = other.events.filter((e) => e.type === "fall" && e.id === me)[0];
          const hostId = other.snap.host && other.snap.host.id;
          return { ev, hostId, me, lottery: !!(other.snap.host && other.snap.host.lottery) };
        } finally { s2.kill("SIGTERM"); }
      }
      const on = await run(1.5, 310);
      assert(on.ev, "падение учтено событием fall");
      assert(!on.ev.offline, "падение, а не снятие");
      assert.strictEqual(on.hostId, on.me, "упавший первым — ведущий");
      assert.strictEqual(on.lottery, false, "ведущий по падению, не по жребию среди снятых");
      const off = await run(null, 311);
      if (off.ev) assert.strictEqual(off.ev.offline, true, "по умолчанию — снятие, как сейчас");
      assert(!off.ev || off.lottery, "по умолчанию отключённый — не по падению (в паре — жребий среди снятых)");
    });

    await test("MP_OFF=1: hello.mp === false (аварийный выключатель каркаса); без флага поля нет", async () => {
      const helloOf = async (extraEnv, port2) => {
        const base2 = `http://localhost:${port2}`;
        const env2 = Object.assign({}, process.env, { PORT: String(port2), NODE_ENV: "development", DUMP_FILE: path.join(require("os").tmpdir(), `floe-test-${port2}.json`) }, extraEnv);
        const s2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
        try {
          for (let i = 0; i < 50; i++) { try { if ((await fetch(base2 + "/floe/api/health")).ok) break; } catch {} await wait(100); }
          const r = await NetBot.createRoom(base2);
          return await new Promise((res, rej) => {
            const w = new WebSocket(`ws://localhost:${port2}/floe/ws?r=${r.code}`);
            w.on("message", (m) => { const j = JSON.parse(m); if (j.type === "hello") { w.close(); res(j); } });
            w.on("error", rej);
          });
        } finally { s2.kill("SIGTERM"); }
      };
      const on = await helloOf({ MP_OFF: "1" }, PORT + 340);
      assert.strictEqual(on.mp, false, "hello.mp при MP_OFF=1");
      const off = await helloOf({}, PORT + 341);
      assert.strictEqual(off.mp, undefined, "hello.mp без флага отсутствует");
    });

    await test("снятый (офлайн > OFFLINE_T) вернулся по токену: inGame true, st gone в снимке (floe-001/002)", async () => {
      const port2 = PORT + 320;
      const base2 = `http://localhost:${port2}`;
      const env2 = Object.assign({}, process.env, { PORT: String(port2), NODE_ENV: "development", DUMP_FILE: path.join(require("os").tmpdir(), `floe-test-${port2}.json`), FLOE_CFG: JSON.stringify({ FIGHT_T: 25, OFFLINE_T: 1 }) });
      const s2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
      try {
        for (let i = 0; i < 50; i++) { try { if ((await fetch(base2 + "/floe/api/health")).ok) break; } catch {} await wait(100); }
        const r = await NetBot.createRoom(base2);
        const host = await NetBot.connect({ base: base2, code: r.code, name: "Хост", hostToken: r.hostToken, think: false });
        const b = await NetBot.connect({ base: base2, code: r.code, name: "Б", think: false });
        const tok = b.token, id = b.id;
        host.send({ type: "start" });
        await b.until((x) => x.phase === "fight", 8000);
        b.close();
        await wait(2500);
        const ws = await new Promise((res, rej) => { const w = new WebSocket(`ws://localhost:${port2}/floe/ws?r=${r.code}`); w.msgs = []; w.on("message", (m) => w.msgs.push(JSON.parse(m))); w.on("open", () => res(w)); w.on("error", rej); });
        ws.send(JSON.stringify({ type: "join", token: tok }));
        await wait(500);
        assert.strictEqual(ws.msgs.find((m) => m.type === "joined").playerId, id);
        const ro = ws.msgs.filter((m) => m.type === "roster").pop();
        assert(ro.players.find((p) => p.id === id).inGame, "inGame в ростере");
        const row = ws.msgs.filter((m) => m.type === "s").pop().p.find((p) => p[0] === id);
        assert.strictEqual(row[6], "gone", "st в снимке: " + row[6]);
        ws.close(); host.close();
      } finally { s2.kill("SIGTERM"); }
    });

    await test("вход по имени (lib/seats): «Это ты?» после 2 с офлайна, подтверждение отзывает прежний токен; тёзка онлайн — «Имя (2)»; эмодзи не рвутся; аноним 4000 молча, ждущий подтверждения живёт дольше", async () => {
      const port2 = PORT + 330;
      const base2 = `http://localhost:${port2}`;
      const env2 = Object.assign({}, process.env, { PORT: String(port2), NODE_ENV: "development", DUMP_FILE: path.join(require("os").tmpdir(), `floe-test-${port2}.json`), FLOE_CFG: JSON.stringify({ FIGHT_T: 25, OFFLINE_T: 1 }), ANON_TTL_MS: "3000", CLAIM_WAIT_MS: "9000" });
      const s2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
      const sock = (code) => new Promise((res, rej) => {
        const w = new WebSocket(`ws://localhost:${port2}/floe/ws?r=${code}`);
        w.msgs = []; w.closed = null;
        w.on("message", (m) => w.msgs.push(JSON.parse(m)));
        w.on("close", (c) => (w.closed = c));
        w.on("open", () => res(w)); w.on("error", rej);
      });
      const until = async (fn, ms) => { for (let i = 0; i < ms / 50; i++) { const v = fn(); if (v) return v; await wait(50); } return fn(); };
      const last = (w, type) => w.msgs.filter((m) => m.type === type || m.error === type).pop();
      try {
        for (let i = 0; i < 50; i++) { try { if ((await fetch(base2 + "/floe/api/health")).ok) break; } catch {} await wait(100); }
        const r = await NetBot.createRoom(base2);
        const host = await NetBot.connect({ base: base2, code: r.code, name: "Хост", hostToken: r.hostToken, think: false });
        // эмодзи на границе 15 символов: срез по символам, без «�»
        const emo = await sock(r.code);
        emo.send(JSON.stringify({ type: "join", name: "Двенадцать" + "😀".repeat(8), caps: ["claim"] }));
        const ej = await until(() => last(emo, "joined"), 2000);
        assert.strictEqual(Array.from(ej.name).length, 15);
        assert(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(ej.name), "нет одиночных суррогатов");
        // Маша входит, закрывается
        const m1 = await sock(r.code);
        m1.send(JSON.stringify({ type: "join", name: "Маша", caps: ["claim"] }));
        const j1 = await until(() => last(m1, "joined"), 2000);
        assert.strictEqual(j1.name, "Маша");
        // тёзка, пока Маша онлайн, — «Маша (2)»
        const twin = await sock(r.code);
        twin.send(JSON.stringify({ type: "join", name: "маша", caps: ["claim"] }));
        const jt = await until(() => last(twin, "joined"), 2000);
        assert.strictEqual(jt.name, "маша (2)");
        assert.strictEqual(jt.renamed, true);
        m1.close();
        await wait(300);
        // раньше 2 с: «подожди» (retry)
        const c0 = await sock(r.code);
        c0.send(JSON.stringify({ type: "join", name: "Маша", caps: ["claim"] }));
        const e0 = await until(() => last(c0, "name_claim"), 2000);
        assert(e0 && e0.retry === true, "в первые 2 с — тихий повтор");
        // после 2 с — «Это ты?», сокет ждёт дольше ANON_TTL_MS (3 с)
        await wait(2000);
        const c1 = await sock(r.code);
        c1.send(JSON.stringify({ type: "join", name: "Маша", caps: ["claim"] }));
        const e1 = await until(() => last(c1, "name_claim"), 2000);
        assert(e1 && !e1.retry && e1.name === "Маша", "подтверждение: " + JSON.stringify(e1));
        await wait(5000);
        assert.strictEqual(c1.closed, null, "ждущий подтверждения не отключён по ANON_TTL_MS");
        // без подтверждения старый токен жив; подтвердили — токен отозван
        c1.send(JSON.stringify({ type: "join", name: "Маша", caps: ["claim"], claim: true }));
        const j2 = await until(() => last(c1, "joined"), 2000);
        assert.strictEqual(j2.playerId, j1.playerId);
        assert.strictEqual(j2.resumed, true);
        assert.notStrictEqual(j2.token, j1.token);
        const old = await sock(r.code);
        old.send(JSON.stringify({ type: "join", token: j1.token, name: "Маша", caps: ["claim"] }));
        const jo = await until(() => last(old, "joined") || last(old, "name_claim") || last(old, "name_taken"), 2000);
        assert(!(jo.type === "joined" && jo.playerId === j1.playerId && jo.token === j1.token), "прежний токен отозван");
        // аноним без входа: закрыт кодом 4000 на ~3 с
        const idle = await sock(r.code);
        await until(() => idle.closed != null, 25000);   // проверка живости раз в 20 с
        assert.strictEqual(idle.closed, 4000);
        [emo, twin, c0, c1, old].forEach((w) => { try { w.close(); } catch {} });
        host.close();
      } finally { s2.kill("SIGTERM"); }
    });

    await test("«мёртвая рука»: ввод замолчал дольше INPUT_STALE_MS (env, прод) — пингвин останавливается, а не бежит к краю", async () => {
      // raw-клиент шлёт один `i {mx:1}` и молчит (замороженная вкладка); сервер в production с разными INPUT_STALE_MS
      async function run(stale, off) {
        const port2 = PORT + off;
        const base2 = `http://localhost:${port2}`;
        const env2 = Object.assign({}, process.env, { PORT: String(port2), NODE_ENV: "production", DUMP_FILE: path.join(require("os").tmpdir(), `floe-test-${port2}.json`), INPUT_STALE_MS: String(stale) });
        const s2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: env2, stdio: ["ignore", "pipe", "pipe"] });
        try {
          for (let i = 0; i < 50; i++) { try { if ((await fetch(base2 + "/floe/api/health")).ok) break; } catch {} await wait(100); }
          const r = await NetBot.createRoom(base2);
          const ws = await new Promise((res, rej) => { const w = new WebSocket(`ws://localhost:${port2}/floe/ws?r=${r.code}`); w.msgs = []; w.on("message", (m) => w.msgs.push(JSON.parse(m))); w.on("open", () => res(w)); w.on("error", rej); });
          ws.send(JSON.stringify({ type: "join", name: "Заморожен", hostToken: r.hostToken }));
          const other = await NetBot.connect({ base: base2, code: r.code, name: "Второй", think: false });
          await wait(300);
          const me = ws.msgs.find((m) => m.type === "joined").playerId;
          ws.send(JSON.stringify({ type: "start" }));
          for (let i = 0; i < 100 && !ws.msgs.some((m) => m.type === "s" && m.ph === "fight"); i++) await wait(50);
          ws.send(JSON.stringify({ type: "i", mx: 1, my: 0, d: 0, s: 1 }));
          await wait(3500);
          const row = ws.msgs.filter((m) => m.type === "s").pop().p.find((p) => p[0] === me);
          ws.close(); other.close();
          return { st: row[6], speed: Math.hypot(row[3], row[4]) };
        } finally { s2.kill("SIGTERM"); }
      }
      const stopped = await run(300, 301);
      assert.strictEqual(stopped.st, "ice", "остался на льду: " + stopped.st);
      assert(stopped.speed < 5, "скорость погашена: " + stopped.speed);
      const runaway = await run(60000, 302);
      assert.notStrictEqual(runaway.st, "ice", "контроль (потолок 60 с): без «мёртвой руки» пингвин добегает до края");
    });

    await test("сверх лимита ввод не теряется: рывок в сообщении №90 из пачки применяется; флуд 5000/с — сервер жив", async () => {
      const r = await NetBot.createRoom(BASE);
      const host = await NetBot.connect({ base: BASE, code: r.code, name: "Хост", hostToken: r.hostToken, think: false });
      const ws = await rawWs(r.code);
      ws.send(JSON.stringify({ type: "join", name: "Спамер" }));
      await wait(300);
      const me = ws.msgs.find((m) => m.type === "joined").playerId;
      host.send({ type: "start" });
      for (let i = 0; i < 100 && !ws.msgs.some((m) => m.type === "s" && m.ph === "fight"); i++) await wait(50);
      await wait(2300);   // защита старта: рывок раньше 2 с боя не сработает
      const dashes = () => ws.msgs.filter((m) => m.type === "ev").flatMap((m) => m.list).filter((e) => e.type === "dash" && e.id === me).length;
      assert.strictEqual(dashes(), 0);
      // пачка в один тик: первые 70 принимаются сразу, дальше — сверх общего лимита; рывок — в №90
      for (let i = 1; i <= 100; i++) ws.send(JSON.stringify({ type: "i", mx: i === 100 ? 0 : 1, my: 0, d: i === 90 ? 1 : 0, s: i }));
      await wait(400);
      assert.strictEqual(dashes(), 1, "рывок из сообщения сверх лимита применён");
      // флуд: потолок не снят, процесс и тики живы
      for (let i = 0; i < 5000; i++) ws.send(JSON.stringify({ type: "i", mx: 1, my: 0, d: 1, s: 1000 + i }));
      await wait(500);
      const h = await (await fetch(BASE + "/floe/api/health")).json();
      assert.strictEqual(h.ok, true);
      assert(dashes() <= 4, "рывков за флуд: " + dashes() + " (перезарядка держит)");
      ws.close(); host.close();
    });

    await test("режим «экран»: зритель получает партию, не игрок, ведущим становится вошедший с токеном", async () => {
      const r5 = await NetBot.createRoom(BASE);
      const v = await rawWs(r5.code);
      v.send(JSON.stringify({ type: "view", hostToken: r5.hostToken }));
      await wait(300);
      assert(v.msgs.some((m) => m.type === "s"), "зритель получил снимок");
      assert(v.msgs.some((m) => m.type === "s" && "sh" in m), "со строкой осколков");
      const g = await NetBot.connect({ base: BASE, code: r5.code, name: "Гость", think: false });
      await wait(300);
      assert.strictEqual(g.hostId, null, "без токена ведущим первый гость не стал");
      const h = await NetBot.connect({ base: BASE, code: r5.code, name: "Хозяин", hostToken: r5.hostToken, think: false });
      await h.until((b) => b.hostId === b.id, 3000);
      h.send({ type: "start" });
      await h.until((b) => b.phase !== "lobby", 5000);
      await wait(800);
      assert(v.msgs.some((m) => m.type === "s" && m.ph !== "lobby"), "зритель видит ход партии");
      assert(v.msgs.some((m) => m.type === "ev"), "зритель получает события");
      v.send(JSON.stringify({ type: "start" }));   // зритель не ведёт комнату и не играет
      v.send(JSON.stringify({ type: "i", mx: 1, my: 0, d: 1 }));
      assert.strictEqual(v.readyState, 1);
      v.close(); g.close(); h.close();
    });

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
