/*
 * Боты «Утиного сплава»: витрина на главном экране и стенд (sim.js). Рулят так же, как люди, — одним рулём.
 * Смотрят вперёд по течению, выбирают, куда держать: быстрая вода, мимо камней, брёвен, водоворотов и кувшинок.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RapidsBots = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const STYLES = {
    // tb: [через сколько секунд после готовности жмёт, шанс нажать в безопасный момент, дальность проверки пути]
    pro:    { look: [70, 140, 220], react: 0.08, noise: 0.05, gain: 1.0, tb: [0.15, 1.0, 230] },
    casual: { look: [60, 120],      react: 0.25, noise: 0.15, gain: 0.8, tb: [0.7, 0.8, 180] },
    novice: { look: [50, 90],       react: 0.45, noise: 0.35, gain: 0.6, tb: [1.6, 0.5, 120] },
    bully:  { look: [60, 130],      react: 0.15, noise: 0.1,  gain: 0.9, bully: true, tb: [0.3, 0.9, 150] },
  };
  const STYLE_KEYS = Object.keys(STYLES);

  function createBot(style, seed) {
    let a = (seed || Math.floor(Math.random() * 1e9)) >>> 0;
    const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return { style: STYLES[style] ? style : 'casual', s: STYLES[style] || STYLES.casual, rnd, tx: null, wait: 0, steer: 0, wob: rnd() * 6 };
  }

  // насколько плохо оказаться в точке (x, y): 0 — чисто
  function danger(c, cfg, x, y) {
    let p = 0;
    const R = cfg.DR;
    for (const r of c.rocks) {
      if (Math.abs(r.y - y) > 50) continue;
      const d = Math.hypot(r.x - x, r.y - y) - r.r - R;
      if (d < 10) p += 3 - Math.max(0, d) * 0.2;
    }
    for (const L of c.logs) {
      if (y < Math.min(L.y1, L.y2) - 30 || y > Math.max(L.y1, L.y2) + 30) continue;
      const ex = L.x2 - L.x1, ey = L.y2 - L.y1;
      const t = clamp(((x - L.x1) * ex + (y - L.y1) * ey) / (ex * ex + ey * ey), 0, 1);
      const d = Math.hypot(x - (L.x1 + ex * t), y - (L.y1 + ey * t)) - L.r - R;
      if (d < 12) p += 4 - Math.max(0, d) * 0.25;
    }
    for (const q of c.pools) {
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < q.r * 0.8) p += 5;
      else if (d < q.r * 1.35) p += 1.2;
    }
    return p;
  }

  function think(g, d, bot, dt) {
    const c = g.course, cfg = g.cfg;
    const s = bot.s;
    bot.wait -= dt;
    if (bot.wait <= 0) {
      bot.wait = s.react * (0.6 + bot.rnd() * 0.8);
      const best = { score: -1e9, x: d.x };
      const N = 15;
      const far = s.look[s.look.length - 1];
      const yA = d.y + far;
      const cxA = c.riverCx(yA), hwA = c.riverHw(yA) - cfg.DR - 6;
      for (let i = 0; i < N; i++) {
        const lat = -0.9 + (1.8 * i) / (N - 1);
        let score = 0;
        for (const L of s.look) {
          const y = d.y + L;
          const x = c.riverCx(y) + lat * (c.riverHw(y) - cfg.DR - 6);
          // по пути от себя до точки — линейно
          const k = L / far;
          const px = d.x + (x - d.x) * Math.min(1, k * 1.4);
          score += c.water(px, y)[2] * 2;
          score -= danger(c, cfg, px, y) * 2.2;
          score -= c.overLily(px, y) ? 0.6 : 0;
        }
        // не дёргаться без причины
        const tx = cxA + lat * hwA;
        score -= Math.abs(tx - d.x) * 0.002;
        if (bot.tx != null) score -= Math.abs(tx - bot.tx) * 0.0015;
        if (s.bully) {
          for (const o of g.players) {
            if (o === d || !o.inGame || o.st !== 'w') continue;
            if (Math.abs(o.y - d.y) < 50 && Math.abs(o.x - tx) < 30) score += 0.8;
          }
        }
        score += (bot.rnd() - 0.5) * s.noise * 4;
        if (score > best.score) { best.score = score; best.x = tx; }
      }
      bot.tx = best.x;
    }
    let tx = bot.tx == null ? d.x : bot.tx;
    // бревно впереди перекрывает путь — к свободному концу (x2), с запасом
    for (const L of c.logs) {
      const top = Math.min(L.y1, L.y2);
      if (top > d.y + 170 || Math.max(L.y1, L.y2) < d.y - 20) continue;
      const lo = Math.min(L.x1, L.x2), hi = Math.max(L.x1, L.x2);
      const s2 = Math.sign(L.x2 - L.x1);
      const free = L.x2 + s2 * (cfg.DR + 22);
      const blocked = (x) => x > lo - cfg.DR && x < hi + cfg.DR && (s2 > 0 ? x < free : x > free);
      if (blocked(d.x) || blocked(tx)) { tx = free; break; }
    }
    const [tdx, tdy] = c.riverDir(d.y);
    const latV = d.vx * tdy - d.vy * tdx;
    let st = ((tx - d.x) / 35 - latV / 120) * s.gain;
    st += Math.sin(g.time * 1.3 + bot.wob) * s.noise * 0.4;
    bot.steer = clamp(st, -1, 1);
    return bot.steer;
  }

  // Жать ли рывок сейчас: кнопка готова, а путь вперёд по текущему курсу чистый — иначе рывок в камень
  // или в водоворот только вредит. Боты разные: профи жмёт сразу, новичок — не всегда и с запозданием.
  function wantTurbo(g, d, bot, dt) {
    if (g.phase !== 'race' || d.st !== 'w' || d.turboCd > 0 || (d.turbo || 0) > 0) { bot.tbWait = null; return false; }
    const [wait, chance, far] = bot.s.tb;
    if (bot.tbWait == null) bot.tbWait = wait * (0.6 + bot.rnd() * 0.8);
    bot.tbWait -= dt;
    if (bot.tbWait > 0) return false;
    const c = g.course, cfg = g.cfg;
    // куда уйдёт утка: вперёд по реке, с поправкой на то, куда рулит
    const tx = bot.tx == null ? d.x : bot.tx;
    for (let L = 30; L <= far; L += 30) {
      const y = d.y + L;
      const k = Math.min(1, L / 140);
      const x = d.x + (tx - d.x) * k;
      if (danger(c, cfg, x, y) > 0 || c.overLily(x, y)) { bot.tbWait = 0.15; return false; }
    }
    if (bot.rnd() > chance) { bot.tbWait = 0.5; return false; }
    bot.tbWait = null;
    return true;
  }

  return { createBot, think, wantTurbo, STYLES, STYLE_KEYS };
});
