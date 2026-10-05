/* Общий код «Вопроса ребром» для пульта (quip.html) и доски (quip-board.html):
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

const QP_SHARED_I18N = {
  ru: {
    game_name: "Вопрос ребром",
    r_duel: "Дуэли", r_duel2: "Дуэли: второй круг", r_emoji: "Эмодзи-сцена", r_final: "Финал: три ответа",
    r_duel_small: "Вопросы на всех", r_duel2_small: "Ещё вопросы на всех",
    r_duel2_d: "Второй круг, новые соперники. Очки ×2",
    r_duel2_small_d: "Ещё два вопроса на всех. Очки ×2",
    q_n: "Вопрос {i} из {n}",
    no_votes: "Никто не проголосовал",
    r_duel_d: "Каждому два вопроса, на каждый отвечает ещё кто-то один. Зал выбирает смешнее",
    r_duel_small_d: "Два вопроса на всех. Голосуй за самый смешной — за свой нельзя",
    r_emoji_d: "Одна сцена на всех — придумай подпись. Очки ×2",
    r_final_d: "Один вопрос, ответ — три пункта. Очки ×3",
    round_n: "Раунд {n}",
    mult: "×{n}",
    jinx: "ДЖИНКС!", jinx_d: "Одинаковые ответы — оба по нулям",
    sweep: "РАЗГРОМ!",
    hint_mark: "подсказка", late_mark: "не успел",
    pts: "+{n}",
    votes_n: "{n} гол.",
    sec: "{s} с",
    podium: "Итоги",
    best: "Ответ вечера", hint_star: "Подсказка смешнее всех", fastest: "Самый быстрый",
    avg_s: "в среднем {s} с",
    err_connect: "Нет связи с сервером, переподключаемся…",
  },
  en: {
    game_name: "Point Blank",
    r_duel: "Duels", r_duel2: "Duels: round two", r_emoji: "Emoji Scene", r_final: "Final: three answers",
    r_duel_small: "Prompts for all", r_duel2_small: "More prompts for all",
    r_duel2_d: "Round two, new rivals. Points ×2",
    r_duel2_small_d: "Two more prompts for everyone. Points ×2",
    q_n: "Prompt {i} of {n}",
    no_votes: "Nobody voted",
    r_duel_d: "Two prompts each, one rival per prompt. The room picks the funnier one",
    r_duel_small_d: "Two prompts for everyone. Vote for the funniest — not your own",
    r_emoji_d: "One scene for everyone — write a caption. Points ×2",
    r_final_d: "One prompt, answer with three items. Points ×3",
    round_n: "Round {n}",
    mult: "×{n}",
    jinx: "JINX!", jinx_d: "Same answers — both score zero",
    sweep: "CLEAN SWEEP!",
    hint_mark: "hint", late_mark: "too slow",
    pts: "+{n}",
    votes_n: "{n} votes",
    sec: "{s} s",
    podium: "Results",
    best: "Line of the night", hint_star: "Funniest hint", fastest: "Fastest",
    avg_s: "avg {s} s",
    err_connect: "No connection, reconnecting…",
  },
  el: {
    game_name: "Ευθέως",
    r_duel: "Μονομαχίες", r_duel2: "Μονομαχίες: δεύτερος γύρος", r_emoji: "Σκηνή με emoji", r_final: "Τελικός: τρεις απαντήσεις",
    r_duel_small: "Ερωτήσεις για όλους", r_duel2_small: "Κι άλλες ερωτήσεις για όλους",
    r_duel2_d: "Δεύτερος γύρος, νέοι αντίπαλοι. Πόντοι ×2",
    r_duel2_small_d: "Άλλες δύο ερωτήσεις για όλους. Πόντοι ×2",
    q_n: "Ερώτηση {i} από {n}",
    no_votes: "Κανείς δεν ψήφισε",
    r_duel_d: "Δύο ερωτήσεις ο καθένας, σε κάθε μία απαντά κι ένας αντίπαλος. Η αίθουσα διαλέγει το πιο αστείο",
    r_duel_small_d: "Δύο ερωτήσεις για όλους. Ψήφισε το πιο αστείο — όχι το δικό σου",
    r_emoji_d: "Μία σκηνή για όλους — γράψε λεζάντα. Πόντοι ×2",
    r_final_d: "Μία ερώτηση, απάντηση σε τρία σημεία. Πόντοι ×3",
    round_n: "Γύρος {n}",
    mult: "×{n}",
    jinx: "ΤΖΙΝΞ!", jinx_d: "Ίδιες απαντήσεις — μηδέν και οι δύο",
    sweep: "ΣΑΡΩΣΕ!",
    hint_mark: "βοήθεια", late_mark: "άργησε",
    pts: "+{n}",
    votes_n: "{n} ψήφοι",
    sec: "{s} δ",
    podium: "Αποτελέσματα",
    best: "Η ατάκα της βραδιάς", hint_star: "Η πιο αστεία βοήθεια", fastest: "Πιο γρήγορο χέρι",
    avg_s: "μ.ό. {s} δ",
    err_connect: "Χωρίς σύνδεση, επανασύνδεση…",
  },
};
(function mergeSharedDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const lang of Object.keys(QP_SHARED_I18N)) d[lang] = Object.assign({}, QP_SHARED_I18N[lang], d[lang] || {});
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

// ответ как текст: строка или три пункта
function qpAnswerHtml(a) {
  if (!a) return "";
  if (a.items) return `<ol class="items">${a.items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>`;
  return escapeHtml(a.text);
}
// вопрос: текст или сцена из эмодзи
function qpPromptHtml(p) {
  if (!p) return "";
  return p.e ? `<span class="scene">${escapeHtml(p.e)}</span>` : escapeHtml(p.q);
}
// название раунда и описание (дуэли при 3–4 игроках — «на всех»)
// раунды дуэлей при 3–4 игроках идут «на всех» — и называются так же
const qpDuelKey = (key) => key === "duel" || key === "duel2";
function qpRoundName(key, small) { return qpT("r_" + key + (small && qpDuelKey(key) ? "_small" : "")); }
function qpRoundDesc(key, small) { return qpT("r_" + key + (small && qpDuelKey(key) ? "_small" : "") + "_d"); }

// «1 голос / 2 голоса / 5 голосов», «1 vote», «1 ψήφος»
function qpVotes(n) {
  const L = qpLang();
  if (L === "en") return n + (n === 1 ? " vote" : " votes");
  if (L === "el") return n + (n === 1 ? " ψήφος" : " ψήφοι");
  const m10 = n % 10, m100 = n % 100;
  return n + (m10 === 1 && m100 !== 11 ? " голос" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? " голоса" : " голосов");
}
// место: «2 место», «2nd place», «2η θέση»
function qpPlace(n) {
  const L = qpLang();
  if (L === "en") { const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"; return `${n}${s} place`; }
  if (L === "el") return `${n}η θέση`;
  return `${n} место`;
}
// Места с ничьими: равные очки — одно место; порядок одинаковый на доске и телефоне (очки, потом имя)
function qpRanked(players) {
  const list = players.filter((p) => !p.left).slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  list.forEach((p, i) => { p.place = i && list[i - 1].score === p.score ? list[i - 1].place : i + 1; });
  return list;
}

// ---------- звуки: короткий синтез без файлов ----------
// Звук телешоу: деревянная коробочка на последних секундах, «дзынь» сдавшему, дробь перед раскрытием,
// медные фанфары за разгром и итоги, грустный тромбон «уа-уа-уа» за джинкс.
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
  const live = () => { const c = ac(); return c && c.state === "running" ? c : null; };
  function env(g, t, a, d, v) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function tone(f0, f1, at, dur, type, vol) {
    const c = live(); if (!c) return;
    const t = c.currentTime + at;
    const o = c.createOscillator(); o.type = type || "sine";
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); o.connect(g); g.connect(c.destination); env(g, t, 0.004, dur, vol);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function hiss(at, dur, vol, type, f, q, attack) {
    const c = live(); if (!c || !noise) return;
    const t = c.currentTime + at;
    const s = c.createBufferSource(); s.buffer = noise;
    const fl = c.createBiquadFilter(); fl.type = type || "bandpass"; fl.frequency.value = f || 2500; fl.Q.value = q || 1.2;
    const g = c.createGain(); s.connect(fl); fl.connect(g); g.connect(c.destination); env(g, t, attack || 0.002, dur, vol);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  // «медь»: две расстроенные пилы через фильтр, который раскрывается на атаке — как труба в студийном оркестре
  function brass(f, at, dur, vol, bend, vib) {
    const c = live(); if (!c) return;
    const t = c.currentTime + at;
    const fl = c.createBiquadFilter(); fl.type = "lowpass"; fl.Q.value = 2;
    fl.frequency.setValueAtTime(500, t); fl.frequency.exponentialRampToValueAtTime(2600, t + 0.06); fl.frequency.exponentialRampToValueAtTime(1300, t + dur);
    const g = c.createGain(); fl.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    g.gain.setValueAtTime(vol, t + Math.max(0.04, dur - 0.08)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    [-6, 6].forEach((det) => {
      const o = c.createOscillator(); o.type = "sawtooth"; o.detune.value = det;
      o.frequency.setValueAtTime(f, t);
      if (bend) o.frequency.exponentialRampToValueAtTime(f * bend, t + dur);
      if (vib) {
        const l = c.createOscillator(), lg = c.createGain();
        l.frequency.value = 5.5; lg.gain.value = f * 0.025; l.connect(lg); lg.connect(o.frequency);
        l.start(t); l.stop(t + dur + 0.1);
      }
      o.connect(fl); o.start(t); o.stop(t + dur + 0.1);
    });
  }
  return {
    // деревянная коробочка: последние пять секунд
    tick(hot) { tone(hot ? 1900 : 1500, hot ? 1250 : 1000, 0, 0.035, "triangle", hot ? 0.16 : 0.1); hiss(0, 0.015, hot ? 0.12 : 0.07, "bandpass", 3200, 3); },
    tap() { tone(700, 1000, 0, 0.035, "triangle", 0.09); },
    send() { tone(660, 990, 0, 0.08, "triangle", 0.14); tone(990, 1480, 0.07, 0.12, "triangle", 0.11); },
    // «боинг»: кто-то зашёл в студию
    pop() { tone(260, 820, 0, 0.09, "sine", 0.18); tone(820, 560, 0.09, 0.12, "sine", 0.1); },
    // «дзынь»: участник сдал ответ
    ding() { tone(1319, 1319, 0, 0.5, "sine", 0.12); tone(2637, 2637, 0, 0.25, "sine", 0.04); },
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
    // джинкс: грустный тромбон «уа-уа-уа-уаааа»
    jinx() { [311, 294, 277].forEach((f, i) => brass(f, i * 0.28, 0.24, 0.1)); brass(262, 0.84, 0.8, 0.1, 0.94, true); },
    // разгром: короткие фанфары
    sweep() { [392, 523, 659].forEach((f, i) => brass(f, i * 0.1, 0.1, 0.09)); [523, 659, 784].forEach((f) => brass(f, 0.32, 0.55, 0.07)); },
    // итоги шоу: фанфары подлиннее
    fanfare() {
      [[392, 0], [392, 0.12], [392, 0.24], [523, 0.36]].forEach(([f, t]) => brass(f, t, 0.1, 0.09));
      [[659, 0.62], [587, 0.8], [659, 0.98]].forEach(([f, t]) => brass(f, t, 0.15, 0.08));
      [523, 659, 784, 1046].forEach((f) => brass(f, 1.2, 0.9, 0.06));
      hiss(1.2, 0.8, 0.3, "highpass", 6000, 0.7, 0.003);
    },
    buzz() { tone(140, 120, 0, 0.22, "sawtooth", 0.12); },
    flip() { hiss(0, 0.12, 0.3, "bandpass", 3000, 0.8, 0.01); tone(400, 800, 0.02, 0.06, "sine", 0.08); },
  };
})();

// ---------- конфетти: своё, на холсте, без библиотек ----------
// qpConfetti({ x, y, n, mode: "burst" | "rain" }) — хлопушка из точки или дождь сверху; сам убирает холст.
// При reduced-motion не стреляет: результат и так виден по штампам и подписям.
function qpConfetti(o) {
  o = Object.assign({ x: innerWidth / 2, y: innerHeight / 2, n: 120, mode: "burst", power: 1 }, o || {});
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = document.createElement("canvas");
  cv.className = "qp-confetti";
  cv.setAttribute("aria-hidden", "true");
  cv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = innerWidth, H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  document.body.append(cv);
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  const colors = ["#ffe14d", "#ff2e74", "#12b8a6", "#fff6ec", "#3ee6a8", "#ff8a3d"];
  const k = Math.max(0.6, Math.min(1.4, W / 1400));
  const ps = Array.from({ length: o.n }, () => {
    const rain = o.mode === "rain";
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const sp = (7 + Math.random() * 12) * o.power * k;
    return {
      x: rain ? Math.random() * W : o.x + (Math.random() - 0.5) * 30,
      y: rain ? -20 - Math.random() * H * 0.5 : o.y,
      vx: rain ? (Math.random() - 0.5) * 2 : Math.cos(a) * sp,
      vy: rain ? 2 + Math.random() * 3 : Math.sin(a) * sp,
      w: (7 + Math.random() * 8) * k, h: (4 + Math.random() * 6) * k,
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.35,
      wob: Math.random() * 6.28, c: colors[(Math.random() * colors.length) | 0], round: Math.random() < 0.25,
    };
  });
  const t0 = performance.now();
  const step = (now) => {
    if (!cv.isConnected) return;
    g.clearRect(0, 0, W, H);
    let alive = 0;
    for (const p of ps) {
      p.vy += 0.32 * k; p.vx *= 0.985; p.vy *= 0.985;
      p.wob += 0.12; p.x += p.vx + Math.sin(p.wob) * 0.6; p.y += p.vy; p.r += p.vr;
      if (p.y < H + 30) alive++;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c;
      // «переворот» бумажки: ширина пульсирует
      const sx = Math.abs(Math.cos(p.wob));
      if (p.round) { g.beginPath(); g.arc(0, 0, p.h * 0.7, 0, 6.28); g.fill(); } else g.fillRect(-p.w / 2 * sx, -p.h / 2, p.w * sx, p.h);
      g.restore();
    }
    if (alive && now - t0 < 6000) requestAnimationFrame(step); else cv.remove();
  };
  requestAnimationFrame(step);
}
// Сменилась схватка или фаза — конфетти прошлого момента не должно сыпаться на следующий:
// холсты быстро гаснут и убираются (их цикл сам останавливается, когда холст снят со страницы).
function qpConfettiClear() {
  document.querySelectorAll("canvas.qp-confetti").forEach((cv) => {
    if (cv.dataset.gone) return;
    cv.dataset.gone = "1";
    cv.style.transition = "opacity .2s";
    cv.style.opacity = "0";
    setTimeout(() => cv.remove(), 220);
  });
}

// ---------- ведущий шоу: кубик Ребрик, стоящий на ребре ----------
// «Вопрос ребром» буквально: жёлтый кубик балансирует на ребре и ведёт шоу с микрофоном.
// Рисуем сами, а не эмодзи: персонаж должен быть один и тот же на ТВ и в телефоне.
function qpHostSvg(cls) {
  return `<svg class="rebrik${cls ? " " + cls : ""}" viewBox="0 0 220 250" aria-hidden="true" focusable="false">
  <ellipse class="h-shadow" cx="112" cy="238" rx="54" ry="9" fill="rgba(61,11,22,.35)"/>
  <g class="h-body">
    <path d="M108 20 L128 8 L214 94 L194 106 Z" fill="#fff09a"/>
    <path d="M194 106 L214 94 L128 214 L108 226 Z" fill="#e0a100"/>
    <path d="M108 20 L194 106 L108 226 L22 106 Z" fill="#ffd23f"/>
    <path d="M108 20 L194 106 L108 226 L22 106 Z" fill="none" stroke="#2a0810" stroke-width="7" stroke-linejoin="round"/>
    <path d="M108 20 L128 8 L214 94 L128 214 L108 226" fill="none" stroke="#2a0810" stroke-width="7" stroke-linejoin="round"/>
    <path d="M194 106 L214 94" stroke="#2a0810" stroke-width="5"/>
    <g class="h-eyes">
      <ellipse cx="86" cy="92" rx="15" ry="17" fill="#fff" stroke="#2a0810" stroke-width="5"/>
      <ellipse cx="130" cy="92" rx="15" ry="17" fill="#fff" stroke="#2a0810" stroke-width="5"/>
      <circle class="h-pupil" cx="90" cy="95" r="7" fill="#2a0810"/>
      <circle class="h-pupil" cx="134" cy="95" r="7" fill="#2a0810"/>
    </g>
    <path d="M70 66 Q84 58 98 64 M118 64 Q132 58 146 66" stroke="#2a0810" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M84 124 Q108 158 132 124 Z" fill="#7a0f24" stroke="#2a0810" stroke-width="6" stroke-linejoin="round"/>
    <path d="M96 140 Q108 150 120 140" stroke="#ff6f9c" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M108 180 L86 168 L86 194 Z M108 180 L130 168 L130 194 Z" fill="#ff2e74" stroke="#2a0810" stroke-width="5" stroke-linejoin="round"/>
    <circle cx="108" cy="181" r="7" fill="#ff2e74" stroke="#2a0810" stroke-width="5"/>
    <g class="h-arm">
      <path d="M42 128 Q22 140 20 160" stroke="#2a0810" stroke-width="7" fill="none" stroke-linecap="round"/>
      <rect x="10" y="156" width="16" height="30" rx="6" fill="#2a0810" transform="rotate(-18 18 170)"/>
      <circle cx="16" cy="152" r="12" fill="#c9c3cf" stroke="#2a0810" stroke-width="5"/>
    </g>
    <path d="M178 128 Q200 118 206 96" stroke="#2a0810" stroke-width="7" fill="none" stroke-linecap="round"/>
  </g>
</svg>`;
}

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
      // на пульте он absolute (уезжает с шапкой) — его место от верха страницы, а не окна
      const top = r.top + (getComputedStyle(sw).position === "fixed" ? 0 : window.scrollY);
      root.setProperty("--lsc", Math.round(top + r.height / 2) + "px");
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
function qpVibrate(p) { if (navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} }

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
      fetch("/quip/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
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
      const res = await timedFetch(`/quip/api/session?r=${encodeURIComponent(code)}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/quip/api/poll?sid=${sid}`, BM_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (qpWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/quip/ws?r=${encodeURIComponent(code)}`);
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

