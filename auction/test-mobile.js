"use strict";

/*
 * Мобильный прогон: эмулирует несколько реальных устройств (включая старый iPhone Safari),
 * тапает пальцем по элементам, вводит имя, делает ставку. Ловит JS-ошибки и невлезающую вёрстку.
 *   node test-mobile.js [http://localhost:3000] [папка скриншотов]
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const OUT = process.argv[3] || path.join(__dirname, "state", "mobile");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9500 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, name) => { console.log((ok ? "    ✓ " : "    ✗ ") + name); if (!ok) failures++; };

const DEVICES = [
  { name: "iPhone SE (Safari 15)", w: 375, h: 667, dpr: 2, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1" },
  { name: "iPhone 14 (Safari 17)", w: 390, h: 844, dpr: 3, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  { name: "Android (Chrome)", w: 412, h: 915, dpr: 2.6, ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" },
  // самый узкий живой экран: iPhone 5/SE1 и старый Android
  { name: "Узкий 320px (Safari 12)", w: 320, h: 568, dpr: 2, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1" },
];

// тест ходит по CDP и легко зависает на мёртвом соединении — держим общий будильник
let chrome = null;
const WATCHDOG = setTimeout(() => {
  console.error("MOBILE TIMEOUT: тест завис, прерываю");
  try { chrome && chrome.kill(); } catch {}
  process.exit(1);
}, Number(process.env.MOBILE_TIMEOUT_MS || 12 * 60 * 1000));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((res) => setTimeout(() => res({ error: "timeout: " + what }), ms))]);

async function page(url, dev) {
  // Вкладки одного профиля делят localStorage — вторая вошла бы по токену первой, тем же игроком
  // (первый пульт при этом получает «ты открыл игру на другом устройстве»). Поэтому вкладку открываем
  // пустой, чистим хранилище и только потом идём на адрес игры. Отдельный browser-контекст не годится:
  // в нём headless Chrome не отвечает на Input.dispatchTouchEvent и тест виснет насмерть.
  const t = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
  if (!t.webSocketDebuggerUrl) throw new Error("не открылась вкладка " + url);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await withTimeout(new Promise((r) => ws.on("open", r)), 20000, "открытие вкладки");
  let id = 0; const pending = new Map(); const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").split("\n")[0]);
  });
  const call = (method, params = {}) => withTimeout(new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }), 20000, method);
  await call("Runtime.enable"); await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await call("Emulation.setUserAgentOverride", { userAgent: dev.ua });
  await call("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "local_storage,cookies" });
  await call("Page.navigate", { url });
  await wait(3500);
  const ev = async (e) => (await call("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
  const tap = async (sel) => {
    const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    if (!r) return false;
    await call("Page.bringToFront"); // в фоновой вкладке headless не доставляет тапы
    await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r[0], y: r[1] }] });
    await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(400);
    return true;
  };
  const shot = async (n) => { const r = await call("Page.captureScreenshot", { format: "png" }); if (r && r.data) fs.writeFileSync(path.join(OUT, n + ".png"), Buffer.from(r.data, "base64")); };
  const rotate = (landscape) => call("Emulation.setDeviceMetricsOverride", { width: landscape ? dev.h : dev.w, height: landscape ? dev.w : dev.h, deviceScaleFactor: dev.dpr, mobile: true });
  return { call, ev, tap, shot, rotate, errors, close: () => fetch(`http://localhost:${PORT}/json/close/${t.id}`) };
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
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
  await wait(2500);
  try {
    for (const dev of DEVICES) {
      console.log("  " + dev.name);
      const room = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "food" }) })).json();
      const board = await page(`${BASE}/auction-board.html?r=${room.code}&t=${room.hostToken}`, { w: 1440, h: 900, dpr: 1, ua: DEVICES[2].ua.replace("Mobile ", "") });
      const p = await page(`${BASE}/auction.html?r=${room.code}`, dev);

      // экран входа: поле кликабельно и принимает текст пальцем
      check(await p.ev("!!document.getElementById('name')"), "экран входа отрисован");
      const tapped = await p.tap("#name");
      check(tapped, "по полю имени можно тапнуть");
      check(await p.ev("document.activeElement && document.activeElement.id === 'name'"), "тап ставит фокус в поле");
      await typeText(p, "Аня");
      check((await p.ev("document.getElementById('name').value")) === "Аня", "имя вводится");
      // страница должна скроллиться, иначе клавиатура закроет поле
      check(await p.ev("document.documentElement.scrollHeight > innerHeight || getComputedStyle(document.body).overflowY === 'auto'"), "экран входа скроллится (место под клавиатуру)");
      await p.shot(`${dev.name.replace(/\W+/g, "_")}_enter`);
      await p.tap("#go");
      await wait(2500);
      check(/Ждём|комнате/i.test(await p.ev("document.body.innerText")), "вошёл в лобби");
      await p.shot(`${dev.name.replace(/\W+/g, "_")}_lobby`);

      // второй игрок — ещё одна вкладка пульта (на проде ботов нет, а для старта нужно двое)
      const mate = await page(`${BASE}/auction.html?r=${room.code}`, DEVICES[2]);
      await mate.tap("#name");
      await typeText(mate, "Боря");
      await mate.tap("#go");
      await wait(2500);
      check(await board.ev('state && state.players.filter(x => !x.left).length >= 2'), "в лобби двое игроков");
      await board.call("Runtime.evaluate", { expression: "sendMsg({type:'start'})" });
      await wait(6000);
      check(await board.ev("state && state.phase !== 'lobby'"), "игра началась");
      // боты перебивают каждые ~0.7 с, поэтому проверяем не лидерство, а что НАША ставка дошла до сервера
      let mineBid = false, tries = 0;
      while (!mineBid && tries++ < 10) {
        if (await p.ev("!!document.getElementById('bid')")) {
          await p.tap("#bid");
          await wait(1200);
          mineBid = await board.ev(`state && state.players.some(x => x.name === "Аня" && (x.money < state.settings.budget || state.leaderId === x.id))`)
            || await p.ev("state && state.bids && state.bids.some(b => b.playerId === me)");
        } else await wait(1200);
      }
      check(mineBid, "ставка тапом дошла до сервера");
      await p.shot(`${dev.name.replace(/\W+/g, "_")}_game`);
      // вёрстка не разъезжается по горизонтали
      check(await p.ev("document.documentElement.scrollWidth <= innerWidth + 2"), "нет горизонтальной прокрутки");
      // важные кнопки должны быть в пределах экрана и достаточно крупные
      const btn = await p.ev("(() => { const b = document.querySelector('.actions .big, .actions .plate'); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.height), Math.round(r.right), Math.round(r.bottom)]; })()");
      check(!!btn && btn[0] >= 44, "кнопка ставки не мельче 44px (" + (btn ? btn[0] + "px" : "нет") + ")");
      check(!!btn && btn[1] <= dev.w + 2, "кнопка ставки не уезжает за правый край");
      // поворот экрана: ландшафт не поддерживаем, но экран не должен разъезжаться
      await p.rotate(true);
      await wait(700);
      check(await p.ev("document.documentElement.scrollWidth <= innerWidth + 2"), "ландшафт: нет горизонтальной прокрутки");
      check(await p.ev("!!document.querySelector('.actions')"), "ландшафт: блок кнопок на месте");
      await p.shot(`${dev.name.replace(/\W+/g, "_")}_landscape`);
      await p.rotate(false);
      await wait(500);
      check(await p.ev("document.documentElement.scrollWidth <= innerWidth + 2"), "возврат в портрет без горизонтальной прокрутки");
      check(p.errors.length === 0, "без JS-ошибок" + (p.errors.length ? ": " + p.errors[0] : ""));
      await board.call("Runtime.evaluate", { expression: "sendMsg({type:'end'})" });
      await p.close(); await mate.close(); await board.close();
    }
  } finally { chrome.kill(); }
  clearTimeout(WATCHDOG);
  console.log(failures ? `MOBILE FAILURES: ${failures}` : "MOBILE TESTS OK", "→", OUT);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
