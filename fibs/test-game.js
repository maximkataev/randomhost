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
  assert.strictEqual(g.s.lies.P4, undefined, "призрак (нет связи) заготовку не получает — fibs-021");
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

test("записей об игроках не больше MAX_PLAYER_RECORDS: вход/выход посреди партии не раздувает список", () => {
  const { MAX_PLAYER_RECORDS } = require("./game");
  const g = game(3);
  for (let i = 0; i < MAX_PLAYER_RECORDS * 2; i++) {
    const r = g.addPlayer({ id: "x" + i, name: "x" + i });
    if (r.ok) g.removePlayer("x" + i, 5000);
  }
  assert.ok(g.s.players.length <= MAX_PLAYER_RECORDS);
  assert.strictEqual(g.addPlayer({ id: "y", name: "y" }).reason, "room_full");
});

test("посреди партии снимок не выдаёт, кто брал «Соври за меня»; в итогах — есть", () => {
  const g = game(4);
  assert.ok(g.pickTopic(g.s.chooser, g.s.topics[0], 6000).ok);
  assert.ok(g.hint("P1", 6000).ok);
  for (const view of ["board", "P2"]) assert.ok(!/hintsUsed/.test(JSON.stringify(g.snapshot(6000, view).players)), "счётчик подсказок утёк в " + view);
  g.abort(7000);
  assert.strictEqual(g.snapshot(7000, "board").players.find((p) => p.id === "P1").hintsUsed, 1);
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

// ---------- T-W0-10: isTruth ----------

test("isTruth: однословный alt не объявляет правдой ложь «чужое слово + alt» (fibs-049)", () => {
  const rhino = { answer: "шерстистого носорога", alts: ["носорога"] };
  assert.ok(!isTruth("белого носорога", rhino));
  assert.ok(!isTruth("чёрного носорога", rhino));
  assert.ok(isTruth("шерстистого носорога", rhino));
  assert.ok(isTruth("носорога", rhino)); // сам alt — правда
  assert.ok(isTruth("Носорога!", rhino));
  const lungs = { answer: "человеческих лёгких", alts: ["лёгких"] };
  assert.ok(!isTruth("куриных лёгких", lungs));
  // alt из двух слов «правду внутри» сохраняет
  const sin = { answer: "Фрэнк Синатра", alts: ["фрэнк синатра", "Френк Синатра"] };
  assert.ok(isTruth("великий Френк Синатра", sin));
  assert.ok(!isTruth("Нэнси Синатра", sin));
  // ответ из одного слова — «правда внутри» как раньше (спека §4: «бобровой железы»)
  assert.ok(isTruth("бобровой железы", { answer: "бобров", alts: [] }));
});

test("isTruth: сдвиг пробела и две опечатки в длинном ответе — правда (fibs-047)", () => {
  const f = { answer: "шерстистого носорога", alts: [] };
  assert.ok(isTruth("шерстистог оносорога", f));
  assert.ok(isTruth("шерстистого  но сорога", f));
  assert.ok(isTruth("шерстистго носорга", f)); // две пропущенные буквы, ответ от 12 букв
  assert.ok(!isTruth("шерстистго носрга", f)); // три
  // ответы короче 12 букв — одна опечатка, как раньше
  const g = { answer: "единорог", alts: [] };
  assert.ok(isTruth("еденорог", g));
  assert.ok(!isTruth("еденарог", g));
  // совсем короткие — только буквально
  assert.ok(isTruth("лук", { answer: "лук", alts: [] }));
  assert.ok(!isTruth("лок", { answer: "лук", alts: [] }));
  // числа: опечатки в цифрах — другое число
  assert.ok(!isTruth("1913 год основания компании", { answer: "1912 год основания компании", alts: [] }));
});

test("«один выстрел на факт»: отказ «правда» не даёт нащупывать ответ — первая же неправда принимается и закрывает приём (fibs-046)", () => {
  const g = game(3);
  g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
  const f = g.s.fact;
  for (let i = 0; i < 20; i++) assert.strictEqual(g.lie("P1", i % 2 ? f.answer : f.alts[0], 6000).reason, "truth");
  assert.strictEqual(g.s.lies.P1, undefined, "отказ ничего не записал");
  assert.ok(g.lie("P1", "первая неправда", 6000).ok);
  // дальше приём закрыт: ни правду, ни другую ложь «проверить» нельзя — ответ всегда «уже отправлено»
  for (const t of [f.answer, "ещё ложь", f.alts[0]]) assert.strictEqual(g.lie("P1", t, 6000).reason, "done");
  assert.strictEqual(g.s.tries, undefined, "мёртвого счётчика попыток нет");
});

// ---------- T-W0-11: призрак без очков, продление выбора ----------

// ложь у всех, кроме P4; P4 офлайн; время лжи вышло
function ghostGame() {
  const g = game(4);
  g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
  g.lie("P1", "раз", 6000);
  g.lie("P2", "два", 6000);
  g.setOnline("P4", false, 6000);
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "choose");
  return g;
}

test("призрак не копит очки: нет заготовки, нет обманутых и лайков; онлайн-опоздавшему 🐌 по-прежнему ставится", () => {
  const g = ghostGame();
  assert.ok(!g.s.options.some((o) => o.authors.includes("P4")));
  assert.ok(g.s.lies.P3.late, "онлайн, но не успел — 🐌 как раньше");
  // все выбирают ложь «раз» (P1): очки только P1; призрак ни при чём
  const i = lieOf(g, "P1");
  for (const id of ["P2", "P3"]) g.choose(id, [i], g.s.phaseStart + 10);
  g.like("P2", i, g.s.phaseStart + 20);
  g.tick(g.s.phaseEnd);
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.player("P4").score, 0);
  assert.strictEqual(g.s.result.gain.P4, undefined);
  assert.ok(g.player("P1").score > 0);
  // вернулся — следующий факт обычный
  g.setOnline("P4", true, g.s.phaseStart);
  g.tick(g.s.phaseEnd);
  g.pickTopic(g.s.chooser, g.s.topics[0], g.s.phaseStart + 100);
  assert.ok(g.s.roster.includes("P4"));
});

