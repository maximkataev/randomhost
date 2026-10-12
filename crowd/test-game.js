"use strict";

// Тесты движка «Как все»: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const { Game, T, revealOrder, POINTS, MAX_PLAYERS, NAME_MAX, MAX_VOID_RUN, clampSettings, cleanName, nameKey } = require("./game");

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

// ---------- T-W2-37: RULE_U47_CROWD_DECIDER ----------
function toDecider(rule) {
  return withRule(rule, () => {
    const ctx = mk(4, { short: true }); ctx.g.start(0);
    for (let i = 0; i < 5; i++) round(ctx, ["a", "a", "a", "b"]);
    skipIntro(ctx);
    round(ctx, ["a", "a", "a", "b"]); // финал: p0,p1,p2 равны
    skipIntro(ctx);
    assert.strictEqual(ctx.g.s.round.kind, "decider");
    return ctx;
  });
}
function withRule(rule, fn) {
  const old = process.env.RULE_U47_CROWD_DECIDER;
  if (rule == null) delete process.env.RULE_U47_CROWD_DECIDER; else process.env.RULE_U47_CROWD_DECIDER = rule;
  try { return fn(); } finally { if (old === undefined) delete process.env.RULE_U47_CROWD_DECIDER; else process.env.RULE_U47_CROWD_DECIDER = old; }
}

test("U-47 now (по умолчанию): единодушие в решающем даёт +50 и партия кончается, как раньше", () => {
  const ctx = toDecider(null);
  const res = withRule(null, () => round(ctx, ["a", "a", "a", "a"]));
  assert.ok(res.unanimous);
  assert.strictEqual(score(ctx.g, "p0"), 700 + 50);
  assert.strictEqual(ctx.g.s.phase, "finished");
});

test("U-47 v1: единодушие и ничья в решающем — 0 очков, партия кончается, лидеры равны", () => {
  for (const votes of [["a", "a", "a", "a"], ["a", "a", "b", "b"]]) {
    const ctx = toDecider("v1");
    const res = withRule("v1", () => round(ctx, votes));
    assert.ok(res.unanimous || res.tie, "флаги раскрытия честные");
    assert.deepStrictEqual(["p0", "p1", "p2"].map((id) => score(ctx.g, id)), [700, 700, 700]);
    assert.strictEqual(ctx.g.s.phase, "finished");
    assert.strictEqual(ctx.g.s.finishedReason, "done");
  }
});

test("U-47 v1: решающий разделил лидеров — +100 большинству, партия окончена", () => {
  const ctx = toDecider("v1");
  withRule("v1", () => round(ctx, ["a", "b", "b", "b"])); // большинство b: p1, p2 +100, p0 — 0
  assert.deepStrictEqual(["p0", "p1", "p2"].map((id) => score(ctx.g, id)), [700, 800, 800]);
  assert.strictEqual(ctx.g.s.phase, "finished");
});

test("U-47 v2: лидеры равны после решающего — ещё один (не больше двух), потом finish done", () => {
  const ctx = toDecider("v2");
  withRule("v2", () => round(ctx, ["a", "a", "a", "a"]));
  assert.strictEqual(ctx.g.s.phase, "intro", "второй решающий");
  skipIntro(ctx);
  assert.strictEqual(ctx.g.s.round.kind, "decider");
  assert.strictEqual(ctx.g.deciderRuns(), 2);
  withRule("v2", () => round(ctx, ["a", "a", "a", "a"]));
  assert.strictEqual(ctx.g.s.phase, "finished");
  assert.strictEqual(ctx.g.s.finishedReason, "done");
  assert.deepStrictEqual(["p0", "p1", "p2"].map((id) => score(ctx.g, id)), [700, 700, 700]);
});

