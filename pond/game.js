/*
 * «Лягушки на кувшинках» — движок партии: кувшинки, прыжки, вытеснение, волны, цапля, мухи, неудачник.
 * Без сети и таймеров: сервер зовёт step(dt) сам. Время партии — g.t (с). Работает в Node (require) и в браузере (window.PondGame:
 * витрина на главном экране и тренировка в лобби гоняют тот же движок локально).
 * Решения принимаются по меткам времени, а не по тикам: прыжок можно «задним числом» начать на lag секунд раньше (§7.5).
 * Спека — docs/frog-pond-spec.md.
 */
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module === 'object' ? require('./physics') : root.PondPhysics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PondGame = api;
})(typeof self !== 'undefined' ? self : this, function (P) {
'use strict';

const { clamp } = P;

const DEFAULTS = Object.assign({}, P.DEFAULTS, {
  COUNTDOWN: 3,
  STAGGER: 0.25,        // разнос погружения кувшинок одной волны
  TELEGRAPH: 2.5,       // от знака беды до погружения кувшинки
  GRACE: 0.15,          // погружение обрабатывается на столько позже метки: ждём прыжки, начатые «задним числом»
  LAG_MAX: 0.15,        // предел бэкдейтинга прыжка
  WAVE_FIRST: 9,        // первая волна
  WAVE_T0: 8, WAVE_T1: 5.5, WAVE_RAMP: 60, // интервал волн 8 с → 5,5 с за минуту
  SLACK0: 0.4,          // запас кувшинок в начале: +40% к числу живых лягушек
  LETHAL_T: 45, LETHAL_BASE: 14, LETHAL_PER: 4, // «стулья» начинаются с min(LETHAL_T, BASE + PER·n) с, а не по первому падению (первый вылет бывает на 5-й секунде)         // с этой секунды волны сводят ёмкость пруда ниже числа живых
  CUT_K: 0.15,          // сколько мест убирает волна в «стульях»: max(1, round(alive*CUT_K))
  MAX_T: 90,            // после этого волна каждые 1,5 с по одному месту
  MAX_WAVE_T: 1.5,
  HERON_FIRST: 26, HERON_RAND: 4, HERON_GAP: [15, 20], HERON_WARN: 1.5, HERON_R: 52, HERON_MIN_ALIVE: 3,
  FLY_FIRST: 3, FLY_EVERY: 5, FLY_MAX: 2, FLY_T: 6,
  OFFLINE_T: 5,         // офлайн дольше — лягушка снимается (не падение)
  OFFLINE_HOLD: 0.5,    // кувшинка над офлайн-лягушкой откладывает погружение
  RETURN_GRACE: 1.5,    // вернувшейся лягушке даётся столько до погружения её кувшинки
  STOMP_GUARD: 8,       // первые секунды вытеснять нельзя: прилёт на занятый лист отскакивает назад (иначе неудачник известен на 4-й секунде)
  REACH_K: 0.9,         // волна не оставляет лягушку без достижимой свободной кувшинки: достижимо = до REACH_K * JUMP_MAX
  REACH_UNTIL: 10,      // за столько секунд до MAX_T проверка достижимости отключается (иначе «стулья» не закончить)
  STAY_T: 9,            // лист «устаёт»: кто сидит на нём дольше (с разбросом ±15%), тот его топит — на месте не отсидеться
  TIRE_WAIT: 3,         // нет свободного достижимого листа — усталый лист ждёт не дольше (дальше выбор: вытеснить соседа или упасть)
  TIRE_WARN: 2.0,       // от красной метки усталого листа до погружения
  JUMP_RATE: 0.2,       // не чаще одного прыжка за столько секунд на игрока
  TIE_EPS: 1e-6,
});

function createGame(opts) {
  opts = opts || {};
  const cfg = Object.assign({}, DEFAULTS, opts.cfg || {});
  const rng = opts.rng || Math.random;
  let seed0 = (opts.seed >>> 0) || 1;
  const lerp = (a, b, t) => a + (b - a) * t;

  const g = {
    cfg, phase: 'lobby', t: 0, cd: 0,
    R: 0, pads: [], players: [], byId: new Map(), flies: [], heron: null,
    loser: null, over: null, falls: [], events: [],
    n0: 0, seed: seed0, nextWave: 0, nextHeron: 0, nextFly: 0, waves: 0, jmax: 0,
  };
  const push = e => g.events.push(e);

  // ---------- вспомогательное ----------
  const alive = () => g.players.filter(f => f.st === 'pad' || f.st === 'air');
  const occupants = id => g.players.filter(f => f.st === 'pad' && f.pad === id);

  function slotFor(pad, f) {
    if (pad.cap === 1) return { x: pad.x, y: pad.y };
    const other = occupants(pad.id).find(o => o !== f);
    const side = other && other.x < pad.x ? 1 : -1;
    return { x: pad.x + side * pad.r * 0.45, y: pad.y };
  }

  function seat(f, pad, t) {
    f.st = 'pad'; f.pad = pad.id; f.jump = null;
    const s = slotFor(pad, f);
    f.x = s.x; f.y = s.y; f.seatedAt = t; f.readyAt = t + cfg.CROUCH;
    // разброс: ±15%; на старте (все сели одновременно) шире, чтобы не прыгали все разом
    f.tireWait = null;
    f.tireAt = t + cfg.STAY_T * (t === 0 ? 0.9 + 0.7 * rng() : 0.85 + 0.3 * rng());
    if (pad.fly && pad.fly.until > t) {
      pad.fly = null; f.boost = true;
      push({ type: 'flyGot', id: f.id, pad: pad.id, t });
    }
  }

  function fall(f, t, cause, by) {
    f.st = 'out'; f.pad = -1; f.jump = null; f.queued = null;
    f.fellAt = t; f.cause = cause; f.by = by || null;
    g.falls.push(f);
    push({ type: 'fall', id: f.id, cause, by: by || null, t, x: f.x, y: f.y });
  }

  function startJump(f, t0, ang, pow, forced, dist, back, seq, byId, rescued) {
    const wasPad = f.st === 'pad' ? g.pads[f.pad] : null;
    const boost = !forced && f.boost;
    const plan = P.jumpPlan(f.x, f.y, ang, pow, boost, g.R, cfg, dist);
    if (!forced) f.boost = false;
    f.st = 'air'; f.pad = -1;
    f.jump = Object.assign(plan, { t0, L: t0 + plan.dur, forced: !!forced, boost, back: back || 0, seq: seq || 0, by: byId || null, from: wasPad ? wasPad.id : -1 });
    f.readyAt = t0 + plan.dur;
    if (wasPad) wasPad.lastLeft = t0;
    push({ type: 'jump', id: f.id, t0, x0: plan.x0, y0: plan.y0, ang, pow: clamp(pow, 0, 1), dist: plan.dist, dur: plan.dur, boost, forced: !!forced, seq: seq || 0, rescued: !!rescued });
  }

  // ---------- приземление ----------
  function land(f) {
    const j = f.jump, L = j.L;
    const pad = P.padAt(g.pads, j.tx, j.ty, cfg);
    const shrinking = pad && pad.cause === 'shrink' && pad.sinkAt != null && pad.state === 'ok';
    const dead = !pad || pad.state === 'sunk' || (pad.sinkAt != null && L >= pad.sinkAt && !shrinking);
    if (dead) {
      const cause = pad ? (pad.cause || 'wave') : 'miss';
      f.x = j.tx; f.y = j.ty;
      return fall(f, L, j.forced ? 'stomp' : cause, j.forced ? j.by : null);
    }
    const occ = occupants(pad.id).filter(o => o !== f);
    const capEff = shrinking && L >= pad.sinkAt ? 1 : pad.cap;
    if (occ.length < capEff) {
      seat(f, pad, L);
      return push({ type: 'land', id: f.id, pad: pad.id, x: f.x, y: f.y, t: L, boost: f.boost, ta: f.tireAt });
    }
    if (j.forced) { f.x = j.tx; f.y = j.ty; return fall(f, L, 'stomp', j.by); }
    if (!occ.length) return; // (недостижимо)
    // стартовая защита: вытеснять рано — лягушка отскакивает на свою прежнюю кувшинку, если та ещё свободна
    if (L < cfg.STOMP_GUARD) {
      const home = j.from >= 0 ? g.pads[j.from] : null;
      if (home && home.state === 'ok' && !(home.sinkAt != null && L >= home.sinkAt) && occupants(home.id).filter(o => o !== f).length < home.cap) {
        seat(f, home, L);
        return push({ type: 'land', id: f.id, pad: home.id, x: f.x, y: f.y, t: L, boost: f.boost, bounce: pad.id, ta: f.tireAt });
      }
      f.x = j.tx; f.y = j.ty;
      return fall(f, L, 'miss');
    }
    // вытеснение: хозяин (кто сидит дольше) получает вынужденный прыжок по ходу прилёта
    const victim = occ.reduce((a, b) => (a.seatedAt <= b.seatedAt ? a : b));
    victim.queued = null;
    startJump(victim, L, j.ang, 0, true, cfg.JUMP_MIN * (1 + 0.5 * rng()), 0, 0, f.id);
    seat(f, pad, L);
    f.stomps++;
    push({ type: 'land', id: f.id, pad: pad.id, x: f.x, y: f.y, t: L, boost: f.boost, stomp: victim.id, ta: f.tireAt });
    push({ type: 'stomp', by: f.id, id: victim.id, pad: pad.id, t: L });
  }

  // ---------- погружение ----------
  function sinkBlocked(pad, t) {
    return occupants(pad.id).some(o => !o.online && o.offSince != null && t - o.offSince < cfg.OFFLINE_T);
  }
  function sink(pad) {
    if (pad.cause === 'shrink') return shrink(pad);
    pad.state = 'sunk'; pad.fly = null;
    push({ type: 'sunk', pad: pad.id, t: pad.sinkAt, cause: pad.cause || 'wave' });
    for (const f of occupants(pad.id)) fall(f, pad.sinkAt, pad.cause || 'wave');
  }
  // большой лист рвётся пополам: остаётся место на одну лягушку, лишняя (сидящая позже) падает
  function shrink(pad) {
    pad.cap = 1; pad.r = cfg.PAD_R; pad.big = false;
    const t = pad.sinkAt;
    pad.sinkAt = null; pad.cause = null;
    push({ type: 'shrunk', pad: pad.id, t });
    const occ = occupants(pad.id).sort((a, b) => a.seatedAt - b.seatedAt);
    for (const f of occ.slice(1)) fall(f, t, 'wave');
    for (const f of occ.slice(0, 1)) { const s = slotFor(pad, f); f.x = s.x; f.y = s.y; }
  }
  function mark(pad, sinkAt, cause) { pad.sinkAt = sinkAt; pad.cause = cause; }

  // ---------- волны, цапля, мухи ----------
  const okPads = () => g.pads.filter(p => p.state === 'ok' && p.sinkAt == null);
  // ёмкость пруда: живые листья + рвущиеся пополам (на них останется одно место)
  const capNow = () => g.pads.reduce((s, p) => s + (p.state !== 'ok' ? 0 : p.sinkAt == null ? p.cap : p.cause === 'shrink' ? 1 : 0), 0);
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // у каждой лягушки на листе p должна остаться достижимая свободная кувшинка, которую не топит эта же волна
  // В «стульях» (мест меньше, чем живых) свободной может не быть по определению: достаточно любой достижимой — на ней можно побороться (вытеснить)
  function reachOk(p, chosen, t, chairs, k) {
    if (t >= cfg.MAX_T - cfg.REACH_UNTIL || k === Infinity) return true;
    const reach = g.jmax * (k || cfg.REACH_K);
    for (const f of occupants(p.id)) {
      const ok = g.pads.some((q) => {
        if (q === p || q.state !== 'ok' || q.sinkAt != null || chosen.includes(q)) return false;
        const d = Math.hypot(q.x - f.x, q.y - f.y);
        if (d < cfg.JUMP_MIN || d > reach) return false;
        return chairs || occupants(q.id).length < q.cap;
      });
      if (!ok) return false;
    }
    return true;
  }

  // есть ли у лягушки куда уйти с усталого листа: свободная достижимая кувшинка, которую никто не топит
  function hasFreeReach(f, pad) {
    const reach = g.jmax * cfg.REACH_K;
    return g.pads.some((q) => {
      if (q === pad || q.state !== 'ok' || (q.sinkAt != null && q.cause !== 'shrink')) return false;
      const d = Math.hypot(q.x - f.x, q.y - f.y);
      return d >= cfg.JUMP_MIN && d <= reach && occupants(q.id).length < q.cap;
    });
  }
  function tire(f, t) {
    const pad = g.pads[f.pad];
    if (!pad || pad.state !== 'ok' || pad.sinkAt != null) { f.tireAt = Infinity; return; }
    const chairs = t >= Math.min(cfg.LETHAL_T, cfg.LETHAL_BASE + cfg.LETHAL_PER * g.n0);
    // до «стульев» не топим лист, с которого некуда уйти: ждём, пока освободится место
    if (!chairs && !hasFreeReach(f, pad)) {
      if (f.tireWait == null) f.tireWait = t;
      if (t - f.tireWait < cfg.TIRE_WAIT) { f.tireAt = t + 0.7; return; }
    }
    mark(pad, t + cfg.TIRE_WARN, 'wave');
    f.tireAt = Infinity;
    push({ type: 'wave', t, pads: [pad.id], shrink: [], sinkAt: pad.sinkAt, sinkAts: [pad.sinkAt], tired: f.id });
  }

  function doWave(t) {
    const n = alive().length;
    const ok = okPads();
    let cap = capNow();
    let target;
    const lethalT = Math.min(cfg.LETHAL_T, cfg.LETHAL_BASE + cfg.LETHAL_PER * g.n0); // вдвоём не ждём минуту: «стулья» раньше
    if (t >= cfg.MAX_T) target = Math.max(1, n - 1);
    else if (t >= lethalT) target = Math.max(1, n - Math.max(1, Math.round(n * cfg.CUT_K)));
    else target = n + Math.round(n * cfg.SLACK0 * (1 - clamp(t / lethalT, 0, 1)));
    const chairs = t >= lethalT;
    let chosen = [];
    // ступени: строгая достижимость → вся дальность прыжка → без проверки (если волна подряд ничего не смогла убрать; иначе партия застрянет)
    const tiers = [undefined, 1.0, g.blocked >= 2 ? Infinity : null].filter((x) => x !== null);
    let usedK;
    for (const k of tiers) {
      usedK = k;
      chosen = [];
      let capLeft = cap;
      // до «стульев» волны убирают только ПУСТЫЕ листья: случайная гибель сидящих — лотерея; давление создают усталость, вытеснения и цапля
      const pool = chairs ? ok.slice() : ok.filter((p) => !occupants(p.id).length);
      for (const p of shuffle(pool)) {
        // метки погружения чуть разнесены по времени: листья уходят каскадом, а не все на одном тике
        if (capLeft - p.cap >= target && reachOk(p, chosen, t, chairs, k)) { chosen.push(p); capLeft -= p.cap; mark(p, t + cfg.TELEGRAPH + (chosen.length - 1) * cfg.STAGGER, 'wave'); }
      }
      // позже выбранный лист мог оказаться единственным спасением для лягушки с раньше выбранного: возвращаем такие листы
      for (let again = true; again;) {
        again = false;
        for (const p of chosen) {
          if (!reachOk(p, chosen, t, chairs, k)) { chosen.splice(chosen.indexOf(p), 1); p.sinkAt = null; p.cause = null; capLeft += p.cap; again = true; break; }
        }
      }
      cap = capLeft;
      if (chosen.length || cap <= target) break;
      cap = capNow();
    }
    g.blocked = chosen.length || cap <= target ? 0 : (g.blocked || 0) + 1;
    const shrunk = [];
    if (cap > target) { // целыми листьями не добрать (остались одни большие): рвём большой пополам
      for (const p of shuffle(ok.filter(p => p.cap === 2 && !chosen.includes(p)))) {
        if (cap > target && cap - 1 >= target) { shrunk.push(p); cap -= 1; mark(p, t + cfg.TELEGRAPH + (chosen.length + shrunk.length - 1) * cfg.STAGGER, 'shrink'); }
      }
    }
    g.waves++;
    if (chosen.length || shrunk.length) push({ type: 'wave', t, pads: chosen.map(p => p.id), shrink: shrunk.map(p => p.id), sinkAt: t + cfg.TELEGRAPH, sinkAts: chosen.concat(shrunk).map(p => p.sinkAt), cap, target });
    g.nextWave = t + (t >= cfg.MAX_T ? cfg.MAX_WAVE_T : lerp(cfg.WAVE_T0, cfg.WAVE_T1, clamp(t / cfg.WAVE_RAMP, 0, 1)));
  }

  function planHeron(t) {
    const live = alive();
    if (live.length < cfg.HERON_MIN_ALIVE) { g.nextHeron = t + 3; return; }
    // самое людное место: у какой лягушки больше всего соседей рядом
    let best = [], bc = -1;
    for (const f of live) {
      const c = live.filter(o => Math.hypot(o.x - f.x, o.y - f.y) <= cfg.HERON_R * 2).length;
      if (c > bc) { bc = c; best = [f]; } else if (c === bc) best.push(f);
    }
    const c = best[Math.floor(rng() * best.length)];
    g.heron = { x: c.x, y: c.y, r: cfg.HERON_R, at: t, strikeAt: t + cfg.HERON_WARN };
    push({ type: 'heron', x: c.x, y: c.y, r: cfg.HERON_R, t, strikeAt: g.heron.strikeAt });
    g.nextHeron = Infinity;
  }
  function strikeHeron(h) {
    const hit = g.pads.filter(p => p.state === 'ok' && Math.hypot(p.x - h.x, p.y - h.y) <= h.r + 8);
    const rest = okPads().filter(p => !hit.includes(p));
    if (!rest.length && hit.length) hit.length = Math.max(0, hit.length - 1); // пруд не вычищаем до нуля
    for (const p of hit) mark(p, h.strikeAt + Math.hypot(p.x - h.x, p.y - h.y) / 400, 'heron'); // волна от центра наружу
    push({ type: 'strike', x: h.x, y: h.y, r: h.r, t: h.strikeAt, pads: hit.map(p => p.id) });
    g.heron = null;
    g.nextHeron = h.strikeAt + cfg.HERON_GAP[0] + rng() * (cfg.HERON_GAP[1] - cfg.HERON_GAP[0]);
  }

  function spawnFly(t) {
    g.flies = g.flies.filter(p => g.pads[p].fly && g.pads[p].fly.until > t);
    g.nextFly = t + cfg.FLY_EVERY;
    if (g.flies.length >= cfg.FLY_MAX) return;
    const free = okPads().filter(p => !p.fly && !occupants(p.id).length);
    if (!free.length) return;
    const p = free[Math.floor(rng() * free.length)];
    p.fly = { until: t + cfg.FLY_T };
    g.flies.push(p.id);
    push({ type: 'fly', pad: p.id, t, until: p.fly.until });
  }

  // ---------- вход игроков ----------
  g.addPlayer = function (id, name, ci) {
    if (g.byId.has(id)) return g.byId.get(id);
    const f = {
      id, name, ci: ci | 0, idx: g.players.length, inGame: false, st: g.phase === 'lobby' ? 'lobby' : 'watch', pad: -1, x: 0, y: 0, jump: null,
      readyAt: 0, seatedAt: 0, tireAt: Infinity, queued: null, boost: false, online: true, offSince: null,
      stomps: 0, jumps: 0, lastIn: -9, fellAt: null, cause: null, by: null, place: null, removed: false,
    };
    g.players.push(f); g.byId.set(id, f);
    return f;
  };
  g.removePlayer = function (id) {
    const f = g.byId.get(id);
    if (!f) return;
    if (g.phase === 'lobby' || f.st === 'watch' || f.st === 'lobby') { g.players.splice(g.players.indexOf(f), 1); g.byId.delete(id); return; }
    if (f.st === 'pad' || f.st === 'air') drop(f, g.t);
    f.left = true; // уже выбывший остаётся в итогах до следующей партии
  };
  function drop(f, t) {
    f.st = 'removed'; f.removed = true; f.pad = -1; f.jump = null; f.queued = null;
    push({ type: 'removed', id: f.id, t });
  }
  g.setOnline = function (id, on) {
    const f = g.byId.get(id);
    if (!f || f.online === on) return;
    f.online = on; f.offSince = on ? null : g.t;
    push({ type: on ? 'online' : 'offline', id, t: g.t });
    if (on && f.st === 'pad') { // вернулся: кувшинке под ним даём время
      const pad = g.pads[f.pad];
      if (pad && pad.sinkAt != null && pad.state === 'ok') pad.sinkAt = Math.max(pad.sinkAt, g.t + cfg.RETURN_GRACE);
    }
  };

  // ---------- старт ----------
  g.start = function () {
    if (g.phase !== 'lobby' || g.players.length < 2) return false;
    g.started = true;
    g.n0 = g.players.length;
    const lay = P.makeLayout(g.seed, g.players.length, cfg);
    g.R = lay.R; g.jmax = P.jumpMax(g.R, cfg);
    g.pads = lay.pads.map(p => Object.assign({ state: 'ok', sinkAt: null, cause: null, fly: null, lastLeft: -9 }, p));
    // старт: самые дальние друг от друга обычные кувшинки
    const normal = g.pads.filter(p => !p.big);
    const picked = [];
    let cur = normal.reduce((a, b) => (Math.hypot(a.x, a.y) >= Math.hypot(b.x, b.y) ? a : b));
    while (picked.length < g.players.length && normal.length) {
      picked.push(cur);
      normal.splice(normal.indexOf(cur), 1);
      if (!normal.length) break;
      cur = normal.reduce((a, b) => (minD(a, picked) >= minD(b, picked) ? a : b));
    }
    const order = shuffle(g.players.slice());
    order.forEach((f, i) => { const pad = picked[i % picked.length]; f.st = 'pad'; f.inGame = true; seat(f, pad, 0); f.readyAt = 0; });
    g.phase = 'countdown'; g.cd = cfg.COUNTDOWN; g.t = 0;
    g.nextWave = cfg.WAVE_FIRST;
    g.nextHeron = cfg.HERON_FIRST + rng() * cfg.HERON_RAND;
    g.nextFly = cfg.FLY_FIRST;
    push({ type: 'start', seed: g.seed, n: g.players.length, R: g.R });
    return true;
  };
  function minD(a, list) { let m = Infinity; for (const b of list) m = Math.min(m, Math.hypot(a.x - b.x, a.y - b.y)); return m; }

  // ---------- ввод ----------
  // msg: {ang, pow, seq}; lag — оценка задержки одного конца, с (сервер: rtt/2)
  g.input = function (id, msg, lag) {
    const f = g.byId.get(id);
    if (!f || g.phase !== 'fight') return false;
    if (f.st !== 'pad' && f.st !== 'air') return false;
    if (!Number.isFinite(msg.ang) || !Number.isFinite(msg.pow)) return false;
    if (g.t - f.lastIn < cfg.JUMP_RATE) return false;
    const pow = clamp(msg.pow, 0, 1);
    const ang = msg.ang;
    f.lastIn = g.t;
    const back = clamp(lag || 0, 0, cfg.LAG_MAX);
    if (f.st === 'pad' && g.t >= f.readyAt) {
      f.queued = null;
      f.jumps++;
      const t0 = Math.max(g.t - back, f.readyAt, f.seatedAt);
      const cur = g.pads[f.pad];
      // метка погружения (с учётом лага) уже позади: поздно, кувшинка утонет под ней
      if (cur && cur.sinkAt != null && cur.state === 'ok' && cur.cause !== 'shrink' && t0 >= cur.sinkAt) { f.jumps--; return false; }
      // спрыгнул с тонущей кувшинки, когда по часам сервера метка уже прошла, а по часам игрока — нет
      const rescued = !!(cur && cur.sinkAt != null && cur.state === 'ok' && t0 < cur.sinkAt && g.t >= cur.sinkAt);
      startJump(f, t0, ang, pow, false, null, back, msg.seq, null, rescued);
    } else {
      f.queued = { ang, pow, seq: msg.seq || 0, back }; // один шаг вперёд
    }
    return true;
  };

  // ---------- шаг ----------
  // Очередь событий считается заново на каждой итерации: людей мало, зато порядок строго по времени.
  function nextDue(tNew) {
    let best = null;
    const take = (time, kind, ref, order) => {
      if (time > tNew) return;
      if (!best || time < best.time - cfg.TIE_EPS || (Math.abs(time - best.time) <= cfg.TIE_EPS && order < best.order)) best = { time, kind, ref, order };
    };
    for (const f of g.players) {
      if (f.st === 'air') take(f.jump.L, 'land', f, 1 + f.idx * 1e-3);
      else if (f.st === 'pad' && f.queued) take(f.readyAt, 'queued', f, 2);
      if (f.st === 'pad' && f.online && f.tireAt !== Infinity) take(f.tireAt, 'tire', f, 2.2);
      if ((f.st === 'pad' || f.st === 'air') && !f.online && f.offSince != null) take(f.offSince + cfg.OFFLINE_T, 'remove', f, 0.5);
    }
    for (const p of g.pads) {
      if (p.state === 'ok' && p.sinkAt != null && p.sinkAt + cfg.GRACE <= tNew) take(p.sinkAt, 'sink', p, 0);
    }
    take(g.nextWave, 'wave', null, 3);
    take(g.nextFly, 'fly', null, 4);
    if (g.heron) take(g.heron.strikeAt, 'strike', g.heron, 2.5);
    else if (g.nextHeron !== Infinity) take(g.nextHeron, 'heronPlan', null, 5);
    return best;
  }

  function finish(t) {
    checkLoser(true);
    const left = alive();
    g.phase = 'over';
    const out = g.falls.filter(f => f.fellAt != null);
    // места: живой — 1, дальше по времени падения с конца; одновременные делят место
    const sorted = out.slice().sort((a, b) => b.fellAt - a.fellAt);
    sorted.forEach((f, i) => {
      if (i > 0 && Math.abs(f.fellAt - sorted[i - 1].fellAt) <= cfg.TIE_EPS) f.place = sorted[i - 1].place;
      else f.place = i + (left.length ? 2 : 1);
    });
    left.forEach(f => { f.place = 1; });
    let kings = left.map(f => f.id), draw = false;
    if (!left.length && sorted.length) {
      kings = sorted.filter(f => f.place === 1).map(f => f.id);
      draw = kings.length > 1;
      if (draw) kings = []; // ничья: короны нет
    }
    let lot = false;
    if (!g.loser) { // остался один без единого падения: жребий среди снятых
      const removed = g.players.filter(f => f.removed);
      if (removed.length) { g.loser = removed[Math.floor(rng() * removed.length)].id; lot = true; push({ type: 'loser', id: g.loser, lot: true, t }); }
    }
    g.over = {
      t, kings, draw, loser: g.loser, lot: !!(lot || g.loserLot),
      players: g.players.map(f => ({ id: f.id, name: f.name, place: f.place, stomps: f.stomps, jumps: f.jumps, cause: f.cause, by: f.by, removed: f.removed, fellAt: f.fellAt })),
    };
    push({ type: 'over', ...g.over });
  }

  // Неудачник назначается чуть позже первого падения: падение от погружения обрабатывается на GRACE позже своей метки,
  // и «более раннее» падение может ещё прийти. При конце партии назначаем сразу (force).
  function checkLoser(force) {
    if (g.loser || !g.falls.length) return;
    const first = Math.min(...g.falls.map(f => f.fellAt));
    if (!force && g.t < first + cfg.GRACE + 0.05) return;
    let c = g.falls.filter(f => f.fellAt - first <= cfg.TIE_EPS);
    let lot = false;
    if (c.length > 1) {
      const m = Math.min(...c.map(f => f.stomps));
      c = c.filter(f => f.stomps === m);
      if (c.length > 1) { // потом тот, кто дольше сидел на месте («засиделся»)
        const e = Math.min(...c.map(f => f.seatedAt));
        c = c.filter(f => f.seatedAt - e <= cfg.TIE_EPS);
        if (c.length > 1) lot = true;
      }
    }
    const pick = c[Math.floor(rng() * c.length)];
    g.loser = pick.id; g.loserLot = lot;
    push({ type: 'loser', id: pick.id, lot, t: first });
  }

  // единственный выживший ещё в полёте: ждём его приземления (сядет — царь, упадёт — последний упавший)
  const soleInAir = () => { const a = alive(); return a.length === 1 && a[0].st === 'air'; };

  g.step = function (dt) {
    if (g.phase === 'countdown') {
      g.cd -= dt;
      if (g.cd <= 0) { g.phase = 'fight'; g.t = 0; push({ type: 'go' }); }
      return;
    }
    if (g.phase !== 'fight') return;
    const tNew = g.t + dt;
    let guard = 0;
    for (;;) {
      const it = nextDue(tNew);
      if (!it || guard++ > 5000) break;
      const { kind, ref, time } = it;
      if (kind === 'land') land(ref);
      else if (kind === 'queued') {
        const q = ref.queued; ref.queued = null; ref.jumps++;
        startJump(ref, Math.max(ref.readyAt, time), q.ang, q.pow, false, null, 0, q.seq);
      } else if (kind === 'remove') drop(ref, time);
      else if (kind === 'tire') tire(ref, time);
      else if (kind === 'sink') {
        if (sinkBlocked(ref, tNew)) ref.sinkAt = tNew + cfg.OFFLINE_HOLD - cfg.GRACE; // ждём вернувшегося или снятого
        else sink(ref);
      }
      else if (kind === 'wave') doWave(time);
      else if (kind === 'fly') spawnFly(time);
      else if (kind === 'heronPlan') planHeron(time);
      else if (kind === 'strike') strikeHeron(ref);
      // конец: остался один (если в ту же секунду ничего не случится)
      if (alive().length <= 1 && !soleInAir()) {
        const more = nextDue(Math.min(tNew, time + cfg.GRACE + cfg.TIE_EPS)); // погружения обрабатываются на GRACE позже метки: одновременные не пропускаем
        if (!more) { g.t = time; checkLoser(); return finish(time); }
      }
    }
    g.t = tNew;
    checkLoser();
    if (alive().length <= 1 && !soleInAir()) finish(g.t);
  };

  // ---------- между партиями ----------
  g.toLobby = function () {
    if (g.phase !== 'over') return false;
    g.players = g.players.filter(f => !f.left);
    g.byId.clear();
    for (const f of g.players) {
      g.byId.set(f.id, f);
      Object.assign(f, { st: 'lobby', pad: -1, jump: null, queued: null, boost: false, readyAt: 0, seatedAt: 0, stomps: 0, jumps: 0, lastIn: -9, fellAt: null, cause: null, by: null, place: null, removed: false, inGame: false, left: false });
      if (f.online) f.offSince = null;
    }
    g.players.forEach((f, i) => { f.idx = i; });
    g.phase = 'lobby'; g.t = 0; g.cd = 0; g.pads = []; g.flies = []; g.heron = null;
    g.loser = null; g.loserLot = false; g.over = null; g.falls = []; g.waves = 0;
    g.seed = Math.floor(rng() * 4294967296) >>> 0;
    return true;
  };
  // часы партии для синхронизации с клиентами: до «go» отрицательные
  g.clock = () => (g.phase === 'countdown' ? -g.cd : g.phase === 'lobby' ? 0 : g.t);
  g.inPlay = () => g.players.filter(f => f.inGame);

  // ---------- снимок и события ----------
  g.drainEvents = function () { const e = g.events; g.events = []; return e; };
  g.snapshot = function () {
    return {
      ph: g.phase, t: g.clock(), seed: g.seed, n0: g.n0, R: g.R, loser: g.loser,
      pads: g.pads.map(p => [p.id, p.state, p.sinkAt, p.cause, p.fly ? p.fly.until : 0, p.cap]),
      frogs: g.players.map(f => ({
        id: f.id, name: f.name, ci: f.ci, ig: f.inGame ? 1 : 0, st: f.st, pad: f.pad, x: f.x, y: f.y, boost: f.boost, on: f.online,
        j: f.jump ? { t0: f.jump.t0, x0: f.jump.x0, y0: f.jump.y0, ang: f.jump.ang, dist: f.jump.dist, dur: f.jump.dur, forced: f.jump.forced } : null,
        rd: f.readyAt, s: f.stomps, ta: f.tireAt === Infinity ? 0 : f.tireAt,
      })),
      heron: g.heron,
      over: g.over,
    };
  };
  g.aliveCount = () => alive().length;
  g.padCap = () => okPads().reduce((s, p) => s + p.cap, 0);
  return g;
}

return { createGame, DEFAULTS, P };
});
