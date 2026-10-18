"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Game, LEVELS } = require("./game");
const R = require("./registry");
const { payout } = require("./odds");

function mulberry(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (n) => Math.floor(f() * n);
}

function room(n = 3, opts = {}, settings = {}) {
  const g = new Game(mulberry(opts.seed || 1), { intro: () => 0, ...opts });
  g.setSettings({ mode: "scenic", ...settings });
  for (let i = 1; i <= n; i++) g.addPlayer("p" + i, "Игрок" + i);
  return g;
}
const sumStacks = (g) => Object.values(g.s.players).reduce((a, p) => a + p.stack, 0);

// прокрутить часы до заданной фазы
function advance(g, now, phase) {
  for (let i = 0; i < 20 && g.s.phase !== phase; i++) { const d = g.nextDeadline(); now = Math.max(now, d); g.tick(now); }
  return now;
}

test("лобби: нужно ≥ 2 игроков, дубли и лимит", () => {
  const g = new Game(mulberry(1), { intro: () => 0 });
  g.addPlayer("a", "А");
  assert.deepEqual(g.start(0), []);
  g.addPlayer("a", "А");
  assert.equal(g.s.order.length, 1);
  for (let i = 0; i < 20; i++) g.addPlayer("x" + i, "X" + i);
  assert.equal(g.s.order.length, 12);
  assert.equal(g.setSettings({ stack: 777 }), true);
  assert.equal(g.s.settings.stack, 1000, "недопустимое значение настройки игнорируется");
});

test("старт: расписание, стек, фаза ставок 20 с", () => {
  const g = room();
  g.start(1000);
  assert.equal(g.s.phase, "bets");
  assert.equal(g.s.deadline, 21000);
  assert.ok(Object.values(g.s.players).every((p) => p.stack === 1000));
  assert.equal(g.s.schedule.length, 12);
});

test("ставки: проверки купона", () => {
  const g = room();
  g.start(0);
  const m = g.cur.markets[0].id;
  assert.deepEqual(g.bet("p1", m, 5), [], "меньше 10");
  assert.deepEqual(g.bet("p1", m, 10.5), [], "нецелая");
  assert.deepEqual(g.bet("p1", "нет-такого", 50), []);
  assert.deepEqual(g.bet("p1", m, 5000), [], "больше стека");
  assert.equal(g.bet("p1", m, 600).length, 1);
  assert.deepEqual(g.bet("p1", g.cur.markets[1].id, 500), [], "сумма больше стека");
  assert.equal(g.bet("p1", m, 100).length, 1, "добавка к той же ставке");
  assert.equal(g.s.players.p1.draft[m], 700);
  for (let i = 1; i < 6; i++) g.bet("p2", g.cur.markets[i].id, 10);
  assert.equal(Object.keys(g.s.players.p2.draft).length, 5);
  g.bet("p2", g.cur.markets[6].id, 10);
  assert.deepEqual(g.bet("p2", g.cur.markets[7].id, 10), [], "не больше 6 рынков");
  g.unbet("p2", g.cur.markets[1].id);
  assert.equal(Object.keys(g.s.players.p2.draft).length, 5);
  g.submit("p1", 100);
  assert.deepEqual(g.bet("p1", m, 10), [], "после «Сдать» менять нельзя");
  assert.deepEqual(g.submit("p1", 100), [], "повторный submit идемпотентен");
});

test("досрочное закрытие, штраф за недобор, несданный купон пуст", () => {
  const g = room(3);
  g.start(0);
  const mk = g.cur.markets[0];
  const min = g.minStake(g.s.players.p1);
  assert.equal(min, 30, "3% от 1000");
  g.bet("p1", mk.id, 100); g.submit("p1", 1000);
  g.bet("p2", mk.id, 10); g.submit("p2", 2000);      // недобор: 10 < 30 → штраф 20
  g.bet("p3", mk.id, 500);                           // не сдал — купон пуст → штраф 30
  assert.equal(g.s.phase, "bets");
  g.tick(g.s.deadline);
  assert.equal(g.s.phase, "locked");
  assert.equal(g.s.players.p1.stack, 900);
  assert.equal(g.s.players.p2.stack, 1000 - 10 - 20);
  assert.equal(g.s.players.p3.stack, 970);
  assert.equal(g.s.players.p3.coupon.penalty, 30);
});

