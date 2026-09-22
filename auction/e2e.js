"use strict";

/*
 * Сквозной тест против живого сервера: node e2e.js https://randomhost.online
 * Создаёт комнату, подключает доску и двух скриптовых игроков, играет короткую партию (3 слота),
 * проверяет ставки, отказ ставки, РАЗБОР, финал и судейство (ChatGPT или голосование).
 */

const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws") + "/auction/ws?r=";
const deadline = Date.now() + 8 * 60 * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Транспорт как у страниц: WebSocket, а если прокси его не пропускает — SSE + POST.
function connect(code, first) {
  return new Promise((resolve, reject) => {
    const c = { state: null, events: [], rejected: [], me: null, token: null, hostOk: false, mode: "ws" };
    const onMsg = (m) => {
      if (m.type === "hello") c.state = m.state;
      if (m.type === "state") c.state = m.state;
      if (m.type === "event") c.events.push(m.event);
      if (m.type === "rejected") c.rejected.push(m);
      if (m.type === "joined") { c.me = m.playerId; c.token = m.token; resolve(c); }
      if (m.type === "host_ok") { c.hostOk = true; resolve(c); }
      if (m.type === "error") reject(new Error(m.error));
    };
    if (process.env.TRANSPORT === "poll") { startSse(); return; } // принудительно проверить запасной транспорт
    const ws = new WebSocket(WS + code);
    let opened = false;
    ws.on("open", () => { opened = true; c.send = (m) => ws.send(JSON.stringify(m)); ws.send(JSON.stringify(first)); });
    ws.on("message", (raw) => onMsg(JSON.parse(raw)));
    let fell = false;
    const fallback = () => { if (!opened && !fell) { fell = true; startSse(); } };
    ws.on("error", fallback);
    ws.on("close", fallback);
    async function startSse() { // long-polling, как у страниц
      c.mode = "poll";
      const res = await fetch(BASE + "/auction/api/session?r=" + code);
      if (!res.ok) return reject(new Error("session " + res.status));
      const data = await res.json();
      const sid = data.sid;
      c.send = (m) => fetch(BASE + "/auction/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg: m }) }).catch(() => {});
      for (const m of data.messages) onMsg(m);
      c.send(first);
      (async () => { for (;;) { const r = await fetch(BASE + "/auction/api/poll?sid=" + sid); if (r.status === 410) return; if (!r.ok) { await wait(1000); continue; } for (const m of (await r.json()).messages) onMsg(m); } })().catch(() => {});
    }
    setTimeout(() => reject(new Error("connect timeout")), 15000);
  });
}

(async () => {
  const health = await (await fetch(BASE + "/auction/api/health")).json();
  log("health", JSON.stringify(health));
  if (!health.ok) fail("health");

  const res = await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "food" }) });
  const room = await res.json();
  if (!room.code) fail("room not created: " + JSON.stringify(room));
  log("room", room.code);

  const host = await connect(room.code, { type: "host", token: room.hostToken });
  const anya = await connect(room.code, { type: "join", name: "Аня" });
  const max = await connect(room.code, { type: "join", name: "Макс" });
  log("joined", anya.me, max.me, "transport:", host.mode);

  host.send({ type: "settings", settings: { slots: 3, budget: 20, t1: 5000, t2: 3000 } });
  await wait(300);
  if (host.state.settings.slots !== 3) fail("settings not applied");
  host.send({ type: "start" });
  await wait(500);
  if (host.state.phase !== "lot") fail("game did not start: " + host.state.phase);
  log("started, rounds", host.state.rounds);
  // устаревшая цена в ставке — сервер обязан ответить rejected/price_changed
  anya.send({ type: "bid", amount: 1, expectedPrice: 5 });
  await wait(400);
  if (!anya.rejected.some((r) => r.reason === "price_changed")) fail("stale bid was not rejected: " + JSON.stringify(anya.rejected));
  log("stale bid rejected ✓");

  // Аня: агрессивно до $6; Макс: только открывающие $1, тратит всё, чтобы попасть в РАЗБОР
  let lastRound = -1, sawPickup = false, sawTaken = false;
  while (Date.now() < deadline) {
    const s = host.state;
    if (s.phase === "finished") break;
    if (s.round !== lastRound) { lastRound = s.round; log(`lot ${s.round + 1}/${s.rounds}: ${s.lot?.name}`); }
    if (s.phase === "pickup") sawPickup = true;
    if ((s.phase === "lot" || s.phase === "bidding")) {
      const a = s.players.find((p) => p.id === anya.me), m = s.players.find((p) => p.id === max.me);
      if (a.canBid && s.leaderId !== anya.me && s.price < 6) anya.send({ type: "bid", amount: s.price + 1, expectedPrice: s.price });
      if (m.canBid && s.leaderId !== max.me && s.price === 0) max.send({ type: "bid", amount: Math.min(m.money, 7), expectedPrice: 0 });
    }
    if (s.phase === "pickup") { const m = s.players.find((p) => p.id === max.me); if (m.canTake) max.send({ type: "take" }); }
    if (host.events.some((e) => e.type === "taken")) sawTaken = true;
    await wait(250);
  }
  const s = host.state;
  if (s.phase !== "finished") fail("game did not finish in time, phase=" + s.phase);
  log("finished:", s.finishedReason, "lots:", s.players.map((p) => `${p.name}=${p.lots.length}/$${p.money}`).join(" "));
  log("pickup seen:", sawPickup, "free take:", sawTaken);
  const sold = host.events.filter((e) => e.type === "sold").length;
  if (!sold) fail("nothing sold");

  // судейство: ChatGPT или голосование
  const t0 = Date.now();
  while (!host.state.results && Date.now() - t0 < 120000) {
    if (host.state.voting) { anya.send({ type: "vote", for: max.me }); max.send({ type: "vote", for: anya.me }); }
    await wait(500);
  }
  if (!host.state.results) fail("no results");
  const r = host.state.results;
  log("results mode:", r.mode);
  for (const x of r.ranking) log(" ", s.players.find((p) => p.id === x.playerId).name, x.score, x.verdict ? "— " + x.verdict.slice(0, 80) : "");
  if (r.summary) log(" summary:", r.summary.slice(0, 120));
  if (r.mode === "chatgpt" && r.ranking.some((x) => !x.verdict)) fail("empty verdict");

  // реконнект по токену после финала
  const again = await connect(room.code, { type: "join", name: "", token: anya.token });
  if (again.me !== anya.me) fail("reconnect by token failed");
  log("reconnect ✓");
  console.log("E2E OK");
  process.exit(0);
})().catch((e) => fail(e.message));
