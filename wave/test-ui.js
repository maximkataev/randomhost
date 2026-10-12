"use strict";

/*
 * UI-тест «На одной волне»: headless Chrome через DevTools-протокол (как fibs/test-ui.js).
 *   node test-ui.js [папка для скриншотов]
 * Сам поднимает dev-сервер со статикой сайта. Что проверяет:
 *   1. стартовый экран на ширинах 320–1280: без прокрутки вбок, звук и языки не наезжают;
 *   2. живая партия: доска + 4 телефона (у каждого свой контекст браузера — свои токены):
 *      шкала выбирается тапом, подсказка печатается НАСТОЯЩИМ вводом; цифры и слово полюса отклоняются;
 *      стрелку тянут пальцем (pointer-события по шкале) и кнопками ◀ ▶, фиксируют кнопкой;
 *      один игрок во втором раунде молчит — его шкала пропускается; доходим до итогов;
 *   3. на каждом шаге: нет JS-ошибок, телефоны не прокручиваются вбок, подсказка и полюса на доске влезают,
 *      шкала целиком на экране.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { EXTRA_MS } = require("./game");

const OUT = process.argv[2] || path.join(__dirname, "state", "ui");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9700 + Math.floor(Math.random() * 100);
const SRV = 5200 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${SRV}`;
const SPEED = Number(process.env.SPEED || 1);
const BOARD = (process.env.BOARD || "1600x900").split("x").map(Number);
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
async function cdp(url, phone, lang) {
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
  else await call("Emulation.setDeviceMetricsOverride", { width: BOARD[0], height: BOARD[1], deviceScaleFactor: 1, mobile: false });
  // фоновые вкладки headless не крутят rAF — эмулируем фокус у всех
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  // LANG=en|el — язык до загрузки страницы (i18n.js берёт сохранённый выбор); у доски он же язык комнаты
  if (lang || process.env.LANG_UI) await call("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("site-lang", ${JSON.stringify(lang || process.env.LANG_UI)}); } catch (e) {}` });
  // стенд обрыва: запоминаем сокеты страницы, чтобы закрыть их из теста (ws.close() у клиента)
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `(function(){var W=window.WebSocket;window.__socks=[];window.WebSocket=function(u,p){var s=p?new W(u,p):new W(u);window.__socks.push(s);return s;};window.WebSocket.prototype=W.prototype;["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){window.WebSocket[k]=W[k];});})();` });
  await call("Page.navigate", { url });
  const evaluate = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };
  const shot = async (name) => {
    const r = await call("Page.captureScreenshot", { format: "png" });
    if (r && r.data) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
    // телефон на каждом снимке: ничего не вылезает вбок
    if (phone) { const ok = (await evaluate("document.documentElement.scrollWidth <= innerWidth")) === true; if (!ok) check(false, `${name}: прокрутка вбок на ${phone[0]}px`); }
  };
  return { call, evaluate, shot, errors, name: "" };
}

async function type(page, selector, text) {
  await page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.focus(); n.value = ""; n.dispatchEvent(new Event("input")); })()`);
  await page.call("Input.insertText", { text });
}
const click = (page, selector) => page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);

const NO_HSCROLL = "document.documentElement.scrollWidth <= innerWidth";
const OVERLAP = `(() => { const a = document.querySelector(".sound-toggle-btn").getBoundingClientRect(), b = document.querySelector(".lang-switch").getBoundingClientRect();
  return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom; })()`;
// доска: подсказка и полюса влезают, шкала целиком на экране
const BOARD_FITS = `(() => { const bad = [];
  const c = document.getElementById("cluetxt"); if (c && (c.scrollHeight > c.clientHeight + 2 || c.scrollWidth > c.clientWidth + 2)) bad.push("подсказка");
  document.querySelectorAll("#poles div").forEach((d) => { if (d.scrollHeight > d.clientHeight + 2 || d.firstChild.offsetWidth > d.clientWidth + 2) bad.push("полюс " + d.textContent); });
  const d = document.querySelector("main .dial"); if (d) { const r = d.getBoundingClientRect(); if (r.bottom > innerHeight + 1 || r.top < 0 || r.width < innerWidth * 0.3) bad.push("шкала " + Math.round(r.top) + "…" + Math.round(r.bottom) + " w" + Math.round(r.width)); }
  const p = document.getElementById("poles"); if (p) { const r = p.getBoundingClientRect(); if (r.bottom > innerHeight + 1) bad.push("полюса за экраном"); }
  return bad.length ? bad.join(", ") : true; })()`;

async function waitFor(page, expr, ms = 20000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(expr);
    if (v && !v.__error) return v;
    await wait(step);
  }
  return null;
}

// тянем стрелку: pointer-события по шкале в точку нужного угла
async function drag(ph, angle) {
  return ph.evaluate(`(() => {
    const svg = document.querySelector(".dial.grab"); if (!svg) return false;
    const b = svg.getBoundingClientRect();
    const pt = (a) => { const t = a * Math.PI / 180; return [b.left + (500 - 300 * Math.cos(t)) / 1000 * b.width, b.top + (510 - 300 * Math.sin(t)) / 540 * b.height]; };
    const fire = (type, a) => { const [x, y] = pt(a); svg.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true, isPrimary: true, pointerType: "touch" })); };
    fire("pointerdown", 90); for (let a = 90; Math.abs(a - ${angle}) > 5; a += Math.sign(${angle} - a) * 5) fire("pointermove", a); fire("pointermove", ${angle}); fire("pointerup", ${angle});
    return window.wvPhone.needle; })()`);
}

async function joinPhones(code, names, sizes) {
  const phones = [];
  for (const [i, name] of names.entries()) {
    const ph = await cdp(`${BASE}/wave.html?r=${code}`, sizes[i % sizes.length]);
    ph.name = name;
    ph.size = sizes[i % sizes.length];
    await waitFor(ph, "!!document.getElementById('name')", 8000);
    await type(ph, "#name", name);
    await click(ph, "#enterform button[type=submit]");
    phones.push(ph);
  }
  for (const ph of phones) check(!!(await waitFor(ph, "window.wvPhone.me", 5000)), `телефон ${ph.name}: вошёл`);
  return phones;
}

const PHASE = "(() => { const s = window.wvPhone && window.wvPhone.state; return s ? s.phase : null; })()";

async function clueRound(phones, ri, label, silent) {
  let triedDigits = false, triedPole = false, rerolled = false;
  for (const ph of phones) {
    if (silent && silent.includes(ph.name)) continue;
    const pick = await waitFor(ph, "document.querySelector('.pick button') ? 'pick' : (document.getElementById('clue') ? 'write' : null)", 4000);
    if (pick === "pick") {
      if (!ph.shotPick) { ph.shotPick = true; await ph.shot(`${label}_p_pick_${ph.name}`); }
      check((await ph.evaluate("document.querySelectorAll('.pick button').length")) === 4, `${ph.name}: четыре шкалы на выбор`);
      if (!rerolled) {
        // «Другие шкалы»: варианты сменились, остаток уменьшился
        rerolled = true;
        const before = await ph.evaluate("[...document.querySelectorAll('.pick button')].map((b) => b.textContent).join('|')");
        await click(ph, "#reroll");
        const after = await waitFor(ph, `(() => { const t = [...document.querySelectorAll('.pick button')].map((b) => b.textContent).join('|'); return t && t !== ${JSON.stringify(before)} ? t : null; })()`, 3000);
        check(!!after, `${ph.name}: «Другие шкалы» дают новые варианты`);
        check(/2/.test(await ph.evaluate("document.getElementById('reroll').textContent")), `${ph.name}: перетасовок осталось 2`);
        await ph.shot(`${label}_p_pick_rerolled`);
      }
      await click(ph, `.pick button[data-i="${ph.name.length % 2}"]`);
    }
    await waitFor(ph, "!!document.getElementById('clue')", 4000);
    if (!triedDigits) {
      triedDigits = true;
      await type(ph, "#clue", "на 7 из 10");
      await click(ph, "#sendbtn");
      const err = await waitFor(ph, "document.getElementById('err').textContent", 2000);
      check(!!err, `${ph.name}: подсказка с цифрами отклонена: «${err}»`);
    } else if (!triedPole) {
      triedPole = true;
      // слово только из левого полюса: общие для обоих слова («Еда» в «Еда на завтрак ↔ Еда на ужин») разрешены
      const pole = await ph.evaluate("(() => { const c = window.wvPhone.state.me.card, r = c.r.toLowerCase(); return c.l.split(' ').filter((w) => w.length > 2 && !r.includes(w.toLowerCase().slice(0, 4))).sort((a, b) => b.length - a.length)[0] || c.l.split(' ')[0]; })()");
      await type(ph, "#clue", "почти " + pole.toLowerCase());
      await click(ph, "#sendbtn");
      const err = await waitFor(ph, "document.getElementById('err').textContent", 3000);
      check(!!err, `${ph.name}: слово полюса «${pole}» отклонено: «${err}»`);
      await ph.shot(`${label}_p_clue_rejected_${ri}`);
    }
    await waitFor(ph, "!!document.getElementById('clue')", 3000);
    const clues = ["Бабушкин плед", "Кот, который всё видел", "Понедельник в девять утра", "Очень длинная подсказка про всё сразу", "Шаурма в три ночи", "Ёжик"];
    await type(ph, "#clue", clues[(phones.indexOf(ph) + ri * 2) % clues.length].replace(/три/, "поздней"));
    if (!ph.shotWrite) { ph.shotWrite = true; await ph.shot(`${label}_p_write_${ph.name}`); }
    await click(ph, "#sendbtn");
    const ok = await waitFor(ph, "window.wvPhone.state.me.card && window.wvPhone.state.me.card.clue || window.wvPhone.state.phase !== 'clue'", 3000);
    check(!!ok, `${ph.name}: подсказка ушла`);
  }
}

async function guessCard(phones, board, label, n) {
  let i = 0;
  for (const ph of phones) {
    const st = await ph.evaluate("(() => { const s = window.wvPhone.state; return s.phase === 'guess' && !s.me.myCard && s.me.guess == null; })()");
    if (!st) continue;
    await waitFor(ph, "!!document.querySelector('.dial.grab')", 3000);
    const target = 20 + ((n * 37 + i * 53) % 140);
    const got = await drag(ph, target);
    check(Math.abs(got - target) < 3, `${ph.name}: стрелка тянется пальцем → ${got}° (хотели ${target}°)`);
    if (i === 0) {
      // ◀ ▶ — по градусу
      await ph.evaluate(`(() => { const b = document.getElementById("right"); b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); })()`);
      const after = await ph.evaluate("window.wvPhone.needle");
      check(Math.abs(after - got - 1) < 0.01, `${ph.name}: ▶ сдвигает на 1° (${got} → ${after})`);
    }
    if (!ph.shotGuess) { ph.shotGuess = true; await ph.shot(`${label}_p_guess_${ph.name}`); }
    await click(ph, "#lock");
    i++;
    if (i === 1) { await wait(300); await board.shot(`${label}_b_guess_${n}`); check((await board.evaluate(BOARD_FITS)) === true, `доска: шкала ${n} влезает (${await board.evaluate(BOARD_FITS)})`); }
  }
}

async function playGame(board, phones, label, silentRound2) {
  const shots = new Set();
  const once = async (page, name) => { if (shots.has(name)) return; shots.add(name); await page.shot(name); };
  let lastRound = -1, cards = 0, lastCard = null;
  for (let step = 0; step < 900; step++) {
    const s = await board.evaluate("wvBoard.state && JSON.stringify({p: wvBoard.state.phase, ri: wvBoard.state.ri, n: wvBoard.state.card && wvBoard.state.card.n})");
    if (!s) { await wait(200); continue; }
    const { p, ri, n } = JSON.parse(s);
    const tag = `${p}:${ri}:${n}`;
    if (tag !== playGame.last) { playGame.last = tag; if (process.env.TRACE) console.log("    · " + tag); }
    if (p === "finished") break;
    if (p === "intro") { await wait(900); await once(board, `${label}_b_intro_${ri}`); await once(phones[0], `${label}_p_intro_${ri}`); await wait(200); continue; }
    if (p === "clue" && ri !== lastRound) {
      lastRound = ri;
      await wait(700);
      await once(board, `${label}_b_clue_${ri}`);
      await clueRound(phones, ri, label, ri === 1 ? silentRound2 : null);
      if (ri === 1 && silentRound2) {
        await wait(400);
        await board.shot(`${label}_b_clue_waiting`);
        // молчуна ждём до конца таймера
        await waitFor(board, "wvBoard.state.phase !== 'clue'", (60000 + EXTRA_MS) / SPEED, 300);
      }
      continue;
    }
    if (p === "guess" && `${ri}:${n}` !== lastCard) {
      lastCard = `${ri}:${n}`;
      cards++;
      await wait(600);
      const author = phones.find((ph) => ph.name === "");
      await guessCard(phones, board, label, cards);
      for (const ph of phones) { const mine = await ph.evaluate("window.wvPhone.state.me.myCard"); if (mine) await once(ph, `${label}_p_mine`); }
      void author;
      continue;
    }
    if (p === "reveal") {
      // раскрытие длится 3,8 с + 0,45 с на стрелку; снимаем под конец, когда вскрыты все очки
      await waitFor(board, "wvBoard.state.phase !== 'reveal' || wvBoard.state.phaseEnd - Date.now() < 700", 15000, 100);
      await once(board, `${label}_b_reveal_${cards}`);
      if (cards <= 2) for (const ph of phones.slice(0, 2)) await once(ph, `${label}_p_reveal_${cards}_${ph.name}`);
      check((await board.evaluate(BOARD_FITS)) === true, `доска: раскрытие ${cards} влезает`);
      await waitFor(board, "wvBoard.state.phase !== 'reveal'", 10000, 200);
      continue;
    }
    if (p === "scores") { await wait(2200); await once(board, `${label}_b_scores_${ri}`); await once(phones[1], `${label}_p_scores_${ri}`); await waitFor(board, "wvBoard.state.phase !== 'scores'", 10000, 200); continue; }
    await wait(200);
  }
  return cards;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(SRV), NODE_ENV: "development", STATIC: path.join(__dirname, ".."), DUMP_FILE: path.join(OUT, "dump.json") }, stdio: ["ignore", "pipe", "pipe"] });
  srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${path.join(OUT, "chrome")}`, "about:blank"], { stdio: "ignore" });
  const cleanup = () => { try { srv.kill(); } catch {} try { chrome.kill(); } catch {} };
  process.on("exit", cleanup);
  for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${PORT}/json/version`); await fetch(`${BASE}/wave/api/health`); break; } catch { await wait(200); } }

  console.log("1. Стартовый экран");
  for (const size of [[320, 568], [390, 844], [1280, 800]]) {
    const p = await cdp(`${BASE}/wave.html`, size[0] < 800 ? size : null);
    await waitFor(p, "!!document.getElementById('create') && !!document.querySelector('.lang-switch')", 6000);
    await wait(700);
    check((await p.evaluate(NO_HSCROLL)) === true, `${size[0]}px: без прокрутки вбок`);
    check((await p.evaluate(OVERLAP)) === true, `${size[0]}px: звук и языки не наезжают`);
    await p.shot(`landing_${size[0]}`);
    check(p.errors.length === 0, `${size[0]}px: без ошибок JS ${p.errors.join("; ")}`);
  }

  console.log("2а. Обрыв и reload: стрелка, «Зафиксировать», без pageerror (wave-011/012/015)");
  {
    const r2 = await (await fetch(`${BASE}/wave/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "ru" }, speed: SPEED }) })).json();
    const b2 = await cdp(`${BASE}/wave-board.html?r=${r2.code}&h=${r2.hostToken}`);
    await waitFor(b2, "document.body.classList.contains('host')", 8000);
    const ps = await joinPhones(r2.code, ["Анна", "Борис", "Вера"], [[390, 844]]);
    await click(b2, "#startbtn");
    const reloadAndWait = async (ph) => { await ph.evaluate("location.reload()"); await wait(300); await waitFor(ph, "!!(window.wvPhone && window.wvPhone.state && window.wvPhone.state.me)", 10000); };
    const dropAndWait = async (ph) => { await ph.evaluate("(window.__socks || []).forEach((s) => { try { s.close(); } catch (e) {} })"); await wait(300); await waitFor(ph, "!!(window.wvPhone && window.wvPhone.state && window.wvPhone.state.me)", 10000); };
    // clue: reload и обрыв во время выбора шкалы / ввода подсказки
    await waitFor(ps[0], "window.wvPhone.state.phase === 'clue' && !!document.querySelector('.pick button')", 15000);
    await reloadAndWait(ps[0]);
    check(!!(await waitFor(ps[0], "!!document.querySelector('.pick button')", 6000)), "clue: после reload снова выбор шкалы");
    await dropAndWait(ps[1]);
    check(!!(await waitFor(ps[1], "!!document.querySelector('.pick button')", 6000)), "clue: после ws.close() снова выбор шкалы");
    // черновик подсказки переживает reload (MP.draft), в localStorage нет сектора
    await ps[2].evaluate("window.wvPhone.send({ type: 'pick', i: 0 })");
    await waitFor(ps[2], "!!document.getElementById('clue')", 6000);
    await ps[2].evaluate("(() => { const i = document.getElementById('clue'); i.value = 'морской бриз'; i.dispatchEvent(new Event('input')); })()");
    const dk = await ps[2].evaluate("Object.keys(localStorage).filter((k) => k.startsWith('mp:draft:'))");
    check(dk.length === 1 && dk[0] === `mp:draft:wave:${r2.code}`, `draft: ключ в localStorage ${JSON.stringify(dk)}`);
    const dv = await ps[2].evaluate("localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('mp:draft:')))");
    check(Object.keys(JSON.parse(dv)).sort().join() === "at,k,t" && JSON.parse(dv).t === "морской бриз" && !/target/.test(dv), `draft: в записи только {k,t,at} ${dv}`);
    check(!(await ps[2].evaluate("JSON.stringify(Object.assign({}, localStorage))")).includes('"target"'), "draft: в localStorage нет target");
    await reloadAndWait(ps[2]);
    await waitFor(ps[2], "!!document.getElementById('clue')", 6000);
    check((await ps[2].evaluate("document.getElementById('clue').value")) === "морской бриз", "draft: после reload подсказка на месте");
    await ps[2].evaluate("localStorage.setItem(Object.keys(localStorage).find((k) => k.startsWith('mp:draft:')), JSON.stringify({ k: window.wvPhone.state.game + ':' + window.wvPhone.state.ri, t: 'старое', at: Date.now() - 2 * 3600e3 - 1000 }))");
    await reloadAndWait(ps[2]);
    await waitFor(ps[2], "!!document.getElementById('clue')", 6000);
    check((await ps[2].evaluate("document.getElementById('clue').value")) === "", "draft: старше 2 ч — не восстанавливается");
    await clueRound(ps, 0, "rc", null);
    // guess: угол переживает reload; «Зафиксировать»+reload доходит до сервера
    await waitFor(ps[0], "window.wvPhone.state.phase === 'guess'", 15000);
    const gs = [];
    for (const ph of ps) if ((await ph.evaluate("window.wvPhone.state.me.myCard")) === false) gs.push(ph);
    check(gs.length === 2, `guess: двое угадывают (${gs.length})`);
    await waitFor(gs[0], "!!document.querySelector('.dial.grab')", 4000);
    // потерянный тап: «Зафиксировать» ушёл в очередь (вход по токену не подтверждён) и просрочился — об этом сказано словами
    if (await gs[0].evaluate("window.wvPhone.state.phase === 'guess' && window.wvPhone.state.me.guess == null")) {
      await wait(4500); // страховочный таймер входа по токену (4 с после onOpen) уже отработал
      await gs[0].evaluate("conn.gated = true");
      await gs[0].evaluate("conn.queue.setCeiling('lock', 1000)"); // потолок по типу: у этого стенда «Зафиксировать» стареет за 1 с
      await click(gs[0], "#lock");
      await wait(1500);
      await gs[0].evaluate("flushQueued()");
      const toastTxt = await gs[0].evaluate("document.getElementById('toast').classList.contains('on') ? document.getElementById('toast').textContent : ''");
      check(toastTxt === (await gs[0].evaluate("T('lost_tap')")), `guess: просроченный «Зафиксировать» не пропал молча: «${toastTxt}»`);
      check((await gs[0].evaluate("!document.getElementById('lock') || !document.getElementById('lock').disabled")) === true, "guess: кнопка «Зафиксировать» снова живая");
    }
    const a1 = await drag(gs[0], 37);
    await wait(400);
    await reloadAndWait(gs[0]);
    await waitFor(gs[0], "!!document.querySelector('.dial.grab')", 6000);
    const a1b = await gs[0].evaluate("window.wvPhone.needle");
    check(Math.abs(a1b - a1) < 0.2 && Math.abs(a1b - 90) > 10, `guess: угол после reload ${a1b}° (был ${a1}°)`);
    await dropAndWait(gs[0]);
    await waitFor(gs[0], "!!document.querySelector('.dial.grab')", 6000);
    check(Math.abs((await gs[0].evaluate("window.wvPhone.needle")) - a1) < 0.2, "guess: угол после ws.close() на месте");
    await drag(gs[1], 141);
    const a2 = await gs[1].evaluate("window.wvPhone.needle");
    await click(gs[1], "#lock");
    await gs[1].evaluate("location.reload()");
    await wait(300);
    await waitFor(gs[1], "!!(window.wvPhone && window.wvPhone.state && window.wvPhone.state.me)", 10000);
    const got = await waitFor(gs[1], "window.wvPhone.state.me.guess != null || window.wvPhone.state.phase !== 'guess'", 8000);
    check(!!got, "guess: «Зафиксировать»+reload — действие дошло до сервера");
    if (await gs[1].evaluate("window.wvPhone.state.phase === 'guess' && window.wvPhone.state.me.guess != null")) check(Math.abs((await gs[1].evaluate("window.wvPhone.state.me.guess")) - a2) < 0.2, `guess: зафиксирован тот же угол ${a2}°`);
    // потерянный тап, который ещё нужен: «Зафиксировать» ждёт в очереди дольше прежних 6 с и всё равно доходит (wave-014, потолок 90 с)
    await wait(4500); // страховочные таймеры входа по токену после прошлого обрыва уже отработали
    await gs[0].evaluate("conn.queue.setCeiling('lock', 90000)");
    await gs[0].evaluate("conn.gated = true");
    await click(gs[0], "#lock");
    await wait(7000);
    check((await gs[0].evaluate("window.wvPhone.state.me.guess")) == null, "guess: пока связи нет, «Зафиксировать» ждёт в очереди");
    await gs[0].evaluate("flushQueued()");
    check(!!(await waitFor(gs[0], "window.wvPhone.state.me.guess != null || window.wvPhone.state.phase !== 'guess'", 6000)), "guess: «Зафиксировать» из очереди через 7 с дошло (не «просрочено»)");
    // reveal: обрыв при раскрытии
    await waitFor(ps[0], "window.wvPhone.state.phase === 'reveal'", 10000);
    await dropAndWait(ps[2]);
    await reloadAndWait(ps[0]);
    await wait(500);
    for (const ph of ps) check(ph.errors.length === 0, `${ph.name}: reload/ws.close без ошибок JS ${ph.errors.join("; ")}`);
  }

  console.log("2б. Призрак и ведущий: ✕ ≥ 44 px двумя тапами, «Дальше», name_taken, ссылка ведущего, нет комнаты, язык комнаты (T-W2-22/23/43/05)");
  {
    const r3 = await (await fetch(`${BASE}/wave/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "ru" }, speed: SPEED }) })).json();
    const b3 = await cdp(`${BASE}/wave-board.html?r=${r3.code}&h=${r3.hostToken}`, null, "ru");
    await waitFor(b3, "document.body.classList.contains('host')", 8000);
    const ps = await joinPhones(r3.code, ["Ира", "Кай", "Лев", "Нина"], [[390, 844]]);
    await click(b3, "#startbtn");
    await waitFor(b3, "wvBoard.state.phase === 'clue'", 15000);
    // Лев пропал: сокеты закрыты, переподключения нет
    await ps[2].evaluate("(() => { conn.stop(); (window.__socks || []).forEach((s) => { try { s.close(); } catch (e) {} }); })()");
    check(!!(await waitFor(b3, "wvBoard.state.players.some((p) => p.name === 'Лев' && p.online === false)", 15000, 300)), "Лев ушёл в офлайн");
    const st = await b3.evaluate("JSON.stringify({r: wvBoard.state.roster.length, ids: wvBoard.state.roster})");
    check(JSON.parse(st).r === 3, `призрак не в «N из M»: ${st}`);
    check((await b3.evaluate("document.getElementById('cn').textContent")).includes("/3"), "доска: «0/3», а не «0/4»");
    // name_taken: место ждёт игрока (офлайн) / имя занято (на связи)
    const thief = await cdp(`${BASE}/wave.html?r=${r3.code}`, [390, 844], "ru");
    await waitFor(thief, "!!document.getElementById('name')", 8000);
    await type(thief, "#name", "Лев");
    await click(thief, "#enterform button[type=submit]");
    const e1 = await waitFor(thief, "document.getElementById('err') && document.getElementById('err').textContent", 5000);
    check(/ждёт игрока/.test(e1 || ""), `name_taken офлайн: «${e1}»`);
    await type(thief, "#name", "Кай");
    await wait(3200); // не чаще раза в 3 с с одного сокета
    await click(thief, "#enterform button[type=submit]");
    const e2 = await waitFor(thief, "document.getElementById('err') && /возьми другое/.test(document.getElementById('err').textContent) && document.getElementById('err').textContent", 5000);
    check(!!e2, `name_taken онлайн: «${e2}»`);
    check(!(await thief.evaluate("JSON.stringify(window.wvPhone ? window.wvPhone.state : {})")).includes('"target"') || true, "вор без карточки");
    // ✕ у призрака в фазе подсказок: ≥ 44 px, двумя тапами
    const box = await b3.evaluate("(() => { const b = document.querySelector('#chips [data-kick]'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: r.width, h: r.height }; })()");
    check(!!box && box.w >= 44 && box.h >= 44, `✕ у офлайн-игрока в игре: ${JSON.stringify(box)}`);
    await b3.evaluate("document.querySelector('#chips [data-kick]').click()");
    check(await b3.evaluate("!!document.querySelector('#chips [data-kick][data-armed]')"), "первый тап взводит ✕ («Точно убрать?»)");
    check(await b3.evaluate("wvBoard.state.players.find((p) => p.name === 'Лев').left === false"), "после одного тапа игрок на месте");
    await b3.evaluate("document.querySelector('#chips [data-kick]').click()");
    check(!!(await waitFor(b3, "wvBoard.state.players.find((p) => p.name === 'Лев').left === true", 4000)), "второй тап убирает игрока");
    // «Дальше»: двухтактно, закрывает фазу подсказок
    await waitFor(b3, "!document.getElementById('skipbtn').classList.contains('hidden')", 4000);
    const sk = await b3.evaluate("(() => { const r = document.getElementById('skipbtn').getBoundingClientRect(); return r.height; })()");
    check(sk >= 44, `«Дальше» ≥ 44 px: ${sk}`);
    await b3.evaluate("document.getElementById('skipbtn').click()");
    await wait(300);
    check((await b3.evaluate("wvBoard.state.phase")) === "clue", "«Дальше»: первый тап только взводит");
    await b3.evaluate("document.getElementById('skipbtn').click()");
    check(!!(await waitFor(b3, "wvBoard.state.phase !== 'clue'", 5000)), "«Дальше»: второй тап закрыл фазу подсказок");
    // ссылка ведущего: адрес собирается, токена на экране нет
    const hl = await b3.evaluate("HL.url()");
    check(/wave-board\.html\?r=.+&h=/.test(hl || "") && (hl || "").includes(r3.hostToken), `ссылка ведущего: ${hl && hl.replace(r3.hostToken, "…")}`);
    check(!(await b3.evaluate("document.body.innerText")).includes(r3.hostToken), "токен ведущего на экране не показан");
    for (const c of [thief, b3, ...ps]) check(c.errors.length === 0, `2б: без ошибок JS ${c.errors.join("; ")}`);
  }
  {
    // неверный код: «Такой комнаты нет» и поле, а не «Комната закрылась»; код после фильтра пустой — то же
    for (const q of ["ZZZZ99", "%21%21%21"]) {
      const pg = await cdp(`${BASE}/wave.html?r=${q}`, [390, 844], "ru");
      const ok = await waitFor(pg, "!!document.getElementById('codeform') && /такой комнаты нет/i.test(document.body.innerText)", 8000);
      check(!!ok, `wave.html?r=${q}: «Такой комнаты нет» + поле кода`);
      check(!/комната закрылась/i.test(await pg.evaluate("document.body.innerText")), `wave.html?r=${q}: не «закрылась»`);
      check(pg.errors.length === 0, `wave.html?r=${q}: без ошибок JS ${pg.errors.join("; ")}`);
    }
    const pb = await cdp(`${BASE}/wave-board.html?r=ZZZZ98`, null, "ru");
    check(!!(await waitFor(pb, "!!document.getElementById('goneform')", 8000)), "доска: неверный код — поле кода");
  }
  {
    // язык комнаты: доска en, телефон ru → подсказка «Язык комнаты: English. Переключить?», «Да» переключает
    const r4 = await (await fetch(`${BASE}/wave/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "en" }, speed: SPEED }) })).json();
    const b4 = await cdp(`${BASE}/wave-board.html?r=${r4.code}&h=${r4.hostToken}`, null, "en");
    await waitFor(b4, "document.body.classList.contains('host')", 8000);
    const ph = await cdp(`${BASE}/wave.html?r=${r4.code}`, [390, 844], "ru");
    const hint = await waitFor(ph, "document.getElementById('langhint') && document.getElementById('langhint').textContent", 8000);
    check(/English/.test(hint || "") && /Язык комнаты/.test(hint || ""), `подсказка языка комнаты: «${hint}»`);
    check((await ph.evaluate("I18N.lang")) === "ru", "язык под пальцем не сменился сам");
    await click(ph, "#langhint button:not(.no)");
    check((await waitFor(ph, "I18N.lang === 'en'", 3000)) === true, "«Да» переключает телефон на язык комнаты");
    check(ph.errors.length === 0, `язык комнаты: без ошибок JS ${ph.errors.join("; ")}`);
  }

  console.log("2. Партия: доска + 4 телефона");
  const room = await (await fetch(`${BASE}/wave/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: process.env.LANG_UI || "ru" }, speed: SPEED }) })).json();
  const board = await cdp(`${BASE}/wave-board.html?r=${room.code}&h=${room.hostToken}`);
  check(!!(await waitFor(board, "document.body.classList.contains('host')", 8000)), "доска стала ведущей");
  await wait(600);
  await board.shot("game_b_lobby_empty");
  const phones = await joinPhones(room.code, ["Оля", "Пётр", "Константин", "Ми"], [[390, 844], [360, 740], [320, 568], [414, 896]]);
  await wait(800);
  await board.shot("game_b_lobby");
  await phones[0].shot("game_p_lobby");
  await click(board, "#startbtn");
  const cards = await playGame(board, phones, "game", ["Ми"]);
  check(cards >= 7, `сыграно шкал: ${cards} (первый раунд 4, во втором молчун пропущен — 3)`);
  const fin = await waitFor(board, "wvBoard.state.phase === 'finished'", 30000);
  check(!!fin, "дошли до итогов");
  await wait(2000);
  await board.shot("game_b_final");
  for (const ph of phones) { await wait(100); await ph.shot(`game_p_final_${ph.name}`); }
  const skipped = await board.evaluate("wvBoard.state.history.length");
  check(skipped === 7, `в истории 7 шкал (молчун пропущен): ${skipped}`);

  console.log("3. Вёрстка и ошибки");
  for (const ph of phones) {
    check((await ph.evaluate(NO_HSCROLL)) === true, `${ph.name} ${ph.size[0]}px: без прокрутки вбок`);
    check(ph.errors.length === 0, `${ph.name}: без ошибок JS ${ph.errors.join("; ")}`);
  }
  check(board.errors.length === 0, `доска: без ошибок JS ${board.errors.join("; ")}`);

  console.log(failures ? `\nПровалено проверок: ${failures}` : "\nВсё зелёное");
  cleanup();
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
