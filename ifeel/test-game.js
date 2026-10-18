"use strict";

// Тесты движка «Айфилю»: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { Game, T, scoreQ, scoreTurn, kendall, cardKey, MIN_PLAYERS, missOf, worstQ } = require("./game");
const CONTENT = require("./content").load(path.join(__dirname, "content"), null);

// детерминированный ГСЧ: тесты повторяемы
function seeded(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

function mk(n, { seed = 1, mode = "safe", content = CONTENT } = {}) {
  const g = Game.create({ settings: { mode }, code: "TEST11", rnd: seeded(seed), content });
  for (let i = 0; i < n; i++) g.addPlayer({ id: "p" + i, name: "Игрок" + i, now: 0 });
  return g;
}
const ids = (g) => g.present().map((p) => p.id);
// случайная честная расстановка
const anyOrder = (rnd) => { const a = [0, 1, 2, 3, 4]; for (let i = 4; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// проходит фазы до нужной, отвечая за всех (кроме skip) — «боты»
function runToPhase(g, phase, now, opts = {}) {
  const rnd = seeded(opts.seed || 7);
  if (g.s.phase === "lobby") g.start(now);
  for (let guard = 0; guard < 400 && g.s.phase !== phase; guard++) now = step(g, now, rnd, opts);
  return now;
}
function step(g, now, rnd, { skipRank = [], skipAnswer = [], answerAll = true } = {}) {
  const s = g.s;
  const ph = s.phase, ti = s.round ? s.round.ti : null, qi = s.turn ? s.turn.qi : null;
  if (s.phase === "pick") { for (const id of s.round.cast) if (g.online(id)) g.choose(id, rnd(s.round.offers[id].length), now); }
  else if (s.phase === "write") {
    for (const [aid] of Object.entries(s.round.writes)) if (g.online(aid)) g.writeCards(aid, ["карта " + aid + " a", "карта " + aid + " b", "карта " + aid + " c"], now);
  } else if (s.phase === "rank") {
    for (const id of s.round.cast) if (g.online(id) && !skipRank.includes(id) && s.round.sets[id]) g.rank(id, anyOrder(rnd), now);
  } else if (s.phase === "ask" && answerAll) {
    const t = s.turn;
    const q = t.qs[t.qi];
    const ans = () => (q.kind === "pair" ? (rnd(2) ? q.a : q.b) : q.kind === "triple" ? anyOrder(rnd).filter((x) => q.items.includes(x)) : rnd(5));
    for (const id of t.guessers.slice()) if (!skipAnswer.includes(id) && s.phase === "ask" && s.turn === t) g.answer(id, t.qi, ans(), now);
  }
  if (s.phase === "lobby" || s.phase === "finished") return now;
  // действие само сменило фазу (или вопрос) — дальше решает вызывающий
  if (s.phase !== ph || (s.round ? s.round.ti : null) !== ti || (s.turn ? s.turn.qi : null) !== qi) return now;
  // всё, что не закрылось досрочно, закрывает таймер
  if (s.phaseEnd != null) { now = s.phaseEnd; g.tick(now); }
  return now;
}

// рекурсивно: есть ли где-то ключ из списка
function hasKey(obj, keys) {
  if (!obj || typeof obj !== "object") return false;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k)) return true;
    if (hasKey(v, keys)) return true;
  }
  return false;
}

// ---------- счёт ----------

test("вопрос 1: пара — 300 за верную сторону, 0 за неверную и без ответа", () => {
  const order = [3, 1, 4, 0, 2];
  const q = { kind: "pair", a: 4, b: 1 };
  assert.strictEqual(scoreQ(order, q, 1), 300);
  assert.strictEqual(scoreQ(order, q, 4), 0);
  assert.strictEqual(scoreQ(order, q, null), 0);
  assert.strictEqual(scoreQ(order, q, 2), 0); // не из пары
});

test("вопрос 2: «что на N-м месте» — точно 300, на одно место мимо 100, дальше 0 (решение владельца 18.10)", () => {
  const order = [3, 1, 4, 0, 2]; // пункт 3 — 1-е место, 1 — 2-е, 4 — 3-е, 0 — 4-е, 2 — 5-е
  assert.deepStrictEqual(order.map((x) => scoreQ(order, { kind: "place", n: 1 }, x)), [300, 100, 0, 0, 0]);
  assert.deepStrictEqual(order.map((x) => scoreQ(order, { kind: "place", n: 3 }, x)), [0, 100, 300, 100, 0]);
  assert.deepStrictEqual(order.map((x) => scoreQ(order, { kind: "place", n: 5 }, x)), [0, 0, 0, 100, 300]);
  assert.strictEqual(scoreQ(order, { kind: "place", n: 2 }, 7), 0);
  assert.strictEqual(scoreQ(order, { kind: "place", n: 2 }, null), 0);
  // вопросы старого вида из дампа комнаты считаются по тем же правилам
  assert.strictEqual(scoreQ(order, { kind: "first" }, 1), 100);
  assert.strictEqual(scoreQ(order, { kind: "last" }, 2), 300);
});

