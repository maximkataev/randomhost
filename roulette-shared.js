/* Общий код рулетки для пульта (roulette.html) и доски (roulette-board.html):
   транспорт до сервера, часы сервера, таблица ставок, карты, общие подписи.
   Транспорт перенесён из auction-shared.js — там же подробная история решений. */

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

// ---------- стол: то же, что в roulette/game.js (сервер всё равно проверяет каждую ставку) ----------

const RL_WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RL_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const rlColor = (n) => (n === 0 ? "green" : RL_RED.has(n) ? "red" : "black");
const RL_PAYOUT = { 1: 35, 2: 17, 3: 11, 4: 8, 6: 5, 12: 2, 18: 1 };

const RL_BETS = (function () {
  const bets = Object.create(null);
  const add = (type, numbers, key) => {
    numbers = numbers.slice().sort((a, b) => a - b);
    key = key || `${type}:${numbers.join("-")}`;
    bets[key] = { key, type, numbers, pays: RL_PAYOUT[numbers.length] };
  };
  const at = (r, c) => 3 * r + c + 1;
  for (let n = 0; n <= 36; n++) add("n", [n]);
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 2; c++) add("sp", [at(r, c), at(r, c + 1)]);
    if (r < 11) for (let c = 0; c < 3; c++) add("sp", [at(r, c), at(r + 1, c)]);
    add("st", [at(r, 0), at(r, 1), at(r, 2)]);
    if (r < 11) {
      for (let c = 0; c < 2; c++) add("co", [at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)]);
      add("sl", [at(r, 0), at(r, 1), at(r, 2), at(r + 1, 0), at(r + 1, 1), at(r + 1, 2)]);
    }
  }
  add("sp", [0, 1]); add("sp", [0, 2]); add("sp", [0, 3]);
  add("st", [0, 1, 2]); add("st", [0, 2, 3]);
  add("co", [0, 1, 2, 3]);
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  for (let d = 0; d < 3; d++) add("dz", range(12 * d + 1, 12 * d + 12), `dz:${d + 1}`);
  for (let c = 0; c < 3; c++) add("col", range(0, 11).map((r) => at(r, c)), `col:${c + 1}`);
  const all = range(1, 36);
  add("red", all.filter((n) => RL_RED.has(n)), "red");
  add("black", all.filter((n) => !RL_RED.has(n)), "black");
  add("even", all.filter((n) => n % 2 === 0), "even");
  add("odd", all.filter((n) => n % 2 === 1), "odd");
  add("low", range(1, 18), "low");
  add("high", range(19, 36), "high");
  return bets;
})();

// ключ ставки по набору номеров (внутренние ставки); null — такой ставки нет
function rlKeyFor(numbers) {
  const ns = numbers.slice().sort((a, b) => a - b);
  const type = { 1: "n", 2: "sp", 3: "st", 4: "co", 6: "sl" }[ns.length];
  if (!type) return null;
  const key = `${type}:${ns.join("-")}`;
  return RL_BETS[key] ? key : null;
}

const rlSum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

// ---------- карты, реакции ----------

const RL_CARDS = {
  double: { icon: "☠️" },
  freeze: { icon: "❄️" },
  share: { icon: "🧲" },
  eye: { icon: "🧿" },
  shield: { icon: "🛡" },
};
const RL_REACTIONS = ["🔥", "😱", "😂", "👏", "🙏", "💀"];

