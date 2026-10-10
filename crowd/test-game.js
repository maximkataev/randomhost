"use strict";

// Тесты движка «Как все»: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const { Game, T, revealOrder, POINTS } = require("./game");

// синтетический банк: 60 вопросов, часть lean b, один sensitive на каждые 15
function bank(n = 60) {
  return Array.from({ length: n }, (_, i) => ({
    id: "t-" + i, q: "Вопрос " + i + "?", a: "Да", b: "Нет", kind: i % 4 === 3 ? "ab" : "yn", tag: "x",
    lean: i % 2 ? "b" : "a", sensitive: i % 15 === 0,
  }));
}
function rndFrom(seed = 7) {
  let a = seed;
  return (n) => { a = (a * 1664525 + 1013904223) >>> 0; return a % n; };
}
function mk(n = 4, settings = {}, content) {
  const g = Game.create({ settings: { opinion: false, ...settings }, code: "T", rnd: rndFrom(), content: { ru: content || bank() } });
  const ids = [];
  for (let i = 0; i < n; i++) { const id = "p" + i; g.addPlayer({ id, name: "Игрок" + i, now: 0 }); ids.push(id); }
  return { g, ids, t: 0 };
}
// пройти раунд голосованием: votes — массив сторон по игрокам; opts.bank — ids с ва-банком; opts.confirm — всем «Готово»
function round(ctx, votes, opts = {}) {
  const { g, ids } = ctx;
  const bankIds = opts.bank || [];
  ids.forEach((id, i) => {
    if (votes[i] == null) return;
    g.vote(id, votes[i], ctx.t);
    if (bankIds.includes(id)) g.bankToggle(id, true, ctx.t);
    if (opts.confirm !== false) g.confirm(id, ctx.t);
  });
  // если не все подтвердили — ждём таймер
  if (g.s.phase === "vote") { ctx.t = g.s.phaseEnd; g.tick(ctx.t); }
  return finishRound(ctx);
}
// довести раунд до «scores» и сразу после — к следующему; возвращает результат закрытого раунда
function finishRound(ctx) {
  const { g } = ctx;
  if (g.s.phase === "opinion") { ctx.t = g.s.phaseEnd; g.tick(ctx.t); }
  const res = g.s.round.result;
  assert.strictEqual(g.s.phase, "reveal");
  ctx.t = g.s.phaseEnd; g.tick(ctx.t); // → scores
  ctx.t = g.s.phaseEnd; g.tick(ctx.t); // → следующий
  return res;
}
function skipIntro(ctx) {
  const { g } = ctx;
  if (g.s.phase === "intro") { ctx.t = g.s.phaseEnd; g.tick(ctx.t); }
}
const score = (g, id) => g.player(id).score;

test("старт: от 3 игроков, первая фаза — голос", () => {
  const two = mk(2);
  assert.strictEqual(two.g.start(0).reason, "few_players");
  const { g } = mk(3);
  assert.ok(g.start(0).ok);
  assert.strictEqual(g.s.phase, "vote");
  assert.strictEqual(g.s.round.kind, "normal");
});

test("большинство +100, меньшинство 0 (нечётное число голосов)", () => {
  const ctx = mk(5); ctx.g.start(0);
  const res = round(ctx, ["a", "a", "a", "b", "b"]);
  assert.strictEqual(res.side, "a");
  assert.deepStrictEqual(ctx.ids.map((id) => score(ctx.g, id)), [100, 100, 100, 0, 0]);
});

test("«Раскол»: поровну — всем +50, ва-банк возвращается", () => {
  const ctx = mk(4); ctx.g.start(0);
  const res = round(ctx, ["a", "a", "b", "b"], { bank: ["p0", "p2"] });
  assert.ok(res.tie);
  assert.deepStrictEqual(ctx.ids.map((id) => score(ctx.g, id)), [50, 50, 50, 50]);
  assert.strictEqual(ctx.g.player("p0").banks, 2);
  assert.ok(res.bankBack.p0 && res.bankBack.p2);
});

