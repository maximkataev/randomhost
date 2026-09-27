"use strict";

// Тесты движка «Не верю!»: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const { Game, T, ROUNDS, MIN_OPTIONS, LIKE_GRACE, LIKE_POINTS, clampSettings, cleanText, isTruth } = require("./game");

// Детерминированная случайность: простой LCG
function rig(seed = 1) {
  let x = seed;
  return (n) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % n;
  };
}

// маленький банк: 6 тем по 10 фактов + 10 финальных, у каждого 8 лжей
const TOPICS = ["animals", "food", "history", "laws", "space", "body"];
function fixture() {
  const facts = [];
  for (const t of TOPICS) {
    for (let i = 0; i < 10; i++) {
      facts.push({ id: `${t}-${i}`, topic: t, final: false, text: `Факт ${t} ${i}: ______`, answer: `правда${t}${i}`, alts: [`истина${t}${i}`], lies: Array.from({ length: 8 }, (_, j) => `ложь${t}${i}x${j}`), source: "https://example.org" });
    }
  }
  for (let i = 0; i < 10; i++) facts.push({ id: `fin-${i}`, topic: "history", final: true, text: `Финал ${i}: ______`, answer: `финалправда${i}`, alts: [], lies: Array.from({ length: 8 }, (_, j) => `финложь${i}x${j}`), source: null });
  return { ru: facts, en: facts, el: facts };
}

const names = (n) => Array.from({ length: n }, (_, i) => "P" + (i + 1));

// партия дошла до выбора темы
function game(n = 5, settings = {}, rnd = rig()) {
  const g = Game.create({ settings, code: "TEST22", rnd, content: fixture() });
  names(n).forEach((id) => assert.ok(g.addPlayer({ id, name: id }).ok));
  // все выбрали — дальше окно лайков (LIKE_GRACE); в тестах сразу проматываем его, если не просили иначе
  const choose = g.choose.bind(g);
  g.choose = (id, picks, now) => {
    const r = choose(id, picks, now);
    if (!g.keepGrace && g.s.phase === "choose" && g.allChose()) g.tick(g.s.phaseEnd);
    return r;
  };
  const r = g.start(0);
  assert.ok(r.ok, r.reason);
  assert.strictEqual(g.s.phase, "intro");
  g.tick(T.intro);
  assert.strictEqual(g.s.phase, "topic");
  return g;
}

// тема выбрана, все врут уникально → фаза выбора
let uniq = 0;
function toChoose(g, now = 10000) {
  if (g.s.phase === "topic") assert.ok(g.pickTopic(g.s.chooser, g.s.topics[0], now).ok);
  assert.strictEqual(g.s.phase, "lie");
  for (const id of g.s.roster) if (!g.s.lies[id]) assert.ok(g.lie(id, `выдумка ${++uniq}`, now).ok);
  assert.strictEqual(g.s.phase, "choose");
}

const truthIdx = (g) => g.s.options.findIndex((o) => o.kind === "truth");
const ownIdx = (g, id) => g.s.options.findIndex((o) => o.authors.includes(id));
const lieOf = (g, id) => g.s.options.findIndex((o) => o.kind === "lie" && o.authors.includes(id));

test("чистка текста и настройки", () => {
  assert.strictEqual(cleanText("  a​‮b \n\t c  ", 25), "ab c");
  assert.strictEqual(cleanText("x".repeat(200), 25).length, 25);
  assert.deepStrictEqual(clampSettings({ hints: 9, short: "yes", lang: "xx" }), { hints: 2, short: false, lang: "ru" });
  assert.deepStrictEqual(clampSettings({ hints: 3, short: true, lang: "el" }), { hints: 3, short: true, lang: "el" });
});

test("правда распознаётся: регистр, падеж, alts, опечатка в длинном ответе", () => {
  const f = { answer: "эму", alts: ["страусам эму"] };
  assert.ok(isTruth("ЭМУ", f));
  assert.ok(isTruth("Страусам эму!", f));
  assert.ok(!isTruth("эмо", f)); // короткий ответ — опечатку не прощаем
  const g = { answer: "единорог", alts: [] };
  assert.ok(isTruth("единорога", g));
  assert.ok(isTruth("еденорог", g)); // одна буква
  assert.ok(!isTruth("носорог", g));
  assert.ok(isTruth("12", { answer: "двенадцать", alts: ["12"] }));
  assert.ok(!isTruth("25 000", { answer: "20 000", alts: ["20000"] })); // другая цифра — другое число
  assert.ok(isTruth("20000", { answer: "20 000", alts: [] }));
  assert.ok(!isTruth("14 часов", { answer: "11 часов", alts: [] }));
  assert.ok(isTruth("11 чассов", { answer: "11 часов", alts: [] }));
});

