"use strict";

/* Юнит-тесты движка: node --test test-game.js */

const test = require("node:test");
const assert = require("node:assert/strict");
const { Game } = require("./game");

const cards = Array.from({ length: 60 }, (_, i) => ({ name: `Лот ${i}`, emoji: "🎲", meta: ["a", "b"], description: "d", fact: "f", wiki_en: "x" }));
const rng = () => 0.5;

function setup(n = 3, settings = {}) {
  const g = Game.create({ kind: "test", cards, settings, rng });
  for (let i = 0; i < n; i++) g.addPlayer({ id: `p${i}`, name: `P${i}` });
  g.start(0);
  return g;
}

test("старт: раунды = ceil(n*slots*1.25), первая фаза lot, deadline = T1", () => {
  const g = setup(3);
  assert.equal(g.s.rounds, Math.ceil(3 * 5 * 1.25));
  assert.equal(g.s.phase, "lot");
  assert.equal(g.s.deadline, 20000);
});

test("ставка: первая $1, ниже цены отклоняется, лидер не перебивает себя, expectedPrice", () => {
  const g = setup(3);
  assert.equal(g.bid("p0", 0, 100).ok, false);
  assert.equal(g.bid("p0", 1, 100).ok, true);
  assert.equal(g.s.phase, "bidding");
  assert.equal(g.bid("p0", 2, 200).reason, "already_leader");
  assert.equal(g.bid("p1", 1, 200).reason, "too_low");
  assert.equal(g.bid("p1", 2, 200, 0).reason, "price_changed");
  assert.equal(g.bid("p1", 2, 200, 1).ok, true);
  assert.equal(g.bid("p2", 999, 300).reason, "not_enough_money");
});

test("таймер после ставки = max(остаток T1, T2); анти-снайп +3 с; кап 60 с", () => {
  const g = setup(2);
  g.bid("p0", 1, 1000); // остаток T1 = 19 с > T2 → deadline остаётся 20000
  assert.equal(g.s.deadline, 20000);
  g.bid("p1", 2, 18500); // остаток 1.5 с < 2 с → анти-снайп: now + T2 + 3 с
  assert.equal(g.s.deadline, 18500 + 5000 + 3000);
  // гонка до капа
  let t = 26000;
  for (let i = 0; i < 40; i++) { g.bid(i % 2 ? "p1" : "p0", g.s.price + 1, t); t = g.s.deadline - 500; }
  assert.ok(g.s.deadline <= 60000, "deadline не выше капа");
});

test("продажа списывает деньги и даёт лот; sold → следующий лот", () => {
  const g = setup(2);
  g.bid("p0", 3, 100);
  const ev = g.tick(g.s.deadline);
  assert.equal(ev[0].type, "sold");
  assert.equal(g.player("p0").money, 27);
  assert.equal(g.player("p0").lots.length, 1);
  assert.equal(g.s.phase, "sold");
  g.tick(g.s.deadline);
  assert.equal(g.s.phase, "lot");
  assert.equal(g.s.round, 1);
});

test("без ставок и без игроков с $0 → unsold → следующий лот; T1 = 3 с когда торговаться некому", () => {
  const g = setup(2);
  assert.equal(g.tick(20000)[0].type, "unsold");
  g.tick(g.s.deadline);
  assert.equal(g.s.round, 1);
  // все на мели → T1 3 с
  for (const p of g.s.players) p.money = 0;
  g.tick(g.s.deadline); // unsold (нет ставок) → pickup, т.к. есть игроки с $0
  assert.equal(g.s.phase, "pickup");
});

test("РАЗБОР: игрок с $0 забирает бесплатно, остальные не могут", () => {
  const g = setup(3);
  g.player("p2").money = 0;
  g.tick(20000);
  assert.equal(g.s.phase, "pickup");
  assert.equal(g.take("p0", 20001).reason, "cannot_take");
  assert.equal(g.take("p2", 20001).ok, true);
  assert.equal(g.player("p2").lots.length, 1);
  assert.equal(g.player("p2").lots[0].price, 0);
});

