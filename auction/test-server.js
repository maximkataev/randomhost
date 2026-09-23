"use strict";

/* Протокольные тесты сервера против локального dev-сервера: node test-server.js [http://localhost:3000] */

const WebSocket = require("ws");
const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws") + "/auction/ws?r=";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) return false; await wait(60); } return true; };
let failures = 0;
const check = (ok, name) => { console.log((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) failures++; };

function connect(code, first) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS + code);
    const c = { ws, state: null, msgs: [], me: null, token: null, closed: false, send: (m) => ws.send(JSON.stringify(m)) };
    ws.on("open", () => ws.send(JSON.stringify(first)));
    ws.on("message", (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.type === "state" || m.type === "hello") c.state = m.state; if (m.type === "joined") { c.me = m.playerId; c.token = m.token; resolve(c); } if (m.type === "host_ok") resolve(c); if (m.type === "error" && !c.me) resolve(c); });
    ws.on("close", () => (c.closed = true));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}
const has = (c, type, pred = () => true) => c.msgs.some((m) => m.type === type && pred(m));

(async () => {
  const room = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal" }) })).json();
  console.log("room", room.code);
  const host = await connect(room.code, { type: "host", token: room.hostToken });
  const bad = await connect(room.code, { type: "host", token: "wrong" });
  check(has(bad, "error", (m) => /token/.test(m.error)), "неверный хост-токен отклоняется");

  const a = await connect(room.code, { type: "join", name: "Аня" });
  const b = await connect(room.code, { type: "join", name: "Аня" });
  await until(() => host.state?.players.length === 2);
  check(host.state.players.map((p) => p.name).join(",") === "Аня,Аня 2", "одинаковые имена получают суффикс");

  host.send({ type: "settings", settings: { budget: 50, slots: 3 } });
  await until(() => host.state.settings.budget === 50);
  check(host.state.players.every((p) => p.money === 50), "смена бюджета в лобби обновляет деньги игроков");

  host.send({ type: "start" });
  await until(() => host.state.phase === "lot");
  check(host.state.phase === "lot", "старт");
  host.send({ type: "settings", settings: { budget: 10 } });
  await wait(200);
  check(host.state.settings.budget === 50, "настройки после старта не меняются");

  const late = await connect(room.code, { type: "join", name: "Опоздавший" });
  check(has(late, "error", (m) => m.error === "game_started"), "новый игрок после старта не входит");

  // пауза
  host.send({ type: "pause" });
  await until(() => host.state.paused);
  a.send({ type: "bid", amount: 1 });
  await until(() => has(a, "rejected"));
  check(has(a, "rejected", (m) => m.reason === "paused"), "ставка на паузе отклоняется");
  host.send({ type: "resume" });
  await until(() => !host.state.paused);

  // ставка и обрыв соединения игрока: он offline, но лот остаётся
  a.send({ type: "bid", amount: 2, expectedPrice: 0 });
  await until(() => host.state.price === 2);
  check(host.state.leaderId === a.me, "ставка принята, лидер Аня");
  b.ws.close();
  await until(() => host.state.players.find((p) => p.id === b.me)?.online === false);
  check(host.state.players.find((p) => p.id === b.me).online === false, "закрытый сокет → offline");

  // повторный вход по имени без токена во время игры
  const b2 = await connect(room.code, { type: "join", name: "Аня 2" });
  check(b2.me === b.me, "повторный вход по имени возвращает того же игрока");
  const b3 = await connect(room.code, { type: "join", name: "", token: b2.token });
  await until(() => has(b2, "replaced"));
  check(b3.me === b.me && has(b2, "replaced"), "второе устройство по токену заменяет первое");

  // вторая доска заменяет первую
  const host2 = await connect(room.code, { type: "host", token: room.hostToken });
  host2.send({ type: "pause" });
  await until(() => host2.state?.paused);
  check(host2.state.paused === true, "новая доска управляет игрой");
  host2.send({ type: "resume" });
  await until(() => !host2.state.paused);

  // кик
  host2.send({ type: "kick", playerId: b.me });
  await until(() => has(b3, "kicked"));
  check(has(b3, "kicked"), "кикнутый игрок получает kicked");
  await until(() => host2.state.phase === "finished");
  check(host2.state.phase === "finished" && host2.state.finishedReason === "not_enough_players", "остался один активный → игра завершена");

  // новая игра сохраняет активных игроков и сбрасывает деньги
  const c = await connect(room.code, { type: "join", name: "Аня 2" }); // после финала (lobby нет) — вход по имени offline-игрока
  host2.send({ type: "next_game", kind: "food" });
  await until(() => host2.state.phase === "lobby");
  check(host2.state.phase === "lobby" && host2.state.kind === "food", "next_game → лобби с новой категорией");
  check(host2.state.players.every((p) => p.money === 50 && p.lots.length === 0), "деньги и лоты сброшены");

  // новый игрок входит в лобби следующей игры
  const vitya = await connect(room.code, { type: "join", name: "Витя" });
  check(!!vitya.me, "в лобби после next_game входит новый игрок");

  // ---------- гонки: одновременные ставки ----------
  const make = async (settings, speed) =>
    (await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal", settings, speed }) })).json());

  {
    const r2 = await make({ slots: 5, budget: 30, t1: 20000, t2: 5000 });
    const h2 = await connect(r2.code, { type: "host", token: r2.hostToken });
    const crowd = [];
    for (let i = 0; i < 10; i++) crowd.push(await connect(r2.code, { type: "join", name: "И" + i }));
    await until(() => h2.state?.players.length === 10, 10000);
    check(h2.state.players.length === 10, "10 игроков в комнате (лимит снят)");
    h2.send({ type: "start" });
    await until(() => h2.state.phase === "lot");
    check(h2.state.rounds === Math.ceil(10 * 5 * 1.25), `раундов = ceil(10×5×1.25) (${h2.state.rounds})`);
    // все десять ставят «$1» одновременно с одной и той же ожидаемой ценой
    for (const c of crowd) c.send({ type: "bid", amount: 1, expectedPrice: 0 });
    await until(() => h2.state.price === 1, 4000);
    await wait(400);
    check(h2.state.price === 1 && h2.state.bids.length === 1, `из десяти одновременных ставок принята одна (цена ${h2.state.price})`);
    const rejects = crowd.filter((c) => has(c, "rejected", (m) => m.reason === "price_changed" || m.reason === "too_low")).length;
    check(rejects === 9, `остальным девяти пришёл явный отказ (${rejects})`);
    check(crowd.every((c) => !has(c, "error")), "лишние ставки не ломают протокол");
    // ставка в момент истечения таймера: лот либо ушёл, либо ставка принята — но деньги списываются один раз
    const leader = h2.state.players.find((p) => p.id === h2.state.leaderId);
    await until(() => h2.state.phase === "sold" || h2.state.phase === "lot", 30000);
    const after = h2.state.players.find((p) => p.id === leader.id);
    check(after.money === 29 && after.lots.length === 1, `лот списан один раз ($${after.money}, лотов ${after.lots.length})`);
    // пропуск лота ведущим в разных фазах
    await until(() => h2.state.phase === "lot", 30000);
    const round = h2.state.round;
    crowd[0].send({ type: "bid", amount: 2 });
    await until(() => h2.state.phase === "bidding");
    h2.send({ type: "skip_lot" });
    await until(() => h2.state.phase === "sold", 4000);
    check(h2.state.phase === "sold", "skip_lot в ТОРГАХ отдаёт лот лидеру сразу");
    h2.send({ type: "skip_lot" });
    const moved = await until(() => h2.state.round === round + 1, 3000);
    check(moved, "skip_lot в фазе ПРОДАНО сразу выводит следующий лот");
    crowd[1].send({ type: "skip_lot" });
    await wait(300);
    check(h2.state.round === round + 1, "игрок не может пропустить лот");
    h2.send({ type: "end" });
    for (const c of crowd) c.ws.close();
    h2.ws.close();
  }

  // ---------- автопауза, когда все отвалились ----------
  {
    const r3 = await make({ slots: 3, budget: 20, t1: 5000, t2: 3000 });
    const h3 = await connect(r3.code, { type: "host", token: r3.hostToken });
    const x = await connect(r3.code, { type: "join", name: "Икс" });
    const y = await connect(r3.code, { type: "join", name: "Игрек" });
    await until(() => h3.state?.players.length === 2);
    h3.send({ type: "start" });
    await until(() => h3.state.phase !== "lobby");
    x.ws.close(); y.ws.close();
    const paused = await until(() => h3.state.paused, 20000);
    check(paused && h3.state.pausedAuto === true, "все игроки отвалились → автопауза, а не финал");
    check(h3.state.phase !== "finished", "партия не завершилась сама");
    const back = await connect(r3.code, { type: "join", name: "", token: x.token });
    check(back.me === x.me, "возврат по токену в ту же партию");
    const resumed = await until(() => !h3.state.paused, 6000);
    check(resumed, "возврат игрока снимает автопаузу");
    h3.send({ type: "end" });
    back.ws.close(); h3.ws.close();
  }

  // ---------- голосование закрывается по таймауту (speed ускоряет 30 с) ----------
  {
    const r4 = await make({ slots: 3, budget: 20, t1: 10000, t2: 3000, judge: "vote" }, 6);
    const h4 = await connect(r4.code, { type: "host", token: r4.hostToken });
    const v1 = await connect(r4.code, { type: "join", name: "Один" });
    const v2 = await connect(r4.code, { type: "join", name: "Два" });
    await until(() => h4.state?.players.length === 2);
    h4.send({ type: "start" });
    await until(() => h4.state.phase !== "lobby");
    for (const c of [v1, v2]) {
      const mine = () => h4.state.players.find((p) => p.id === c.me);
      await until(() => (h4.state.phase === "lot" || h4.state.phase === "bidding") && mine().canBid, 40000);
      c.send({ type: "bid", amount: h4.state.price + 1 });
      await until(() => mine().lots.length >= 1, 40000);
    }
    h4.send({ type: "end" });
    await until(() => h4.state.phase === "finished");
    check(await until(() => h4.state.voting, 5000), "судья = голосование → открылось голосование");
    v1.send({ type: "vote", for: v2.me });
    await until(() => h4.state.votes === 1, 4000);
    const closed = await until(() => h4.state.results, 40000); // 30 с голосования (при speed=1 — без ускорения)
    check(closed, "голосование закрывается по таймауту, даже если проголосовали не все");
    if (closed) {
      check(h4.state.results.mode === "vote" && h4.state.results.ranking.length === 2, "итоги голосования посчитаны для обоих");
      check(h4.state.results.ranking[0].playerId === v2.me, "выше тот, за кого голосовали");
      v2.send({ type: "vote", for: v1.me });
      await until(() => has(v2, "rejected"), 3000);
      check(has(v2, "rejected", (m) => m.reason === "closed"), "голос после подсчёта отклоняется");
    }
    v1.ws.close(); v2.ws.close(); h4.ws.close();
  }

  // health и неизвестная комната
  const h = await (await fetch(BASE + "/auction/api/health")).json();
  check(h.ok === true, "health ok");
  const nope = await fetch(BASE + "/auction/api/session?r=ZZZZ");
  check(nope.status === 404, "сессия для несуществующей комнаты → 404");

  console.log(failures ? `FAILURES: ${failures}` : "SERVER TESTS OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