test("U-47 v2: второй решающий разделил лидеров — победитель один", () => {
  const ctx = toDecider("v2");
  withRule("v2", () => round(ctx, ["a", "a", "b", "b"]));
  skipIntro(ctx);
  withRule("v2", () => round(ctx, ["a", "b", "b", "b"]));
  assert.strictEqual(ctx.g.s.phase, "finished");
  assert.ok(score(ctx.g, "p1") === 800 && score(ctx.g, "p0") === 700);
});

test("deciderRuns: старый дамп с deciderDone: true считается одним решающим", () => {
  const ctx = mk(3); ctx.g.start(0);
  delete ctx.g.s.deciderRuns;
  ctx.g.s.deciderDone = true;
  assert.strictEqual(ctx.g.deciderRuns(), 1);
  ctx.g.s.deciderDone = false;
  assert.strictEqual(ctx.g.deciderRuns(), 0);
});

test("решающий и финальный вопросы не sensitive (3000 партий)", () => {
  let sens = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    const g = Game.create({ settings: { opinion: false, short: seed % 2 === 0 }, code: "T", rnd: rndFrom(seed), content: { ru: bank() } });
    for (const id of ["a", "b", "c"]) g.addPlayer({ id, name: "И" + id, now: 0 });
    g.start(0);
    g.s.n = g.total() - 1; // последний основной вопрос
    for (const kind of ["final", "decider", "extra"]) {
      const q = g.takeQuestion(kind);
      const src = bank().find((x) => x.id === q.id);
      if (src.sensitive && kind !== "extra") sens++;
    }
  }
  assert.strictEqual(sens, 0);
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

test("«Иллюзия» подряд (RULE_U48_ILLUSION): по умолчанию как раньше; с флагом — не два раунда подряд, счётчик ill считает условие", () => {
  const old = process.env.RULE_U48_ILLUSION;
  const play = (flag) => {
    if (flag) process.env.RULE_U48_ILLUSION = "1"; else delete process.env.RULE_U48_ILLUSION;
    const ctx = mk(5, { opinion: true }); ctx.g.start(0);
    const out = [];
    for (let k = 0; k < 3; k++) {
      ["a", "a", "a", "a", "b"].forEach((v, i) => { ctx.g.vote("p" + i, v, ctx.t); ctx.g.confirm("p" + i, ctx.t); });
      assert.strictEqual(ctx.g.s.phase, "opinion");
      ["b", "b", "b", "b", "a"].forEach((v, i) => ctx.g.opinion("p" + i, v, ctx.t));
      out.push(!!ctx.g.s.round.result.illusion);
      finishRoundSame(ctx);
    }
    return out;
  };
  const finishRoundSame = (ctx) => { ctx.t = ctx.g.s.phaseEnd; ctx.g.tick(ctx.t); ctx.t = ctx.g.s.phaseEnd; ctx.g.tick(ctx.t); };
  try {
    assert.deepStrictEqual(play(false), [true, true, true], "по умолчанию — на каждом раунде, где условие выполнено");
    assert.deepStrictEqual(play(true), [true, false, true], "с флагом — вторая подряд подавлена, третья снова показывается");
  } finally {
    if (old === undefined) delete process.env.RULE_U48_ILLUSION; else process.env.RULE_U48_ILLUSION = old;
  }
});

test("qstat несёт ill: условие «Иллюзии» выполнено — 1 даже когда плашка подавлена кулдауном", () => {
  const old = process.env.RULE_U48_ILLUSION;
  process.env.RULE_U48_ILLUSION = "1";
  try {
    const ctx = mk(5, { opinion: true }); ctx.g.start(0);
    const ill = [];
    for (let k = 0; k < 2; k++) {
      ["a", "a", "a", "a", "b"].forEach((v, i) => { ctx.g.vote("p" + i, v, ctx.t); ctx.g.confirm("p" + i, ctx.t); });
      let ev = [];
      ["b", "b", "b", "b", "a"].forEach((v, i) => { ev = ev.concat(ctx.g.opinion("p" + i, v, ctx.t).events || []); });
      const q = ev.find((e) => e.type === "qstat");
      ill.push(q ? q.ill : null);
      ctx.t = ctx.g.s.phaseEnd; ctx.g.tick(ctx.t); ctx.t = ctx.g.s.phaseEnd; ctx.g.tick(ctx.t);
    }
    assert.deepStrictEqual(ill, [1, 1]);
  } finally {
    if (old === undefined) delete process.env.RULE_U48_ILLUSION; else process.env.RULE_U48_ILLUSION = old;
  }
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

// ---------- регрессии аудита (10.10) ----------

test("вернулся с тем же именем посреди партии — та же запись: очки, ва-банки и голос на месте", () => {
  const ctx = mk(5); ctx.g.start(0);
  const { g } = ctx;
  round(ctx, ["a", "a", "a", "b", "b"], { bank: ["p0"] });
  const p0 = g.player("p0");
  assert.strictEqual(p0.score, 200);
  assert.strictEqual(p0.banks, 1);
  g.vote("p0", "a", ctx.t);
  g.vote("p1", "b", ctx.t);
  g.bankToggle("p0", true, ctx.t);
  g.confirm("p0", ctx.t);
  g.removePlayer("p0", ctx.t);
  g.removePlayer("p1", ctx.t);
  const n = g.s.players.length;
  const r = g.addPlayer({ id: "новый", name: "  игрок0 ", now: ctx.t + 1 });
  assert.ok(r.ok && r.restored);
  assert.strictEqual(r.player.id, "p0", "тот же человек — та же запись");
  assert.strictEqual(r.player.score, 200);
  assert.strictEqual(r.player.banks, 1, "ва-банк не возвращается");
  assert.strictEqual(g.s.players.length, n, "записей не прибавилось");
  assert.strictEqual(g.s.round.votes.p0, "a");
  assert.ok(g.s.round.confirmed.p0 && g.s.round.bank.p0, "голос текущего раунда сохранён, не пересчитывается");
  g.addPlayer({ id: "x", name: "игрок1", now: ctx.t + 1 });
  assert.strictEqual(g.s.round.votes.p1, "b");
});

test("перезаходы не копят «призраков»: «Комната заполнена» только при 12 присутствующих", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  for (let i = 0; i < 80; i++) {
    const r = g.addPlayer({ id: "g" + i, name: "Гость" + i, now: 1 });
    assert.ok(r.ok, "цикл " + i + ": " + r.reason);
    g.removePlayer("g" + i, 1);
  }
  assert.ok(g.s.players.length <= MAX_PLAYERS * 3, "записей " + g.s.players.length);
  assert.ok(g.present().length === 4);
  // даже с очками: давних ушедших вытесняем, а не отказываем живым
  for (let i = 0; i < 60; i++) {
    g.addPlayer({ id: "s" + i, name: "Счёт" + i, now: 1 });
    g.player("s" + i).score = 50;
    g.removePlayer("s" + i, 1);
    assert.ok(g.s.players.length <= MAX_PLAYERS * 3);
  }
  for (let i = 4; i < 12; i++) assert.ok(g.addPlayer({ id: "f" + i, name: "Полный" + i, now: 1 }).ok);
  assert.strictEqual(g.present().length, 12);
  assert.strictEqual(g.addPlayer({ id: "лишний", name: "Лишний", now: 1 }).reason, "room_full");
});

test("пауза «пассивная»: все на связи, но голосов нет — короткая, с причиной; потом партия останавливается", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  round(ctx, ["a", null, null, null]);
  round(ctx, ["a", null, null, null]);
  assert.strictEqual(g.s.phase, "pause");
  assert.strictEqual(g.s.pauseReason, "passive");
  assert.strictEqual(g.s.phaseEnd - g.s.phaseStart, T.passive, "не полные 60 с");
  const snap = g.snapshot(ctx.t, "board");
  assert.strictEqual(snap.pauseReason, "passive");
  assert.deepStrictEqual(snap.pauseIdle.sort(), ["p1", "p2", "p3"]);
  ctx.t = g.s.phaseEnd; g.tick(ctx.t);
  assert.strictEqual(g.s.phase, "vote");
  assert.strictEqual(g.snapshot(ctx.t, "board").pauseReason, null);
  round(ctx, ["a", null, null, null]);
  round(ctx, ["a", null, null, null]);
  assert.strictEqual(g.s.phase, "finished", "цикл «2 войда → пауза → 2 войда» не бесконечный");
  assert.strictEqual(g.s.finishedReason, "idle");
  assert.ok(MAX_VOID_RUN >= 4);
});

test("пауза: передумали — связь пропала во время короткой паузы → «ждём игроков» на полную минуту", () => {
  const ctx = mk(3); ctx.g.start(0);
  const { g } = ctx;
  round(ctx, ["a", null, null]);
  round(ctx, ["a", null, null]);
  assert.strictEqual(g.s.pauseReason, "passive");
  g.setOnline("p0", false, ctx.t);
  assert.strictEqual(g.s.phase, "pause");
  assert.strictEqual(g.s.pauseReason, "offline");
  assert.strictEqual(g.s.phaseEnd - ctx.t, T.pause);
  g.setOnline("p0", true, ctx.t + 5);
  assert.strictEqual(g.s.phase, "vote", "вернулись — продолжаем сразу");
  // меньше трёх на связи к концу раунда — сразу offline
  const c2 = mk(4); c2.g.start(0);
  c2.g.setOnline("p2", false, 0); c2.g.setOnline("p3", false, 0);
  round(c2, ["a", "a", null, null]);
  assert.strictEqual(c2.g.s.pauseReason, "offline");
});

test("ва-банк: только настоящий boolean", () => {
  const ctx = mk(3); ctx.g.start(0);
  for (const bad of ["false", "true", 1, 0, null, undefined, {}]) {
    assert.strictEqual(ctx.g.bankToggle("p0", bad, 0).ok, false, JSON.stringify(bad));
  }
  assert.ok(ctx.g.bankToggle("p0", true, 0).ok);
  assert.ok(ctx.g.bankToggle("p0", false, 0).ok);
});

test("имена: 15 кодпоинтов без разрыва суррогатных пар; двойники і/ї/ј, диакритика, 0/o, I/l", () => {
  assert.strictEqual(NAME_MAX, 15);
  assert.strictEqual(Array.from(cleanName("ы".repeat(40))).length, 15);
  const e = cleanName("😀".repeat(30));
  assert.strictEqual(Array.from(e).length, 15);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(e));
  assert.strictEqual(nameKey("Іvan"), nameKey("Ivan"));
  assert.strictEqual(nameKey("Ïvan"), nameKey("Ivan"));
  assert.strictEqual(nameKey("Саша"), nameKey("Сaшa"));
  assert.strictEqual(nameKey("Ilya"), nameKey("llya"));
  assert.strictEqual(nameKey("Rob0t"), nameKey("Robot"));
  assert.strictEqual(nameKey("Άννα"), nameKey("Αννα"));
  assert.notStrictEqual(nameKey("Анна"), nameKey("Антон"));
});

