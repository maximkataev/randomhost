"use strict";

// Тесты движка «Вопроса ребром»: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const { Game, T, ROUNDS, POINTS, WIN_BONUS, SWEEP_BONUS, clampSettings, cleanText } = require("./game");
const { normalize, normalizeList } = require("./normalize");

// Детерминированная случайность: простой LCG
function rig(seed = 1) {
  let x = seed;
  return (n) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % n;
  };
}

// маленькая колода: по 30 карточек, у каждой 6 подсказок
function fixture() {
  const lang = {
    duel: Array.from({ length: 30 }, (_, i) => ({ id: "d" + i, q: "Вопрос " + i, h: Array.from({ length: 6 }, (_, j) => `подсказка ${i}.${j}`) })),
    emoji: Array.from({ length: 30 }, (_, i) => ({ id: "e" + i, e: "🐧🏦" + i, h: Array.from({ length: 6 }, (_, j) => `подпись ${i}.${j}`) })),
    final: Array.from({ length: 30 }, (_, i) => ({ id: "f" + i, q: "Три вещи " + i, h: Array.from({ length: 5 }, (_, j) => [`раз ${i}.${j}`, `два ${i}.${j}`, `три ${i}.${j}`]) })),
  };
  return { ru: lang, en: lang, el: lang };
}

const names = (n) => Array.from({ length: n }, (_, i) => "P" + (i + 1));

function game(n = 5, settings = {}, rnd = rig()) {
  const g = Game.create({ settings, code: "TEST22", rnd, content: fixture() });
  names(n).forEach((id) => assert.ok(g.addPlayer({ id, name: id }).ok));
  const r = g.start(0);
  assert.ok(r.ok, r.reason);
  assert.strictEqual(g.s.phase, "intro");
  g.tick(T.intro);
  assert.strictEqual(g.s.phase, "answer");
  return g;
}

// все отвечают руками уникальными текстами
let uniq = 0;
function answerAll(g, now = T.intro + 1000) {
  for (const m of g.s.matchups) {
    for (const id of m.authors) {
      if (m.answers[id]) continue;
      const ans = m.deck === "final" ? [`a${++uniq}`, `b${uniq}`, `c${uniq}`] : `ответ ${++uniq} ${id}`;
      const r = g.answer(id, m.id, ans, now);
      assert.ok(r.ok, r.reason);
    }
  }
}

test("нормализация: регистр, ё, падежи, пунктуация", () => {
  assert.strictEqual(normalize("Кота в мешке"), normalize("КОТ, в мешке!"));
  assert.strictEqual(normalize("Ёлки"), normalize("елка"));
  assert.strictEqual(normalize("бегущего человека"), normalize("Бегущий человек"));
  assert.strictEqual(normalize("The CATS"), normalize("the cat"));
  assert.strictEqual(normalize("Γάτες"), normalize("γάτα"));
  assert.notStrictEqual(normalize("кот"), normalize("код"));
  assert.notStrictEqual(normalize("кот в мешке"), normalize("мешок в коте")); // порядок слов важен
  assert.strictEqual(normalizeList(["Кот", "пёс", "мышь"]), normalizeList(["мыши", "кота", "пес"])); // в финале — как множество
});

test("чистка текста: управляющие символы, пробелы, длина", () => {
  assert.strictEqual(cleanText("  a\u200b\u202eb \n\t c  ", 80), "ab c");
  assert.strictEqual(cleanText("x".repeat(200), 80).length, 80);
  assert.strictEqual(Array.from(cleanText("😂".repeat(100), 80)).length, 80);
  // невидимые «буквы»: имя из одних заполнителей — пустое
  assert.strictEqual(cleanText("\u3164\u3164\u115f\u2060\u00ad\uffa0\u061c", 16), "");
  assert.strictEqual(cleanText("Ан\u2060я\u3164", 16), "Аня");
});

test("настройки: подсказки 1–3, короткая партия, язык", () => {
  assert.deepStrictEqual(clampSettings({ hints: 9, short: "yes", lang: "xx" }), { hints: 2, short: false, lang: "ru" });
  assert.deepStrictEqual(clampSettings({ hints: 3, short: true, lang: "el" }), { hints: 3, short: true, lang: "el" });
});