test("когда сдали все онлайн, окно закрывается сразу; офлайн не держит стол", () => {
  const g = room(3);
  g.start(0);
  const m = g.cur.markets[0].id;
  g.setOnline("p3", false);
  g.bet("p1", m, 50); g.submit("p1", 500);
  assert.equal(g.s.phase, "bets");
  g.bet("p2", m, 50); g.submit("p2", 700);
  assert.equal(g.s.phase, "locked");
  assert.equal(g.s.deadline, 700 + 2000);
});

test("выплаты по рынкам, округление вниз, баланс фишек сходится", () => {
  const g = room(2);
  g.start(0);
  // фиксируем исход костей: 6-6-6 (тройка), 'triple' выигрывает, 'big' нет
  g.cur = R.rebuild("dice", {});
  g.s.ev.type = "dice";
  g.s.schedule[0] = "dice";
  const total0 = sumStacks(g);
  const trip = g.cur.markets.find((m) => m.id === "triple"), big = g.cur.markets.find((m) => m.id === "big");
  g.cur.draw = () => [6, 6, 6]; // исход выбирается при запирании окна, подменяем до него
  g.bet("p1", "triple", 100); g.bet("p1", "big", 333); g.submit("p1", 100);
  g.bet("p2", "big", 100); g.submit("p2", 100);
  assert.equal(g.s.phase, "locked");
  assert.equal(g.s.ev.outcome.join(), "6,6,6");
  const staked = 100 + 333 + 100;
  let now = advance(g, 100, "payout");
  assert.equal(g.s.phase, "payout");
  const p1 = g.s.players.p1, p2 = g.s.players.p2;
  assert.equal(p1.last.won, payout(100, trip.kc));
  assert.equal(p1.stack, 1000 - 433 + payout(100, trip.kc));
  assert.equal(p2.stack, 900);
  assert.equal(p1.last.lines.find((l) => l.id === "big").result, "lose");
  // сумма стеков = старт − ставки − штрафы + выплаты
  const won = p1.last.won + p2.last.won, pen = p1.last.penalty + p2.last.penalty;
  assert.equal(sumStacks(g), total0 - staked - pen + won);
});

test("вылет при нуле, победа последнего выжившего", () => {
  const g = room(3, {}, { stack: 500 });
  g.start(0);
  const m = g.cur.markets.find((x) => x.kc > 150).id;
  for (const id of ["p1", "p2"]) { g.bet(id, m, 500); g.submit(id, 10); }
  g.bet("p3", g.cur.markets[0].id, 100); g.submit("p3", 10);
  g.s.ev.outcome = null;
  // принудительно: никто из p1/p2 не выигрывает
  const mk = g.getMarket(m);
  mk.test = () => false;
  advance(g, 10, "payout");
  assert.equal(g.s.players.p1.alive, false);
  assert.equal(g.s.players.p2.alive, false);
  assert.equal(g.s.players.p1.stack, 0);
  advance(g, g.s.deadline, "done");
  assert.equal(g.s.phase, "done");
  assert.equal(g.s.winner, "p3");
});

test("все вылетели в одном событии: побеждает тот, у кого было больше фишек", () => {
  const g = room(2, {}, { stack: 500 });
  g.start(0);
  const m = g.cur.markets[0].id;
  g.getMarket(m).test = () => false;
  g.bet("p1", m, 500); g.submit("p1", 0);
  g.bet("p2", m, 500); g.submit("p2", 0);
  g.s.players.p1.stackBefore = 500; g.s.players.p2.stackBefore = 500;
  advance(g, 0, "payout");
  advance(g, g.s.deadline, "done");
  assert.equal(g.s.phase, "done");
  assert.ok(["p1", "p2"].includes(g.s.winner));
});

test("лимит событий: победа по фишкам", () => {
  const g = room(2, { seed: 5 }, { events: 8 });
  g.start(0);
  let now = 0, guard = 0;
  while (g.s.phase !== "done" && guard++ < 500) {
    if (g.s.phase === "bets") for (const id of ["p1", "p2"]) { g.bet(id, g.cur.markets[0].id, 10); g.submit(id, now); }
    now = Math.max(now, g.nextDeadline()); g.tick(now);
  }
  assert.equal(g.s.phase, "done");
  assert.equal(g.s.idx, 7, "сыграно 8 событий");
  assert.ok(g.s.winner);
});

