/* Общий код «Бомбы» для пульта (bomb.html) и доски (bomb-board.html):
   транспорт до сервера, часы сервера, подписи на трёх языках, рисунок бомбы, звуки, проверка печати.
   Транспорт перенесён из roulette-shared.js (а туда — из auction-shared.js): там подробная история решений. */

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

const BM_SHARED_I18N = {
  ru: {
    mode_classic: "Классика", mode_elim: "На выбывание", mode_two: "Две бомбы", mode_quiz: "Эрудит",
    mode_classic_d: "Одна бомба, один взрыв — он и ведёт стендап",
    mode_elim_d: "Взорвался — выбыл. Играем до последнего",
    mode_two_d: "С 6 игроков: две бомбы, первый взрыв решает",
    mode_quiz_d: "Каждое испытание — вопрос на эрудицию",
    fuse_short: "Короткий", fuse_normal: "Обычный", fuse_long: "Длинный",
    fuse_range: "{a}–{b} с",
    grp_hands: "Ловкость", grp_eyes: "Внимание", grp_head: "Голова",
    ch_wires: "режет провода", ch_swipe: "смахивает", ch_hold: "держит кнопку", ch_order: "жмёт по порядку",
    ch_nopress: "не жмёт кнопку", ch_catch: "ловит мишень", ch_color: "угадывает цвет", ch_odd: "ищет лишнего",
    ch_code: "вспоминает код", ch_count: "считает уток", ch_letter: "ищет букву", ch_sad: "ищет грустного",
    ch_quiz: "отвечает на вопрос", ch_sudoku: "решает судоку", ch_seq: "продолжает ряд", ch_math: "считает в уме",
    ch_tf: "решает: правда или враньё", ch_heavy: "взвешивает", ch_chrono: "вспоминает историю",
    color_red: "КРАСНЫЙ", color_blue: "СИНИЙ", color_green: "ЗЕЛЁНЫЙ", color_yellow: "ЖЁЛТЫЙ", color_purple: "ФИОЛЕТОВЫЙ", color_orange: "ОРАНЖЕВЫЙ",
    days: "Пн|Вт|Ср|Чт|Пт|Сб|Вс",
    q_true: "Правда", q_false: "Враньё",
    seal_title: "Печать раунда",
    seal_line: "Время взрыва запечатано до старта — после взрыва печать вскроем и сверим",
    seal_ok: "Печать совпала: время взрыва было задано до старта",
    seal_bad: "Печать не совпала!",
    seal_check: "Проверка…",
    seal_fuse: "Фитиль: {n} с",
    standup_sub: "Стендап ведёт: {name}",
    sec_s: "{s} с",
    err_connect: "Нет связи с сервером, переподключаемся…",
  },
  en: {
    mode_classic: "Classic", mode_elim: "Elimination", mode_two: "Two bombs", mode_quiz: "Brainiac",
    mode_classic_d: "One bomb, one blast — that person hosts the stand-up",
    mode_elim_d: "Blown up — you're out. Last one standing wins",
    mode_two_d: "6+ players: two bombs, first blast decides",
    mode_quiz_d: "Every challenge is a trivia question",
    fuse_short: "Short", fuse_normal: "Normal", fuse_long: "Long",
    fuse_range: "{a}–{b} s",
    grp_hands: "Reflexes", grp_eyes: "Attention", grp_head: "Brains",
    ch_wires: "is cutting wires", ch_swipe: "is swiping", ch_hold: "is holding the button", ch_order: "is tapping in order",
    ch_nopress: "is NOT pressing", ch_catch: "is catching the target", ch_color: "is naming the colour", ch_odd: "is spotting the odd one",
    ch_code: "is recalling the code", ch_count: "is counting ducks", ch_letter: "is hunting a letter", ch_sad: "is finding the sad one",
    ch_quiz: "is answering a question", ch_sudoku: "is solving sudoku", ch_seq: "is continuing the pattern", ch_math: "is doing maths",
    ch_tf: "is deciding: true or false", ch_heavy: "is weighing things up", ch_chrono: "is sorting history",
    color_red: "RED", color_blue: "BLUE", color_green: "GREEN", color_yellow: "YELLOW", color_purple: "PURPLE", color_orange: "ORANGE",
    days: "Mon|Tue|Wed|Thu|Fri|Sat|Sun",
    q_true: "True", q_false: "False",
    seal_title: "Round seal",
    seal_line: "The blast time is sealed before the start — we'll open the seal after the blast and check",
    seal_ok: "Seal matches: the blast time was set before the start",
    seal_bad: "Seal does NOT match!",
    seal_check: "Checking…",
    seal_fuse: "Fuse: {n} s",
    standup_sub: "Stand-up host: {name}",
    sec_s: "{s} s",
    err_connect: "No connection, reconnecting…",
  },
  el: {
    mode_classic: "Κλασικό", mode_elim: "Αποκλεισμός", mode_two: "Δύο βόμβες", mode_quiz: "Γνώσεις",
    mode_classic_d: "Μία βόμβα, μία έκρηξη — αυτός κάνει το stand-up",
    mode_elim_d: "Έσκασε — αποκλείεται. Ως τον τελευταίο",
    mode_two_d: "Από 6 παίκτες: δύο βόμβες, κρίνει η πρώτη έκρηξη",
    mode_quiz_d: "Κάθε δοκιμασία είναι ερώτηση γνώσεων",
    fuse_short: "Κοντό", fuse_normal: "Κανονικό", fuse_long: "Μακρύ",
    fuse_range: "{a}–{b} δ",
    grp_hands: "Αντανακλαστικά", grp_eyes: "Προσοχή", grp_head: "Μυαλό",
    ch_wires: "κόβει καλώδια", ch_swipe: "σέρνει", ch_hold: "κρατά το κουμπί", ch_order: "πατά με τη σειρά",
    ch_nopress: "ΔΕΝ πατά", ch_catch: "πιάνει τον στόχο", ch_color: "βρίσκει το χρώμα", ch_odd: "ψάχνει το παράταιρο",
    ch_code: "θυμάται τον κωδικό", ch_count: "μετρά πάπιες", ch_letter: "ψάχνει γράμμα", ch_sad: "ψάχνει τον λυπημένο",
    ch_quiz: "απαντά σε ερώτηση", ch_sudoku: "λύνει σουντόκου", ch_seq: "συνεχίζει τη σειρά", ch_math: "κάνει πράξεις",
    ch_tf: "αποφασίζει: αλήθεια ή ψέμα", ch_heavy: "ζυγίζει", ch_chrono: "βάζει σε σειρά την ιστορία",
    color_red: "ΚΟΚΚΙΝΟ", color_blue: "ΜΠΛΕ", color_green: "ΠΡΑΣΙΝΟ", color_yellow: "ΚΙΤΡΙΝΟ", color_purple: "ΜΩΒ", color_orange: "ΠΟΡΤΟΚΑΛΙ",
    days: "Δευ|Τρί|Τετ|Πέμ|Παρ|Σάβ|Κυρ",
    q_true: "Αλήθεια", q_false: "Ψέμα",
    seal_title: "Σφραγίδα γύρου",
    seal_line: "Η ώρα της έκρηξης σφραγίζεται πριν την αρχή — μετά την έκρηξη την ανοίγουμε και ελέγχουμε",
    seal_ok: "Η σφραγίδα ταιριάζει: η ώρα ορίστηκε πριν την αρχή",
    seal_bad: "Η σφραγίδα ΔΕΝ ταιριάζει!",
    seal_check: "Έλεγχος…",
    seal_fuse: "Φιτίλι: {n} δ",
    standup_sub: "Stand-up κάνει: {name}",
    sec_s: "{s} δ",
    err_connect: "Χωρίς σύνδεση, επανασύνδεση…",
  },
};
(function mergeSharedDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const lang of Object.keys(BM_SHARED_I18N)) d[lang] = Object.assign({}, BM_SHARED_I18N[lang], d[lang] || {});
})();