test("настройки: null, массив, строка — без исключения, значения по умолчанию", () => {
  for (const bad of [null, [], "x", 5, true]) assert.deepStrictEqual(clampSettings(bad), clampSettings({}));
  assert.deepStrictEqual(Game.create({ settings: null, rnd: rndFrom(), content: {} }).s.settings, clampSettings({}));
});

// синтетический банк с тегами: острые колоды должны выходить в каждой партии, а лимиты — соблюдаться
function taggedBank(n = 200) {
  const tags = ["spicy", "dark", "pick", "edge", "taste", "absurd", "habits", "social", "work", "money", "tech"];
  return Array.from({ length: n }, (_, i) => ({
    id: "k-" + i, q: "Вопрос " + i + "?", a: "Да", b: "Нет", kind: (i * 7) % 3 === 0 ? "ab" : "yn", tag: tags[(i * 5) % tags.length],
    lean: (i * 11) % 5 < 2 ? "b" : "a", sensitive: i % 25 === 0,
  }));
}

test("выбор вопросов: острый минимум, потолки pick/edge, «А/Б» 30–70 %, sensitive ≤ 1 и не первым, lean 40–50 %", () => {
  const content = taggedBank();
  const by = new Map(content.map((x) => [x.id, x]));
  for (const short of [false, true]) {
    const total = short ? 6 : 10;
    for (let room = 0; room < 40; room++) {
      let seed = room + 1;
      const g = Game.create({ settings: { short, opinion: false }, code: "T", rnd: rndFrom(seed * 97), content: { ru: content } });
      for (let i = 0; i < 3; i++) g.addPlayer({ id: "p" + i, name: "И" + i, now: 0 });
      for (let party = 0; party < 12; party++) {
        g.s.phase = "lobby"; g.start(0);
        const qs = [g.s.round.q];
        for (let i = 1; i < total; i++) qs.push(g.takeQuestion(i === total - 1 ? "final" : "normal"));
        const m = qs.map((q) => by.get(q.id));
        const ctxt = `short=${short} room=${room} party=${party}`;
        assert.strictEqual(new Set(qs.map((q) => q.id)).size, total, "повтор в партии " + ctxt);
        assert.ok(m.filter((x) => x.tag === "spicy" || x.tag === "dark").length >= (short ? 1 : 3), "острых мало " + ctxt);
        assert.ok(m.filter((x) => x.tag === "pick").length <= 2 && m.filter((x) => x.tag === "edge").length <= 2, "pick/edge " + ctxt);
        const ab = m.filter((x) => x.kind === "ab").length;
        assert.ok(ab >= Math.ceil(0.3 * total) && ab <= Math.floor(0.7 * total), `ab=${ab} ` + ctxt);
        assert.ok(m.filter((x) => x.sensitive).length <= 1, "sensitive " + ctxt);
        assert.ok(!m.slice(0, 2).some((x) => x.sensitive), "sensitive в первых двух " + ctxt);
        const lb = m.filter((x) => x.lean === "b").length;
        assert.ok(lb >= Math.floor(0.4 * total) && lb <= Math.floor(0.5 * total), `lean b=${lb} ` + ctxt);
      }
    }
  }
});