test("реальное событие: фолбэк на сценическое, если источник молчит", () => {
  const g = new Game(mulberry(3), { prepareLive: () => null, intro: () => 0 });
  g.setSettings({ mode: "real" });
  g.addPlayer("a", "А"); g.addPlayer("b", "Б");
  g.start(0);
  assert.ok(R.SCENIC.includes(g.s.ev.type), `фолбэк на ${g.s.ev.type}`);
  assert.ok(g.s.ev.fallback, "запоминаем, какое событие заменили");
});

test("реальное событие: исход приходит позже, ничья по порогу возвращается, таймаут — возврат ставок", () => {
  const prep = () => ({ input: { sigma: 40 }, meta: {} });
  const g = new Game(mulberry(4), { prepareLive: prep, intro: () => 0 });
  g.setSettings({ mode: "real" });
  g.addPlayer("a", "А"); g.addPlayer("b", "Б");
  g.start(0);
  g.s.ev.type = "btc"; g.cur = R.rebuild("btc", { sigma: 40 }); g.s.ev.input = { sigma: 40 }; g.s.ev.live = true;
  g.s.schedule[0] = "btc";
  g.bet("a", "up:1", 100); g.bet("a", "up:0", 100); g.submit("a", 5);
  g.bet("b", "down:1", 100); g.submit("b", 5);
  assert.equal(g.s.phase, "locked");
  assert.equal(g.s.ev.hasOutcome, false);
  let now = advance(g, 5, "scene");
  assert.equal(g.s.phase, "scene");
  assert.deepEqual(g.tick(now + 100), [], "до прихода исхода сцена ждёт");
  g.resolveLive(0, now + 5000, ["up:0", "down:0"]); // цена не сдвинулась: ничья
  advance(g, now + 5000, "payout");
  const a = g.s.players.a;
  assert.equal(a.last.lines.find((l) => l.id === "up:0").result, "void");
  assert.equal(a.last.lines.find((l) => l.id === "up:1").result, "lose");
  assert.equal(a.stack, 1000 - 100 + 0); // 100 вернулось, 100 проиграно
  // таймаут без исхода: всем возврат
  const g2 = new Game(mulberry(4), { prepareLive: prep, intro: () => 0 });
  g2.setSettings({ mode: "real" });
  g2.addPlayer("a", "А"); g2.addPlayer("b", "Б");
  g2.start(0);
  const mid = g2.cur.markets[0].id;
  g2.bet("a", mid, 100); g2.submit("a", 5); g2.bet("b", mid, 100); g2.submit("b", 5);
  advance(g2, 5, "payout");
  assert.equal(g2.s.ev.voidAll, true);
  assert.equal(g2.s.players.a.stack, 1000);
  assert.equal(g2.s.players.b.stack, 1000);
});

test("ракета: индивидуальная цель, выигрыш равен цели", () => {
  const g = room(2);
  g.start(0);
  g.s.ev.type = "rocket"; g.s.schedule[0] = "rocket"; g.cur = R.rebuild("rocket", {}); g.s.ev.input = {};
  assert.equal(g.bet("p1", "target:2.37", 100).length, 1);
  assert.deepEqual(g.bet("p1", "target:1.01", 100), [], "k < 1,05 не предлагаем");
  assert.deepEqual(g.bet("p1", "target:abc", 100), []);
  g.bet("p2", "target:5", 100);
  g.submit("p1", 0); g.submit("p2", 0);
  g.s.ev.outcome = 3.1; // долетела до 3,10
  advance(g, 0, "payout");
  assert.equal(g.s.players.p1.last.won, 237);
  assert.equal(g.s.players.p2.last.won, 0);
});

test("дамп и восстановление посреди сцены сохраняют коэффициенты и исход", () => {
  const rnd = mulberry(9);
  const g = room(3, { seed: 9 });
  g.start(0);
  for (const id of ["p1", "p2", "p3"]) { g.bet(id, g.cur.markets[0].id, 100); g.submit(id, 10); }
  advance(g, 10, "scene");
  const dumped = JSON.parse(JSON.stringify(g.dump()));
  const g2 = Game.restore(dumped, rnd);
  assert.deepEqual(g2.cur.markets.map((m) => [m.id, m.kc]), g.cur.markets.map((m) => [m.id, m.kc]));
  advance(g, 10, "payout");
  advance(g2, 10, "payout");
  assert.deepEqual(Object.values(g.s.players).map((p) => p.stack), Object.values(g2.s.players).map((p) => p.stack));
});