test("нужно минимум 3 игрока", () => {
  const g = Game.create({ rnd: rig(), content: fixture() });
  g.addPlayer({ id: "a", name: "a" });
  g.addPlayer({ id: "b", name: "b" });
  assert.strictEqual(g.start(0).reason, "few_players");
});

test("тему выбирает игрок по кругу; чужой выбор отклоняется; по таймеру — случайная", () => {
  const g = game(4);
  const first = g.s.chooser;
  assert.strictEqual(g.s.topics.length, 4);
  const other = g.s.players.find((p) => p.id !== first).id;
  assert.strictEqual(g.pickTopic(other, g.s.topics[0], 5000).reason, "not_chooser");
  assert.strictEqual(g.pickTopic(first, "нет-такой", 5000).reason, "bad_topic");
  g.tick(T.intro + T.topic);
  assert.strictEqual(g.s.phase, "lie");
  assert.ok(g.s.topics.includes(g.s.topic));
  assert.strictEqual(g.s.fact.topic, g.s.topic);
  // досидим факт до конца — следующим выбирает другой
  toChoose(g, 20000);
  g.tick(g.s.phaseEnd); // никто не выбрал
  g.tick(g.s.phaseEnd); // раскрытие → счёт
  g.tick(g.s.phaseEnd); // счёт → следующий факт
  assert.strictEqual(g.s.phase, "topic");
  assert.notStrictEqual(g.s.chooser, first);
});

test("вписанная правда отклоняется, честная ложь после отказов принимается", () => {
  const g = game(3);
  g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
  const f = g.s.fact;
  assert.strictEqual(g.lie("P1", f.answer.toUpperCase(), 6000).reason, "truth");
  assert.strictEqual(g.lie("P1", f.alts[0], 6000).reason, "truth");
  assert.strictEqual(g.lie("P1", "п" + f.answer.slice(2), 6000).reason, "truth"); // опечатка
  // сколько бы раз ни вписал правду, честная ложь после этого принимается
  for (let i = 0; i < 8; i++) g.lie("P1", f.answer, 6000);
  assert.ok(g.lie("P1", "честная ложь", 6000).ok);
});

test("одинаковая ложь склеивается, оба автора получают очки за каждого обманутого", () => {
  const g = game(5);
  g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
  g.lie("P1", "Кенгуру", 6000);
  g.lie("P2", "кенгуру!", 6000);
  for (const id of ["P3", "P4", "P5"]) g.lie(id, "ложь " + id, 6000);
  const i = g.s.options.findIndex((o) => o.authors.includes("P1"));
  assert.deepStrictEqual(g.s.options[i].authors.sort(), ["P1", "P2"]);
  assert.strictEqual(g.s.options.filter((o) => o.kind === "lie").length, 4);
  // P1 и P2 не могут выбрать общий вариант
  assert.strictEqual(g.choose("P2", [i], 7000).reason, "own");
  g.choose("P3", [i], 7000);
  g.choose("P4", [i], 7000);
  g.choose("P5", [truthIdx(g)], 7000);
  g.choose("P1", [truthIdx(g)], 7000);
  g.choose("P2", [truthIdx(g)], 7000);
  assert.strictEqual(g.s.phase, "reveal");
  const R = ROUNDS.r1;
  const by = Object.fromEntries(g.s.players.map((p) => [p.id, p.score]));
  assert.strictEqual(by.P1, 2 * R.fool + R.truth);
  assert.strictEqual(by.P2, 2 * R.fool + R.truth);
  assert.strictEqual(by.P5, R.truth);
});

