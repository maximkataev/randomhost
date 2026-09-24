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
  // Короткий обрыв больше не событие партии: в пределах грации игрок числится на связи, и вернувшийся
  // телефон не оставляет следов. Раньше тут ждали немедленного offline — и любое моргание Wi-Fi
  // ставило партию на авто-паузу, снять которую мог только ведущий. Полный цикл — в graceSuite().
  await wait(1200);
  check(host.state.players.find((p) => p.id === b.me).online === true, "короткий обрыв не выбрасывает игрока сразу");

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
    // вернулся один из двух — торговаться ему не с кем, пауза держится; вернулись оба — снимается сама
    await wait(1200);
    check(!!h3.state.paused, "на связи один из двух — авто-пауза держится");
    const back2 = await connect(r3.code, { type: "join", name: "", token: y.token });
    const resumed = await until(() => !h3.state.paused, 6000);
    check(back2.me === y.me && resumed, "вернулись оба — авто-пауза снялась сама");
    h3.send({ type: "end" });
    back.ws.close(); back2.ws.close(); h3.ws.close();
  }

  // ---------- соло-добор: свободные слоты остались у одного (§6.5) ----------
  {
    // speed=2: фаза ДОБОРА — фиксированные 10 с, без ускорения блок шёл бы минуты; сильнее ускорять
    // нельзя — таймер начнёт срабатывать раньше, чем до сервера доедет нажатие, и тест станет гадать
    const r7 = await make({ slots: 3, budget: 20, t1: 4000, t2: 3000 }, 2); // 3 — минимум слотов
    const h7 = await connect(r7.code, { type: "host", token: r7.hostToken });
    const one = await connect(r7.code, { type: "join", name: "Один" });
    const two = await connect(r7.code, { type: "join", name: "Два" });
    await until(() => h7.state?.players.length === 2);
    h7.send({ type: "start" });
    await until(() => h7.state.phase !== "lobby");
    const lots = () => h7.state.players.find((p) => p.id === one.me).lots.length;
    const toDraft = async (ms = 25000) => until(() => h7.state.phase === "draft", ms);

    two.ws.close(); // второй ушёл — торговаться не с кем: авто-пауза, продолжать без него решает ведущий
    await until(() => h7.state.players.find((p) => p.id === two.me).online === false, 20000); // грация
    check(!!h7.state.paused && h7.state.pausedAuto, "отвал одного из двух ставит авто-паузу");
    h7.send({ type: "resume" });
    check(await toDraft(), `остался один со свободными слотами → фаза ДОБОР (${h7.state.phase})`);
    check(!!h7.state.solo && h7.state.solo.playerId === one.me && h7.state.solo.skips === 5, "в снимке есть кто добирает и сколько скипов");
    check(h7.state.t4 === 10000, `T4 = 10 с приходит в снимке (${h7.state.t4})`);
    check(h7.state.players.find((p) => p.id === one.me).canDraft === true, "у добирающего есть canDraft");

    one.send({ type: "skip" });
    check(await until(() => h7.state.solo && h7.state.solo.skips === 4, 5000), "скип списывает счётчик и уводит лот в отбой");
    await toDraft();
    const before = h7.state.players.find((p) => p.id === one.me).money;
    one.send({ type: "take" });
    check(await until(() => lots() === 1, 5000), "«Взять» отдаёт лот бесплатно");
    check(h7.state.players.find((p) => p.id === one.me).money === before, "деньги за лот в доборе не списались");
    check(await toDraft(), "следующий лот добора");
    check(h7.state.solo.skips === 5, `после взятия счётчик снова полный (${h7.state.solo.skips})`);

    // вернулся второй игрок — соло-добор выключается прямо на этом лоте
    const back = await connect(r7.code, { type: "join", name: "", token: two.token });
    check(back.me === two.me, "второй вернулся по токену");
    check(await until(() => h7.state.phase === "lot" && !h7.state.solo, 5000), `добирающих снова двое → обычный аукцион (${h7.state.phase})`);

    // и снова уходит: добираем остаток через обязательный лот
    back.ws.close();
    await until(() => h7.state.players.find((p) => p.id === two.me).online === false, 20000);
    check(await until(() => h7.state.paused, 5000), "второй уход — снова авто-пауза");
    h7.send({ type: "resume" });
    check(await toDraft(), "ведущий продолжил — добор включается заново");
    // Скипаем, пока счётчик не обнулится. Считаем лоты, а не итерации: истёкший таймер — тоже
    // скип, и на медленной машине счётчик может списать он, а не нажатие.
    let lotsSeen = 0, must = false;
    while (lotsSeen < 8) {
      if (!(await toDraft())) break;
      lotsSeen++;
      const solo = h7.state.solo;
      if (!solo) break;
      if (solo.skips === 0) { must = true; break; } // это и есть обязательный лот
      one.send({ type: "skip" });
      await until(() => h7.state.phase !== "draft" || (h7.state.solo && h7.state.solo.skips < solo.skips), 6000);
    }
    check(must && lotsSeen === 6, `на слот ушло шесть лотов: пять скипов и обязательный (${lotsSeen})`);
    one.send({ type: "skip" });
    check(await until(() => has(one, "rejected", (m) => m.action === "skip" && m.reason === "must_take"), 4000), "шестой лот скипнуть нельзя — сервер отвечает must_take");
    check(await until(() => lots() === 2, 20000), "истёкший таймер на обязательном лоте берёт лот за игрока");
    // остаток слотов добираем руками — партия обязана закончиться сама, без «раундов»
    for (let i = 0; i < 4 && lots() < h7.state.settings.slots; i++) {
      if (!(await toDraft())) break;
      const was = lots();
      one.send({ type: "take" });
      await until(() => lots() > was, 6000);
    }
    check(lots() === h7.state.settings.slots, `лайнап собран добором (${lots()}/${h7.state.settings.slots})`);
    // Свободные слоты остались только у отключённого «Два»: это не «все собрали» — ждём его (§7.4),
    // а не заканчиваем с all_full, как раньше (M7). Ведущий может закончить сам.
    check(await until(() => h7.state.paused && h7.state.pausedFor === two.me, 15000), `слоты остались у отключённого — «Ждём Два» (${h7.state.phase}/${h7.state.pausedFor})`);
    h7.send({ type: "end" });
    check(await until(() => h7.state.phase === "finished" && !h7.state.paused, 5000), "«Завершить» на паузе — финал без оверлея паузы (H5)");
    one.ws.close(); h7.ws.close();
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

  // ---------- регрессии из QA-отчёта ----------
  {
    const r = await make({ slots: 3, budget: 20, t1: 20000, t2: 5000 });
    const h = await connect(r.code, { type: "host", token: r.hostToken });
    // H1: повторный join на том же соединении (ретрай POST, двойной тап) — тот же игрок, а не зомби
    const a = await connect(r.code, { type: "join", name: "Дубль" });
    a.send({ type: "join", name: "Дубль" });
    a.send({ type: "join", name: "Другой", token: null });
    await wait(400);
    const joins = a.msgs.filter((m) => m.type === "joined");
    check(h.state.players.length === 1 && joins.length === 3 && joins.every((m) => m.playerId === a.me && m.token === a.token), `повторный join на соединении не создаёт второго игрока (игроков ${h.state.players.length})`);
    // M8: вход без токена с тем же именем после обрыва в лобби — тот же игрок, без «призрака»
    const b = await connect(r.code, { type: "join", name: "Боря" });
    b.ws.close();
    await wait(300);
    const b2 = await connect(r.code, { type: "join", name: "Боря" });
    check(b2.me === b.me && h.state.players.length === 2, `в лобби вход по имени подхватывает отключённого, а не плодит «Боря 2» (${h.state.players.map((p) => p.name)})`);
    // M9: токен выгнанного в лобби — не фантом, а на ввод имени
    b2.ws.close();
    h.send({ type: "kick", playerId: b2.me });
    await until(() => h.state.players.length === 1);
    const b3 = await connect(r.code, { type: "join", name: "", token: b2.token });
    check(has(b3, "error", (m) => m.error === "token_gone") && !b3.me && h.state.players.length === 1, "токен выгнанного игрока → token_gone, фантом не входит");
    // H9: вторая доска забирает управление — первая об этом узнаёт
    const h2 = await connect(r.code, { type: "host", token: r.hostToken });
    check(await until(() => has(h, "host_lost"), 2000), "прежняя доска получает host_lost");
    const c = await connect(r.code, { type: "join", name: "Вера" });
    await until(() => h2.state.players.length === 2);
    h2.send({ type: "start" });
    await until(() => h2.state.phase === "lot");
    const round = h2.state.round;
    // H7: действия с устаревшим round не применяются к новому лоту
    a.send({ type: "bid", amount: 1, expectedPrice: 0, round: round + 1 });
    await until(() => has(a, "rejected", (m) => m.action === "bid"), 2000);
    check(has(a, "rejected", (m) => m.action === "bid" && m.reason === "closed") && h2.state.price === 0, "ставка на чужой (устаревший) лот отклоняется как closed");
    c.send({ type: "take", round: round - 1 });
    c.send({ type: "skip", round: round - 1 });
    await until(() => has(c, "rejected", (m) => m.action === "skip"), 2000);
    check(has(c, "rejected", (m) => m.action === "take" && m.reason === "closed") && has(c, "rejected", (m) => m.action === "skip" && m.reason === "closed"), "take/skip с чужим round → closed");
    h2.send({ type: "skip_lot", round: round + 3 });
    await wait(300);
    check(h2.state.round === round && h2.state.phase === "lot", "устаревший skip_lot ведущего лот не трогает");
    a.send({ type: "bid", amount: 1, expectedPrice: 0, round });
    await until(() => h2.state.price === 1, 2000);
    check(h2.state.leaderId === a.me, "ставка с верным round принимается");
    // H5 + M4: «Завершить» на паузе → финал без паузы; лайнап у одного — режим single без «100»
    h2.send({ type: "skip_lot", round });
    await until(() => h2.state.phase === "sold", 3000);
    h2.send({ type: "pause" });
    await until(() => h2.state.paused);
    h2.send({ type: "end" });
    await until(() => h2.state.phase === "finished" && h2.state.results, 5000);
    check(h2.state.paused === false, "финал снимает паузу — голосование и итоги не под оверлеем");
    check(h2.state.results && h2.state.results.mode === "single" && h2.state.results.ranking.length === 1 && h2.state.results.ranking[0].score == null,
      `один лайнап → режим single без очков (${JSON.stringify(h2.state.results && { m: h2.state.results.mode, s: h2.state.results.ranking.map((x) => x.score) })})`);
    check(!h2.state.players.some((p) => p.lots.some((l) => "meta" in l)), "в снимке лоты игроков без meta — state легче");
    for (const x of [h, h2, a, c]) x.ws.close();
  }

  // M3: голос выгнанного не считается; уход последнего непроголосовавшего закрывает голосование
  {
    const r = await make({ slots: 3, budget: 20, t1: 5000, t2: 3000, judge: "vote" }, 6);
    const h = await connect(r.code, { type: "host", token: r.hostToken });
    const vs = [];
    for (const n of ["В1", "В2", "В3", "В4"]) vs.push(await connect(r.code, { type: "join", name: n }));
    await until(() => h.state?.players.length === 4);
    h.send({ type: "start" });
    await until(() => h.state.phase !== "lobby");
    for (const c of vs) {
      const mine = () => h.state.players.find((p) => p.id === c.me);
      await until(() => (h.state.phase === "lot" || h.state.phase === "bidding") && mine().canBid && !h.state.leaderId, 40000);
      c.send({ type: "bid", amount: h.state.price + 1, round: h.state.round });
      await until(() => mine().lots.length >= 1, 40000);
    }
    h.send({ type: "end" });
    await until(() => h.state.voting, 8000);
    vs[3].send({ type: "vote", for: vs[0].me });
    await until(() => h.state.votes === 1, 3000);
    check(vs[3].state.voted && vs[3].state.voted.includes(vs[3].me), "в снимке есть, кто уже проголосовал (пульт держит ✓)");
    h.send({ type: "kick", playerId: vs[3].me });
    await until(() => h.state.players.find((p) => p.id === vs[3].me).left, 3000);
    check(h.state.votes === 0 && !h.state.results, `голос выгнанного не в счёт и голосование не закрылось (голосов ${h.state.votes})`);
    vs[0].send({ type: "vote", for: vs[1].me });
    vs[1].send({ type: "vote", for: vs[0].me });
    await until(() => h.state.votes === 2, 3000);
    check(!h.state.results, "двое из трёх проголосовали — ждём третьего");
    h.send({ type: "kick", playerId: vs[2].me });
    check(await until(() => !!h.state.results, 3000), "ушёл последний непроголосовавший — итоги сразу, без 30 с ожидания");
    for (const x of [h, ...vs]) x.ws.close();
  }

  // ---------- M29: ведущий играет с телефона (§10.4) ----------
  // Пульт с хост-токеном получает права ведущего на своём соединении, доска при этом остаётся
  // в управлении (никакого host_lost), а игрок без токена управлять не может.
  {
    const r = await make({ slots: 3, budget: 20, t1: 20000, t2: 5000 });
    const h = await connect(r.code, { type: "host", token: r.hostToken });
    const a = await connect(r.code, { type: "join", name: "Ведущий" });
    const b = await connect(r.code, { type: "join", name: "Боб" });
    const c = await connect(r.code, { type: "join", name: "Кира" });
    a.send({ type: "host", token: r.hostToken, remote: true });
    b.send({ type: "host", token: "wrong", remote: true });
    await until(() => has(a, "host_ok") && has(b, "host_denied"), 2000);
    check(has(a, "host_ok", (m) => m.remote) && !has(h, "host_lost"), "пульт с хост-токеном получает права ведущего, доска их не теряет");
    check(has(b, "host_denied") && !b.closed && !has(b, "error"), "чужой токен с пульта → host_denied, соединение игрока живо");
    b.send({ type: "start" });
    await wait(300);
    check(h.state.phase === "lobby", "игрок без токена не стартует игру");
    await until(() => h.state.players.every((p) => p.online));
    a.send({ type: "start" });
    check(await until(() => h.state.phase === "lot", 3000), "ведущий с пульта стартует игру");
    b.send({ type: "pause" });
    b.send({ type: "end" });
    b.send({ type: "kick", playerId: c.me });
    b.send({ type: "skip_lot", round: h.state.round });
    await wait(400);
    check(!h.state.paused && h.state.phase === "lot" && h.state.round === 0 && !h.state.players.find((p) => p.id === c.me).left, "пауза/завершение/кик/пропуск от игрока без прав игнорируются");
    a.send({ type: "pause" });
    await until(() => h.state.paused, 2000);
    check(h.state.paused && !h.state.pausedAuto, "ведущий с пульта ставит паузу");
    h.send({ type: "resume" });
    await until(() => !h.state.paused, 2000);
    check(!h.state.paused, "доска по-прежнему управляет (снимает паузу ведущего с пульта)");
    a.send({ type: "skip_lot", round: h.state.round });
    check(await until(() => h.state.round === 1 || h.state.phase === "unsold", 3000), "ведущий с пульта пропускает лот");
    // H9 не сломан: вторая доска забирает управление у первой, пульт ведущего права сохраняет
    const h2 = await connect(r.code, { type: "host", token: r.hostToken });
    await until(() => has(h, "host_lost"), 2000);
    check(has(h, "host_lost") && !has(a, "host_lost"), "вторая доска отбирает права у первой доски, но не у пульта ведущего");
    a.send({ type: "kick", playerId: a.me });
    await wait(300);
    check(!h2.state.players.find((p) => p.id === a.me).left, "ведущий с пульта не выгоняет сам себя");
    a.send({ type: "kick", playerId: c.me });
    await until(() => has(c, "kicked"), 2000);
    check(has(c, "kicked") && h2.state.players.find((p) => p.id === c.me).left, "ведущий с пульта выгоняет игрока");
    // права живут на соединении: после переподключения без повторного host их нет
    a.ws.close();
    const a2 = await connect(r.code, { type: "join", name: "", token: a.token });
    a2.send({ type: "end" });
    await wait(300);
    check(h2.state.phase !== "finished", "новое соединение без запроса host прав ведущего не имеет");
    a2.send({ type: "host", token: r.hostToken, remote: true });
    await until(() => has(a2, "host_ok"), 2000);
    a2.send({ type: "end" });
    check(await until(() => h2.state.phase === "finished", 3000), "ведущий с пульта завершает игру");
    for (const x of [h, h2, a2, b, c]) x.ws.close();
  }

  // ---------- M16: state без повторов тяжёлых частей ----------
  // Клиент с d=1 получает настройки/лот/лоты игроков только при изменении и собирает полный снимок
  // сам (auctionMergeState из auction-shared.js). Проверяем, что собранное состояние совпадает
  // с полным снимком на всём протяжении партии с ботами — по WebSocket, по long-polling и после
  // переподключения, и что трафик действительно меньше.
  await deltaSuite(make);

  // health и неизвестная комната
  const h = await (await fetch(BASE + "/auction/api/health")).json();
  check(h.ok === true, "health ok");
  const nope = await fetch(BASE + "/auction/api/session?r=ZZZZ");
  check(nope.status === 404, "сессия для несуществующей комнаты → 404");

  // ---------- лимиты против DoS (отдельный дочерний сервер с крошечными потолками) ----------
  await limitsSuite();
  await anonIpSuite();

  // ---------- дамп и восстановление партии (свой инстанс со своим файлом) ----------
  await dumpSuite();

  // ---------- TTL комнаты (свой инстанс с TTL 2 с) ----------
  await ttlSuite();
  await graceSuite();
  await pingTtlSuite();
  await shutdownSuite();

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
    let expired = false, expiredReason = null;
    ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "error") { expiredReason = m.error; if (m.error === "room_expired") expired = true; } });
    ws.on("error", () => {});
    await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ type: "host", token: held.hostToken })); r(); }); setTimeout(r, 3000); });
    await wait(6500); // больше трёх TTL
    check(expired, "лобби, в котором ничего не происходит, закрывается по TTL даже с открытой доской");
    check(/room_expired/.test(String(expiredReason || "")), `игроку сказано, почему комната закрылась (${expiredReason})`);
    const h = await (await fetch(B + "/auction/api/health")).json();
    check(h.rooms === 0, `брошенные и простаивающие комнаты убраны (комнат ${h.rooms})`);
    ws.close();

    // а вот идущая партия по TTL умирать не должна: на паузе и в разборе игровых тиков нет,
    // и без этого игра распадалась бы под людьми, которые просто задумались над ставкой
    const live = await mk();
    const hostWs = new WebSocket(B.replace(/^http/, "ws") + "/auction/ws?r=" + live.code);
    let liveExpired = false;
    hostWs.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "error" && m.error === "room_expired") liveExpired = true; });
    hostWs.on("error", () => {});
    await new Promise((r) => { hostWs.on("open", () => { hostWs.send(JSON.stringify({ type: "host", token: live.hostToken })); r(); }); setTimeout(r, 3000); });
    const pl = [];
    for (let i = 0; i < 2; i++) {
      const w = new WebSocket(B.replace(/^http/, "ws") + "/auction/ws?r=" + live.code);
      await new Promise((r) => { w.on("open", () => { w.send(JSON.stringify({ type: "join", name: "И" + i })); r(); }); w.on("error", r); setTimeout(r, 2000); });
      pl.push(w);
    }
    await wait(300);
    hostWs.send(JSON.stringify({ type: "start" }));
    await wait(500);
    hostWs.send(JSON.stringify({ type: "pause" }));
    await wait(6500); // больше трёх TTL на паузе
    check(!liveExpired, "партия на паузе с подключёнными игроками по TTL не закрывается");
    hostWs.close(); for (const w of pl) w.close();
  } finally {
    child.kill("SIGKILL");
  }
}