test("лидер вышел из игры: ставка снимается, лот продолжается с предыдущей чужой", () => {
  const g = setup(3);
  g.bid("p0", 1, 100);
  g.bid("p1", 2, 200);
  g.removePlayer("p1");
  assert.equal(g.s.leaderId, "p0");
  assert.equal(g.s.price, 1);
  assert.equal(g.tick(g.s.deadline)[0].type, "sold");
  assert.equal(g.player("p0").lots.length, 1);
});

test("активных меньше двух → игра завершается", () => {
  const g = setup(2);
  const ev = g.removePlayer("p1");
  assert.ok(ev.some((e) => e.type === "finished"));
  assert.equal(g.s.finishedReason, "not_enough_players");
});

test("пауза замораживает deadline и отклоняет ставки", () => {
  const g = setup(2);
  g.pause(3000);
  assert.equal(g.bid("p0", 1, 3500).reason, "paused");
  assert.deepEqual(g.tick(50000), []);
  g.resume(50000);
  assert.equal(g.s.deadline, 50000 + (20000 - 3000));
});

test("offline-игрок не торгуется и не блокирует финал", () => {
  const g = setup(2, { slots: 3 });
  g.setOnline("p1", false);
  assert.equal(g.bid("p1", 1, 100).reason, "cannot_bid");
  for (let i = 0; i < 3; i++) { g.bid("p0", 1, g.s.lotStartedAt + 100); g.tick(g.s.deadline); g.tick(g.s.deadline); }
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.finishedReason, "all_full");
});

test("раунды кончились → финал даже с пустыми слотами", () => {
  const g = setup(2, { slots: 3 });
  for (let i = 0; i < g.s.rounds; i++) { g.tick(g.s.deadline); if (g.s.phase !== "finished") g.tick(g.s.deadline); }
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.finishedReason, "rounds_over");
});

test("голосование: за себя нельзя, без лотов нельзя, ничья решается по потраченному", () => {
  const g = setup(3);
  g.bid("p0", 5, 100); g.tick(g.s.deadline); g.tick(g.s.deadline);
  g.bid("p1", 2, g.s.lotStartedAt + 100); g.tick(g.s.deadline); g.tick(g.s.deadline);
  g.finish("host_ended");
  assert.equal(g.vote("p0", "p0").reason, "bad_vote");
  assert.equal(g.vote("p2", "p0").reason, "no_lots");
  assert.equal(g.vote("p0", "p1").ok, true);
  assert.equal(g.vote("p1", "p0").ok, true);
  g.closeVotes(rng);
  assert.equal(g.s.results.mode, "vote");
  assert.equal(g.s.results.ranking[0].playerId, "p1", "при 1:1 выше тот, кто потратил меньше");
});

test("имена уникальны, деньги = бюджет из настроек, clamp настроек", () => {
  const g = Game.create({ kind: "test", cards, settings: { budget: 9999, slots: 1 }, rng });
  assert.equal(g.s.settings.budget, 200);
  assert.equal(g.s.settings.slots, 3);
  g.addPlayer({ id: "a", name: "Макс" });
  g.addPlayer({ id: "b", name: "Макс" });
  assert.equal(g.player("b").name, "Макс 2");
  assert.equal(g.player("a").money, 200);
});

test("снимок не отдаёт колоду и содержит только текущий лот", () => {
  const g = setup(2);
  const snap = g.snapshot(0);
  assert.equal(snap.deck, undefined);
  assert.equal(snap.lot.name, g.s.deck[0].name);
  assert.ok(snap.players.every((p) => "canBid" in p));
});

test("хост пропускает лот: без ставок — следующий, с торгами — продажа лидеру", () => {
  const g = setup(3);
  g.hostSkip(500);
  assert.ok(["unsold", "pickup"].includes(g.s.phase));
  g.tick(g.s.deadline);
  if (g.s.phase !== "lot") g.tick(g.s.deadline);
  assert.equal(g.s.round, 1);
  g.bid("p0", 4, g.s.lotStartedAt + 100);
  const ev = g.hostSkip(g.s.lotStartedAt + 200);
  assert.equal(ev[0].type, "sold");
  assert.equal(g.player("p0").lots.length, 1);
});
