/* Общий код «На одной волне» для пульта (wave.html) и доски (wave-board.html):
   транспорт до сервера, часы сервера, подписи на трёх языках, звуки, шкала-полукруг.
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

// ---------- подписи, общие для доски и пульта ----------
// Страница кладёт свой словарь в I18N_DICT, эти ключи домешиваются туда до загрузки i18n.js.

const WV_SHARED_I18N = {
  ru: {
    game_name: "На одной волне",
    r_0: "Настройка", r_1: "Двойная волна",
    r_0_d: "Каждый прячет точку на шкале и подсказывает одной фразой. Остальные ловят волну",
    r_1_d: "То же самое, очки ×2",
    round_n: "Раунд {n}",
    pts: "+{n}", sec: "{s} с",
    bull: "В яблочко!", wave: "На одной волне!", miss: "Мимо", miss_short: "мимо",
    clue_by: "Подсказывает {name}",
    card_of: "{i}/{n}",
    aw_telepath: "Телепат", aw_telepath_d: "в яблочко: {n}",
    aw_clear: "Ясно выражается", aw_clear_d: "в среднем {n} очков за подсказку",
    aw_miss: "Мимо кассы", aw_miss_d: "{name} — мимо центра на {n}°",
    podium: "Итоги",
    c_side: ["Все мимо — и все в одну сторону!", "Дружно промахнулись. Зато единодушно"],
    c_miss: ["Мимо всем составом", "Никто не поймал волну"],
    c_split: ["Компания раскололась", "Мнения разошлись на полшкалы"],
    c_close: ["Почти! Все рядом с сектором", "Тепло-тепло, но не в яблочко"],
    aw_split: "Раскол", aw_split_d: "стрелки разошлись на {n}°",
    leaders: "Лидеры перед удвоением",
    err_connect: "Нет связи с сервером, переподключаемся…",
  },
  en: {
    game_name: "Same Wave",
    r_0: "Tuning In", r_1: "Double Wave",
    r_0_d: "Everyone hides a point on a scale and gives one clue. The rest try to catch the wave",
    r_1_d: "Same thing, points ×2",
    round_n: "Round {n}",
    pts: "+{n}", sec: "{s}s",
    bull: "Bullseye!", wave: "Same wave!", miss: "Miss", miss_short: "miss",
    clue_by: "Clue by {name}",
    card_of: "{i}/{n}",
    aw_telepath: "Telepath", aw_telepath_d: "bullseyes: {n}",
    aw_clear: "Crystal Clear", aw_clear_d: "{n} points per clue on average",
    aw_miss: "Way Off", aw_miss_d: "{name} missed the center by {n}°",
    podium: "Results",
    c_side: ["All missed — in the same direction!", "Missed together. At least you agree"],
    c_miss: ["Nobody caught the wave", "A miss for the whole room"],
    c_split: ["The room is split", "Opinions are half a dial apart"],
    c_close: ["So close! Everyone's near the target", "Warm, warmer… but no bullseye"],
    aw_split: "The Great Divide", aw_split_d: "needles {n}° apart",
    leaders: "Leaders before the double",
    err_connect: "No connection, reconnecting…",
  },
  el: {
    game_name: "Στο ίδιο κύμα",
    r_0: "Συντονισμός", r_1: "Διπλό κύμα",
    r_0_d: "Ο καθένας κρύβει ένα σημείο στην κλίμακα και δίνει ένα στοιχείο. Οι άλλοι πιάνουν το κύμα",
    r_1_d: "Το ίδιο, πόντοι ×2",
    round_n: "Γύρος {n}",
    pts: "+{n}", sec: "{s} δ",
    bull: "Διάνα!", wave: "Στο ίδιο κύμα!", miss: "Άστοχο", miss_short: "άστοχο",
    clue_by: "Στοιχείο: {name}",
    card_of: "{i}/{n}",
    aw_telepath: "Τηλεπαθητικός", aw_telepath_d: "διάνες: {n}",
    aw_clear: "Μιλάει καθαρά", aw_clear_d: "κατά μέσο όρο {n} πόντοι ανά στοιχείο",
    aw_miss: "Άσχετος", aw_miss_d: "{name}: {n}° μακριά από το κέντρο",
    podium: "Αποτελέσματα",
    c_side: ["Όλοι άστοχοι — και προς την ίδια μεριά!", "Αστοχία όλοι μαζί. Τουλάχιστον συμφωνείτε"],
    c_miss: ["Κανείς δεν έπιασε το κύμα", "Άστοχο για όλη την παρέα"],
    c_split: ["Η παρέα χωρίστηκε στα δύο", "Οι γνώμες απέχουν μισή κλίμακα"],
    c_close: ["Σχεδόν! Όλοι κοντά στον στόχο", "Ζεστό, ζεστό… αλλά όχι διάνα"],
    aw_split: "Διχασμός", aw_split_d: "οι βελόνες απέχουν {n}°",
    leaders: "Οι πρώτοι πριν το διπλό",
    err_connect: "Χωρίς σύνδεση, επανασύνδεση…",
  },
};
(function mergeSharedDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const lang of Object.keys(WV_SHARED_I18N)) d[lang] = Object.assign({}, WV_SHARED_I18N[lang], d[lang] || {});
})();

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
    tick(hot) { tone(hot ? 1500 : 1200, hot ? 1400 : 1100, 0, 0.03, "square", hot ? 0.06 : 0.035); },
    tap() { tone(700, 900, 0, 0.03, "triangle", 0.08); },
    // щелчок стрелки при перетаскивании — тихий, раз в несколько градусов
    detent() { tone(2400, 2200, 0, 0.012, "square", 0.025); },
    send() { tone(660, 990, 0, 0.08, "triangle", 0.14); tone(990, 1320, 0.07, 0.1, "triangle", 0.1); },
    // фиксация стрелки: тяжёлый «клац»
    lock() { tone(180, 90, 0, 0.09, "square", 0.16); hiss(0, 0.05, 0.3, "highpass", 4000, 0.7, 0.001); },
    // шторка смены цвета
    whoosh() { hiss(0, 0.32, 0.28, "bandpass", 900, 0.6, 0.12); },
    // дробь перед раскрытием сектора
    drumroll(sec) {
      const n = Math.round((sec || 0.8) * 24);
      for (let i = 0; i < n; i++) hiss(i / 24, 0.05, 0.1 + 0.22 * (i / n), "bandpass", 180 + (i % 2) * 40, 1.5);
      tone(110, 60, n / 24, 0.25, "sine", 0.5);
    },
    // стрелка игрока упала на шкалу: чем ближе к центру, тем выше нота
    drop(k) { const f = 330 + 500 * (k || 0); tone(f, f * 1.02, 0, 0.12, "triangle", 0.14); },
    bull() { [784, 1046, 1318].forEach((f, i) => tone(f, f, i * 0.07, 0.18, "triangle", 0.18)); },
    // «На одной волне!» — восходящее арпеджио с дрожью
    wave() { [392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, f * 1.01, i * 0.06, 0.28, "sawtooth", 0.08)); hiss(0.36, 0.6, 0.25, "highpass", 6000, 0.7, 0.01); },
    womp() { tone(330, 300, 0, 0.2, "sawtooth", 0.1); tone(250, 170, 0.22, 0.45, "sawtooth", 0.12); },
    fanfare() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, f, i * 0.1, 0.18, "triangle", 0.16)); },
    buzz() { tone(140, 120, 0, 0.22, "sawtooth", 0.12); },
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
      // центр и высота переключателя: кнопка звука встаёт с ним на одну линию и той же высоты
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
      fetch("/wave/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
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
      const res = await timedFetch(`/wave/api/session?r=${encodeURIComponent(code)}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/wave/api/poll?sid=${sid}`, BM_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (wvWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/wave/ws?r=${encodeURIComponent(code)}`);
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


// ---------- шкала-полукруг ----------
// Угол 0° — левый полюс, 180° — правый, 90° — верх. SVG 1000×540, центр стрелки внизу посередине.
const WV = { cx: 500, cy: 510, R: 470, W: 1000, H: 540 };
// Заливка экрана: у каждой шкалы свой цвет. Все светлые и сочные — чёрный текст читается на любом.
// Жёлтого и кораллового нет: это палитра «Бомбы»; оранжевого — это «Вопрос ребром».
const WV_COLORS = ["#c6f432", "#ff5fa2", "#5b8cff", "#2ee8b0", "#b69cff", "#9be7ff"];
const WV_HOME = "#5b8cff"; // стартовый экран и лобби
const wvColor = (i) => WV_COLORS[((i % WV_COLORS.length) + WV_COLORS.length) % WV_COLORS.length];

function wvPt(a, r) {
  const t = (a * Math.PI) / 180;
  return [WV.cx - r * Math.cos(t), WV.cy - r * Math.sin(t)];
}
const wvXY = (p) => p[0].toFixed(1) + " " + p[1].toFixed(1);
// клин от a1 до a2 (градусы, a1 < a2) радиусом r
function wvWedge(a1, a2, r) {
  a1 = Math.max(0, a1); a2 = Math.min(180, a2);
  if (a2 <= a1) return "";
  return `M${WV.cx} ${WV.cy} L${wvXY(wvPt(a1, r))} A${r} ${r} 0 0 1 ${wvXY(wvPt(a2, r))} Z`;
}
// угол по точке экрана относительно svg: тянуть можно из любой точки полукруга и даже ниже центра
function wvAngleAt(svg, clientX, clientY) {
  const b = svg.getBoundingClientRect();
  const x = ((clientX - b.left) / b.width) * WV.W;
  const y = ((clientY - b.top) / b.height) * WV.H;
  const dx = x - WV.cx, dy = WV.cy - y;
  let a = (Math.atan2(Math.max(dy, 0.0001), -dx) * 180) / Math.PI;
  if (dy < 0) a = dx < 0 ? 0 : 180; // ниже центра — прижимаем к ближнему краю
  return Math.max(0, Math.min(180, a));
}

/*
 * Порядок раскрытия (wave-spec.md §6): стрелки падают на закрытую ширму, дробь, ширма уезжает вокруг оси,
 * потом очки вскрываются по одной — от самого дальнего промаха к самому точному. Все сроки — в мс от начала раскрытия.
 */
