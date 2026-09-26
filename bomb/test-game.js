"use strict";

// Тесты движка бомбы: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const { Game, T, FUSES, sealString, sha256, clampSettings } = require("./game");
const CH = require("./challenges");

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
const bytes = (n) => Buffer.alloc(n, 7);

function game(names = ["A", "B", "C"], settings = {}, rnd = rig()) {
  const g = Game.create({ settings, code: "TEST22", rnd, bytes });
  names.forEach((n) => g.addPlayer({ id: n, name: n }));
  const r = g.start(0);
  assert.ok(r.ok, r.reason);
  g.tick(T.countdown); // отсчёт → игра
  assert.strictEqual(g.s.phase, "live");
  return g;
}

// правильный ответ на испытание — как его прислал бы телефон
function solve(c) {
  if (c.type === "nopress") return { early: false };
  if (c.type === "hold") return { v: c.answer[0] + 80 };
  return { v: c.answer };
}
const holderOf = (g, b = 0) => g.s.bombs[b].holder;

// держатель проходит испытание и кидает
function throwTo(g, to, now) {
  const from = holderOf(g);
  const c = g.s.challenges[from];
  const at = Math.max(now, c.at + c.minMs);
  const a = g.answer(from, c.id, solve(c), at);
  assert.ok(a.ok, a.reason);
  const r = g.pass(from, to, at);
  assert.ok(r.ok, r.reason);
  return at;
}

test("печать: хеш до старта совпадает с раскрытием после взрыва", () => {
  const g = game();
  const b = g.s.bombs[0];
  const [min, max] = FUSES.normal;
  assert.ok(b.fuseMs >= min * 1000 && b.fuseMs <= max * 1000 && b.fuseMs % 1000 === 0);
  const snap = g.snapshot(1000, "board");
  const seal = snap.seals[0];
  assert.strictEqual(seal.revealed, false);
  assert.strictEqual(seal.fuseMs, undefined);
  g.tick(b.explodeAt);
  const after = g.snapshot(b.explodeAt, "board").seals[0];
  assert.strictEqual(after.revealed, true);
  assert.strictEqual(sha256(after.seal), after.commit);
  assert.strictEqual(after.seal, sealString("TEST22", 1, 0, b.fuseMs, b.salt));
});

test("до взрыва тайна не уходит ни в один снимок", () => {
  const g = game(["A", "B", "C", "D", "E", "F"], { mode: "two" });
  assert.strictEqual(g.s.bombs.length, 2);
  for (const view of ["board", "A", "B", null]) {
    const json = JSON.stringify(g.snapshot(5000, view));
    for (const b of g.s.bombs) {
      assert.ok(!json.includes(b.salt), "соль в снимке " + view);
      assert.ok(!json.includes(`"fuseMs"`), "fuseMs в снимке " + view);
      assert.ok(!json.includes(String(b.explodeAt)), "explodeAt в снимке " + view);
    }
    assert.ok(!json.includes(`"answer"`), "ответ испытания в снимке " + view);
    assert.strictEqual(JSON.parse(json).phaseEnd, null);
  }
});

test("взрывается у того, кто держит бомбу в момент срока", () => {
  const g = game();
  const first = holderOf(g);
  const to = ["A", "B", "C"].find((x) => x !== first);
  throwTo(g, to, 1000);
  const ev = g.tick(g.s.bombs[0].explodeAt);
  assert.deepStrictEqual(ev.map((e) => e.type), ["boom"]);
  assert.strictEqual(ev[0].playerId, to);
  assert.strictEqual(g.s.loserId, to);
  assert.strictEqual(g.s.phase, "boom");
  g.tick(g.s.phaseEnd);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.snapshot(0, "A").loserId, to);
});

test("бросок после срока не спасает: сервер сначала взрывает", () => {
  const g = game();
  const first = holderOf(g);
  const c = g.s.challenges[first];
  const late = g.s.bombs[0].explodeAt + 5;
  // так делает сервер перед каждым действием
  const ev = g.tick(late);
  assert.strictEqual(ev[0].type, "boom");
  assert.strictEqual(ev[0].playerId, first);
  assert.strictEqual(g.answer(first, c.id, solve(c), late).ok, false);
  assert.strictEqual(g.pass(first, "A", late).ok, false);
});

