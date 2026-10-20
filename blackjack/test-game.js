"use strict";

// Тесты движка блэкджека (blackjack-spec.md §12): node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const G = require("./game");
const { Game, T, LEVELS, PACE, handValue, isBlackjack, perfectPairs, twentyOnePlusThree, RANKS, SUITS, SHOE_SIZE, CUT, PP, TP } = G;

// Детерминированная случайность: очередь заданных значений, дальше — простой LCG
function rig(queue, seed) {
  let x = seed || 1;
  const f = (n) => {
    if (f.queue.length) return f.queue.shift() % n;
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % n;
  };
  f.queue = (queue || []).slice();
  return f;
}

const C = (str) => G.parseCard(str);

// Партия с игроками, уже в фазе ставок первой раздачи. Карт-пакостей по умолчанию нет — они мешают считать деньги.
function game(names, settings, rnd) {
  const g = Game.create({ settings: Object.assign({ cards: false }, settings || {}), rnd: rnd || rig() });
  (names || ["A", "B"]).forEach((n) => g.addPlayer({ id: n, name: n }));
  const r = g.start(0);
  assert.ok(r.ok, r.reason);
  return g;
}

// Подложить карты в шуз в порядке сдачи: первая строка — первая карта со стола
function rigShoe(g, cards) {
  g.s.shoe = cards.slice().reverse();
}

// Довести раздачу от ставок до решений (или до конца, если решений нет). insurance — {id: choice}
function toDeciding(g, now, insurance) {
  now = now || 1000;
  g.closeBets(now);
  while (g.s.phase === "closing" || g.s.phase === "dealing") { now = g.s.deadline; g.tick(now); }
  if (g.s.phase === "insurance") {
    if (insurance) for (const id of Object.keys(insurance)) g.insure(id, insurance[id], now + 10);
    if (g.s.phase === "insurance") { now = g.s.deadline; g.tick(now); }
  }
  return now;
}

// Прогнать от текущей фазы до выплат; actions — {id: action | [actions by hand]} на каждую волну (одно и то же решение на все волны)
function toPayout(g, now, actions) {
  let guard = 0;
  while (g.s.phase !== "payout" && g.s.phase !== "finished" && guard++ < 50) {
    if (g.s.phase === "deciding") {
      const wave = g.s.wave;
      for (const x of g.pending()) {
        if (g.s.phase !== "deciding" || g.s.wave !== wave) break;
        const a = actions && actions[x.p.id];
        const act = Array.isArray(a) ? a[x.i] : a;
        if (act) { const r = g.decide(x.p.id, x.i, act, now + 10); assert.ok(r.ok, `${x.p.id}: ${act} ${r.reason}`); }
      }
      if (g.s.phase === "deciding" && g.s.wave === wave) { now = g.s.deadline; g.tick(now); } else now += 10;
    } else { now = g.s.deadline; g.tick(now); }
  }
  return now;
}

// Полная раздача: ставки уже стоят
function playHand(g, opts) {
  opts = opts || {};
  if (opts.shoe) rigShoe(g, opts.shoe);
  let now = toDeciding(g, opts.now, opts.insurance);
  now = toPayout(g, now, opts.actions);
  return now;
}

const total = (g) => g.s.players.reduce((a, p) => a + p.stack, 0);

// ---------- синтаксис и независимость от Node ----------