test("минимум 6 вариантов: при трёх игроках добавляются ловушки, выбравший ловушку получает 0", () => {
  const g = game(3);
  toChoose(g);
  assert.ok(g.s.options.length >= MIN_OPTIONS);
  const traps = g.s.options.map((o, i) => (o.kind === "trap" ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(traps.length, MIN_OPTIONS - 4);
  assert.strictEqual(g.s.options.filter((o) => o.kind === "truth").length, 1);
  g.choose("P1", [traps[0]], 11000);
  g.choose("P2", [traps[0]], 11000);
  g.choose("P3", [traps[1]], 11000);
  assert.ok(g.s.players.every((p) => p.score === 0));
  assert.strictEqual(g.player("P1").stats.traps, 1);
});

test("подстраховка: два варианта — всё за половину очков; больше двух нельзя", () => {
  const g = game(4);
  toChoose(g);
  const t = truthIdx(g);
  const l2 = lieOf(g, "P2");
  assert.strictEqual(g.choose("P1", [t, l2, lieOf(g, "P3")], 11000).reason, "bad_pick");
  assert.ok(g.choose("P1", [t, l2], 11000).ok);
  g.choose("P2", [t], 11000);
  g.choose("P3", [t], 11000);
  g.choose("P4", [t], 11000);
  const R = ROUNDS.r1;
  assert.strictEqual(g.player("P1").score, R.truth / 2);
  assert.strictEqual(g.player("P2").score, R.truth + R.fool / 2);
});

test("свой вариант выбрать нельзя, повторно выбирать нельзя", () => {
  const g = game(3);
  toChoose(g);
  assert.strictEqual(g.choose("P1", [ownIdx(g, "P1")], 11000).reason, "own");
  assert.ok(g.choose("P1", [truthIdx(g)], 11000).ok);
  assert.strictEqual(g.choose("P1", [truthIdx(g)], 11000).reason, "chosen");
});

test("лайки: после выбора, до двух, не свои, +100 автору в любом раунде", () => {
  const g = game(4);
  toChoose(g);
  const l2 = lieOf(g, "P2");
  assert.strictEqual(g.like("P1", l2, 11000).reason, "choose_first");
  g.choose("P1", [truthIdx(g)], 11000);
  assert.ok(g.like("P1", l2, 11000).ok);
  assert.strictEqual(g.like("P1", l2, 11000).reason, "liked");
  assert.strictEqual(g.like("P1", ownIdx(g, "P1"), 11000).reason, "own");
  assert.ok(g.like("P1", lieOf(g, "P3"), 11000).ok);
  assert.strictEqual(g.like("P1", lieOf(g, "P4"), 11000).reason, "no_likes");
  for (const id of ["P2", "P3", "P4"]) g.choose(id, [truthIdx(g)], 11000);
  assert.strictEqual(g.player("P2").score, ROUNDS.r1.truth + LIKE_POINTS);
  assert.strictEqual(g.s.bestLie.likes, 1);
  assert.strictEqual(g.awards().bestLie, null, "один лайк — не «любимая ложь»");
});

test("«Соври за меня»: лимит на партию, одна заготовка не достаётся двоим", () => {
  const g = game(4, { hints: 1 });
  g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
  assert.ok(g.hint("P1", 6000).ok);
  assert.ok(g.hint("P2", 6000).ok);
  assert.notStrictEqual(g.s.lies.P1.key, g.s.lies.P2.key);
  assert.ok(g.s.lies.P1.hint && !g.s.lies.P1.late);
  assert.strictEqual(g.snapshot(6000, "P1").me.hintsLeft, 0);
  g.lie("P3", "раз", 6000);
  g.lie("P4", "два", 6000);
  // следующий факт: лимит 1 уже потрачен
  for (const id of ["P1", "P2", "P3", "P4"]) g.choose(id, [truthIdx(g)], 7000);
  g.tick(g.s.phaseEnd);
  g.tick(g.s.phaseEnd);
  g.pickTopic(g.s.chooser, g.s.topics[0], g.s.phaseStart + 100);
  assert.strictEqual(g.hint("P1", g.s.phaseStart + 200).reason, "no_hints");
});

test("не успел соврать — заготовка с 🐌, лимит не тратится; отключившийся не держит фазу", () => {
  const g = game(4);
  g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
  g.lie("P1", "раз", 6000);
  g.lie("P2", "два", 6000);
  g.setOnline("P4", false, 6000);
  assert.strictEqual(g.s.phase, "lie");
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "choose");
  assert.ok(g.s.lies.P3.late && g.s.lies.P3.hint);
  assert.ok(g.s.lies.P4.late);
  assert.strictEqual(g.player("P3").hintsUsed, 0);
  // P4 офлайн — выбор без него
  for (const id of ["P1", "P2", "P3"]) g.choose(id, [truthIdx(g)], g.s.phaseStart + 10);
  assert.strictEqual(g.s.phase, "reveal");
});

test("тайны не утекают до раскрытия: правда, авторы, ловушки, чужой выбор, пул лжи", () => {
  const g = game(3);
  g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
  const f = g.s.fact;
  const secret = [f.answer, ...f.alts, ...f.pool];
  const leaks = (snap) => secret.filter((x) => JSON.stringify(snap).includes(x));
  for (const v of ["board", "P1", "P2"]) assert.deepStrictEqual(leaks(g.snapshot(6000, v)), [], v);
  g.hint("P1", 6000);
  // своя подсказка видна только себе
  assert.ok(JSON.stringify(g.snapshot(6000, "P1")).includes(g.s.lies.P1.text));
  assert.ok(!JSON.stringify(g.snapshot(6000, "P2")).includes(g.s.lies.P1.text));
  assert.ok(!JSON.stringify(g.snapshot(6000, "board")).includes(g.s.lies.P1.text));
  g.lie("P2", "два", 6000);
  g.lie("P3", "три", 6000);
  g.choose("P2", [truthIdx(g)], 7000);
  for (const v of ["board", "P1", "P2", "P3"]) {
    const snap = g.snapshot(7000, v);
    assert.strictEqual(snap.truth, null);
    for (const o of snap.options) {
      assert.deepStrictEqual(Object.keys(o).filter((k) => k !== "text" && k !== "mine"), [], v);
    }
    assert.ok(!JSON.stringify(snap).includes("\"kind\""), v);
    if (v !== "P2") assert.strictEqual(snap.me ? snap.me.picks : null, null);
  }
  // alts и оставшийся пул не уходят и после раскрытия
  g.choose("P1", [truthIdx(g)], 7000);
  g.choose("P3", [truthIdx(g)], 7000);
  const after = JSON.stringify(g.snapshot(8000, "board"));
  assert.ok(after.includes(f.answer));
  for (const a of f.alts) assert.ok(!after.includes(a));
  const unused = f.pool.filter((_, i) => !f.poolUsed.includes(i));
  for (const l of unused) assert.ok(!after.includes(l), l);
});

test("раскрытие: сначала невыбранные, правда последней; очки и шаги сходятся", () => {
  const g = game(5);
  toChoose(g);
  const t = truthIdx(g);
  g.choose("P1", [lieOf(g, "P2")], 11000);
  for (const id of ["P2", "P3", "P4", "P5"]) g.choose(id, [t], 11000);
  const steps = g.s.result.steps;
  assert.strictEqual(steps[steps.length - 1].opt, t);
  const pickedPos = steps.findIndex((x) => x.opt === lieOf(g, "P2"));
  const emptyPos = steps.findIndex((x) => x.opt === lieOf(g, "P3"));
  assert.ok(emptyPos < pickedPos);
  assert.strictEqual(g.s.phaseEnd - g.s.phaseStart, g.s.result.total);
  assert.strictEqual(g.s.result.total, 4 * T.stepEmpty + T.step + T.truth);
});

test("партия целиком: 3+3+1 фактов, множители раундов, финал без выбора темы, награды", () => {
  const g = game(3);
  let now = 5000;
  let facts = 0;
  const seenRounds = [];
  while (g.s.phase !== "finished") {
    if (g.s.phase === "topic") { g.pickTopic(g.s.chooser, g.s.topics[0], now); }
    if (g.s.phase === "lie") {
      facts++;
      seenRounds.push(g.roundKey());
      for (const id of g.s.roster) g.lie(id, `выдумка ${++uniq}`, now);
    }
    if (g.s.phase === "choose") {
      // P1 всегда находит правду
      g.choose("P1", [truthIdx(g)], now);
      g.choose("P2", [lieOf(g, "P3")], now);
      g.choose("P3", [lieOf(g, "P2")], now);
    }
    now = Math.max(now + 1, g.s.phaseEnd || now);
    g.tick(now);
  }
  assert.strictEqual(facts, 7);
  // снимок итогов собирается (раунда за последним нет)
  for (const v of ["board", "P1"]) assert.strictEqual(g.snapshot(now, v).phase, "finished");
  assert.deepStrictEqual(seenRounds, ["r1", "r1", "r1", "r2", "r2", "r2", "final"]);
  const sum = (k) => 3 * ROUNDS.r1[k] + 3 * ROUNDS.r2[k] + ROUNDS.final[k];
  assert.strictEqual(g.player("P1").score, sum("truth"));
  assert.strictEqual(g.player("P2").score, sum("fool"));
  assert.deepStrictEqual(g.s.awards.detector.ids, ["P1"]);
  assert.strictEqual(g.s.awards.liar.n, 7);
});

test("короткая партия: 2+2+1", () => {
  const g = game(3, { short: true });
  let now = 5000, facts = 0;
  while (g.s.phase !== "finished") {
    if (g.s.phase === "lie") facts++;
    now = Math.max(now + 1, g.s.phaseEnd || now);
    g.tick(now);
  }
  assert.strictEqual(facts, 5);
});

test("факт не повторяется в комнате, пока банк не пройден", () => {
  const g = game(3);
  const seen = new Set();
  let now = 5000;
  for (let n = 0; n < 3; n++) {
    while (g.s.phase !== "finished") {
      if (g.s.phase === "lie" && !seen.has("~" + g.s.factN + "-" + n)) {
        assert.ok(!seen.has(g.s.fact.id), "повтор " + g.s.fact.id);
        seen.add(g.s.fact.id);
        seen.add("~" + g.s.factN + "-" + n);
      }
      now = Math.max(now + 1, g.s.phaseEnd || now);
      g.tick(now);
    }
    g.toLobby(now);
    g.start(now);
  }
});

test("досрочно: все соврали → выбор, все выбрали → раскрытие; ушедший выбирающий → случайная тема", () => {
  const g = game(4);
  const ch = g.s.chooser;
  g.removePlayer(ch, 5000);
  assert.strictEqual(g.s.phase, "lie");
  for (const id of g.s.roster) if (id !== ch) g.lie(id, "л" + id, 6000);
  assert.strictEqual(g.s.phase, "choose");
});

test("меньше трёх игроков посреди партии — конец", () => {
  const g = game(3);
  g.removePlayer("P2", 5000);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "few");
});