test("нужно минимум 3 игрока", () => {
  const g = Game.create({ rnd: rig(), content: fixture() });
  g.addPlayer({ id: "a", name: "a" });
  g.addPlayer({ id: "b", name: "b" });
  assert.strictEqual(g.start(0).reason, "few_players");
});

test("дуэли при 5+: каждый ровно в двух схватках, пары не повторяются, у схватки ровно двое", () => {
  for (const n of [5, 6, 9, 16]) {
    const g = game(n);
    assert.strictEqual(g.s.matchups.length, n);
    const cnt = {};
    const pairs = new Set();
    for (const m of g.s.matchups) {
      assert.strictEqual(m.kind, "duel");
      assert.strictEqual(m.authors.length, 2);
      assert.notStrictEqual(m.authors[0], m.authors[1]);
      const key = m.authors.slice().sort().join("-");
      assert.ok(!pairs.has(key), "пара повторилась: " + key);
      pairs.add(key);
      for (const a of m.authors) cnt[a] = (cnt[a] || 0) + 1;
    }
    for (const id of names(n)) assert.strictEqual(cnt[id], 2);
    // вопросы разные
    assert.strictEqual(new Set(g.s.matchups.map((m) => m.prompt.q)).size, n);
    // на ответы — 20 с на каждый из двух вопросов
    assert.strictEqual(g.s.phaseEnd - g.s.phaseStart, ROUNDS.duel.answerMs * 2);
  }
});

test("3–4 игрока: первый раунд — два вопроса на всех", () => {
  for (const n of [3, 4]) {
    const g = game(n);
    assert.strictEqual(g.s.matchups.length, 2);
    for (const m of g.s.matchups) {
      assert.strictEqual(m.kind, "grid");
      assert.strictEqual(m.authors.length, n);
    }
  }
});

test("ответы: чужой вопрос, повтор, пустой, после звонка — отклонены", () => {
  const g = game(5);
  const m = g.s.matchups[0];
  const stranger = g.s.roster.find((id) => !m.authors.includes(id));
  assert.strictEqual(g.answer(stranger, m.id, "x", 5000).reason, "not_yours");
  assert.strictEqual(g.answer(m.authors[0], m.id, "   ", 5000).reason, "empty");
  assert.ok(g.answer(m.authors[0], m.id, "хорошо", 5000).ok);
  assert.strictEqual(g.answer(m.authors[0], m.id, "ещё", 5000).reason, "answered");
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "vote");
  assert.strictEqual(g.answer(m.authors[1], m.id, "поздно", g.s.phaseStart).reason, "not_answer");
});

test("подсказка: лимит на партию, сменить нельзя, одинаковые двоим не выпадают", () => {
  const g = game(3, { hints: 1 });
  const [m1, m2] = g.s.matchups;
  const p = g.s.roster[0];
  const r = g.hint(p, m1.id, 5000);
  assert.ok(r.ok, r.reason);
  assert.ok(m1.answers[p].hint);
  assert.strictEqual(g.hint(p, m1.id, 5000).reason, "answered");
  assert.strictEqual(g.hint(p, m2.id, 5000).reason, "no_hints");
  // остальные берут подсказки к тому же вопросу — все разные
  const g2 = game(6, { hints: 3 }, rig(7));
  const grid = g2.s.matchups[0];
  const texts = new Set();
  for (const id of grid.authors) { assert.ok(g2.hint(id, grid.id, 5000).ok); texts.add(grid.answers[id].text); }
  assert.strictEqual(texts.size, grid.authors.length);
});

test("не успел: автоподсказка 🐌, лимит не тратит, пустых мест нет", () => {
  const g = game(5, { hints: 2 });
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "vote");
  for (const m of g.s.matchups) {
    for (const id of m.authors) {
      const a = m.answers[id];
      assert.ok(a && a.hint && a.late && a.text);
    }
  }
  for (const p of g.s.players) assert.strictEqual(p.hintsUsed, 0);
});

