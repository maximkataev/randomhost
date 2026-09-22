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

  // health и неизвестная комната
  const h = await (await fetch(BASE + "/auction/api/health")).json();
  check(h.ok === true, "health ok");
  const nope = await fetch(BASE + "/auction/api/session?r=ZZZZ");
  check(nope.status === 404, "сессия для несуществующей комнаты → 404");

  console.log(failures ? `FAILURES: ${failures}` : "SERVER TESTS OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
