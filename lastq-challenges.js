/* Испытания Камеры «Последнего вопроса» на телефоне (lastq-spec.md §4).
   Форк экранов испытаний из bomb.html: бомбовые взяты как есть, к ним добавлены свои испытания побега.
   Дальше живут отдельно от «Бомбы» — правка здесь бомбу не трогает и наоборот.

   Подключение: <link rel="stylesheet" href="lastq-challenges.css"> + <script src="lastq-challenges.js">.
   Строки домешиваются в window.I18N_DICT до загрузки i18n.js (как в bomb-shared.js).

   LQC.mount(c, pad, task, ctx) — нарисовать испытание c (как его отдаёт сервер, + c.at — момент выдачи по часам сервера)
   в контейнер pad, текст задания — в task. ctx:
     submit(ans)       — отправить ответ (страница сама ждёт minMs, как submit в bomb.html);
     wrong()           — сыграть «мимо» (звук + тряска) без ответа;
     now()             — часы сервера, мс;
     solved()          — ответ уже ушёл;
     playerName(id)    — имя игрока (для «Передачки»);
     sfx { tap, tick, pop, buzz }, vibrate(p) — необязательно.
   LQC.update(c, pad, task) — тот же тип, новый view (у «Передачки» код переезжает на доску).
   LQC.bars(pad, ms) — решётка после ошибки (§4.1): закрывает pad на ms и снимается сама. */