test("16 игроков в сетке: пула в 6 подсказок не хватает — добираем из колоды без повторов", () => {
  const g = game(16, { short: true });
  // проматываем дуэли
  answerAll(g);
  while (g.s.phase !== "intro") g.tick(g.s.phaseEnd);
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.plan[g.s.ri], "final");
  g.tick(g.s.phaseEnd); // никто не ответил
  const m = g.s.matchups[0];
  const keys = m.order.map((id) => m.answers[id].key);
  assert.strictEqual(new Set(keys).size, 16);
  assert.ok(m.order.every((id) => m.answers[id].items.length === 3));
});

test("досрочно: все ответили — сразу голосование; все проголосовали — сразу раскрытие", () => {
  const g = game(5);
  answerAll(g);
  assert.strictEqual(g.s.phase, "vote");
  const m = g.s.matchups[g.s.mi];
  for (const p of g.present()) {
    if (m.authors.includes(p.id)) continue;
    assert.ok(g.vote(p.id, m.id, [0], 9000).ok);
  }
  assert.strictEqual(g.s.phase, "reveal");
});

test("голоса: авторы дуэли не голосуют, за себя нельзя, лишние голоса нельзя, повтор нельзя", () => {
  const g = game(5);
  answerAll(g);
  const m = g.s.matchups[g.s.mi];
  assert.strictEqual(g.vote(m.authors[0], m.id, [0], 9000).reason, "author");
  const v = g.present().find((p) => !m.authors.includes(p.id)).id;
  assert.strictEqual(g.vote(v, m.id, [0, 1], 9000).reason, "bad_votes");
  assert.strictEqual(g.vote(v, m.id, [5], 9000).reason, "bad_votes");
  assert.strictEqual(g.vote(v, m.id + 1, [0], 9000).reason, "stale");
  assert.ok(g.vote(v, m.id, [1], 9000).ok);
  assert.strictEqual(g.vote(v, m.id, [0], 9000).reason, "voted");
  // сетка: за свой ответ нельзя
  const g3 = game(3);
  answerAll(g3);
  const gm = g3.s.matchups[g3.s.mi];
  const me = gm.order[0];
  assert.strictEqual(g3.vote(me, gm.id, [0], 9000).reason, "own");
  assert.ok(g3.vote(me, gm.id, [1], 9000).ok);
});

test("очки дуэли: голос = 100 × множитель, победа +100, разгром +250", () => {
  const g = game(6);
  answerAll(g);
  const m = g.s.matchups[g.s.mi];
  const voters = g.present().filter((p) => !m.authors.includes(p.id));
  const target = m.order[0];
  for (const p of voters) g.vote(p.id, m.id, [0], 9000); // все за первый — разгром
  assert.strictEqual(g.s.phase, "reveal");
  const r = m.result;
  assert.strictEqual(r.sweep, target);
  assert.strictEqual(r.points[0], voters.length * POINTS + SWEEP_BONUS);
  assert.strictEqual(r.points[1], 0);
  assert.strictEqual(g.player(target).score, voters.length * POINTS + SWEEP_BONUS);
  // следующая: голоса поровну — оба в победителях, но бонус только единоличному (иначе счёт слипается)
  g.tick(g.s.phaseEnd);
  const m2 = g.s.matchups[g.s.mi];
  const v2 = g.present().filter((p) => !m2.authors.includes(p.id));
  v2.forEach((p, i) => g.vote(p.id, m2.id, [i % 2], 9000));
  assert.strictEqual(m2.result.sweep, null);
  assert.deepStrictEqual(m2.result.points, [2 * POINTS, 2 * POINTS]);
});

test("джинкс: одинаковые с точностью до падежа — оба по нулям, дуэль без голосования", () => {
  const g = game(5);
  const m = g.s.matchups[0];
  g.answer(m.authors[0], m.id, "Кота в мешке", 5000);
  g.answer(m.authors[1], m.id, "кот в мешке!", 5000);
  answerAll(g);
  // первая схватка — это m; голосование пропущено
  assert.strictEqual(g.s.mi, 0);
  assert.strictEqual(g.s.phase, "reveal");
  assert.deepStrictEqual(m.result.points, [0, 0]);
  assert.strictEqual(m.result.jinx.length, 2);
});

