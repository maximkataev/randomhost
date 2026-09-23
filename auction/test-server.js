"use strict";

/* Протокольные тесты сервера против локального dev-сервера: node test-server.js [http://localhost:3000] */

const WebSocket = require("ws");
const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws") + "/auction/ws?r=";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) return false; await wait(60); } return true; };
let failures = 0;
const check = (ok, name) => { console.log((ok ? "  ✓ " : "  ✗ ") + name); if (!ok) failures++; };

function connect(code, first) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS + code);
    const c = { ws, state: null, msgs: [], me: null, token: null, closed: false, send: (m) => ws.send(JSON.stringify(m)) };
    ws.on("open", () => ws.send(JSON.stringify(first)));
    ws.on("message", (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.type === "state" || m.type === "hello") c.state = m.state; if (m.type === "joined") { c.me = m.playerId; c.token = m.token; resolve(c); } if (m.type === "host_ok") resolve(c); if (m.type === "error" && !c.me) resolve(c); });
    ws.on("close", () => (c.closed = true));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}
const has = (c, type, pred = () => true) => c.msgs.some((m) => m.type === type && pred(m));

(async () => {
  const room = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal", settings: { intro: 0 } }) })).json();
  console.log("room", room.code);
  const host = await connect(room.code, { type: "host", token: room.hostToken });
  const bad = await connect(room.code, { type: "host", token: "wrong" });
  check(has(bad, "error", (m) => /token/.test(m.error)), "неверный хост-токен отклоняется");

  const a = await connect(room.code, { type: "join", name: "Аня" });
  const b = await connect(room.code, { type: "join", name: "Аня" });
  await until(() => host.state?.players.length === 2);
  check(host.state.players.map((p) => p.name).join(",") === "Аня,Аня 2", "одинаковые имена получают суффикс");

  host.send({ type: "settings", settings: { budget: 50, slots: 3 } });
  await until(() => host.state.settings.budget === 50);
  check(host.state.players.every((p) => p.money === 50), "смена бюджета в лобби обновляет деньги игроков");

  host.send({ type: "start" });
  await until(() => host.state.phase === "lot");
  check(host.state.phase === "lot", "старт");
  host.send({ type: "settings", settings: { budget: 10 } });
  await wait(200);
  check(host.state.settings.budget === 50, "настройки после старта не меняются");

  const late = await connect(room.code, { type: "join", name: "Опоздавший" });
  check(has(late, "error", (m) => m.error === "game_started"), "новый игрок после старта не входит");

  // пауза
  host.send({ type: "pause" });
  await until(() => host.state.paused);
  a.send({ type: "bid", amount: 1 });
  await until(() => has(a, "rejected"));
  check(has(a, "rejected", (m) => m.reason === "paused"), "ставка на паузе отклоняется");
  host.send({ type: "resume" });
  await until(() => !host.state.paused);

  // ставка и обрыв соединения игрока: он offline, но лот остаётся
  a.send({ type: "bid", amount: 2, expectedPrice: 0 });
  await until(() => host.state.price === 2);
  check(host.state.leaderId === a.me, "ставка принята, лидер Аня");
  b.ws.close();
  await until(() => host.state.players.find((p) => p.id === b.me)?.online === false);
  check(host.state.players.find((p) => p.id === b.me).online === false, "закрытый сокет → offline");

  // повторный вход по имени без токена во время игры
  const b2 = await connect(room.code, { type: "join", name: "Аня 2" });
  check(b2.me === b.me, "повторный вход по имени возвращает того же игрока");
  const b3 = await connect(room.code, { type: "join", name: "", token: b2.token });
  await until(() => has(b2, "replaced"));
  check(b3.me === b.me && has(b2, "replaced"), "второе устройство по токену заменяет первое");

  // вторая доска заменяет первую
  const host2 = await connect(room.code, { type: "host", token: room.hostToken });
  host2.send({ type: "pause" });
  await until(() => host2.state?.paused);
  check(host2.state.paused === true, "новая доска управляет игрой");
  host2.send({ type: "resume" });
  await until(() => !host2.state.paused);

  // кик
  host2.send({ type: "kick", playerId: b.me });
  await until(() => has(b3, "kicked"));
  check(has(b3, "kicked"), "кикнутый игрок получает kicked");
  await until(() => host2.state.phase === "finished");
  check(host2.state.phase === "finished" && host2.state.finishedReason === "not_enough_players", "остался один активный → игра завершена");

  // новая игра сохраняет активных игроков и сбрасывает деньги
  const c = await connect(room.code, { type: "join", name: "Аня 2" }); // после финала (lobby нет) — вход по имени offline-игрока
  host2.send({ type: "next_game", kind: "food" });
  await until(() => host2.state.phase === "lobby");
  check(host2.state.phase === "lobby" && host2.state.kind === "food", "next_game → лобби с новой категорией");
  check(host2.state.players.every((p) => p.money === 50 && p.lots.length === 0), "деньги и лоты сброшены");

  // новый игрок входит в лобби следующей игры
  const vitya = await connect(room.code, { type: "join", name: "Витя" });
  check(!!vitya.me, "в лобби после next_game входит новый игрок");

  // ---------- гонки: одновременные ставки ----------
  const make = async (settings, speed) =>
    (await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal", settings: { intro: 0, ...settings }, speed }) })).json());

  {
    const r2 = await make({ slots: 5, budget: 30, t1: 20000, t2: 5000 });
    const h2 = await connect(r2.code, { type: "host", token: r2.hostToken });
    const crowd = [];
    for (let i = 0; i < 10; i++) crowd.push(await connect(r2.code, { type: "join", name: "И" + i }));
    await until(() => h2.state?.players.length === 10, 10000);
    check(h2.state.players.length === 10, "10 игроков в комнате (лимит снят)");
    h2.send({ type: "start" });
    await until(() => h2.state.phase === "lot");
    check(h2.state.rounds === Math.ceil(10 * 5 * 1.25), `раундов = ceil(10×5×1.25) (${h2.state.rounds})`);
    // все десять ставят «$1» одновременно с одной и той же ожидаемой ценой
    for (const c of crowd) c.send({ type: "bid", amount: 1, expectedPrice: 0 });
    await until(() => h2.state.price === 1, 4000);
    await wait(400);
    check(h2.state.price === 1 && h2.state.bids.length === 1, `из десяти одновременных ставок принята одна (цена ${h2.state.price})`);
    const rejects = crowd.filter((c) => has(c, "rejected", (m) => m.reason === "price_changed" || m.reason === "too_low")).length;
    check(rejects === 9, `остальным девяти пришёл явный отказ (${rejects})`);
    check(crowd.every((c) => !has(c, "error")), "лишние ставки не ломают протокол");
    // ставка в момент истечения таймера: лот либо ушёл, либо ставка принята — но деньги списываются один раз
    const leader = h2.state.players.find((p) => p.id === h2.state.leaderId);
    await until(() => h2.state.phase === "sold" || h2.state.phase === "lot", 30000);
    const after = h2.state.players.find((p) => p.id === leader.id);
    check(after.money === 29 && after.lots.length === 1, `лот списан один раз ($${after.money}, лотов ${after.lots.length})`);
    // пропуск лота ведущим в разных фазах
    await until(() => h2.state.phase === "lot", 30000);
    const round = h2.state.round;
    crowd[0].send({ type: "bid", amount: 2 });
    await until(() => h2.state.phase === "bidding");
    h2.send({ type: "skip_lot" });
    await until(() => h2.state.phase === "sold", 4000);
    check(h2.state.phase === "sold", "skip_lot в ТОРГАХ отдаёт лот лидеру сразу");
    h2.send({ type: "skip_lot" });
    const moved = await until(() => h2.state.round === round + 1, 3000);
    check(moved, "skip_lot в фазе ПРОДАНО сразу выводит следующий лот");
    crowd[1].send({ type: "skip_lot" });
    await wait(300);
    check(h2.state.round === round + 1, "игрок не может пропустить лот");
    h2.send({ type: "end" });
    for (const c of crowd) c.ws.close();
    h2.ws.close();
  }

  // ---------- автопауза, когда все отвалились ----------
  {
    const r3 = await make({ slots: 3, budget: 20, t1: 5000, t2: 3000 });
    const h3 = await connect(r3.code, { type: "host", token: r3.hostToken });
    const x = await connect(r3.code, { type: "join", name: "Икс" });
    const y = await connect(r3.code, { type: "join", name: "Игрек" });
    await until(() => h3.state?.players.length === 2);
    h3.send({ type: "start" });
    await until(() => h3.state.phase !== "lobby");
    x.ws.close(); y.ws.close();
    const paused = await until(() => h3.state.paused, 20000);
    check(paused && h3.state.pausedAuto === true, "все игроки отвалились → автопауза, а не финал");
    check(h3.state.phase !== "finished", "партия не завершилась сама");
    const back = await connect(r3.code, { type: "join", name: "", token: x.token });
    check(back.me === x.me, "возврат по токену в ту же партию");
    const resumed = await until(() => !h3.state.paused, 6000);
    check(resumed, "возврат игрока снимает автопаузу");
    h3.send({ type: "end" });
    back.ws.close(); h3.ws.close();
  }

  // ---------- голосование закрывается по таймауту (speed ускоряет 30 с) ----------
  {
    const r4 = await make({ slots: 3, budget: 20, t1: 10000, t2: 3000, judge: "vote" }, 6);
    const h4 = await connect(r4.code, { type: "host", token: r4.hostToken });
    const v1 = await connect(r4.code, { type: "join", name: "Один" });
    const v2 = await connect(r4.code, { type: "join", name: "Два" });
    await until(() => h4.state?.players.length === 2);
    h4.send({ type: "start" });
    await until(() => h4.state.phase !== "lobby");
    for (const c of [v1, v2]) {
      const mine = () => h4.state.players.find((p) => p.id === c.me);
      await until(() => (h4.state.phase === "lot" || h4.state.phase === "bidding") && mine().canBid, 40000);
      c.send({ type: "bid", amount: h4.state.price + 1 });
      await until(() => mine().lots.length >= 1, 40000);
    }
    h4.send({ type: "end" });
    await until(() => h4.state.phase === "finished");
    check(await until(() => h4.state.voting, 5000), "судья = голосование → открылось голосование");
    v1.send({ type: "vote", for: v2.me });
    await until(() => h4.state.votes === 1, 4000);
    const closed = await until(() => h4.state.results, 40000); // 30 с голосования (при speed=1 — без ускорения)
    check(closed, "голосование закрывается по таймауту, даже если проголосовали не все");
    if (closed) {
      check(h4.state.results.mode === "vote" && h4.state.results.ranking.length === 2, "итоги голосования посчитаны для обоих");
      check(h4.state.results.ranking[0].playerId === v2.me, "выше тот, за кого голосовали");
      v2.send({ type: "vote", for: v1.me });
      await until(() => has(v2, "rejected"), 3000);
      check(has(v2, "rejected", (m) => m.reason === "closed"), "голос после подсчёта отклоняется");
    }
    v1.ws.close(); v2.ws.close(); h4.ws.close();
  }

  // ---------- заставка перед первым лотом ----------
  // Игра с настройками по умолчанию обязана начинаться с заставки: иначе задание никто не увидит.
  {
    const ri = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal", settings: { mode: "worst", intro: 2000 } }) })).json();
    const hi = await connect(ri.code, { type: "host", token: ri.hostToken });
    const i1 = await connect(ri.code, { type: "join", name: "И1" });
    const i2 = await connect(ri.code, { type: "join", name: "И2" });
    await until(() => hi.state && hi.state.players.length === 2);
    hi.send({ type: "start" });
    await until(() => hi.state.phase === "intro");
    check(hi.state.phase === "intro", `старт показывает заставку (${hi.state.phase})`);
    check(!hi.state.lot, "во время заставки лот не раскрыт — игроки не подглядят");
    check(i1.state.phase === "intro" && i1.state.settings.mode === "worst", "заставка и задание видны игроку");
    // ставка на заставке не проходит
    i1.send({ type: "bid", amount: 1 });
    await wait(300);
    check(has(i1, "rejected") || !hi.state.price, "ставка во время заставки не принимается");
    await until(() => hi.state.phase === "lot", 6000);
    check(hi.state.phase === "lot" && !!hi.state.lot, `после заставки открывается первый лот (${hi.state.phase})`);
    const left = hi.state.deadline - hi.state.serverNow;
    check(left > hi.state.settings.t1 - 1500, `первый лот получает полный таймер, заставка его не съела (${Math.round(left / 1000)} с)`);
    for (const c of [hi, i1, i2]) c.ws.close();
  }

  // ---------- задание и категория согласованы на всех путях, а не только в обработчике settings ----------
  // Иначе «лига суперзлодеев» доезжала до промпта судьи вместе с блюдами и городами.
  {
    const r5 = await make({ mode: "worst" }, 1); // kind = animal
    const h5 = await connect(r5.code, { type: "host", token: r5.hostToken });
    await until(() => h5.state);
    check(h5.state.settings.mode === "worst", "POST /rooms: доступное задание принято");

    const r6 = await (await fetch(BASE + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "food", settings: { mode: "villains" } }) })).json();
    const h6 = await connect(r6.code, { type: "host", token: r6.hostToken });
    await until(() => h6.state);
    check(h6.state.settings.mode === "base", `POST /rooms: задание не из этой категории сброшено (${h6.state.settings.mode})`);

    // смена категории без блока settings — задание обязано пересчитаться
    h5.send({ type: "settings", kind: "character", settings: { mode: "villains" } });
    await until(() => h5.state.settings.mode === "villains", 3000);
    check(h5.state.settings.mode === "villains", "villains выбирается для персонажей");
    h5.send({ type: "settings", kind: "city" });
    await until(() => h5.state.kind === "city", 3000);
    await wait(200);
    check(h5.state.settings.mode === "base", `одна категория без настроек тоже сбрасывает задание (${h5.state.settings.mode})`);

    // next_game с другой категорией
    h5.send({ type: "settings", kind: "character", settings: { mode: "villains" } });
    await until(() => h5.state.settings.mode === "villains", 3000);
    const g1 = await connect(r5.code, { type: "join", name: "Злодей" });
    const g2 = await connect(r5.code, { type: "join", name: "Подельник" });
    await until(() => h5.state.players.length === 2);
    h5.send({ type: "start" });
    await until(() => h5.state.phase !== "lobby");
    h5.send({ type: "end" });
    await until(() => h5.state.phase === "finished");
    h5.send({ type: "next_game", kind: "city" });
    await until(() => h5.state.phase === "lobby", 3000);
    check(h5.state.kind === "city" && h5.state.settings.mode === "base", `next_game со сменой категории сбрасывает задание (${h5.state.kind}/${h5.state.settings.mode})`);
    h5.send({ type: "next_game" });
    await until(() => h5.state.phase === "lobby", 3000);
    check(h5.state.settings.mode === "base", "next_game без категории задание не портит");
    g1.ws.close(); g2.ws.close(); h5.ws.close(); h6.ws.close();
  }

  // health и неизвестная комната
  const h = await (await fetch(BASE + "/auction/api/health")).json();
  check(h.ok === true, "health ok");
  const nope = await fetch(BASE + "/auction/api/session?r=ZZZZ");
  check(nope.status === 404, "сессия для несуществующей комнаты → 404");

  // ---------- лимиты против DoS (отдельный дочерний сервер с крошечными потолками) ----------
  await limitsSuite();

  // ---------- дамп и восстановление партии (свой инстанс со своим файлом) ----------
  await dumpSuite();

  // ---------- TTL комнаты (свой инстанс с TTL 2 с) ----------
  await ttlSuite();

  console.log(failures ? `FAILURES: ${failures}` : "SERVER TESTS OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });

// Поднимаем свой инстанс с маленькими лимитами, чтобы проверить защиту от исчерпания ресурсов
// быстро и не засоряя общий dev-сервер сотнями комнат/сокетов.
async function limitsSuite() {
  const { spawn } = require("child_process");
  const path = require("path");
  const PORT = 3400 + Math.floor(Math.random() * 300);
  const B = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "development",
      MAX_ROOMS: "6", MAX_ROOMS_PER_IP: "3", MAX_SOCKETS_PER_ROOM: "4", EVICT_GRACE_MS: "0",
      DUMP_FILE: path.join(require("os").tmpdir(), `limits-${PORT}.json`) },
    stdio: "ignore",
  });
  try {
    // ждём, пока поднимется
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(B + "/auction/api/health")).ok; } catch { await wait(100); } }
    check(up, "лимит-сервер поднялся");
    const mk = (ip, headers = {}) => fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json", ...(ip ? { "X-Real-IP": ip } : {}), ...headers }, body: JSON.stringify({ kind: "animal" }) });
    const wsUrl = (code) => B.replace(/^http/, "ws") + "/auction/ws?r=" + code;
    const roomsOf = async (ip) => (await (await fetch(B + "/auction/api/health")).json()).rooms;

    // 1) лимит комнат на адрес (потолок 3): создавать можно и дальше, но брошенные комнаты
    //    этого же адреса вытесняются — griefer не копит комнаты, а игрок с переигровками не ловит отказ
    const before = await roomsOf();
    let ok = 0;
    for (let i = 0; i < 6; i++) { const r = await mk("1.1.1.1"); if (r.ok) ok++; }
    const grew = (await roomsOf()) - before;
    check(ok === 6 && grew === 3, `адрес держит не больше 3 комнат (создано ${ok}, комнат прибавилось ${grew})`);

    // 1b) если все комнаты адреса живые (есть соединение), вытеснять нечего — отказ
    const live = [];
    for (let i = 0; i < 3; i++) {
      const r = await (await mk("5.5.5.5")).json();
      if (r.code) { const ws = new WebSocket(wsUrl(r.code)); await new Promise((d) => { ws.on("open", d); ws.on("error", d); }); live.push(ws); }
    }
    await wait(150);
    const refused = await mk("5.5.5.5");
    check(!refused.ok && /this address/.test((await refused.json()).error || ""), "адрес с живыми комнатами получает отказ, а не вытесняет чужое");
    for (const ws of live) ws.close();

    // 1c-1d) подделка заголовков не обходит лимит. Меряем не числом комнат (в него вмешивается
    //        общий потолок процесса), а отказом: занимаем лимит живыми комнатами и просим ещё одну,
    //        каждый раз меняя тот заголовок, который клиент мог бы подделать.
    const holdAndRetry = async (headersFor) => {
      const held = [];
      for (let i = 0; i < 3; i++) {
        const r = await (await fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json", ...headersFor(i) }, body: JSON.stringify({ kind: "animal" }) })).json();
        if (r.code) { const ws = new WebSocket(wsUrl(r.code)); await new Promise((d) => { ws.on("open", d); ws.on("error", d); }); held.push(ws); }
      }
      await wait(150);
      const extra = await fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json", ...headersFor(99) }, body: JSON.stringify({ kind: "animal" }) });
      const body = extra.ok ? {} : await extra.json();
      for (const ws of held) ws.close();
      await wait(150);
      return { ok: extra.ok, error: body.error || "" };
    };
    // доверенный X-Real-IP один и тот же, подделан только X-Forwarded-For → лимит всё равно упирается
    const spoofXff = await holdAndRetry((i) => ({ "X-Real-IP": "7.7.7.7", "X-Forwarded-For": `fake-${i}.evil, 9.1.1.${i}` }));
    check(!spoofXff.ok && /this address/.test(spoofXff.error), "подделка X-Forwarded-For не обходит лимит при доверенном X-Real-IP");
    // без X-Real-IP (один прокси перед нами) считаем по хвосту X-Forwarded-For — его дописывает прокси
    const tailXff = await holdAndRetry((i) => ({ "X-Forwarded-For": `fake-${i}.evil, 8.8.8.8` }));
    check(!tailXff.ok && /this address/.test(tailXff.error), "без X-Real-IP лимит считается по хвосту X-Forwarded-For");
    // мусор вместо адреса не создаёт «новый адрес» на каждый запрос
    const junk = await holdAndRetry(() => ({ "X-Real-IP": "not-an-ip", "X-Forwarded-For": "also-not-an-ip" }));
    check(!junk.ok && /this address/.test(junk.error), "нечисловые заголовки не создают новый адрес на каждый запрос");

    // 2) вытеснение самой старой пустой комнаты вместо отказа: добиваем до MAX_ROOMS с разных IP,
    //    затем ещё одна с нового адреса — должна пройти (пустые комнаты без сокетов вытесняются)
    for (let i = 0; i < 40; i++) { await mk("2.0.0." + i); } // каждый IP — своя комната, лимит на IP не мешает
    const full = await (await fetch(B + "/auction/api/health")).json();
    check(full.rooms === 6, `процесс упёрся в MAX_ROOMS (${full.rooms})`);
    const evicted = await mk("9.9.9.9");
    check(evicted.ok, "при переполнении новая комната вытесняет старую пустую, а не получает отказ");
    const after = await (await fetch(B + "/auction/api/health")).json();
    check(after.rooms === 6, `число комнат не превышает MAX_ROOMS (${after.rooms})`);

    // 3) потолок соединений на комнату (=4): 8 WebSocket → лишние отклоняются
    const rm = await (await mk("3.3.3.3")).json(); // 3.3.3.3 ещё не набрал лимит комнат
    if (rm.code) {
      let opened = 0, refused = 0;
      await new Promise((done) => { let s = 0, N = 8; for (let i = 0; i < N; i++) { const ws = new WebSocket(wsUrl(rm.code)); ws.on("open", () => { opened++; if (++s >= N) done(); }); ws.on("error", () => { refused++; if (++s >= N) done(); }); } setTimeout(done, 4000); });
      check(opened > 0 && opened <= 4 && refused >= 1, `на комнату не больше 4 сокетов (открыто ${opened}, отклонено ${refused})`);

      // 4) слишком большое сообщение (>8 КБ) рвёт соединение, не попадая в обработчик
      const closed = await new Promise((done) => { const ws = new WebSocket(wsUrl(rm.code)); ws.on("open", () => ws.send(JSON.stringify({ type: "join", name: "x".repeat(20000) }))); ws.on("close", () => done(true)); ws.on("error", () => {}); setTimeout(() => done(false), 3000); });
      check(closed, "сообщение больше 8 КБ обрывает сокет");
    } else {
      check(false, "не удалось создать комнату для теста сокетов");
    }

    // 5) сервер жив после всех атак
    const alive = await (await fetch(B + "/auction/api/health")).json();
    check(alive.ok === true, "сервер жив после флуда комнат/сокетов");
  } finally {
    child.kill("SIGKILL");
  }
}

