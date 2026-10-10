/* Общий код «Как все» для пульта (crowd.html) и доски (crowd-board.html):
   транспорт до сервера, часы сервера, звуки, мелкие помощники.
   Транспорт и часы перенесены из crowd-shared.js (а туда — из fibs-shared.js, bomb, roulette, auction): там подробная история решений. */


// iOS 12–13 не знает replaceChildren
(function () {
  function replaceChildren() {
    while (this.lastChild) this.removeChild(this.lastChild);
    if (arguments.length) this.append.apply(this, arguments);
  }
  [window.Element, window.Document, window.DocumentFragment].forEach(function (C) {
    if (C && C.prototype && !C.prototype.replaceChildren) C.prototype.replaceChildren = replaceChildren;
  });
})();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- подписи, общие для доски и пульта ----------
// Страница кладёт свой словарь в I18N_DICT, эти ключи домешиваются туда до загрузки i18n.js.

// Если i18n.js не доехал (блокировщик) — работаем по-русски, а не белым экраном
function wvT(key) {
  if (window.I18N && window.I18N.t) return window.I18N.t(key);
  const d = (window.I18N_DICT || {}).ru || {};
  return key in d ? d[key] : key;
}
const wvTpl = (key, vars) => String(wvT(key)).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const wvLang = () => (window.I18N && window.I18N.lang) || "ru";
const wvSec = (ms) => String(Math.round(Math.max(0, ms) / 100) / 10).replace(".", wvLang() === "en" ? "." : ",");
// имена через запятую — именительный падеж, не склоняем
const wvNames = (ids, player) => ids.map((id) => (player(id) || {}).name || "?").join(", ");


// ---------- звуки: короткий синтез без файлов ----------
// Всё идёт в ctx.destination — sound-toggle.js перехватывает это подключение и глушит общий выключатель.
const wvSfx = (function () {
  let ctx = null, noise = null;
  function ac() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume().catch(() => {}); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  ["pointerdown", "keydown"].forEach((t) => window.addEventListener(t, () => ac(), { passive: true, capture: true }));
  function env(g, t, a, d, v) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function tone(f0, f1, at, dur, type, vol) {
    const c = ac(); if (!c || c.state !== "running") return;
    const t = c.currentTime + at;
    const o = c.createOscillator(); o.type = type || "sine";
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); o.connect(g); g.connect(c.destination); env(g, t, 0.004, dur, vol);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function hiss(at, dur, vol, type, f, q, attack) {
    const c = ac(); if (!c || c.state !== "running" || !noise) return;
    const t = c.currentTime + at;
    const s = c.createBufferSource(); s.buffer = noise;
    const fl = c.createBiquadFilter(); fl.type = type || "bandpass"; fl.frequency.value = f || 2500; fl.Q.value = q || 1.2;
    const g = c.createGain(); s.connect(fl); fl.connect(g); g.connect(c.destination); env(g, t, attack || 0.002, dur, vol);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  return {
    // тиканье последних секунд голосования
    tick(hot) { tone(hot ? 1500 : 1200, hot ? 1400 : 1100, 0, 0.03, "square", hot ? 0.06 : 0.035); },
    tap() { tone(700, 900, 0, 0.03, "triangle", 0.08); },
    // «Готово»: тяжёлый щелчок замка
    lock() { tone(180, 90, 0, 0.09, "square", 0.16); hiss(0, 0.05, 0.3, "highpass", 4000, 0.7, 0.001); },
    // ва-банк включён
    bank() { tone(330, 660, 0, 0.1, "sawtooth", 0.08); tone(660, 990, 0.08, 0.12, "sawtooth", 0.08); },
    // скрип каната: низкий дрожащий шорох; k — натяжение 0..1
    creak(k) { hiss(0, 0.28, 0.1 + 0.12 * (k || 0), "bandpass", 260 + 120 * (k || 0), 4, 0.04); tone(95, 80, 0, 0.25, "sawtooth", 0.03); },
    // игрок встал на свою сторону каната
    step() { tone(150, 100, 0, 0.06, "triangle", 0.1); hiss(0, 0.04, 0.12, "lowpass", 600, 0.7, 0.002); },
    // решающий голос и итог раскрытия
    thud() { tone(120, 50, 0, 0.3, "sine", 0.45); hiss(0, 0.12, 0.2, "lowpass", 500, 0.7, 0.002); },
    // меньшинство в луже
    splash() { hiss(0, 0.5, 0.28, "bandpass", 900, 0.8, 0.02); tone(260, 120, 0, 0.35, "sine", 0.12); },
    // «Раскол»: канат трещит
    strain() { hiss(0, 0.8, 0.14, "bandpass", 300, 5, 0.1); tone(70, 64, 0, 0.8, "sawtooth", 0.05); },
    // «Иллюзия!»
    pop() { tone(300, 900, 0, 0.14, "triangle", 0.2); tone(900, 450, 0.12, 0.24, "triangle", 0.14); hiss(0.1, 0.25, 0.15, "highpass", 5000, 0.7, 0.01); },
    // «Как один!»
    chord() { [392, 494, 587, 784].forEach((f, i) => tone(f, f, i * 0.04, 0.5, "triangle", 0.12)); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, f, i * 0.07, 0.2, "triangle", 0.16)); },
    womp() { tone(330, 300, 0, 0.2, "sawtooth", 0.1); tone(250, 170, 0.22, 0.45, "sawtooth", 0.12); },
    fanfare() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, f, i * 0.1, 0.18, "triangle", 0.16)); },
    buzz() { tone(140, 120, 0, 0.22, "sawtooth", 0.12); },
  };
})();