test("вопрос 3: тройка по Кендаллу 0→300, 1→200, 2→100, 3→0", () => {
  const order = [0, 1, 2, 3, 4];
  const q = { kind: "triple", items: [1, 3, 4] };
  assert.strictEqual(kendall(order, [1, 3, 4]), 0);
  assert.strictEqual(scoreQ(order, q, [1, 3, 4]), 300);
  assert.strictEqual(scoreQ(order, q, [3, 1, 4]), 200);
  assert.strictEqual(scoreQ(order, q, [3, 4, 1]), 100);
  assert.strictEqual(scoreQ(order, q, [4, 3, 1]), 0);
  assert.strictEqual(scoreQ(order, q, [1, 3, 3]), 0); // повтор — не ответ
  assert.strictEqual(scoreQ(order, q, [1, 2, 4]), 0); // не та тройка
});

test("наугад в среднем 150 / 92 / 150 = 392 за ход (§5): точный перебор по правилам выбора вопросов", () => {
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.filter((_, j) => j !== i)).map((p) => [x, ...p])));
  const all = perms([0, 1, 2, 3, 4]);
  let s1 = 0, s2 = 0, s3 = 0, n = 0;
  for (const order of all) {
    // В1: пара соседних мест, каждая из 4 поровну, ответ наугад — одна из двух
    for (let p = 0; p < 4; p++) {
      const q = { kind: "pair", a: order[p], b: order[p + 1] };
      s1 += (scoreQ(order, q, q.a) + scoreQ(order, q, q.b)) / 2 / 4;
    }
    // В2: место N из 1..5 поровну, ответ наугад — одна из пяти
    for (let k = 1; k <= 5; k++) for (let x = 0; x < 5; x++) s2 += scoreQ(order, { kind: "place", n: k }, x) / 25;
    s3 += perms([0, 2, 4]).reduce((a, p) => a + scoreQ(order, { kind: "triple", items: [0, 2, 4] }, p), 0) / 6;
    n++;
  }
  assert.deepStrictEqual([s1 / n, s2 / n, s3 / n].map(Math.round), [150, 92, 150]);
  assert.deepStrictEqual(scoreTurn([0, 1, 2, 3, 4], [{ kind: "pair", a: 0, b: 1 }, { kind: "place", n: 1 }, { kind: "triple", items: [2, 3, 4] }], [0, 0, [2, 3, 4]]), [300, 300, 300]);
});

// ---------- рассадка и пары ----------

for (let N = 3; N <= 8; N++) {
  test(`пары по рассадке, N=${N}: никто не угадывает себя, угадывающий ≠ автор, в R2 ≠ угадывающему из R1`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = mk(N, { seed });
      let now = 0;
      g.start(now);
      const r1 = g.s.round;
      assert.strictEqual(r1.cast.length, N);
      assert.deepStrictEqual(new Set(Object.values(r1.guess)).size, N, "каждый угадывает ровно раз");
      for (const t of r1.cast) assert.notStrictEqual(r1.guess[t], t);
      const r1g = { ...r1.guess };
      now = runToPhase(g, "write", now, { seed });
      const r2 = g.s.round;
      assert.strictEqual(r2.n, 2);
      assert.strictEqual(new Set(Object.values(r2.guess)).size, N);
      assert.strictEqual(new Set(Object.values(r2.author)).size, N, "каждый пишет ровно для одного");
      for (const t of r2.cast) {
        assert.notStrictEqual(r2.guess[t], t);
        assert.notStrictEqual(r2.author[t], t);
        assert.notStrictEqual(r2.guess[t], r2.author[t]);
        assert.notStrictEqual(r2.guess[t], r1g[t]);
      }
    }
  });
}

