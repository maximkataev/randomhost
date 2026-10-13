"use strict";

/*
 * UI-тест «Не верю!»: headless Chrome через DevTools-протокол (как quip/test-ui.js).
 *   node test-ui.js [папка для скриншотов]
 * Сам поднимает dev-сервер со статикой сайта. Что проверяет:
 *   1. стартовый экран на ширинах 320–1280: без прокрутки вбок, звук и языки не наезжают;
 *   2. живая партия: доска + 5 телефонов (у каждого свой контекст браузера — свои токены),
 *      тема выбирается тапом, ложь печатается НАСТОЯЩИМ вводом; вписанная правда отклоняется («Это правда!»),
 *      «Соври за меня» — двойным тапом, один молчит — 🐌, один выбирает с подстраховкой, лайк чужой лжи;
 *      на доске раскрытие штемпелями, правда вписывается в заголовок; доходим до итогов;
 *   3. короткая партия втроём (ловушки игры добивают варианты до шести);
 *   4. на каждом шаге: нет JS-ошибок, телефоны не прокручиваются вбок, вырезки на доске влезают.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { T: { lie: T_LIE } } = require("./game");

const OUT = process.argv[2] || path.join(__dirname, "state", "ui");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9600 + Math.floor(Math.random() * 100);
const SRV = 5100 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${SRV}`;
const SPEED = 2;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, name) => { console.log((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) failures++; };

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
async function cdp(url, phone) {
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
  });
  const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await call("Runtime.enable");
  await call("Page.enable");
  if (phone) await call("Emulation.setDeviceMetricsOverride", { width: phone[0], height: phone[1], deviceScaleFactor: 2, mobile: true });
  else await call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  // фоновые вкладки headless не крутят rAF — эмулируем фокус у всех
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Page.navigate", { url });
  const evaluate = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };
  const shot = async (name) => { const r = await call("Page.captureScreenshot", { format: "png" }); if (r && r.data) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64")); };
  return { call, evaluate, shot, errors, name: "", targetId: t.targetId };
}

async function type(page, selector, text) {
  await page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.focus(); n.value = ""; })()`);
  await page.call("Input.insertText", { text });
}
const click = (page, selector) => page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);

const NO_HSCROLL = "document.documentElement.scrollWidth <= innerWidth";
const OVERLAP = `(() => { const a = document.querySelector(".sound-toggle-btn").getBoundingClientRect(), b = document.querySelector(".lang-switch").getBoundingClientRect();
  return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom; })()`;
// вырезки на доске влезают: текст не обрезан, карточки не за экраном
// ярлычок «ЛОЖЬ/ПРАВДА» не закрывает текст вырезки (T-W3-15, fibs-005); подписи раскрытия ≥ 24 px от ширины 1600
const STAMPS_OK = `(() => { const cards = [...document.querySelectorAll(".clip.shown")]; if (!cards.length) return "no shown";
  const bad = cards.filter((c) => { const st = c.querySelector(".stamp").getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(c.querySelector(".t")); const t = r.getBoundingClientRect();
    return !(st.bottom <= t.top + 1 || st.top >= t.bottom || st.right <= t.left || st.left >= t.right); }).length;
  const fs = (s) => { const e = document.querySelector(s); return e ? parseFloat(getComputedStyle(e).fontSize) : 99; };
  const small = innerWidth >= 1600 ? [".clip .who", ".clip .pts", ".headline .kicker", ".votebar"].filter((s) => fs(s) < 23.9) : [];
  return bad === 0 && !small.length ? true : "штамп на тексте: " + bad + "; мелкие подписи: " + small.join(","); })()`;
const WALL_FITS = `(() => { const cards = [...document.querySelectorAll(".clip")]; if (!cards.length) return "no cards";
  const bad = cards.filter((c) => { const t = c.querySelector(".t"); return t.scrollHeight > t.clientHeight + 2; }).length;
  const out = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > innerHeight + 1 || r.right > innerWidth + 1; }).length;
  return bad === 0 && out === 0 ? true : "обрезано " + bad + ", за экраном " + out; })()`;

async function waitFor(page, expr, ms = 20000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(expr);
    if (v && !v.__error) return v;
    await wait(step);
  }
  return null;
}

async function joinPhones(code, names, sizes) {
  const phones = [];
  for (const [i, name] of names.entries()) {
    const ph = await cdp(`${BASE}/fibs.html?r=${code}`, sizes[i % sizes.length]);
    ph.name = name;
    await waitFor(ph, "!!document.getElementById('name')", 8000);
    await type(ph, "#name", name);
    await click(ph, "#enterform button[type=submit]");
    phones.push(ph);
  }
  for (const ph of phones) {
    check(!!(await waitFor(ph, "window.qpPhone.me", 5000)), `телефон ${ph.name}: вошёл`);
    // на ускорении сервер спешит — телефон считает шаги раскрытия в том же темпе (только для стенда)
    await ph.evaluate(`window.qpRevealSpeed = ${SPEED}`);
  }
  return phones;
}

const C = require("./content");
const truthOf = (text) => { for (const l of ["ru", "en", "el"]) { const f = C[l].find((x) => x.text === text); if (f) return f.answer; } return null; };

// все врут настоящим вводом. opts: silent — молчит; hint — «Соври за меня»; truthFirst — сначала вписывает правду
async function lieRound(phones, opts, label) {
  for (const ph of phones) {
    if (opts.silent && opts.silent.includes(ph.name)) continue;
    const st = await ph.evaluate("(() => { const s = window.qpPhone.state; return s && s.phase === 'lie' && s.me && s.me.inRound && !s.me.lie ? s.fact.text : null; })()");
    if (!st) continue;
    await waitFor(ph, "!!document.getElementById('sendbtn')", 4000);
    if (opts.hint && opts.hint.includes(ph.name) && !ph.hinted) {
      ph.hinted = true;
      await click(ph, "#hintbtn");
      await wait(150);
      check((await ph.evaluate("document.getElementById('hintbtn').classList.contains('sure')")) === true, `${ph.name}: «Соври за меня» просит подтверждения`);
      await click(ph, "#hintbtn");
      const got = await waitFor(ph, "(document.querySelector('.gotit')||{}).textContent", 3000);
      check(!!got, `${ph.name}: готовая ложь пришла: «${String(got || "").trim().slice(0, 30)}»`);
      await ph.shot(label + "_p_hint");
      continue;
    }
    if (opts.truthFirst && opts.truthFirst.includes(ph.name) && !ph.triedTruth) {
      ph.triedTruth = true;
      const ans = truthOf(st);
      await type(ph, "#lie", ans.toUpperCase());
      await click(ph, "#sendbtn");
      const msg = await waitFor(ph, "(document.getElementById('truthmsg')||{}).textContent", 3000);
      check(!!msg, `${ph.name}: вписанная правда отклонена: «${msg}»`);
      await ph.shot(label + "_p_truth_rejected");
    }
    await waitFor(ph, "!!document.getElementById('lie')", 3000);
    await type(ph, "#lie", `Враки ${ph.name.slice(0, 6)} ${Math.random().toString(36).slice(2, 5)}`);
    if (!ph.shotLie) { ph.shotLie = true; await ph.shot(label + "_p_lie_" + ph.name.slice(0, 4)); }
    await click(ph, "#sendbtn");
    await wait(200);
  }
}

async function chooseRound(phones, opts, label) {
  for (const ph of phones) {
    const can = await ph.evaluate("(() => { const s = window.qpPhone.state; return s && s.phase === 'choose' && s.me && !s.me.picks; })()");
    if (!can) continue;
    await waitFor(ph, "document.querySelectorAll('.opt:not(.own)').length > 1", 3000);
    if (opts.hedge && opts.hedge.includes(ph.name)) {
      await click(ph, "#hedge");
      await wait(150);
      await ph.evaluate("document.querySelectorAll('.opt:not(.own)')[0].click()");
      await wait(100);
      await ph.evaluate("document.querySelectorAll('.opt:not(.own)')[1].click()");
      await wait(100);
      await ph.shot(label + "_p_hedge");
      await click(ph, "#pickbtn");
      const ok = await waitFor(ph, "window.qpPhone.state.me.picks && window.qpPhone.state.me.picks.length === 2", 3000);
      check(!!ok, `${ph.name}: подстраховка — выбраны два варианта`);
    } else {
      await ph.evaluate("document.querySelectorAll('.opt:not(.own)')[0].click()");
    }
    await wait(150);
    if (opts.like && opts.like.includes(ph.name)) {
      await waitFor(ph, "document.querySelectorAll('.opt:not(:disabled)').length > 0", 3000);
      await ph.evaluate("(() => { const b = document.querySelector('.opt:not(:disabled)'); if (b) b.click(); })()");
      const liked = await waitFor(ph, "(window.qpPhone.state.me.likes || []).length > 0", 3000);
      check(!!liked, `${ph.name}: лайк чужой лжи засчитан`);
    }
  }
}

async function playGame(board, phones, label, plan) {
  let stampsChecked = false;
  let facts = 0, sawLate = false, sawHint = false, sawTrap = false, sawTruthInHeadline = false, sawStamp = false;
  const seenFacts = new Set();
  const shotOnce = new Set();
  const once = async (page, name) => { if (shotOnce.has(name)) return; shotOnce.add(name); await page.shot(name); };
  for (let step = 0; step < 600; step++) {
    const ph = await board.evaluate("state && state.phase + ':' + state.ri + ':' + state.fi");
    const [phase, ri, fi] = String(ph).split(":");
    const fk = ri + ":" + fi;
    if (phase === "finished") break;
    if (phase === "intro") { await once(board, `${label}_b_intro_${ri}`); await wait(300); continue; }
    if (phase === "topic") {
      await wait(300);
      await once(board, `${label}_b_topic`);
      for (const p of phones) {
        if (await p.evaluate("!!(window.qpPhone.state.me && window.qpPhone.state.me.chooser)")) {
          await waitFor(p, "document.querySelectorAll('.topics button').length > 0", 3000);
          await once(p, `${label}_p_topic`);
          await p.evaluate("document.querySelector('.topics button').click()");
        }
      }
      await waitFor(board, "state.phase !== 'topic'", 10000);
      continue;
    }
    if (phase === "lie") {
      if (seenFacts.has(fk)) { await wait(200); continue; }
      seenFacts.add(fk);
      facts++;
      await wait(400);
      await once(board, `${label}_b_lie_${ri}`);
      const key = plan[facts - 1] || {};
      await lieRound(phones, key, label);
      const moved = await waitFor(board, "state.phase !== 'lie'", key.silent ? T_LIE / SPEED + 5000 : 8000);
      check(!!moved, `${label}: факт ${facts} — ложь собрана`);
      continue;
    }
    if (phase === "choose") {
      await wait(500);
      const fits = await board.evaluate(WALL_FITS);
      check(fits === true, `${label}: доска, факт ${facts} — вырезки влезают (${fits})`);
      await once(board, `${label}_b_choose_${ri}`);
      await once(phones[0], `${label}_p_choose`);
      const secs = await phones[0].evaluate("(document.getElementById('tleft') || {}).textContent || ''");
      if (!/\d/.test(secs)) check(false, `${label}: в фазе выбора на телефоне нет секунд (${secs})`);
      for (const p of phones) { const h = await p.evaluate(NO_HSCROLL); if (h !== true) check(false, `${p.name}: выбор без прокрутки вбок`); }
      await chooseRound(phones, plan[facts - 1] || {}, label);
      await waitFor(board, "state.phase !== 'choose'", 15000 / SPEED + 3000);
      continue;
    }
    if (phase === "reveal") {
      const opts = JSON.parse((await board.evaluate("JSON.stringify(state.options)")) || "[]");
      if (opts.some((o) => o.kind === "lie" && o.late.some(Boolean))) sawLate = true;
      if (opts.some((o) => o.kind === "lie" && o.hint.some((h, k) => h && !o.late[k]))) sawHint = true;
      if (opts.some((o) => o.kind === "trap")) sawTrap = true;
      await wait(1200);
      await once(board, `${label}_b_reveal_mid_${ri}`);
      await once(phones[1], `${label}_p_reveal_${ri}`);
      // пока идёт раскрытие: штемпели ложатся, правда вписывается в заголовок
      const t0 = Date.now();
      while (Date.now() - t0 < 40000 && (await board.evaluate("state.phase")) === "reveal") {
        if (!sawStamp) sawStamp = (await board.evaluate("document.querySelectorAll('.clip.shown .stamp').length")) > 0;
        if (!stampsChecked && (await board.evaluate("document.querySelectorAll('.clip.shown').length === document.querySelectorAll('.clip').length && document.querySelectorAll('.clip').length > 0"))) {
          stampsChecked = true;
          const so = await board.evaluate(STAMPS_OK);
          check(so === true, `tv-matrix: раскрытие — штамп не закрывает вариант, подписи ≥ 24 px (${so})`);
        }
        // на ускорении (SPEED > 1) сервер спешит, а доска считает шаги по настоящим часам и до правды не доходит — правду смотрим на телефоне
        if (!sawTruthInHeadline && (await (SPEED > 1 ? phones[0] : board).evaluate("!!document.querySelector('mark.ans')"))) { sawTruthInHeadline = true; await once(board, `${label}_b_reveal_truth`); }
        await wait(200);
      }
      continue;
    }
    if (phase === "scores") {
      await wait(300);
      await once(board, `${label}_b_scores`);
      await once(phones[0], `${label}_p_scores`);
      await waitFor(board, "state.phase !== 'scores'", 8000);
      continue;
    }
    await wait(250);
  }
  return { facts, sawLate, sawHint, sawTrap, sawTruthInHeadline, sawStamp };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(SRV), STATIC: "..", NODE_ENV: "development", DUMP_FILE: path.join(os.tmpdir(), `fibs-ui-${SRV}.json`) }, stdio: ["ignore", "pipe", "pipe"] });
  let srvLog = "";
  srv.stdout.on("data", (d) => (srvLog += d));
  srv.stderr.on("data", (d) => (srvLog += d));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fibs-ui-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"], { stdio: "ignore" });
  await wait(2500);
  const pages = [];
  try {
    // ---------- 1. стартовый экран ----------
    const land = await cdp(`${BASE}/fibs.html`, [390, 844]);
    land.name = "стартовый";
    pages.push(land);
    await waitFor(land, "!!document.getElementById('create')", 8000);
    check((await land.evaluate("!!document.getElementById('create')")) === true, "стартовый экран: кнопка «Открыть редакцию»");
    for (const w of [320, 360, 390, 768, 1280]) {
      await land.call("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: w < 700 });
      await wait(400);
      check((await land.evaluate(NO_HSCROLL)) === true, `стартовый экран ${w}px: без прокрутки вбок`);
      check((await land.evaluate(OVERLAP)) === true, `стартовый экран ${w}px: звук и языки не наезжают`);
      await land.shot(`landing_${w}`);
    }
    for (const lang of ["en", "el"]) {
      await land.evaluate(`window.I18N && window.I18N.setLang && window.I18N.setLang("${lang}")`);
      await wait(300);
      check((await land.evaluate(NO_HSCROLL)) === true, `стартовый экран (${lang}): без прокрутки вбок`);
      await land.shot(`landing_${lang}`);
    }
    await land.evaluate(`window.I18N && window.I18N.setLang && window.I18N.setLang("ru")`);

    // ---------- 2. полная партия впятером ----------
    const room = await (await fetch(BASE + "/fibs/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "ru" }, speed: SPEED }) })).json();
    console.log("комната", room.code);
    const board = await cdp(`${BASE}/fibs-board.html?r=${room.code}&h=${room.hostToken}`);
    board.name = "доска";
    pages.push(board);
    await waitFor(board, "!!document.getElementById('startbtn') && document.body.classList.contains('host')", 8000);
    check((await board.evaluate("!!document.getElementById('startbtn')")) === true, "доска: лобби с кнопкой старта");
    check((await board.evaluate(OVERLAP)) === true, "доска: звук и языки не наезжают");
    check((await board.evaluate("document.getElementById('seats').getBoundingClientRect().left < document.getElementById('qr').getBoundingClientRect().left")) === true, "доска: список игроков слева от QR");
    await board.evaluate("document.querySelector('.seg button[data-k=hints][data-v=\"3\"]').click()");
    await waitFor(board, "state.settings.hints === 3", 3000);
    check((await board.evaluate("state.settings.hints")) === 3, "доска: настройка «Соври за меня» меняется");
    await board.evaluate("document.querySelector('.seg button[data-k=hints][data-v=\"2\"]').click()");

    const names = ["Аня", "Петя", "Оля", "Константин Константинопольский", "Ζωή"];
    const phones = await joinPhones(room.code, names, [[390, 844], [360, 640], [320, 568], [414, 896], [375, 667]]);
    pages.push(...phones);
    await wait(600);
    check((await board.evaluate("state.players.length")) === 5, "доска: пятеро в лобби");
    await board.shot("b_lobby");
    await phones[3].shot("p_lobby_longname");
    for (const p of phones) check((await p.evaluate(NO_HSCROLL)) === true, `${p.name}: лобби без прокрутки вбок`);
    check(/5/.test(await phones[0].evaluate("(document.getElementById('lobbyn') || {}).textContent || ''")), "телефон: в лобби счётчик «Нас N» (fibs-044)");

    await click(board, "#startbtn");
    const plan = [
      { truthFirst: ["Аня"], hint: ["Оля"], hedge: ["Петя"], like: ["Аня"] },
      { silent: ["Петя"] },
    ];
    const res = await playGame(board, phones, "g5", plan);
    check(res.facts === 7, `партия впятером: семь фактов (${res.facts})`);
    check(res.sawLate, "молчавший получил 🐌-ложь");
    check(res.sawHint, "«Соври за меня» отмечено 🎲 после раскрытия");
    check(res.sawTruthInHeadline, SPEED > 1 ? "правда вписана в факт на телефоне" : "правда вписана в заголовок на доске");
    check(res.sawStamp, "на доске штемпели раскрытия");
    check(!!(await waitFor(board, "state.phase === 'finished'", 15000)), "партия дошла до итогов");
    await wait(600);
    await board.shot("g5_b_final");
    for (const p of phones) { await p.shot("g5_p_final_" + p.name.slice(0, 4)); check((await p.evaluate(NO_HSCROLL)) === true, `${p.name}: итоги без прокрутки вбок`); }
    check((await board.evaluate("!!document.querySelector('.podium .p1')")) === true, "доска: пьедестал");
    check((await board.evaluate("!!document.getElementById('again')")) === true, "доска: кнопка «Ещё выпуск»");

    // ---------- 3. короткая партия втроём ----------
    await click(board, "#tolobby");
    await waitFor(board, "state.phase === 'lobby'", 5000);
    for (const id of await board.evaluate("state.players.slice(3).map((p) => p.id)")) await board.evaluate(`window.qpBoard.send({ type: "kick", playerId: "${id}" })`);
    await board.evaluate("document.querySelector('.seg button[data-k=short][data-v=\"true\"]').click()");
    await waitFor(board, "state.settings.short === true && state.players.length === 3", 5000);
    check((await board.evaluate("state.players.length")) === 3, "лобби: двое убраны, осталось трое");
    await click(board, "#startbtn");
    const small = await playGame(board, phones.slice(0, 3), "g3", []);
    check(small.facts === 5, `короткая партия втроём: пять фактов (${small.facts})`);
    check(small.sawTrap, "втроём варианты добиты ловушками игры");
    check(!!(await waitFor(board, "state.phase === 'finished'", 15000)), "короткая партия дошла до итогов");
    await board.shot("g3_b_final");

    // ---------- 3b. двухтактные команды ведущего (T-W1-13, U-12): «Закончить», «Дальше», ✕ у офлайн ----------
    await click(board, "#tolobby");
    await waitFor(board, "state.phase === 'lobby'", 5000);
    await click(board, "#startbtn");
    await waitFor(board, "state.phase === 'topic'", 8000);
    check((await board.evaluate("!document.getElementById('skipbtn').classList.contains('hidden')")) === true, "доска: «Дальше» видна ведущему в фазе темы");
    check((await board.evaluate("document.getElementById('endbtn').getBoundingClientRect().height >= 44")) === true, "доска: «Закончить» ≥ 44 px высотой");
    await click(board, "#endbtn");
    check((await board.evaluate("document.getElementById('endbtn').hasAttribute('data-armed')")) === true, "«Закончить»: первый тап только взводит («Точно завершить?»)");
    check((await board.evaluate("state.phase")) === "topic", "«Закончить»: после одного тапа партия идёт");
    await wait(1000); // skip не раньше 800 мс от старта фазы
    await click(board, "#skipbtn");
    check((await board.evaluate("document.getElementById('skipbtn').hasAttribute('data-armed') && !document.getElementById('endbtn').hasAttribute('data-armed')")) === true, "«Дальше»: взведена, «Закончить» остыла (взведена одна команда)");
    check((await board.evaluate("state.phase")) === "topic", "«Дальше»: после одного тапа фаза та же");
    await click(board, "#skipbtn");
    check(!!(await waitFor(board, "state.phase === 'lie'", 4000)), "«Дальше»: второй тап — тема выбрана жребием, пошла ложь");
    // взведённая кнопка сама остывает через 3 с
    await click(board, "#endbtn");
    await wait(3400);
    check((await board.evaluate("document.getElementById('endbtn').hasAttribute('data-armed')")) === false, "«Закончить»: без второго тапа за 3 с взвод снят");
    // ✕ у офлайн-игрока в карточках лжи: локально «роняем» связь у игрока в снимке доски
    await board.evaluate("(() => { const id = state.roster[0]; state.players.find((p) => p.id === id).online = false; viewKey = ''; render(); })()");
    check((await board.evaluate("document.querySelectorAll('.writer .kickx').length")) === 1, "карточка лжи офлайн-игрока: есть ✕");
    check((await board.evaluate("document.querySelector('.writer .kickx').getBoundingClientRect().width >= 44")) === true, "✕: цель ≥ 44 px");
    await click(board, ".writer .kickx");
    check((await board.evaluate("document.querySelector('.writer .kickx').hasAttribute('data-armed')")) === true, "✕: первый тап взводит («Точно убрать?»), игрока не убирает");
    check((await board.evaluate("state.players.length")) === 3, "✕: после одного тапа игроков по-прежнему трое");
    await wait(3400);
    check((await board.evaluate("document.querySelector('.writer .kickx') ? document.querySelector('.writer .kickx').hasAttribute('data-armed') : false")) === false, "✕: без второго тапа взвод снят");
    // «Закончить» двумя тапами завершает партию
    await click(board, "#endbtn");
    await click(board, "#endbtn");
    check(!!(await waitFor(board, "state.phase === 'finished'", 4000)), "«Закончить»: два тапа — партия завершена");

    // ---------- 4. перезагрузка телефона: возвращается по токену ----------
    await phones[0].call("Page.reload");
    check(!!(await waitFor(phones[0], "window.qpPhone && window.qpPhone.me", 8000)), "телефон после перезагрузки вернулся по токену");


    // ---------- 5. W2: неверный код, вход по имени, черновик, ссылка ведущего, язык комнаты (T-W2-04/05/20/21) ----------
    {
      const hdr = { "Content-Type": "application/json" };
      // 5a. неверный код — «Такой комнаты нет» с полем, не «закрыта» (fibs-028)
      const bad = await cdp(`${BASE}/fibs.html?r=ZZZZ99`, [390, 844]);
      bad.name = "неверный код";
      pages.push(bad);
      check(!!(await waitFor(bad, "!!document.getElementById('codeform')", 12000)), "неверный код: поле кода на экране «Такой комнаты нет»");
      check((await bad.evaluate("document.getElementById('app').textContent.includes('Такой комнаты нет') && !document.getElementById('app').textContent.includes('закрыта')")) === true, "неверный код: «Такой комнаты нет», а не «закрыта»");
      await bad.shot("w2_noroom");

      const r2 = await (await fetch(BASE + "/fibs/api/rooms", { method: "POST", headers: hdr, body: JSON.stringify({ settings: { lang: "ru" } }) })).json();
      // 5b. ссылка ведущего: токен не на экране, ссылка собирается, второй экран «Я ведущий» вставляет ссылку
      const hb = await cdp(`${BASE}/fibs-board.html?r=${r2.code}&h=${r2.hostToken}`);
      hb.name = "доска W2";
      pages.push(hb);
      check(!!(await waitFor(hb, "document.body.classList.contains('host')", 8000)), "доска по ?h=: ведущий");
      const url = await hb.evaluate("HL && HL.url()");
      check(typeof url === "string" && url.includes("fibs-board.html") && url.includes("h=" + r2.hostToken), "ссылка ведущего собирается из ключа");
      check((await hb.evaluate(`!document.body.innerHTML.includes(${JSON.stringify(r2.hostToken)})`)) === true, "токен ведущего на экране не рисуется");
      check((await hb.evaluate("!!document.querySelector('#hostbar .linkbtn')")) === true, "доска: кнопка «Ссылка ведущего»");
      check((await hb.evaluate("document.querySelector('#hostbar .linkbtn').getBoundingClientRect().height >= 44")) === true, "«Ссылка ведущего» ≥ 44 px");
      const hb2 = await cdp(`${BASE}/fibs-board.html?r=${r2.code}`);
      hb2.name = "вторая доска";
      pages.push(hb2);
      check(!!(await waitFor(hb2, "!!document.querySelector('#hostbar .linkbtn') && !document.body.classList.contains('host')", 8000)), "вторая доска без ключа: «Я ведущий»");
      await click(hb2, "#hostbar .linkbtn");
      await waitFor(hb2, "!!document.querySelector('#hostbar input')", 3000);
      await type(hb2, "#hostbar input", url);
      await click(hb2, "#hostbar button");
      check(!!(await waitFor(hb2, "document.body.classList.contains('host')", 6000)), "вторая доска: после вставки ссылки — ведущий");

      // 5c. вход по имени: тёзка онлайн → «Маша (2)» с тостом; офлайн → «Это ты?»
      const mk = async (name, size) => {
        const ph = await cdp(`${BASE}/fibs.html?r=${r2.code}`, size || [390, 844]);
        ph.name = name;
        pages.push(ph);
        await waitFor(ph, "!!document.getElementById('name')", 8000);
        await type(ph, "#name", name);
        await click(ph, "#enterform button[type=submit]");
        return ph;
      };
      const a = await mk("Маша");
      check(!!(await waitFor(a, "window.qpPhone && window.qpPhone.me", 6000)), "Маша: вошла");
      const b = await mk("Маша");
      check(!!(await waitFor(b, "window.qpPhone && window.qpPhone.me", 6000)), "тёзка онлайн: вошёл");
      check((await b.evaluate("window.qpPhone.state.players.some((p) => p.name === 'Маша (2)')")) === true, "тёзка онлайн: «Маша (2)», а не «Маша 2» или перехват");
      check((await b.evaluate("document.getElementById('toast').textContent.includes('Маша (2)')")) === true, "тёзка онлайн: тост «Имя занято: ты теперь «Маша (2)»»");
      await browserCall("Target.closeTarget", { targetId: a.targetId });
      pages.splice(pages.indexOf(a), 1);
      await wait(2600);
      const c = await cdp(`${BASE}/fibs.html?r=${r2.code}`, [390, 844]);
      c.name = "Маша (после)";
      pages.push(c);
      await waitFor(c, "!!document.getElementById('name')", 8000);
      await type(c, "#name", "Маша");
      await click(c, "#enterform button[type=submit]");
      check(!!(await waitFor(c, "!!document.getElementById('claimyes')", 6000)), "офлайн-тёзка: экран «Это ты, Маша?»");
      await c.shot("w2_claim");
      check((await c.evaluate("document.getElementById('claimyes').getBoundingClientRect().height >= 44")) === true, "«Занять место» ≥ 44 px");
      await click(c, "#claimyes");
      check(!!(await waitFor(c, "window.qpPhone && window.qpPhone.me", 6000)), "«Занять место»: вошла на своё место");
      check((await c.evaluate("window.qpPhone.state.players.filter((p) => !p.left).length")) === 2, "«Занять место»: игроков по-прежнему двое");
      // 5d. счётчик «N/16» у имени
      const cnt = await cdp(`${BASE}/fibs.html?r=${r2.code}`, [390, 844]);
      cnt.name = "счётчик имени";
      pages.push(cnt);
      await waitFor(cnt, "!!document.getElementById('name')", 8000);
      await type(cnt, "#name", "Двенадцатибуква");
      check((await cnt.evaluate("document.getElementById('ncnt').textContent")) === "15/16", "счётчик имени: «15/16» с 12 символов");

      // 5e. черновик лжи переживает reload (fibs-018)
      const d = await mk("Витя");
      await waitFor(d, "window.qpPhone && window.qpPhone.me", 6000);
      await hb2.evaluate("window.qpBoard.send({ type: 'start' })");
      const ph3 = [c, b, d];
      let inLie = false;
      for (let i = 0; i < 100 && !inLie; i++) {
        for (const p of ph3) {
          const st = await p.evaluate("(() => { const s = window.qpPhone.state; return s ? { phase: s.phase, chooser: !!(s.me && s.me.chooser), topic: s.topics && s.topics[0] } : null; })()");
          if (st && st.phase === "topic" && st.chooser && !p.sentTopic) { p.sentTopic = true; await p.evaluate(`window.qpPhone.send({ type: "topic", topic: ${JSON.stringify(st.topic)} })`); }
        }
        inLie = (await c.evaluate("(() => { const s = window.qpPhone.state; return !!s && s.phase === 'lie' && !!s.me && s.me.inRound && !s.me.lie; })()")) === true;
        if (!inLie) await wait(400);
      }
      check(inLie, "партия втроём дошла до фазы лжи");
      if (inLie) {
        await waitFor(c, "!!document.getElementById('lie')", 5000);
        await type(c, "#lie", "черновичок");
        await wait(400);
        await c.call("Page.reload");
        check(!!(await waitFor(c, "window.qpPhone && window.qpPhone.me", 8000)), "после reload: вернулась по токену");
        const kept = await waitFor(c, "(document.getElementById('lie') || {}).value === 'черновичок'", 6000);
        check(!!kept, "после reload: черновик лжи на месте");
      }

      // 5f. подсказка языка комнаты: телефон открыт по-английски, комната русская (U-17, подсказка, не принуждение)
      const en = await cdp(`${BASE}/fibs.html?r=${r2.code}`, [390, 844]);
      en.name = "телефон en";
      pages.push(en);
      await waitFor(en, "!!document.getElementById('name')", 8000);
      await en.evaluate("window.I18N.setLang('en', { persist: false })");
      await en.evaluate("sessionStorage.removeItem('mp-lang-manual')");
      await en.call("Page.reload");
      await waitFor(en, "!!document.getElementById('name')", 8000);
      await en.evaluate("window.I18N.setLang('en', { persist: false })");
      await en.evaluate("checkRoomLang()");
      const hint = await waitFor(en, "(() => { const h = document.getElementById('langhint'); return h && !h.hidden && h.textContent; })()", 6000);
      check(!!hint && /RU/.test(hint), "язык комнаты: подсказка «Room language: RU. Switch?» (" + String(hint).slice(0, 40) + ")");
      if (hint) {
        check((await en.evaluate("window.I18N.lang")) === "en", "язык комнаты: сам не переключается");
        await en.evaluate("document.querySelector('#langhint [data-y]').click()");
        check((await waitFor(en, "window.I18N.lang === 'ru'", 3000)) === true, "язык комнаты: «Переключить» — русский");
      }
    }


    // ---------- 6. W3: tv-matrix / phone-matrix (T-W3-02, T-W3-15) ----------
    {
      const { tvSizes, phoneSizes } = require("../tools/testkit/sizes");
      const r6 = await (await fetch(BASE + "/fibs/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "ru" }, speed: SPEED }) })).json();
      const b6 = await cdp(`${BASE}/fibs-board.html?r=${r6.code}&h=${r6.hostToken}`);
      b6.name = "доска W3";
      pages.push(b6);
      await waitFor(b6, "!!document.getElementById('startbtn') && document.body.classList.contains('host')", 8000);
      const nm = ["Alexandra-Long-N", "Маша", "Гоша", "Даша", "Егор", "Зоя"];
      const p6 = await joinPhones(r6.code, nm, [[320, 568]]);
      pages.push(...p6);
      await wait(500);
      // tv-matrix: лобби — без вертикальной прокрутки, «В печать!» в экране, длинное имя не рвётся посреди слова
      for (const sz of tvSizes()) {
        await b6.call("Emulation.setDeviceMetricsOverride", { width: sz.width, height: sz.height, deviceScaleFactor: 1, mobile: false });
        await wait(350);
        const lob = await b6.evaluate(`(() => { const l = document.querySelector(".screen.lobby"), sb = document.getElementById("startbtn").getBoundingClientRect();
          const brk = [...document.querySelectorAll(".seat b")].filter((b) => b.textContent.indexOf("Alexandra") === 0 && b.scrollHeight > b.clientHeight + 1).length;
          const url = parseFloat(getComputedStyle(document.querySelector(".url")).fontSize);
          return { scroll: l.scrollHeight - l.clientHeight, startOk: sb.bottom <= innerHeight, brk, url, w: innerWidth }; })()`);
        check(lob.scroll <= 1 && lob.startOk, `tv-matrix ${sz.name}: лобби без вертикальной прокрутки, «В печать!» в экране (scroll ${lob.scroll})`);
        check(lob.brk === 0, `tv-matrix ${sz.name}: «Alexandra-Long-N» целиком в карточке`);
        if (sz.width >= 1600) check(lob.url >= 24, `tv-matrix ${sz.name}: адрес комнаты ≥ 24 px (${lob.url})`);
        check((await b6.evaluate(NO_HSCROLL)) === true, `tv-matrix ${sz.name}: лобби без прокрутки вбок`);
      }
      await b6.call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
      await b6.evaluate("document.querySelector('#startbtn').click()");
      // телефон: до выбора — ложь с клавиатурой, потом выбор в каждом размере
      const driveTo = async (want) => {
        for (let i = 0; i < 120; i++) {
          const ph = await p6[0].evaluate("window.qpPhone.state && window.qpPhone.state.phase");
          if (ph === want) return true;
          for (const p of p6) {
            const st = await p.evaluate("(() => { const s = window.qpPhone.state; return s ? { phase: s.phase, chooser: !!(s.me && s.me.chooser), topic: s.topics && s.topics[0], lied: !!(s.me && s.me.lie), inRound: !!(s.me && s.me.inRound), picked: !!(s.me && s.me.picks) } : null; })()");
            if (!st) continue;
            if (st.phase === "topic" && st.chooser && !p.sentTopic6) { p.sentTopic6 = true; await p.evaluate(`window.qpPhone.send({ type: "topic", topic: ${JSON.stringify(st.topic)} })`); }
            if (want === "choose" && st.phase === "lie" && st.inRound && !st.lied && p !== p6[0]) await p.evaluate(`window.qpPhone.send({ type: "lie", text: "враки ${Math.random().toString(36).slice(2, 6)}" })`);
          }
          await wait(300);
        }
        return false;
      };
      check(await driveTo("lie"), "phone-matrix: партия дошла до лжи");
      await waitFor(p6[0], "!!document.getElementById('lie')", 5000);
      const lieMatrix = [[320, 568], [360, 740], [390, 844], [568, 320], [844, 390]];
      for (const [w, h] of lieMatrix) {
        await p6[0].call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
        await wait(250);
        const m = await p6[0].evaluate(`(() => { const b = document.getElementById("hintbtn").getBoundingClientRect(); return { hscroll: document.documentElement.scrollWidth > innerWidth, hintBottom: b.bottom, ih: innerHeight, tap: b.height >= 44 }; })()`);
        check(!m.hscroll && m.hintBottom <= m.ih + 40 && m.tap, `phone-matrix ${w}x${h}: ложь — «Соври за меня» рядом с экраном, ≥ 44 px, без прокрутки вбок (${Math.round(m.hintBottom)}/${m.ih})`);
      }
      // клавиатура: окно ужимается (320×568 → 320×268), «Соври за меня» остаётся в видимой области
      await p6[0].call("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
      await wait(300);
      await p6[0].evaluate("document.getElementById('lie').focus()");
      await p6[0].call("Emulation.setDeviceMetricsOverride", { width: 320, height: 268, deviceScaleFactor: 2, mobile: true });
      await wait(900);
      const kb = await p6[0].evaluate(`(() => { const b = document.getElementById("hintbtn").getBoundingClientRect(), i = document.getElementById("lie").getBoundingClientRect();
        return { kb: document.documentElement.classList.contains("kb"), hint: b.bottom, input: i.top, ih: innerHeight }; })()`);
      check(kb.kb && kb.hint <= kb.ih + 1 && kb.input >= 0, `phone-matrix 320x268 с клавиатурой: «Соври за меня» и поле в видимой области (${Math.round(kb.hint)}/${kb.ih})`);
      await p6[0].evaluate("document.activeElement.blur()");
      await p6[0].call("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
      await wait(300);
      await p6[0].evaluate("window.qpPhone.send({ type: 'lie', text: 'мой обман' })");
      check(await driveTo("choose"), "phone-matrix: дошли до выбора");
      await waitFor(p6[0], "document.querySelectorAll('.opt').length > 1", 4000);
      // W5: «Подстраховка» и «Это правда · n/2» — липкая полоса у нижнего края; проверяем без прокрутки, при коротком и длинном факте
      // (раньше «Подстраховка» стояла над списком и на 568×320 с длинным фактом уезжала за край: детерминированно от длины факта)
      const measureChoose = `(() => { const r = (e) => e.getBoundingClientRect(); const hb = r(document.getElementById("hedge")); const pk = document.getElementById("pickbtn");
        const o = document.querySelector(".opt"); const op = [...document.querySelectorAll(".opt")]; const re = [...document.querySelectorAll(".reacts button")].map((b) => r(b));
        return { hscroll: document.documentElement.scrollWidth > innerWidth, y: scrollY, hedgeBottom: hb.bottom, hedgeH: hb.height, pickBottom: pk ? r(pk).bottom : 0, pickH: pk ? r(pk).height : 99,
          ih: innerHeight, optH: Math.min(...op.map((b) => r(b).height)), reactsOk: re.every((b) => b.width >= 43.5 && b.height >= 43.5) }; })()`;
      for (const long of [false, true]) {
        if (long) await p6[0].evaluate("(() => { const f = document.querySelector('.fact'); f.textContent = (f.textContent + ' ').repeat(3); })()");
        for (const [w, h] of [[320, 568], [375, 667], [390, 844], [412, 915], [568, 320], [667, 375], [844, 390], [915, 412]]) {
          await p6[0].call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
          await wait(250);
          await p6[0].evaluate("window.scrollTo(0, 0)");
          const m = await p6[0].evaluate(measureChoose);
          check(!m.hscroll && m.y === 0 && m.hedgeBottom <= m.ih && m.hedgeH >= 43.5 && m.optH >= 43.5,
            `phone-matrix ${w}x${h}${long ? " (длинный факт)" : ""}: выбор — «Подстраховка» в первом экране без прокрутки, тап ≥ 44 (${Math.round(m.hedgeBottom)}/${m.ih}, ${Math.round(m.hedgeH)} px, вариант ${Math.round(m.optH)} px)`);
          if (!long) {
            await p6[0].evaluate("document.getElementById('hedge').click()");
            await wait(150);
            await p6[0].evaluate("window.scrollTo(0, 0)");
            const on = await p6[0].evaluate(measureChoose);
            check(on.pickBottom <= on.ih && on.hedgeBottom <= on.ih && on.pickH >= 43.5, `phone-matrix ${w}x${h}: подстраховка включена — «Это правда · 0/2» видна без прокрутки (${Math.round(on.pickBottom)}/${on.ih})`);
            await p6[0].evaluate("document.getElementById('hedge').click()");
            await wait(150);
          }
        }
      }
    }

    for (const p of pages) check(p.errors.length === 0, `${p.name || "страница"}: без JS-ошибок` + (p.errors[0] ? ": " + p.errors[0] : ""));
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    try { chrome.kill(); } catch {}
    try { srv.kill(); } catch {}
    if (failures) console.log(srvLog.split("\n").slice(-30).join("\n"));
  }
  console.log(failures ? `\nПРОВАЛОВ: ${failures}` : "\nвсё зелёное");
  process.exit(failures ? 1 : 0);
}

main();
