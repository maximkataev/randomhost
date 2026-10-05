"use strict";

/*
 * Пульт для агентов-игроков «Последнего вопроса»: игра из командной строки, по одной команде за вызов (как wave/play.js).
 *   node play.js <base> <code> <name> join
 *   node play.js <base> <code> <name> state                 — что сейчас на экране у этого игрока
 *   node play.js <base> <code> <name> wait [сек]            — ждать смены фазы / своего испытания (до 90 с), потом state
 *   node play.js <base> <code> <name> answer <0..3|A..D>    — ответ на вопрос (A=0 … D=3)
 *   node play.js <base> <code> <name> group hands|eyes|head — палач выбирает набор испытаний
 *   node play.js <base> <code> <name> cell '<json>'         — ответ на своё текущее испытание, напр. '{"v":2}'
 *   node play.js <base> <code> <name> cell auto             — испытания на время и «механика» (hold, nopress, rollcall,
 *                                                             lockpick, searchlight, rhythm, dig, saw, wires, catch, spark,
 *                                                             coward, swipe, order): пульт сам считает ответ по view
 *   node play.js <base> <code> <name> bet <имя узника> y|n  — ставка «спасётся» (y) / «сгорит» (n), одна на узника
 *   node play.js <base> <code> <name> stake <n>             — ставка в финале (0…max)
 *   node play.js <base> <code> <name> react 😂
 *   node play.js <base> <code> host <hostToken> start|short|long|final-on|final-off|end|lobby|kick <имя>
 * Токен игрока — в state/play-<code>-<name>.json.
 * Комната для агентов: POST /lastq/api/rooms {speed: 0.15} (только dev), сервер с OFFLINE_GRACE_MS=3600000 —
 * иначе между командами агент «офлайн» и его пропускают.
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const [base, code, name, cmd, ...rest] = process.argv.slice(2);
if (!base || !code || !name || !cmd) { console.log("usage: node play.js <base> <code> <name> <cmd> [...]"); process.exit(2); }
const wsUrl = base.replace(/^http/, "ws") + "/lastq/ws?r=" + encodeURIComponent(code);
const tokFile = path.join(__dirname, "state", `play-${code}-${name.replace(/[^\p{L}\p{N}]/gu, "_")}.json`);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const inbox = [];
    let waiter = null;
    ws.on("message", (raw) => { const m = JSON.parse(raw); inbox.push(m); if (waiter) { const w = waiter; waiter = null; w(); } });
    ws.on("open", () => resolve({ ws, next: (ms) => new Promise((r) => { if (inbox.length) return r(inbox.shift()); const t = setTimeout(() => { waiter = null; r(null); }, ms); waiter = () => { clearTimeout(t); r(inbox.shift()); }; }), send: (m) => ws.send(JSON.stringify(m)) }));
    ws.on("error", reject);
  });
}

async function session() {
  const c = await connect();
  let state = null, me = null;
  for (;;) { const m = await c.next(5000); if (!m) break; if (m.type === "hello") { state = m.state; break; } }
  if (name === "host") {
    c.send({ type: "host", token: cmd });
    return { c, state, me: null };
  }
  let token = null;
  try { token = JSON.parse(fs.readFileSync(tokFile, "utf8")).token; } catch {}
  if (cmd === "join" && !token) c.send({ type: "join", name });
  else if (token) c.send({ type: "join", token });
  else { console.log("сначала: join"); process.exit(1); }
  for (;;) {
    const m = await c.next(5000);
    if (!m) break;
    if (m.type === "joined") { me = m.playerId; fs.mkdirSync(path.dirname(tokFile), { recursive: true }); fs.writeFileSync(tokFile, JSON.stringify({ token: m.token })); }
    if (m.type === "state") state = m.state;
    if (m.type === "error") { console.log("ошибка: " + m.error); process.exit(1); }
    if (me && state && state.me) break; // hello приходит до входа — в нём ещё нет «меня»
  }
  return { c, state, me };
}

const L = ["A", "B", "C", "D"];

// ---------- подписи: словари страниц (lastq-shared.js, lastq-challenges.js), язык комнаты ----------
// Пульт — инструмент разработки, файлы страниц лежат рядом (в корне сайта). Нет файла — показываем сырые ключи.
function loadDict(file, marker, end) {
  try {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const i = src.indexOf(marker);
    const j = src.indexOf(end, i);
    return new Function("return (" + src.slice(i + marker.length - 1, j + 2) + ")")();
  } catch { return {}; }
}
const DICT = (() => {
  const a = loadDict("lastq-shared.js", "const LQ_SHARED_I18N = {", "\n};");
  const b = loadDict("lastq-challenges.js", "const STR = {", "\n};");
  const out = {};
  for (const l of ["ru", "en", "el"]) out[l] = Object.assign({}, (b || {})[l], (a || {})[l]);
  return out;
})();
let LANG = "ru";
const T = (k, vars) => {
  const d = DICT[LANG] || {};
  const v = k in d ? d[k] : k in (DICT.ru || {}) ? DICT.ru[k] : k;
  return String(v).replace(/\{(\w+)\}/g, (m, x) => (vars && x in vars ? String(vars[x]) : m));
};
const tx = (o) => (o && typeof o === "object" ? o[LANG] || o.ru || o.en || "" : String(o == null ? "" : o));
const topic = (t) => (T("t_" + t) === "t_" + t ? t : T("t_" + t));
const groupName = (g) => T("g_" + g);
const chLabel = (t) => (T("ch_" + t) === "ch_" + t ? t : T("ch_" + t));
const secStr = (ms) => (Math.round(ms / 100) / 10).toFixed(1).replace(".", LANG === "en" ? "." : ",") + (LANG === "en" ? " s" : LANG === "el" ? " δ" : " с");
const num = (n) => (n < 0 ? "−" + Math.abs(n) : String(n));
// ключ по числу, как в lastq-challenges.js: key1 / key / key5 (в EN/EL — только 1 или много)
function plural(key, n) {
  const a = Math.abs(n) % 100, b = a % 10;
  const k = LANG !== "ru" ? (n === 1 ? key + "1" : key + "5") : b === 1 && a !== 11 ? key + "1" : b >= 2 && b <= 4 && (a < 12 || a > 14) ? key : key + "5";
  return T(k, { n }) !== k ? T(k, { n }) : T(key, { n });
}
const colorName = (k) => (T("color_" + k) === "color_" + k ? k : T("color_" + k));
const REACTIONS = ["😂", "😱", "😈", "👏", "🙏"];
const REASON = {
  not_now: "сейчас этого сделать нельзя (фаза другая)", already: "уже сделано — второй раз нельзя", not_in_question: "ты не участвуешь в этом вопросе",
  bad: "неверное значение", not_palach: "ты не палач", not_free: "ставят только свободные (не узники)", closed: "окно ставок закрыто",
  few_players: "нужно хотя бы двое", started: "партия уже идёт", no_content: "нет вопросов", stale: "испытание уже сменилось",
};

// ---------- испытания: задание, понятный view и формат ответа ----------
const DIR = { u: "↑ вверх (u)", d: "↓ вниз (d)", l: "← влево (l)", r: "→ вправо (r)" };
const opts = (a) => a.map((o, i) => `${i}) ${tx(o)}`).join("   ");
const grid = (items, cols) => { const rows = []; for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols).map((x, k) => `${i + k}:${tx(x)}`).join("  ")); return rows.join("\n      "); };
const IDX = `cell '{"v":<индекс>}'`;
// [задание, описание view, формат ответа]
function chInfo(ch, P) {
  const v = ch.view, t = ch.type;
  const auto = "cell auto — пульт сам посчитает и отправит вовремя";
  switch (t) {
    case "wires": return [plural("t_wires", v.n), `проводов перерезать: ${v.n}`, auto];
    case "swipe": return [T("t_swipe"), `стрелки по порядку: ${v.dirs.map((d) => DIR[d]).join(", ")}`, `${auto} (или cell '{"v":${JSON.stringify(v.dirs)}}')`];
    case "hold": return [T("t_hold"), `полоса заполняется за ${v.full} мс, зелёная зона ${v.from}–${v.to} мс от выдачи`, auto];
    case "order": return [T("t_order", { n: v.n }), `кнопки 1…${v.n}`, auto];
    case "nopress": return [T("t_nopress"), `не жать ${v.wait} мс (обманок: ${v.fakes})`, auto];
    case "catch": return [plural("t_catch", v.hits), `поймать: ${v.hits}`, auto];
    case "coward": return [plural("t_coward", v.hits), `поймать: ${v.hits}`, auto];
    case "spark": return [plural("t_spark", v.n), `тапнуть по искре: ${v.n}`, auto];
    case "dig": return [T("t_dig"), `тапов по лопате: ${v.n}`, auto];
    case "saw": return [T("t_saw"), `прутьев: ${v.bars}, движений пилы на прут: ${v.strokes}`, auto];
    case "rhythm": return [T("t_rhythm2"), `промежутки между ударами: ${v.gaps.join(", ")} мс`, auto];
    case "lockpick": return [T("t_lockpick"), `штифтов: ${v.pins.length}`, auto];
    case "searchlight": return [T("t_searchlight"), `перебежек: ${v.n}`, auto];
    case "rollcall": return [T("t_rollcall"), `твой номер ${v.mine}; бегут: ${v.list.join(", ")} (по ${v.step} мс)`, auto];
    case "color": return [T("t_color"), `слово «${colorName(v.word)}», написано цветом ${colorName(v.ink)}; варианты: ${opts(v.options.map(colorName))}`, IDX];
    case "odd": case "letter": case "sad": return [T("t_" + t), `клетки:\n      ${grid(v.items, v.items.length > 9 ? 4 : 3)}`, IDX + " — номер клетки"];
    case "oddmeaning": return [T("t_oddmeaning"), `варианты: ${opts(v.items)}`, IDX];
    case "count": return [T("t_count"), `${v.items.join("")}; варианты: ${opts(v.options)}`, IDX + " — индекс варианта, не само число"];
    case "code": return [T("t_code2"), `код (на экране его показывают ${v.show} мс): ${v.digits}`, `cell '{"v":"<код>"}' — код строкой`];
    case "pass": {
      const helper = v.where === "tv" ? "на общем экране" : `его знает ${P(v.helper)} — подсказчик видит код у себя`;
      return [v.where === "tv" ? T("t_pass_tv") : T("t_pass_phone", { name: P(v.helper) }), `код из ${v.n} цифр; ${helper}`, `cell '{"v":"<${v.n} цифр>"}' — код строкой`];
    }
    case "quiz": return [T("t_quiz"), `${tx(v.q)}  варианты: ${opts(v.options)}`, IDX];
    case "tf": return [T("t_tf"), `«${tx(v.q)}»  0) ${T("q_true")}   1) ${T("q_false")}`, IDX];
    case "heavy": return [T("t_heavy"), opts(v.options), IDX];
    case "rebus": return [T("t_rebus"), `${v.q}  варианты: ${opts(v.options)}`, IDX];
    case "chrono": return [T("t_chrono"), opts(v.items), `cell '{"v":[i,j,k]}' — индексы от древнего к новому`];
    case "sudoku": return [T("t_sudoku"), `сетка ${v.n}×${v.n} (пусто — «.»), спрашивают клетку строка ${v.target[0]}, столбец ${v.target[1]} (с нуля):\n      ${v.cells.map((r) => r.map((x) => (x == null ? "." : x)).join(" ")).join("\n      ")}`, `cell '{"v":<цифра>}' — сама цифра`];
    case "seq": return [T("t_seq"), `${v.items.map(tx).join(", ")}, ?  варианты: ${opts(v.options)}`, IDX];
    case "math": return [T("t_math"), `${v.text} = ?  варианты: ${opts(v.options)}`, IDX];
    case "dice": return [T("t_dice"), `кубики: ${v.dice.join(", ")}  варианты: ${opts(v.options)}`, IDX];
    case "manual": return [T("t_manual"), `правило: ${T("mr_" + v.rule)}  провода по порядку: ${opts(v.wires.map(colorName))}`, IDX + " — номер провода"];
    case "diff": return [T("t_diff"), `сетка ${v.side}×${v.side}; верх: ${v.top.join("")}; низ: ${v.bottom.join("")}`, IDX + " — номер клетки, где низ отличается"];
    case "shells": return [T("t_shells2"), `стаканов: ${v.cups}, предмет под стаканом ${v.start}; перестановки: ${v.swaps.map((s) => s.join("↔")).join(", ")}`, IDX + " — где предмет после перестановок"];
    case "simon": return [T("t_simon2"), `мигание: ${v.seq.join(", ")} (кнопки 0–3)`, `cell '{"v":${JSON.stringify(v.seq)}}'`];
    case "blink": return [T("t_blink2"), `лица:\n      ${grid(v.items, 4)}\n      моргнул (стал ${v.to}) номер ${v.cell}`, IDX + " — номер клетки"];
    case "flashes": return [T("t_flashes2"), `вспышек было: ${v.count}; варианты: ${opts(v.options)}`, IDX];
    case "lineup": {
      const f = (x) => `шляпа ${x.h}, очки ${x.g}, усы ${x.m}`;
      return [T("t_lineup2"), `фоторобот: ${f(v.target)}; подозреваемые: ${v.suspects.map((x, i) => `${i}) ${f(x)}`).join("; ")}`, IDX];
    }
    case "keys": return [T("t_keys"), `бородка замка: ${v.lock.join("")}; ключи: ${v.keys.map((k, i) => `${i}) ${k.join("")}`).join("  ")} (зеркальный не подходит)`, IDX];
    case "cipher": return [T("t_cipher"), `8 знаков (g — форма, r — поворот, m — зеркало; одинаковые — совпадает всё): ${v.items.map((x, i) => `${i}) g${x.g} r${x.r} m${x.m}`).join("  ")}`, `cell '{"v":[i,j]}' — два индекса, меньший первым`];
    case "codelock": return [T("t_codelock"), `подсказки: ${v.clues.map((c) => T("cl_" + c.k, { n: c.n })).join("; ")}  варианты: ${opts(v.options)}`, IDX];
    case "scales": return [T("t_scales", { s: v.ask[1], b: v.ask[0] }), `${v.eq.map(([a, b, n]) => `${a} = ${b}×${n}`).join(", ")}; сколько ${v.ask[1]} в одном ${v.ask[0]}? варианты: ${opts(v.options)}`, IDX];
    case "clock": return [v.plus ? T("t_clock_plus", { h: v.plus[0], m: v.plus[1] }) : T("t_clock"), `стрелки показывают ${v.h}:${String(v.m).padStart(2, "0")}${v.plus ? `, прибавить ${v.plus[0]} ч ${v.plus[1]} мин` : ""}; варианты: ${opts(v.options)}`, IDX];
    case "guard": return [T("t_guard2"), `сетка 3×3, клетки 0–8 слева направо, сверху вниз (0 1 2 / 3 4 5 / 6 7 8); охранник стартует в ${v.start}, ходы: ${v.dirs.map((d) => DIR[d]).join(", ")}`, IDX + " — клетка, где он остановился"];
    default: return [chLabel(t), JSON.stringify(v), IDX];
  }
}

// треугольная волна — как в lastq/challenges.js (штифты «Отмычки», луч «Прожектора»)
function tri(x) { const f = ((x % 1) + 1) % 1; return f < 0.5 ? f * 2 : 2 - f * 2; }
// ответ по view: моменты (мс от выдачи испытания) — те же формулы, что у генератора в lastq/challenges.js
const AUTO = {
  hold: (v) => Math.round((v.from + v.to) / 2),
  nopress: () => 0,
  rollcall: (v) => { const k = v.list.indexOf(v.mine); return v.lead + k * v.step + Math.round(v.step / 2); },
  rhythm: (v) => v.gaps.slice(),
  lockpick: (v) => {
    let t0 = 500;
    return v.pins.map((p) => { let t = t0; while (Math.abs(tri(t / p.period + p.phase) - p.c) >= v.half * 0.5) t += 10; t0 = t + 250; return t; });
  },
  searchlight: (v) => {
    let t0 = 500;
    return v.covers.map((x) => { let t = t0; while (Math.abs(tri(t / v.period + v.phase) - x) <= v.half + 0.05) t += 10; t0 = t + 450; return t; });
  },
  dig: (v) => v.n, wires: (v) => v.n, spark: (v) => v.n, catch: (v) => v.hits, coward: (v) => v.hits,
  saw: (v) => v.bars * v.strokes,
  swipe: (v) => v.dirs.slice(),
  order: (v) => Array.from({ length: v.n }, (_, i) => i + 1),
};

const FSTEP_MS = 3000;
// нужно ли сейчас что-то делать этому игроку: [ключ события, текст «ТВОЙ ХОД»] или null.
// now — часы комнаты (pong.t перед ожиданием, дальше — serverNow свежего снимка)
function needAction(s, now) {
  const my = s.me;
  if (!my) return null;
  const ph = s.phase;
  if ((ph === "answer" || ph === "fanswer") && my.inQuestion && my.answer == null) return ["answer:" + s.qn + ph, `ответь на вопрос → answer <A..D>, осталось ~${Math.max(0, Math.round((s.phaseEnd - now) / 1000))} с`];
  if (ph === "reveal" && my.palach) return ["palach:" + s.qn, "ты палач — выбери набор испытаний → group hands|eyes|head"];
  if (ph === "cell" || ph === "fcell") {
    const c = my.cell;
    if (c && c.ch && !c.escaped && !c.burned) return ["ch:" + c.ch.id, `твоё испытание #${c.ch.id} (${c.ch.type}) → ${AUTO[c.ch.type] ? "cell auto" : "cell '{\"v\":…}'"}`];
    if (my.free && s.betUntil && now < s.betUntil) {
      const left = (s.cell || []).filter((x) => !x.escaped && !x.burned && (my.bets || {})[x.id] == null);
      if (left.length) return ["bet:" + s.qn + ph + left.length, `поставь на узников (${left.map((x) => (s.players.find((p) => p.id === x.id) || {}).name).join(", ")}) → bet <имя> y|n, осталось ~${Math.max(0, Math.round((s.betUntil - now) / 1000))} с`];
    }
    // «Передачка» — не повод будить wait: подсказчик ничего не отправляет, код печатается в описании ниже
  }
  if (ph === "stake" && my.inQuestion && my.stake == null) return ["stake:" + s.game, `поставь в финале → stake <0..${my.maxStake}>, осталось ~${Math.max(0, Math.round((s.phaseEnd - now) / 1000))} с`];
  return null;
}

function describe(s, me) {
  LANG = (s.settings && s.settings.lang) || "ru";
  const P = (id) => (s.players.find((p) => p.id === id) || { name: "?" }).name;
  const out = [];
  const now = s.serverNow;
  const need = needAction(s, now);
  if (need) out.push(`\n######## ТВОЙ ХОД: ${need[1]} ########\n`);
  const sec = (t) => (t == null ? "?" : Math.max(0, Math.round((t - now) / 1000)));
  const inGame = s.phase !== "lobby" && s.phase !== "finished";
  const final = s.act === 3;
  const where = final ? "ФИНАЛ" : s.qn >= 0 ? `вопрос ${s.qn + 1}/${s.qTotal}, акт ${s.act} «${T("act" + s.act)}»` : "";
  out.push(`ФАЗА: ${s.phase}${inGame && where ? " · " + where : ""}${inGame && s.phaseEnd ? ` · до конца фазы ~${sec(s.phaseEnd)} игровых с` : ""}${s.paused ? " · ПАУЗА (все офлайн)" : ""}`);
  const my = s.me || {};
  const q = s.question;
  if (s.phase === "lobby") out.push(`В лобби: ${s.players.filter((p) => !p.left).map((p) => p.name).join(", ")}. Настройки: короткая=${s.settings.short}, финал=${s.settings.final}, язык=${s.settings.lang}`);
  if (s.phase === "intro") out.push(`Заставка: акт ${s.act} «${T("act" + s.act)}»${s.points ? `: верно +${s.points.right} (+до ${s.points.speed} за скорость), не выбрался из Камеры −${s.points.knock}` : ""}`);
  if (q && q.text) {
    out.push(`ВОПРОС [${topic(q.tag)}]: ${q.text}`);
    out.push(q.options.map((o, i) => `  ${i}) ${L[i]}. ${o}${s.right === i ? "   ← ВЕРНЫЙ" : ""}${s.right != null && my.answer === i && s.right !== i ? "   ← твой ответ" : ""}`).join("\n"));
  }
  if (s.phase === "read" || s.phase === "fread") out.push(`Кнопки откроются через ~${sec(s.phaseEnd)} с. Можно уже сейчас: answer <A..D> — пульт дождётся открытия и отправит.`);
  if (s.phase === "answer" || s.phase === "fanswer") {
    if (!my.inQuestion) out.push(final ? "В финале ты не участвуешь — смотри." : "Ты вошёл посреди партии — отвечаешь со следующего вопроса.");
    else if (my.answer != null) out.push(`Твой ответ: ${L[my.answer]}. Ответили ${(s.answered || []).length}/${s.eligible.length}.`);
    else out.push(`ОТВЕТЬ: answer <A..D>.${final ? " Бонуса за скорость в финале нет." : " Чем быстрее, тем больше бонус."} Ответили ${(s.answered || []).length}/${s.eligible.length}.`);
  }
  if (s.phase === "reveal" || s.phase === "fshow") {
    if (my.inQuestion) out.push(my.answer === s.right ? `ВЕРНО!${my.gain ? " +" + my.gain : ""}` : `МИМО — ты в ${s.phase === "fshow" ? "финальной Камере" : "Камере"}.`);
    if (s.prisoners && s.prisoners.length) out.push(`В Камеру: ${s.prisoners.map(P).join(", ")}`);
    else out.push(final ? "Все ответили верно — сразу раскрываем ставки." : "Все верно — Камеры не будет.");
    if (my.palach) out.push(`ТЫ ПАЛАЧ: выбери набор для узников → group hands|eyes|head (hands — ${groupName("hands")}: ${T("g_hands_d")}; eyes — ${groupName("eyes")}: ${T("g_eyes_d")}; head — ${groupName("head")}: ${T("g_head_d")})`);
    else if (s.group) out.push(`Набор: «${groupName(s.group)}»${s.palach && !s.groupAuto ? ", выбрал " + P(s.palach) : ", случайно"}`);
    else if (s.palach) out.push(`Палач ${P(s.palach)} выбирает набор…`);
  }
  if (s.phase === "cell" || s.phase === "fcell") {
    out.push(`КАМЕРА «${groupName(s.group)}»: до конца ~${sec(s.cellEnd)} с`);
    for (const x of s.cell || []) out.push(`  ${P(x.id)}: ${x.done}/${x.need}${x.escaped ? " ВЫРВАЛСЯ" : x.burned ? " сгорел" : x.locked ? " (решётка)" : x.type ? " · " + chLabel(x.type) : ""}`);
    const c = my.cell;
    if (c && !c.escaped && !c.burned) {
      if (c.ch) {
        const [task, view, fmt] = chInfo(c.ch, P);
        out.push(`ТВОЁ ИСПЫТАНИЕ #${c.ch.id}: «${task}» (${c.ch.type}, уровень ${c.ch.lvl}), прогресс ${c.done}/${c.need}`);
        out.push(`  что на экране: ${view}`);
        out.push(`  ответ: ${AUTO[c.ch.type] ? "cell auto — пульт сам посчитает по экрану и отправит вовремя" : fmt}. Ошибка — решётка 1,5 с и новое испытание.`);
      } else out.push(`Твоё испытание откроется через ~${sec(c.readyAt || c.lockUntil)} с (${c.lockUntil > now ? "решётка" : "приготовься"}) → wait`);
    } else if (c && c.escaped) out.push("Ты вырвался! Жди приговора.");
    if (my.free) {
      const open = s.betUntil && now < s.betUntil;
      out.push(open ? `СТАВКИ (ещё ~${sec(s.betUntil)} с): bet <имя> y|n — y = спасётся, n = сгорит; одна на узника, +20 за угаданное` : "Ставки закрыты.");
      const mine = Object.entries(my.bets || {}).map(([id, v]) => `${P(id)}: ${v ? "спасётся" : "сгорит"}`);
      if (mine.length) out.push("  твои ставки: " + mine.join(", "));
    }
    for (const h of my.passHints || []) {
      out.push(`ПЕРЕДАЧКА — ты подсказчик. ${P(h.prisoner)} ждёт код:\n\n        ${h.code.split("").join("  ")}\n`);
      out.push(`  Продиктуй (агентам: напиши ${P(h.prisoner)} в чат) — или соври 😈. Твоя ставка на ${P(h.prisoner)}: ${h.bet == null ? "нет" : h.bet ? "спасётся" : "сгорит"}`);
    }
  }
  if (s.phase === "verdict" && s.verdict) {
    const v = s.verdict;
    out.push(`ПРИГОВОР: вырвались — ${v.escaped.map(P).join(", ") || "никто"}; отлетают — ${v.burned.map((id) => `${P(id)} ${num(v.delta[id] || 0)}`).join(", ") || "никто"}`);
    const myBets = Object.entries((v.bets || {})[me] || {});
    if (myBets.length) out.push("Твои ставки: " + myBets.map(([id, esc]) => `${P(id)} — «${esc ? "спасётся" : "сгорит"}»: ${esc === v.escaped.includes(id) ? "выиграла +20" : "не сыграла"}`).join("; "));
    const bg = Object.entries(v.betGain || {}).filter(([, n]) => n).map(([id, n]) => `${P(id)} +${n}`);
    if (bg.length) out.push("За ставки: " + bg.join(", "));
  }
  if (s.phase === "stake") {
    out.push(`ФИНАЛ, ставки. Тема: «${q ? topic(q.tag) : "?"}». ${my.stake != null ? `Твоя ставка: ${my.stake} (можно изменить)` : `ПОСТАВЬ: stake <0..${my.maxStake}>`}. Поставили ${s.stakedN}/${s.eligible.length}. Верно — +ставка; мимо — −ставка (выбрался из Камеры — −половина).`);
  }
  if (s.phase === "freveal" && s.fsteps) {
    out.push("РАСКРЫТИЕ СТАВОК (снизу вверх, по шагу в 3 игровых с):");
    s.fsteps.forEach((x, i) => {
      const shown = now >= s.phaseStart + FSTEP_MS * i + 1500;
      out.push(shown ? `  ${P(x.id)}: ставка ${x.stake}, ${x.right ? "верно" : x.escaped ? "мимо, выбрался" : "мимо"} → ${x.delta > 0 ? "+" + x.delta : num(x.delta)}: ${num(x.before)} → ${num(x.after)}` : `  ${P(x.id)}: ещё не раскрыто (было ${num(x.before)})`);
    });
  }
  if ((inGame && s.phase !== "freveal") || s.phase === "finished") {
    out.push("СЧЁТ: " + s.players.filter((p) => !p.left).sort((a, b) => b.score - a.score).map((p) => `${p.name} ${num(p.score)}${p.id === me ? " (ты)" : ""}${p.online ? "" : " [офлайн]"}`).join(", "));
  }
  if (s.phase === "finished") {
    for (const r of s.ranking || []) out.push(`  ${r.place} место — ${P(r.id)} (${num(r.score)})`);
    const a = s.awards || {};
    for (const [k, x] of Object.entries(a)) {
      if (!x) continue;
      const d = T("aw_" + k + "_d", { n: k === "bottom" ? num(x.n) : x.n, s: k === "rocket" ? secStr(x.n).replace(/ .*/, "") : "" });
      out.push(`Награда «${T("aw_" + k)}»: ${x.ids.map(P).join(", ")} — ${d}`);
    }
    out.push(`ИГРА ОКОНЧЕНА (${s.finishedReason === "done" ? "доиграли" : s.finishedReason === "few" ? "игроков меньше двух" : "ведущий закончил"}).`);
  }
  return out.join("\n");
}

