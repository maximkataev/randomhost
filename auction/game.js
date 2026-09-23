"use strict";

const { modeById, modesForKind } = require("./modes");

/*
 * Движок аукциона: чистая логика без сети и таймеров.
 * Всё состояние лежит в plain-объекте `this.s`, чтобы его можно было дампить в JSON и поднимать обратно.
 * Время приходит снаружи (`now` в миллисекундах): сервер зовёт tick(now), когда истекает ближайший deadline.
 * Каждый метод возвращает список событий для эффектов на клиентах ({type, ...}).
 */

const DEFAULTS = {
  budget: 30,
  slots: 5,
  t1: 20000, // фаза ЛОТ: 20 с до пропуска лота
  t2: 10000, // после ставки: столько есть у остальных, чтобы перебить
  t3: 5000, // РАЗБОР
  lotCap: 60000, // максимум на один лот
  antiSnipeWindow: 2000,
  antiSnipeBonus: 3000,
  showDelay: 2000, // ПРОДАНО / ЗАБРАЛ перед следующим лотом
  // Заставка перед первым лотом: задание крупно, потом отсчёт 3-2-1. Отдельная фаза, а не
  // анимация поверх лота, — иначе игроки теряли бы секунды торгов, пока смотрят заставку.
  // 0 — без заставки (тесты и симуляции стартуют сразу).
  intro: 6000,
  judge: "chatgpt", // chatgpt | vote
  mode: "base", // задание: что собираем и как судят (auction/modes.js)
  // Язык партии: на нём приходят лоты и отвечает судья. Ставится один на комнату, а не на
  // устройство: все смотрят в один экран, и разноязычные карточки за одним столом бессмысленны.
  lang: "ru",
  // Имя комнаты, которое ведущий может задать сам («Днюха Ани»). Код в ссылке при этом остаётся
  // сгенерированным: он должен быть коротким и без коллизий, а набирать его руками никто не должен.
  title: "",
  media: true,
};

const PHASES = ["lobby", "intro", "lot", "bidding", "pickup", "draft", "sold", "taken", "unsold", "finished"];

/*
 * Соло-добор (§6.5). Когда свободные слоты остались ровно у одного подключённого игрока,
 * торговаться уже не с кем: фаза ДОБОР заменяет ЛОТ/ТОРГИ/РАЗБОР, лоты бесплатны, а игрок
 * решает «взять или скипнуть». Скипов пять на каждый слот, шестой лот обязателен — это и
 * есть гарантия, что партия закончится: на все слоты уходит не больше 6 × слоты лотов.
 * В настройки комнаты эти числа не выносятся: выбирать нечего, торговаться не с кем.
 */
const SOLO_T4 = 10000; // таймер ДОБОРА
const SOLO_SKIPS = 5; // скипов на слот
const SOLO_WAIT = 60000; // сколько ждём вернувшегося добирающего, прежде чем закончить партию (§7.4)

