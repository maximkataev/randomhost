"use strict";
/*
 * ws-kit — клиент-игрок / клиент-ведущий (доска) по WS игры и сбор кадров (T-W0-03).
 * Без новых зависимостей: `ws` берётся из <игра>/node_modules (createRequire), запасной вариант —
 * встроенный WebSocket Node 22. Запускать из корня репозитория.
 *
 *   const kit = require("./tools/testkit/ws-kit");
 *   const room = await kit.createRoom("http://127.0.0.1:4100", "bomb");      // { code, hostToken }
 *   const host = await kit.host("http://127.0.0.1:4100", "bomb", room);      // доска
 *   const p    = await kit.join("http://127.0.0.1:4100", "bomb", room, "Аня");
 *   host.send({ type: "settings", ... });  await p.waitFor("state", 3000);
 *   kit.scan(p.frames, { forbiddenKeys: ["fuseMs"] });                       // → scanFrames
 *   await kit.closeAll(host, p);
 *
 * Клиент: { frames:[{t,view,frame}], hello, playerId, token, hostOk, closed,
 *           send(obj), waitFor(typeOrPred, ms), collect(ms), drop(), close() }
 * Виды (view): "board" — у host/floe-ведущего, "player" — у join, "anon" — сокет без роли (rawSocket).
 * Нет «host»-сообщения у floe/rapids: ведущий — игрок, вошедший с hostToken (join {hostToken}).
 */
const path = require("path");
const { createRequire } = require("module");
const { scanFrames } = require("./scan");

const REPO = path.resolve(__dirname, "..", "..");
const GAMES = ["auction", "roulette", "bomb", "quip", "fibs", "wave", "floe", "lastq", "crowd", "rapids"];

// описание игр: порт по умолчанию (server.js), тело создания комнаты, роль ведущего
const GAME_INFO = {
  auction: { port: 3000, createBody: { kind: "animal", settings: { intro: 0 } }, hostMsg: true },
  roulette: { port: 3100, createBody: {}, hostMsg: true },
  bomb: { port: 3300, createBody: {}, hostMsg: true },
  quip: { port: 3400, createBody: {}, hostMsg: true },
  fibs: { port: 3500, createBody: {}, hostMsg: true },
  wave: { port: 3600, createBody: {}, hostMsg: true },
  floe: { port: 3700, createBody: null, hostMsg: false },
  lastq: { port: 3800, createBody: {}, hostMsg: true },
  crowd: { port: 3900, createBody: {}, hostMsg: true },
  rapids: { port: 3800, createBody: null, hostMsg: false },
};

let wsCtor = null;
function loadWs(game) {
  if (wsCtor) return wsCtor;
  const dirs = [game, ...GAMES].filter(Boolean);
  for (const g of dirs) {
    try { wsCtor = createRequire(path.join(REPO, g, "package.json"))("ws"); return wsCtor; } catch {}
  }
  if (typeof WebSocket === "function") { wsCtor = WebSocket; return wsCtor; } // встроенный Node 22
  throw new Error("нет модуля ws: выполните npm ci в <игра>/ или симлинк node_modules");
}

