"use strict";

/*
 * Пульт для агентов-игроков «Позывного»: у каждого игрока свой фоновый процесс (демон) держит сокет и остаётся «на связи»,
 * как телефон в руке; агент говорит с ним короткими командами. Все вызовы печатают то, что человек видел бы на экране.
 *
 *   node play.js <base> <code> <имя> join                  — войти и запустить демон (токен запоминается)
 *   node play.js <base> <code> <имя> state                 — что сейчас на экране
 *   node play.js <base> <code> <имя> wait [сек]            — ждать, пока что-то изменится (по умолчанию до 90 реальных с), потом state
 *   node play.js <base> <code> <имя> team red|blue|none    — выбрать команду (лобби и итоги)
 *   node play.js <base> <code> <имя> captain               — «хочу быть капитаном» / отказаться
 *   node play.js <base> <code> <имя> clue <слово> <число>  — подсказка капитана
 *   node play.js <base> <code> <имя> open <номер>          — тап по карточке (оперативник)
 *   node play.js <base> <code> <имя> stop                  — «Хватит»
 *   node play.js <base> <code> <имя> resume                — «Играем!» после паузы (три пустых хода подряд)
 *   node play.js <base> <code> <имя> say <текст>           — сказать вслух за столом (видит своя команда) — для обсуждения
 *   node play.js <base> <code> <имя> talk                  — что говорят за столом
 *   node play.js <base> <code> <имя> avatar <эмодзи> | rename <имя> | leave
 *   — для тестеров устойчивости:
 *   node play.js <base> <code> <имя> drop [сек]            — оборвать сокет на N секунд (поведение при потере связи)
 *   node play.js <base> <code> <имя> raw '<json>'          — отправить сырое сообщение серверу (и показать ответы)
 *   node play.js <base> <code> <имя> log [N]               — последние N сообщений сервера
 *   node play.js <base> <code> <имя> quit                  — закрыть демон
 *   — ведущий (доска):
 *   node play.js <base> <code> host <hostToken> start|end|lobby|skip|mode words|mode pics
 *
 * Комнату для агентов создают в режиме разработки с speed < 1 (сроки растянуты, чтобы у агента было время подумать):
 *   curl -X POST $BASE/callsign/api/rooms -d '{"settings":{"lang":"ru","mode":"words"},"speed":0.35}'
 * Журнал каждого игрока — state/<код>-<имя>.log.jsonl (метка реального времени + игровое время): из него считает динамику timeline.js.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const argv = process.argv.slice(2);
const DAEMON = argv[0] === "--daemon";
const [base, code, name, cmd, ...rest] = DAEMON ? argv.slice(1) : argv;
if (!base || !code || !name) { console.log("usage: node play.js <base> <code> <имя> <команда> [...]"); process.exit(2); }
const safe = (s) => String(s).replace(/[^\p{L}\p{N}]/gu, "_");
const dir = path.join(__dirname, "state");
fs.mkdirSync(dir, { recursive: true });
const base0 = path.join(dir, `${code}-${safe(name)}`);
const sockPath = base0 + ".sock", tokFile = base0 + ".token.json", logFile = base0 + ".log.jsonl";
const wsUrl = base.replace(/^http/, "ws") + "/callsign/ws?r=" + encodeURIComponent(code);
const TEAM_RU = { red: "КРАСНЫЕ", blue: "СИНИЕ" };
const GLYPH = { red: "▲", blue: "●", n: "◼", x: "✕" };
// то, что игрок видит на экране словами (на страницах те же тексты; здесь — русская версия)
const END_RU = { limit: "открыли всё, что назвали", neutral: "промах: пустая карточка", enemy: "промах: карточка соперников", stop: "остановились сами", time: "время вышло", noclue: "капитан не успел с подсказкой", skip: "пропущен ведущим", cleared: "все слова команды открыты", assassin: "открыта ловушка", few: "в команде никого не осталось", host: "ведущий закончил партию" };
const AW_RU = { sniper: "Снайпер", oops: "Рисковая рука", trap: "Попал в ловушку", clue: "Лучшая подсказка" };
const REJ_RU = { bad_phase: "сейчас так нельзя", already_open: "уже открыта", not_your_turn: "сейчас ходит другая команда", captain: "капитан не открывает карточки — он подсказывает", none_yet: "«Хватит» — после первого слова", too_soon: "секунду — прочитай подсказку", on_board: "это слово есть на поле", used: "это слово уже звучало в партии", one_word: "только одно слово", too_many: "столько слов у вас не осталось", bad_number: "число от 1 до 9", mixed: "буквы из разных алфавитов", digits: "без цифр", short: "слишком короткое", long: "слишком длинное", slow_down: "не так быстро", not_captain: "подсказывает только капитан" };

// ---------- ведущий: одноразовая команда ----------
if (name === "host") {
  const ws = new WebSocket(wsUrl);
  let done = false;
  const out = (s) => { if (!done) { done = true; console.log(s); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 100); } };
  ws.on("open", () => ws.send(JSON.stringify({ type: "host", token: cmd })));
  ws.on("error", (e) => out("ошибка: " + e.message));
  let acted = false;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "error") return out("ошибка: " + m.error);
    if (m.type === "rejected") return out(`ОТКАЗ ${m.action}: ${m.reason}${m.red != null ? ` (красных ${m.red}, синих ${m.blue})` : ""}`);
    if (m.type === "host_ok" && !acted) {
      acted = true;
      const [a, b] = rest;
      const msg = a === "start" ? { type: "start" } : a === "end" ? { type: "end" } : a === "lobby" ? { type: "lobby" } : a === "skip" ? { type: "skip" } : a === "mode" ? { type: "settings", settings: { mode: b } } : null;
      if (!msg) return out("команды: start | end | lobby | skip | mode words|pics");
      ws.send(JSON.stringify(msg));
      setTimeout(() => out(`отправлено: ${JSON.stringify(msg)}`), 700);
    }
  });
  setTimeout(() => out("таймаут"), 8000);
  return;
}

// ---------- описание экрана ----------
const picChar = (id) => String.fromCodePoint(...String(id).split("-").map((h) => parseInt(h, 16)));
const cellText = (c) => (c.w !== undefined ? String(c.w).toUpperCase() : picChar(c.p));

function describe(S, ctx) {
  const s = S.state;
  if (!s) return "Ещё нет состояния (сокет подключается).";
  const P = (id) => (s.players.find((p) => p.id === id) || { name: "?" }).name;
  const me = S.me ? s.players.find((p) => p.id === S.me) : null;
  const out = [];
  const left = s.phaseEnd ? Math.max(0, Math.round((s.phaseEnd - s.serverNow) / 1000)) : null;
  const rate = ctx.rate();
  const real = left != null && rate ? ` (≈${Math.round(left / rate)} реальных с)` : "";
  const isCap = !!(s.me && s.me.captain);
  const role = !me ? "не в игре" : !me.team ? "без команды" : `${TEAM_RU[me.team]}, ${isCap ? "КАПИТАН" : "оперативник"}`;
  out.push(`ТЫ: ${name} · ${role} · комната ${code} · режим ${s.settings.mode === "pics" ? "КАРТИНКИ" : "СЛОВА"} · язык ${s.settings.lang}`);
  const inGame = s.board && s.phase !== "lobby";
  if (s.phase === "lobby" || (s.phase === "finished" && !s.board)) {
    out.push("ЛОБИ. Команды: " + ["red", "blue"].map((t) => `${TEAM_RU[t]}: ${s.players.filter((p) => !p.left && p.team === t).map((p) => p.name + (s.claim && s.claim[t] === p.id ? "★" : "")).join(", ") || "—"}`).join(" | "));
    const loose = s.players.filter((p) => !p.left && !p.team);
    if (loose.length) out.push("Без команды: " + loose.map((p) => p.name).join(", "));
    out.push(`Команды: team red|blue, captain (хочу капитаном). Нужно ≥ ${s.minPlayers} игроков, в каждой команде ≥ ${s.minTeam}. Старт нажимает ведущий.`);
  }
  if (inGame) {
    const c = s.counts;
    out.push(`ФАЗА: ${s.phase}${left != null && s.phase !== "finished" ? ` · осталось ~${left} игровых с${real}` : ""}`);
    out.push(`ОСТАЛОСЬ ОТКРЫТЬ: красные ▲ ${c.red.left}/${c.red.total} · синие ● ${c.blue.left}/${c.blue.total}` + (s.phase !== "finished" ? ` · ХОД: ${TEAM_RU[s.team]}` : ""));
    out.push("КАПИТАНЫ: " + ["red", "blue"].map((t) => `${TEAM_RU[t]} — ${P(s.caps[t])}`).join(" | "));
    if (s.clue) out.push(`ПОДСКАЗКА: «${s.clue.word}» ${s.clue.n} (${TEAM_RU[s.clue.team]}) · открыто в этом ходу ${s.opened}, можно ещё ${s.clue.n - s.opened}`);
    // поле
    const rows = [];
    for (let r = 0; r < 5; r++) {
      const cells = [];
      for (let k = 0; k < 5; k++) {
        const i = r * 5 + k, cd = s.board[i];
        let t = `${i}:${cellText(cd)}`;
        if (cd.o) t += `[${cd.t === "red" ? "К✓" : cd.t === "blue" ? "С✓" : cd.t === "n" ? "пусто" : "ЛОВУШКА"}]`;
        else if (cd.t) t += `(${cd.t === "red" ? "к" : cd.t === "blue" ? "с" : cd.t === "n" ? "·" : "☠"})`;
        cells.push(t);
      }
      rows.push("  " + cells.join("  "));
    }
    out.push("ПОЛЕ (номер:карточка; [..] — открыта" + (isCap ? "; (к) красная, (с) синяя, (·) нейтральная, (☠) ЛОВУШКА — это ключ, только у капитанов" : "") + "):");
    out.push(...rows);
    if (s.log.length) out.push("ПРОШЛЫЕ ХОДЫ: " + s.log.slice(-4).map((e) => `${GLYPH[e.team]} ${e.word ? `«${e.word}» ${e.n}` : "без подсказки"} → ${e.hits.map((h) => GLYPH[h.t]).join("") || "—"} — ${END_RU[e.end] || e.end}`).join("; "));
    // что делать
    const mt = s.me && s.me.team;
    if (s.phase === "draw") out.push(`ЖРЕБИЙ: начинают ${TEAM_RU[s.starter]}.`);
    else if (s.phase === "clue") {
      if (isCap && mt === s.team) out.push(`ТВОЙ ХОД КАК КАПИТАНА: придумай подсказку — ОДНО слово и число 1..${Math.min(9, c[s.team].left)} → команда: clue <слово> <число>`);
      else if (mt === s.team) out.push("Твой капитан придумывает подсказку. Подожди (wait).");
      else out.push(`Ходят ${TEAM_RU[s.team]}: капитан думает над подсказкой. Молчи и смотри.`);
    } else if (s.phase === "guess") {
      if (s.me && s.me.canOpen) out.push(`ТВОЙ ХОД КАК ОПЕРАТИВНИКА: команда open <номер> — карточка откроется СРАЗУ, без подтверждения (первый тап решает за всех)${s.opened > 0 ? "; stop — закончить ход" : ""}.`);
      else if (isCap && mt === s.team) out.push("Ты капитан: молчи, пока команда угадывает, и смотри.");
      else out.push(`Угадывают ${TEAM_RU[s.team]}. Ты ждёшь.`);
    } else if (s.phase === "swap") out.push(`Ход переходит: ${TEAM_RU[s.team]}.`);
    else if (s.phase === "paused") out.push("ПАУЗА: три хода подряд прошли впустую. Любой игрок может продолжить: команда resume (на телефоне — кнопка «Играем!»).");
    else if (s.phase === "finished") {
      out.push(`ИГРА ОКОНЧЕНА: ${s.winner ? "победа — " + TEAM_RU[s.winner] : "без победителя"} (${END_RU[s.finishedReason] || s.finishedReason}). Серия: красные ${s.wins.red} : ${s.wins.blue} синие.`);
      if (s.awards && s.awards.length) out.push("НАГРАДЫ: " + s.awards.map((a) => `${AW_RU[a.key] || a.key}${a.playerId ? " — " + P(a.playerId) : ""}${a.word ? ` «${a.word}»` : ""}${a.value != null ? " (" + a.value + ")" : ""}`).join("; "));
      out.push("Можно сменить команду (team). Новую партию запускает ведущий.");
    }
  }
  if (ctx.notes.length) { out.push("СОБЫТИЯ С ПРОШЛОГО ВЫЗОВА:"); out.push(...ctx.notes.map((n) => "  • " + n)); ctx.notes.length = 0; }
  return out.join("\n");
}

// ---------- демон ----------
function daemon() {
  const S = { ws: null, state: null, me: null, token: null, closing: false, drop: false, inbox: [], waiters: [], t0: null };
  const notes = [];
  const samples = [];
  const ctx = { notes, rate() { if (samples.length < 2) return null; const a = samples[0], b = samples[samples.length - 1]; return b.real - a.real > 4000 ? (b.srv - a.srv) / (b.real - a.real) : null; } };
  try { S.token = JSON.parse(fs.readFileSync(tokFile, "utf8")).token; } catch {}
  const log = (o) => { try { fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...o }) + "\n"); } catch {} };
  const pushRaw = (m) => { S.inbox.push(m); if (S.inbox.length > 200) S.inbox.shift(); };
  const sigOf = (s) => s ? [s.game, s.phase, s.team, s.opened, s.log.length, s.clue ? s.clue.word : "", s.board ? s.board.filter((c) => c.o).length : 0, s.players.filter((p) => !p.left).length, s.players.map((p) => p.team).join(""), s.me ? s.me.canOpen : "", s.me ? s.me.captain : ""].join(":") : "";
  const notify = () => { const w = S.waiters.splice(0); w.forEach((f) => f()); };

  function connect() {
    if (S.closing) return;
    const ws = new WebSocket(wsUrl);
    S.ws = ws;
    ws.on("open", () => log({ ev: "ws_open" }));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      pushRaw(m);
      if (m.type === "hello") {
        if (S.token) ws.send(JSON.stringify({ type: "join", token: S.token }));
        else ws.send(JSON.stringify({ type: "join", name }));
      }
      if (m.type === "joined") { S.me = m.playerId; S.token = m.token; fs.writeFileSync(tokFile, JSON.stringify({ token: m.token })); if (m.name && m.name !== name) notes.push(`Тебя записали как «${m.name}»`); log({ ev: "joined" }); }
      if (m.type === "hello" || m.type === "state") {
        const prev = sigOf(S.state);
        S.state = m.state;
        samples.push({ real: Date.now(), srv: m.state.serverNow });
        if (samples.length > 30) samples.splice(1, 1);
        const sig = sigOf(S.state);
        if (sig !== prev) {
          const s = S.state;
          log({ ev: "state", srv: s.serverNow, game: s.game, phase: s.phase, team: s.team, opened: s.opened, logLen: s.log.length, left: s.counts ? [s.counts.red.left, s.counts.blue.left] : null, clue: s.clue ? [s.clue.word, s.clue.n] : null, phaseEnd: s.phaseEnd, n: s.players.filter((p) => !p.left).length });
          notify();
        }
      }
      if (m.type === "event") {
        const e = m.event, s = S.state;
        const P = (id) => (s && s.players.find((p) => p.id === id) || { name: "?" }).name;
        log({ ev: "event", e: e.type, ...e });
        if (e.type === "clue") notes.push(`Подсказка ${TEAM_RU[e.team]}: «${e.word}» ${e.n}`);
        if (e.type === "open") notes.push(`${P(e.by)} (${TEAM_RU[e.team]}) открыл карточку ${e.i}: ${e.t === "x" ? "ЛОВУШКА!" : e.t === "n" ? "нейтральная" : e.t === "red" ? "красная" : "синяя"}${e.t === e.team ? " — своя ✓" : e.t === "x" ? "" : " — мимо ✗"}`);
        if (e.type === "turn_end") notes.push(`Ход ${TEAM_RU[e.team]} закончен: ${END_RU[e.reason] || e.reason}`);
        if (e.type === "captain") notes.push(`Капитан ${TEAM_RU[e.team]}: теперь ${P(e.playerId)} — прежний ${e.reason === "left" ? "ушёл" : "пропал со связи"}`);
        if (e.type === "paused") notes.push("ПАУЗА: три хода подряд прошли впустую");
        if (e.type === "resumed") notes.push("Игра продолжается");
        if (e.type === "final") notes.push(`КОНЕЦ ИГРЫ: ${e.winner ? "победа " + TEAM_RU[e.winner] : "без победителя"} (${END_RU[e.reason] || e.reason})`);
        if (e.type === "started") { notes.push(`Партия началась (№${e.game}), начинают ${TEAM_RU[e.starter]}`); for (const t of ["red", "blue"]) try { fs.unlinkSync(talkFile(t)); } catch {} }
        notify();
      }
      if (m.type === "rejected") { notes.push(`НЕ ВЫШЛО (${m.action}): ${REJ_RU[m.reason] || m.reason}${m.word ? ` — «${m.word}»` : ""}`); log({ ev: "rejected", action: m.action, reason: m.reason }); notify(); }
      if (m.type === "error") { notes.push(`ОШИБКА: ${m.error}`); log({ ev: "error", error: m.error }); if (m.error === "token_gone") { S.token = null; ws.send(JSON.stringify({ type: "join", name })); } notify(); }
      if (m.type === "kicked") { notes.push("ТЕБЯ УБРАЛИ из комнаты ведущим"); notify(); }
      if (m.type === "replaced") { notes.push("Ты зашёл с другого экрана — этот отключён"); notify(); }
    });
    ws.on("close", () => { log({ ev: "ws_close" }); if (!S.closing && !S.drop) setTimeout(connect, 800); });
    ws.on("error", () => {});
  }
  connect();

  const send = (msg) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify(msg));
  // действие: отправить и подождать ответ (изменение экрана или отказ), до 2 с
  const act = (msg) => new Promise((res) => {
    const sig = sigOf(S.state), n0 = notes.length;
    log({ ev: "cmd", msg: msg.type });
    send(msg);
    const t = setTimeout(done, 2000);
    S.waiters.push(done);
    function done() { clearTimeout(t); setTimeout(res, 150); }
  });
  const waitChange = (ms) => new Promise((res) => {
    const t = setTimeout(res, ms);
    S.waiters.push(() => { clearTimeout(t); setTimeout(res, 250); });
  });
  const talkFile = (team) => path.join(dir, `${code}-talk-${team}.txt`);

  const srv = net.createServer((sock) => {
    let buf = "";
    sock.on("data", async (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const { c, a } = JSON.parse(buf.split("\n")[0]);
      buf = "";
      let out = "";
      try { out = await handle(c, a); } catch (e) { out = "сбой пульта: " + e.message; }
      sock.end(out + "\n");
    });
  });
  async function handle(c, a) {
    const me = () => S.state && S.me && S.state.players.find((p) => p.id === S.me);
    switch (c) {
      case "join": await waitChange(2500); return describe(S, ctx);
      case "state": return describe(S, ctx);
      case "wait": { const sec = Number(a[0] || 90); await waitChange(sec * 1000); return describe(S, ctx); }
      case "team": await act({ type: "team", team: a[0] === "red" || a[0] === "blue" ? a[0] : null }); return describe(S, ctx);
      case "captain": await act({ type: "captain" }); return describe(S, ctx);
      case "clue": { const n = Number(a[a.length - 1]); await act({ type: "clue", text: a.slice(0, -1).join(" "), n }); return describe(S, ctx); }
      case "open": await act({ type: "open", i: Number(a[0]) }); return describe(S, ctx);
      case "stop": await act({ type: "stop" }); return describe(S, ctx);
      case "resume": await act({ type: "resume" }); return describe(S, ctx);
      case "avatar": await act({ type: "avatar", avatar: a[0] }); return describe(S, ctx);
      case "rename": await act({ type: "rename", name: a.join(" ") }); return describe(S, ctx);
      case "leave": await act({ type: "leave" }); return describe(S, ctx);
      case "say": {
        const m = me();
        if (!m || !m.team) return "Ты ещё не в команде.";
        fs.appendFileSync(talkFile(m.team), `[${new Date().toTimeString().slice(0, 8)}] ${name}: ${a.join(" ")}\n`);
        log({ ev: "say" });
        return "сказано за столом";
      }
      case "talk": {
        const m = me();
        if (!m || !m.team) return "Ты ещё не в команде.";
        try { return fs.readFileSync(talkFile(m.team), "utf8").split("\n").slice(-25).join("\n") || "(тихо)"; } catch { return "(тихо)"; }
      }
      case "drop": {
        const sec = Number(a[0] || 5);
        S.drop = true; try { S.ws.terminate(); } catch {}
        log({ ev: "drop", sec });
        setTimeout(() => { S.drop = false; connect(); }, sec * 1000);
        return `сокет оборван на ${sec} с; потом переподключусь по токену`;
      }
      case "raw": { const before = S.inbox.length; try { send(JSON.parse(a.join(" "))); } catch (e) { return "не JSON: " + e.message; } await new Promise((r) => setTimeout(r, 900)); return S.inbox.slice(before).map((m) => JSON.stringify(m).slice(0, 400)).join("\n") || "(ответа нет)"; }
      case "log": return S.inbox.slice(-Number(a[0] || 10)).map((m) => JSON.stringify(m).slice(0, 300)).join("\n");
      case "quit": setTimeout(() => process.exit(0), 100); S.closing = true; try { S.ws.close(); } catch {} return "демон закрыт";
      default: return "неизвестная команда";
    }
  }
  try { fs.unlinkSync(sockPath); } catch {}
  srv.listen(sockPath);
  process.on("SIGTERM", () => { try { fs.unlinkSync(sockPath); } catch {} process.exit(0); });
}

// ---------- клиент ----------
function ask(c, a) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let out = "";
    sock.on("connect", () => sock.write(JSON.stringify({ c, a }) + "\n"));
    sock.on("data", (d) => (out += d));
    sock.on("end", () => resolve(out.trim()));
    sock.on("error", reject);
  });
}

if (DAEMON) {
  daemon();
} else {
  (async () => {
    const c = cmd || "state";
    const alive = await ask("state", []).then(() => true, () => false);
    if (!alive) {
      if (c !== "join") { console.log("сначала: join"); process.exit(1); }
      const child = spawn(process.execPath, [__filename, "--daemon", base, code, name], { detached: true, stdio: "ignore" });
      child.unref();
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150)); if (await ask("state", []).then(() => true, () => false)) break; }
    }
    console.log(await ask(c, rest));
    process.exit(0);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
