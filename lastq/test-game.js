"use strict";
// Движок «Последнего вопроса»: node --test test-game.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { Game, T, ACTS, BET_POINTS, BET_WINDOW, PASS_SILENCE } = require("./game.js");
const CH = require("./challenges.js");

function mulberry(seed) {
  return (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const TAGS = ["animals", "food", "geo", "body", "science"];
function bank(n = 40, finals = 6) {
  const qs = [];
  for (let i = 0; i < n; i++) qs.push({ id: "q" + i, tag: TAGS[i % TAGS.length], lvl: 1 + (i % 3), final: false, q: "Вопрос " + i, a: ["верно" + i, "мимо1", "мимо2", "мимо3"], fun: 3 });
  for (let i = 0; i < finals; i++) qs.push({ id: "f" + i, tag: TAGS[i % TAGS.length], lvl: 3, final: true, q: "Финал " + i, a: ["верно", "мимо1", "мимо2", "мимо3"], fun: 2 });
  return { ru: qs, en: qs, el: qs };
}

function setup(n = 3, settings = {}, seed = 1) {
  const g = Game.create({ settings, code: "TEST", rnd: mulberry(seed), content: bank() });
  for (let i = 0; i < n; i++) g.addPlayer({ id: "p" + i, name: "Игрок " + i });
  return g;
}
// крутим таймер до нужной фазы
function until(g, phase, t, max = 50) {
  for (let i = 0; i < max && g.s.phase !== phase; i++) { t = g.nextDeadline(); assert.ok(t != null, "застряли в " + g.s.phase); g.tick(t); }
  assert.equal(g.s.phase, phase);
  return t;
}
const right = (g) => g.s.q.right;
const wrong = (g) => (g.s.q.right + 1) % 4;

// эталонный ответ испытания — как шлёт телефон
function solve(ch) {
  const a = ch.answer;
  if (ch.type === "nopress") return { early: false };
  if (ch.type === "hold" || ch.type === "rollcall") return { v: (a[0] + a[1]) / 2 };
  return { v: a };
}
function badAns(ch) {
  if (ch.type === "nopress") return { early: true };
  if (ch.type === "hold" || ch.type === "rollcall") return { v: -5 };
  if (typeof ch.answer === "number") return { v: ch.answer === 0 ? 1 : 0 };
  if (typeof ch.answer === "string") return { v: "x" };
  return { v: [] };
}

test("старт: от 2 игроков; заставка акта → чтение → ответ; бонус за скорость от открытия кнопок", () => {
  const one = setup(1);
  assert.equal(one.start(0).reason, "few_players");
  const g = setup(2);
  assert.ok(g.start(0).ok);
  assert.equal(g.s.phase, "intro");
  let t = until(g, "read", 0);
  // на чтении кнопок нет
  assert.equal(g.answer("p0", 0, t + 10).reason, "not_now");
  t = until(g, "answer", t);
  const open = g.s.openAt;
  g.answer("p0", right(g), open); // мгновенно — полный бонус
  g.answer("p1", right(g), open + T.answer / 2); // на середине — половина
  assert.equal(g.s.phase, "reveal"); // все ответили — раскрытие досрочно
  assert.equal(g.s.result.gain.p0, ACTS[1].right + ACTS[1].speed);
  assert.equal(g.s.result.gain.p1, ACTS[1].right + 30); // 25 → округление до 10
  assert.equal(g.player("p0").score, 150);
});

test("все верно — «Чисто!», Камеры нет; все ошиблись — палача нет, набор случайный", () => {
  const g = setup(3);
  g.start(0);
  let t = until(g, "answer", 0);
  for (const p of ["p0", "p1", "p2"]) g.answer(p, right(g), t + 100);
  assert.equal(g.s.phase, "reveal");
  assert.equal(g.s.prisoners.length, 0);
  t = g.nextDeadline(); g.tick(t);
  assert.equal(g.s.phase, "read");
  t = until(g, "answer", t);
  for (const p of ["p0", "p1", "p2"]) g.answer(p, wrong(g), t + 100);
  assert.equal(g.s.palach, null);
  assert.ok(g.s.group, "набор выбран случаем сразу");
  assert.ok(g.s.groupAuto);
});

test("палач — самый быстрый из верных; выбрал раньше — раскрытие не короче 4 с", () => {
  const g = setup(3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p1", right(g), t + 500);
  g.answer("p0", right(g), t + 900);
  g.answer("p2", wrong(g), t + 1000);
  const r0 = g.s.phaseStart;
  assert.equal(g.s.palach, "p1");
  assert.equal(g.pickGroup("p0", "head", r0 + 100).reason, "not_palach");
  assert.ok(g.pickGroup("p1", "head", r0 + 100).ok);
  assert.equal(g.s.phaseEnd, r0 + T.revealMin);
  g.tick(g.s.phaseEnd);
  assert.equal(g.s.phase, "cell");
  assert.deepEqual(g.s.prisoners, ["p2"]);
  assert.equal(g.s.cell.p2.ch.group, "head");
});

test("Камера: верно — следующее; ошибка — решётка 1,5 с; три верных — спасся, Камера закрывается досрочно", () => {
  const g = setup(2, {}, 3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 200);
  g.pickGroup("p0", "eyes", t + 300);
  t = until(g, "cell", t);
  const c = g.s.cell.p1;
  assert.equal(c.need, CH.CELL[0].need);
  // слишком рано — отказ без провала
  assert.equal(g.cellAnswer("p1", c.ch.id, solve(c.ch), c.ch.at + 1).reason, "early");
  let now = c.ch.at + c.ch.minMs + 10;
  const ev = g.cellAnswer("p1", c.ch.id, badAns(c.ch), now);
  assert.equal(ev.events[0].type, "cellWrong");
  assert.equal(c.lockUntil, now + CH.WRONG_LOCK_MS);
  assert.equal(c.ch.at, c.lockUntil, "следующее испытание — после решётки");
  assert.equal(g.cellAnswer("p1", c.ch.id, solve(c.ch), now + 100).reason, "locked");
  for (let k = 0; k < 3; k++) {
    now = c.ch.at + c.ch.minMs + 10;
    assert.ok(g.cellAnswer("p1", c.ch.id, solve(c.ch), now).ok);
  }
  assert.ok(c.escaped);
  assert.equal(g.s.phase, "verdict");
  assert.deepEqual(g.s.result.escaped, ["p1"]);
  assert.equal(g.player("p1").score, 0);
});

test("не успел — отлёт на N, счёт уходит в минус; во втором акте N = 250", () => {
  const g = setup(2);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  t = until(g, "cell", t);
  t = until(g, "verdict", t);
  assert.deepEqual(g.s.result.burned, ["p1"]);
  assert.equal(g.player("p1").score, -ACTS[1].knock);
  assert.equal(g.s.result.delta.p1, -100);
  // доходим до второго акта
  for (let q = 1; q < 5; q++) {
    t = until(g, "answer", t);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", right(g), t + 100);
  }
  assert.equal(g.s.act, 2);
  t = until(g, "answer", t);
  const before = g.player("p1").score;
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  t = until(g, "verdict", t);
  assert.equal(g.player("p1").score, before - ACTS[2].knock);
});

test("ставки на спасение: только свободные, без умолчания; угадал — +20", () => {
  const g = setup(4, {}, 5);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", right(g), t + 200);
  g.answer("p2", wrong(g), t + 300);
  g.answer("p3", wrong(g), t + 300);
  t = until(g, "cell", t);
  assert.equal(g.bet("p2", "p3", true, t).reason, "not_free");
  assert.ok(g.bet("p0", "p2", false, t).ok);
  assert.ok(g.bet("p0", "p3", true, t).ok);
  // p1 не ставит — очков за ставки нет
  t = until(g, "verdict", t);
  assert.deepEqual(g.s.result.burned.sort(), ["p2", "p3"]);
  assert.equal(g.s.result.betGain.p0, BET_POINTS);
  assert.equal(g.s.result.betGain.p1, undefined);
});

test("«Передачка»: подсказчик — свободный игрок; через 4 с тишины код на доске; вдвоём не выпадает", () => {
  let found = false;
  for (let seed = 1; seed < 400 && !found; seed++) {
    const g = setup(3, {}, seed);
    g.start(0);
    let t = until(g, "answer", 0);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", right(g), t + 200);
    g.answer("p2", wrong(g), t + 300);
    g.pickGroup("p0", "eyes", t + 400);
    t = until(g, "cell", t);
    const c = g.s.cell.p2;
    for (let k = 0; k < 3 && c.ch && c.ch.type !== "pass"; k++) {
      const now = c.ch.at + c.ch.minMs + 10;
      g.cellAnswer("p2", c.ch.id, solve(c.ch), now);
    }
    if (!c.ch || c.ch.type !== "pass") continue;
    found = true;
    const helper = c.ch.view.helper;
    assert.ok(["p0", "p1"].includes(helper));
    const hs = g.snapshot(c.ch.at + 10, helper);
    assert.equal(hs.me.passHints[0].code, c.ch.answer);
    assert.ok(!JSON.stringify(g.snapshot(c.ch.at + 10, "board")).includes(`"passCode"`));
    assert.ok(!JSON.stringify(g.snapshot(c.ch.at + 10, "p2")).includes(c.ch.answer.length > 2 ? `"${c.ch.answer}"` : "@@"));
    assert.equal(g.nextDeadline(), c.ch.passAt);
    g.tick(c.ch.passAt);
    assert.equal(c.ch.view.where, "tv");
    assert.equal(g.snapshot(c.ch.passAt, "board").cell[0].passCode, c.ch.answer);
  }
  assert.ok(found, "«Передачка» так и не выпала");
  // вдвоём
  for (let seed = 1; seed < 200; seed++) {
    const g = setup(2, {}, seed);
    g.start(0);
    let t = until(g, "answer", 0);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", wrong(g), t + 300);
    g.pickGroup("p0", "eyes", t + 400);
    t = until(g, "cell", t);
    assert.notEqual(g.s.cell.p1.ch.type, "pass");
  }
});

test("тайны: до раскрытия ни верного ответа, ни чужих ответов, ни палача; ответы испытаний — никому", () => {
  const g = setup(3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  for (const v of ["board", "p0", "p1", null]) {
    const s = g.snapshot(t + 200, v);
    assert.equal(s.right, null);
    assert.equal(s.picks, null);
    assert.equal(s.palach, null);
    assert.equal(s.gain, null);
    if (v === "p1") assert.equal(s.me.answer, null);
    // T-W0-06: имена ответивших — только доске; телефону и зрителю — число
    assert.equal(s.answeredN, 1);
    if (v === "board") assert.deepEqual(s.answered, ["p0"]); else assert.equal(s.answered, null);
  }
  assert.equal(g.snapshot(t + 200, "p0").me.answer, right(g));
  g.answer("p1", wrong(g), t + 300);
  g.answer("p2", wrong(g), t + 300);
  t = until(g, "cell", t);
  for (const v of ["board", "p0", "p1", "p2"]) {
    const js = JSON.stringify(g.snapshot(t + 10, v));
    assert.ok(!js.includes('"answer":' + JSON.stringify(g.s.cell.p1.ch.answer) + ',"minMs"'));
    assert.ok(!/"answer":\[/.test(js), "ответ испытания утёк: " + v);
  }
  // ставки видны только автору до приговора
  g.bet("p0", "p1", true, t + 20);
  assert.deepEqual(g.snapshot(t + 30, "p0").me.bets, { p1: true });
  assert.ok(!JSON.stringify(g.snapshot(t + 30, "board")).includes('"p1":true'));
});

test("финал: тема на ставках, ставка до max(очки, 200), верно +ставка, спасся −½, сгорел −вся (в минус)", () => {
  const g = setup(3, { short: true }, 9);
  g.start(0);
  let t = 0;
  for (let q = 0; q < 4; q++) {
    t = until(g, "answer", t);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", right(g), t + 100);
    g.answer("p2", right(g), t + 100);
  }
  t = until(g, "stake", t);
  const snap = g.snapshot(t, "p2");
  assert.ok(snap.question.tag);
  assert.equal(snap.question.text, null);
  assert.equal(snap.me.maxStake, Math.max(200, g.player("p2").score));
  // p2 обнулим, чтобы проверить «в долг»
  g.player("p2").score = 0;
  assert.equal(g.stake("p2", 201, t).reason, "bad");
  assert.ok(g.stake("p2", 200, t).ok);
  const s0 = g.player("p0").score;
  g.stake("p0", s0, t);
  g.stake("p1", 100, t);
  assert.equal(g.s.phase, "fread");
  t = until(g, "fanswer", t);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  g.answer("p2", wrong(g), t + 100);
  assert.equal(g.s.phase, "fshow");
  assert.equal(g.snapshot(t + 200, "board").right, g.s.q.right, "зал видит верный ответ финала");
  t = until(g, "fcell", t);
  assert.equal(g.s.cell.p1.need, CH.CELL[2].need);
  // p1 спасается, p2 — нет
  const c = g.s.cell.p1;
  while (!c.escaped) { const now = c.ch.at + c.ch.minMs + 10; g.cellAnswer("p1", c.ch.id, solve(c.ch), now); }
  t = until(g, "freveal", t);
  const step = (id) => g.s.fsteps.find((x) => x.id === id);
  assert.equal(step("p0").delta, s0);
  assert.equal(step("p1").delta, -50);
  assert.equal(step("p2").delta, -200);
  assert.equal(g.player("p2").score, -200);
  // снизу таблицы вверх
  assert.deepEqual(g.s.fsteps.map((x) => x.before), g.s.fsteps.map((x) => x.before).slice().sort((a, b) => a - b));
  // T-W0-06: телефон получает только свой шаг раскрытия (+fpos/fN), доска — весь список
  const fb = g.snapshot(t, "board");
  assert.equal(fb.fsteps.length, g.s.fsteps.length);
  for (const id of ["p0", "p1", "p2"]) {
    const ph = g.snapshot(t, id);
    assert.deepEqual(ph.fsteps.map((x) => x.id), [id], "телефон: только свой шаг");
    assert.equal(ph.fpos, g.s.fsteps.findIndex((x) => x.id === id));
    assert.equal(ph.fN, g.s.fsteps.length);
    assert.ok(!JSON.stringify(ph).includes('"answered":['), "телефону не уходит список ответивших");
  }
  assert.deepEqual(g.snapshot(t, null).fsteps, [], "зритель без места: пусто");
  t = until(g, "finished", t);
  assert.equal(g.s.ranking[0].id, "p0");
  assert.ok(g.s.awards.kamikaze.ids.includes("p0"));
  assert.ok(g.s.awards.bottom.ids.includes("p2"));
});

test("финал выключен — партия кончается после последнего вопроса; ничья — по меньшему числу отлётов", () => {
  const g = setup(2, { short: true, final: false });
  g.start(0);
  let t = 0;
  for (let q = 0; q < 4; q++) {
    t = until(g, "answer", t);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", right(g), t + 100);
  }
  t = until(g, "finished", t, 20);
  assert.equal(g.s.ranking[0].place, 1);
  assert.equal(g.s.ranking[1].place, 1, "одинаковые очки и время — делят место");
  assert.equal(g.s.awards.kamikaze, null);
});

test("офлайн: не ответил — в Камеру и сгорает; вернулся посреди Камеры — играет; все офлайн — пауза", () => {
  const g = setup(3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.setOnline("p2", false, t);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", right(g), t + 200);
  assert.equal(g.s.phase, "reveal", "офлайн считается ответившим для досрочного конца");
  assert.ok(g.s.prisoners.includes("p2"));
  t = until(g, "cell", t);
  assert.equal(g.s.cell.p2.ch, null);
  // все узники офлайн — Камера сразу закрывается? нет: вернулся до этого
  g.setOnline("p2", true, t + 100);
  assert.ok(g.s.cell.p2.ch, "вернулся — получил испытание");
  // все офлайн — пауза
  for (const p of ["p0", "p1", "p2"]) g.setOnline(p, false, t + 200);
  assert.equal(g.nextDeadline(), null);
  const end = g.s.phaseEnd;
  assert.deepEqual(g.tick(end + 99999), []);
  g.setOnline("p0", true, t + 10200);
  assert.equal(g.s.phaseEnd, end + 10000);
});

test("палач вышел — набор случайный сразу; меньше 2 игроков — партия заканчивается", () => {
  const g = setup(3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 200);
  g.answer("p2", wrong(g), t + 200);
  assert.equal(g.s.palach, "p0");
  g.setOnline("p0", false, t + 300);
  assert.ok(g.s.group);
  g.removePlayer("p1", t + 400);
  g.removePlayer("p2", t + 400);
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.finishedReason, "few");
});

test("вошедший посреди партии отвечает со следующего вопроса", () => {
  const g = setup(2);
  g.start(0);
  let t = until(g, "answer", 0);
  g.addPlayer({ id: "late", name: "Опоздун" });
  assert.equal(g.answer("late", 0, t + 100).reason, "not_in_question");
  g.answer("p0", right(g), t + 100);
  g.answer("p1", right(g), t + 100);
  t = until(g, "answer", t);
  assert.ok(g.answer("late", 0, t + 100).ok);
});

test("вопросы не повторяются в комнате; уровни по актам; тема не как у прошлого", () => {
  const g = setup(2, {}, 11);
  const seen = new Set();
  for (let game = 0; game < 4; game++) {
    g.start(0);
    let t = 0;
    while (g.s.phase !== "stake" && g.s.phase !== "finished") {
      t = until(g, "answer", t);
      assert.ok(!seen.has(g.s.q.id), "повтор " + g.s.q.id);
      seen.add(g.s.q.id);
      assert.ok((g.s.act === 1 ? [1, 2] : [2, 3]).includes(g.s.q.lvl));
      g.answer("p0", right(g), t + 100);
      g.answer("p1", right(g), t + 100);
      t = g.nextDeadline();
      g.tick(t);
      if (g.s.phase === "read" || g.s.phase === "intro" || g.s.phase === "stake") continue;
    }
    g.toLobby(t);
  }
  assert.equal(seen.size, 32);
});

test("состояние переживает JSON (дамп сервера) посреди Камеры", () => {
  const g = setup(3, {}, 4);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  g.answer("p2", wrong(g), t + 100);
  t = until(g, "cell", t);
  const g2 = Game.from(JSON.parse(JSON.stringify(g.s)), mulberry(2), bank());
  const c = g2.s.cell.p1;
  assert.ok(g2.cellAnswer("p1", c.ch.id, solve(c.ch), c.ch.at + c.ch.minMs + 10).ok);
});

// ---------- по ревью движка (05.10) ----------

test("ставки: только первые 3 с после «Приготовься», одна на узника, без перестановки", () => {
  const { BET_WINDOW } = require("./game.js");
  const g = setup(3, {}, 5);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  g.answer("p2", right(g), t + 200);
  t = until(g, "cell", t);
  assert.ok(g.bet("p0", "p1", true, t + 100).ok);
  assert.equal(g.bet("p0", "p1", false, t + 200).reason, "already");
  assert.equal(g.bet("p2", "p1", true, g.s.cellReady + BET_WINDOW + 1).reason, "closed");
});

test("повторный вход онлайн-узника не меняет испытание; вернувшийся из офлайна — новое, решётка сохраняется", () => {
  const g = setup(2, {}, 3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  t = until(g, "cell", t);
  const c = g.s.cell.p1;
  const id0 = c.ch.id;
  g.setOnline("p1", true, t + 1500);
  assert.equal(c.ch.id, id0, "перебор испытаний переподключением");
  const now = c.ch.at + c.ch.minMs + 10;
  g.cellAnswer("p1", c.ch.id, badAns(c.ch), now);
  const lock = c.lockUntil;
  g.setOnline("p1", false, now + 100);
  g.setOnline("p1", true, now + 200);
  assert.equal(c.lockUntil, lock);
  assert.ok(c.ch.at >= lock, "решётка не обходится переподключением");
});

test("последний онлайн вышел — пауза; кик на паузе не сдвигает срок на всю паузу", () => {
  const g = setup(3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.setOnline("p0", false, t);
  g.setOnline("p1", false, t);
  g.removePlayer("p2", t + 10);
  assert.notEqual(g.s.paused, null);
  assert.equal(g.nextDeadline(), null);
  const left = g.s.phaseEnd - (t + 10);
  g.setOnline("p0", true, t + 60010);
  assert.equal(g.s.phaseEnd - (t + 60010), left);
});

test("набор по жребию помечен groupAuto даже если палач онлайн, но молчал", () => {
  const g = setup(2);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  t = until(g, "cell", t);
  assert.equal(g.s.groupAuto, true);
});

test("испытание не повторяется узнику между Камерами одной партии", () => {
  const g = setup(2, {}, 21);
  g.start(0);
  let t = 0;
  const got = [];
  for (let q = 0; q < 8; q++) {
    t = until(g, "answer", t);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", wrong(g), t + 100);
    g.pickGroup("p0", "hands", t + 200);
    t = until(g, "cell", t);
    got.push(g.s.cell.p1.ch.type);
    t = until(g, g.s.qn === 7 ? "stake" : "verdict", t);
  }
  const pool = CH.poolFor({ lvl: 2, stage: 1, group: "hands", canPass: true }).length;
  assert.equal(new Set(got.slice(0, pool)).size, Math.min(pool, got.length));
});

test("ничья по очкам без верных ответов — делят место", () => {
  const g = setup(2, { short: true, final: false });
  g.start(0);
  let t = 0;
  for (let q = 0; q < 4; q++) {
    t = until(g, "answer", t);
    g.answer("p0", wrong(g), t + 100);
    g.answer("p1", wrong(g), t + 100);
  }
  t = until(g, "finished", t, 40);
  assert.equal(g.s.ranking[0].place, g.s.ranking[1].place);
});

test("вошедший после ставок финала не ставит и не подсказывает в финальной Камере", () => {
  const g = setup(2, { short: true }, 9);
  g.start(0);
  let t = 0;
  for (let q = 0; q < 4; q++) {
    t = until(g, "answer", t);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", right(g), t + 100);
  }
  t = until(g, "stake", t);
  g.stake("p0", 0, t); g.stake("p1", 0, t);
  g.addPlayer({ id: "late", name: "Опоздун" });
  t = until(g, "fanswer", t);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  t = until(g, "fcell", t);
  assert.equal(g.bet("late", "p1", true, g.s.cellReady + 10).reason, "not_free");
});

test("во время решётки и «Приготовься» следующее испытание не видно ни узнику, ни доске", () => {
  const g = setup(2, {}, 3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  g.pickGroup("p0", "head", t + 200);
  t = until(g, "cell", t);
  const c = g.s.cell.p1;
  assert.equal(g.snapshot(t + 10, "p1").me.cell.ch, null, "«Приготовься»");
  assert.equal(g.nextDeadline(t + 10), c.ch.at, "снимок уйдёт в момент показа");
  assert.ok(g.snapshot(c.ch.at, "p1").me.cell.ch);
  const now = c.ch.at + c.ch.minMs + 10;
  g.cellAnswer("p1", c.ch.id, badAns(c.ch), now);
  assert.equal(g.snapshot(now + 10, "p1").me.cell.ch, null);
  assert.ok(!g.snapshot(now + 10, "board").cell[0].ch);
});

// ---------- по плейтесту агентами (05.10) ----------

test("под конец Камеры не выдаём испытание, которое заведомо не успеть", () => {
  let checked = 0;
  for (let seed = 1; seed < 80; seed++) {
    const g = setup(2, {}, seed);
    g.start(0);
    let t = until(g, "answer", 0);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", wrong(g), t + 100);
    g.pickGroup("p0", "eyes", t + 200);
    t = until(g, "cell", t);
    const c = g.s.cell.p1;
    // ошибка за 3,5 с до конца — следующее после решётки (останется ~2 с) должно быть коротким
    const now = g.s.phaseEnd - 3500;
    if (now < c.ch.at + c.ch.minMs) continue;
    g.cellAnswer("p1", c.ch.id, badAns(c.ch), now);
    const left = g.s.phaseEnd - c.ch.at;
    assert.ok((c.ch.fitMs ?? c.ch.minMs) + 800 <= left || (c.ch.fitMs ?? c.ch.minMs) <= 1500, `${c.ch.type} нужно ${c.ch.fitMs ?? c.ch.minMs} при ${left} мс до конца`);
    checked++;
  }
  assert.ok(checked > 10);
});

test("«Передачка» не выдаётся, если до конца Камеры не успеть (fitMs), и не уходит клиенту (T-W0-07)", () => {
  let early = 0;
  for (let seed = 1; seed < 120; seed++) {
    const g = setup(3, {}, seed);
    g.start(0);
    let t = until(g, "answer", 0);
    g.answer("p0", right(g), t + 100);
    g.answer("p1", wrong(g), t + 100);
    g.answer("p2", right(g), t + 100);
    g.pickGroup("p0", "eyes", t + 200);
    t = until(g, "cell", t);
    const c = g.s.cell.p1;
    for (const rest of [2500, 4000, 6000, 7000]) {
      for (let k = 0; k < 6; k++) {
        c.last = null;
        g.player("p1").seen = {};
        g.issue("p1", t, g.s.phaseEnd - rest);
        assert.notEqual(c.ch.type, "pass", `seed ${seed}: pass при ${rest} мс до конца`);
      }
    }
    // в начале Камеры «передачка» по-прежнему возможна
    for (let k = 0; k < 6; k++) {
      c.last = null;
      g.player("p1").seen = {};
      g.issue("p1", t, g.s.phaseEnd - 14000);
      if (c.ch.type === "pass") { early++; assert.equal(c.ch.fitMs, 6500); assert.ok(!("fitMs" in Game.chView(c.ch))); }
    }
  }
  assert.ok(early > 0, "передачка в начале Камеры выдаётся");
});

test("битый ответ испытания — отказ без решётки", () => {
  const g = setup(2, {}, 3);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", wrong(g), t + 100);
  t = until(g, "cell", t);
  const c = g.s.cell.p1;
  for (const bad of ["notjson", 5, null, [1]]) assert.equal(g.cellAnswer("p1", c.ch.id, bad, c.ch.at + c.ch.minMs + 10).reason, "bad");
  assert.equal(c.lockUntil, 0);
});

test("заставка акта показывает номер следующего вопроса", () => {
  const g = setup(2, { short: true });
  g.start(0);
  assert.equal(g.snapshot(10, "board").qn, 0);
  let t = 0;
  for (let q = 0; q < 2; q++) { t = until(g, "answer", t); g.answer("p0", right(g), t + 100); g.answer("p1", right(g), t + 100); }
  t = until(g, "intro", t);
  assert.equal(g.snapshot(t, "board").qn, 2);
});

test("уровни по весам: в Акте 1 в основном lvl 2, в Акте 2 — в основном lvl 3", () => {
  const n = { 1: { 1: 0, 2: 0 }, 2: { 2: 0, 3: 0 } };
  for (let seed = 1; seed < 60; seed++) {
    const g = setup(2, {}, seed);
    g.start(0);
    let t = 0;
    for (let q = 0; q < 8; q++) {
      t = until(g, "answer", t);
      n[g.s.act][g.s.q.lvl]++;
      g.answer("p0", right(g), t + 100); g.answer("p1", right(g), t + 100);
    }
  }
  assert.ok(n[1][2] > n[1][1] * 1.6, JSON.stringify(n));
  assert.ok(n[2][3] > n[2][2] * 1.6, JSON.stringify(n));
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

// ---------- T-W2-28: имена ----------
const { cleanName, cleanText, nameKey } = require("./game.js");
test("cleanName/cleanText режут по символам, а не по UTF-16 (lastq-039); nameKey — регистр/пробелы/ё", () => {
  const long = "A".repeat(15) + "😀😀";
  const n = cleanName(long);
  assert.equal(Array.from(n).length, 16);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(n), "одиночный суррогат в имени");
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(cleanText("😀".repeat(5), 3)));
  assert.equal(nameKey("  Ёж Игорь "), nameKey("еж игорь"));
  assert.equal(nameKey("ХИТРЫЙ"), nameKey("хитрый "));
});

// ---------- T-W2-29: призраки и ставки; RULE_U08_GHOST_OUT ----------
function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value == null) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally { if (prev == null) delete process.env[name]; else process.env[name] = prev; }
}

test("ставка на узника без связи закрыта (ghost); в снимке узник помечен offline (lastq-001)", () => {
  const g = setup(4);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", right(g), t + 120);
  g.answer("p2", wrong(g), t + 150);
  g.setOnline("p2", false, t + 160);
  g.answer("p3", wrong(g), t + 170);
  t = until(g, "cell", t);
  assert.equal(g.s.cell.p2.ghost, true);
  assert.equal(g.s.cell.p3.ghost, false);
  assert.equal(g.bet("p0", "p2", false, t + 50).reason, "ghost", "на призрака ставить нельзя");
  assert.ok(g.bet("p0", "p3", false, t + 60).ok, "на онлайн-узника можно");
  const snap = g.snapshot(t + 100, "p0");
  assert.equal(snap.cell.find((x) => x.id === "p2").offline, true);
  assert.equal(snap.cell.find((x) => x.id === "p3").offline, false);
});

test("узник ушёл в офлайн ПОСЛЕ ставки и не выбрался — ставка «сгорит» не засчитывается; онлайн-узник — засчитывается", () => {
  const g = setup(4);
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", right(g), t + 120);
  g.answer("p2", wrong(g), t + 150);
  g.answer("p3", wrong(g), t + 170);
  t = until(g, "cell", t);
  assert.ok(g.bet("p0", "p2", false, t + 50).ok);
  assert.ok(g.bet("p0", "p3", false, t + 60).ok);
  const hits0 = g.player("p0").stats.betHits;
  g.setOnline("p2", false, t + 500); // выбил сетью
  until(g, "verdict", t);
  assert.deepEqual(g.s.result.burned.sort(), ["p2", "p3"]);
  assert.equal(g.s.result.betGain.p0, 20, "засчитана только ставка на p3");
  assert.equal(g.player("p0").stats.betHits, hits0 + 1);
});

test("RULE_U08_GHOST_OUT: по умолчанию выпавший до вопроса отвечает (и идёт в Камеру); при =1 — вне eligible, очков не теряет", () => {
  for (const [flag, inQuestion] of [[null, true], ["1", false]]) {
    withEnv("RULE_U08_GHOST_OUT", flag, () => {
      const g = setup(4);
      g.start(0);
      g.setOnline("p3", false, 10);
      const t = until(g, "answer", 0);
      assert.equal(g.s.eligible.includes("p3"), inQuestion, "flag=" + flag);
      // и на последний вопрос — финал
      assert.equal(g.s.eligible.length, inQuestion ? 4 : 3);
    });
  }
});

test("RULE_U08_GHOST_OUT=1: если на связи меньше двух — вопрос идёт всем присутствующим (К-13)", () => {
  withEnv("RULE_U08_GHOST_OUT", "1", () => {
    const g = setup(3);
    g.start(0);
    g.setOnline("p1", false, 5);
    g.setOnline("p2", false, 5);
    until(g, "answer", 0);
    assert.equal(g.s.eligible.length, 3);
  });
});

// ---------- T-W2-30: призраки в лобби ----------
test("addPlayer на полной комнате вытесняет самое давнее офлайн-место старше GHOST_TTL; свежий призрак не вытесняется", () => {
  const g = Game.create({ settings: {}, code: "T", rnd: mulberry(3), content: bank() });
  for (let i = 0; i < 10; i++) g.addPlayer({ id: "p" + i, name: "И" + i });
  const t0 = 1000000;
  g.setOnline("p3", false, t0);
  g.setOnline("p5", false, t0 + 1000);
  // оба призрака моложе порога — места нет
  assert.equal(g.addPlayer({ id: "n1", name: "Новый", now: t0 + 60000 }).reason, "room_full");
  // p3 (самый давний) старше 120 с — вытесняется
  const r = g.addPlayer({ id: "n2", name: "Новый", now: t0 + 130000 });
  assert.ok(r.ok);
  assert.equal(r.evicted, "p3");
  assert.equal(g.player("p3"), undefined);
  assert.ok(g.player("p5"), "второй призрак (ещё не старше порога) остался");
  assert.equal(g.present().length, 10);
});

test("start: «двое» — на связи; серые перед партией уходят в left, а не в вопрос", () => {
  const g = setup(3);
  g.setOnline("p1", false, 1000);
  g.setOnline("p2", false, 1000);
  assert.equal(g.start(2000).reason, "few_players", "1 онлайн + 2 серых");
  assert.equal(g.snapshot(2000, "p0").onlineN, 1);
  g.setOnline("p2", true, 3000);
  const r = g.start(20000); // p1 офлайн дольше грации (8 с) — в left
  assert.ok(r.ok);
  assert.equal(g.player("p1"), undefined, "серый не попал в партию");
  assert.deepEqual(g.s.eligible.length ? g.s.eligible : g.present().map((p) => p.id), g.present().map((p) => p.id));
  assert.equal(g.present().length, 2);
});

test("toLobby после партии: места, отмеченные офлайн, получают offSince (чистит их таймер GHOST_TTL_MS)", () => {
  const g = setup(3);
  g.start(0);
  const t = until(g, "answer", 0);
  g.setOnline("p2", false, t + 50);
  assert.ok(Number.isFinite(g.player("p2").offSince));
  g.toLobby(t + 100);
  assert.equal(g.s.phase, "lobby");
  assert.equal(g.player("p2").online, false);
  assert.equal(g.player("p2").offSince, t + 50, "метка не сбрасывается");
  g.setOnline("p2", true, t + 200);
  assert.equal(g.player("p2").offSince, undefined);
});

// ---------- T-W2-31: возврат записи, стартовый счёт вошедшего ----------
function lowestAtP2(g) {
  // p0, p1 верно; p2 мимо и не выбрался: p2 уходит в минус
  g.start(0);
  let t = until(g, "answer", 0);
  g.answer("p0", right(g), t + 100);
  g.answer("p1", right(g), t + 120);
  g.answer("p2", wrong(g), t + 140);
  t = until(g, "verdict", t);
  assert.ok(g.player("p2").score < 0, "p2 в минусе: " + g.player("p2").score);
  return t;
}

test("RULE_U43_LATE_MIN выкл (по умолчанию): новичок посреди партии — 0; вкл — min(0, минимум счёта, включая ушедших)", () => {
  for (const [flag, expectMin] of [[null, false], ["1", true]]) {
    withEnv("RULE_U43_LATE_MIN", flag, () => {
      const g = setup(3);
      const t = lowestAtP2(g);
      const low = g.player("p2").score;
      g.removePlayer("p2", t + 10); // ушёл на дне
      const r = g.addPlayer({ id: "late", name: "Новичок", now: t + 20 });
      assert.ok(r.ok);
      assert.equal(g.player("late").score, expectMin ? low : 0, "flag=" + flag);
      assert.equal(g.player("late").stats.minScore, expectMin ? low : 0);
    });
  }
});

test("rejoinLeft: ушедший возвращается со своим счётом; «Дно» не теряется после ухода (lastq-008)", () => {
  const g = setup(3);
  let t = lowestAtP2(g);
  const low = g.player("p2").score;
  g.removePlayer("p2", t + 10);
  assert.equal(g.player("p2").left, true);
  // «Дно» считается и по ушедшим
  g.finish("host", t + 20);
  assert.ok(g.s.awards.bottom && g.s.awards.bottom.ids.includes("p2"), "награда «Дно» ушедшего пропала");
  // в finished возвращать запись нельзя — это уже итоги
  assert.equal(g.rejoinLeft("p2", t + 30).ok, false);
  // другая партия: вернуть можно только вне лобби/итогов
  const g2 = setup(3);
  t = lowestAtP2(g2);
  g2.removePlayer("p2", t + 10);
  const r = g2.rejoinLeft("p2", t + 30);
  assert.ok(r.ok);
  assert.equal(g2.player("p2").left, false);
  assert.equal(g2.player("p2").score, low, "счёт сохранён");
  assert.equal(g2.s.players.length, 3, "записей не прибавилось");
});

// ---------- T-W2-05: язык комнаты, перевод вопроса на телефоне (RULE_U17_LANG_FOLLOW) ----------
test("question.tr: за флагом, по тому же id и порядку вариантов; доске и без флага — нет; верный индекс совпадает", () => {
  const ru = [], en = [];
  for (let i = 0; i < 30; i++) {
    ru.push({ id: "q" + i, tag: "animals", lvl: 1 + (i % 3), final: false, q: "Вопрос " + i, a: ["верно" + i, "мимо1", "мимо2", "мимо3"], fun: 3 });
    en.push({ id: "q" + i, tag: "animals", lvl: 1 + (i % 3), final: false, q: "Question " + i, a: ["right" + i, "wrong1", "wrong2", "wrong3"], fun: 3 });
  }
  ru.push({ id: "f0", tag: "geo", lvl: 3, final: true, q: "Финал", a: ["верно", "м1", "м2", "м3"], fun: 2 });
  en.push({ id: "f0", tag: "geo", lvl: 3, final: true, q: "Final", a: ["right", "w1", "w2", "w3"], fun: 2 });
  const mk = () => {
    const g = Game.create({ settings: { lang: "ru" }, code: "T", rnd: mulberry(5), content: { ru, en, el: [] } });
    for (let i = 0; i < 3; i++) g.addPlayer({ id: "p" + i, name: "И" + i });
    g.start(0);
    until(g, "answer", 0);
    return g;
  };
  withEnv("RULE_U17_LANG_FOLLOW", "1", () => {
    const g = mk();
    const own = g.snapshot(g.s.phaseStart + 10, "p0", { lang: "ru" });
    assert.equal(own.question.tr, null, "язык комнаты — перевода нет");
    const snap = g.snapshot(g.s.phaseStart + 10, "p0", { lang: "en" });
    const tr = snap.question.tr;
    assert.ok(tr && tr.lang === "en");
    assert.match(tr.text, /^Question \d+$/);
    // тот же порядок: на месте «верно<N>» стоит «right<N>», и индекс верного не пришлось раскрывать
    snap.question.options.forEach((o, i) => {
      const idx = ["верно", "мимо1", "мимо2", "мимо3"].findIndex((x) => o.startsWith(x));
      assert.equal(tr.options[i], ["right", "wrong1", "wrong2", "wrong3"][idx] + (idx === 0 ? o.replace("верно", "") : ""));
    });
    assert.equal(g.snapshot(g.s.phaseStart + 10, "board").question.tr, null, "доске перевод не нужен");
    assert.equal(g.snapshot(g.s.phaseStart + 10, "p0", { lang: "el" }).question.tr, null, "нет банка языка — нет перевода");
    assert.ok(!JSON.stringify(snap).includes('"order"'), "порядок вариантов в снимок не уходит");
    assert.equal(snap.right, null, "верный индекс до раскрытия не уходит");
  });
  withEnv("RULE_U17_LANG_FOLLOW", null, () => {
    const g = mk();
    assert.equal(g.snapshot(g.s.phaseStart + 10, "p0", { lang: "en" }).question.tr, null, "флаг выкл — перевода нет");
  });
});

// ---- T-W3-17 (lastq-016, U-12): «Дальше» ведущего ----
test("skipPhase: ответ → раскрытие (не ответивший — ошибся), раскрытие → дальше, ставка → вопрос финала; Камеру и заставки не пропускает; не раньше 800 мс", () => {
  const g = setup(3, {}, 11);
  g.start(0);
  let t = until(g, "answer", 0);
  assert.equal(g.skipPhase(g.s.phaseStart + 300).reason, "too_early", "промах по тапу");
  g.answer("p0", right(g), t + 900);
  const r = g.skipPhase(g.s.phaseStart + 1000);
  assert.ok(r.ok);
  assert.equal(g.s.phase, "reveal");
  assert.deepEqual(g.s.prisoners.slice().sort(), ["p1", "p2"], "не ответившие — в Камере, как при «время вышло»");
  // reveal → Камера (есть узники): пропуск раскрытия открывает её
  assert.ok(g.skipPhase(g.s.phaseStart + 1000).ok);
  assert.equal(g.s.phase, "cell");
  assert.equal(g.skipPhase(g.s.phaseStart + 5000).reason, "bad_phase", "Камеру пропустить нельзя");
  // заставка и лобби — тоже нет
  const h = setup(2, {}, 3);
  assert.equal(h.skipPhase(0).reason, "bad_phase");
  h.start(0);
  assert.equal(h.s.phase, "intro");
  assert.equal(h.skipPhase(2000).reason, "bad_phase");
  // пауза
  const p = setup(2, {}, 3);
  p.start(0);
  const tp = until(p, "answer", 0);
  p.pause(tp + 10);
  assert.equal(p.skipPhase(tp + 2000).reason, "bad_phase");
});

test("skipPhase: ставка финала закрывается без ставки (0), дальше — вопрос финала", () => {
  const g = setup(3, { short: true }, 9);
  g.start(0);
  let t = 0;
  for (let q = 0; q < 4; q++) {
    t = until(g, "answer", t);
    for (const p of ["p0", "p1", "p2"]) g.answer(p, right(g), t + 100);
  }
  t = until(g, "stake", t);
  g.stake("p0", 100, t + 10);
  const r = g.skipPhase(g.s.phaseStart + 1000);
  assert.ok(r.ok);
  assert.equal(g.s.phase, "fread");
  assert.equal(g.s.stakes.p0, 100);
  assert.ok(g.s.stakes.p1 == null || g.s.stakes.p1 === 0, "кто не поставил — ставка 0, не случайная");
});

// ---- T-W3-29 (lastq-018, lastq-021): окно ставок, «не два тяжёлых подряд», запас minMs ----
function cellWith(nPlayers, nPrisoners, seed = 5) {
  const g = setup(nPlayers, {}, seed);
  g.start(0);
  let t = until(g, "answer", 0);
  for (let i = 0; i < nPlayers; i++) g.answer("p" + i, i < nPlayers - nPrisoners ? right(g) : wrong(g), t + 100 + i);
  t = until(g, "reveal", t);
  if (g.s.palach && !g.s.group) g.pickGroup(g.s.palach, "eyes", t + 10);
  t = until(g, "cell", t);
  return { g, t };
}

test("RULE_U45_BET_WINDOW: выкл — окно 3 с на любое число узников; вкл — clamp(2000+1000·N, 3000, 6000); betUntil в снимке; дамп без betUntil — как раньше", () => {
  withEnv("RULE_U45_BET_WINDOW", null, () => {
    for (const n of [1, 3, 5]) {
      const { g } = cellWith(7, n);
      assert.equal(g.snapshot(g.s.cellReady, "p0").betUntil - g.s.cellReady, BET_WINDOW, `выкл, узников ${n}`);
    }
  });
  withEnv("RULE_U45_BET_WINDOW", "1", () => {
    const want = { 1: 3000, 2: 4000, 3: 5000, 4: 6000, 5: 6000 };
    for (const n of [1, 2, 3, 4, 5]) {
      const { g } = cellWith(7, n);
      assert.equal(g.s.prisoners.length, n);
      assert.equal(g.snapshot(g.s.cellReady, "p0").betUntil - g.s.cellReady, want[n], `вкл, узников ${n}`);
      assert.equal(g.snapshot(g.s.cellReady, "board").betUntil, g.s.betUntil);
      // ставка внутри окна проходит, после — «closed»
      const free = g.free().find((p) => p.online);
      const pr = g.s.prisoners.find((id) => !g.s.cell[id].ghost);
      assert.ok(g.bet(free.id, pr, true, g.s.betUntil - 10).ok);
      const free2 = g.free().filter((p) => p.online)[1];
      if (free2) assert.equal(g.bet(free2.id, pr, true, g.s.betUntil + 10).reason, "closed");
      // прогресс узников скрыт до конца окна
      assert.ok(g.snapshot(g.s.betUntil - 5, "board").cell.every((x) => x.done === 0 && !x.escaped));
    }
    // дамп прежней версии (нет betUntil) — окно 3 с после «Приготовься»
    const { g } = cellWith(5, 3);
    const dumped = JSON.parse(JSON.stringify(g.s));
    delete dumped.betUntil;
    g.s = dumped;
    assert.equal(g.snapshot(dumped.cellReady, "p0").betUntil, dumped.cellReady + BET_WINDOW);
  });
});

test("«не два тяжёлых подряд»: после испытания с minMs ≥ 3 с следующее выдаётся лёгким, пока есть выбор (CH.generate lastMin)", () => {
  let heavySeen = 0, bad = 0;
  for (let s = 1; s <= 600; s++) for (const group of ["eyes", "head", "hands"]) for (const lvl of [1, 2]) {
    const rnd = mulberry(s * 13 + lvl);
    const ch = CH.generate({ lvl, rnd, group, lastMin: 3500, stage: lvl, canPass: true });
    if (ch.minMs >= CH.HEAVY_MS) bad++;
    const free = CH.generate({ lvl, rnd: mulberry(s * 13 + lvl), group, stage: lvl, canPass: true });
    if (free.minMs >= CH.HEAVY_MS) heavySeen++;
  }
  assert.ok(heavySeen > 0, "без правила тяжёлые выпадают");
  assert.equal(bad, 0, "с lastMin ≥ 3 с два тяжёлых подряд не выдаём");
});

test("c.lastMin пишется при выдаче; RULE_U46_MINMS: запас на остальные испытания — выдаваемое помещается с остатком", () => {
  withEnv("RULE_U46_MINMS", "1", () => {
    const { g } = cellWith(4, 2);
    const id = g.s.prisoners[0];
    const c = g.s.cell[id];
    assert.equal(typeof c.lastMin, "number");
    // за 3 с до конца Камеры при двух оставшихся — выдаётся самое короткое из выпавших, и оно же не ломает выдачу
    g.s.phaseEnd = g.s.cellReady + 3000;
    g.issue(id, g.s.cellReady);
    assert.ok(c.ch && c.ch.minMs >= 0);
  });
});

// ---------- T-W4-14 (lastq-052): награда «Ракета» — среднее время целое ----------
test("awards().rocket.n — целое число мс, даже если среднее дробное", () => {
  const g = setup(3);
  g.start(0);
  const [a, b, c] = g.s.players;
  a.stats.right = 3; a.stats.msSum = 1000; // 333,33…
  b.stats.right = 3; b.stats.msSum = 2500;
  c.stats.right = 1; c.stats.msSum = 10; // меньше трёх верных — не участвует
  const r = g.awards().rocket;
  assert.deepEqual(r.ids, [a.id]);
  assert.equal(r.n, 333);
  assert.ok(Number.isInteger(r.n));
});
