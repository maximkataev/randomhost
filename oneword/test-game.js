"use strict";

// Тесты движка «Сто к одному» (docs/oneword-spec.md §10): node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const {
  Game, normalizeWord, clusterAnswers, scorePopular, scoreRare, matchCluster, cleanWord, cleanName,
} = require("./game");

// банк-пустышка: достаточно тем, чтобы не упираться в повторы
const TOPICS = Array.from({ length: 20 }, (_, i) => ({ id: "t" + i, topic: "Тема " + i }));
const CONTENT = { ru: TOPICS, en: TOPICS, el: TOPICS };

function rndFrom(seed) {
  let a = seed || 1;
  return (n) => { a = (a * 1664525 + 1013904223) >>> 0; return a % Math.max(1, n); };
}

function makeGame(n = 3, opts = {}) {
  const g = Game.create({ settings: opts.settings, code: "TEST", rnd: opts.rnd || rndFrom(42), content: opts.content || CONTENT });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = "p" + i;
    const r = g.addPlayer({ id, name: "Игрок" + i, now: 0 });
    assert.ok(r.ok, JSON.stringify(r));
    ids.push(id);
  }
  return { g, ids };
}

// ---------- нормализация ----------

test("normalizeWord: регистр, пробелы по краям, ё/е, знаки на концах", () => {
  assert.strictEqual(normalizeWord("  Арбуз  "), "арбуз");
  assert.strictEqual(normalizeWord("АРБУЗ"), "арбуз");
  assert.strictEqual(normalizeWord("ёлка"), "елка");
  assert.strictEqual(normalizeWord("Ёлка!"), "елка");
  assert.strictEqual(normalizeWord("«банан»"), "банан");
  assert.strictEqual(normalizeWord("банан."), "банан");
  assert.strictEqual(normalizeWord("-банан-"), "банан");
  assert.strictEqual(normalizeWord(""), "");
  assert.strictEqual(normalizeWord(null), "");
  assert.strictEqual(normalizeWord("   "), "");
  // без фонетики/синонимов (§11.4): разные слова остаются разными
  assert.notStrictEqual(normalizeWord("драгонфрут"), normalizeWord("фрукт дракона"));
});

test("cleanWord: одно слово, пробел обрезает до первого токена", () => {
  assert.strictEqual(cleanWord("банан киви"), "банан");
  assert.strictEqual(cleanWord("  манго  "), "манго");
  assert.strictEqual(cleanWord(""), "");
  assert.strictEqual(cleanWord("   "), "");
  assert.ok(cleanWord("а".repeat(100)).length <= 24);
});

// ---------- кластеризация ----------

test("clusterAnswers: все в одном кластере (точные совпадения после нормализации)", () => {
  const clusters = clusterAnswers({ a: "Банан", b: "банан", c: "БАНАН!", d: "  банан  " });
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].count, 4);
  assert.deepStrictEqual(new Set(clusters[0].players), new Set(["a", "b", "c", "d"]));
});

test("clusterAnswers: N разных кластеров — каждый ответ уникален", () => {
  const clusters = clusterAnswers({ a: "банан", b: "киви", c: "манго", d: "ананас" });
  assert.strictEqual(clusters.length, 4);
  for (const c of clusters) assert.strictEqual(c.count, 1);
});

test("clusterAnswers: ё/е свёрнуты, пустые и null ответы не попадают в кластеры", () => {
  const clusters = clusterAnswers({ a: "ёж", b: "еж", c: null, d: "", e: "   " });
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].count, 2);
});

test("clusterAnswers: порядок — по убыванию count, затем по первому появлению", () => {
  const clusters = clusterAnswers({ a: "один", b: "два", c: "два", d: "три", e: "три", f: "три" });
  assert.strictEqual(clusters[0].key, "три");
  assert.strictEqual(clusters[0].count, 3);
  assert.strictEqual(clusters[1].key, "два");
  assert.strictEqual(clusters[2].key, "один");
});

// ---------- очки ----------

