"use strict";

/*
 * UI-тест «Вопроса ребром»: headless Chrome через DevTools-протокол (как bomb/test-ui.js).
 *   node test-ui.js [папка для скриншотов]
 * Сам поднимает dev-сервер со статикой сайта. Что проверяет:
 *   1. стартовый экран на ширинах 320–1280: без прокрутки вбок, звук и языки не наезжают;
 *   2. живая партия: доска + 5 телефонов (у каждого свой контекст браузера — свои токены),
 *      ответы печатаются и отправляются НАСТОЯЩИМИ нажатиями, подсказка тянется двойным тапом,
 *      двое пишут одно и то же в разных падежах — на доске «Джинкс», один молчит — 🐌,
 *      голосуют тапами, доходим до итогов;
 *   3. короткая партия втроём (дуэли «на всех» + финал);
 *   4. на каждом шаге: нет JS-ошибок, телефоны не прокручиваются вбок, ответы на доске влезают в карточки.
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
// ответы на доске влезают в свои карточки (шрифт подогнан, коробка не выросла)
const WALL_FITS = `(() => { const cards = [...document.querySelectorAll(".ans")]; if (!cards.length) return "no cards";
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
    const ph = await cdp(`${BASE}/quip.html?r=${code}`, sizes[i % sizes.length]);
    ph.name = name;
    await waitFor(ph, "!!document.getElementById('name')", 8000);
    await type(ph, "#name", name);
    await click(ph, "#enterform button[type=submit]");
    phones.push(ph);
  }
  for (const ph of phones) check(!!(await waitFor(ph, "window.qpPhone.me", 5000)), `телефон ${ph.name}: вошёл`);
  return phones;
}

// Все телефоны отвечают на свои вопросы настоящими нажатиями. opts: silent — не отвечает; hint — тянет подсказку; jinx — пара пишет одно и то же
async function answerRound(phones, opts = {}) {
  let n = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (const ph of phones) {
      if (opts.silent && opts.silent.includes(ph.name)) continue;
      const st = await ph.evaluate("(() => { const s = window.qpPhone.state; return s && s.phase === 'answer' && s.me && s.me.inRound ? s.me.prompts.find((p) => !p.done) || null : null; })()");
      if (!st) continue;
      // экран ещё переворачивает подсказку — подождём
      await waitFor(ph, "!!document.getElementById('sendbtn') && !document.getElementById('sendbtn').disabled", 4000);
      if (opts.hint && opts.hint.includes(ph.name) && !ph.hinted) {
        ph.hinted = true;
        await click(ph, "#hintbtn");
        await wait(150);
        check((await ph.evaluate("document.getElementById('hintbtn').classList.contains('sure')")) === true, `${ph.name}: подсказка просит подтверждения`);
        await click(ph, "#hintbtn");
        const got = await waitFor(ph, "(document.querySelector('.gotit')||{}).textContent", 3000);
        check(!!got, `${ph.name}: подсказка перевернулась: «${String(got || "").trim().slice(0, 40)}»`);
        await ph.shot("p_hint_" + ph.name);
        await wait(2000);
        n++;
        continue;
      }
      const jinxText = opts.jinx && opts.jinx[st.id];
      if (st.deck === "final") {
        for (let i = 0; i < 3; i++) await type(ph, `.three input[data-i="${i}"]`, `${ph.name} пункт ${i + 1} ${pass}`);
      } else {
        await type(ph, "#ta", jinxText ? jinxText[ph.name] : `Шутка от ${ph.name} №${pass}${st.id}`);
      }
      if (n === 0) await ph.shot("p_answer");
      await click(ph, "#sendbtn");
      n++;
      await wait(250);
    }
  }
  return n;
}

async function voteRound(phones) {
  let n = 0;
  for (const ph of phones) {
    const can = await ph.evaluate("(() => { const s = window.qpPhone.state; return s && s.phase === 'vote' && s.me && s.me.canVote && !s.me.voted ? s.me.votesFor : 0; })()");
    if (!can) continue;
    await waitFor(ph, "document.querySelectorAll('.opt:not(.own)').length > 0", 3000);
    const opts = await ph.evaluate("document.querySelectorAll('.opt:not(.own)').length");
    for (let i = 0; i < Math.min(can, opts); i++) {
      await ph.evaluate(`document.querySelectorAll('.opt:not(.own)')[${i}].click()`);
      await wait(120);
    }
    if (can > 1) await click(ph, "#votebtn");
    n++;
    await wait(150);
  }
  return n;
}

async function playGame(board, phones, label, plan) {
  let rounds = 0, sawJinx = false, sawLate = false, sawHint = false;
  const revealed = new Set();
  const shotOnce = new Set();
  const once = async (page, name) => { if (shotOnce.has(name)) return; shotOnce.add(name); await page.shot(name); };
  for (let step = 0; step < 400; step++) {
    const ph = await board.evaluate("state && state.phase + ':' + state.ri + ':' + state.mi");
    const [phase, ri] = String(ph).split(":");
    if (phase === "finished") break;
    if (phase === "intro") { await once(board, `${label}_b_intro_${ri}`); await wait(400); continue; }
    if (phase === "answer") {
      const key = plan[Number(ri)] || {};
      await wait(500);
      await once(board, `${label}_b_answer_${ri}`);
      // джинкс: найти дуэль двух наших телефонов и написать одно и то же в разных падежах
      let jinx = null;
      if (key.jinx) {
        const mine = {};
        // тот, кто тянет подсказку, в джинкс не годится
        for (const p of phones) if (!(key.hint || []).includes(p.name)) mine[p.name] = await p.evaluate("(window.qpPhone.state.me.prompts || []).map((x) => x.id)");
        const all = Object.entries(mine);
        outer: for (const [a, la] of all) for (const [b, lb] of all) {
          if (a >= b) continue;
          const shared = la.find((x) => lb.includes(x));
          if (shared != null) { jinx = { [shared]: { [a]: "Кота в мешке", [b]: "кот в МЕШКЕ!" } }; break outer; }
        }
      }
      await answerRound(phones, { ...key, jinx });
      const moved = await waitFor(board, "state.phase !== 'answer'", key.silent ? 45000 / SPEED + 5000 : 8000);
      check(!!moved, `${label}: раунд ${Number(ri) + 1} — ответы собраны`);
      rounds++;
      continue;
    }
    if (phase === "vote") {
      await wait(400);
      await once(board, `${label}_b_vote_${ri}`);
      await once(phones[0], `${label}_p_vote_${ri}`);
      const fits = await board.evaluate(WALL_FITS);
      check(fits === true, `${label}: доска, голосование раунда ${Number(ri) + 1} — ответы влезают (${fits})`);
      for (const p of phones) { const h = await p.evaluate(NO_HSCROLL); if (h !== true) check(false, `${p.name}: голосование без прокрутки вбок`); }
      await voteRound(phones);
      await waitFor(board, "state.phase !== 'vote'", 15000 / SPEED + 3000);
      continue;
    }
    if (phase === "reveal") {
      await wait(500);
      const c = await board.evaluate("JSON.stringify(state.current)");
      const cur = JSON.parse(c || "null");
      if (!cur || revealed.has(cur.id)) { await wait(200); continue; }
      revealed.add(cur.id);
      if (cur && cur.result) {
        if (cur.result.jinx.length) { sawJinx = true; await once(board, `${label}_b_jinx`); check((await board.evaluate("[...document.querySelectorAll('.ans.stamped .stamp')].some((s) => /ДЖИНКС/.test(s.textContent))")) === true, `${label}: на доске штамп «ДЖИНКС!»`); }
        if (cur.answers.some((a) => a.late)) { sawLate = true; await once(board, `${label}_b_late`); }
        if (cur.answers.some((a) => a.hint && !a.late)) sawHint = true;
      }
      await once(board, `${label}_b_reveal_${ri}`);
      await once(phones[1], `${label}_p_reveal_${ri}`);
      await waitFor(board, `state.phase !== 'reveal' || (state.current && state.current.id !== ${cur ? cur.id : -1})`, 8000);
      continue;
    }
    if (phase === "scores") { await wait(300); await once(board, `${label}_b_scores_${ri}`); await once(phones[0], `${label}_p_scores_${ri}`); await waitFor(board, "state.phase !== 'scores'", 8000); continue; }
    await wait(300);
  }
  return { rounds, reveals: revealed.size, sawJinx, sawLate, sawHint };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(SRV), STATIC: "..", NODE_ENV: "development", DUMP_FILE: path.join(os.tmpdir(), `quip-ui-${SRV}.json`) }, stdio: ["ignore", "pipe", "pipe"] });
  let srvLog = "";
  srv.stdout.on("data", (d) => (srvLog += d));
  srv.stderr.on("data", (d) => (srvLog += d));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "quip-ui-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"], { stdio: "ignore" });
  await wait(2500);
  const pages = [];
  try {
    // ---------- 1. стартовый экран ----------
    const land = await cdp(`${BASE}/quip.html`, [390, 844]);
    pages.push(land);
    await waitFor(land, "!!document.getElementById('create')", 8000);
    check((await land.evaluate("!!document.getElementById('create')")) === true, "стартовый экран: кнопка «Открыть клуб»");
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
    check(land.errors.length === 0, "стартовый экран без JS-ошибок" + (land.errors[0] ? ": " + land.errors[0] : ""));

    // ---------- 2. полная партия впятером ----------
    const room = await (await fetch(BASE + "/quip/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "ru" }, speed: SPEED }) })).json();
    console.log("комната", room.code);
    const board = await cdp(`${BASE}/quip-board.html?r=${room.code}&h=${room.hostToken}`);
    pages.push(board);
    await waitFor(board, "!!document.getElementById('startbtn') && document.body.classList.contains('host')", 8000);
    check((await board.evaluate("!!document.getElementById('startbtn')")) === true, "доска: лобби с кнопкой старта");
    check((await board.evaluate(OVERLAP)) === true, "доска: звук и языки не наезжают");
    // игроки слева (правило владельца)
    check((await board.evaluate("document.getElementById('seats').getBoundingClientRect().left < document.getElementById('qr').getBoundingClientRect().left")) === true, "доска: список игроков слева от QR");
    await board.evaluate("document.querySelector('.seg button[data-k=hints][data-v=\"3\"]').click()");
    await waitFor(board, "state.settings.hints === 3", 3000);
    check((await board.evaluate("state.settings.hints")) === 3, "доска: настройка подсказок меняется");
    await board.evaluate("document.querySelector('.seg button[data-k=hints][data-v=\"2\"]').click()");

    const names = ["Аня", "Петя", "Оля", "Константин Константинопольский", "Ζωή"];
    const phones = await joinPhones(room.code, names, [[390, 844], [360, 640], [320, 568], [414, 896], [375, 667]]);
    pages.push(...phones);
    await wait(600);
    check((await board.evaluate("state.players.length")) === 5, "доска: пятеро в лобби");
    check((await board.evaluate("!document.getElementById('startbtn').disabled")) === true, "доска: старт доступен");
    await board.shot("b_lobby");
    await phones[3].shot("p_lobby_longname");
    for (const p of phones) check((await p.evaluate(NO_HSCROLL)) === true, `${p.name}: лобби без прокрутки вбок`);

    await click(board, "#startbtn");
    const res = await playGame(board, phones, "g5", [{ jinx: true, hint: ["Оля"] }, { silent: ["Петя"] }, {}, {}]);
    check(res.rounds === 4, `партия впятером: четыре раунда (${res.rounds})`);
    check(res.reveals >= 12, `партия впятером: раскрытий ${res.reveals} (5 дуэлей + сцена + 5 дуэлей + финал)`);
    check(res.sawJinx, "джинкс случился на одинаковых ответах в разных падежах");
    check(res.sawLate, "молчавший получил 🐌-подсказку");
    check(res.sawHint, "вытянутая подсказка отмечена 🎲 после раскрытия");
    check(!!(await waitFor(board, "state.phase === 'finished'", 15000)), "партия дошла до итогов");
    await wait(600);
    await board.shot("g5_b_final");
    for (const p of phones) { await p.shot("g5_p_final_" + p.name.slice(0, 4)); check((await p.evaluate(NO_HSCROLL)) === true, `${p.name}: итоги без прокрутки вбок`); }
    check((await board.evaluate("!!document.querySelector('.podium .p1')")) === true, "доска: пьедестал");
    check((await board.evaluate("!!document.getElementById('again')")) === true, "доска: кнопка «Ещё шоу»");

    // ---------- 3. короткая партия втроём ----------
    await click(board, "#tolobby");
    await waitFor(board, "state.phase === 'lobby'", 5000);
    for (const id of await board.evaluate("state.players.slice(3).map((p) => p.id)")) await board.evaluate(`window.qpBoard.send({ type: "kick", playerId: "${id}" })`);
    await board.evaluate("document.querySelector('.seg button[data-k=short][data-v=\"true\"]').click()");
    await waitFor(board, "state.settings.short === true && state.players.length === 3", 5000);
    check((await board.evaluate("state.players.length")) === 3, "лобби: двое убраны, осталось трое");
    await click(board, "#startbtn");
    const small = await playGame(board, phones.slice(0, 3), "g3", [{}, {}]);
    check(small.rounds === 2, `короткая партия втроём: два раунда (${small.rounds})`);
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
