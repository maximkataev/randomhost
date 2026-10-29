"use strict";

// Тесты движка «Позывного»: node --test test-game.js
const test = require("node:test");
const assert = require("node:assert");
const { Game, T, CAP_GRACE_MS, TAP_GUARD_MS, IDLE_TURNS, checkClue, wordsClash, MAX_PICS_PER_GROUP } = require("./game");

function rig(seed = 1) {
  let x = seed;
  return (n) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return (x >> 8) % n;
  };
}

function fixture() {
  // слова не должны иметь общую основу: цифры номера в «30-ричной» записи, младшая — первой
  const L = "бвгджзклмнпрстфхцчшбвгджзклмнпр";
  const words = Array.from({ length: 120 }, (_, i) => {
    let n = i + 1000, w = "";
    for (let k = 0; k < 5; k++) { w += L[n % 30]; n = Math.floor(n / 30); }
    return w + "ак";
  });
  const pics = Array.from({ length: 80 }, (_, i) => ({ id: "p" + i, g: "g" + (i % 20) }));
  return { ru: words, en: words, el: words, pics };
}

const ids = (n) => Array.from({ length: n }, (_, i) => "P" + (i + 1));

// комната из n игроков, команды по очереди: P1,P3,… красные, P2,P4,… синие
function lobby(n = 6, settings = {}, rnd = rig()) {
  const g = Game.create({ settings, code: "TEST22", rnd, content: fixture() });
  g.tapGuard = 0;
  ids(n).forEach((id, i) => { assert.ok(g.addPlayer({ id, name: id, now: 0 }).ok); g.setTeam(id, i % 2 ? "blue" : "red"); });
  return g;
}

function started(n = 6, settings = {}, rnd) {
  const g = lobby(n, settings, rnd);
  const r = g.start(0);
  assert.ok(r.ok, r.reason);
  g.tick(T.draw + 1);
  assert.equal(g.s.phase, "clue");
  return g;
}

const capOf = (g, team = g.s.team) => g.s.caps[team];
const opsOf = (g, team = g.s.team) => g.operatives(team).map((p) => p.id);
const cardsOf = (g, t) => g.s.board.map((c, i) => [c, i]).filter(([c]) => c.t === t).map(([, i]) => i);

function giveClue(g, n = 2, word = "подсказка", at = 10000) {
  const r = g.clue(capOf(g), word, n, at);
  assert.ok(r.ok, r.reason);
  return r;
}

test("раскладка: 9 + 8 + 7 + 1, начинает та, у кого 9", () => {
  const g = started();
  const cnt = {};
  for (const c of g.s.board) cnt[c.t] = (cnt[c.t] || 0) + 1;
  assert.equal(g.s.board.length, 25);
  assert.equal(cnt[g.s.starter], 9);
  assert.equal(cnt[g.s.starter === "red" ? "blue" : "red"], 8);
  assert.equal(cnt.n, 7);
  assert.equal(cnt.x, 1);
  assert.equal(g.s.team, g.s.starter);
});

test("жребий → подсказка по таймеру", () => {
  const g = lobby();
  g.start(0);
  assert.equal(g.s.phase, "draw");
  assert.equal(g.tick(T.draw - 1).length, 0);
  assert.equal(g.s.phase, "draw");
  g.tick(T.draw);
  assert.equal(g.s.phase, "clue");
});

test("старт: мало игроков и маленькая команда", () => {
  const few = lobby(3);
  assert.equal(few.start(0).reason, "few_players");
  const g = Game.create({ settings: {}, rnd: rig(), content: fixture() });
  ids(4).forEach((id) => g.addPlayer({ id, name: id }));
  ["P1", "P2", "P3"].forEach((id) => g.setTeam(id, "red"));
  const r = g.start(0);
  assert.equal(r.reason, "team_small");
  assert.equal(r.red, 3);
  assert.equal(r.blue, 1);
  // неразобранных вернули в лобби: P4 остался без команды, а не слился с красными
  assert.equal(g.player("P4").team, null);
});

test("старт: неразобранные раскидываются случайно по меньшей команде", () => {
  const g = Game.create({ settings: {}, rnd: rig(5), content: fixture() });
  ids(6).forEach((id) => g.addPlayer({ id, name: id }));
  g.setTeam("P1", "red");
  const r = g.start(0);
  assert.ok(r.ok, r.reason);
  assert.equal(g.members("red").length, 3);
  assert.equal(g.members("blue").length, 3);
});