// ---------- грация обрыва и авто-снятие авто-паузы ----------
// Вечеринка на восьми телефонах — это постоянные микрообрывы: Wi-Fi переключается, браузер
// притормаживает. Пока игрока объявляли выпавшим мгновенно, каждый такой обрыв ставил партию
// на авто-паузу, а снять её мог только ведущий с доски: две секунды сети стоили всем минуту.
// Здесь грация 800 мс, чтобы проверка шла секунды.
async function graceSuite() {
  const { spawn } = require("child_process");
  const path = require("path");
  const os = require("os");
  const PORT = 3700 + Math.floor(Math.random() * 90);
  const B = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", OFFLINE_GRACE_MS: "800",
      DUMP_FILE: path.join(os.tmpdir(), `grace-${PORT}.json`) },
    stdio: "ignore",
  });
  const sock = (code, first) => new Promise((res) => {
    const ws = new WebSocket(B.replace(/^http/, "ws") + "/auction/ws?r=" + code);
    const c = { ws, send: (m) => ws.send(JSON.stringify(m)) };
    ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.state) c.state = m.state; if (m.type === "joined") { c.me = m.playerId; c.token = m.token; } });
    ws.on("error", () => {});
    ws.on("open", () => { ws.send(JSON.stringify(first)); setTimeout(() => res(c), 250); });
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(B + "/auction/api/health")).ok; } catch { await wait(100); } }
    if (!up) return check(false, "сервер грации поднялся");
    const room = await (await fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal", settings: { intro: 0 } }) })).json();
    const h = await sock(room.code, { type: "host", token: room.hostToken });
    const x = await sock(room.code, { type: "join", name: "Икс" });
    const y = await sock(room.code, { type: "join", name: "Игрек" });
    await until(() => h.state?.players.length === 2);
    h.send({ type: "start" });
    await until(() => h.state.phase !== "lobby");

    // 1. Моргнувшая сеть: вернулся в пределах грации — партия даже не узнала
    y.ws.close();
    await wait(200);
    const y2 = await sock(room.code, { type: "join", name: "Игрек", token: y.token });
    await wait(1400); // заведомо больше грации: если бы таймер не сняли, пауза бы уже встала
    check(y2.me === y.me, "возврат в пределах грации — та же партия");
    check(!h.state.paused, "моргнувшая сеть не ставит партию на паузу");

    // 2. Ушёл насовсем: после грации — offline. В партии на двоих торговаться больше не с кем —
    // авто-пауза.
    y2.ws.close();
    const dropped = await until(() => h.state.players.find((p) => p.id === y.me)?.online === false, 6000);
    check(dropped, "не вернувшийся за грацию игрок объявлен offline");
    check(!!h.state.paused && h.state.pausedAuto === true, "выпал один из двух — авто-пауза");

    // 3. Вернулся — авто-пауза снимается сама, без ведущего
    const y3 = await sock(room.code, { type: "join", name: "Игрек", token: y.token });
    const resumed = await until(() => !h.state.paused, 6000);
    check(y3.me === y.me && resumed, "вернулся — авто-пауза снялась сама, ведущий не нужен");
    const x2 = x;

    // 4. Ручную паузу ведущего возврат игрока не снимает: её ставили осознанно
    h.send({ type: "pause" });
    await until(() => h.state.paused);
    y3.ws.close();
    await until(() => h.state.players.find((p) => p.id === y.me)?.online === false, 6000);
    const y4 = await sock(room.code, { type: "join", name: "Игрек", token: y.token });
    await wait(1200);
    check(!!h.state.paused, "ручную паузу ведущего возврат игрока не снимает");

    // 5. Пока доска жива, управление принадлежит ей: игрок паузу ведущего не снимает
    await until(() => x2.state && x2.state.paused);
    y4.send({ type: "resume" });
    await wait(700);
    check(!!x2.state.paused, "при живой доске игрок не может снять паузу ведущего");

    // 6. Доска умерла — иначе партия застревает на паузе до самого TTL при живых игроках
    h.ws.close();
    await wait(500);
    y4.send({ type: "resume" });
    const rescued = await until(() => x2.state && !x2.state.paused, 5000);
    check(rescued, "доски нет — паузу снимает любой игрок, партия не застревает навсегда");

    for (const c of [h, x2, y4]) c.ws.close();
  } finally {
    child.kill("SIGKILL");
  }
}