// Дамп партии: колода уходит в файл номерами карт, а не карточками. Это не косметика — при
// сохранении колод целиком дамп 100 комнат весил 30 МБ и разгонял RSS до 400 МБ при mem_limit 256m,
// то есть контейнер убивало ядро, а restore поднимал то же состояние и убивало снова.
// Тест держит три вещи: формат компактен, порядок лотов при перезапуске не меняется,
// дамп прежнего формата (колода целиком) всё ещё читается — иначе деплой терял бы живые партии.
async function dumpSuite() {
  const { spawn } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const PORT = 3700 + Math.floor(Math.random() * 200);
  const B = `http://127.0.0.1:${PORT}`;
  const DUMP = path.join(os.tmpdir(), `dump-suite-${PORT}.json`);
  fs.rmSync(DUMP, { force: true });
  const boot = () => spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", DUMP_FILE: DUMP }, stdio: "ignore",
  });
  const up = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(B + "/auction/api/health")).ok) return true; } catch {} await wait(100); } return false; };
  let child = boot();
  try {
    if (!(await up())) return check(false, "дамп-сервер поднялся");
    const r = await (await fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "artist", settings: { judge: "vote" } }) })).json();
    // дамп идёт раз в 5 с
    const dumped = await until(() => fs.existsSync(DUMP) && fs.statSync(DUMP).size > 2, 9000);
    if (!dumped) return check(false, "дамп записался");
    await wait(300);
    const one = JSON.parse(fs.readFileSync(DUMP, "utf8"))[0];
    check(Array.isArray(one.state.deckIdx) && one.state.deck === null, "колода сохранена номерами карт, а не карточками");
    const kb = fs.statSync(DUMP).size / 1024;
    check(kb < 25, `дамп одной комнаты ${kb.toFixed(1)} КБ (колодой целиком было бы ~305 КБ)`);
    const cards = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "artist.json"), "utf8"));
    check(new Set(one.state.deckIdx).size === cards.length, `в колоде все ${cards.length} карт и без повторов`);
    const orderBefore = one.state.deckIdx.join(",");

    // перезапуск: комната и порядок лотов должны уцелеть
    child.kill("SIGTERM");
    await wait(1200);
    child = boot();
    if (!(await up())) return check(false, "дамп-сервер поднялся после перезапуска");
    const h = await (await fetch(B + "/auction/api/health")).json();
    check(h.rooms === 1, "комната пережила перезапуск");
    const again = await until(() => { try { return JSON.parse(fs.readFileSync(DUMP, "utf8"))[0]?.state?.deckIdx; } catch { return false; } }, 9000);
    check(again, "восстановленная комната снова дампится");
    const two = JSON.parse(fs.readFileSync(DUMP, "utf8"))[0];
    check(two.state.deckIdx.join(",") === orderBefore, "порядок лотов после перезапуска не изменился");
    check(two.code === r.code, "код комнаты не изменился — QR на экране остаётся рабочим");

    // дамп прежнего формата: колода карточками, без deckIdx
    child.kill("SIGTERM");
    await wait(1000);
    const legacyState = { ...two.state, deck: two.state.deckIdx.map((i) => cards[i]) };
    delete legacyState.deckIdx;
    fs.writeFileSync(DUMP, JSON.stringify([{ code: "OLDF", ip: "", hostToken: "h", tokens: {}, touched: Date.now(), state: legacyState }]));
    child = boot();
    if (!(await up())) return check(false, "дамп-сервер поднялся на старом формате");
    const h2 = await (await fetch(B + "/auction/api/health")).json();
    check(h2.rooms === 1, "дамп прежнего формата читается — деплой не теряет идущую партию");
  } finally {
    child.kill("SIGKILL");
    try { require("fs").rmSync(DUMP, { force: true }); } catch {}
  }
}

