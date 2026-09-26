"use strict";

// Тесты движка рулетки: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const { Game, BETS, WHEEL, RED, LEVELS, T } = require("./game");

// Детерминированная случайность: очередь заданных значений, дальше — простой LCG
function rig(queue = [], seed = 1) {
  let x = seed;
  const f = (n) => {
    if (f.queue.length) return f.queue.shift() % n;
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % n;
  };
  f.queue = queue.slice();
  return f;
}

// Партия с игроками, уже в фазе ставок. Карт по умолчанию нет — они мешают считать деньги.
function game(names = ["A", "B"], settings = {}, rnd = rig()) {
  const g = Game.create({ settings: { cards: false, ...settings }, rnd });
  names.forEach((n) => g.addPlayer({ id: n, name: n }));
  const r = g.start(0);
  assert.ok(r.ok, r.reason);
  return g;
}

// Прогнать спин до выплат, выбросив заданное число
function spin(g, number, now = 100000) {
  g.rnd.queue.unshift(number);
  const ev = g.close(now);
  const s = g.s;
  ev.push(...g.tick(s.deadline)); // closing → spinning
  ev.push(...g.tick(s.deadline)); // spinning → payout (settle)
  return ev;
}

const total = (g) => g.s.players.reduce((a, p) => a + p.stack, 0);