// ---------- служебный ping не продлевает жизнь брошенной комнате ----------
// Пульт раз в 20 с спрашивает сервер, жив ли сокет. Это проверка связи, а не действие в комнате:
// если бы такой ping двигал room.touched, брошенное лобби с открытой доской никогда не закрылось бы
// по TTL и висело бы, занимая лимит комнат, ровно до перезапуска процесса.
async function pingTtlSuite() {
  const { spawn } = require("child_process");
  const path = require("path");
  const os = require("os");
  const PORT = 3800 + Math.floor(Math.random() * 90);
  const B = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", ROOM_TTL_MS: "2000",
      DUMP_FILE: path.join(os.tmpdir(), `pingttl-${PORT}.json`) },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(B + "/auction/api/health")).ok; } catch { await wait(100); } }
    if (!up) return check(false, "сервер ping/TTL поднялся");
    const room = await (await fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal" }) })).json();
    const ws = new WebSocket(B.replace(/^http/, "ws") + "/auction/ws?r=" + room.code);
    let expired = false, pongs = 0;
    ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "pong") pongs++; if (m.type === "error" && m.error === "room_expired") expired = true; });
    ws.on("error", () => {});
    await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ type: "host", token: room.hostToken })); r(); }); setTimeout(r, 3000); });
    const beat = setInterval(() => { try { ws.send(JSON.stringify({ type: "ping" })); } catch {} }, 300);
    await wait(6500); // больше трёх TTL, всё это время пульт исправно пингует
    clearInterval(beat);
    check(pongs > 5, `на служебный ping приходит pong (получено ${pongs})`);
    check(expired, "служебный ping не продлевает жизнь брошенному лобби");
    ws.close();
  } finally {
    child.kill("SIGKILL");
  }
}

