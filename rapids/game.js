/*
 * «Утиный сплав» — движок заплыва: русло, препятствия, утки, руль, правила.
 * Без сети и таймеров: сервер зовёт step(dt) сам. Работает и в Node (require), и в браузере (window.RapidsGame).
 * Русло и препятствия строятся из одного сида (makeCourse) — клиент собирает ту же реку, что и сервер.
 * Спека — duck-rapids-spec.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RapidsGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function smooth01(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Всё, что подбирается на стенде (sim.js), — здесь.
  const DEFAULTS = {
    DR: 12,              // радиус утки
    FLOW: 170,           // скорость течения посередине русла, ед/с
    BANK_K: 0.45,        // у самого берега течение в столько раз медленнее середины
    STREAM_K: 1.5,       // быстрая струя ускоряет во столько раз
    LILY_K: 0.5,         // кувшинки тормозят
    RELAX: 1.6,          // как быстро утка подхватывает течение
    STEER: 230,          // разгон руля поперёк течения, ед/с²; предел поперечной скорости ≈ STEER/RELAX
    POOL_STEER: 0.55,    // в воронке водоворота руль слабее
    LOG_SLIDE: 200,      // снос вдоль бревна и с макушки камня, ед/с²: руль к берегу его пересиливает, но отпустил — и утку вынесет
    BANK_RAMP: [100, 600], // береговое замедление включается плавно за шлюзом: иначе крайние дорожки старта проигрывали (плейтест 04.10)
    CAP_T: 1.4,          // сколько крутит пойманную утку (потеря времени ≈1.2 с)
    CAP_CD: 3,           // после выхода тот же водоворот не ловит столько секунд
    REST: 0.75,          // упругость столкновения уток
    COUNTDOWN: 3,
    RACE_T: 55,          // предел заплыва: кто не доплыл — по пройденному пути
    START_GUARD: 1.2,    // первые секунды после старта утки не толкаются (все стоят плотно у шлюза)
    OFFLINE_T: 0,        // офлайн не снимает с заплыва: утку несёт течение
    LEN: 4300,           // от шлюза до финиша
  };

  const SUB = 1 / 60;
  const WORLD_W = 440;
  const GATE_Y = 250;

  // ===================================================================
  // Русло
  // ===================================================================
  function makeCourse(seed, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    const rnd = mulberry32(seed >>> 0);
    const rr = (a, b) => a + (b - a) * rnd();
    const DR = cfg.DR;
    const FINISH_Y = GATE_Y + cfg.LEN;
    const CLEAN = 420;
    const WORLD_H = FINISH_Y + 410;
    const RP = [rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU];

    function wiggle(y) {
      return smooth01(GATE_Y - 40, GATE_Y + 240, y) * (1 - smooth01(FINISH_Y - CLEAN - 160, FINISH_Y - CLEAN + 20, y));
    }
    function riverCx(y) {
      return WORLD_W / 2 + wiggle(y) * (40 * Math.sin(y / 260 + RP[0]) + 16 * Math.sin(y / 97 + RP[1]));
    }
    function riverHw(y) {
      let hw = 128 + 14 * Math.sin(y / 190 + RP[2]) * wiggle(y);
      hw += 30 * (1 - smooth01(GATE_Y - 30, GATE_Y + 110, y));
      hw += 70 * smooth01(FINISH_Y + 50, FINISH_Y + 250, y);
      hw *= Math.sqrt(smooth01(-30, 90, y)) * Math.sqrt(1 - smooth01(WORLD_H - 190, WORLD_H - 30, y));
      return hw;
    }
    function riverDir(y) {
      const dx = (riverCx(y + 3) - riverCx(y - 3)) / 6;
      const l = Math.hypot(dx, 1);
      return [dx / l, 1 / l];
    }
    function flowMul(y) {
      return 1 - 0.88 * smooth01(FINISH_Y + 40, FINISH_Y + 260, y);
    }

    const c = {
      seed, cfg, WORLD_W, WORLD_H, GATE_Y, FINISH_Y, CLEAN, RP,
      riverCx, riverHw, riverDir, flowMul, wiggle,
      rocks: [], logs: [], pools: [], lilies: [], streams: [], slots: [],
    };

    function makeRock(x, y, r) {
      const pts = [];
      const rot = rnd() * TAU;
      for (let i = 0; i < 9; i++) {
        const a = rot + (i / 9) * TAU, k = rr(0.8, 1.08);
        pts.push([Math.cos(a) * r * k, Math.sin(a) * r * k]);
      }
      const moss = [];
      for (let i = 0; i < 3; i++) moss.push([rr(-0.45, 0.3) * r, rr(-0.5, 0.25) * r, rr(0.16, 0.3) * r]);
      return { x, y, r, pts, moss, tone: rr(-12, 12) };
    }

    function place(kind, y) {
      const cx = riverCx(y), hw = riverHw(y);
      c.slots.push({ kind, y });
      if (kind === 'rocks') {
        // гряда поперёк русла: проходы между камнями есть всегда, но не по прямой
        const count = rnd() < 0.5 ? 3 : 4;
        const placed = [];
        for (let tries = 0; placed.length < count && tries < 120; tries++) {
          const r = rr(14, 24);
          const yy = y + rr(-70, 70);
          // между камнем и берегом всегда проход: иначе у берега карман, из которого против течения не выплыть
          const lim = riverHw(yy) - r - DR * 2 - 14;
          if (lim <= 0) continue;
          const x = riverCx(yy) + rr(-lim, lim);
          if (placed.some(o => Math.hypot(o.x - x, o.y - yy) < o.r + r + DR * 2 + 12)) continue;
          placed.push(makeRock(x, yy, r));
        }
        c.rocks.push(...placed);
        return;
      }
      if (kind === 'log') {
        const side = rnd() < 0.5 ? -1 : 1;
        const a = rr(0.25, 0.5);
        let len = hw * rr(1.05, 1.3);
        const x1 = cx + side * (hw + 12), y1 = y;
        let x2, y2;
        for (let i = 0; i < 14; i++) {
          x2 = x1 - side * Math.cos(a) * len;
          y2 = y1 + Math.sin(a) * len;
          const farBank = riverCx(y2) - side * riverHw(y2);
          if (Math.abs(x2 - farBank) >= DR * 2 + 30) break;
          len *= 0.93;
        }
        const twigs = [];
        for (let i = 0; i < 2; i++) twigs.push({ t: rr(0.3, 0.8), a: (rnd() < 0.5 ? -1 : 1) * rr(0.6, 1.0), l: rr(12, 20) });
        c.logs.push({ x1, y1, x2, y2, r: 9, twigs });
        return;
      }
      if (kind === 'whirl') {
        c.pools.push({ x: cx + rr(-0.35, 0.35) * hw, y, r: rr(44, 52), dir: rnd() < 0.5 ? -1 : 1 });
        return;
      }
      if (kind === 'lily') {
        const side = rnd() < 0.5 ? -1 : 1;
        const ccx = cx + side * hw * rr(0.1, 0.4);
        const R = rr(60, 76);
        const pads = [];
        for (let tries = 0; pads.length < 12 && tries < 120; tries++) {
          const a = rnd() * TAU, dist = Math.sqrt(rnd()) * R;
          const px = ccx + Math.cos(a) * dist, py = y + Math.sin(a) * dist;
          const pr = rr(10, 16);
          if (Math.abs(px - riverCx(py)) + pr > riverHw(py) - 2) continue;
          if (pads.some(p => Math.hypot(p.x - px, p.y - py) < p.r + pr - 3)) continue;
          pads.push({ x: px, y: py, r: pr, rot: rnd() * TAU, flower: rnd() < 0.25 });
        }
        const frogPad = pads.length ? Math.floor(rnd() * pads.length) : -1;
        if (frogPad >= 0) pads[frogPad].flower = false;
        c.lilies.push({ x: ccx, y, r: R, pads, frogPad });
      }
    }

    // мешок препятствий: подряд одно и то же не идёт
    const base = ['rocks', 'log', 'whirl', 'lily', 'rocks', 'log', 'whirl', 'rocks'];
    let bag = [], prev = null;
    const take = () => {
      if (!bag.length) {
        bag = base.slice();
        for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
      }
      let i = bag.findIndex(k => k !== prev);
      if (i < 0) i = 0;
      prev = bag.splice(i, 1)[0];
      return prev;
    };
    let y = GATE_Y + 300;
    while (y < FINISH_Y - CLEAN - 40) {
      place(take(), y);
      y += rr(200, 260);
    }

    // Быстрые струи: полоса вдоль русла, смещённая к одному берегу. Срезают время, но ведут мимо препятствий впритык
    let sy = GATE_Y + 420;
    while (sy < FINISH_Y - CLEAN - 200) {
      const len = rr(320, 520);
      const lat = (rnd() < 0.5 ? -1 : 1) * rr(0.35, 0.7);
      const lat2 = clamp(lat + rr(-0.35, 0.35), -0.75, 0.75);
      c.streams.push({ y0: sy, y1: sy + len, lat, lat2, w: 26 });
      sy += len + rr(280, 520);
    }

    // смещение струи поперёк русла в точке y (доля полуширины), или null
    c.streamAt = function (x, yy) {
      let best = 0;
      for (const s of c.streams) {
        if (yy < s.y0 - 40 || yy > s.y1 + 40) continue;
        const k = clamp((yy - s.y0) / (s.y1 - s.y0), 0, 1);
        const sx = riverCx(yy) + lerp(s.lat, s.lat2, k) * riverHw(yy);
        const fade = smooth01(s.y0 - 40, s.y0 + 60, yy) * (1 - smooth01(s.y1 - 60, s.y1 + 40, yy));
        const d = Math.abs(x - sx);
        const v = (1 - smooth01(s.w * 0.6, s.w * 1.4, d)) * fade;
        if (v > best) best = v;
      }
      return best;
    };
    c.streamX = function (s, yy) {
      const k = clamp((yy - s.y0) / (s.y1 - s.y0), 0, 1);
      return riverCx(yy) + lerp(s.lat, s.lat2, k) * riverHw(yy);
    };

    c.overLily = function (x, yy) {
      for (const L of c.lilies) {
        if (Math.abs(L.y - yy) > L.r + 24) continue;
        for (const p of L.pads) if (Math.hypot(p.x - x, p.y - yy) < p.r + DR * 0.6) return true;
      }
      return false;
    };

    // скорость воды в точке: [vx, vy, множитель]
    c.water = function (x, yy) {
      const cx = riverCx(yy), hw = Math.max(20, riverHw(yy));
      const lat = clamp((x - cx) / hw, -1, 1);
      const [tx, ty] = riverDir(yy);
      const bank = smooth01(GATE_Y + cfg.BANK_RAMP[0], GATE_Y + cfg.BANK_RAMP[1], yy);
      let k = (1 - (1 - cfg.BANK_K) * lat * lat * bank) * flowMul(yy);
      if (yy > GATE_Y - 10 && yy < FINISH_Y) k *= 1 + (cfg.STREAM_K - 1) * c.streamAt(x, yy);
      if (c.overLily(x, yy)) k *= cfg.LILY_K;
      const sp = cfg.FLOW * k;
      return [tx * sp, ty * sp, k];
    };

    return c;
  }

  // ===================================================================
  // Одна утка без соседей и водоворотов: течение, руль, камни, брёвна, берега.
  // Общая для сервера и клиента, который предсказывает свою утку, не дожидаясь ответа.
  // gateOpen=false — шлюз закрыт: утки в заводи; controlled=false — руль не действует.
  // Возвращает удар о препятствие: null | {kind, power, x, y}
  // ===================================================================
  function moveDuck(d, c, cfg, dt, steer, controlled, gateOpen) {
    const [wx, wy] = c.water(d.x, d.y);
    const calm = !gateOpen && d.y < GATE_Y + 20;
    const fx = calm ? wx * 0.12 : wx, fy = calm ? wy * 0.12 : wy;
    const [tx, ty] = c.riverDir(d.y);
    let s = controlled ? clamp(steer, -1, 1) : 0;
    if (d.inPool) s *= cfg.POOL_STEER;
    // руль — поперёк течения: вправо по ходу реки (течение вниз, «право» на экране — +x)
    const nx = ty, ny = -tx;
    const ax = nx * s * cfg.STEER, ay = ny * s * cfg.STEER;
    d.vx += ((fx - d.vx) * cfg.RELAX + ax) * dt;
    d.vy += ((fy - d.vy) * cfg.RELAX + ay) * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    // нос по ходу
    const sp = Math.hypot(d.vx, d.vy);
    if (sp > 10) {
      let da = Math.atan2(d.vy, d.vx) - d.ang;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      d.ang += da * Math.min(1, dt * 4 * Math.min(1, sp / 60));
    }
    d.ang += d.spin * dt;
    d.spin *= Math.exp(-dt * 2.2);
    const hit = collideStatic(d, c, cfg);
    bankAndGate(d, c, cfg, gateOpen);
    return hit;
  }

  function pushOut(d, px, py, minDist, kind) {
    const dx = d.x - px, dy = d.y - py;
    const dist = Math.hypot(dx, dy);
    if (dist >= minDist) return null;
    const nx = dist > 0.01 ? dx / dist : 0, ny = dist > 0.01 ? dy / dist : -1;
    d.x = px + nx * minDist;
    d.y = py + ny * minDist;
    // лёгкий снос вбок, чтобы утка не зависала ровно на макушке камня
    d.vx += (Math.abs(dx) < 0.5 ? (d.id && d.id.charCodeAt(d.id.length - 1) % 2 ? 1 : -1) : Math.sign(dx)) * 1.2;
    const vn = d.vx * nx + d.vy * ny;
    if (vn < 0) {
      d.vx -= 1.45 * vn * nx;
      d.vy -= 1.45 * vn * ny;
      d.spin += (d.vx * ny - d.vy * nx) * 0.03;
      if (-vn > 30) return { kind, power: -vn, x: px + nx * (minDist - 12), y: py + ny * (minDist - 12) };
    }
    return null;
  }

  function collideStatic(d, c, cfg) {
    let hit = null;
    for (const r of c.rocks) {
      if (Math.abs(r.y - d.y) > 60) continue;
      // течение обтекает камень и сносит прижатую утку в сторону, на макушке не зависнуть
      if (r.y > d.y && Math.hypot(d.x - r.x, d.y - r.y) < r.r + cfg.DR + 1) {
        let side = Math.sign(d.x - r.x) || 1;
        const cx = c.riverCx(r.y), hw = c.riverHw(r.y);
        const room = side > 0 ? cx + hw - (r.x + r.r) : (r.x - r.r) - (cx - hw);
        if (room < cfg.DR * 2 + 6) side = -side;
        d.vx += side * cfg.LOG_SLIDE * SUB;
      }
      hit = pushOut(d, r.x, r.y, r.r + cfg.DR - 1, 'rock') || hit;
    }
    for (const L of c.logs) {
      if (d.y < Math.min(L.y1, L.y2) - 40 || d.y > Math.max(L.y1, L.y2) + 40) continue;
      const ex = L.x2 - L.x1, ey = L.y2 - L.y1;
      const t = clamp(((d.x - L.x1) * ex + (d.y - L.y1) * ey) / (ex * ex + ey * ey), 0, 1);
      const px = L.x1 + ex * t, py = L.y1 + ey * t;
      // упёрлась в бревно: течение тащит утку вдоль него к свободному концу
      if (t < 0.97 && Math.hypot(d.x - px, d.y - py) < L.r + cfg.DR + 1) d.vx += Math.sign(ex) * cfg.LOG_SLIDE * SUB;
      hit = pushOut(d, px, py, L.r + cfg.DR, 'log') || hit;
    }
    return hit;
  }

  function bankAndGate(d, c, cfg, gateOpen) {
    const cx = c.riverCx(d.y), lim = c.riverHw(d.y) - cfg.DR - 3;
    const off = d.x - cx;
    if (lim <= 0) d.x = cx;
    else if (Math.abs(off) > lim) {
      const s = Math.sign(off);
      d.x = cx + s * lim;
      if (d.vx * s > 0) d.vx = -d.vx * 0.3;
    }
    if (d.y < 70) { d.y = 70; if (d.vy < 0) d.vy = 0; }
    if (d.y > c.WORLD_H - 70) { d.y = c.WORLD_H - 70; if (d.vy > 0) d.vy = -d.vy * 0.2; }
    if (!gateOpen && d.y > GATE_Y - cfg.DR - 8 && d.y < GATE_Y + 30) {
      d.y = GATE_Y - cfg.DR - 8;
      if (d.vy > 0) d.vy = -d.vy * 0.25;
    }
  }

  // ===================================================================
  function createGame(opts = {}) {
    const cfg = Object.assign({}, DEFAULTS, opts.cfg || {});
    const rng = opts.rng || mulberry32((opts.seed ?? (Math.random() * 4294967296)) >>> 0);

    const g = {
      cfg,
      phase: 'lobby',      // lobby → countdown → race → over
      time: 0,
      clock: 0,            // время с открытия шлюза
      phaseT: 0,
      players: [],
      byId: new Map(),
      seed: 0,
      course: null,
      finishCount: 0,
      champion: null,
      host: null,          // {id, dnf: bool}
      events: [],
      stats: null,
    };

    function newCourse() {
      g.seed = Math.floor(rng() * 4294967296) >>> 0;
      g.course = makeCourse(g.seed, cfg);
    }
    newCourse();

    function emit(type, data) {
      g.events.push(Object.assign({ type, t: g.time, clock: g.clock }, data));
      if (g.events.length > 2000) g.events.splice(0, 1000);
    }
    function drainEvents() { const e = g.events; g.events = []; return e; }

    // ----- игроки -----
    function newDuck(id, name, ci) {
      return {
        id, name, ci, online: true, inGame: false, offlineSince: 0,
        x: 0, y: 0, vx: 0, vy: 0, ang: Math.PI / 2, spin: 0, steer: 0,
        st: 'w', cap: null, inPool: false, poolCd: new Map(),
        place: 0, finT: 0, dnf: false,
        bumps: 0, bumped: 0, rocks: 0, whirls: 0, lastHit: -9, lastBump: -9,
      };
    }
    function spotInPool(d) {
      const c = g.course;
      for (let t = 0; t < 200; t++) {
        const y = 110 + rng() * (GATE_Y - DEFAULTS.DR - 24 - 110);
        const lim = c.riverHw(y) - cfg.DR - 10;
        const x = c.riverCx(y) + (rng() * 2 - 1) * lim;
        if (t === 199 || g.players.every(o => o === d || Math.hypot(o.x - x, o.y - y) > cfg.DR * 2.4)) { d.x = x; d.y = y; break; }
      }
      d.vx = d.vy = 0;
    }
    function addPlayer(id, name, ci) {
      if (g.byId.has(id)) return g.byId.get(id);
      const d = newDuck(id, name, ci);
      g.players.push(d);
      g.byId.set(id, d);
      spotInPool(d);
      return d;
    }
    function removePlayer(id) {
      const d = g.byId.get(id);
      if (!d) return;
      // ушёл посреди заплыва — сошёл с дистанции, место за ним остаётся
      if (d.inGame && (g.phase === 'countdown' || g.phase === 'race')) {
        d.online = false;
        if (d.st !== 'f') { d.dnf = true; d.st = 'f'; d.left = true; emit('removed', { id }); checkEnd(); }
        return;
      }
      g.players.splice(g.players.indexOf(d), 1);
      g.byId.delete(id);
    }
    function setOnline(id, on) {
      const d = g.byId.get(id);
      if (!d || d.online === on) return;
      d.online = on;
      if (!on) { d.offlineSince = g.time; d.steer = 0; }
      emit(on ? 'online' : 'offline', { id });
    }
    function setInput(id, s) {
      const d = g.byId.get(id);
      if (!d || !Number.isFinite(s)) return;
      d.steer = clamp(Math.round(s * 20) / 20, -1, 1);
    }
    const inPlay = () => g.players.filter(p => p.inGame);

    function setPhase(ph) {
      g.phase = ph;
      g.phaseT = 0;
      emit('phase', { phase: ph });
    }

    function start() {
      const ready = g.players.filter(p => p.online);
      if (ready.length < 2) return false;
      newCourse();
      g.finishCount = 0; g.champion = null; g.host = null; g.stats = null; g.clock = 0;
      // старт у шлюза в ряд, дорожки — по жребию
      const order = ready.slice();
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const c = g.course;
      // все в один ряд у шлюза: второй ряд при 8+ утках вёл дейлик в 70% заплывов (плейтест 04.10).
      // На 12 уток ширины впритык — соседи через одного чуть сдвинуты назад (на 6 ед., ≈0.03 с), чтобы не перекрываться
      for (const p of g.players) p.inGame = false;
      const n = order.length;
      order.forEach((p, k) => {
        const y = GATE_Y - cfg.DR - 12 - (n > 8 && k % 2 ? 6 : 0);
        const hw = c.riverHw(GATE_Y - cfg.DR - 12) - cfg.DR - 2;
        const x = c.riverCx(y) + (n === 1 ? 0 : lerp(-hw, hw, (k + 0.5) / n) * (n > 8 ? 1 : 0.92));
        Object.assign(p, {
          inGame: true, x, y, vx: 0, vy: 0, ang: Math.PI / 2, spin: 0, st: 'w', cap: null, inPool: false,
          poolCd: new Map(), place: 0, finT: 0, dnf: false, left: false,
          bumps: 0, bumped: 0, rocks: 0, whirls: 0, lastHit: -9, lastBump: -9,
        });
      });
      // кто не в заплыве — в заводь, чтобы не мешал у шлюза
      for (const p of g.players) if (!p.inGame) spotInPool(p);
      setPhase('countdown');
      emit('course', { seed: g.seed });
      return true;
    }

    function toLobby() {
      g.players = g.players.filter(p => !p.left);
      g.byId = new Map(g.players.map(p => [p.id, p]));
      for (const p of g.players) { p.inGame = false; p.st = 'w'; p.cap = null; p.place = 0; spotInPool(p); }
      newCourse();
      g.finishCount = 0; g.champion = null; g.host = null; g.clock = 0;
      setPhase('lobby');
      emit('course', { seed: g.seed });
    }

    // ----- водовороты -----
    function swirl(d, p, dt) {
      const dx = d.x - p.x, dy = d.y - p.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const R = p.r * 1.35;
      if (dist > R) return;
      d.inPool = true;
      const f = 1 - dist / R;
      const ux = dx / dist, uy = dy / dist;
      d.vx += (-uy * p.dir * 150 * f - ux * 60 * f) * dt;
      d.vy += (ux * p.dir * 150 * f - uy * 60 * f) * dt;
      d.spin += p.dir * 5 * f * dt;
      if (g.phase === 'race' && d.st === 'w' && dist < p.r * 0.6 && g.time > (d.poolCd.get(p) || 0)) {
        d.cap = { p, a: Math.atan2(dy, dx), r: dist, t: 0 };
        d.st = 'c';
        d.whirls++;
        emit('whirl', { id: d.id, x: p.x, y: p.y });
      }
    }
    function stepCaptured(d, dt) {
      const c = d.cap, p = c.p;
      c.t += dt;
      c.r += (13 - c.r) * Math.min(1, dt * 1.1);
      const w = p.dir * (2.0 + 26 / (c.r + 6));
      c.a += w * dt;
      const nx = p.x + Math.cos(c.a) * c.r, ny = p.y + Math.sin(c.a) * c.r;
      d.vx = (nx - d.x) / dt; d.vy = (ny - d.y) / dt;
      d.x = nx; d.y = ny;
      d.ang += w * 1.3 * dt;
      // отпускает с нижней по течению стороны воронки и сразу со скоростью воды: потеря времени почти постоянная,
      // а не лотерея угла выброса (было 0.1–3.5 с, плейтест 04.10). Орбита к этому моменту ≈13 ед. — сдвиг незаметен
      if (c.t >= cfg.CAP_T) {
        d.x = p.x + Math.cos(c.a) * c.r * 0.3;
        d.y = p.y + Math.max(c.r, 13);
        const [wx, wy] = g.course.water(d.x, d.y + 20);
        d.vx = wx; d.vy = Math.max(wy, 90);
        d.cap = null; d.st = 'w';
        d.poolCd.set(p, g.time + cfg.CAP_CD);
        d.spin = p.dir * 5;
        emit('whirlOut', { id: d.id, x: d.x, y: d.y });
      }
    }

    // ----- столкновения уток -----
    function collideDucks() {
      const L = g.players.filter(p => (g.phase === 'lobby' || p.inGame) && p.st !== 'f' && !p.left);
      const min = cfg.DR * 2;
      const guard = g.phase === 'race' && g.clock < cfg.START_GUARD;
      for (let i = 0; i < L.length; i++) {
        for (let j = i + 1; j < L.length; j++) {
          const a = L[i], b = L[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          const ia = a.cap ? 0 : 1, ib = b.cap ? 0 : 1;
          if (ia + ib === 0) continue;
          let dist = Math.sqrt(d2);
          if (dist < 0.001) { dx = rng() - 0.5; dy = rng() - 0.5; dist = Math.hypot(dx, dy); }
          const nx = dx / dist, ny = dy / dist, overlap = min - dist;
          const sa = ia / (ia + ib), sb = ib / (ia + ib);
          a.x -= nx * overlap * sa; a.y -= ny * overlap * sa;
          b.x += nx * overlap * sb; b.y += ny * overlap * sb;
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {
            const imp = -(1 + (guard ? 0.1 : cfg.REST)) * rel;
            a.vx -= imp * nx * sa; a.vy -= imp * ny * sa;
            b.vx += imp * nx * sb; b.vy += imp * ny * sb;
            const tang = (b.vx - a.vx) * -ny + (b.vy - a.vy) * nx;
            a.spin += tang * 0.02 * ia; b.spin -= tang * 0.02 * ib;
            // кто толкнул: тот, кто сильнее двигался навстречу соседу
            if (g.phase === 'race' && !guard && -rel > 40) {
              // толкнул тот, кто рулил на соседа; рулили оба или никто — кто быстрее шёл на соседа относительно воды
              // (абсолютные скорости не годятся: в них общее течение, и «толкачом» выходил тот, кто плыл в струе)
              const [rtx, rty] = g.course.riverDir((a.y + b.y) / 2);
              const side = nx * rty - ny * rtx;   // проекция линии a→b на «право» по ходу реки
              const aTo = (a.steer || 0) * side > 0.1, bTo = -(b.steer || 0) * side > 0.1;
              let by;
              if (aTo !== bTo) by = aTo ? a : b;
              else {
                const wa = g.course.water(a.x, a.y), wb = g.course.water(b.x, b.y);
                const towardA = (a.vx - wa[0]) * nx + (a.vy - wa[1]) * ny, towardB = -((b.vx - wb[0]) * nx + (b.vy - wb[1]) * ny);
                by = towardA >= towardB ? a : b;
              }
              const to = by === a ? b : a;
              if (g.time - by.lastBump > 0.6) {
                by.lastBump = g.time;
                by.bumps++; to.bumped++;
                emit('bump', { id: to.id, by: by.id, power: -rel, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
              }
            }
          }
        }
      }
    }

    // ----- шаг -----
    let acc = 0;
    function step(dt) {
      acc += Math.min(dt, 0.25);
      while (acc >= SUB - 1e-9) { acc -= SUB; sub(SUB); }
    }

    function sub(dt) {
      g.time += dt;
      g.phaseT += dt;
      if (g.phase === 'countdown' && g.phaseT >= cfg.COUNTDOWN) {
        setPhase('race');
        emit('go', {});
      }
      if (g.phase === 'race') g.clock += dt;
      const c = g.course;
      const gateOpen = g.phase === 'race' || g.phase === 'over';
      for (const d of g.players) {
        if (g.phase !== 'lobby' && !d.inGame) continue;
        if (d.st === 'f') { stepFinished(d, dt); continue; }
        if (d.cap) { stepCaptured(d, dt); continue; }
        d.inPool = false;
        for (const p of c.pools) swirl(d, p, dt);
        if (d.cap) continue;
        const controlled = (g.phase === 'lobby' || g.phase === 'race') && d.online;
        const hit = moveDuck(d, c, cfg, dt, d.steer, controlled, gateOpen);
        if (hit && g.phase === 'race' && g.time - d.lastHit > 0.8) {
          d.lastHit = g.time;
          if (hit.kind === 'rock') d.rocks++;
          emit(hit.kind, { id: d.id, x: hit.x, y: hit.y, power: hit.power });
        }
      }
      collideDucks();
      for (const d of g.players) if ((g.phase === 'lobby' || d.inGame) && d.st !== 'f') bankAndGate(d, c, cfg, gateOpen);
      if (g.phase === 'race') { checkFinish(); checkEnd(); }
    }

    // доплывшие уходят в заводь к берегам и никому не мешают
    function stepFinished(d, dt) {
      const c = g.course;
      if (d.left) return;
      const side = d.place % 2 ? -1 : 1;
      const ty = c.FINISH_Y + 120 + Math.min(5, Math.floor((d.place - 1) / 2)) * 26;
      const tx = c.riverCx(ty) + side * (c.riverHw(ty) - 30);
      d.vx += ((tx - d.x) * 1.4 - d.vx * 1.8) * dt;
      d.vy += ((ty - d.y) * 1.4 - d.vy * 1.8) * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      const sp = Math.hypot(d.vx, d.vy);
      if (sp > 8) {
        let da = Math.atan2(d.vy, d.vx) - d.ang;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        d.ang += da * Math.min(1, dt * 3);
      }
    }

    function checkFinish() {
      const c = g.course;
      const crossing = g.players.filter(d => d.inGame && d.st !== 'f' && d.y >= c.FINISH_Y).sort((a, b) => b.y - a.y);
      for (const d of crossing) {
        d.st = 'f'; d.cap = null;
        d.place = ++g.finishCount;
        d.finT = g.clock;
        emit('finish', { id: d.id, place: d.place, time: +g.clock.toFixed(2), x: d.x });
        if (d.place === 1) { g.champion = d.id; emit('champion', { id: d.id, time: +g.clock.toFixed(2) }); }
      }
    }

    // Заплыв кончается, когда в реке остаётся одна утка: она и ведёт дейлик. Или по пределу времени — тогда по пройденному пути.
    function checkEnd() {
      if (g.phase !== 'race' && g.phase !== 'countdown') return;
      const L = inPlay();
      const swimming = L.filter(d => d.st !== 'f');
      const timeUp = g.phase === 'race' && g.clock >= cfg.RACE_T;
      if (swimming.length > 1 && !timeUp) return;
      if (L.length < 2) { /* один остался в комнате — всё равно итог */ }
      // места: доплывшие по порядку, дальше — плывущие по пути (кто дальше — выше), сошедшие — в самом конце
      const fin = L.filter(d => d.st === 'f' && !d.dnf).sort((a, b) => a.place - b.place);
      const swim = swimming.slice().sort((a, b) => b.y - a.y);
      const dnf = L.filter(d => d.dnf);
      const order = fin.concat(swim, dnf);
      order.forEach((d, i) => { d.place = i + 1; });
      const last = order[order.length - 1];
      g.host = { id: last.id, dnf: !!last.dnf, timeUp: timeUp && swim.length > 1 };
      if (!g.champion && order[0]) g.champion = order[0].id;
      emit('host', g.host);
      const stats = statsOf(order);
      g.stats = stats;
      setPhase('over');
      emit('over', { host: g.host, champion: g.champion, stats });
    }

    function statsOf(order) {
      const players = order.map(d => ({
        id: d.id, name: d.name, place: d.place, time: d.st === 'f' && !d.dnf && d.finT ? +d.finT.toFixed(2) : null,
        dnf: !!d.dnf, bumps: d.bumps, whirls: d.whirls, rocks: d.rocks,
        progress: +clamp((d.y - GATE_Y) / (g.course.FINISH_Y - GATE_Y), 0, 1).toFixed(3),
      }));
      const maxOf = (k) => Math.max(0, ...players.map(p => p[k]));
      const who = (k) => { const m = maxOf(k); return m > 0 ? players.filter(p => p[k] === m).map(p => p.id) : []; };
      return { players, pusher: who('bumps'), maxBumps: maxOf('bumps'), whirler: who('whirls'), maxWhirls: maxOf('whirls') };
    }

    function snapshot() {
      return {
        phase: g.phase,
        phaseT: +g.phaseT.toFixed(2),
        clock: +g.clock.toFixed(2),
        seed: g.seed,
        champion: g.champion,
        host: g.host,
        players: g.players.map(p => ({
          id: p.id, name: p.name, ci: p.ci, inGame: p.inGame, online: p.online,
          x: +p.x.toFixed(1), y: +p.y.toFixed(1), vx: +p.vx.toFixed(1), vy: +p.vy.toFixed(1), ang: +p.ang.toFixed(2),
          st: p.st, place: p.place, dnf: p.dnf, steer: p.steer,
        })),
      };
    }

    Object.assign(g, { addPlayer, removePlayer, setOnline, setInput, start, toLobby, step, snapshot, drainEvents, inPlay, rng });
    return g;
  }

  return { createGame, makeCourse, moveDuck, mulberry32, DEFAULTS, SUB, WORLD_W, GATE_Y };
});