test("«Как один!»: ≥ 4 одинаковых голосов — +50, ва-банк возвращается; при 3 голосах — обычные +100", () => {
  const ctx = mk(4); ctx.g.start(0);
  const res = round(ctx, ["b", "b", "b", "b"], { bank: ["p1"] });
  assert.ok(res.unanimous);
  assert.deepStrictEqual(ctx.ids.map((id) => score(ctx.g, id)), [50, 50, 50, 50]);
  assert.strictEqual(ctx.g.player("p1").banks, 2);
  const three = mk(3); three.g.start(0);
  const r3 = round(three, ["a", "a", "a"]);
  assert.ok(!r3.unanimous);
  assert.deepStrictEqual(three.ids.map((id) => score(three.g, id)), [100, 100, 100]);
});

test("ва-банк: +200 в большинстве, −200 в меньшинстве, тратится один; лимит 2", () => {
  const ctx = mk(5); ctx.g.start(0);
  round(ctx, ["a", "a", "a", "b", "b"], { bank: ["p0", "p3"] });
  assert.strictEqual(score(ctx.g, "p0"), 200);
  assert.strictEqual(score(ctx.g, "p3"), -200);
  assert.strictEqual(ctx.g.player("p0").banks, 1);
  // второй ва-банк, потом третьего нет
  round(ctx, ["a", "a", "a", "b", "b"], { bank: ["p0"] });
  assert.strictEqual(ctx.g.player("p0").banks, 0);
  assert.ok(!ctx.g.bankToggle("p0", true, ctx.t).ok);
  assert.strictEqual(ctx.g.bankToggle("p0", true, ctx.t).reason, "no_banks");
});

test("ва-банк засчитывается только после «Готово»", () => {
  const ctx = mk(5); ctx.g.start(0);
  const { g } = ctx;
  ["a", "a", "a", "b", "b"].forEach((v, i) => g.vote("p" + i, v, 0));
  g.bankToggle("p0", true, 0); // выбрал ×2, но «Готово» не нажал
  ["p1", "p2", "p3", "p4"].forEach((id) => g.confirm(id, 0));
  g.tick(g.s.phaseEnd);
  finishRound(ctx);
  assert.strictEqual(score(g, "p0"), 100); // обычное большинство, без ×2
  assert.strictEqual(g.player("p0").banks, 2);
});

test("после «Готово» менять сторону и ва-банк нельзя", () => {
  const ctx = mk(3); ctx.g.start(0);
  const { g } = ctx;
  g.vote("p0", "a", 0);
  g.confirm("p0", 0);
  assert.strictEqual(g.vote("p0", "b", 0).reason, "confirmed");
  assert.strictEqual(g.bankToggle("p0", true, 0).reason, "confirmed");
  assert.strictEqual(g.confirm("p1", 0).reason, "pick_first");
});

test("выбранная, но не подтверждённая сторона засчитывается по таймеру; нет выбора — нет голоса", () => {
  const ctx = mk(4); ctx.g.start(0);
  const res = round(ctx, ["a", "a", "b", null], { confirm: false });
  assert.strictEqual(res.cast, 3);
  assert.strictEqual(res.side, "a");
  assert.strictEqual(score(ctx.g, "p3"), 0);
  assert.strictEqual(res.pts.p3, undefined);
});

test("меньше трёх голосов — раунд аннулируется, ва-банк возвращается, вопрос заменяется", () => {
  const ctx = mk(4); ctx.g.start(0);
  const n0 = ctx.g.s.n;
  const q0 = ctx.g.s.round.q.id;
  const res = round(ctx, ["a", "b", null, null], { bank: ["p0"] });
  assert.ok(res.void);
  assert.ok(res.bankBack.p0);
  assert.strictEqual(ctx.g.s.n, n0, "счётчик вопросов не растёт");
  assert.notStrictEqual(ctx.g.s.round.q.id, q0, "задан новый вопрос");
  assert.deepStrictEqual(ctx.ids.map((id) => score(ctx.g, id)), [0, 0, 0, 0]);
});