test("выбор вопросов на настоящих колодах: 3000 партий на язык, доли в пределах, повторов нет", () => {
  const CONTENT = require("./content");
  for (const lang of ["ru", "en", "el"]) {
    const bankL = CONTENT[lang];
    if (!bankL || bankL.length < 60) continue;
    const by = new Map(bankL.map((x) => [x.id, x]));
    let parties = 0;
    for (const short of [false, true]) {
      const total = short ? 6 : 10;
      for (let room = 0; room < 15; room++) {
        const g = Game.create({ settings: { short, lang, opinion: false }, code: "T", rnd: rndFrom(room * 31 + 5), content: CONTENT });
        for (let i = 0; i < 3; i++) g.addPlayer({ id: "p" + i, name: "И" + i, now: 0 });
        for (let party = 0; party < 100; party++) {
          g.s.phase = "lobby"; g.start(0);
          const qs = [g.s.round.q];
          for (let i = 1; i < total; i++) qs.push(g.takeQuestion(i === total - 1 ? "final" : "normal"));
          const m = qs.map((q) => by.get(q.id));
          parties++;
          const ctxt = `${lang} short=${short} room=${room} party=${party}`;
          assert.strictEqual(new Set(qs.map((q) => q.id)).size, total, "повтор " + ctxt);
          assert.ok(m.filter((x) => x.tag === "spicy" || x.tag === "dark").length >= (short ? 1 : 3), "острых мало " + ctxt);
          assert.ok(m.filter((x) => x.tag === "pick").length <= 2 && m.filter((x) => x.tag === "edge").length <= 2, "pick/edge " + ctxt);
          const ab = m.filter((x) => x.kind === "ab").length;
          assert.ok(ab >= Math.ceil(0.3 * total) && ab <= Math.floor(0.7 * total), `ab=${ab} ` + ctxt);
          assert.ok(m.filter((x) => x.sensitive).length <= 1 && !m.slice(0, 2).some((x) => x.sensitive), "sensitive " + ctxt);
          const lb = m.filter((x) => x.lean === "b").length;
          assert.ok(lb >= Math.floor(0.4 * total) && lb <= Math.floor(0.5 * total), `lean b=${lb} ` + ctxt);
        }
      }
    }
    assert.strictEqual(parties, 3000);
  }
});

