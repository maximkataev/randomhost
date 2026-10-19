"use strict";

/*
 * Bluesky Jetstream (открытый WebSocket постов, без ключа): события emoji (дуэль эмодзи/слов, §10.2)
 * и lang (язык следующего поста, §10.4).
 *
 * Метки времени — серверные (момент прихода сообщения). Считаются только посты, пришедшие ПОСЛЕ closeAt.
 * Сообщения без поля langs в пул языков не попадают; доли считаются по тому же пулу.
 */
const { withDefaults, RateTracker, managedWs, duelOk, round, makeHandle } = require("./feed-util");
const live = require("./events/live");

const HOSTS = ["jetstream2.us-east", "jetstream1.us-west", "jetstream2.us-west", "jetstream1.us-east"];
const PATH = "/subscribe?wantedCollections=app.bsky.feed.post";

// φ эмодзи-дуэли: калибровка по записи 18.10 (42 мин Jetstream, 465 пар-окон по 20 с, из них 117 непересекающихся;
// проходит отбор duelOk фактически одна пара 😂/❤️). Дисперсия (N−λ̂T)²/(λ̂T) = 1,31 (90% ИИ 1,12–1,52), по широкому
// отбору 1,21; минимум лог-потерь размазан (2,2, ИИ 1,2–4,0). Было 1,6; берём 1,4 (с запасом к хвостам). Раздел
// «Калибровка по записям, 18.10» в docs/bets-spec.md §12; инструменты tools/record-feed.js, tools/fit-phi.js.
const T_SEC = 20, PHI_EMOJI = 1.4;
const LANG_WINDOW = 300000, LANG_MIN_TOTAL = 500;
const LANGS = ["en", "ja", "pt", "es", "de", "ru"];
const LANG_LABEL = { en: "English", ja: "日本語", pt: "Português", es: "Español", de: "Deutsch", ru: "Русский", other: "Другой" };

// Каталог эмодзи-дуэлей. Совпадение — пост содержит шаблон (один пост — не больше одного очка на сторону).
const M = {
  laugh: /😂|🤣/, heart: /❤|♥|💖|💕/, fire: /🔥/, skull: /💀/, cry: /😭/, pleading: /🥺/, party: /🎉/, love: /😍|🥰/,
  cat: /🐱|🐈|😺|\bcats?\b/i, dog: /🐶|🐕|\bdogs?\b/i, haha: /\bha(?:ha)+\b/i, lol: /\blol\b/i, ahah: /а?хах/i, lolru: /лол/i,
  sun: /☀|🌞/, moon: /🌙|🌛/,
  // расширение каталога 18.10 (чтобы чаще находилась пара, проходящая duelOk): те же правила, что у остальных — шаблон на пост
  pray: /🙏/, sparkle: /✨/, eyes: /👀/, think: /🤔/, smile: /😊|☺/, sweat: /😅/, thumbs: /👍/, clap: /👏/,
  gm: /\bgood morning\b|\bgm\b/i, gn: /\bgood night\b|\bgn\b/i, thanks: /\bthank(?:s| you)\b|\bthx\b/i, sorry: /\bsorry\b/i,
  privet: /привет/i, poka: /\bпока\b/i,
};
const PAIRS = [
  { id: "laugh-heart", a: "laugh", b: "heart", la: "😂", lb: "❤️" },
  { id: "fire-skull", a: "fire", b: "skull", la: "🔥", lb: "💀" },
  { id: "cry-pleading", a: "cry", b: "pleading", la: "😭", lb: "🥺" },
  { id: "party-love", a: "party", b: "love", la: "🎉", lb: "😍" },
  { id: "cat-dog", a: "cat", b: "dog", la: "🐱", lb: "🐶" },
  { id: "haha-lol", a: "haha", b: "lol", la: "haha", lb: "lol" },
  { id: "ahah-lolru", a: "ahah", b: "lolru", la: "ахах", lb: "лол" },
  { id: "sun-moon", a: "sun", b: "moon", la: "☀️", lb: "🌙" },
  { id: "laugh-cry", a: "laugh", b: "cry", la: "😂", lb: "😭" },
  { id: "heart-fire", a: "heart", b: "fire", la: "❤️", lb: "🔥" },
  { id: "skull-laugh", a: "skull", b: "laugh", la: "💀", lb: "😂" },
  { id: "love-heart", a: "love", b: "heart", la: "😍", lb: "❤️" },
  { id: "pray-sparkle", a: "pray", b: "sparkle", la: "🙏", lb: "✨" },
  { id: "eyes-think", a: "eyes", b: "think", la: "👀", lb: "🤔" },
  { id: "smile-sweat", a: "smile", b: "sweat", la: "😊", lb: "😅" },
  { id: "thumbs-clap", a: "thumbs", b: "clap", la: "👍", lb: "👏" },
  { id: "gm-gn", a: "gm", b: "gn", la: "gm", lb: "gn" },
  { id: "thanks-sorry", a: "thanks", b: "sorry", la: "thanks", lb: "sorry" },
  { id: "privet-poka", a: "privet", b: "poka", la: "привет", lb: "пока" },
];