// Если i18n.js не доехал (блокировщик) — работаем по-русски, а не белым экраном
function bmT(key) {
  if (window.I18N && window.I18N.t) return window.I18N.t(key);
  const d = (window.I18N_DICT || {}).ru || {};
  return key in d ? d[key] : key;
}
const bmTpl = (key, vars) => String(bmT(key)).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const bmLang = () => (window.I18N && window.I18N.lang) || "ru";
// текст из банка вопросов: {ru, en, el}
const bmTx = (o) => (o && typeof o === "object" ? o[bmLang()] || o.en || o.ru || "" : String(o == null ? "" : o));
const bmSec = (ms) => (Math.max(0, ms) / 1000).toFixed(1).replace(".", bmLang() === "en" ? "." : ",");

// Цвета испытания «Цвет»: чернила должны читаться на бумаге
const BM_INK = { red: "#e0271f", blue: "#1f5fd6", green: "#16924a", yellow: "#e2a400", purple: "#8a3fd1", orange: "#f06a0f" };

// ---------- бомба (SVG) ----------
// Фитиль укорачивается к верхней границе диапазона: длина = (max − прошло) / max (§7).
// fuse: 0..1 — доля оставшегося фитиля. Искра — на конце фитиля.
function bmBombSvg(cls) {
  return `<svg class="${cls || "bomb"}" viewBox="0 0 120 120" aria-hidden="true">
    <path class="fuse" d="M78 30 C 86 18, 96 14, 104 18 S 114 4, 108 -2" fill="none" stroke="#6b4a24" stroke-width="4" stroke-linecap="round"/>
    <g class="spark"><circle r="5" fill="#ffd21a"/><circle r="2.6" fill="#fff"/>
      <path d="M0 -11 L2 -3 L10 -6 L4 0 L11 5 L2 3 L0 11 L-2 3 L-10 6 L-4 0 L-11 -5 L-2 -3Z" fill="#ff8a00"/></g>
    <rect x="66" y="26" width="20" height="14" rx="2" transform="rotate(38 76 33)" fill="#2a2622" stroke="#16120c" stroke-width="3"/>
    <circle cx="54" cy="70" r="40" fill="#23201c" stroke="#16120c" stroke-width="4"/>
    <path d="M30 56 A 28 28 0 0 1 50 38" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".55"/>
  </svg>`;
}
// Поставить длину фитиля и искру на конец: path.getTotalLength есть у всех браузеров с SVG
function bmSetFuse(svg, frac) {
  if (!svg) return;
  const path = svg.querySelector(".fuse"), spark = svg.querySelector(".spark");
  if (!path || !spark) return;
  const len = path.getTotalLength();
  const k = Math.max(0.04, Math.min(1, frac));
  path.style.strokeDasharray = `${len * k} ${len}`;
  const p = path.getPointAtLength(len * k);
  spark.setAttribute("transform", `translate(${p.x} ${p.y})`);
}
// доля оставшегося фитиля по публичным данным: сколько прошло и верхняя граница
function bmFuseLeft(state, now) {
  if (!state || !state.startedAt || state.phase !== "live") return state && state.phase === "countdown" ? 1 : 0;
  const max = state.fuse.max * 1000;
  return Math.max(0, (max - (now - state.startedAt)) / max);
}

