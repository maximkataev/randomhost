"use strict";
/*
 * Сетевой бот «Лягушек»: подключается к комнате как обычный игрок и играет логикой bots.js по модели мира (model.js).
 * Нужен для test-server.js, стенда плохой сети (§7.7) и игры агентами. Умеет эмулировать сеть: задержку, джиттер,
 * разрыв, переподключение по токену — порядок сообщений сохраняется, как в TCP.
 *
 *   const b = await NetBot.connect({ base: "http://localhost:4200", code, name, style, hostToken, net: { latency: 300, jitter: 100 } });
 *   b.send({ type: "start" }); await b.until((b) => b.model.phase === "over", 90000); b.close();
 */
const WebSocket = require("ws");
const { createModel } = require("./model");
const Bots = require("./bots");

const T0 = process.hrtime.bigint();
const nowSec = () => Number(process.hrtime.bigint() - T0) / 1e9;

function connect({ base, code, name, style = "jumpy", hostToken, token, ci, think = true, net = {}, autoReconnect = false }) {
  return new Promise((resolve, reject) => {
    const wsUrl = base.replace(/^http/, "ws") + "/pond/ws?r=" + encodeURIComponent(code);
    const model = createModel();
    const bot = Bots.createBot(style, Math.floor(Math.random() * 1e9));
    const b = {
      ws: null, model, net: Object.assign({ latency: 0, jitter: 0 }, net), id: null, token: token || null, hostId: null, roster: null,
      events: [], errors: [], seq: 0, pending: new Map(), closed: false, sent: 0, recv: 0, bytes: 0, think, resumes: 0, reconnects: 0,
      acks: 0, resends: 0, predicted: 0, rejected: 0, hello: null, lastMsgAt: nowSec(), _resolved: false,
      send(m) { out(m); },
      close() { b.closed = true; b.stopped = true; clearInterval(b.timer); clearInterval(b.pinger); try { b.ws.close(); } catch {} },
      // обрыв сети без прощания: клиент не закрывал вкладку
      cut() { try { b.ws.terminate(); } catch {} },
      until(pred, ms = 30000) {
        return new Promise((res, rej) => {
          const t0 = Date.now();
          const h = setInterval(() => {
            if (pred(b)) { clearInterval(h); res(b); }
            else if (Date.now() - t0 > ms) { clearInterval(h); rej(new Error(`${name}: не дождались за ${ms} мс (фаза ${b.model.phase})`)); }
          }, 20);
        });
      },
    };
    // очереди с задержкой: сообщения идут по одному, в порядке отправки (как TCP)
    let outTail = 0, inTail = 0;
    const delay = () => Math.max(0, (b.net.latency / 2 + (Math.random() * 2 - 1) * (b.net.jitter / 2))) / 1000;
    function out(m) {
      const ws = b.ws;
      if (!ws) return;
      const at = Math.max(outTail, nowSec() + delay());
      outTail = at;
      const go = () => { if (ws.readyState === 1) { ws.send(JSON.stringify(m)); b.sent++; } };
      if (at - nowSec() < 0.001) go(); else setTimeout(go, (at - nowSec()) * 1000);
    }
    function deliver(raw) {
      const at = Math.max(inTail, nowSec() + delay());
      inTail = at;
      const go = () => onMsg(raw);
      if (at - nowSec() < 0.001) go(); else setTimeout(go, (at - nowSec()) * 1000);
    }
    const dead = (ws) => ws !== b.ws;

    function onMsg(raw) {
      b.recv++; b.bytes += raw.length;
      b.lastMsgAt = nowSec();
      const m = JSON.parse(raw);
      model.feed(m, nowSec());
      if (m.type === "hello") b.hello = m;
      else if (m.type === "joined") {
        b.id = m.playerId; b.token = m.token; if (m.resumed) b.resumes++;
        if (!b._resolved) { b._resolved = true; resolve(b); }
      } else if (m.type === "roster") { b.roster = m.players; b.hostId = m.hostId; }
      else if (m.type === "ev") b.events.push(...m.list);
      else if (m.type === "error") { b.errors.push(m.error); if (!b.id && !b._resolved && !autoReconnect) { b._resolved = true; reject(new Error(m.error)); } }
      else if (m.type === "hb") out({ type: "hbr", c: m.c });
      else if (m.type === "pong") {
        const rtt = nowSec() - m.cs;
        if (rtt >= 0 && rtt < 5 && m.cs != null) model.sync(m.gt, rtt, nowSec());
      } else if (m.type === "ack") { b.acks++; b.pending.delete(m.s); if (m.ok === false) b.rejected++; }
    }

    // pong не знает наше время отправки: храним по номеру
    const pingSent = new Map();
    const origOnMsg = onMsg;
    onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "pong") { m.cs = pingSent.get(m.c); pingSent.delete(m.c); raw = JSON.stringify(m); }
      origOnMsg(raw);
    };

    function open() {
      const ws = new WebSocket(wsUrl);
      b.ws = ws; outTail = 0; inTail = 0;
      ws.on("open", () => {
        out({ type: "join", name, token: b.token, hostToken, ci });
        sendPing();
      });
      ws.on("error", (e) => { b.errors.push(e.message); if (!b._resolved && !autoReconnect) { b._resolved = true; reject(e); } });
      ws.on("close", () => {
        if (dead(ws)) return;
        if (b.stopped) { b.closed = true; return; }
        if (autoReconnect) { b.reconnects++; setTimeout(() => { if (!b.stopped) open(); }, 300 + Math.random() * 300); }
        else b.closed = true;
      });
      ws.on("message", (raw) => { if (!dead(ws)) deliver(raw.toString()); });
    }
    let pingN = 0;
    function sendPing() { const c = ++pingN; pingSent.set(c, nowSec()); out({ type: "ping", c }); }
    b.pinger = setInterval(() => { if (b.ws && b.ws.readyState === 1) sendPing(); }, 2000);

    // думаем 20 раз в секунду; неподтверждённый прыжок повторяем (тот же номер — сервер дубль не исполнит)
    b.timer = setInterval(() => {
      if (!b.id || !b.ws || b.ws.readyState !== 1) return;
      const t = model.now(nowSec());
      model.advance(t - model.delay);
      for (const [s, p] of b.pending) {
        if (nowSec() - p.at > Math.max(0.3, (model.clock.rtt === Infinity ? 0 : model.clock.rtt) * 1.5 + 0.1) && p.n < 3) { p.n++; p.at = nowSec(); b.resends++; out(p.msg); }
        else if (p.n >= 3 && nowSec() - p.at > 1) b.pending.delete(s);
      }
      if (!think) return;
      // решения — по самой свежей картине (без задержки отрисовки)
      model.advance(t);
      const me = model.frogs.get(b.id);
      if (!me) return;
      const move = Bots.think(model.view(t), me, bot, 0.05);
      if (!move) return;
      const s = ++b.seq;
      const msg = { type: "j", a: Math.round(move.ang * 1000) / 1000, p: Math.round(move.pow * 1000) / 1000, s };
      if (model.predict(msg.a, msg.p, s, t)) b.predicted++;
      b.pending.set(s, { msg, at: nowSec(), n: 0 });
      out(msg);
    }, 50);

    open();
  });
}

async function createRoom(base) {
  const r = await fetch(base + "/pond/api/rooms", { method: "POST" });
  if (!r.ok) throw new Error("rooms " + r.status);
  return r.json();
}

module.exports = { connect, createRoom, nowSec };