test("скрытность: чужие черновики и исход до развязки", () => {
  const g = room(2);
  g.start(0);
  const m = g.cur.markets[0].id;
  g.bet("p1", m, 100);
  const forP2 = g.snapshot(0, "p2");
  assert.equal(forP2.players.find((p) => p.id === "p1").draft, undefined);
  assert.equal(forP2.players.find((p) => p.id === "p1").coupon, null);
  assert.equal(g.snapshot(0, "p1").players.find((p) => p.id === "p1").draft[m], 100);
  g.submit("p1", 5); g.submit("p2", 5);
  advance(g, 5, "scene");
  assert.equal(g.snapshot(0, "p1").ev.outcome, undefined, "телефон не видит исход до развязки");
  assert.notEqual(g.snapshot(0).ev.outcome, undefined, "доска видит исход и строит сцену");
  // после запирания купоны открыты всем
  assert.ok(g.snapshot(0, "p2").players.find((p) => p.id === "p1").coupon.bets.length === 1);
});

test("расписание: пары реальное/сценическое, нет подряд одинаковых, не больше двух", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = mulberry(seed);
    for (const n of [8, 12, 16]) {
      const sch = R.makeSchedule(n, rnd);
      assert.equal(sch.length, n);
      for (let i = 1; i < n; i++) assert.notEqual(sch[i], sch[i - 1]);
      const cnt = {};
      sch.forEach((t) => (cnt[t] = (cnt[t] || 0) + 1));
      assert.ok(Object.values(cnt).every((c) => c <= 2), JSON.stringify(cnt));
      const realN = sch.filter((t) => R.REAL.includes(t)).length;
      assert.equal(realN, n / 2, `${n}: реальных ${realN}`);
      for (let i = 0; i < n; i += 2) assert.notEqual(R.REAL.includes(sch[i]), R.REAL.includes(sch[i + 1]), "в паре один реальный, один сценический");
    }
  }
});

test("минимальная ставка растёт по шкале и не превышает стек", () => {
  const g = room(2);
  g.start(0);
  const p = g.s.players.p1;
  assert.equal(g.minStake(p), 30);
  g.s.idx = 10;
  assert.equal(g.minStake(p), 250);
  p.stack = 100;
  assert.equal(g.minStake(p), 100, "ва-банк: минимум = весь остаток");
  assert.equal(LEVELS[LEVELS.length - 1], 25);
});

test("знакомство перед ставками: клиенты видят окно ставок с флагом intro, ставки закрыты до его конца", () => {
  const g = new Game(mulberry(21), { intro: (first) => (first ? 12000 : 6000) });
  g.setSettings({ mode: "scenic" });
  g.addPlayer("a", "А"); g.addPlayer("b", "Б");
  g.start(1000);
  assert.equal(g.s.phase, "intro");
  const snap = g.snapshot(1000, "a");
  assert.equal(snap.phase, "bets", "для клиента это окно ставок");
  assert.equal(snap.intro, true);
  assert.equal(snap.introMs, 12000, "первый показ типа события — длиннее");
  assert.equal(snap.deadline, 13000);
  assert.deepEqual(g.bet("a", g.cur.markets[0].id, 50), [], "ставка во время знакомства не принимается");
  assert.deepEqual(g.submit("a", 1500), []);
  assert.deepEqual(g.tick(5000), []);
  const ev = g.tick(13000);
  assert.equal(ev[0].type, "bets_open");
  assert.equal(g.s.phase, "bets");
  assert.equal(g.s.deadline, 13000 + g.s.settings.betMs, "окно ставок отсчитывается после знакомства");
  const snap2 = g.snapshot(13000, "a");
  assert.equal(snap2.intro, undefined);
  assert.equal(g.bet("a", g.cur.markets[0].id, 50).length, 1);
  // тот же тип события повторно — короче
  g.bet("b", g.cur.markets[0].id, 50); g.submit("a", 13100); g.submit("b", 13100);
  let now = 13100;
  for (let i = 0; i < 30 && g.s.phase !== "intro"; i++) { now = Math.max(now, g.nextDeadline()); g.tick(now); }
  assert.equal(g.s.phase, "intro");
});
