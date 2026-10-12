"use strict";

/*
 * UI-тест «Бомбы»: headless Chrome через DevTools-протокол (как auction/test-ui.js).
 *   node test-ui.js [папка для скриншотов]
 * Сам поднимает dev-сервер со статикой сайта. Что проверяет:
 *   1. стартовый экран; 2. галерея всех 19 испытаний на двух телефонах (без JS-ошибок, без вылезания за экран);
 *   3. живая партия: доска + 3 телефона, испытания решаются НАСТОЯЩИМИ нажатиями по экрану пульта,
 *      бомба летает, ведущий останавливает раунд, печать сверяется в браузере (✓ на доске и телефоне).
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const CH = require("./challenges");

const OUT = process.argv[2] || path.join(__dirname, "state", "ui");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9500 + Math.floor(Math.random() * 100);
const SRV = 4900 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${SRV}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, name) => { console.log((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) failures++; };

async function cdp(url, phone) {
  const targets = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
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
  if (phone) await call("Emulation.setDeviceMetricsOverride", { width: phone[0], height: phone[1], deviceScaleFactor: 2, mobile: true });
  await call("Page.navigate", { url });
  const evaluate = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  };
  const shot = async (name) => { const r = await call("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64")); };
  const close = () => fetch(`http://localhost:${PORT}/json/close/${targets.id}`);
  return { call, evaluate, shot, errors, close };
}

async function typeText(page, text) {
  for (const ch of text) {
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
}

// Решатель в странице пульта: смотрит на испытание и жмёт кнопки на экране, как человек.
// Вопросы банка (quiz/tf/heavy/chrono) по экрану не решить — жмёт первый вариант (заодно проверяем «мимо»).
const SOLVER = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = window.bmPhone.state;
  const c = st && st.me && st.me.challenge;
  if (!c) return "none";
  const v = c.view;
  const $$ = (s) => [...document.querySelectorAll(s)];
  const click = (node) => node && node.click();
  const opt = (i) => click($$("#pad .opt")[i]);
  const cell = (i) => click($$("#pad .cell")[i]);
  const uniq = (items) => items.findIndex((x) => items.filter((y) => y === x).length === 1);
  const ptr = (node, type, x, y) => node.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
  switch (c.type) {
    case "wires": for (let i = 0; i < v.n; i++) { click($$("#pad .wire:not(.cut)")[0]); await sleep(60); } break;
    case "swipe": {
      const z = document.querySelector(".swipezone");
      const r = z.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const D = { u: [0, -60], d: [0, 60], l: [-60, 0], r: [60, 0] };
      for (const d of v.dirs) { ptr(z, "pointerdown", cx, cy); ptr(z, "pointerup", cx + D[d][0], cy + D[d][1]); await sleep(40); }
      break;
    }
    case "hold": { const b = document.querySelector(".holdbtn"); ptr(b, "pointerdown", 1, 1); await sleep((v.from + v.to) / 2); ptr(b, "pointerup", 1, 1); break; }
    case "order": for (let i = 1; i <= v.n; i++) { click($$("#pad .num").find((b) => b.textContent === String(i))); await sleep(40); } break;
    case "nopress": { for (let i = 0; i < 100 && !document.querySelector(".nowbtn.on"); i++) await sleep(60); click(document.querySelector(".nowbtn")); break; }
    case "catch": for (let i = 0; i < v.hits; i++) { ptr(document.querySelector(".tgt"), "pointerdown", 1, 1); await sleep(50); } break;
    case "color": opt(v.options.indexOf(v.ink)); break;
    case "odd": case "letter": cell(uniq(v.items)); break;
    case "sad": cell(v.items.findIndex((x) => ["😢", "😭", "🙁", "😞"].includes(x))); break;
    case "code": {
      await sleep(v.show + 80);
      for (const d of v.digits) { click($$(".keypad button").find((b) => b.textContent === d)); await sleep(30); }
      break;
    }
    case "count": opt(v.options.indexOf(v.items.filter((x) => x === "🦆").length)); break;
    case "sudoku": {
      const [r, k] = v.target, n = v.n, all = [...Array(n)].map((_, i) => i + 1);
      const row = v.cells[r].filter((x) => x != null), col = v.cells.map((x) => x[k]).filter((x) => x != null);
      const ans = row.length === n - 1 ? all.find((x) => !row.includes(x)) : all.find((x) => !col.includes(x));
      opt(v.options.indexOf(ans));
      break;
    }
    case "math": opt(v.options.indexOf(Function("return " + v.text.replace(/×/g, "*").replace(/−/g, "-"))())); break;
    case "seq": {
      let next;
      const it = v.items;
      if (v.kind === "days") next = (it[3] + (it[1] - it[0] + 7)) % 7;
      else if (v.kind === "emoji") { for (let p = 1; p <= 3; p++) if (it.every((x, i) => i < p || x === it[i - p])) { next = it[it.length - p]; break; } }
      else {
        const L = it.length, d = it.map((x, i) => x - it[i - 1]).slice(1);
        if (d.every((x) => x === d[0])) next = it[L - 1] + d[0];
        else if (it.every((x, i) => i === 0 || x === it[i - 1] * (it[1] / it[0]))) next = it[L - 1] * (it[1] / it[0]);
        else if (it.every((x) => Number.isInteger(Math.sqrt(x)))) next = (Math.sqrt(it[L - 1]) + 1) ** 2;
        else if (L === 5 && it[2] === it[0] + it[1]) next = it[3] + it[4];
        else next = it[L - 1] + d[0];
      }
      opt(v.options.indexOf(next));
      break;
    }
    case "chrono": for (let i = 0; i < 3; i++) { opt(i); await sleep(40); } break;
    case "spark": for (let i = 0; i < v.n; i++) { ptr(document.querySelector(".sparkbtn"), "pointerdown", 1, 1); await sleep(40); } break;
    case "coward": for (let i = 0; i < v.hits; i++) { ptr(document.querySelector(".cowardbtn"), "pointerdown", 1, 1); await sleep(60); } break;
    case "rhythm": {
      const b = document.querySelector(".rhythmbtn");
      for (let i = 0; i < 100 && b.disabled; i++) await sleep(60);
      ptr(b, "pointerdown", 1, 1);
      for (const g of v.gaps) { await sleep(g); ptr(b, "pointerdown", 1, 1); }
      break;
    }
    case "shells": {
      const f = document.querySelector(".shellfield");
      for (let i = 0; i < 150 && !f.classList.contains("pick"); i++) await sleep(60);
      let at = v.start; for (const [a, b] of v.swaps) { if (at === a) at = b; else if (at === b) at = a; }
      click($$(".shellfield .cup").sort((x, y) => parseFloat(x.style.left) - parseFloat(y.style.left))[at]);
      break;
    }
    case "simon": {
      const pads = $$(".spad");
      for (let i = 0; i < 150 && pads[0].disabled; i++) await sleep(60);
      for (const i of v.seq) { click(pads[i]); await sleep(60); }
      break;
    }
    case "blink": await sleep(v.showAt + v.dur + 100); cell(v.cell); break;
    case "flashes": { for (let i = 0; i < 150 && !$$("#pad .opt").length; i++) await sleep(60); opt(v.options.indexOf(v.count)); break; }
    case "diff": click($$("#pad .grid")[1].children[v.top.findIndex((x, i) => x !== v.bottom[i])]); break;
    case "dice": opt(v.options.indexOf(v.dice.reduce((a, b) => a + b, 0))); break;
    case "manual": {
      const w = v.wires, L = w.length;
      const R = {
        last_yellow: () => (w[L - 1] === "yellow" ? 0 : L - 1), even: () => (L % 2 === 0 ? L - 2 : 0),
        red: () => (w.filter((c) => c === "red").length > 1 ? w.lastIndexOf("red") : 1), blue: () => (w.includes("blue") ? w.indexOf("blue") : 2),
        white: () => (w.filter((c) => c === "white").length === 1 ? w.indexOf("white") : L - 1), same: () => w.indexOf(w[0], 1),
        black: () => (w[0] === "black" ? 1 : w.indexOf("black")), green: () => w.indexOf("green") + 1,
      };
      click($$("#pad .mwire")[R[v.rule]()]);
      break;
    }
    case "oddmeaning": cell(0); break;
    default: opt(0);
  }
  return c.type;
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dump = path.join(os.tmpdir(), `bomb-ui-${process.pid}.json`);
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(SRV), NODE_ENV: "development", STATIC: path.join(__dirname, ".."), DUMP_FILE: dump, OFFLINE_GRACE_MS: "3000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let slog = "";
  server.stdout.on("data", (d) => (slog += d));
  server.stderr.on("data", (d) => (slog += d));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bomb-ui-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  // Chrome на нагруженной машине поднимается дольше 2,5 с — ждём порт отладки до 30 с
  for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${PORT}/json/version`); break; } catch (e) { await wait(500); } }
  const pages = [];
  try {
    // --- 1. стартовый экран
    const land = await cdp(`${BASE}/bomb.html`, [390, 844]);
    pages.push(land);
    await wait(2500);
    check((await land.evaluate("document.getElementById('create') ? 1 : 0")) === 1, "стартовый экран: кнопка «Создать комнату»");
    check((await land.evaluate("document.documentElement.scrollWidth <= innerWidth")) === true, "стартовый экран: без горизонтальной прокрутки");
    const OVERLAP = `(() => { const a = document.querySelector(".sound-toggle-btn").getBoundingClientRect(), b = document.querySelector(".lang-switch").getBoundingClientRect();
      return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom; })()`;
    const ALIGN = `(() => { const a = document.querySelector(".sound-toggle-btn").getBoundingClientRect(), b = document.querySelector(".lang-switch").getBoundingClientRect();
      return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= 2 && Math.abs(a.height - b.height) <= 2; })()`;
    for (const w of [320, 390, 768, 1280]) {
      await land.call("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: w < 700 });
      await wait(400);
      check((await land.evaluate("document.documentElement.scrollWidth <= innerWidth")) === true, `стартовый экран ${w}px: без горизонтальной прокрутки`);
      check((await land.evaluate(OVERLAP)) === true, `стартовый экран ${w}px: звук и языки не накладываются`);
      // звук и переключатель на одной линии: центры по вертикали расходятся не больше чем на 2 px
      check((await land.evaluate(ALIGN)) === true, `стартовый экран ${w}px: звук и языки на одной линии`);
      await land.shot(`p_top_${w}`);
    }
    await land.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await wait(300);
    await land.shot("p_landing");
    check(land.errors.length === 0, "стартовый экран без JS-ошибок" + (land.errors[0] ? ": " + land.errors[0] : ""));

    // --- 1б. неверный код (bomb-037): «Такой комнаты нет» + поле кода, не «Комната закрылась»
    const wrong = await cdp(`${BASE}/bomb.html?r=ZZZZ99`, [390, 844]);
    pages.push(wrong);
    await wait(2500);
    const wtxt = await wrong.evaluate("document.body.innerText");
    check(/такой комнаты нет/i.test(wtxt) && !/закрылась/i.test(wtxt), "телефон, неверный код: «Такой комнаты нет», а не «закрылась»");
    check((await wrong.evaluate("!!document.getElementById('codein')")) === true, "телефон, неверный код: поле для кода");
    await wrong.evaluate("document.getElementById('codein').value = ' bear 74 '; document.getElementById('codeform').requestSubmit();");
    await wait(600);
    check((await wrong.evaluate("location.search")) === "?r=BEAR74", "телефон: код уходит после фильтра (bear 74 -> BEAR74)");
    await wrong.shot("p_noroom");
    const wrongBoard = await cdp(`${BASE}/bomb-board.html?r=ZZZZ99`);
    pages.push(wrongBoard);
    await wait(2500);
    const btxt = await wrongBoard.evaluate("document.body.innerText");
    check(/Такой комнаты нет/.test(btxt) && !/закрылась/i.test(btxt) && (await wrongBoard.evaluate("!!document.getElementById('gonecode')")) === true, "доска, неверный код: «Такой комнаты нет» и поле кода");
    check((await wrongBoard.evaluate("document.querySelectorAll('#hostbar *').length")) === 0, "доска, неверный код: кнопок ведущего нет");
    check(wrong.errors.filter((e) => !/404|WebSocket|Failed to load/.test(e)).length === 0, "неверный код: без JS-ошибок" + (wrong.errors[0] ? ": " + wrong.errors[0] : ""));
    await wrong.close();
    await wrongBoard.close();

    // --- 2. комната, доска, телефоны
    const room = await (await fetch(BASE + "/bomb/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "ru" } }) })).json();
    console.log("комната", room.code);
    const board = await cdp(`${BASE}/bomb-board.html?r=${room.code}&h=${room.hostToken}`);
    pages.push(board);
    await wait(2500);
    check((await board.evaluate("!!document.getElementById('startbtn')")) === true, "доска: лобби с кнопкой старта");
    check((await board.evaluate(OVERLAP)) === true, "доска: звук и языки не накладываются");
    check((await board.evaluate(ALIGN)) === true, "доска: звук и языки на одной линии");

    // --- 2a. «🔑 Ссылка ведущего» (bomb-001): кнопка в лобби, токен не на экране, ссылка открывает управление с чистого устройства
    const linkInfo = await board.evaluate(`(() => {
      const b = document.querySelector("#hostbar .linkbtn");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { w: r.width, h: r.height, text: document.body.innerText, search: location.search };
    })()`);
    check(!!linkInfo, "доска ведущего: кнопка «Ссылка ведущего» есть в лобби");
    check(linkInfo && linkInfo.w >= 44 && linkInfo.h >= 44, "кнопка «Ссылка ведущего» не меньше 44×44" + (linkInfo ? ` (${Math.round(linkInfo.w)}×${Math.round(linkInfo.h)})` : ""));
    check(linkInfo && linkInfo.search === `?r=${room.code}`, "после применения ?h= токена нет в адресной строке");
    check(linkInfo && !linkInfo.text.includes(room.hostToken), "токен ведущего не нарисован на экране доски");
    await board.evaluate(`(() => { window.__copied = null; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } }); document.querySelector("#hostbar .linkbtn").click(); })()`);
    await wait(300);
    const copied = await board.evaluate("window.__copied");
    check(copied === `${BASE}/bomb-board.html?r=${room.code}&h=${room.hostToken}`, "кнопка копирует ссылку …/bomb-board.html?r=КОД&h=ТОКЕН" + (copied ? "" : " (буфер пуст)"));
    check(!(await board.evaluate("document.body.innerText")).includes(room.hostToken), "после копирования токен тоже не на экране");

    // чистый контекст (другой origin = другое хранилище) по ссылке получает управление, адрес очищается
    const cleanHost = await cdp(`http://127.0.0.1:${SRV}/bomb-board.html?r=${room.code}&h=${room.hostToken}`);
    pages.push(cleanHost);
    await wait(2000);
    check((await cleanHost.evaluate("!!document.getElementById('startbtn') && isHost === true")) === true, "чистый контекст по ссылке: доска с кнопкой старта (управление)");
    check((await cleanHost.evaluate("location.search")) === `?r=${room.code}`, "чистый контекст: токен убран из адресной строки");
    // прежняя доска ушла в зрители: «Забрать»
    await wait(500);
    check((await board.evaluate("isHost === false && !!document.querySelector('#hostbar .linkbtn')")) === true, "прежняя доска стала зрителем и показала «Забрать»");
    await board.evaluate("document.querySelector('#hostbar .linkbtn').click()");
    await wait(800);
    check((await board.evaluate("isHost === true")) === true, "«Забрать» возвращает управление");
    // без токена: «Я ведущий» вместо кнопок, поле вставки принимает ссылку
    const viewer = await cdp(`http://[::1]:${SRV}/bomb-board.html?r=${room.code}`);
    pages.push(viewer);
    await wait(2000);
    check((await viewer.evaluate("document.getElementById('startbtn').classList.contains('hidden') && !!document.querySelector('#hostbar .linkbtn')")) === true, "доска без токена: управления нет, есть «Я ведущий»");
    await viewer.evaluate("document.querySelector('#hostbar .linkbtn').click()");
    await wait(200);
    await viewer.evaluate(`(() => { const i = document.querySelector("#hostbar input"); i.value = "${BASE}/bomb-board.html?r=${room.code}&h=${room.hostToken}"; document.querySelector("#hostbar .linkbtn").click(); })()`);
    await wait(1200);
    check((await viewer.evaluate("isHost === true && !!document.getElementById('startbtn')")) === true, "«Я ведущий» + вставленная ссылка: управление получено");
    await viewer.close();
    await cleanHost.close();
    await wait(300);
    // «Я ведущий» отобрал управление у основной доски — возвращаем её, остальные проверки идут с неё
    check((await board.evaluate("isHost === false")) === true, "основная доска ушла в зрители после вставки ссылки");
    await board.evaluate("document.querySelector('#hostbar .linkbtn').click()");
    await wait(800);
    check((await board.evaluate("isHost === true && !!document.getElementById('startbtn')")) === true, "основная доска снова ведёт");
    await board.call("Page.bringToFront");

    const names = ["Аня", "Петя", "Оля"];
    const phones = [];
    for (const [i, name] of names.entries()) {
      // у каждого телефона своё хранилище: в одном браузере вкладки делили бы токен и были бы одним игроком
      const origin = [`http://localhost:${SRV}`, `http://127.0.0.1:${SRV}`, `http://[::1]:${SRV}`][i];
      const ph = await cdp(`${origin}/bomb.html?r=${room.code}`, i === 2 ? [360, 640] : [390, 844]);
      pages.push(ph);
      await wait(1500);
      // клавиши доходят только до вкладки на переднем плане
      await ph.call("Page.bringToFront");
      await ph.call("Runtime.evaluate", { expression: "document.getElementById('name').focus()" });
      await typeText(ph, name);
      await ph.evaluate("document.querySelector('#enterform button[type=submit]').click()");
      phones.push(ph);
    }
    await wait(1500);
    for (const [i, ph] of phones.entries()) check((await ph.evaluate("window.bmPhone.me")) != null, `телефон ${names[i]}: вошёл`);
    check((await board.evaluate("state.players.length")) === 3, "доска: трое в лобби");
    await board.shot("b_lobby");
    // T-W3-14 (bomb-008): ✕ не меньше 36×36 и убирает со второго тапа; QR крупнее 136 css-px при высоте 900
    const lobbyM = await board.evaluate(`(() => { const x = document.querySelector(".seat .x"); const q = document.getElementById("qr").getBoundingClientRect(); const r = x.getBoundingClientRect(); x.click(); return { w: Math.round(r.width), h: Math.round(r.height), qr: Math.round(q.width), armed: !!document.querySelector(".seat .x[data-armed]"), n: state.players.length }; })()`);
    check(lobbyM && lobbyM.w >= 36 && lobbyM.h >= 36, `лобби: ✕ не меньше 36×36 (${lobbyM && lobbyM.w}×${lobbyM && lobbyM.h})`);
    check(lobbyM && lobbyM.armed && lobbyM.n === 3, "лобби: первый тап по ✕ взводит «Убрать?», игрок остаётся");
    check(lobbyM && lobbyM.qr >= 136, `лобби: QR не меньше 136 (${lobbyM && lobbyM.qr})`);
    await wait(3300);
    check((await board.evaluate("!document.querySelector('.seat .x[data-armed]') && state.players.length")) === 3, "лобби: без второго тапа ✕ сам снимается, игрок на месте");
    await phones[0].shot("p_lobby");

    // --- 3. галерея испытаний: подсовываем пульту каждое испытание и рисуем, ничего не отправляя
    const gallery = phones[2];
    const types = Object.values(CH.GROUPS).flat();
    const rnd = (n) => Math.floor(Math.random() * n);
    for (const phoneSize of [[390, 844], [360, 640], [320, 568]]) {
      await gallery.call("Emulation.setDeviceMetricsOverride", { width: phoneSize[0], height: phoneSize[1], deviceScaleFactor: 2, mobile: true });
      for (const type of types) {
        const c = CH.generate({ lvl: 3, rnd, groups: {}, used: { quiz: [], tf: [], heavy: [], chrono: [] }, only: type });
        const pub = { id: 900000 + types.indexOf(type), type: c.type, group: c.group, lvl: c.lvl, view: c.view, at: Date.now() + 60000, minMs: c.minMs, ttl: 12000 };
        const res = await gallery.evaluate(`(() => {
          const real = window.bmPhone.state;
          const fake = JSON.parse(JSON.stringify(real));
          fake.phase = "live"; fake.startedAt = Date.now();
          fake.bombs = [{ id: 0, holder: window.bmPhone.me, from: null, since: Date.now(), alive: true, commit: "0".repeat(64), min: 30, max: 90 }];
          fake.me = { id: window.bmPhone.me, challenge: ${JSON.stringify(pub)}, armed: false, holding: [0] };
          window.__fake = fake;
          screen = null; state = fake; renderHot();
          const pad = document.getElementById("pad");
          const r = pad.getBoundingClientRect();
          const over = [...pad.querySelectorAll("*")].filter((n) => { const b = n.getBoundingClientRect(); return b.width && (b.right > innerWidth + 1 || b.left < -1); }).length;
          const low = [...pad.querySelectorAll("*")].filter((n) => { const b = n.getBoundingClientRect(); return b.height && b.bottom > r.bottom + 1; }).length;
          return { ok: !!pad.children.length, over, low, scroll: document.documentElement.scrollWidth <= innerWidth, fits: document.documentElement.scrollHeight <= innerHeight + 1, bottom: r.bottom };
        })()`);
        check(res && res.ok && res.over === 0 && res.low === 0 && res.scroll && res.fits, `испытание ${type} (${phoneSize.join("×")}): отрисовано, влезает в экран без прокрутки` + (res && res.over ? ` — вбок вылезло ${res.over}` : "") + (res && res.low ? ` — вниз вылезло ${res.low}` : "") + (res && !res.fits ? " — экран прокручивается" : "") + (res && res.__error ? " " + res.__error : ""));
        await gallery.shot(`ch_${type}_${phoneSize[0]}`);
      }
    }
    for (const size of [[320, 568], [360, 640], [390, 844], [414, 896], [768, 1024]]) {
      await gallery.call("Emulation.setDeviceMetricsOverride", { width: size[0], height: size[1], deviceScaleFactor: 2, mobile: true });
      for (const [phase, victimIsMe] of [["boom", true], ["boom", false], ["finished", true], ["finished", false]]) {
        const res = await gallery.evaluate(`(() => {
          const me = window.bmPhone.me, real = window.bmPhone.state;
          const other = real.players.find((p) => p.id !== me) || real.players[0];
          const victim = ${victimIsMe} ? me : other.id;
          const fake = JSON.parse(JSON.stringify(real));
          Object.assign(fake, { phase: "${phase}", round: 7, loserId: victim, booms: [{ round: 7, bomb: 0, playerId: victim, at: Date.now() }],
            seals: [{ round: 7, bomb: 0, commit: "ab".repeat(32), min: 30, max: 90, revealed: true, fuseMs: 47000, salt: "00", seal: "x" }], bombs: [] });
          screen = null; state = fake; renderBoom();
          return { scroll: document.documentElement.scrollWidth <= innerWidth, fits: document.documentElement.scrollHeight <= innerHeight + 1 };
        })()`);
        check(res && res.scroll && res.fits, `экран ${phase} ${victimIsMe ? "жертвы" : "остальных"} ${size.join("×")}: влезает` + (res && res.__error ? " " + res.__error : ""));
        await gallery.shot(`v_${phase}_${victimIsMe ? "me" : "other"}_${size[0]}`);
      }
    }
    // --- 3б. T-W3-11: вёрстка телефона 320×568 (хеш 8 знаков, вердикт без разрыва слов, имена, «← Все игры», тост, «ты вне игры», «ты»)
    await gallery.call("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
    const w311 = await gallery.evaluate(`(() => {
      const real = window.bmPhone.state, me = window.bmPhone.me;
      const mk = () => { const f = JSON.parse(JSON.stringify(real)); f.phase = "live"; f.startedAt = Date.now() - 38000; return f; };
      const out = {};
      // имена «Игорь🔥» и «Игорь🔥 2» в сетке целей различимы и не обрезаны
      const f1 = mk();
      f1.players = real.players.slice(0, 1).concat([{ id: "x1", name: "Игорь🔥", color: "#e8322b", online: true }, { id: "x2", name: "Игорь🔥 2", color: "#1e6fd9", online: true }, { id: "x3", name: "Alexandra-Lupita", color: "#16924a", online: true }]);
      f1.players[0] = Object.assign({}, real.players.find((p) => p.id === me));
      f1.bombs = [{ id: 0, holder: me, from: null, since: Date.now() - 3000, alive: true, commit: "ab12cd34" + "0".repeat(56), min: 30, max: 90 }];
      f1.me = { id: me, challenge: null, armed: true, holding: [0], passN: {} };
      screen = null; state = f1; renderTargets();
      out.targets = [...document.querySelectorAll("#targets .target .nm")].map((n) => ({ t: n.textContent, clipped: n.scrollHeight > n.clientHeight + 1 }));
      // красный экран: «← Все игры» не кликабельна, тост — под шапкой, не на кнопках
      const a = document.querySelector(".util a");
      out.backPE = getComputedStyle(a).pointerEvents; out.backAria = a.getAttribute("aria-disabled");
      toast("Не успел — держи другое");
      const tr = document.getElementById("toast").getBoundingClientRect(), tg = document.getElementById("targets").getBoundingClientRect();
      out.toastBottom = Math.round(tr.bottom); out.targetsTop = Math.round(tg.top);
      // отсчёт: 8 знаков, по тапу полный; часов с начала раунда на телефоне нет
      const f2 = mk(); f2.phase = "countdown"; f2.phaseEnd = Date.now() + 3000;
      f2.bombs = [{ id: 0, holder: null, from: null, since: 0, alive: true, commit: "ab12cd34" + "0".repeat(56), min: 30, max: 90 }];
      f2.me = { id: me, challenge: null, armed: false, holding: [] };
      screen = null; calmKey = ""; state = f2; render();
      out.hashShort = (document.querySelector(".seal .hash") || {}).textContent;
      out.long64 = /[0-9a-f]{40,}/i.test(document.getElementById("app").innerText);
      document.querySelector(".seal .hash").click();
      out.hashFull = (document.querySelector(".seal .hash") || {}).textContent.length;
      // пассивный экран: метка «ты», нет часов «0:38», выбывший без «(а)»
      const f3 = mk();
      f3.bombs = [{ id: 0, holder: f3.players.find((p) => p.id !== me).id, from: null, since: Date.now() - 3000, alive: true, commit: "ab12cd34" + "0".repeat(56), min: 30, max: 90 }];
      f3.me = { id: me, challenge: null, armed: false, holding: [] };
      screen = null; calmKey = ""; state = f3; render();
      out.you = document.querySelectorAll(".pl.me .you").length;
      out.clock = /\\d+:\\d\\d/.test((document.querySelector(".mini .t") || {}).textContent || "");
      f3.players.find((p) => p.id === me).out = true; screen = null; calmKey = ""; render();
      out.outText = document.querySelector(".status").innerText;
      f3.players.find((p) => p.id === me).out = false;
      // итоги: вердикт печати переносится по словам
      Object.assign(f3, { phase: "finished", loserId: f3.players[0].id, round: 7, seals: [{ round: 7, bomb: 0, commit: "ab".repeat(32), min: 30, max: 90, revealed: true, fuseMs: 47000, salt: "00", seal: "x" }], bombs: [] });
      screen = null; boomKey = ""; render();
      const ok = document.getElementById("sealok");
      out.verdictBreak = getComputedStyle(ok).wordBreak + "/" + getComputedStyle(ok).overflowWrap;
      out.finishedHash = (document.querySelector(".seal .hash") || {}).textContent;
      out.gender = /\\([а-я]+\\)/.test(document.body.innerText);
      return out;
    })()`);
    check(w311 && w311.targets && w311.targets.length === 3 && new Set(w311.targets.map((t) => t.t)).size === 3 && w311.targets.every((t) => !t.clipped), "320: «Игорь🔥» / «Игорь🔥 2» / «Alexandra-Lupita» в сетке целей различимы и не обрезаны" + (w311 && w311.__error ? " " + w311.__error : ""));
    check(w311 && w311.backPE === "none" && w311.backAria === "true", "красный экран: «← Все игры» неактивна");
    check(w311 && w311.toastBottom <= w311.targetsTop + 1, `красный экран: тост не перекрывает плитки (низ ${w311 && w311.toastBottom}, плитки с ${w311 && w311.targetsTop})`);
    check(w311 && /^[0-9a-f]{8}…$/.test(w311.hashShort) && w311.long64 === false && w311.hashFull === 64, "отсчёт: хеш 8 знаков, по тапу полный 64");
    check(w311 && w311.you === 1 && w311.clock === false, "пассивный экран: метка «ты», часов с начала раунда нет");
    check(w311 && !/\([а-я]+\)/.test(w311.outText) && !w311.gender, "экран «ты вне игры» и итоги без «(а)»");
    check(w311 && /^normal/.test(w311.verdictBreak) && /^[0-9a-f]{8}…$/.test(w311.finishedHash), "итоги: вердикт печати без разрыва внутри слова, хеш короткий");
    await gallery.shot("w311_320");

    check(gallery.errors.length === 0, "галерея без JS-ошибок" + (gallery.errors[0] ? ": " + gallery.errors[0] : ""));
    // вернуть настоящее состояние
    await gallery.call("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
    await gallery.call("Page.reload");
    await wait(2500);
    check((await gallery.evaluate("window.bmPhone.me")) != null, "телефон после перезагрузки вернулся по токену");

    // --- 4. живая партия
    await board.evaluate(`window.bmBoard.send({ type: "settings", settings: { groups: { crowd: false } } })`);
    await wait(400);
    await board.evaluate("document.getElementById('startbtn').click()");
    await wait(600);
    check((await board.evaluate("state.phase")) === "countdown", "доска: отсчёт с печатью");
    await board.shot("b_countdown");
    await phones[0].shot("p_countdown");
    await wait(3000);
    check((await board.evaluate("state.phase")) === "live", "раунд пошёл");
    const seen = new Set();
    let passes = 0;
    for (let step = 0; step < 40 && passes < 7; step++) {
      const holder = await board.evaluate("state.bombs[0].holder");
      const idx = await Promise.all(phones.map((p) => p.evaluate("window.bmPhone.me")));
      const ph = phones[idx.indexOf(holder)];
      if (!ph) { await wait(300); continue; }
      if (!(await ph.evaluate("!!(window.bmPhone.state.me && window.bmPhone.state.me.challenge)"))) {
        if (await ph.evaluate("!!document.getElementById('targets')")) {
          if (passes === 0) { await ph.shot("p_targets"); await board.shot("b_live"); }
          const before = await board.evaluate("state.passes");
          await ph.evaluate("[...document.querySelectorAll('#targets .target')].find((b) => !b.disabled).click()");
          await wait(900);
          const after = await board.evaluate("state.passes");
          if (after > before) passes++;
          if (passes === 1) await board.shot("b_after_pass");
          continue;
        }
        await wait(200);
        continue;
      }
      const type = await ph.evaluate("window.bmPhone.state.me.challenge.type");
      if (!seen.has(type)) { seen.add(type); await ph.shot("live_" + type); }
      await ph.evaluate(SOLVER);
      await wait(700);
      const hot = await board.evaluate("document.body.classList.contains('hot')");
      if (hot) await board.shot("b_hot");
    }
    check(passes >= 5, `бомба летала по настоящим нажатиям: передач ${passes}, типы ${[...seen].join(", ")}`);
    const doing = await board.evaluate("document.getElementById('doing').textContent");
    check(typeof doing === "string" && doing.length > 3, `доска: подпись «что делает держатель» (${doing})`);
    check((await board.evaluate("state.challenges && Object.keys(state.challenges).length >= 0")) === true, "доска видит испытания держателя");

    // --- 4а. «нет связи» (bomb-003): метка на карточке держателя и в подписи по центру; карточки не двигаются
    {
      await board.call("Page.bringToFront"); // метка в .st и раскладка карточек живут в rAF — в фоновой вкладке он не идёт
      await wait(900);
      const before = await board.evaluate(`(() => { const o = {}; document.querySelectorAll(".pc").forEach((c) => { const r = c.getBoundingClientRect(); o[c.dataset.id] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }); return o; })()`);
      const hid = await board.evaluate("state.bombs[0].holder");
      await board.evaluate(`(() => { const p = state.players.find((x) => x.id === ${JSON.stringify(hid)}); p.online = false; render(); })()`);
      await wait(900);
      const mark = await board.evaluate(`(() => { const c = document.querySelector('.pc[data-id=' + JSON.stringify(${JSON.stringify(hid)}) + ']'); return { st: c.querySelector(".st").textContent, doing: document.getElementById("doing").textContent }; })()`);
      check(/нет связи/.test(mark.st) && /⚡/.test(mark.st), `доска: у держателя без связи «🧨 ⚡ нет связи» (${mark.st})`);
      check(/без связи/.test(mark.doing), `доска: подпись по центру «без связи…» (${mark.doing})`);
      const after = await board.evaluate(`(() => { const o = {}; document.querySelectorAll(".pc").forEach((c) => { const r = c.getBoundingClientRect(); o[c.dataset.id] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }); return o; })()`);
      check(JSON.stringify(before) === JSON.stringify(after), "доска: карточки не сдвинулись и не изменили размер от метки «нет связи»");
      await board.evaluate(`(() => { state.players.find((x) => x.id === ${JSON.stringify(hid)}).online = true; })()`);

      // телефон: плитки целей — серая «нет связи»; с правилом U-26 — disabled; размер плитки не меняется
      const res = await phones[0].evaluate(`(() => {
        const me = window.bmPhone.me, real = window.bmPhone.state;
        const run = (onlineOnly, offId) => {
          const fake = JSON.parse(JSON.stringify(real));
          fake.phase = "live"; fake.onlineOnly = onlineOnly;
          fake.bombs = [{ id: 0, holder: me, from: null, since: Date.now(), alive: true, commit: "0".repeat(64) }];
          fake.me = { id: me, challenge: null, armed: true, holding: [0], passN: { 0: 0 } };
          fake.players.forEach((p) => { p.online = p.id !== offId; });
          screen = null; state = fake; renderTargets();
          return [...document.querySelectorAll("#targets .target")].map((t) => ({ off: t.classList.contains("off"), disabled: t.disabled, small: (t.querySelector("small") || {}).textContent || "", h: Math.round(t.getBoundingClientRect().height) }));
        };
        const other = real.players.find((p) => p.id !== me).id;
        const base = run(false, null), soft = run(false, other), hard = run(true, other);
        return { base, soft, hard };
      })()`);
      const offSoft = res.soft.find((t) => t.off), offHard = res.hard.find((t) => t.off);
      check(offSoft && offSoft.small === "нет связи" && !offSoft.disabled, "телефон: офлайн-плитка серая с «нет связи», без правила — нажимается");
      check(offHard && offHard.small === "нет связи" && offHard.disabled, "телефон: с RULE_U26_BOMB_ONLINE офлайн-плитка disabled");
      check(res.base.map((t) => t.h).join() === res.hard.map((t) => t.h).join(), "телефон: высота плиток не меняется от метки «нет связи»");
      await phones[0].evaluate("screen = null; targetsKey = ''; render();");
    }

    // --- 5. ведущий останавливает раунд → итоги, печать сверяется в браузере
    // T-W3-14 (bomb-005): «Остановить раунд» — два тапа; первый только взводит
    await board.evaluate("document.querySelector('#hostbar button:not(.linkbtn)').click()");
    await wait(300);
    check((await board.evaluate("state.phase")) === "live" && (await board.evaluate("document.querySelector('#hostbar button[data-armed]') !== null")), "«Остановить раунд»: первый тап взводит, раунд идёт");
    await board.evaluate("document.querySelector('#hostbar button:not(.linkbtn)').click()");
    await wait(2000);
    check((await board.evaluate("state.phase")) === "finished", "раунд остановлен ведущим");
    const boardSeal = await board.evaluate("(document.querySelector('.sealrow .chk')||{}).textContent || ''");
    check(boardSeal.startsWith("✓"), `доска: печать совпала (${boardSeal.slice(0, 50)})`);
    await board.shot("b_result");
    const phoneSeal = await phones[0].evaluate("(document.getElementById('sealok')||{}).textContent || ''");
    check(phoneSeal.startsWith("✓"), `телефон: печать совпала (${phoneSeal.slice(0, 50)})`);
    await phones[0].shot("p_result");

    // --- 5б. «Зал»: код на телефоне соседа или на общем экране — держатель вводит его по-настоящему
    await board.evaluate(`window.bmBoard.send({ type: "settings", settings: { groups: { hands: false, eyes: false, head: false, crowd: true } } })`);
    await wait(400);
    let crowdDone = 0;
    for (let round = 0; round < 3; round++) {
      await board.evaluate("document.getElementById('again').click()");
      await wait(3600);
      const holder = await board.evaluate("state.bombs[0].holder");
      const ids = await Promise.all(phones.map((p) => p.evaluate("window.bmPhone.me")));
      const hp = phones[ids.indexOf(holder)];
      const ch = await hp.evaluate("window.bmPhone.state.me.challenge");
      let code;
      if (ch.view.where === "phone") {
        const helper = phones[ids.indexOf(ch.view.helper)];
        code = await helper.evaluate("(document.querySelector('#hintbar.on .code') || {}).textContent || ''");
        check(/^[1-9]{3,4}$/.test(code), `«Зал»: у соседа на телефоне плашка с кодом (${code})`);
        await helper.shot("crowd_helper");
        check((await hp.evaluate("document.body.innerText.includes(" + JSON.stringify(code) + ")")) === false, "«Зал»: у держателя кода на экране нет");
      } else {
        const txt = await board.evaluate("document.getElementById('bubble').textContent");
        code = (txt.match(/[1-9]{3,4}/) || [""])[0];
        check(code.length >= 3, `«Зал»: код на общем экране (${txt.slice(0, 40)})`);
        await board.shot("crowd_board");
      }
      await hp.shot("crowd_holder_" + ch.view.where);
      await wait(1300);
      for (const d of code) { await hp.evaluate(`[...document.querySelectorAll(".keypad button")].find((b) => b.textContent === "${d}").click()`); await wait(60); }
      await wait(900);
      const armed = await hp.evaluate("!!window.bmPhone.state.me.armed");
      check(armed, `«Зал» (${ch.view.where}): держатель ввёл код и может кидать`);
      if (armed) crowdDone++;
      await board.evaluate("document.querySelector('#hostbar button:not(.linkbtn)').click()");
      await wait(150);
      await board.evaluate("document.querySelector('#hostbar button:not(.linkbtn)').click()");
      await wait(1500);
    }
    check(crowdDone >= 1, "«Зал» пройден по-настоящему");
    await board.evaluate(`window.bmBoard.send({ type: "settings", settings: { groups: { hands: true, eyes: true, head: true, crowd: true } } })`);
    await wait(300);

    // --- 6. ещё раунд на коротком фитиле — до настоящего взрыва (никто не кидает)
    await board.evaluate(`window.bmBoard.send({ type: "settings", settings: { fuse: "short" } })`);
    await wait(400);
    await board.evaluate("document.getElementById('again').click()");
    await wait(3500);
    await board.evaluate(`(() => {
      window.__kap = null;
      new MutationObserver((muts) => {
        const arena = document.getElementById("arena");
        for (const m of muts) for (const k of m.addedNodes) {
          if (!k.classList || !k.classList.contains("kapow")) continue;
          requestAnimationFrame(() => {
            const ar = arena.getBoundingClientRect(), sc = ar.width / arena.clientWidth || 1;
            const rg = document.createRange(); rg.selectNodeContents(document.getElementById("holder")); const nr = rg.getBoundingClientRect();
            const cx = parseFloat(k.style.left), cy = parseFloat(k.style.top), hw = k.offsetWidth / 2, hh = k.offsetHeight / 2;
            const x0 = (nr.left - ar.left) / sc, x1 = (nr.right - ar.left) / sc, y0 = (nr.top - ar.top) / sc, y1 = (nr.bottom - ar.top) / sc;
            window.__kap = { over: !(cx + hw <= x0 || cx - hw >= x1 || cy + hh <= y0 || cy - hh >= y1), z: k.style.zIndex };
          });
        }
      }).observe(document.getElementById("arena"), { childList: true });
    })()`);
    const victimPhone = await board.evaluate("state.bombs[0].holder");
    const waitBoom = async () => { for (let i = 0; i < 100; i++) { if ((await board.evaluate("state.phase")) === "boom") return true; await wait(500); } return false; };
    check(await waitBoom(), "взрыв случился сам по фитилю");
    await wait(300);
    await board.shot("b_boom");
    // T-W3-14 (bomb-006): «БУМ!» не лежит на имени проигравшего (наблюдатель в странице записал положение звезды сразу при появлении)
    const kap = await board.evaluate("window.__kap || { none: true }");
    check(kap && !kap.none && (!kap.over || kap.z === "2"), "взрыв: «БУМ!» не перекрывает имя проигравшего" + (kap && kap.none ? " (звезды нет)" : ""));
    await wait(2000);
    check((await board.evaluate("document.querySelectorAll('.kapow').length")) === 0, "взрыв: «БУМ!» исчезает за ~2 с, а не висит 4 с");
    const vIdx = (await Promise.all(phones.map((p) => p.evaluate("window.bmPhone.me")))).indexOf(victimPhone);
    if (vIdx >= 0) await phones[vIdx].shot("p_boom_victim");
    await phones[(vIdx + 1) % 3].shot("p_boom_other");
    await wait(5000);
    check((await board.evaluate("state.phase")) === "finished" && (await board.evaluate("state.loserId")) === victimPhone, "итоги: проиграл тот, на ком рванула");
    await board.shot("b_final");

    // --- 6а. вход по имени (T-W2-15): плитки «Это я», «Это ты?», тёзка получает «Имя (2)» и тост
    {
      const r2 = await (await fetch(BASE + "/bomb/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "ru" } }) })).json();
      const joinRaw = (name) => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${SRV}/bomb/ws?r=${r2.code}`);
        ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
        ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "joined") resolve({ ws, id: m.playerId }); });
        ws.on("error", reject);
      });
      const guest = await joinRaw("Гость"), lena = await joinRaw("Лена");
      guest.ws.close();
      lena.ws.close();
      await wait(3800); // OFFLINE_GRACE_MS=3000 + запас: оба места без связи, грация подхвата прошла
      const fresh = async (size) => {
        // сначала страница без комнаты (токены в общем localStorage чужих телефонов не читаются), чистим, потом входим в комнату
        const pg = await cdp(`${BASE}/bomb.html`, size);
        pages.push(pg);
        await wait(700);
        await pg.evaluate("localStorage.clear()");
        await pg.call("Page.navigate", { url: `${BASE}/bomb.html?r=${r2.code}` });
        await wait(1800);
        await pg.call("Page.bringToFront");
        return pg;
      };
      const p1 = await fresh([390, 844]);
      const tiles = await p1.evaluate("[...document.querySelectorAll('#ghosts .ghost')].map((b) => b.textContent).sort().join()");
      check(tiles === "Гость,Лена", `вход: под формой плитки «Это я» с офлайн-местами (${tiles})`);
      const geo = await p1.evaluate(`(() => { const r = document.querySelector('#ghosts .ghost').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), document.documentElement.scrollWidth <= innerWidth]; })()`);
      check(geo[1] >= 44 && geo[2], `плитки «Это я»: высота ≥ 44 и без горизонтальной прокрутки (${geo[0]}×${geo[1]})`);
      await p1.shot("p_enter_ghosts");
      // имя набрано руками — «Это ты?»
      await p1.call("Runtime.evaluate", { expression: "document.getElementById('name').focus()" });
      await typeText(p1, "Лена");
      await p1.evaluate("document.querySelector('#enterform button[type=submit]').click()");
      await wait(900);
      check((await p1.evaluate("!!document.getElementById('claimyes')")) === true, "имя офлайн-места набрано руками: экран «Это ты?»");
      await p1.shot("p_claim");
      await p1.evaluate("document.getElementById('claimyes').click()");
      await wait(900);
      check((await p1.evaluate("window.bmPhone.me")) === lena.id, "«Да, это я» возвращает то же место (playerId)");
      // плитка «Гость» на втором телефоне — одним тапом
      const p2 = await fresh([360, 640]);
      await p2.evaluate("[...document.querySelectorAll('#ghosts .ghost')].find((b) => b.textContent === 'Гость').click()");
      await wait(900);
      check((await p2.evaluate("window.bmPhone.me")) === guest.id, "плитка «Это я: Гость» возвращает своё место");
      // тёзка живого игрока — «Лена (2)» и тост
      const p3 = await fresh([390, 844]);
      await p3.call("Runtime.evaluate", { expression: "document.getElementById('name').focus()" });
      await typeText(p3, "Лена");
      await p3.evaluate("document.querySelector('#enterform button[type=submit]').click()");
      await wait(900);
      const nm = await p3.evaluate("(window.bmPhone.state.players.find((p) => p.id === window.bmPhone.me) || {}).name");
      const tst = await p3.evaluate("document.getElementById('toast').textContent");
      if (nm !== "Лена (2)") { await p3.shot("p_dbg_homonym"); console.log("   диагностика:", await p3.evaluate("document.body.innerText.slice(0, 200) + ' | screen=' + screen + ' me=' + me + ' joinErr=' + joinErr")); }
      check(nm === "Лена (2)", `тёзка живого игрока получает «Лена (2)» (${nm})`);
      check(/Лена \(2\)/.test(tst), `тост «имя занято — теперь ты …» (${tst})`);
      for (const pg of [p1, p2, p3]) check(pg.errors.length === 0, "вход по имени без JS-ошибок" + (pg.errors[0] ? ": " + pg.errors[0] : ""));
    }

    // --- 6б. потерянный тап (T-W2-16, S-12): сокет закрылся, тап по цели в первые 100 мс — бросок доходит после возврата связи
    {
      const r3 = await (await fetch(BASE + "/bomb/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { fuse: "long", groups: { hands: true, eyes: false, head: false, crowd: false } } }) })).json();
      const conn3 = (extra) => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${SRV}/bomb/ws?r=${r3.code}`);
        const c = { ws, state: null };
        ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.state) c.state = m.state; if (m.type === "hello" || m.type === "joined" || m.type === "host_ok") c.ready = true; });
        ws.on("open", () => { ws.send(JSON.stringify(extra)); resolve(c); });
        ws.on("error", reject);
      });
      const hostC = await conn3({ type: "host", token: r3.hostToken });
      const mate = await conn3({ type: "join", name: "Напарник" });
      const tap = await cdp(`${BASE}/bomb.html`, [390, 844]);
      pages.push(tap);
      await wait(600);
      await tap.evaluate("localStorage.clear()");
      // перехват сокетов страницы: закрыть «связь» можно только изнутри страницы
      await tap.call("Page.addScriptToEvaluateOnNewDocument", { source: "(() => { const W = window.WebSocket; window.__ws = []; window.WebSocket = function (u, p) { const w = p ? new W(u, p) : new W(u); window.__ws.push(w); return w; }; window.WebSocket.prototype = W.prototype; ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach((k) => { window.WebSocket[k] = W[k]; }); })();" });
      await tap.call("Page.navigate", { url: `${BASE}/bomb.html?r=${r3.code}` });
      await wait(1800);
      await tap.call("Page.bringToFront");
      await tap.call("Runtime.evaluate", { expression: "document.getElementById('name').focus()" });
      await typeText(tap, "Тап");
      await tap.evaluate("document.querySelector('#enterform button[type=submit]').click()");
      await wait(1000);
      const myId = await tap.evaluate("window.bmPhone.me");
      check(!!myId, "S-12: телефон вошёл в комнату");
      // раундов, пока бомба не окажется у телефона (до 8 попыток)
      let got = false;
      for (let round = 0; round < 8 && !got; round++) {
        hostC.ws.send(JSON.stringify({ type: round === 0 ? "start" : "end" }));
        if (round) { await wait(500); hostC.ws.send(JSON.stringify({ type: "start" })); }
        await wait(3800);
        got = (await tap.evaluate("(window.bmPhone.state.bombs[0] || {}).holder")) === myId;
      }
      check(got, "S-12: бомба у телефона для проверки броска");
      if (got) {
        // решаем испытание по-настоящему, ждём экран целей
        for (let i = 0; i < 20 && !(await tap.evaluate("!!document.getElementById('targets')")); i++) {
          await tap.evaluate(SOLVER);
          await wait(600);
        }
        check((await tap.evaluate("!!document.getElementById('targets')")) === true, "S-12: экран целей открыт");
        const before = hostC.state ? hostC.state.passes : 0;
        // обрыв и тап сразу: сокет закрыт, переподключение ещё не началось
        const res = await tap.evaluate(`(() => {
          window.__ws.forEach((w) => { try { w.close(); } catch (e) {} });
          const t = [...document.querySelectorAll('#targets .target')].find((b) => !b.disabled);
          t.click();
          return conn.api ? conn.api.mode : "?";
        })()`);
        console.log("   режим транспорта в момент тапа:", res);
        let passed = false;
        for (let i = 0; i < 40 && !passed; i++) { await wait(250); passed = hostC.state && hostC.state.passes > before; }
        check(passed, "S-12: тап после ws.close() дошёл после возврата связи (бомба передана)");
        const toastText = await tap.evaluate("document.getElementById('toast').textContent");
        check(!/Не дошло/.test(toastText), "S-12: тоста «Не дошло» нет (" + toastText + ")");
        check((await tap.evaluate("document.body.innerText")).length > 0 && (await tap.evaluate("!document.querySelector('.throwing')")), "S-12: кнопки целей не остались мёртвыми (.throwing снят)");
      }
      // bomb-030: событие offline браузера — баннер «нет связи» сразу, не через 45 с
      await tap.evaluate("window.dispatchEvent(new Event('offline'))");
      await wait(200);
      check((await tap.evaluate("document.getElementById('conn').classList.contains('on')")) === true, "bomb-030: событие offline — баннер «нет связи» виден сразу");
      check(tap.errors.length === 0, "S-12: без JS-ошибок" + (tap.errors[0] ? ": " + tap.errors[0] : ""));
      hostC.ws.close();
      mate.ws.close();
    }

    // --- 7. телефоны и доска без JS-ошибок, без горизонтальной прокрутки
    for (const [i, ph] of phones.entries()) {
      check(ph.errors.length === 0, `телефон ${names[i]} без JS-ошибок` + (ph.errors[0] ? ": " + ph.errors[0] : ""));
      check((await ph.evaluate("document.documentElement.scrollWidth <= innerWidth")) === true, `телефон ${names[i]} без горизонтальной прокрутки`);
    }
    check(board.errors.length === 0, "доска без JS-ошибок" + (board.errors[0] ? ": " + board.errors[0] : ""));
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    for (const p of pages) { try { await p.close(); } catch {} }
    chrome.kill();
    server.kill();
    try { fs.unlinkSync(dump); } catch {}
  }
  console.log(failures ? `\nпровалов: ${failures}` : "\nвсё зелёное");
  if (failures) console.log(slog.split("\n").slice(-15).join("\n"));
  process.exit(failures ? 1 : 0);
})();
