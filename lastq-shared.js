/* Общий код «Последнего вопроса» для телефона (lastq.html) и доски (lastq-board.html):
   транспорт до сервера, часы сервера, подписи на трёх языках, звуки, мелкие помощники.
   Транспорт и часы перенесены из fibs-shared.js (а туда — из bomb/roulette/auction): там подробная история решений. */

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

// ---------- подписи, общие для доски и телефона ----------
// Страница кладёт свой словарь в I18N_DICT, эти ключи домешиваются туда до загрузки i18n.js.

const LQ_SHARED_I18N = {
  ru: {
    game_name: "Последний вопрос",
    act1: "Разогрев", act2: "Без страховки", act3: "Последний вопрос",
    act_n: "Акт {n}", act_final: "Финал",
    act1_d: "Верно — +100 и бонус за скорость. Ошибка — в Камеру. Не вышло выбраться — минус 100",
    act2_d: "Очки вдвое больше, а отлёт — минус 250. Ошибка теперь дорогая",
    act3_d: "Один трудный вопрос. Сначала ставишь очки, потом отвечаешь",
    q_of: "Вопрос {i} из {n}",
    t_animals: "Животные", t_food: "Еда", t_geo: "География", t_body: "Тело человека", t_science: "Наука и техника",
    t_screen: "Кино и сериалы", t_weird: "Странное", t_space_nature: "Космос и природа",
    g_hands: "Ловкость", g_eyes: "Внимание", g_head: "Голова",
    g_hands_d: "провода, отмычка, подкоп", g_eyes_d: "найди, запомни, опознай", g_head_d: "задачки и вопросы на скорость",
    pts: "+{n}", minus: "−{n}",
    escaped: "Свобода!", burned: "Отлёт",
    aw_unkillable: "Неубиваемый", aw_unkillable_d: "спасений из Камеры: {n}",
    aw_regular: "Постоялец", aw_regular_d: "в Камере: {n}",
    aw_rocket: "Ракета", aw_rocket_d: "верный ответ в среднем за {s} с",
    aw_kamikaze: "Камикадзе", aw_kamikaze_d: "ставка {n}",
    aw_seer: "Провидец", aw_seer_d: "угаданных ставок: {n}",
    aw_bottom: "Дно", aw_bottom_d: "дно: {n}",
    podium: "Итоги",
    err_connect: "Нет связи с сервером, переподключаемся…",
    sec: "{s} с",
  },
  en: {
    game_name: "Last Question",
    act1: "Warm-up", act2: "No Safety Net", act3: "The Last Question",
    act_n: "Act {n}", act_final: "Final",
    act1_d: "Right — +100 plus a speed bonus. Wrong — off to the Cell. Don't escape — lose 100",
    act2_d: "Double the points, and getting knocked back costs 250. Mistakes hurt now",
    act3_d: "One hard question. Bet your points first, then answer",
    q_of: "Question {i} of {n}",
    t_animals: "Animals", t_food: "Food", t_geo: "Geography", t_body: "Human body", t_science: "Science & tech",
    t_screen: "Movies & TV", t_weird: "Weird stuff", t_space_nature: "Space & nature",
    g_hands: "Agility", g_eyes: "Attention", g_head: "Brains",
    g_hands_d: "wires, lockpick, tunnel", g_eyes_d: "spot, remember, identify", g_head_d: "puzzles and quick questions",
    pts: "+{n}", minus: "−{n}",
    escaped: "Free!", burned: "Knocked back",
    aw_unkillable: "Unkillable", aw_unkillable_d: "Cell escapes: {n}",
    aw_regular: "Regular", aw_regular_d: "times in the Cell: {n}",
    aw_rocket: "Rocket", aw_rocket_d: "right answers in {s} s on average",
    aw_kamikaze: "Kamikaze", aw_kamikaze_d: "bet: {n}",
    aw_seer: "Seer", aw_seer_d: "bets called right: {n}",
    aw_bottom: "Rock Bottom", aw_bottom_d: "sank to {n}",
    podium: "Results",
    err_connect: "No connection, reconnecting…",
    sec: "{s} s",
  },
  el: {
    game_name: "Τελευταία ερώτηση",
    act1: "Ζέσταμα", act2: "Χωρίς δίχτυ", act3: "Η τελευταία ερώτηση",
    act_n: "Πράξη {n}", act_final: "Τελικός",
    act1_d: "Σωστό — +100 και μπόνους ταχύτητας. Λάθος — στο Κελί. Δεν το σκας — χάνεις 100",
    act2_d: "Διπλοί πόντοι, αλλά το πισωγύρισμα κοστίζει 250. Τα λάθη τώρα πονάνε",
    act3_d: "Μία δύσκολη ερώτηση. Πρώτα ποντάρεις, μετά απαντάς",
    q_of: "Ερώτηση {i} από {n}",
    t_animals: "Ζώα", t_food: "Φαγητό", t_geo: "Γεωγραφία", t_body: "Ανθρώπινο σώμα", t_science: "Επιστήμη και τεχνολογία",
    t_screen: "Σινεμά και σειρές", t_weird: "Παράξενα", t_space_nature: "Διάστημα και φύση",
    g_hands: "Επιδεξιότητα", g_eyes: "Προσοχή", g_head: "Μυαλό",
    g_hands_d: "καλώδια, αντικλείδι, τούνελ", g_eyes_d: "βρες, θυμήσου, αναγνώρισε", g_head_d: "γρίφοι και γρήγορες ερωτήσεις",
    pts: "+{n}", minus: "−{n}",
    escaped: "Ελευθερία!", burned: "Πισωγύρισμα",
    aw_unkillable: "Άτρωτος", aw_unkillable_d: "αποδράσεις από το Κελί: {n}",
    aw_regular: "Μόνιμος θαμώνας", aw_regular_d: "φορές στο Κελί: {n}",
    aw_rocket: "Πύραυλος", aw_rocket_d: "σωστή απάντηση σε {s} δ κατά μέσο όρο",
    aw_kamikaze: "Καμικάζι", aw_kamikaze_d: "ποντάρισμα {n}",
    aw_seer: "Μάντης", aw_seer_d: "σωστά στοιχήματα: {n}",
    aw_bottom: "Πάτος", aw_bottom_d: "πάτος: {n}",
    podium: "Αποτελέσματα",
    err_connect: "Χωρίς σύνδεση, επανασύνδεση…",
    sec: "{s} δ",
  },
};
(function mergeSharedDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const lang of Object.keys(LQ_SHARED_I18N)) d[lang] = Object.assign({}, LQ_SHARED_I18N[lang], d[lang] || {});
})();

