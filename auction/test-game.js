"use strict";

/* Юнит-тесты движка: node --test test-game.js */

const test = require("node:test");
const assert = require("node:assert/strict");
const { Game, DEFAULTS, clampSettings } = require("./game");
const { judge, buildPrompt } = require("./judge");
const { MODES, modeById, modeText, modesForKind } = require("./modes");

const cards = Array.from({ length: 60 }, (_, i) => ({ name: `Лот ${i}`, emoji: "🎲", meta: ["a", "b"], description: "d", fact: "f", wiki_en: "x" }));
const rng = () => 0.5;

// intro: 0 — заставка «задание + отсчёт» тут не нужна, партия должна начинаться с первого лота.
// Её поведение проверяется отдельным тестом ниже.
function setup(n = 3, settings = {}) {
  const g = Game.create({ kind: "test", cards, settings: { intro: 0, ...settings }, rng });
  for (let i = 0; i < n; i++) g.addPlayer({ id: `p${i}`, name: `P${i}` });
  g.start(0);
  return g;
}

test("старт: раунды = ceil(n*slots*1.25), первая фаза lot, deadline = T1", () => {
  const g = setup(3);
  assert.equal(g.s.rounds, Math.ceil(3 * 5 * 1.25));
  assert.equal(g.s.phase, "lot");
  assert.equal(g.s.deadline, 20000);
});

test("ставка: первая $1, ниже цены отклоняется, лидер не перебивает себя, expectedPrice", () => {
  const g = setup(3);
  assert.equal(g.bid("p0", 0, 100).ok, false);
  assert.equal(g.bid("p0", 1, 100).ok, true);
  assert.equal(g.s.phase, "bidding");
  assert.equal(g.bid("p0", 2, 200).reason, "already_leader");
  assert.equal(g.bid("p1", 1, 200).reason, "too_low");
  assert.equal(g.bid("p1", 2, 200, 0).reason, "price_changed");
  assert.equal(g.bid("p1", 2, 200, 1).ok, true);
  assert.equal(g.bid("p2", 999, 300).reason, "not_enough_money");
});

test("таймер после ставки = max(остаток T1, T2); анти-снайп +3 с; кап 60 с", () => {
  const g = setup(2);
  g.bid("p0", 1, 1000); // остаток T1 = 19 с > T2 → deadline остаётся 20000
  assert.equal(g.s.deadline, 20000);
  g.bid("p1", 2, 18500); // остаток 1.5 с < 2 с → анти-снайп: now + T2 + 3 с
  assert.equal(g.s.deadline, 18500 + DEFAULTS.t2 + 3000);
  // гонка до капа
  let t = 26000;
  for (let i = 0; i < 40; i++) { g.bid(i % 2 ? "p1" : "p0", g.s.price + 1, t); t = g.s.deadline - 500; }
  assert.ok(g.s.deadline <= 60000, "deadline не выше капа");
});

test("продажа списывает деньги и даёт лот; sold → следующий лот", () => {
  const g = setup(2);
  g.bid("p0", 3, 100);
  const ev = g.tick(g.s.deadline);
  assert.equal(ev[0].type, "sold");
  assert.equal(g.player("p0").money, 27);
  assert.equal(g.player("p0").lots.length, 1);
  assert.equal(g.s.phase, "sold");
  g.tick(g.s.deadline);
  assert.equal(g.s.phase, "lot");
  assert.equal(g.s.round, 1);
});

test("без ставок и без игроков с $0 → unsold → следующий лот; T1 = 3 с когда торговаться некому", () => {
  const g = setup(2);
  assert.equal(g.tick(20000)[0].type, "unsold");
  g.tick(g.s.deadline);
  assert.equal(g.s.round, 1);
  // все на мели → T1 3 с
  for (const p of g.s.players) p.money = 0;
  g.tick(g.s.deadline); // unsold (нет ставок) → pickup, т.к. есть игроки с $0
  assert.equal(g.s.phase, "pickup");
});

