#!/usr/bin/env node
"use strict";
/*
 * Самопроверка testkit (Node): node tools/testkit/selftest.js  (из корня репозитория)
 * 6 кейсов scanFrames (приёмка T-W0-03) + кейсы ws-kit на встроенной заглушке сервера + sizes.
 */
const assert = require("assert");
const http = require("http");
const { scanFrames } = require("./scan");
const kit = require("./ws-kit");
const { phoneSizes, tvSizes } = require("./sizes");

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { passed++; console.log("  ✓ " + name); },
    (e) => { failed++; console.log("  ✗ " + name + "\n    " + String(e && e.stack || e).split("\n").slice(0, 3).join("\n    ")); }
  ));
}

// ---- scanFrames: 6 кейсов приёмки ----
console.log("scanFrames");
test("запрещённое поле найдено (путь и ключ)", () => {
  const v = scanFrames([{ type: "state", state: { phase: "live", holder: { id: "p1", fuseMs: 4000 } } }], { forbiddenKeys: ["fuseMs", "salt"] });
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].path, "state.holder.fuseMs");
  assert.strictEqual(v[0].type, "key");
  assert.strictEqual(v[0].frame, 0);
});
test("фаза вне списка игнорируется", () => {
  const fr = [{ type: "state", state: { phase: "lobby", salt: "x" } }, { type: "state", state: { phase: "live", salt: "y" } }];
  const v = scanFrames(fr, { forbiddenKeys: ["salt"], phases: ["live"] });
  assert.deepStrictEqual(v.map((x) => x.frame), [1]);
});
test("вид board/игрок различается", () => {
  const fr = [
    { view: "board", t: 1, frame: { type: "state", state: { lineups: { a: [] } } } },
    { view: "player", t: 2, frame: { type: "state", state: { lineups: { a: [] } } } },
  ];
  const v = scanFrames(fr, { views: { player: { forbiddenKeys: ["lineups"] } } });
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].view, "player");
  assert.strictEqual(v[0].frame, 1);
});
test("одиночный суррогат — нарушение, пара — нет", () => {
  const bad = scanFrames([{ name: "Аня\uD83D" }]);
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].type, "surrogate");
  assert.strictEqual(bad[0].path, "name");
  assert.deepStrictEqual(scanFrames([{ name: "Аня😀" }]), []);
  assert.strictEqual(scanFrames([{ name: "\uDE00" }]).length, 1);
});
test("чистый кадр — пустой результат (JSON-строка тоже)", () => {
  assert.deepStrictEqual(scanFrames([{ type: "hello", code: "ABC23", state: { phase: "lobby", players: [] } }], { forbiddenKeys: ["fuseMs"], forbiddenSubstrings: ["SECRET"] }), []);
  assert.deepStrictEqual(scanFrames([JSON.stringify({ type: "pong" })], { forbiddenKeys: ["x"] }), []);
  assert.strictEqual(scanFrames([JSON.stringify({ a: { fuse: 1 } })], { forbiddenKeys: ["fuse"] }).length, 1);
});
test("вложенные массивы: путь с индексами, подстрока, функция-правило", () => {
  const fr = [{ state: { rounds: [[{ ok: 1 }, { answers: [{ authorId: "p3" }] }]], note: ["a", "token=abcd"] } }];
  const v = scanFrames(fr, { forbiddenKeys: ["authorId"], forbiddenSubstrings: ["token="] });
  const paths = v.map((x) => x.path).sort();
  assert.deepStrictEqual(paths, ["state.note[1]", "state.rounds[0][1].answers[0].authorId"]);
  const f = scanFrames([{ answered: [1, 2] }, { answered: 3 }], { forbiddenKeys: [(p, k, val) => k === "answered" && Array.isArray(val)] });
  assert.deepStrictEqual(f.map((x) => x.frame), [0]);
});

// ---- sizes ----
console.log("sizes");
test("phoneSizes: 9 вьюпортов, iPhone UA, ландшафт; tvSizes: 4", () => {
  const p = kit.GAMES && phoneSizes();
  assert.strictEqual(p.length, 9);
  assert(p.every((s) => /iPhone/.test(s.userAgent) && s.viewport.width === s.width));
  assert.strictEqual(phoneSizes({ orientation: "landscape" }).length, 4);
  assert.strictEqual(tvSizes().length, 4);
  assert(/Chrome\/80/.test(tvSizes({ oldProjector: true })[0].userAgent));
});