// ---------- мягкий перезапуск ----------
// Деплой приходится на живую партию. Если процесс просто выйдет, клиент увидит обрыв 1006 —
// «сеть пропала» — и будет отсиживать свой шаг backoff. Код 1012 (Service Restart) говорит прямо:
// это перезапуск сервиса, возвращайся сразу.
async function shutdownSuite() {
  const { spawn } = require("child_process");
  const path = require("path");
  const os = require("os");
  const PORT = 3600 + Math.floor(Math.random() * 90);
  const B = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production",
      DUMP_FILE: path.join(os.tmpdir(), `shutdown-${PORT}.json`) },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(B + "/auction/api/health")).ok; } catch { await wait(100); } }
    if (!up) return check(false, "сервер перезапуска поднялся");
    const room = await (await fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal" }) })).json();
    const ws = new WebSocket(B.replace(/^http/, "ws") + "/auction/ws?r=" + room.code);
    let code = null;
    ws.on("close", (c) => (code = c));
    ws.on("error", () => {});
    await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ type: "join", name: "Икс" })); r(); }); setTimeout(r, 3000); });
    await wait(300);
    child.kill("SIGTERM");
    await until(() => code !== null, 5000);
    check(code === 1012, `при перезапуске сокет закрывается кодом 1012 Service Restart (получено ${code})`);
  } finally {
    child.kill("SIGKILL");
  }
}

