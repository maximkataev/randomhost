"use strict";
// node --test lib/test-presence.js   (T-W1-03) — R1 в игре не удаляется; R2 лобби/итоги; вытеснение; offSince
const test = require("node:test");
const assert = require("node:assert/strict");
const pr = require("./presence");

const T0 = 5_000_000;
const TTL = pr.GHOST_TTL_MS;
const mk = (id, over) => Object.assign({ id, name: "P" + id, online: true }, over || {});

test("по умолчанию GHOST_TTL_MS = 120 000; env читается через ghostTtlMs(env)", () => {
  assert.equal(pr.GHOST_TTL_MS, 120000);
  assert.equal(pr.ghostTtlMs({ GHOST_TTL_MS: "5000" }), 5000);
  assert.equal(pr.ghostTtlMs({ GHOST_TTL_MS: "мусор" }), 120000);
  assert.equal(pr.ghostTtlMs({ GHOST_TTL_MS: "-1" }), 120000);
  assert.equal(pr.ghostTtlMs({}), 120000);
});

test("onlineIds: онлайн по умолчанию, без офлайн и left", () => {
  const ps = [mk(1), mk(2, { online: false }), { id: 3, name: "x" }, mk(4, { left: true })];
  assert.deepEqual(pr.onlineIds(ps), [1, 3]);
  assert.equal(pr.onlineCount(ps), 2);
  assert.deepEqual(pr.onlineIds(null), []);
});

test("setOnline: offSince ставится один раз, снимается при возврате", () => {
  const p = mk(1);
  pr.setOnline(p, false, 100);
  assert.equal(p.online, false);
  assert.equal(p.offSince, 100);
  pr.setOnline(p, false, 999); // повторный «офлайн» не сдвигает метку
  assert.equal(p.offSince, 100);
  pr.setOnline(p, true, 1000);
  assert.equal(p.online, true);
  assert.equal("offSince" in p, false);
  pr.setOnline(p, false, 2000);
  assert.equal(p.offSince, 2000);
});

test("R1: в игре ничего не удаляется и не вытесняется, сколько бы ни прошло", () => {
  const ps = [mk(1, { online: false, offSince: T0 - 10 * TTL })];
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "game" }), []);
  assert.equal(pr.evictOldestGhost(ps, { now: T0, stage: "game" }), null);
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "что-то-неизвестное" }), []);
});

test("R2: в лобби офлайн старше TTL удаляется, моложе — нет, онлайн — нет", () => {
  const ps = [
    mk(1, { online: false, offSince: T0 - TTL - 1 }),
    mk(2, { online: false, offSince: T0 - TTL + 1000 }),
    mk(3),
    mk(4, { online: false, offSince: T0 - TTL }),
  ];
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "lobby" }), [1, 4]);
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "lobby", ttlMs: 500 }), [1, 2, 4]);
});

test("R2: protect (id, Set, функция) — ведущий/текущий не удаляется", () => {
  const ps = [mk(1, { online: false, offSince: 0 }), mk(2, { online: false, offSince: 0 })];
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "lobby", protect: 1 }), [2]);
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "lobby", protect: new Set([1, 2]) }), []);
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "lobby", protect: (id) => id === 2 }), [1]);
});

test("в итогах удаляются только места без участия: played=0, без очков и наград", () => {
  const old = T0 - TTL * 2;
  const ps = [
    mk(1, { online: false, offSince: old, played: 0, score: 0 }),
    mk(2, { online: false, offSince: old, played: 3, score: 0 }),
    mk(3, { online: false, offSince: old, played: 0, score: 15 }),
    mk(4, { online: false, offSince: old, played: 0, awards: ["gold"] }),
    mk(5, { online: false, offSince: old }), // played нет, очков нет
    mk(6, { online: false, offSince: old, played: 0, stack: -40 }),
  ];
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "finished" }), [1, 5]);
  // в лобби защита по умолчанию выключена
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "lobby" }), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pr.ghostsToDrop({ players: ps, now: T0, stage: "lobby", protectEarned: true }), [1, 5]);
});