test("РАЗБОР: игрок с $0 забирает бесплатно, остальные не могут", () => {
  const g = setup(3);
  g.player("p2").money = 0;
  g.tick(20000);
  assert.equal(g.s.phase, "pickup");
  assert.equal(g.take("p0", 20001).reason, "cannot_take");
  assert.equal(g.take("p2", 20001).ok, true);
  assert.equal(g.player("p2").lots.length, 1);
  assert.equal(g.player("p2").lots[0].price, 0);
});

test("лидер вышел из игры: ставка снимается, лот продолжается с предыдущей чужой", () => {
  const g = setup(3);
  g.bid("p0", 1, 100);
  g.bid("p1", 2, 200);
  g.removePlayer("p1");
  assert.equal(g.s.leaderId, "p0");
  assert.equal(g.s.price, 1);
  assert.equal(g.tick(g.s.deadline)[0].type, "sold");
  assert.equal(g.player("p0").lots.length, 1);
});

test("активных меньше двух → игра завершается", () => {
  const g = setup(2);
  const ev = g.removePlayer("p1");
  assert.ok(ev.some((e) => e.type === "finished"));
  assert.equal(g.s.finishedReason, "not_enough_players");
});

test("пауза замораживает deadline и отклоняет ставки", () => {
  const g = setup(2);
  g.pause(3000);
  assert.equal(g.bid("p0", 1, 3500).reason, "paused");
  assert.deepEqual(g.tick(50000), []);
  g.resume(50000);
  assert.equal(g.s.deadline, 50000 + (20000 - 3000));
});

test("offline-игрок не торгуется и не блокирует финал", () => {
  const g = setup(2, { slots: 3 });
  g.setOnline("p1", false);
  assert.ok(g.s.paused, "отвал игрока останавливает партию");
  g.resume(200); // ведущий продолжает без него
  assert.equal(g.bid("p1", 1, 100).reason, "cannot_bid");
  for (let i = 0; i < 3; i++) { g.bid("p0", 1, g.s.lotStartedAt + 100); g.tick(g.s.deadline); g.tick(g.s.deadline); }
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.finishedReason, "all_full");
});

test("раунды кончились → финал даже с пустыми слотами", () => {
  const g = setup(2, { slots: 3 });
  for (let i = 0; i < g.s.rounds; i++) { g.tick(g.s.deadline); if (g.s.phase !== "finished") g.tick(g.s.deadline); }
  assert.equal(g.s.phase, "finished");
  assert.equal(g.s.finishedReason, "rounds_over");
});

test("голосование: за себя нельзя, без лотов нельзя, ничья решается по потраченному", () => {
  const g = setup(3);
  g.bid("p0", 5, 100); g.tick(g.s.deadline); g.tick(g.s.deadline);
  g.bid("p1", 2, g.s.lotStartedAt + 100); g.tick(g.s.deadline); g.tick(g.s.deadline);
  g.finish("host_ended");
  assert.equal(g.vote("p0", "p0").reason, "bad_vote");
  assert.equal(g.vote("p2", "p0").reason, "no_lots");
  assert.equal(g.vote("p0", "p1").ok, true);
  assert.equal(g.vote("p1", "p0").ok, true);
  g.closeVotes(rng);
  assert.equal(g.s.results.mode, "vote");
  assert.equal(g.s.results.ranking[0].playerId, "p1", "при 1:1 выше тот, кто потратил меньше");
});

test("имена уникальны, деньги = бюджет из настроек, clamp настроек", () => {
  const g = Game.create({ kind: "test", cards, settings: { budget: 9999, slots: 1 }, rng });
  assert.equal(g.s.settings.budget, 200);
  assert.equal(g.s.settings.slots, 3);
  g.addPlayer({ id: "a", name: "Макс" });
  g.addPlayer({ id: "b", name: "Макс" });
  assert.equal(g.player("b").name, "Макс 2");
  assert.equal(g.player("a").money, 200);
});

test("снимок не отдаёт колоду и содержит только текущий лот", () => {
  const g = setup(2);
  const snap = g.snapshot(0);
  assert.equal(snap.deck, undefined);
  assert.equal(snap.lot.name, g.s.deck[0].name);
  assert.ok(snap.players.every((p) => "canBid" in p));
});