function stripCode(src) {
  let out = "", i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

test("game.js и strategy.js: синтаксис ES2017, без require, грузятся в пустом окне браузера", () => {
  const FORBIDDEN = [
    [/\?\.(?!\d)/, "optional chaining ?."], [/\?\?/, "nullish ??"], [/\.\.\./, "rest/spread ..."], [/\bcatch\s*\{/, "optional catch binding"],
    [/\.at\s*\(/, ".at()"], [/\.replaceAll\s*\(/, "replaceAll"], [/\bObject\.hasOwn\b/, "Object.hasOwn"], [/\bstructuredClone\b/, "structuredClone"],
    [/\?\?=|\|\|=|&&=/, "logical assignment"], [/\d_\d/, "numeric separator"], [/\bObject\.fromEntries\b/, "Object.fromEntries"], [/\.flat(Map)?\s*\(/, ".flat()"],
  ];
  for (const file of ["game.js", "strategy.js"]) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    const code = stripCode(src);
    for (const [re, label] of FORBIDDEN) assert.ok(!re.test(code), `${file}: ${label}`);
    assert.ok(!/\brequire\s*\(/.test(code), `${file}: require`);
    assert.ok(!/\bprocess\b|\bBuffer\b/.test(code), `${file}: Node-глобалы`);
    const win = {};
    vm.runInNewContext(src, { window: win, Math, Number, String, Array, Object, Set, Map, RegExp, JSON, Date });
    assert.ok(win.BlackjackGame || win.BlackjackStrategy, `${file}: window.* не выставлен`);
  }
});

// ---------- карты и руки ----------

test("подсчёт рук: мягкие/жёсткие, туз как 1 и 11, блэкджек ≠ 21 после сплита", () => {
  assert.deepStrictEqual(handValue([C("As"), C("6h")]), { value: 17, soft: true });
  assert.deepStrictEqual(handValue([C("As"), C("6h"), C("Kd")]), { value: 17, soft: false });
  assert.deepStrictEqual(handValue([C("As"), C("Ad")]), { value: 12, soft: true });
  assert.deepStrictEqual(handValue([C("As"), C("Ad"), C("9c")]), { value: 21, soft: true });
  assert.deepStrictEqual(handValue([C("10s"), C("6h")]), { value: 16, soft: false });
  assert.deepStrictEqual(handValue([C("Ks"), C("Qh"), C("5d")]), { value: 25, soft: false });
  assert.ok(isBlackjack([C("As"), C("Kd")], false));
  assert.ok(isBlackjack([C("Qs"), C("Ad")], false));
  assert.ok(!isBlackjack([C("As"), C("Kd")], true), "после сплита — просто 21");
  assert.ok(!isBlackjack([C("7s"), C("7d"), C("7c")], false));
  assert.ok(G.isPair([C("Ks"), C("10d")]), "две разные десятки — пара");
  assert.ok(!G.isPair([C("As"), C("Kd")]));
});

test("Perfect Pairs и 21+3: перебор всех троек карт против прямого определения", () => {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push({ r, s });
  const idx = (r) => RANKS.indexOf(r);
  const color = (s) => (s === "h" || s === "d" ? "r" : "b");
  let pp = { none: 0, mixed: 0, colored: 0, perfect: 0 };
  let tp = { none: 0, flush: 0, straight: 0, trips: 0, straightFlush: 0, suitedTrips: 0 };
  for (const a of deck) for (const b of deck) {
    if (a === b) continue;
    const r = perfectPairs(a, b);
    const expect = a.r !== b.r ? null : a.s === b.s ? "perfect" : color(a.s) === color(b.s) ? "colored" : "mixed";
    assert.strictEqual(r ? r.kind : null, expect, `PP ${a.r}${a.s} ${b.r}${b.s}`);
    if (r) assert.strictEqual(r.mult, PP[r.kind]);
    pp[expect || "none"]++;
    for (const u of deck) {
      if (u === a || u === b) continue;
      const t = twentyOnePlusThree(a, b, u);
      const flush = a.s === b.s && b.s === u.s;
      const trips = a.r === b.r && b.r === u.r;
      const v = [idx(a.r), idx(b.r), idx(u.r)].sort((x, y) => x - y);
      const straight = v[0] !== v[1] && v[1] !== v[2] && ((v[1] === v[0] + 1 && v[2] === v[1] + 1) || (v[0] === 0 && v[1] === 11 && v[2] === 12));
      const e = trips && flush ? "suitedTrips" : straight && flush ? "straightFlush" : trips ? "trips" : straight ? "straight" : flush ? "flush" : null;
      assert.strictEqual(t ? t.kind : null, e, `21+3 ${a.r}${a.s} ${b.r}${b.s} ${u.r}${u.s}`);
      if (t) assert.strictEqual(t.mult, TP[t.kind]);
      tp[e || "none"]++;
    }
  }
  // контроль, что перебор что-то нашёл: тройка одной масти в одной колоде невозможна, остальное — есть
  assert.ok(pp.mixed > 0 && pp.colored > 0 && pp.perfect === 0 && tp.straightFlush > 0 && tp.trips > 0 && tp.suitedTrips === 0);
  // в шузе на 6 колод одномастная пара и тройка одной масти есть
  assert.strictEqual(perfectPairs(C("As"), C("As")).kind, "perfect");
  assert.strictEqual(twentyOnePlusThree(C("7s"), C("7s"), C("7s")).kind, "suitedTrips");
  assert.strictEqual(twentyOnePlusThree(C("Qs"), C("Ks"), C("As")).kind, "straightFlush");
  assert.strictEqual(twentyOnePlusThree(C("As"), C("2d"), C("3h")).kind, "straight");
  assert.strictEqual(twentyOnePlusThree(C("Kd"), C("As"), C("2s")), null, "через туз стрита нет");
  assert.deepStrictEqual(PP, { mixed: 5, colored: 10, perfect: 25 });
  assert.deepStrictEqual(TP, { flush: 5, straight: 10, trips: 30, straightFlush: 40, suitedTrips: 100 });
});

test("побочные ставки: каждая не больше основной, выплачиваются сразу при раздаче, в минимум не входят", () => {
  const g = game();
  assert.strictEqual(g.sideBet("A", "pp", 10).reason, "over_main");
  g.bet("A", 100);
  assert.strictEqual(g.sideBet("A", "pp", 101).reason, "over_main");
  assert.ok(g.sideBet("A", "pp", 100).ok);
  assert.ok(g.sideBet("A", "tp", 50).ok);
  assert.strictEqual(g.sideBet("A", "xx", 5).reason, "bad_box");
  g.bet("B", 10);
  // A: 8s 8s — perfect pair (25:1); A+дилер: 8s 8s 8d — тройка (30:1)
  rigShoe(g, ["8s", "5h", "8d", "8s", "9c", "7h", "4c"]);
  g.closeBets(1000);
  g.tick(g.s.deadline); // раздача
  assert.strictEqual(g.s.phase, "dealing");
  const a = g.player("A");
  assert.strictEqual(a.sideResults.pp.kind, "perfect");
  assert.strictEqual(a.sideResults.tp.kind, "trips");
  assert.strictEqual(a.stack, 1000 + 100 * 25 + 50 * 30, "побочные выплачены сразу: ставка вернулась и выигрыш");
  assert.ok(g.s.dealer.jackpot, "25:1 — джекпот");
  // «Отменить» снимает последнюю фишку и урезает побочные до основной
  const h = game();
  h.bet("A", 50); h.sideBet("A", "pp", 50); h.bet("A", 50);
  h.unbet("A");
  assert.deepStrictEqual([h.player("A").bet, h.player("A").side.pp], [50, 50]);
  h.unbet("A");
  assert.deepStrictEqual([h.player("A").bet, h.player("A").side.pp], [50, 0]);
});

// ---------- выплаты ----------

test("выплаты: блэкджек 3:2, выигрыш 1:1, пуш, перебор; стеки меняются только в settle", () => {
  const g = game(["A", "B", "C"]);
  g.bet("A", 100); g.bet("B", 100); g.bet("C", 100);
  // A: K A (блэкджек), B: 10 7 (17 — пуш с дилером), C: 9 6 → берёт K → перебор; дилер 9 8 = 17
  const shoe = ["Ks", "10d", "9c", "9h", "Ad", "7s", "6d", "8c", "Kh"];
  rigShoe(g, shoe);
  let now = toDeciding(g, 1000);
  assert.strictEqual(g.s.phase, "deciding");
  assert.ok(g.player("A").hands[0].done, "блэкджек решений не ждёт");
  assert.strictEqual(g.decide("B", 0, "stand", now).reason, undefined);
  const r = g.decide("C", 0, "hit", now);
  assert.ok(r.ok);
  assert.strictEqual(g.s.phase, "dealer", "все решили — волна закрылась сама");
  assert.strictEqual(g.player("A").stack, 1000, "до settle стек не меняется");
  now = g.s.deadline; g.tick(now);
  assert.strictEqual(g.s.phase, "payout");
  assert.strictEqual(g.player("A").stack, 1150);
  assert.strictEqual(g.player("B").stack, 1000);
  assert.strictEqual(g.player("C").stack, 900);
  assert.deepStrictEqual(g.player("A").hands[0].result, "bj");
  assert.deepStrictEqual(g.player("B").hands[0].result, "push");
  assert.deepStrictEqual(g.player("C").hands[0].result, "lose");
  assert.strictEqual(total(g), 3000 - g.s.casino.won + g.s.casino.paid);
});

test("подглядывание: блэкджек дилера заканчивает раздачу, блэкджек игрока — пуш, страховка 2:1, even money 1:1", () => {
  let g = game(["A", "B", "C"]);
  g.bet("A", 100); g.bet("B", 100); g.bet("C", 100);
  // A: 10 A (бж), B: K 9, C: 5 5; дилер: A + K (бж)
  rigShoe(g, ["10s", "Kd", "5c", "Ah", "Ad", "9s", "5d", "Kc"]);
  g.closeBets(1000);
  while (g.s.phase !== "insurance") g.tick(g.s.deadline);
  assert.ok(g.s.dealer.insurance);
  assert.strictEqual(g.snapshot(5000, "A").dealer.hole, null, "до вскрытия закрытой карты не видно");
  assert.strictEqual(g.snapshot(5000, null).dealer.hole, null, "и доске тоже");
  assert.strictEqual(g.insure("A", true, 5000).reason, "even_money_only");
  assert.strictEqual(g.insure("B", "evenMoney", 5000).reason, "no_blackjack");
  assert.ok(g.insure("A", "evenMoney", 5000).ok);
  assert.ok(g.insure("B", true, 5000).ok);
  assert.strictEqual(g.player("B").insurance, 50);
  const r = g.insure("C", false, 5000);
  assert.ok(r.ok);
  assert.strictEqual(g.s.phase, "dealer", "все ответили — дилер подглядел");
  assert.strictEqual(g.s.dealer.plot, "dealerbj");
  g.tick(g.s.deadline);
  assert.strictEqual(g.player("A").stack, 1100, "even money: ровно 1:1 даже против блэкджека");
  assert.strictEqual(g.player("B").stack, 1000, "проиграл 100, страховка 50 принесла 100");
  assert.strictEqual(g.player("C").stack, 900);
  assert.strictEqual(g.player("B").hands[0].result, "lose");

  // игрок с блэкджеком без even money — пуш; страховка без блэкджека дилера сгорает; при десятке — молчаливое подглядывание
  g = game(["A", "B"]);
  g.bet("A", 100); g.bet("B", 100);
  rigShoe(g, ["As", "7d", "Ah", "Kd", "9s", "5c", "Kh"]); // дилер A+5, B стоит на 16, дилер берёт K → 16+... A5K = 16 → ещё
  g.closeBets(1000);
  while (g.s.phase !== "insurance") g.tick(g.s.deadline);
  g.insure("B", true, 2000);
  g.tick(g.s.deadline); // A не ответил — без страховки
  assert.strictEqual(g.s.phase, "deciding", "блэкджека нет — к решениям");
  assert.ok(!g.player("A").evenMoney);
  playHand(g, { actions: { B: "stand" } });
  assert.strictEqual(g.player("A").hands[0].result, "bj");
  assert.strictEqual(g.player("A").stack, 1150);
  const bRes = g.player("B").hands[0].result;
  assert.strictEqual(g.s.result.perPlayer.B.insWin, 0, "страховка сгорела");
  assert.strictEqual(g.player("B").stack, 950 + (bRes === "win" ? 100 : bRes === "push" ? 0 : -100));

  g = game(["A", "B"]);
  g.bet("A", 10); g.bet("B", 10);
  rigShoe(g, ["As", "7d", "Kh", "Kd", "9s", "5c"]);
  g.closeBets(1000);
  while (g.s.phase !== "insurance") g.tick(g.s.deadline);
  assert.strictEqual(g.s.dealer.peek, "ten");
  assert.ok(!g.s.dealer.insurance);
  assert.strictEqual(g.s.deadline - g.s.events[g.s.events.length - 1].t, T.peek);
  assert.strictEqual(g.insure("B", true, 2000).reason, "closed");
});

// ---------- удвоение и сплит ----------

test("удвоение: ставка ×2 и одна карта; нельзя без фишек и на трёх картах", () => {
  const g = game();
  g.player("B").stack = 150;
  g.bet("A", 100); g.bet("B", 100);
  // A: 6 5 (11), B: 6 5; дилер 10 7; A удваивает → K = 21; B не может удвоить
  rigShoe(g, ["6s", "6d", "10c", "5h", "5d", "7s", "Kh", "2c"]);
  const now = toDeciding(g, 1000);
  assert.strictEqual(g.decide("B", 0, "double", now).reason, "not_allowed");
  assert.ok(!g.options(g.player("B"), g.player("B").hands[0]).double);
  assert.ok(g.decide("B", 0, "hit", now).ok);
  assert.ok(g.decide("A", 0, "double", now).ok);
  // B взял 2 → 13, волна 2; удвоить уже нельзя
  assert.strictEqual(g.s.wave, 2);
  assert.ok(g.player("A").hands[0].doubled && g.player("A").hands[0].done);
  assert.strictEqual(g.player("A").hands[0].bet, 200);
  assert.strictEqual(g.decide("A", 0, "stand", now).reason, "hand_done");
  assert.strictEqual(g.decide("B", 0, "double", now).reason, "not_allowed");
  g.decide("B", 0, "stand", now);
  g.tick(g.s.deadline);
  assert.strictEqual(g.player("A").stack, 1200, "удвоенная ставка 200 выиграла 1:1");
  assert.strictEqual(g.player("B").stack, 50);
  assert.strictEqual(g.decide("A", 0, "fly", 1).reason, "closed");
});

test("сплит: две руки в следующей волне, удвоение после сплита, сплит тузов по одной карте, ре-сплита нет, нужны фишки", () => {
  const g = game(["A", "B", "C"]);
  g.player("C").stack = 100;
  g.bet("A", 100); g.bet("B", 100); g.bet("C", 100);
  // A: 8 8, B: A A, C: 9 9; дилер 6 K; после сплита: A1←3 (11), A2←8 (16), B1←K, B2←5; A1 удваивает ← 10 = 21; A2 стоит; дилер берёт 5 → 21
  rigShoe(g, ["8s", "As", "9s", "6d", "8d", "Ad", "9d", "Kc", "3h", "8h", "Kh", "5h", "10s", "5s"]);
  const now = toDeciding(g, 1000);
  assert.strictEqual(g.decide("C", 0, "split", now).reason, "not_allowed", "на сплит не хватает фишек");
  assert.ok(g.decide("A", 0, "split", now).ok);
  assert.ok(g.decide("B", 0, "split", now).ok);
  assert.strictEqual(g.decide("A", 0, "split", now).reason, undefined, "решение можно менять до закрытия волны");
  g.decide("C", 0, "stand", now);
  assert.strictEqual(g.s.wave, 2);
  const a = g.player("A"), b = g.player("B");
  assert.strictEqual(a.hands.length, 2);
  assert.deepStrictEqual(a.hands.map((h) => h.cards.map(G.packCard)), [["8s", "3h"], ["8d", "8h"]]);
  assert.ok(a.hands.every((h) => h.fromSplit && !h.done), "обе руки сплита решаются в одной волне");
  assert.deepStrictEqual(b.hands.map((h) => h.cards.map(G.packCard)), [["As", "Kh"], ["Ad", "5h"]]);
  assert.ok(b.hands.every((h) => h.done), "тузы: по одной карте, без добора");
  assert.ok(!isBlackjack(b.hands[0].cards, b.hands[0].fromSplit), "A+K после сплита — 21, не блэкджек");
  assert.ok(!g.options(a, a.hands[1]).split, "ре-сплита нет");
  assert.ok(g.options(a, a.hands[0]).double, "удвоение после сплита");
  g.decide("A", 0, "double", now + 100);
  const r = g.decide("A", 1, "stand", now + 100);
  assert.ok(r.ok);
  assert.strictEqual(g.s.phase, "dealer");
  g.tick(g.s.deadline);
  assert.strictEqual(handValue(g.s.dealer.cards).value, 21);
  assert.deepStrictEqual(a.hands.map((h) => h.result), ["push", "lose"]);
  assert.strictEqual(a.stack, 1000 - 100, "21 на удвоенной — пуш (200 назад), 16 — минус 100");
  assert.deepStrictEqual(b.hands.map((h) => h.result), ["push", "lose"]);
  assert.strictEqual(g.player("C").stack, 0, "18 против 21 — выбыл");
  assert.ok(g.player("C").out);
});

test("две руки после сплита не могут удвоиться на одни и те же фишки", () => {
  const g = game();
  g.player("A").stack = 300;
  g.bet("A", 100); g.bet("B", 10);
  rigShoe(g, ["8s", "2d", "6c", "8d", "3d", "Kc", "3h", "3c", "9s", "9d", "7h"]);
  const now = toDeciding(g, 1000);
  g.decide("A", 0, "split", now);
  g.decide("B", 0, "stand", now);
  const a = g.player("A");
  assert.ok(g.options(a, a.hands[0]).double);
  g.decide("A", 0, "double", now + 10);
  assert.ok(!g.options(a, a.hands[1]).double, "фишки обещаны первой руке");
  assert.strictEqual(g.decide("A", 1, "double", now + 10).reason, "not_allowed");
});

// ---------- волны ----------

test("волны: таймаут = «Хватит», карты добора в порядке мест, офлайн не держит стол", () => {
  const g = game(["A", "B", "C"]);
  g.bet("A", 10); g.bet("B", 10); g.bet("C", 10);
  rigShoe(g, ["5s", "6d", "7c", "9h", "5d", "6s", "7d", "8c", "2s", "3s", "4s"]);
  const now = toDeciding(g, 1000);
  assert.strictEqual(g.s.wave, 1);
  assert.strictEqual(g.s.deadline, now + T.wave1);
  g.decide("C", 0, "hit", now);
  g.decide("A", 0, "hit", now);
  g.tick(g.s.deadline); // B не решил — хватит
  const b = g.player("B");
  assert.ok(b.hands[0].done && b.hands[0].decision === "stand" && b.hands[0].auto);
  const cards = g.s.events.filter((e) => e.type === "card").map((e) => e.playerId + ":" + G.packCard(e.card));
  assert.deepStrictEqual(cards, ["A:2s", "C:3s"], "сдача по местам, не по порядку нажатий");
  assert.strictEqual(g.s.wave, 2);
  assert.strictEqual(g.s.deadline, g.s.waveStart + T.wave);
  assert.strictEqual(g.s.waveStart, now + T.wave1 + 2 * T.hitCard, "следующая волна — после подлёта карт");
  // C ушёл в офлайн: A решил — волна закрывается, C получает «хватит»
  g.setOnline("C", false, g.s.waveStart);
  const r = g.decide("A", 0, "stand", g.s.waveStart + 100);
  assert.ok(r.ok);
  assert.strictEqual(g.s.phase, "dealer");
  assert.ok(g.player("C").hands[0].auto);
});

// ---------- штрафы, ва-банк, выбывание ----------

test("штраф: ничего не поставил — платит минимум и пропускает; меньше минимума — платит разницу и играет", () => {
  const g = game(["A", "B", "C"]);
  assert.strictEqual(g.levelNeed(), 10);
  g.bet("A", 4);
  g.bet("B", 10);
  const ev = g.closeBets(1000);
  const a = g.player("A"), c = g.player("C");
  assert.strictEqual(a.penalty, 6);
  assert.strictEqual(a.stack, 994);
  assert.ok(a.inHand);
  assert.strictEqual(c.penalty, 10);
  assert.ok(c.skip && !c.inHand);
  assert.strictEqual(c.stack, 990);
  assert.deepStrictEqual(ev.filter((e) => e.type === "penalty").map((e) => [e.playerId, e.amount, e.skip]), [["A", 6, false], ["C", 10, true]]);
  assert.strictEqual(g.s.casino.won, 16);
  playHand(g, { actions: { A: "stand", B: "stand" } });
  assert.strictEqual(c.hands.length, 0, "пропустивший карт не получает");
  assert.strictEqual(total(g), 3000 - g.s.casino.won + g.s.casino.paid);
});

test("штраф больше стека — отдаёт всё и выбывает; стек меньше минимума — ва-банк без штрафа", () => {
  const g = game(["A", "B", "C"]);
  g.player("A").stack = 5;
  g.player("B").stack = 7;
  g.bet("B", 7); // меньше минимума 10, но весь стек — штрафа нет
  g.bet("C", 10);
  const ev = g.closeBets(1000);
  assert.strictEqual(g.player("A").stack, 0);
  assert.ok(g.player("A").out);
  assert.ok(ev.some((e) => e.type === "out" && e.playerId === "A"));
  assert.strictEqual(g.player("B").penalty, 0);
  assert.strictEqual(g.need(g.player("B")), 7);
  assert.ok(g.player("B").inHand);
});

test("ва-банк: вся свободная часть стека; выбывание после выплат; все обнулились разом — выше тот, у кого было больше", () => {
  let g = game(["A", "B", "C"]);
  g.sideBet("A", "pp", 0);
  assert.ok(g.allIn("A").ok);
  assert.strictEqual(g.player("A").bet, 1000);
  assert.strictEqual(g.bet("A", 1).reason, "no_money");
  g.bet("B", 10); g.bet("C", 10);
  // A: 10 6 стоит; дилер 10 7 = 17 → A проиграл всё
  rigShoe(g, ["10s", "2d", "3c", "10h", "6d", "4s", "5h", "7c"]);
  playHand(g, { actions: { A: "stand", B: "stand", C: "stand" } });
  assert.strictEqual(g.player("A").stack, 0);
  assert.ok(g.player("A").out);
  assert.strictEqual(g.s.phase, "payout");
  assert.strictEqual(g.s.finishAfterPayout, false);

  g = game(["A", "B"]);
  g.player("A").stack = 30;
  g.player("B").stack = 50;
  g.allIn("A"); g.allIn("B");
  rigShoe(g, ["10s", "10d", "Kc", "6h", "6d", "9c"]);
  playHand(g, { actions: { A: "stand", B: "stand" } });
  assert.strictEqual(g.s.finishedReason, "all_out");
  assert.strictEqual(g.s.winnerId, "B");
  g.tick(g.s.deadline);
  assert.strictEqual(g.s.phase, "finished");
  assert.deepStrictEqual(g.s.players.map((p) => p.place), [2, 1]);
});

test("уровни: минимум растёт по темпу, держится на последнем, в овертайме — доля среднего стека; «N раздач» без овертайма", () => {
  const g = game(["A", "B"]);
  const seen = [];
  for (let i = 0; i < 30; i++) {
    for (const p of g.s.players) p.stack = 100000;
    g.s.avgStack = 100000; // средний стек фиксируется в начале раздачи — выравниваем вручную
    seen.push(g.levelNeed());
    g.bet("A", g.levelNeed()); g.bet("B", g.levelNeed());
    playHand(g, { actions: { A: "stand", B: "stand" } });
    g.tick(g.s.deadline);
  }
  const pace = g.paceHands();
  for (let i = 0; i < 10; i++) assert.strictEqual(seen[i * pace], (1000 * LEVELS[i]) / 100, `уровень ${i}`);
  assert.strictEqual(seen[10 * pace], 25000, "овертайм: 25% от среднего стека 100000");
  assert.strictEqual(seen[11 * pace], 50000);
  assert.strictEqual(seen[12 * pace], 100000);
  assert.strictEqual(seen[29], 100000, "последний уровень держится");

  const h = game(["A", "B"], { format: "hands", handsTotal: 30, pace: "fast" });
  for (const p of h.s.players) p.stack = 100000;
  assert.strictEqual(h.levelFor(30), LEVELS.length - 1, "в «N раздач» овертайма нет");
});

// ---------- форматы ----------

test("«до последнего»: остался один — победа, остальные по местам", () => {
  const g = game(["A", "B", "C"]);
  g.player("B").stack = 10;
  g.player("C").stack = 10;
  g.bet("A", 10); g.bet("B", 10); g.bet("C", 10);
  rigShoe(g, ["10s", "10d", "10c", "10h", "9d", "6s", "6h", "8c"]); // дилер 10 8 = 18; A 19, B 16, C 16
  playHand(g, { actions: { A: "stand", B: "stand", C: "stand" } });
  assert.strictEqual(g.s.winnerId, "A");
  assert.strictEqual(g.s.finishedReason, "last");
  g.tick(g.s.deadline);
  assert.strictEqual(g.s.phase, "finished");
  assert.strictEqual(g.player("A").place, 1);
  assert.ok(g.snapshot(0, "A").stats);
});

test("«N раздач»: конец после N, ничья делится; разорившийся — зритель, партия идёт", () => {
  const g = game(["A", "B", "C"], { format: "hands", handsTotal: 15 });
  g.player("C").stack = 10;
  for (let i = 0; i < 15; i++) {
    assert.strictEqual(g.s.phase, "betting");
    for (const p of g.alive()) { p.stack = i === 14 ? 777 : p.stack; g.bet(p.id, g.need(p)); }
    rigShoe(g, ["10s", "10d", "10c", "10h", "9d", "6s", "6h", "8c", "2c", "3c"]);
    playHand(g, { actions: { A: "stand", B: "stand", C: "stand" } });
    if (i === 0) { assert.ok(g.player("C").out); assert.strictEqual(g.s.phase, "payout"); }
    if (i < 14) { g.tick(g.s.deadline); assert.notStrictEqual(g.s.phase, "finished"); }
  }
  assert.strictEqual(g.s.finishedReason, "hands");
  g.tick(g.s.deadline);
  assert.strictEqual(g.s.phase, "finished");
  const snap = g.snapshot(0, "A");
  assert.ok(snap.draw);
  assert.deepStrictEqual(snap.winnerIds.sort(), ["A", "B"]);
  assert.deepStrictEqual(g.s.players.map((p) => p.place), [1, 1, 3]);
  assert.strictEqual(g.snapshot(0, null).handsTotal, 15);
});

test("турнир: K по формуле, отсечение самого бедного, ничья — кто больше проиграл, потом жребий", () => {
  assert.strictEqual(Game.cutK(12), 2);
  assert.strictEqual(Game.cutK(6), 4);
  assert.strictEqual(Game.cutK(4), 7);
  assert.strictEqual(Game.cutK(2), 20);
  const g = game(["A", "B", "C", "D"], { format: "tournament" }, rig([], 3));
  assert.strictEqual(g.s.cutK, 7);
  for (let h = 1; h <= 7; h++) {
    assert.strictEqual(g.snapshot(0, null).cutIn, 7 - h, `до отсечения на раздаче ${h}`);
    for (const p of g.alive()) g.bet(p.id, g.need(p));
    if (h === 7) {
      // D беднее всех — уходит; A и B равны, но B проиграл больше в последней раздаче — остаётся A… проверяем на следующей отсечке
      g.player("D").stack = 500;
      rigShoe(g, ["10s", "10d", "10c", "10h", "9d", "9s", "9h", "9c", "6d", "8c"]);
    } else rigShoe(g, ["10s", "10d", "10c", "10h", "9d", "9s", "9h", "9c", "6d", "8c"]);
    playHand(g, { actions: { A: "stand", B: "stand", C: "stand", D: "stand" } });
    if (h < 7) g.tick(g.s.deadline);
  }
  assert.ok(g.player("D").out, "отсечение");
  assert.ok(g.s.events.some((e) => e.type === "cut" && e.playerId === "D" && !e.coin));
  g.tick(g.s.deadline);
  // следующее отсечение на 14-й: A, B, C приходят к равному стеку, но B ставил больше и проиграл больше → уходит B
  for (let h = 8; h <= 14; h++) {
    for (const p of g.alive()) { p.stack = 1000; g.bet(p.id, g.need(p)); }
    if (h === 14) { const b = g.player("B"); b.stack += 40; g.bet("B", 40); }
    rigShoe(g, ["10s", "10d", "10c", "10h", "6d", "6s", "6c", "8c"]); // все 16 против 18 — все проиграли
    playHand(g, { actions: { A: "stand", B: "stand", C: "stand" } });
    if (h < 14) g.tick(g.s.deadline);
  }
  assert.ok(g.player("B").out, "при равных стеках уходит проигравший больше");
  assert.ok(!g.s.events.find((e) => e.type === "cut" && e.playerId === "B").coin);
  g.tick(g.s.deadline);
  // 21-я: A и C всё одинаково — жребий через rnd (очередь: выбрать индекс 1 → C)
  for (let h = 15; h <= 21; h++) {
    for (const p of g.alive()) { p.stack = 1000; g.bet(p.id, g.need(p)); }
    rigShoe(g, ["10s", "10d", "10h", "6h", "6d", "8c"]);
    if (h === 21) g.rnd.queue.push(1);
    playHand(g, { actions: { A: "stand", C: "stand" } });
    if (h < 21) g.tick(g.s.deadline);
  }
  const cut = g.s.events.filter((e) => e.type === "cut").pop();
  assert.ok(cut.coin);
  assert.deepStrictEqual(cut.among.sort(), ["A", "C"]);
  assert.strictEqual(cut.playerId, "C");
  assert.strictEqual(g.s.winnerId, "A");
  assert.strictEqual(g.s.finishedReason, "last");
});

// ---------- карты-пакости ----------

function withCards(names, settings) {
  const g = Game.create({ settings: Object.assign({ cards: true }, settings || {}), rnd: rig() });
  (names || ["A", "B", "C"]).forEach((n) => g.addPlayer({ id: n, name: n }));
  g.start(0);
  for (const p of g.s.players) p.trick = [];
  return g;
}

test("карты: по две на старте, +1 на уровне, не больше трёх; одна за раздачу, щит не играется, чужие — только количество", () => {
  const g = Game.create({ settings: { cards: true, pace: "fast" }, rnd: rig() });
  for (const n of "ABCDEFGHIJKL") g.addPlayer({ id: n, name: n });
  g.start(0);
  assert.ok(g.s.players.every((p) => p.trick.length === 2));
  for (let i = 0; i < 6; i++) {
    for (const p of g.alive()) { p.stack = 1e6; g.bet(p.id, g.levelNeed()); }
    playHand(g, { actions: {} });
    g.tick(g.s.deadline);
    for (const p of g.alive()) assert.ok(p.trick.length <= 3);
  }
  const counts = {};
  for (const p of g.s.players) for (const c of p.trick) counts[c] = (counts[c] || 0) + 1;
  for (const c of Object.keys(counts)) assert.ok(counts[c] <= 3, c);

  const h = withCards();
  h.player("A").trick = ["freeze", "peek", "shield"];
  assert.strictEqual(h.playCard("A", "freeze", "A").reason, "bad_target");
  assert.strictEqual(h.playCard("A", "shield", "B").reason, "passive");
  assert.strictEqual(h.playCard("A", "tax", "B").reason, "no_card");
  assert.ok(h.playCard("A", "freeze", "B").ok);
  assert.strictEqual(h.playCard("A", "peek").reason, "one_per_hand");
  const snapB = h.snapshot(10, "B");
  const a = snapB.players.find((p) => p.id === "A");
  assert.strictEqual(a.cardsCount, 2);
  assert.ok(a.played);
  assert.strictEqual(a.shield, false, "чужой щит не виден");
  assert.deepStrictEqual(snapB.reveals, [], "до открытия — только факт розыгрыша");
  assert.deepStrictEqual(snapB.me.cards, []);
  assert.ok(h.snapshot(10, "A").players.find((p) => p.id === "A").shield);
});

test("заморозка: цель стоит на первых двух; лишняя карта: после решений прилетает ещё одна", () => {
  const g = withCards(["A", "B", "C"]);
  g.player("A").trick = ["freeze"];
  g.player("C").trick = ["extra"];
  for (const id of ["A", "B", "C"]) g.bet(id, 10);
  g.playCard("A", "freeze", "B");
  g.playCard("C", "extra", "A");
  // A: 5 6 → стоит → прилетает K = 21; B: 5 6 заморожен; C: 10 7; дилер 10 8
  rigShoe(g, ["5s", "5d", "10c", "10h", "6s", "6d", "7c", "8d", "Kh"]);
  const now = toDeciding(g, 1000);
  assert.ok(g.player("B").frozen);
  assert.ok(g.player("B").hands[0].done, "заморожен — автоматически «хватит»");
  assert.ok(g.snapshot(now, "A").players.find((p) => p.id === "A").extraIncoming, "предупреждение «тебе прилетит ещё карта»");
  g.decide("A", 0, "stand", now);
  g.decide("C", 0, "stand", now);
  assert.strictEqual(g.s.phase, "dealer");
  assert.deepStrictEqual(g.player("A").hands[0].cards.map(G.packCard), ["5s", "6s", "Kh"]);
  assert.ok(g.s.events.some((e) => e.type === "card" && e.why === "extra" && e.playerId === "A"));
  g.tick(g.s.deadline);
  assert.strictEqual(g.player("A").stack, 1010);
  assert.strictEqual(g.player("B").stack, 990);
});

test("обмен: руки меняются после первых двух карт, блэкджек уходит к обменявшему; налог: половина выигрыша", () => {
  const g = withCards(["A", "B", "C"]);
  g.player("A").trick = ["swap"];
  g.player("C").trick = ["tax"];
  g.bet("A", 100); g.bet("B", 100); g.bet("C", 10);
  g.playCard("A", "swap", "B");
  g.playCard("C", "tax", "A");
  // A: 10 6; B: A K (бж); C: 9 9; дилер 10 7 → после обмена блэкджек у A
  rigShoe(g, ["10s", "As", "9s", "10h", "6d", "Kd", "9d", "7c"]);
  toDeciding(g, 1000);
  assert.ok(isBlackjack(g.player("A").hands[0].cards, false));
  assert.ok(g.s.events.some((e) => e.type === "swap" && e.playerId === "A" && e.target === "B"));
  toPayout(g, 2000, { B: "stand", C: "stand" });
  assert.strictEqual(g.player("A").hands[0].result, "bj");
  assert.strictEqual(g.player("A").stack, 1000 + 150 - 75, "блэкджек 150, половина — налог");
  assert.strictEqual(g.player("C").stack, 1000 + 10 + 75);
  assert.strictEqual(g.player("B").stack, 900);
  assert.strictEqual(total(g), 3000 - g.s.casino.won + g.s.casino.paid);
});

test("щит гасит первую враждебную; вторая карта в ту же цель возвращается владельцу; налог с проигрыша не берётся", () => {
  const g = withCards(["A", "B", "C", "D"]);
  g.player("B").trick = ["shield"];
  g.player("A").trick = ["freeze"];
  g.player("C").trick = ["extra"];
  g.player("D").trick = ["tax"];
  for (const id of ["A", "B", "C", "D"]) g.bet(id, 10);
  g.playCard("A", "freeze", "B");
  g.playCard("C", "extra", "B");
  g.playCard("D", "tax", "A");
  g.closeBets(1000);
  assert.deepStrictEqual(g.s.reveals.map((r) => `${r.by}:${r.outcome}`), ["A:shielded", "C:busy", "D:ok"]);
  assert.deepStrictEqual(g.player("B").trick, []);
  assert.deepStrictEqual(g.player("C").trick, ["extra"]);
  assert.ok(!g.player("B").frozen);
  rigShoe(g, ["10s", "10d", "10c", "10h", "10h", "6d", "6s", "6c", "6h", "8c"]);
  playHand(g, { actions: { A: "stand", B: "stand", C: "stand", D: "stand" } });
  assert.strictEqual(g.player("A").stack, 990, "проигрыш налогом не делится");
  assert.strictEqual(g.player("D").stack, 990);
});

test("подгляд: закрытую карту видит только владелец и только на телефоне; пересдача: обе карты заново; двойной минимум — на следующую", () => {
  const g = withCards(["A", "B", "C"]);
  g.player("A").trick = ["peek"];
  g.player("B").trick = ["redeal"];
  g.player("C").trick = ["doublemin"];
  for (const id of ["A", "B", "C"]) g.bet(id, 10);
  g.playCard("A", "peek");
  g.playCard("B", "redeal");
  g.playCard("C", "doublemin", "A");
  rigShoe(g, ["5s", "5d", "10c", "9h", "6s", "6d", "7c", "8d", "As", "Kh", "3c"]);
  const now = toDeciding(g, 1000);
  assert.strictEqual(g.snapshot(now, "A").me.peekHole.r, "8");
  assert.strictEqual(g.snapshot(now, "B").me.peekHole, null);
  assert.strictEqual(g.snapshot(now, "A").dealer.hole, null, "на доске/в общей части ничего не меняется");
  assert.strictEqual(g.snapshot(now, null).dealer.hole, null);
  assert.ok(g.snapshot(now, "B").players.find((p) => p.id === "A").peeked, "«Маша подглядела» — видно всем");
  assert.ok(g.snapshot(now, "B").me.redealAvail);
  assert.ok(g.decide("B", 0, "redeal", now).ok);
  assert.deepStrictEqual(g.player("B").hands[0].cards.map(G.packCard), ["As", "Kh"]);
  assert.ok(g.player("B").hands[0].done, "после пересдачи пришёл блэкджек");
  assert.strictEqual(g.decide("B", 0, "redeal", now).reason, "hand_done");
  assert.ok(g.snapshot(now, "B").players.find((p) => p.id === "A").doubleMinNext);
  toPayout(g, now, { A: "stand", C: "stand" });
  g.tick(g.s.deadline);
  assert.strictEqual(g.need(g.player("A")), 20, "двойной минимум в следующей раздаче");
  assert.strictEqual(g.need(g.player("B")), 10);
  assert.ok(g.snapshot(0, "A").players.find((p) => p.id === "A").doubleMin);
});

// ---------- шуз ----------

test("шуз: 6 колод, отсечка 75% — следующая раздача с перетасовкой и +3 с на ставки; пустой шуз посреди раздачи тасуется сам", () => {
  const g = game();
  assert.strictEqual(SHOE_SIZE, 312);
  assert.ok(g.s.events.some((e) => e.type === "reshuffle"), "первая раздача начинается с перетасовки");
  g.s.shoeDealt = Math.floor(SHOE_SIZE * CUT) - 1;
  g.bet("A", 10); g.bet("B", 10);
  playHand(g, { actions: { A: "stand", B: "stand" } });
  assert.ok(g.s.shoeDealt >= Math.floor(SHOE_SIZE * CUT));
  const ev = g.tick(g.s.deadline);
  assert.ok(ev.some((e) => e.type === "reshuffle"));
  assert.strictEqual(g.s.shoeDealt, 0);
  assert.strictEqual(g.s.shoe.length, SHOE_SIZE);
  assert.ok(g.snapshot(0, null).shoe.reshuffle);
  assert.strictEqual(g.s.deadline - g.s.events.filter((e) => e.type === "betting").pop().t, g.s.settings.betTime + T.reshuffle);
  const sorted = g.s.shoe.slice().sort();
  const counts = {};
  for (const c of sorted) counts[c] = (counts[c] || 0) + 1;
  assert.strictEqual(Object.keys(counts).length, 52);
  assert.ok(Object.values(counts).every((n) => n === 6));

  g.bet("A", 10); g.bet("B", 10);
  g.s.shoe = ["5s", "5d", "10c", "9h", "6s"].reverse();
  g.closeBets(1000);
  g.tick(g.s.deadline);
  assert.strictEqual(g.s.phase, "dealing");
  assert.ok(g.s.shoe.length > 300, "карт не хватило — новый шуз посреди раздачи");
});

// ---------- скрытность ----------

test("скрытность: телефон не видит закрытой карты, добора, сюжета и итогов до revealAt; доска — с начала фазы дилера", () => {
  const g = game(["A", "B"]);
  g.bet("A", 100); g.bet("B", 100);
  // A 10 9 стоит, B 10 2 стоит; дилер 6 + 10 → 16 → берёт 5 = 21
  rigShoe(g, ["10s", "10d", "6c", "9h", "2s", "10h", "5c"]);
  const now = toDeciding(g, 1000);
  for (const view of ["A", "B", null]) {
    const d = g.snapshot(now, view).dealer;
    assert.strictEqual(d.hole, null);
    assert.strictEqual(d.cards.length, 1);
    assert.strictEqual(d.plot, null);
  }
  g.decide("A", 0, "stand", now);
  g.decide("B", 0, "stand", now);
  assert.strictEqual(g.s.phase, "dealer");
  const board = g.snapshot(now, null);
  assert.deepStrictEqual(board.dealer.cards.map(G.packCard), ["6c", "10h", "5c"]);
  assert.strictEqual(board.dealer.hole.r, "10");
  assert.strictEqual(board.dealer.revealAt.length, 3, "переворот, карта добора, итог");
  assert.ok(board.dealer.plot);
  assert.strictEqual(board.players[0].hands[0].result, "lose");
  const finalAt = g.s.dealer.revealAt[2];
  const phone = g.snapshot(finalAt - 1, "A");
  assert.strictEqual(phone.dealer.hole, null);
  assert.deepStrictEqual(phone.dealer.cards.map(G.packCard), ["6c"]);
  assert.strictEqual(phone.dealer.value, 6);
  assert.strictEqual(phone.dealer.plot, null);
  assert.deepStrictEqual(phone.dealer.revealAt, [finalAt]);
  assert.strictEqual(phone.players[0].hands[0].result, null);
  assert.strictEqual(phone.players[0].net, null);
  assert.ok(!phone.events.some((e) => e.type === "dealer"), "событие с сюжетом телефону не уходит раньше времени");
  assert.ok(!JSON.stringify(phone).includes('"5c"'), "карты добора в снимке телефона нет");
  const later = g.snapshot(finalAt, "A");
  assert.strictEqual(later.dealer.hole.r, "10");
  assert.strictEqual(later.dealer.cards.length, 3);
  assert.strictEqual(later.players[0].hands[0].result, "lose");
  assert.ok(later.events.some((e) => e.type === "dealer"));
  g.tick(finalAt);
  assert.strictEqual(g.s.phase, "payout");
  assert.strictEqual(g.snapshot(finalAt, "B").players[1].net, -100);
});

// ---------- режиссёр ----------

test("режиссёр: ва-банк, спасение, джекпот — всегда; особые не чаще раза в три раздачи; расписание в пределах 10 с", () => {
  const g = game(["A", "B"]);
  g.allIn("A"); g.bet("B", 10);
  rigShoe(g, ["10s", "10d", "6c", "9h", "9s", "10h", "9c"]); // дилер 25 — A с ва-банком выиграл
  playHand(g, { actions: { A: "stand", B: "stand" } });
  assert.strictEqual(g.s.dealer.plot, "allin");
  assert.deepStrictEqual(g.s.dealer.allin, ["A"]);
  assert.strictEqual(g.s.dealer.revealAt[0] - g.s.dealer.lead, g.s.events.filter((e) => e.type === "dealer").pop().t + T.allinLead + T.flip);
  g.tick(g.s.deadline);
  g.player("A").stack = 15; // на последних фишках: выигрыш не меньше остатка — «спасение»
  g.bet("A", 15); g.bet("B", 10);
  rigShoe(g, ["10s", "10d", "6c", "9h", "9s", "10h", "9c"]); // дилер 25 — перебор, A выиграл
  playHand(g, { actions: { A: "stand", B: "stand" } });
  assert.strictEqual(g.s.dealer.plot, "rescue");
  assert.deepStrictEqual(g.s.dealer.rescue, ["A"]);
  g.tick(g.s.deadline);
  // долгий флип: обе руки стоят на 18–20; квотный сюжет принимается с вероятностью SPECIAL_CHANCE — подкладываем 0
  for (let i = 0; i < 3; i++) {
    for (const p of g.s.players) p.stack = 5000;
    g.bet("A", 10); g.bet("B", 10);
    rigShoe(g, ["10s", "10d", "6c", "9h", "9s", "10h", "5c"]);
    g.rnd.queue.push(0, 0);
    playHand(g, { actions: { A: "stand", B: "stand" } });
    assert.strictEqual(g.s.dealer.plot, i === 0 ? "longflip" : "normal", `раздача ${g.s.hand}`);
    assert.ok(g.s.dealer.revealAt[g.s.dealer.revealAt.length - 1] - g.s.dealer.revealAt[0] <= T.dealerMax);
    g.tick(g.s.deadline);
  }
});

// ---------- инвариант ----------

test("инвариант: фишки игроков = старт − выигрыш казино + выплаты казино, после каждой из 300 случайных раздач", () => {
  let now = 0;
  let hands = 0;
  for (let seed = 11; seed < 40 && hands < 300; seed++) {
  const h = Game.create({ settings: { cards: true, pace: "slow", stack: 2000 }, rnd: rig([], seed) });
  for (const n of ["A", "B", "C", "D", "E", "F"]) h.addPlayer({ id: n, name: n });
  h.start(0);
  const r = h.rnd;
  while (h.s.phase !== "finished" && hands < 300) {
    hands++;
    for (const p of h.alive()) {
      const k = r(5);
      if (k === 0) continue;
      if (k === 1) h.allIn(p.id);
      else { h.bet(p.id, 1 + r(Math.max(1, Math.floor(p.stack / 3)))); if (r(2)) h.sideBet(p.id, "pp", 1 + r(20)); if (r(2)) h.sideBet(p.id, "tp", 1 + r(20)); }
      const card = p.trick.find((c) => c !== "shield");
      const t = h.alive().filter((x) => x.id !== p.id);
      if (card && r(2) && t.length) h.playCard(p.id, card, t[r(t.length)].id);
    }
    now += 5000;
    h.closeBets(now);
    while (h.s.phase !== "payout" && h.s.phase !== "finished") {
      if (h.s.phase === "deciding") {
        const w = h.s.wave;
        for (const x of h.pending()) {
          if (h.s.phase !== "deciding" || h.s.wave !== w) break;
          const o = h.options(x.p, x.h);
          const acts = Object.keys(o).filter((k) => o[k]);
          h.decide(x.p.id, x.i, acts[r(acts.length)], now);
        }
        if (h.s.phase === "deciding" && h.s.wave === w) { now = h.s.deadline; h.tick(now); }
      } else if (h.s.phase === "insurance" && h.s.dealer.insurance) {
        for (const p of h.inHand()) if (h.s.phase === "insurance") h.insure(p.id, r(2) ? true : r(2) ? "evenMoney" : false, now);
        if (h.s.phase === "insurance") { now = h.s.deadline; h.tick(now); }
      } else { now = h.s.deadline; h.tick(now); }
    }
    assert.strictEqual(total(h), 12000 - h.s.casino.won + h.s.casino.paid, `раздача ${h.s.hand}`);
    for (const p of h.s.players) assert.ok(p.stack >= 0 && Number.isInteger(p.stack));
    JSON.stringify(h.snapshot(now, "A"));
    now = h.s.deadline; h.tick(now);
  }
  }
  assert.ok(hands >= 100);
});

// ---------- прочее ----------

test("готово у всех — ставки закрываются без таймера; пауза замораживает таймер ставок, посреди раздачи — встаёт на следующих", () => {
  const g = game();
  g.bet("A", 10);
  assert.strictEqual(g.ready("A", true, 50).events.length, 0);
  const r = g.ready("B", true, 60);
  assert.ok(r.events.some((e) => e.type === "closed"));
  assert.strictEqual(g.s.phase, "closing");

  const h = game();
  const dl = h.s.deadline;
  h.pause(5000);
  assert.deepStrictEqual(h.tick(dl + 100000), []);
  assert.strictEqual(h.snapshot(5000, "A").phase, "paused");
  assert.strictEqual(h.snapshot(5000, "A").pausedPhase, "betting");
  h.resume(10000);
  assert.strictEqual(h.s.deadline, 10000 + (dl - 5000));
  h.bet("A", 10); h.bet("B", 10);
  h.closeBets(20000);
  h.pause(20001);
  playHand(h, { now: 20000, actions: { A: "stand", B: "stand" } });
  h.tick(h.s.deadline);
  assert.strictEqual(h.s.phase, "betting");
  assert.ok(h.s.paused);
});

test("повторить прошлую ставку, урезается до стека; настройки комнаты через clampSettings", () => {
  const g = game();
  g.bet("A", 300); g.sideBet("A", "pp", 100); g.bet("B", 10);
  rigShoe(g, ["10s", "10d", "6c", "6h", "9s", "10h", "5c"]);
  playHand(g, { actions: { A: "stand", B: "stand" } });
  g.tick(g.s.deadline);
  g.player("A").stack = 350;
  assert.ok(g.repeatBet("A").ok);
  assert.deepStrictEqual([g.player("A").bet, g.player("A").side.pp], [300, 50]);
  assert.strictEqual(g.repeatBet("B").ok, true);
  assert.strictEqual(g.player("B").bet, 10);

  const s = G.clampSettings({ format: "tournament", handsTotal: 99, stack: 2000, pace: "slow", betTime: 30000, cards: false, chat: "no", lang: "el", solo: "yes" });
  assert.deepStrictEqual(s, { format: "tournament", handsTotal: 20, stack: 2000, pace: "slow", betTime: 30000, cards: false, chat: true, calm: false, lang: "el", solo: false });
  assert.deepStrictEqual(G.clampSettings(null), G.DEFAULTS);
  assert.strictEqual(G.clampSettings({ solo: true }).cards, false, "в соло карт-пакостей нет");
  assert.strictEqual(G.cleanName("  Маша\u0000  Петрова-Сидорова-Иванова "), "Маша Петрова-Си");
});

test("соло: один игрок, без таймеров ставок и решений, партия до разорения", () => {
  const g = Game.create({ settings: { solo: true }, rnd: rig() });
  assert.ok(g.addPlayer({ id: "A", name: "A" }).ok);
  assert.strictEqual(g.addPlayer({ id: "B", name: "B" }).reason, "room_full");
  assert.ok(g.start(0).ok);
  assert.strictEqual(g.s.deadline, null, "ставки без таймера");
  assert.deepStrictEqual(g.tick(1e9), []);
  g.player("A").stack = 10;
  g.bet("A", 10);
  rigShoe(g, ["10s", "Ac", "6h", "5h", "5c"]); // дилер с тузом: страховка без таймера
  g.closeBets(1000);
  while (g.s.phase !== "insurance") g.tick(g.s.deadline);
  assert.strictEqual(g.s.deadline, null, "страховка без таймера");
  assert.deepStrictEqual(g.tick(1e9), []);
  g.insure("A", false, 2000);
  assert.strictEqual(g.s.phase, "deciding");
  assert.strictEqual(g.s.deadline, null, "решения без таймера");
  g.decide("A", 0, "stand", 2000);
  g.tick(g.s.deadline);
  assert.strictEqual(g.player("A").stack, 0);
  assert.strictEqual(g.s.finishedReason, "all_out");
  assert.strictEqual(g.s.winnerId, "A");
});

test("соло: после сплита карта приходит сразу по действию на руке, вторая рука ждёт своего решения", () => {
  const g = Game.create({ settings: { solo: true }, rnd: rig() });
  g.addPlayer({ id: "A", name: "A" });
  g.start(0);
  g.bet("A", 100);
  // A: 8 8; дилер 6 K; после сплита: 3 и 9; hit на руке 1 → 5 (16); stand на руке 2 (17); дилер 16 → берёт 2 = 18
  rigShoe(g, ["8s", "6d", "8d", "Kc", "3h", "9h", "5s", "2c"]);
  g.closeBets(1000);
  while (g.s.phase !== "deciding") g.tick(g.s.deadline);
  assert.ok(g.decide("A", 0, "split", 2000).ok);
  const a = g.player("A");
  assert.strictEqual(g.s.phase, "deciding");
  assert.deepStrictEqual(a.hands.map((h) => h.cards.map(G.packCard)), [["8s", "3h"], ["8d", "9h"]]);
  assert.ok(g.decide("A", 0, "hit", 2100).ok);
  assert.strictEqual(g.s.phase, "deciding", "вторая рука ещё не решена — дилер не ходит");
  assert.deepStrictEqual(a.hands[0].cards.map(G.packCard), ["8s", "3h", "5s"], "карта пришла сразу, до решения по второй руке");
  assert.ok(!a.hands[0].done && a.hands[1].decision === null && !a.hands[1].done);
  assert.ok(g.decide("A", 0, "stand", 2200).ok);
  assert.ok(a.hands[0].done);
  assert.strictEqual(g.s.phase, "deciding");
  assert.ok(g.decide("A", 1, "stand", 2300).ok);
  assert.strictEqual(g.s.phase, "dealer");
  g.tick(g.s.deadline);
  assert.deepStrictEqual(a.hands.map((h) => h.result), ["lose", "lose"]);
  assert.strictEqual(a.stack, 800);
  assert.strictEqual(total(g), 1000 - g.s.casino.won + g.s.casino.paid, "инвариант фишек");
  // мультиплеер не меняется: без решения по второй руке волна ждёт
  const m = game(["A", "B"]);
  m.bet("A", 100); m.bet("B", 10);
  rigShoe(m, ["8s", "2d", "6c", "8d", "3d", "Kc", "3h", "9h", "5s", "2c"]);
  const now = toDeciding(m, 1000);
  m.decide("A", 0, "split", now); m.decide("B", 0, "stand", now);
  m.decide("A", 0, "hit", now + 10);
  assert.strictEqual(m.player("A").hands[0].cards.length, 2, "в мультиплеере карта ждёт закрытия волны");
});

test("опоздавший — зритель; выход игрока посреди партии: последний побеждает; «Закончить» — по фишкам с ничьёй", () => {
  const g = game(["A", "B", "C"]);
  const r = g.addPlayer({ id: "L", name: "Late" });
  assert.ok(r.ok && r.player.spectator && r.player.out);
  assert.strictEqual(g.bet("L", 10).reason, "closed");
  assert.ok(g.chat("L", "привет", 0).ok);
  g.removePlayer("C", 10);
  assert.strictEqual(g.s.phase, "betting");
  g.finishNow(20);
  assert.strictEqual(g.s.phase, "finished");
  assert.ok(g.s.draw);
  assert.deepStrictEqual(g.s.winnerIds, ["A", "B"]);
  assert.strictEqual(g.player("L").place, null);
  g.reset();
  assert.ok(!g.player("L").spectator && g.player("L").stack === 1000);

  const h = game();
  h.removePlayer("B", 10);
  assert.strictEqual(h.s.winnerId, "A");
  assert.strictEqual(h.s.phase, "finished");
});

test("чат: длина, частота, заглушка, скрытие; реакции только из набора; «болею за» — только за живого", () => {
  const g = game();
  assert.ok(g.chat("A", "  привет   всем ", 0).ok);
  assert.strictEqual(g.s.chat[0].text, "привет всем");
  assert.strictEqual(g.chat("A", "ещё", 1000).reason, "too_fast");
  assert.ok(g.chat("A", "x".repeat(200), 5000).ok);
  assert.strictEqual(g.s.chat[1].text.length, 80);
  g.mute("B", true);
  assert.strictEqual(g.chat("B", "эй", 0).reason, "muted");
  g.hideMessage(1);
  assert.strictEqual(g.snapshot(0, null).chat.length, 1);
  assert.ok(g.react("A", "🔥", 0).ok);
  assert.strictEqual(g.react("A", "🔥", 500).reason, "too_fast");
  assert.strictEqual(g.react("A", "<script>", 5000).reason, "bad");
  assert.strictEqual(g.react("A", "💛", 6000, "A").reason, "bad");
  assert.strictEqual(g.react("A", "💛", 6000, "B").events[0].type, "cheer");
});

test("дамп: состояние переживает JSON и продолжает раздачу с того же шуза", () => {
  const g = game();
  g.bet("A", 10); g.bet("B", 10);
  g.closeBets(100);
  const shoe = g.s.shoe.slice();
  const g2 = Game.from(JSON.parse(JSON.stringify(g.s)), rig());
  g2.tick(g2.s.deadline);
  assert.strictEqual(g2.s.phase, "dealing");
  assert.deepStrictEqual(g2.s.shoe, shoe.slice(0, shoe.length - 6), "два игрока и дилер — шесть карт из того же шуза");
  toPayout(g2, g2.s.deadline, { A: "stand", B: "stand" });
  assert.strictEqual(g2.s.phase, "payout");
});
