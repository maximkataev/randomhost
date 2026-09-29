/*
 * «Царь льдины» — движок партии: льдина, пингвины, рывки, таяние, правила.
 * Без сети и таймеров: сервер (и песочница floe-lab.html) зовёт step(dt) сами.
 * Работает и в Node (require), и в браузере (window.FloeGame).
 * Спека — floe-battle-spec.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FloeGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Всё, что подбирается на стенде, — здесь. Песочница меняет эти числа ползунками.
  const DEFAULTS = {
    PR: 10,              // радиус пингвина
    ACC: 300,            // разгон от джойстика, ед/с²
    DRAG: 3.2,           // трение льда: скорость гаснет как exp(-DRAG·t); предел хода ACC/DRAG ≈ 94
    DASH_V: 240,         // скорость в начале рывка
    DASH_T: 0.2,         // сколько длится рывок (пока он «бьёт»)
    DASH_DRAG: 1.2,      // трение во время рывка
    DASH_CD: 1.5,        // перезарядка рывка
    DASH_HIT: 150,       // добавка скорости цели от попадания рывком
    DASH_BUFFER: 0.12,   // нажал чуть раньше конца перезарядки — рывок всё равно случится
    START_GUARD: 2,      // первые секунды боя рывок «перезаряжается»: соседа не сбить сразу после «Толкайся!» (плейтест 30.09)
    REST: 0.55,          // упругость обычного столкновения
    TOUCH_WINDOW: 2,     // «кто столкнул» — последнее касание за столько секунд до падения
    AREA_PER_PLAYER: 13500, // площадь льда на пингвина на старте
    R_MIN: 100,          // льдина на двоих не меньше этого радиуса
    COUNTDOWN: 3,
    FIGHT_T: 60,
    MELT_START: 10,
    MELT_MID: 50,        // к этому моменту остаётся пятачок на двоих
    MID_R: 46,
    CORE_R: 26,          // центр до добивания не тонет
    CRACK_T: 1.5,        // от трещины до откола
    MAX_CRACKS: 3,
    OVERTIME_T: 10,
    OVERTIME_EVERY: 1,
    OVERTIME_CRACK_T: 0.9,
    OFFLINE_T: 5,
    PRACTICE_RESPAWN: 1.2,
    REPLAY_BEFORE: 3,
    REPLAY_AFTER: 1.1,
  };

  const SUB = 1 / 60;    // шаг физики

  // ----- Геометрия -----
  function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const q of p) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
      lo.push(q);
    }
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
      hi.push(q);
    }
    lo.pop(); hi.pop();
    return lo.concat(hi);
  }

  // оставляет часть многоугольника, где nx*x + ny*y <= c
  function clipHalf(poly, nx, ny, c) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = a[0] * nx + a[1] * ny - c, db = b[0] * nx + b[1] * ny - c;
      if (da <= 0) out.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }

  function polyArea(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }

  function polyCentroid(p) {
    let x = 0, y = 0, s = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const c = a[0] * b[1] - b[0] * a[1];
      x += (a[0] + b[0]) * c; y += (a[1] + b[1]) * c; s += c;
    }
    if (Math.abs(s) < 1e-6) return [p[0][0], p[0][1]];
    return [x / (3 * s), y / (3 * s)];
  }

  function pointInPoly(x, y, p) {
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ближайшая точка отрезка: [x, y, расстояние²]
  function nearestOnSeg(px, py, x1, y1, x2, y2) {
    const ex = x2 - x1, ey = y2 - y1;
    const l2 = ex * ex + ey * ey || 1e-6;
    const t = clamp(((px - x1) * ex + (py - y1) * ey) / l2, 0, 1);
    const x = x1 + ex * t, y = y1 + ey * t;
    return [x, y, (px - x) * (px - x) + (py - y) * (py - y)];
  }

  function floeRadius(n, cfg) {
    return Math.max(cfg.R_MIN, Math.sqrt((Math.max(2, n) * cfg.AREA_PER_PLAYER) / Math.PI));
  }

  // Льдина: выпуклый контур, разрезанный на осколки Вороного. Зависит только от seed и R —
  // клиент строит ту же льдину сам (floe-render.js зовёт эту же функцию).
  function generateFloe(seed, R) {
    const rnd = mulberry32(seed >>> 0);
    const rr = (a, b) => a + (b - a) * rnd();
    const K = 20, raw = [];
    const rx = R * rr(1.02, 1.08), ry = R * rr(0.94, 0.99), rot = rr(-0.3, 0.3);
    for (let k = 0; k < K; k++) {
      const a = (k / K) * TAU + rr(-0.08, 0.08), r = rr(0.93, 1);
      const x = Math.cos(a) * rx * r, y = Math.sin(a) * ry * r;
      raw.push([x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    const hull = convexHull(raw);

    const seeds = [[rr(-6, 6), rr(-6, 6)]];
    const want = Math.round(60 * (R / 150) * (R / 150)) + 8;
    for (let tries = 0; tries < 6000 && seeds.length < want; tries++) {
      const a = rnd() * TAU, d = Math.sqrt(rnd()) * R * 1.12;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      if (!pointInPoly(x, y, hull)) continue;
      const minD = lerp(44, 34, clamp(d / R, 0, 1));
      if (seeds.some(s => Math.hypot(s[0] - x, s[1] - y) < minD)) continue;
      seeds.push([x, y]);
    }

    const shards = [];
    for (const s of seeds) {
      let poly = hull;
      for (const o of seeds) {
        if (o === s || Math.hypot(o[0] - s[0], o[1] - s[1]) > 150) continue;
        const nx = o[0] - s[0], ny = o[1] - s[1];
        poly = clipHalf(poly, nx, ny, nx * (s[0] + o[0]) / 2 + ny * (s[1] + o[1]) / 2);
        if (poly.length < 3) break;
      }
      if (poly.length < 3 || polyArea(poly) < 60) continue;
      const c = polyCentroid(poly);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const v of poly) { x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]); x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]); }
      shards.push({ id: shards.length, poly, cx: c[0], cy: c[1], area: polyArea(poly), nb: [], edgeNb: [], box: [x0, y0, x1, y1] });
    }

    const near = (p, q) => Math.abs(p[0] - q[0]) < 0.8 && Math.abs(p[1] - q[1]) < 0.8;
    for (const a of shards) {
      a.edgeNb = a.poly.map(() => -1);
      for (const b of shards) {
        if (a === b || Math.hypot(a.cx - b.cx, a.cy - b.cy) > 130) continue;
        let shared = false;
        a.poly.forEach((p1, i) => {
          const p2 = a.poly[(i + 1) % a.poly.length];
          for (let j = 0; j < b.poly.length; j++) {
            const q1 = b.poly[j], q2 = b.poly[(j + 1) % b.poly.length];
            if ((near(p1, q2) && near(p2, q1)) || (near(p1, q1) && near(p2, q2))) { a.edgeNb[i] = b.id; shared = true; }
          }
        });
        if (shared) a.nb.push(b.id);
      }
    }
    return { shards, hull, R, area0: shards.reduce((s, x) => s + x.area, 0) };
  }

  // Один шаг движения пингвина без столкновений: разгон, рывок, трение. Общий для сервера и для клиента,
  // который предсказывает своего пингвина, не дожидаясь ответа, — физика у них обязана совпадать.
  // controlled=false — управление не действует (отсчёт, конец партии), тело просто скользит.
  function moveBody(p, cfg, dt, ix, iy, wantDash, controlled) {
    let dashed = false, whiff = false;
    if (controlled && wantDash && p.cd <= 0 && p.dashT <= 0) {
      let dx = ix, dy = iy;
      if (Math.hypot(dx, dy) < 0.2) { dx = Math.cos(p.dir); dy = Math.sin(p.dir); }
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      p.dir = Math.atan2(dy, dx);
      // скорость рывка не складывается с разгоном: сносит по его направлению
      const along = Math.max(0, p.vx * dx + p.vy * dy);
      const sp = Math.max(cfg.DASH_V, along);
      p.vx = dx * sp; p.vy = dy * sp;
      p.dashT = cfg.DASH_T;
      p.cd = cfg.DASH_CD;
      dashed = true;
    }
    if (controlled && p.dashT <= 0) {
      p.vx += ix * cfg.ACC * dt;
      p.vy += iy * cfg.ACC * dt;
      if (Math.hypot(ix, iy) > 0.2) p.dir = Math.atan2(iy, ix);
    }
    const k = Math.exp(-(p.dashT > 0 ? cfg.DASH_DRAG : cfg.DRAG) * dt);
    p.vx *= k; p.vy *= k;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.dashT > 0) {
      p.dashT = Math.max(0, p.dashT - dt);
      if (p.dashT === 0) whiff = true;
    }
    if (p.cd > 0) p.cd = Math.max(0, p.cd - dt);
    return { dashed, whiff };
  }

  // ===================================================================
  function createGame(opts = {}) {
    const cfg = Object.assign({}, DEFAULTS, opts.cfg || {});
    const rng = opts.rng || mulberry32((opts.seed ?? (Math.random() * 4294967296)) >>> 0);
    const rr = (a, b) => a + (b - a) * rng();

    const g = {
      cfg,
      phase: 'lobby',     // lobby → countdown → fight → (overtime) → over
      time: 0,            // общее время движка
      clock: 0,           // время с начала фазы fight (в overtime продолжает идти)
      phaseT: 0,
      players: [],
      byId: new Map(),
      floe: null,
      shardSt: [],        // по осколку: {st: 's'|'c'|'g', t, dur}
      seed: 0,
      host: null,         // {ids: [...] — обычно один, tie: 'none'|'hits'|'lottery', lottery: bool}
      kings: [],
      events: [],
      replay: null,
      stats: null,
      rimDirty: true,
      rim: [],
      lastCrackAt: -9,
      nextOvertimeCrack: 0,
      fallsThisStep: [],
      frames: [],
    };

    // ----- Льдина -----
    function newFloe(n) {
      g.seed = Math.floor(rng() * 4294967296) >>> 0;
      g.floe = generateFloe(g.seed, floeRadius(n, cfg));
      g.shardSt = g.floe.shards.map(s => ({ st: 's', t: 0, dur: 0, core: Math.hypot(s.cx, s.cy) < cfg.CORE_R }));
      // центр — хотя бы один осколок
      if (!g.shardSt.some(x => x.core)) {
        let best = 0;
        g.floe.shards.forEach((s, i) => { if (Math.hypot(s.cx, s.cy) < Math.hypot(g.floe.shards[best].cx, g.floe.shards[best].cy)) best = i; });
        g.shardSt[best].core = true;
      }
      g.rimDirty = true;
      emit('floe', { seed: g.seed, R: g.floe.R });
    }

    const holds = (i) => g.shardSt[i].st !== 'g';

    function shardAt(x, y) {
      const sh = g.floe.shards;
      for (let i = 0; i < sh.length; i++) {
        if (!holds(i)) continue;
        const b = sh[i].box;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (pointInPoly(x, y, sh[i].poly)) return i;
      }
      return -1;
    }
    const onIce = (x, y) => shardAt(x, y) >= 0;

    function rebuildRim() {
      const rim = [];
      for (const s of g.floe.shards) {
        if (!holds(s.id)) continue;
        s.poly.forEach((p1, i) => {
          const nb = s.edgeNb[i];
          if (nb >= 0 && holds(nb)) return;
          const p2 = s.poly[(i + 1) % s.poly.length];
          if (Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) < 0.5) return;
          rim.push([p1[0], p1[1], p2[0], p2[1]]);
        });
      }
      g.rim = rim;
      g.rimDirty = false;
    }

    // расстояние до края и нормаль внутрь льдины
    function edgeInfo(x, y) {
      if (g.rimDirty) rebuildRim();
      let best = 1e12, bx = x, by = y;
      for (const e of g.rim) {
        const n = nearestOnSeg(x, y, e[0], e[1], e[2], e[3]);
        if (n[2] < best) { best = n[2]; bx = n[0]; by = n[1]; }
      }
      const d = Math.sqrt(best);
      const sg = onIce(x, y) ? 1 : -1;
      return { d: d * sg, nx: d > 1e-3 ? (sg * (x - bx)) / d : 0, ny: d > 1e-3 ? (sg * (y - by)) / d : 0 };
    }

    function floeCenter() {
      let x = 0, y = 0, a = 0;
      g.floe.shards.forEach((s, i) => { if (g.shardSt[i].st === 's') { x += s.cx * s.area; y += s.cy * s.area; a += s.area; } });
      return a ? [x / a, y / a] : [0, 0];
    }

    function solidArea() {
      let a = 0;
      g.floe.shards.forEach((s, i) => { if (g.shardSt[i].st === 's') a += s.area; });
      return a;
    }

    function exposed(i) {
      const s = g.floe.shards[i];
      return s.edgeNb.some(nb => nb < 0 || !holds(nb));
    }

    // откалывать можно только осколок, без которого остальные остаются одной льдиной
    function keepsConnected(skip) {
      const alive = [];
      g.shardSt.forEach((x, i) => { if (x.st === 's' && i !== skip) alive.push(i); });
      if (alive.length <= 1) return true;
      const seen = new Set([alive[0]]);
      const stack = [alive[0]];
      while (stack.length) {
        const i = stack.pop();
        for (const n of g.floe.shards[i].nb) {
          if (n === skip || g.shardSt[n].st !== 's' || seen.has(n)) continue;
          seen.add(n);
          stack.push(n);
        }
      }
      return seen.size === alive.length;
    }

    function startCrack(i, dur) {
      const s = g.shardSt[i];
      s.st = 'c'; s.t = 0; s.dur = dur;
      g.lastCrackAt = g.time;
      emit('crack', { shard: i, dur });
    }

    // Сколько льда должно остаться к моменту t боя
    function targetArea(t) {
      const A0 = g.floe.area0;
      const Amid = Math.PI * cfg.MID_R * cfg.MID_R;
      const Acore = g.floe.shards.reduce((a, s, i) => a + (g.shardSt[i].core ? s.area : 0), 0);
      if (t < cfg.MELT_START) return A0;
      if (t < cfg.MELT_MID) {
        const u = (t - cfg.MELT_START) / (cfg.MELT_MID - cfg.MELT_START);
        return lerp(A0, Amid, Math.pow(u, 1.35));
      }
      const u = clamp((t - cfg.MELT_MID) / (cfg.FIGHT_T - cfg.MELT_MID), 0, 1);
      return lerp(Amid, Acore, u);
    }

    function pickEdgeShard(allowCore) {
      const c = floeCenter();
      const cand = [];
      let total = 0;
      g.shardSt.forEach((x, i) => {
        if (x.st !== 's' || (x.core && !allowCore) || !exposed(i) || !keepsConnected(i)) return;
        const s = g.floe.shards[i];
        const w = Math.pow(Math.hypot(s.cx - c[0], s.cy - c[1]) + 10, 3);
        cand.push([i, w]);
        total += w;
      });
      if (!cand.length) return -1;
      let pick = rng() * total;
      for (const [i, w] of cand) { pick -= w; if (pick <= 0) return i; }
      return cand[cand.length - 1][0];
    }

    function updateShards(dt) {
      let changed = false;
      g.shardSt.forEach((x, i) => {
        if (x.st !== 'c') return;
        x.t += dt;
        if (x.t >= x.dur) { x.st = 'g'; changed = true; emit('sink', { shard: i }); }
      });
      if (changed) g.rimDirty = true;
    }

    function melt() {
      if (g.phase === 'fight') {
        const cracking = g.shardSt.filter(x => x.st === 'c').length;
        if (cracking >= cfg.MAX_CRACKS || g.time - g.lastCrackAt < 0.35) return;
        if (solidArea() <= targetArea(g.clock)) return;
        const i = pickEdgeShard(false);
        if (i >= 0) startCrack(i, cfg.CRACK_T);
      } else if (g.phase === 'overtime') {
        if (g.clock < g.nextOvertimeCrack) return;
        g.nextOvertimeCrack = g.clock + cfg.OVERTIME_EVERY;
        let i = pickEdgeShard(true);
        if (i < 0) {
          // остался один осколок (или связность не даёт) — тонет любой
          const left = [];
          g.shardSt.forEach((x, k) => { if (x.st === 's') left.push(k); });
          if (left.length) i = left[Math.floor(rng() * left.length)];
        }
        if (i >= 0) startCrack(i, cfg.OVERTIME_CRACK_T);
      }
    }

    // ----- Игроки -----
    function addPlayer(id, name, ci) {
      if (g.byId.has(id)) return g.byId.get(id);
      const p = {
        id, name: String(name), ci: ci | 0,
        x: 0, y: 0, vx: 0, vy: 0, dir: rng() * TAU,
        ix: 0, iy: 0, wantDash: -1,
        dashT: 0, cd: 0,
        st: 'ice',           // ice | fall | swim | gone (снят) ; в лобби — ещё spawn
        inGame: false,       // участвует в текущей партии
        online: true, offlineSince: 0,
        lastTouch: null, fellAt: -1, fallT: 0, by: null, removed: false,
        hits: 0, kos: 0, selfFall: false, place: 0, respawnAt: 0,
      };
      g.players.push(p);
      g.byId.set(id, p);
      // в лобби льдина сразу на восьмерых: народ подходит, пересобирать её под каждого нельзя
      if (!g.floe) newFloe(8);
      if (g.phase === 'lobby') spawnSafe(p);
      else { p.st = 'gone'; p.inGame = false; }
      emit('join', { id });
      return p;
    }

    function removePlayer(id) {
      const p = g.byId.get(id);
      if (!p) return;
      if (g.phase === 'lobby' || g.phase === 'over' || !p.inGame) {
        g.players.splice(g.players.indexOf(p), 1);
        g.byId.delete(id);
        emit('leave', { id });
        return;
      }
      takeOff(p, 'left');
    }

    // снят с партии без падения: ведущим стать не может
    function takeOff(p, why) {
      if (p.st === 'gone') return;
      p.st = 'gone';
      p.removed = true;
      p.fellAt = g.clock;
      emit('removed', { id: p.id, why });
    }

    function setOnline(id, on) {
      const p = g.byId.get(id);
      if (!p) return;
      if (on && !p.online) emit('online', { id });
      if (!on && p.online) { p.offlineSince = g.time; emit('offline', { id }); }
      p.online = !!on;
      if (!on) { p.ix = 0; p.iy = 0; }
    }

    function setInput(id, mx, my, dash) {
      const p = g.byId.get(id);
      if (!p || !p.online) return;
      mx = Number(mx); my = Number(my);
      if (!Number.isFinite(mx) || !Number.isFinite(my)) { mx = 0; my = 0; }
      const l = Math.hypot(mx, my);
      if (l > 1) { mx /= l; my /= l; }
      p.ix = mx; p.iy = my;
      if (dash) p.wantDash = g.time;
    }

    function spawnSafe(p) {
      const pt = safePoint(p);
      p.x = pt[0]; p.y = pt[1];
      p.vx = p.vy = 0;
      p.st = 'ice';
      p.dashT = 0;
      p.lastTouch = null;
    }

    // точка на льду подальше от края и от других
    function safePoint(p) {
      let best = null, bestS = -1e9;
      const R = g.floe.R;
      for (let k = 0; k < 40; k++) {
        const a = rng() * TAU, d = Math.sqrt(rng()) * R * 0.7;
        const x = Math.cos(a) * d, y = Math.sin(a) * d;
        if (!onIce(x, y)) continue;
        const e = edgeInfo(x, y).d;
        let near = 1e9;
        for (const o of g.players) if (o !== p && o.st === 'ice') near = Math.min(near, Math.hypot(o.x - x, o.y - y));
        const s = Math.min(e, 60) + Math.min(near, 80);
        if (s > bestS) { bestS = s; best = [x, y]; }
      }
      return best || floeCenter();
    }

    // ----- Партия -----
    function start() {
      const list = g.players.filter(p => p.online);
      if (list.length < 2 || (g.phase !== 'lobby' && g.phase !== 'over')) return false;
      newFloe(list.length);
      g.host = null; g.kings = []; g.replay = null; g.stats = null; g.frames = [];
      g.clock = 0;
      g.lastCrackAt = -9;
      // по кругу на равном расстоянии от центра, порядок и поворот — жребий
      const order = list.slice();
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const rot = rng() * TAU, rad = g.floe.R * 0.45;
      g.players.forEach(p => { p.inGame = false; p.st = 'gone'; });
      order.forEach((p, k) => {
        const a = rot + (k / order.length) * TAU;
        Object.assign(p, {
          x: Math.cos(a) * rad, y: Math.sin(a) * rad, vx: 0, vy: 0, dir: a + Math.PI,
          dashT: 0, cd: cfg.START_GUARD, wantDash: -1, st: 'ice', inGame: true, removed: false,
          lastTouch: null, fellAt: -1, fallT: 0, by: null, hits: 0, kos: 0, selfFall: false, place: 0,
        });
      });
      setPhase('countdown');
      return true;
    }

    function toLobby() {
      g.phase = 'lobby';
      g.phaseT = 0;
      newFloe(Math.max(8, g.players.length));
      g.players.forEach(p => { p.inGame = false; spawnSafe(p); });
      emit('phase', { phase: 'lobby' });
    }

    function setPhase(ph) {
      g.phase = ph;
      g.phaseT = 0;
      emit('phase', { phase: ph });
    }

    const inPlay = () => g.players.filter(p => p.inGame && p.st === 'ice');

    // ----- Физика -----
    function control(p, dt, live) {
      if (!live || p.st !== 'ice') return false;
      const want = p.wantDash >= 0 && g.time - p.wantDash <= cfg.DASH_BUFFER;
      if (p.wantDash >= 0 && !want) p.wantDash = -1;
      return want;
    }

    function integrate(p, dt, want, controlled) {
      const r = moveBody(p, cfg, dt, controlled ? p.ix : 0, controlled ? p.iy : 0, want, controlled);
      if (r.dashed) { p.wantDash = -1; emit('dash', { id: p.id }); }
      // рывок кончился сам, ни в кого не попав, — промах (попадание обнуляет dashT в collide)
      if (r.whiff) emit('whiff', { id: p.id, x: p.x, y: p.y });
    }

    function touch(v, by, dash) {
      v.lastTouch = { by: by.id, t: g.time, dash };
    }

    function collide() {
      const list = g.players.filter(p => p.st === 'ice' && (g.phase === 'lobby' || p.inGame));
      const D = cfg.PR * 2;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d >= D) continue;
          if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6; }
          const nx = dx / d, ny = dy / d;
          const ia = 1, ib = 1;   // масса у всех одна
          // разводим
          const over = D - d;
          a.x -= nx * over * ia / (ia + ib); a.y -= ny * over * ia / (ia + ib);
          b.x += nx * over * ib / (ia + ib); b.y += ny * over * ib / (ia + ib);
          const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;   // >0 — сближаются
          if (vn <= 0) continue;
          const jn = ((1 + cfg.REST) * vn) / (ia + ib);
          a.vx -= jn * ia * nx; a.vy -= jn * ia * ny;
          b.vx += jn * ib * nx; b.vy += jn * ib * ny;

          const aDash = a.dashT > 0, bDash = b.dashT > 0;
          if (aDash || bDash) {
            // рывок лоб в лоб — обоих отбрасывает, никто не выигрывает
            if (aDash && bDash) {
              const H = cfg.DASH_HIT * 0.6;
              a.vx -= nx * H; a.vy -= ny * H;
              b.vx += nx * H; b.vy += ny * H;
              a.dashT = b.dashT = 0;
              touch(a, b, true); touch(b, a, true);
              emit('hit', { a: a.id, b: b.id, clash: true, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, power: 1 });
            } else {
              const att = aDash ? a : b, vic = aDash ? b : a;
              const sx = aDash ? nx : -nx, sy = aDash ? ny : -ny;   // от нападающего к цели
              const dirx = Math.cos(att.dir), diry = Math.sin(att.dir);
              const align = Math.max(0, dirx * sx + diry * sy);      // скользящий удар слабее
              const H = cfg.DASH_HIT * align;
              vic.vx += sx * H; vic.vy += sy * H;
              // нападающий гасит скорость о цель
              att.vx *= 0.3; att.vy *= 0.3;
              att.dashT = 0;
              if (align > 0.3) att.hits++;
              touch(vic, att, true); touch(att, vic, false);
              emit('hit', { a: att.id, b: vic.id, clash: false, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, power: align });
            }
          } else if (vn > 12) {
            touch(a, b, false); touch(b, a, false);
            if (vn > 40) emit('bump', { a: a.id, b: b.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          }
        }
      }
    }

    function checkFooting() {
      for (const p of g.players) {
        if (p.st !== 'ice') continue;
        if (g.phase !== 'lobby' && !p.inGame) continue;
        if (onIce(p.x, p.y)) continue;
        fall(p);
      }
    }

    function fall(p) {
      p.st = 'fall';
      p.fallT = 0;
      p.dashT = 0;
      const lt = p.lastTouch;
      const by = lt && g.time - lt.t <= cfg.TOUCH_WINDOW && lt.by !== p.id && g.byId.get(lt.by) ? lt.by : null;
      p.by = by;
      if (g.phase === 'lobby') {
        p.respawnAt = g.time + cfg.PRACTICE_RESPAWN;
        emit('fall', { id: p.id, by, practice: true, x: p.x, y: p.y });
        return;
      }
      p.fellAt = g.clock;
      // упал, пока был офлайн, — не падение, а снятие: исход не решается чужим Wi-Fi
      if (!p.online) {
        p.removed = true;
        emit('fall', { id: p.id, by: null, offline: true, x: p.x, y: p.y });
        return;
      }
      if (by) g.byId.get(by).kos++;
      else p.selfFall = true;
      g.fallsThisStep.push(p);
      emit('fall', { id: p.id, by, x: p.x, y: p.y });
    }

    function stepOut(p, dt) {
      if (p.st === 'fall') {
        p.fallT += dt;
        const k = Math.exp(-3 * dt);
        p.vx *= k; p.vy *= k;
        p.x += p.vx * dt * 0.6; p.y += p.vy * dt * 0.6;
        if (p.fallT > 0.55) {
          p.st = 'swim';
          pushToWater(p);
        }
      } else if (p.st === 'swim') {
        const k = Math.exp(-2 * dt);
        p.vx *= k; p.vy *= k;
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
      if (g.phase === 'lobby' && (p.st === 'fall' || p.st === 'swim') && g.time >= p.respawnAt) {
        spawnSafe(p);
        emit('respawn', { id: p.id });
      }
    }

    // пловец не остаётся под льдом: отплывает от центра, пока не окажется в воде с запасом
    function pushToWater(p) {
      const c = floeCenter();
      let dx = p.x - c[0], dy = p.y - c[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      for (let i = 0; i < 100; i++) {
        if (!onIce(p.x, p.y) && !onIce(p.x - dx * 16, p.y - dy * 16) && !onIce(p.x, p.y - 14)) break;
        p.x += dx * 2; p.y += dy * 2;
      }
      p.vx = dx * 20; p.vy = dy * 20;
    }

    // ----- Решение: ведущий и цари -----
    function resolveFalls() {
      const falls = g.fallsThisStep;
      g.fallsThisStepHad = falls.length > 0 && !g.host;
      g.fallsThisStep = [];
      if (!falls.length || g.host) return;
      let ids = falls.map(p => p.id);
      let tie = 'none';
      if (falls.length > 1) {
        // меньше попаданий рывком — тот и ведёт; поровну — жребий
        const minHits = Math.min(...falls.map(p => p.hits));
        let pool = falls.filter(p => p.hits === minHits);
        tie = 'hits';
        if (pool.length > 1) {
          pool = [pool[Math.floor(rng() * pool.length)]];
          tie = 'lottery';
        }
        ids = [pool[0].id];
      }
      g.host = { id: ids[0], tie, at: g.clock, lottery: false };
      emit('host', { id: ids[0], tie });
      startReplayCapture();
    }

    function checkEnd() {
      if (g.phase !== 'fight' && g.phase !== 'overtime') return;
      const live = inPlay();
      if (!g.host && live.length <= 1) {
        // остальные сняты без падений (сеть, ушли) — ведущего решает жребий среди снятых
        const removed = g.players.filter(p => p.inGame && p.removed);
        if (removed.length) {
          const p = removed[Math.floor(rng() * removed.length)];
          g.host = { id: p.id, tie: 'lottery', at: g.clock, lottery: true };
          emit('host', { id: p.id, tie: 'lottery', lottery: true });
        }
      }
      if (g.host && live.length <= 1) return finish(live);
      if (g.host && g.clock >= cfg.FIGHT_T) return finish(live);
      if (g.phase === 'overtime' && g.clock >= cfg.FIGHT_T + cfg.OVERTIME_T && !g.host) {
        // лёд кончился раньше? на всякий случай — меньше попаданий среди живых, затем жребий
        const pool = live.length ? live : g.players.filter(p => p.inGame);
        const minHits = Math.min(...pool.map(p => p.hits));
        const cand = pool.filter(p => p.hits === minHits);
        const p = cand[Math.floor(rng() * cand.length)];
        g.host = { id: p.id, tie: 'lottery', at: g.clock, lottery: true };
        emit('host', { id: p.id, tie: 'lottery', lottery: true });
        return finish(live.filter(x => x !== p));
      }
    }

    function finish(live) {
      let kings = live;
      if (!kings.length) {
        // последние упали вместе — цари все, кто упал последним
        const last = Math.max(...g.players.filter(p => p.inGame && !p.removed && p.fellAt >= 0).map(p => p.fellAt));
        kings = g.players.filter(p => p.inGame && !p.removed && p.fellAt === last && p.id !== g.host.id);
      }
      g.kings = kings.map(p => p.id);
      // места: цари — 1, дальше по времени падения
      const played = g.players.filter(p => p.inGame);
      const order = played.slice().sort((a, b) => {
        const ta = g.kings.includes(a.id) ? 1e9 : a.fellAt, tb = g.kings.includes(b.id) ? 1e9 : b.fellAt;
        return tb - ta;
      });
      let place = 0, prev = null;
      order.forEach((p, k) => {
        const key = g.kings.includes(p.id) ? 'king' : p.fellAt;
        if (key !== prev) place = k + 1;
        prev = key;
        p.place = place;
      });
      const maxKos = Math.max(0, ...played.map(p => p.kos));
      g.stats = {
        duration: g.clock,
        pusher: maxKos > 0 ? played.filter(p => p.kos === maxKos).map(p => p.id) : [],
        maxKos,
        selfFallers: played.filter(p => p.selfFall).map(p => p.id),
        players: played.map(p => ({ id: p.id, name: p.name, place: p.place, kos: p.kos, hits: p.hits, fellAt: p.fellAt, selfFall: p.selfFall, removed: p.removed })),
      };
      setPhase('over');
      emit('over', { host: g.host, kings: g.kings, stats: g.stats });
    }

    // ----- Повтор первого падения -----
    function recordFrame() {
      const f = {
        t: g.clock,
        sh: g.shardSt.map(x => (x.st === 'c' ? 'c' + Math.round((x.t / x.dur) * 9) : x.st)).join(','),
        p: g.players.filter(p => p.inGame).map(p => [p.id, +p.x.toFixed(1), +p.y.toFixed(1), +p.vx.toFixed(1), +p.vy.toFixed(1), +p.dir.toFixed(2), p.st, p.dashT > 0 ? 1 : 0]),
      };
      g.frames.push(f);
      while (g.frames.length && f.t - g.frames[0].t > cfg.REPLAY_BEFORE + 0.05) g.frames.shift();
      if (g.replay && !g.replay.done) {
        g.replay.frames.push(f);
        if (f.t - g.replay.at >= cfg.REPLAY_AFTER) { g.replay.done = true; emit('replay', {}); }
      }
    }

    function startReplayCapture() {
      g.replay = { at: g.clock, host: g.host.id, frames: g.frames.slice(), done: false };
    }

    // ----- Шаг -----
    let acc = 0;
    function step(dt) {
      acc += Math.min(dt, 0.25);
      while (acc >= SUB - 1e-9) {
        acc -= SUB;
        sub(SUB);
      }
    }

    function sub(dt) {
      g.time += dt;
      g.phaseT += dt;
      const live = g.phase === 'lobby' || g.phase === 'fight' || g.phase === 'overtime';

      if (g.phase === 'countdown' && g.phaseT >= cfg.COUNTDOWN) {
        setPhase('fight');
        emit('go', {});
      }
      if (g.phase === 'fight' || g.phase === 'overtime') {
        g.clock += dt;
        if (g.phase === 'fight' && g.clock >= cfg.FIGHT_T && !g.host) {
          setPhase('overtime');
          g.nextOvertimeCrack = g.clock;
        }
      }

      // офлайн дольше OFFLINE_T — снимаем со льдины
      if (g.phase === 'fight' || g.phase === 'overtime' || g.phase === 'countdown') {
        for (const p of g.players) {
          if (p.inGame && p.st === 'ice' && !p.online && g.time - p.offlineSince >= cfg.OFFLINE_T) takeOff(p, 'offline');
        }
      }

      for (const p of g.players) {
        if (p.st === 'ice') {
          if (g.phase === 'countdown' || g.phase === 'over') { p.vx *= 0.9; p.vy *= 0.9; if (g.phase === 'countdown') continue; }
          const ctl = live && (g.phase === 'lobby' || p.inGame);
          integrate(p, dt, control(p, dt, ctl), ctl);
        } else {
          stepOut(p, dt);
        }
      }
      if (live) collide();
      if (g.phase === 'fight' || g.phase === 'overtime') melt();
      updateShards(dt);
      if (live) checkFooting();
      resolveFalls();
      // кадры повтора — 15 в секунду: клиент интерполирует, а память не раздувается
      g.subN = (g.subN || 0) + 1;
      const rec = g.subN % 4 === 0 || g.fallsThisStepHad;
      if (rec && (g.phase === 'fight' || g.phase === 'overtime' || (g.replay && !g.replay.done))) recordFrame();
      checkEnd();
    }

    function emit(type, data) {
      g.events.push(Object.assign({ type, t: g.time, clock: g.clock }, data));
      if (g.events.length > 2000) g.events.splice(0, 1000);
    }

    function drainEvents() {
      const e = g.events;
      g.events = [];
      return e;
    }

    function snapshot() {
      return {
        phase: g.phase,
        phaseT: +g.phaseT.toFixed(2),
        clock: +g.clock.toFixed(2),
        left: +Math.max(0, cfg.FIGHT_T - g.clock).toFixed(2),
        seed: g.seed,
        R: g.floe ? g.floe.R : 0,
        sh: g.shardSt.map(x => (x.st === 'c' ? 'c' + Math.round((x.t / x.dur) * 9) : x.st)).join(','),
        host: g.host,
        kings: g.kings,
        players: g.players.map(p => ({
          id: p.id, name: p.name, ci: p.ci, st: p.st, inGame: p.inGame, online: p.online,
          x: +p.x.toFixed(1), y: +p.y.toFixed(1), vx: +p.vx.toFixed(1), vy: +p.vy.toFixed(1), dir: +p.dir.toFixed(2),
          dash: p.dashT > 0 ? 1 : 0, cd: +(p.cd / cfg.DASH_CD).toFixed(2), fallT: +p.fallT.toFixed(2),
        })),
      };
    }

    Object.assign(g, {
      addPlayer, removePlayer, setOnline, setInput, start, toLobby, step, snapshot, drainEvents,
      onIce, shardAt, edgeInfo, floeCenter, solidArea, targetArea, inPlay, rng,
    });
    return g;
  }

  return { createGame, generateFloe, floeRadius, moveBody, mulberry32, pointInPoly, polyArea, DEFAULTS, SUB };
});