function wvRevealPlan(n) {
  const drop = 200, dropStep = 120;
  const open = drop + n * dropStep + 700;
  const badge0 = open + 650, badgeStep = 450;
  const badgeAt = (i) => badge0 + i * badgeStep + (i === n - 1 && n > 1 ? 300 : 0); // перед самым точным — пауза
  return { drop, dropStep, open, badgeAt, done: n ? badgeAt(n - 1) + 400 : open + 700 };
}

/*
 * Разметка шкалы. o = {
 *   target — центр сектора (null — сектора нет), bands,
 *   shutter — "closed" | "open" (уезжает по плану раскрытия) | нет,
 *   label — крупная надпись на ширме («№3»),
 *   guesses — [{a, color, avatar, pts}] стрелки игроков, уже отсортированные от дальнего к ближнему,
 *   plan — wvRevealPlan (задержки анимаций раскрытия), needle — главная стрелка (телефон), uid, missText
 * }
 */
function wvDialSvg(o) {
  const R = WV.R;
  const uid = o.uid || "d";
  const plan = o.plan || null;
  const parts = [];
  parts.push(`<defs><pattern id="hatch-${uid}" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="14" fill="#fff"/><rect width="6" height="14" fill="var(--card, #c6f432)"/></pattern>
    <pattern id="shut-${uid}" width="46" height="46" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="46" height="46" fill="var(--card, #c6f432)"/><rect width="16" height="46" fill="#111"/></pattern>
    <clipPath id="face-${uid}"><path d="${wvWedge(0, 180, R)}"/></clipPath></defs>`);
  parts.push(`<path class="face" d="${wvWedge(0, 180, R)}" fill="#fff"/>`);
  // сектор: крайние полосы — штриховка, соседние — цвет шкалы, центр — чёрный
  if (o.target != null) {
    const t = o.target;
    const b = o.bands || [[4, 400], [12, 300], [20, 200]];
    const fills = [`url(#hatch-${uid})`, "var(--card, #c6f432)", "#111"];
    let sec = "";
    for (let i = b.length - 1; i >= 0; i--) {
      const lim = b[i][0];
      const inner = i > 0 ? b[i - 1][0] : 0;
      const k = b.length - 1 - i;
      if (i === 0) sec += `<path d="${wvWedge(t - lim, t + lim, R)}" fill="${fills[2]}"/>`;
      else sec += `<path d="${wvWedge(t - lim, t - inner, R)}" fill="${fills[k]}"/><path d="${wvWedge(t + inner, t + lim, R)}" fill="${fills[k]}"/>`;
    }
    // цифры очков в полосах, у края; на раскрытии их место — таблички очков игроков
    for (let i = 0; i < b.length && !(o.guesses && o.guesses.length); i++) {
      const inner = i > 0 ? b[i - 1][0] : -b[0][0];
      const mid = i === 0 ? [t] : [t - (b[i][0] + inner) / 2, t + (b[i][0] + inner) / 2];
      for (const a of mid) {
        if (a < 1 || a > 179) continue;
        const p = wvPt(a, R - 52);
        sec += `<text x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" class="bandnum" fill="${i === 0 ? "#fff" : "#111"}" transform="rotate(${(a - 90).toFixed(1)} ${p[0].toFixed(1)} ${p[1].toFixed(1)})">${b[i][1] / 100}</text>`;
      }
    }
    parts.push(`<g class="sector" clip-path="url(#face-${uid})">${sec}</g>`);
  }
  // ширма: полукруг в цвет шкалы с толстой чёрной штриховкой; уезжает вокруг оси вниз, за основание шкалы
  if (o.shutter) {
    const lp = wvPt(90, R * 0.5);
    const lab = o.label ? `<text x="${lp[0]}" y="${lp[1]}" class="shutlabel">${escapeHtml(o.label)}</text>` : "";
    parts.push(`<g clip-path="url(#face-${uid})"><g class="shutter ${o.shutter}"${plan ? ` style="--sd:${plan.open}ms"` : ""}><path d="${wvWedge(0, 180, R)}" fill="url(#shut-${uid})"/>${lab}</g></g>`);
  }
  // риски: каждые 5°, на 0/90/180 длиннее; поверх ширмы — шкала читается и закрытой
  let ticks = "";
  for (let a = 0; a <= 180; a += 5) {
    const big = a % 90 === 0, mid = a % 10 === 0;
    const p1 = wvPt(a, R - (big ? 40 : mid ? 24 : 12)), p2 = wvPt(a, R);
    ticks += `<line x1="${p1[0].toFixed(1)}" y1="${p1[1].toFixed(1)}" x2="${p2[0].toFixed(1)}" y2="${p2[1].toFixed(1)}" stroke-width="${big ? 7 : mid ? 4 : 2.5}"/>`;
  }
  parts.push(`<g class="ticks" stroke="#111" stroke-linecap="butt">${ticks}</g>`);
  parts.push(`<path class="rim" d="${wvWedge(0, 180, R)}" fill="none" stroke="#111" stroke-width="10" stroke-linejoin="round"/>`);
  // стрелки игроков: чёрная окантовка под цветом — видно и на секторе того же цвета; одинаковые углы разводим по радиусу
  if (o.guesses && o.guesses.length) {
    const bySide = o.guesses.map((g, i) => ({ g, i })).sort((x, y) => x.g.a - y.g.a);
    const len = new Array(o.guesses.length);
    bySide.forEach((x, k) => {
      let lift = 0;
      for (let j = k - 1; j >= 0 && Math.abs(bySide[j].g.a - x.g.a) < 8; j--) lift++;
      len[x.i] = R - 70 - lift * 70;
    });
    let lines = "", avs = "", badges = "";
    o.guesses.forEach((g, i) => {
      const L = len[i];
      const p = wvPt(g.a, L);
      const q = wvPt(g.a, L - 84);
      const d = plan ? plan.drop + i * plan.dropStep : 0;
      const bd = plan ? plan.badgeAt(i) : 0;
      lines += `<g class="gneedle" style="--a:${g.a};--d:${d}ms"><line x1="${WV.cx}" y1="${WV.cy}" x2="${WV.cx - L}" y2="${WV.cy}" stroke="#111" stroke-width="20" stroke-linecap="round"/><line x1="${WV.cx}" y1="${WV.cy}" x2="${WV.cx - L}" y2="${WV.cy}" stroke="${g.color}" stroke-width="11" stroke-linecap="round"/></g>`;
      avs += `<g class="gav" style="--d:${d}ms"><circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="31" fill="${g.color}" stroke="#111" stroke-width="6"/><text x="${p[0].toFixed(1)}" y="${(p[1] + 11).toFixed(1)}" class="avtxt">${escapeHtml(g.avatar)}</text></g>`;
      if (g.pts != null) {
        const txt = g.pts ? "+" + g.pts : (o.missText || "0");
        const w = Math.max(96, Array.from(txt).length * (g.pts ? 30 : 24) + 28);
        badges += `<g class="badge${g.pts ? "" : " zero"}${g.best ? " best" : ""}" style="--bd:${bd}ms"><rect x="${(q[0] - w / 2).toFixed(1)}" y="${(q[1] - 30).toFixed(1)}" width="${w}" height="56" fill="#111"/><text x="${q[0].toFixed(1)}" y="${(q[1] + 1).toFixed(1)}" class="btxt">${escapeHtml(txt)}</text></g>`;
      }
    });
    parts.push(`<g class="guesses">${lines}</g><g class="gavs">${avs}</g><g class="badges">${badges}</g>`);
  }
  if (o.needle != null) {
    parts.push(`<g class="needle" style="--a:${o.needle}"><line x1="${WV.cx}" y1="${WV.cy}" x2="${WV.cx - (R - 18)}" y2="${WV.cy}" stroke="#111" stroke-width="16" stroke-linecap="round"/><circle cx="${WV.cx - (R - 18)}" cy="${WV.cy}" r="14" fill="#111"/></g>`);
  }
  parts.push(`<circle cx="${WV.cx}" cy="${WV.cy}" r="34" fill="#111"/><circle cx="${WV.cx}" cy="${WV.cy}" r="11" fill="#fff"/>`);
  return `<svg class="dial" viewBox="0 0 ${WV.W} ${WV.H}" preserveAspectRatio="xMidYMax meet" role="img">${parts.join("")}</svg>`;
}