// Каноническая строка: порядок ключей не важен (клиент дописывает части в другом порядке)
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
function loadMerge() {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "auction-shared.js"), "utf8");
  const m = src.match(/\/\* merge:start \*\/([\s\S]*?)\/\* merge:end \*\//);
  return new Function(m[1] + "; return auctionMergeState;")();
}

async function deltaSuite(make) {
  const merge = loadMerge();
  const r = await make({ slots: 3, budget: 20, judge: "vote" }, 12);
  const full = [], fullSet = new Set();
  let bytesFull = 0, bytesDelta = 0;
  // эталон — клиент без d=1: получает полный снимок, как старые пульты
  const ref = new WebSocket(WS + r.code);
  ref.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "state") { bytesFull += raw.length; full.push(m.state); fullSet.add(canon(m.state)); } });
  await new Promise((d) => ref.on("open", d));
  const bad = [];
  const mkDelta = (label) => {
    const cache = {};
    const x = { states: 0, ws: new WebSocket(WS + r.code + "&d=1") };
    x.ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type !== "state" && m.type !== "hello") return;
      if (m.type === "state") bytesDelta += raw.length;
      const st = merge(cache, m.state);
      x.states++;
      x.last = st;
      if (m.type === "state") x.pending = (x.pending || []).concat(canon(st));
    });
    x.label = label;
    return x;
  };
  const d1 = mkDelta("ws");
  await new Promise((d) => d1.ws.on("open", d));
  // long-polling с d=1
  const pollCache = {}, pollStates = [];
  const ses = await (await fetch(BASE + "/auction/api/session?r=" + r.code + "&d=1")).json();
  let polling = true;
  const eat = (msgs) => { for (const m of msgs) if (m.type === "state" || m.type === "hello") { const st = merge(pollCache, m.state); if (m.type === "state") pollStates.push(canon(st)); } };
  eat(ses.messages);
  // анонимную poll-сессию сервер закрывает через 30 с — представляемся пультом ведущего
  await fetch(BASE + "/auction/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: ses.sid, msg: { type: "host", token: r.hostToken, remote: true } }) });
  (async () => { while (polling) { try { const b = await (await fetch(BASE + "/auction/api/poll?sid=" + ses.sid)).json(); eat(b.messages || []); } catch { break; } } })();
  const h = await connect(r.code, { type: "host", token: r.hostToken });
  h.send({ type: "bots", n: 4 });
  await until(() => h.state.players.length === 4);
  h.send({ type: "start" });
  // посреди партии пульт переподключается: новый hello, дальше опять разница
  await until(() => h.state.round >= 2, 20000);
  d1.ws.close();
  const d2 = mkDelta("ws после переподключения");
  await new Promise((d) => d2.ws.on("open", d));
  await until(() => h.state.phase === "finished" && h.state.results, 60000);
  await wait(500);
  polling = false;
  for (const x of [d1, d2]) for (const c of x.pending || []) if (!fullSet.has(c)) bad.push(x.label);
  for (const c of pollStates) if (!fullSet.has(c)) bad.push("poll");
  check(full.length > 20 && (d1.pending || []).length > 5 && (d2.pending || []).length > 5 && pollStates.length > 20, `delta-клиенты получили состояния (полных ${full.length}, ws ${(d1.pending || []).length}+${(d2.pending || []).length}, poll ${pollStates.length})`);
  check(!bad.length, `собранное из разницы состояние совпадает с полным снимком (расхождений ${bad.length}: ${[...new Set(bad)].join(", ")})`);
  check(canon(d2.last) === canon(full[full.length - 1]), "после переподключения итоговое состояние delta-клиента равно полному");
  const ratio = bytesDelta / Math.max(1, bytesFull);
  console.log(`    трафик state: полный ${bytesFull} Б, с d=1 ${bytesDelta} Б (${Math.round(ratio * 100)}%)`);
  check(ratio < 0.75, `с d=1 state заметно легче (${Math.round(ratio * 100)}% от полного)`);
  for (const x of [ref, d2.ws, h.ws]) x.close();
}

