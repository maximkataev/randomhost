/*
 * «Лягушки на кувшинках» — формулы прыжка и раскладка пруда. Общий файл сервера и клиента:
 * Node (require) и браузер (window.PondPhysics). Всё считается из чисел события, позиции по сети не ходят.
 * Координаты: центр пруда (0,0), радиус R(n). Спека — docs/frog-pond-spec.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PondPhysics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
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
    PAD_R: 34,          // обычная кувшинка (1 лягушка)
    PAD_BIG_R: 54,      // большая (2 лягушки)
    PAD_GAP: 18,        // минимальный зазор между краями кувшинок
    BIG_SHARE: 0.2,     // доля больших
    PADS_K: 1.6,        // кувшинок на старте: ceil(n*PADS_K)+PADS_ADD
    PADS_ADD: 2,
    LINK_K: 0.85,       // соседние кувшинки достижимы, если зазор <= LINK_K * JUMP_MAX
    JUMP_MIN: 36,       // короче прыгать нельзя
    JUMP_MAX_K: 0.8,    // JUMP_MAX = JUMP_MAX_K * R (= 40% диаметра пруда)
    FLIGHT_MIN: 0.35,   // время полёта на самый короткий прыжок
    FLIGHT_MAX: 0.7,    // на самый длинный
    LAND_SLACK: 6,      // допуск попадания в круг кувшинки
    FLY_BOOST: 1.4,     // муха: следующий прыжок дальше во столько раз
    CROUCH: 0.25,       // приседание после посадки
  };

  const pondRadius = n => 140 + 42 * Math.sqrt(Math.max(2, n));
  const jumpMax = (R, cfg) => (cfg || DEFAULTS).JUMP_MAX_K * R;

  // dist — явная дальность (вынужденный прыжок вытесненной лягушки), иначе по силе pow 0..1
  function jumpPlan(x0, y0, ang, pow, boost, R, cfg, dist) {
    cfg = cfg || DEFAULTS;
    const jm = jumpMax(R, cfg);
    let d, p;
    if (dist != null) { d = dist; p = clamp((d - cfg.JUMP_MIN) / (jm - cfg.JUMP_MIN), 0, 1); }
    else { p = clamp(pow, 0, 1); d = (cfg.JUMP_MIN + p * (jm - cfg.JUMP_MIN)) * (boost ? cfg.FLY_BOOST : 1); }
    return {
      x0, y0, ang, tx: x0 + Math.cos(ang) * d, ty: y0 + Math.sin(ang) * d, dist: d,
      dur: cfg.FLIGHT_MIN + p * (cfg.FLIGHT_MAX - cfg.FLIGHT_MIN),
    };
  }
  // положение в полёте: u 0..1; z — высота дуги для рисования
  function jumpPos(plan, u) {
    u = clamp(u, 0, 1);
    return { x: plan.x0 + (plan.tx - plan.x0) * u, y: plan.y0 + (plan.ty - plan.y0) * u, z: 4 * u * (1 - u) * (18 + plan.dist * 0.28) };
  }

  const gapOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;

  function connected(pads, maxGap) {
    if (!pads.length) return false;
    const seen = new Set([0]), q = [0];
    while (q.length) {
      const i = q.pop();
      for (let j = 0; j < pads.length; j++) if (!seen.has(j) && gapOf(pads[i], pads[j]) <= maxGap) { seen.add(j); q.push(j); }
    }
    return seen.size === pads.length;
  }

  // Раскладка по сиду и числу лягушек: сервер и клиент получают один и тот же пруд.
  function makeLayout(seed, n, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    const R0 = pondRadius(n);
    const want = Math.ceil(n * cfg.PADS_K) + cfg.PADS_ADD;
    const bigs = Math.round(want * cfg.BIG_SHARE);
    const rnd = mulberry32(seed >>> 0);
    let best = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      // не влезли — пруд чуть больше (на 4% каждые 10 попыток), всё детерминированно по сиду
      const R = R0 * (1 + 0.04 * Math.floor(attempt / 10));
      const maxGap = cfg.LINK_K * jumpMax(R, cfg);
      const pads = [];
      for (let i = 0; i < want; i++) {
        const big = i < bigs, r = big ? cfg.PAD_BIG_R : cfg.PAD_R;
        for (let tr = 0; tr < 400; tr++) {
          const a = rnd() * TAU, d = Math.sqrt(rnd()) * (R - r - 6);
          const c = { id: pads.length, x: Math.cos(a) * d, y: Math.sin(a) * d, r, cap: big ? 2 : 1, big };
          if (pads.every(p => gapOf(p, c) >= cfg.PAD_GAP)) { pads.push(c); break; }
        }
      }
      if (pads.length === want && connected(pads, maxGap)) return { R, pads };
      if (!best || pads.length > best.pads.length) best = { R, pads };
    }
    return best;
  }

  // кувшинка, в круг которой попадает точка (с допуском); живость проверяет движок
  function padAt(pads, x, y, cfg) {
    const slack = (cfg || DEFAULTS).LAND_SLACK;
    let hit = null, hd = Infinity;
    for (const p of pads) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= p.r + slack && d < hd) { hit = p; hd = d; }
    }
    return hit;
  }

  return { DEFAULTS, TAU, clamp, mulberry32, pondRadius, jumpMax, jumpPlan, jumpPos, makeLayout, padAt, gapOf };
});