test("опоздавший встаёт в конец круга со второго раунда; пары пересчитаны и всё равно честные", () => {
  for (let N = 3; N <= 7; N++) {
    for (let seed = 1; seed <= 15; seed++) {
      const g = mk(N, { seed });
      let now = 0;
      g.start(now);
      const seatsR1 = g.s.seats.slice();
      const r1g = { ...g.s.round.guess };
      const late = g.addPlayer({ id: "late", name: "Опоздал", now: 1 });
      assert.ok(late.ok);
      assert.ok(!g.s.round.cast.includes("late"), "в раунде 1 опоздавшего нет");
      assert.strictEqual(g.snapshot(now, "late").me.inCast, false);
      now = runToPhase(g, "write", now, { seed });
      const r2 = g.s.round;
      assert.deepStrictEqual(r2.cast, seatsR1.concat(["late"]));
      for (const t of r2.cast) {
        assert.notStrictEqual(r2.guess[t], t);
        assert.notStrictEqual(r2.guess[t], r2.author[t]);
        if (r1g[t]) assert.notStrictEqual(r2.guess[t], r1g[t], `N=${N} seed=${seed}`);
      }
      assert.strictEqual(new Set(Object.values(r2.guess)).size, N + 1);
    }
  }
});

// ---------- тройки категорий ----------

test("тройки: без повторов в партии, в каждой ровно один «🎲» и хотя бы одна pref (решение владельца 18.10)", () => {
  for (const mode of ["safe", "edgy"]) {
    for (let seed = 1; seed <= 30; seed++) {
      const N = 3 + (seed % 8);
      const g = mk(N, { seed, mode });
      g.start(0);
      const offers = g.s.round.offers;
      const prefIds = new Set(g.cats().filter((c) => c.pref).map((c) => c.id));
      const seenIds = new Set();
      let rnd = 0;
      for (const id of g.s.round.cast) {
        const o = offers[id];
        assert.strictEqual(o.length, 3);
        const cats = o.filter((x) => x.kind === "cat");
        const r = o.filter((x) => x.kind === "rnd");
        assert.strictEqual(r.length, 1, "«🎲» — ровно один на тройку");
        rnd += r.length;
        assert.ok(cats.some((x) => prefIds.has(x.id)), "в тройке есть категория о предпочтениях");
        for (const c of cats) { assert.ok(!seenIds.has(c.id), "категория повторилась: " + c.id); seenIds.add(c.id); }
        for (const x of r) assert.ok(g.scales().some((sc) => "rnd:" + sc.id === x.id), "шкала «🎲» — из режима комнаты");
      }
      assert.strictEqual(rnd, N, `«🎲» в ${rnd} тройках из ${N}`);
      // шкалы «🎲» в партии не повторяются, пока их хватает
      const sc = g.s.round.cast.map((id) => offers[id].find((x) => x.kind === "rnd").id);
      assert.strictEqual(new Set(sc).size, Math.min(N, g.scales().length));
    }
  }
});

test("тройки: категорию, у которой ≥ 2 пункта уже встречались в партии, не предлагаем (пока банк позволяет)", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = mk(5, { seed, mode: seed % 2 ? "safe" : "edgy" });
    g.start(0);
    const byId = new Map(g.cats().map((c) => [c.id, c]));
    const seen = new Set();
    for (const id of g.s.round.cast) {
      const cats = g.s.round.offers[id].filter((x) => x.kind === "cat").map((x) => byId.get(x.id));
      for (const c of cats) {
        const n = c.items.filter((x) => seen.has(cardKey(x.t))).length;
        assert.ok(n < 2, `seed ${seed}: «${c.title}» — ${n} пунктов уже встречались`);
      }
      for (const c of cats) for (const x of c.items) seen.add(cardKey(x.t));
    }
  }
});

test("набор: 5 карточек, без повторов в партии; «🎲» — 5 вещей из общего пула", () => {
  const g = mk(6, { seed: 3 });
  g.start(0);
  const cast = g.s.round.cast;
  const rndPicker = cast.find((id) => g.s.round.offers[id].some((x) => x.kind === "rnd"));
  for (const id of cast) g.choose(id, rndPicker === id ? g.s.round.offers[id].findIndex((x) => x.kind === "rnd") : 0, 0);
  assert.strictEqual(g.s.phase, "rank");
  const keys = [];
  for (const id of cast) {
    const set = g.s.round.sets[id];
    assert.strictEqual(set.items.length, 5);
    keys.push(...set.items.map((x) => cardKey(x.t)));
  }
  assert.strictEqual(new Set(keys).size, keys.length, "карточки не повторяются между наборами");
  const pool = new Set(g.pool().map((x) => cardKey(x.t)));
  const rs = g.s.round.sets[rndPicker];
  assert.strictEqual(rs.kind, "rnd");
  assert.ok(rs.items.every((x) => pool.has(cardKey(x.t))));
});

