"use strict";

// Тесты очереди потерянных тапов телефона (quip-shared.js → qpConnect): node --test test-shared.js
// Берём из quip-shared.js только транспорт и qpConnect и гоняем их в vm с поддельными WebSocket и таймерами.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "quip-shared.js"), "utf8");
const part = src.slice(src.indexOf("let qpWsBroken"));

function rig() {
  let now = 1000000;
  const timers = [];
  let seq = 0;
  const socks = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; socks.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen && this.onopen(); }
    drop() { this.readyState = 3; this.onclose && this.onclose({}); }
  }
  const sched = (fn, ms, every) => { const id = ++seq; timers.push({ id, at: now + ms, fn, every: every ? ms : 0 }); return id; };
  const ctx = {
    WebSocket: FakeWS,
    location: { protocol: "http:", host: "x" },
    document: { addEventListener() {}, hidden: false },
    window: { addEventListener() {} },
    fetch: () => Promise.reject(new Error("net")),
    qpClockSample() {}, qpStateSample() {},
    encodeURIComponent,
    JSON, Math, Date: { now: () => now }, Promise, Number, String, Array, Object, Error, console,
    setTimeout: (fn, ms) => sched(fn, ms, false),
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => sched(fn, ms, true),
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  vm.createContext(ctx);
  vm.runInContext(part + "\nthis.qpConnect = qpConnect;", ctx);
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every) due.at += due.every; else timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    now = end;
  };
  return { ctx, socks, advance };
}

test("тап в обрыв: ждёт возвращения связи и уходит после flush", () => {
  const { ctx, socks, advance } = rig();
  const dropped = [];
  const conn = ctx.qpConnect({ code: "ABC", onMessage() {}, onDrop: (m) => dropped.push(m) });
  socks[0].open();
  socks[0].drop(); // обрыв; переподключение через 500 мс
  conn.send({ type: "answer", mid: 7, ans: "привет" }); // тап во время обрыва
  assert.strictEqual(socks[0].sent.filter((m) => m.type === "answer").length, 0);
  advance(600); // переподключение через 500 мс, сокет открывается
  const s2 = socks[socks.length - 1];
  assert.notStrictEqual(s2, socks[0]);
  s2.open();
  conn.flush(() => true, (m) => dropped.push(m));
  assert.deepStrictEqual(s2.sent.filter((m) => m.type === "answer"), [{ type: "answer", mid: 7, ans: "привет" }]);
  assert.strictEqual(dropped.length, 0);
  conn.stop();
});

test("связи нет дольше 30 с: действие не висит вечно — onDrop", () => {
  const { ctx, socks, advance } = rig();
  const dropped = [];
  const conn = ctx.qpConnect({ code: "ABC", onMessage() {}, onDrop: (m) => dropped.push(m) });
  socks[0].open();
  socks[0].drop();
  conn.send({ type: "vote", mid: 3, picks: [1] });
  advance(10000);
  assert.strictEqual(dropped.length, 0, "в пределах срока ещё ждём");
  advance(25000);
  assert.deepStrictEqual(dropped, [{ type: "vote", mid: 3, picks: [1] }]);
  conn.stop();
});

test("очередь ≤ 8: переполнение отбрасывает старейшее через onDrop; дубль той же схватки не плодится", () => {
  const { ctx, socks } = rig();
  const dropped = [];
  const conn = ctx.qpConnect({ code: "ABC", onMessage() {}, onDrop: (m) => dropped.push(m) });
  socks[0].open();
  socks[0].drop();
  conn.send({ type: "vote", mid: 1, picks: [0] });
  conn.send({ type: "vote", mid: 1, picks: [0] }); // дубль
  for (let i = 2; i <= 9; i++) conn.send({ type: "answer", mid: i, ans: "x" });
  assert.strictEqual(dropped.length, 1);
  assert.strictEqual(dropped[0].mid, 1);
  conn.stop();
});

test("flush: просроченное и неактуальное уходит в onDrop, актуальное — в сокет", () => {
  const { ctx, socks, advance } = rig();
  const dropped = [];
  const conn = ctx.qpConnect({ code: "ABC", onMessage() {}, onDrop: () => {} });
  socks[0].open();
  socks[0].drop();
  conn.send({ type: "answer", mid: 1, ans: "a" });
  conn.send({ type: "answer", mid: 2, ans: "b" });
  advance(1500);
  const s2 = socks[socks.length - 1];
  s2.open();
  conn.flush((m) => m.mid === 2, (m) => dropped.push(m));
  assert.deepStrictEqual(dropped.map((m) => m.mid), [1]);
  assert.deepStrictEqual(s2.sent.filter((m) => m.type === "answer").map((m) => m.mid), [2]);
  conn.stop();
});