// ---------- место под переключатель языка ----------
// i18n.js ставит его fixed в правый верхний угол, а ширина у него своя на каждом экране и языке.
// Меряем: --lsw — отступ от правого края до его левой кромки, --lsc/--lsh — его центр и высота.
(function reserveLangSwitch() {
  let seen = null;
  const measure = () => {
    const sw = document.querySelector(".lang-switch");
    if (!sw) return false;
    const r = sw.getBoundingClientRect();
    if (r.width) {
      const root = document.documentElement.style;
      root.setProperty("--lsw", Math.ceil(window.innerWidth - r.left + 10) + "px");
      root.setProperty("--lsc", Math.round(r.top + r.height / 2) + "px");
      root.setProperty("--lsh", Math.round(r.height) + "px");
    }
    if (sw !== seen && window.ResizeObserver) { seen = sw; new ResizeObserver(measure).observe(sw); }
    return true;
  };
  const poll = (n) => { if (!measure() && n < 200) requestAnimationFrame(() => poll(n + 1)); };
  poll(0);
  window.addEventListener("resize", measure);
  window.addEventListener("langchange", () => requestAnimationFrame(measure));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
})();

// ---------- вибрация: не везде есть, а где есть — может бросить исключение ----------
function wvVibrate(p) { if (navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} }

// ---------- часы сервера ----------
// Смещение «сервер − устройство» по самому быстрому ping/pong (RTT/2); пока замера нет —
// по state (у него задержка только прибавляется, поэтому берём наибольший из недавних).
const wvClock = { offset: null, rtt: Infinity, at: 0, states: [] };
function wvClockSample(serverT, sentAt) {
  const t = Date.now(), rtt = t - sentAt;
  if (!(rtt >= 0) || typeof serverT !== "number") return;
  if (rtt <= wvClock.rtt || t - wvClock.at > 60000) {
    wvClock.rtt = rtt;
    wvClock.offset = serverT + rtt / 2 - t;
    wvClock.at = t;
  }
}
function wvStateSample(serverNow) {
  if (typeof serverNow !== "number") return;
  wvClock.states.push(serverNow - Date.now());
  if (wvClock.states.length > 12) wvClock.states.shift();
}
function wvOffset() {
  const byState = wvClock.states.length ? Math.max.apply(null, wvClock.states) : 0;
  return wvClock.offset != null ? Math.max(wvClock.offset, byState) : byState;
}
const wvNow = () => Date.now() + wvOffset();

// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------

let wvWsBroken = false;
const BM_WS_HANDSHAKE_MS = 5000;
const BM_POLL_FETCH_MS = 28000;
const BM_PROBE_MS = 3000;