// ---------- проверка печати ----------
// sha256 в браузере; crypto.subtle есть только в защищённом контексте — иначе считаем сами
async function bmSha256(str) {
  const data = new TextEncoder().encode(str);
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return bmSha256Js(data);
}
function bmSha256Js(bytes) {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(n);
  m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 4, l * 8); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
  const w = new Uint32Array(64);
  const r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}
// {ok: true|false} по раскрытой печати
async function bmVerifySeal(seal) {
  if (!seal || !seal.revealed || !seal.seal) return null;
  try { return (await bmSha256(seal.seal)) === seal.commit; } catch (e) { return null; }
}

// ---------- звуки: короткий синтез без файлов ----------
// Всё идёт в ctx.destination — sound-toggle.js перехватывает это подключение и глушит общий выключатель.
const bmSfx = (function () {
  let ctx = null, noise = null;
  function ac() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume().catch(() => {}); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
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
    s.start(t, Math.random() * 0.2); s.stop(t + dur + 0.05);
  }
  return {
    tick(hot) { tone(hot ? 1900 : 1500, hot ? 1700 : 1350, 0, 0.03, "square", hot ? 0.07 : 0.045); },
    whoosh() { hiss(0, 0.35, 0.28, "bandpass", 900, 0.8, 0.08); },
    catch() { tone(220, 140, 0, 0.12, "sine", 0.35); hiss(0, 0.05, 0.25, "lowpass", 900, 0.7); },
    buzz() { tone(140, 120, 0, 0.22, "sawtooth", 0.12); },
    ok() { tone(880, 1320, 0, 0.09, "triangle", 0.16); tone(1320, 1760, 0.08, 0.1, "triangle", 0.12); },
    tap() { tone(700, 900, 0, 0.03, "triangle", 0.08); },
    boom() {
      hiss(0, 1.1, 0.9, "lowpass", 380, 0.6, 0.004);
      tone(90, 30, 0, 0.9, "sine", 0.9);
      hiss(0.02, 0.35, 0.5, "bandpass", 1600, 0.5);
    },
    pop() { tone(500, 1100, 0, 0.06, "sine", 0.14); },
    count(last) { tone(last ? 1046 : 523, last ? 1046 : 523, 0, last ? 0.35 : 0.12, "triangle", 0.2); },
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
function bmVibrate(p) { if (navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} }

// ---------- часы сервера ----------
// Смещение «сервер − устройство» по самому быстрому ping/pong (RTT/2); пока замера нет —
// по state (у него задержка только прибавляется, поэтому берём наибольший из недавних).
const bmClock = { offset: null, rtt: Infinity, at: 0, states: [] };
function bmClockSample(serverT, sentAt) {
  const t = Date.now(), rtt = t - sentAt;
  if (!(rtt >= 0) || typeof serverT !== "number") return;
  if (rtt <= bmClock.rtt || t - bmClock.at > 60000) {
    bmClock.rtt = rtt;
    bmClock.offset = serverT + rtt / 2 - t;
    bmClock.at = t;
  }
}
function bmStateSample(serverNow) {
  if (typeof serverNow !== "number") return;
  bmClock.states.push(serverNow - Date.now());
  if (bmClock.states.length > 12) bmClock.states.shift();
}
function bmOffset() {
  const byState = bmClock.states.length ? Math.max.apply(null, bmClock.states) : 0;
  return bmClock.offset != null ? Math.max(bmClock.offset, byState) : byState;
}
const bmNow = () => Date.now() + bmOffset();

// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------

let bmWsBroken = false;
const BM_WS_HANDSHAKE_MS = 5000;
const BM_POLL_FETCH_MS = 28000;
const BM_PROBE_MS = 3000;

function bmOpenTransport({ code, onMessage, onClose, onOpen, onSendFail, onGone }) {
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
    if (m && m.type === "pong") { if (typeof m.c === "number") bmClockSample(m.t, m.c); return; }
    if (m && (m.type === "state" || m.type === "hello") && m.state) bmStateSample(m.state.serverNow);
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
      fetch("/bomb/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
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
      const res = await timedFetch(`/bomb/api/session?r=${encodeURIComponent(code)}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/bomb/api/poll?sid=${sid}`, BM_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (bmWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/bomb/ws?r=${encodeURIComponent(code)}`);
    const handshake = setTimeout(() => {
      if (closed || opened || !ws || ws.readyState !== 0) return;
      bmWsBroken = true;
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
function bmConnect({ code, onMessage, onOpen, onGone, onState }) {
  let t = null, delay = 500, stopped = false;
  const holder = { api: null, send: (m) => holder.api && holder.api.send(m), stop() { stopped = true; clearTimeout(t); if (holder.api) holder.api.close(); } };
  const open = () => {
    if (stopped) return;
    if (onState) onState("connecting");
    holder.api = bmOpenTransport({
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