test("без испытания кинуть нельзя, в себя и в выбывших — тоже", () => {
  const g = game();
  const h = holderOf(g);
  const other = ["A", "B", "C"].find((x) => x !== h);
  assert.strictEqual(g.pass(h, other, 1000).reason, "not_armed");
  const c = g.s.challenges[h];
  assert.ok(g.answer(h, c.id, solve(c), c.at + c.minMs).ok);
  assert.strictEqual(g.pass(h, h, 2000).reason, "bad_target");
  assert.strictEqual(g.pass(h, "ZZZ", 2000).reason, "bad_target");
  assert.strictEqual(g.pass(other, h, 2000).reason, "no_bomb");
});

test("вернуть отправителю: запрет по настройке, разрешено при двух игроках и с галочкой", () => {
  const g = game(["A", "B", "C"]);
  const h = holderOf(g);
  const [x, y] = ["A", "B", "C"].filter((p) => p !== h);
  let t = throwTo(g, x, 1000);
  let c = g.s.challenges[x];
  t = Math.max(t, c.at + c.minMs);
  assert.ok(g.answer(x, c.id, solve(c), t).ok);
  assert.strictEqual(g.pass(x, h, t).reason, "no_return");
  assert.ok(g.pass(x, y, t).ok);

  const g2 = game(["A", "B", "C"], { returnOk: true });
  const h2 = holderOf(g2);
  const x2 = ["A", "B", "C"].find((p) => p !== h2);
  const t2 = throwTo(g2, x2, 1000);
  const c2 = g2.s.challenges[x2];
  assert.ok(g2.answer(x2, c2.id, solve(c2), t2 + c2.minMs).ok);
  assert.ok(g2.pass(x2, h2, t2 + c2.minMs).ok);

  const g3 = game(["A", "B"]);
  const h3 = holderOf(g3);
  const x3 = h3 === "A" ? "B" : "A";
  const t3 = throwTo(g3, x3, 1000);
  const c3 = g3.s.challenges[x3];
  assert.ok(g3.answer(x3, c3.id, solve(c3), t3 + c3.minMs).ok);
  assert.ok(g3.pass(x3, h3, t3 + c3.minMs).ok, "при двоих возвращать можно");
});

test("ошибка — новое испытание, слишком быстрый ответ — отказ без провала", () => {
  const g = game();
  const h = holderOf(g);
  const c = g.s.challenges[h];
  if (c.type !== "nopress") {
    const early = g.answer(h, c.id, solve(c), c.at + 10);
    assert.strictEqual(early.reason, "early");
    assert.strictEqual(g.s.challenges[h].id, c.id);
  }
  const wrong = g.answer(h, c.id, { v: "__nope__", early: true }, c.at + c.minMs + 1);
  assert.ok(wrong.ok);
  assert.strictEqual(wrong.events[0].type, "wrong");
  const next = g.s.challenges[h];
  assert.notStrictEqual(next.id, c.id);
  assert.strictEqual(next.lvl, c.lvl);
  assert.strictEqual(g.answer(h, c.id, solve(c), c.at + 5000).reason, "stale");
});

test("зависшее испытание через 12 с сменяется другим", () => {
  const g = game();
  const h = holderOf(g);
  const c = g.s.challenges[h];
  const at = c.at + CH.CHALLENGE_TTL;
  if (at >= g.s.bombs[0].explodeAt) return; // короткий фитиль в этом прогоне — проверять нечего
  assert.strictEqual(g.nextDeadline(), at);
  const ev = g.tick(at);
  assert.strictEqual(ev[0].type, "swap");
  assert.notStrictEqual(g.s.challenges[h].id, c.id);
});

