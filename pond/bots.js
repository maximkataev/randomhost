/*
 * Боты «Лягушек»: играют через тот же g.input, что и люди. Нужны стенду (sim.js) и тестам.
 * Стили: спокойный, нервный, агрессор. Реакция на знак беды и разброс прицела — настоящие, а не идеальные.
 */
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module === 'object' ? require('./physics') : root.PondPhysics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PondBots = api;
})(typeof self !== 'undefined' ? self : this, function (P) {
'use strict';
const { jumpMax } = P;

const STYLES = {
  calm:  { react: [0.7, 1.5], aim: 0.05, stomp: 0.05 },
  jumpy: { react: [0.25, 0.7], aim: 0.10, stomp: 0.15 },
  brute: { react: [0.4, 1.1], aim: 0.07, stomp: 0.55 },
};
const STYLE_KEYS = Object.keys(STYLES);

function createBot(style, seed) {
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return { style: STYLES[style], rnd, due: null, seq: 0 };
}

// решение бота на этот тик: вернуть {ang,pow,seq} или null
function think(g, f, bot, dt) {
  if (f.st !== 'pad' || g.phase !== 'fight') { bot.due = null; return null; }
  if (g.t < f.readyAt) return null;
  const pad = g.pads[f.pad];
  const threatened = pad && pad.sinkAt != null;
  if (!threatened) { bot.due = null; return null; }
  if (bot.due == null) bot.due = g.t + bot.style.react[0] + bot.rnd() * (bot.style.react[1] - bot.style.react[0]);
  if (g.t < bot.due) return null;
  bot.due = null;

  const jm = jumpMax(g.R, g.cfg), jmin = g.cfg.JUMP_MIN, boost = f.boost ? g.cfg.FLY_BOOST : 1;
  const taken = new Set(g.players.filter(o => o !== f && (o.st === 'pad')).map(o => o.pad));
  const aimed = new Set(g.players.filter(o => o !== f && o.st === 'air').map(o => g.pads.find(p => Math.hypot(p.x - o.jump.tx, p.y - o.jump.ty) <= p.r + 6)).filter(Boolean).map(p => p.id));
  let best = null, bs = Infinity;
  for (const p of g.pads) {
    if (p.state !== 'ok' || p.sinkAt != null || p.id === f.pad) continue;
    const d = Math.hypot(p.x - f.x, p.y - f.y);
    if (d < jmin || d > jm * boost) continue;
    const occ = g.players.filter(o => o.st === 'pad' && o.pad === p.id).length;
    const full = occ >= p.cap || aimed.has(p.id);
    if (full && bot.rnd() > bot.style.stomp) continue;
    const score = d * (full ? 1.6 : 1) + bot.rnd() * 20;
    if (score < bs) { bs = score; best = p; }
  }
  if (!best) { // некуда — прыгнуть хоть куда-то подальше от беды
    best = g.pads.filter(p => p.state === 'ok' && p.id !== f.pad).sort((a, b) => Math.hypot(a.x - f.x, a.y - f.y) - Math.hypot(b.x - f.x, b.y - f.y))[0];
    if (!best) return null;
  }
  const dx = best.x - f.x, dy = best.y - f.y;
  const ang = Math.atan2(dy, dx) + (bot.rnd() - 0.5) * 2 * bot.style.aim;
  let d = Math.min(Math.hypot(dx, dy), jm * boost) * (1 + (bot.rnd() - 0.5) * bot.style.aim);
  d = d / boost;
  const pow = Math.max(0, Math.min(1, (d - jmin) / (jm - jmin)));
  return { ang, pow, seq: ++bot.seq };
}

return { createBot, think, STYLE_KEYS, STYLES };
});
