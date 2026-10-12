"use strict";
// Очередь неотправленных действий телефона (lastq-shared.js, lqConnect): node --test test-queue.js
// Обрыв сокета → тап не пропадает, уходит после возврата связи; просроченное — onDrop; лишнее — молча.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load() {
  const timers = [];
  let nowMs = 1000000;
  const sockets = [];
  class FakeWS {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(d) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen && this.onopen(); }
    drop() { this.readyState = 3; this.onclose && this.onclose({}); }
  }
  const sandbox = {
    console, JSON, Date: { now: () => nowMs }, Math, Number, Array, Object, Promise,
    setTimeout: (f, ms) => { const t = { f, at: nowMs + (ms || 0) }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 0, clearInterval: () => {},
    WebSocket: FakeWS, fetch: () => Promise.reject(new Error("no fetch")),
    location: { protocol: "http:", host: "x" },
    document: { addEventListener() {}, hidden: false, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; }, documentElement: { style: {} }, body: null, readyState: "loading" },
    window: { addEventListener() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    performance: { now: () => nowMs }, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "lastq-shared.js"), "utf8") + "\nthis.lqConnect = lqConnect;", sandbox);
  const advance = (ms) => { nowMs += ms; for (const t of timers.slice()) if (t.at <= nowMs) { timers.splice(timers.indexOf(t), 1); t.f(); } };
  return { lqConnect: sandbox.lqConnect, sockets, advance };
}

test("тап в обрыве ждёт в очереди и уходит после возврата связи", () => {
  const env = load();
  const fails = [], drops = [];
  const conn = env.lqConnect({ code: "X", onMessage() {}, onSendFail: (m) => fails.push(m), onDrop: (m, why) => drops.push([m, why]) });
  env.sockets[0].open();
  const msg = { type: "answer", i: 2 };
  conn.send(msg);
  assert.deepEqual(env.sockets[0].sent.filter((m) => m.type === "answer"), [msg]);
  env.sockets[0].drop();
  const m2 = { type: "bet", prisoner: "p1", escape: true };
  conn.send(m2);
  assert.ok(conn.queued(m2), "в обрыве действие встало в очередь");
  assert.equal(fails.length, 0, "onSendFail не нужен: действие не потеряно");
  env.advance(1000); // переподключение (пауза 0,5 с)
  assert.equal(env.sockets.length, 2);
  env.sockets[1].open();
  conn.flush(() => true);
  assert.deepEqual(env.sockets[1].sent.filter((m) => m.type === "bet"), [m2], "после возврата связи действие ушло");
  assert.ok(!conn.queued(m2));
  assert.equal(drops.length, 0);
});

test("просроченное в очереди (30 с) — onDrop; ненужное по keep — молча", () => {
  const env = load();
  const drops = [];
  const conn = env.lqConnect({ code: "X", onMessage() {}, onSendFail() {}, onDrop: (m, why) => drops.push([m.type, why]) });
  env.sockets[0].open();
  env.sockets[0].drop();
  const old = { type: "answer", i: 1 }, stale = { type: "group", group: "head" };
  conn.send(old);
  env.advance(31000);
  conn.send(stale);
  env.sockets[env.sockets.length - 1].open();
  conn.flush((m) => m !== stale);
  assert.deepEqual(drops, [["answer", "ttl"]]);
  const last = env.sockets[env.sockets.length - 1];
  assert.equal(last.sent.filter((m) => m.type === "answer" || m.type === "group").length, 0);
});

test("действие, пережившее обрыв меньше 30 с, не отбрасывается (раньше терялось через 6 с)", () => {
  const env = load();
  const drops = [];
  const conn = env.lqConnect({ code: "X", onMessage() {}, onSendFail() {}, onDrop: (m, why) => drops.push(why) });
  env.sockets[0].open();
  env.sockets[0].drop();
  const m = { type: "stake", n: 50 };
  conn.send(m);
  env.advance(12000);
  env.sockets[env.sockets.length - 1].open();
  conn.flush(() => true);
  assert.deepEqual(env.sockets[env.sockets.length - 1].sent.filter((x) => x.type === "stake"), [m]);
  assert.equal(drops.length, 0);
});

test("переполнение очереди (> 8) — onDrop для самых старых", () => {
  const env = load();
  const drops = [];
  const conn = env.lqConnect({ code: "X", onMessage() {}, onSendFail() {}, onDrop: (m, why) => drops.push([m.i, why]) });
  env.sockets[0].open();
  env.sockets[0].drop();
  for (let i = 0; i < 10; i++) conn.send({ type: "answer", i });
  assert.deepEqual(drops, [[0, "overflow"], [1, "overflow"]]);
});