test("два аннулирования подряд — пауза; вернулись ≥ 3 — партия продолжается", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  round(ctx, ["a", null, null, null]);
  round(ctx, ["a", null, null, null]);
  assert.strictEqual(g.s.phase, "pause");
  ctx.t = g.s.phaseEnd; // таймер паузы: онлайн 4 → партия продолжается
  g.tick(ctx.t);
  assert.strictEqual(g.s.phase, "vote");
});

test("пауза: не вернулись — итоги «партия прервана»", () => {
  const ctx = mk(3); ctx.g.start(0);
  const { g } = ctx;
  round(ctx, ["a", null, null]);
  round(ctx, ["a", null, null]);
  assert.strictEqual(g.s.phase, "pause");
  g.setOnline("p0", false, ctx.t);
  assert.strictEqual(g.s.phase, "pause");
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "paused");
});

test("замен аннулированных вопросов не больше двух; дальше раунд считается сыгранным", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  round(ctx, ["a", null, null, null]); // замена 1
  round(ctx, ["a", null, null, null]); // замена 2 → пауза
  ctx.t = g.s.phaseEnd; g.tick(ctx.t);
  assert.strictEqual(g.s.voidsUsed, 2);
  const n = g.s.n;
  round(ctx, ["a", null, null, null]); // третье: уже не заменяется
  assert.strictEqual(g.s.n, n + 1);
});

test("финальный вопрос ×2, ва-банк в нём недоступен", () => {
  const ctx = mk(5, { short: true }); ctx.g.start(0);
  const { g } = ctx;
  for (let i = 0; i < 5; i++) round(ctx, ["a", "a", "a", "b", "b"]);
  skipIntro(ctx);
  assert.strictEqual(g.s.round.kind, "final");
  assert.strictEqual(g.bankToggle("p0", true, ctx.t).reason, "no_bank_here");
  const before = score(g, "p0");
  round(ctx, ["a", "a", "a", "b", "b"]);
  assert.strictEqual(score(g, "p0") - before, 200);
});

test("«Раскол» в финале — допвопрос ×2; второй «Раскол» остаётся +100 всем", () => {
  const ctx = mk(4, { short: true }); ctx.g.start(0);
  const { g } = ctx;
  for (let i = 0; i < 5; i++) round(ctx, ["a", "a", "a", "b"]);
  skipIntro(ctx);
  assert.strictEqual(g.s.round.kind, "final");
  round(ctx, ["a", "a", "b", "b"]); // тай в финале
  skipIntro(ctx);
  assert.strictEqual(g.s.round.kind, "extra");
  const before = ctx.ids.map((id) => score(g, id));
  round(ctx, ["a", "a", "b", "b"]);
  const after = ctx.ids.map((id) => score(g, id));
  assert.deepStrictEqual(after.map((x, i) => x - before[i]), [100, 100, 100, 100]);
});

test("равные очки на первом месте — решающий вопрос только между лидерами", () => {
  const ctx = mk(4, { short: true }); ctx.g.start(0);
  const { g } = ctx;
  // 5 раундов: p0,p1 всегда в большинстве вместе с p2 / p3 / оба поровну → к финалу счёт выровнен
  for (let i = 0; i < 5; i++) round(ctx, ["a", "a", "a", "b"]);
  skipIntro(ctx);
  // у p0,p1,p2 по 500; финал: p3 один против — финал не ломает ничью троих
  round(ctx, ["a", "a", "a", "b"]);
  skipIntro(ctx);
  assert.strictEqual(g.s.round.kind, "decider");
  assert.deepStrictEqual(g.s.round.only.slice().sort(), ["p0", "p1", "p2"]);
  const res = round(ctx, ["a", "a", "b", "b"]); // тай в решающем: лидерам +50, p3 очков не получает
  assert.ok(res.tie);
  assert.strictEqual(score(g, "p3"), 0);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(score(g, "p0"), 500 + 200 + 50);
});