test("не выбрал категорию — берётся первая; выбор фазу закрывает досрочно", () => {
  const g = mk(4, { seed: 5 });
  g.start(0);
  const cast = g.s.round.cast;
  g.choose(cast[0], 2, 100);
  g.choose(cast[1], 1, 100);
  assert.strictEqual(g.s.phase, "pick");
  g.setOnline(cast[3], false, 200);
  g.choose(cast[2], 0, 300);
  assert.strictEqual(g.s.phase, "rank", "все на связи выбрали — дальше");
  const first = g.s.round.offers[cast[3]][0];
  assert.strictEqual(g.s.round.sets[cast[3]].title, first.title);
});

// ---------- раунд 2: карточки и вето ----------

test("R2: {name} подставлен; карточки 1–40 знаков, без ссылок, HTML и повторов; недописанное — из пула", () => {
  const g = mk(4, { seed: 9 });
  let now = runToPhase(g, "write", 0);
  const [author, w] = Object.entries(g.s.round.writes)[0];
  const tname = g.player(w.target).name;
  assert.ok(w.prompt.text.includes(tname) && !w.prompt.text.includes("{name}"), w.prompt.text);
  assert.strictEqual(g.writeCards(author, ["https://x.ru"], now).reason, "bad_card");
  assert.strictEqual(g.writeCards(author, ["зайди на site.com"], now).reason, "bad_card");
  assert.strictEqual(g.writeCards(author, ["<b>жирно</b>"], now).reason, "bad_card");
  assert.strictEqual(g.writeCards(author, ["Кот", "кот!"], now).reason, "dup");
  assert.strictEqual(g.writeCards(author, ["x".repeat(41)], now).reason, "too_long");
  assert.strictEqual(g.writeCards(author, ["", " "], now).reason, "empty");
  assert.ok(g.writeCards(author, ["Кот", "", "Ёжик в тумане"], now).ok);
  assert.ok(g.writeCards(author, ["Кот", "", "Ёжик в тумане"], now).noop, "повтор той же отправки — noop");
  assert.strictEqual(g.writeCards(author, ["Другое"], now).reason, "sent");
  now = g.s.phaseEnd;
  g.tick(now);
  assert.strictEqual(g.s.phase, "rank");
  const set = g.s.round.sets[w.target];
  assert.strictEqual(set.items.length, 5);
  const texts = set.items.map((x) => x.t);
  assert.ok(texts.includes("Кот") && texts.includes("Ёжик в тумане"));
  assert.strictEqual(new Set(texts.map(cardKey)).size, 5);
  // автор пропал — все пять из пула подсказки
  const other = Object.values(g.s.round.writes).find((x) => !x.cards);
  assert.ok(g.s.round.sets[other.target].items.every((x) => other.prompt.examples.includes(x.t) || g.pool().some((p) => p.t === x.t)));
});

test("вето: одна карточка, на новую, один раз; повтор с тем же aid — noop; доска не знает, какая", () => {
  const g = mk(4, { seed: 11 });
  let now = runToPhase(g, "rank", runToPhase(g, "write", 0));
  assert.strictEqual(g.s.round.n, 2);
  const t = g.s.round.cast[0];
  const before = g.s.round.sets[t].items.map((x) => x.t);
  const r = g.veto(t, 2, "a1", now);
  assert.ok(r.ok);
  const after = g.s.round.sets[t].items.map((x) => x.t);
  assert.notStrictEqual(after[2], before[2]);
  assert.deepStrictEqual(after.filter((_, i) => i !== 2), before.filter((_, i) => i !== 2));
  assert.ok(!before.map(cardKey).includes(cardKey(after[2])));
  assert.ok(g.veto(t, 2, "a1", now).noop);
  assert.strictEqual(g.veto(t, 1, "a2", now).reason, "veto_used");
  const b = g.snapshot(now, "board");
  assert.deepStrictEqual(b.round.vetoed, [t]);
  assert.ok(!JSON.stringify(b).includes(after[2]), "доска не видит новую карточку до хода");
  const author = g.s.round.author[t];
  assert.ok(!JSON.stringify(g.snapshot(now, author)).includes(after[2]), "автор тоже");
  assert.strictEqual(g.snapshot(now, t).me.veto.used, true);
  // в раунде 1 вето нет
  const g1 = mk(4, { seed: 2 });
  runToPhase(g1, "rank", 0);
  assert.strictEqual(g1.veto(g1.s.round.cast[0], 0, "x", 0).reason, "no_veto");
});