test("таблица ставок: 157 позиций, выплаты по числу номеров", () => {
  const byType = {};
  for (const b of Object.values(BETS)) byType[b.type] = (byType[b.type] || 0) + 1;
  assert.deepStrictEqual(byType, { n: 37, sp: 60, st: 14, co: 23, sl: 11, dz: 3, col: 3, red: 1, black: 1, even: 1, odd: 1, low: 1, high: 1 });
  assert.strictEqual(BETS["n:17"].pays, 35);
  assert.strictEqual(BETS["sp:0-1"].pays, 17);
  assert.strictEqual(BETS["st:0-2-3"].pays, 11);
  assert.strictEqual(BETS["co:0-1-2-3"].pays, 8);
  assert.strictEqual(BETS["sl:31-32-33-34-35-36"].pays, 5);
  assert.deepStrictEqual(BETS["col:1"].numbers, [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
  assert.strictEqual(BETS.red.numbers.length, 18);
  assert.ok(!BETS.red.numbers.includes(0));
  assert.strictEqual(WHEEL.length, 37);
  assert.deepStrictEqual(WHEEL.slice().sort((a, b) => a - b), Array.from({ length: 37 }, (_, i) => i));
  assert.strictEqual(RED.size, 18);
  // мусорные наборы не проходят
  for (const k of ["sp:1-3", "co:1-2-3-4", "n:37", "sp:2-1", "st:1-2-4", "sl:1-2-3-4-5-7", "dz:4", "blue", "__proto__", "constructor"]) assert.ok(!Object.hasOwn(BETS, k), k);
});

test("выплаты: каждая ставка на каждом исходе платит ровно по таблице", () => {
  for (const b of Object.values(BETS)) {
    for (let n = 0; n <= 36; n++) {
      const g = game(["A", "B"]);
      assert.ok(g.bet("A", b.key, 10).ok);
      assert.ok(g.bet("B", "red", 10).ok);
      spin(g, n);
      const expect = b.numbers.includes(n) ? 1000 - 10 + 10 * (b.pays + 1) : 990;
      assert.strictEqual(g.player("A").stack, expect, `${b.key} на ${n}`);
    }
  }
});

test("зеро: равные шансы проигрывают целиком", () => {
  const g = game();
  g.bet("A", "red", 100);
  g.bet("B", "n:0", 10);
  spin(g, 0);
  assert.strictEqual(g.player("A").stack, 900);
  assert.strictEqual(g.player("B").stack, 1000 - 10 + 360);
});

test("ставка: не больше стека, валидация суммы и ключа", () => {
  const g = game();
  assert.strictEqual(g.bet("A", "n:5", 1001).reason, "no_money");
  assert.ok(g.bet("A", "n:5", 1000).ok, "весь стек на одно число можно — лимита стола нет");
  assert.strictEqual(g.bet("A", "red", 1).reason, "no_money");
  assert.strictEqual(g.bet("B", "nope", 1).reason, "bad_bet");
  assert.strictEqual(g.bet("B", "red", 0).reason, "bad_amount");
  assert.strictEqual(g.bet("B", "red", -5).reason, "bad_amount");
  assert.strictEqual(g.bet("B", "red", "abc").reason, "bad_amount");
  assert.strictEqual(g.setBets("B", { red: 600, black: 600 }).reason, "no_money");
  // из сети ключ приходит через JSON.parse — там __proto__ становится обычным ключом
  assert.strictEqual(g.setBets("B", JSON.parse('{"__proto__": 5}')).reason, "bad_bet");
  assert.strictEqual(g.setBets("B", JSON.parse('{"constructor": 5}')).reason, "bad_bet");
  assert.strictEqual(g.bet("B", "__proto__", 5).reason, "bad_bet");
  assert.ok(g.setBets("B", { red: 500, "n:3": 0 }).ok);
  assert.deepStrictEqual(g.player("B").bets, { red: 500 });
});

test("штраф: недобор минимума уходит казино, заморозка платит минимум целиком", () => {
  const g = game(["A", "B", "C"]);
  const min = g.minBet();
  assert.strictEqual(min, 10);
  g.bet("A", "red", 4); // недобор 6
  g.bet("B", "red", 10);
  // C не ставит вовсе
  spin(g, 2); // чёрное
  assert.strictEqual(g.player("A").stack, 1000 - 4 - 6);
  assert.strictEqual(g.player("B").stack, 990);
  assert.strictEqual(g.player("C").stack, 990);
});

test("ва-банк при стеке меньше минимума и выбывание по штрафу", () => {
  const g = game(["A", "B", "C"]);
  g.player("A").stack = 5;
  g.bet("B", "red", 10);
  g.bet("C", "red", 10);
  const ev = spin(g, 1);
  assert.strictEqual(g.player("A").stack, 0);
  assert.ok(g.player("A").out);
  assert.ok(ev.some((e) => e.type === "out" && e.playerId === "A"));
});

test("стеки меняются только в момент revealAt, телефон не видит число раньше", () => {
  const g = game();
  g.bet("A", "n:7", 100);
  g.rnd.queue.unshift(7);
  g.close(1000);
  const r = g.s.result;
  assert.strictEqual(g.player("A").stack, 1000);
  assert.strictEqual(g.snapshot(1000, "A").result.number, undefined);
  assert.strictEqual(g.snapshot(1000, "board").result.number, 7);
  g.tick(r.spinAt);
  assert.strictEqual(g.s.phase, "spinning");
  assert.strictEqual(g.snapshot(r.spinAt, "A").result.number, undefined);
  g.tick(r.revealAt - 1);
  assert.strictEqual(g.player("A").stack, 1000);
  g.tick(r.revealAt);
  assert.strictEqual(g.player("A").stack, 1000 + 3500);
  assert.strictEqual(g.snapshot(r.revealAt, "A").result.number, 7);
  assert.ok(r.revealAt - r.spinAt >= T.spinMin && r.revealAt - r.spinAt <= T.spinMax);
});

test("уровни: минимум растёт каждые 3 спина и держится на последнем", () => {
  const g = game(["A", "B"]);
  const seen = [];
  for (let i = 0; i < 40; i++) {
    for (const p of g.s.players) p.stack = 1e9;
    seen.push(g.minBet());
    g.bet("A", "red", g.minBet());
    g.bet("B", "black", g.minBet());
    spin(g, 5);
    g.tick(g.s.deadline);
  }
  assert.deepStrictEqual(seen.slice(0, 7), [10, 10, 10, 20, 20, 20, 30]);
  assert.strictEqual(seen[39], (1000 * LEVELS[LEVELS.length - 1]) / 100);
});

test("конец: остался один — победа; все обнулились разом — выше тот, у кого было больше", () => {
  let g = game(["A", "B", "C"]);
  g.player("B").stack = 10;
  g.player("C").stack = 10;
  g.bet("A", "red", 10);
  g.bet("B", "black", 10);
  g.bet("C", "black", 10);
  spin(g, 1);
  assert.strictEqual(g.s.winnerId, "A");
  g.tick(g.s.deadline);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.player("A").place, 1);

  g = game(["A", "B"]);
  g.player("A").stack = 30;
  g.player("B").stack = 50;
  g.bet("A", "red", 30);
  g.bet("B", "red", 50);
  spin(g, 0);
  assert.strictEqual(g.s.winnerId, "B");
  assert.strictEqual(g.s.finishedReason, "all_out");
});

test("готово у всех — ставки закрываются без таймера", () => {
  const g = game();
  g.bet("A", "red", 10);
  assert.strictEqual(g.setReady("A", true, 50).events.length, 0);
  const r = g.setReady("B", true, 60);
  assert.ok(r.events.some((e) => e.type === "closed"));
  assert.strictEqual(g.s.phase, "closing");
});

test("пауза в ставках замораживает таймер, во время вращения — встаёт на следующих ставках", () => {
  const g = game();
  const dl = g.s.deadline;
  g.pause(5000);
  assert.deepStrictEqual(g.tick(dl + 100000), []);
  g.resume(10000);
  assert.strictEqual(g.s.deadline, 10000 + (dl - 5000));
  g.close(20000);
  g.pause(20001);
  g.tick(g.s.deadline);
  g.tick(g.s.deadline);
  g.tick(g.s.deadline);
  assert.strictEqual(g.s.phase, "betting");
  assert.ok(g.s.paused);
});

// ---------- карты ----------

function withCards(names = ["A", "B", "C"]) {
  const g = Game.create({ settings: { cards: true }, rnd: rig() });
  names.forEach((n) => g.addPlayer({ id: n, name: n }));
  g.start(0);
  g.hostGo(0);
  for (const p of g.s.players) p.hand = [];
  return g;
}

test("знакомство с картами: старт ждёт «Готов» от всех на связи; ведущий может начать сам", () => {
  const g = Game.create({ settings: { cards: true }, rnd: rig() });
  for (const n of ["A", "B", "C"]) g.addPlayer({ id: n, name: n });
  const r = g.start(0);
  assert.ok(r.ok);
  assert.strictEqual(g.s.phase, "briefing");
  assert.ok(g.s.players.every((p) => p.hand.length === 1), "карты розданы до знакомства");
  assert.deepStrictEqual(g.tick(1e9), [], "таймера у знакомства нет");
  assert.strictEqual(g.bet("A", "red", 10).reason, "closed");
  g.setReady("A", true, 10);
  g.setReady("B", true, 20);
  assert.strictEqual(g.s.phase, "briefing");
  // C отвалился — ждать его не нужно
  const ev = g.setOnline("C", false, 30);
  assert.ok(ev.some((e) => e.type === "betting"));
  assert.strictEqual(g.s.phase, "betting");
  assert.strictEqual(g.s.spin, 1);
  assert.ok(g.s.players.every((p) => !p.ready), "«Готов» знакомства не переносится в ставки");

  const h = Game.create({ settings: { cards: true }, rnd: rig() });
  for (const n of ["A", "B"]) h.addPlayer({ id: n, name: n });
  h.start(0);
  h.hostGo(5);
  assert.strictEqual(h.s.phase, "betting");

  const off = Game.create({ settings: { cards: false }, rnd: rig() });
  for (const n of ["A", "B"]) off.addPlayer({ id: n, name: n });
  off.start(0);
  assert.strictEqual(off.s.phase, "betting", "без карт знакомства нет");
});

test("двойной риск: удваивает ставки цели из её стека", () => {
  const g = withCards();
  g.player("A").hand = ["double"];
  g.bet("B", "red", 300);
  g.bet("B", "n:1", 400);
  g.bet("C", "red", 10);
  g.bet("A", "red", 10);
  assert.ok(g.playCard("A", "double", "B").ok);
  spin(g, 2); // чёрное, всё мимо
  // 300 → 600, 400 → 400 + остаток 100
  assert.strictEqual(g.player("B").stack, 0);
  assert.ok(g.player("B").out);
});

test("заморозка: в следующем спине цель не ставит и платит минимум", () => {
  const g = withCards();
  g.player("A").hand = ["freeze"];
  for (const id of ["A", "B", "C"]) g.bet(id, "red", 10);
  g.playCard("A", "freeze", "B");
  spin(g, 1);
  g.tick(g.s.deadline);
  assert.ok(g.player("B").frozen);
  assert.strictEqual(g.bet("B", "red", 10).reason, "frozen");
  g.bet("A", "red", 10);
  g.bet("C", "red", 10);
  const before = g.player("B").stack;
  spin(g, 1);
  assert.strictEqual(g.player("B").stack, before - 10);
});

test("доля: 25% чистого выигрыша цели; сглаз: казино платит 50% проигрыша цели", () => {
  let g = withCards();
  g.player("A").hand = ["share"];
  g.bet("A", "black", 10);
  g.bet("B", "n:1", 100);
  g.bet("C", "black", 10);
  g.playCard("A", "share", "B");
  spin(g, 1);
  assert.strictEqual(g.player("B").stack, 1000 + 3500 - 875);
  assert.strictEqual(g.player("A").stack, 990 + 875);

  g = withCards();
  g.player("A").hand = ["eye"];
  g.bet("A", "red", 10);
  g.bet("B", "red", 200);
  g.bet("C", "red", 10);
  g.playCard("A", "eye", "B");
  spin(g, 2);
  assert.strictEqual(g.player("B").stack, 800, "у цели сглаз ничего не отнимает");
  assert.strictEqual(g.player("A").stack, 990 + 100);
});

test("щит гасит первую карту; вторая карта в ту же цель возвращается владельцу", () => {
  const g = withCards(["A", "B", "C", "D"]);
  g.player("B").hand = ["shield"];
  g.player("A").hand = ["double"];
  g.player("C").hand = ["freeze"];
  g.player("D").hand = ["eye"];
  for (const id of ["A", "B", "C", "D"]) g.bet(id, "red", 10);
  g.playCard("A", "double", "B");
  g.playCard("C", "freeze", "B");
  g.playCard("D", "eye", "A");
  g.close(1000);
  const out = g.s.result.reveals.map((r) => `${r.by}:${r.outcome}`);
  assert.deepStrictEqual(out, ["A:shielded", "C:busy", "D:ok"]);
  assert.deepStrictEqual(g.player("B").hand, []);
  assert.deepStrictEqual(g.player("C").hand, ["freeze"]);
  assert.strictEqual(g.player("B").bets.red, 10, "щит не дал удвоить");
});

test("карты: одна за спин, не в себя, щит не играется, до открытия чужие не видят", () => {
  const g = withCards();
  g.player("A").hand = ["double", "freeze", "shield"];
  assert.strictEqual(g.playCard("A", "double", "A").reason, "bad_target");
  assert.strictEqual(g.playCard("A", "shield", "B").reason, "passive");
  assert.ok(g.playCard("A", "double", "B").ok);
  assert.strictEqual(g.playCard("A", "freeze", "C").reason, "one_per_spin");
  const snapB = g.snapshot(10, "B");
  assert.deepStrictEqual(snapB.played, [{ by: "A" }]);
  assert.strictEqual(snapB.players.find((p) => p.id === "A").cards, 2);
  assert.strictEqual(snapB.me.hand.length, 0);
});

test("раздача: по карте на уровень, в руке не больше трёх, колода перетасовывается", () => {
  const g = Game.create({ settings: { cards: true, pace: "fast" }, rnd: rig() });
  for (const n of "ABCDEFGHIJKL") g.addPlayer({ id: n, name: n });
  g.start(0);
  g.hostGo(0);
  for (let i = 0; i < 12; i++) {
    for (const p of g.alive()) { p.stack = 1e9; g.bet(p.id, "red", g.minBet()); }
    spin(g, 1);
    g.tick(g.s.deadline);
    for (const p of g.alive()) assert.ok(p.hand.length <= 3);
  }
  const counts = {};
  for (const p of g.s.players) for (const c of p.hand) counts[c] = (counts[c] || 0) + 1;
  for (const c of Object.keys(counts)) assert.ok(counts[c] <= 3, c);
});

// ---------- инвариант денег ----------

test("инвариант: фишки игроков = старт − выигрыш казино + выплаты казино, на 300 случайных спинах", () => {
  const rnd = rig([], 7);
  const g = Game.create({ settings: { cards: true }, rnd });
  for (const n of ["A", "B", "C", "D", "E", "F"]) g.addPlayer({ id: n, name: n });
  g.start(0);
  g.hostGo(0);
  const keys = Object.keys(BETS);
  let now = 0;
  for (let i = 0; i < 300 && g.s.phase !== "finished"; i++) {
    for (const p of g.alive()) {
      if (p.frozen) continue;
      const k = rnd(4);
      for (let j = 0; j < k; j++) g.bet(p.id, keys[rnd(keys.length)], 1 + rnd(Math.max(1, Math.floor(p.stack / 4))));
      if (p.hand.length && rnd(3) === 0) {
        const card = p.hand.find((c) => c !== "shield");
        const t = g.alive().filter((x) => x.id !== p.id);
        if (card && t.length) g.playCard(p.id, card, t[rnd(t.length)].id);
      }
    }
    now = g.s.deadline;
    while (g.s.phase !== "betting" && g.s.phase !== "finished") now = g.s.deadline || now;
    g.tick(now);
    while (g.s.phase !== "betting" && g.s.phase !== "finished") { now = g.s.deadline; g.tick(now); }
    const expect = 6000 - g.s.casino.won + g.s.casino.paid;
    assert.strictEqual(total(g), expect, `спин ${g.s.spin}`);
    for (const p of g.s.players) assert.ok(p.stack >= 0 && Number.isInteger(p.stack));
  }
});

test("режиссёр: ложная посадка при тяжёлом соседе, особые сюжеты не чаще раза в 3 спина", () => {
  const g = game(["A", "B"]);
  for (const p of g.s.players) p.stack = 100000;
  const idx = WHEEL.indexOf(17);
  const neighbor = WHEEL[idx + 1];
  g.bet("A", `n:${neighbor}`, 50);
  g.bet("B", "red", 10);
  spin(g, 17);
  assert.strictEqual(g.s.result.story.path, "fake");
  assert.strictEqual(g.s.result.story.fakeFrom, neighbor);
  g.tick(g.s.deadline);
  g.bet("A", `n:${neighbor}`, 50);
  g.bet("B", "red", 10);
  spin(g, 17);
  assert.strictEqual(g.s.result.story.path, "normal", "второй особый подряд нельзя");
});

test("ва-банк и джекпот помечаются в сюжете", () => {
  const g = game();
  g.bet("A", "n:9", 1000);
  g.bet("B", "red", 10);
  spin(g, 9);
  assert.deepStrictEqual(g.s.result.story.allin, ["A"]);
  assert.ok(g.s.result.story.jackpot);
  assert.ok(g.s.result.story.duration <= T.spinMax);
});

test("выход игрока посреди партии: последний оставшийся побеждает", () => {
  const g = game();
  g.removePlayer("B", 10);
  assert.strictEqual(g.s.winnerId, "A");
  assert.strictEqual(g.s.phase, "finished");
});

test("опоздавший — зритель: без ставок и мест, на «Ещё партию» садится за стол; эмодзи не режутся пополам", () => {
  const g = game(["A", "B"]);
  const r = g.addPlayer({ id: "L", name: "Late" });
  assert.ok(r.ok);
  const l = g.player("L");
  assert.ok(l.spectator && l.out && l.stack === 0);
  assert.strictEqual(g.bet("L", "red", 1).reason, "closed");
  assert.ok(g.chat("L", "привет", 0).ok);
  g.finishNow(10);
  assert.strictEqual(l.place, null);
  assert.deepStrictEqual(g.s.players.filter((p) => !p.spectator).map((p) => p.place).sort(), [1, 2]);
  g.reset();
  assert.ok(!g.player("L").spectator && !g.player("L").out && g.player("L").stack === 1000);
  const e = Game.create({});
  e.addPlayer({ id: "E", name: "a".repeat(15) + "😀x" });
  assert.strictEqual(e.player("E").name, "a".repeat(15) + "😀");
});

test("чат: длина, частота, заглушка, скрытие; реакции только из набора", () => {
  const g = game();
  assert.ok(g.chat("A", "  привет   всем ", 0).ok);
  assert.strictEqual(g.s.chat[0].text, "привет всем");
  assert.strictEqual(g.chat("A", "ещё", 1000).reason, "too_fast");
  assert.ok(g.chat("A", "x".repeat(200), 5000).ok);
  assert.strictEqual(g.s.chat[1].text.length, 80);
  g.mute("B", true);
  assert.strictEqual(g.chat("B", "эй", 0).reason, "muted");
  g.hideMessage(1);
  assert.strictEqual(g.snapshot(0, "board").chat.length, 1);
  assert.deepStrictEqual(g.snapshot(0, "A").chat, []);
  assert.ok(g.react("A", "🔥", 0).ok);
  assert.strictEqual(g.react("A", "🔥", 500).reason, "too_fast");
  assert.strictEqual(g.react("A", "<script>", 5000).reason, "bad");
});

test("ведущий заканчивает посреди вращения: ставки спина не играют, победитель по фишкам", () => {
  const g = game(["A", "B", "C"]);
  g.player("B").stack = 1500;
  g.bet("A", "n:5", 500);
  g.close(100);
  g.tick(g.s.deadline); // вращение
  g.finishNow(g.s.deadline + 10);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "host");
  assert.strictEqual(g.s.winnerId, "B");
  assert.strictEqual(g.player("A").stack, 1000, "ставка несыгранного спина не списана");
  assert.deepStrictEqual(g.s.players.map((p) => p.place), [2, 1, 3]);
  assert.strictEqual(g.snapshot(0, "A").result, null);
});

test("новая партия: те же игроки, стеки и карты с нуля", () => {
  const g = game();
  g.finishNow(10);
  assert.strictEqual(g.s.phase, "finished");
  g.reset();
  assert.strictEqual(g.s.phase, "lobby");
  assert.strictEqual(g.s.players.length, 2);
  assert.ok(g.start(20).ok);
  assert.strictEqual(g.player("A").stack, 1000);
});

test("дамп: состояние переживает JSON и продолжает партию", () => {
  const g = game();
  g.bet("A", "red", 10);
  g.close(100);
  const g2 = Game.from(JSON.parse(JSON.stringify(g.s)), rig());
  g2.tick(g2.s.deadline);
  g2.tick(g2.s.deadline);
  assert.strictEqual(g2.s.phase, "payout");
});
