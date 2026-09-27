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
  return { call, evaluate, shot, errors, name: "" };
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
  for (const ph of phones) check(!!(await waitFor(ph, "window.qpPhone.me", 5000)), `телефон ${ph.name}: вошёл`);
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
      const moved = await waitFor(board, "state.phase !== 'lie'", key.silent ? 33000 / SPEED + 5000 : 8000);
      check(!!moved, `${label}: факт ${facts} — ложь собрана`);
      continue;
    }
    if (phase === "choose") {
      await wait(500);
      const fits = await board.evaluate(WALL_FITS);
      check(fits === true, `${label}: доска, факт ${facts} — вырезки влезают (${fits})`);
      await once(board, `${label}_b_choose_${ri}`);
      await once(phones[0], `${label}_p_choose`);
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

    // ---------- 4. перезагрузка телефона: возвращается по токену ----------
    await phones[0].call("Page.reload");
    check(!!(await waitFor(phones[0], "window.qpPhone && window.qpPhone.me", 8000)), "телефон после перезагрузки вернулся по токену");

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