test("джинкс в сетке: совпавшие по нулям, остальные считаются", () => {
  const g = game(4);
  const m = g.s.matchups[0];
  const [a, b, c, d] = m.authors;
  g.answer(a, m.id, "Бабушка на скейте", 5000);
  g.answer(b, m.id, "бабушки на скейтах", 5000);
  answerAll(g);
  assert.strictEqual(g.s.phase, "vote");
  const idx = (id) => m.order.indexOf(id);
  g.vote(c, m.id, [idx(a)], 9000);
  g.vote(d, m.id, [idx(a)], 9000);
  g.vote(a, m.id, [idx(c)], 9000);
  g.vote(b, m.id, [idx(c)], 9000);
  assert.strictEqual(g.s.phase, "reveal");
  assert.strictEqual(m.result.points[idx(a)], 0);
  assert.strictEqual(m.result.points[idx(b)], 0);
  assert.deepStrictEqual(m.result.winners, [c]);
  assert.strictEqual(m.result.points[idx(c)], 2 * POINTS + WIN_BONUS);
});

test("анонимность: до раскрытия ни авторов, ни 🎲 в снимках; пулы подсказок не уходят никогда", () => {
  const g = game(5);
  const m = g.s.matchups[0];
  g.hint(m.authors[0], m.id, 5000);
  answerAll(g);
  const check = (view) => {
    const snap = g.snapshot(9000, view);
    const txt = JSON.stringify(snap);
    assert.ok(!txt.includes('"pool"'), "пул утёк");
    assert.ok(!txt.includes('"key"'), "ключ утёк");
    if (snap.current) for (const a of snap.current.answers || []) {
      assert.ok(!("playerId" in a) && !("hint" in a) && !("late" in a), "автор утёк до раскрытия");
    }
    return snap;
  };
  const board = check("board");
  assert.strictEqual(board.phase, "vote");
  assert.strictEqual(board.current.answers.length, 2);
  // автор видит свой ответ отмеченным, чужой — нет
  const mine = check(m.authors[0]);
  assert.strictEqual(mine.current.answers.filter((a) => a.mine).length, 1);
  const other = check(g.s.roster.find((id) => !m.authors.includes(id)));
  assert.strictEqual(other.current.answers.filter((a) => a.mine).length, 0);
  // в фазе ответов подсказки других не видны
  const g2 = game(5);
  const m2 = g2.s.matchups[0];
  g2.hint(m2.authors[0], m2.id, 5000);
  const s2 = JSON.stringify(g2.snapshot(5000, m2.authors[1]));
  assert.ok(!s2.includes(m2.answers[m2.authors[0]].text));
  // после раскрытия — авторы есть
  const voters = g.present().filter((p) => !m.authors.includes(p.id));
  for (const p of voters) g.vote(p.id, m.id, [0], 9500);
  const after = g.snapshot(9600, "board");
  assert.ok(after.current.answers.every((a) => a.playerId));
  assert.ok(after.current.answers.some((a) => a.hint));
});

test("полная партия: интро → ответы → голоса → счёт → … → итоги, множители раундов", () => {
  const g = game(5);
  const seen = [];
  let guard = 0;
  while (g.s.phase !== "finished" && guard++ < 500) {
    if (!seen.includes(g.s.phase + ":" + g.s.ri)) seen.push(g.s.phase + ":" + g.s.ri);
    if (g.s.phase === "answer") answerAll(g, g.s.phaseStart + 100);
    else if (g.s.phase === "vote") {
      const m = g.s.matchups[g.s.mi];
      for (const p of g.present()) {
        if (m.votes[p.id] || (m.kind === "duel" && m.authors.includes(p.id))) continue;
        const pick = m.order.findIndex((id) => id !== p.id);
        g.vote(p.id, m.id, [pick], g.s.phaseStart + 100);
        if (g.s.phase !== "vote") break;
      }
    } else g.tick(g.s.phaseEnd);
  }
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "done");
  assert.deepStrictEqual(g.s.plan, ["duel", "emoji", "duel2", "final"]);
  assert.ok(seen.includes("answer:1") && seen.includes("answer:2") && seen.includes("answer:3"));
  const snap = g.snapshot(1e9, "board");
  assert.ok(snap.best && snap.best.votes > 0);
  assert.ok(g.s.players.some((p) => p.score > 0));
  // итоговые очки = сумма очков схваток
});

