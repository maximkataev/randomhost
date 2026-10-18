"use strict";

/*
 * Пульт для агентов-игроков: игра из командной строки, по одной команде за вызов.
 *   node play.js <base> <code> <name> join
 *   node play.js <base> <code> <name> state              — что сейчас на экране у этого игрока
 *   node play.js <base> <code> <name> wait [сек]         — ждать смены фазы, хода или вопроса (по умолчанию до 90 с), потом state
 *   node play.js <base> <code> <name> pick <N>           — раунд 1: категория N из трёх (с нуля)
 *   node play.js <base> <code> <name> cards "a|b|c|d|e"  — раунд 2: карточки для своей мишени (1–5 штук, ≤ 40 знаков)
 *   node play.js <base> <code> <name> rank 2,0,4,1,3     — расстановка: номера карточек от первого места к последнему
 *   node play.js <base> <code> <name> veto <N>           — раунд 2: заменить карточку N (один раз, до расстановки)
 *   node play.js <base> <code> <name> answer <q>:<v>     — ответ на вопрос q (1–3, как в «ВОПРОС q/3»): номер карточки,
 *                                                          для тройки — «x,y,z». Вопрос уже закрыт — «вопрос уже закрыт»
 *   node play.js <base> <code> host <hostToken> start|end|lobby|mode safe|edgy|lang ru|en|el
 * Ведущий: команда уходит только после подтверждения прав (host_ok); в конце печатаются итоговые настройки комнаты.
 * Токен игрока хранится в state/play-<code>-<name>.json. Комнату для агентов создают с speed < 1 (только dev):
 * сроки фаз растягиваются, и у агента есть время подумать.
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const [base, code, name, cmd, ...rest] = process.argv.slice(2);
if (!base || !code || !name || !cmd) { console.log("usage: node play.js <base> <code> <name> <cmd> [...]"); process.exit(2); }
const wsUrl = base.replace(/^http/, "ws") + "/ifeel/ws?r=" + encodeURIComponent(code);
const tokFile = path.join(__dirname, "state", `play-${code}-${name.replace(/[^\p{L}\p{N}]/gu, "_")}.json`);
const newAid = () => "p" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const inbox = [];
    let waiter = null;
    ws.on("message", (raw) => { const m = JSON.parse(raw); inbox.push(m); if (waiter) { const w = waiter; waiter = null; w(); } });
    ws.on("open", () => resolve({ ws, next: (ms) => new Promise((r) => { if (inbox.length) return r(inbox.shift()); const t = setTimeout(() => { waiter = null; r(null); }, ms); waiter = () => { clearTimeout(t); r(inbox.shift()); }; }), send: (m) => ws.send(JSON.stringify(m)) }));
    ws.on("error", reject);
  });
}

// отказы сервера — по-человечески; idx — номер карточки с нуля, печатаем с единицы
function human(reason, idx) {
  const n = idx != null ? idx + 1 : null;
  const map = {
    q_closed: "вопрос уже закрыт", not_ask: "вопрос уже закрыт", answered: "на этот вопрос ответ уже принят",
    not_guesser: "сейчас угадываешь не ты — смотри доску", target: "угадывают тебя — отвечать нельзя", bad_answer: "такого ответа нет: номер карточки из вопроса (для тройки — все три через запятую)",
    too_long: `карточка ${n} длиннее 40 знаков`, bad_card: `карточка ${n} не подходит: без ссылок и разметки`, dup: `карточка ${n} повторяет другую`,
    empty: "нужна хотя бы одна непустая карточка", sent: "карточки уже отправлены", not_write: "время сочинения вышло", not_author: "ты сейчас не пишешь карточки",
    bad_order: "нужна полная расстановка: все номера карточек по одному разу", ranked: "расстановка уже отправлена", not_rank: "время расстановки вышло",
    veto_used: "замена уже использована", no_veto: "замена бывает только в раунде 2", no_spare: "заменить не на что", bad_pick: "такой категории нет",
    not_pick: "выбор категории уже закрыт", not_in_round: "ты в этом раунде не играешь — со следующего", rate: "слишком часто — повтори",
    not_host: "нет прав ведущего", game_started: "партия уже идёт — настройки меняются только в лобби", few_players: "нужно хотя бы 3 игрока", no_content: "банк карточек не загрузился",
  };
  return map[reason] || reason + (n != null ? ` (карточка ${n})` : "");
}

async function session() {
  const c = await connect();
  let state = null, me = null;
  for (;;) { const m = await c.next(5000); if (!m) break; if (m.type === "hello") { state = m.state; break; } }
  if (name === "host") {
    // права ведущего — до любой команды: иначе settings мог уйти раньше, чем сервер признал доску (и тихо не примениться)
    c.send({ type: "host", token: cmd });
    for (;;) {
      const m = await c.next(5000);
      if (!m) { console.log("ОШИБКА: сервер не подтвердил права ведущего"); process.exit(1); }
      if (m.type === "error") { console.log("ОШИБКА: " + (m.error === "bad host token" ? "неверный токен ведущего" : m.error)); process.exit(1); }
      if (m.type === "hello" || m.type === "state") state = m.state;
      if (m.type === "host_ok") break;
    }
    // после host_ok сервер шлёт свежий hello доски
    for (let m; (m = await c.next(300));) if (m.type === "hello" || m.type === "state") state = m.state;
    return { c, state, me: null };
  }
  let token = null;
  try { token = JSON.parse(fs.readFileSync(tokFile, "utf8")).token; } catch {}
  if (cmd === "join" && !token) c.send({ type: "join", name });
  else if (token) c.send({ type: "join", token, name });
  else { console.log("сначала: join"); process.exit(1); }
  for (;;) {
    const m = await c.next(5000);
    if (!m) break;
    if (m.type === "joined") { me = m.playerId; fs.mkdirSync(path.dirname(tokFile), { recursive: true }); fs.writeFileSync(tokFile, JSON.stringify({ token: m.token })); }
    if (m.type === "state") state = m.state;
    if (m.type === "error") { console.log("ошибка: " + m.error); process.exit(1); }
    if (me && state && state.me) break;
  }
  // всё, что успело прийти следом, — до первого «кадра»: иначе wait проснулся бы от устаревшего снимка
  for (let m; (m = await c.next(150));) if (m.type === "state") state = m.state;
  return { c, state, me };
}

const itemStr = (x, i) => `[${i}] ${x.e ? x.e + " " : ""}${x.t}`;
const RND_LABEL = { ru: "🎲 Случайный набор", en: "🎲 Random set", el: "🎲 Τυχαίο σετ" };
const ordRu = (n) => n + "-е";
function qLine(q, set, tname) {
  const it = (i) => `[${i}] ${set.items[i].t}`;
  if (q.kind === "pair") return `Что ${tname} ставит выше: ${it(q.a)} или ${it(q.b)}?`;
  if (q.kind === "place" || q.kind === "first" || q.kind === "last") return `Что ${tname} ставит на ${ordRu(q.kind === "place" ? q.n : q.kind === "first" ? 1 : 5)} место? (любая из пяти)`;
  return `Расставь ${q.items.map(it).join(", ")} как ${tname} (первое место первым)`;
}
function describe(s) {
  const P = (id) => (s.players.find((p) => p.id === id) || { name: "?" }).name;
  const out = [];
  const left = s.phaseEnd ? Math.max(0, Math.round((s.phaseEnd - s.serverNow) / 1000)) : null;
  const inGame = s.phase !== "lobby" && s.phase !== "finished";
  out.push(`ФАЗА: ${s.phase}${s.round ? ` · раунд ${s.round.n}/2` : ""}${inGame && left != null ? ` · осталось ~${left} игровых с` : ""} · режим ${s.settings.mode}, карточки ${s.contentLang}`);
  if (s.restarted && s.phase === "pick") out.push(`Партия перезапущена: режим ${s.settings.mode}, карточки ${s.contentLang}`);
  const my = s.me;
  if (s.phase === "lobby") out.push(`В лобби: ${s.players.filter((p) => !p.left).map((p) => p.name).join(", ")}`);
  if (my && inGame && s.round && !my.inCast && !my.role) out.push("Вход посреди раунда — игра со следующего.");
  if (s.phase === "pick" && my && my.offers) {
    out.push("ВЫБЕРИ КАТЕГОРИЮ (pick N). Потом тайно расставишь 5 карточек по её шкале:");
    my.offers.forEach((o, i) => out.push(`  ${i}) ${o.kind === "rnd" ? (RND_LABEL[s.contentLang] || RND_LABEL.ru) + " · " : ""}${o.title}  [${o.top} ↔ ${o.bottom}]${my.choice === i ? "  ← выбрано" : ""}`));
  }
  if (s.phase === "write" && my && my.write) {
    const w = my.write;
    out.push(`ТЫ ПИШЕШЬ 5 КАРТОЧЕК ДЛЯ: ${P(w.target)}. Подсказка: «${w.prompt}» [${w.top} ↔ ${w.bottom}]`);
    out.push(w.cards ? `Отправлено: ${w.cards.join(" | ")}` : `Команда: cards "a|b|c|d|e" (пустые добьются примерами). Примеры: ${w.examples.slice(0, 6).join("; ")}`);
  }
  if (s.phase === "rank" && my) {
    if (my.set) {
      out.push(`РАССТАВЬ «${my.set.title}» от «${my.set.top}» (1-е место) до «${my.set.bottom}» (последнее):`);
      my.set.items.forEach((x, i) => out.push("  " + itemStr(x, i) + (my.veto && my.veto.used && my.veto.idx === i ? "  ← замена" : "")));
      if (my.set.author) out.push(`Карточки: ${P(my.set.author)}`);
      out.push(my.ranked ? "Расстановка отправлена." : `Команда: rank 2,0,4,1,3${my.veto && !my.veto.used ? "; можно один раз veto N — заменить карточку" : ""}. Расставляй честно — твой порядок будут угадывать.`);
    } else out.push(my.wroteFor ? `${P(my.wroteFor)} расставляет твои карточки.` : "Остальные расставляют.");
    if (s.round) out.push(`Расставили: ${(s.round.done || []).length}/${(s.round.ranking || []).length}`);
  }
  const t = s.turn;
  if (t && ["tintro", "ask", "reveal"].includes(s.phase)) {
    out.push(`ХОД: ${t.guessers.map(P).join(" + ") || "—"} угадывает: ${P(t.target)} · «${t.set.title}» [${t.set.top} ↔ ${t.set.bottom}]`);
    if (t.set.author) out.push(`Карточки: ${P(t.set.author)}`);
    t.set.items.forEach((x, i) => out.push("  " + itemStr(x, i)));
    if (my && my.role) out.push(`Твоя роль: ${my.role === "guesser" ? "ТВОЙ ХОД — угадываешь (очки за попадание)" : my.role === "target" ? "угадывают тебя — молчи" : "зритель — смотри доску, отвечать не нужно"}`);
    if (s.phase === "ask") {
      const q = t.qs[t.qi];
      const hint = my && my.role === "guesser" ? ` → answer ${t.qi + 1}:${q.kind === "triple" ? "x,y,z" : "N"}` : "";
      out.push(`ВОПРОС ${t.qi + 1}/3: ${qLine(q, t.set, P(t.target))}${hint}`);
      if (my && my.role === "guesser" && my.answered && my.answered[t.qi]) out.push("Ответ на этот вопрос принят.");
    }
    for (const g of t.guessers) out.push(`Ответы ${P(g)}: ${JSON.stringify(t.answers[g])}`);
    if (s.phase === "reveal" && t.result) {
      out.push(`ПОРЯДОК ${P(t.target)}: ${t.result.order.map((x, i) => `${i + 1}) ${t.set.items[x].t}`).join("  ")}`);
      for (const g of t.guessers) out.push(`Очки ${P(g)}: ${JSON.stringify(t.result.pts[g])}`);
      if (my && my.pts) out.push(`Твои очки за ход: ${my.pts.reduce((a, b) => a + b, 0)}`);
    }
  }
  if (["scores", "finished", "reveal"].includes(s.phase)) {
    const list = s.players.filter((p) => !p.left).sort((a, b) => b.score - a.score);
    out.push("СЧЁТ: " + list.map((p) => `${1 + list.filter((x) => x.score > p.score).length}. ${p.name} ${p.score}`).join(", "));
  }
  if (s.phase === "finished") {
    out.push("ИГРА ОКОНЧЕНА." + (s.finishedReason && s.finishedReason !== "done" ? ` (${s.finishedReason})` : ""));
    const list = s.players.filter((p) => !p.left);
    const top = Math.max(...list.map((p) => p.score));
    const win = list.filter((p) => p.score === top).map((p) => p.name);
    out.push(win.length > 1 ? `Победу делят: ${win.join(", ")}` : `Победа: ${win[0]}`);
    for (const x of s.loud || []) out.push(`  Громко: ${P(x.guesser)} → ${P(x.target)} «${x.title}»: ${x.pts.reduce((a, b) => a + b, 0)}/900, порядок ${x.order.map((k) => x.items[k].t).join(" > ")}`);
  }
  return out.join("\n");
}

(async () => {
  const { c, state: first } = await session();
  let state = first;
  // действие ждёт свой ack/rejected по aid (или отказ ведущему): печатает «принято» или человеческую причину
  // doneWhen(state) — для команд ведущего без aid: успех виден по снимку (настройки применились, фаза сменилась)
  const act = async (msg, label, doneWhen) => {
    for (let m; (m = await c.next(50));) if (m.type === "state" || m.type === "hello") state = m.state;
    c.send(msg);
    const until = Date.now() + 3000;
    let verdict = null;
    while (Date.now() < until) {
      const m = await c.next(until - Date.now());
      if (!m) break;
      if (m.type === "state" || m.type === "hello") { state = m.state; if (doneWhen && doneWhen(state)) { verdict = "ПРИНЯТО"; break; } continue; }
      if (m.type === "rejected" && (!msg.aid || m.aid === msg.aid)) { verdict = "ОТКАЗ: " + human(m.reason, m.idx); break; }
      if (m.type === "error") { verdict = "ОТКАЗ: " + human(m.error); break; }
      if (m.type === "ack" && m.aid === msg.aid) { verdict = "ПРИНЯТО" + (label ? ": " + label : ""); }
    }
    // снимки, пришедшие сразу после подтверждения
    for (let m; (m = await c.next(150));) if (m.type === "state" || m.type === "hello") state = m.state;
    if (verdict) console.log(verdict);
    else console.log("НЕТ ОТВЕТА СЕРВЕРА — проверь state и повтори");
  };
  const nums = (s) => String(s || "").split(",").map((x) => Number(x.trim()));
  if (name === "host") {
    const op = rest[0];
    const g0 = state.game;
    if (op === "start") await act({ type: "start" }, "", (s) => s.game !== g0 && s.phase !== "lobby");
    else if (op === "end") await act({ type: "end" }, "", (s) => s.phase === "finished");
    else if (op === "lobby") await act({ type: "lobby" }, "", (s) => s.phase === "lobby");
    else if (op === "mode" || op === "lang") {
      const want = String(rest[1] || "");
      if (state.settings[op] === want) console.log(`ПРИНЯТО (уже было): ${op} = ${want}`);
      else await act({ type: "settings", settings: { [op]: want } }, "", (s) => s.settings[op] === want);
      if (state.settings[op] !== want) console.log(`НЕ ПРИМЕНИЛОСЬ: ${op} = ${state.settings[op]} (просили ${want})`);
    } else if (op) console.log("неизвестная команда ведущего: " + op);
    console.log(`НАСТРОЙКИ КОМНАТЫ: режим ${state.settings.mode}, язык карточек ${state.settings.lang}${state.contentLang !== state.settings.lang ? ` (играет банк ${state.contentLang})` : ""}`);
    console.log(describe(state));
    c.ws.close();
    process.exit(0);
  }
  const sig = (s) => [s.game, s.phase, s.round ? s.round.n : "", s.round ? s.round.ti : "", s.turn ? s.turn.qi : ""].join(":");
  if (cmd === "pick") await act({ type: "pick", idx: Number(rest[0]), aid: newAid() }, "категория " + rest[0]);
  if (cmd === "cards") await act({ type: "cards", cards: String(rest[0] || "").split("|"), aid: newAid() }, "карточки отправлены");
  if (cmd === "rank") await act({ type: "rank", order: nums(rest[0]), aid: newAid() }, "расстановка " + rest[0]);
  if (cmd === "veto") await act({ type: "veto", idx: Number(rest[0]), aid: newAid() }, "карточка заменена");
  if (cmd === "answer") {
    const raw = String(rest[0] || "");
    const m = raw.match(/^(\d)\s*:\s*(.+)$/);
    if (!m) { console.log("формат: answer <вопрос 1–3>:<карточка>, для тройки answer 3:x,y,z"); process.exit(2); }
    const qi = Number(m[1]) - 1;
    const v = m[2].includes(",") ? nums(m[2]) : Number(m[2]);
    await act({ type: "answer", qi, v, aid: newAid() }, `вопрос ${qi + 1}`);
  }
  if (cmd === "wait") {
    // просыпается только от смены партии, фазы, раунда, хода или вопроса — не от чужих «готов» и не от тиков
    const start = sig(state);
    const until = Date.now() + 1000 * Number(rest[0] || 90);
    while (Date.now() < until && sig(state) === start) {
      const m = await c.next(until - Date.now());
      if (m && m.type === "state") state = m.state;
    }
    if (sig(state) === start) console.log("(ничего не сменилось за отведённое время)");
  }
  console.log(describe(state));
  c.ws.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