test("хост пропускает лот: без ставок — следующий, с торгами — продажа лидеру", () => {
  const g = setup(3);
  g.hostSkip(500);
  assert.ok(["unsold", "pickup"].includes(g.s.phase));
  g.tick(g.s.deadline);
  if (g.s.phase !== "lot") g.tick(g.s.deadline);
  assert.equal(g.s.round, 1);
  g.bid("p0", 4, g.s.lotStartedAt + 100);
  const ev = g.hostSkip(g.s.lotStartedAt + 200);
  assert.equal(ev[0].type, "sold");
  assert.equal(g.player("p0").lots.length, 1);
});

test("пропуск лота работает и в фазах ПРОДАНО/ОТБОЙ, но не на паузе", () => {
  const g = setup(3);
  g.bid("p0", 2, 100);
  g.hostSkip(200); // → sold
  assert.equal(g.s.phase, "sold");
  const ev = g.hostSkip(300); // раньше кнопка в этой фазе была мертва и ждали 2 с
  assert.equal(g.s.phase, "lot");
  assert.equal(g.s.round, 1);
  assert.ok(ev.some((e) => e.type === "lot"));
  g.hostSkip(g.s.lotStartedAt + 100); // без ставок → unsold
  assert.equal(g.s.phase, "unsold");
  g.hostSkip(g.s.lotStartedAt + 150);
  assert.equal(g.s.round, 2);
  // на паузе пропуск ничего не делает и не сбивает таймер
  g.pause(g.s.lotStartedAt + 200);
  const before = g.s.deadline;
  assert.deepEqual(g.hostSkip(g.s.lotStartedAt + 300), []);
  assert.equal(g.s.deadline, before);
  assert.equal(g.s.phase, "lot");
});

test("отвал игрока ставит партию на паузу; снимает её только ведущий", () => {
  const g = setup(2, { slots: 3 });
  g.bid("p0", 1, 100);
  g.tick(g.s.deadline); // sold
  const ev = g.setOnline("p0", false, 200);
  assert.equal(g.s.paused.auto, true, "партия встала сама");
  assert.ok(ev.some((e) => e.type === "paused"), "о паузе сообщено");
  assert.ok(ev.some((e) => e.type === "dropped" && e.playerId === "p0"), "сказано, кто отвалился");
  assert.equal(g.s.phase, "sold", "фаза не сгорела");
  assert.equal(g.s.round, 0, "раунд не сгорел");
  assert.equal(g.snapshot(0).pausedAuto, true);
  // второй отвал уже ничего не ломает — партия и так стоит
  assert.deepEqual(g.setOnline("p1", false, 300), []);
  // возвращение игрока партию НЕ продолжает: это делает ведущий
  assert.deepEqual(g.setOnline("p0", true, 400), []);
  assert.ok(g.s.paused, "вернувшийся игрок не снимает паузу сам");
  g.resume(60000);
  g.tick(g.s.deadline);
  assert.equal(g.s.phase, "lot");
  assert.equal(g.s.round, 1);
  assert.equal(g.s.finishedReason, null);
});

test("отвал в лобби и на финале партию не трогает", () => {
  const lobby = Game.create({ kind: "test", cards, settings: {}, rng });
  lobby.addPlayer({ id: "p0", name: "A" });
  lobby.addPlayer({ id: "p1", name: "B" });
  assert.deepEqual(lobby.setOnline("p0", false, 100), [], "в лобби паузы нет");
  assert.equal(lobby.s.paused, null);

  const g = setup(2, { slots: 3 });
  g.finish("host_ended");
  assert.deepEqual(g.setOnline("p0", false, 100), [], "на финале паузы нет");
});

test("после паузы в активной фазе остаётся не меньше 3 с", () => {
  const g = setup(2);
  g.bid("p0", 1, 1000);
  g.pause(g.s.deadline - 400); // пауза за 0,4 с до конца торгов
  const t = 90000;
  g.resume(t);
  assert.equal(g.s.deadline, t + 3000);
  assert.ok(g.s.lotCapAt >= g.s.deadline, "кап не режет добавленные секунды");
});

