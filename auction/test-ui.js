"use strict";

/*
 * UI-тест: открывает экраны доски и пульта в headless Chrome через DevTools-протокол, ждёт РЕАЛЬНОЕ время
 * (без virtual-time, чтобы таймеры были честными), собирает исключения и console.error, снимает скриншоты.
 *   node test-ui.js [http://localhost:3000] [папка для скриншотов]
 * Нужен запущенный dev-сервер (npm run dev) и Google Chrome.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const OUT = process.argv[3] || path.join(__dirname, "state", "ui");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9400 + Math.floor(Math.random() * 100);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, name) => { console.log((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) failures++; };

async function cdp(url) {
  const targets = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(targets.webSocketDebuggerUrl);
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
  await call("Network.enable");
  const block = (urls) => call("Network.setBlockedURLs", { urls });
  const evaluate = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
  const shot = async (name) => { const r = await call("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64")); };
  const close = () => fetch(`http://localhost:${PORT}/json/close/${targets.id}`);
  return { call, evaluate, shot, errors, close, block };
}

// Печатаем НАСТОЯЩИМИ нажатиями, а не Input.insertText: insertText не шлёт keydown и потому
// проходил мимо бага, из-за которого обработчик клавиш отменял вставку символов и имя
// вообще нельзя было ввести. Живой игрок печатает именно клавишами.
async function typeText(page, text) {
  for (const ch of text) {
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", `--remote-debugging-port=${PORT}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  await wait(2500);
  try {
    const room = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "film" }) })).json();
    console.log("room", room.code);

    // --- стартовый экран пульта
    const start = await cdp(`${BASE}/auction.html`);
    await wait(3000);
    check((await evaluateSafe(start, "document.body.innerText.length")) > 100, "стартовый экран отрисован");
    await start.shot("ui_start");
    check(start.errors.length === 0, "стартовый экран без JS-ошибок" + (start.errors.length ? ": " + start.errors[0] : ""));
    await start.close();

    // --- доска: лобби
    const board = await cdp(`${BASE}/auction-board.html?r=${room.code}&t=${room.hostToken}`);
    await wait(3000);
    check(await evaluateSafe(board, "!!document.getElementById('start')"), "лобби доски: кнопка «Начать» есть");
    await board.shot("ui_board_lobby");

    // --- пульт: вход и лобби
    const remote = await cdp(`${BASE}/auction.html?r=${room.code}`);
    await remote.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
    await wait(2000);
    check(await evaluateSafe(remote, "!!document.getElementById('name')"), "пульт: поле имени есть");
    // печатаем имя как на телефоне
    await remote.call("Runtime.evaluate", { expression: "document.getElementById('name').focus()" });
    await typeText(remote, "Макс");
    check((await evaluateSafe(remote, "document.getElementById('name').value")) === "Макс", "пульт: имя вводится");
    await remote.call("Runtime.evaluate", { expression: "document.getElementById('go').click()" });
    await wait(2500);
    check(/K|комнате|Ждём/i.test(await evaluateSafe(remote, "document.body.innerText")), "пульт: попал в лобби после входа");
    await remote.shot("ui_remote_lobby");
    await wait(500);
    check(await evaluateSafe(board, "document.body.innerText.includes('Макс')"), "доска: игрок появился в лобби");

    // --- задание партии: клик по плитке должен дойти до сервера и до пульта
    await board.call("Runtime.evaluate", { expression: `[...document.querySelectorAll("#mode .tile")].find(x => x.dataset.v === "worst").click()` });
    await wait(1200);
    check((await evaluateSafe(board, "state && state.settings.mode")) === "worst", "доска: выбранное задание дошло до сервера");
    check(/нелеп|несочетаем/i.test(await evaluateSafe(board, "document.getElementById('modehint').textContent") || ""), "доска: подсказка объясняет, как судит ИИ");
    check(/Худший набор/.test(await evaluateSafe(remote, "document.body.innerText") || ""), "пульт: задание видно в лобби");
    // задание, которого нет в новой категории, откатывается на обычное
    // «Лига суперзлодеев» есть у персонажей, но не у городов — переключаемся туда, где она доступна
    await board.call("Runtime.evaluate", { expression: `[...document.querySelectorAll("#kind .tile")].find(x => x.dataset.v === "character").click()` });
    await wait(900);
    const villainsClick = await evaluateSafe(board, `(() => { const b = [...document.querySelectorAll("#mode .tile")].find(x => x.dataset.v === "villains"); if (!b) return "нет плитки: " + [...document.querySelectorAll("#mode .tile")].map(x => x.dataset.v).join(","); b.click(); return "ok"; })()`);
    await wait(900);
    check(villainsClick === "ok" && (await evaluateSafe(board, "state && state.settings.mode")) === "villains", "доска: задание переключается повторно (" + villainsClick + ")");
    await board.call("Runtime.evaluate", { expression: `[...document.querySelectorAll("#kind .tile")].find(x => x.dataset.v === "city").click()` });
    await wait(1200);
    const afterKind = await evaluateSafe(board, "(state && state.settings.mode) + '/' + (state && state.kind)");
    check(afterKind === "base/city", "доска: недоступное задание сброшено при смене категории (" + afterKind + ")");
    await board.call("Runtime.evaluate", { expression: `[...document.querySelectorAll("#kind .tile")].find(x => x.dataset.v === "film").click()` });
    await wait(900);
    await board.call("Runtime.evaluate", { expression: `[...document.querySelectorAll("#mode .tile")].find(x => x.dataset.v === "worst").click()` });
    await wait(900);

    // --- боты и старт
    await board.call("Runtime.evaluate", { expression: "sendMsg({type:'bots', n:3}); setTimeout(() => sendMsg({type:'start'}), 500)" });
    await wait(2500);
    // заставка: задание во весь экран, затем отсчёт 3-2-1 — и только потом торги
    await board.call("Page.bringToFront"); // отсчёт крутится на requestAnimationFrame
    const introPhase = await evaluateSafe(board, "state && state.phase");
    check(introPhase === "intro", "доска: партия открывается заставкой (" + introPhase + ")");
    const introText = await evaluateSafe(board, "(document.getElementById('intro') || {}).textContent || ''");
    check(/Худший набор/.test(introText), "доска: на заставке крупно показано задание");
    check(/ChatGPT|голосован/i.test(introText), "доска: на заставке сказано, кто выберет победителя");
    check(!(await evaluateSafe(board, "!!(state && state.lot)")), "доска: во время заставки лот не раскрыт");
    const rIntro = await evaluateSafe(remote, "document.body.innerText");
    check(/большой экран/i.test(rIntro || ""), "пульт: на заставке отправляет смотреть на экран");
    // отсчёт появляется в последние 3 секунды
    let count = "";
    for (let i = 0; i < 30 && !/^[123]$/.test(count); i++) { count = (await evaluateSafe(board, "(document.getElementById('count') || {}).textContent || ''")).trim(); await wait(200); }
    check(/^[123]$/.test(count), "доска: идёт отсчёт три-два-один (" + count + ")");
    // Читаемость отсчёта проверяем замерами во времени, а не скриншотом: один кадр её не ловит.
    // Так был пропущен дефект, когда кадр анимации гасил цифру до 15% к концу каждой секунды.
    const seen = [];
    for (let i = 0; i < 22; i++) {
      const s = await evaluateSafe(board, `(() => { const n = document.querySelector("#count .num"); if (!n) return null;
        return n.textContent + ":" + Math.round(Number(getComputedStyle(n).opacity) * 100); })()`);
      if (s) seen.push(s);
      await wait(100);
    }
    const digits = new Set(seen.map((s) => s.split(":")[0]));
    const faint = seen.filter((s) => Number(s.split(":")[1]) < 55).length;
    check(digits.size >= 2, "доска: в отсчёте сменяется несколько цифр (" + [...digits].join(",") + ")");
    check(seen.length > 0 && faint <= seen.length * 0.4, `доска: цифра отсчёта не тусклая большую часть секунды (тусклых ${faint} из ${seen.length})`);

    await wait(6000);
    const phase = await evaluateSafe(board, "state && state.phase");
    check(["lot", "bidding", "sold", "unsold", "pickup", "taken"].includes(phase), "доска: игра идёт (" + phase + ")");
    await board.call("Page.bringToFront"); // в фоновой вкладке headless не крутит requestAnimationFrame
    let tnum = "";
    for (let i = 0; i < 20 && !/^\d+$/.test(tnum); i++) { tnum = await evaluateSafe(board, "document.getElementById('tnum') && document.getElementById('tnum').textContent"); await wait(300); }
    check(/^\d+$/.test(tnum || ""), "доска: таймер показывает секунды (" + tnum + ")");
    await board.shot("ui_board_game");
    await wait(1500);
    const rtext = await evaluateSafe(remote, "document.body.innerText");
    check(/Перебить|лидер|Ждём|Не хватает|Следующий|Забрать|На мели/i.test(rtext), "пульт: игровой экран");
    const rnum = await evaluateSafe(remote, "document.getElementById('tnum') && document.getElementById('tnum').textContent");
    check(/^\d*$/.test(rnum || ""), "пульт: таймер-кольцо есть (" + rnum + ")");
    await remote.shot("ui_remote_game");
    check(/Худший набор/.test(await evaluateSafe(board, "document.getElementById('gtask') && document.getElementById('gtask').textContent") || ""), "доска: задание видно во время торгов");
    check(/Худший набор/.test(await evaluateSafe(remote, "document.getElementById('task') && document.getElementById('task').textContent") || ""), "пульт: задание видно во время торгов");
    // ставка с пульта
    await remote.call("Runtime.evaluate", { expression: "(document.getElementById('bid') || {click(){}}).click()" });
    await wait(1200);
    const leader = await evaluateSafe(board, "state && state.leaderId && state.players.find(p=>p.id===state.leaderId).name");
    console.log("    лидер после клика на пульте:", leader);

    // --- завершение и финал
    await board.call("Runtime.evaluate", { expression: "sendMsg({type:'end'})" });
    await wait(4000);
    const fin = await evaluateSafe(board, "state && state.phase");
    check(fin === "finished", "доска: завершение игры хостом");
    await wait(20000); // судья или голосование
    await board.shot("ui_board_final");
    await remote.shot("ui_remote_final");
    const ftext = await evaluateSafe(board, "document.body.innerText");
    check(/Итоги|Голосование|Судья/i.test(ftext), "доска: экран финала");
    // на итогах задание подписано — иначе вердикты «за нелепость» выглядят как ошибка судьи
    const finTask = await evaluateSafe(board, "(document.querySelector('.final .ftask') || {}).textContent || ''");
    check(!/Итоги/.test(ftext) || /Худший набор/.test(finTask), "доска: задание подписано на итогах (" + finTask.slice(0, 60) + ")");

    // --- экран голосования: без подписи задания игроки голосуют за лучший набор вместо худшего.
    // Состояние подставляем прямо в клиент: ветка voting иначе воспроизводится только через
    // отказ судьи, а проверить надо именно рендер.
    const boardVote = await evaluateSafe(board, `(() => {
      state.phase = "finished"; state.results = null; state.votes = 0; state.voting = { deadline: Date.now() + 30000 };
      render();
      return document.body.innerText;
    })()`);
    check(/Худший набор/.test(boardVote || ""), "доска: задание подписано на экране голосования");
    const remoteVote = await evaluateSafe(remote, `(() => {
      state.phase = "finished"; state.results = null; state.votes = 0; state.voting = { deadline: Date.now() + 30000 };
      render();
      return document.body.innerText;
    })()`);
    check(/Худший набор/.test(remoteVote || ""), "пульт: задание подписано на экране голосования");

    check(board.errors.length === 0, "доска без JS-ошибок" + (board.errors.length ? ": " + board.errors.slice(0, 2).join(" | ") : ""));
    check(remote.errors.length === 0, "пульт без JS-ошибок" + (remote.errors.length ? ": " + remote.errors.slice(0, 2).join(" | ") : ""));
    await board.close(); await remote.close();

    // --- сеть без Википедии и iTunes: партия обязана идти, карточка — рисоваться
    const room2 = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "artist" }) })).json();
    const offline = await cdp(`${BASE}/auction-board.html?r=${room2.code}&t=${room2.hostToken}`);
    // заодно проверяем лобби без cdnjs: без библиотеки QR кнопка «Начать» раньше оставалась без обработчика
    await offline.block(["*wikipedia.org*", "*itunes.apple.com*", "*wikimedia.org*", "*cdnjs.cloudflare.com*"]);
    await offline.call("Page.reload");
    await wait(3500);
    check(await evaluateSafe(offline, "!!(document.getElementById('start') && document.getElementById('start').onclick)"), "лобби без cdnjs: кнопка «Начать игру» жива");
    check(await evaluateSafe(offline, "!!document.querySelector('.join .code')"), "лобби без cdnjs: код комнаты на экране");
    await offline.call("Runtime.evaluate", { expression: "sendMsg({type:'bots', n:3}); setTimeout(() => sendMsg({type:'start'}), 500)" });
    await offline.call("Page.bringToFront");
    await wait(9000);
    const offPhase = await evaluateSafe(offline, "state && state.phase");
    check(["lot", "bidding", "sold", "unsold", "pickup", "taken"].includes(offPhase), "без Википедии и iTunes партия идёт (" + offPhase + ")");
    check((await evaluateSafe(offline, "(document.querySelector('#card .name') || {}).textContent || ''")).length > 0, "карточка лота рисуется без фото");
    check((await evaluateSafe(offline, "(document.getElementById('tnum') || {}).textContent || ''")).length > 0, "таймер идёт без внешних сервисов");
    await offline.shot("ui_board_no_media");
    const netErrors = offline.errors.filter((e) => !/ERR_BLOCKED_BY_CLIENT|Failed to fetch|iTunes/i.test(e));
    check(netErrors.length === 0, "заблокированные картинки/музыка не дают JS-ошибок" + (netErrors.length ? ": " + netErrors[0] : ""));
    await offline.call("Runtime.evaluate", { expression: "sendMsg({type:'end'})" });
    await offline.close();

    // --- пульт без auction-modes.js: задание неизвестно, и врать про него нельзя.
    // Раньше фолбэк подставлял «🏆 Лучший набор» — игрок собирал бы обратное тому, что судят.
    const room3 = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "artist", settings: { mode: "worst" } }) })).json();
    const noModes = await cdp(`${BASE}/auction.html?r=${room3.code}`);
    await noModes.block(["*auction-modes.js*"]);
    await noModes.call("Page.reload");
    await wait(3000);
    await noModes.call("Runtime.evaluate", { expression: "document.getElementById('name').focus()" });
    await typeText(noModes, "Без заданий");
    await noModes.call("Runtime.evaluate", { expression: "document.getElementById('go').click()" });
    await wait(2500);
    const noModesText = await evaluateSafe(noModes, "document.body.innerText") || "";
    check(/комнате|Ждём/i.test(noModesText), "пульт без auction-modes.js: вход в лобби работает");
    check(!/Лучший набор|Худший набор/.test(noModesText), "пульт без auction-modes.js: не выдумывает задание (" + noModesText.replace(/\n/g, " ").slice(0, 70) + ")");
    check(noModes.errors.filter((e) => !/ERR_BLOCKED_BY_CLIENT/.test(e)).length === 0, "пульт без auction-modes.js: без JS-ошибок" + (noModes.errors.length ? ": " + noModes.errors[0] : ""));
    await noModes.close();
  } finally {
    chrome.kill();
  }
  console.log(failures ? `UI FAILURES: ${failures}` : "UI TESTS OK", "→", OUT);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });

async function evaluateSafe(page, expr) { try { return await page.evaluate(expr); } catch { return null; } }
