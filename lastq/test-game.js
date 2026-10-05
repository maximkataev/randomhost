"use strict";
// Движок «Последнего вопроса»: node --test test-game.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { Game, T, ACTS, BET_POINTS, PASS_SILENCE } = require("./game.js");
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
    assert.ok(c.ch.minMs + 800 <= left || c.ch.minMs <= 1500, `${c.ch.type} minMs ${c.ch.minMs} при ${left} мс до конца`);
    checked++;
  }
  assert.ok(checked > 10);
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