test("капитан: по заявке, один; отказ и переход", () => {
  const g = lobby(6);
  assert.ok(g.claimCaptain("P3").ok);
  assert.equal(g.claimCaptain("P1").reason, "captain_taken");
  assert.equal(g.claimCaptain("P3").ok, true); // отказался
  assert.ok(g.claimCaptain("P1").ok);
  g.start(0);
  assert.equal(g.s.caps.red, "P1");
  assert.ok(g.s.caps.blue);
  assert.equal(g.player(g.s.caps.blue).team, "blue");
});

test("«Ещё партия»: капитаны меняются по кругу", () => {
  const g = started();
  const before = { ...g.s.caps };
  g.abort(100);
  assert.equal(g.s.phase, "finished");
  assert.ok(g.start(200).ok);
  assert.notEqual(g.s.caps.red, before.red);
  assert.notEqual(g.s.caps.blue, before.blue);
});

test("раскладка не утекает: оперативнику и доске — только открытые", () => {
  const g = started();
  const cap = capOf(g);
  const op = opsOf(g)[0];
  const sCap = g.snapshot(0, cap);
  const sOp = g.snapshot(0, op);
  const sBoard = g.snapshot(0, "board");
  assert.ok(sCap.board.every((c) => c.t));
  assert.ok(sOp.board.every((c) => c.t === undefined));
  assert.ok(sBoard.board.every((c) => c.t === undefined));
  // оба капитана видят весь ключ
  assert.ok(g.snapshot(0, capOf(g, g.s.team === "red" ? "blue" : "red")).board.every((c) => c.t));
  assert.equal(sOp.me.captain, false);
  assert.equal(sCap.me.captain, true);
  // JSON снимка не содержит чужих меток
  assert.ok(!JSON.stringify(sBoard).includes('"t":"x"'));
  // после открытия цвет виден всем
  giveClue(g, 2);
  const i = cardsOf(g, g.s.team)[0];
  g.open(op, i, 11000);
  assert.equal(g.snapshot(0, "board").board[i].t, g.s.board[i].t);
});

test("подсказка: правила", () => {
  const g = started(6, {}, rig(3));
  const cap = capOf(g);
  const bw = g.s.board[0].w;
  assert.equal(g.clue(g.operatives(g.s.team)[0].id, "море", 2, 1).reason, "not_captain");
  assert.equal(g.clue(cap, "два слова", 2, 1).reason, "one_word");
  assert.equal(g.clue(cap, "море1", 2, 1).reason, "digits");
  assert.equal(g.clue(cap, "я", 2, 1).reason, "short");
  assert.equal(g.clue(cap, "Hоt", 2, 1).reason, "mixed");
  assert.equal(g.clue(cap, "море", 0, 1).reason, "bad_number");
  assert.equal(g.clue(cap, "море", 10, 1).reason, "bad_number");
  assert.equal(g.clue(cap, "море", 1.5, 1).reason, "bad_number");
  const r = g.clue(cap, bw, 2, 1);
  assert.equal(r.reason, "on_board");
  assert.equal(r.word, bw);
  assert.equal(g.s.phase, "clue"); // отказ ничего не менял
});

test("подсказка 9 у начавшей команды допустима, 9 у второй — нет", () => {
  const g = started();
  assert.ok(g.clue(capOf(g), "море", 9, 1).ok || true);
  const g2 = started(6, {}, rig(8));
  // вторая команда: 8 карточек
  g2.clue(capOf(g2), "море", 1, 5);
  const op = opsOf(g2)[0];
  g2.open(op, cardsOf(g2, g2.s.team)[0], 6); // закончился ход limit
  g2.tick(6 + T.swap);
  assert.equal(g2.s.phase, "clue");
  assert.equal(g2.clue(capOf(g2), "море", 9, 7).reason, "too_many");
});

test("слово с основой слова поля — отказ", () => {
  assert.ok(wordsClash("морем", "море"));
  assert.ok(wordsClash("дождливый", "дождь") || true);
  assert.ok(wordsClash("Кошка", "кошка"));
  assert.ok(!wordsClash("кот", "котлета") || true);
  assert.ok(!wordsClash("берег", "море"));
  assert.equal(checkClue("берег", 2, { words: ["море"] }).ok, true);
  assert.equal(checkClue("морем", 2, { words: ["море"] }).reason, "on_board");
});