test("расстановка: только полная перестановка; повтор — noop; другая — отказ; все готовы — дальше", () => {
  const g = mk(3, { seed: 4 });
  let now = runToPhase(g, "rank", 0);
  const [a, b, c] = g.s.round.cast;
  assert.strictEqual(g.rank(a, [0, 1, 2, 3], now).reason, "bad_order");
  assert.strictEqual(g.rank(a, [0, 1, 2, 3, 3], now).reason, "bad_order");
  assert.ok(g.rank(a, [4, 3, 2, 1, 0], now).ok);
  assert.ok(g.rank(a, [4, 3, 2, 1, 0], now).noop);
  assert.strictEqual(g.rank(a, [0, 1, 2, 3, 4], now).reason, "ranked");
  g.rank(b, [0, 1, 2, 3, 4], now);
  assert.strictEqual(g.s.phase, "rank");
  g.rank(c, [0, 1, 2, 3, 4], now);
  assert.strictEqual(g.s.phase, "tintro");
});

// ---------- ходы ----------

test("ход: 3 вопроса, отвечает только угадывающий, зрители — нет; вопрос закрывается ответом G; очки на раскрытии", () => {
  const g = mk(4, { seed: 21 });
  let now = runToPhase(g, "tintro", 0);
  const t = g.s.turn;
  const pair = [t.qs[0].a, t.qs[0].b];
  const order = g.s.round.orders[t.target];
  assert.strictEqual(Math.abs(order.indexOf(pair[0]) - order.indexOf(pair[1])), 1, "в паре — соседние места мишени");
  assert.ok(!(t.qs[2].items.includes(pair[0]) && t.qs[2].items.includes(pair[1])), "тройка не совпадает с парой целиком");
  assert.strictEqual(t.qs[1].kind, "place");
  assert.ok(t.qs[1].n >= 1 && t.qs[1].n <= 5);
  assert.ok(!("hall" in t), "зала нет");
  now = g.s.phaseEnd; g.tick(now);
  assert.strictEqual(g.s.phase, "ask");
  const G = t.guessers[0];
  const watchers = g.watcherIds();
  assert.ok(watchers.length > 0 && !watchers.includes(G) && !watchers.includes(t.target));
  assert.strictEqual(g.answer(t.target, 0, pair[0], now).reason, "target");
  assert.strictEqual(g.answer(watchers[0], 0, pair[0], now).reason, "not_guesser", "зритель не отвечает");
  assert.strictEqual(g.snapshot(now, watchers[0]).me.role, "watch");
  assert.strictEqual(g.snapshot(now, watchers[0]).me.answered, undefined, "у зрителя нет кнопок ответа");
  const best = order.indexOf(pair[0]) < order.indexOf(pair[1]) ? pair[0] : pair[1];
  const scoreBefore = g.player(G).score;
  g.answer(G, 0, best, now);
  assert.strictEqual(g.s.turn.qi, 1, "ответ G закрывает вопрос");
  assert.strictEqual(g.answer(G, 0, best, now).reason, "q_closed", "чужой (прошлый) вопрос отвергается");
  g.answer(G, 1, order[t.qs[1].n - 1], now);
  const tri = t.qs[2].items.slice().sort((x, y) => order.indexOf(x) - order.indexOf(y));
  g.answer(G, 2, tri, now);
  assert.strictEqual(g.s.phase, "reveal");
  assert.deepStrictEqual(g.s.turn.result.pts[G], [300, 300, 300]);
  assert.strictEqual(g.player(G).score - scoreBefore, 900);
  assert.strictEqual(g.player(t.target).score, 0, "мишень очков не получает");
  assert.deepStrictEqual(Object.keys(g.snapshot(now, "board").turn.result).sort(), ["order", "pts"]);
});

test("вопросы равновероятно покрывают все 4 пары соседних мест и все 5 мест в обоих раундах", () => {
  const pairs = new Map(), places = new Map();
  for (let seed = 1; seed <= 60; seed++) {
    const g = mk(4, { seed });
    let now = runToPhase(g, "tintro", 0, { seed });
    if (seed % 2) { now = runToPhase(g, "write", now, { seed }); now = runToPhase(g, "tintro", now, { seed }); }
    const t = g.s.turn;
    const o = g.s.round.orders[t.target];
    const p = Math.min(o.indexOf(t.qs[0].a), o.indexOf(t.qs[0].b));
    pairs.set(p, (pairs.get(p) || 0) + 1);
    places.set(t.qs[1].n, (places.get(t.qs[1].n) || 0) + 1);
  }
  assert.deepStrictEqual([...pairs.keys()].sort(), [0, 1, 2, 3]);
  assert.deepStrictEqual([...places.keys()].sort(), [1, 2, 3, 4, 5]);
  for (const v of pairs.values()) assert.ok(v >= 6, "пары не перекошены: " + [...pairs]);
});