test("scorePopular: очки = count совпавшего кластера, 0 при несовпадении", () => {
  const clusters = clusterAnswers({ a: "банан", b: "банан", c: "банан", d: "киви" });
  assert.strictEqual(scorePopular("банан", clusters), 3);
  assert.strictEqual(scorePopular("БАНАН", clusters), 3); // регистр не важен
  assert.strictEqual(scorePopular("киви", clusters), 1);
  assert.strictEqual(scorePopular("ананас", clusters), 0); // не совпало ни с одним реальным ответом
  assert.strictEqual(scorePopular("", clusters), 0);
});

test("scoreRare: очки = N − count совпавшего кластера, 0 при несовпадении; угадать уникальный даёт N−1", () => {
  const answers = { a: "банан", b: "банан", c: "банан", d: "киви" };
  const clusters = clusterAnswers(answers);
  const n = Object.keys(answers).length; // N = 4
  assert.strictEqual(scoreRare("киви", clusters, n), n - 1); // уникальный ответ — максимум раунда
  assert.strictEqual(scoreRare("банан", clusters, n), n - 3);
  assert.strictEqual(scoreRare("ананас", clusters, n), 0); // не совпало
  assert.strictEqual(scoreRare("", clusters, n), 0);
});

test("matchCluster: находит кластер по нормализованному guess, иначе null", () => {
  const clusters = clusterAnswers({ a: "Ёлка", b: "елка" });
  assert.ok(matchCluster("ЁЛКА", clusters));
  assert.strictEqual(matchCluster("сосна", clusters), null);
  assert.strictEqual(matchCluster("", clusters), null);
});

// ---------- утечки до раскрытия ----------

test("снимок игрока: до раскрытия не видно чужих ответов темы и чужих guess'ов", () => {
  const { g, ids } = makeGame(3);
  g.start(0);
  for (const id of ids) g.answer(id, "слово" + id, 1000);
  // фаза перешла в guessPopular, но ещё не reveal
  assert.strictEqual(g.s.phase, "guessPopular");
  for (const id of ids) {
    const snap = g.snapshot(2000, id);
    assert.strictEqual(snap.round.clusters, undefined);
    assert.strictEqual(snap.round.n, undefined);
    // свой ответ темы виден только если угадывание ещё не раскрыто — но чужие точно не передаются ни в каком поле
    const raw = JSON.stringify(snap);
    for (const otherId of ids) {
      if (otherId === id) continue;
      assert.ok(!raw.includes("слово" + otherId), `чужой ответ ${otherId} утёк в снимок ${id}`);
    }
  }
  const board = g.snapshot(2000, "board");
  assert.strictEqual(board.round.clusters, undefined);
  for (const id of ids) assert.ok(!JSON.stringify(board).includes("слово" + id));
});

test("снимок игрока: во время guessRare не видно чужих guessPopular", () => {
  const { g, ids } = makeGame(3);
  g.start(0);
  for (const id of ids) g.answer(id, "а" + id, 1000);
  for (const id of ids) g.guessPopular(id, "уникальное" + id, 2000);
  assert.strictEqual(g.s.phase, "guessRare");
  for (const id of ids) {
    const raw = JSON.stringify(g.snapshot(3000, id));
    for (const otherId of ids) {
      if (otherId === id) continue;
      assert.ok(!raw.includes("уникальное" + otherId));
    }
  }
});

test("после reveal кластеры и очки раскрываются всем одинаково", () => {
  const { g, ids } = makeGame(4);
  g.start(0);
  // два игрока пишут «банан», два — разное
  g.answer(ids[0], "банан", 1000);
  g.answer(ids[1], "банан", 1000);
  g.answer(ids[2], "киви", 1000);
  g.answer(ids[3], "манго", 1000);
  for (const id of ids) g.guessPopular(id, "банан", 2000);
  for (const id of ids) g.guessRare(id, "киви", 3000);
  assert.strictEqual(g.s.phase, "reveal");
  const board = g.snapshot(4000, "board");
  assert.strictEqual(board.round.n, 4);
  assert.strictEqual(board.round.clusters.find((c) => c.key === "банан").count, 2);
  for (const id of ids) {
    assert.strictEqual(board.round.popularPts[id], 2); // «банан» — кластер из 2
    assert.strictEqual(board.round.rarePts[id], 4 - 1); // «киви» — уникален, N−1 = 3
  }
});

// ---------- таймеры (через внедрённые часы) ----------