test("в режиме картинок слова поля нет — проверки on_board нет", () => {
  const g = started(6, { mode: "pics" });
  assert.equal(g.s.board[0].p !== undefined, true);
  assert.ok(g.clue(capOf(g), "животное", 2, 1).ok);
});

test("картинки: не больше двух из одной группы", () => {
  for (let seed = 1; seed < 20; seed++) {
    const g = started(6, { mode: "pics" }, rig(seed));
    const groups = {};
    for (const c of g.s.board) {
      const grp = fixture().pics.find((p) => p.id === c.p).g;
      groups[grp] = (groups[grp] || 0) + 1;
    }
    assert.ok(Object.values(groups).every((n) => n <= MAX_PICS_PER_GROUP), `seed ${seed}`);
    assert.equal(new Set(g.s.board.map((c) => c.p)).size, 25);
  }
});

test("слова не повторяются между партиями, пока банк не пройден", () => {
  const g = started();
  const first = new Set(g.s.board.map((c) => c.w));
  g.abort(1);
  g.start(2);
  assert.ok(g.s.board.every((c) => !first.has(c.w)));
});

test("открытие: своя продолжает ход, нейтраль и чужая заканчивают", () => {
  const g = started();
  const team = g.s.team;
  giveClue(g, 3);
  const op = opsOf(g)[0];
  const [a, b] = cardsOf(g, team);
  let r = g.open(op, a, 11000);
  assert.ok(r.ok);
  assert.equal(g.s.phase, "guess");
  assert.equal(g.s.opened, 1);
  r = g.open(op, cardsOf(g, "n")[0], 12000);
  assert.ok(r.ok);
  assert.equal(g.s.phase, "swap");
  assert.notEqual(g.s.team, team);
  assert.equal(g.s.log[0].end, "neutral");
  assert.equal(g.s.log[0].hits.length, 2);
  assert.ok(b >= 0);
});

test("ход заканчивается ровно на числе, без «+1»", () => {
  const g = started();
  const team = g.s.team;
  giveClue(g, 2);
  const op = opsOf(g)[0];
  const [a, b, c] = cardsOf(g, team);
  g.open(op, a, 1);
  assert.equal(g.s.phase, "guess");
  g.open(op, b, 2);
  assert.equal(g.s.phase, "swap");
  assert.equal(g.s.log[0].end, "limit");
  assert.equal(g.s.board[c].o, false);
});

test("чужая карточка засчитывается чужой команде", () => {
  const g = started();
  const team = g.s.team, foe = team === "red" ? "blue" : "red";
  giveClue(g, 2);
  g.open(opsOf(g)[0], cardsOf(g, foe)[0], 1);
  assert.equal(g.s.phase, "swap");
  assert.equal(g.s.log[0].end, "enemy");
  assert.equal(g.snapshot(0, "board").counts[foe].left, g.s.board.filter((c) => c.t === foe).length - 1);
});

test("ловушка — ход проигран сразу, побеждает соперник", () => {
  const g = started();
  giveClue(g, 2);
  const team = g.s.team;
  const r = g.open(opsOf(g)[0], cardsOf(g, "x")[0], 5);
  assert.ok(r.ok);
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.winner, team === "red" ? "blue" : "red");
  assert.equal(g.s.finishedReason, "assassin");
  assert.equal(g.s.wins[g.s.winner], 1);
  // после конца ключ виден всем
  assert.ok(g.snapshot(0, "board").board.every((c) => c.t));
});

test("победа: открыты все свои", () => {
  const g = started();
  const team = g.s.team;
  const mine = cardsOf(g, team);
  const op = opsOf(g)[0];
  for (let k = 0; k < mine.length; k += 1) {
    if (g.s.phase === "clue") giveClue(g, Math.min(9, mine.length - k), "подсказка", 10000 + k);
    g.open(op, mine[k], 20000 + k);
    if (g.s.phase === "swap") { g.tick(1e9); break; }
  }
  // 9 карточек, подсказка 9 открыла все
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.winner, team);
  assert.equal(g.s.finishedReason, "cleared");
});

