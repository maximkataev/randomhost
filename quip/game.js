"use strict";

/*
 * Движок «Вопроса ребром»: чистая логика без сети и таймеров (quip-spec.md).
 * Всё состояние — plain-объект `this.s`: дампится в JSON и поднимается обратно.
 * Время приходит снаружи (`now`, мс): сервер зовёт tick(now) к ближайшему сроку и перед каждым действием.
 * Случайность тоже снаружи: rnd(n) → целое 0..n-1. Колоды вопросов — снаружи (content[lang][deck]),
 * в состояние копируются только тексты разыгранных вопросов и их подсказки (подсказки — только на сервере).
 *
 * Партия: раунды (дуэли → эмодзи-сцена → финал), в раунде — фаза ответов, потом по очереди
 * «схватки» (matchup): голосование → раскрытие. Между раундами — счёт.
 * Анонимность (§8): до раскрытия схватки ни доска, ни телефоны не знают, кто что написал и была ли это подсказка.
 */

const { normalize, normalizeList } = require("./normalize");

const DECKS = ["duel", "emoji", "rev", "final"];

// Добавка ко времени на ответ (просьба владельца 04.10: «дольше на 10–20 с»). Настраивается
// переменной окружения ROUND_EXTRA_SEC (0…60), по умолчанию +15 с; голосования и раскрытия не трогает.
const EXTRA_MS = Math.round(Math.max(0, Math.min(60, Number(process.env.ROUND_EXTRA_SEC ?? 15) || 0)) * 1000);

// Раунды партии (§2). Полная: дуэли → сцена → «Наоборот» ×2 → финал (8–12 минут; с одним кругом дуэлей
// плейтест выходил в 3 минуты — «только разогрелись, а уже пьедестал»). Короткая: дуэли и финал.
// «Наоборот» (владелец, 09.10): дан ответ («99,1%»), придумать к нему вопрос. Идёт вторым кругом дуэлей
// на месте прежнего duel2 — тот же круг, соперник через одного. duel2 остаётся для дампов старых комнат.
const ROUNDS = {
  duel: { deck: "duel", mult: 1, votes: 1, answerMs: 30000 + EXTRA_MS, shift: 1 },
  emoji: { deck: "emoji", mult: 2, votes: 2, answerMs: 30000 + EXTRA_MS },
  duel2: { deck: "duel", mult: 2, votes: 1, answerMs: 30000 + EXTRA_MS, shift: 2 },
  rev: { deck: "rev", mult: 2, votes: 1, answerMs: 30000 + EXTRA_MS, shift: 2 },
  final: { deck: "final", mult: 3, votes: 3, answerMs: 60000 + EXTRA_MS },
};
const PLAN_FULL = ["duel", "emoji", "rev", "final"];
const PLAN_SHORT = ["duel", "final"];

const T = {
  intro: 3500, // заставка раунда
  voteDuel: 15000,
  voteGrid: 20000,
  revealDuel: 5000, // успеть прочитать авторов и отсмеяться (3–4 с сливались в мельтешение)
  revealGrid: 7000,
  scores: 6000,
};

const DEFAULTS = {
  hints: 2, // подсказок на партию (§4): 1–3
  short: false, // короткая партия: раунды 1 и 3
  lang: "ru",
};

const MAX_PLAYERS = 16;
// Всего записей об игроках, вместе с ушедшими посреди партии. Без потолка вход/выход в цикле
// раздувал список (и каждый снимок, и дамп) без предела: 10 сокетов — +70 записей за 20 с.
const MAX_PLAYER_RECORDS = MAX_PLAYERS * 4;
const MIN_PLAYERS = 3;
const SMALL = 4; // до стольких игроков дуэли идут «все против всех» (§2)
const ANSWER_MAX = 80;
const ITEM_MAX = 50; // греческие слова длинные: на 40 пункт резался посреди слова
const REACT_GAP = 2000;
const REACTIONS = ["😂", "🔥", "😱", "👏", "💀"];
const POINTS = 100;
const WIN_BONUS = 100;
const SWEEP_BONUS = 250;
const LATE_SHARE = 0.5; // 🐌-подсказка за молчание — за полцены и без бонуса: молчать не должно окупаться

