/* Общий код «Не верю!» для пульта (fibs.html) и доски (fibs-board.html):
   транспорт до сервера, часы сервера, подписи на трёх языках, звуки.
   Транспорт перенесён из bomb-shared.js (а туда — из roulette/auction): там подробная история решений. */

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

const FB_SHARED_I18N = {
  ru: {
    game_name: "Не верю!",
    r_r1: "Разминка", r_r2: "Двойные ставки", r_final: "Финал",
    r_r1_d: "Впиши ложь, в которую поверят. Потом найди правду среди чужих выдумок",
    r_r2_d: "То же самое, но очки вдвое больше",
    r_final_d: "Один факт — самый дикий. Очки втрое больше",
    round_n: "Раунд {n}",
    t_animals: "Животные", t_food: "Еда", t_history: "История", t_laws: "Странные законы", t_records: "Рекорды", t_inventions: "Изобретения",
    t_space: "Космос", t_body: "Тело человека", t_places: "Города и страны", t_culture: "Кино и книги", t_language: "Слова и языки", t_nature: "Природа", t_sport: "Спорт",
    truth: "ПРАВДА", fake: "ЛОЖЬ", trap: "Ловушка игры", lie_of: "Ложь: {names}",
    hint_mark: "подсказка", late_mark: "не успел",
    pts: "+{n}", sec: "{s} с",
    pts_truth: "Правда — {n}", pts_fool: "каждый обманутый — {n}",
    source: "Источник",
    podium: "Итоги",
    aw_liar: "Главный врун", aw_liar_d: "обманутых: {n}",
    aw_detector: "Детектор лжи", aw_detector_d: "правда найдена: {n}",
    aw_gullible: "Верит всему", aw_gullible_d: "ловушек игры: {n}",
    aw_best: "Любимая ложь зала", likes_n: "👍 {n}",
    err_connect: "Нет связи с сервером, переподключаемся…",
  },
  en: {
    game_name: "No Way!",
    r_r1: "Warm-up", r_r2: "Double Stakes", r_final: "Final",
    r_r1_d: "Write a lie people will buy. Then find the truth among everyone's fibs",
    r_r2_d: "Same thing, double the points",
    r_final_d: "One fact — the wildest one. Triple points",
    round_n: "Round {n}",
    t_animals: "Animals", t_food: "Food", t_history: "History", t_laws: "Weird laws", t_records: "Records", t_inventions: "Inventions",
    t_space: "Space", t_body: "Human body", t_places: "Places", t_culture: "Movies & books", t_language: "Words", t_nature: "Nature", t_sport: "Sport",
    truth: "TRUTH", fake: "FAKE", trap: "Game's trap", lie_of: "Lie by {names}",
    hint_mark: "hint", late_mark: "too slow",
    pts: "+{n}", sec: "{s} s",
    pts_truth: "Truth — {n}", pts_fool: "each fooled — {n}",
    source: "Source",
    podium: "Results",
    aw_liar: "Master liar", aw_liar_d: "fooled: {n}",
    aw_detector: "Lie detector", aw_detector_d: "truths found: {n}",
    aw_gullible: "Believes anything", aw_gullible_d: "game traps: {n}",
    aw_best: "Crowd's favourite lie", likes_n: "👍 {n}",
    err_connect: "No connection, reconnecting…",
  },
  el: {
    game_name: "Δεν το πιστεύω!",
    r_r1: "Ζέσταμα", r_r2: "Διπλό ποντάρισμα", r_final: "Τελικός",
    r_r1_d: "Γράψε ένα ψέμα που θα το πιστέψουν. Μετά βρες την αλήθεια ανάμεσα στα ψέματα των άλλων",
    r_r2_d: "Το ίδιο, με διπλούς πόντους",
    r_final_d: "Ένα γεγονός — το πιο απίστευτο. Τριπλοί πόντοι",
    round_n: "Γύρος {n}",
    t_animals: "Ζώα", t_food: "Φαγητό", t_history: "Ιστορία", t_laws: "Παράξενοι νόμοι", t_records: "Ρεκόρ", t_inventions: "Εφευρέσεις",
    t_space: "Διάστημα", t_body: "Ανθρώπινο σώμα", t_places: "Πόλεις και χώρες", t_culture: "Σινεμά και βιβλία", t_language: "Λέξεις", t_nature: "Φύση", t_sport: "Αθλητισμός",
    truth: "ΑΛΗΘΕΙΑ", fake: "ΨΕΜΑ", trap: "Παγίδα του παιχνιδιού", lie_of: "Ψέμα: {names}",
    hint_mark: "βοήθεια", late_mark: "άργησε",
    pts: "+{n}", sec: "{s} δ",
    pts_truth: "Αλήθεια — {n}", pts_fool: "κάθε θύμα — {n}",
    source: "Πηγή",
    podium: "Αποτελέσματα",
    aw_liar: "Αρχιψεύτης", aw_liar_d: "ξεγέλασε {n} φορές",
    aw_detector: "Ανιχνευτής ψεμάτων", aw_detector_d: "βρήκε την αλήθεια {n} φορές",
    aw_gullible: "Αφελής", aw_gullible_d: "έπεσε στην παγίδα {n} φορές",
    aw_best: "Το αγαπημένο ψέμα", likes_n: "👍 {n}",
    err_connect: "Χωρίς σύνδεση, επανασύνδεση…",
  },
};
(function mergeSharedDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const lang of Object.keys(FB_SHARED_I18N)) d[lang] = Object.assign({}, FB_SHARED_I18N[lang], d[lang] || {});
})();

