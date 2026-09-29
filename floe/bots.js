/*
 * Боты для «Царя льдины»: стенд (sim.js), песочница (floe-lab.html) и, позже, разминка в лобби.
 * Бот видит то же, что игрок на экране, и отдаёт тот же ввод: джойстик + рывок.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FloeBots = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // react — как часто бот пересматривает решение; margin — с какого расстояния до края он пугается;
  // aim — разброс направления (рад); dashRange — с какого расстояния бьёт рывком;
  // careful — не бьёт, если промах унесёт его в воду
  const STYLES = {
    aggressor: { react: 0.12, margin: 26, aim: 0.08, dashRange: 62, careful: 0.7, center: 0.15 },
    cautious:  { react: 0.12, margin: 40, aim: 0.08, dashRange: 48, careful: 1.0, center: 0.8 },
    hunter:    { react: 0.1,  margin: 30, aim: 0.06, dashRange: 58, careful: 0.9, center: 0.3, hunt: true },
    novice:    { react: 0.32, margin: 16, aim: 0.45, dashRange: 80, careful: 0.2, center: 0.1, wild: 0.25 },
  };
  const STYLE_KEYS = Object.keys(STYLES);

  function createBot(style) {
    return { style: STYLES[style] ? style : 'aggressor', t: 0, mx: 0, my: 0, dash: false, target: null };
  }

  function norm(x, y) {
    const l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  }

  // Возвращает ввод {mx, my, dash} для пингвина p. Зовётся каждый шаг, думает раз в react секунд.
  function think(g, p, bot, dt) {
    const S = STYLES[bot.style];
    const r = g.rng;
    bot.dash = false;
    if (p.st !== 'ice') { bot.mx = bot.my = 0; return bot; }
    if (g.phase !== 'lobby' && !(p.inGame && (g.phase === 'fight' || g.phase === 'overtime'))) { bot.mx = bot.my = 0; return bot; }
    bot.t -= dt;
    if (bot.t > 0) return bot;
    bot.t = S.react * (0.7 + 0.6 * r());

    const cfg = g.cfg;
    const c = g.floeCenter();
    const e = g.edgeInfo(p.x, p.y);
    const look = 0.3;
    const pe = g.edgeInfo(p.x + p.vx * look, p.y + p.vy * look);
    const si = g.shardAt(p.x, p.y);
    const onCrack = si >= 0 && g.shardSt[si].st === 'c';

    // 1. Опасность: край близко или лёд под ногами трескается — к центру
    if (pe.d < S.margin || e.d < S.margin * 0.7 || onCrack) {
      const [cx, cy] = norm(c[0] - p.x, c[1] - p.y);
      const [dx, dy] = norm(cx + e.nx * 1.2, cy + e.ny * 1.2);
      bot.mx = dx; bot.my = dy;
      return bot;
    }

    const others = g.players.filter(o => o !== p && o.st === 'ice' && (g.phase === 'lobby' || o.inGame));
    if (!others.length) {
      const [dx, dy] = norm(c[0] - p.x, c[1] - p.y);
      const d = Math.hypot(c[0] - p.x, c[1] - p.y);
      bot.mx = d > 12 ? dx * 0.6 : 0; bot.my = d > 12 ? dy * 0.6 : 0;
      return bot;
    }

    // 2. Цель
    let tgt = null, best = 1e9;
    for (const o of others) {
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      const score = S.hunt ? d * 0.5 + g.edgeInfo(o.x, o.y).d * 1.2 : d;
      if (score < best) { best = score; tgt = o; }
    }
    bot.target = tgt.id;
    const dx = tgt.x - p.x, dy = tgt.y - p.y, dist = Math.hypot(dx, dy);

    // осторожный держится центра и ждёт, пока соперник сам подойдёт
    const te = g.edgeInfo(tgt.x, tgt.y).d;
    if (S.center > 0.5 && dist > S.dashRange * 1.3 && te > 35) {
      const cd = Math.hypot(c[0] - p.x, c[1] - p.y);
      const [cx, cy] = norm(c[0] - p.x, c[1] - p.y);
      bot.mx = cd > 15 ? cx * 0.7 : 0; bot.my = cd > 15 ? cy * 0.7 : 0;
      return bot;
    }

    // заходим со стороны центра: толкать цель надо наружу
    const [ox, oy] = norm(tgt.x - c[0], tgt.y - c[1]);
    const gx = tgt.x - ox * 14 - p.x, gy = tgt.y - oy * 14 - p.y;
    let [mx, my] = norm(gx, gy);
    const noise = (r() - 0.5) * 2 * S.aim;
    const cs = Math.cos(noise), sn = Math.sin(noise);
    [mx, my] = [mx * cs - my * sn, mx * sn + my * cs];
    bot.mx = mx; bot.my = my;

    // 3. Рывок
    if (p.cd <= 0 && p.dashT <= 0) {
      let want = dist < S.dashRange;
      if (S.wild && r() < S.wild * 0.3) want = true;
      if (want) {
        // куда унесёт при промахе
        const reach = cfg.DASH_V * cfg.DASH_T + (cfg.DASH_V / cfg.DRAG) * 0.55;
        const [ux, uy] = norm(dx, dy);
        const land = g.edgeInfo(p.x + ux * reach, p.y + uy * reach).d;
        const risky = land < 0 && dist > 28;
        if (!risky || r() > S.careful) {
          let [ax, ay] = [ux, uy];
          const n2 = (r() - 0.5) * 2 * S.aim;
          [ax, ay] = [ax * Math.cos(n2) - ay * Math.sin(n2), ax * Math.sin(n2) + ay * Math.cos(n2)];
          bot.mx = ax; bot.my = ay;
          bot.dash = true;
          bot.t = 0.2;
        }
      }
    }
    return bot;
  }

  return { STYLES, STYLE_KEYS, createBot, think };
});
