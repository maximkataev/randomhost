"use strict";

/*
 * Пульт для агентов-игроков: игра из командной строки, по одной команде за вызов.
 *   node play.js <base> <code> <name> join
 *   node play.js <base> <code> <name> state            — что сейчас на экране у этого игрока
 *   node play.js <base> <code> <name> wait [сек]       — ждать смены фазы/шкалы (по умолчанию до 90 с), потом state
 *   node play.js <base> <code> <name> pick 0..3
 *   node play.js <base> <code> <name> reroll          — другие шкалы (до трёх раз за раунд)
 *   node play.js <base> <code> <name> clue "текст"
 *   node play.js <base> <code> <name> lock <угол 0..180>
 *   node play.js <base> <code> host <hostToken> start|short|end
 * Токен игрока хранится в state/play-<code>-<name>.json. Комнату для агентов создают с speed < 1 (только dev):
 * сроки фаз растягиваются, и у агента есть время подумать.
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const [base, code, name, cmd, ...rest] = process.argv.slice(2);
if (!base || !code || !name || !cmd) { console.log("usage: node play.js <base> <code> <name> <cmd> [...]"); process.exit(2); }
const wsUrl = base.replace(/^http/, "ws") + "/wave/ws?r=" + encodeURIComponent(code);
const tokFile = path.join(__dirname, "state", `play-${code}-${name.replace(/[^\p{L}\p{N}]/gu, "_")}.json`);

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

async function session() {
  const c = await connect();
  let state = null, me = null;
  for (;;) { const m = await c.next(5000); if (!m) break; if (m.type === "hello") { state = m.state; break; } }
  if (name === "host") {
    c.send({ type: "host", token: cmd });
    return { c, state, me: null };
  }
  let token = null;
  try { token = JSON.parse(fs.readFileSync(tokFile, "utf8")).token; } catch {}
  if (cmd === "join" && !token) c.send({ type: "join", name });
  else if (token) c.send({ type: "join", token });
  else { console.log("сначала: join"); process.exit(1); }
  for (;;) {
    const m = await c.next(5000);
    if (!m) break;
    if (m.type === "joined") { me = m.playerId; fs.mkdirSync(path.dirname(tokFile), { recursive: true }); fs.writeFileSync(tokFile, JSON.stringify({ token: m.token })); }
    if (m.type === "state") state = m.state;
    if (m.type === "error") { console.log("ошибка: " + m.error); process.exit(1); }
    if (me && state && state.me) break; // hello приходит до входа — в нём ещё нет «меня»
  }
  return { c, state, me };
}

function describe(s, me) {
  const P = (id) => (s.players.find((p) => p.id === id) || { name: "?" }).name;
  const out = [];
  const left = s.phaseEnd ? Math.max(0, Math.round((s.phaseEnd - s.serverNow) / 1000)) : null;
  const inGame = s.phase !== "lobby" && s.phase !== "finished";
  out.push(`ФАЗА: ${s.phase}${inGame && s.ri >= 0 ? ` · раунд ${s.ri + 1}/${s.rounds} ×${s.mult}` : ""}${inGame && left != null ? ` · осталось ~${left} игровых с` : ""}`);
  const my = s.me;
  if (s.phase === "lobby") out.push(`В лобби: ${s.players.filter((p) => !p.left).map((p) => p.name).join(", ")}`);
  if (s.phase === "clue") {
    if (!my || !my.card) out.push("Ты вошёл посреди раунда — подсказку не пишешь, жди угадывания.");
    else if (my.card.pick == null) out.push(`ВЫБЕРИ ШКАЛУ: ${my.card.options.map((o, i) => `${i}) ${o.l} ↔ ${o.r}`).join("   ")}   → команда: pick <номер>${my.card.rerollsLeft ? ` (или reroll — другие шкалы, осталось ${my.card.rerollsLeft})` : ""}`);
    else if (!my.card.clue) out.push(`ТВОЯ ШКАЛА: ${my.card.l} (0°) ↔ ${my.card.r} (180°). Тайный центр сектора: ${my.card.target}°. 400 очков — ±4°, 300 — ±12°, 200 — ±20°.\nНапиши подсказку (одна фраза до 40 символов, без цифр, без слов полюсов) — вещь, которая по-твоему лежит на ${my.card.target}° → команда: clue "…"`);
    else out.push(`Твоя подсказка «${my.card.clue}» отправлена (шкала ${my.card.l} ↔ ${my.card.r}, центр ${my.card.target}°). Ждём остальных: ${s.clued.length}/${s.roster.length}.`);
  }
  if ((s.phase === "guess" || s.phase === "reveal") && s.card) {
    out.push(`ШКАЛА ${s.card.n}/${s.card.of}: ${s.card.l} (0°) ↔ ${s.card.r} (180°). Подсказка от ${P(s.card.author)}: «${s.card.clue}»`);
    if (s.phase === "guess") {
      if (my && my.myCard) out.push(`Это твоя шкала — остальные угадывают. Зафиксировали ${s.locked.length}/${s.guessers.length}.`);
      else if (my && my.guess != null) out.push(`Твоя стрелка зафиксирована на ${my.guess}°. Ждём: ${s.locked.length}/${s.guessers.length}.`);
      else out.push("УГАДАЙ: где на шкале эта подсказка? 0° — полностью левый полюс, 90° — середина, 180° — полностью правый → команда: lock <угол>");
    } else {
      out.push(`РАСКРЫТИЕ: центр сектора был ${s.card.target}°. ${s.card.wave ? "🌊 НА ОДНОЙ ВОЛНЕ! " : ""}Автору +${s.card.authorPts}.`);
      for (const [id, a] of Object.entries(s.card.guesses)) out.push(`  ${P(id)}: ${a}° → +${s.card.pts[id]}`);
    }
  }
  if (s.phase === "scores" || s.phase === "finished" || s.phase === "reveal") {
    out.push("СЧЁТ: " + s.players.filter((p) => !p.left).sort((a, b) => b.score - a.score).map((p) => `${p.name} ${p.score}`).join(", "));
  }
  if (s.phase === "finished" && s.awards) {
    const a = s.awards;
    if (a.telepath) out.push(`Телепат: ${a.telepath.ids.map(P).join(", ")} (${a.telepath.n})`);
    if (a.clear) out.push(`Ясно выражается: ${a.clear.ids.map(P).join(", ")}`);
    if (a.miss) out.push(`Мимо кассы: «${a.miss.clue}» — ${P(a.miss.playerId)}, мимо центра на ${a.miss.dist}°`);
    out.push("ИГРА ОКОНЧЕНА.");
  }
  return out.join("\n");
}

(async () => {
  const { c, state: first, me } = await session();
  let state = first;
  // после действия собираем всё, что пришло за полсекунды, и берём последний снимок: первым может прийти старый
  const act = async (msg) => {
    await new Promise((r) => setTimeout(r, 200));
    for (let m; (m = await c.next(50));) if (m.type === "state") state = m.state;
    c.send(msg);
    const until = Date.now() + 600;
    while (Date.now() < until) {
      const m = await c.next(until - Date.now());
      if (!m) break;
      if (m.type === "rejected") { console.log("ОТКАЗ: " + m.reason); break; }
      if (m.type === "state") state = m.state;
    }
  };
  if (name === "host") {
    await new Promise((r) => setTimeout(r, 300));
    if (rest[0] === "start") await act({ type: "start" });
    if (rest[0] === "short") await act({ type: "settings", settings: { short: true } });
    if (rest[0] === "end") await act({ type: "end" });
    console.log(describe(state, null));
    process.exit(0);
  }
  const sig = (s) => s.phase + ":" + s.ri + ":" + (s.card ? s.card.n : "");
  if (cmd === "pick") await act({ type: "pick", i: Number(rest[0]) });
  if (cmd === "reroll") await act({ type: "reroll" });
  if (cmd === "clue") await act({ type: "clue", text: rest.join(" ") });
  if (cmd === "lock") await act({ type: "lock", angle: Number(rest[0]) });
  if (cmd === "wait") {
    const start = sig(state);
    const until = Date.now() + 1000 * Number(rest[0] || 90);
    while (Date.now() < until && sig(state) === start) {
      const m = await c.next(until - Date.now());
      if (m && m.type === "state") state = m.state;
    }
  }
  console.log(describe(state, me));
  c.ws.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