test("на выбывание: доводит до одного, стендап ведёт первый взорвавшийся", () => {
  const g = game(["A", "B", "C", "D"], { mode: "elim", fuse: "short" });
  let now = 0, first = null;
  for (let round = 0; round < 10 && g.s.phase !== "finished"; round++) {
    if (g.s.phase === "countdown") { now = g.s.phaseEnd; g.tick(now); }
    now = g.s.bombs[0].explodeAt;
    const ev = g.tick(now);
    assert.strictEqual(ev[0].type, "boom");
    if (!first) first = ev[0].playerId;
    assert.ok(g.player(ev[0].playerId).out);
    now = g.s.phaseEnd;
    g.tick(now);
  }
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.alive().length, 1);
  assert.strictEqual(g.s.winnerId, g.alive()[0].id);
  assert.strictEqual(g.s.loserId, first);
  assert.strictEqual(g.s.seals.length, 3);
  for (const x of g.snapshot(now, "A").seals) assert.strictEqual(sha256(x.seal), x.commit);
});

test("две бомбы: разные первые держатели, первый взрыв закрывает раунд и вскрывает обе печати", () => {
  const g = game(["A", "B", "C", "D", "E", "F"], { mode: "two" });
  const [b0, b1] = g.s.bombs;
  assert.notStrictEqual(b0.holder, b1.holder);
  const first = b0.explodeAt <= b1.explodeAt ? b0 : b1;
  const ev = g.tick(first.explodeAt);
  assert.strictEqual(ev[0].type, "boom");
  assert.strictEqual(ev[0].bomb, first.id);
  const seals = g.snapshot(first.explodeAt, "board").seals;
  assert.strictEqual(seals.length, 2);
  assert.ok(seals.every((x) => x.revealed && sha256(x.seal) === x.commit));
  // при пяти игроках вторая бомба не появляется
  const g5 = game(["A", "B", "C", "D", "E"], { mode: "two" });
  assert.strictEqual(g5.s.bombs.length, 1);
});

test("две бомбы у одного: за каждую — своё испытание", () => {
  const g = game(["A", "B", "C", "D", "E", "F"], { mode: "two" });
  const [b0, b1] = g.s.bombs;
  // кидаем первую бомбу держателю второй
  const h0 = b0.holder, h1 = b1.holder;
  const c = g.s.challenges[h0];
  const t = c.at + c.minMs;
  assert.ok(g.answer(h0, c.id, solve(c), t).ok);
  assert.ok(g.pass(h0, h1, t).ok);
  assert.strictEqual(g.holding(h1).length, 2);
  const c1 = g.s.challenges[h1];
  const t1 = Math.max(t, c1.at + c1.minMs);
  assert.ok(g.answer(h1, c1.id, solve(c1), t1).ok);
  const others = ["A", "B", "C", "D", "E", "F"].filter((p) => p !== h1 && p !== h0);
  assert.ok(g.pass(h1, others[0], t1).ok);
  assert.strictEqual(g.holding(h1).length, 1, "вторая бомба осталась");
  assert.ok(g.s.challenges[h1], "за неё выдано новое испытание");
});

test("ушёл с бомбой — она достаётся живому; остался один — раунд кончается без взрыва", () => {
  const g = game(["A", "B", "C"]);
  const h = holderOf(g);
  const ev = g.removePlayer(h, 1000);
  assert.ok(ev.some((e) => e.type === "pass" && e.dropped));
  assert.notStrictEqual(holderOf(g), h);
  assert.ok(g.s.challenges[holderOf(g)]);
  g.removePlayer(holderOf(g), 2000);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.s.finishedReason, "few");
  assert.ok(g.s.seals[0].revealed, "печать вскрыта и при досрочном конце");
});

test("статистика раунда", () => {
  const g = game(["A", "B", "C"], { returnOk: true });
  const h = holderOf(g);
  const [x, y] = ["A", "B", "C"].filter((p) => p !== h);
  let t = throwTo(g, x, 1000);
  t = throwTo(g, y, t + 3000);
  t = throwTo(g, x, t + 500);
  g.tick(g.s.bombs[0].explodeAt);
  const st = g.s.stats;
  assert.strictEqual(st.passes, 3);
  assert.strictEqual(st.mostGot.playerId, x);
  assert.strictEqual(st.mostGot.n, 2);
  assert.strictEqual(st.victim, x);
  assert.ok(st.longest && st.fastest);
});