test("короткая партия — без эмодзи-сцены", () => {
  const g = game(3, { short: true });
  assert.deepStrictEqual(g.s.plan, ["duel", "final"]);
});

test("вопросы не повторяются в комнате, пока колода не пройдена", () => {
  const g = game(6);
  const seen = new Set(g.s.matchups.map((m) => m.prompt.q));
  g.abort(1);
  for (let i = 0; i < 3; i++) {
    g.start(10);
    g.tick(10 + T.intro);
    for (const m of g.s.matchups) { assert.ok(!seen.has(m.prompt.q), "повтор: " + m.prompt.q); seen.add(m.prompt.q); }
    g.abort(20);
  }
  assert.strictEqual(seen.size, 24);
  // 30 карточек — на пятой партии колода начинается заново, но внутри партии повторов нет
  g.start(30);
  g.tick(30 + T.intro);
  assert.strictEqual(new Set(g.s.matchups.map((m) => m.prompt.q)).size, 6);
});

test("вышел игрок: партия идёт, пока их хотя бы трое; меньше — конец", () => {
  const g = game(4);
  g.removePlayer("P1", 5000);
  assert.strictEqual(g.s.phase, "answer");
  g.removePlayer("P2", 5000);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "few");
});

test("вошёл посреди партии — голосует сразу, отвечает со следующего раунда", () => {
  const g = game(5);
  assert.ok(g.addPlayer({ id: "late", name: "late" }).ok);
  assert.ok(!g.s.roster.includes("late"));
  answerAll(g);
  const m = g.s.matchups[g.s.mi];
  assert.ok(g.snapshot(9000, "late").me.canVote);
  assert.ok(g.vote("late", m.id, [0], 9000).ok);
});

test("офлайн не держит фазу ответов", () => {
  const g = game(5);
  g.setOnline("P5", false, 5000);
  for (const m of g.s.matchups) for (const id of m.authors) if (id !== "P5") g.answer(id, m.id, "x " + id + m.id, 5000);
  assert.strictEqual(g.s.phase, "vote");
  const late = g.s.matchups.filter((m) => m.authors.includes("P5")).map((m) => m.answers.P5);
  assert.ok(late.every((a) => a.late));
});

test("реакции: только из списка и не чаще раза в 2 с", () => {
  const g = game(3);
  assert.ok(g.react("P1", "😂", 1000).ok);
  assert.strictEqual(g.react("P1", "😂", 2000).reason, "too_fast");
  assert.strictEqual(g.react("P1", "<b>", 5000).reason, "bad");
});

test("дамп и подъём: состояние — чистый JSON", () => {
  const g = game(5);
  answerAll(g);
  const copy = Game.from(JSON.parse(JSON.stringify(g.s)), rig(), fixture());
  assert.deepStrictEqual(copy.snapshot(9000, "board"), g.snapshot(9000, "board"));
});

test("вход-выход посреди партии не копит записи игроков; сыгравший остаётся «ушёл»", () => {
  const g = game(5);
  for (let i = 0; i < 500; i++) {
    assert.ok(g.addPlayer({ id: "churn" + i, name: "c" + i }).ok);
    g.removePlayer("churn" + i, 5000);
  }
  assert.strictEqual(g.s.players.length, 5, "мимолётные записи удалены целиком");
  // отвечавший в раунде уходит — запись остаётся (его ответы ещё раскрывать)
  g.removePlayer("P1", 5000);
  assert.ok(g.player("P1").left);
  // новая партия: ушедшие прошлой партии не переезжают
  g.abort(6000);
  assert.ok(g.start(7000).ok);
  assert.ok(!g.s.players.some((p) => p.left));
});

test("потолок записей об игроках: даже без удаления список не растёт бесконечно", () => {
  const { MAX_PLAYER_RECORDS } = require("./game");
  const g = game(3);
  for (let i = 0; i < MAX_PLAYER_RECORDS * 2; i++) {
    const r = g.addPlayer({ id: "x" + i, name: "x" + i });
    if (r.ok) g.player("x" + i).left = true; // как если бы ушёл сыгравший
  }
  assert.ok(g.s.players.length <= MAX_PLAYER_RECORDS);
  assert.strictEqual(g.addPlayer({ id: "y", name: "y" }).reason, "room_full");
});