// Если i18n.js не доехал (блокировщик) — работаем по-русски, а не белым экраном
function lqT(key) {
  if (window.I18N && window.I18N.t) return window.I18N.t(key);
  const d = (window.I18N_DICT || {}).ru || {};
  return key in d ? d[key] : key;
}
const lqTpl = (key, vars) => String(lqT(key)).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const lqLang = () => (window.I18N && window.I18N.lang) || "ru";
const lqSec = (ms) => String(Math.round(Math.max(0, ms) / 100) / 10).replace(".", lqLang() === "en" ? "." : ",");
// число со знаком: минус — настоящий «−», а не дефис
const lqNum = (n) => (n < 0 ? "−" + Math.abs(n) : String(n));
const lqSigned = (n) => (n > 0 ? "+" + n : n < 0 ? "−" + Math.abs(n) : "0");
const lqTopic = (t) => { const k = "t_" + t; const v = lqT(k); return v === k ? String(t || "") : v; };
const lqGroup = (g) => lqT("g_" + g);
const lqActName = (act) => lqT("act" + act);
// подпись испытания для доски: «режет провода» (строки ch_* — из lastq-challenges.js)
const lqChLabel = (type) => { const k = "ch_" + type; const v = lqT(k); return v === k ? "…" : v; };
const LQ_REACTIONS = ["😂", "😱", "😈", "👏", "🙏"];
// буквы вариантов: на всех языках латиница — их называют вслух, а A/B/C/D узнают все
const LQ_LETTERS = ["A", "B", "C", "D"];

// ---------- звуки: короткий синтез без файлов ----------
// Всё идёт в ctx.destination — sound-toggle.js перехватывает это подключение и глушит общий выключатель.
const lqSfx = (function () {
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
    // тиканье последних 5 секунд
    tick(hot) { tone(hot ? 1500 : 1200, hot ? 1400 : 1100, 0, 0.03, "square", hot ? 0.06 : 0.035); },
    // щелчок ответа
    tap() { tone(700, 900, 0, 0.03, "triangle", 0.08); },
    click() { tone(520, 380, 0, 0.05, "square", 0.08); hiss(0, 0.03, 0.2, "highpass", 3000, 0.7); },
    // гонг верного варианта
    gong() { [196, 392, 588, 784].forEach((f, i) => tone(f, f * 0.995, 0, 1.6 - i * 0.25, "sine", 0.22 / (i + 1))); },
    // мимо
    buzz() { tone(140, 120, 0, 0.22, "sawtooth", 0.12); },
    // лязг решётки
    clang() {
      [311, 467, 523, 740].forEach((f) => tone(f, f * 0.97, 0, 0.45, "square", 0.05));
      hiss(0, 0.25, 0.35, "bandpass", 3200, 2.5, 0.001);
      tone(90, 60, 0, 0.18, "sine", 0.4);
    },
    // «вжух» отлёта
    whoosh() { hiss(0, 0.45, 0.45, "bandpass", 900, 0.9, 0.08); tone(500, 120, 0.02, 0.4, "sine", 0.12); tone(80, 50, 0.42, 0.2, "sine", 0.35); },
    ok() { tone(660, 660, 0, 0.08, "triangle", 0.14); tone(990, 990, 0.08, 0.14, "triangle", 0.12); },
    escape() { [523, 659, 784, 1046].forEach((f, i) => tone(f, f, i * 0.07, 0.14, "triangle", 0.16)); },
    // барабанная дробь перед раскрытием ставок
    drumroll(sec) {
      const n = Math.round((sec || 1.2) * 22);
      for (let i = 0; i < n; i++) hiss(i / 22, 0.05, 0.12 + 0.2 * (i / n), "bandpass", 180 + (i % 2) * 40, 1.5);
      hiss(n / 22, 0.5, 0.5, "highpass", 5000, 0.7, 0.003);
      tone(110, 60, n / 22, 0.25, "sine", 0.5);
    },
    pop() { tone(500, 1100, 0, 0.06, "sine", 0.14); },
    fanfare() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, f, i * 0.1, 0.18, "triangle", 0.16)); },
    womp() { tone(330, 300, 0, 0.22, "sawtooth", 0.1); tone(290, 250, 0.24, 0.22, "sawtooth", 0.1); tone(250, 180, 0.48, 0.5, "sawtooth", 0.12); },
  };
})();