test("«Одиночка»: ровно один против всех (≥ 4 голосов) — значок, очки по общим правилам", () => {
  const ctx = mk(5); ctx.g.start(0);
  const res = round(ctx, ["b", "a", "a", "a", "a"]);
  assert.strictEqual(res.wolf, "p0");
  assert.strictEqual(score(ctx.g, "p0"), 0);
  assert.strictEqual(ctx.g.player("p0").stats.wolf, 1);
});

test("вошедший посреди партии голосует со следующего вопроса; ва-банки пропорционально оставшимся", () => {
  const ctx = mk(3); ctx.g.start(0);
  const { g } = ctx;
  ctx.t = 5;
  g.addPlayer({ id: "late", name: "Поздний", now: ctx.t });
  assert.strictEqual(g.vote("late", "a", ctx.t).reason, "late");
  assert.ok(g.player("late").banks >= 1);
  round(ctx, ["a", "a", "a"]);
  assert.ok(g.vote("late", "a", ctx.t).ok);
});

test("голосование закрывается досрочно только при ≥ 3 подключённых", () => {
  const ctx = mk(3); ctx.g.start(0);
  const { g } = ctx;
  g.setOnline("p1", false, 0);
  g.setOnline("p2", false, 0);
  g.vote("p0", "a", 0);
  g.confirm("p0", 0);
  assert.strictEqual(g.s.phase, "vote", "один онлайн — досрочно не закрываем");
  g.setOnline("p1", true, 0);
  g.setOnline("p2", true, 0);
  g.vote("p1", "a", 0); g.confirm("p1", 0);
  g.vote("p2", "b", 0); g.confirm("p2", 0);
  assert.notStrictEqual(g.s.phase, "vote");
});

test("подтверждённый голос ушедшего со связи считается", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  g.vote("p0", "a", 0); g.confirm("p0", 0);
  g.setOnline("p0", false, 0);
  ["p1", "p2"].forEach((id) => { g.vote(id, "a", 0); g.confirm(id, 0); });
  g.vote("p3", "b", 0); g.confirm("p3", 0);
  assert.strictEqual(g.s.round.result.a, 3);
});

test("фаза «Мнение»: включается при ≥ 4 игроках; «Иллюзия» — стороны противоположны и обе ≥ 60 %", () => {
  const ctx = mk(5, { opinion: true }); ctx.g.start(0);
  const { g } = ctx;
  ["a", "a", "a", "a", "b"].forEach((v, i) => { g.vote("p" + i, v, 0); g.confirm("p" + i, 0); });
  assert.strictEqual(g.s.phase, "opinion");
  assert.strictEqual(g.s.players.find((p) => p.id === "p0").score, 0, "очки не начислены до раскрытия");
  ["b", "b", "b", "b", "a"].forEach((v, i) => g.opinion("p" + i, v, 0));
  assert.strictEqual(g.s.phase, "reveal");
  const res = g.s.round.result;
  assert.deepStrictEqual(res.illusion, { vote: "a", opinion: "b" });
  assert.deepStrictEqual(res.opinions, { a: 1, b: 4, skip: 0 });
});

test("«Иллюзия» не срабатывает на шуме (4:3 против 3:4) и при менее 4 мнений", () => {
  const ctx = mk(7, { opinion: true }); ctx.g.start(0);
  const { g } = ctx;
  ["a", "a", "a", "a", "b", "b", "b"].forEach((v, i) => { g.vote("p" + i, v, 0); g.confirm("p" + i, 0); });
  ["b", "b", "b", "a", "a", "a", "a"].forEach((v, i) => g.opinion("p" + i, v, 0));
  assert.strictEqual(g.s.round.result.illusion, null);
  const c2 = mk(4, { opinion: true }); c2.g.start(0);
  ["a", "a", "a", "a"].forEach((v, i) => { c2.g.vote("p" + i, v, 0); c2.g.confirm("p" + i, 0); });
  ["skip", "skip", "b", "b"].forEach((v, i) => c2.g.opinion("p" + i, v, 0));
  assert.strictEqual(c2.g.s.round.result.illusion, null);
});

