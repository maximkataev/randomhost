"use strict";

// Тесты движка «На одной волне»: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const { Game, T, WAVE_BONUS, clampSettings, cleanText, checkClue, points } = require("./game");

// Детерминированная случайность: простой LCG
function rig(seed = 1) {
  let x = seed;
  return (n) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % n;
  };
}

function fixture() {
  const scales = Array.from({ length: 60 }, (_, i) => ({ id: "s" + i, l: `Холодное${i}`, r: `Горячее${i}`, tag: "classic" }));
  scales[0] = { id: "s0", l: "Холодное", r: "Горячее", tag: "classic" };
  return { ru: scales, en: scales, el: scales };
}

const names = (n) => Array.from({ length: n }, (_, i) => "P" + (i + 1));

// партия дошла до подсказок
function game(n = 4, settings = {}, rnd = rig()) {
  const g = Game.create({ settings, code: "TEST22", rnd, content: fixture() });
  names(n).forEach((id) => assert.ok(g.addPlayer({ id, name: id }).ok));
  const r = g.start(0);
  assert.ok(r.ok, r.reason);
  assert.strictEqual(g.s.phase, "intro");
  g.tick(T.intro);
  assert.strictEqual(g.s.phase, "clue");
  return g;
}

let uniq = 0;
// все выбрали шкалу и написали подсказку → первая шкала на угадывании
function toGuess(g, now = 10000) {
  for (const id of Object.keys(g.s.cards)) {
    const c = g.s.cards[id];
    if (c.pick == null) assert.ok(g.pickScale(id, 0, now).ok);
    if (!c.clue) assert.ok(g.clue(id, `подсказка ${"абвгдежзий"[++uniq % 10]}`, now).ok);
  }
  assert.strictEqual(g.s.phase, "guess");
}

test("очки по полосам", () => {
  assert.strictEqual(points(90, 90), 400);
  assert.strictEqual(points(94, 90), 400);
  assert.strictEqual(points(94.5, 90), 300);
  assert.strictEqual(points(102, 90), 300);
  assert.strictEqual(points(110, 90), 200);
  assert.strictEqual(points(110.1, 90), 0);
  assert.strictEqual(points(0, 180), 0);
});

test("чистка текста и настройки", () => {
  assert.strictEqual(cleanText("  a​‮b \n\t c  ", 40), "ab c");
  assert.deepStrictEqual(clampSettings({ short: "yes", lang: "xx" }), { short: false, lang: "ru" });
  assert.deepStrictEqual(clampSettings({ short: true, lang: "el" }), { short: true, lang: "el" });
});