test("посреди партии снимок не выдаёт, кто брал подсказку; в итогах — есть", () => {
  const g = game(5);
  const m = g.mine("P1")[0];
  assert.ok(g.hint("P1", m.id, 5000).ok);
  for (const view of ["board", "P2"]) {
    const raw = JSON.stringify(g.snapshot(5000, view).players);
    assert.ok(!/hintsUsed|"answered"|avgMs/.test(raw), "счётчики подсказок/ответов утекли в " + view);
  }
  g.abort(6000);
  const fin = g.snapshot(6000, "board").players.find((p) => p.id === "P1");
  assert.strictEqual(fin.hintsUsed, 1);
  assert.ok("avgMs" in fin);
});

test("второй круг дуэлей: пары не повторяют первый круг (5+ игроков), множитель ×2", () => {
  const g = game(6);
  const pairs = (gg) => new Set(gg.s.matchups.map((m) => m.authors.slice().sort().join("-")));
  const first = pairs(g);
  answerAll(g);
  while (!(g.s.phase === "answer" && g.s.plan[g.s.ri] === "duel2")) {
    if (g.s.phase === "answer") answerAll(g, g.s.phaseStart + 100);
    else g.tick(g.s.phaseEnd);
  }
  const second = pairs(g);
  for (const k of second) assert.ok(!first.has(k), "пара повторилась: " + k);
  assert.strictEqual(g.round().mult, 2);
});

test("мало игроков: в сетке голосов не больше половины чужих ответов", () => {
  const g = game(3, { short: true });
  answerAll(g);
  while (!(g.s.phase === "vote" && g.s.plan[g.s.ri] === "final")) {
    if (g.s.phase === "answer") answerAll(g, g.s.phaseStart + 100);
    else if (g.s.phase === "vote") { const m = g.s.matchups[g.s.mi]; for (const p of g.present()) if (!m.votes[p.id]) g.vote(p.id, m.id, [m.order.findIndex((x) => x !== p.id)], g.s.phaseStart + 1); }
    else g.tick(g.s.phaseEnd);
  }
  assert.strictEqual(g.s.matchups[g.s.mi].votesPer, 1);
});

test("черновик голоса засчитывается, когда голосование закрылось по таймеру", () => {
  const g = game(5);
  answerAll(g);
  const m = g.s.matchups[g.s.mi];
  const v = g.present().find((p) => !m.authors.includes(p.id)).id;
  assert.ok(g.vote(v, m.id, [1], 9000, true).ok);
  assert.strictEqual(g.s.phase, "vote");
  assert.ok(!m.votes[v]);
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "reveal");
  assert.strictEqual(m.result.tally[1], 1);
});

test("🐌 за полцены и без бонуса; финал — только три пункта", () => {
  const g = game(5);
  const m = g.s.matchups[0];
  const [a] = m.authors;
  // все ответили, кроме одного из авторов первой дуэли
  for (const x of g.s.matchups) for (const id of x.authors) if (!(x === m && id === a)) g.answer(id, x.id, "ответ " + id + x.id, 5000);
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.mi, 0);
  const idx = m.order.indexOf(a);
  for (const p of g.present()) if (!m.authors.includes(p.id)) g.vote(p.id, m.id, [idx], 50000);
  assert.strictEqual(m.result.points[idx], 3 * POINTS * 0.5);
  const f = game(3, { short: true });
  while (f.s.plan[f.s.ri] !== "final" || f.s.phase !== "answer") { if (f.s.phase === "answer") answerAll(f, f.s.phaseStart + 1); else if (f.s.phase === "vote") f.tick(f.s.phaseEnd); else f.tick(f.s.phaseEnd); }
  const fm = f.s.matchups[0];
  assert.strictEqual(f.answer(fm.authors[0], fm.id, ["раз", "два"], f.s.phaseStart + 1).reason, "need_three");
});