test("вытеснение: 13-й вход вытесняет самого давнего офлайн старше порога", () => {
  const ps = [];
  for (let i = 1; i <= 12; i++) ps.push(mk(i));
  ps[3] = mk(4, { online: false, offSince: T0 - TTL - 5000 });
  ps[7] = mk(8, { online: false, offSince: T0 - TTL - 90000 }); // самый давний
  ps[9] = mk(10, { online: false, offSince: T0 - TTL - 100 });
  assert.equal(pr.evictOldestGhost(ps, { now: T0, stage: "lobby" }), 8);
  assert.equal(pr.evictOldestGhost(ps, { now: T0, stage: "lobby", protect: 8 }), 4);
});

test("вытеснение: только офлайн СТАРШЕ порога — свежие призраки неприкосновенны", () => {
  const ps = [mk(1, { online: false, offSince: T0 - 5000 }), mk(2)];
  assert.equal(pr.evictOldestGhost(ps, { now: T0, stage: "lobby" }), null);
  assert.equal(pr.evictOldestGhost(ps, { now: T0, stage: "lobby", minAgeMs: 1000 }), 1);
});

test("вытеснение в итогах не трогает места с очками", () => {
  const ps = [
    mk(1, { online: false, offSince: 0, played: 2, score: 10 }),
    mk(2, { online: false, offSince: 1000, played: 0, score: 0 }),
  ];
  assert.equal(pr.evictOldestGhost(ps, { now: T0, stage: "finished" }), 2);
  assert.equal(pr.evictOldestGhost(ps, { now: T0, stage: "lobby" }), 1);
});

test("restore из дампа: offSince = момент restore, лобби не пустеет", () => {
  const dumped = [
    mk(1, { online: false, offSince: 1 }),              // «давно» по старой метке
    mk(2, { online: false }),                           // дамп прошлой версии: метки нет
    mk(3),
  ];
  // до onRestore метка отсутствует/древняя — без неё не удаляем, со старой — удалили бы
  assert.deepEqual(pr.ghostsToDrop({ players: dumped, now: T0, stage: "lobby" }), [1]);
  assert.equal(pr.onRestore(dumped, T0), 2);
  assert.equal(dumped[0].offSince, T0);
  assert.equal(dumped[1].offSince, T0);
  assert.deepEqual(pr.ghostsToDrop({ players: dumped, now: T0 + 1000, stage: "lobby" }), []);
  assert.deepEqual(pr.ghostsToDrop({ players: dumped, now: T0 + TTL, stage: "lobby" }), [1, 2]);
});

test("ensureOffSince: страховка для офлайн без метки", () => {
  const ps = [mk(1, { online: false }), mk(2, { online: false, offSince: 7 }), mk(3)];
  assert.equal(pr.ensureOffSince(ps, T0), 1);
  assert.equal(ps[0].offSince, T0);
  assert.equal(ps[1].offSince, 7);
});

test("pruneOfflineForNewGame: офлайн дольше грации -> left, токен остаётся, онлайн не трогаем", () => {
  const ps = [
    mk(1, { online: false, offSince: T0 - 20000, token: "t1" }),
    mk(2, { online: false, offSince: T0 - 3000, token: "t2" }),
    mk(3, { token: "t3" }),
    mk(4, { online: false, offSince: T0 - 20000, played: 5, score: 50, token: "t4" }),
  ];
  assert.deepEqual(pr.pruneOfflineForNewGame(ps, { now: T0 }), [1, 4]);
  assert.equal(ps[0].left, true);
  assert.equal(ps[0].token, "t1");
  assert.equal(ps[1].left, undefined);
  assert.equal(ps[2].left, undefined);
  assert.equal(ps[3].score, 50); // очки не стираются, только место помечено
  assert.deepEqual(pr.onlineIds(ps), [3]);
});

test("pruneOfflineForNewGame: свой graceMs; без метки — не выкидывает", () => {
  const ps = [mk(1, { online: false, offSince: T0 - 3000 }), mk(2, { online: false })];
  assert.deepEqual(pr.pruneOfflineForNewGame(ps, { now: T0, graceMs: 1000 }), [1]);
  assert.equal(ps[1].left, undefined);
});

test("seatsFree: left место свободно", () => {
  assert.equal(pr.seatsFree([mk(1), mk(2, { left: true })], 12), 11);
  assert.equal(pr.seatsFree([], 12), 12);
});

test("ghostAge: онлайн и без метки = 0", () => {
  assert.equal(pr.ghostAge(mk(1), T0), 0);
  assert.equal(pr.ghostAge(mk(1, { online: false }), T0), 0);
  assert.equal(pr.ghostAge(mk(1, { online: false, offSince: T0 - 42 }), T0), 42);
});