test("фаза answer закрывается досрочно, когда ответили все подключённые", () => {
  const { g, ids } = makeGame(3);
  g.start(0);
  assert.strictEqual(g.s.phase, "answer");
  g.answer(ids[0], "один", 100);
  g.answer(ids[1], "два", 200);
  assert.strictEqual(g.s.phase, "answer"); // третий ещё не ответил
  g.answer(ids[2], "три", 300);
  assert.strictEqual(g.s.phase, "guessPopular"); // все ответили — фаза закрылась без ожидания T.answer
});

test("tick(now) закрывает фазу по истечении таймера, даже если не все ответили", () => {
  const { g, ids } = makeGame(3);
  g.start(0);
  const deadline = g.nextDeadline();
  assert.ok(deadline != null);
  g.answer(ids[0], "один", 100);
  const events = g.tick(deadline + 1);
  assert.strictEqual(g.s.phase, "guessPopular");
  assert.ok(events.some((e) => e.type === "guessPopular"));
});

test("offline-игрок не блокирует закрытие фазы (readyToClose считает только подключённых)", () => {
  const { g, ids } = makeGame(3);
  g.start(0);
  g.setOnline(ids[2], false, 50);
  g.answer(ids[0], "один", 100);
  g.answer(ids[1], "два", 200);
  assert.strictEqual(g.s.phase, "guessPopular"); // третий офлайн — не ждём его
});

test("nextDeadline null в lobby и finished", () => {
  const { g } = makeGame(2);
  assert.strictEqual(g.nextDeadline(), null);
  g.start(0);
  assert.notStrictEqual(g.nextDeadline(), null);
});

// ---------- партия: раунды, вращение тем без повторов ----------

test("партия идёт settings.rounds раундов и завершается", () => {
  const { g, ids } = makeGame(3, { settings: { rounds: 4 } });
  g.start(0);
  let t = 1000;
  for (let round = 0; round < 4; round++) {
    assert.strictEqual(g.s.phase, "answer");
    for (const id of ids) g.answer(id, "слово" + round, t++);
    for (const id of ids) g.guessPopular(id, "слово" + round, t++);
    for (const id of ids) g.guessRare(id, "слово" + round, t++);
    assert.strictEqual(g.s.phase, "reveal");
    g.tick(g.nextDeadline() + 1); // reveal → scores
    assert.strictEqual(g.s.phase, "scores");
    g.tick(g.nextDeadline() + 1); // scores → следующий раунд или finished
  }
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "done");
});

test("темы раунда не повторяются в партии, пока банк не пройден (меньше тем, чем раундов)", () => {
  const small = [{ id: "x1", topic: "Тема 1" }, { id: "x2", topic: "Тема 2" }, { id: "x3", topic: "Тема 3" }, { id: "x4", topic: "Тема 4" }];
  const content = { ru: small, en: small, el: small };
  const { g, ids } = makeGame(2, { settings: { rounds: 6 }, content });
  const started = g.start(0);
  assert.ok(started.ok, JSON.stringify(started));
  const seenFirstPass = [];
  let t = 1000;
  for (let round = 0; round < 4; round++) {
    seenFirstPass.push(g.s.round.topic.id);
    for (const id of ids) g.answer(id, "а", t++);
    for (const id of ids) g.guessPopular(id, "а", t++);
    for (const id of ids) g.guessRare(id, "а", t++);
    g.tick(g.nextDeadline() + 1);
    g.tick(g.nextDeadline() + 1);
  }
  // первые 4 раунда — все четыре темы без повторов
  assert.strictEqual(new Set(seenFirstPass).size, 4);
  // раунд 5: банк пройден — партия продолжается, тема выбирается заново (не падает, не зависает в null)
  assert.ok(small.some((x) => x.id === g.s.round.topic.id));
});

test("две темы не совпадают подряд внутри одной партии при достаточном банке", () => {
  const { g } = makeGame(3, { settings: { rounds: 8 } });
  g.start(0);
  const seen = [g.s.round.topic.id];
  let t = 1000;
  for (let round = 0; round < 7; round++) {
    const ids = g.present().map((p) => p.id);
    for (const id of ids) g.answer(id, "а", t++);
    for (const id of ids) g.guessPopular(id, "а", t++);
    for (const id of ids) g.guessRare(id, "а", t++);
    g.tick(g.nextDeadline() + 1);
    g.tick(g.nextDeadline() + 1);
    if (g.s.round) seen.push(g.s.round.topic.id);
  }
  assert.strictEqual(new Set(seen).size, seen.length, "темы раунда повторились: " + JSON.stringify(seen));
});