// `kind` обязателен всюду, где категория известна: задание живёт не во всех категориях,
// и проверка id без категории пропускала «лигу суперзлодеев» в блюда (POST /rooms, next_game).
function clampSettings(input = {}, kind) {
  const s = { ...DEFAULTS };
  const num = (k, min, max) => {
    const v = Number(input[k]);
    if (Number.isFinite(v)) s[k] = Math.min(max, Math.max(min, Math.round(v)));
  };
  num("budget", 10, 200);
  num("slots", 3, 8);
  num("t1", 5000, 60000);
  num("t2", 3000, 15000);
  num("intro", 0, 15000);
  if (input.judge === "vote" || input.judge === "chatgpt") s.judge = input.judge;
  if (typeof input.mode === "string" && modeById(input.mode).id === input.mode) s.mode = input.mode;
  if (kind && !modesForKind(kind).some((m) => m.id === s.mode)) s.mode = "base";
  if (input.lang === "ru" || input.lang === "en" || input.lang === "el") s.lang = input.lang;
  if (typeof input.title === "string") s.title = input.title.replace(/\s+/g, " ").trim().slice(0, 40);
  if (typeof input.media === "boolean") s.media = input.media;
  return s;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Game {
  constructor(state) {
    this.s = state;
  }

  static create({ kind, cards, settings, rng = Math.random }) {
    return new Game({
      kind,
      settings: clampSettings(settings, kind),
      phase: "lobby",
      players: [], // {id, name, money, lots: [card], online, left, spent}
      deck: shuffle(cards, rng),
      rounds: 0,
      round: 0, // индекс текущего лота (с 0)
      lot: null,
      price: 0,
      leaderId: null,
      bids: [], // {playerId, amount, at}
      deadline: null,
      lotStartedAt: null,
      lotCapAt: null,
      solo: null, // соло-добор: {playerId, skips} (§6.5)
      paused: null, // {at, remaining}
      results: null, // {mode, ranking, summary} после судейства
      votes: {},
      finishedReason: null,
    });
  }

  static from(state) {
    return new Game(state);
  }

  // ---------- участники ----------

  addPlayer({ id, name }) {
    const s = this.s;
    if (s.players.some((p) => p.id === id)) return this.player(id);
    // запасное имя тоже на языке партии: пустое имя клиент не пропускает, но по сети прийти может
    const FALLBACK = { ru: "Игрок", en: "Player", el: "Παίκτης" };
    const base = name.trim().slice(0, 24) || FALLBACK[s.settings.lang] || FALLBACK.ru;
    let final = base;
    for (let n = 2; s.players.some((p) => p.name === final); n++) final = `${base} ${n}`;
    const p = { id, name: final, money: s.settings.budget, spent: 0, lots: [], online: true, left: false };
    s.players.push(p);
    return p;
  }

  player(id) {
    return this.s.players.find((p) => p.id === id) || null;
  }

  // Отвал игрока останавливает партию: иначе лот уходит за него, пока он переподключается,
  // а деньги и слот уже не вернуть. Снимает паузу только ведущий (resume — его команда),
  // сам по себе возврат игрока игру не продолжает: за столом должны увидеть, что все на месте.
  setOnline(id, online, now = Date.now()) {
    const p = this.player(id);
    if (!p) return [];
    const was = p.online;
    p.online = online;
    const s = this.s;
    if (online) {
      // Партию ждали именно его: соло-добор продолжается сам. Снимать паузу тут больше некому —
      // остальные уже собрали лайнапы или ушли, а ведущий мог уйти вместе с ними.
      if (s.paused && s.paused.waitFor === id) return this.resume(now);
      // добирающих снова двое и больше — соло-добор выключается, лот доигрывается торгами (§6.5)
      if (s.phase === "draft" && !s.paused && this.drafters().length > 1) return this.soloOff(now);
      return [];
    }
    if (was === false || p.left) return [];
    if (s.phase === "lobby" || s.phase === "finished" || s.paused) return [];
    const ev = this.pause(now, true).concat([{ type: "dropped", playerId: id }]);
    // Ушёл в offline единственный добирающий: ждём его минуту («Ждём Аню») и заканчиваем
    // партию с его пустыми слотами — иначе она висела бы вечно на одном человеке (§7.4).
    if (s.phase === "draft" && s.solo && s.solo.playerId === id && s.paused) {
      s.paused.waitFor = id;
      s.paused.waitUntil = now + SOLO_WAIT;
    }
    return ev;
  }

  removePlayer(id) {
    const p = this.player(id);
    if (!p) return [];
    if (this.s.phase === "lobby") {
      this.s.players = this.s.players.filter((x) => x.id !== id);
      return [];
    }
    p.left = true;
    p.online = false;
    const ev = [{ type: "left", playerId: id }];
    if (this.s.leaderId === id) {
      // лидер ушёл — его ставка снимается, лот продолжается с предыдущей ставки чужого игрока
      const others = this.s.bids.filter((b) => b.playerId !== id);
      const last = others[others.length - 1];
      this.s.bids = others;
      this.s.leaderId = last ? last.playerId : null;
      this.s.price = last ? last.amount : 0;
      if (!last && this.s.phase === "bidding") this.s.phase = "lot";
    }
    if (this.activePlayers().length < 2 && this.s.phase !== "finished") ev.push(...this.finish("not_enough_players"));
    return ev;
  }

  activePlayers() {
    return this.s.players.filter((p) => !p.left);
  }

  // может ставить: подключён, не вышел, есть слот и хотя бы $1
  canBid(p) {
    return p && p.online && !p.left && p.lots.length < this.s.settings.slots && p.money >= 1;
  }

  // может забрать бесплатно в РАЗБОРЕ: подключён, слот есть, денег нет
  canTake(p) {
    return p && p.online && !p.left && p.lots.length < this.s.settings.slots && p.money === 0;
  }

  bidders() {
    return this.s.players.filter((p) => this.canBid(p));
  }

  // «Добирающие» — подключённые игроки со свободными слотами. Денег тут не спрашиваем: в доборе
  // лоты бесплатны, а пока добирающих двое и больше, игрок с $0 и так ждёт РАЗБОРА.
  drafters() {
    return this.s.players.filter((p) => p.online && !p.left && p.lots.length < this.s.settings.slots);
  }

  // ---------- старт и лоты ----------

  start(now) {
    const s = this.s;
    if (s.phase !== "lobby") throw new Error("already started");
    const n = this.activePlayers().length;
    if (n < 2) throw new Error("need at least 2 players");
    s.rounds = Math.min(s.deck.length, Math.ceil(n * s.settings.slots * 1.25));
    s.round = -1;
    if (s.settings.intro > 0) {
      s.phase = "intro";
      s.deadline = now + s.settings.intro;
      return [{ type: "started" }, { type: "intro" }];
    }
    return [{ type: "started" }, ...this.nextLot(now)];
  }

  nextLot(now) {
    const s = this.s;
    s.round += 1;
    // С v0.7 партия идёт, пока у всех не заполнены слоты: `rounds` — только прогноз и счётчик
    // на доске (§7.3). Жёсткий предохранитель один — кончившаяся колода.
    if (s.round >= s.deck.length) return this.finish("deck_over");
    // никого нет на связи (обрыв у всех, перезапуск сервера) — не заканчиваем партию, а ждём на паузе
    const online = this.activePlayers().filter((p) => p.online);
    if (!online.length) {
      s.round -= 1;
      return this.autoPause(now);
    }
    const drafters = this.drafters();
    if (!drafters.length) return this.finish("all_full");
    s.lot = s.deck[s.round];
    s.price = 0;
    s.leaderId = null;
    s.bids = [];
    s.lotStartedAt = now;
    s.lotCapAt = now + s.settings.lotCap;
    // Свободные слоты остались у одного — торговаться не с кем: фаза ДОБОР (§6.5).
    // Счётчик скипов свой на каждый слот: у нового добирающего он полный, у прежнего —
    // тот, с которым он подошёл к этому лоту (обнуляется взятием, см. draftTake).
    if (drafters.length === 1) {
      const id = drafters[0].id;
      s.solo = { playerId: id, skips: s.solo && s.solo.playerId === id ? s.solo.skips : SOLO_SKIPS };
      s.phase = "draft";
      s.deadline = now + SOLO_T4;
      return [{ type: "draft", round: s.round, playerId: id }];
    }
    s.solo = null;
    s.phase = "lot";
    // торговаться некому — не держим лот 10 секунд
    const t1 = this.bidders().length ? s.settings.t1 : 3000;
    s.deadline = now + t1;
    return [{ type: "lot", round: s.round }];
  }

  // Соло-добор выключается посреди лота: игрок вернулся или ведущий впустил гостя, добирающих
  // снова двое и больше. Карточка уже на экране, поэтому лот не меняем — он доигрывается торгами.
  soloOff(now) {
    const s = this.s;
    if (s.phase !== "draft") return [];
    s.solo = null;
    s.phase = "lot";
    s.lotStartedAt = now;
    s.lotCapAt = now + s.settings.lotCap;
    s.deadline = now + (this.bidders().length ? s.settings.t1 : 3000);
    return [{ type: "lot", round: s.round }];
  }

  bid(playerId, amount, now, expectedPrice) {
    const s = this.s;
    const p = this.player(playerId);
    if (s.phase !== "lot" && s.phase !== "bidding") return { ok: false, reason: "closed" };
    if (s.paused) return { ok: false, reason: "paused" };
    if (!this.canBid(p)) return { ok: false, reason: "cannot_bid" };
    if (s.leaderId === playerId) return { ok: false, reason: "already_leader" };
    if (expectedPrice != null && expectedPrice !== s.price) return { ok: false, reason: "price_changed", price: s.price };
    amount = Math.floor(Number(amount));
    if (!(amount >= s.price + 1)) return { ok: false, reason: "too_low", price: s.price };
    if (amount > p.money) return { ok: false, reason: "not_enough_money", money: p.money };

    const prevLeader = s.leaderId;
    s.price = amount;
    s.leaderId = playerId;
    s.bids.push({ playerId, amount, at: now });
    s.phase = "bidding";
    // таймер = max(остаток T1, T2); ставка в последние 2 с — +3 с; общий кап 60 с
    let deadline = Math.max(s.deadline, now + s.settings.t2);
    if (s.deadline - now <= s.settings.antiSnipeWindow) deadline = Math.max(deadline, now + s.settings.t2 + s.settings.antiSnipeBonus);
    s.deadline = Math.min(deadline, s.lotCapAt);
    const events = [{ type: "bid", playerId, amount }];
    if (prevLeader && prevLeader !== playerId) events.push({ type: "outbid", playerId: prevLeader, by: playerId, amount });
    return { ok: true, events };
  }

  take(playerId, now) {
    const s = this.s;
    const p = this.player(playerId);
    if (s.phase === "draft") return this.draftTake(playerId, now);
    if (s.phase !== "pickup") return { ok: false, reason: "closed" };
    if (s.paused) return { ok: false, reason: "paused" };
    if (!this.canTake(p)) return { ok: false, reason: "cannot_take" };
    p.lots.push(this.lotRecord(0));
    s.phase = "taken";
    s.leaderId = playerId;
    s.deadline = now + s.settings.showDelay;
    return { ok: true, events: [{ type: "taken", playerId, lot: s.lot.name }] };
  }

  // ---------- соло-добор ----------

  // «Взять»: лот бесплатно, счётчик скипов снова полный — он свой на каждый слот (§6.5).
  // auto = взятие за истёкший таймер на обязательном лоте.
  draftTake(playerId, now, auto = false) {
    const s = this.s;
    const p = this.player(playerId);
    if (s.phase !== "draft") return { ok: false, reason: "closed" };
    if (s.paused) return { ok: false, reason: "paused" };
    if (!s.solo || s.solo.playerId !== playerId) return { ok: false, reason: "cannot_take" };
    if (!p || p.left || p.lots.length >= s.settings.slots) return { ok: false, reason: "cannot_take" };
    p.lots.push(this.lotRecord(0));
    s.solo.skips = SOLO_SKIPS;
    s.phase = "taken";
    s.leaderId = playerId;
    s.deadline = now + s.settings.showDelay;
    return { ok: true, events: [{ type: "taken", playerId, lot: s.lot.name, auto }] };
  }

  // «Скип»: лот в отбой и не возвращается, счётчик −1. Скипов не осталось — лот обязателен.
  skip(playerId, now) {
    const s = this.s;
    if (s.phase !== "draft") return { ok: false, reason: "closed" };
    if (s.paused) return { ok: false, reason: "paused" };
    if (!s.solo || s.solo.playerId !== playerId) return { ok: false, reason: "cannot_skip" };
    if (s.solo.skips <= 0) return { ok: false, reason: "must_take" };
    s.solo.skips -= 1;
    s.phase = "unsold";
    s.leaderId = null;
    s.deadline = now + Math.min(s.settings.showDelay, 1000);
    return { ok: true, events: [{ type: "unsold", lot: s.lot.name }] };
  }

  lotRecord(price) {
    const c = this.s.lot;
    return { name: c.name, emoji: c.emoji, meta: c.meta, price, round: this.s.round };
  }

  // ---------- время ----------

  tick(now) {
    const s = this.s;
    if (s.paused) {
      // единственное, что идёт на паузе, — минута ожидания добирающего (§7.4)
      if (s.paused.waitUntil && now >= s.paused.waitUntil) return this.finish("solo_gone");
      return [];
    }
    if (s.phase === "lobby" || s.phase === "finished") return [];
    if (now < s.deadline) return [];
    switch (s.phase) {
      case "intro":
        return this.nextLot(now);
      case "bidding": {
        const p = this.player(s.leaderId);
        // лидера не стало (кик/выход в ту же миллисекунду) — лот никому не уходит, но сервер не падает
        if (!p || p.left) {
          s.phase = "unsold";
          s.price = 0;
          s.leaderId = null;
          s.deadline = now + Math.min(s.settings.showDelay, 1000);
          return [{ type: "unsold", lot: s.lot.name }];
        }
        p.money -= s.price;
        p.spent += s.price;
        p.lots.push(this.lotRecord(s.price));
        s.phase = "sold";
        s.deadline = now + s.settings.showDelay;
        return [{ type: "sold", playerId: p.id, amount: s.price, lot: s.lot.name }];
      }
      case "lot": {
        if (s.players.some((p) => this.canTake(p))) {
          s.phase = "pickup";
          s.deadline = now + s.settings.t3;
          return [{ type: "pickup" }];
        }
        s.phase = "unsold";
        s.deadline = now + Math.min(s.settings.showDelay, 1000);
        return [{ type: "unsold", lot: s.lot.name }];
      }
      case "pickup": {
        s.phase = "unsold";
        s.deadline = now + Math.min(s.settings.showDelay, 1000);
        return [{ type: "unsold", lot: s.lot.name }];
      }
      case "draft": {
        // Бездействие = скип и списывает счётчик, иначе партия висела бы на неактивном игроке.
        // На обязательном лоте истёкший таймер, наоборот, = взятие (§6.5).
        const id = s.solo ? s.solo.playerId : null;
        const r = s.solo && s.solo.skips > 0 ? this.skip(id, now) : this.draftTake(id, now, true);
        if (r.ok) return r.events;
        // добирающего не стало в ту же миллисекунду (кик/выход) — лот в отбой, следующий лот разберётся
        s.phase = "unsold";
        s.deadline = now + Math.min(s.settings.showDelay, 1000);
        return [{ type: "unsold", lot: s.lot.name }];
      }
      case "sold":
      case "taken":
      case "unsold":
        return this.nextLot(now);
      default:
        return [];
    }
  }

  // хост пропускает лот: без ставок — сразу дальше, со ставками — немедленная продажа лидеру.
  // Работает во всех игровых фазах; на паузе и в лобби/финале — ничего не делает.
  hostSkip(now) {
    const s = this.s;
    if (s.paused || s.phase === "lobby" || s.phase === "finished") return [];
    // заставку ведущий тоже вправе оборвать — компания уже смотрит на экран
    if (s.phase === "intro" || s.phase === "lot" || s.phase === "bidding" || s.phase === "pickup" || s.phase === "draft" || s.phase === "sold" || s.phase === "taken" || s.phase === "unsold") {
      s.deadline = now;
      return this.tick(now);
    }
    return [];
  }

  pause(now, auto = false) {
    const s = this.s;
    if (s.paused || s.phase === "lobby" || s.phase === "finished") return [];
    s.paused = { at: now, remaining: s.deadline - now, capRemaining: s.lotCapAt - now, auto };
    return [{ type: "paused", auto }];
  }

  // автопауза «ждём игроков»: все отвалились (в том числе после перезапуска сервера)
  autoPause(now) {
    return this.pause(now, true);
  }

  resume(now) {
    const s = this.s;
    if (!s.paused) return [];
    let remaining = Math.max(0, s.paused.remaining);
    // после паузы нельзя оставлять 0,4 с на реакцию: в активных фазах даём минимум 3 с
    if (s.phase === "lot" || s.phase === "bidding" || s.phase === "pickup" || s.phase === "draft") remaining = Math.max(remaining, 3000);
    s.deadline = now + remaining;
    s.lotCapAt = now + Math.max(remaining, Math.max(0, s.paused.capRemaining));
    s.paused = null;
    return [{ type: "resumed" }];
  }

  finish(reason) {
    const s = this.s;
    s.phase = "finished";
    s.finishedReason = reason;
    s.deadline = null;
    s.lot = null;
    return [{ type: "finished", reason }];
  }

  // ---------- финал ----------

  // голосование: каждый игрок с лотами — один голос за чужой лайнап
  vote(playerId, forId) {
    const s = this.s;
    // голосование закрыто, когда итоги уже посчитаны (или судил ChatGPT)
    if (s.phase !== "finished" || s.results) return { ok: false, reason: "closed" };
    const me = this.player(playerId);
    const target = this.player(forId);
    if (!me || !target || me.left || target.left || playerId === forId) return { ok: false, reason: "bad_vote" };
    if (!me.lots.length) return { ok: false, reason: "no_lots" };
    s.votes[playerId] = forId;
    return { ok: true, events: [{ type: "vote", playerId }] };
  }

  closeVotes(rng = Math.random) {
    const s = this.s;
    const counts = {};
    for (const p of this.activePlayers()) counts[p.id] = 0;
    for (const id of Object.values(s.votes)) if (id in counts) counts[id]++;
    const ranking = this.activePlayers()
      .filter((p) => p.lots.length)
      .map((p) => ({ playerId: p.id, score: counts[p.id], verdict: "", tie: rng() }))
      .sort((a, b) => b.score - a.score || this.player(a.playerId).spent - this.player(b.playerId).spent || a.tie - b.tie)
      .map(({ tie, ...r }) => r);
    s.results = { mode: "vote", ranking, summary: "" };
    return [{ type: "results" }];
  }

  setJudgeResults(ranking, summary) {
    this.s.results = { mode: "chatgpt", ranking, summary };
    return [{ type: "results" }];
  }

  // ---------- снимок для клиентов ----------

  snapshot(now) {
    const s = this.s;
    return {
      kind: s.kind,
      phase: s.phase,
      paused: !!s.paused,
      pausedAuto: !!(s.paused && s.paused.auto), // «ждём игроков», а не пауза ведущего
      pausedFor: (s.paused && s.paused.waitFor) || null, // «ждём Аню»: минута соло-добора (§7.4)
      round: s.round,
      rounds: s.rounds,
      deckSize: s.deck.length, // предупреждение о маленькой колоде в лобби (§5)
      // Соло-добор: кто добирает и сколько у него скипов. T4 в настройках нет — константа,
      // но клиентам нужно знать длину фазы, чтобы нарисовать кольцо таймера.
      solo: s.phase === "draft" && s.solo ? { playerId: s.solo.playerId, skips: s.solo.skips } : null,
      t4: SOLO_T4,
      lot: s.lot && (s.phase === "lot" || s.phase === "bidding" || s.phase === "pickup" || s.phase === "draft" || s.phase === "sold" || s.phase === "taken" || s.phase === "unsold") ? s.lot : null,
      price: s.price,
      leaderId: s.leaderId,
      bids: s.bids.slice(-6),
      deadline: s.deadline,
      serverNow: now,
      settings: s.settings,
      finishedReason: s.finishedReason,
      results: s.results,
      votes: s.phase === "finished" ? Object.keys(s.votes).length : 0,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        money: p.money,
        spent: p.spent,
        lots: p.lots,
        online: p.online,
        left: p.left,
        full: p.lots.length >= s.settings.slots,
        canBid: this.canBid(p),
        canTake: s.phase === "pickup" && this.canTake(p),
        canDraft: s.phase === "draft" && !!s.solo && s.solo.playerId === p.id,
      })),
    };
  }
}

module.exports = { Game, DEFAULTS, PHASES, clampSettings, SOLO_T4, SOLO_SKIPS, SOLO_WAIT };
