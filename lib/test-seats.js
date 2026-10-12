"use strict";
// node --test lib/test-seats.js   (T-W1-02) — матрица «токен × имя × сокет × фаза» (К-1 пп.1-4, U-01)
const test = require("node:test");
const assert = require("node:assert/strict");
const seats = require("./seats");
const { classifyJoin, decideJoin } = seats;

const NOW = 1_000_000;

// комната: Маша(1) — офлайн с NOW-5000, Боря(2) — онлайн, Вика(3) — офлайн, закрылась только что (NOW-500)
function room(extra) {
  const players = [
    { id: 1, name: "Маша", token: "tok-m", score: 40 },
    { id: 2, name: "Боря", token: "tok-b", score: 10 },
    { id: 3, name: "Вика", token: "tok-v", score: 0 },
  ];
  const live = new Set([2]);
  const closed = { 1: NOW - 5000, 3: NOW - 500 };
  return Object.assign({
    players, now: NOW, phase: "lobby",
    hasLiveSocket: (id) => live.has(id),
    closedAt: (id) => (closed[id] === undefined ? null : closed[id]),
  }, extra || {});
}
const kind = (o) => classifyJoin(o).kind;

test("токен -> молча в любой фазе, даже без имени и в секретной фазе", () => {
  for (const phase of ["lobby", "play", "vote", "finished"]) {
    const c = classifyJoin(room({ token: "tok-m", name: "", phase, secretPhases: ["vote"] }));
    assert.equal(c.kind, "token");
    assert.equal(c.player.id, 1);
    assert.equal(c.silent, true);
  }
});

test("токен чужого/неизвестный -> как без токена (по имени)", () => {
  assert.equal(kind(room({ token: "nope", name: "Новый" })), "fresh");
  assert.equal(kind(room({ token: "nope", name: "Маша" })), "claimable");
});

test("токен лежит вне players: tokenOwner и массив tokens", () => {
  const ps = [{ id: 7, name: "Яна", tokens: ["a", "b"] }];
  assert.equal(classifyJoin({ players: ps, token: "b", name: "x" }).player.id, 7);
  const c = classifyJoin({ players: ps, token: "zzz", name: "q", tokenOwner: (t) => (t === "zzz" ? ps[0] : null) });
  assert.equal(c.kind, "token");
});

test("свободное имя -> fresh; регистр/пробел/ё не обманывают", () => {
  assert.equal(kind(room({ name: "Новенький" })), "fresh");
  assert.equal(kind(room({ name: " маша " })), "claimable");
  assert.equal(kind(room({ name: "БОРЯ" })), "taken_online");
});

test("офлайн ≥ 2 с в лобби -> claimable, не молча", () => {
  const c = classifyJoin(room({ name: "Маша" }));
  assert.equal(c.kind, "claimable");
  assert.equal(c.silent, false);
  assert.equal(c.player.id, 1);
});

test("офлайн < 2 с -> pending с retryInMs", () => {
  const c = classifyJoin(room({ name: "Вика" }));
  assert.equal(c.kind, "pending");
  assert.equal(c.retryInMs, 1500);
});

test("граница grace: ровно graceMs -> claimable", () => {
  assert.equal(kind(room({ name: "Вика", closedAt: () => NOW - 2000 })), "claimable");
  assert.equal(kind(room({ name: "Вика", closedAt: () => NOW - 1999 })), "pending");
});

test("живой сокет -> taken_online в любой фазе", () => {
  for (const phase of ["lobby", "play", "finished", "vote"]) {
    assert.equal(kind(room({ name: "Боря", phase, secretPhases: ["vote"] })), "taken_online");
  }
});

test("«завис» (сокет есть, pong пропущен) -> claimable, а не taken_online", () => {
  const c = classifyJoin(room({ name: "Боря", isStale: (id) => id === 2 }));
  assert.equal(c.kind, "claimable");
});

test("нет данных о закрытии (место из дампа после restore) -> claimable", () => {
  assert.equal(kind(room({ name: "Маша", closedAt: () => null })), "claimable");
});

test("фаза вне белого списка claimablePhases -> phase_blocked (reason phase)", () => {
  const c = classifyJoin(room({ name: "Маша", phase: "play" }));
  assert.equal(c.kind, "phase_blocked");
  assert.equal(c.reason, "phase");
});

test("по умолчанию белый список только lobby/finished; свой список расширяет", () => {
  assert.equal(kind(room({ name: "Маша", phase: "finished" })), "claimable");
  assert.equal(kind(room({ name: "Маша", phase: "reveal" })), "phase_blocked");
  assert.equal(kind(room({ name: "Маша", phase: "reveal", claimablePhases: ["lobby", "reveal"] })), "claimable");
});