test("при трёх игроках «Мнение» отключено, а выключенное в лобби — не спрашивается", () => {
  const ctx = mk(3, { opinion: true }); ctx.g.start(0);
  round(ctx, ["a", "a", "b"]);
  assert.strictEqual(ctx.g.s.round.q.id !== undefined, true);
  const c4 = mk(4, { opinion: false }); c4.g.start(0);
  const { g } = c4;
  ["a", "a", "a", "b"].forEach((v, i) => { g.vote("p" + i, v, 0); g.confirm("p" + i, 0); });
  assert.strictEqual(g.s.phase, "reveal");
});

test("мнение: второй ответ отбрасывается; сторона вне a/b/skip — отказ", () => {
  const ctx = mk(4, { opinion: true }); ctx.g.start(0);
  const { g } = ctx;
  ["a", "a", "a", "b"].forEach((v, i) => { g.vote("p" + i, v, 0); g.confirm("p" + i, 0); });
  assert.ok(g.opinion("p0", "a", 0).ok);
  assert.strictEqual(g.opinion("p0", "b", 0).reason, "answered");
  assert.strictEqual(g.opinion("p1", "zz", 0).reason, "bad_side");
});

test("тайны: голоса, ва-банк, мнения, порядок показа не уходят в снимки до раскрытия", () => {
  const ctx = mk(5, { opinion: true }); ctx.g.start(0);
  const { g } = ctx;
  ["a", "a", "a", "b", "b"].forEach((v, i) => g.vote("p" + i, v, 0));
  g.bankToggle("p0", true, 0);
  g.confirm("p0", 0); g.confirm("p3", 0);
  const hasSecret = (snap, who) => {
    const j = JSON.stringify(snap);
    return /"votes"|"seed"|"order"|"opinions"|"pts"/.test(j) ? who : null;
  };
  for (const view of ["board", "p1", "p2"]) {
    const snap = g.snapshot(1, view);
    assert.strictEqual(hasSecret(snap, view), null, "в голосовании " + view);
    assert.strictEqual(snap.me ? snap.me.vote === "a" || snap.me.vote === "b" || snap.me.vote === null : true, true);
    assert.ok(!JSON.stringify(snap).includes('"bank":true') || view === "p0", "чужой ва-банк виден: " + view);
  }
  assert.strictEqual(g.snapshot(1, "p0").me.bank, true);
  assert.strictEqual(g.snapshot(1, "p1").me.vote, "a"); // свой голос — виден
  assert.strictEqual(g.snapshot(1, "p3").me.vote, "b");
  // доска во время голосования: только «готов»
  assert.deepStrictEqual(g.snapshot(1, "board").round.ready.sort(), ["p0", "p3"]);
  // остальные закрывают
  ["p1", "p2", "p4"].forEach((id) => g.confirm(id, 1));
  assert.strictEqual(g.s.phase, "opinion");
  const snapOp = JSON.stringify(g.snapshot(2, "board"));
  assert.ok(!/"votes"|"order"|"seed"/.test(snapOp), "в мнении доска без голосов");
  assert.strictEqual(g.snapshot(2, "board").round.result, undefined);
  // очки до раскрытия не видны
  assert.ok(g.snapshot(2, "board").players.every((p) => p.score === 0));
});