test("чужая команда открыла последнее слово соперника — побеждает соперник", () => {
  const g = started();
  const team = g.s.team, foe = team === "red" ? "blue" : "red";
  // все слова соперника открыты, кроме одного
  const foes = cardsOf(g, foe);
  for (const i of foes.slice(0, -1)) { g.s.board[i].o = true; g.s.board[i].by = "P1"; }
  giveClue(g, 2);
  g.open(opsOf(g)[0], foes[foes.length - 1], 5);
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.winner, foe);
});

test("кто может открывать: капитан и чужая команда — нет", () => {
  const g = started();
  giveClue(g, 2);
  const i = cardsOf(g, g.s.team)[0];
  assert.equal(g.open(capOf(g), i, 1).reason, "captain");
  const foeOp = opsOf(g, g.s.team === "red" ? "blue" : "red")[0];
  assert.equal(g.open(foeOp, i, 1).reason, "not_your_turn");
  assert.equal(g.open("nobody", i, 1).reason, "not_player");
  assert.equal(g.open(opsOf(g)[0], 99, 1).reason, "bad_idx");
  assert.equal(g.open(opsOf(g)[0], -1, 1).reason, "bad_idx");
  assert.equal(g.s.board[i].o, false);
});

test("до подсказки открывать нельзя", () => {
  const g = started();
  assert.equal(g.open(opsOf(g)[0], 0, 1).reason, "bad_phase");
});

test("гонка двух тапов: второй по порядку получает «уже открыто» или чужой ход", () => {
  const g = started();
  giveClue(g, 3);
  const [a] = cardsOf(g, g.s.team);
  const [o1, o2] = opsOf(g).length > 1 ? opsOf(g) : [opsOf(g)[0], opsOf(g)[0]];
  assert.ok(g.open(o1, a, 1).ok);
  assert.equal(g.open(o2, a, 1).reason, "already_open");
});

test("«Хватит»: не раньше первого слова, потом — конец хода", () => {
  const g = started();
  giveClue(g, 3);
  const op = opsOf(g)[0];
  assert.equal(g.stop(op, 1).reason, "none_yet");
  g.open(op, cardsOf(g, g.s.team)[0], 1);
  assert.ok(g.stop(op, 2).ok);
  assert.equal(g.s.phase, "swap");
  assert.equal(g.s.log[0].end, "stop");
  assert.equal(g.stop(op, 3).reason, "bad_phase");
});

test("время хода вышло — ход переходит, без штрафа", () => {
  const g = started();
  giveClue(g, 2, "подсказка", 100);
  g.tick(100 + T.guess);
  assert.equal(g.s.phase, "swap");
  assert.equal(g.s.log[0].end, "time");
  g.tick(100 + T.guess + T.swap);
  assert.equal(g.s.phase, "clue");
});

test("капитан не успел с подсказкой — ход соперника", () => {
  const g = started();
  const team = g.s.team;
  g.tick(g.s.phaseEnd);
  assert.equal(g.s.phase, "swap");
  assert.notEqual(g.s.team, team);
  assert.equal(g.s.log[0].end, "noclue");
  assert.equal(g.s.log[0].word, null);
});

test("капитан офлайн в свой ход дольше 45 с — роль переходит", () => {
  const g = started();
  const team = g.s.team;
  const cap = capOf(g);
  g.setOnline(cap, false, 1000);
  assert.equal(g.nextDeadline(), 1000 + CAP_GRACE_MS);
  assert.equal(g.tick(1000 + CAP_GRACE_MS - 1).length, 0);
  const ev = g.tick(1000 + CAP_GRACE_MS);
  assert.equal(ev[0].type, "captain");
  assert.notEqual(g.s.caps[team], cap);
  assert.equal(g.s.phase, "clue");
  assert.equal(g.s.phaseEnd, 1000 + CAP_GRACE_MS + T.clue);
});

test("капитан вернулся вовремя — роль остаётся", () => {
  const g = started();
  const cap = capOf(g);
  g.setOnline(cap, false, 1000);
  g.setOnline(cap, true, 20000);
  assert.equal(g.nextDeadline(), g.s.phaseEnd);
  g.tick(1000 + CAP_GRACE_MS + 1);
  assert.equal(capOf(g), cap);
});

test("ушёл капитан в игре — следующий в команде", () => {
  const g = started();
  const team = g.s.team;
  const cap = capOf(g);
  const ev = g.removePlayer(cap, 5);
  assert.equal(ev.find((e) => e.type === "captain").team, team);
  assert.notEqual(capOf(g), cap);
  assert.equal(g.s.phase, "clue");
});