// TTL комнаты не должен убивать комнату, на которой открыта доска. В лобби и финале игровых
// событий нет, room.touched двигают только сообщения — и комната с кодом на большом экране
// умирала через 30 минут ожидания гостей вместе с QR. Брошенные комнаты при этом обязаны убираться,
// иначе лимит MAX_ROOMS запирается мусором. Здесь TTL 2 с, чтобы проверка шла секунды, а не полчаса.
async function ttlSuite() {
  const { spawn } = require("child_process");
  const path = require("path");
  const os = require("os");
  const PORT = 3900 + Math.floor(Math.random() * 90);
  const B = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", ROOM_TTL_MS: "2000",
      DUMP_FILE: path.join(os.tmpdir(), `ttl-${PORT}.json`) },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(B + "/auction/api/health")).ok; } catch { await wait(100); } }
    if (!up) return check(false, "TTL-сервер поднялся");
    const mk = async () => (await (await fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal" }) })).json());
    const held = await mk();
    await mk(); // эту никто не открывает
    const ws = new WebSocket(B.replace(/^http/, "ws") + "/auction/ws?r=" + held.code);
    let expired = false;
    ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "error" && m.error === "room_expired") expired = true; });
    ws.on("error", () => {});
    await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ type: "host", token: held.hostToken })); r(); }); setTimeout(r, 3000); });
    await wait(6500); // больше трёх TTL
    check(!expired, "комната с открытой доской переживает TTL в лобби — код на экране остаётся живым");
    const h = await (await fetch(B + "/auction/api/health")).json();
    check(h.rooms === 1, `брошенная комната убрана по TTL, открытая осталась (комнат ${h.rooms})`);
    ws.close();
  } finally {
    child.kill("SIGKILL");
  }
}