(function () {
"use strict";

let K = null;
const noop = () => {};
const sfx = {
  tap: () => (K.sfx && K.sfx.tap ? K.sfx.tap() : noop()),
  tick: (h) => (K.sfx && K.sfx.tick ? K.sfx.tick(h) : noop()),
  pop: () => (K.sfx && K.sfx.pop ? K.sfx.pop() : noop()),
  buzz: () => (K.sfx && K.sfx.buzz ? K.sfx.buzz() : noop()),
};
const vibrate = (p) => { if (K.vibrate) K.vibrate(p); else if (navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} };
const submit = (ans) => K.submit(ans);
const flashWrong = () => (K.wrong ? K.wrong() : sfx.buzz());

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const lang = () => (window.I18N && window.I18N.lang) || "ru";
function T(key) {
  if (window.I18N && window.I18N.t) return window.I18N.t(key);
  const d = (window.I18N_DICT || {}).ru || {};
  return key in d ? d[key] : key;
}
const tpl = (key, vars) => String(T(key)).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
// Ключ по числу: key1 (1 раз), key (2 раза), key5 (5 раз). По-русски 21 — «раз», 22 — «раза»; в EN/EL только 1 или много.
function pluralKey(key, n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (lang() !== "ru") return n === 1 ? key + "1" : key + "5";
  if (b === 1 && a !== 11) return key + "1";
  if (b >= 2 && b <= 4 && (a < 12 || a > 14)) return key;
  return key + "5";
}
const tplN = (key, n, vars) => tpl(pluralKey(key, n), Object.assign({ n }, vars));
// текст из банка вопросов: {ru, en, el}
const tx = (o) => (o && typeof o === "object" ? o[lang()] || o.en || o.ru || "" : String(o == null ? "" : o));
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// треугольная волна — та же, что в lastq/challenges.js (штифты «Отмычки», луч «Прожектора»)
function tri(x) { const f = ((x % 1) + 1) % 1; return f < 0.5 ? f * 2 : 2 - f * 2; }

// Провода «Инструкции сапёра» и чернила «Цвета» — из bomb-shared.js
const WIRE = { red: "#e0271f", blue: "#1f5fd6", yellow: "#ffc21a", green: "#16924a", white: "#ffffff", black: "#16120c" };
const INK = { red: "#e0271f", blue: "#1f5fd6", green: "#16924a", yellow: "#e2a400", purple: "#8a3fd1", orange: "#f06a0f" };

// ---------- рисунки своих испытаний ----------

// Фоторобот «Опознания»: шляпа 0–3 (нет, кепка, цилиндр, шапка с помпоном), очки 0–2 (нет, круглые, квадратные), усы 0–2 (нет, тонкие, густые).
// Свой SVG, не эмодзи: эмодзи-слои на iOS и Android рисуются по-разному, а усов в эмодзи нет.
function faceSvg(f) {
  const S = 'stroke="#16120c" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"';
  const hat = [
    "",
    `<path d="M24 40 Q50 14 76 40 Z" fill="#1e6fd9" ${S}/><path d="M66 40 H92" ${S} fill="none"/>`,
    `<rect x="32" y="8" width="36" height="30" fill="#16120c" ${S}/><path d="M20 38 H80" ${S} stroke-width="5"/>`,
    `<path d="M26 42 Q50 10 74 42 Z" fill="#e8322b" ${S}/><circle cx="50" cy="16" r="6" fill="#fff" ${S}/>`,
  ][f.h];
  const glasses = [
    "",
    `<circle cx="39" cy="54" r="8" fill="#fff8" ${S}/><circle cx="61" cy="54" r="8" fill="#fff8" ${S}/><path d="M47 54 H53" ${S}/>`,
    `<rect x="29" y="47" width="18" height="13" fill="#fff8" ${S}/><rect x="53" y="47" width="18" height="13" fill="#fff8" ${S}/><path d="M47 52 H53" ${S}/>`,
  ][f.g];
  const stache = [
    "",
    `<path d="M40 70 Q50 65 60 70" fill="none" ${S}/>`,
    `<path d="M34 72 Q42 62 50 68 Q58 62 66 72 Q58 70 50 72 Q42 70 34 72 Z" fill="#4a2c12" ${S}/>`,
  ][f.m];
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <ellipse cx="50" cy="58" rx="27" ry="31" fill="#f2c89b" ${S}/>
    <circle cx="39" cy="54" r="3" fill="#16120c"/><circle cx="61" cy="54" r="3" fill="#16120c"/>
    <path d="M42 80 Q50 85 58 80" fill="none" ${S}/>
    ${stache}${glasses}${hat}
  </svg>`;
}

// Бородка ключа «Связки ключей»: зубцы высотой 1–4 слева направо. lock=true — скважина замка (тот же профиль, тёмный).
function keySvg(cuts, lock) {
  const n = cuts.length, W = 22, base = 30;
  let d = `M20 ${base}`;
  cuts.forEach((h, i) => { const x = 20 + i * W; d += ` L${x} ${base + h * 7} L${x + W} ${base + h * 7}`; });
  d += ` L${20 + n * W} ${base} Z`;
  const w = 20 + n * W + 6;
  if (lock) return `<svg viewBox="-2 0 ${w + 4} 66" aria-hidden="true"><rect x="0" y="16" width="${w}" height="46" rx="8" fill="#7a6a4f" stroke="#16120c" stroke-width="3"/><path d="${d}" fill="#16120c" stroke="#16120c" stroke-width="2"/></svg>`;
  return `<svg viewBox="-34 0 ${w + 36} 66" aria-hidden="true">
    <circle cx="-14" cy="30" r="15" fill="#ffc21a" stroke="#16120c" stroke-width="3"/><circle cx="-14" cy="30" r="5" fill="#fff" stroke="#16120c" stroke-width="2"/>
    <path d="M0 22 H20 V38 H0 Z" fill="#ffc21a" stroke="#16120c" stroke-width="3"/>
    <path d="${d}" fill="#ffc21a" stroke="#16120c" stroke-width="3" stroke-linejoin="round"/>
  </svg>`;
}

// Знаки «Шифра на стене»: 10 несимметричных глифов — при любом повороте и отражении выглядят по-разному.
// Их число совпадает с GLYPH_COUNT в lastq/challenges.js.
const GLYPHS = [
  "M7 4H17M7 4V20M7 12H14", // F
  "M7 21V3L17 7.5L7 12", // флажок
  "M9 4V15A4 4 0 0 0 17 15M17 7.2V7", // J с точкой
  "M6 4V19H17M17 19V14", // L с засечкой
  "M5 19V11H17M13 7L17 11L13 15", // стрелка с изгибом
  "M5.5 8A3 3 0 1 0 11.5 8A3 3 0 1 0 5.5 8M10.5 10.5L19 19M16 16L18 14M13.5 13.5L15 12", // ключик
  "M15 21V3L5 15H19", // 4
  "M7 21V3H13A4.5 4.5 0 0 1 13 12H7M12 12L18 21", // R
  "M18 7A7 7 0 1 0 18 17V12H13", // G
  "M8 8A4 4 0 1 1 13 12V15M13 19.2V19", // ?
];
function glyphSvg(s) {
  const t = `rotate(${s.r * 90} 12 12)${s.m ? " translate(24 0) scale(-1 1)" : ""}`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${GLYPHS[s.g]}" transform="${t}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Стрелочные часы «Часов на стене»
function clockSvg(h, m) {
  const ha = ((h % 12) + m / 60) * 30, ma = m * 6;
  let ticks = "";
  for (let i = 0; i < 12; i++) ticks += `<path d="M50 8 V${i % 3 ? 14 : 18}" transform="rotate(${i * 30} 50 50)" stroke="#16120c" stroke-width="${i % 3 ? 2 : 4}"/>`;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="46" fill="#fff" stroke="#16120c" stroke-width="4"/>${ticks}
    <path d="M50 50 V26" transform="rotate(${ha} 50 50)" stroke="#16120c" stroke-width="6" stroke-linecap="round"/>
    <path d="M50 50 V13" transform="rotate(${ma} 50 50)" stroke="#e8322b" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="50" cy="50" r="4" fill="#16120c"/>
  </svg>`;
}

// ---------- общие кнопки (из bomb.html) ----------
function optButtons(opts, onPick, cls) {
  const box = el("div", "opts" + (cls ? " " + cls : ""));
  opts.forEach((o, i) => {
    const b = el("button", "opt");
    b.type = "button";
    b.textContent = o;
    b.onclick = () => { b.classList.add("picked"); sfx.tap(); onPick(i); };
    box.append(b);
  });
  return box;
}
function gridOf(items, cols, onPick, txt) {
  const g = el("div", "grid");
  g.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  items.forEach((x, i) => {
    const b = el("button", "cell" + (txt ? " txt" : ""), x);
    b.type = "button";
    b.onclick = () => { sfx.tap(); onPick(i); };
    g.append(b);
  });
  return g;
}
const rndInt = (n) => Math.floor(Math.random() * n);
function shuffled(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rndInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const WIRE_COLORS = ["#e8322b", "#1e6fd9", "#ffc21a", "#16924a", "#a259ff", "#ff7a1a", "#16120c"];

const RENDER = {
  // ---- ловкость ----
  wires(c, pad, task) {
    const n = c.view.n;
    task.textContent = tpl(n >= 5 ? "t_wires5" : "t_wires", { n });
    const field = el("div", "field");
    let left = n;
    const wires = [];
    for (let i = 0; i < n; i++) {
      const w = el("button", "wire");
      w.type = "button";
      w.style.setProperty("--wc", WIRE_COLORS[i % WIRE_COLORS.length]);
      w.onclick = () => {
        w.classList.add("cut"); sfx.tap(); vibrate(15);
        if (--left === 0) return submit({ v: n });
        place();
      };
      wires.push(w);
      field.append(w);
    }
    // провода переставляются после каждого разреза
    function place() {
      const live = wires.filter((w) => !w.classList.contains("cut"));
      const slots = shuffled(live.map((_, i) => i));
      const gap = (field.clientHeight || 300) / live.length;
      live.forEach((w, i) => { w.style.top = `${slots[i] * gap + (gap - 36) / 2}px`; });
    }
    pad.append(field);
    place();
  },
  swipe(c, pad, task) {
    const dirs = c.view.dirs;
    task.textContent = T("t_swipe");
    const ARROW = { u: "↑", d: "↓", l: "←", r: "→" };
    const row = el("div", "arrows");
    dirs.forEach((d) => row.append(el("span", null, ARROW[d])));
    const zone = el("div", "swipezone", T("swipe_here"));
    pad.append(row, zone);
    const got = [];
    let sx = null, sy = null;
    zone.addEventListener("pointerdown", (e) => { sx = e.clientX; sy = e.clientY; });
    zone.addEventListener("pointerup", (e) => {
      if (sx == null) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      sx = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) return;
      const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "r" : "l") : dy > 0 ? "d" : "u";
      got.push(d);
      row.children[got.length - 1].classList.add("done");
      sfx.tap();
      if (got.length === dirs.length) submit({ v: got });
    });
  },
  hold(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_hold");
    const bar = el("div", "holdbar");
    const zone = el("div", "zone");
    zone.style.left = (v.from / v.full) * 100 + "%";
    zone.style.width = ((v.to - v.from) / v.full) * 100 + "%";
    const fill = el("div", "fill");
    bar.append(zone, fill);
    const btn = el("button", "holdbtn", T("hold_btn"));
    btn.type = "button";
    pad.append(bar, btn);
    let t0 = null, raf = 0;
    const tick = () => {
      if (t0 == null) return;
      const ms = performance.now() - t0;
      fill.style.width = Math.min(100, (ms / v.full) * 100) + "%";
      if (ms >= v.full) return release();
      raf = requestAnimationFrame(tick);
    };
    const press = (e) => { e.preventDefault(); if (t0 != null || K.solved()) return; t0 = performance.now(); btn.classList.add("on"); vibrate(10); raf = requestAnimationFrame(tick); };
    const release = () => {
      if (t0 == null) return;
      const ms = Math.round(performance.now() - t0);
      t0 = null; cancelAnimationFrame(raf); btn.classList.remove("on");
      submit({ v: ms });
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
  },
  order(c, pad, task) {
    const n = c.view.n;
    task.textContent = tpl("t_order", { n });
    const field = el("div", "field");
    // раскладка без наложений: ячейки сетки 4×4, числа в случайных ячейках
    pad.append(field);
    const rowH = (field.clientHeight || 300) / 4;
    const cells = shuffled([...Array(16).keys()]).slice(0, n);
    let next = 1;
    cells.forEach((cell, i) => {
      const b = el("button", "num", String(i + 1));
      b.type = "button";
      b.style.left = ((cell % 4) * 25 + 12.5 + (rndInt(9) - 4)) + "%";
      b.style.top = (Math.floor(cell / 4) * rowH + rowH / 2 + (rndInt(11) - 5)) + "px";
      b.onclick = () => {
        if (Number(b.textContent) !== next) { flashWrong(); return; }
        b.classList.add("done"); sfx.tap(); next++;
        if (next > n) submit({ v: [...Array(n)].map((_, k) => k + 1) });
      };
      field.append(b);
    });
  },
  nopress(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_nopress");
    const big = el("button", "nopress", T("nopress_btn"));
    big.type = "button";
    const now = el("button", "nowbtn", T("now_btn"));
    now.type = "button";
    pad.append(big, now);
    big.onclick = () => submit({ early: true });
    now.onclick = () => submit({ early: false });
    // уловки: надпись на большой кнопке ненадолго подмигивает «ЖМИ?»
    for (let i = 0; i < v.fakes; i++) {
      setTimeout(() => { if (big.isConnected) { big.textContent = T(i ? "fake2" : "fake1"); setTimeout(() => big.isConnected && (big.textContent = T("nopress_btn")), 500); } }, 500 + i * 700);
    }
    const showAt = c.at + v.wait;
    const t = setInterval(() => {
      if (!now.isConnected) return clearInterval(t);
      if (K.now() >= showAt) { clearInterval(t); now.classList.add("on"); sfx.pop(); }
    }, 50);
  },
  catch(c, pad, task) {
    const v = c.view;
    task.textContent = tplN("t_catch", v.hits);
    const field = el("div", "field");
    const tgt = el("button", "tgt", "🔑");
    tgt.type = "button";
    field.append(tgt);
    pad.append(field);
    let hits = 0;
    const jump = () => { tgt.style.left = 12 + rndInt(76) + "%"; tgt.style.top = 40 + rndInt(Math.max(60, (field.clientHeight || 300) - 80)) + "px"; };
    jump();
    const iv = setInterval(() => { if (!tgt.isConnected) return clearInterval(iv); jump(); }, Math.round(900 / v.speed));
    tgt.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      hits++; sfx.tap(); vibrate(12); jump();
      if (hits >= v.hits) { clearInterval(iv); submit({ v: hits }); }
    });
  },

  // ---- внимание ----
  color(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_color");
    const w = el("div", "word", T("color_" + v.word));
    w.style.color = INK[v.ink];
    w.style.setProperty("--len", Math.max(4, T("color_" + v.word).length));
    pad.append(w, optButtons(v.options.map((k) => T("color_" + k)), (i) => submit({ v: i })));
  },
  odd(c, pad, task) {
    task.textContent = T("t_odd");
    const n = c.view.items.length;
    pad.append(gridOf(c.view.items, n <= 4 ? 2 : 3, (i) => submit({ v: i })));
  },
  letter(c, pad, task) {
    task.textContent = T("t_letter");
    pad.append(gridOf(c.view.items, 4, (i) => submit({ v: i }), true));
  },
  sad(c, pad, task) {
    task.textContent = T("t_sad");
    const n = c.view.items.length;
    pad.append(gridOf(c.view.items, n <= 6 ? 3 : 4, (i) => submit({ v: i })));
  },
  code(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_code");
    const d = el("div", "digits", v.digits);
    pad.append(d);
    let typed = "";
    setTimeout(() => {
      if (!d.isConnected) return;
      task.textContent = T("t_code2");
      d.textContent = "_".repeat(v.digits.length);
      const kp = el("div", "keypad");
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", ""].forEach((k) => {
        const b = el("button", null, k);
        b.type = "button";
        if (!k) b.style.visibility = "hidden";
        b.onclick = () => {
          sfx.tap();
          if (k === "⌫") typed = typed.slice(0, -1);
          else typed += k;
          d.textContent = (typed + "_".repeat(v.digits.length)).slice(0, v.digits.length);
          if (typed.length === v.digits.length) submit({ v: typed });
        };
        kp.append(b);
      });
      pad.append(kp);
    }, v.show);
  },
  count(c, pad, task) {
    task.textContent = T("t_count");
    const n = c.view.items.length;
    const g = el("div", "grid");
    g.style.gridTemplateColumns = `repeat(${n <= 9 ? 3 : 4}, 1fr)`;
    g.className = "grid count-grid";
    g.style.fontSize = "34px";
    g.style.textAlign = "center";
    c.view.items.forEach((x) => g.append(el("span", null, x)));
    pad.append(g, optButtons(c.view.options.map(String), (i) => submit({ v: i })));
  },

  // ---- голова ----
  quiz(c, pad, task) {
    task.textContent = T("t_quiz");
    pad.append(el("div", "qtext", tx(c.view.q)), optButtons(c.view.options.map(tx), (i) => submit({ v: i })));
  },
  tf(c, pad, task) {
    task.textContent = T("t_tf");
    pad.append(el("div", "qtext", tx(c.view.q)), optButtons([T("q_true"), T("q_false")], (i) => submit({ v: i })));
  },
  heavy(c, pad, task) {
    task.textContent = T("t_heavy");
    pad.append(el("div", "qtext", "⚖️"), optButtons(c.view.options.map(tx), (i) => submit({ v: i }), "one"));
  },
  chrono(c, pad, task) {
    task.textContent = T("t_chrono");
    const box = el("div", "opts one chron");
    const picked = [];
    c.view.items.forEach((x, i) => {
      const b = el("button", "opt");
      b.type = "button";
      b.innerHTML = `<i></i><span>${escapeHtml(tx(x))}</span>`;
      b.onclick = () => {
        if (picked.includes(i)) return;
        picked.push(i);
        b.classList.add("picked");
        b.querySelector("i").textContent = picked.length;
        sfx.tap();
        if (picked.length === c.view.items.length) submit({ v: picked });
      };
      box.append(b);
    });
    pad.append(box);
  },
  sudoku(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_sudoku");
    const g = el("div", "sud");
    g.style.gridTemplateColumns = `repeat(${v.n}, auto)`;
    v.cells.forEach((row, r) => row.forEach((x, col) => {
      const isQ = r === v.target[0] && col === v.target[1];
      g.append(el("div", isQ ? "q" : x == null ? "e" : "", isQ ? "?" : x == null ? "" : String(x)));
    }));
    pad.append(g, optButtons(v.options.map(String), (i) => submit({ v: v.options[i] })));
  },
  seq(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_seq");
    const days = String(T("days")).split("|");
    const show = (x) => (v.kind === "days" ? days[x] : String(x));
    const row = el("div", "seqrow");
    v.items.forEach((x) => row.append(el("span", null, show(x))));
    row.append(el("span", "q", "?"));
    pad.append(row, optButtons(v.options.map(show), (i) => submit({ v: i })));
  },
  math(c, pad, task) {
    task.textContent = T("t_math");
    pad.append(el("div", "qtext", c.view.text + " = ?"), optButtons(c.view.options.map(String), (i) => submit({ v: i })));
  },
  // ---- ловкость: новые ----
  spark(c, pad, task) {
    const v = c.view;
    task.textContent = tplN("t_spark", v.n);
    const field = el("div", "field sparkfield");
    const line = el("div", "fuseline");
    const bomb = el("div", "sparkbomb", "🚨");
    const sp = el("button", "sparkbtn", "✨");
    sp.type = "button";
    const left = el("div", "sparkleft", String(v.n));
    field.append(line, bomb, sp, left);
    pad.append(field);
    let hits = 0, done = false;
    const t0 = performance.now();
    (function move(now) {
      if (done || !sp.isConnected) return;
      const k = Math.min(1, (now - t0) / v.travel);
      // искра ползёт по проводу змейкой к сигнализации справа
      sp.style.left = 6 + k * 70 + "%";
      sp.style.top = 50 + Math.sin(k * Math.PI * 3) * 28 + "%";
      if (k >= 1) { done = true; submit({ v: hits, late: true }); return; }
      requestAnimationFrame(move);
    })(t0);
    sp.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (done) return;
      hits++; sfx.tap(); vibrate(10);
      left.textContent = String(v.n - hits);
      if (hits >= v.n) { done = true; submit({ v: hits }); }
    });
  },
  rhythm(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_rhythm1");
    const b = el("button", "rhythmbtn", "🧱");
    b.type = "button";
    b.disabled = true;
    pad.append(b);
    // показ: стена «стучит» на каждый удар — перестук между камерами
    const beats = [v.lead];
    for (const g of v.gaps) beats.push(beats[beats.length - 1] + g);
    beats.forEach((t) => setTimeout(() => {
      if (!b.isConnected) return;
      sfx.tick(true);
      b.classList.remove("beat"); void b.offsetWidth; b.classList.add("beat");
    }, t));
    const taps = [];
    setTimeout(() => {
      if (!b.isConnected) return;
      task.textContent = T("t_rhythm2");
      b.disabled = false;
      b.textContent = T("rhythm_btn");
    }, beats[beats.length - 1] + 500);
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (b.disabled) return;
      taps.push(performance.now());
      sfx.tick(false); vibrate(8);
      b.classList.remove("beat"); void b.offsetWidth; b.classList.add("beat");
      if (taps.length === beats.length) submit({ v: taps.slice(1).map((t, i) => Math.round(t - taps[i])) });
    });
  },
  coward(c, pad, task) {
    const v = c.view;
    task.textContent = tplN("t_coward", v.hits);
    const field = el("div", "field");
    const btn = el("button", "cowardbtn", T("coward_btn"));
    btn.type = "button";
    field.append(btn);
    pad.append(field);
    let hits = 0;
    // телепортируется, а не едет: в «Поймай» мишень летает плавно
    const jump = () => { btn.style.left = 18 + rndInt(64) + "%"; btn.style.top = 20 + rndInt(Math.max(40, field.clientHeight - 60)) + "px"; };
    jump();
    const iv = setInterval(() => { if (!btn.isConnected) return clearInterval(iv); jump(); }, v.jump);
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      hits++; sfx.tap(); vibrate(12); jump();
      if (hits >= v.hits) { clearInterval(iv); submit({ v: hits }); }
    });
  },

  // ---- внимание: новые ----
  shells(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_shells1");
    const field = el("div", "field shellfield");
    const w = 100 / v.cups;
    // slot[i] — в какой позиции сейчас стакан i
    const slot = [...Array(v.cups).keys()];
    const cups = slot.map((i) => {
      const cup = el("button", "cup");
      cup.type = "button";
      cup.style.width = w - 4 + "%";
      cup.style.left = i * w + 2 + "%";
      if (i === v.start) cup.append(el("span", "under", "🔑"));
      field.append(cup);
      return cup;
    });
    pad.append(field);
    cups.forEach((cup) => cup.classList.add("up"));
    setTimeout(() => cups.forEach((cup) => { cup.classList.remove("up"); const u = cup.querySelector(".under"); if (u) u.remove(); }), v.show - 150);
    v.swaps.forEach(([a, b], k) => setTimeout(() => {
      const ca = slot.indexOf(a), cb = slot.indexOf(b);
      slot[ca] = b; slot[cb] = a;
      cups[ca].style.left = b * w + 2 + "%";
      cups[cb].style.left = a * w + 2 + "%";
      cups[ca].style.transitionDuration = cups[cb].style.transitionDuration = v.swapMs - 30 + "ms";
    }, v.show + k * v.swapMs));
    setTimeout(() => { if (field.isConnected) { task.textContent = T("t_shells2"); field.classList.add("pick"); } }, v.show + v.swaps.length * v.swapMs);
    cups.forEach((cup, i) => { cup.onclick = () => { if (!field.classList.contains("pick")) return; sfx.tap(); cup.classList.add("up"); submit({ v: slot[i] }); }; });
  },
  simon(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_simon1");
    const grid = el("div", "simon");
    const colors = ["#e8322b", "#1e6fd9", "#ffc21a", "#16924a"];
    const pads = colors.map((col, i) => {
      const b = el("button", "spad");
      b.type = "button";
      b.style.setProperty("--sc", col);
      b.disabled = true;
      grid.append(b);
      return b;
    });
    pad.append(grid);
    const lit = (i, ms) => { pads[i].classList.add("lit"); setTimeout(() => pads[i].classList.remove("lit"), ms); };
    v.seq.forEach((i, k) => setTimeout(() => { if (grid.isConnected) { lit(i, v.step * 0.7); sfx.tick(false); } }, v.lead + k * v.step));
    const got = [];
    setTimeout(() => { if (!grid.isConnected) return; task.textContent = T("t_simon2"); pads.forEach((p) => (p.disabled = false)); }, v.lead + v.seq.length * v.step);
    pads.forEach((p, i) => { p.onclick = () => { lit(i, 180); sfx.tap(); got.push(i); if (got.length === v.seq.length) submit({ v: got }); }; });
  },
  blink(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_blink1");
    const g = gridOf(v.items, v.items.length <= 9 ? 3 : 4, (i) => submit({ v: i }));
    pad.append(g);
    const cell = g.children[v.cell];
    setTimeout(() => { if (cell.isConnected) cell.textContent = v.to; }, v.showAt);
    setTimeout(() => { if (cell.isConnected) { cell.textContent = v.items[v.cell]; task.textContent = T("t_blink2"); } }, v.showAt + v.dur);
  },
  flashes(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_flashes1");
    const lamp = el("div", "lamp");
    pad.append(lamp);
    for (let k = 0; k < v.count; k++) setTimeout(() => {
      if (!lamp.isConnected) return;
      lamp.classList.add("on"); sfx.tick(false);
      setTimeout(() => lamp.classList.remove("on"), v.gap * 0.45);
    }, v.lead + k * v.gap);
    setTimeout(() => {
      if (!lamp.isConnected) return;
      task.textContent = T("t_flashes2");
      pad.append(optButtons(v.options.map(String), (i) => submit({ v: i })));
    }, v.lead + v.count * v.gap + 200);
  },
  diff(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_diff");
    // верхняя сетка — образец, её не нажимают: на низком экране она мельче нижней
    const cellSize = `repeat(${v.side}, min(42px, 9.5vw, 5.4vh))`;
    const top = gridOf(v.top, v.side, () => {});
    top.classList.add("tiny"); // не «mini»: так называется плашка с бомбой на спокойном экране
    top.style.gridTemplateColumns = cellSize;
    top.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const bottom = gridOf(v.bottom, v.side, (i) => submit({ v: i }));
    bottom.classList.add("tiny");
    bottom.style.gridTemplateColumns = `repeat(${v.side}, max(44px, min(56px, 13vw, 7.6vh)))`;
    pad.append(top, el("div", "vs", "⇅"), bottom);
  },

  // ---- голова: новые ----
  manual(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_manual");
    pad.append(el("div", "rule", T("mr_" + v.rule)));
    const box = el("div", "mwires");
    v.wires.forEach((col, i) => {
      const b = el("button", "mwire");
      b.type = "button";
      b.innerHTML = `<i>${i + 1}</i><span style="background:${WIRE[col]}"></span>`;
      b.onclick = () => { b.classList.add("cut"); sfx.tap(); submit({ v: i }); };
      box.append(b);
    });
    pad.append(box);
  },
  rebus(c, pad, task) {
    task.textContent = T("t_rebus");
    pad.append(el("div", "rebusq", c.view.q), optButtons(c.view.options.map(tx), (i) => submit({ v: i })));
  },
  oddmeaning(c, pad, task) {
    task.textContent = T("t_oddmeaning");
    pad.append(gridOf(c.view.items, c.view.items.length, (i) => submit({ v: i })));
  },
  dice(c, pad, task) {
    task.textContent = T("t_dice");
    const row = el("div", "dicerow");
    // точки рисуем сами: символы ⚀–⚅ на многих телефонах мелкие и нечитаемые
    const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    c.view.dice.forEach((d) => {
      const die = el("div", "die");
      for (let k = 0; k < 9; k++) die.append(el("i", PIPS[d].includes(k) ? "p" : ""));
      row.append(die);
    });
    pad.append(row, optButtons(c.view.options.map(String), (i) => submit({ v: i })));
  },


  // ======== свои испытания Камеры (lastq-spec.md §4.2) ========

  // ---- ловкость ----
  dig(c, pad, task) {
    const n = c.view.n;
    task.textContent = T("t_dig");
    const tunnel = el("div", "tunnel");
    const fill = el("i");
    const mole = el("b", null, "⛏️");
    tunnel.append(fill, mole, el("span", "exit", "🌳"));
    const left = el("div", "digleft", String(n));
    const btn = el("button", "digbtn", T("dig_btn"));
    btn.type = "button";
    pad.append(tunnel, left, btn);
    let hits = 0;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (hits >= n) return;
      hits++; sfx.tap(); vibrate(8);
      const k = hits / n;
      fill.style.width = k * 100 + "%";
      mole.style.left = `calc(${k * 100}% - ${k * 30}px)`;
      left.textContent = String(n - hits);
      btn.classList.remove("beat"); void btn.offsetWidth; btn.classList.add("beat");
      if (hits >= n) submit({ v: hits });
    });
  },
  saw(c, pad, task) {
    const v = c.view, total = v.bars * v.strokes;
    task.textContent = T("t_saw");
    const bars = el("div", "sawbars");
    const cuts = [];
    for (let i = 0; i < v.bars; i++) { const b = el("div", "sawbar"); const cut = el("i"); b.append(cut); bars.append(b); cuts.push(cut); }
    const zone = el("div", "sawzone");
    const saw = el("span", "sawicon", "🪚");
    zone.append(saw, el("small", null, T("saw_here")));
    pad.append(bars, zone);
    // взмах — смена направления пальца после пути ≥ 36 px (сервер проверяет только число взмахов и minMs)
    let strokes = 0, dir = 0, ext = null;
    const stroke = () => {
      strokes++; sfx.tap(); vibrate(6);
      const bar = Math.min(v.bars - 1, Math.floor((strokes - 1) / v.strokes));
      cuts.forEach((cut, i) => { cut.style.height = (i < bar ? 100 : i === bar ? ((strokes - bar * v.strokes) / v.strokes) * 100 : 0) + "%"; });
      if (strokes % v.strokes === 0) bars.children[bar].classList.add("cut");
      if (strokes >= total) submit({ v: strokes });
    };
    zone.addEventListener("pointerdown", (e) => { ext = e.clientX; dir = 0; try { zone.setPointerCapture(e.pointerId); } catch (er) {} });
    zone.addEventListener("pointermove", (e) => {
      if (ext == null || strokes >= total) return;
      const x = e.clientX, r = zone.getBoundingClientRect();
      saw.style.left = Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)) + "%";
      if (dir === 0) { if (Math.abs(x - ext) >= 36) { dir = Math.sign(x - ext); ext = x; stroke(); } return; }
      if ((x - ext) * dir > 0) { ext = x; return; }
      if (Math.abs(x - ext) >= 36) { dir = -dir; ext = x; stroke(); }
    });
    const up = () => { ext = null; };
    zone.addEventListener("pointerup", up);
    zone.addEventListener("pointercancel", up);
  },
  lockpick(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_lockpick");
    const lock = el("div", "picklock");
    const pins = v.pins.map((p) => {
      const col = el("div", "pin");
      const gap = el("i", "gap");
      gap.style.bottom = (p.c - v.half) * 100 + "%";
      gap.style.height = v.half * 200 + "%";
      const head = el("b", "pinhead");
      col.append(gap, head);
      lock.append(col);
      return { p, col, head, at: null };
    });
    const btn = el("button", "pickbtn", T("pick_btn"));
    btn.type = "button";
    pad.append(lock, btn);
    const t0 = performance.now();
    const taps = [];
    let done = false;
    // положение штифта — та же формула, что проверяет сервер: tri(t / period + phase)
    (function move(now) {
      if (!lock.isConnected) return;
      pins.forEach((x, i) => {
        const t = x.at != null ? x.at : now - t0;
        x.head.style.bottom = `calc(${tri(t / x.p.period + x.p.phase) * 100}% - 9px)`;
        x.col.classList.toggle("on", i === taps.length && !done);
      });
      if (!done) requestAnimationFrame(move);
    })(t0);
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (done) return;
      const t = Math.round(performance.now() - t0), x = pins[taps.length];
      x.at = t;
      taps.push(t);
      const ok = Math.abs(tri(t / x.p.period + x.p.phase) - x.p.c) < v.half + 0.03;
      x.col.classList.add(ok ? "set" : "miss");
      sfx.tap(); vibrate(12);
      if (!ok || taps.length === pins.length) { done = true; submit({ v: taps }); }
    });
  },
  searchlight(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_searchlight");
    const yard = el("div", "yard");
    const beam = el("div", "beam");
    beam.style.width = v.half * 200 + "%";
    yard.append(beam);
    v.covers.forEach((x) => { const b = el("i", "cover"); b.style.left = x * 100 + "%"; yard.append(b); });
    const runner = el("b", "runner", "🏃");
    runner.style.left = v.covers[0] * 100 + "%";
    yard.append(runner, el("span", "gate", "🚪"));
    const btn = el("button", "runbtn", T("run_btn"));
    btn.type = "button";
    pad.append(yard, btn);
    const t0 = performance.now();
    const taps = [];
    let done = false;
    (function sweep(now) {
      if (!yard.isConnected || done) return;
      beam.style.left = (tri((now - t0) / v.period + v.phase) - v.half) * 100 + "%";
      requestAnimationFrame(sweep);
    })(t0);
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (done || btn.disabled) return;
      const t = Math.round(performance.now() - t0), i = taps.length;
      taps.push(t);
      const safe = Math.abs(tri(t / v.period + v.phase) - v.covers[i]) > v.half - 0.02 && (i === 0 || t - taps[i - 1] >= 350);
      if (!safe) { done = true; runner.classList.add("caught"); sfx.buzz(); return submit({ v: taps }); }
      sfx.tap(); vibrate(10);
      runner.style.left = (i + 1 < v.n ? v.covers[i + 1] : 1.04) * 100 + "%";
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, v.dash);
      if (taps.length === v.n) { done = true; submit({ v: taps }); }
    });
  },

  // ---- внимание ----
  lineup(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_lineup1");
    const big = el("div", "facebig");
    big.innerHTML = faceSvg(v.target);
    pad.append(big);
    setTimeout(() => {
      if (!big.isConnected) return;
      big.remove();
      task.textContent = T("t_lineup2");
      const g = el("div", "suspects");
      v.suspects.forEach((f, i) => {
        const b = el("button", "suspect");
        b.type = "button";
        b.innerHTML = faceSvg(f) + `<i>${i + 1}</i>`;
        b.onclick = () => { b.classList.add("picked"); sfx.tap(); submit({ v: i }); };
        g.append(b);
      });
      pad.append(g);
    }, v.show);
  },
  rollcall(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_rollcall");
    const mine = el("div", "mineno");
    mine.innerHTML = `<small>${escapeHtml(T("rollcall_mine"))}</small><b>№ ${escapeHtml(v.mine)}</b>`;
    const win = el("div", "ticker");
    const num = el("span", null, "");
    win.append(num);
    const btn = el("button", "herebtn", T("rollcall_btn"));
    btn.type = "button";
    pad.append(mine, win, btn);
    const t0 = performance.now();
    let shown = -2, done = false;
    (function roll(now) {
      if (!win.isConnected || done) return;
      const t = now - t0, i = Math.floor((t - v.lead) / v.step);
      if (i !== shown) {
        shown = i;
        num.textContent = i >= 0 && i < v.list.length ? "№ " + v.list[i] : "";
        num.classList.remove("in"); void num.offsetWidth; num.classList.add("in");
        if (i >= 0 && i < v.list.length) sfx.tick(false);
      }
      // лента кончилась, а тапа не было — проспал перекличку
      if (t > v.lead + v.list.length * v.step + 300) { done = true; return submit({ v: -1 }); }
      requestAnimationFrame(roll);
    })(t0);
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (done) return;
      done = true; sfx.tap(); vibrate(15);
      submit({ v: Math.round(performance.now() - t0) });
    });
  },
  keys(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_keys");
    const lock = el("div", "keylock");
    lock.innerHTML = keySvg(v.lock, true);
    const box = el("div", "keyring");
    v.keys.forEach((k, i) => {
      const b = el("button", "keybtn");
      b.type = "button";
      b.innerHTML = keySvg(k, false);
      b.onclick = () => { b.classList.add("picked"); sfx.tap(); submit({ v: i }); };
      box.append(b);
    });
    pad.append(lock, box);
  },
  cipher(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_cipher");
    const wall = el("div", "wall");
    const picked = [];
    v.items.forEach((s, i) => {
      const b = el("button", "glyph");
      b.type = "button";
      b.innerHTML = glyphSvg(s);
      b.onclick = () => {
        const at = picked.indexOf(i);
        sfx.tap();
        if (at >= 0) { picked.splice(at, 1); b.classList.remove("picked"); return; }
        picked.push(i);
        b.classList.add("picked");
        if (picked.length === 2) submit({ v: picked.slice().sort((x, y) => x - y) });
      };
      wall.append(b);
    });
    pad.append(wall);
  },

  // ---- голова ----
  codelock(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_codelock");
    const box = el("div", "clues");
    v.clues.forEach((cl) => box.append(el("div", "clue", tpl("cl_" + cl.k, { n: cl.n }))));
    pad.append(el("div", "padlock", "🔒"), box, optButtons(v.options, (i) => submit({ v: i }), "code"));
  },
  scales(c, pad, task) {
    const v = c.view;
    task.textContent = tpl("t_scales", { b: v.ask[0], s: v.ask[1] });
    const box = el("div", "eqs");
    v.eq.forEach(([big, small, k]) => box.append(el("div", "eq", `${big} = ${small.repeat(k)}`)));
    pad.append(box, optButtons(v.options.map(String), (i) => submit({ v: i })));
  },
  clock(c, pad, task) {
    const v = c.view;
    task.textContent = v.plus ? tpl("t_clock_plus", { h: v.plus[0], m: v.plus[1] }) : T("t_clock");
    const face = el("div", "clockface");
    face.innerHTML = clockSvg(v.h, v.m);
    pad.append(face, optButtons(v.options, (i) => submit({ v: i })));
  },
  guard(c, pad, task) {
    const v = c.view;
    task.textContent = T("t_guard1");
    const MOVES = { u: [-1, 0], d: [1, 0], l: [0, -1], r: [0, 1] };
    const grid = el("div", "yardgrid");
    const cells = [];
    for (let i = 0; i < 9; i++) {
      const b = el("button", "ycell");
      b.type = "button";
      b.disabled = true;
      b.onclick = () => { b.classList.add("picked"); sfx.tap(); submit({ v: i }); };
      grid.append(b);
      cells.push(b);
    }
    const g = el("b", "guardman", "💂");
    grid.append(g);
    pad.append(grid);
    let r = Math.floor(v.start / 3), col = v.start % 3;
    const place = () => { g.style.left = `calc(${col} * 100% / 3)`; g.style.top = `calc(${r} * 100% / 3)`; };
    g.style.transitionDuration = Math.round(v.stepMs * 0.7) + "ms";
    place();
    v.dirs.forEach((d, k) => setTimeout(() => {
      if (!grid.isConnected) return;
      r += MOVES[d][0]; col += MOVES[d][1];
      place(); sfx.tick(false);
    }, v.lead + k * v.stepMs));
    setTimeout(() => {
      if (!grid.isConnected) return;
      g.classList.add("gone");
      task.textContent = T("t_guard2");
      cells.forEach((b) => (b.disabled = false));
    }, v.lead + v.dirs.length * v.stepMs);
  },

  // ---- передачка ----
  pass(c, pad, task) {
    const v = c.view;
    const say = () => {
      const helper = v.where === "phone" ? K.playerName(v.helper) : null;
      task.textContent = helper ? tpl("t_pass_phone", { name: helper }) : T("t_pass_tv");
      icon.textContent = helper ? "📱🗣️" : "📺👀";
    };
    const icon = el("div", "crowdicon");
    pad.append(icon);
    // доска показывает код после 4 с тишины: страница зовёт LQC.update с новым view
    pad.__lqcUpdate = (nc) => { v.where = nc.view.where; v.helper = nc.view.helper; say(); };
    say();
    const d = el("div", "digits", "_".repeat(v.n));
    pad.append(d);
    let typed = "";
    const kp = el("div", "keypad");
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "⌫", ""].forEach((k) => {
      const b = el("button", null, k);
      b.type = "button";
      if (!k) b.style.visibility = "hidden";
      b.onclick = () => {
        sfx.tap();
        if (k === "⌫") typed = typed.slice(0, -1);
        else typed += k;
        d.textContent = (typed + "_".repeat(v.n)).slice(0, v.n);
        if (typed.length === v.n) submit({ v: typed });
      };
      kp.append(b);
    });
    pad.append(kp);
  },
  fallback(c, pad) {
    pad.append(el("div", "qtext", "…"));
  },
};