// Если i18n.js не доехал (блокировщик) — работаем по-русски, а не белым экраном
function qpT(key) {
  if (window.I18N && window.I18N.t) return window.I18N.t(key);
  const d = (window.I18N_DICT || {}).ru || {};
  return key in d ? d[key] : key;
}
const qpTpl = (key, vars) => String(qpT(key)).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const qpLang = () => (window.I18N && window.I18N.lang) || "ru";
const qpSec = (ms) => String(Math.round(Math.max(0, ms) / 100) / 10).replace(".", qpLang() === "en" ? "." : ",");

// факт: пропуск ______ — подчёркнутая линия; ans — вставить ответ в пропуск (раскрытие)
function qpFactHtml(text, ans) {
  const parts = String(text || "").split(/_{3,}/);
  const gap = ans != null ? `<mark class="ans">${escapeHtml(ans)}</mark>` : `<span class="gap"></span>`;
  return parts.map(escapeHtml).join(gap);
}
const qpTopic = (t) => qpT("t_" + t);
function qpRoundName(key) { return qpT("r_" + key); }
function qpRoundDesc(key) { return qpT("r_" + key + "_d"); }
// имена через запятую — именительный падеж, не склоняем
// имя на иврите или арабском без изоляции переставляло соседние имена и знаки (\u2068…\u2069 — FSI/PDI)
const qpNames = (ids, player) => ids.map((id) => "\u2068" + ((player(id) || {}).name || "?") + "\u2069").join(", ");
// домен источника для подписи под правдой
function qpSourceHost(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }

