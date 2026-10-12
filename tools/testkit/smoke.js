#!/usr/bin/env node
"use strict";
/*
 * Дымовой тест 10 игр (T-W0-26): health → комната → WS hello ≤ 2 с → один игрок → scanFrames.
 *
 *   node tools/testkit/smoke.js https://randomhost.online          # прод/стенд за nginx: /<игра>/api/..., /<игра>/ws
 *   node tools/testkit/smoke.js --local                            # dev-серверы на 127.0.0.1, порты по умолчанию игр (3000…3900)
 *   node tools/testkit/smoke.js --local --port-base 4100           # игра i слушает 4100+i (порядок: auction roulette bomb quip fibs wave floe lastq crowd rapids)
 *   node tools/testkit/smoke.js --spawn --port-base 4100           # сам поднять 10 серверов (DUMP_FILE во временный каталог), прогнать, остановить
 *   node tools/testkit/smoke.js <base> --port 8080                 # один порт для всех (nginx/compose на 127.0.0.1:8080)
 *
 * Опции:  --games bomb,quip        только эти игры
 *         --reuse FILE             взять коды комнат из JSON {игра: код} вместо создания (комнату закрыть нечем)
 *         --save FILE              записать созданные коды (для --reuse в следующий раз)
 *         --ports bomb=3300,...    точечные порты
 *         --node PATH              Node для --spawn (по умолчанию текущий)
 *         --hello-ms N             лимит hello (по умолчанию 2000)
 *         --json                   итог одной JSON-строкой в stdout
 *
 * ПРОД: каждый прогон оставляет 10 комнат на ROOM_TTL_MS (30 мин) и считается в MAX_ROOMS_PER_IP и зону
 * nginx `rooms` (1 r/s, burst 10) — не чаще раза за релиз; создания разнесены на 1,1 с. Код выхода ≠ 0 при
 * любом нарушении. На продакшен скрипт сам не нацеливается: базовый адрес обязателен (или --local/--spawn).
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const kit = require("./ws-kit");

const REPO = path.resolve(__dirname, "..", "..");
const ORDER = kit.GAMES; // auction roulette bomb quip fibs wave floe lastq crowd rapids

// запретные ключи в hello/state/roster кадрах игрока (минимум; расширяется T-W0-05)
const COMMON_KEYS = ["hostToken", "hostSecret", "passCode"];
const GAME_KEYS = {
  // `fuse` — НЕ запрещён: state.fuse={min,max} (объявленный диапазон) и settings.fuse="normal" публичны по замыслу.
  // Секрет — точный фитиль живой бомбы: fuseMs/salt/explodeAt и min/max внутри bombs[].
  bomb: ["fuseMs", "salt", "explodeAt", (p) => /(^|\.)bombs\[\d+\]\.(min|max)$/.test(p)],
  lastq: ["ch", "hostToken"],
};
const SCAN_TYPES = new Set(["hello", "state", "roster", "joined", "snapshot"]);

function parseArgs(argv) {
  const o = { base: null, local: false, spawn: false, portBase: null, port: null, games: null, reuse: null, save: null, ports: {}, helloMs: 2000, json: false, node: process.execPath };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], nx = () => argv[++i];
    if (a === "--local") o.local = true;
    else if (a === "--spawn") o.spawn = true;
    else if (a === "--port-base") o.portBase = Number(nx());
    else if (a === "--port") o.port = Number(nx());
    else if (a === "--games") o.games = nx().split(",").filter(Boolean);
    else if (a === "--reuse") o.reuse = nx();
    else if (a === "--save") o.save = nx();
    else if (a === "--ports") nx().split(",").forEach((kv) => { const [g, p] = kv.split("="); if (g && p) o.ports[g] = Number(p); });
    else if (a === "--hello-ms") o.helloMs = Number(nx());
    else if (a === "--node") o.node = nx();
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^[\s\S]*?\/\*\n?/, "")); process.exit(0); }
    else if (!a.startsWith("--") && !o.base) o.base = a;
    else { console.error("неизвестный аргумент: " + a); process.exit(2); }
  }
  return o;
}

function portFor(o, game) {
  if (o.ports[game]) return o.ports[game];
  if (o.port) return o.port;
  if (o.portBase) return o.portBase + ORDER.indexOf(game);
  return kit.GAME_INFO[game].port;
}
function baseFor(o, game) {
  if (o.spawn || o.local) {
    const host = o.base && /^https?:\/\//.test(o.base) ? o.base.replace(/\/+$/, "").replace(/:\d+$/, "") : "http://127.0.0.1";
    return host + ":" + portFor(o, game);
  }
  const b = o.base.replace(/\/+$/, "");
  return o.port ? b.replace(/:\d+$/, "") + ":" + o.port : b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("таймаут: " + what)), ms))]);

async function smokeGame(o, game, reuse, isLocal) {
  const t0 = Date.now();
  const res = { game, ok: false, steps: [], error: null, code: null, ms: 0 };
  const step = (name, extra) => res.steps.push(Object.assign({ name, ms: Date.now() - t0 }, extra || {}));
  const base = baseFor(o, game);
  let player = null;
  try {
    const h = await withTimeout(kit.healthOf(base, game), 5000, "health");
    if (!h || h.ok !== true) throw new Error("health.ok !== true: " + JSON.stringify(h));
    step("health", { rooms: h.rooms });

    let code;
    if (reuse && reuse[game]) { code = reuse[game]; step("reuse", { code }); }
    else {
      const room = await withTimeout(kit.createRoom(base, game), 8000, "создание комнаты");
      code = room.code;
      step("room", { code });
    }
    res.code = code;

    const tH = Date.now();
    player = await withTimeout(kit.rawSocket(base, game, code, { view: "player" }), 5000, "подключение WS");
    const hello = await player.waitFor("hello", o.helloMs).catch(() => null);
    const helloMs = Date.now() - tH;
    if (!hello) throw new Error("нет hello за " + o.helloMs + " мс");
    step("hello", { helloMs });

    player.send({ type: "join", name: "Smoke" });
    const j = await player.waitFor((m) => m.type === "joined" || m.type === "error", 4000);
    if (j.type !== "joined") throw new Error("join отклонён: " + JSON.stringify(j));
    step("join", { playerId: j.playerId });
    await sleep(250); // хвост кадров после входа (state/roster)

    const frames = player.frames.filter((r) => SCAN_TYPES.has(r.frame.type));
    const keys = COMMON_KEYS.concat(GAME_KEYS[game] || []);
    const violations = kit.scanFrames(frames, { forbiddenKeys: keys });
    step("scan", { frames: frames.length, violations: violations.length });
    if (violations.length) {
      throw new Error("утечка в кадрах: " + violations.slice(0, 5).map((v) => v.type + " " + v.path).join(", ") + (violations.length > 5 ? " …(+" + (violations.length - 5) + ")" : ""));
    }
    res.ok = true;
  } catch (e) {
    res.error = (e && e.message) || String(e);
  } finally {
    if (player) await player.close().catch(() => {});
    res.ms = Date.now() - t0;
  }
  return res;
}

async function spawnServers(o, games) {
  const procs = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-smoke-"));
  for (const g of games) {
    const port = portFor(o, g);
    const p = spawn(o.node, ["server.js"], {
      cwd: path.join(REPO, g),
      env: Object.assign({}, process.env, { PORT: String(port), DUMP_FILE: path.join(tmp, g + ".json") }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.log = "";
    p.stdout.on("data", (d) => (p.log += d));
    p.stderr.on("data", (d) => (p.log += d));
    p.game = g;
    procs.push(p);
  }
  // ждём health
  for (const p of procs) {
    const base = "http://127.0.0.1:" + portFor(o, p.game);
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      if (p.exitCode !== null) break;
      try { const r = await fetch(base + "/" + p.game + "/api/health"); up = r.ok; } catch {}
      if (!up) await sleep(100);
    }
    if (!up) console.error("[smoke] " + p.game + " не поднялся на порту " + portFor(o, p.game) + ":\n" + p.log.slice(-400));
  }
  return { procs, tmp, stop() { procs.forEach((p) => { try { p.kill("SIGTERM"); } catch {} }); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } };
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (!o.base && !o.local && !o.spawn) {
    console.error("укажите базовый URL (node tools/testkit/smoke.js https://host) или --local / --spawn");
    process.exit(2);
  }
  const games = (o.games || ORDER).filter((g) => ORDER.includes(g));
  const isLocal = o.local || o.spawn || /^https?:\/\/(localhost|127\.|\[::1\])/.test(o.base || "");
  const reuse = o.reuse ? JSON.parse(fs.readFileSync(o.reuse, "utf8")) : null;

  let sp = null;
  if (o.spawn) sp = await spawnServers(o, games);
  const results = [];
  try {
    for (const g of games) {
      const before = Date.now();
      const r = await smokeGame(o, g, reuse, isLocal);
      results.push(r);
      if (!o.json) console.log((r.ok ? "  ✓ " : "  ✗ ") + g.padEnd(9) + (r.code ? r.code.padEnd(11) : "".padEnd(11)) + (r.ok ? r.ms + " мс" : r.error));
      // nginx rooms: 1 r/s — не упираемся в burst на проде
      if (!isLocal && !(reuse && reuse[g])) await sleep(Math.max(0, 1100 - (Date.now() - before)));
    }
  } finally {
    if (sp) sp.stop();
  }
  if (o.save) {
    const codes = {};
    results.forEach((r) => { if (r.code) codes[r.game] = r.code; });
    fs.writeFileSync(o.save, JSON.stringify(codes, null, 2));
  }
  const bad = results.filter((r) => !r.ok);
  if (o.json) console.log(JSON.stringify({ ok: bad.length === 0, results }));
  else console.log(`\n${results.length - bad.length}/${results.length} игр зелёные` + (bad.length ? "; красные: " + bad.map((r) => r.game).join(", ") : ""));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