test("RULE_U09B_CHOOSE_EXTEND: по умолчанию выкл — возврат окно не меняет; включён — не больше +8 с и один раз на фазу", () => {
  const key = "RULE_U09B_CHOOSE_EXTEND";
  const saved = process.env[key];
  try {
    for (const on of [false, true]) {
      if (on) process.env[key] = "1"; else delete process.env[key];
      const g = game(4);
      g.keepGrace = true;
      g.pickTopic(g.s.chooser, g.s.topics[0], 5000);
      g.lie("P1", "раз", 6000); g.lie("P2", "два", 6000); g.lie("P3", "три", 6000);
      g.setOnline("P4", false, 6500);
      // P4 без лжи ушёл — все остальные соврали, фаза выбора открылась сразу
      assert.strictEqual(g.s.phase, "choose");
      const t0 = g.s.phaseStart;
      for (const id of ["P1", "P2", "P3"]) g.choose(id, [truthIdx(g)], t0 + 1000);
      assert.strictEqual(g.s.phaseEnd, t0 + 1000 + LIKE_GRACE, "все онлайн-выбравшие сократили окно");
      const short = g.s.phaseEnd;
      g.setOnline("P4", true, t0 + 1500);
      if (!on) { assert.strictEqual(g.s.phaseEnd, short, "флаг выкл: как сейчас"); continue; }
      assert.strictEqual(g.s.phaseEnd, t0 + 1500 + 8000, "не больше +8 с от возврата");
      assert.ok(g.s.phaseEnd <= t0 + T.choose, "не дальше исходного срока фазы");
      // второй обрыв и возврат на той же фазе не продлевают снова
      g.s.phaseEnd = short;
      g.setOnline("P4", false, t0 + 1600);
      g.setOnline("P4", true, t0 + 1700);
      assert.strictEqual(g.s.phaseEnd, short);
      // следующая фаза выбора — продление снова доступно
      assert.strictEqual(g.s.chooseExtended, true);
    }
  } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
});

// ---------- T-W0-12: played ----------

test("played: растёт от реальной лжи/выбора, не от 🐌; призрак и новичок после финала — без наград и в таблице", () => {
  const g = ghostGame();
  const s0 = g.snapshot(0, "board");
  assert.strictEqual(s0.players.find((p) => p.id === "P3").played, 0, "🐌-автоложь — не ход");
  assert.strictEqual(s0.players.find((p) => p.id === "P1").played, 1);
  assert.strictEqual(s0.players.find((p) => p.id === "P4").played, 0);
  const i = lieOf(g, "P1");
  g.choose("P2", [i], g.s.phaseStart + 10);
  g.choose("P3", [i], g.s.phaseStart + 10);
  g.tick(g.s.phaseEnd);
  g.abort(g.s.phaseEnd + 1);
  assert.strictEqual(g.s.phase, "finished");
  const late = g.addPlayer({ id: "N1", name: "Новичок" });
  assert.ok(late.ok);
  const snap = g.snapshot(0, "board");
  assert.strictEqual(snap.players.find((p) => p.id === "N1").played, 0);
  const aw = snap.awards;
  const ids = [aw.liar, aw.detector, aw.gullible].filter(Boolean).flatMap((x) => x.ids);
  assert.ok(ids.length && !ids.includes("P4") && !ids.includes("N1"));
  // новая партия: счётчик обнуляется
  g.start(g.s.phaseStart + 10);
  assert.ok(g.s.players.every((p) => p.played === 0));
});

