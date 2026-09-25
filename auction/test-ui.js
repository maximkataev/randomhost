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
const { modeText } = require("./modes");
// комната в тесте — категория film, у неё своё название задания («Худший киномарафон»)
const WORST = modeText("worst", "film").title;
const reOf = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const WORST_RE = reOf(WORST);
const BASE_RE = reOf(modeText("base", "film").title);
// Название и критерий задания тоже берём у страницы: auction-modes.js переводит их сам,
// а на каком языке сейчас экран — знает его же i18n (см. i18nFrag ниже для словарных ключей).
const modeTitle = (page, id, kind) => evaluateSafe(page,
  `(window.auctionModeText && window.I18N) ? (auctionModeText(${JSON.stringify(id)}, ${JSON.stringify(kind)}, I18N.lang).title || "") : ""`);
const modeJudge = (page, id, kind) => evaluateSafe(page,
  `(window.auctionModeText && window.I18N) ? (auctionModeText(${JSON.stringify(id)}, ${JSON.stringify(kind)}, I18N.lang).judge || "") : ""`);

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
  // свой профиль на прогон: не трогаем профиль пользователя и не наследуем localStorage прошлых прогонов
  const profile = fs.mkdtempSync(path.join(require("os").tmpdir(), "auction-ui-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
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

    // --- забытая вкладка на закрытой комнате: внятный экран, а не вечное «переподключаемся…»
    const gone = await cdp(`${BASE}/auction.html?r=ZZZZ&name=Тест`);
    await wait(5000);
    check(await evaluateSafe(gone, "!!document.querySelector('.expired')"), "закрытая комната: показан экран «комнаты нет», а не бесконечное переподключение");
    await gone.shot("ui_room_gone");
    await gone.close();

    // --- доска: лобби
    const board = await cdp(`${BASE}/auction-board.html?r=${room.code}&t=${room.hostToken}`);
    await wait(3000);
    check(await evaluateSafe(board, "!!document.getElementById('start')"), "лобби доски: кнопка «Начать» есть");
    await board.shot("ui_board_lobby");
    // Предупреждение о маленькой колоде (§5). Порог — игроки × слоты × 1.25 + 6 × слоты (запас на
    // соло-добор), и у настоящих категорий он не срабатывает: подменяем размер колоды в состоянии.
    check(!(await evaluateSafe(board, `!!document.querySelector(".rounds .warn")`)), "лобби: на полной колоде предупреждения нет");
    const deckWarn = await evaluateSafe(board, `(() => {
      const was = state.deckSize; state.deckSize = 5; render();
      const t = (document.querySelector(".rounds .warn") || {}).textContent || "";
      state.deckSize = was; render(); return t;
    })()`);
    check(hasFrag(deckWarn, await i18nFrag(board, "deck_warn")), `лобби: маленькая колода — предупреждение (${String(deckWarn).slice(0, 40)})`);

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
    check(hasFrag(await evaluateSafe(remote, "document.body.innerText"), await i18nFrag(remote, "lobby_sub")), "пульт: попал в лобби после входа");
    await remote.shot("ui_remote_lobby");
    await wait(500);
    check(await evaluateSafe(board, "document.body.innerText.includes('Макс')"), "доска: игрок появился в лобби");

    // --- перезагрузка пульта: вход по токену обязан вернуть того же игрока. Раньше join() на
    // верхнем уровне скрипта падал на TDZ (let lastName ниже) — пустой экран и авто-пауза партии.
    const meBefore = await evaluateSafe(remote, "me");
    await remote.call("Page.reload");
    await wait(3000);
    check(hasFrag(await evaluateSafe(remote, "document.body.innerText"), await i18nFrag(remote, "lobby_sub")), "пульт: после перезагрузки снова в лобби (вход по токену)");
    check((await evaluateSafe(remote, "me")) === meBefore, "пульт: после перезагрузки — тот же игрок");
    check(remote.errors.length === 0, "пульт: перезагрузка без JS-ошибок" + (remote.errors.length ? ": " + remote.errors[0] : ""));
    check((await evaluateSafe(board, "state.players.filter(p => p.name.startsWith('Макс')).length")) === 1, "доска: после перезагрузки пульта игрок один, без «Макс 2»");

    // --- задание партии: клик по плитке должен дойти до сервера и до пульта
    await board.call("Runtime.evaluate", { expression: `[...document.querySelectorAll("#mode .tile")].find(x => x.dataset.v === "worst").click()` });
    await wait(1200);
    check((await evaluateSafe(board, "state && state.settings.mode")) === "worst", "доска: выбранное задание дошло до сервера");
    // подсказка обязана пересказывать именно «что сделает судья» — сверяем с текстом задания на языке доски
    const hintJudge = await modeJudge(board, "worst", "film");
    const hintText = await evaluateSafe(board, "document.getElementById('modehint').textContent") || "";
    check(!!hintJudge && hintText.includes(hintJudge), "доска: подсказка объясняет, как судит ИИ");
    // задание на языке доски: её экраны сверяем с ним, а не с русской строкой из modes.js
    const boardWorst = (await modeTitle(board, "worst", "film")) || WORST;
    check(WORST_RE.test(await evaluateSafe(remote, "document.body.innerText") || ""), "пульт: задание видно в лобби");
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
    check(hasFrag(introText, boardWorst), "доска: на заставке крупно показано задание");
    check(/ChatGPT|голосован/i.test(introText), "доска: на заставке сказано, кто выберет победителя");
    check(!(await evaluateSafe(board, "!!(state && state.lot)")), "доска: во время заставки лот не раскрыт");
    const rIntro = await evaluateSafe(remote, "document.body.innerText");
    check(hasFrag(rIntro, await i18nFrag(remote, "intro_watch")), "пульт: на заставке отправляет смотреть на экран");
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
    const rtext = await evaluateSafe(remote, "document.body.innerText") || "";
    // на игровом экране в любой момент видно что-то одно из этого набора
    const actionKeys = ["bid_btn", "bid_first_btn", "lead_me_title", "next_lot", "take_free", "broke_title", "not_enough_title", "done_title"];
    const actions = [];
    for (const k of actionKeys) actions.push(await i18nFrag(remote, k));
    check(actions.some((f) => hasFrag(rtext, f)), "пульт: игровой экран");
    const rnum = await evaluateSafe(remote, "document.getElementById('tnum') && document.getElementById('tnum').textContent");
    check(/^\d*$/.test(rnum || ""), "пульт: таймер-кольцо есть (" + rnum + ")");
    await remote.shot("ui_remote_game");
    check(hasFrag(await evaluateSafe(board, "document.getElementById('gtask') && document.getElementById('gtask').textContent") || "", boardWorst), "доска: задание видно во время торгов");
    check(WORST_RE.test(await evaluateSafe(remote, "document.getElementById('task') && document.getElementById('task').textContent") || ""), "пульт: задание видно во время торгов");
    // «Своя сумма» переживает чужие state: поле, набранное и фокус остаются (раньше закрывалось)
    const ownbid = await evaluateSafe(remote, `(() => {
      state.phase = "lot"; state.leaderId = null; state.price = 0; render();
      // поле на экране сразу, без ссылки «Своя сумма»: лишнее нажатие, пока тикает лот
      if (document.querySelector("#ownwrap .linkbtn")) return "поле спрятано за ссылкой";
      const i = document.getElementById("ownbid"); if (!i) return "нет поля";
      i.value = "7"; i.focus();
      render(); render();
      const j = document.getElementById("ownbid");
      return j === i && j.value === "7" && document.activeElement === j ? "ok" : "поле пересоздано";
    })()`);
    check(ownbid === "ok", "пульт: «Своя сумма» не закрывается на новом state (" + ownbid + ")");
    const frac = await evaluateSafe(remote, `(() => { const i = document.getElementById("ownbid"); if (!i) return ""; i.value = "7.5"; document.querySelector("#ownwrap .go").click(); return document.querySelector("#ownwrap .note").textContent; })()`);
    check(hasFrag(frac || "", await i18nFrag(remote, "own_bid_int")), "пульт: дробная сумма не округляется молча (" + frac + ")");
    // ставка с пульта
    await remote.call("Runtime.evaluate", { expression: "(document.getElementById('bid') || {click(){}}).click()" });
    await wait(1200);
    const leader = await evaluateSafe(board, "state && state.leaderId && state.players.find(p=>p.id===state.leaderId).name");
    console.log("    лидер после клика на пульте:", leader);

    // Пауза и возобновление НАСТОЯЩИМ кликом мыши, а не .click(): оверлей паузы перекрывал
    // кнопку «Продолжить», и партию нельзя было возобновить. Программный click() это не ловит —
    // он бьёт прямо в элемент, минуя то, что лежит сверху.
    const clickReal = async (page, sel) => {
      const box = await evaluateSafe(page, `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null;
        const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!box) return "нет кнопки";
      const hit = await evaluateSafe(page, `(() => { const el = document.elementFromPoint(${box.x}, ${box.y}); return el ? (el.id || el.tagName) : "ничего"; })()`);
      await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return hit;
    };
    await clickReal(board, "#pause");
    await wait(800);
    check(await evaluateSafe(board, "!!(state && state.paused)"), "доска: пауза ставится кликом");
    const onTop = await clickReal(board, "#pause");
    await wait(900);
    check(onTop === "pause", `доска: кнопку «Продолжить» ничем не перекрыло (сверху: ${onTop})`);
    check(!(await evaluateSafe(board, "!!(state && state.paused)")), "доска: пауза снимается кликом по «Продолжить»");


    // --- завершение и финал
    await board.call("Runtime.evaluate", { expression: "sendMsg({type:'end'})" });
    await wait(4000);
    const fin = await evaluateSafe(board, "state && state.phase");
    check(fin === "finished", "доска: завершение игры хостом");

    await wait(20000); // судья или голосование
    await board.shot("ui_board_final");
    await remote.shot("ui_remote_final");
    const ftext = await evaluateSafe(board, "document.body.innerText");
    const finTitles = [];
    for (const k of ["results_title", "vote_title", "judging"]) finTitles.push(await i18nFrag(board, k));
    check(finTitles.some((f) => hasFrag(ftext, f)), "доска: экран финала");
    // на итогах задание подписано — иначе вердикты «за нелепость» выглядят как ошибка судьи
    const finTask = await evaluateSafe(board, "(document.querySelector('.final .ftask') || {}).textContent || ''");
    check(!hasFrag(ftext, finTitles[0]) || hasFrag(finTask, boardWorst), "доска: задание подписано на итогах (" + finTask.slice(0, 60) + ")");

    // --- экран голосования: без подписи задания игроки голосуют за лучший набор вместо худшего.
    // Состояние подставляем прямо в клиент: ветка voting иначе воспроизводится только через
    // отказ судьи, а проверить надо именно рендер.
    const boardVote = await evaluateSafe(board, `(() => {
      state.phase = "finished"; state.results = null; state.votes = 0; state.voting = { deadline: Date.now() + 30000 };
      render();
      return document.body.innerText;
    })()`);
    check(hasFrag(boardVote || "", boardWorst), "доска: задание подписано на экране голосования");
    const remoteVote = await evaluateSafe(remote, `(() => {
      state.phase = "finished"; state.results = null; state.votes = 0; state.voting = { deadline: Date.now() + 30000 };
      render();
      return document.body.innerText;
    })()`);
    check(WORST_RE.test(remoteVote || ""), "пульт: задание подписано на экране голосования");
    // «Ещё раз» и «Другая категория» раньше слали одно и то же, и вторая кнопка просто врала.
    // Комната своя: кнопки живут только на экране итогов, а в общем прогоне доска к этому моменту
    // стоит на голосовании. Судья — голосование, чтобы итоги пришли без похода в OpenAI.
    {
      const r = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "film", settings: { intro: 0, judge: "vote", t1: 5000, t2: 3000 } }) })).json();
      const b2 = await cdp(`${BASE}/auction-board.html?r=${r.code}&t=${r.hostToken}`);
      await wait(2500);
      await b2.call("Runtime.evaluate", { expression: "sendMsg({type:'bots', n:2}); setTimeout(() => sendMsg({type:'start'}), 400)" });
      await wait(3000);
      await b2.call("Runtime.evaluate", { expression: "sendMsg({type:'end'})" });
      let hasBtn = false;
      for (let i = 0; i < 60 && !hasBtn; i++) { hasBtn = await evaluateSafe(b2, `!!document.getElementById("another")`); await wait(500); }
      check(hasBtn, "доска: на итогах есть кнопки следующей игры");
      const kindBefore = await evaluateSafe(b2, "state && state.kind");
      await b2.call("Runtime.evaluate", { expression: `document.getElementById("another").click()` });
      await wait(1500);
      const kindAfter = await evaluateSafe(b2, "state && state.kind");
      check((await evaluateSafe(b2, "state && state.phase")) === "lobby", "доска: «Другая категория» открывает лобби");
      check(kindAfter && kindAfter !== kindBefore, `доска: «Другая категория» действительно меняет категорию (${kindBefore} → ${kindAfter})`);
      await b2.close();
    }



    check(board.errors.length === 0, "доска без JS-ошибок" + (board.errors.length ? ": " + board.errors.slice(0, 2).join(" | ") : ""));
    check(remote.errors.length === 0, "пульт без JS-ошибок" + (remote.errors.length ? ": " + remote.errors.slice(0, 2).join(" | ") : ""));
    await board.close(); await remote.close();

    // --- соло-добор: свободные слоты остались у одного (§6.5).
    // Экраны добора нигде больше не появляются, а живьём до них доходят в конце каждой партии.
    {
      const rd = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal", settings: { intro: 0, slots: 3, t1: 4000, t2: 3000 } }) })).json();
      // ведущий и второй игрок — обычными сокетами: смотрим мы на экраны первого
      const sock = (first) => new Promise((res) => {
        const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/auction/ws?r=" + rd.code);
        const c = { ws, state: null, me: null };
        ws.on("open", () => ws.send(JSON.stringify(first)));
        ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.state) c.state = m.state; if (m.type === "joined") { c.me = m.playerId; res(c); } if (m.type === "host_ok") res(c); });
      });
      // ведущий — сама доска: вторая доска на том же токене отбирает права у первой
      const dboard = await cdp(`${BASE}/auction-board.html?r=${rd.code}&t=${rd.hostToken}`);
      const dremote = await cdp(`${BASE}/auction.html?r=${rd.code}`);
      await dremote.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
      await wait(2500);
      await dremote.call("Runtime.evaluate", { expression: "document.getElementById('name').focus()" });
      await typeText(dremote, "Аня");
      await dremote.call("Runtime.evaluate", { expression: "document.getElementById('go').click()" });
      await wait(1500);
      const guest = await sock({ type: "join", name: "Гость" });
      await wait(600);
      await dboard.call("Runtime.evaluate", { expression: "sendMsg({type:'start'})" });
      await wait(1200);
      // Остался один со свободными слотами. Выпал один из двух — авто-пауза; ведущий решает
      // продолжить без него, и следующий лот уже соло-добор.
      guest.ws.close();
      check(await untilPage(dremote, "state && state.paused", 30000), "выпал один из двух — пульт на авто-паузе");
      await dboard.call("Runtime.evaluate", { expression: "sendMsg({type:'resume'})" });
      const draft = await untilPage(dremote, "state && state.phase === 'draft'", 40000);
      check(draft, `соло-добор: пульт дождался фазы ДОБОР (${await evaluateSafe(dremote, "state && state.phase + '/' + state.players.length + '/' + state.paused")})`);
      await wait(400);
      const boardText = await evaluateSafe(dboard, "document.body.innerText") || "";
      check(hasFrag(boardText, await i18nFrag(dboard, "ph_draft")), "доска: в верхней полосе ДОБОР");
      check(hasFrag(await evaluateSafe(dboard, "(document.getElementById('draftline')||{}).textContent") || "", "Аня"), "доска: в полосе написано, кто добирает и какой слот");
      check(hasFrag(boardText, await i18nFrag(dboard, "draft_bar")), "доска: полоса ставок объясняет «взять или скипнуть»");
      const remoteText = await evaluateSafe(dremote, "document.body.innerText") || "";
      check(hasFrag(remoteText, await i18nFrag(dremote, "draft_take")), "пульт: кнопка «Взять»");
      check(hasFrag(remoteText, await i18nFrag(dremote, "draft_skip")), "пульт: кнопка «Скип» со счётчиком");
      check(hasFrag(await evaluateSafe(dremote, "(document.getElementById('mymoney')||{}).textContent") || "", await i18nFrag(dremote, "draft_status")), "пульт: в статус-строке добор и номер слота вместо денег");
      await dboard.shot("ui_board_draft");
      await dremote.shot("ui_remote_draft");
      // Дальше жмём кнопки минуту с лишним: фоновую вкладку Chrome подмораживает, и пульт
      // успевает потерять связь. Живой игрок смотрит в свой экран — выводим её вперёд.
      await dremote.call("Page.bringToFront");
      // тратим все пять скипов: шестой лот обязан остаться без кнопки «Скип».
      // Считаем лоты, а не нажатия: истёкший таймер — тоже скип, и на медленной машине
      // счётчик может списать он.
      let seen = 0, must = false;
      while (seen < 8) {
        if (!(await untilPage(dremote, "state && state.phase === 'draft'", 20000))) break;
        seen++;
        if ((await evaluateSafe(dremote, "state.solo ? state.solo.skips : -1")) === 0) { must = true; break; }
        await dremote.call("Runtime.evaluate", { expression: `(document.querySelector('#bidbox .mid') || {click(){}}).click()` });
        await untilPage(dremote, "state && state.phase !== 'draft'", 8000);
      }
      check(must && seen === 6, `соло-добор: на слот ушло шесть лотов — пять скипов и обязательный (${seen})`);
      await wait(400);
      check(!(await evaluateSafe(dremote, "!!document.querySelector('#bidbox .mid')")), "пульт: на обязательном лоте кнопки «Скип» нет");
      check(await evaluateSafe(dremote, "!!document.querySelector('#bidbox .big')"), "пульт: кнопка «Взять» осталась");
      check(hasFrag(await evaluateSafe(dremote, "document.body.innerText") || "", await i18nFrag(dremote, "draft_must")), "пульт: подпись «скипы кончились — этот лот твой»");
      check(hasFrag(await evaluateSafe(dboard, "document.body.innerText") || "", await i18nFrag(dboard, "draft_bar_must")), "доска: на обязательном лоте сказано, что лот уходит игроку");
      await dremote.shot("ui_remote_draft_must");
      await dboard.shot("ui_board_draft_must");
      await dremote.call("Runtime.evaluate", { expression: `document.querySelector('#bidbox .big').click()` });
      check(await untilPage(dremote, "state && state.players.some((p) => p.lots.length === 1)", 8000), "пульт: «Взять» отдаёт лот игроку");
      check(dboard.errors.length === 0, "доска в доборе без JS-ошибок" + (dboard.errors.length ? ": " + dboard.errors.slice(0, 2).join(" | ") : ""));
      check(dremote.errors.length === 0, "пульт в доборе без JS-ошибок" + (dremote.errors.length ? ": " + dremote.errors.slice(0, 2).join(" | ") : ""));
      await dboard.call("Runtime.evaluate", { expression: "sendMsg({type:'end'})" });
      await dboard.close(); await dremote.close();
    }

    // --- M29: ведущий играет с телефона (§10.4). Хост-токен лежит в localStorage пульта — у него
    // есть «Начать игру» в лобби, кнопка «Ведущий» в игре, шторка с паузой/пропуском/завершением/киком
    // и «Продолжить» поверх паузы. Доска при этом остаётся в управлении. У обычного игрока кнопок нет.
    {
      const r = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal", settings: { intro: 0 } }) })).json();
      const hb = await cdp(`${BASE}/auction-board.html?r=${r.code}&t=${r.hostToken}`);
      const hp = await cdp(`${BASE}/auction.html`);
      await hp.call("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
      await hp.evaluate(`localStorage.setItem("auction-host-${r.code}", ${JSON.stringify(r.hostToken)}); true`);
      await hp.call("Page.navigate", { url: `${BASE}/auction.html?r=${r.code}&name=${encodeURIComponent("Хост")}` });
      check(await untilPage(hp, "isHostRemote && document.getElementById('hoststart')", 6000), "пульт ведущего: в лобби есть «Начать игру»");
      check(await evaluateSafe(hp, "document.getElementById('hoststart').disabled"), "пульт ведущего: «Начать» неактивна, пока на связи один");
      // Вкладки одного профиля делят localStorage: гость вошёл бы по токену ведущего и стал бы им.
      // Ведущий уже на связи (токены у него в памяти) — убираем ключи перед открытием гостя.
      await hp.evaluate(`localStorage.removeItem("auction-host-${r.code}"); localStorage.removeItem("auction-token-${r.code}"); true`);
      const guest = await cdp(`${BASE}/auction.html?r=${r.code}&name=${encodeURIComponent("Гость")}`);
      await guest.call("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
      const victim = new WebSocket(BASE.replace(/^http/, "ws") + "/auction/ws?r=" + r.code);
      let kicked = false;
      victim.on("message", (raw) => { if (JSON.parse(raw).type === "kicked") kicked = true; });
      await new Promise((d) => victim.on("open", () => { victim.send(JSON.stringify({ type: "join", name: "Жертва" })); d(); }));
      check(await untilPage(hp, "document.getElementById('hoststart') && !document.getElementById('hoststart').disabled", 6000), "пульт ведущего: «Начать» активна, когда двое на связи");
      check(!(await evaluateSafe(guest, "!!document.getElementById('hoststart')")), "обычный пульт: кнопки старта нет");
      await hp.shot("ui_remote_host_lobby");
      await hp.evaluate("document.getElementById('hoststart').click()");
      check(await untilPage(hb, "state && state.phase === 'lot'", 6000), "пульт ведущего: игра стартовала с телефона");
      await untilPage(hp, "document.getElementById('hostbtn')", 4000);
      check(await evaluateSafe(hp, "(() => { const b = document.getElementById('hostbtn'); return !!b && !b.hidden && b.offsetWidth > 0; })()"), "пульт ведущего: в статус-строке есть кнопка «Ведущий»");
      check(await evaluateSafe(guest, "(() => { const b = document.getElementById('hostbtn'); return !b || b.hidden || b.offsetWidth === 0; })()"), "обычный пульт: кнопки «Ведущий» нет");
      await hp.evaluate("document.getElementById('hostbtn').click()");
      check(await untilPage(hp, "document.querySelector('#sheet.on.host #hs_pause')", 3000), "пульт ведущего: шторка управления открывается");
      await wait(400);
      await hp.shot("ui_remote_host_sheet");
      await hp.evaluate("document.getElementById('hs_pause').click()");
      check(await untilPage(hb, "state.paused", 3000), "пульт ведущего: пауза с телефона");
      await hp.evaluate("closeHostSheet()");
      await untilPage(hp, "document.getElementById('ovresume')", 3000);
      // «Продолжить» не закрыт оверлеем: в центре кнопки — сама кнопка
      check(await evaluateSafe(hp, "(() => { const b = document.getElementById('ovresume'); if (!b) return false; const q = b.getBoundingClientRect(); return document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) === b; })()"), "пульт ведущего: на паузе доступна кнопка «Продолжить»");
      await hp.shot("ui_remote_host_paused");
      await hp.evaluate("document.getElementById('ovresume').click()");
      check(await untilPage(hb, "!state.paused", 3000), "пульт ведущего: «Продолжить» снимает паузу");
      // пропуск: отказ в подтверждении ничего не делает, согласие — пропускает
      const round0 = await evaluateSafe(hb, "state.round");
      await hp.evaluate("window.confirm = () => false; openHostSheet(); document.getElementById('hs_skip').click(); true");
      await wait(600);
      check((await evaluateSafe(hb, "state.round")) === round0 && (await evaluateSafe(hb, "state.phase")) === "lot", "пульт ведущего: «Пропустить» без подтверждения лот не трогает");
      await hp.evaluate("window.confirm = () => true; document.getElementById('hs_skip').click(); true");
      check(await untilPage(hb, `state.round !== ${round0} || state.phase === "unsold"`, 4000), "пульт ведущего: «Пропустить» с подтверждением пропускает лот");
      await hp.evaluate(`(() => { fillHostSheet(); const b = [...document.querySelectorAll("#sheet [data-kick]")].find((x) => x.parentElement.textContent.includes("Жертва")); b.click(); return true; })()`);
      check(await untilPage(hb, "state.players.some((p) => p.name === 'Жертва' && p.left)", 3000) && kicked, "пульт ведущего: кик игрока с подтверждением");
      // M24: на узкой доске «Пропустить» — в два тапа
      await hb.call("Emulation.setDeviceMetricsOverride", { width: 375, height: 700, deviceScaleFactor: 2, mobile: true });
      await hb.call("Page.bringToFront");
      await untilPage(hb, "state.phase === 'lot' && !document.getElementById('skip').disabled", 25000);
      const round1 = await evaluateSafe(hb, "state.round");
      await hb.evaluate("document.getElementById('skip').click()");
      await wait(500);
      check((await evaluateSafe(hb, "document.getElementById('skip').textContent === T('skip_sure')")) && (await evaluateSafe(hb, "state.round")) === round1 && (await evaluateSafe(hb, "state.phase")) === "lot", "узкая доска: первый тап по «Пропустить» только просит подтверждения");
      await hb.shot("ui_board_skip_confirm");
      await hb.evaluate("document.getElementById('skip').click()");
      check(await untilPage(hb, `state.round !== ${round1} || state.phase !== "lot"`, 3000), "узкая доска: второй тап пропускает лот");
      await hp.evaluate("window.confirm = () => true; openHostSheet(); document.getElementById('hs_end').click(); true");
      check(await untilPage(hb, "state.phase === 'finished'", 4000), "пульт ведущего: «Завершить игру» с телефона");
      check(!(await evaluateSafe(hb, "hostLost")), "доска после действий пульта ведущего осталась в управлении");
      // M5: пульт объясняет, как решилась ничья, доска бросает монетку (и не бросает при reduced-motion)
      const tieText = await evaluateSafe(hp, `(() => { setState(Object.assign({}, state, { phase: "finished", voting: null, results: { mode: "vote", ranking: [{ playerId: me, score: 1, verdict: "" }], tieBreak: "coin", votes: 2, summary: "" } })); return (document.getElementById("tie") || {}).textContent || ""; })()`);
      check(!!tieText && tieText === await evaluateSafe(hp, "I18N.t('tie_coin')"), "пульт: на итогах сказано, что ничью решила монетка");
      await hb.call("Emulation.clearDeviceMetricsOverride");
      const fakeRes = `Object.assign({}, state, { phase: "finished", voting: null, results: { mode: "vote", ranking: state.players.filter((p) => !p.left).map((p) => ({ playerId: p.id, score: 1, verdict: "" })), tieBreak: "coin", votes: 2, summary: "" } })`;
      check(await evaluateSafe(hb, `(() => { coinShown = ""; state = ${fakeRes}; render(); return !!document.getElementById("coinflip"); })()`), "доска: ничья по монетке — анимация броска");
      await wait(300);
      await hb.shot("ui_board_coin");
      await hb.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      const reduced = await evaluateSafe(hb, `(() => { const c = document.getElementById("coinflip"); if (c) c.remove(); coinShown = ""; state = ${fakeRes}; render(); return { coin: !!document.getElementById("coinflip"), text: document.body.innerText.includes(T("tie_coin").slice(0, 12)) }; })()`);
      check(reduced && !reduced.coin && reduced.text, "доска: при reduced-motion без броска, но с пояснением");
      await hb.call("Emulation.setEmulatedMedia", { features: [] });
      check(hp.errors.length === 0 && hb.errors.length === 0 && guest.errors.length === 0, "ведущий с телефона: без JS-ошибок" + ([...hp.errors, ...hb.errors, ...guest.errors].length ? ": " + [...hp.errors, ...hb.errors, ...guest.errors][0] : ""));
      victim.close();
      await hp.close(); await hb.close(); await guest.close();
    }

    // --- сеть без Википедии и iTunes: партия обязана идти, карточка — рисоваться
    const room2 = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "artist" }) })).json();
    const offline = await cdp(`${BASE}/auction-board.html?r=${room2.code}&t=${room2.hostToken}`);
    // заодно проверяем лобби без cdnjs: без библиотеки QR кнопка «Начать» раньше оставалась без обработчика.
    // Google Fonts блокируем здесь же: стили из <link> блокируют первую отрисовку, и если шрифты
    // недоступны (в части сетей их режут), доска обязана нарисоваться системным шрифтом, а не остаться белой.
    await offline.block(["*wikipedia.org*", "*itunes.apple.com*", "*wikimedia.org*", "*cdnjs.cloudflare.com*", "*fonts.googleapis.com*", "*fonts.gstatic.com*"]);
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
    check(hasFrag(noModesText, await i18nFrag(noModes, "lobby_sub")), "пульт без auction-modes.js: вход в лобби работает");
    check(!(WORST_RE.test(noModesText) || BASE_RE.test(noModesText)), "пульт без auction-modes.js: не выдумывает задание (" + noModesText.replace(/\n/g, " ").slice(0, 70) + ")");
    check(noModes.errors.filter((e) => !/ERR_BLOCKED_BY_CLIENT/.test(e)).length === 0, "пульт без auction-modes.js: без JS-ошибок" + (noModes.errors.length ? ": " + noModes.errors[0] : ""));
    await noModes.close();
  } finally {
    chrome.kill();
  }
  console.log(failures ? `UI FAILURES: ${failures}` : "UI TESTS OK", "→", OUT);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });

async function evaluateSafe(page, expr) { try { return await page.evaluate(expr); } catch { return null; } }

// ждём условие на странице (страница живёт своими сокетами — опрашиваем её же state)
async function untilPage(page, expr, ms = 10000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await evaluateSafe(page, `!!(${expr})`)) return true; await wait(200); }
  return false;
}

// Ожидаемые подписи пульта берём из его же словаря (window.I18N_DICT), а не хардкодим:
// страница переведена на ru/en/el, и тест обязан быть зелёным на любом языке.
// Из значения выкидываем HTML-теги и берём самый длинный кусок без {подстановок}.
async function i18nFrag(page, key) {
  const v = await evaluateSafe(page, `(() => {
    const D = window.I18N_DICT || {}, d = D[(window.I18N || {}).lang || "ru"] || D.ru || {}, s = d[${JSON.stringify(key)}];
    if (typeof s !== "string") return "";
    return s.replace(/<[^>]*>/g, "").split(/\\{\\w+\\}/).map((x) => x.trim()).sort((a, b) => b.length - a.length)[0] || "";
  })()`);
  return v || "\u0000нет ключа " + key; // пустую строку includes() нашёл бы где угодно
}
// innerText отдаёт текст уже после text-transform: uppercase, а греческие заглавные теряют ударения.
// Поэтому сравниваем без регистра и без диакритики.
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const hasFrag = (text, frag) => norm(text).includes(norm(frag));
