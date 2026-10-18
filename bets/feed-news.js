"use strict";

/*
 * 📰 Кто первый в новостях (R3, §10.1): регион первого нового заголовка ленты (BBC World, Al Jazeera).
 * Reuters: публичный RSS закрыт (feeds.reuters.com не резолвится), в этой версии его нет.
 *
 * Регион определяется словарём (демонимы, столицы, лидеры). Неоднозначные заголовки (два региона сразу)
 * пропускаются и в статистику не входят — оценка вероятности и исход считаются по одному и тому же пулу.
 * Заголовок «новый», если его не было в ленте на момент закрытия (первый опрос в begin() только запоминает ленту)
 * и он не помечен датой старше closeAt − 60 с. Вероятность — по накопленным заголовкам (до 2000 на ленту).
 */
const { withDefaults, parseRss, makeHandle } = require("./feed-util");

const FEEDS = [
  { id: "bbc", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "aj", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
];
const POLL_BG = 30000, POLL_FG = 4000, KEEP = 2000, MIN_CLASSIFIED = 50;
const UA = "randomhost-bets/1.0 (+https://randomhost.online)";

// регистр важен только для аббревиатур (US, UK, EU)
const REGIONS = [
  ["us", "США", [/\b(?:United States|America|Americans?|Washington|White House|Pentagon|Congress|Senate|Trump|Biden|Vance|Rubio|New York|California|Texas|Florida|FBI|CIA|Federal Reserve|Wall Street)\b/i, /\b(?:US|USA|U\.S\.)\b/]],
  ["ru", "Россия", [/\b(?:Russia|Russian|Russians|Moscow|Putin|Kremlin|Lavrov|Medvedev|Siberia)\b/i]],
  ["il", "Израиль и Газа", [/\b(?:Israel|Israeli|Israelis|Gaza|Hamas|Hezbollah|Tel Aviv|Jerusalem|Netanyahu|West Bank|Palestin\w+|IDF|Houthi|Houthis)\b/i]],
  ["cn", "Китай", [/\b(?:China|Chinese|Beijing|Xi Jinping|Hong Kong|Taiwan|Taiwanese|Shanghai)\b/i]],
  ["ua", "Украина", [/\b(?:Ukraine|Ukrainian|Ukrainians|Kyiv|Kiev|Zelensky\w*|Donbas|Donetsk|Kharkiv|Odesa|Crimea)\b/i]],
  ["eu", "Европа", [/\b(?:Britain|British|London|France|French|Paris|Germany|German|Berlin|Brussels|European|Europe|Italy|Italian|Rome|Spain|Spanish|Madrid|Poland|Polish|Macron|Starmer|Scholz|Merz|Netherlands|Dutch|Sweden|Swedish|Norway|Greece|Greek|Ireland|Irish|Scotland|Wales|England)\b/i, /\b(?:UK|EU)\b/]],
];
const LABELS = Object.fromEntries(REGIONS.map(([id, l]) => [id, l]));
LABELS.other = "Другое";

// → id региона, "other" (ничего не нашли) или null (неоднозначно)
function classify(text) {
  const hit = [];
  for (const [id, , res] of REGIONS) if (res.some((re) => re.test(text))) hit.push(id);
  if (hit.length > 1) return null;
  return hit.length ? hit[0] : "other";
}

function create(d) {
  const deps = withDefaults(d);
  const hist = new Map();            // guid → { cls, feed }
  let lastOk = 0, iv = null, note = "не запущен";
  const known = new Set();
  let polling = null;

  async function fetchFeed(f) {
    try {
      const res = await deps.fetch(f.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" } });
      if (!res.ok) return null;
      return parseRss(await res.text());
    } catch (e) { return null; }
  }
  // один опрос обеих лент; возвращает свежие (раньше не виденные) элементы
  async function poll() {
    if (polling) return polling;
    polling = (async () => {
      const fresh = [];
      const all = await Promise.all(FEEDS.map(async (f) => ({ f, items: await fetchFeed(f) })));
      const t = deps.now();
      let ok = false;
      for (const { f, items } of all) {
        if (!items) continue;
        ok = true;
        for (const it of items) {
          const key = f.id + ":" + it.guid;
          if (known.has(key)) continue;
          known.add(key);
          const cls = classify(it.title);
          fresh.push({ key, feed: f.name, title: it.title, pubMs: it.pubMs, cls, t });
          if (cls) hist.set(key, cls);
        }
      }
      if (ok) { lastOk = t; note = `заголовков ${hist.size}`; }
      if (hist.size > KEEP * FEEDS.length) { const drop = hist.size - KEEP * FEEDS.length; let i = 0; for (const k of hist.keys()) { if (i++ >= drop) break; hist.delete(k); } }
      if (known.size > KEEP * 4) { let i = 0; for (const k of known) { if (i++ > KEEP) break; known.delete(k); } }
      return fresh;
    })();
    try { return await polling; } finally { polling = null; }
  }

  function counts() {
    const c = {};
    for (const id of Object.keys(LABELS)) c[id] = 0;
    for (const v of hist.values()) c[v]++;
    return c;
  }

  function prepare() {
    if (!(lastOk > 0 && deps.now() - lastOk < 120000)) return null;
    const c = counts();
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    if (total < MIN_CLASSIFIED) return null;
    const minShare = 0.03;
    const labels = {};
    for (const [id, n] of Object.entries(c)) if (id !== "other" && n / total >= minShare) labels[id] = LABELS[id];
    labels.other = LABELS.other;
    return { input: { counts: c, minShare }, meta: { labels, feeds: FEEDS.map((f) => f.name) } };
  }

  function begin(type, opts) {
    const h = makeHandle(deps, opts, { timeoutMs: 46000 });
    const closeAt = opts.closeAt;
    const c = counts(), total = Object.values(c).reduce((a, b) => a + b, 0);
    const kept = new Set(Object.keys(c).filter((id) => id !== "other" && total && c[id] / total >= 0.03));
    let armed = false;     // первый опрос после закрытия только запоминает ленту
    async function tick() {
      if (h.done) return;
      const fresh = await poll();
      if (h.done) return;
      if (!armed) { armed = true; return; }
      fresh.sort((a, b) => (a.pubMs || a.t) - (b.pubMs || b.t));
      for (const it of fresh) {
        if (it.pubMs && it.pubMs < closeAt - 60000) continue;      // старая новость, просто поздно попавшая в ленту
        if (it.cls === null) { deps.log(`[news] неоднозначно: ${it.title}`); continue; }
        const cat = kept.has(it.cls) ? it.cls : "other";
        h.live({ kind: "reel", cat, text: it.title.slice(0, 160) });
        h.live({ kind: "stop" });
        return h.resolve(cat);
      }
    }
    const start = () => { tick(); h.every(POLL_FG, tick); };
    h.later(closeAt - deps.now(), start);
    return { cancel: () => h.cancel() };
  }

  return {
    types: ["news"],
    start() { poll(); iv = deps.setInterval(() => poll(), POLL_BG); },
    stop() { deps.clearInterval(iv); },
    status() { const ok = lastOk > 0 && deps.now() - lastOk < 120000; return { ok, lastAt: lastOk, note }; },
    prepare, begin, _poll: poll, _counts: counts, classify,
  };
}

module.exports = { create, classify, REGIONS, FEEDS };