test("подсказка: без цифр, без полюсов, не пустая", () => {
  const sc = { l: "Холодное", r: "Горячее" };
  assert.ok(checkClue("кофе, который остыл", sc).ok);
  assert.strictEqual(checkClue("на 7 из 10", sc).reason, "digits");
  assert.strictEqual(checkClue("٣ ложки", sc).reason, "digits");
  assert.strictEqual(checkClue("горячий чай", sc).reason, "pole");
  assert.strictEqual(checkClue("ХОЛОДНАЯ вода", sc).reason, "pole");
  assert.strictEqual(checkClue("!!", sc).reason, "empty");
  assert.strictEqual(checkClue(" ", sc).reason, "empty");
  assert.ok(checkClue("🔥", sc).ok); // эмодзи — можно
  // короткие слова полюса («не») не мешают
  assert.ok(checkClue("не знаю, борщ", { l: "Суп", r: "Не суп" }).ok);
  assert.strictEqual(checkClue("суповой набор", { l: "Суп", r: "Не суп" }).ok, true); // «суповой» — другая основа
  assert.strictEqual(checkClue("x".repeat(80), sc).text.length, 40);
  // служебные слова полюса не мешают, значимые — мешают
  assert.ok(checkClue("новость про всё сразу", { l: "Все знают", r: "Никто не знает" }).ok);
  assert.strictEqual(checkClue("никто не спросил", { l: "Все знают", r: "Никто не знает" }).reason, "pole");
  assert.strictEqual(checkClue("горячительные напитки", { l: "Холодное", r: "Горячее" }).reason, "pole");
  assert.ok(checkClue("котлета", { l: "Кот", r: "Собака" }).ok);
  assert.ok(checkClue("a caged pet rat", { l: "Normal pet", r: "Questionable pet" }).ok, "общее слово полюсов можно");
  assert.strictEqual(checkClue("a normal hamster", { l: "Normal pet", r: "Questionable pet" }).reason, "pole");
  // обходы из ревью безопасности: любые числовые символы, невидимые разрывы, латинские двойники
  for (const t of ["²³ градуса", "⑦ из десяти", "Ⅻ часов", "½ пути", "🔟 баллов", "７ дней", "𝟕 дней"]) assert.strictEqual(checkClue(t, sc).reason, "digits", t);
  const live = { l: "Живое", r: "Неживое" };
  for (const t of ["Жи\u00adвое", "Жи\u2060вое", "Жи\u200dвое", "Жи\u{E0020}вое"]) assert.strictEqual(checkClue(t, live).reason, "pole", JSON.stringify(t));
  for (const [t, sc2] of [["Живoe", live], ["Hоt tea", { l: "Cold", r: "Hot" }], ["Гοрячее", { l: "Холодное", r: "Горячее" }], ["κρύo", { l: "Κρύο", r: "Ζεστό" }]]) assert.strictEqual(checkClue(t, sc2).reason, "mixed", t);
  assert.ok(checkClue("👨\u200d👩\u200d👧 семья", sc).text.includes("\u200d"), "ZWJ в составных эмодзи сохраняется");
  assert.ok(checkClue("full moon party", { l: "Not the vibe", r: "The vibe" }).ok);
});

test("каждому две разные шкалы и сектор 10…170", () => {
  const g = game(6);
  const ids = new Set();
  for (const c of Object.values(g.s.cards)) {
    assert.strictEqual(c.options.length, 2);
    for (const o of c.options) ids.add(o.id);
    assert.ok(c.target >= 10 && c.target <= 170);
  }
  assert.strictEqual(ids.size, 12);
});

test("подсказка требует выбранной шкалы, выбор не меняется", () => {
  const g = game();
  assert.strictEqual(g.clue("P1", "что-то", 1).reason, "pick_first");
  assert.ok(g.pickScale("P1", 1, 1).ok);
  assert.strictEqual(g.pickScale("P1", 0, 1).reason, "picked");
  assert.strictEqual(g.pickScale("P2", 5, 1).reason, "bad_pick");
  assert.ok(g.clue("P1", "что-то", 1).ok);
  assert.strictEqual(g.clue("P1", "ещё", 1).reason, "done");
});

test("все написали — сразу угадывание; очередь случайная, автор не угадывает свою", () => {
  const g = game(4);
  toGuess(g);
  assert.strictEqual(g.s.queue.length, 4);
  const author = g.author();
  assert.strictEqual(g.lock(author, 90, 11000).reason, "own");
  assert.strictEqual(g.lock("P9", 90, 11000).reason, "not_player");
  assert.strictEqual(g.lock(g.s.queue.find((x) => x !== author), 200, 11000).reason, "bad_angle");
  for (const bad of [null, [], "", false, "90"]) assert.strictEqual(g.lock(g.s.queue.find((x) => x !== author), bad, 11000).reason, "bad_angle", JSON.stringify(bad));
});

test("очки автора: среднее, округление до 50 вниз; бонус «на одной волне»", () => {
  const g = game(4);
  toGuess(g);
  const author = g.author();
  const t = g.s.cards[author].target;
  const others = g.s.queue.filter((x) => x !== author);
  // 400 + 300 + 0 → среднее 233 → 200
  assert.ok(g.lock(others[0], t, 11000).ok);
  assert.ok(g.lock(others[1], t + 10, 11000).ok);
  assert.ok(g.lock(others[2], t > 90 ? 0 : 180, 11000).ok);
  assert.strictEqual(g.s.phase, "reveal");
  assert.strictEqual(g.s.result.authorPts, 200);
  assert.strictEqual(g.s.result.wave, false);
  assert.strictEqual(g.player(others[0]).score, 400);
  assert.strictEqual(g.player(author).score, 200);

  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "guess");
  const a2 = g.author();
  const t2 = g.s.cards[a2].target;
  for (const id of g.s.queue.filter((x) => x !== a2)) assert.ok(g.lock(id, t2 + 5, 20000).ok); // все по 300
  assert.strictEqual(g.s.result.wave, true);
  assert.strictEqual(g.s.result.authorPts, 300 + WAVE_BONUS);
});