// Подписи, общие для доски и пульта: карты, типы ставок, события ленты.
// Страница кладёт свой словарь в I18N_DICT, а эти ключи домешиваются туда до загрузки i18n.js.
const RL_SHARED_I18N = {
  ru: {
    card_double: "Двойной риск", card_double_d: "Все ставки цели на этот спин удваиваются из её фишек.",
    card_freeze: "Заморозка", card_freeze_d: "В следующем спине цель не ставит и платит штраф минимумом.",
    card_share: "Доля", card_share_d: "Если цель выиграет в этом спине, 25% её чистого выигрыша — тебе.",
    card_eye: "Сглаз", card_eye_d: "Если цель проиграет в этом спине, казино заплатит тебе половину её проигрыша.",
    card_shield: "Щит", card_shield_d: "Сработает сам: отменит первую карту против тебя.",
    out_shielded: "Щит отбил", out_busy: "цель уже под ударом — карта вернулась", out_gone: "цели больше нет",
    color_red: "красное", color_black: "чёрное", color_green: "зеро",
    bet_red: "Красное", bet_black: "Чёрное", bet_even: "Чёт", bet_odd: "Нечет", bet_low: "1–18", bet_high: "19–36",
    bet_dz: "{n}-я дюжина", bet_col: "{n}-я колонка", bet_n: "Число {a}", bet_sp: "Сплит {a}", bet_st: "Стрит {a}", bet_co: "Каре {a}", bet_sl: "Сикслайн {a}",
    penalty: "штраф",
    ev_allin: "{name} идёт ва-банк",
    ev_out: "{name} выбывает",
    ev_win: "{name} +{n}",
    ev_level: "Минимум теперь {n}",
    ev_overtime: "Овертайм: минимум — {p}% среднего стека",
    ev_card: "{by} → {target}: {card}",
    ev_penalty: "{name}: штраф {n}",
    ev_frozen: "{name} заморожен(а) на следующий спин",
    err_connect: "Нет связи с сервером, переподключаемся…",
  },
  en: {
    card_double: "Double Risk", card_double_d: "All the target's bets this spin are doubled from their own chips.",
    card_freeze: "Freeze", card_freeze_d: "Next spin the target can't bet and pays the minimum as a penalty.",
    card_share: "Cut", card_share_d: "If the target wins this spin, you get 25% of their net win.",
    card_eye: "Evil Eye", card_eye_d: "If the target loses this spin, the casino pays you half of their loss.",
    card_shield: "Shield", card_shield_d: "Triggers by itself: blocks the first card played on you.",
    out_shielded: "Shield blocked it", out_busy: "target already hit — card returned", out_gone: "target is gone",
    color_red: "red", color_black: "black", color_green: "zero",
    bet_red: "Red", bet_black: "Black", bet_even: "Even", bet_odd: "Odd", bet_low: "1–18", bet_high: "19–36",
    bet_dz: "Dozen {n}", bet_col: "Column {n}", bet_n: "Number {a}", bet_sp: "Split {a}", bet_st: "Street {a}", bet_co: "Corner {a}", bet_sl: "Six line {a}",
    penalty: "penalty",
    ev_allin: "{name} goes all in",
    ev_out: "{name} is out",
    ev_win: "{name} +{n}",
    ev_level: "Minimum is now {n}",
    ev_overtime: "Overtime: minimum is {p}% of the average stack",
    ev_card: "{by} → {target}: {card}",
    ev_penalty: "{name}: penalty {n}",
    ev_frozen: "{name} is frozen next spin",
    err_connect: "No connection, reconnecting…",
  },
  el: {
    card_double: "Διπλό ρίσκο", card_double_d: "Όλα τα πονταρίσματα του στόχου σε αυτό το γύρισμα διπλασιάζονται από τις μάρκες του.",
    card_freeze: "Πάγωμα", card_freeze_d: "Στο επόμενο γύρισμα ο στόχος δεν ποντάρει και πληρώνει ποινή το ελάχιστο.",
    card_share: "Μερίδιο", card_share_d: "Αν ο στόχος κερδίσει σε αυτό το γύρισμα, παίρνεις το 25% του καθαρού κέρδους του.",
    card_eye: "Μάτι", card_eye_d: "Αν ο στόχος χάσει σε αυτό το γύρισμα, το καζίνο σού πληρώνει τη μισή του απώλεια.",
    card_shield: "Ασπίδα", card_shield_d: "Ενεργοποιείται μόνη της: ακυρώνει την πρώτη κάρτα εναντίον σου.",
    out_shielded: "Η ασπίδα την απέκρουσε", out_busy: "ο στόχος έχει ήδη χτυπηθεί — η κάρτα επέστρεψε", out_gone: "ο στόχος δεν υπάρχει πια",
    color_red: "κόκκινο", color_black: "μαύρο", color_green: "μηδέν",
    bet_red: "Κόκκινο", bet_black: "Μαύρο", bet_even: "Ζυγά", bet_odd: "Μονά", bet_low: "1–18", bet_high: "19–36",
    bet_dz: "{n}η δωδεκάδα", bet_col: "{n}η στήλη", bet_n: "Αριθμός {a}", bet_sp: "Σπλιτ {a}", bet_st: "Στριτ {a}", bet_co: "Καρέ {a}", bet_sl: "Εξάδα {a}",
    penalty: "ποινή",
    ev_allin: "{name} πάει all in",
    ev_out: "{name} αποκλείεται",
    ev_win: "{name} +{n}",
    ev_level: "Το ελάχιστο τώρα είναι {n}",
    ev_overtime: "Παράταση: ελάχιστο το {p}% της μέσης στοίβας",
    ev_card: "{by} → {target}: {card}",
    ev_penalty: "{name}: ποινή {n}",
    ev_frozen: "{name} παγώνει στο επόμενο γύρισμα",
    err_connect: "Χωρίς σύνδεση, επανασύνδεση…",
  },
};
(function mergeSharedDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const lang of Object.keys(RL_SHARED_I18N)) d[lang] = Object.assign({}, RL_SHARED_I18N[lang], d[lang] || {});
})();

