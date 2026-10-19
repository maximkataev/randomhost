"use strict";

/*
 * ✈ Аэропорт-дуэль (R9, §10.2): у какого аэропорта больше взлётов за окно T = 90 с.
 *
 * Источники ADS-B без ключа (проверено 18.10.2026 с этой машины, оба отвечают 200 анонимно):
 *   adsb.lol     GET https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}            → { ac: [...] }
 *   adsb.fi      GET https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm} → { aircraft: [...] }
 * (у adsb.fi путь /v2/point/... даёт 400 — используем lat/lon/dist). Заявленный лимит — около 1 запроса
 * в секунду; на деле adsb.lol уже через ~5 минут при 1 запросе в 2,4 с отвечал 429, поэтому у него зазор 5 с, а у adsb.fi 2,4 с
 * (за 20 минут без отказов). На 429 источник отдыхает по Retry-After (иначе 2, 4… до 10 минут).
 * В User-Agent — адрес проекта. Любой из двух источников может упасть: после трёх ошибок подряд он отдыхает 1, 2, 4… до 10 минут.
 *
 * Определение «взлёт» (в радиусе R_KM от полосы), по одному судну (hex), без дублей в течение 10 минут:
 *   «ground»: в последние 150 с видели судно на земле (alt_baro == "ground"), теперь оно в воздухе,
 *             высота над аэродромом < 3000 фт, ground speed ≥ 90 уз и оно набирает высоту
 *             (baro_rate ≥ 300 или высота выросла против прошлого отсчёта);
 *   «climb»:  судна на земле мы не видели (нет покрытия у земли), но оно впервые появилось в воздухе низко
 *             (< 2000 фт над аэродромом), быстро (≥ 110 уз) и круто набирает (baro_rate ≥ 700).
 * Заход на посадку/пролёт сюда не попадает: у них снижение или нет набора. Вертолёты (A7) не считаем.
 * Если аэропорт у нас «не слышен» (нет ни одного отсчёта за минуту), счёт не засчитывается как нулевой:
 * begin() прерывается, а prepare() не предлагает пару без свежих отсчётов.
 *
 * Счёт окна ведётся по серверному времени ответа: считаются только взлёты, обнаруженные после closeAt.
 * Математика (duel с точной свёрткой) — events/live.js. φ — см. PHI_AIRPORT ниже.
 */
const { withDefaults, RateTracker, duelOk, round, makeHandle } = require("./feed-util");
const live = require("./events/live");

const T_SEC = 90;
// Сверхдисперсия. Измерение 18.10 (20 мин, окна 90 с, три сдвига): Фано по аэропортам 0,56–0,71 (взлёты регулярнее
// пуассона: полосы пропускают самолёты по очереди), var(N_A−N_B)/E(N_A+N_B) по парам 0,62–0,82. Но λ мы знаем лишь
// по ~10 событиям за 15 минут (ошибка ~30%), что добавляет к дисперсии разности ещё ~0,1–0,3. Итог около 0,9;
// по спеке φ ≥ 1, берём границу 1,0 (честнее прибавлять запас, чем недооценивать ничьи вдвое).
const PHI_AIRPORT = 1.0;

const R_KM = 9;                    // радиус счёта вокруг аэропорта
const QUERY_NM = 5.6;              // радиус запроса (≈10,4 км), чуть больше R_KM
const TICK_MS = 1200;              // шаг планировщика: суммарно ~0,8 запроса/с на оба источника
const DEDUP_MS = 600000, GROUND_MEMORY_MS = 150000;
const RATE_KEEP = 25 * 60 * 1000, RATE_WINDOW = 15 * 60 * 1000, RATE_HALF = 5 * 60 * 1000;
const WARM_MS = 6 * 60 * 1000;     // сколько слушать аэропорт, прежде чем верить оценке
const FOCUS_MS = 150000;
const UA = "randomhost.online bets (+https://randomhost.online; ADS-B takeoff counter, <=1 req/s per source)";