test("ещё раунд с итогов и возврат в лобби; новые игроки входят только в лобби и на итогах", () => {
  const g = game(["A", "B"]);
  assert.strictEqual(g.addPlayer({ id: "Z", name: "Z" }).reason, "game_started");
  g.tick(g.s.bombs[0].explodeAt);
  g.tick(g.s.phaseEnd);
  assert.ok(g.addPlayer({ id: "Z", name: "Z" }).ok);
  const r = g.start(999999);
  assert.ok(r.ok);
  assert.strictEqual(g.s.phase, "countdown");
  assert.strictEqual(g.s.round, 2);
  g.toLobby(1000000);
  assert.strictEqual(g.s.phase, "lobby");
});

test("настройки: неизвестное отбрасывается, все группы выключить нельзя", () => {
  const s = clampSettings({ mode: "hack", fuse: "eternal", returnOk: "yes", groups: { hands: false, eyes: false, head: false } });
  assert.strictEqual(s.mode, "classic");
  assert.strictEqual(s.fuse, "normal");
  assert.strictEqual(s.returnOk, false);
  assert.strictEqual(s.groups.hands, true);
});

// ---------- испытания ----------

test("каждое испытание решается своим ответом и не решается чужим", () => {
  const used = () => ({ quiz: [], tf: [], heavy: [], chrono: [] });
  const types = Object.values(CH.GROUPS).flat();
  let seed = 3;
  for (const type of types) {
    for (const lvl of [1, 2, 3]) {
      for (let i = 0; i < 60; i++) {
        const rnd = rig([], seed++);
        const c = CH.generate({ lvl, rnd, groups: {}, used: used(), only: type });
        if (CH.QUIZ_TYPES.includes(type) && c.type !== type) continue; // банк пуст
        assert.strictEqual(c.type, type);
        assert.strictEqual(CH.check(c, solve(c), c.minMs), "ok", `${type}/${lvl}: ${JSON.stringify(c)}`);
        if (type !== "nopress") assert.strictEqual(CH.check(c, { v: "__nope__" }, c.minMs), "wrong", type);
        if (type !== "nopress" && c.minMs > 0) assert.strictEqual(CH.check(c, solve(c), c.minMs - 1), "early", type);
      }
    }
  }
});

test("варианты ответа: правильный ровно один, без повторов", () => {
  for (const type of ["count", "seq", "math", "color", "quiz", "heavy"]) {
    for (let i = 0; i < 300; i++) {
      const c = CH.generate({ lvl: 1 + (i % 3), rnd: rig([], i + 1), groups: {}, used: { quiz: [], tf: [], heavy: [], chrono: [] }, only: type });
      if (c.type !== type) continue;
      const opts = c.view.options.map((o) => JSON.stringify(o));
      assert.strictEqual(new Set(opts).size, opts.length, `${type}: повтор в ${opts}`);
      assert.ok(c.answer >= 0 && c.answer < opts.length, type);
    }
  }
});

