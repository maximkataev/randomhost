"use strict";

/*
 * Утилита для разработки: создаёт комнату на локальном сервере (NODE_ENV=development),
 * добавляет ботов, по желанию стартует игру и печатает ссылки на доску и пульт.
 *   node dev-game.js            → комната в лобби с 3 ботами
 *   node dev-game.js start      → сразу стартует партию
 *   node dev-game.js start film → категория film
 * Требует запущенный сервер: npm run dev
 */

const WebSocket = require("ws");
const BASE = process.env.BASE || "http://localhost:3000";
const start = process.argv.includes("start");
const kind = process.argv.find((a) => /^[a-z]+$/.test(a) && a !== "start") || "artist";

(async () => {
  const res = await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
  const room = await res.json();
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/auction/ws?r=" + room.code);
  ws.on("open", () => ws.send(JSON.stringify({ type: "host", token: room.hostToken })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "host_ok") {
      ws.send(JSON.stringify({ type: "bots", n: 3 }));
      setTimeout(() => {
        if (start) ws.send(JSON.stringify({ type: "start" }));
        console.log(`Комната ${room.code} (${kind})${start ? ", игра идёт" : ", лобби с ботами"}`);
        console.log(`Доска:  ${BASE}/auction-board.html?r=${room.code}&t=${room.hostToken}`);
        console.log(`Пульт:  ${BASE}/auction.html?r=${room.code}&name=Макс`);
        setTimeout(() => process.exit(0), 300);
      }, 400);
    }
  });
})();
