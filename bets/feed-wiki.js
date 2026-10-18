"use strict";

/*
 * Wikimedia recentchange (SSE https://stream.wikimedia.org/v2/stream/recentchange): события
 *   wikiduel — у какой вики больше правок за 20 с (дуэль счётчиков, §10.2),
 *   wikiedit — пороговые рынки «будет ли правка в статье про X» (§10.3, R6),
 *   wikinext — в каком проекте будет следующая правка (рулетка, §10.4, R11).
 * Метки времени серверные (приход сообщения). Считаются только edit и new; журналы и категоризация — нет.
 */
const { withDefaults, RateTracker, managedSse, duelOk, round, makeHandle } = require("./feed-util");
const live = require("./events/live");

const URL = "https://stream.wikimedia.org/v2/stream/recentchange";
const T_SEC = 20, PHI_DUEL = 1.8, PHI_EDIT = 1.5;
const NEXT_WINDOW = 300000, NEXT_MIN_TOTAL = 300;
const EDIT_HISTORY = 30 * 60 * 1000;

// участники дуэли: код wiki → подпись
const WIKIS = {
  enwiki: "en", dewiki: "de", frwiki: "fr", ruwiki: "ru", eswiki: "es", itwiki: "it", jawiki: "ja", ptwiki: "pt", zhwiki: "zh",
  plwiki: "pl", ukwiki: "uk", arwiki: "ar", nlwiki: "nl", svwiki: "sv", wikidatawiki: "Wikidata", commonswiki: "Commons",
};

// каталог тем для wikiedit (по названию статьи, любой язык Википедии, основное пространство)
const TOPICS = [
  ["football", /football|футбол|fußball|fútbol|calcio/i, "футбол"],
  ["basketball", /basketball|баскетбол/i, "баскетбол"],
  ["tennis", /\btennis\b|теннис/i, "теннис"],
  ["olympic", /olympi|олимпи/i, "Олимпиада"],
  ["war", /\bwar\b|войн|krieg|guerre/i, "война"],
  ["election", /election|выбор(?:ы|ов)|wahl\b/i, "выборы"],
  ["president", /president|президент|präsident/i, "президент"],
  ["russia", /\brussia|росси[яи]|russland|russie/i, "Россия"],
  ["ukraine", /ukrain|украин/i, "Украина"],
  ["usa", /united states|\bUSA\b|\bСША\b|vereinigte staaten/i, "США"],
  ["china", /\bchina\b|китай|chine/i, "Китай"],
  ["germany", /germany|германи|deutschland/i, "Германия"],
  ["france", /\bfrance\b|франци/i, "Франция"],
  ["film", /\bfilm\b|фильм|\(film\)/i, "фильм"],
  ["album", /\balbum\b|альбом/i, "альбом"],
  ["song", /\bsong\b|песня|\(song\)/i, "песня"],
  ["list", /^list of|^список|^liste/i, "список"],
  ["village", /village|село|деревн|\bdorf\b/i, "деревня"],
  ["river", /\briver\b|\bреки?\b|\bfluss\b/i, "река"],
  ["school", /school|школ|schule/i, "школа"],
  ["church", /church|церк|kirche/i, "церковь"],
  ["bitcoin", /bitcoin|биткоин|биткойн/i, "биткоин"],
  ["trump", /trump|трамп/i, "Трамп"],
  ["putin", /putin|путин/i, "Путин"],
  ["musk", /\bmusk\b|\bмаск\b/i, "Маск"],
  ["messi", /messi|месси/i, "Месси"],
  ["swift", /taylor swift|тейлор свифт/i, "Тейлор Свифт"],
  ["pokemon", /pok[eé]mon|покемон/i, "покемоны"],
  ["starwars", /star wars|звёздные войны|звездные войны/i, "Звёздные войны"],
  ["cat", /\bcats?\b|\bкошк|\bкот\b|katze/i, "кошки"],
  ["dog", /\bdogs?\b|\bсобак|hund\b/i, "собаки"],
  ["moscow", /moscow|москв|moskau/i, "Москва"],
  ["london", /london|лондон/i, "Лондон"],
  ["paris", /\bparis\b|париж/i, "Париж"],
  ["anime", /anime|аниме/i, "аниме"],
  ["game", /video game|видеоигр|компьютерная игра|videospiel/i, "видеоигры"],
];