test("secretPhases -> secret_blocked (приоритет над белым списком)", () => {
  const c = classifyJoin(room({ name: "Маша", phase: "vote", claimablePhases: ["vote"], secretPhases: ["vote"] }));
  assert.equal(c.kind, "secret_blocked");
});

test("strict + другой IP -> не claimable; strict + тот же IP -> claimable", () => {
  const a = classifyJoin(room({ name: "Маша", policy: "strict", sameIp: false }));
  assert.equal(a.kind, "phase_blocked");
  assert.equal(a.reason, "ip");
  assert.equal(kind(room({ name: "Маша", policy: "strict" })), "phase_blocked"); // sameIp не передан
  assert.equal(kind(room({ name: "Маша", policy: "strict", sameIp: true })), "claimable");
  assert.equal(kind(room({ name: "Маша", policy: "claim", sameIp: false })), "claimable");
});

test("floe/rapids в игре: grace 10 с + strict", () => {
  const o = { name: "Маша", phase: "play", claimablePhases: ["lobby", "play"], policy: "strict", sameIp: true, graceMs: 10000 };
  assert.equal(kind(room(Object.assign({ closedAt: () => NOW - 5000 }, o))), "pending");
  assert.equal(kind(room(Object.assign({ closedAt: () => NOW - 10000 }, o))), "claimable");
});

test("место left не подхватывается по имени (имя свободно), токен находит", () => {
  const r = room({ name: "Маша" });
  r.players[0].left = true;
  assert.equal(classifyJoin(r).kind, "fresh");
  assert.equal(classifyJoin(Object.assign({}, r, { token: "tok-m" })).kind, "token");
});

// ── decideJoin ───────────────────────────────────────────────────────────────────────────────────
test("decide: новый клиент, офлайн-место -> prompt name_claim; claim:true -> claim с отзывом токенов", () => {
  const p = decideJoin(room({ name: "Маша", caps: ["claim"] }));
  assert.equal(p.action, "prompt");
  assert.equal(p.error, "name_claim");
  assert.equal(p.name, "Маша");
  const c = decideJoin(room({ name: "Маша", caps: ["claim"], claim: true }));
  assert.equal(c.action, "claim");
  assert.equal(c.revokeTokens, true);
  assert.equal(c.replaceSocket, true);
  assert.equal(c.player.id, 1);
});

test("decide: старый клиент без caps -> молча как сегодня; legacyClaim:false -> «База (N)»", () => {
  const a = decideJoin(room({ name: "Маша" }));
  assert.equal(a.action, "claim");
  assert.equal(a.silent, true);
  const b = decideJoin(room({ name: "Маша", legacyClaim: false }));
  assert.equal(b.action, "create");
  assert.equal(b.name, "Маша (2)");
  assert.equal(b.renamed, true);
});

test("decide: старый клиент, pending -> без name_claim/retry (taken)", () => {
  const d = decideJoin(room({ name: "Вика" }));
  assert.equal(d.action, "taken");
  assert.equal(d.error, "name_taken");
  assert.equal(d.suggested, "Вика (2)");
});

test("decide: новый клиент, pending -> retry с name_claim", () => {
  const d = decideJoin(room({ name: "Вика", caps: ["claim"] }));
  assert.equal(d.action, "retry");
  assert.equal(d.retry, true);
  assert.equal(d.retryInMs, 1500);
});

test("decide: claim:true не обходит grace, фазу и IP", () => {
  assert.equal(decideJoin(room({ name: "Вика", caps: ["claim"], claim: true })).action, "retry");
  assert.equal(decideJoin(room({ name: "Маша", caps: ["claim"], claim: true, phase: "play" })).action, "taken");
  assert.equal(decideJoin(room({ name: "Маша", caps: ["claim"], claim: true, policy: "strict", sameIp: false })).action, "taken");
});

test("decide: fresh:true («Я другой») -> «Маша (2)»; три тёзки подряд нумеруются", () => {
  const r = room({ name: "Маша", caps: ["claim"], fresh: true });
  const d = decideJoin(r);
  assert.equal(d.action, "create");
  assert.equal(d.name, "Маша (2)");
  r.players.push({ id: 9, name: "Маша (2)", token: "x" });
  assert.equal(decideJoin(r).name, "Маша (3)");
  assert.equal(decideJoin(Object.assign({}, r, { name: "Маша (2)" })).name, "Маша (3)");
});

test("decide: тёзка онлайн -> taken online, suggested; секретная фаза -> retry:true", () => {
  const a = decideJoin(room({ name: "Боря", caps: ["claim"] }));
  assert.equal(a.action, "taken");
  assert.equal(a.online, true);
  assert.equal(a.retry, false);
  assert.equal(a.suggested, "Боря (2)");
  const b = decideJoin(room({ name: "Маша", caps: ["claim"], phase: "vote", secretPhases: ["vote"] }));
  assert.equal(b.action, "taken");
  assert.equal(b.retry, true);
  assert.equal(b.reason, "secret");
});

