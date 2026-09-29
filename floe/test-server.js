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
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + String(e.stack || e).split("\n").slice(0, 3).join("\n    ")); }
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
      assert.deepStrictEqual(names, ["Бот", "Бот 2", "Бот 3", "Бот 4", "Бот 5", "Хост"]);
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
      assert.strictEqual(bots[1].hostId, bots[1].id);
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

    await test("с одного адреса не больше 10 анонимных сокетов в комнате", async () => {
      const r6 = await NetBot.createRoom(BASE);
      const list = [];
      let refused = 0;
      for (let i = 0; i < 12; i++) { try { list.push(await rawWs(r6.code)); } catch { refused++; } }
      assert.strictEqual(list.length, 10);
      assert.strictEqual(refused, 2);
      list.forEach((w) => w.close());
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