const baseLang = (l) => String(l || "").toLowerCase().split("-")[0];
const snippet = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);

function create(d) {
  const deps = withDefaults(d);
  const keyRates = {};                                // ключ эмодзи → RateTracker
  for (const k of Object.keys(M)) keyRates[k] = new RateTracker({ keep: 10 * 60 * 1000 });
  const langTs = new Map();                           // язык → [t]
  const listeners = new Set();
  let since = 0, lastAt = 0, conn = null, posts = 0, withLang = 0;
  const lastPrepared = {};

  function onPost(rec, t) {
    posts++;
    if (!since) since = t;
    lastAt = t;
    const text = rec.text || "";
    const hits = [];
    for (const k of Object.keys(M)) if (M[k].test(text)) { keyRates[k].add(t); hits.push(k); }
    let lang = null;
    if (Array.isArray(rec.langs) && rec.langs.length) { lang = baseLang(rec.langs[0]); withLang++; }
    if (lang) {
      let a = langTs.get(lang);
      if (!a) langTs.set(lang, (a = []));
      a.push(t);
    }
    if (posts % 500 === 0) pruneAll(t);
    for (const f of listeners) f({ t, text, hits, lang });
  }
  function pruneAll(t) {
    for (const r of Object.values(keyRates)) r.prune(t);
    for (const [k, a] of langTs) { let i = 0; while (i < a.length && t - a[i] > LANG_WINDOW) i++; if (i) a.splice(0, i); if (!a.length) langTs.delete(k); }
  }

  function endpoints() {
    return HOSTS.map((h) => ({
      name: h, url: `wss://${h}.bsky.network${PATH}`,
      onMessage(text, t) {
        const m = JSON.parse(text);
        const c = m && m.commit;
        if (m.kind !== "commit" || !c || c.operation !== "create" || c.collection !== "app.bsky.feed.post" || !c.record) return;
        onPost(c.record, t);
      },
    }));
  }

  function warm(min) { return since && deps.now() - since >= min && conn && conn.isLive(); }

  // ---- emoji ----
  function prepareEmoji() {
    if (!warm(90000)) return null;
    const now = deps.now();
    const cands = [];
    for (const p of PAIRS) {
      const la = keyRates[p.a].rate(now, { since }), lb = keyRates[p.b].rate(now, { since });
      if (!duelOk(la, lb, T_SEC, PHI_EMOJI, { minTotal: 10 })) continue;
      const ev = live.duel({ lamA: la, lamB: lb, T: T_SEC, phi: PHI_EMOJI });
      const ids = ev.markets.map((m) => m.id);
      if (!ids.includes("A") || !ids.includes("B")) continue;
      cands.push({ p, la, lb });
    }
    if (!cands.length) return null;
    const c = cands[deps.rnd(cands.length)];
    const input = { lamA: round(c.la, 4), lamB: round(c.lb, 4), T: T_SEC, phi: PHI_EMOJI };
    const meta = { labels: { A: c.p.la, B: c.p.lb }, skin: c.p.id };
    lastPrepared.emoji = { pair: c.p, input };       // только запасной вариант: begin берёт пару из opts.meta.skin
    return { input, meta };
  }

  function beginEmoji(opts) {
    // пара — из meta события (переживает рестарт и две комнаты); lastPrepared — лишь запасной вариант
    const skin = (opts.meta && opts.meta.skin) || opts.skin;
    const pair = PAIRS.find((p) => p.id === skin) || (!skin && lastPrepared.emoji && lastPrepared.emoji.pair);
    if (!pair) { return abortNow(opts, "пара не подготовлена"); }
    const h = makeHandle(deps, opts, { timeoutMs: T_SEC * 1000 + 5000 });
    const closeAt = opts.closeAt, endAt = closeAt + T_SEC * 1000;
    let nA = 0, nB = 0, lastItemAt = 0;
    const off = (f) => listeners.delete(f);
    const fn = (p) => {
      if (p.t <= closeAt || p.t > endAt) return;
      const a = p.hits.includes(pair.a), b = p.hits.includes(pair.b);
      if (a) nA++;
      if (b) nB++;
      if ((a || b) && p.t - lastItemAt >= 400) { lastItemAt = p.t; h.live({ kind: "item", side: a ? "a" : "b", text: snippet(p.text) }); }
    };
    listeners.add(fn);
    const stopAll = () => off(fn);
    h.everyFromClose(500, () => h.live({ kind: "count", a: nA, b: nB }));
    // молчание: ни одного поста за первые 5 с — источник мёртв
    h.later(closeAt + 5000 - deps.now(), () => { if (lastAt <= closeAt) { stopAll(); h.abort("поток молчит"); } });
    h.later(endAt + 20 - deps.now(), () => { stopAll(); h.live({ kind: "count", a: nA, b: nB }); h.resolve({ nA, nB }); });
    return { cancel: () => { stopAll(); h.cancel(); } };
  }

  // ---- lang ----
  function langCounts(now) {
    pruneAll(now);
    const counts = {};
    let total = 0, named = 0;
    for (const [l, a] of langTs) { total += a.length; if (LANGS.includes(l)) { counts[l] = a.length; named += a.length; } }
    counts.other = total - named;
    return { counts, total };
  }
  function prepareLang() {
    if (!warm(60000)) return null;
    const { counts, total } = langCounts(deps.now());
    if (total < LANG_MIN_TOTAL) return null;
    const minShare = 0.03;
    const kept = Object.keys(counts).filter((k) => k !== "other" && counts[k] / total >= minShare);
    const labels = {};
    for (const k of [...kept, "other"]) labels[k] = LANG_LABEL[k];
    const input = { counts, minShare };
    lastPrepared.lang = { kept: new Set(kept) };     // запасной вариант: begin берёт набор из opts.meta.labels
    return { input, meta: { labels } };
  }
  function beginLang(opts) {
    // набор рынков = ключи подписей события без «other»; иначе исход мог бы не совпасть с рынками, которые видел игрок
    const lab = opts.meta && opts.meta.labels && typeof opts.meta.labels === "object" ? Object.keys(opts.meta.labels).filter((k) => k !== "other") : null;
    const kept = lab ? new Set(lab) : (lastPrepared.lang && lastPrepared.lang.kept) || new Set(LANGS);
    const h = makeHandle(deps, opts, { timeoutMs: 10500 });
    const closeAt = opts.closeAt;
    const stopAt = closeAt + 4000 + deps.rnd(5001);       // случайный момент «стоп» 4–9 с, неизвестен заранее
    let lastReel = 0;
    const cat = (l) => (kept.has(l) ? l : "other");
    const fn = (p) => {
      if (p.t <= closeAt || !p.lang) return;
      if (p.t >= stopAt) {
        listeners.delete(fn);
        const c = cat(p.lang);
        h.live({ kind: "reel", cat: c, text: snippet(p.text) });
        h.live({ kind: "stop" });
        return h.resolve(c);
      }
      if (p.t - lastReel >= 100) { lastReel = p.t; h.live({ kind: "reel", cat: cat(p.lang), text: snippet(p.text) }); }
    };
    listeners.add(fn);
    h.later(stopAt + 1500 - deps.now(), () => { listeners.delete(fn); h.abort("после стопа не пришло ни одного поста"); });
    return { cancel: () => { listeners.delete(fn); h.cancel(); } };
  }

  function abortNow(opts, why) { deps.setTimeout(() => opts.onAbort && opts.onAbort(why), 0); return { cancel() {} }; }

  return {
    types: ["emoji", "lang"],
    start() {
      conn = managedWs(deps, endpoints(), { name: "bsky", silentMs: 10000, retryPrimaryMs: 600000 });
      conn.start();
    },
    stop() { if (conn) conn.stop(); conn = null; },
    status() { const ok = !!conn && conn.isLive(); return { ok, lastAt, note: ok ? `${conn.endpoint()}, постов ${posts}` : "Jetstream молчит" }; },
    // почему prepare вернул null
    why(type) {
      if (!conn || !conn.isLive()) return "down";
      if (type === "emoji") return warm(90000) ? "no_pair" : "warming";
      if (!warm(60000)) return "warming";
      return langCounts(deps.now()).total < LANG_MIN_TOTAL ? "warming" : "no_pair";
    },
    prepare(type) { return type === "emoji" ? prepareEmoji() : type === "lang" ? prepareLang() : null; },
    begin(type, opts) { return type === "emoji" ? beginEmoji(opts) : beginLang(opts); },
    _onPost: onPost, _setConn(c) { conn = c; }, _since(t) { since = t; }, PAIRS,
  };
}

module.exports = { create, PAIRS, LANGS, M };