test("revealOrder: итог не меняется, при k − m ∈ {1,2} решающий голос стоит последним", () => {
  for (let seed = 1; seed < 30; seed++) {
    for (const [k, m] of [[1, 1], [2, 1], [3, 2], [4, 2], [5, 2], [5, 0], [4, 1], [7, 3], [3, 3]]) {
      const maj = Array.from({ length: k }, (_, i) => "M" + i);
      const min = Array.from({ length: m }, (_, i) => "m" + i);
      const winner = k === m ? null : "a";
      const order = revealOrder(maj, min, winner, seed);
      assert.strictEqual(order.length, k + m);
      assert.deepStrictEqual(order.slice().sort(), maj.concat(min).sort());
      if (k - m === 1 || k - m === 2) {
        // лидер меняется до последних k − m голосов подряд: последние голоса — большинство
        const tail = order.slice(order.length - (k - m));
        assert.ok(tail.every((x) => x.startsWith("M")), `k=${k} m=${m} seed=${seed}: ${order}`);
        // и до этого момента большинство не вело
        let a = 0, b = 0;
        for (const x of order.slice(0, order.length - (k - m))) { if (x.startsWith("M")) a++; else b++; }
        assert.ok(a <= b + 1);
      }
      if (k === m) {
        let lead = 0, maxLead = 0;
        for (const x of order) { lead += x.startsWith("M") ? 1 : -1; maxLead = Math.max(maxLead, Math.abs(lead)); }
        assert.ok(maxLead <= 1);
      }
    }
  }
});

test("баланс партии: 40–50 % вопросов с lean b, не более одного sensitive", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = Game.create({ settings: { opinion: false }, code: "T", rnd: rndFrom(seed), content: { ru: bank(100) } });
    for (let i = 0; i < 3; i++) g.addPlayer({ id: "p" + i, name: "И" + i, now: 0 });
    g.start(0);
    const bs = g.s.leanB;
    for (let i = 0; i < 9; i++) {
      const ctx = { g, ids: ["p0", "p1", "p2"], t: g.s.phaseStart };
      round(ctx, ["a", "a", "a"]);
      skipIntro(ctx);
    }
    assert.ok(g.s.leanB >= 4 && g.s.leanB <= 5, `seed ${seed}: leanB=${g.s.leanB}`);
    assert.ok(g.s.sensUsed <= 1, `seed ${seed}: sensitive=${g.s.sensUsed}`);
    assert.ok(bs >= 0);
  }
});

test("вопросы не повторяются внутри партии", () => {
  const ctx = mk(3); ctx.g.start(0);
  const seen = new Set();
  for (let i = 0; i < 9; i++) {
    seen.add(ctx.g.s.round.q.id);
    round(ctx, ["a", "a", "a"]);
  }
  assert.strictEqual(seen.size, 9);
});

test("награды: делят двое — показываем, делят трое — нет", () => {
  const two = mk(4); two.g.start(0);
  for (let i = 0; i < 3; i++) round(two, ["a", "a", "a", "b"]);
  const aw2 = two.g.computeAwards();
  assert.strictEqual(aw2.crowd, null);
  assert.deepStrictEqual(aw2.crow.ids, ["p3"]);
  const one = mk(5); one.g.start(0);
  round(one, ["a", "a", "b", "b", "b"]);
  round(one, ["a", "a", "b", "b", "b"]);
  assert.deepStrictEqual(one.g.computeAwards().crowd, null, "трое по 2 попадания");
  round(one, ["a", "a", "a", "a", "b"]);
  const aw = one.g.computeAwards();
  assert.deepStrictEqual(aw.crowd.ids.sort(), ["p2", "p3"], "двое набрали по 3");
});

test("ушёл игрок: меньше 3 в партии — конец; иначе продолжаем", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  g.removePlayer("p3", 1);
  assert.notStrictEqual(g.s.phase, "finished");
  g.removePlayer("p2", 2);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "few");
});

test("серверное состояние переживает JSON-дамп", () => {
  const ctx = mk(4, { opinion: true }); ctx.g.start(0);
  const { g } = ctx;
  ["a", "a", "b", "b"].forEach((v, i) => g.vote("p" + i, v, 0));
  const copy = Game.from(JSON.parse(JSON.stringify(g.s)), rndFrom(), { ru: bank() });
  copy.tick(copy.s.phaseEnd);
  assert.strictEqual(copy.s.phase, "opinion");
  assert.ok(POINTS.win === 100);
});
