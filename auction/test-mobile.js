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
];

async function page(url, dev) {
  const t = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").split("\n")[0]);
  });
  const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await call("Runtime.enable"); await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await call("Emulation.setUserAgentOverride", { userAgent: dev.ua });
  await call("Page.reload");
  await wait(3500);
  const ev = async (e) => (await call("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
  const tap = async (sel) => {
    const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    if (!r) return false;
    await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r[0], y: r[1] }] });
    await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(400);
    return true;
  };
  const shot = async (n) => { const r = await call("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, n + ".png"), Buffer.from(r.data, "base64")); };
  return { call, ev, tap, shot, errors, close: () => fetch(`http://localhost:${PORT}/json/close/${t.id}`) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
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
      await p.call("Input.insertText", { text: "Аня" });
      check((await p.ev("document.getElementById('name').value")) === "Аня", "имя вводится");
      // страница должна скроллиться, иначе клавиатура закроет поле
      check(await p.ev("document.documentElement.scrollHeight > innerHeight || getComputedStyle(document.body).overflowY === 'auto'"), "экран входа скроллится (место под клавиатуру)");
      await p.shot(`${dev.name.replace(/\W+/g, "_")}_enter`);
      await p.tap("#go");
      await wait(2500);
      check(/Ждём|комнате/i.test(await p.ev("document.body.innerText")), "вошёл в лобби");
      await p.shot(`${dev.name.replace(/\W+/g, "_")}_lobby`);

      // игра: кнопка ставки нажимается пальцем
      await board.call("Runtime.evaluate", { expression: "sendMsg({type:'bots', n:2}); setTimeout(() => sendMsg({type:'start'}), 400)" });
      await wait(6000);
      // боты перебивают каждые ~0.7 с, поэтому проверяем не лидерство, а что НАША ставка дошла до сервера
      let mineBid = false, tries = 0;
      while (!mineBid && tries++ < 6) {
        if (await p.ev("!!document.getElementById('bid')")) {
          await p.tap("#bid");
          await wait(700);
          mineBid = await board.ev(`state && state.players.some(x => x.name === "Аня" && (x.money < state.settings.budget || state.leaderId === x.id))`)
            || await p.ev("state && state.bids && state.bids.some(b => b.playerId === me)");
        } else await wait(700);
      }
      check(mineBid, "ставка тапом дошла до сервера");
      await p.shot(`${dev.name.replace(/\W+/g, "_")}_game`);
      // вёрстка не разъезжается по горизонтали
      check(await p.ev("document.documentElement.scrollWidth <= innerWidth + 2"), "нет горизонтальной прокрутки");
      check(p.errors.length === 0, "без JS-ошибок" + (p.errors.length ? ": " + p.errors[0] : ""));
      await board.call("Runtime.evaluate", { expression: "sendMsg({type:'end'})" });
      await p.close(); await board.close();
    }
  } finally { chrome.kill(); }
  console.log(failures ? `MOBILE FAILURES: ${failures}` : "MOBILE TESTS OK", "→", OUT);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