// ---------- угадывать можно свой собственный ответ (§2) ----------

test("свой ответ не исключается из кластеров и не исключён как цель угадывания", () => {
  const { g, ids } = makeGame(3);
  g.start(0);
  g.answer(ids[0], "слон", 100);
  g.answer(ids[1], "кит", 200);
  g.answer(ids[2], "кит", 300);
  // ids[1] угадывает свой собственный ответ как «популярное»
  g.guessPopular(ids[0], "кит", 400);
  g.guessPopular(ids[1], "кит", 400);
  g.guessPopular(ids[2], "слон", 400);
  g.guessRare(ids[0], "слон", 500);
  g.guessRare(ids[1], "слон", 500);
  g.guessRare(ids[2], "слон", 500);
  const board = g.snapshot(600, "board");
  assert.strictEqual(board.round.popularPts[ids[1]], 2); // угадал свой «кит» — кластер из 2
  assert.strictEqual(board.round.popularPts[ids[2]], 1); // угадал «слон» — кластер из 1
});

// ---------- защита базовых правил join/leave ----------

test("addPlayer: имена чистятся и ограничены длиной, дубли id идемпотентны", () => {
  const { g } = makeGame(1);
  const r1 = g.addPlayer({ id: "p0", name: "Игрок0", now: 0 });
  assert.strictEqual(r1.player.id, "p0");
  const r2 = g.addPlayer({ id: "new", name: "  Длинное Имя Которое Обрежется  ", now: 0 });
  assert.ok(r2.ok);
  assert.ok(r2.player.name.length <= 15);
});

test("removePlayer в lobby убирает запись совсем; посреди партии помечает left", () => {
  const { g, ids } = makeGame(3);
  g.removePlayer(ids[0], 0);
  assert.strictEqual(g.s.players.length, 2);
  const { g: g2, ids: ids2 } = makeGame(3);
  g2.start(0);
  g2.removePlayer(ids2[0], 100);
  assert.strictEqual(g2.player(ids2[0]).left, true);
});

test("меньше MIN_PLAYERS посреди партии — партия завершается", () => {
  const { g, ids } = makeGame(2);
  g.start(0);
  g.removePlayer(ids[0], 100);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "few");
});

// ---------- settings ----------

test("clampSettings: ограничивает rounds и lang", () => {
  const { clampSettings } = require("./game");
  assert.strictEqual(clampSettings({ rounds: 100 }).rounds, 16);
  assert.strictEqual(clampSettings({ rounds: 1 }).rounds, 4);
  assert.strictEqual(clampSettings({ lang: "fr" }).lang, "ru");
  assert.strictEqual(clampSettings({ lang: "en" }).lang, "en");
  assert.strictEqual(clampSettings(null).rounds, 8);
});

test("cleanName через игру: обрезает и чистит управляющие символы", () => {
  assert.strictEqual(cleanName("Максим\u0007"), "Максим");
  assert.ok(cleanName("a".repeat(100)).length <= 15);
});

// ---------- нормализация: диакритика, греческий, эмодзи (QA 18.10) ----------

test("normalizeWord: греческие тоны/диалитика/финальная сигма и латинские акценты не разводят ответы", () => {
  assert.strictEqual(normalizeWord("Μήλο"), normalizeWord("μηλο"));
  assert.strictEqual(normalizeWord("ΜΗΛΟ"), normalizeWord("μήλο"));
  assert.strictEqual(normalizeWord("ΟΔΟΣ"), normalizeWord("οδός"));
  assert.strictEqual(normalizeWord("οδοσ"), normalizeWord("οδός")); // σ в конце, набранная вручную
  assert.strictEqual(normalizeWord("ΐ"), normalizeWord("ι"));
  assert.strictEqual(normalizeWord("Café"), normalizeWord("cafe"));
  assert.notStrictEqual(normalizeWord("μήλο"), normalizeWord("μάλο")); // разные буквы остаются разными
});