test("лидер исчез в момент истечения таймера — лот в отбой, tick не падает", () => {
  const g = setup(3);
  g.bid("p0", 3, 100);
  g.player("p0").left = true; // гонка: кик/выход обработан вне removePlayer
  const ev = g.tick(g.s.deadline);
  assert.equal(ev[0].type, "unsold");
  assert.equal(g.player("p0").money, 30, "деньги не списались");
  assert.equal(g.s.phase, "unsold");
});

test("голос после подсчёта итогов не принимается", () => {
  const g = setup(3);
  g.bid("p0", 1, 100); g.tick(g.s.deadline); g.tick(g.s.deadline);
  g.bid("p1", 1, g.s.lotStartedAt + 100); g.tick(g.s.deadline); g.tick(g.s.deadline);
  g.finish("host_ended");
  assert.equal(g.vote("p0", "p1").ok, true);
  g.closeVotes(rng);
  assert.equal(g.vote("p1", "p0").reason, "closed");
  assert.equal(Object.keys(g.s.votes).length, 1);
});

test("12 игроков: партия заканчивается, деньги и слоты не уходят в минус", () => {
  const g = Game.create({ kind: "test", cards: Array.from({ length: 200 }, (_, i) => ({ name: `Л${i}`, emoji: "🎲", meta: ["m"] })), settings: { slots: 5 }, rng });
  for (let i = 0; i < 12; i++) g.addPlayer({ id: `p${i}`, name: `P${i}` });
  g.start(0);
  assert.equal(g.s.rounds, Math.ceil(12 * 5 * 1.25));
  let now = 0, guard = 0;
  while (g.s.phase !== "finished" && guard++ < 20000) {
    for (let i = 0; i < 12; i++) {
      const p = g.player(`p${i}`);
      if (g.s.phase === "pickup") g.take(p.id, now);
      else if ((i + guard) % 3 === 0) g.bid(p.id, g.s.price + 1, now);
    }
    now += 700;
    g.tick(now);
  }
  assert.equal(g.s.phase, "finished");
  for (const p of g.s.players) {
    assert.ok(p.money >= 0, `${p.name} с минусом на счету`);
    assert.ok(p.lots.length <= 5, `${p.name} набрал больше слотов`);
    assert.equal(p.spent + p.money, 30, `${p.name}: потрачено + остаток ≠ бюджет`);
  }
});

// ---------- судья ----------

const judgeReply = (obj) => ({ ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(obj) }] }] }) });
const twoLineups = [{ pid: "p1", playerId: "a", lots: [{ name: "X", meta: [] }] }, { pid: "p2", playerId: "b", lots: [] }];
const full = { results: [{ player: "p1", score: 120, verdict: "норм" }, { player: "p2", score: 40, verdict: "так" }], summary: "итог" };

test("судья: неполный ответ повторяется один раз, оценки прижимаются к 0–100", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return judgeReply(calls === 1 ? { results: [full.results[0]], summary: "нет второго" } : full); };
  const v = await judge({ kind: "artist", lineups: twoLineups, slots: 3, apiKey: "k", model: "m", fetchImpl });
  assert.equal(calls, 2);
  assert.equal(v.results.length, 2);
  assert.equal(v.results[0].score, 100);
});

test("судья: два кривых ответа подряд → ошибка (сервер уйдёт в голосование)", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return judgeReply({ results: [full.results[0], full.results[0]], summary: "дубль" }); };
  await assert.rejects(() => judge({ kind: "artist", lineups: twoLineups, slots: 3, apiKey: "k", model: "m", fetchImpl }), /duplicate/);
  assert.equal(calls, 2);
});

test("судья: HTTP-ошибка API не роняет сервер, а превращается в исключение", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "bad key" } }) });
  await assert.rejects(() => judge({ kind: "film", lineups: twoLineups, slots: 3, apiKey: "bad", model: "m", fetchImpl }), /bad key/);
});

// ---------- задания ----------

test("задание: валидное принимается, мусорное откатывается к base", () => {
  assert.equal(setup(2, { mode: "worst" }).s.settings.mode, "worst");
  assert.equal(setup(2, { mode: "нет-такого" }).s.settings.mode, "base");
  assert.equal(setup(2).s.settings.mode, "base");
});