// ---------- M14: потолок анонимных соединений с одного адреса внутри комнаты ----------
// Анонимы (без join/host) с одного IP не забивают все анонимные места комнаты; игроки за одним
// NAT при этом не ограничены — считаются только анонимы.
async function anonIpSuite() {
  const { spawn } = require("child_process");
  const path = require("path");
  const PORT = 3700 + Math.floor(Math.random() * 90);
  const B = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", MAX_ANON_PER_IP: "3", MAX_ANON_PER_ROOM: "30",
      DUMP_FILE: path.join(require("os").tmpdir(), `anonip-${PORT}.json`) },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(B + "/auction/api/health")).ok; } catch { await wait(100); } }
    check(up, "сервер для лимита анонимов поднялся");
    const room = await (await fetch(B + "/auction/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "animal" }) })).json();
    const url = B.replace(/^http/, "ws") + "/auction/ws?r=" + room.code;
    const open = (ip, first) => new Promise((done) => {
      const ws = new WebSocket(url, { headers: { "X-Real-IP": ip } });
      ws.on("open", () => { if (first) ws.send(JSON.stringify(first)); done(ws); });
      ws.on("error", () => done(null));
      setTimeout(() => done(null), 3000);
    });
    const anonA = [];
    for (let i = 0; i < 5; i++) anonA.push(await open("10.0.0.1"));
    const okA = anonA.filter(Boolean).length;
    check(okA === 3, `анонимов с одного адреса в комнате не больше 3 (открыто ${okA} из 5)`);
    const other = await open("10.0.0.2");
    check(!!other, "аноним с другого адреса проходит");
    const sess = await fetch(B + "/auction/api/session?r=" + room.code, { headers: { "X-Real-IP": "10.0.0.1" } });
    check(sess.status === 503, `poll-сессия сверх лимита адреса → 503 (${sess.status})`);
    // подделка X-Forwarded-For при доверенном X-Real-IP не создаёт новый адрес
    const spoof = await new Promise((done) => { const ws = new WebSocket(url, { headers: { "X-Real-IP": "10.0.0.1", "X-Forwarded-For": "1.2.3.4" } }); ws.on("open", () => done(ws)); ws.on("error", () => done(null)); });
    check(!spoof, "подделанный X-Forwarded-For не обходит лимит адреса");
    // NAT: игроки с того же адреса входят без ограничения — анонимами они остаются доли секунды
    for (const ws of anonA) if (ws) ws.close();
    await wait(200);
    const players = [];
    for (let i = 0; i < 8; i++) players.push(await open("10.0.0.1", { type: "join", name: "NAT" + i }));
    await wait(300);
    const okP = players.filter((w) => w && w.readyState === 1).length;
    check(okP === 8, `8 игроков за одним NAT входят (вошло ${okP})`);
    const anonAfter = [];
    for (let i = 0; i < 3; i++) anonAfter.push(await open("10.0.0.1"));
    check(anonAfter.filter(Boolean).length === 3, "вошедшие игроки не занимают места анонимов своего адреса");
    for (const ws of [other, ...players, ...anonAfter]) if (ws) ws.close();
  } finally {
    child.kill("SIGKILL");
  }
}