// 16 цветов карточек под неоновую вывеску на кирпиче
const COLORS = ["#ff3d7f", "#22d3ee", "#ffd23f", "#7cff6b", "#b388ff", "#ff8a3d", "#3d8bff", "#ff5c5c", "#00e0a4", "#f472b6", "#a3e635", "#fb7185", "#38bdf8", "#facc15", "#c084fc", "#94a3b8"];
const AVATARS = ["🎤", "🦊", "🐸", "🦉", "🐙", "🦄", "🐧", "🦁", "🐼", "🐵", "🦖", "🐝", "🐳", "🦩", "🐢", "🦔"];
// из чего игрок выбирает сам (первые 16 раздаются по умолчанию)
const AVATAR_CHOICES = AVATARS.concat(["🐱", "🐶", "🐰", "🐻", "🐨", "🐯", "🐷", "🐮", "🦝", "🦥", "🦦", "🐲", "👽", "🤖", "👻", "🤡", "🥑", "🍕", "🌮", "🍩", "🧀", "🌵", "🍄", "🪩"]);

function clampSettings(input = {}) {
  const s = { ...DEFAULTS };
  const h = Number(input.hints);
  if ([1, 2, 3].includes(h)) s.hints = h;
  if (typeof input.short === "boolean") s.short = input.short;
  if (["ru", "en", "el"].includes(input.lang)) s.lang = input.lang;
  return s;
}