// ---------- место под переключатель языка ----------
// i18n.js ставит его fixed в правый верхний угол, а ширина у него своя на каждом экране и языке.
// Меряем: --lsw — отступ от правого края до его левой кромки (шапка на него не заезжает), --lsc/--lsh — его центр и высота.
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
// до первого касания браузер вибрацию всё равно блокирует (и пишет об этом в консоль) — не зовём
function lqVibrate(p) {
  if (!navigator.vibrate || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return;
  try { navigator.vibrate(p); } catch (e) {}
}

// ---------- экран не гаснет (Wake Lock), пока идёт игра ----------
const lqWake = (function () {
  let lock = null, want = false;
  async function grab() {
    if (!want || lock || document.hidden) return;
    try { if ("wakeLock" in navigator) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => { lock = null; }); } } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) grab(); });
  return { on() { want = true; grab(); } };
})();

// ---------- часы сервера ----------
// Смещение «сервер − устройство» по самому быстрому ping/pong (RTT/2); пока замера нет —
// по state (у него задержка только прибавляется, поэтому берём наибольший из недавних).
const lqClock = { offset: null, rtt: Infinity, at: 0, states: [] };
function lqClockSample(serverT, sentAt) {
  const t = Date.now(), rtt = t - sentAt;
  if (!(rtt >= 0) || typeof serverT !== "number") return;
  if (rtt <= lqClock.rtt || t - lqClock.at > 60000) {
    lqClock.rtt = rtt;
    lqClock.offset = serverT + rtt / 2 - t;
    lqClock.at = t;
  }
}
function lqStateSample(serverNow) {
  if (typeof serverNow !== "number") return;
  lqClock.states.push(serverNow - Date.now());
  if (lqClock.states.length > 12) lqClock.states.shift();
}
function lqOffset() {
  const byState = lqClock.states.length ? Math.max.apply(null, lqClock.states) : 0;
  return lqClock.offset != null ? Math.max(lqClock.offset, byState) : byState;
}
const lqNow = () => Date.now() + lqOffset();

// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------

let lqWsBroken = false;
const LQ_WS_HANDSHAKE_MS = 5000;
const LQ_POLL_FETCH_MS = 28000;
const LQ_PROBE_MS = 3000;

function lqOpenTransport({ code, onMessage, onClose, onOpen, onSendFail, onGone }) {
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
    if (m && m.type === "pong") { if (typeof m.c === "number") lqClockSample(m.t, m.c); return; }
    if (m && (m.type === "state" || m.type === "hello") && m.state) lqStateSample(m.state.serverNow);
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
      fetch("/lastq/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
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
      probeTimer = setTimeout(() => { if (!closed && lastSeen < asked) fireClose(); }, ms || LQ_PROBE_MS);
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
      const res = await timedFetch(`/lastq/api/session?r=${encodeURIComponent(code)}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/lastq/api/poll?sid=${sid}`, LQ_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (lqWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/lastq/ws?r=${encodeURIComponent(code)}`);
    const handshake = setTimeout(() => {
      if (closed || opened || !ws || ws.readyState !== 0) return;
      lqWsBroken = true;
      const dead = ws; ws = null;
      dead.onclose = dead.onmessage = dead.onopen = null;
      try { dead.close(); } catch (e) {}
      startPolling();
    }, LQ_WS_HANDSHAKE_MS);
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
function lqConnect({ code, onMessage, onOpen, onGone, onState, onSendFail }) {
  let t = null, delay = 500, stopped = false;
  const holder = { api: null, send: (m) => holder.api && holder.api.send(m), stop() { stopped = true; clearTimeout(t); if (holder.api) holder.api.close(); } };
  const open = () => {
    if (stopped) return;
    if (onState) onState("connecting");
    holder.api = lqOpenTransport({
      code,
      onMessage,
      onSendFail,
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