test("банк «забывается» только когда не хватает нужного: хвост банка не ломает баланс", () => {
  // 30 вопросов: после трёх партий свободных мало, баланс всё равно держится, повторов в партии нет
  const content = taggedBank(30);
  const g = Game.create({ settings: { short: false, opinion: false }, code: "T", rnd: rndFrom(3), content: { ru: content } });
  for (let i = 0; i < 3; i++) g.addPlayer({ id: "p" + i, name: "И" + i, now: 0 });
  const by = new Map(content.map((x) => [x.id, x]));
  for (let party = 0; party < 15; party++) {
    g.s.phase = "lobby"; g.start(0);
    const qs = [g.s.round.q];
    for (let i = 1; i < 10; i++) qs.push(g.takeQuestion(i === 9 ? "final" : "normal"));
    assert.strictEqual(new Set(qs.map((q) => q.id)).size, 10, "повтор в партии " + party);
    const lb = qs.filter((q) => by.get(q.id).lean === "b").length;
    assert.ok(lb >= 4 && lb <= 5, `партия ${party}: lean b=${lb}`);
  }
});

test("аватар: меняется в лобби, чужой занять нельзя, во время игры нельзя", () => {
  const g = Game.create({ settings: {}, code: "TEST22", rnd: Math.random.bind(Math), content: { ru: {} } });
  g.addPlayer({ id: "a", name: "Аня", now: 0 });
  g.addPlayer({ id: "b", name: "Боб", now: 0 });
  assert.ok(Array.isArray(g.snapshot(0, {}).avatarChoices));
  assert.strictEqual(g.setAvatar("a", "🍕").ok, true);
  assert.strictEqual(g.player("a").avatar, "🍕");
  assert.strictEqual(g.setAvatar("b", "🍕").reason, "avatar_taken");
  assert.strictEqual(g.setAvatar("b", "не-эмодзи").reason, "bad_avatar");
  g.s.phase = "answer";
  assert.strictEqual(g.setAvatar("b", "🌮").reason, "game_started");
  assert.strictEqual(g.snapshot(0, {}).avatarChoices, null);
});