test("normalizeWord: в кириллице знаки значимы — й ≠ и, но ё = е; в разложенном виде тоже", () => {
  assert.notStrictEqual(normalizeWord("мой"), normalizeWord("мои"));
  assert.strictEqual(normalizeWord("Ёлка"), normalizeWord("елка"));
  assert.strictEqual(normalizeWord("Ёлка"), normalizeWord("Ёлка")); // ё как е + диерезис
  assert.strictEqual(normalizeWord("мой"), normalizeWord("мой"));
});

test("normalizeWord: эмодзи — это ответ, а не знак препинания; знаки вокруг снимаются", () => {
  assert.strictEqual(normalizeWord("🍎"), "🍎");
  assert.strictEqual(normalizeWord("🍎!!!"), "🍎");
  assert.strictEqual(normalizeWord("👍🏽"), normalizeWord("👍")); // тон кожи не разводит
  assert.strictEqual(normalizeWord("!!!"), "");
  assert.strictEqual(normalizeWord("…"), "");
});

test("answer/guess: только знаки препинания — bad_word (не засчитывается молчаливым «пустым» ответом)", () => {
  const { g, ids } = makeGame(2);
  g.start(0);
  assert.deepStrictEqual(g.answer(ids[0], "!!!", 1), { ok: false, reason: "bad_word" });
  assert.deepStrictEqual(g.answer(ids[0], "   ", 1), { ok: false, reason: "bad_word" });
  assert.ok(g.answer(ids[0], "🍎", 1).ok); // эмодзи принимается
  assert.ok(g.answer(ids[1], "яблоко", 2).ok);
  assert.strictEqual(g.s.phase, "guessPopular");
  assert.deepStrictEqual(g.guessPopular(ids[0], "…", 3), { ok: false, reason: "bad_word" });
  assert.ok(g.guessPopular(ids[0], "🍎", 3).ok);
});

test("очки: кластер по греческому с тонами, угадывание без тонов совпадает", () => {
  const { g, ids } = makeGame(3, { settings: { lang: "el" } });
  g.start(0);
  g.answer(ids[0], "Μήλο", 1); g.answer(ids[1], "μηλο", 1); g.answer(ids[2], "αχλάδι", 1);
  assert.strictEqual(g.s.round.clusters[0].count, 2);
  for (const id of ids) g.guessPopular(id, "ΜΗΛΟ", 2);
  for (const id of ids) g.guessRare(id, "αχλαδι", 3);
  assert.strictEqual(g.s.phase, "reveal");
  assert.strictEqual(g.s.round.result.popularPts[ids[0]], 2);
  assert.strictEqual(g.s.round.result.rarePts[ids[0]], 2); // N=3, count=1
});

test("N — число ответивших: молчун не входит в N и не ломает очки раунда", () => {
  const { g, ids } = makeGame(4);
  g.start(0);
  g.answer(ids[0], "банан", 1); g.answer(ids[1], "банан", 1); g.answer(ids[2], "киви", 1);
  g.tick(20000); // ids[3] промолчал — фаза закрылась по таймеру
  assert.strictEqual(g.s.phase, "guessPopular");
  assert.strictEqual(g.s.round.n, 3);
  g.tick(40000); // никто не угадывал — по таймеру в guessRare, затем в reveal
  g.tick(60000);
  assert.strictEqual(g.s.phase, "reveal");
  for (const id of ids) assert.strictEqual(g.player(id).score, 0);
});

test("никто не ответил: фазы угадывания пропускаются, раунд идёт дальше без очков", () => {
  const { g, ids } = makeGame(3);
  g.start(0);
  g.tick(20000); // все молчат до таймера
  assert.strictEqual(g.s.phase, "reveal");
  assert.strictEqual(g.s.round.n, 0);
  assert.deepStrictEqual(g.s.round.clusters, []);
  for (const id of ids) assert.strictEqual(g.player(id).score, 0);
  const snap = g.snapshot(20000, ids[0]); // снимок раскрытия без кластеров не падает
  assert.strictEqual(snap.round.clusters.length, 0);
  g.tick(g.s.phaseEnd); // reveal → scores
  assert.strictEqual(g.s.phase, "scores");
  g.tick(g.s.phaseEnd); // scores → следующий раунд
  assert.strictEqual(g.s.phase, "answer");
  assert.strictEqual(g.s.round.num, 2);
});