(async () => {
  const { c, state: first, me } = await session();
  let state = first;
  // часы комнаты: ping → pong.t (= clock(room)); у комнаты агентов speed < 1, реальные мс тут не годятся
  const serverTime = async () => {
    const tag = Date.now() + Math.random();
    c.send({ type: "ping", c: tag });
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const m = await c.next(until - Date.now());
      if (!m) break;
      if (m.type === "pong" && m.c === tag) return m.t;
      if (m.type === "state") state = m.state;
    }
    return state.serverNow;
  };
  const waitServer = async (target) => {
    for (;;) {
      const t = await serverTime();
      if (t >= target) return;
      await new Promise((r) => setTimeout(r, Math.min(400, Math.max(60, (target - t) / 4))));
    }
  };
  const drain = async () => { for (let m; (m = await c.next(50));) if (m.type === "state") state = m.state; };
  // после действия собираем всё, что пришло за полсекунды, и берём последний снимок
  let rejected = null;
  const act = async (msg, keepTrying) => {
    rejected = null;
    await new Promise((r) => setTimeout(r, 200));
    await drain();
    c.send(msg);
    let tries = 0;
    let until = Date.now() + (keepTrying ? 60000 : 700);
    while (Date.now() < until) {
      const m = await c.next(until - Date.now());
      if (!m) break;
      if (m.type === "rejected") {
        // испытание: «рано»/«решётка» — не провал, ждём ещё 200 игровых мс и шлём снова
        if (keepTrying && (m.reason === "early" || m.reason === "locked") && tries++ < 20) {
          const lock = state.me && state.me.cell ? state.me.cell.lockUntil || 0 : 0;
          await waitServer(Math.max((await serverTime()) + 200, lock + 60));
          c.send(msg);
          continue;
        }
        console.log("ОТКАЗ: " + (REASON[m.reason] || m.reason));
        rejected = m.reason;
        break;
      }
      if (m.type === "state") { state = m.state; if (!keepTrying) continue; const ch = state.me && state.me.cell && state.me.cell.ch; if (!ch || ch.id !== msg.cid) break; }
    }
    await drain();
  };
  if (name === "host") {
    await new Promise((r) => setTimeout(r, 300));
    const a = rest[0];
    if (a === "start") await act({ type: "start" });
    if (a === "short" || a === "long") await act({ type: "settings", settings: { short: a === "short" } });
    if (a === "final-on" || a === "final-off") await act({ type: "settings", settings: { final: a === "final-on" } });
    if (a === "end") await act({ type: "end" });
    if (a === "lobby") await act({ type: "lobby" });
    if (a === "kick") {
      const p = state.players.find((x) => x.name.toLowerCase() === String(rest[1] || "").toLowerCase() || x.id === rest[1]);
      if (!p) console.log("нет такого игрока: " + rest[1]);
      else await act({ type: "kick", playerId: p.id });
    }
    console.log(describe(state, null));
    process.exit(0);
  }
  const P = (n) => { const p = state.players.find((x) => x.name.toLowerCase() === String(n).toLowerCase() || x.id === n); return p ? p.id : n; };
  const myCh = () => state.me && state.me.cell && state.me.cell.ch;
  const sig = (s) => s.phase + ":" + s.qn + ":" + s.act + ":" + ((s.me && s.me.cell && s.me.cell.ch && s.me.cell.ch.id) || "") + ":" + ((s.me && s.me.palach) || "");
  const fail = (text) => { console.log("ОШИБКА ПУЛЬТА: " + text); c.ws.close(); process.exit(2); };
  let waitedOpen = false;
  if (cmd === "answer") {
    const x = String(rest[0] || "").trim().toUpperCase().replace("А", "A").replace("В", "B").replace("С", "C");
    const i = /^[ABCD]$/.test(x) ? "ABCD".indexOf(x) : /^[0-3]$/.test(x) ? Number(x) : -1;
    if (i < 0) fail("answer принимает A, B, C, D или 0–3");
    // кнопки ещё закрыты (3 с на чтение) — ждём их открытия по часам комнаты и отвечаем
    if ((state.phase === "read" || state.phase === "fread") && state.phaseEnd) { console.log(`Кнопки закрыты — жду открытия (~${Math.max(0, Math.round((state.phaseEnd - state.serverNow) / 1000))} игровых с), ответ уйдёт в момент открытия…`); await waitServer(state.phaseEnd + 50); await drain(); waitedOpen = true; }
    await act({ type: "answer", i });
    if (!rejected && state.me && state.me.answer === i) console.log(`Ответ ${L[i]} принят${waitedOpen ? " (отправлен в момент открытия кнопок)" : ""}.`);
  }
  if (cmd === "group") {
    if (!["hands", "eyes", "head"].includes(rest[0])) fail("group: hands | eyes | head");
    await act({ type: "group", group: rest[0] });
    if (!rejected) console.log(`Набор «${groupName(rest[0])}» выбран.`);
  }
  if (cmd === "bet") {
    const yn = String(rest[1] || "").toLowerCase();
    if (yn !== "y" && yn !== "n") fail("bet <имя> y|n — y = спасётся, n = сгорит");
    const pid = P(rest[0]);
    if (!state.players.some((p) => p.id === pid)) fail("нет такого игрока: " + rest[0]);
    await act({ type: "bet", prisoner: pid, escape: yn === "y" });
    if (!rejected && state.me && state.me.bets && state.me.bets[pid] === (yn === "y")) console.log(`Ставка на ${rest[0]} «${yn === "y" ? "спасётся" : "сгорит"}» принята.`);
  }
  if (cmd === "stake") {
    const n = Number(rest[0]);
    if (!Number.isInteger(n) || n < 0) fail("stake <целое число ≥ 0>");
    await act({ type: "stake", n });
    if (!rejected && state.me && state.me.stake === n) console.log(`Ставка ${n} принята.`);
    else if (state.phase !== "stake" && !rejected) console.log(`Ставка ${n} принята (все поставили — финал пошёл).`);
  }
  if (cmd === "react") {
    if (!REACTIONS.includes(rest[0])) fail("react — только " + REACTIONS.join(" "));
    await act({ type: "react", emoji: rest[0] });
    if (!rejected) console.log(`Реакция ${rest[0]} отправлена.`);
  }
  if (cmd === "cell") {
    const ch = myCh();
    if (!ch) console.log("Сейчас нет твоего испытания.");
    else {
      let ans;
      if (rest[0] === "auto") {
        if (!AUTO[ch.type]) { LANG = state.settings.lang; console.log(`cell auto не умеет ${ch.type} — реши сам: ${chInfo(ch, (id) => id)[2]}`); process.exit(1); }
        ans = { v: AUTO[ch.type](ch.view) };
      } else {
        try { ans = JSON.parse(rest.join(" ")); } catch { ans = { v: isNaN(Number(rest[0])) ? rest[0] : Number(rest[0]) }; }
      }
      // быстрее minMs сервер не примет: ждём по часам комнаты (при speed < 1 игровое время идёт медленнее)
      await waitServer(ch.at + (ch.minMs || 0) + 80);
      const before = state.me.cell.done;
      await act({ type: "cell", cid: ch.id, ans }, true);
      const c2 = state.me && state.me.cell;
      if (c2) console.log(c2.escaped ? "ВЕРНО — ты вырвался!" : c2.done > before ? "ВЕРНО." : c2.lockUntil > state.serverNow ? "МИМО — решётка." : "");
    }
  }
  if (cmd === "wait") {
    // сначала — всё, что уже пришло: иначе устаревший снимок «меняется» на текущий и wait возвращается без события
    await drain();
    // уже нужно действовать — не ждём ни секунды
    if (!needAction(state, await serverTime())) {
      const start = sig(state);
      const until = Date.now() + 1000 * Number(rest[0] || 90);
      while (Date.now() < until && sig(state) === start && !needAction(state, state.serverNow)) {
        const m = await c.next(until - Date.now());
        if (m && m.type === "state") state = m.state;
      }
    }
  }
  console.log(describe(state, me));
  c.ws.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
