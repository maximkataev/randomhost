"use strict";
/*
 * Сетевой бот «Утиного сплава»: подключается к комнате как обычный игрок и рулит логикой bots.js
 * по снимкам с сервера. Нужен для test-server.js, нагрузочного стенда и игры агентами (play.js).
 *
 *   const b = await NetBot.connect({ base: "http://localhost:3800", code, name, style, hostToken });
 *   b.send({ type: "start" }); await b.until((b) => b.phase === "over", 90000); b.close();
 */
const WebSocket = require("ws");
const { makeCourse, DEFAULTS } = require("./game");
const Bots = require("./bots");

function connect({ base, code, name, style = "casual", hostToken, token, ci, think = true, latency = 0 }) {
  return new Promise((resolve, reject) => {
    const wsUrl = base.replace(/^http/, "ws") + "/rapids/ws?r=" + encodeURIComponent(code);
    const ws = new WebSocket(wsUrl);
    // зеркало для логики бота: та же река по сиду и утки из снимка
    const mirror = { cfg: Object.assign({}, DEFAULTS), course: null, players: [], byId: new Map(), time: 0, phase: null };
    const bot = Bots.createBot(style);
    const b = {
      ws, id: null, token: token || null, phase: null, snap: null, roster: null, events: [], hostId: null,
      errors: [], cfg: null, seq: 0, closed: false, sent: 0, recv: 0, bytes: 0, think, steer: 0,
      send(m) { if (ws.readyState === 1) { ws.send(JSON.stringify(m)); b.sent++; } },
      close() { b.closed = true; clearInterval(b.timer); try { ws.close(); } catch {} },
      until(pred, ms = 30000) {
        return new Promise((res, rej) => {
          const t0 = Date.now();
          const h = setInterval(() => {
            if (pred(b)) { clearInterval(h); res(b); }
            else if (Date.now() - t0 > ms) { clearInterval(h); rej(new Error(`${name}: не дождались за ${ms} мс (фаза ${b.phase})`)); }
          }, 20);
        });
      },
    };
    let seed = null;
    const deliver = (fn) => (latency ? setTimeout(fn, latency / 2) : fn());
    ws.on("open", () => b.send({ type: "join", name, token: b.token, hostToken, ci }));
    ws.on("error", (e) => { b.errors.push(e.message); reject(e); });
    ws.on("close", () => { b.closed = true; clearInterval(b.timer); });
    ws.on("message", (raw) => deliver(() => {
      b.recv++; b.bytes += raw.length;
      const m = JSON.parse(raw);
      if (m.type === "hello") { b.cfg = m.cfg; Object.assign(mirror.cfg, m.cfg); }
      else if (m.type === "joined") { b.id = m.playerId; b.token = m.token; resolve(b); }
      else if (m.type === "roster") { b.roster = m.players; b.hostId = m.hostId; }
      else if (m.type === "ev") b.events.push(...m.list);
      else if (m.type === "error") { b.errors.push(m.error); if (!b.id) reject(new Error(m.error)); }
      else if (m.type === "s") {
        b.snap = m; b.phase = m.ph;
        if (m.sd !== seed) { seed = m.sd; mirror.course = makeCourse(m.sd, mirror.cfg); }
        mirror.phase = m.ph;
        mirror.time = m.t / 1000;
        mirror.players = m.p.map(([id, x, y, vx, vy, ang, st]) => ({ id, x, y, vx, vy, ang, st, inGame: true }));
        mirror.byId = new Map(mirror.players.map((p) => [p.id, p]));
      }
    }));
    // думаем и шлём руль 20 раз в секунду
    b.timer = setInterval(() => {
      if (!b.think || !b.id || !b.snap || !mirror.course || ws.readyState !== 1) return;
      const me = mirror.byId.get(b.id);
      if (!me) return;
      const st = Bots.think(mirror, me, bot, 0.05);
      b.steer = +st.toFixed(2);
      b.send({ type: "i", st: b.steer, s: ++b.seq });
    }, 50);
  });
}

async function createRoom(base) {
  const r = await fetch(base + "/rapids/api/rooms", { method: "POST" });
  if (!r.ok) throw new Error("rooms " + r.status);
  return r.json();
}

module.exports = { connect, createRoom };
