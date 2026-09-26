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
    default: opt(0);
  }
  return c.type;
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dump = path.join(os.tmpdir(), `bomb-ui-${process.pid}.json`);
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(SRV), NODE_ENV: "development", STATIC: path.join(__dirname, ".."), DUMP_FILE: dump },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let slog = "";
  server.stdout.on("data", (d) => (slog += d));
  server.stderr.on("data", (d) => (slog += d));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bomb-ui-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  await wait(2500);
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

    // --- 2. комната, доска, телефоны
    const room = await (await fetch(BASE + "/bomb/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { lang: "ru" } }) })).json();
    console.log("комната", room.code);
    const board = await cdp(`${BASE}/bomb-board.html?r=${room.code}&h=${room.hostToken}`);
    pages.push(board);
    await wait(2500);
    check((await board.evaluate("!!document.getElementById('startbtn')")) === true, "доска: лобби с кнопкой старта");
    check((await board.evaluate(OVERLAP)) === true, "доска: звук и языки не накладываются");
    check((await board.evaluate(ALIGN)) === true, "доска: звук и языки на одной линии");

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
    check(gallery.errors.length === 0, "галерея без JS-ошибок" + (gallery.errors[0] ? ": " + gallery.errors[0] : ""));
    // вернуть настоящее состояние
    await gallery.call("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
    await gallery.call("Page.reload");
    await wait(2500);
    check((await gallery.evaluate("window.bmPhone.me")) != null, "телефон после перезагрузки вернулся по токену");

    // --- 4. живая партия
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

    // --- 5. ведущий останавливает раунд → итоги, печать сверяется в браузере
    await board.evaluate("document.querySelector('#hostbar button').click()");
    await wait(2000);
    check((await board.evaluate("state.phase")) === "finished", "раунд остановлен ведущим");
    const boardSeal = await board.evaluate("(document.querySelector('.sealrow .chk')||{}).textContent || ''");
    check(boardSeal.startsWith("✓"), `доска: печать совпала (${boardSeal.slice(0, 50)})`);
    await board.shot("b_result");
    const phoneSeal = await phones[0].evaluate("(document.getElementById('sealok')||{}).textContent || ''");
    check(phoneSeal.startsWith("✓"), `телефон: печать совпала (${phoneSeal.slice(0, 50)})`);
    await phones[0].shot("p_result");

    // --- 6. ещё раунд на коротком фитиле — до настоящего взрыва (никто не кидает)
    await board.evaluate(`window.bmBoard.send({ type: "settings", settings: { fuse: "short" } })`);
    await wait(400);
    await board.evaluate("document.getElementById('again').click()");
    await wait(3500);
    const victimPhone = await board.evaluate("state.bombs[0].holder");
    const waitBoom = async () => { for (let i = 0; i < 100; i++) { if ((await board.evaluate("state.phase")) === "boom") return true; await wait(500); } return false; };
    check(await waitBoom(), "взрыв случился сам по фитилю");
    await wait(300);
    await board.shot("b_boom");
    const vIdx = (await Promise.all(phones.map((p) => p.evaluate("window.bmPhone.me")))).indexOf(victimPhone);
    if (vIdx >= 0) await phones[vIdx].shot("p_boom_victim");
    await phones[(vIdx + 1) % 3].shot("p_boom_other");
    await wait(5000);
    check((await board.evaluate("state.phase")) === "finished" && (await board.evaluate("state.loserId")) === victimPhone, "итоги: стендап ведёт тот, у кого взорвалось");
    await board.shot("b_final");

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
