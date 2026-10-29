"use strict";

/*
 * Ведущий-автомат для плейтестов без человека у доски:
 *   node autohost.js <base> <код> <hostToken> [партий=2] [мин.игроков=4]
 * Держит сокет доски, сам нажимает «Поехали», когда все в командах и людей достаточно, и после конца партии
 * запускает следующую (через 25 реальных секунд — чтобы игроки успели прочитать итоги), пока не сыграно нужное число.
 * Печатает хронику в stdout. Не заменяет настоящую доску: интерфейс ведущего им не проверяется.
 */

const WebSocket = require("ws");
const [base, code, token, gamesArg, minArg] = process.argv.slice(2);
const MAX = Number(gamesArg || 2), MIN = Number(minArg || 4);
const ws = new WebSocket(base.replace(/^http/, "ws") + "/callsign/ws?r=" + encodeURIComponent(code));
const t0 = Date.now();
const say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
let state = null, played = 0, startedGame = 0, timer = null;
const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
ws.on("open", () => send({ type: "host", token }));
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.type === "host_ok") say("доска признана ведущей");
  if (m.type === "rejected") say(`отказ ${m.action}: ${m.reason}`);
  if (m.type === "hello" || m.type === "state") { state = m.state; tick(); }
});
function tick() {
  const s = state;
  if (!s) return;
  const ps = s.players.filter((p) => !p.left);
  if (s.phase === "lobby" && startedGame === played && played < MAX) {
    if (ps.length >= MIN && ps.every((p) => p.team) && ps.filter((p) => p.team === "red").length >= 2 && ps.filter((p) => p.team === "blue").length >= 2 && !timer) {
      timer = setTimeout(() => { timer = null; startedGame++; say(`старт партии ${startedGame} (${ps.length} игроков)`); send({ type: "start" }); }, 4000);
    }
  }
  if (s.phase === "finished" && startedGame === played + 1) {
    played++;
    say(`партия ${played} окончена: ${s.winner || "без победителя"} (${s.finishedReason})`);
    if (played < MAX && !timer) timer = setTimeout(() => { timer = null; startedGame++; say(`старт партии ${startedGame}`); send({ type: "start" }); }, 25000);
    if (played >= MAX) setTimeout(() => process.exit(0), 60000);
  }
}
setTimeout(() => { say("лимит времени ведущего-автомата (90 мин)"); process.exit(0); }, 90 * 60000);