test("played: дамп прошлой версии без поля — присутствующим с очками 1, остальным 0; финал с наградами", () => {
  const g = game(4);
  toChoose(g);
  const i = lieOf(g, "P1");
  for (const id of ["P2", "P3", "P4"]) g.choose(id, [i], g.s.phaseStart + 10);
  g.tick(g.s.phaseEnd);
  g.abort(g.s.phaseEnd + 1);
  const dump = JSON.parse(JSON.stringify(g.s));
  g.addPlayer({ id: "G1", name: "Призрак" });
  dump.players.push(JSON.parse(JSON.stringify(g.player("G1"))));
  for (const p of dump.players) delete p.played; // как у дампа до этой версии
  delete dump.awards;
  const g2 = Game.from(dump, rig(3), fixture());
  const pl = Object.fromEntries(g2.s.players.map((p) => [p.id, p.played]));
  assert.strictEqual(pl.P1, 1);
  assert.strictEqual(pl.G1, 0);
  const a = g2.awards();
  assert.ok(a.liar && a.liar.ids.includes("P1"), "награда «Главный врун» есть");
  assert.ok(g2.snapshot(0, "board").players.every((p) => typeof p.played === "number"));
});

// ---------- T-W0-29 / T-W2-03: очередь неотправленных действий на телефоне (fibs-shared.js + MP.sendQueue) ----------

// Берём из fibs-shared.js транспорт и qpConnect, из mp-common.js — MP, и гоняем их с поддельными сокетом/таймерами браузера.
function loadConnect(opts = {}) {
  const fs = require("fs");
  const vm = require("vm");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "fibs-shared.js"), "utf8");
  let code = src.slice(src.indexOf("const qpClock = {"));
  if (opts.queueMs) code = code.replace(/const QP_QUEUE_CEILING_MS = \{[^}]*\};/, `const QP_QUEUE_CEILING_MS = { "*": ${opts.queueMs} };`);
  const sockets = [];
  class FakeWS {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(x) { this.sent.push(JSON.parse(x)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    drop() { this.readyState = 3; this.onclose({}); }
  }
  const win = { addEventListener() {} };
  const ctx = {
    location: { protocol: "http:", host: "x" }, WebSocket: FakeWS, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Math,
    document: { addEventListener() {}, hidden: false }, window: win, fetch: () => Promise.reject(new Error("offline")), AbortController: undefined,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require("path").join(__dirname, "..", "mp-common.js"), "utf8"), ctx);
  win.MP = ctx.MP;
  vm.runInContext(code + "\n;this.qpConnect = qpConnect;", ctx);
  return { qpConnect: ctx.qpConnect, sockets };
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test("телефон: тап в обрыве ждёт в очереди и уходит после возврата связи; чужому факту не уходит", async () => {
  const { qpConnect, sockets } = loadConnect();
  let fact = "f1";
  const dropped = [];
  const conn = qpConnect({ code: "X", onMessage() {}, onDrop: (m) => dropped.push(m.type), tag: () => fact });
  sockets[0].open();
  conn.send({ type: "lie", text: "раз" });
  assert.deepStrictEqual(sockets[0].sent.filter((m) => m.type === "lie").length, 1, "при живой связи уходит сразу");
  sockets[0].drop();
  conn.send({ type: "lie", text: "в обрыв" });
  conn.send({ type: "choose", picks: [1] });
  fact = "f2"; // за время обрыва факт сменился
  conn.send({ type: "like", opt: 0 });
  await sleepMs(700); // реконнект 500 мс
  assert.ok(sockets.length >= 2, "сокет переоткрыт");
  sockets[1].open();
  conn.flush((m, tg) => tg === fact);
  const sent = sockets[1].sent.filter((m) => m.type !== "ping").map((m) => m.type);
  assert.deepStrictEqual(sent, ["like"], "действия прошлого факта не уходят");
  assert.deepStrictEqual(dropped.sort(), ["choose", "lie"], "а страница узнаёт, что они не дошли");
  conn.stop();
});

test("телефон: очередь ограничена 8; залежавшееся действие при возврате связи — onDrop «expired» (потолок по типу)", async () => {
  const { qpConnect, sockets } = loadConnect({ queueMs: 400 });
  const dropped = [];
  const conn = qpConnect({ code: "X", onMessage() {}, onDrop: (m, why) => dropped.push([m.n, why]), tag: () => "f" });
  sockets[0].open();
  sockets[0].drop();
  for (let n = 1; n <= 10; n++) conn.send({ type: "like", opt: n, n });
  assert.deepStrictEqual(dropped, [[1, "overflow"], [2, "overflow"]], "переполнение выталкивает самые старые");
  await sleepMs(900);
  sockets[1].open();
  conn.flush();
  assert.deepStrictEqual(dropped.slice(2).map((d) => d[0]).sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 9, 10], "просроченные — через onDrop");
  assert.ok(dropped.slice(2).every((d) => d[1] === "expired"), "причина — expired");
  conn.stop();
});