test("реакции: только из списка и не чаще раза в 2 с", () => {
  const g = game(3);
  assert.ok(g.react("P1", "😂", 1000).ok);
  assert.strictEqual(g.react("P1", "😂", 2000).reason, "too_fast");
  assert.strictEqual(g.react("P1", "💩", 5000).reason, "bad");
});

test("состояние переживает JSON (дамп сервера)", () => {
  const g = game(3);
  toChoose(g);
  const g2 = Game.from(JSON.parse(JSON.stringify(g.s)), rig(2), fixture());
  g2.choose("P1", [g2.s.options.findIndex((o) => o.kind === "truth")], 11000);
  assert.ok(g2.s.picks.P1);
});

test("все выбрали — ещё окно на лайки, потом раскрытие; последний выбравший успевает лайкнуть", () => {
  const g = game(3);
  g.keepGrace = true;
  toChoose(g);
  const now = g.s.phaseStart + 1000;
  g.choose("P1", [truthIdx(g)], now);
  g.choose("P2", [truthIdx(g)], now);
  g.choose("P3", [truthIdx(g)], now);
  assert.strictEqual(g.s.phase, "choose");
  assert.strictEqual(g.s.phaseEnd, now + LIKE_GRACE);
  assert.ok(g.like("P3", lieOf(g, "P1"), now + 500).ok);
  g.tick(now + LIKE_GRACE);
  assert.strictEqual(g.s.phase, "reveal");
});