// без управляющих и невидимых символов, без лишних пробелов. Хангыль-заполнители (U+3164 и др.),
// мягкий перенос и «невидимые операторы» дают имя, которое на доске выглядит пустым, — тоже долой.
const CTRL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0]/g;
function cleanText(text, max) {
  return Array.from(String(text == null ? "" : text).replace(CTRL, "").replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}
const cleanName = (name) => cleanText(name, 16);

class Game {
  constructor(state, rnd, content) {
    this.s = state;
    this.rnd = rnd;
    this.content = content || {};
  }

  static create({ settings, code = "", rnd, content } = {}) {
    return new Game({
      code,
      settings: clampSettings(settings),
      phase: "lobby", // lobby | intro | answer | vote | reveal | scores | finished
      players: [],
      game: 0,
      plan: [], // ключи раундов партии
      ri: -1, // индекс раунда в plan
      phaseStart: null,
      phaseEnd: null,
      matchups: [], // схватки текущего раунда
      mi: -1, // текущая схватка (vote / reveal)
      roster: [], // кто отвечает в этом раунде
      used: { ru: {}, en: {}, el: {} }, // разыгранные id по колодам: не повторяем, пока колода не пройдена
      best: null, // лучший ответ партии
      hintStar: null, // лучший ответ-подсказка
      seq: 0,
      finishedReason: null,
    }, rnd, content);
  }

  static from(state, rnd, content) {
    return new Game(state, rnd, content);
  }

  // ---------- участники ----------

  player(id) {
    return this.s.players.find((p) => p.id === id);
  }

  present() {
    return this.s.players.filter((p) => !p.left);
  }

  addPlayer({ id, name }) {
    const s = this.s;
    const have = this.player(id);
    if (have) return { ok: true, player: have };
    if (this.present().length >= MAX_PLAYERS || s.players.length >= MAX_PLAYER_RECORDS) return { ok: false, reason: "room_full" };
    name = cleanName(name);
    if (!name) return { ok: false, reason: "bad_name" };
    const used = new Set(this.present().map((p) => p.color));
    const usedAv = new Set(this.present().map((p) => p.avatar));
    const p = {
      id,
      name,
      color: COLORS.find((c) => !used.has(c)) || COLORS[s.players.length % COLORS.length],
      avatar: AVATARS.find((a) => !usedAv.has(a)) || AVATARS[s.players.length % AVATARS.length],
      online: true,
      left: false,
      score: 0,
      hintsUsed: 0,
      answerMs: 0, // сумма времени ответов (для «Самого быстрого»), только набранные руками
      answered: 0,
      lastReact: null,
    };
    s.players.push(p);
    // вошёл посреди партии — играет со следующего раунда, голосовать может сразу (§8)
    return { ok: true, player: p };
  }

  removePlayer(id, now) {
    const s = this.s;
    const p = this.player(id);
    if (!p) return [];
    if (s.phase === "lobby" || s.phase === "finished") {
      s.players = s.players.filter((x) => x !== p);
      return [{ type: "left", playerId: id }];
    }
    if (p.left) return [];
    // Ни разу не отвечал в этой партии — его запись ни на что не влияет (голоса считаются по списку
    // голосов, не по игрокам): убираем совсем, как в лобби. Иначе вход-выход копил бы записи «ушёл».
    const played = p.played === s.game || s.roster.includes(id) || s.matchups.some((m) => m.authors.includes(id)) ||
      (s.best && s.best.playerId === id) || (s.hintStar && s.hintStar.playerId === id);
    if (played) p.left = true;
    else s.players = s.players.filter((x) => x !== p);
    const ev = [{ type: "left", playerId: id }];
    if (this.present().length < MIN_PLAYERS) return ev.concat(this.finish("few", now));
    // ушедший больше не держит фазу: может, теперь все ответили или проголосовали
    return ev.concat(this.maybeAdvance(now));
  }

  setOnline(id, online, now) {
    const p = this.player(id);
    if (p) p.online = online;
    return online ? [] : this.maybeAdvance(now);
  }

  // ---------- колоды ----------

  deck(name) {
    const lang = this.s.settings.lang;
    return ((this.content[lang] || this.content.ru || {})[name]) || [];
  }

  // n разных карточек колоды, не игранных в этой комнате, пока колода не пройдена целиком
  draw(name, n) {
    const s = this.s;
    const lang = s.settings.lang;
    const deck = this.deck(name);
    if (!deck.length) return [];
    const used = (s.used[lang] = s.used[lang] || {});
    let seen = new Set(used[name] || []);
    let free = deck.filter((c) => !seen.has(c.id));
    if (free.length < n) { seen = new Set(); free = deck.slice(); }
    const out = [];
    while (out.length < n && free.length) out.push(free.splice(this.rnd(free.length), 1)[0]);
    used[name] = [...seen, ...out.map((c) => c.id)];
    return out;
  }

  // ---------- ход партии ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "started" };
    const ps = this.present();
    if (ps.length < MIN_PLAYERS) return { ok: false, reason: "few_players" };
    s.game++;
    s.plan = (s.settings.short ? PLAN_SHORT : PLAN_FULL).slice();
    s.ri = -1;
    s.best = null;
    s.hintStar = null;
    s.finishedReason = null;
    // ушедшие в прошлой партии новой не нужны (а копились бы от партии к партии)
    s.players = ps;
    for (const p of ps) { p.score = 0; p.hintsUsed = 0; p.answerMs = 0; p.answered = 0; }
    return { ok: true, events: [{ type: "started", game: s.game }, ...this.nextRound(now)] };
  }

  round() {
    const s = this.s;
    return s.ri >= 0 ? ROUNDS[s.plan[s.ri]] : null;
  }

  nextRound(now) {
    const s = this.s;
    s.ri++;
    if (s.ri >= s.plan.length) return this.finish("done", now);
    s.phase = "intro";
    s.phaseStart = now;
    s.phaseEnd = now + T.intro;
    s.matchups = [];
    s.mi = -1;
    s.roster = [];
    return [{ type: "round", roundKey: s.plan[s.ri], index: s.ri }];
  }

  // Раздать вопросы: дуэли по кругу или один вопрос на всех (§2)
  deal(now) {
    const s = this.s;
    const key = s.plan[s.ri];
    const R = ROUNDS[key];
    // колоды «Наоборот» на языке комнаты нет — играем этот раунд обычными вопросами, а не пустыми карточками
    const dk = this.deck(R.deck).length ? R.deck : "duel";
    const ps = this.present();
    // порядок круга перемешан, чтобы соседи в лобби не играли всегда друг против друга
    let ring = ps.slice();
    for (let i = ring.length - 1; i > 0; i--) { const j = this.rnd(i + 1); [ring[i], ring[j]] = [ring[j], ring[i]]; }
    // второй круг дуэлей («Наоборот») идёт по тому же кругу, что первый (со сдвигом через одного) — иначе пары повторялись бы;
    // новенькие встают в конец круга
    if (R.shift === 2 && Array.isArray(s.duelRing)) {
      const kept = s.duelRing.map((id) => ps.find((p) => p.id === id)).filter(Boolean);
      ring = kept.concat(ps.filter((p) => !kept.includes(p)));
    }
    if (R.shift === 1) s.duelRing = ring.map((p) => p.id);
    s.roster = ring.map((p) => p.id);
    for (const p of ring) p.played = s.game;
    const mk = (card, authors, kind, votes) => ({
      id: ++s.seq,
      kind, // duel | grid
      deck: dk,
      prompt: dk === "emoji" ? { e: card.e } : dk === "rev" ? { a: card.a } : { q: card.q },
      pool: (card.h || []).slice(), // подсказки — только на сервере
      poolUsed: [],
      authors,
      answers: {}, // playerId → {text | items, hint, late, at, key}
      order: null, // порядок показа (перемешан при голосовании)
      votesPer: votes,
      votes: {}, // voterId → [индексы в order]
      drafts: {}, // выбранное, но не подтверждённое кнопкой: засчитывается, когда голосование закроется
      result: null,
    });
    let ms = [];
    // голосов у зрителя — не больше половины чужих ответов: при трёх игроках «2 голоса из 2 чужих»
    // значило голосовать за всех сразу, и выбор ничего не решал
    const gridVotes = Math.min(R.votes, Math.max(1, Math.floor((ring.length - 1) / 2)));
    if (R.shift && ring.length > SMALL) {
      const cards = this.draw(dk, ring.length);
      // во втором круге соперник — через одного: пары первого круга не повторяются (при 5+ игроках)
      const k = R.shift || 1;
      ms = ring.map((p, i) => mk(cards[i % cards.length], [p.id, ring[(i + k) % ring.length].id], "duel", 1));
    } else if (R.shift) {
      // мало игроков: два вопроса, отвечают все, голосуют за лучший
      ms = this.draw(dk, 2).map((c) => mk(c, s.roster.slice(), "grid", 1));
    } else {
      ms = this.draw(R.deck, 1).map((c) => mk(c, s.roster.slice(), "grid", gridVotes));
    }
    s.matchups = ms;
    s.phase = "answer";
    s.phaseStart = now;
    // время на ответ — на каждый свой вопрос (§3)
    const per = Math.max(...s.roster.map((id) => ms.filter((m) => m.authors.includes(id)).length), 1);
    s.phaseEnd = now + R.answerMs * per;
    return [{ type: "answer" }];
  }

  mine(id) {
    return this.s.matchups.filter((m) => m.authors.includes(id));
  }

  // ответ руками: текст (дуэль, сцена, вопрос к ответу) или три пункта (финал)
  answer(id, mid, ans, now) {
    const s = this.s;
    if (s.phase !== "answer") return { ok: false, reason: "not_answer" };
    const m = s.matchups.find((x) => x.id === mid);
    if (!m || !m.authors.includes(id)) return { ok: false, reason: "not_yours" };
    if (m.answers[id]) return { ok: false, reason: "answered" };
    let a;
    if (m.deck === "final") {
      const items = (Array.isArray(ans) ? ans : [ans]).slice(0, 3).map((x) => cleanText(x, ITEM_MAX)).filter(Boolean);
      if (items.length < 3) return { ok: false, reason: "need_three" };
      a = { items, key: normalizeList(items) };
    } else {
      const text = cleanText(ans, ANSWER_MAX);
      if (!text) return { ok: false, reason: "empty" };
      a = { text, key: normalize(text) };
    }
    m.answers[id] = { ...a, hint: false, late: false, at: now };
    const p = this.player(id);
    if (p) { p.answerMs += now - s.phaseStart; p.answered++; }
    return { ok: true, events: [{ type: "answered", playerId: id }, ...this.maybeAdvance(now)] };
  }

  // Подсказка вслепую (§4): случайная из неразыгранных в этой схватке, сменить нельзя
  hint(id, mid, now) {
    const s = this.s;
    if (s.phase !== "answer") return { ok: false, reason: "not_answer" };
    const m = s.matchups.find((x) => x.id === mid);
    if (!m || !m.authors.includes(id)) return { ok: false, reason: "not_yours" };
    if (m.answers[id]) return { ok: false, reason: "answered" };
    const p = this.player(id);
    if (!p || p.hintsUsed >= s.settings.hints) return { ok: false, reason: "no_hints" };
    p.hintsUsed++;
    m.answers[id] = { ...this.pickHint(m), hint: true, late: false, at: now };
    return { ok: true, events: [{ type: "answered", playerId: id }, ...this.maybeAdvance(now)] };
  }

  // подсказка из пула схватки; пул кончился (16 игроков, 6 подсказок) — берём из другой карточки той же колоды
  pickHint(m) {
    const free = m.pool.map((_, i) => i).filter((i) => !m.poolUsed.includes(i));
    let h;
    if (free.length) {
      const i = free[this.rnd(free.length)];
      m.poolUsed.push(i);
      h = m.pool[i];
    } else {
      const deck = this.deck(m.deck).filter((c) => (c.h || []).length);
      const taken = new Set(Object.values(m.answers).map((a) => a.key));
      for (let tries = 0; tries < 20 && deck.length; tries++) {
        const c = deck[this.rnd(deck.length)];
        const cand = c.h[this.rnd(c.h.length)];
        const key = Array.isArray(cand) ? normalizeList(cand) : normalize(cand);
        h = cand;
        if (!taken.has(key)) break;
      }
      if (h == null) h = m.deck === "final" ? ["…", "…", "…"] : "…";
    }
    return Array.isArray(h) ? { items: h.slice(0, 3), key: normalizeList(h) } : { text: h, key: normalize(h) };
  }

  // все, кто на связи, ответили на все свои вопросы — не ждём таймер
  allAnswered() {
    const s = this.s;
    for (const id of s.roster) {
      const p = this.player(id);
      if (!p || p.left || !p.online) continue;
      if (this.mine(id).some((m) => !m.answers[id])) return false;
    }
    return true;
  }

  closeAnswers(now) {
    const s = this.s;
    // не успел — случайная подсказка, лимит не тратит (§3)
    for (const m of s.matchups) {
      for (const id of m.authors) if (!m.answers[id]) m.answers[id] = { ...this.pickHint(m), hint: true, late: true, at: now };
      // порядок показа перемешан: авторство не угадывается по месту
      const order = m.authors.slice();
      for (let i = order.length - 1; i > 0; i--) { const j = this.rnd(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      m.order = order;
      // джинкс считаем сразу: одинаковые ответы в дуэли голосования не требуют
      const count = {};
      for (const id of order) count[m.answers[id].key] = (count[m.answers[id].key] || 0) + 1;
      m.jinx = order.filter((id) => count[m.answers[id].key] > 1);
    }
    s.mi = -1;
    return this.nextMatchup(now);
  }

  voters(m) {
    // голосуют все на связи, кроме авторов дуэли; в сетке автор голосует, но не за себя
    return this.present().filter((p) => p.online && !(m.kind === "duel" && m.authors.includes(p.id)));
  }

  votesFor(m, voterId) {
    const others = m.order.filter((id) => id !== voterId).length;
    return Math.max(0, Math.min(m.votesPer, others));
  }

  nextMatchup(now) {
    const s = this.s;
    s.mi++;
    if (s.mi >= s.matchups.length) {
      s.phase = "scores";
      s.phaseStart = now;
      s.phaseEnd = now + T.scores;
      return [{ type: "scores" }];
    }
    const m = s.matchups[s.mi];
    // дуэль-джинкс: голосовать не о чем — сразу раскрытие
    if (m.kind === "duel" && m.jinx.length === m.order.length) return this.reveal(now);
    s.phase = "vote";
    s.phaseStart = now;
    s.phaseEnd = now + (m.kind === "duel" ? T.voteDuel : T.voteGrid);
    return [{ type: "vote", mid: m.id }];
  }

  // голос: индексы ответов в порядке показа; за свой нельзя, повторно нельзя.
  // draft — только отметка (ещё не «Голосую»): держим её, и если время выйдет — засчитаем
  vote(id, mid, picks, now, draft) {
    const s = this.s;
    if (s.phase !== "vote") return { ok: false, reason: "not_vote" };
    const m = s.matchups[s.mi];
    if (!m || m.id !== mid) return { ok: false, reason: "stale" };
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (m.kind === "duel" && m.authors.includes(id)) return { ok: false, reason: "author" };
    if (m.votes[id]) return { ok: false, reason: "voted" };
    const want = this.votesFor(m, id);
    const list = [...new Set((Array.isArray(picks) ? picks : [picks]).slice(0, 16).map(Number))];
    if (draft && !list.length) { delete m.drafts[id]; return { ok: true, events: [] }; }
    if (!want || list.length < 1 || list.length > want) return { ok: false, reason: "bad_votes" };
    for (const i of list) {
      if (!Number.isInteger(i) || i < 0 || i >= m.order.length) return { ok: false, reason: "bad_votes" };
      if (m.order[i] === id) return { ok: false, reason: "own" };
    }
    if (draft) { m.drafts[id] = list; return { ok: true, events: [] }; }
    m.votes[id] = list;
    delete m.drafts[id];
    return { ok: true, events: [{ type: "voted", playerId: id }, ...this.maybeAdvance(now)] };
  }

  allVoted() {
    const m = this.s.matchups[this.s.mi];
    return this.voters(m).every((p) => m.votes[p.id] || !this.votesFor(m, p.id));
  }

  // Подсчёт схватки (§5)
  reveal(now) {
    const s = this.s;
    const m = s.matchups[s.mi];
    const R = this.round();
    // не нажал «Голосую», но отметил — голос считается (плейтест: выбранное молча пропадало)
    for (const [id, list] of Object.entries(m.drafts || {})) {
      const p = this.player(id);
      if (!m.votes[id] && p && !p.left) m.votes[id] = list;
    }
    m.drafts = {};
    const tally = m.order.map(() => 0);
    for (const list of Object.values(m.votes)) for (const i of list) tally[i]++;
    const total = tally.reduce((a, b) => a + b, 0);
    const jinx = new Set(m.jinx);
    const late = (id) => m.answers[id] && m.answers[id].late;
    const pts = m.order.map((id, i) => (jinx.has(id) ? 0 : Math.round(tally[i] * POINTS * R.mult * (late(id) ? LATE_SHARE : 1))));
    const clean = m.order.map((id, i) => (jinx.has(id) ? -1 : tally[i]));
    const top = Math.max(...clean);
    const winners = top > 0 ? m.order.filter((_, i) => clean[i] === top) : [];
    // разгром: все голоса за один ответ, и голосов хотя бы два (§5)
    const sweep = winners.length === 1 && top === total && total >= 2 ? winners[0] : null;
    // бонус — только единоличному победителю: при ничьей его получали все, и счёт слипался
    const bonus = {};
    if (winners.length === 1 && !late(winners[0])) bonus[winners[0]] = (winners[0] === sweep ? SWEEP_BONUS : WIN_BONUS) * R.mult;
    m.result = {
      tally,
      points: m.order.map((id, i) => pts[i] + (bonus[id] || 0)),
      winners,
      sweep,
      jinx: m.jinx.slice(),
    };
    m.order.forEach((id, i) => {
      const p = this.player(id);
      if (p) p.score += m.result.points[i];
      const a = m.answers[id];
      const cand = { playerId: id, votes: tally[i], deck: m.deck, prompt: m.prompt, text: a.text, items: a.items, hint: a.hint };
      if (!jinx.has(id) && tally[i] > 0) {
        // «Ответ вечера» при равенстве голосов — рукописному, а не подсказке
        if (!s.best || tally[i] > s.best.votes || (tally[i] === s.best.votes && s.best.hint && !a.hint)) s.best = cand;
        // «Подсказка смешнее всех» — ачивка, а не утешительный приз: от двух голосов
        if (a.hint && !a.late && tally[i] >= 2 && (!s.hintStar || tally[i] > s.hintStar.votes)) s.hintStar = cand;
      }
    });
    s.phase = "reveal";
    s.phaseStart = now;
    s.phaseEnd = now + (m.kind === "duel" ? T.revealDuel : T.revealGrid);
    const ev = [{ type: "reveal", mid: m.id, winners, sweep }];
    if (m.jinx.length) ev.push({ type: "jinx", mid: m.id });
    return ev;
  }

  // досрочный переход, если все уже ответили / проголосовали
  maybeAdvance(now) {
    const s = this.s;
    if (s.phase === "answer" && this.allAnswered()) return this.closeAnswers(now);
    if (s.phase === "vote" && this.allVoted()) return this.reveal(now);
    return [];
  }

  nextDeadline() {
    const s = this.s;
    return s.phase === "lobby" || s.phase === "finished" ? null : s.phaseEnd;
  }

  tick(now) {
    const s = this.s;
    if (s.phaseEnd == null || now < s.phaseEnd) return [];
    switch (s.phase) {
      case "intro": return this.deal(now);
      case "answer": return this.closeAnswers(now);
      case "vote": return this.reveal(now);
      case "reveal": return this.nextMatchup(now);
      case "scores": return this.nextRound(now);
      default: return [];
    }
  }

  finish(reason, now) {
    const s = this.s;
    s.phase = "finished";
    s.phaseStart = now;
    s.phaseEnd = null;
    s.finishedReason = reason;
    return [{ type: "final", reason }];
  }

  // ---------- ведущий ----------

  toLobby(now) {
    const s = this.s;
    const ev = s.phase === "lobby" || s.phase === "finished" ? [] : this.finish("host", now);
    s.phase = "lobby";
    s.players = s.players.filter((p) => !p.left);
    s.matchups = [];
    s.mi = -1;
    return ev.concat([{ type: "lobby" }]);
  }

  abort(now) {
    const s = this.s;
    if (s.phase === "lobby" || s.phase === "finished") return [];
    return this.finish("host", now);
  }

  // Свой аватар (владелец, 27.09): в лобби и между партиями, из списка, не занятый другим игроком
  setAvatar(id, avatar) {
    const s = this.s;
    const p = this.player(id);
    if (!p || p.left) return { ok: false, reason: "not_player" };
    if (s.phase !== "lobby" && s.phase !== "finished") return { ok: false, reason: "game_started" };
    if (!AVATAR_CHOICES.includes(avatar)) return { ok: false, reason: "bad_avatar" };
    if (this.present().some((x) => x !== p && x.avatar === avatar)) return { ok: false, reason: "avatar_taken" };
    p.avatar = avatar;
    return { ok: true, events: [{ type: "avatar", playerId: id }] };
  }

  react(id, emoji, now) {
    const p = this.player(id);
    if (!p || !REACTIONS.includes(emoji)) return { ok: false, reason: "bad" };
    if (p.lastReact != null && now - p.lastReact < REACT_GAP) return { ok: false, reason: "too_fast" };
    p.lastReact = now;
    return { ok: true, events: [{ type: "react", playerId: id, emoji }] };
  }

  // ---------- снимок для клиентов ----------

  /*
   * view: "board" — доска, иначе id игрока. Никому не уходят пулы подсказок и ключи сравнения;
   * до раскрытия схватки — ни авторы ответов, ни отметки 🎲/🐌. Ответы видны только с голосования.
   */
  matchupView(m, view, revealed) {
    const s = this.s;
    const showAnswers = m.order && (revealed || (s.phase === "vote" && s.matchups[s.mi] === m));
    const out = {
      id: m.id,
      kind: m.kind,
      deck: m.deck,
      prompt: m.prompt,
      votesPer: m.votesPer,
      authorsN: m.authors.length,
      answeredN: Object.keys(m.answers).length,
    };
    if (showAnswers) {
      out.answers = m.order.map((id) => {
        const a = m.answers[id];
        const x = a.items ? { items: a.items } : { text: a.text };
        if (revealed) Object.assign(x, { playerId: id, hint: a.hint, late: a.late });
        else if (view === id) x.mine = true;
        return x;
      });
      out.votedN = Object.keys(m.votes).length;
      out.votersN = this.voters(m).length;
      if (revealed) out.result = m.result;
    }
    return out;
  }

  snapshot(now, view) {
    const s = this.s;
    const board = view === "board";
    const me = board ? null : this.player(view);
    const cur = s.mi >= 0 ? s.matchups[s.mi] : null;
    const revealedUpTo = s.phase === "reveal" ? s.mi : s.phase === "vote" ? s.mi - 1 : s.phase === "scores" ? s.matchups.length - 1 : -1;
    let mePart = null;
    if (me) {
      const mine = s.phase === "answer" ? this.mine(me.id).map((m) => {
        const a = m.answers[me.id];
        return { id: m.id, deck: m.deck, prompt: m.prompt, done: !!a, answer: a ? (a.items ? { items: a.items } : { text: a.text }) : null, hint: a ? a.hint : false };
      }) : [];
      mePart = {
        id: me.id,
        prompts: mine,
        hintsLeft: Math.max(0, s.settings.hints - me.hintsUsed),
        inRound: s.roster.includes(me.id),
        voted: cur && s.phase === "vote" ? !!cur.votes[me.id] : false,
        myVotes: cur && cur.votes[me.id] ? cur.votes[me.id] : null,
        canVote: cur && s.phase === "vote" ? !(cur.kind === "duel" && cur.authors.includes(me.id)) && this.votesFor(cur, me.id) > 0 : false,
        votesFor: cur && s.phase === "vote" ? this.votesFor(cur, me.id) : 0,
        myDraft: cur && s.phase === "vote" && cur.drafts ? cur.drafts[me.id] || null : null,
        author: cur ? cur.authors.includes(me.id) : false,
      };
    }
    const R = this.round();
    return {
      phase: s.phase,
      serverNow: now,
      code: s.code,
      settings: s.settings,
      game: s.game,
      plan: s.plan,
      ri: s.ri,
      roundKey: s.ri >= 0 ? s.plan[s.ri] : null,
      mult: R ? R.mult : 1,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      mi: s.mi,
      matchupsN: s.matchups.length,
      current: cur && (s.phase === "vote" || s.phase === "reveal") ? this.matchupView(cur, view, s.phase === "reveal") : null,
      // в фазе ответов доска видит, кто уже ответил (без текстов)
      // вопрос на всех (сцена, финал) — крупно на доске уже в фазе ответов
      sharedPrompt: (s.phase === "answer" || s.phase === "intro") && s.matchups.length === 1 ? s.matchups[0].prompt : null,
      // вопросы «на всех» (мало игроков: два вопроса в первом раунде) — доска показывает их списком
      sharedPrompts: s.phase === "answer" && s.matchups.length > 1 && s.matchups.every((m) => m.kind === "grid") ? s.matchups.map((m) => m.prompt) : null,
      // мало игроков: дуэлей нет, раунды дуэлей идут «на всех» (подписи на экранах другие)
      small: this.present().length <= SMALL,
      progress: s.phase === "answer" ? Object.fromEntries(s.roster.map((id) => [id, this.mine(id).filter((m) => m.answers[id]).length + "/" + this.mine(id).length])) : null,
      history: s.phase === "scores" ? s.matchups.map((m, i) => (i <= revealedUpTo ? { id: m.id, result: m.result } : null)).filter(Boolean) : null,
      best: s.phase === "finished" ? s.best : null,
      hintStar: s.phase === "finished" ? s.hintStar : null,
      finishedReason: s.phase === "finished" ? s.finishedReason : null,
      minPlayers: MIN_PLAYERS,
      avatarChoices: s.phase === "lobby" || s.phase === "finished" ? AVATAR_CHOICES : null,
      me: mePart,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        online: p.online,
        left: p.left,
        score: p.score,
        // Сколько подсказок взял и сколько написал руками — только в итогах: посреди партии эти
        // счётчики выдавали бы, кто сейчас ответил подсказкой (§4: «при голосовании не отличить»).
        ...(s.phase === "finished" ? { hintsUsed: p.hintsUsed, answered: p.answered, avgMs: p.answered >= 2 ? Math.round(p.answerMs / p.answered) : null } : {}),
      })),
    };
  }
}

module.exports = { Game, EXTRA_MS, ROUNDS, PLAN_FULL, PLAN_SHORT, LATE_SHARE, T, DEFAULTS, DECKS, MAX_PLAYERS, MAX_PLAYER_RECORDS, MIN_PLAYERS, SMALL, ANSWER_MAX, ITEM_MAX, REACTIONS, POINTS, WIN_BONUS, SWEEP_BONUS, COLORS, AVATARS, AVATAR_CHOICES, clampSettings, cleanName, cleanText };