test("последовательности: ответ действительно продолжает ряд", () => {
  for (let i = 0; i < 500; i++) {
    const c = CH.generate({ lvl: 1 + (i % 3), rnd: rig([], i + 7), groups: {}, used: {}, only: "seq" });
    const v = c.view;
    const right = v.options[c.answer];
    if (v.kind === "num" && v.items.length === 4) {
      const [a, b, x, d] = v.items;
      const diff = b - a, q = b / a;
      const ok = (x - b === diff && d - x === diff && right - d === diff) || (b === a * q && x === b * q && d === x * q && right === d * q) ||
        [a, b, x, d, right].every((n, k) => Math.round(Math.sqrt(n)) ** 2 === n && (k === 0 || Math.sqrt(n) - Math.sqrt([a, b, x, d][k - 1]) === 1));
      assert.ok(ok, JSON.stringify(v) + " → " + right);
    }
    if (v.kind === "num" && v.items.length === 5) {
      const [a, b, x, d, e] = v.items;
      const fib = x === a + b && d === b + x && e === x + d && right === d + e;
      // чередование: +a, −b, +a, −b, +a
      const alt = b - a === d - x && d - x === right - e && x - b === e - d;
      assert.ok(fib || alt, JSON.stringify(v) + " → " + right);
    }
    if (v.kind === "emoji") {
      // период узора — наименьший p, при котором ряд повторяется; показан минимум дважды целиком
      const it = v.items;
      const p = [1, 2, 3].find((k) => it.every((x, j) => j < k || x === it[j - k]));
      assert.ok(p && p >= 2 && it.length >= 2 * p + 1, "ряд короткий или без узора: " + it.join(""));
      assert.strictEqual(right, it[it.length - p], it.join("") + " → " + right);
      assert.ok(new Set(it).size <= p, "в ряду лишние эмодзи: " + it.join(""));
    }
    if (v.kind === "days") {
      const step = (v.items[1] - v.items[0] + 7) % 7;
      assert.strictEqual(right, (v.items[3] + step) % 7);
    }
  }
});

test("судоку: у клетки «?» ответ однозначен", () => {
  for (let i = 0; i < 400; i++) {
    const lvl = 1 + (i % 3);
    const c = CH.generate({ lvl, rnd: rig([], i + 11), groups: {}, used: {}, only: "sudoku" });
    const { n, cells, target: [r, col] } = c.view;
    const row = cells[r].filter((x) => x != null), column = cells.map((x) => x[col]).filter((x) => x != null);
    const fromRow = row.length === n - 1 ? [...Array(n)].map((_, k) => k + 1).find((k) => !row.includes(k)) : null;
    const fromCol = column.length === n - 1 ? [...Array(n)].map((_, k) => k + 1).find((k) => !column.includes(k)) : null;
    assert.ok(fromRow === c.answer || fromCol === c.answer, JSON.stringify(c.view));
  }
});

test("уровень испытаний растёт по времени раунда", () => {
  assert.strictEqual(CH.levelFor(0), 1);
  assert.strictEqual(CH.levelFor(19999), 1);
  assert.strictEqual(CH.levelFor(20000), 2);
  assert.strictEqual(CH.levelFor(45000), 3);
});

test("выключенная группа не выпадает; «Эрудит» — только вопросы банка", () => {
  for (let i = 0; i < 200; i++) {
    const c = CH.generate({ lvl: 2, rnd: rig([], i + 1), groups: { hands: false, eyes: true, head: false }, used: { quiz: [], tf: [], heavy: [], chrono: [] } });
    assert.strictEqual(c.group, "eyes");
  }
  if (!CH.bank().quiz.length) return;
  for (let i = 0; i < 100; i++) {
    const c = CH.generate({ lvl: 1, rnd: rig([], i + 1), groups: {}, quizOnly: true, used: { quiz: [], tf: [], heavy: [], chrono: [] } });
    assert.ok(CH.QUIZ_TYPES.includes(c.type), c.type);
  }
});

test("одно испытание не выпадает дважды подряд одному игроку, вопрос не повторяется в партии", () => {
  const g = game(["A", "B"]);
  let last = null, t = 0;
  for (let i = 0; i < 40; i++) {
    const h = holderOf(g);
    const c = g.s.challenges[h];
    if (g.s.lastType[h] && last && last.player === h) assert.notStrictEqual(c.type, last.type);
    last = { player: h, type: c.type };
    const r = g.answer(h, c.id, { v: "__nope__", early: true }, Math.max(t, c.at + c.minMs));
    t = Math.max(t, c.at + c.minMs);
    assert.ok(r.ok);
    last = { player: h, type: c.type };
    if (t > g.s.bombs[0].explodeAt - 20000) break;
  }
  const quizUsed = g.s.used.quiz;
  assert.strictEqual(new Set(quizUsed).size, quizUsed.length);
});
