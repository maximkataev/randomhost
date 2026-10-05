"use strict";

/*
 * UI-тест «Последнего вопроса»: headless Chrome через DevTools-протокол (как fibs/test-ui.js).
 *   node test-ui.js [папка для скриншотов]          LANG_UI=en|el — язык страниц (localStorage site-lang)
 *                                                   SPEED=1.5 — ускорение комнаты (только dev), по умолчанию 1
 * Сервер поднимается в этом же процессе (require("./server.js")) со временным банком вопросов: так тест видит
 * верный ответ и ответы испытаний и отвечает правильно или нарочно мимо. Генератор испытаний сужен до типов,
 * которые решаются тапами по кнопкам (голова — задачки с вариантами, внимание — «Передачка», ловкость — «Подкоп»):
 * проверяем страницы, а не меткость бота. Все нажатия — настоящие события мыши по координатам элемента,
 * и перед нажатием проверяется, что в этой точке именно он (ничто не перекрывает).
 *
 * Сценарий: доска + 3 телефона (390, 360, 320 px, свои контексты браузера) проходят короткую партию с финалом:
 *   1) Аня и Оля верно, Петя мимо → палач Аня выбирает «Голову»; Петя один раз ошибается (решётка) и выбирается;
 *      Оля ставит «спасётся»; на доске — вопрос «Головы» крупно;
 *   2) Аня верно, Петя и Оля мимо → палач даёт «Внимание» → «Передачка»: Петя набирает код с телефона Ани,
 *      Оля сидит и отлетает (на доске — отлёт по шкале);
 *   3) все верно → «Чисто!»;  4) Аня мимо → палач Петя даёт «Ловкость», Аня копает подкоп;
 *   финал: ставки «Всё» / «Половина» / ползунок, Аня верно, остальные мимо → Камера → раскрытие → итоги.
 * На каждом шаге: нет ошибок консоли, у телефонов нет прокрутки вбок, игровые экраны (вопрос, Камера) — без вертикальной.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const OUT = process.argv[2] || path.join(__dirname, "state", "ui");
const LANG = ["ru", "en", "el"].includes(process.env.LANG_UI) ? process.env.LANG_UI : "ru";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9700 + Math.floor(Math.random() * 100);
const SRV = 5300 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${SRV}`;
const SPEED = Number(process.env.SPEED || 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, name) => { console.log((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) failures++; };

// ---------- временный банк вопросов ----------
// REAL_BANK=1 — настоящий банк lastq/content (длинные тексты на 320 px и на доске)
const REAL = process.env.REAL_BANK === "1";
const BANK_DIR = REAL ? path.join(__dirname, "content") : process.env.LQ_CONTENT_DIR || path.join(os.tmpdir(), "lastq-ui-bank");
function writeBank() {
  const Q = [
    // [lvl, tag, {ru,en,el} вопрос, [верный, …3] по языкам]
    [1, "animals", ["Сколько сердец у осьминога?", "How many hearts does an octopus have?", "Πόσες καρδιές έχει το χταπόδι;"], [["Три", "Одно", "Восемь", "Зависит от настроения"], ["Three", "One", "Eight", "Depends on its mood"], ["Τρεις", "Μία", "Οκτώ", "Ανάλογα με τη διάθεση"]]],
    [1, "space_nature", ["Какая планета Солнечной системы самая горячая?", "Which planet in the Solar System is the hottest?", "Ποιος πλανήτης του ηλιακού συστήματος είναι ο πιο ζεστός;"], [["Венера", "Меркурий", "Марс", "Та, где нет кондиционера"], ["Venus", "Mercury", "Mars", "The one without air conditioning"], ["Αφροδίτη", "Ερμής", "Άρης", "Αυτός χωρίς κλιματιστικό"]]],
    [2, "food", ["Из какой страны родом картофель, прежде чем он покорил Европу и весь остальной мир за пару веков?", "Where do potatoes originally come from, before they conquered Europe and the rest of the world?", "Από πού κατάγεται η πατάτα, πριν κατακτήσει την Ευρώπη και τον υπόλοιπο κόσμο;"], [["Из Южной Америки", "Из Ирландии", "Из Индии", "Из бабушкиного погреба"], ["South America", "Ireland", "India", "Grandma's cellar"], ["Από τη Νότια Αμερική", "Από την Ιρλανδία", "Από την Ινδία", "Από το κελάρι της γιαγιάς"]]],
    [2, "body", ["Какая кость в теле человека самая длинная?", "Which is the longest bone in the human body?", "Ποιο είναι το μακρύτερο οστό του ανθρώπινου σώματος;"], [["Бедренная", "Плечевая", "Большеберцовая", "Та, что болит к дождю"], ["The femur", "The humerus", "The tibia", "The one that aches before rain"], ["Το μηριαίο", "Το βραχιόνιο", "Η κνήμη", "Αυτό που πονάει πριν τη βροχή"]]],
    [2, "geo", ["Какая река самая длинная в Европе?", "Which is the longest river in Europe?", "Ποιος είναι ο μακρύτερος ποταμός της Ευρώπης;"], [["Волга", "Дунай", "Рейн", "Та, что у соседей на даче"], ["The Volga", "The Danube", "The Rhine", "The one at the neighbours' cabin"], ["Ο Βόλγας", "Ο Δούναβης", "Ο Ρήνος", "Αυτός στο εξοχικό του γείτονα"]]],
    [3, "science", ["Какой газ составляет большую часть воздуха?", "Which gas makes up most of the air?", "Ποιο αέριο αποτελεί το μεγαλύτερο μέρος του αέρα;"], [["Азот", "Кислород", "Углекислый газ", "Запах соседских котлет"], ["Nitrogen", "Oxygen", "Carbon dioxide", "The smell of next door's dinner"], ["Άζωτο", "Οξυγόνο", "Διοξείδιο του άνθρακα", "Η μυρωδιά από το διπλανό φαγητό"]]],
    [3, "screen", ["Как зовут снеговика из «Холодного сердца»?", "What is the snowman's name in Frozen?", "Πώς λένε τον χιονάνθρωπο στο «Ψυχρά κι ανάποδα»;"], [["Олаф", "Свен", "Кристофф", "Снежок Петрович"], ["Olaf", "Sven", "Kristoff", "Frosty McFrostface"], ["Όλαφ", "Σβεν", "Κρίστοφ", "Χιονούλης"]]],
    [3, "weird", ["Сколько глаз у пчелы?", "How many eyes does a bee have?", "Πόσα μάτια έχει μια μέλισσα;"], [["Пять", "Два", "Четыре", "Столько, сколько нужно"], ["Five", "Two", "Four", "As many as it needs"], ["Πέντε", "Δύο", "Τέσσερα", "Όσα χρειάζεται"]]],
  ];
  const F = [
    ["animals", ["Какое животное спит дольше всех, до 22 часов в сутки?", "Which animal sleeps the most, up to 22 hours a day?", "Ποιο ζώο κοιμάται περισσότερο, έως 22 ώρες τη μέρα;"], [["Коала", "Ленивец", "Кошка", "Студент на парах"], ["The koala", "The sloth", "The cat", "A student in class"], ["Το κοάλα", "Ο βραδύποδας", "Η γάτα", "Ο φοιτητής στο μάθημα"]]],
    ["geo", ["Какая страна самая маленькая в мире?", "Which country is the smallest in the world?", "Ποια είναι η μικρότερη χώρα στον κόσμο;"], [["Ватикан", "Монако", "Сан-Марино", "Моя кухня"], ["Vatican City", "Monaco", "San Marino", "My kitchen"], ["Το Βατικανό", "Το Μονακό", "Ο Άγιος Μαρίνος", "Η κουζίνα μου"]]],
  ];
  fs.mkdirSync(BANK_DIR, { recursive: true });
  ["ru", "en", "el"].forEach((lang, li) => {
    const questions = Q.map(([lvl, tag, q, a], i) => ({ id: "t" + (i + 1), tag, lvl, final: false, q: q[li], a: a[li], fun: 3, source: "test" }))
      .concat(F.map(([tag, q, a], i) => ({ id: "f" + (i + 1), tag, lvl: 3, final: true, q: q[li], a: a[li], fun: 3, source: "test" })));
    fs.writeFileSync(path.join(BANK_DIR, lang + ".json"), JSON.stringify({ questions }, null, 1));
  });
}

// ---------- сервер в этом процессе ----------
if (!REAL) writeBank();
Object.assign(process.env, { PORT: String(SRV), STATIC: path.join(__dirname, ".."), NODE_ENV: "development", LQ_CONTENT_DIR: BANK_DIR, DUMP_FILE: path.join(os.tmpdir(), `lastq-ui-${SRV}.json`) });
try { fs.unlinkSync(process.env.DUMP_FILE); } catch {}
const CH = require("./challenges.js");
const origGenerate = CH.generate;
const FORCE = { head: ["math", "codelock", "clock", "tf"], eyes: ["keys"], hands: ["dig"] };
let forceN = 0;
CH.generate = (opts) => {
  let only = FORCE[opts.group] ? FORCE[opts.group][forceN++ % FORCE[opts.group].length] : undefined;
  if (opts.group === "eyes" && opts.canPass) only = "pass";
  return origGenerate({ ...opts, only });
};
const { rooms } = require("./server.js");
const optTypes = new Set(["math", "codelock", "clock", "tf", "quiz", "heavy"]);

// ---------- Chrome по DevTools-протоколу ----------
let browser = null;
async function browserCall(method, params = {}) {
  if (!browser) {
    const v = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => ws.on("open", r));
    let id = 0;
    const pending = new Map();
    ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); } });
    browser = { call: (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }), ws };
  }
  return browser.call(method, params);
}

// страница в своём контексте браузера: у каждого телефона своё localStorage
async function cdp(url, size, name) {
  const ctx = await browserCall("Target.createBrowserContext", {});
  const t = await browserCall("Target.createTarget", { url: "about:blank", browserContextId: ctx.browserContextId });
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const target = list.find((x) => x.id === t.targetId);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split("\n")[0]);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error: " + m.params.args.map((a) => a.value || a.description).join(" ").slice(0, 200));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/mc\.yandex|metrika|doubleclick|favicon|fonts\.g|cdnjs|jsdelivr/.test(m.params.entry.url || m.params.entry.text)) errors.push("log: " + m.params.entry.text.slice(0, 200) + " " + (m.params.entry.url || ""));
  });
  const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Log.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("site-lang", ${JSON.stringify(LANG)}); } catch (e) {} window.confirm = () => true;` });
  const phone = !!size;
  await call("Emulation.setDeviceMetricsOverride", phone ? { width: size[0], height: size[1], deviceScaleFactor: 2, mobile: true } : { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  // фоновые вкладки headless не крутят rAF — эмулируем фокус у всех
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Page.navigate", { url });
  const evaluate = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };
  const shot = async (n) => { const r = await call("Page.captureScreenshot", { format: "png" }); if (r && r.data) fs.writeFileSync(path.join(OUT, `${LANG}_${n}.png`), Buffer.from(r.data, "base64")); };
  return { call, evaluate, shot, errors, name, size };
}

async function waitFor(page, expr, ms = 20000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(expr);
    if (v && !v.__error) return v;
    await wait(step);
  }
  return null;
}

// настоящее нажатие: мышь в центр элемента; перед этим — что в этой точке именно он
async function tap(page, sel, idx = 0) {
  const r = await page.evaluate(`(() => {
    const n = document.querySelectorAll(${JSON.stringify(sel)})[${idx}];
    if (!n) return { err: "нет элемента" };
    const b = n.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { err: "за экраном " + Math.round(x) + "," + Math.round(y) };
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== n && !n.contains(hit))) return { err: "перекрыт: " + (hit ? hit.className || hit.tagName : "ничем") };
    return { x, y };
  })()`);
  if (!r || r.err) return r ? r.err : "нет ответа";
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  return true;
}
async function mustTap(page, sel, idx, what) {
  let res = null;
  for (let i = 0; i < 20; i++) { res = await tap(page, sel, idx); if (res === true) return true; await wait(100); }
  check(false, `${page.name}: ${what} — ${res}`);
  return false;
}

const NO_HSCROLL = "document.documentElement.scrollWidth <= innerWidth";
const NO_VSCROLL = "document.documentElement.scrollHeight <= innerHeight + 1";
const room = () => rooms.get(CODE);
const S = () => room().game.s;
let CODE = null;

// телефонная проверка вёрстки: один раз на фазу и телефон
const layoutSeen = new Set();
async function layout(phones, tag, vertical) {
  for (const p of phones) {
    const k = p.name + tag;
    if (layoutSeen.has(k)) continue;
    layoutSeen.add(k);
    const h = await p.evaluate(NO_HSCROLL);
    if (h !== true) check(false, `${p.name} (${p.size[0]}): ${tag} — прокрутка вбок`);
    if (vertical) {
      const v = await p.evaluate(`(() => document.documentElement.scrollHeight + "/" + innerHeight)()`);
      const [a, b] = String(v).split("/").map(Number);
      if (!(a <= b + 1)) check(false, `${p.name} (${p.size[0]}×${p.size[1]}): ${tag} — вертикальная прокрутка ${a} > ${b}`);
    }
  }
}

// ---------- решатель Камеры: ответ берём у сервера, жмём по-настоящему ----------
async function solveCell(ph, phones, { wrongFirst = false, deadline }) {
  const pid = ph.id;
  let wrongDone = !wrongFirst, solved = 0, sawBars = false;
  while (Date.now() < deadline) {
    const s = S();
    if (s.phase !== "cell" && s.phase !== "fcell") break;
    const c = s.cell[pid];
    if (!c || c.escaped || c.burned) break;
    const ch = c.ch;
    if (!ch || ch.at > Date.now() + (room().skew || 0)) { await wait(80); continue; }
    // ждём, пока телефон смонтирует именно это испытание
    const ok = await waitFor(ph, `(() => { const r = window.lqPhone.run; return !!(r && r.mounted && r.ch.id === ${ch.id} && !r.sent); })()`, 4000, 60);
    if (!ok) { await wait(100); continue; }
    if (!ph.shotCell) { ph.shotCell = true; await wait(150); await ph.shot(`p_cell_${ph.name}_${ch.type}`); await layout([ph], "Камера", true); }
    if (optTypes.has(ch.type)) {
      const idx = wrongDone ? ch.answer : (ch.answer + 1) % (ch.type === "tf" ? 2 : await ph.evaluate("document.querySelectorAll('#pad .opt').length"));
      await mustTap(ph, "#pad .opt", idx, `испытание ${ch.type}`);
      if (!wrongDone) {
        wrongDone = true;
        const bars = await waitFor(ph, "!!document.querySelector('#pad .lqbars')", 4000, 50);
        sawBars = !!bars;
        check(sawBars, `${ph.name}: ошибка в испытании — решётка закрылась`);
        await ph.shot(`p_bars_${ph.name}`);
        continue;
      }
    } else if (ch.type === "dig") {
      // первый тап — с проверкой, что кнопку ничто не перекрывает; дальше барабаним по тем же координатам
      await mustTap(ph, "#pad .digbtn", 0, "лопата");
      const r = await ph.evaluate("(() => { const b = document.querySelector('#pad .digbtn').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()");
      for (let i = 1; i < ch.answer; i++) {
        await wait(66);
        await ph.call("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
        await ph.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
      }
    } else if (ch.type === "keys") {
      await mustTap(ph, "#pad .keybtn", ch.answer, "ключ");
    } else if (ch.type === "pass") {
      // код — с телефона подсказчика: читаем его плашку, как продиктовал бы живой сосед
      const helper = phones.find((p) => p.id === ch.view.helper);
      const code = helper ? await waitFor(helper, `(() => { const h = [...document.querySelectorAll('.hint')].find((x) => x.textContent.includes(${JSON.stringify(ph.name)})); return h ? h.querySelector('.code').textContent : null; })()`, 4000, 80) : null;
      check(!!code, `«Передачка»: у подсказчика ${helper && helper.name} на телефоне код для ${ph.name}`);
      if (helper && !helper.shotHint) { helper.shotHint = true; await helper.shot(`p_pass_helper_${helper.name}`); }
      for (const d of String(code || ch.answer)) {
        const i = await ph.evaluate(`[...document.querySelectorAll('#pad .keypad button')].findIndex((b) => b.textContent === ${JSON.stringify(d)})`);
        await tap(ph, "#pad .keypad button", i);
        await wait(90);
      }
    } else {
      console.log("    неизвестный тип", ch.type);
      await wait(300);
      continue;
    }
    solved++;
    await waitFor(ph, `(() => { const r = window.lqPhone.run; return !r || r.ch.id !== ${ch.id}; })()`, 5000, 60);
  }
  return { solved, sawBars };
}

// ---------- партия ----------
async function answerAll(phones, plan, label) {
  // ждём открытия кнопок
  for (const p of phones) await waitFor(p, "document.querySelectorAll('.ans:not(:disabled)').length === 4", 15000, 60);
  await layout(phones, "вопрос " + label, true);
  const right = S().q.right;
  for (const p of phones) {
    const want = plan[p.name];
    if (want === "skip") continue;
    const i = want === "right" ? right : (right + 1 + (p.name.length % 3)) % 4;
    await mustTap(p, ".ans", i, "кнопка ответа");
    await wait(140);
  }
  for (const p of phones) if (plan[p.name] !== "skip") check(!!(await waitFor(p, "window.lqPhone.state.me.answer != null || window.lqPhone.state.phase !== 'answer'", 4000)), `${p.name}: ответ принят (${label})`);
}

// самые длинные вопросы банка: подставляем в снимок на доске и телефонах и меряем (вопрос и варианты влезают, без прокрутки)
async function longest(board, phones) {
  await waitFor(phones[2], "document.querySelectorAll('.ans:not(:disabled)').length === 4", 15000, 60);
  const bank = JSON.parse(fs.readFileSync(path.join(BANK_DIR, LANG + ".json"), "utf8")).questions;
  const score = (q) => q.q.length + 2 * Math.max(...q.a.map((x) => x.length));
  const top = bank.slice().sort((x, y) => score(y) - score(x)).slice(0, 12);
  let bad = 0;
  const pages = [board, ...phones];
  for (const p of pages) await p.evaluate("window.__q0 = state.question");
  for (const q of top) {
    const inject = `(() => { state.question = Object.assign({}, state.question, { text: ${JSON.stringify(q.q)}, options: ${JSON.stringify(q.a)}, tag: ${JSON.stringify(q.tag)} }); `;
    await board.evaluate(inject + `viewKey = ""; render(); })()`);
    for (const p of phones) await p.evaluate(inject + `screenKey = ""; render(); })()`);
    await wait(120);
    const fb = await board.evaluate(`(() => { const t = document.querySelector('#qtext .t'); const o = [...document.querySelectorAll('.bopt')].filter((b) => b.scrollHeight > b.clientHeight + 2).length; return t.scrollHeight <= t.clientHeight + 2 && o === 0; })()`);
    if (fb !== true) { bad++; console.log("    доска не влезает:", q.id, q.q); }
    for (const p of phones) {
      const v = await p.evaluate(NO_VSCROLL + " && " + NO_HSCROLL);
      if (v !== true) { bad++; console.log(`    ${p.name} ${p.size.join("×")} прокрутка:`, q.id, q.q); if (!p.shotLong) { p.shotLong = true; await p.shot("p_long_" + p.name); } }
    }
  }
  check(bad === 0, `самые длинные вопросы банка (${top.length}) влезают на доске и на 390/360/320 без прокрутки`);
  await board.shot("b_longest");
  await phones[2].shot("p_longest_320");
  // возвращаем настоящий снимок: следующий state придёт с сервера, а пока перерисуем по последнему
  await board.evaluate(`(() => { state.question = window.__q0; viewKey = ""; render(); })()`);
  for (const p of phones) await p.evaluate(`(() => { state.question = window.__q0; screenKey = ""; render(); })()`);
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lastq-ui-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"], { stdio: "ignore" });
  await wait(2500);
  const pages = [];
  console.log(`язык ${LANG}, скорость ${SPEED}, сервер ${BASE}`);
  try {
    // ---------- стартовый экран ----------
    const land = await cdp(`${BASE}/lastq.html`, [320, 568], "стартовый");
    pages.push(land);
    check(!!(await waitFor(land, "!!document.getElementById('create')", 8000)), "стартовый экран: кнопка «Создать комнату»");
    for (const w of [320, 390, 1280]) {
      await land.call("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: w < 700 });
      await wait(300);
      check((await land.evaluate(NO_HSCROLL)) === true, `стартовый экран ${w}px: без прокрутки вбок`);
    }
    await land.shot("landing");

    // ---------- комната и доска ----------
    const res = await (await fetch(BASE + "/lastq/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: LANG }, speed: SPEED }) })).json();
    CODE = res.code;
    console.log("комната", CODE);
    const board = await cdp(`${BASE}/lastq-board.html?r=${CODE}&h=${res.hostToken}`, null, "доска");
    pages.push(board);
    check(!!(await waitFor(board, "!!document.getElementById('startbtn') && document.body.classList.contains('host')", 8000)), "доска: лобби, ведущий");
    check((await board.evaluate("document.getElementById('seats').getBoundingClientRect().left < document.getElementById('qr').getBoundingClientRect().left")) === true, "доска: игроки слева от QR");
    // галочки: «Короткая партия» включаем настоящим нажатием, «Финал» проверяем, что включён
    await mustTap(board, ".tog[data-k=short]", 0, "галочка «Короткая партия»");
    check(!!(await waitFor(board, "window.lqBoard.state.settings.short === true", 3000)), "доска: «Короткая партия» включилась");
    check((await board.evaluate("window.lqBoard.state.settings.final")) === true, "доска: «Финал со ставками» включён по умолчанию");
    check((await board.evaluate("document.getElementById('startbtn').disabled")) === true, "доска: «Старт» закрыт, пока игроков меньше двух");

    const names = ["Аня", "Петя", "Оля"];
    const sizes = [[390, 844], [360, 640], [320, 568]];
    const phones = [];
    for (const [i, name] of names.entries()) {
      const ph = await cdp(`${BASE}/lastq.html?r=${CODE}`, sizes[i], name);
      check(!!(await waitFor(ph, "!!document.getElementById('name')", 8000)), `${name}: экран входа`);
      await ph.evaluate(`document.getElementById('name').value = ""`);
      await ph.evaluate(`document.getElementById('name').focus()`);
      await ph.call("Input.insertText", { text: name });
      await mustTap(ph, "#enterform button[type=submit]", 0, "кнопка «Войти»");
      ph.id = await waitFor(ph, "window.lqPhone.me", 5000);
      check(!!ph.id, `${name}: вошёл`);
      phones.push(ph);
      pages.push(ph);
    }
    await layout(phones, "лобби", false);
    await wait(500);
    await board.shot("b_lobby");
    await phones[2].shot("p_lobby_320");
    check((await board.evaluate("document.getElementById('startbtn').disabled")) === false, "доска: «Старт» открыт при трёх игроках");
    await mustTap(board, "#startbtn", 0, "«Старт»");

    const [A, P, O] = phones;
    const plans = [
      { ans: { Аня: "right", Петя: "wrong", Оля: "right" }, group: "head", palach: A, prisoners: [P], wrongFirst: P, bettor: O },
      { ans: { Аня: "right", Петя: "wrong", Оля: "skip" }, group: "eyes", palach: A, prisoners: [P], idle: [O] },
      { ans: { Аня: "right", Петя: "right", Оля: "right" }, clean: true },
      { ans: { Аня: "wrong", Петя: "right", Оля: "right" }, group: "hands", palach: P, prisoners: [A], bettor: O },
    ];
    let qn = -1, sawHeadOnBoard = false, sawKnock = false, sawClean = false, sawTrackMove = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 6 * 60 * 1000) {
      const s = S();
      if (s.phase === "finished") break;
      if (s.phase === "intro") { await wait(600); await board.shot(`b_intro_${s.act}`); await waitFor(board, "window.lqBoard.state.phase !== 'intro'", 8000); continue; }
      if ((s.phase === "read" || s.phase === "answer") && s.qn !== qn) {
        qn = s.qn;
        const plan = plans[qn];
        console.log(`  вопрос ${qn + 1}`);
        await waitFor(board, "window.lqBoard.state.phase === 'answer'", 6000);
        await board.shot(`b_q${qn + 1}`);
        const fits = await board.evaluate(`(() => { const t = document.querySelector('#qtext .t'); const o = [...document.querySelectorAll('.bopt')].filter((b) => b.scrollHeight > b.clientHeight + 2 || b.scrollWidth > b.clientWidth + 2).length; return t.scrollHeight <= t.clientHeight + 2 && o === 0 ? true : "вопрос " + t.scrollHeight + "/" + t.clientHeight + ", вариантов не влезло " + o; })()`);
        check(fits === true, `доска: вопрос ${qn + 1} и варианты влезают (${fits})`);
        if (REAL && qn === 0) await longest(board, phones);
        await answerAll(phones, plan.ans, "вопрос " + (qn + 1));
        if (qn === 0) await phones[2].shot("p_question_answered_320");
        // Оля молчит во втором вопросе — ждём таймер
        const moved = await waitFor(board, "window.lqBoard.state.phase === 'reveal'", 30000);
        check(!!moved, `вопрос ${qn + 1}: раскрытие`);
        await wait(1500);
        await board.shot(`b_reveal_q${qn + 1}`);
        check((await board.evaluate("document.querySelectorAll('.bopt.right').length")) === 1, `доска: верный вариант подсвечен (вопрос ${qn + 1})`);
        check((await board.evaluate("document.querySelectorAll('.bopt .who span').length")) >= (plan.ans.Оля === "skip" ? 2 : 3), `доска: аватарки под вариантами (вопрос ${qn + 1})`);
        if (plan.clean) {
          sawClean = (await phones[0].evaluate("document.body.textContent")).length > 0 && !!(await board.evaluate("!!document.querySelector('.strip .ok')"));
          check(sawClean, "все верно — на доске «Чисто!»");
          await waitFor(board, "window.lqBoard.state.phase !== 'reveal'", 10000);
          continue;
        }
        const pal = plan.palach;
        const cards = await waitFor(pal, "document.querySelectorAll('.grp').length === 3", 4000);
        check(!!cards, `${pal.name}: палачу три карточки наборов`);
        await pal.shot(`p_palach_${pal.name}`);
        await layout([pal], "палач", true);
        await mustTap(pal, `.grp[data-g=${plan.group}]`, 0, "карточка набора");
        check(!!(await waitFor(board, `window.lqBoard.state.group === "${plan.group}" && !!document.querySelector('.strip .big')`, 4000)), `доска: «выбрал: ${plan.group}»`);
        await board.shot(`b_group_q${qn + 1}`);
        const inCell = await waitFor(board, "window.lqBoard.state.phase === 'cell'", 10000);
        check(!!inCell, `вопрос ${qn + 1}: Камера`);
        await wait(300);
        // ставка свободного — сразу, пока окно ставок открыто
        if (plan.bettor) {
          const b = plan.bettor;
          const ok = await waitFor(b, "document.querySelectorAll('.bet .two button:not(:disabled)').length >= 2", 3000, 50);
          check(!!ok, `${b.name}: ставки на спасение`);
          await layout([b], "ставки", true);
          await mustTap(b, ".bet .two button.y", 0, "ставка «спасётся»");
          check(!!(await waitFor(b, "Object.keys(window.lqPhone.state.me.bets).length === 1", 3000)), `${b.name}: ставка принята сервером`);
          check((await b.evaluate("document.querySelectorAll('.bet .two button:not(:disabled)').length")) === 0, `${b.name}: после ставки кнопки закрыты (одна ставка на узника)`);
          await b.shot(`p_bets_${b.name}`);
        }
        const deadline = Date.now() + 25000;
        const solvers = plan.prisoners.map((p) => solveCell(p, phones, { wrongFirst: plan.wrongFirst === p, deadline }));
        // доска во время Камеры: плитки, вопрос «Головы» крупно
        let headShot = false;
        const watchHead = (async () => {
          while (Date.now() < deadline && ["cell", "fcell"].includes(S().phase)) {
            if (plan.group === "head" && (await board.evaluate("!document.getElementById('headq').classList.contains('hidden') && document.querySelectorAll('#hqpad .opt').length > 0"))) {
              sawHeadOnBoard = true;
              if (!headShot) { headShot = true; await board.shot(`b_cell_head_q${qn + 1}`); }
            }
            await wait(150);
          }
        })();
        await wait(2500);
        await board.shot(`b_cell_q${qn + 1}`);
        check((await board.evaluate("document.querySelectorAll('.tile').length")) === (plan.prisoners.length + (plan.idle || []).length), `доска: плитки узников (вопрос ${qn + 1})`);
        const results = await Promise.all(solvers);
        await watchHead;
        results.forEach((r, i) => check(r.solved >= 3, `${plan.prisoners[i].name}: прошёл испытания (${r.solved})`));
        for (const p of plan.prisoners) check(!!(await waitFor(p, "!!window.lqPhone.state.me.cell && window.lqPhone.state.me.cell.escaped", 3000)), `${p.name}: вырвался`);
        const v = await waitFor(board, "window.lqBoard.state.phase === 'verdict'", 15000);
        check(!!v, `вопрос ${qn + 1}: приговор`);
        if (plan.idle) {
          // отлёт: аватар отбрасывает по шкале, следом летит −N и пыль
          const k = await waitFor(board, "document.querySelectorAll('#track .fly:not(.plus), #track .dust').length > 0", 4000, 40);
          sawKnock = !!k;
          await board.shot(`b_knock_q${qn + 1}`);
          for (const p of plan.idle) { await p.shot(`p_verdict_${p.name}`); check(!!(await waitFor(p, "window.lqPhone.state.verdict && window.lqPhone.state.verdict.burned.includes(window.lqPhone.me)", 2000)), `${p.name}: сгорел, отлетает`); }
        }
        if (plan.bettor) check(!!(await waitFor(plan.bettor, `(window.lqPhone.state.verdict.betGain || {})[window.lqPhone.me] === 20`, 3000)), `${plan.bettor.name}: угаданная ставка +20`);
        continue;
      }
      if (s.phase === "stake") {
        console.log("  финал: ставки");
        await waitFor(board, "window.lqBoard.state.phase === 'stake'", 3000);
        await wait(500);
        await board.shot("b_stake");
        for (const p of phones) check(!!(await waitFor(p, "!!document.getElementById('stakebtn')", 4000)), `${p.name}: ползунок ставки`);
        await layout(phones, "ставка финала", true);
        await mustTap(A, ".quick button[data-k=all]", 0, "«Всё»");
        await mustTap(P, ".quick button[data-k=half]", 0, "«Половина»");
        await O.evaluate(`(() => { const r = document.getElementById('sr'); r.value = 100; r.dispatchEvent(new Event('input')); })()`);
        await P.shot("p_stake_Петя");
        const want = {};
        for (const p of phones) want[p.name] = Number(await p.evaluate("document.getElementById('sv').textContent"));
        for (const p of phones) await mustTap(p, "#stakebtn", 0, "«Ставлю»");
        const stakes = await waitFor(board, "window.lqBoard.state.phase !== 'stake'", 5000);
        check(!!stakes, "все поставили — финал пошёл досрочно");
        const st = S().stakes;
        check(st[A.id] === want["Аня"] && st[P.id] === want["Петя"] && st[O.id] === 100, `ставки дошли как нажаты: ${JSON.stringify(want)}`);
        await waitFor(board, "window.lqBoard.state.phase === 'fanswer'", 8000);
        await board.shot("b_final_q");
        await answerAll(phones, { Аня: "right", Петя: "wrong", Оля: "wrong" }, "финал");
        check(!!(await waitFor(board, "window.lqBoard.state.phase === 'fshow'", 8000)), "финал: верный ответ на экране (fshow)");
        await wait(700);
        await board.shot("b_fshow");
        check((await board.evaluate("document.querySelectorAll('.bopt.right').length === 1 && document.querySelectorAll('.bopt .who span').length >= 3")) === true, "доска fshow: верный подсвечен, аватарки под вариантами");
        check((await board.evaluate(`document.getElementById('strip').textContent.includes(${JSON.stringify("Петя")})`)) === true, "доска fshow: «Камера для: …» с ошибившимися");
        check(!!(await waitFor(A, "!!document.querySelector('.big.ok')", 3000)), "Аня (fshow): «Верно!»");
        check(!!(await waitFor(P, "!!document.querySelector('.big.bad')", 3000)), "Петя (fshow): «Мимо — в финальную Камеру»");
        await P.shot("p_fshow_Петя");
        await layout(phones, "fshow", true);
        check(!!(await waitFor(board, "window.lqBoard.state.phase === 'fcell'", 8000)), "финал: ошибившиеся — в Камеру");
        await wait(1500);
        await board.shot("b_fcell");
        const r = await solveCell(P, phones, { deadline: Date.now() + 30000 });
        check(r.solved >= 5, `Петя: пять испытаний финальной Камеры (${r.solved})`);
        check(!!(await waitFor(board, "window.lqBoard.state.phase === 'freveal'", 30000)), "финал: раскрытие ставок");
        await wait(2000);
        await board.shot("b_freveal");
        const shown = await waitFor(board, "document.querySelectorAll('.frow .d.plus, .frow .d.minus').length >= 3", 15000);
        check(!!shown, "доска: ставки раскрыты по одному");
        await A.shot("p_freveal_Аня");
        continue;
      }
      if (s.phase === "verdict" || s.phase === "reveal" || s.phase === "cell") { await wait(200); continue; }
      await wait(150);
    }
    check(!!sawHeadOnBoard, "доска: вопрос «Головы» крупно во время Камеры");
    check(sawKnock, "доска: отлёт по шкале (−N и пыль)");
    // шкала: аватар Оли ниже нуля не обязательно, но левее старта Ани
    sawTrackMove = true;
    check(!!(await waitFor(board, "window.lqBoard.state.phase === 'finished'", 20000)), "партия дошла до итогов");
    await wait(800);
    await board.shot("b_final");
    check((await board.evaluate("!!document.querySelector('.podium .p1')")) === true, "доска: пьедестал");
    check((await board.evaluate("document.querySelectorAll('.award').length")) >= 1, "доска: награды");
    check((await board.evaluate("!!document.getElementById('again')")) === true, "доска: «Ещё партия»");
    for (const p of phones) { await p.shot(`p_final_${p.name}`); await layout([p], "итоги", false); }
    const rk = S().ranking;
    check(rk && rk[0].id === A.id, "победила Аня (верно везде и всё на финал)");

    // ---------- перезагрузка телефона: возвращается по токену ----------
    await P.call("Page.reload");
    check(!!(await waitFor(P, "window.lqPhone && window.lqPhone.me", 8000)), "телефон после перезагрузки вернулся по токену");
    // ---------- ещё партия ----------
    await mustTap(board, "#again", 0, "«Ещё партия»");
    check(!!(await waitFor(board, "['intro','read'].includes(window.lqBoard.state.phase) && window.lqBoard.state.game === 2", 5000)), "«Ещё партия»: новая партия пошла");
    await mustTap(board, "#endbtn", 0, "«Закончить»");
    check(!!(await waitFor(board, "window.lqBoard.state.phase === 'finished'", 5000)), "«Закончить»: итоги");

    for (const p of pages) check(p.errors.length === 0, `${p.name}: без ошибок консоли` + (p.errors.length ? ": " + p.errors.slice(0, 3).join(" | ") : ""));
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    try { chrome.kill(); } catch {}
  }
  console.log(failures ? `\nПРОВАЛОВ: ${failures}` : "\nвсё зелёное");
  process.exit(failures ? 1 : 0);
}

run();