// Раньше проверка задания на доступность категории жила только в обработчике settings, поэтому
// «лига суперзлодеев» доезжала до судьи вместе с блюдами через POST /rooms и next_game.
test("задание: недоступное категории задание сбрасывается при создании партии", () => {
  const mk = (kind, mode) => Game.create({ kind, cards, settings: { mode }, rng }).s.settings.mode;
  assert.equal(mk("character", "villains"), "villains");
  assert.equal(mk("food", "villains"), "base", "villains недоступен блюдам");
  assert.equal(mk("city", "villains"), "base", "villains недоступен городам");
  assert.equal(mk("food", "worst"), "worst", "worst доступен везде");
  assert.equal(clampSettings({ mode: "villains" }, "city").mode, "base");
  assert.equal(clampSettings({ mode: "villains" }, "person").mode, "villains");
  assert.equal(clampSettings({ mode: "villains" }).mode, "villains", "без категории проверять нечем");
});

test("задание: villains есть у персонажей и нет у городов", () => {
  const ids = (k) => modesForKind(k).map((m) => m.id);
  assert.ok(ids("character").includes("villains"));
  assert.ok(!ids("city").includes("villains"));
  for (const k of ["artist", "city", "film", "food"]) assert.ok(ids(k).includes("base"), `${k}: base должен быть везде`);
});

// Копия для статики делается вручную (npm run sync-modes), потому что .dockerignore не пускает
// auction/ в образ nginx. Расхождение молча ломает страницы: сервер судит по одному заданию,
// а игроки на экране видят другое (или задание вообще пропадает с плиток).
test("задание: auction/modes.js и корневой auction-modes.js совпадают байт в байт", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const mine = fs.readFileSync(path.join(__dirname, "modes.js"), "utf8");
  const copy = fs.readFileSync(path.join(__dirname, "..", "auction-modes.js"), "utf8");
  assert.equal(copy, mine, "копия устарела — выполните npm run sync-modes");
});

test("задание: у каждого задания есть всё, что подставляют страницы и промпт", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const kinds = fs.readdirSync(path.join(__dirname, "data")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  const ids = new Set();
  for (const m of MODES) {
    assert.ok(!ids.has(m.id), `дубль id задания: ${m.id}`);
    ids.add(m.id);
    for (const f of ["icon", "title", "short", "judge"]) assert.ok(m[f] && String(m[f]).trim(), `${m.id}: пустое поле ${f}`);
    if (m.id !== "base") for (const f of ["what", "criteria", "prompt"]) assert.ok(m[f] && String(m[f]).trim(), `${m.id}: пустое поле ${f}`);
    // опечатка в kinds/notKinds молча прячет задание из лобби и никак себя не проявляет
    for (const k of m.kinds || []) assert.ok(kinds.includes(k), `${m.id}: неизвестная категория «${k}» в kinds`);
    for (const k of m.notKinds || []) assert.ok(kinds.includes(k), `${m.id}: неизвестная категория «${k}» в notKinds`);
    assert.ok(!(m.kinds && m.notKinds), `${m.id}: белый и чёрный список одновременно — что-то одно`);
  }
  assert.equal(MODES[0].id, "base", "обычное задание должно быть первой плиткой");
  for (const k of kinds) assert.ok(modesForKind(k).length >= 2, `${k}: в категории нечего выбирать`);
});

test("судья: текст задания попадает в промпт, base его не добавляет", () => {
  const worst = buildPrompt("artist", twoLineups, 5, "worst");
  assert.ok(worst.includes("нарочно провальный набор"), "нет формулировки задания");
  assert.ok(worst.includes("несовместимость"), "нет критериев задания");
  assert.ok(worst.includes("Скучный средний набор"), "нет инструкции судье");
  const base = buildPrompt("artist", twoLineups, 5, "base");
  assert.ok(!base.includes("нарочно провальный"), "base подмешал чужое задание");
  assert.equal(buildPrompt("artist", twoLineups, 5, "чушь"), base, "неизвестное задание должно вести себя как base");
});