// ---------- строки ----------
// Бомбовые подписи испытаний (bomb.html, bomb-shared.js) + свои. Страница может переопределить любую в своём I18N_DICT.
const STR = {
 "ru": {
  "t_wires": "Перережь {n} провода!",
  "t_wires5": "Перережь {n} проводов!",
  "t_swipe": "Смахни по стрелкам",
  "swipe_here": "Смахивай здесь",
  "t_hold": "Держи и отпусти в зелёной зоне",
  "hold_btn": "Держи",
  "t_order": "Жми по порядку: 1 → {n}",
  "t_nopress": "Не нажимай. Серьёзно",
  "nopress_btn": "НЕ ЖМИ",
  "now_btn": "Вот теперь жми",
  "fake1": "ЖМИ?",
  "fake2": "ну жми",
  "t_catch1": "Поймай ключ {n} раз",
  "t_catch": "Поймай ключ {n} раза",
  "t_catch5": "Поймай ключ {n} раз",
  "t_color": "Каким цветом написано слово?",
  "t_odd": "Найди лишнего",
  "t_letter": "Найди не такую",
  "t_sad": "Найди грустного",
  "t_code": "Запомни код",
  "t_code2": "Введи код",
  "t_count": "Сколько взрослых уток 🦆?",
  "t_quiz": "Вопрос",
  "t_tf": "Правда или враньё?",
  "t_heavy": "Кто тяжелее?",
  "t_chrono": "Расставь по порядку: от древнего к новому",
  "t_sudoku": "Какая цифра на месте «?» — в строке и столбце без повторов",
  "t_seq": "Что дальше?",
  "t_math": "Посчитай",
  "t_spark1": "Искра бежит к сигнализации: тапни по ней {n} раз!",
  "t_spark": "Искра бежит к сигнализации: тапни по ней {n} раза!",
  "t_spark5": "Искра бежит к сигнализации: тапни по ней {n} раз!",
  "t_rhythm1": "Сосед стучит в стену — слушай…",
  "t_rhythm2": "Теперь простучи так же!",
  "rhythm_btn": "ТУК",
  "t_coward1": "Поймай кнопку-труса {n} раз",
  "t_coward": "Поймай кнопку-труса {n} раза",
  "t_coward5": "Поймай кнопку-труса {n} раз",
  "coward_btn": "СТОЙ!",
  "t_shells1": "Следи за ключом!",
  "t_shells2": "Где ключ?",
  "t_simon1": "Запоминай…",
  "t_simon2": "Повтори!",
  "t_blink1": "Следи — кто-то моргнёт",
  "t_blink2": "Кто моргнул?",
  "t_flashes1": "Считай вспышки",
  "t_flashes2": "Сколько было вспышек?",
  "t_diff": "Найди отличие и тапни его внизу",
  "t_manual": "Схема сигнализации: какой провод резать?",
  "t_rebus": "Разгадай ребус",
  "t_oddmeaning": "Кто лишний по смыслу?",
  "t_dice": "Сколько очков на кубиках?",
  "grp_hands": "Ловкость",
  "grp_eyes": "Внимание",
  "grp_head": "Голова",
  "ch_wires": "режет провода",
  "ch_swipe": "смахивает",
  "ch_hold": "держит кнопку",
  "ch_order": "жмёт по порядку",
  "ch_nopress": "не жмёт кнопку",
  "ch_catch": "ловит ключ",
  "ch_color": "угадывает цвет",
  "ch_odd": "ищет лишнего",
  "ch_code": "вспоминает код",
  "ch_count": "считает уток",
  "ch_letter": "ищет букву",
  "ch_sad": "ищет грустного",
  "ch_quiz": "отвечает на вопрос",
  "ch_sudoku": "решает судоку",
  "ch_seq": "продолжает ряд",
  "ch_math": "считает в уме",
  "ch_tf": "решает: правда или враньё",
  "ch_heavy": "взвешивает",
  "ch_chrono": "вспоминает историю",
  "ch_spark": "гасит искру",
  "ch_rhythm": "перестукивается",
  "ch_coward": "ловит кнопку-труса",
  "ch_shells": "следит за ключом",
  "ch_simon": "повторяет мигание",
  "ch_blink": "ищет, кто моргнул",
  "ch_flashes": "считает вспышки",
  "ch_diff": "ищет отличие",
  "ch_manual": "читает схему сигнализации",
  "ch_rebus": "разгадывает ребус",
  "ch_oddmeaning": "ищет лишнего по смыслу",
  "ch_dice": "считает кубики",
  "mr_last_yellow": "Если последний провод жёлтый — режь первый. Иначе — последний.",
  "mr_even": "Если проводов чётное число — режь предпоследний. Иначе — первый.",
  "mr_red": "Если красных проводов больше одного — режь последний красный. Иначе — второй провод.",
  "mr_blue": "Если синий провод есть — режь первый синий. Иначе — третий провод.",
  "mr_white": "Если белый провод ровно один — режь его. Иначе — последний.",
  "mr_same": "Режь ближайший к первому провод того же цвета (но не сам первый).",
  "mr_black": "Если первый провод чёрный — режь второй. Иначе — первый чёрный.",
  "mr_green": "Режь провод, который идёт сразу после первого зелёного.",
  "color_red": "КРАСНЫЙ",
  "color_blue": "СИНИЙ",
  "color_green": "ЗЕЛЁНЫЙ",
  "color_yellow": "ЖЁЛТЫЙ",
  "color_purple": "ФИОЛЕТОВЫЙ",
  "color_orange": "ОРАНЖЕВЫЙ",
  "days": "Пн|Вт|Ср|Чт|Пт|Сб|Вс",
  "q_true": "Правда",
  "q_false": "Враньё",
  "t_dig": "Копай подкоп! Тапай по лопате",
  "dig_btn": "КОПАТЬ",
  "t_saw": "Перепили решётку: води пилой туда-сюда",
  "saw_here": "Пили здесь",
  "t_lockpick": "Тапни, когда штифт в зелёной щели",
  "pick_btn": "ЩЁЛК",
  "t_searchlight": "Беги, когда прожектор далеко!",
  "run_btn": "БЕГИ",
  "t_lineup1": "Запомни лицо",
  "t_lineup2": "Кто это был?",
  "t_rollcall": "Перекличка! Жми, когда пробежит твой номер",
  "rollcall_mine": "Твой номер",
  "rollcall_btn": "Я ЗДЕСЬ!",
  "t_keys": "Какой ключ подходит к замку?",
  "t_cipher": "Найди два одинаковых знака",
  "t_codelock": "Подбери код замка",
  "cl_sum": "Сумма цифр — {n}",
  "cl_diff": "Первая цифра больше второй на {n}",
  "cl_less": "Вторая цифра больше первой на {n}",
  "cl_prod": "Произведение цифр — {n}",
  "cl_twice": "Вторая цифра вдвое больше первой",
  "cl_twice1": "Первая цифра вдвое больше второй",
  "cl_even0": "Первая цифра чётная",
  "cl_odd0": "Первая цифра нечётная",
  "cl_even1": "Вторая цифра чётная",
  "cl_odd1": "Вторая цифра нечётная",
  "cl_gt": "Код больше {n}",
  "cl_lt": "Код меньше {n}",
  "t_scales": "Сколько {s} в одном {b}?",
  "t_clock": "Который час?",
  "t_clock_plus": "Сколько будет через {h} ч {m} мин?",
  "t_guard1": "Следи за охранником",
  "t_guard2": "Где он теперь?",
  "t_pass_phone": "Код знает {name}. Пусть продиктует!",
  "t_pass_tv": "Сокамерник молчит — код на общем экране!",
  "hint_pass_title": "{name} в Камере ждёт код!",
  "hint_pass_say": "Продиктуй — или соври 😈",
  "hint_bet_escape": "Твоя ставка: спасётся",
  "hint_bet_burn": "Твоя ставка: сгорит",
  "hint_bet_none": "Ты на него не ставил(а)",
  "bars_wrong": "Мимо! Решётка закрыта…",
  "ch_dig": "роет подкоп",
  "ch_saw": "пилит решётку",
  "ch_lockpick": "вскрывает замок",
  "ch_searchlight": "бежит от прожектора",
  "ch_lineup": "опознаёт",
  "ch_rollcall": "ждёт переклички",
  "ch_keys": "подбирает ключ",
  "ch_cipher": "читает шифр",
  "ch_codelock": "подбирает код",
  "ch_scales": "взвешивает фрукты",
  "ch_clock": "смотрит на часы",
  "ch_guard": "следит за охранником",
  "ch_pass": "ждёт передачку"
 },
 "en": {
  "t_wires": "Cut {n} wires!",
  "t_wires5": "Cut {n} wires!",
  "t_swipe": "Swipe along the arrows",
  "swipe_here": "Swipe here",
  "t_hold": "Hold and release in the green zone",
  "hold_btn": "Hold",
  "t_order": "Tap in order: 1 → {n}",
  "t_nopress": "Don't press it. Seriously",
  "nopress_btn": "DON'T",
  "now_btn": "Now press this",
  "fake1": "PRESS?",
  "fake2": "go on",
  "t_catch1": "Catch the key once",
  "t_catch": "Catch the key {n} times",
  "t_catch5": "Catch the key {n} times",
  "t_color": "What colour is the word written in?",
  "t_odd": "Find the odd one",
  "t_letter": "Find the different one",
  "t_sad": "Find the sad one",
  "t_code": "Remember the code",
  "t_code2": "Enter the code",
  "t_count": "How many grown-up ducks 🦆?",
  "t_quiz": "Question",
  "t_tf": "True or false?",
  "t_heavy": "Which is heavier?",
  "t_chrono": "Put in order: oldest to newest",
  "t_sudoku": "Which digit goes in \"?\" — no repeats in a row or column",
  "t_seq": "What comes next?",
  "t_math": "Work it out",
  "t_spark1": "A spark is racing to the alarm: tap it once!",
  "t_spark": "A spark is racing to the alarm: tap it {n} times!",
  "t_spark5": "A spark is racing to the alarm: tap it {n} times!",
  "t_rhythm1": "Your cellmate knocks on the wall — listen…",
  "t_rhythm2": "Now tap it back!",
  "rhythm_btn": "TAP",
  "t_coward1": "Catch the coward button once",
  "t_coward": "Catch the coward button {n} times",
  "t_coward5": "Catch the coward button {n} times",
  "coward_btn": "STOP!",
  "t_shells1": "Watch the key!",
  "t_shells2": "Where's the key?",
  "t_simon1": "Remember…",
  "t_simon2": "Repeat!",
  "t_blink1": "Watch — someone will blink",
  "t_blink2": "Who blinked?",
  "t_flashes1": "Count the flashes",
  "t_flashes2": "How many flashes?",
  "t_diff": "Spot the difference and tap it below",
  "t_manual": "Alarm wiring: which wire do you cut?",
  "t_rebus": "Solve the rebus",
  "t_oddmeaning": "Which one doesn't belong?",
  "t_dice": "How many dots in total?",
  "grp_hands": "Hands",
  "grp_eyes": "Eyes",
  "grp_head": "Head",
  "ch_wires": "is cutting wires",
  "ch_swipe": "is swiping",
  "ch_hold": "is holding the button",
  "ch_order": "is tapping in order",
  "ch_nopress": "is NOT pressing",
  "ch_catch": "is catching the key",
  "ch_color": "is naming the colour",
  "ch_odd": "is spotting the odd one",
  "ch_code": "is recalling the code",
  "ch_count": "is counting ducks",
  "ch_letter": "is hunting a letter",
  "ch_sad": "is finding the sad one",
  "ch_quiz": "is answering a question",
  "ch_sudoku": "is solving sudoku",
  "ch_seq": "is continuing the pattern",
  "ch_math": "is doing maths",
  "ch_tf": "is deciding: true or false",
  "ch_heavy": "is weighing things up",
  "ch_chrono": "is sorting history",
  "ch_spark": "is putting out the spark",
  "ch_rhythm": "is knocking on the wall",
  "ch_coward": "is chasing the coward button",
  "ch_shells": "is tracking the key",
  "ch_simon": "is repeating the blinks",
  "ch_blink": "is spotting who blinked",
  "ch_flashes": "is counting flashes",
  "ch_diff": "is spotting the difference",
  "ch_manual": "is reading the alarm wiring",
  "ch_rebus": "is solving a rebus",
  "ch_oddmeaning": "is finding the odd one out",
  "ch_dice": "is adding up dice",
  "mr_last_yellow": "If the last wire is yellow, cut the first. Otherwise cut the last.",
  "mr_even": "If there's an even number of wires, cut the second-to-last. Otherwise cut the first.",
  "mr_red": "If there's more than one red wire, cut the last red. Otherwise cut the second wire.",
  "mr_blue": "If there's a blue wire, cut the first blue. Otherwise cut the third wire.",
  "mr_white": "If there's exactly one white wire, cut it. Otherwise cut the last.",
  "mr_same": "Cut the wire nearest to the first one that has the same colour (but not the first).",
  "mr_black": "If the first wire is black, cut the second. Otherwise cut the first black.",
  "mr_green": "Cut the wire right after the first green one.",
  "color_red": "RED",
  "color_blue": "BLUE",
  "color_green": "GREEN",
  "color_yellow": "YELLOW",
  "color_purple": "PURPLE",
  "color_orange": "ORANGE",
  "days": "Mon|Tue|Wed|Thu|Fri|Sat|Sun",
  "q_true": "True",
  "q_false": "False",
  "t_dig": "Dig a tunnel! Tap the shovel",
  "dig_btn": "DIG",
  "t_saw": "Saw through the bars: drag back and forth",
  "saw_here": "Saw here",
  "t_lockpick": "Tap when the pin is in the green slot",
  "pick_btn": "CLICK",
  "t_searchlight": "Run when the searchlight is far away!",
  "run_btn": "RUN",
  "t_lineup1": "Remember the face",
  "t_lineup2": "Who was it?",
  "t_rollcall": "Roll call! Tap when your number goes by",
  "rollcall_mine": "Your number",
  "rollcall_btn": "HERE!",
  "t_keys": "Which key fits the lock?",
  "t_cipher": "Find the two matching symbols",
  "t_codelock": "Crack the lock code",
  "cl_sum": "The digits add up to {n}",
  "cl_diff": "The first digit is {n} more than the second",
  "cl_less": "The second digit is {n} more than the first",
  "cl_prod": "The digits multiply to {n}",
  "cl_twice": "The second digit is twice the first",
  "cl_twice1": "The first digit is twice the second",
  "cl_even0": "The first digit is even",
  "cl_odd0": "The first digit is odd",
  "cl_even1": "The second digit is even",
  "cl_odd1": "The second digit is odd",
  "cl_gt": "The code is greater than {n}",
  "cl_lt": "The code is less than {n}",
  "t_scales": "How many {s} make one {b}?",
  "t_clock": "What time is it?",
  "t_clock_plus": "What time will it be in {h} h {m} min?",
  "t_guard1": "Watch the guard",
  "t_guard2": "Where is he now?",
  "t_pass_phone": "{name} has the code. Make them read it out!",
  "t_pass_tv": "Your cellmate is silent — the code is on the big screen!",
  "hint_pass_title": "{name} is in the Cell, waiting for the code!",
  "hint_pass_say": "Read it out — or lie 😈",
  "hint_bet_escape": "Your bet: escapes",
  "hint_bet_burn": "Your bet: burns",
  "hint_bet_none": "You didn't bet on them",
  "bars_wrong": "Wrong! Bars down…",
  "ch_dig": "is digging a tunnel",
  "ch_saw": "is sawing the bars",
  "ch_lockpick": "is picking a lock",
  "ch_searchlight": "is dodging the searchlight",
  "ch_lineup": "is picking a suspect",
  "ch_rollcall": "is waiting for roll call",
  "ch_keys": "is trying keys",
  "ch_cipher": "is reading the cipher",
  "ch_codelock": "is cracking a code",
  "ch_scales": "is weighing fruit",
  "ch_clock": "is reading the clock",
  "ch_guard": "is watching the guard",
  "ch_pass": "is waiting for a message"
 },
 "el": {
  "t_wires": "Κόψε {n} καλώδια!",
  "t_wires5": "Κόψε {n} καλώδια!",
  "t_swipe": "Σύρε όπως δείχνουν τα βέλη",
  "swipe_here": "Σύρε εδώ",
  "t_hold": "Κράτα και άφησε στην πράσινη ζώνη",
  "hold_btn": "Κράτα",
  "t_order": "Πάτα με τη σειρά: 1 → {n}",
  "t_nopress": "Μην το πατάς. Σοβαρά",
  "nopress_btn": "ΜΗΝ",
  "now_btn": "Τώρα πάτα αυτό",
  "fake1": "ΠΑΤΑ;",
  "fake2": "έλα, πάτα",
  "t_catch1": "Πιάσε το κλειδί μία φορά",
  "t_catch": "Πιάσε το κλειδί {n} φορές",
  "t_catch5": "Πιάσε το κλειδί {n} φορές",
  "t_color": "Με τι χρώμα είναι γραμμένη η λέξη;",
  "t_odd": "Βρες το παράταιρο",
  "t_letter": "Βρες το διαφορετικό",
  "t_sad": "Βρες τον λυπημένο",
  "t_code": "Θυμήσου τον κωδικό",
  "t_code2": "Γράψε τον κωδικό",
  "t_count": "Πόσες μεγάλες πάπιες 🦆;",
  "t_quiz": "Ερώτηση",
  "t_tf": "Αλήθεια ή ψέμα;",
  "t_heavy": "Τι είναι πιο βαρύ;",
  "t_chrono": "Βάλε σε σειρά: από το παλιότερο στο νεότερο",
  "t_sudoku": "Ποιο ψηφίο μπαίνει στο «?» — χωρίς επαναλήψεις σε γραμμή και στήλη",
  "t_seq": "Τι ακολουθεί;",
  "t_math": "Υπολόγισε",
  "t_spark1": "Η σπίθα τρέχει στον συναγερμό: πάτα την μία φορά!",
  "t_spark": "Η σπίθα τρέχει στον συναγερμό: πάτα την {n} φορές!",
  "t_spark5": "Η σπίθα τρέχει στον συναγερμό: πάτα την {n} φορές!",
  "t_rhythm1": "Ο διπλανός χτυπά τον τοίχο — άκου…",
  "t_rhythm2": "Τώρα χτύπα τον ίδιο!",
  "rhythm_btn": "ΤΟΚ",
  "t_coward1": "Πιάσε το δειλό κουμπί μία φορά",
  "t_coward": "Πιάσε το δειλό κουμπί {n} φορές",
  "t_coward5": "Πιάσε το δειλό κουμπί {n} φορές",
  "coward_btn": "ΣΤΑΣΟΥ!",
  "t_shells1": "Πρόσεχε το κλειδί!",
  "t_shells2": "Πού είναι το κλειδί;",
  "t_simon1": "Θυμήσου…",
  "t_simon2": "Επανάλαβε!",
  "t_blink1": "Πρόσεχε — κάποιος θα ανοιγοκλείσει",
  "t_blink2": "Ποιος ανοιγόκλεισε;",
  "t_flashes1": "Μέτρα τις αναλαμπές",
  "t_flashes2": "Πόσες αναλαμπές ήταν;",
  "t_diff": "Βρες τη διαφορά και πάτα την κάτω",
  "t_manual": "Σχέδιο συναγερμού: ποιο καλώδιο κόβεις;",
  "t_rebus": "Λύσε το ρέμπους",
  "t_oddmeaning": "Ποιο είναι το παράταιρο;",
  "t_dice": "Πόσοι πόντοι συνολικά;",
  "grp_hands": "Επιδεξιότητα",
  "grp_eyes": "Προσοχή",
  "grp_head": "Μυαλό",
  "ch_wires": "κόβει καλώδια",
  "ch_swipe": "σέρνει",
  "ch_hold": "κρατά το κουμπί",
  "ch_order": "πατά με τη σειρά",
  "ch_nopress": "ΔΕΝ πατά",
  "ch_catch": "πιάνει το κλειδί",
  "ch_color": "βρίσκει το χρώμα",
  "ch_odd": "ψάχνει το παράταιρο",
  "ch_code": "θυμάται τον κωδικό",
  "ch_count": "μετρά πάπιες",
  "ch_letter": "ψάχνει γράμμα",
  "ch_sad": "ψάχνει τον λυπημένο",
  "ch_quiz": "απαντά σε ερώτηση",
  "ch_sudoku": "λύνει σουντόκου",
  "ch_seq": "συνεχίζει τη σειρά",
  "ch_math": "κάνει πράξεις",
  "ch_tf": "αποφασίζει: αλήθεια ή ψέμα",
  "ch_heavy": "ζυγίζει",
  "ch_chrono": "βάζει σε σειρά την ιστορία",
  "ch_spark": "σβήνει τη σπίθα",
  "ch_rhythm": "χτυπά τον τοίχο",
  "ch_coward": "κυνηγά το δειλό κουμπί",
  "ch_shells": "παρακολουθεί το κλειδί",
  "ch_simon": "επαναλαμβάνει τις αναλαμπές",
  "ch_blink": "ψάχνει ποιος ανοιγόκλεισε",
  "ch_flashes": "μετρά αναλαμπές",
  "ch_diff": "ψάχνει τη διαφορά",
  "ch_manual": "διαβάζει το σχέδιο συναγερμού",
  "ch_rebus": "λύνει ρέμπους",
  "ch_oddmeaning": "ψάχνει το παράταιρο",
  "ch_dice": "μετρά ζάρια",
  "mr_last_yellow": "Αν το τελευταίο καλώδιο είναι κίτρινο, κόψε το πρώτο. Αλλιώς το τελευταίο.",
  "mr_even": "Αν τα καλώδια είναι ζυγός αριθμός, κόψε το προτελευταίο. Αλλιώς το πρώτο.",
  "mr_red": "Αν τα κόκκινα είναι πάνω από ένα, κόψε το τελευταίο κόκκινο. Αλλιώς το δεύτερο καλώδιο.",
  "mr_blue": "Αν υπάρχει μπλε καλώδιο, κόψε το πρώτο μπλε. Αλλιώς το τρίτο καλώδιο.",
  "mr_white": "Αν υπάρχει ακριβώς ένα λευκό, κόψε το. Αλλιώς το τελευταίο.",
  "mr_same": "Κόψε το πιο κοντινό στο πρώτο καλώδιο με το ίδιο χρώμα (όχι το πρώτο).",
  "mr_black": "Αν το πρώτο καλώδιο είναι μαύρο, κόψε το δεύτερο. Αλλιώς το πρώτο μαύρο.",
  "mr_green": "Κόψε το καλώδιο αμέσως μετά το πρώτο πράσινο.",
  "color_red": "ΚΟΚΚΙΝΟ",
  "color_blue": "ΜΠΛΕ",
  "color_green": "ΠΡΑΣΙΝΟ",
  "color_yellow": "ΚΙΤΡΙΝΟ",
  "color_purple": "ΜΩΒ",
  "color_orange": "ΠΟΡΤΟΚΑΛΙ",
  "days": "Δευ|Τρί|Τετ|Πέμ|Παρ|Σάβ|Κυρ",
  "q_true": "Αλήθεια",
  "q_false": "Ψέμα",
  "t_dig": "Σκάψε τούνελ! Πάτα το φτυάρι",
  "dig_btn": "ΣΚΑΨΕ",
  "t_saw": "Πριόνισε τα κάγκελα: σύρε πέρα-δώθε",
  "saw_here": "Πριόνισε εδώ",
  "t_lockpick": "Πάτα όταν ο πείρος είναι στην πράσινη σχισμή",
  "pick_btn": "ΚΛΙΚ",
  "t_searchlight": "Τρέξε όταν ο προβολέας είναι μακριά!",
  "run_btn": "ΤΡΕΞΕ",
  "t_lineup1": "Θυμήσου το πρόσωπο",
  "t_lineup2": "Ποιος ήταν;",
  "t_rollcall": "Προσκλητήριο! Πάτα όταν περάσει ο αριθμός σου",
  "rollcall_mine": "Ο αριθμός σου",
  "rollcall_btn": "ΠΑΡΩΝ!",
  "t_keys": "Ποιο κλειδί ταιριάζει στην κλειδαριά;",
  "t_cipher": "Βρες τα δύο ίδια σύμβολα",
  "t_codelock": "Βρες τον κωδικό",
  "cl_sum": "Άθροισμα ψηφίων: {n}",
  "cl_diff": "Το πρώτο ψηφίο είναι κατά {n} μεγαλύτερο από το δεύτερο",
  "cl_less": "Το δεύτερο ψηφίο είναι κατά {n} μεγαλύτερο από το πρώτο",
  "cl_prod": "Γινόμενο ψηφίων: {n}",
  "cl_twice": "Το δεύτερο ψηφίο είναι το διπλάσιο του πρώτου",
  "cl_twice1": "Το πρώτο ψηφίο είναι το διπλάσιο του δεύτερου",
  "cl_even0": "Το πρώτο ψηφίο είναι ζυγό",
  "cl_odd0": "Το πρώτο ψηφίο είναι μονό",
  "cl_even1": "Το δεύτερο ψηφίο είναι ζυγό",
  "cl_odd1": "Το δεύτερο ψηφίο είναι μονό",
  "cl_gt": "Ο κωδικός είναι μεγαλύτερος από {n}",
  "cl_lt": "Ο κωδικός είναι μικρότερος από {n}",
  "t_scales": "Πόσα {s} κάνουν ένα {b};",
  "t_clock": "Τι ώρα είναι;",
  "t_clock_plus": "Τι ώρα θα είναι σε {h} ώρ. {m} λεπ.;",
  "t_guard1": "Πρόσεχε τον φύλακα",
  "t_guard2": "Πού είναι τώρα;",
  "t_pass_phone": "Τον κωδικό τον έχει: {name}. Ζήτα να τον πει!",
  "t_pass_tv": "Ο συγκρατούμενος σωπαίνει — ο κωδικός είναι στη μεγάλη οθόνη!",
  "hint_pass_title": "{name} περιμένει τον κωδικό στο Κελί!",
  "hint_pass_say": "Πες τον — ή πες ψέματα 😈",
  "hint_bet_escape": "Το στοίχημά σου: θα γλιτώσει",
  "hint_bet_burn": "Το στοίχημά σου: θα καεί",
  "hint_bet_none": "Δεν στοιχημάτισες γι' αυτόν/ήν",
  "bars_wrong": "Λάθος! Τα κάγκελα κλείνουν…",
  "ch_dig": "σκάβει τούνελ",
  "ch_saw": "πριονίζει τα κάγκελα",
  "ch_lockpick": "παραβιάζει κλειδαριά",
  "ch_searchlight": "αποφεύγει τον προβολέα",
  "ch_lineup": "αναγνωρίζει ύποπτο",
  "ch_rollcall": "περιμένει το προσκλητήριο",
  "ch_keys": "δοκιμάζει κλειδιά",
  "ch_cipher": "διαβάζει τον κώδικα",
  "ch_codelock": "σπάει τον κωδικό",
  "ch_scales": "ζυγίζει φρούτα",
  "ch_clock": "κοιτάει το ρολόι",
  "ch_guard": "παρακολουθεί τον φύλακα",
  "ch_pass": "περιμένει μήνυμα"
 }
};
(function mergeDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const l of Object.keys(STR)) d[l] = Object.assign({}, STR[l], d[l] || {});
})();

function mount(c, pad, task, ctx) {
  K = ctx;
  pad.replaceChildren();
  delete pad.__lqcUpdate;
  task.textContent = "";
  (RENDER[c.type] || RENDER.fallback)(c, pad, task);
}
function update(c, pad) {
  if (pad && pad.__lqcUpdate) pad.__lqcUpdate(c);
}
// Решётка после ошибки (§4.1): прутья падают на pad, на ms мс он недоступен
function bars(pad, ms) {
  const b = el("div", "lqbars");
  b.append(el("span", null, T("bars_wrong")));
  pad.append(b);
  if (!reduceMotion()) { pad.classList.remove("shake"); void pad.offsetWidth; pad.classList.add("shake"); }
  setTimeout(() => b.remove(), ms);
  return b;
}

window.LQC = { mount, update, bars, types: Object.keys(RENDER).filter((t) => t !== "fallback"), faceSvg, keySvg, glyphSvg, clockSvg, GLYPHS, STR };
})();