test("тайны: до раскрытия ни доска, ни игроки (включая G и мишень) не получают порядок мишени", () => {
  const g = mk(5, { seed: 31 });
  const views = () => ["board", ...ids(g)];
  let now = 0;
  g.start(now);
  const rnd = seeded(3);
  let reveals = 0;
  for (let guard = 0; guard < 300 && g.s.phase !== "finished"; guard++) {
    const ph = g.s.phase;
    if (ph !== "reveal" && ph !== "finished") {
      for (const v of views()) {
        const snap = g.snapshot(now, v);
        assert.ok(!hasKey(snap, ["order", "orders", "hall", "shadow", "myAnswers"]), `${ph}/${v}: утечка`);
        if (snap.me && snap.me.answered) assert.ok(snap.me.answered.every((x) => typeof x === "boolean"));
      }
    } else if (ph === "reveal") {
      reveals++;
      const snap = g.snapshot(now, "board");
      assert.deepStrictEqual(snap.turn.result.order, g.s.round.orders[g.s.turn.target]);
      for (const v of views()) assert.ok(!hasKey(g.snapshot(now, v), ["hall", "shadow", "myAnswers", "hallCount"]), "следов зала нет");
    }
    now = step(g, now, rnd);
  }
  assert.ok(reveals >= 10);
  assert.strictEqual(g.s.phase, "finished");
});

test("мишень не расставила — её ход пропущен, угадывающий играет следующую мишень вдвоём с её угадывающим", () => {
  const g = mk(5, { seed: 41 });
  let now = runToPhase(g, "rank", 0);
  const cast = g.s.round.cast;
  const skip = cast[1];
  const orphan = g.s.round.guess[skip];
  for (const id of cast) if (id !== skip) g.rank(id, [0, 1, 2, 3, 4], now);
  now = g.s.phaseEnd; g.tick(now);
  const turns = g.s.round.turns;
  assert.strictEqual(turns.length, 4);
  assert.ok(!turns.some((x) => x.target === skip));
  const joint = turns.find((x) => x.guessers.includes(orphan));
  assert.ok(joint, "угадывающий не остался без хода");
  assert.strictEqual(joint.target, cast[2], "следующая мишень по кругу");
  assert.strictEqual(joint.guessers.length, 2);
  // оба угадывающих получают свои очки
  now = runToPhase(g, "scores", now);
  const logs = g.s.log.filter((x) => x.target === cast[2]);
  assert.deepStrictEqual(logs.map((x) => x.guesser).sort(), joint.guessers.slice().sort());
});

test("угадывающий отвалился до хода — ход у следующего на связи по кругу (не мишени и не автора)", () => {
  const g = mk(5, { seed: 51 });
  let now = runToPhase(g, "write", 0);
  now = runToPhase(g, "rank", now);
  for (const id of g.s.round.cast) g.rank(id, [0, 1, 2, 3, 4], now);
  // перед первым ходом: угадывающий первой мишени пропадает
  const first = g.s.round.turns[0];
  assert.strictEqual(g.s.phase, "tintro");
  // пересоберём ход с офлайн-угадывающим: вернёмся к началу и отключим
  const G = first.guessers[0];
  g.setOnline(G, false, now);
  g.s.round.ti = -1;
  g.nextTurn(now);
  const t = g.s.turn;
  assert.ok(!t.guessers.includes(G));
  assert.strictEqual(t.guessers.length, 1);
  const rep = t.guessers[0];
  assert.notStrictEqual(rep, t.target);
  assert.notStrictEqual(rep, t.author);
  assert.ok(g.online(rep));
  const N = g.s.round.cast.length;
  const exp = [1, 2, 3, 4].map((k) => g.s.round.cast[(g.s.round.cast.indexOf(G) + k) % N]).find((c) => c !== t.target && c !== t.author);
  assert.strictEqual(rep, exp);
  assert.deepStrictEqual(t.swapped, [{ from: G, to: rep }]);
});