test("перефраз с правдой внутри — тоже правда; ловушка не повторяет слово чужой лжи", () => {
  assert.ok(isTruth("бобровой железы", { answer: "бобров", alts: [] }));
  assert.ok(!isTruth("кроличьей железы", { answer: "бобров", alts: [] }));
  const g = game(3);
  g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
  const trap = g.s.fact.pool[0];
  g.lie("P1", trap + " в очках", 6000);
  g.lie("P2", "раз", 6000);
  g.lie("P3", "два", 6000);
  const texts = g.s.options.filter((o) => o.kind === "trap").map((o) => o.text);
  assert.ok(!texts.includes(trap), "ловушка-двойник чужой лжи");
});

test("темы, сыгранные в партии, не предлагаются снова, пока хватает других", () => {
  const g = game(3);
  const seen = [];
  let now = 5000;
  while (g.s.phase !== "finished" && seen.length < 4) {
    if (g.s.phase === "topic") {
      // в банке теста 6 тем: пока несыгранных ≥ 4, сыгранных среди предложенных нет
      if (6 - seen.length >= 4) for (const t of seen) assert.ok(!g.s.topics.includes(t), "повтор темы " + t);
      else for (const t of g.s.topics.slice(0, 6 - seen.length)) assert.ok(!seen.includes(t), "несыгранные — первыми");
      seen.push(g.s.topics[0]);
      g.pickTopic(g.s.chooser, g.s.topics[0], now);
    }
    now = Math.max(now + 1, g.s.phaseEnd || now);
    g.tick(now);
  }
  assert.ok(seen.length >= 2);
});

test("варианты на экране — строчными и без знаков в конце: правду не узнать по оформлению", () => {
  const { displayText } = require("./game");
  assert.strictEqual(displayText("Акулы!"), "акулы");
  assert.strictEqual(displayText("«Кенгуру»."), "кенгуру");
  assert.strictEqual(displayText("THE MOON?!"), "the moon");
  assert.strictEqual(displayText("ΓΑΤΑ!"), "γατα");
  assert.strictEqual(displayText("..."), "...");
});