// ---------- звуки: короткий синтез без файлов ----------
// Всё идёт в ctx.destination — sound-toggle.js перехватывает это подключение и глушит общий выключатель.
const qpSfx = (function () {
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
    send() { tone(660, 990, 0, 0.08, "triangle", 0.14); tone(990, 1320, 0.07, 0.1, "triangle", 0.1); },
    pop() { tone(500, 1100, 0, 0.06, "sine", 0.14); },
    // барабанная дробь перед раскрытием
    drumroll(sec) {
      const n = Math.round((sec || 1.2) * 22);
      for (let i = 0; i < n; i++) hiss(i / 22, 0.05, 0.12 + 0.2 * (i / n), "bandpass", 180 + (i % 2) * 40, 1.5);
      hiss(n / 22, 0.5, 0.5, "highpass", 5000, 0.7, 0.003); // тарелка
      tone(110, 60, n / 22, 0.25, "sine", 0.5);
    },
    // смех зала: чем больше голосов, тем гуще аплодисменты
    applause(k) {
      const n = Math.max(6, Math.min(60, Math.round(10 + 40 * (k || 0.5))));
      for (let i = 0; i < n; i++) hiss(Math.random() * 1.6, 0.03 + Math.random() * 0.04, 0.12 + Math.random() * 0.2, "bandpass", 1500 + Math.random() * 2500, 2);
    },
    jinx() { tone(330, 330, 0, 0.14, "square", 0.1); tone(262, 262, 0.16, 0.14, "square", 0.1); tone(196, 150, 0.32, 0.35, "sawtooth", 0.12); },
    sweep() { [523, 659, 784, 1046].forEach((f, i) => tone(f, f, i * 0.09, 0.16, "triangle", 0.18)); },
    buzz() { tone(140, 120, 0, 0.22, "sawtooth", 0.12); },
    flip() { hiss(0, 0.12, 0.3, "bandpass", 3000, 0.8, 0.01); tone(400, 800, 0.02, 0.06, "sine", 0.08); },
    // стук пишущей машинки: n ударов
    type(n) { for (let i = 0; i < (n || 6); i++) hiss(i * 0.07 + Math.random() * 0.02, 0.025, 0.35, "bandpass", 2200 + Math.random() * 800, 3, 0.001); },
    // штемпель по бумаге
    stamp() { tone(160, 70, 0, 0.12, "sine", 0.5); hiss(0, 0.08, 0.4, "lowpass", 900, 0.7, 0.002); },
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
// без касания экрана (после перезагрузки) Chrome не вибрирует и пишет ошибку в консоль — не зовём
function qpVibrate(p) { if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; if (navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} }

// ---------- часы сервера ----------
// Смещение «сервер − устройство» по самому быстрому ping/pong (RTT/2); пока замера нет —
// по state (у него задержка только прибавляется, поэтому берём наибольший из недавних).
const qpClock = { offset: null, rtt: Infinity, at: 0, states: [] };
function qpClockSample(serverT, sentAt) {
  const t = Date.now(), rtt = t - sentAt;
  if (!(rtt >= 0) || typeof serverT !== "number") return;
  if (rtt <= qpClock.rtt || t - qpClock.at > 60000) {
    qpClock.rtt = rtt;
    qpClock.offset = serverT + rtt / 2 - t;
    qpClock.at = t;
  }
}
function qpStateSample(serverNow) {
  if (typeof serverNow !== "number") return;
  qpClock.states.push(serverNow - Date.now());
  if (qpClock.states.length > 12) qpClock.states.shift();
}
function qpOffset() {
  const byState = qpClock.states.length ? Math.max.apply(null, qpClock.states) : 0;
  return qpClock.offset != null ? Math.max(qpClock.offset, byState) : byState;
}
const qpNow = () => Date.now() + qpOffset();

// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------

let qpWsBroken = false;
const BM_WS_HANDSHAKE_MS = 5000;
const BM_POLL_FETCH_MS = 28000;
const BM_PROBE_MS = 3000;

function qpOpenTransport({ code, onMessage, onClose, onOpen, onSendFail, onGone }) {
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
    if (m && m.type === "pong") { if (typeof m.c === "number") qpClockSample(m.t, m.c); return; }
    if (m && (m.type === "state" || m.type === "hello") && m.state) qpStateSample(m.state.serverNow);
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
      fetch("/fibs/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
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
      const res = await timedFetch(`/fibs/api/session?r=${encodeURIComponent(code)}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/fibs/api/poll?sid=${sid}`, BM_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (qpWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/fibs/ws?r=${encodeURIComponent(code)}`);
    const handshake = setTimeout(() => {
      if (closed || opened || !ws || ws.readyState !== 0) return;
      qpWsBroken = true;
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
function qpConnect({ code, onMessage, onOpen, onGone, onState }) {
  let t = null, delay = 500, stopped = false;
  const holder = { api: null, send: (m) => holder.api && holder.api.send(m), stop() { stopped = true; clearTimeout(t); if (holder.api) holder.api.close(); } };
  const open = () => {
    if (stopped) return;
    if (onState) onState("connecting");
    holder.api = qpOpenTransport({
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