test("угадывающий отвалился посреди хода — неотвеченные дают 0, ход сразу идёт к раскрытию", () => {
  const g = mk(4, { seed: 61 });
  let now = runToPhase(g, "tintro", 0);
  now = g.s.phaseEnd; g.tick(now);
  const t = g.s.turn;
  const G = t.guessers[0];
  g.answer(G, 0, t.qs[0].a, now);
  assert.strictEqual(g.s.turn.qi, 1);
  g.setOnline(G, false, now + 10);
  assert.strictEqual(g.s.phase, "reveal", "ждать пропавшего не надо");
  assert.strictEqual(g.s.turn.result.pts[G][1], 0);
  assert.strictEqual(g.s.turn.result.pts[G][2], 0);
});

test("мишень отвалилась после расстановки — её всё равно угадывают", () => {
  const g = mk(4, { seed: 71 });
  let now = runToPhase(g, "rank", 0);
  for (const id of g.s.round.cast) g.rank(id, [0, 1, 2, 3, 4], now);
  const target = g.s.round.turns[1].target;
  g.setOnline(target, false, now);
  now = runToPhase(g, "scores", now);
  assert.ok(g.s.log.some((x) => x.target === target));
});

test("меньше 3 на связи — пауза перед ходом, возвращение продолжает с того же хода", () => {
  const g = mk(4, { seed: 81 });
  let now = runToPhase(g, "reveal", 0);
  const ti = g.s.round.ti;
  g.setOnline("p0", false, now);
  g.setOnline("p1", false, now);
  now = g.s.phaseEnd; g.tick(now);
  assert.strictEqual(g.s.phase, "pause");
  assert.ok(g.snapshot(now, "board").pauseReason);
  g.setOnline("p0", true, now + 1000);
  assert.strictEqual(g.s.phase, "tintro");
  assert.strictEqual(g.s.round.ti, ti + 1);
  // пауза, которую никто не прервал, кончает партию
  g.setOnline("p0", false, now); g.setOnline("p2", false, now);
  now = runToPhase(g, "pause", now);
  now = g.s.phaseEnd; g.tick(now);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "paused");
});

test("ушли так, что осталось меньше 3, — партия кончается", () => {
  const g = mk(3, { seed: 3 });
  runToPhase(g, "rank", 0);
  g.removePlayer("p0", 5);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "few");
});

// ---------- партия целиком ----------

test("полная партия с ботами от лобби до итогов: N=3..8, счёт = сумма очков ходов", () => {
  for (let N = 3; N <= 8; N++) {
    for (const mode of ["safe", "edgy"]) {
      const g = mk(N, { seed: N * 7 + (mode === "edgy" ? 1 : 0), mode });
      assert.ok(g.start(0).ok);
      let now = runToPhase(g, "finished", 0, { seed: N });
      assert.strictEqual(g.s.phase, "finished");
      assert.strictEqual(g.s.finishedReason, "done");
      assert.strictEqual(g.s.log.length, 2 * N, "каждый угадывал раз в раунде");
      for (const p of g.present()) {
        const sum = g.s.log.filter((x) => x.guesser === p.id).reduce((a, x) => a + x.pts.reduce((b, c) => b + c, 0), 0);
        assert.strictEqual(p.score, sum);
        assert.ok(p.score <= 1800);
      }
      const snap = g.snapshot(now, "board");
      assert.ok(Array.isArray(snap.loud) && snap.loud.length <= 3);
      // новая партия из итогов
      assert.ok(g.start(now + 1).ok);
      assert.strictEqual(g.s.phase, "pick");
      assert.ok(g.present().every((p) => p.score === 0));
    }
  }
});

