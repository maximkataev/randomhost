"use strict";

/*
 * Пульт для агентов-игроков: игра из командной строки, по одной команде за вызов.
 *   node play.js <base> <code> <name> join
 *   node play.js <base> <code> <name> state            — что сейчас на экране у этого игрока
 *   node play.js <base> <code> <name> wait [сек]       — ждать смены фазы/раунда (по умолчанию до 90 с), потом state
 *   node play.js <base> <code> <name> vote a|b         — выбрать сторону (можно передумать до «Готово»)
 *   node play.js <base> <code> <name> bank on|off      — ва-банк (только если разрешён)
 *   node play.js <base> <code> <name> confirm          — «Готово»: голос зафиксирован
 *   node play.js <base> <code> <name> opinion a|b|skip — фаза «Мнение»: за какую сторону проголосует большинство
 *   node play.js <base> <code> host <hostToken> start|end
 * Токен игрока хранится в state/play-<code>-<name>.json. Комнату для агентов создают с speed < 1 (только dev):
 * сроки фаз растягиваются, и у агента есть время подумать.
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const [base, code, name, cmd, ...rest] = process.argv.slice(2);
if (!base || !code || !name || !cmd) { console.log("usage: node play.js <base> <code> <name> <cmd> [...]"); process.exit(2); }
const wsUrl = base.replace(/^http/, "ws") + "/crowd/ws?r=" + encodeURIComponent(code);
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
    if (me && state && state.me) break;
  }
  return { c, state, me };
}

function describe(s) {
  const P = (id) => (s.players.find((p) => p.id === id) || { name: "?" }).name;
  const out = [];
  const left = s.phaseEnd ? Math.max(0, Math.round((s.phaseEnd - s.serverNow) / 1000)) : null;
  const r = s.round;
  const inGame = s.phase !== "lobby" && s.phase !== "finished";
  out.push(`ФАЗА: ${s.phase}${inGame && r ? ` · раунд ${r.num}/${s.total}${r.mult > 1 ? ` ×${r.mult}` : ""}` : ""}${inGame && left != null ? ` · осталось ~${left} игровых с` : ""}`);
  const my = s.me;
  if (s.phase === "lobby") out.push(`В лобби: ${s.players.filter((p) => !p.left).map((p) => p.name).join(", ")}`);
  if (r) {
    out.push(`ВОПРОС: «${r.q.q}»   a) ${r.q.a}   b) ${r.q.b}`);
    if (r.only) out.push(`Отвечают только: ${r.only.map(P).join(", ")}`);
  }
  if (s.phase === "vote" && r) {
    if (my && !my.inRound) out.push("Ты вошёл посреди раунда — голосовать будешь со следующего.");
    else if (my) {
      out.push(`Твой голос: ${my.vote || "ещё нет"}${my.confirmed ? " (подтверждён)" : ""}${my.bank ? " · ВА-БАНК" : ""}. Ва-банков осталось: ${my.banks}${r.bankAllowed ? "" : " (в этом раунде нельзя)"}.`);
      out.push("ЗАДАЧА: угадать, что выберет БОЛЬШИНСТВО игроков, а не что нравится тебе. Команды: vote a|b → confirm" + (r.bankAllowed && my.banks ? " (опц. bank on: ×2 очков при победе / −200 при проигрыше)" : ""));
    }
    out.push(`Готовы: ${(r.ready || []).length}/${(r.voters || []).length}`);
  }
  if (s.phase === "opinion" && r) {
    out.push(my && my.asked ? `ФАЗА «МНЕНИЕ»: как думаешь, что выберет большинство? Твой ответ: ${my.opinion || "ещё нет"} → opinion a|b|skip` : "Фаза «Мнение»: ждём ответов других.");
  }
  if ((s.phase === "reveal" || s.phase === "scores") && r && r.result) {
    const x = r.result;
    if (x.void) out.push("РАУНД НЕ ЗАСЧИТАН (мало голосов).");
    else {
      out.push(`РЕЗУЛЬТАТ: ${r.q.a} — ${x.a}, ${r.q.b} — ${x.b}. ${x.tie ? "РАСКОЛ (ничья)." : `Большинство: ${x.side === "a" ? r.q.a : r.q.b}.`}${x.unanimous ? " Все как один!" : ""}${x.illusion ? " ИЛЛЮЗИЯ: мнение расходилось с голосованием." : ""}`);
      if (my && my.gain != null) out.push(`Твои очки за раунд: ${my.gain >= 0 ? "+" : ""}${my.gain}`);
    }
  }
  if (s.phase === "scores" || s.phase === "finished" || s.phase === "reveal") {
    out.push("СЧЁТ: " + s.players.filter((p) => !p.left).sort((a, b) => b.score - a.score).map((p) => `${p.name} ${p.score}`).join(", "));
  }
  if (s.phase === "finished") out.push("ИГРА ОКОНЧЕНА." + (s.finishedReason && s.finishedReason !== "done" ? ` (${s.finishedReason})` : ""));
  return out.join("\n");
}

(async () => {
  const { c, state: first, me } = await session();
  let state = first;
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
    if (rest[0] === "end") await act({ type: "end" });
    console.log(describe(state));
    process.exit(0);
  }
  const sig = (s) => s.phase + ":" + (s.round ? s.round.num : "");
  if (cmd === "vote") await act({ type: "vote", side: rest[0] });
  if (cmd === "bank") await act({ type: "bank", on: rest[0] !== "off" });
  if (cmd === "confirm") await act({ type: "confirm" });
  if (cmd === "opinion") await act({ type: "opinion", side: rest[0] });
  if (cmd === "wait") {
    const start = sig(state);
    const until = Date.now() + 1000 * Number(rest[0] || 90);
    while (Date.now() < until && sig(state) === start) {
      const m = await c.next(until - Date.now());
      if (m && m.type === "state") state = m.state;
    }
  }
  console.log(describe(state));
  c.ws.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