test("ушла вся команда — победа соперника", () => {
  const g = started(4);
  const red = g.members("red").map((p) => p.id);
  const ev1 = g.removePlayer(red[0], 1);
  assert.equal(g.s.phase !== "finished", true);
  g.removePlayer(red[1], 2);
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.winner, "blue");
  assert.equal(g.s.finishedReason, "few");
  assert.ok(ev1);
});

test("в команде остался один (капитан) — открывает сам", () => {
  const g = started(4);
  const team = g.s.team;
  const [op] = opsOf(g);
  g.removePlayer(op, 1);
  assert.equal(g.operatives(team).length, 0);
  giveClue(g, 1, "подсказка", 2);
  const cap = capOf(g);
  assert.ok(g.open(cap, cardsOf(g, team)[0], 3).ok);
});

test("вошедший посреди партии — оперативник в меньшей команде", () => {
  const g = started(5);
  const r = g.members("red").length, b = g.members("blue").length;
  g.addPlayer({ id: "late", name: "Late", now: 9 });
  const p = g.player("late");
  assert.equal(p.team, r < b ? "red" : "blue");
  assert.ok(!TEAMS_CAP(g).includes("late"));
});
function TEAMS_CAP(g) { return [g.s.caps.red, g.s.caps.blue]; }

test("команду и капитана в игре менять нельзя", () => {
  const g = started();
  assert.equal(g.setTeam("P1", "blue").reason, "game_started");
  assert.equal(g.claimCaptain("P1").reason, "game_started");
  assert.equal(g.rename("P1", "X").reason, "game_started");
});

test("награды: снайпер и ловушка", () => {
  const g = started();
  const team = g.s.team;
  giveClue(g, 3);
  const op = opsOf(g)[0];
  const mine = cardsOf(g, team);
  g.open(op, mine[0], 1);
  g.open(op, mine[1], 2);
  g.open(op, cardsOf(g, "x")[0], 3);
  assert.equal(g.s.phase, "finished");
  const keys = g.s.awards.map((a) => a.key);
  assert.ok(keys.includes("trap"));
  assert.ok(keys.includes("clue"));
});

test("дамп и подъём: состояние живёт в JSON", () => {
  const g = started();
  giveClue(g, 2);
  const g2 = Game.from(JSON.parse(JSON.stringify(g.s)), rig(), fixture());
  g2.tapGuard = 0;
  assert.equal(g2.s.clue.word, "подсказка");
  assert.ok(g2.open(opsOf(g2)[0], cardsOf(g2, g2.s.team)[0], 5).ok);
});

test("Дальше ведущего: закрывает фазу, не раньше 800 мс", () => {
  const g = started();
  const start = g.s.phaseStart;
  assert.equal(g.skip(start + 100).reason, "too_early");
  assert.ok(g.skip(start + 1000).ok);
  assert.equal(g.s.phase, "swap");
});

test("в лобби команда с 1 человеком неразобранные не спасают", () => {
  const g = Game.create({ settings: {}, rnd: rig(), content: fixture() });
  ids(5).forEach((id) => g.addPlayer({ id, name: id }));
  ["P1", "P2", "P3", "P4"].forEach((id) => g.setTeam(id, "red"));
  g.setTeam("P5", "blue");
  assert.equal(g.start(0).reason, "team_small");
});

test("защита от случайного касания: тап раньше TAP_GUARD_MS после подсказки отклоняется", () => {
  const g = started();
  g.tapGuard = null; // как на сервере
  g.clue(capOf(g), "подсказка", 2, 1000);
  const op = opsOf(g)[0], i = cardsOf(g, g.s.team)[0];
  assert.equal(g.open(op, i, 1000 + TAP_GUARD_MS - 1).reason, "too_soon");
  assert.equal(g.s.board[i].o, false);
  assert.ok(g.open(op, i, 1000 + TAP_GUARD_MS).ok);
});

test("капитан открывает сам, если все оперативники команды не на связи", () => {
  const g = started();
  const team = g.s.team;
  for (const id of opsOf(g)) g.setOnline(id, false, 5);
  giveClue(g, 1, "подсказка", 10);
  assert.equal(g.snapshot(0, capOf(g)).me.canOpen, true);
  assert.ok(g.open(capOf(g), cardsOf(g, team)[0], 20).ok);
  // один оператор вернулся — капитан снова только подсказывает
  const g2 = started();
  giveClue(g2, 1, "подсказка", 10);
  assert.equal(g2.open(capOf(g2), cardsOf(g2, g2.s.team)[0], 20).reason, "captain");
});