test("второй раунд — ×2, короткая партия — один раунд", () => {
  const g = game(3);
  for (let guard = 0; g.s.ri === 0 && guard < 50; guard++) {
    if (g.s.phase === "clue") toGuess(g);
    else if (g.s.phase === "guess") { const a = g.author(); for (const id of g.s.queue) if (id !== a) g.lock(id, g.s.cards[a].target, 0); }
    else g.tick(g.s.phaseEnd);
  }
  assert.strictEqual(g.s.ri, 1);
  assert.strictEqual(g.mult(), 2);
  const before = g.player("P1").score;
  g.tick(g.s.phaseEnd); // intro → clue
  toGuess(g);
  const a = g.author();
  const other = g.s.queue.find((x) => x !== a);
  const was = g.player(other).score;
  assert.ok(g.lock(other, g.s.cards[a].target, 30000).ok);
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.player(other).score - was, 800);
  assert.ok(before >= 0);

  const sh = game(3, { short: true });
  for (let guard = 0; sh.s.phase !== "finished" && guard < 50; guard++) {
    if (sh.s.phase === "clue") toGuess(sh);
    else sh.tick(sh.s.phaseEnd);
  }
  assert.strictEqual(sh.s.phase, "finished");
  assert.strictEqual(sh.s.ri, 1);
});

test("не написал подсказку — шкала пропускается, 🐌 в статистике", () => {
  const g = game(4);
  for (const id of ["P1", "P2", "P3"]) { g.pickScale(id, 0, 1); g.clue(id, "слово " + { P1: "а", P2: "б", P3: "в" }[id], 1); }
  assert.strictEqual(g.s.phase, "clue");
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "guess");
  assert.strictEqual(g.s.queue.length, 3);
  assert.ok(!g.s.queue.includes("P4"));
  assert.strictEqual(g.player("P4").stats.skipped, 1);
});

test("никто не зафиксировал — ноль и автору; офлайн не ждём", () => {
  const g = game(4);
  toGuess(g);
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "reveal");
  assert.strictEqual(g.s.result.authorPts, 0);
  g.tick(g.s.phaseEnd);
  const a = g.author();
  const others = g.s.queue.filter((x) => x !== a);
  g.setOnline(others[0], false, 40000);
  g.setOnline(others[1], false, 40000);
  assert.strictEqual(g.s.phase, "guess");
  g.lock(others[2], 90, 40000);
  assert.strictEqual(g.s.phase, "reveal");
});

test("тайны: сектор только автору, чужие стрелки и шкалы на выбор — никому", () => {
  const g = game(4);
  const board0 = JSON.stringify(g.snapshot(1, "board"));
  const c1 = g.s.cards.P1;
  assert.ok(!board0.includes(c1.options[0].l + '"'), "доска не видит шкалы на выбор");
  const p2 = g.snapshot(1, "P2");
  assert.ok(!JSON.stringify(p2).includes(`"${c1.options[0].l}"`), "чужие шкалы не видны");
  assert.strictEqual(g.snapshot(1, "P1").me.card.options.length, 2);
  toGuess(g);
  const a = g.author();
  const target = g.s.cards[a].target;
  const other = g.s.queue.find((x) => x !== a);
  const third = g.s.queue.find((x) => x !== a && x !== other);
  g.lock(other, 33.3, 12000);
  const board = g.snapshot(12000, "board");
  assert.strictEqual(board.card.target, undefined);
  assert.ok(!JSON.stringify(board).includes("33.3"));
  assert.deepStrictEqual(board.locked, [other]);
  const guesser = g.snapshot(12000, third);
  assert.strictEqual(guesser.card.target, undefined);
  assert.strictEqual(guesser.me.card.target, g.s.cards[third].target); // своя будущая шкала — видна себе
  assert.ok(!JSON.stringify(guesser).includes("33.3"));
  assert.ok(!JSON.stringify(guesser).includes(`"target":${target}`) || g.s.cards[third].target === target);
  assert.strictEqual(g.snapshot(12000, other).me.guess, 33.3);
  assert.strictEqual(g.snapshot(12000, a).me.card.target, target);
  // после раскрытия видно всем
  g.tick(g.s.phaseEnd);
  const rb = g.snapshot(40000, "board");
  assert.strictEqual(rb.card.target, target);
  assert.strictEqual(rb.card.guesses[other], 33.3);
});