test("decide: токен -> resume (имя игнорируется); новое имя -> create; пустое -> deny; лимит имени", () => {
  assert.equal(decideJoin(room({ token: "tok-b", name: "Ктотам" })).action, "resume");
  const n = decideJoin(room({ name: "  Новый  ", max: 15 }));
  assert.equal(n.action, "create");
  assert.equal(n.name, "Новый");
  assert.equal(decideJoin(room({ name: " <> " })).action, "deny");
  assert.equal(decideJoin(room({ name: "Я".repeat(40), max: 15 })).name, "Я".repeat(15));
});

test("claimSummary: только перечисленные ключи, без секретов", () => {
  const p = { id: 1, name: "Маша", score: 40, token: "secret", target: "x" };
  assert.deepEqual(seats.claimSummary(p, ["score"]), { score: 40 });
  assert.deepEqual(seats.claimSummary(p, ["stack"]), {});
  assert.deepEqual(seats.claimSummary(null), {});
});

// ── pendingClaim ─────────────────────────────────────────────────────────────────────────────────
test("pendingClaim: свой TTL CLAIM_WAIT_MS вместо ANON_TTL_MS; не вытесняется и не считается анонимом", () => {
  const cfg = { anonTtlMs: 30000, claimWaitMs: 120000 };
  const plain = { ip: "1.1.1.1", createdAt: NOW - 31000 };
  const waiting = { ip: "1.1.1.1", createdAt: NOW - 31000 };
  const sockets = [plain, waiting];
  assert.deepEqual(seats.markPending(waiting, { sockets, now: NOW - 31000 + 100 }), { ok: true });
  assert.equal(seats.anonExpired(plain, NOW, cfg), true);
  assert.equal(seats.anonExpired(waiting, NOW, cfg), false);
  assert.equal(seats.anonExpired(waiting, NOW - 31000 + 100 + 120001, cfg), true);
  assert.deepEqual(seats.evictableAnon(sockets), [plain]);
  assert.equal(seats.anonCount(sockets, "1.1.1.1"), 1);
  assert.equal(seats.pendingCount(sockets, "1.1.1.1"), 1);
});

test("pendingClaim: потолки 6 на IP и 12 на комнату; повтор того же сокета не считается", () => {
  const sockets = [];
  for (let i = 0; i < 6; i++) {
    const s = { ip: "9.9.9.9", createdAt: NOW };
    sockets.push(s);
    assert.equal(seats.markPending(s, { sockets, now: NOW }).ok, true);
  }
  const seventh = { ip: "9.9.9.9", createdAt: NOW };
  sockets.push(seventh);
  assert.deepEqual(seats.markPending(seventh, { sockets, now: NOW }), { ok: false, reason: "pending_ip" });
  assert.equal(seats.markPending(sockets[0], { sockets, now: NOW + 5 }).already, true);
  assert.equal(sockets[0].pendingClaimAt, NOW); // TTL не продлевается повторами
  for (let i = 0; i < 6; i++) {
    const s = { ip: "8.8.8." + i, createdAt: NOW };
    sockets.push(s);
    assert.equal(seats.markPending(s, { sockets, now: NOW }).ok, true);
  }
  const x = { ip: "7.7.7.7", createdAt: NOW };
  sockets.push(x);
  assert.deepEqual(seats.markPending(x, { sockets, now: NOW }), { ok: false, reason: "pending_room" });
});

test("pendingClaim: вошедший сокет и ведущий не анонимы; clearPending возвращает 30 с", () => {
  const joined = { ip: "1.1.1.1", joined: true, createdAt: 0 };
  const host = { ip: "1.1.1.1", host: true, createdAt: 0 };
  assert.equal(seats.anonExpired(joined, NOW), false);
  assert.equal(seats.anonExpired(host, NOW), false);
  const s = { ip: "2.2.2.2", createdAt: NOW - 40000 };
  seats.markPending(s, { sockets: [s], now: NOW - 40000 });
  assert.equal(seats.anonExpired(s, NOW), false);
  seats.clearPending(s);
  assert.equal(seats.anonExpired(s, NOW), true);
});

test("константы по умолчанию", () => {
  assert.equal(seats.CLAIM_WAIT_MS, 120000);
  assert.equal(seats.ANON_TTL_MS, 30000);
  assert.equal(seats.MAX_PENDING_PER_IP, 6);
  assert.equal(seats.MAX_PENDING_PER_ROOM, 12);
  assert.deepEqual([...seats.DEFAULT_CLAIMABLE], ["lobby", "finished"]);
});