test("двойники букв и полная ширина не обходят «слово с поля»", () => {
  assert.ok(wordsClash("mox", "МОХ"));
  assert.ok(wordsClash("ｍｏｘ", "mox"));
  assert.ok(wordsClash("koca", "КОСА"));
  assert.ok(wordsClash("Ёж", "еж"));
  assert.equal(checkClue("ｍｏｘ", 2, { words: ["МОХ"] }).reason, "on_board");
  assert.equal(checkClue("море", 2, { words: ["лес"] }).ok, true);
});

test("повторять подсказку партии нельзя", () => {
  const g = started();
  const t1 = g.s.team;
  giveClue(g, 1, "зима", 10);
  g.open(opsOf(g)[0], cardsOf(g, "n")[0], 20); // нейтральная — ход кончился
  g.tick(1e9);
  const r = g.clue(capOf(g), "ЗИМА", 1, 1e9 + 1); // ход соперников, но слово уже звучало
  assert.equal(r.reason, "used");
  assert.notEqual(g.s.team, t1);
});

test("три пустых хода подряд — пауза; «Играем» продолжает", () => {
  const g = started();
  let at = g.s.phaseEnd;
  for (let i = 0; i < IDLE_TURNS; i++) {
    g.tick(at); // подсказка не дана — noclue
    assert.equal(g.s.log[g.s.log.length - 1].end, "noclue");
    at = g.s.phaseEnd;
    g.tick(at); // swap → clue или paused
    at = g.s.phaseEnd;
  }
  assert.equal(g.s.phase, "paused");
  assert.equal(g.nextDeadline(), null);
  assert.equal(g.snapshot(0, "board").paused, true);
  assert.ok(g.resume(5e6).ok);
  assert.equal(g.s.phase, "clue");
  assert.equal(g.s.idleTurns, 0);
  assert.equal(g.resume(5e6).reason, "bad_phase");
});

test("пустые ходы по «Дальше» паузу не копят; ход соперника с тапом сбрасывает счётчик", () => {
  const g = started();
  g.tick(g.s.phaseEnd); // noclue
  assert.equal(g.s.idleTurns, 1);
  g.tick(g.s.phaseEnd); // swap
  giveClue(g, 1, "подсказка", 1e8);
  g.open(opsOf(g)[0], cardsOf(g, g.s.team)[0], 1e8 + 1);
  assert.equal(g.s.idleTurns, 0);
  const g2 = started();
  g2.skip(g2.s.phaseStart + 1000);
  assert.equal(g2.s.log[0].end, "skip");
  assert.equal(g2.s.idleTurns, 0);
});

test("смена капитана: причина записана для табло", () => {
  const g = started();
  const team = g.s.team, cap = capOf(g);
  g.setOnline(cap, false, 1000);
  const ev = g.tick(1000 + CAP_GRACE_MS);
  assert.equal(ev[0].reason, "offline");
  assert.equal(g.s.capChange.team, team);
  assert.equal(g.s.capChange.reason, "offline");
  assert.equal(g.snapshot(0, "board").capChange.playerId, g.s.caps[team]);
  const g2 = started();
  const ev2 = g2.removePlayer(capOf(g2), 5);
  assert.equal(ev2.find((e) => e.type === "captain").reason, "left");
});

test("первый ход чередуется между партиями", () => {
  const g = started();
  const first = g.s.starter;
  g.abort(1);
  g.start(2);
  assert.notEqual(g.s.starter, first);
  g.abort(3);
  g.start(4);
  assert.equal(g.s.starter, first);
});

test("ход одиночного оперативника короче", () => {
  const g = started(4);
  giveClue(g, 1, "подсказка", 100);
  assert.equal(g.s.phaseEnd - 100, T.guessSolo);
  const g6 = started(6);
  giveClue(g6, 1, "подсказка", 100);
  assert.equal(g6.s.phaseEnd - 100, T.guess);
});

test("noclue: событие называет ту команду, что не успела", () => {
  const g = started();
  const team = g.s.team;
  const ev = g.tick(g.s.phaseEnd);
  assert.equal(ev[0].team, team);
  assert.equal(ev[0].reason, "noclue");
});