test("судья: задание уходит в реальный вызов judge()", async () => {
  let sent = "";
  const fetchImpl = async (_u, opts) => { sent = opts.body; return judgeReply(full); };
  await judge({ kind: "artist", lineups: twoLineups, slots: 3, mode: "villains", apiKey: "k", model: "m", fetchImpl });
  assert.ok(sent.includes("суперзлодеев") || sent.includes("\\u0437\\u043b\\u043e\\u0434\\u0435"), "тело запроса без задания: " + sent.slice(0, 200));
});

// ---------- заставка перед первым лотом ----------

test("заставка: старт уходит в intro, по дедлайну открывается первый лот", () => {
  const g = Game.create({ kind: "test", cards, settings: {}, rng });
  g.addPlayer({ id: "p0", name: "A" });
  g.addPlayer({ id: "p1", name: "B" });
  const ev = g.start(0);
  assert.equal(g.s.phase, "intro", "старт должен показывать заставку");
  assert.equal(g.s.deadline, DEFAULTS.intro, "дедлайн заставки = длительности intro");
  assert.ok(ev.some((e) => e.type === "intro"), "событие intro не пришло");
  assert.equal(g.s.lot, null, "во время заставки лота ещё нет");
  assert.equal(g.s.round, -1, "раунды начинаются после заставки");
  // раньше дедлайна ничего не происходит
  assert.deepEqual(g.tick(DEFAULTS.intro - 1), []);
  assert.equal(g.s.phase, "intro");
  g.tick(DEFAULTS.intro);
  assert.equal(g.s.phase, "lot", "после заставки начинается первый лот");
  assert.equal(g.s.round, 0);
  assert.ok(g.s.lot, "лот выдан");
  assert.equal(g.s.deadline, DEFAULTS.intro + g.s.settings.t1, "первый лот получает полный T1, заставка его не съедает");
});

test("заставка: ставки и разбор во время заставки невозможны", () => {
  const g = Game.create({ kind: "test", cards, settings: {}, rng });
  g.addPlayer({ id: "p0", name: "A" });
  g.addPlayer({ id: "p1", name: "B" });
  g.start(0);
  assert.equal(g.bid("p0", 1, 100).ok, false, "ставка на заставке должна отклоняться");
  assert.equal(g.take("p0", 100).ok, false, "забрать лот на заставке нельзя");
});

test("заставка: ведущий может её оборвать, заставка выключается настройкой", () => {
  const g = Game.create({ kind: "test", cards, settings: {}, rng });
  g.addPlayer({ id: "p0", name: "A" });
  g.addPlayer({ id: "p1", name: "B" });
  g.start(0);
  g.hostSkip(1000);
  assert.equal(g.s.phase, "lot", "пропуск на заставке открывает первый лот");
  assert.equal(g.s.deadline, 1000 + g.s.settings.t1, "оборванная заставка не укорачивает первый лот");

  const g2 = setup(2); // setup ставит intro: 0
  assert.equal(g2.s.phase, "lot", "с intro: 0 партия начинается сразу с лота");
});

test("заставка: пауза на заставке замораживает её, а не проглатывает", () => {
  const g = Game.create({ kind: "test", cards, settings: {}, rng });
  g.addPlayer({ id: "p0", name: "A" });
  g.addPlayer({ id: "p1", name: "B" });
  g.start(0);
  g.pause(2000);
  assert.deepEqual(g.tick(99999), [], "на паузе заставка не истекает");
  assert.equal(g.s.phase, "intro");
  g.resume(50000);
  assert.equal(g.s.phase, "intro", "после снятия паузы заставка продолжается");
  g.tick(g.s.deadline);
  assert.equal(g.s.phase, "lot");
});