const trimBase = (b) => String(b).replace(/\/+$/, "");
const wsUrl = (base, game, code) => trimBase(base).replace(/^http/, "ws") + "/" + game + "/ws" + (code ? "?r=" + encodeURIComponent(code) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthOf(base, game) {
  const r = await fetch(trimBase(base) + "/" + game + "/api/health");
  if (!r.ok) throw new Error(game + " health HTTP " + r.status);
  return r.json();
}

async function createRoom(base, game, body) {
  const info = GAME_INFO[game];
  if (!info) throw new Error("неизвестная игра: " + game);
  const payload = body !== undefined ? body : info.createBody;
  const init = { method: "POST", headers: { "Content-Type": "application/json" } };
  if (payload !== null) init.body = JSON.stringify(payload);
  const r = await fetch(trimBase(base) + "/" + game + "/api/rooms", init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.code) throw new Error(game + ": комната не создана (HTTP " + r.status + " " + JSON.stringify(j) + ")");
  return j; // { code, hostToken }
}

/** Низкоуровневый сокет: без join/host — для проверок «аноним», отказов, мёртвых токенов. */
function rawSocket(base, game, code, opts) {
  opts = opts || {};
  const WS = loadWs(game);
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl(base, game, code));
    const c = {
      ws, game, code, view: opts.view || "anon", frames: [], hello: null, playerId: null, token: null,
      hostOk: false, closed: false, closeCode: null, waiters: [],
      send(obj) { ws.send(typeof obj === "string" ? obj : JSON.stringify(obj)); },
      waitFor(pred, ms) { return waitFor(c, pred, ms); },
      async collect(ms) { const from = c.frames.length; await sleep(ms); return c.frames.slice(from); },
      drop() { try { ws.terminate ? ws.terminate() : ws.close(); } catch {} },
      close() { return new Promise((res) => { if (c.closed) return res(); c.waiters.push({ closing: res }); try { ws.close(); } catch { res(); } setTimeout(res, 1500); }); },
      messages() { return c.frames.map((f) => f.frame); },
    };
    const onMessage = (data) => {
      const text = typeof data === "string" ? data : data && data.data !== undefined ? String(data.data) : data.toString();
      let frame; try { frame = JSON.parse(text); } catch { frame = { type: "<non-json>", raw: text }; }
      const rec = { t: Date.now(), view: c.view, frame };
      c.frames.push(rec);
      if (frame.type === "hello") c.hello = frame;
      if (frame.type === "joined") { c.playerId = frame.playerId; c.token = frame.token; }
      if (frame.type === "host_ok") c.hostOk = true;
      c.waiters = c.waiters.filter((w) => { if (w.pred && w.pred(frame)) { w.res(frame); return false; } return true; });
    };
    const onClose = (ev) => {
      c.closed = true; c.closeCode = ev && ev.code != null ? ev.code : ev;
      c.waiters.forEach((w) => (w.closing ? w.closing() : w.rej && w.rej(new Error("сокет закрыт"))));
      c.waiters = [];
    };
    if (typeof ws.on === "function") { // пакет ws
      ws.on("open", () => resolve(c));
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", (e) => { if (!c.frames.length && !c.closed) reject(e); });
    } else { // встроенный WebSocket
      ws.onopen = () => resolve(c);
      ws.onmessage = onMessage;
      ws.onclose = onClose;
      ws.onerror = (e) => reject(new Error("ws error " + (e && e.message)));
    }
    setTimeout(() => reject(new Error("таймаут подключения к " + wsUrl(base, game, code))), opts.timeout || 5000);
  });
}

function waitFor(c, pred, ms) {
  const test = typeof pred === "string" ? (f) => f.type === pred : pred;
  for (const rec of c.frames) if (test(rec.frame)) return Promise.resolve(rec.frame);
  return new Promise((res, rej) => {
    if (c.closed) return rej(new Error("сокет закрыт"));
    const w = { pred: test, res: (f) => { clearTimeout(t); res(f); }, rej };
    const t = setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); rej(new Error("таймаут ожидания кадра " + (typeof pred === "string" ? pred : "pred") + " (" + (ms || 5000) + " мс)")); }, ms || 5000);
    c.waiters.push(w);
  });
}

/** Игрок: join {name}; ждёт joined (или error). Возвращает клиента; c.playerId/c.token заполнены. */
async function join(base, game, room, name, extra) {
  const c = await rawSocket(base, game, room.code || room, { view: "player" });
  c.send(Object.assign({ type: "join", name: name || "Игрок" }, extra || {}));
  const f = await c.waitFor((m) => m.type === "joined" || m.type === "error", 5000);
  if (f.type === "error") { c.joinError = f.error; }
  return c;
}

/** Ведущий (доска): host {token} → host_ok. У floe/rapids — join с hostToken (ведущий = игрок). */
async function host(base, game, room, extra) {
  const info = GAME_INFO[game] || {};
  const c = await rawSocket(base, game, room.code, { view: "board" });
  if (info.hostMsg === false) {
    c.send(Object.assign({ type: "join", name: "Ведущий", hostToken: room.hostToken }, extra || {}));
    await c.waitFor((m) => m.type === "joined" || m.type === "error", 5000);
  } else {
    c.send(Object.assign({ type: "host", token: room.hostToken }, extra || {}));
    await c.waitFor((m) => m.type === "host_ok" || m.type === "error", 5000);
  }
  return c;
}

/** Все кадры нескольких клиентов — для scanFrames (у каждого записи с view). */
const framesOf = (...clients) => clients.flat().flatMap((c) => c.frames);
const scan = (frames, opts) => scanFrames(frames, opts);
async function closeAll(...clients) { await Promise.all(clients.flat().filter(Boolean).map((c) => c.close())); }

module.exports = { GAMES, GAME_INFO, createRoom, rawSocket, join, host, healthOf, framesOf, scan, scanFrames, closeAll, wsUrl, sleep, waitFor, loadWs };