function wvOpenTransport({ code, onMessage, onClose, onOpen, onSendFail, onGone }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let closed = false, opened = false, sid = null, ws = null, polling = false, pollAbort = null;
  let lastSeen = 0, beat = null, notified = false, probeTimer = null;
  const stopBeat = () => { if (beat) { clearInterval(beat); beat = null; } clearTimeout(probeTimer); probeTimer = null; };
  const fireClose = () => {
    if (closed || notified) return;
    notified = true;
    stopBeat();
    closed = true;
    try { if (ws) ws.close(); } catch (e) {}
    try { if (pollAbort) pollAbort.abort(); } catch (e) {}
    sid = null;
    if (onClose) onClose();
  };
  const ping = () => api.send({ type: "ping", c: Date.now() });
  const deliver = (m) => {
    if (closed) return;
    lastSeen = Date.now();
    if (m && m.type === "pong") { if (typeof m.c === "number") wvClockSample(m.t, m.c); return; }
    if (m && (m.type === "state" || m.type === "hello") && m.state) wvStateSample(m.state.serverNow);
    onMessage(m);
  };
  const startBeat = () => {
    stopBeat();
    lastSeen = Date.now();
    ping(); setTimeout(ping, 400); setTimeout(ping, 1500);
    beat = setInterval(() => {
      if (closed) return stopBeat();
      if (Date.now() - lastSeen > 45000) { fireClose(); return; }
      ping();
    }, 20000);
  };
  const api = {
    send(msg, attempt) {
      if (closed) { if (onSendFail && msg && msg.type !== "ping") onSendFail(msg); return; }
      if (ws && ws.readyState === 1) return ws.send(JSON.stringify(msg));
      if (!sid) { if (onSendFail && msg && msg.type !== "ping") onSendFail(msg); return; }
      const tries = attempt || 0;
      fetch("/crowd/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
        .then((r) => {
          if (r.ok || r.status === 410) return;
          if (tries < 2) setTimeout(() => api.send(msg, tries + 1), 400 * (tries + 1));
          else if (onSendFail) onSendFail(msg);
        })
        .catch(() => {
          if (tries < 2) setTimeout(() => api.send(msg, tries + 1), 400 * (tries + 1));
          else if (onSendFail) onSendFail(msg);
        });
    },
    close() { closed = true; stopBeat(); try { if (ws) ws.close(); } catch (e) {} try { if (pollAbort) pollAbort.abort(); } catch (e) {} sid = null; },
    probe(ms) {
      if (closed || !opened) return;
      clearTimeout(probeTimer);
      const asked = Date.now();
      ping();
      probeTimer = setTimeout(() => { if (!closed && lastSeen < asked) fireClose(); }, ms || BM_PROBE_MS);
    },
    get mode() {
      if (closed) return "none";
      if (ws && ws.readyState === 1) return "ws";
      if (ws && ws.readyState === 0) return "connecting";
      if (sid) return "poll";
      if (polling) return "connecting";
      return "none";
    },
  };
  const timedFetch = (url, ms) => {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    pollAbort = ctl;
    const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).finally(() => clearTimeout(t));
  };
  async function startPolling() {
    if (closed || polling) return;
    polling = true;
    try {
      const res = await timedFetch(`/crowd/api/session?r=${encodeURIComponent(code)}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/crowd/api/poll?sid=${sid}`, BM_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (wvWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/crowd/ws?r=${encodeURIComponent(code)}`);
    const handshake = setTimeout(() => {
      if (closed || opened || !ws || ws.readyState !== 0) return;
      wvWsBroken = true;
      const dead = ws; ws = null;
      dead.onclose = dead.onmessage = dead.onopen = null;
      try { dead.close(); } catch (e) {}
      startPolling();
    }, BM_WS_HANDSHAKE_MS);
    ws.onopen = () => { clearTimeout(handshake); opened = true; startBeat(); if (onOpen) onOpen(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } deliver(m); };
    ws.onclose = (e) => {
      clearTimeout(handshake);
      if (closed) return;
      // комнаты нет (404 на рукопожатии не видно из браузера) — это выяснит опрос сессии
      if (!opened) { ws = null; startPolling(); }
      else fireClose();
    };
    ws.onerror = () => {};
  } catch (e) { startPolling(); }
  return api;
}

// Переподключение с нарастающей паузой: сеть моргнула — вернуться сразу, сервер лежит — не долбить
function wvConnect({ code, onMessage, onOpen, onGone, onState }) {
  let t = null, delay = 500, stopped = false;
  const holder = { api: null, send: (m) => holder.api && holder.api.send(m), stop() { stopped = true; clearTimeout(t); if (holder.api) holder.api.close(); } };
  const open = () => {
    if (stopped) return;
    if (onState) onState("connecting");
    holder.api = wvOpenTransport({
      code,
      onMessage,
      onOpen: () => { delay = 500; if (onState) onState("open"); if (onOpen) onOpen(); },
      onClose: () => { if (stopped) return; if (onState) onState("lost"); t = setTimeout(open, delay); delay = Math.min(delay * 2, 8000); },
      onGone: () => { stopped = true; if (onGone) onGone(); },
    });
  };
  open();
  // вернулись в вкладку или сеть появилась — проверяем, жив ли сокет, не дожидаясь 45 с тишины
  const wake = () => { if (holder.api && holder.api.mode !== "none") holder.api.probe(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  window.addEventListener("online", wake);
  return holder;
}



// место в таблице: равные очки — равное место (1, 2, 2, 4)
const wvRank = (list, p) => 1 + list.filter((x) => x.score > p.score).length;