// раскрытие: стрелки игроков от дальнего промаха к ближнему (так их и вскрываем)
function wvRevealGuesses(card, player) {
  return Object.entries(card.guesses)
    .map(([id, a]) => { const p = player(id) || { color: "#111", avatar: "?" }; return { id, a, color: p.color, avatar: p.avatar, pts: card.pts[id], dist: Math.abs(a - card.target) }; })
    .sort((x, y) => y.dist - x.dist);
}

// место в таблице: равные очки — равное место (1, 2, 2, 4)
const wvRank = (list, p) => 1 + list.filter((x) => x.score > p.score).length;
// номер шкалы на ширме: «№» — по-русски, «#» — остальным
const wvNo = (n) => (wvLang() === "ru" ? "№" : "#") + n;

// полюс шкалы: неразрывный пробел после коротких слов — «в», «для», «για» не висят в конце строки
const wvPole = (t) => escapeHtml(t).replace(/(^|\s)([\p{L}]{1,3})\s/gu, "$1$2 ");

// общий CSS шкалы: одинаков на доске и телефоне
(function dialCss() {
  const css = `
  .dial .bandnum { font: 1000 44px/1 var(--f); font-stretch: 151%; font-variation-settings: "wdth" 151; text-anchor: middle; dominant-baseline: central; }
  .dial .avtxt { font-size: 34px; text-anchor: middle; }
  .dial .btxt { font: 1000 38px/1 var(--f); fill: #fff; text-anchor: middle; dominant-baseline: central; font-variant-numeric: tabular-nums; }
  .dial .badge.zero .btxt { font-size: 30px; text-transform: uppercase; }
  .dial .shutlabel { font: 1000 150px/1 var(--f); font-stretch: 151%; font-variation-settings: "wdth" 151; text-anchor: middle; dominant-baseline: central; fill: #111; paint-order: stroke; stroke: var(--card, #c6f432); stroke-width: 26px; }
  .dial .needle, .dial .gneedle { transform-box: view-box; transform-origin: 500px 510px; transform: rotate(calc(var(--a) * 1deg)); }
  .dial .shutter { transform-box: view-box; transform-origin: 500px 510px; }
  .dial .shutter.open { animation: wvShutOpen .75s cubic-bezier(.7, 0, .3, 1) forwards; animation-delay: var(--sd, 0ms); }
  .dial .shutter.jolt { animation: wvJolt .22s ease-out; }
  .dial .gneedle { animation: wvSwing .7s cubic-bezier(.2, 1.6, .4, 1) both; animation-delay: var(--d); }
  .dial .gav { animation: wvPop .4s cubic-bezier(.2, 1.6, .4, 1) both; animation-delay: calc(var(--d) + .35s); transform-box: fill-box; transform-origin: center; }
  .dial .badge { animation: wvPop .45s cubic-bezier(.2, 1.8, .4, 1) both; animation-delay: var(--bd); transform-box: fill-box; transform-origin: center; }
  .dial .badge.best rect { fill: var(--card, #c6f432); stroke: #111; stroke-width: 6px; }
  .dial .badge.best .btxt { fill: #111; }
  @keyframes wvShutOpen { to { transform: rotate(180deg); } }
  @keyframes wvJolt { 30% { transform: rotate(-1.6deg); } 70% { transform: rotate(1.2deg); } }
  @keyframes wvSwing { from { transform: rotate(90deg); } }
  @keyframes wvPop { from { transform: scale(0); } }
  @media (prefers-reduced-motion: reduce) { .dial .shutter.open { animation-duration: .01ms; } }
  /* переключатель языка — в духе игры: прямые углы, толстая линия, без стекла и мягкой тени */
  .lang-switch { border-radius: 0 !important; box-shadow: none !important; border: 3px solid #111 !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  .lang-switch button { border-radius: 0 !important; }
  /* кавычки по языку: «ёлочки» — русским и грекам, “лапки” — английским */
  html[lang="en"] q { quotes: "\\201C" "\\201D" "\\2018" "\\2019" !important; }`;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.append(st);
})();
