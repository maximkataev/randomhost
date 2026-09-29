"use strict";
/*
 * Сетевой бот «Царя льдины»: подключается к комнате как обычный игрок и играет логикой bots.js
 * по снимкам с сервера. Нужен для test-server.js, нагрузочного стенда и игры агентами (play.js).
 *
 *   const b = await NetBot.connect({ base: "http://localhost:3700", code, name, style, hostToken });
 *   b.send({ type: "start" }); await b.until((b) => b.phase === "over", 90000); b.close();
 */
const WebSocket = require("ws");
const { createGame, generateFloe, DEFAULTS } = require("./game");
const Bots = require("./bots");

function connect({ base, code, name, style = "aggressor", hostToken, token, ci, think = true, latency = 0 }) {
  return new Promise((resolve, reject) => {
    const wsUrl = base.replace(/^http/, "ws") + "/floe/ws?r=" + encodeURIComponent(code);
    const ws = new WebSocket(wsUrl);
    // зеркало: свой экземпляр движка, в который подставляем льдину и пингвинов из снимков — боту нужны edgeInfo и shardAt
    const mirror = createGame({ seed: 1 });
    const bot = Bots.createBot(style);
    const b = {
      ws, id: null, token: token || null, phase: null, snap: null, roster: null, events: [], replay: null, hostId: null,
      errors: [], cfg: null, seq: 0, closed: false, sent: 0, recv: 0, bytes: 0, think,
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
    let floeKey = "";
    const deliver = (fn) => (latency ? setTimeout(fn, latency / 2) : fn());
    ws.on("open", () => b.send({ type: "join", name, token: b.token, hostToken, ci }));
    ws.on("error", (e) => { b.errors.push(e.message); reject(e); });
    ws.on("close", () => { b.closed = true; clearInterval(b.timer); });
    ws.on("message", (raw) => deliver(() => {
      b.recv++; b.bytes += raw.length;
      const m = JSON.parse(raw);
      if (m.type === "hello") b.cfg = m.cfg;
      else if (m.type === "joined") { b.id = m.playerId; b.token = m.token; resolve(b); }
      else if (m.type === "roster") { b.roster = m.players; b.hostId = m.hostId; }
      else if (m.type === "ev") b.events.push(...m.list);
      else if (m.type === "replay") b.replay = m;
      else if (m.type === "error") { b.errors.push(m.error); if (!b.id) reject(new Error(m.error)); }
      else if (m.type === "s") {
        b.snap = m; b.phase = m.ph;
        const key = m.sd + ":" + m.R;
        if (key !== floeKey) {
          floeKey = key;
          mirror.floe = generateFloe(m.sd, m.R);
          mirror.shardSt = mirror.floe.shards.map(() => ({ st: "s", t: 0, dur: 1 }));
          mirror.rimDirty = true;
        }
        if (m.sh) {
          m.sh.split(",").forEach((v, i) => { if (mirror.shardSt[i]) mirror.shardSt[i].st = v[0]; });
          mirror.rimDirty = true;
        }
        mirror.phase = m.ph;
        mirror.players = m.p.map(([id, x, y, vx, vy, dir, st, dash, cd]) => ({
          id, x, y, vx, vy, dir, st, inGame: m.ph !== "lobby", dashT: dash ? DEFAULTS.DASH_T : 0, cd: cd * DEFAULTS.DASH_CD,
        }));
        mirror.byId = new Map(mirror.players.map((p) => [p.id, p]));
      }
    }));
    // думаем и шлём ввод 20 раз в секунду
    b.timer = setInterval(() => {
      if (!b.think || !b.id || !b.snap || ws.readyState !== 1) return;
      const me = mirror.byId && mirror.byId.get(b.id);
      if (!me) return;
      Bots.think(mirror, me, bot, 0.05);
      b.send({ type: "i", mx: +bot.mx.toFixed(3), my: +bot.my.toFixed(3), d: bot.dash ? 1 : 0, s: ++b.seq });
    }, 50);
  });
}

async function createRoom(base) {
  const r = await fetch(base + "/floe/api/rooms", { method: "POST" });
  if (!r.ok) throw new Error("rooms " + r.status);
  return r.json();
}

module.exports = { connect, createRoom };