// elev — высота аэродрома над уровнем моря, фт (alt_baro отсчитывается от уровня моря)
const AIRPORTS = {
  LHR: { lat: 51.4706, lon: -0.4619, elev: 83 },   FRA: { lat: 50.0333, lon: 8.5706, elev: 364 },
  AMS: { lat: 52.3086, lon: 4.7639, elev: -11 },   CDG: { lat: 49.0097, lon: 2.5479, elev: 392 },
  MAD: { lat: 40.4936, lon: -3.5668, elev: 2000 }, BCN: { lat: 41.2971, lon: 2.0785, elev: 12 },
  ATL: { lat: 33.6367, lon: -84.4281, elev: 1026 }, ORD: { lat: 41.9786, lon: -87.9048, elev: 672 },
  DFW: { lat: 32.8968, lon: -97.038, elev: 607 },  DEN: { lat: 39.8561, lon: -104.6737, elev: 5434 },
  LAX: { lat: 33.9425, lon: -118.4081, elev: 128 },
};
// Измерение 18.10.2026 (20 мин, 16 аэропортов, взлётов/мин): LHR .85, LAX .85, DEN .85, DFW .85, ORD .70, ATL .65,
// MAD .50, BCN .50, CDG .40, AMS .40, JFK .30, FCO .30, FRA .25, MUC .25, IST .20, DXB .05 — то есть у JFK/FCO/FRA/MUC и
// особенно IST/DXB ADS-B почти не слышит самолёты у земли (или не видит взлёты), поэтому DXB/IST, JFK, MUC, FCO из списка убраны,
// FRA оставлен только в паре с LHR на случай, если вечером/днём покрытие лучше.
// В дуэль идёт только пара, прошедшая duelOk по свежей λ (|μ|≤0,6σ, не вдвое неравные, суммарно ≥3 взлётов за окно)
const PAIRS = [["LHR", "FRA"], ["LHR", "AMS"], ["AMS", "CDG"], ["LHR", "CDG"], ["MAD", "BCN"], ["ATL", "ORD"], ["ATL", "DFW"], ["DFW", "LAX"], ["DEN", "LAX"], ["DEN", "DFW"], ["ORD", "DFW"], ["LHR", "LAX"]];
const SOURCES = [
  { id: "adsb.lol", gap: 5000, url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { id: "adsb.fi", gap: 2400, url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dl = (lat2 - lat1) * r, dn = (lon2 - lon1) * r;
  const a = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dn / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// Разбор одного ответа API: возвращает список взлётов, обновляя состояние аэропорта st (Map hex → запись).
// Чистая функция от (ответ, время) — именно её гоняют тесты на фикстурах.
function detect(ap, resp, t, st) {
  const list = (resp && (resp.ac || resp.aircraft)) || [];
  const A = AIRPORTS[ap];
  const out = [];
  for (const a of list) {
    if (!a || !a.hex || typeof a.lat !== "number" || typeof a.lon !== "number") continue;
    if (a.category === "A7") continue;                                     // вертолёты
    if (haversineKm(A.lat, A.lon, a.lat, a.lon) > R_KM) continue;
    const hex = String(a.hex).toLowerCase();
    let rec = st.get(hex);
    if (!rec) { rec = { seen: t, g: 0, air: 0, lastAlt: null, counted: 0 }; st.set(hex, rec); rec.fresh = true; }
    const alt = a.alt_baro, gs = typeof a.gs === "number" ? a.gs : null;
    if (alt === "ground") { rec.g = t; rec.fresh = false; rec.seen = t; continue; }
    if (typeof alt !== "number") continue;
    const agl = alt - A.elev;
    const rate = typeof a.baro_rate === "number" ? a.baro_rate : typeof a.geom_rate === "number" ? a.geom_rate : null;
    const grew = rec.lastAlt != null && alt > rec.lastAlt + 50;
    let kind = null;
    if (!rec.counted || t - rec.counted > DEDUP_MS) {
      if (rec.g && t - rec.g <= GROUND_MEMORY_MS && agl < 3000 && gs != null && gs >= 90 && ((rate != null && rate >= 300) || grew)) kind = "ground";
      else if (rec.fresh && !rec.g && !rec.air && agl > 0 && agl < 2000 && gs != null && gs >= 110 && rate != null && rate >= 700) kind = "climb";
    }
    if (kind) {
      rec.counted = t;
      out.push({ t, ap, hex, flight: String(a.flight || a.r || hex).trim() || hex, kind });
    }
    rec.air = t; rec.lastAlt = alt; rec.seen = t; rec.fresh = false;
  }
  return out;
}

function create(d) {
  const deps = withDefaults(d);
  const codes = [...new Set(PAIRS.flat())];
  const rates = {}, states = {}, since = {}, lastOk = {};
  for (const c of codes) { rates[c] = new RateTracker({ keep: RATE_KEEP }); states[c] = new Map(); since[c] = 0; lastOk[c] = 0; }
  const src = SOURCES.map((s) => ({ ...s, last: 0, busy: false, fails: 0, downs: 0, downUntil: 0, okAt: 0 }));
  const listeners = new Set();
  let timer = null, started = false, k = 0, lastAt = 0, total = { ground: 0, climb: 0 };
  // Частый опрос выбранных пар: ключ «A-B» → { pair, until }. Пар может быть несколько (по одной на комнату),
  // поэтому это не одна глобальная пара: истёкшие записи удаляются, опрос идёт по аэропортам всех живых пар.
  const focus = new Map();
  const refs = new Map();                             // «A-B» → число идущих begin() с этой парой
  let lastPrepared = null;
  const hist = [];                                    // дневник для отладки измерения: { t, ap, kind }

  function onEvents(evs) {
    for (const e of evs) {
      rates[e.ap].add(e.t);
      total[e.kind]++;
      hist.push(e); if (hist.length > 2000) hist.shift();
      for (const f of listeners) f(e);
    }
  }

  async function poll(s, ap) {
    s.busy = true; s.last = deps.now();
    let ctrl = null, to = null;
    try {
      if (typeof AbortController === "function") { ctrl = new AbortController(); to = deps.setTimeout(() => ctrl.abort(), 8000); }
      const A = AIRPORTS[ap];
      const res = await deps.fetch(s.url(A.lat, A.lon, QUERY_NM), { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl ? ctrl.signal : undefined });
      if (res.status === 429) {                              // нас просят отстать: отдых по Retry-After (иначе 2, 4… до 10 минут)
        const ra = res.headers && res.headers.get ? +res.headers.get("retry-after") : 0;
        s.downUntil = deps.now() + (ra > 0 ? Math.min(600000, ra * 1000) : Math.min(600000, 120000 * 2 ** s.downs));
        s.downs++; s.fails = 0;
        throw new Error("HTTP 429");
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.json();
      if (!body || !(Array.isArray(body.ac) || Array.isArray(body.aircraft))) throw new Error("нет списка судов");
      const t = deps.now();
      if (!since[ap]) since[ap] = t;
      lastOk[ap] = t; lastAt = t; s.okAt = t; s.fails = 0; s.downs = 0;
      onEvents(detect(ap, body, t, states[ap]));
    } catch (e) {
      deps.log(`[airport] ${s.id} ${ap}: ${e.message}`);
      if (e.message !== "HTTP 429") s.fails++;
      if (s.fails >= 3) { s.downUntil = deps.now() + Math.min(600000, 60000 * 2 ** s.downs); s.downs++; s.fails = 0; }   // отдых 1, 2, 4… до 10 минут
    } finally {
      if (to != null) deps.clearTimeout(to);
      s.busy = false;
    }
  }

  function tick() {
    const now = deps.now();
    for (const [key, f] of focus) if (now > f.until) focus.delete(key);
    const usable = src.filter((s) => !s.busy && s.downUntil <= now && now - s.last >= s.gap).sort((a, b) => a.last - b.last);
    if (!usable.length) return;
    const fl = focus.size ? [...new Set([...focus.values()].flatMap((f) => f.pair))] : null;
    const ap = fl ? fl[k % fl.length] : codes[k % codes.length];
    k++;
    poll(usable[0], ap);
    // иногда чистим память о судах (раз в ~сотню запросов)
    if (k % 100 === 0) for (const c of codes) for (const [h, r] of states[c]) if (now - r.seen > DEDUP_MS) states[c].delete(h);
  }

  const fresh = (c, now) => lastOk[c] && now - lastOk[c] < 90000;
  const warm = (c, now) => since[c] && now - since[c] >= WARM_MS && fresh(c, now);
  const lam = (c, now) => rates[c].rate(now, { windowMs: RATE_WINDOW, halfMs: RATE_HALF, since: since[c] });

  const pairKey = (A, B) => `${A}-${B}`;
  function setFocus(A, B, until) {
    const key = pairKey(A, B), f = focus.get(key);
    focus.set(key, { pair: [A, B], until: f ? Math.max(f.until, until) : until });
  }

  // почему prepare вернул null
  function why() {
    const now = deps.now();
    if (!(lastAt > 0 && now - lastAt < 30000)) return "down";
    return PAIRS.some(([a, b]) => warm(a, now) && warm(b, now)) ? "no_pair" : "warming";
  }

  function prepare() {
    const now = deps.now();
    const cands = [];
    for (const [a, b] of PAIRS) {
      if (!warm(a, now) || !warm(b, now)) continue;
      const la = lam(a, now), lb = lam(b, now);
      if (!duelOk(la, lb, T_SEC, PHI_AIRPORT, { minTotal: 3 })) continue;
      const ev = live.duel({ lamA: la, lamB: lb, T: T_SEC, phi: PHI_AIRPORT });
      const ids = ev.markets.map((m) => m.id);
      if (!ids.includes("A") || !ids.includes("B")) continue;
      cands.push({ a, b, la, lb });
    }
    if (!cands.length) return null;
    const c = cands[deps.rnd(cands.length)];
    const flip = deps.rnd(2) === 1;                     // сторона на табло случайна
    const [A, B, la, lb] = flip ? [c.b, c.a, c.lb, c.la] : [c.a, c.b, c.la, c.lb];
    const input = { lamA: round(la, 5), lamB: round(lb, 5), T: T_SEC, phi: PHI_AIRPORT };
    const meta = { labels: { A: `✈ ${A}`, B: `✈ ${B}` }, skin: `${A}-${B}` };
    lastPrepared = { A, B, input };
    setFocus(A, B, now + FOCUS_MS);                    // с этого момента эту пару опрашиваем чаще
    return { input, meta };
  }

  function begin(type, opts) {
    let A, B;
    // пара — из meta события (переживает рестарт и две комнаты); lastPrepared — лишь запасной вариант без skin
    const skin = (opts.meta && opts.meta.skin) || opts.skin;
    const m = /^([A-Z]{3})-([A-Z]{3})$/.exec(skin || "");
    if (m && AIRPORTS[m[1]] && AIRPORTS[m[2]]) { A = m[1]; B = m[2]; } else if (!skin && lastPrepared) { A = lastPrepared.A; B = lastPrepared.B; }
    if (!A) { deps.setTimeout(() => opts.onAbort && opts.onAbort("пара не подготовлена"), 0); return { cancel() {} }; }
    const closeAt = opts.closeAt, endAt = closeAt + T_SEC * 1000;
    const h = makeHandle(deps, opts, { timeoutMs: T_SEC * 1000 + 8000 });
    const myKey = pairKey(A, B);
    setFocus(A, B, endAt + 5000);
    refs.set(myKey, (refs.get(myKey) || 0) + 1);
    let nA = 0, nB = 0, lastItem = 0;
    const fn = (e) => {
      if (e.t <= closeAt || e.t > endAt) return;
      if (e.ap === A) nA++; else if (e.ap === B) nB++; else return;
      if (e.t - lastItem >= 700) { lastItem = e.t; h.live({ kind: "item", side: e.ap === A ? "a" : "b", text: `✈ ${e.ap} · ${e.flight}` }); }
    };
    listeners.add(fn);
    // счётчик ссылок: фокус на паре сворачиваем, только когда её последнее событие закончилось
    let stopped = false;
    const stopAll = () => {
      listeners.delete(fn);
      if (stopped) return;
      stopped = true;
      const left = (refs.get(myKey) || 1) - 1;
      if (left > 0) { refs.set(myKey, left); return; }
      refs.delete(myKey);
      const f = focus.get(myKey);
      if (f) f.until = Math.min(f.until, deps.now() + 1000);
    };
    // по ходу окна оба аэропорта должны отвечать, иначе нулевой счёт был бы враньём
    const alive = () => {
      const now = deps.now();
      return now - lastOk[A] < 15000 && now - lastOk[B] < 15000;
    };
    h.later(closeAt + 8000 - deps.now(), () => {
      h.every(2000, () => { if (!alive()) { stopAll(); h.abort("ADS-B источник потерян"); } });
    });
    h.everyFromClose(1500, () => h.live({ kind: "count", a: nA, b: nB }));
    h.later(endAt + 20 - deps.now(), () => {
      if (!alive()) { stopAll(); return h.abort("ADS-B источник потерян к концу окна"); }
      stopAll();
      h.live({ kind: "count", a: nA, b: nB });
      h.resolve({ nA, nB });
    });
    return { cancel: () => { stopAll(); h.cancel(); } };
  }

  return {
    types: ["airport"],
    start() { if (started) return; started = true; timer = deps.setInterval(tick, TICK_MS); },
    stop() { started = false; if (timer != null) deps.clearInterval(timer); timer = null; focus.clear(); refs.clear(); },
    status() {
      const now = deps.now();
      const ok = lastAt > 0 && now - lastAt < 30000;
      const up = src.filter((s) => s.okAt && now - s.okAt < 30000).map((s) => s.id).join("+") || "нет";
      return { ok, lastAt, note: ok ? `${up}, взлётов ${total.ground}+${total.climb}` : "ADS-B источники молчат" };
    },
    prepare, why,
    begin,
    _focus: focus,
    // для тестов и измерения
    _tick: tick, _detect: detect, _hist: hist, _lam: lam, _since: since, _rates: rates, _total: total,
  };
}

module.exports = { create, detect, AIRPORTS, PAIRS, PHI_AIRPORT, T_SEC, R_KM };