test("лента громких раскрытий: недобор только по отвеченным, порог строго > 300, одна мишень — один ход, самый яркий промах", () => {
  const order = [0, 1, 2, 3, 4];
  const qs = [{ kind: "pair", a: 1, b: 2 }, { kind: "place", n: 1 }, { kind: "triple", items: [0, 3, 4] }];
  // ход «как в жизни»: очки — по правилам, недобор и худший вопрос — тоже
  const e = (guesser, target, answers) => {
    const pts = scoreTurn(order, qs, answers);
    return { guesser, target, order, qs, answers, pts, items: [], title: "", miss: missOf(answers, pts), worst: worstQ(order, qs, answers, pts) };
  };
  // недобор: таймаут — не промах
  assert.strictEqual(missOf([2, null, null], [0, 0, 0]), 300);
  assert.strictEqual(missOf([null, null, null], [0, 0, 0]), 0);
  // ярче всего: 5-е вместо 1-го (разлёт 4) — ярче неверной пары
  assert.deepStrictEqual(worstQ(order, qs, [2, 4, [0, 3, 4]], [0, 0, 300]), { qi: 1, lost: 300, mag: 4 });
  assert.deepStrictEqual(worstQ(order, qs, [2, 1, [4, 3, 0]], [0, 100, 0]), { qi: 0, lost: 300, mag: 1 }, "пара рассказывается проще тройки");
  assert.deepStrictEqual(worstQ(order, qs, [1, 1, [4, 3, 0]], [300, 100, 0]), { qi: 2, lost: 300, mag: 3 });
  assert.strictEqual(worstQ(order, qs, [1, 0, [0, 3, 4]], [300, 300, 300]), null);
  const g = mk(4);
  g.s.log = [
    e("a", "x", [2, 4, [4, 3, 0]]), // 900 мимо
    e("b", "x", [2, 3, [4, 3, 0]]), // тоже x — в ленту не идёт
    e("c", "y", [2, 4, null]), // 600, ответил на два
    e("d", "z", [2, null, null]), // 300 — не громко (порог строго больше)
    e("f", "w", [null, null, null]), // молчание
    e("h", "v", [1, 2, [3, 0, 4]]), // 0 + 0 + 200 → недобор 400
  ];
  assert.deepStrictEqual(g.computeLoud().map((x) => x.guesser), ["a", "c", "h"]);
  assert.strictEqual(g.computeLoud()[0].worst.qi, 1, "у хода a ярче всего промах про место");
  g.s.log = [e("d", "z", [2, null, null]), e("f", "w", [null, null, null])];
  assert.deepStrictEqual(g.computeLoud(), [], "недобор ≤ 300 и молчание — ленты нет");
  g.s.log = [e("a", "x", [2, 4, [4, 3, 0]])];
  g.finish("done", 0);
  const snap = g.snapshot(0, "board");
  assert.strictEqual(snap.loud.length, 1);
  assert.ok(snap.loud[0].worst && snap.loud[0].hallRate === undefined);
});

test("вето: замена из пула той же подсказки без повторов; пул исчерпан — пример другой подсказки того же режима", () => {
  const g = mk(4, { seed: 13 });
  let now = runToPhase(g, "rank", runToPhase(g, "write", 0));
  const t = g.s.round.cast[1];
  const set = g.s.round.sets[t];
  // все примеры подсказки уже стоят в наборе (по ключу: регистр и пунктуация не важны)
  set.examples = set.items.map((x) => x.t.toUpperCase() + "!");
  const r = g.veto(t, 0, "z1", now);
  assert.ok(r.ok);
  const nt = set.items[0].t;
  const modeEx = new Set([].concat(...g.prompts().map((p) => p.examples)).map(cardKey));
  assert.ok(modeEx.has(cardKey(nt)), "замена — пример подсказки того же режима: " + nt);
  assert.strictEqual(new Set(set.items.map((x) => cardKey(x.t))).size, 5, "без повторов в наборе");
});

test("ведущий вернул партию в лобби и перезапустил — снимок несёт restarted; обычная «ещё партия» — нет", () => {
  const g = mk(4, { seed: 3 });
  let now = runToPhase(g, "rank", 0);
  assert.strictEqual(g.snapshot(now, "p0").restarted, false);
  g.toLobby(now);
  g.s.settings.mode = "edgy";
  assert.ok(g.start(now + 1).ok);
  assert.strictEqual(g.snapshot(now, "p0").restarted, true);
  assert.strictEqual(g.snapshot(now, "board").settings.mode, "edgy");
  now = runToPhase(g, "finished", now);
  assert.strictEqual(g.snapshot(now, "p0").restarted, false, "на итогах плашки нет");
  assert.ok(g.start(now + 1).ok);
  assert.strictEqual(g.snapshot(now, "p0").restarted, false, "доигранная партия — не перезапуск");
});

test("таймеры фаз: выбор 15 с, вопросы 10/12/20 с, раскрытие 8 с, счёт 6 с; сочинение и расстановка с надбавкой", () => {
  assert.strictEqual(T.pick, 15000);
  assert.deepStrictEqual(T.q, [10000, 12000, 20000]);
  assert.strictEqual(T.reveal, 8000);
  assert.strictEqual(T.scores, 6000);
  assert.ok(T.write >= 75000 && T.rank >= 45000);
  assert.strictEqual(MIN_PLAYERS, 3);
});

test("язык комнаты: нет банка языка — играет русский, contentLang честно говорит ru", () => {
  const g = Game.create({ settings: { lang: "el" }, rnd: seeded(1), content: CONTENT });
  assert.strictEqual(g.contentLang(), CONTENT.available.includes("el") ? "el" : "ru");
  assert.ok(g.cats().length > 0);
});
