"use strict";

/*
 * Сервер аукциона: HTTP (создание комнаты, health) + WebSocket (игра).
 * Состояние комнат в памяти, дамп в JSON раз в 5 с, чтобы деплой не убивал живые партии.
 *
 * Запуск:  node server.js            (порт PORT, по умолчанию 3000)
 * Разработка: STATIC=.. node server.js — раздаёт статику сайта из родительской папки, чтобы открывать
 * auction.html / auction-board.html с того же origin, что и WebSocket.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { WebSocketServer } = require("ws");
const { Game, clampSettings, cleanName } = require("./game");
const { judge } = require("./judge");
const { MODES } = require("./modes");
const { decide, decideDraft, STRATEGIES } = require("./bots");

const PORT = Number(process.env.PORT || 3000);
const STATIC = process.env.STATIC ? path.resolve(process.env.STATIC) : null;
const DEV = process.env.NODE_ENV === "development";
const DUMP = process.env.DUMP_FILE || path.join(__dirname, "state", "rooms.json");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const ROOM_TTL = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000); // комната без активности 30 минут — удаляется (короче — только для тестов)
const SWEEP = Math.min(25000, Math.max(1000, Math.floor(ROOM_TTL / 4))); // ping/pong и уборка комнат
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);
const MAX_PLAYERS = 100; // по сути без лимита; минимум для старта — 2
// ---- лимиты против исчерпания ресурсов ----
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 20); // сколько живых комнат на один адрес
const MAX_SOCKETS_PER_ROOM = Number(process.env.MAX_SOCKETS_PER_ROOM || 200); // сокетов+poll-сессий на комнату
const MAX_TOTAL_SOCKETS = Number(process.env.MAX_TOTAL_SOCKETS || 3000); // сокетов+poll-сессий на процесс
const MAX_JUDGE_CALLS = Number(process.env.MAX_JUDGE_CALLS || 12); // платных запросов к OpenAI на комнату
const EVICT_GRACE_MS = Number(process.env.EVICT_GRACE_MS || 10000); // свежую пустую комнату не вытесняем — доска ещё подключается (0 — только для тестов)
// Сколько ждём вернувшегося игрока, прежде чем считать его выпавшим. Моргнувший на телефоне
// Wi-Fi — норма вечеринки, а не событие партии: без этой грации обрыв на две секунды ставил игру
// на авто-паузу, снять которую мог только ведущий, — цена секундного моргания была минута ожидания.
const OFFLINE_GRACE_MS = Number(process.env.OFFLINE_GRACE_MS || 8000);
// Сколько подряд не отвеченных ping терпим. Раньше рвали после первого: подвисший на пару секунд
// телефон (сборка мусора, переключение Wi-Fi→LTE) получал обрыв на ровном месте.
const PONG_MISSES = Number(process.env.PONG_MISSES || 3);
// Потолок неотправленного на один сокет. Телефон на плохой сети читает медленнее, чем мы пишем,
// и очередь на отправку растёт в памяти процесса без предела — при лимите контейнера 256 МБ это
// та же дорога к OOM, что и раздутый дамп. Рвём такой сокет: клиент вернётся и получит снапшот
// целиком, поэтому терять тут нечего — в отличие от систем, где клиент доигрывает пропущенное.
const SEND_BUFFER_LIMIT = Number(process.env.SEND_BUFFER_LIMIT || 1048576);
const MSG_RATE = Number(process.env.MSG_RATE || 40); // сообщений в секунду на один сокет
// Соединения без игрока и без доски. Честный клиент шлёт join/host сразу после открытия, так что
// «анонимов» в комнате единицы; сотня анонимных poll-сессий забивала лимит комнаты, и живые игроки
// получали 503. Свой маленький потолок и короткий срок жизни (poll-аноним без join дольше
// ANON_TTL_MS закрывается при обходе).
const MAX_ANON_PER_ROOM = Number(process.env.MAX_ANON_PER_ROOM || 30);
const MAX_ANON_PER_IP = Number(process.env.MAX_ANON_PER_IP || 10); // из них — с одного адреса
// Сжатие WebSocket (M15) — по умолчанию ВЫКЛЮЧЕНО, включается WS_DEFLATE=1. Замер (macOS, партии
// со ставками, окна 2^10, memLevel 4, порог 1 КБ): трафик state меньше в 4 раза, но RSS 225 сокетов —
// 161 МБ против 109 МБ без сжатия, 450 сокетов — 221 МБ против 112 МБ и продолжает расти (zlib-контекст
// и фрагментация на каждый сокет). При mem_limit 256m и потолке 3000 соединений это прямой путь к OOM.
// Трафик вместо этого срезан на уровне протокола (state без повторов, d=1) — ~55% от полного.
const WS_DEFLATE = process.env.WS_DEFLATE === "1";
const ANON_TTL_MS = Number(process.env.ANON_TTL_MS || 30000);
// Сколько ждём следующий опрос после ответа на предыдущий, прежде чем считать poll-клиента ушедшим
const POLL_GAP_MS = Number(process.env.POLL_GAP_MS || 12000);
const MAX_MSG_BYTES = 8192; // максимум на одно входящее сообщение
// Карточки лотов по языкам: data/<kind>.json — русские, data/<lang>/<kind>.json — переводы.
// Категории, для которых перевода ещё нет, отдаются по-русски: игра должна работать и с неполным
// переводом, а не падать на отсутствующем файле.
const LANGS = ["ru", "en", "el"];
const KINDS_BY_LANG = { ru: {} };
for (const f of fs.readdirSync(path.join(__dirname, "data"))) {
  if (f.endsWith(".json")) KINDS_BY_LANG.ru[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(__dirname, "data", f), "utf8"));
}
for (const lang of LANGS.slice(1)) {
  const dir = path.join(__dirname, "data", lang);
  KINDS_BY_LANG[lang] = Object.assign({}, KINDS_BY_LANG.ru);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const kind = f.slice(0, -5);
    const cards = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    // перевод обязан совпадать по длине с русским: иначе номера карт в дампе поедут
    if (KINDS_BY_LANG.ru[kind] && cards.length === KINDS_BY_LANG.ru[kind].length) {
      // Русских исполнителей iTunes RU-витрины знает только кириллицей, а в переводе у них транслит
      // (Kino, Zemfira) — превью не находилось почти ни для кого. Оригинальное имя кладём рядом.
      cards.forEach((c, i) => { const orig = KINDS_BY_LANG.ru[kind][i]; if (c.ru && orig && orig.name !== c.name) c.name_ru = orig.name; });
      KINDS_BY_LANG[lang][kind] = cards;
    } else console.warn(`[auction] ${lang}/${f}: длина не совпадает с русской колодой, беру русскую`);
  }
}
const KINDS = KINDS_BY_LANG.ru; // список категорий и запасная колода
const cardsFor = (kind, lang) => (KINDS_BY_LANG[lang] || KINDS_BY_LANG.ru)[kind] || KINDS[kind];
if (!OPENAI_API_KEY) console.warn("[auction] OPENAI_API_KEY не задан — судья будет через голосование");

// Номера карт в колоде категории. Game.create тасует через slice, поэтому объекты в room.game.s.deck —
// это те же объекты, что в KINDS[kind]: колоду можно дампить списком номеров вместо самих карточек.
// Без этого в файл уходила вся колода на каждую комнату (305 КБ против 2,5 КБ), дамп 100 комнат
// разгонял RSS до 400 МБ при mem_limit 256m, а restore делал каждой комнате свою глубокую копию колоды.
// Индекс нужен на каждый язык: у перевода свои объекты карточек, и номер карты имеет смысл
// только внутри колоды своего языка.
const CARD_INDEX = {};
for (const lang of LANGS) {
  CARD_INDEX[lang] = {};
  for (const [kind, cards] of Object.entries(KINDS_BY_LANG[lang])) {
    const m = new Map();
    cards.forEach((c, i) => m.set(c, i));
    CARD_INDEX[lang][kind] = m;
  }
}
const langOf = (state) => (state && state.settings && state.settings.lang) || "ru";

// ---------- комнаты ----------

const rooms = new Map(); // code → room
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // без похожих символов

function newCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

// суммарное число живых соединений (WebSocket + long-polling) по всем комнатам
function totalSockets() {
  let n = 0;
  for (const r of rooms.values()) n += r.sockets.size;
  return n;
}

// снести комнату целиком: погасить таймеры, оповестить и разорвать соединения, вычистить poll-сессии
function destroyRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.voteTimer);
  clearInterval(room.botTimer);
  for (const t of room.offlineTimers.values()) clearTimeout(t);
  room.offlineTimers.clear();
  // Сначала дожидаемся, пока кадр «room_expired» уйдёт, и только потом рвём сокет: со сжатием
  // (perMessageDeflate) terminate сразу после send терял кадр, и игрок видел «нет связи» вместо
  // «комната закрылась». Предохранитель на 1 с — если сокет уже не пишет.
  for (const c of room.sockets) {
    try {
      if (c.poll || c.ws.readyState !== 1) { send(c.ws, { type: "error", error: "room_expired" }); c.ws.terminate(); continue; }
      const ws = c.ws;
      const kill = setTimeout(() => { try { ws.terminate(); } catch {} }, 1000);
      ws.send(JSON.stringify({ type: "error", error: "room_expired" }), () => { clearTimeout(kill); try { ws.close(4000, "room_expired"); } catch {} setTimeout(() => { try { ws.terminate(); } catch {} }, 1000).unref(); });
    } catch {}
  }
  for (const [sid, c] of pollClients) if (c.room === room) pollClients.delete(sid);
  rooms.delete(room.code);
}

// вытеснить самую старую пустую (без соединений) комнату в лобби/финале — чтобы griefer,
// набивший процесс пустыми комнатами, не блокировал создание новых игр всем остальным
function evictOldestEmpty(ip) {
  let victim = null;
  const cutoff = now() - EVICT_GRACE_MS;
  for (const r of rooms.values()) {
    if (ip && r.ip !== ip) continue; // вытесняем только брошенные комнаты того же адреса
    if (r.sockets.size === 0 && r.touched < cutoff && (r.game.s.phase === "lobby" || r.game.s.phase === "finished")) {
      if (!victim || r.touched < victim.touched) victim = r;
    }
  }
  if (!victim) return false;
  destroyRoom(victim);
  return true;
}

function createRoom({ kind = "artist", settings = {}, speed = 1, ip = "" } = {}) {
  if (!KINDS[kind]) throw new Error("unknown kind");
  if (ip) {
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    // Упёрлись в лимит — сначала пробуем освободить брошенную комнату этого же адреса.
    // Отказ только если все его комнаты живые: так лимит не запирает того, кто просто переигрывает,
    // и ошибка в проксировании адреса не превращается в отказ всему сайту.
    if (mine >= MAX_ROOMS_PER_IP && !evictOldestEmpty(ip)) throw new Error("too many rooms from this address");
  }
  if (rooms.size >= MAX_ROOMS && !evictOldestEmpty()) throw new Error("too many rooms");
  const code = newCode();
  const room = {
    code,
    ip,
    hostToken: crypto.randomBytes(12).toString("base64url"),
    game: Game.create({ kind, cards: cardsFor(kind, clampSettings(settings, kind).lang), settings }),
    tokens: {}, // playerToken → playerId
    sockets: new Set(), // {ws, playerId?, host?}
    offlineTimers: new Map(), // playerId → таймер «ещё ждём, не объявляем выпавшим»
    dropCounts: new Map(), // playerId → сколько раз за партию терял связь
    timer: null,
    voteTimer: null,
    touched: Date.now(),
    speed: DEV ? Math.max(1, Math.min(20, Number(speed) || 1)) : 1,
    skew: 0,
    bots: [], // {playerId, strategy}
    botTimer: null,
    judging: false,
    judgeCalls: 0,
  };
  rooms.set(code, room);
  return room;
}

// частота входящих сообщений на один сокет: флуд по одному соединению не жжёт CPU всей комнаты
function rateOk(client) {
  const t = now();
  if (!client.rl || t - client.rl.ts >= 1000) client.rl = { ts: t, n: 0 };
  return ++client.rl.n <= MSG_RATE;
}

const now = () => Date.now();
// Часы комнаты. При speed > 1 (только в разработке) таймер просыпается раньше дедлайна,
// поэтому комната держит свой сдвиг и «догоняет» дедлайн — иначе tick ничего не делал бы.
const clock = (room) => now() + (room.skew || 0);

// таймеры игры: после каждого изменения пересчитываем ближайший deadline
// ближайший момент, когда движку есть что сделать: обычный дедлайн фазы, а на паузе —
// только минута ожидания единственного добирающего (§7.4), остальные таймеры заморожены
const nextAt = (s) => (s.paused ? s.paused.waitUntil || 0 : s.deadline || 0);

function schedule(room) {
  clearTimeout(room.timer);
  const s = room.game.s;
  if (s.phase === "finished" || s.phase === "lobby" || !nextAt(s)) return;
  const wait = Math.max(0, (nextAt(s) - clock(room)) / room.speed);
  room.timer = setTimeout(() => {
    try {
      const at = nextAt(room.game.s);
      if (at) room.skew += Math.max(0, at - clock(room));
      afterChange(room, room.game.tick(clock(room)));
    } catch (err) {
      console.error("[auction] шаг таймера упал:", err);
    }
  }, wait);
}

// Сводка по обрывам за интервал уборки: без неё в логе видно только «сколько сейчас соединений»,
// а нужен ответ на вопрос «рвётся ли у нас вообще и у скольких». Сбрасывается каждым обходом.
let statBlips = 0, statBack = 0, statDrops = 0;

// Игрок пропал со связи. Не объявляем его выпавшим сразу: если он вернётся в пределах грации,
// партия об обрыве даже не узнает. Объявляем — только когда он действительно не вернулся.
function scheduleOffline(room, playerId) {
  if (!playerId) return;
  if ([...room.sockets].some((c) => c.playerId === playerId)) return; // открыт ещё один сокет того же игрока
  if (room.offlineTimers.has(playerId)) return;
  const name = room.game.player(playerId)?.name || playerId;
  // Номер обрыва за партию: по нему из `docker logs` сразу видно, у кого именно рвётся,
  // без воспроизведения и без опроса гостей «а у тебя как со связью?».
  const nth = (room.dropCounts.get(playerId) || 0) + 1;
  room.dropCounts.set(playerId, nth);
  statBlips++;
  console.log(`[auction] ${room.code}: ${name} потерял связь (обрыв №${nth} за партию), ждём ${OFFLINE_GRACE_MS} мс`);
  const t = setTimeout(() => {
    room.offlineTimers.delete(playerId);
    if (!rooms.has(room.code)) return;
    if ([...room.sockets].some((c) => c.playerId === playerId)) return; // успел вернуться
    statDrops++;
    console.log(`[auction] ${room.code}: ${name} не вернулся — offline`);
    const ev = room.game.setOnline(playerId, false, clock(room));
    afterChange(room, [{ type: "offline", playerId }, ...ev]);
  }, OFFLINE_GRACE_MS);
  if (t.unref) t.unref();
  room.offlineTimers.set(playerId, t);
}

function cancelOffline(room, playerId) {
  const t = room.offlineTimers.get(playerId);
  if (!t) return;
  clearTimeout(t);
  room.offlineTimers.delete(playerId);
  statBack++;
  console.log(`[auction] ${room.code}: ${room.game.player(playerId)?.name || playerId} вернулся в пределах грации`);
}

// Авто-пауза «ждём игроков» снимается сама, как только причины больше нет (см. tooManyOffline)
// (§7.4) — в том числе когда отключённого выгнали. Ручную паузу ведущего не трогаем: её ставили
// осознанно, и снимать её за ведущего нельзя.
function autoResumeIfBack(room) {
  const ev = room.game.autoResume(clock(room));
  if (ev.length) console.log(`[auction] ${room.code}: игроки вернулись — авто-пауза снята`);
  return ev;
}

function afterChange(room, events = []) {
  room.touched = now();
  const s = room.game.s;
  broadcast(room, { type: "state", state: snapshotWithVoting(room) });
  for (const e of events) broadcast(room, { type: "event", event: e });
  // судейство запускаем ровно один раз: пока идёт голосование или запрос к судье — не трогаем
  // startJudging асинхронна: без catch любая её ошибка стала бы unhandledRejection и уронила процесс
  if (s.phase === "finished" && !s.results && !s.voting && !room.judging) {
    startJudging(room).catch((err) => { room.judging = false; console.error("[auction] судейство упало:", err.message); });
  }
  schedule(room);
}

// ---- state без повторов (M16) ----
// Снимок уходит всем на каждое событие, а тяжёлые его части — настройки, карточка лота, лоты
// игроков — между событиями почти не меняются: ставка за ставкой гоняли одни и те же килобайты.
// Клиент, открывший соединение с d=1, получает такие части, только когда они изменились для него
// (сравниваем с тем, что ему уже отправили), остальное берёт из своего кэша (auctionMergeState в
// auction-shared.js). Старые клиенты без d=1 получают полный снимок, как раньше; hello — всегда полный.
const HEAVY = ["settings", "lot", "lots"];
function packState(snap) {
  const lots = {};
  const players = snap.players.map(({ lots: l, ...p }) => { lots[p.id] = l; return p; });
  const parts = { settings: JSON.stringify(snap.settings), lot: JSON.stringify(snap.lot), lots: JSON.stringify(lots) };
  // settings/lot = undefined JSON выкидывает — в base их нет, дописываем по надобности
  const base = JSON.stringify({ ...snap, settings: undefined, lot: undefined, players, d: 1 });
  return { full: null, snap, base, parts };
}
function stateData(packed, c) {
  if (!c.delta) return packed.full || (packed.full = JSON.stringify({ type: "state", state: packed.snap }));
  const sent = c.sent || (c.sent = {});
  let extra = "";
  for (const k of HEAVY) if (sent[k] !== packed.parts[k]) { sent[k] = packed.parts[k]; extra += `,"${k}":${packed.parts[k]}`; }
  return `{"type":"state","state":${packed.base.slice(0, -1)}${extra}}}`;
}
// hello несёт полный снимок: запоминаем, что у клиента теперь есть, — дальше шлём ему только разницу
function sendHello(room, c) {
  const snap = snapshotWithVoting(room);
  if (c.delta) c.sent = packState(snap).parts;
  send(c.ws, { type: "hello", code: room.code, state: snap, kinds: Object.keys(KINDS) });
}

function broadcast(room, msg) {
  const packed = msg.type === "state" ? packState(msg.state) : null;
  const data = packed ? null : JSON.stringify(msg);
  for (const c of room.sockets) {
    if (c.ws.readyState !== 1) continue;
    // У poll-сессии буфера нет: её очередь ограничена сроком жизни сессии (40 с без опроса — снос).
    if (!c.poll && c.ws.bufferedAmount > SEND_BUFFER_LIMIT) {
      console.log(`[auction] ${room.code}: ${room.game.player(c.playerId)?.name || "сокет без игрока"} не читает, буфер ${Math.round(c.ws.bufferedAmount / 1024)} КБ — рвём`);
      c.ws.terminate();
      continue;
    }
    c.ws.send(packed ? stateData(packed, c) : data);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------- судья ----------

// Единственный текст, который сервер пишет клиенту сам, — остальное приходит от модели уже
// на языке партии. Без этой таблицы он оставался русским на английском и греческом экране.
// «играли не все» было неточно: причина не в явке, а в том, что ни у кого не набралось лотов
const NO_JUDGE_SUMMARY = {
  ru: "Судить нечего — лоты никто не собрал.",
  en: "Nothing to judge — nobody collected any lots.",
  el: "Δεν έχει τι να κριθεί — κανείς δεν μάζεψε λοτ.",
};
// Лайнап собрал один человек: сравнивать не с чем, он и победил. Ни судьи, ни очков тут нет —
// раньше доска писала «ChatGPT…» и «100» даже в комнате с голосованием.
const SINGLE_SUMMARY = {
  ru: "Лайнап собрал только один игрок — сравнивать не с чем, он и победил.",
  en: "Only one player collected a lineup — nothing to compare, so they win.",
  el: "Μόνο ένας παίκτης μάζεψε λάιναπ — δεν υπάρχει σύγκριση, οπότε κερδίζει.",
};

async function startJudging(room) {
  const g = room.game;
  const s = g.s;
  room.judging = true;
  const players = s.players.filter((p) => !p.left && p.lots.length);
  if (players.length < 2) {
    const r = players.map((p) => ({ playerId: p.id, score: null, verdict: "" }));
    const table = players.length ? SINGLE_SUMMARY : NO_JUDGE_SUMMARY;
    g.setJudgeResults(r, table[s.settings.lang] || table.ru);
    s.results.mode = players.length ? "single" : "none";
    afterChange(room, [{ type: "results" }]);
    room.judging = false;
    return;
  }
  if (s.settings.judge === "chatgpt" && OPENAI_API_KEY && room.judgeCalls < MAX_JUDGE_CALLS) {
    room.judgeCalls++;
    broadcast(room, { type: "event", event: { type: "judging" } });
    const lineups = players.map((p, i) => ({ pid: `p${i + 1}`, playerId: p.id, lots: p.lots }));
    try {
      const verdict = await judge({ kind: s.kind, lineups, slots: s.settings.slots, mode: s.settings.mode, lang: s.settings.lang, apiKey: OPENAI_API_KEY, model: OPENAI_MODEL });
      const byPid = Object.fromEntries(lineups.map((l) => [l.pid, l]));
      const names = Object.fromEntries(lineups.map((l) => [l.pid, g.player(l.playerId).name]));
      // p1/{{p1}} → имена; выдуманный игрок (p9, которого нет) превращается в нейтральное «игрок»
      const fix = (t) =>
        String(t || "")
          .replace(/\{\{\s*p(\d+)\s*\}\}/g, (m, n) => names[`p${n}`] || "игрок")
          .replace(/\bp(\d+)\b/g, (m, n) => names[`p${n}`] || "игрок")
          .slice(0, 400);
      const ranking = verdict.results
        .filter((r) => byPid[r.player])
        .map((r) => ({ playerId: byPid[r.player].playerId, score: r.score, verdict: fix(r.verdict) }))
        .sort((a, b) => b.score - a.score || g.player(a.playerId).spent - g.player(b.playerId).spent);
      if (ranking.length !== lineups.length) throw new Error("в вердикте не все игроки");
      afterChange(room, g.setJudgeResults(ranking, fix(verdict.summary)));
      room.judging = false;
      return;
    } catch (err) {
      console.warn(`[auction] судья не ответил (${err.message}) — голосование`);
      broadcast(room, { type: "event", event: { type: "judge_failed" } });
    }
  }
  // голосование: 30 с, потом подсчёт
  s.results = null;
  s.voting = { deadline: clock(room) + 30000 };
  room.judging = false;
  armVoting(room);
  broadcast(room, { type: "state", state: snapshotWithVoting(room) });
}

// таймер голосования живёт отдельно от room.timer: любой afterChange (например, чужой голос)
// зовёт schedule(), а тот гасит room.timer — раньше из-за этого голосование не закрывалось никогда.
function armVoting(room) {
  clearTimeout(room.voteTimer);
  const v = room.game.s.voting;
  if (!v) return;
  const wait = Math.max(0, (v.deadline - clock(room)) / room.speed);
  room.voteTimer = setTimeout(() => finishVoting(room), wait);
}

function snapshotWithVoting(room) {
  const snap = room.game.snapshot(clock(room));
  snap.voting = room.game.s.voting || null;
  return snap;
}

// все, кто вправе, проголосовали — закрываем, не дожидаясь таймера. Зовётся и после кика/ухода:
// ушёл последний непроголосовавший — ждать его 30 с незачем.
function maybeFinishVoting(room) {
  const s = room.game.s;
  if (s.phase === "finished" && s.voting && !s.results && room.game.allVoted()) finishVoting(room);
}

function finishVoting(room) {
  clearTimeout(room.voteTimer);
  const s = room.game.s;
  if (s.phase !== "finished" || s.results) return;
  s.voting = null;
  afterChange(room, room.game.closeVotes());
}

// ---------- боты (только в разработке) ----------

function addBots(room, n) {
  const names = Object.keys(STRATEGIES);
  for (let i = 0; i < n && room.game.s.players.length < MAX_PLAYERS; i++) {
    const strategy = names[i % names.length];
    const id = "bot_" + crypto.randomBytes(4).toString("hex");
    room.game.addPlayer({ id, name: `🤖 ${strategy}` });
    room.bots.push({ playerId: id, strategy });
  }
  if (!room.botTimer) {
    room.botTimer = setInterval(() => {
      const s = room.game.s;
      if (s.phase === "lobby" || s.phase === "finished") return;
      const snap = room.game.snapshot(clock(room));
      let changed = [];
      for (const b of room.bots) {
        const amount = decide(b.strategy, snap, b.playerId);
        if (amount != null) {
          const r = room.game.bid(b.playerId, amount, clock(room));
          if (r.ok) changed.push(...r.events);
        }
        const me = snap.players.find((p) => p.id === b.playerId);
        if (snap.phase === "pickup" && me?.canTake && Math.random() < 0.8) {
          const r = room.game.take(b.playerId, clock(room));
          if (r.ok) changed.push(...r.events);
        }
        // соло-добор: последним добирающим вполне может остаться бот — без этого отладка встаёт
        // на 10 секунд на каждом лоте, пока за него решает таймер
        const draft = decideDraft(b.strategy, snap, b.playerId);
        if (draft) {
          const r = draft === "take" ? room.game.take(b.playerId, clock(room)) : room.game.skip(b.playerId, clock(room));
          if (r.ok) changed.push(...r.events);
        }
      }
      if (changed.length) afterChange(room, changed);
    }, 700 / room.speed);
  }
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(STATIC, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(STATIC) || path.basename(file).startsWith(".")) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const type = MIME[path.extname(file)] || "application/octet-stream";
    // Текст жмём: на EDGE несжатые страница и скрипты (~200 КБ) давали форму входа через 40 с.
    // В проде то же делает nginx (gzip в nginx.conf), это — для dev-сервера.
    if (/text|javascript|json|svg/.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && data.length > 1024) {
      return zlib.gzip(data, (e, gz) => {
        if (e) { res.writeHead(200, { "Content-Type": type }); return res.end(data); }
        res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
        res.end(gz);
      });
    }
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "", done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    // тело больше 10 КБ — обрываем и сразу отвечаем пустым (иначе промис висел бы вечно и держал соединение)
    req.on("data", (c) => { body += c; if (body.length > 10000) { finish({}); req.destroy(); } });
    req.on("end", () => { try { finish(JSON.parse(body || "{}")); } catch { finish({}); } });
    req.on("error", () => finish({}));
  });
}

// адрес клиента похож на IP; всё остальное — подделка, её игнорируем
const looksLikeIp = (s) => /^[0-9a-fA-F:.]{3,45}$/.test(s) && /[.:]/.test(s);

function clientIp(req) {
  // Главный источник — X-Real-IP: его ставит ВНЕШНИЙ nginx ($remote_addr) и затирает всё,
  // что прислал клиент, а внутренний nginx пробрасывает как есть. Хвост X-Forwarded-For для
  // этого не годится: при двух прокси там лежит адрес внешнего nginx, один на всех, и лимит
  // комнат на адрес схлопнулся бы на весь сайт.
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (looksLikeIp(real)) return real;
  // Запасной путь для одного прокси: последний элемент цепочки дописал он сам, подделать его нельзя.
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(looksLikeIp);
  return chain.length ? chain[chain.length - 1] : (req.socket.remoteAddress || "");
}

// ---------- запасной транспорт: long-polling (когда прокси не пропускает WebSocket и буферизует потоки) ----------
// GET /auction/api/session?r=CODE → {sid, hello}; GET /auction/api/poll?sid=… → ждёт до 20 с и отдаёт накопленные сообщения;
// POST /auction/api/msg {sid, msg} — действие. Сессия умирает, если её не опрашивали 40 с.

const pollClients = new Map(); // sid → client

function openPoll(room, opts = {}) {
  const sid = crypto.randomBytes(12).toString("base64url");
  const shim = {
    readyState: 1,
    queue: [],
    waiter: null,
    send: (data) => { shim.queue.push(data); if (shim.waiter) { const w = shim.waiter; shim.waiter = null; w(); } },
    ping: () => {},
    terminate: () => closePoll(sid),
  };
  const client = { ws: shim, playerId: null, host: false, alive: true, poll: true, room, sid, lastSeen: now(), opened: now(), inflight: false, ip: opts.ip || "", delta: !!opts.delta };
  room.sockets.add(client);
  pollClients.set(sid, client);
  sendHello(room, client);
  return client;
}

function closePoll(sid) {
  const client = pollClients.get(sid);
  if (!client) return;
  const room = client.room;
  client.ws.readyState = 3;
  room.sockets.delete(client);
  pollClients.delete(sid);
  if (client.ws.waiter) { const w = client.ws.waiter; client.ws.waiter = null; w(); }
  scheduleOffline(room, client.playerId);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/auction/api/session") {
    const room = rooms.get((url.searchParams.get("r") || "").toUpperCase());
    if (!room) return json(404, { error: "no such room" });
    const ip = clientIp(req);
    if (!roomHasSpace(room, ip)) return json(503, { error: "busy" });
    const client = openPoll(room, { ip, delta: url.searchParams.get("d") === "1" });
    const first = client.ws.queue.splice(0);
    return json(200, { sid: client.sid, messages: first.map((d) => JSON.parse(d)) });
  }
  if (url.pathname === "/auction/api/poll") {
    const client = pollClients.get(String(url.searchParams.get("sid") || ""));
    if (!client) return json(410, { error: "session gone" });
    client.lastSeen = now();
    // Живость poll-сессии меряем висящим запросом: пока он висит — клиент на связи; ответили или
    // запрос оборвался — ждём следующий не дольше POLL_GAP_MS (см. обход ниже). Раньше сессию
    // закрывали только через 40 с тишины, и ушедший игрок числился на связи почти минуту.
    const flush = () => { client.inflight = false; client.lastSeen = now(); json(200, { messages: client.ws.queue.splice(0).map((d) => JSON.parse(d)) }); };
    if (client.ws.queue.length) return flush();
    // ждём новых сообщений до 20 с (короче любых таймаутов прокси)
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); client.ws.waiter = null; flush(); };
    const t = setTimeout(finish, 20000);
    client.ws.waiter = finish;
    client.inflight = true;
    res.on("close", () => {
      if (done) return;
      done = true; clearTimeout(t); client.inflight = false; client.lastSeen = now();
      if (client.ws.waiter === finish) client.ws.waiter = null;
    });
    return;
  }
  if (url.pathname === "/auction/api/msg" && req.method === "POST") {
    const body = await readJson(req);
    const client = pollClients.get(String(body.sid || ""));
    if (!client) return json(410, { error: "session gone" });
    // lastSeen здесь НЕ двигаем: POST доходит и тогда, когда висящий опрос уже мёртв (сменилась
    // сеть), и служебные ping держали бы мёртвую сессию «живой» — события в неё копились бы впустую
    if (!rateOk(client)) return json(429, { error: "slow down" });
    try { handle(client.room, client, body.msg || {}); } catch (err) { send(client.ws, { type: "error", error: err.message }); }
    return json(200, { ok: true });
  }
  if (url.pathname === "/auction/api/health") return json(200, { ok: true, rooms: rooms.size, judge: OPENAI_API_KEY ? "chatgpt" : "vote" });
  if (url.pathname === "/auction/api/kinds") return json(200, Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.length])));
  if (url.pathname === "/auction/api/modes") return json(200, MODES);
  if (url.pathname === "/auction/api/rooms" && req.method === "POST") {
    const body = await readJson(req);
    try {
      const room = createRoom({ kind: body.kind, settings: body.settings, speed: body.speed, ip: clientIp(req) });
      return json(200, { code: room.code, hostToken: room.hostToken });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }
  if (STATIC && req.method === "GET") return serveStatic(req, res);
  res.writeHead(404);
  res.end();
});

// анонимы — соединения, которые не стали ни игроком, ни доской (зритель после host_lost — не аноним)
const isAnon = (c) => !c.playerId && !c.host && !c.wasHost && !c.hostRemote;
function anonCount(room, ip) {
  let n = 0;
  for (const c of room.sockets) if (isAnon(c) && (ip === undefined || c.ip === ip)) n++;
  return n;
}
// Место для нового соединения. Помимо общих потолков — потолок анонимов с одного адреса внутри
// комнаты (M14): один клиент больше не забивает все анонимные места комнаты. Игроков и доски
// по адресу не считаем — за NAT кафе или офиса вся компания сидит на одном IP.
function roomHasSpace(room, ip) {
  if (room.sockets.size >= MAX_SOCKETS_PER_ROOM || totalSockets() >= MAX_TOTAL_SOCKETS) return false;
  if (anonCount(room) >= MAX_ANON_PER_ROOM) return false;
  return !ip || anonCount(room, ip) < MAX_ANON_PER_IP;
}

// ---------- WebSocket ----------

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MSG_BYTES,
  perMessageDeflate: WS_DEFLATE && {
    threshold: 1024,
    serverMaxWindowBits: 10,
    clientMaxWindowBits: 10,
    zlibDeflateOptions: { memLevel: 4, level: 6 },
    concurrencyLimit: 4,
  },
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/auction/ws") return socket.destroy();
  const room = rooms.get((url.searchParams.get("r") || "").toUpperCase());
  if (!room) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  // потолок соединений на комнату и на процесс: без него один клиент открывает тысячи сокетов
  const ip = clientIp(req);
  if (!roomHasSpace(room, ip)) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(room, ws, { ip, delta: url.searchParams.get("d") === "1" }));
});

function onConnection(room, ws, opts = {}) {
  const client = { ws, playerId: null, host: false, misses: 0, ip: opts.ip || "", delta: !!opts.delta };
  room.sockets.add(client);
  ws.on("pong", () => (client.misses = 0));
  sendHello(room, client);

  ws.on("message", (raw) => {
    if (!rateOk(client)) return; // флуд по одному сокету не тратит CPU всей комнаты
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(room, client, msg); } catch (err) { send(ws, { type: "error", error: err.message }); }
  });

  // Без обработчика ошибка сокета (например, сообщение больше maxPayload) становится непойманной
  // и роняет процесс со всеми комнатами. Рвём только этот сокет — close ниже уберёт его из комнаты.
  ws.on("error", (err) => {
    console.log(`[auction] ${room.code}: ошибка сокета (${err.message}) — рвём`);
    try { ws.terminate(); } catch {}
  });
  ws.on("close", () => {
    room.sockets.delete(client);
    scheduleOffline(room, client.playerId);
  });
}

// права ведущего: доска (host) или пульт ведущего с хост-токеном (hostRemote, §10.4).
// Настройки, «ещё раз» и боты остаются за доской: это экран лобби и итогов, а не пульт.
const isHost = (c) => !!(c.host || c.hostRemote);

function handle(room, client, msg) {
  const g = room.game;
  const t = clock(room);
  // Служебный пинг пульта: им клиент проверяет, жив ли ещё сокет. Это не действие в комнате,
  // поэтому room.touched здесь НЕ двигаем — иначе брошенное лобби с открытой доской, где никто
  // ничего не делает, жило бы вечно и никогда не закрывалось по TTL.
  // В pong — часы комнаты и метка клиента: по ним пульт считает смещение часов по самому быстрому
  // обмену (RTT/2), а не по state, который мог простоять в очереди секунды (§6.4).
  if (msg.type === "ping") return send(client.ws, { type: "pong", t, c: typeof msg.c === "number" ? msg.c : undefined });
  room.touched = now();
  const reply = (obj) => send(client.ws, obj);
  // round в сообщении не совпадает с текущим лотом — действие устарело (старые клиенты round не шлют)
  const stale = (m) => m.round != null && m.round !== g.s.round;

  switch (msg.type) {
    case "host": {
      // Ведущий, который играет с телефона (§10.4): пульт с сохранённым хост-токеном получает права
      // ведущего на своём соединении, не отбирая их у доски, — доска остаётся на связи и в управлении,
      // логика «вторая доска забирает управление» (H9) касается только досок.
      if (msg.remote) {
        if (msg.token !== room.hostToken) return reply({ type: "host_denied" });
        client.hostRemote = true;
        return reply({ type: "host_ok", remote: true });
      }
      if (msg.token !== room.hostToken) return reply({ type: "error", error: "bad host token" });
      // Одна доска на комнату: предыдущая становится зрителем — и узнаёт об этом. Раньше права
      // отнимались молча: её кнопки просто переставали действовать, а локальные правки настроек
      // расходились с сервером (на ТВ $50, на сервере $30).
      for (const c of room.sockets) if (c.host && c !== client) { c.host = false; c.wasHost = true; send(c.ws, { type: "host_lost" }); }
      client.host = true;
      client.wasHost = true;
      return reply({ type: "host_ok" });
    }
    case "join": {
      // Повторный join на том же соединении (ретрай POST при потерянном ответе, двойной тап) —
      // тот же игрок, а не новый: раньше прежний игрок соединения оставался зомби «online навсегда»,
      // а одним сокетом можно было набить комнату до room_full.
      if (client.playerId && g.player(client.playerId) && !g.player(client.playerId).left) {
        return reply({ type: "joined", playerId: client.playerId, token: client.token });
      }
      let playerId = msg.token && room.tokens[msg.token];
      // Токен ведёт к игроку, которого больше нет (выгнали в лобби, пока телефон был офлайн, или
      // ведущий начал новую игру без него): не «входим» фантомом, а отправляем на ввод имени.
      if (playerId && !g.player(playerId)) {
        delete room.tokens[msg.token];
        if (!String(msg.name || "").trim()) return reply({ type: "error", error: "token_gone" });
        playerId = null;
      }
      if (playerId && g.player(playerId)?.left) playerId = null;
      // Потерял localStorage, но игра идёт: то же имя, что у никем не занятого игрока, — продолжаем
      // его партию. Признак занятости — живой сокет с этим playerId, а НЕ флаг online: в пределах
      // грации вернувшийся числится онлайн, и проверка по флагу запирала его снаружи с «game_started»
      // ровно в том случае, ради которого грация и вводилась. Имена в комнате уникальны (addPlayer
      // дописывает « 2» тёзке), так что перехватить чужую партию совпадением имени нельзя.
      // В лобби то же самое: иначе вошедший заново без токена получал «Аня 2», а офлайн-«Аня»
      // оставалась призраком, стартовала вместе со всеми и держала авто-паузу.
      if (!playerId) {
        const name = cleanName(msg.name);
        const ghost = g.s.players.find((p) => !p.left && p.name === name && ![...room.sockets].some((c) => c.playerId === p.id));
        if (ghost) {
          playerId = ghost.id;
          const token = crypto.randomBytes(12).toString("base64url");
          room.tokens[token] = playerId;
          msg.token = token;
        }
      }
      if (!playerId) {
        if (g.s.phase !== "lobby") return reply({ type: "error", error: "game_started" });
        if (g.activePlayers().length >= MAX_PLAYERS) return reply({ type: "error", error: "room_full" });
        playerId = "u_" + crypto.randomBytes(5).toString("hex");
        const token = crypto.randomBytes(12).toString("base64url");
        room.tokens[token] = playerId;
        g.addPlayer({ id: playerId, name: String(msg.name || "") });
        client.token = token;
        reply({ type: "joined", playerId, token });
      } else {
        client.token = msg.token;
        reply({ type: "joined", playerId, token: msg.token });
      }
      // второе устройство той же сессии заменяет первое
      for (const c of room.sockets) if (c !== client && c.playerId === playerId) { c.playerId = null; send(c.ws, { type: "replaced" }); }
      client.playerId = playerId;
      cancelOffline(room, playerId);
      // события возврата важны: вернувшийся единственный добирающий снимает паузу сам (§7.4)
      const events = [{ type: "online", playerId }, ...g.setOnline(playerId, true, t)];
      // Авто-паузу, которую поставил чей-то обрыв, снимаем сами, как только все вернулись: иначе
      // цена моргнувшей сети — вся партия стоит, пока кто-нибудь не дойдёт до доски и не нажмёт
      // «Продолжить». Ручную паузу ведущего это не трогает (см. autoResumeIfBack).
      events.push(...autoResumeIfBack(room));
      return afterChange(room, events);
    }
    case "bid": {
      if (!client.playerId) return;
      // Действие привязано к лоту, на который смотрел игрок: на медленной сети «Скип» или ставка
      // с expectedPrice 0 иначе доезжали до следующего, ещё не показанного лота.
      if (stale(msg)) return reply({ type: "rejected", action: "bid", ok: false, reason: "closed" });
      const r = g.bid(client.playerId, msg.amount, t, msg.expectedPrice);
      if (!r.ok) return reply({ type: "rejected", action: "bid", ...r });
      return afterChange(room, r.events);
    }
    case "take": {
      if (!client.playerId) return;
      if (stale(msg)) return reply({ type: "rejected", action: "take", ok: false, reason: "closed" });
      const r = g.take(client.playerId, t);
      if (!r.ok) return reply({ type: "rejected", action: "take", ...r });
      return afterChange(room, r.events);
    }
    // соло-добор: «Скип». Отдельное действие, а не take с флагом, — пульт шлёт ровно то,
    // что нажали, и отказ («скипы кончились») читается в логе без догадок
    case "skip": {
      if (!client.playerId) return;
      if (stale(msg)) return reply({ type: "rejected", action: "skip", ok: false, reason: "closed" });
      const r = g.skip(client.playerId, t);
      if (!r.ok) return reply({ type: "rejected", action: "skip", ...r });
      return afterChange(room, r.events);
    }
    case "vote": {
      if (!client.playerId) return;
      const r = g.vote(client.playerId, msg.for);
      if (!r.ok) return reply({ type: "rejected", action: "vote", ...r });
      afterChange(room, r.events);
      maybeFinishVoting(room);
      return;
    }
    case "leave": {
      if (!client.playerId) return;
      const events = g.removePlayer(client.playerId);
      client.playerId = null;
      events.push(...autoResumeIfBack(room));
      afterChange(room, events);
      return maybeFinishVoting(room);
    }
    // ---- хост ----
    case "settings": {
      if (!client.host) return;
      if (g.s.phase !== "lobby") return reply({ type: "error", error: "game_started" });
      const wasKind = g.s.kind, wasLang = g.s.settings.lang;
      if (msg.kind && KINDS[msg.kind]) g.s.kind = msg.kind;
      // clampSettings знает категорию и сам сбрасывает задание, доступное только прежней;
      // пересчитываем и когда пришла одна категория без настроек — иначе задание осталось бы чужим
      if (msg.settings) {
        g.s.settings = clampSettings({ ...g.s.settings, ...msg.settings }, g.s.kind);
        for (const p of g.s.players) p.money = g.s.settings.budget;
      } else if (msg.kind) {
        g.s.settings = clampSettings(g.s.settings, g.s.kind);
      }
      // колода зависит и от категории, и от языка: карточки на другом языке — другие объекты
      if (g.s.kind !== wasKind || g.s.settings.lang !== wasLang) {
        g.s.deck = Game.create({ kind: g.s.kind, cards: cardsFor(g.s.kind, g.s.settings.lang) }).s.deck;
      }
      return afterChange(room, []);
    }
    case "start": {
      if (!isHost(client)) return;
      return afterChange(room, g.start(t));
    }
    // пропуск ведущим тоже привязан к лоту: запоздавшее нажатие не должно продать следующий лот
    case "skip_lot": return isHost(client) && !stale(msg) ? afterChange(room, g.hostSkip(t)) : undefined;
    case "pause": return isHost(client) ? afterChange(room, g.pause(t)) : undefined;
    case "resume": {
      // Управляет партией ведущий, и это правильно. Но если доска умерла — ноутбук уснул, вкладку
      // закрыли, браузер убил страницу — снять паузу становится некому, и живые игроки сидят перед
      // замершей игрой до самого TTL. Предохранитель нарочно узкий: продолжить может любой игрок и
      // только пока не подключено ни одной доски. Пропуск лота и завершение партии остаются за ней:
      // они меняют исход, а «Продолжить» лишь возвращает то, что и так шло.
      const noBoard = ![...room.sockets].some((c) => c.host);
      if (!isHost(client) && !noBoard) return;
      if (!isHost(client)) console.log(`[auction] ${room.code}: доски нет — партию продолжил ${g.player(client.playerId)?.name || "игрок"}`);
      return afterChange(room, g.resume(t));
    }
    case "kick": {
      if (!isHost(client)) return;
      // ведущий с пульта не выгоняет сам себя случайным тапом — для этого есть «Выйти»
      if (client.hostRemote && !client.host && msg.playerId === client.playerId) return;
      const events = g.removePlayer(msg.playerId);
      for (const c of room.sockets) if (c.playerId === msg.playerId) { c.playerId = null; send(c.ws, { type: "kicked" }); }
      // выгнали отключённого — отключённых могло стать не больше половины (§7.4)
      events.push(...autoResumeIfBack(room));
      afterChange(room, events);
      return maybeFinishVoting(room);
    }
    case "end": {
      if (!isHost(client)) return;
      return afterChange(room, g.s.phase === "finished" ? [] : g.finish("host_ended"));
    }
    case "next_game": {
      if (!client.host) return;
      const kind = KINDS[msg.kind] ? msg.kind : g.s.kind;
      const fresh = Game.create({ kind, cards: cardsFor(kind, g.s.settings.lang), settings: g.s.settings });
      for (const p of g.activePlayers()) fresh.addPlayer({ id: p.id, name: p.name });
      // онлайн определяем по живым соединениям (боты считаются подключёнными всегда)
      for (const p of fresh.s.players) p.online = room.bots.some((b) => b.playerId === p.id) || [...room.sockets].some((c) => c.playerId === p.id);
      clearTimeout(room.voteTimer);
      room.judging = false;
      room.game = fresh;
      return afterChange(room, [{ type: "new_game" }]);
    }
    case "bots": {
      if (!client.host || !DEV) return;
      addBots(room, Math.min(7, Number(msg.n) || 3));
      return afterChange(room, []);
    }
    default:
      return reply({ type: "error", error: "unknown message" });
  }
}

// ---------- обслуживание: ping, TTL, дамп ----------

setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.sockets) {
      if (c.poll) continue; // poll-сессии обходит свой частый таймер ниже
      if (c.misses >= PONG_MISSES) {
        console.log(`[auction] ${room.code}: сокет (${room.game.player(c.playerId)?.name || "без игрока"}) молчит ${PONG_MISSES} ping подряд — рвём`);
        c.ws.terminate();
        continue;
      }
      c.misses = (c.misses || 0) + 1;
      c.ws.ping();
    }
    // Идущая партия живёт, пока к ней кто-то подключён: на паузе и в разборе игровых тиков нет,
    // а room.touched двигают только сообщения — иначе живая игра умирала бы под людьми.
    // Лобби так не продлеваем: комната, в которой полчаса никто ничего не сделал, — брошенная,
    // и открытая доска с кодом на экране этого не меняет. Игроки увидят внятный экран «комната
    // была неактивна», а не молча мёртвый код.
    if (room.sockets.size && room.game.s.phase !== "lobby") room.touched = now();
    if (now() - room.touched > ROOM_TTL) destroyRoom(room);
  }
  // Одна строка в лог на каждый обход: по `docker logs randomhost-auction` видно, сколько комнат,
  // соединений и памяти было в момент поломки. При лимите 256m рост RSS — единственный признак
  // близкого OOM, и без этой строки после убийства контейнера не остаётся никаких следов.
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  if (rooms.size) {
    const drops = statBlips ? `, обрывов ${statBlips} (вернулись ${statBack}, выпали ${statDrops})` : "";
    console.log(`[auction] комнат ${rooms.size}, соединений ${totalSockets()}, RSS ${rssMb} МБ${drops}`);
  }
  statBlips = statBack = statDrops = 0;
  if (rssMb > 180) console.warn(`[auction] ВНИМАНИЕ: RSS ${rssMb} МБ при лимите контейнера 256 МБ, комнат ${rooms.size}`);
}, SWEEP);

// Poll-сессии проверяем чаще общего обхода: ушедший с long-polling игрок должен выпадать так же
// быстро, как с WebSocket (закрытие сокета видно сразу), а не через минуту.
setInterval(() => {
  const t = now();
  for (const c of pollClients.values()) {
    const idle = !c.inflight && t - c.lastSeen > POLL_GAP_MS;
    const anon = !c.playerId && !c.host && !c.wasHost && t - c.opened > ANON_TTL_MS;
    if (idle || anon || t - c.lastSeen > 40000) closePoll(c.sid);
  }
}, 2000).unref();

// колода комнаты → список номеров карт; null, если карточки не из текущей колоды категории
// (данные поменялись между сборками) — тогда дампим колоду как есть
function deckIndexes(s) {
  const idx = (CARD_INDEX[langOf(s)] || CARD_INDEX.ru)[s.kind];
  if (!idx || !Array.isArray(s.deck)) return null;
  const out = [];
  for (const c of s.deck) {
    const i = idx.get(c);
    if (i === undefined) return null;
    out.push(i);
  }
  return out;
}

let dumpWasEmpty = false;
function dump() {
  try {
    const data = [...rooms.values()]
      .filter((r) => !r.bots.length)
      .map((r) => {
        const s = r.game.s;
        const deckIdx = deckIndexes(s);
        // judgeCalls тоже сохраняем: без него перезапуск обнулял счётчик платных запросов к судье,
        // и в цикле падений каждая доигранная комната заказывала вердикт заново
        return {
          code: r.code, ip: r.ip, hostToken: r.hostToken, tokens: r.tokens, touched: r.touched, judgeCalls: r.judgeCalls,
          state: deckIdx ? { ...s, deck: null, deckIdx } : s,
        };
      });
    // нечего сохранять и в прошлый раз было нечего — не трогаем диск каждые 5 секунд
    if (!data.length && dumpWasEmpty) return;
    dumpWasEmpty = !data.length;
    fs.mkdirSync(path.dirname(DUMP), { recursive: true });
    fs.writeFileSync(DUMP + ".tmp", JSON.stringify(data));
    fs.renameSync(DUMP + ".tmp", DUMP);
  } catch (err) {
    console.warn("[auction] дамп не удался:", err.message);
  }
}

function restore() {
  try {
    if (!fs.existsSync(DUMP)) return;
    for (const r of JSON.parse(fs.readFileSync(DUMP, "utf8"))) {
      if (now() - r.touched > ROOM_TTL) continue;
      // колода сохранена номерами — поднимаем её теми же объектами, что в KINDS (общая память, не копия).
      // Старый формат (колода целиком) читается как есть: дамп с прошлой версии не теряется.
      if (Array.isArray(r.state.deckIdx)) {
        const cards = cardsFor(r.state.kind, langOf(r.state)) || [];
        const deck = r.state.deckIdx.map((i) => cards[i]);
        if (deck.every(Boolean)) {
          r.state.deck = deck;
        } else {
          // карточки категории изменились между сборками — номера ведут не туда. Партию не бросаем:
          // берём свежую тасовку. Купленные лоты лежат у игроков, текущий лот сохранён отдельно,
          // а будущих ещё никто не видел, поэтому подмена незаметна.
          r.state.deck = Game.create({ kind: r.state.kind, cards }).s.deck;
          r.state.rounds = Math.min(r.state.rounds, r.state.deck.length);
          console.warn(`[auction] комната ${r.code}: колода категории изменилась, лоты перетасованы заново`);
        }
        delete r.state.deckIdx;
      }
      const room = { code: r.code, ip: r.ip || "", hostToken: r.hostToken, game: Game.from(r.state), tokens: r.tokens, sockets: new Set(), offlineTimers: new Map(), dropCounts: new Map(), timer: null, voteTimer: null, touched: r.touched, speed: 1, skew: 0, bots: [], botTimer: null, judging: false, judgeCalls: Number(r.judgeCalls) || 0 };
      for (const p of room.game.s.players) p.online = false;
      // После перезапуска на связи никого: без паузы таймеры шли бы, и лоты продавались и сгорали
      // без людей. Авто-пауза снимется сама, когда вернётся больше половины (§7.4).
      if (room.game.s.phase !== "lobby" && room.game.s.phase !== "finished" && !room.game.s.paused) room.game.pause(clock(room), true);
      rooms.set(room.code, room);
      schedule(room);
      // партия успела закончиться до перезапуска: досудить или добрать голоса, иначе финал зависнет
      const s = room.game.s;
      if (s.phase === "finished" && !s.results) {
        if (s.voting) armVoting(room);
        else startJudging(room).catch((err) => console.error("[auction] судейство при восстановлении упало:", err.message));
      }
    }
    console.log(`[auction] восстановлено комнат: ${rooms.size}`);
  } catch (err) {
    console.warn("[auction] восстановление не удалось:", err.message);
  }
}

restore();
setInterval(dump, 5000);
// Одно неожиданное исключение убивало разом все комнаты: процесс падал, restart: always поднимал
// его, и партии возвращались из дампа пятисекундной давности — в лучшем случае. Дампим перед
// выходом и выходим сами: падение становится морганием, а не потерянным вечером. Продолжать
// работу после uncaughtException нельзя — состояние процесса уже неизвестно.
function fatal(what, err) {
  try { console.error(`[auction] ${what}:`, (err && err.stack) || err); } catch {}
  try { dump(); } catch {}
  process.exit(1);
}
process.on("uncaughtException", (err) => fatal("непойманное исключение", err));
process.on("unhandledRejection", (err) => fatal("непойманный отказ промиса", err));

// Деплой случается посреди партии. Если просто выйти, клиенты получат обрыв 1006 — «сеть пропала» —
// и будут ждать свой шаг backoff. Код 1012 (Service Restart) говорит им прямо: это перезапуск,
// возвращайся сразу. Полсекунды на отправку кадров, иначе они не успеют уйти из буфера.
process.on("SIGTERM", () => {
  dump();
  try { server.close(); } catch {}
  for (const room of rooms.values()) {
    for (const c of room.sockets) { try { if (!c.poll) c.ws.close(1012, "restart"); } catch {} }
  }
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => console.log(`[auction] порт ${PORT}, категорий ${Object.keys(KINDS).length}${STATIC ? ", статика из " + STATIC : ""}${DEV ? ", режим разработки (боты)" : ""}`));