test("телефон: потолок очереди по типу — лайк живёт секунды, ложь — 90 с; новое действие того же вида заменяет прежнее", async () => {
  const { qpConnect, sockets } = loadConnect();
  const dropped = [];
  const conn = qpConnect({ code: "X", onMessage() {}, onDrop: (m, why) => dropped.push(m.type + ":" + why), tag: () => "f" });
  sockets[0].open();
  sockets[0].drop();
  conn.send({ type: "lie", text: "первая" });
  conn.send({ type: "lie", text: "вторая" });
  conn.send({ type: "like", opt: 1 });
  assert.strictEqual(conn.queue.size(), 2, "ложь заменила ложь, лайк рядом");
  assert.deepStrictEqual(dropped, [], "замена — не потеря");
  await sleepMs(700);
  sockets[1].open();
  conn.flush();
  await sleepMs(450); // шаг очереди — 4 действия в секунду
  const sent = sockets[1].sent.filter((m) => m.type !== "ping");
  assert.deepStrictEqual(sent.map((m) => m.type + ":" + (m.text || m.opt)), ["lie:вторая", "like:1"]);
  conn.stop();
});

// ---- T-W1-13 (fibs-003): skipPhase — «Дальше» ведущего как «время вышло» ----
test("skipPhase: тема/ложь/выбор закрываются как таймаут (то же состояние), не раньше 800 мс, в лобби/раскрытии — отказ", () => {
  const mk = () => game(4, {}, rig(3));
  const a = mk(), b = mk();
  const t0 = a.s.phaseStart;
  assert.strictEqual(a.skipPhase(t0 + 799).reason, "too_early");
  assert.strictEqual(a.s.phase, "topic");
  const now = t0 + 1000;
  assert.ok(a.skipPhase(now).ok);
  b.s.phaseEnd = now; b.tick(now);
  assert.strictEqual(JSON.stringify(a.s), JSON.stringify(b.s));
  assert.strictEqual(a.s.phase, "lie");
  // ложь: один соврал, остальные — нет
  a.lie(a.s.roster[0], "выдумка один", now + 10);
  b.lie(b.s.roster[0], "выдумка один", now + 10);
  assert.strictEqual(a.skipPhase(now + 100).reason, "too_early"); // фаза началась в now
  const n2 = now + 2000;
  assert.ok(a.skipPhase(n2).ok);
  b.s.phaseEnd = n2; b.tick(n2);
  assert.strictEqual(JSON.stringify(a.s), JSON.stringify(b.s));
  assert.strictEqual(a.s.phase, "choose");
  // выбор: без ожидающих → раскрытие, очки те же, что у таймаута
  const n3 = n2 + 1500;
  assert.ok(a.skipPhase(n3).ok);
  b.s.phaseEnd = n3; b.tick(n3);
  assert.strictEqual(JSON.stringify(a.s), JSON.stringify(b.s));
  assert.strictEqual(a.s.phase, "reveal");
  // раскрытие и далее — отказ, состояние не тронуто
  const snap = JSON.stringify(a.s);
  assert.strictEqual(a.skipPhase(n3 + 5000).reason, "bad_phase");
  assert.strictEqual(JSON.stringify(a.s), snap);
  const l = Game.create({ settings: {}, code: "LOBBY2", rnd: rig(), content: fixture() });
  assert.strictEqual(l.skipPhase(1e6).reason, "bad_phase");
});