test("задание: у категории своё название, и оно не расходится с рамкой судьи", () => {
  const { FRAMES } = require("./judge");
  // общий текст — запасной: если у категории есть своя формулировка, показываем её
  assert.equal(modeText("base", "artist").title, "Лайнап фестиваля");
  assert.equal(modeText("worst", "food").title, "Худшее меню");
  assert.equal(modeText("party", "invention").title, modeById("party").title, "категория без своей строки берёт общий текст");
  assert.equal(modeText("base", "нет-такой-категории").title, modeById("base").title);
  // byKind переопределяет только тексты для экрана; промптовые поля остаются общими
  for (const m of MODES) {
    for (const k of Object.keys(m.byKind || {})) {
      assert.ok(FRAMES[k], `${m.id}: byKind ссылается на неизвестную категорию «${k}»`);
      const t = modeText(m.id, k);
      for (const f of ["icon", "title", "short", "judge"]) assert.ok(t[f] && String(t[f]).trim(), `${m.id}/${k}: пустое ${f}`);
      // modeText отдаёт только то, что показывают на экране: промптовые поля не должны просачиваться
      // в интерфейс, иначе перевод байкинда начал бы менять условия судейства
      for (const f of ["what", "criteria", "prompt", "kinds", "notKinds", "t", "byKind"]) {
        assert.equal(t[f], undefined, `${m.id}/${k}: modeText отдал непоказываемое поле ${f}`);
      }
      assert.ok(!(m.kinds && !m.kinds.includes(k)), `${m.id}: текст для «${k}», где задание недоступно`);
      assert.ok(!(m.notKinds && m.notKinds.includes(k)), `${m.id}: текст для «${k}», где задание недоступно`);
    }
  }
});

// ---------- язык партии ----------

test("язык: валидный принимается, мусор откатывается к русскому", () => {
  assert.equal(clampSettings({}).lang, "ru");
  for (const l of ["ru", "en", "el"]) assert.equal(clampSettings({ lang: l }).lang, l);
  for (const bad of ["xx", "EN", 1, null, {}]) assert.equal(clampSettings({ lang: bad }).lang, "ru", `мусор ${JSON.stringify(bad)}`);
});

test("язык: судья получает инструкцию отвечать на языке партии", () => {
  const lu = [{ pid: "p1", playerId: "a", lots: [{ name: "X", meta: [] }] }, { pid: "p2", playerId: "b", lots: [] }];
  assert.match(buildPrompt("artist", lu, 3, "base", "ru"), /по-русски/);
  assert.match(buildPrompt("artist", lu, 3, "base", "en"), /Answer in English/);
  assert.match(buildPrompt("artist", lu, 3, "base", "el"), /ελληνικά/);
  // без языка ведём себя как раньше — русский
  assert.equal(buildPrompt("artist", lu, 3, "base"), buildPrompt("artist", lu, 3, "base", "ru"));
  // подпись пустого слота тоже на языке партии, иначе в английском вердикте всплывало бы «пусто»
  assert.match(buildPrompt("artist", lu, 3, "base", "en"), /empty/);
  assert.ok(!/пусто/.test(buildPrompt("artist", lu, 3, "base", "en")), "в английский промпт просочилось «пусто»");
});

test("имя комнаты: задаётся ведущим, чистится и не заменяет код", () => {
  assert.equal(clampSettings({}).title, "", "по умолчанию имени нет");
  assert.equal(clampSettings({ title: "  Днюха   Ани " }).title, "Днюха Ани", "пробелы схлопнуты");
  assert.equal(clampSettings({ title: "x".repeat(200) }).title.length, 40, "длина ограничена");
  for (const bad of [{}, [], 7, null, undefined]) assert.equal(clampSettings({ title: bad }).title, "", `мусор ${JSON.stringify(bad)}`);
  // имя — только подпись: код комнаты генерируется сервером и от него не зависит
  const g = Game.create({ kind: "test", cards, settings: { title: "Днюха" }, rng });
  assert.equal(g.s.settings.title, "Днюха");
  assert.equal(g.s.code, undefined, "код живёт в комнате на сервере, а не в настройках партии");
});

test("язык: сервер не пишет клиенту по-русски на чужом языке", () => {
  // Единственное имя, которое движок придумывает сам. Оно уезжает на экран, поэтому
  // обязано быть на языке партии — иначе в английской комнате появлялся бы «Игрок».
  for (const [lang, expected] of [["ru", "Игрок"], ["en", "Player"], ["el", "Παίκτης"]]) {
    const g = Game.create({ kind: "test", cards, settings: { lang }, rng });
    assert.equal(g.addPlayer({ id: "a", name: "   " }).name, expected, `запасное имя для ${lang}`);
  }
});