test("автор текущей шкалы ушёл — шкала сразу пропускается", () => {
  const g = game(4);
  toGuess(g);
  const a = g.author();
  g.removePlayer(a, 12000);
  assert.notStrictEqual(g.author(), a);
  assert.strictEqual(g.s.history.length, 0);
});

test("ушёл автор — его шкалу пропускаем; меньше трёх — конец", () => {
  const g = game(4);
  toGuess(g);
  const next = g.s.queue[1];
  g.removePlayer(next, 12000);
  g.tick(g.s.phaseEnd); // reveal первой
  g.tick(g.s.phaseEnd); // следующая — не ушедшего
  assert.notStrictEqual(g.author(), next);
  const g2 = game(3);
  g2.removePlayer("P1", 5);
  assert.strictEqual(g2.s.phase, "finished");
  assert.strictEqual(g2.s.finishedReason, "few");
});

test("вошёл посреди партии — угадывает со следующей шкалы, подсказку со следующего раунда", () => {
  const g = game(3);
  toGuess(g);
  assert.ok(g.addPlayer({ id: "late", name: "Late", now: 12000 }).ok);
  assert.strictEqual(g.s.phase, "guess");
  assert.strictEqual(g.lock("late", 90, 12000).reason, "late");
  const a = g.author();
  for (const id of g.s.queue) if (id !== a) g.lock(id, 90, 12500);
  assert.strictEqual(g.s.phase, "reveal", "опоздавшего не ждём");
  g.tick(g.s.phaseEnd);
  assert.ok(g.lock("late", 90, g.s.phaseStart + 10).ok);
  const snap = g.snapshot(12000, "late");
  assert.strictEqual(snap.me.inRound, false);
});

test("итоги: награды и пьедестал; шкалы не повторяются в комнате", () => {
  const g = game(3);
  const seen = new Set(Object.values(g.s.cards).flatMap((c) => c.options.map((o) => o.id)));
  for (let guard = 0; g.s.phase !== "finished" && guard < 100; guard++) {
    if (g.s.phase === "clue") {
      for (const c of Object.values(g.s.cards)) for (const o of c.options) seen.add(o.id);
      toGuess(g);
    } else if (g.s.phase === "guess") {
      const a = g.author();
      const t = g.s.cards[a].target;
      for (const id of g.s.queue) if (id !== a) g.lock(id, id === "P1" ? t : t > 90 ? 0 : 180, 0);
    } else g.tick(g.s.phaseEnd);
  }
  assert.strictEqual(seen.size, 12);
  const snap = g.snapshot(0, "board");
  assert.strictEqual(snap.phase, "finished");
  assert.ok(snap.awards.telepath.ids.includes("P1"));
  assert.ok(snap.awards.miss && snap.awards.miss.dist >= 40);
  assert.strictEqual(snap.history.length, 6);
  // ещё партия
  assert.ok(g.start(1).ok);
  assert.strictEqual(g.player("P1").score, 0);
});

test("реакции не чаще раза в 2 с", () => {
  const g = game(3);
  assert.ok(g.react("P1", "😂", 1000).ok);
  assert.ok(!g.react("P1", "😂", 2000).ok);
  assert.ok(g.react("P1", "🙈", 3100).ok);
  assert.ok(!g.react("P1", "💩", 9000).ok);
});

test("дамп: состояние переживает JSON", () => {
  const g = game(4);
  toGuess(g);
  const a = g.author();
  const g2 = Game.from(JSON.parse(JSON.stringify(g.s)), rig(2), fixture());
  const other = g2.s.queue.find((x) => x !== a);
  assert.ok(g2.lock(other, 90, 12000).ok);
});