// ---- ws-kit на заглушке ----
console.log("ws-kit");
async function withStub(fn) {
  const { WebSocketServer } = kit.loadWs("bomb");
  const calls = [];
  const srv = http.createServer((req, res) => {
    if (req.url === "/bomb/api/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":true,"rooms":0}'); }
    if (req.url === "/bomb/api/rooms" && req.method === "POST") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"code":"TEST23","hostToken":"HT"}'); }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on("connection", (ws, req) => {
    ws.send(JSON.stringify({ type: "hello", code: "TEST23", state: { phase: "lobby" } }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw); calls.push(m);
      if (m.type === "host") ws.send(JSON.stringify(m.token === "HT" ? { type: "host_ok" } : { type: "error", error: "bad host token" }));
      if (m.type === "join") ws.send(JSON.stringify({ type: "joined", playerId: "p1", token: "tok1" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  try { await fn(base, calls); } finally { wss.close(); srv.close(); }
}
test("createRoom/health/host/join/collect/scan/close", async () => {
  await withStub(async (base, calls) => {
    assert.strictEqual((await kit.healthOf(base, "bomb")).ok, true);
    const room = await kit.createRoom(base, "bomb");
    assert.deepStrictEqual(room, { code: "TEST23", hostToken: "HT" });
    const h = await kit.host(base, "bomb", room);
    const p = await kit.join(base, "bomb", room, "Аня");
    assert.strictEqual(h.hostOk, true);
    assert.strictEqual(p.playerId, "p1");
    assert.strictEqual(p.token, "tok1");
    assert.strictEqual(p.hello.code, "TEST23");
    assert(calls.some((m) => m.type === "join" && m.name === "Аня"));
    assert.strictEqual(kit.scan(kit.framesOf(h, p), { forbiddenKeys: ["fuseMs"] }).length, 0);
    assert.deepStrictEqual(h.frames.map((f) => f.view), ["board", "board"]);
    await assert.rejects(() => p.waitFor("never", 150), /таймаут/);
    await kit.closeAll(h, p);
    assert(h.closed && p.closed);
  });
});
test("неверный токен ведущего → error, hostOk=false", async () => {
  await withStub(async (base) => {
    const h = await kit.host(base, "bomb", { code: "TEST23", hostToken: "WRONG" });
    assert.strictEqual(h.hostOk, false);
    assert(h.frames.some((f) => f.frame.type === "error"));
    await h.close();
  });
});

// ---- restore: шаблон «дамп прошлой версии» (T-W0-31) ----
console.log("restore");
const restore = require("./restore");
test("restore: stripFields вырезает вложенные, массивные и словарные пути; копия не меняет исходник", () => {
  const st = { chooseExtended: true, players: [{ id: "a", played: 1 }, { id: "b", played: 0 }], paused: { auto: true, waitFor: "a", waitUntil: 5 }, cards: { x: { n: 1, repl: 2 } } };
  const r = restore.stripFields(st, ["chooseExtended", "players[].played", "paused.waitFor", "paused.waitUntil", "cards{}.repl", "нет.такого"]);
  assert.strictEqual(r.removed, 6);
  assert.deepStrictEqual(r.state, { players: [{ id: "a" }, { id: "b" }], paused: { auto: true }, cards: { x: { n: 1 } } });
  assert.strictEqual(st.players[0].played, 1);
  restore.assertAbsent(r.state, ["players[].played", "paused.waitFor"]);
  assert.throws(() => restore.assertAbsent(st, ["players[].played"]), /остались поля/);
});
test("restore: makeOldDump — по коду комнаты и для всех комнат", () => {
  const dump = [restore.roomEntry({ code: "A", hostToken: "t", state: { x: 1, y: 2 } }), restore.roomEntry({ code: "B", hostToken: "t", state: { x: 1 } })];
  const one = restore.makeOldDump(dump, { A: ["x"] });
  assert.strictEqual("x" in one[0].state, false);
  assert.strictEqual(one[1].state.x, 1);
  const all = restore.makeOldDump(dump, ["x"]);
  assert.ok(all.every((r) => !("x" in r.state)));
  assert.strictEqual(dump[0].state.x, 1);
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} зелёных, ${failed} красных`);
  process.exit(failed ? 1 : 0);
});