function nextCat(server) {
  switch (server) {
    case "www.wikidata.org": return "wikidata";
    case "commons.wikimedia.org": return "commons";
    case "en.wikipedia.org": return "en";
    case "de.wikipedia.org": return "de";
    case "ru.wikipedia.org": return "ru";
    case "fr.wikipedia.org": return "fr";
    default: return "other";
  }
}
const NEXT_LABEL = { wikidata: "Wikidata", commons: "Commons", en: "en", de: "de", ru: "ru", fr: "fr", other: "Другие" };
const NEXT_IDS = ["wikidata", "commons", "en", "de", "ru", "fr"];

function create(d) {
  const deps = withDefaults(d);
  const wikiRates = {};
  for (const w of Object.keys(WIKIS)) wikiRates[w] = new RateTracker({ keep: 10 * 60 * 1000 });
  const topicRates = {};
  for (const [id] of TOPICS) topicRates[id] = new RateTracker({ keep: EDIT_HISTORY });
  const nextTs = {};                    // категория → [t]
  const listeners = new Set();
  let since = 0, lastAt = 0, sse = null, n = 0, live_ = false;
  const lastPrepared = {};

  function onChange(c, t) {
    if (!c || (c.type !== "edit" && c.type !== "new")) return;
    n++;
    if (!since) since = t;
    lastAt = t;
    const wiki = c.wiki, server = c.server_name || "", title = String(c.title || "");
    if (wikiRates[wiki]) wikiRates[wiki].add(t);
    const topics = [];
    if (c.namespace === 0 && /\.wikipedia\.org$/.test(server)) {
      for (const [id, re] of TOPICS) if (re.test(title)) { topicRates[id].add(t); topics.push(id); }
    }
    const cat = nextCat(server);
    (nextTs[cat] || (nextTs[cat] = [])).push(t);
    if (n % 500 === 0) prune(t);
    for (const f of listeners) f({ t, wiki, title, server, cat, topics, bot: !!c.bot, isNew: c.type === "new" });
  }
  function prune(t) {
    for (const r of Object.values(wikiRates)) r.prune(t);
    for (const r of Object.values(topicRates)) r.prune(t);
    for (const k of Object.keys(nextTs)) { const a = nextTs[k]; let i = 0; while (i < a.length && t - a[i] > NEXT_WINDOW) i++; if (i) a.splice(0, i); }
  }
  const warm = (min) => since && deps.now() - since >= min && sse && sse.isLive();

  // ---- wikiduel ----
  function prepareDuel() {
    if (!warm(90000)) return null;
    const now = deps.now(), names = Object.keys(WIKIS), cands = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const la = wikiRates[names[i]].rate(now, { since }), lb = wikiRates[names[j]].rate(now, { since });
        if (!duelOk(la, lb, T_SEC, PHI_DUEL, { minTotal: 16 })) continue;
        const ev = live.duel({ lamA: la, lamB: lb, T: T_SEC, phi: PHI_DUEL });
        const ids = ev.markets.map((m) => m.id);
        if (ids.includes("A") && ids.includes("B")) cands.push({ a: names[i], b: names[j], la, lb });
      }
    }
    if (!cands.length) return null;
    const c = cands[deps.rnd(cands.length)];
    const flip = deps.rnd(2) === 1;                               // сторона не должна зависеть от порядка в каталоге
    const A = flip ? { w: c.b, l: c.lb } : { w: c.a, l: c.la }, B = flip ? { w: c.a, l: c.la } : { w: c.b, l: c.lb };
    lastPrepared.wikiduel = { a: A.w, b: B.w };
    return { input: { lamA: round(A.l, 4), lamB: round(B.l, 4), T: T_SEC, phi: PHI_DUEL }, meta: { labels: { A: WIKIS[A.w], B: WIKIS[B.w] }, wikis: { A: A.w, B: B.w } } };
  }
  function beginDuel(opts) {
    const lp = lastPrepared.wikiduel;
    const wa = (opts.wikis && opts.wikis.A) || (lp && lp.a), wb = (opts.wikis && opts.wikis.B) || (lp && lp.b);
    if (!wa) return abortNow(opts, "пара не подготовлена");
    const h = makeHandle(deps, opts, { timeoutMs: T_SEC * 1000 + 5000 });
    const closeAt = opts.closeAt, endAt = closeAt + T_SEC * 1000;
    let nA = 0, nB = 0, lastItem = 0;
    const fn = (e) => {
      if (e.t <= closeAt || e.t > endAt) return;
      const a = e.wiki === wa, b = e.wiki === wb;
      if (a) nA++; else if (b) nB++;
      if ((a || b) && e.t - lastItem >= 250) { lastItem = e.t; h.live({ kind: "item", side: a ? "a" : "b", text: e.title.slice(0, 80) }); }
    };
    listeners.add(fn);
    h.everyFromClose(500, () => h.live({ kind: "count", a: nA, b: nB }));
    h.later(closeAt + 5000 - deps.now(), () => { if (lastAt <= closeAt) { listeners.delete(fn); h.abort("поток молчит"); } });
    h.later(endAt + 20 - deps.now(), () => { listeners.delete(fn); h.live({ kind: "count", a: nA, b: nB }); h.resolve({ nA, nB }); });
    return { cancel: () => { listeners.delete(fn); h.cancel(); } };
  }

  // ---- wikiedit ----
  function prepareEdit() {
    if (!warm(300000)) return null;
    const now = deps.now(), el = [];
    for (const [id, , label] of TOPICS) {
      const lam = topicRates[id].rate(now, { windowMs: EDIT_HISTORY, halfMs: 900000, since });
      if (!(lam > 0)) continue;
      const ev = live.thresholds([{ id, lam }], { T: T_SEC, phi: PHI_EDIT, ks: [1, 2] });
      if (ev.markets.length) el.push({ id, lam, label });
    }
    if (el.length < 2) return null;
    const pick = [];
    while (pick.length < Math.min(5, el.length)) pick.push(el.splice(deps.rnd(el.length), 1)[0]);
    const kinds = pick.map((k) => ({ id: k.id, lam: round(k.lam, 5) }));
    const labels = {};
    for (const k of pick) labels[k.id] = k.label;
    lastPrepared.wikiedit = { ids: kinds.map((k) => k.id) };
    return { input: { kinds, opts: { T: T_SEC, phi: PHI_EDIT, ks: [1, 2] } }, meta: { labels } };
  }
  function beginEdit(opts) {
    const ids = opts.kinds || (lastPrepared.wikiedit && lastPrepared.wikiedit.ids);
    if (!ids) return abortNow(opts, "темы не подготовлены");
    const h = makeHandle(deps, opts, { timeoutMs: T_SEC * 1000 + 5000 });
    const closeAt = opts.closeAt, endAt = closeAt + T_SEC * 1000;
    const out = {};
    for (const id of ids) out[id] = 0;
    out.first = null;
    let lastItem = 0;
    const fn = (e) => {
      if (e.t <= closeAt || e.t > endAt) return;
      const hit = e.topics.filter((id) => ids.includes(id));
      for (const id of hit) { out[id]++; if (out.first === null) out.first = id; }
      if ((hit.length || e.t - lastItem >= 500) && e.t - lastItem >= 250 && e.server.endsWith(".wikipedia.org")) {
        lastItem = e.t;
        h.live({ kind: "item", id: hit[0] || null, text: e.title.slice(0, 80) });
      }
    };
    listeners.add(fn);
    h.later(closeAt + 5000 - deps.now(), () => { if (lastAt <= closeAt) { listeners.delete(fn); h.abort("поток молчит"); } });
    h.later(endAt + 20 - deps.now(), () => { listeners.delete(fn); h.resolve(Object.assign({}, out)); });
    return { cancel: () => { listeners.delete(fn); h.cancel(); } };
  }

  // ---- wikinext ----
  function nextCounts(now) {
    prune(now);
    const counts = {};
    let total = 0;
    for (const id of NEXT_IDS) { counts[id] = (nextTs[id] || []).length; total += counts[id]; }
    counts.other = (nextTs.other || []).length;
    total += counts.other;
    return { counts, total };
  }
  function prepareNext() {
    if (!warm(60000)) return null;
    const { counts, total } = nextCounts(deps.now());
    if (total < NEXT_MIN_TOTAL) return null;
    const minShare = 0.03;
    const kept = NEXT_IDS.filter((k) => counts[k] / total >= minShare);
    lastPrepared.wikinext = { kept: new Set(kept) };
    const labels = {};
    for (const k of [...kept, "other"]) labels[k] = NEXT_LABEL[k];
    return { input: { counts, minShare }, meta: { labels } };
  }
  function beginNext(opts) {
    const kept = (lastPrepared.wikinext && lastPrepared.wikinext.kept) || new Set(NEXT_IDS);
    const h = makeHandle(deps, opts, { timeoutMs: 10500 });
    const closeAt = opts.closeAt;
    const stopAt = closeAt + 4000 + deps.rnd(5001);
    let lastReel = 0;
    const cat = (c) => (kept.has(c) ? c : "other");
    const fn = (e) => {
      if (e.t <= closeAt) return;
      if (e.t >= stopAt) {
        listeners.delete(fn);
        const c = cat(e.cat);
        h.live({ kind: "reel", cat: c, text: e.title.slice(0, 80) });
        h.live({ kind: "stop" });
        return h.resolve(c);
      }
      if (e.t - lastReel >= 100) { lastReel = e.t; h.live({ kind: "reel", cat: cat(e.cat), text: e.title.slice(0, 80) }); }
    };
    listeners.add(fn);
    h.later(stopAt + 1500 - deps.now(), () => { listeners.delete(fn); h.abort("после стопа не пришло ни одной правки"); });
    return { cancel: () => { listeners.delete(fn); h.cancel(); } };
  }

  function abortNow(opts, why) { deps.setTimeout(() => opts.onAbort && opts.onAbort(why), 0); return { cancel() {} }; }

  return {
    types: ["wikiduel", "wikiedit", "wikinext"],
    start() {
      sse = managedSse(deps, {
        url: URL, name: "wiki",
        headers: { "User-Agent": "randomhost-bets/1.0 (https://randomhost.online; maximkakataev@gmail.com)" },
        onData(text, t) { onChange(JSON.parse(text), t); },
        onState(s) { live_ = s.state === "live"; },
      });
      sse.start();
    },
    stop() { if (sse) sse.stop(); sse = null; },
    status() { const ok = !!sse && sse.isLive(); return { ok, lastAt, note: ok ? `правок ${n}` : "recentchange молчит" }; },
    prepare(type) { return type === "wikiduel" ? prepareDuel() : type === "wikiedit" ? prepareEdit() : type === "wikinext" ? prepareNext() : null; },
    begin(type, opts) { return type === "wikiduel" ? beginDuel(opts) : type === "wikiedit" ? beginEdit(opts) : beginNext(opts); },
    _onChange: onChange, _setSse(s) { sse = s; }, _since(t) { since = t; }, TOPICS,
  };
}

module.exports = { create, TOPICS, WIKIS, nextCat };