// Если i18n.js не доехал (блокировщик) — работаем по-русски, а не белым экраном
function rlT(key) {
  if (window.I18N && window.I18N.t) return window.I18N.t(key);
  const d = (window.I18N_DICT || {}).ru || {};
  return key in d ? d[key] : key;
}
const rlTpl = (key, vars) => String(rlT(key)).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const RL_NUM_LOCALE = { ru: "ru-RU", en: "en-US", el: "el-GR" };
const rlNum = (n) => Number(n).toLocaleString(RL_NUM_LOCALE[(window.I18N && window.I18N.lang) || "ru"] || "en-US");

// человеческое имя ставки: «Сплит 17–20», «Красное»
function rlBetName(key) {
  const b = RL_BETS[key];
  if (!b) return key;
  if (["red", "black", "even", "odd", "low", "high"].includes(key)) return rlT("bet_" + key);
  if (b.type === "dz" || b.type === "col") return rlTpl("bet_" + b.type, { n: key.split(":")[1] });
  return rlTpl("bet_" + b.type, { a: b.numbers.join("–") });
}

// ---------- часы сервера ----------
// Смещение «сервер − устройство» по самому быстрому ping/pong (RTT/2); пока замера нет —
// по state (у него задержка только прибавляется, поэтому берём наибольший из недавних).
const rlClock = { offset: null, rtt: Infinity, at: 0, states: [] };
function rlClockSample(serverT, sentAt) {
  const t = Date.now(), rtt = t - sentAt;
  if (!(rtt >= 0) || typeof serverT !== "number") return;
  if (rtt <= rlClock.rtt || t - rlClock.at > 60000) {
    rlClock.rtt = rtt;
    rlClock.offset = serverT + rtt / 2 - t;
    rlClock.at = t;
  }
}
function rlStateSample(serverNow) {
  if (typeof serverNow !== "number") return;
  rlClock.states.push(serverNow - Date.now());
  if (rlClock.states.length > 12) rlClock.states.shift();
}
function rlOffset() {
  const byState = rlClock.states.length ? Math.max.apply(null, rlClock.states) : 0;
  return rlClock.offset != null ? Math.max(rlClock.offset, byState) : byState;
}
const rlNow = () => Date.now() + rlOffset();

// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------

let rlWsBroken = false;
const RL_WS_HANDSHAKE_MS = 5000;
const RL_POLL_FETCH_MS = 28000;
const RL_PROBE_MS = 3000;