// ---- T-W0-15: подписи ва-банка, замены, агрегат мнений ----
test("ва-банк без «Готово»: не засчитывается (правило прежнее), но помечен bankLate и виден игроку", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  ["a", "a", "a", "b"].forEach((v, i) => g.vote("p" + i, v, 0));
  g.bankToggle("p0", true, 0);
  ["p1", "p2", "p3"].forEach((id) => g.confirm(id, 0));
  g.tick(g.s.phaseEnd);
  const res = g.s.round.result;
  assert.ok(res.bankLate.p0, "p0 включил ×2, но не нажал «Готово»");
  assert.ok(!res.bankLate.p1);
  assert.ok(!res.banked.p0, "ва-банк не засчитан");
  assert.strictEqual(res.pts.p0, POINTS.win, "очки обычные, не ×2");
  assert.strictEqual(g.player("p0").banks, 2, "ва-банк не потрачен");
  assert.strictEqual(g.snapshot(0, "p0").me.bankLate, true);
  assert.strictEqual(g.snapshot(0, "p1").me.bankLate, false);
});

test("bankLate до раскрытия никому не уходит в снимке", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  g.vote("p0", "a", 0); g.bankToggle("p0", true, 0);
  const j = JSON.stringify(g.snapshot(0, "p0")) + JSON.stringify(g.snapshot(0, "board"));
  assert.ok(!/bankLate":true/.test(j));
  assert.ok(!/"bankLate":\{"p0"/.test(j));
});

test("аннулирование: replace и номер замены; после двух замен — replace=false, номер вопроса «замена» в раунде", () => {
  const ctx = mk(4); ctx.g.start(0);
  const { g } = ctx;
  const r1 = round(ctx, ["a", null, null, null]);
  assert.strictEqual(r1.replace, true);
  assert.strictEqual(r1.replaceNo, 1);
  assert.strictEqual(g.s.round.repl, 1, "следующий вопрос — замена 1");
  assert.strictEqual(g.snapshot(0, "p0").round.repl, 1);
  const r2 = round(ctx, ["a", null, null, null]);
  assert.strictEqual(r2.replaceNo, 2);
  ctx.t = g.s.phaseEnd; g.tick(ctx.t); // пауза
  assert.strictEqual(g.s.round.repl, 2);
  const r3 = round(ctx, ["a", null, null, null]);
  assert.strictEqual(r3.void, true);
  assert.strictEqual(r3.replace, false, "замены кончились — обещание «заменят» не даётся");
  assert.ok(!g.s.round || !g.s.round.repl, "следующий вопрос не помечен заменой");
});

test("агрегат мнений: при 1–2 ответивших не показывается, при ≥ 3 — показывается", () => {
  const ctx = mk(5, { opinion: true }); ctx.g.start(0);
  const { g } = ctx;
  ["a", "a", "a", "b", "b"].forEach((v, i) => { g.vote("p" + i, v, 0); g.confirm("p" + i, 0); });
  ["a", "b", "skip", "skip", "skip"].forEach((v, i) => g.opinion("p" + i, v, 0));
  assert.strictEqual(g.s.round.result.opinions, null, "2 ответивших (a+b) — скрыто");
  const c2 = mk(5, { opinion: true }); c2.g.start(0);
  ["a", "a", "a", "b", "b"].forEach((v, i) => { c2.g.vote("p" + i, v, 0); c2.g.confirm("p" + i, 0); });
  ["a", "b", "b", "skip", "skip"].forEach((v, i) => c2.g.opinion("p" + i, v, 0));
  assert.deepStrictEqual(c2.g.s.round.result.opinions, { a: 1, b: 2, skip: 2 });
});

// ---- T-W0-31: restore из дампа прошлой версии без новых полей (шаблон — tools/testkit/restore.js) ----
test("restore-from-prev-dump: без voidsUsed/replNext/round.repl/result.bankLate — партия доигрывается до финала, очки конечные, замены не включаются (T-W0-31)", () => {
  const restore = require("../tools/testkit/restore");
  const ctx = mk(4, { short: true });
  ctx.g.start(0);
  const mid = JSON.parse(JSON.stringify(ctx.g.s));
  assert.ok("voidsUsed" in mid && "repl" in mid.round, "текущая версия пишет новые поля");
  const { state } = restore.stripFields(mid, ["voidsUsed", "replNext", "round.repl", "round.result.bankLate", "round.result.replace", "round.result.replaceNo", "round.result.replaceMax"]);
  restore.assertAbsent(state, ["voidsUsed", "round.repl"]);
  const g2 = Game.from(state, rndFrom(9), { ru: bank() });
  const c2 = { g: g2, ids: ctx.ids, t: 0 };
  let guard = 0;
  while (g2.s.phase !== "finished" && guard++ < 60) {
    skipIntro(c2);
    if (g2.s.phase === "vote") round(c2, ["a", "b", "a", "b"], { bank: [c2.ids[0]] });
    else { c2.t = g2.s.phaseEnd; g2.tick(c2.t); }
  }
  assert.strictEqual(g2.s.phase, "finished", "партия дошла до финала");
  for (const p of g2.s.players) assert.ok(Number.isFinite(p.score), "очки конечные: " + p.score);
  assert.ok(!Number.isNaN(g2.s.voidsUsed), "voidsUsed не NaN");
  const snap = g2.snapshot(c2.t, c2.ids[0]);
  assert.ok(snap.awards !== undefined);
});

// ---------- T-W2-35: призраки не в партии (RULE_U08_GHOST_OUT) и вытеснение офлайн-места ----------
function withFlag(name, value, fn) {
  const old = process.env[name];
  if (value == null) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally { if (old === undefined) delete process.env[name]; else process.env[name] = old; }
}

test("RULE_U08_GHOST_OUT выкл: офлайн к старту — в партии с нулём, как раньше", () => {
  withFlag("RULE_U08_GHOST_OUT", null, () => {
    const { g } = mk(4);
    g.setOnline("p3", false, 1000);
    assert.ok(g.start(2000).ok);
    assert.strictEqual(g.present().length, 4);
    assert.ok(g.player("p3") && !g.player("p3").left);
  });
});

test("RULE_U08_GHOST_OUT=1: офлайн к старту — left, не в партии; вернулся по имени — садится обратно без очков", () => {
  withFlag("RULE_U08_GHOST_OUT", "1", () => {
    const { g } = mk(4);
    g.setOnline("p3", false, 1000);
    assert.ok(g.start(2000).ok);
    assert.strictEqual(g.present().length, 3);
    assert.strictEqual(g.player("p3").left, true);
    const r = g.addPlayer({ id: "новый", name: "Игрок3", now: 3000 });
    assert.ok(r.ok && r.restored);
    assert.strictEqual(r.player.id, "p3");
    assert.strictEqual(r.player.left, false);
    assert.strictEqual(r.player.score, 0);
  });
});

test("RULE_U08_GHOST_OUT=1: 2 на связи + 1 призрак -> few_players; призраки не занимают места", () => {
  withFlag("RULE_U08_GHOST_OUT", "1", () => {
    const a = mk(3);
    a.g.setOnline("p2", false, 0);
    assert.strictEqual(a.g.start(1).reason, "few_players");
    const b = mk(12);
    for (const id of ["p9", "p10", "p11"]) b.g.setOnline(id, false, 0);
    assert.ok(b.g.start(10).ok);
    assert.strictEqual(b.g.present().length, 9);
    assert.ok(b.g.addPlayer({ id: "x1", name: "Новый1", now: 20 }).ok);
  });
});

test("лобби: полная комната вытесняет давнее офлайн-место (старше GHOST_TTL_MS), свежее не трогает", () => {
  const { g } = mk(12);
  g.setOnline("p5", false, 1000);
  g.setOnline("p6", false, 50000);
  assert.strictEqual(g.addPlayer({ id: "x", name: "Новый", now: 60000 }).reason, "room_full");
  const r = g.addPlayer({ id: "x", name: "Новый", now: 130000 });
  assert.ok(r.ok);
  assert.ok(!g.player("p5"));
  assert.ok(g.player("p6"));
});

test("посреди партии место офлайн не вытесняется (room_full)", () => {
  const { g } = mk(12);
  g.start(0);
  g.setOnline("p5", false, 1000);
  assert.strictEqual(g.addPlayer({ id: "x", name: "Новый", now: 900000 }).reason, "room_full");
});