function rlOpenTransport({ code, onMessage, onClose, onOpen, onSendFail, onGone }) {
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
    if (m && m.type === "pong") { if (typeof m.c === "number") rlClockSample(m.t, m.c); return; }
    if (m && (m.type === "state" || m.type === "hello") && m.state) rlStateSample(m.state.serverNow);
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
      fetch("/roulette/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
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
      probeTimer = setTimeout(() => { if (!closed && lastSeen < asked) fireClose(); }, ms || RL_PROBE_MS);
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
      const res = await timedFetch(`/roulette/api/session?r=${encodeURIComponent(code)}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/roulette/api/poll?sid=${sid}`, RL_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (rlWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/roulette/ws?r=${encodeURIComponent(code)}`);
    const handshake = setTimeout(() => {
      if (closed || opened || !ws || ws.readyState !== 0) return;
      rlWsBroken = true;
      const dead = ws; ws = null;
      dead.onclose = dead.onmessage = dead.onopen = null;
      try { dead.close(); } catch (e) {}
      startPolling();
    }, RL_WS_HANDSHAKE_MS);
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
function rlConnect({ code, onMessage, onOpen, onGone, onState, onSendFail }) {
  let t = null, delay = 500, stopped = false;
  const holder = { api: null, send: (m) => holder.api && holder.api.send(m), stop() { stopped = true; clearTimeout(t); if (holder.api) holder.api.close(); } };
  const open = () => {
    if (stopped) return;
    if (onState) onState("connecting");
    holder.api = rlOpenTransport({
      code,
      onMessage,
      onOpen: () => { delay = 500; if (onState) onState("open"); if (onOpen) onOpen(); },
      onClose: () => { if (stopped) return; if (onState) onState("lost"); t = setTimeout(open, delay); delay = Math.min(delay * 2, 8000); },
      onGone: () => { stopped = true; if (onGone) onGone(); },
      onSendFail, // сообщение не ушло (сокет закрыт) — страница решает, повторить ли его после переподключения
    });
  };
  open();
  // вернулись в вкладку или сеть появилась — проверяем, жив ли сокет, не дожидаясь 45 с тишины
  const wake = () => { if (holder.api && holder.api.mode !== "none") holder.api.probe(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  window.addEventListener("online", wake);
  return holder;
}

// ---------- фишка цвета игрока: одни переменные для пульта и доски ----------
// --c тело, --cd кант/тень (темнее), --cs пятна на ребре: на светлых фишках тёмные, иначе пятна пропадают
function rlShade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(k < 1 ? v * k : v + (255 - v) * (k - 1))));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}
function rlLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const c = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * c(n >> 16) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255);
}
function rlChipVars(color) {
  const light = rlLum(color) > 0.55;
  return `--c:${color};--cd:${rlShade(color, 0.55)};--cs:${light ? "#2b2118" : "#fff6e2"}`;
}
// высота столбика: чем больше ставка относительно минимума, тем больше фишек в столбике
function rlStackLayers(amount, min) {
  const k = amount / Math.max(1, min);
  return k >= 25 ? 4 : k >= 8 ? 3 : k >= 3 ? 2 : 1;
}

// ---------- звуки интерфейса: короткий синтез без файлов ----------
// Всё идёт в ctx.destination — sound-toggle.js перехватывает это подключение и глушит общий выключатель.
// Контекст создаём на первом касании: без жеста браузер его не запустит.
// Только на касании: раньше его создавал и первый же звук, а на доске это «Ставок больше нет» —
// new AudioContext() занимает 100–150 мс, и колесо замирало ровно на старте спина.
const rlSfx = (function () {
  let ctx = null, noise = null;
  function ac(create) {
    if (ctx) { if (ctx.state === "suspended") ctx.resume().catch(() => {}); return ctx; }
    if (!create) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  ["pointerdown", "keydown"].forEach((t) => window.addEventListener(t, () => ac(true), { passive: true, capture: true }));
  const out = (c, node, vol) => { const g = c.createGain(); g.gain.value = vol; node.connect(g); g.connect(c.destination); return g; };
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
    const g = out(c, o, 1); env(g, t, 0.004, dur, vol);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function hiss(at, dur, vol, type, f, q) {
    const c = ac(); if (!c || c.state !== "running" || !noise) return;
    const t = c.currentTime + at;
    const s = c.createBufferSource(); s.buffer = noise;
    const fl = c.createBiquadFilter(); fl.type = type || "bandpass"; fl.frequency.value = f || 2500; fl.Q.value = q || 1.2;
    s.connect(fl);
    const g = out(c, fl, 1); env(g, t, 0.002, dur, vol);
    s.start(t, Math.random() * 0.2); s.stop(t + dur + 0.05);
  }
  return {
    // глиняная фишка о сукно: сухой щелчок и короткий отскок
    chip() { hiss(0, 0.035, 0.5, "bandpass", 2800, 1.6); tone(520, 380, 0, 0.03, "sine", 0.12); hiss(0.05, 0.025, 0.18, "bandpass", 3400, 2); },
    select() { hiss(0, 0.02, 0.35, "bandpass", 4200, 3); tone(1600, 1900, 0, 0.03, "sine", 0.06); },
    stamp() { tone(140, 55, 0, 0.16, "sine", 0.55); hiss(0, 0.09, 0.35, "lowpass", 700, 0.7); },
    tick(hot) { tone(hot ? 1500 : 1100, hot ? 1400 : 1000, 0, 0.04, "triangle", hot ? 0.16 : 0.08); },
    heart(k) { const v = 0.35 + 0.35 * (k || 0); tone(70, 42, 0, 0.12, "sine", v); tone(64, 40, 0.17, 0.1, "sine", v * 0.7); },
    flip() { hiss(0, 0.12, 0.22, "highpass", 1800, 0.7); tone(300, 180, 0.08, 0.06, "sine", 0.12); },
    pop() { tone(500, 1100, 0, 0.06, "sine", 0.14); },
    sweep() { hiss(0, 0.35, 0.2, "bandpass", 1200, 0.6); },
    win(big) {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, f, i * 0.08, 0.16, "triangle", 0.2));
      const n = big ? 22 : 12;
      for (let i = 0; i < n; i++) tone(2400 + Math.random() * 2200, 0, 0.3 + i * 0.045, 0.06, "sine", 0.06);
    },
    lose() { tone(392, 370, 0, 0.22, "triangle", 0.16); tone(349, 330, 0.25, 0.22, "triangle", 0.16); tone(311, 233, 0.5, 0.5, "triangle", 0.16); },
    zero() { [392, 494, 587].forEach((f) => tone(f, f, 0, 0.6, "sine", 0.1)); tone(784, 784, 0.12, 0.5, "sine", 0.06); },
    freeze() { hiss(0, 0.45, 0.2, "bandpass", 6000, 4); [2093, 2637, 3136].forEach((f, i) => tone(f, f * 0.98, 0.05 + i * 0.07, 0.3, "sine", 0.05)); },
    ding() { tone(1318, 1318, 0, 0.5, "sine", 0.14); tone(1976, 1976, 0.02, 0.4, "sine", 0.06); },
  };
})();
