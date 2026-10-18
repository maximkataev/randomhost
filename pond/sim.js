// Стенд: партии ботов без сети. node sim.js [партий] [лягушек]
// Другие настройки: SIM_CFG='{"LETHAL_T":30}' node sim.js
'use strict';
const { createGame } = require('./game');
const { createBot, think, STYLE_KEYS } = require('./bots');

const RUNS = Number(process.argv[2] || 200);
const N = Number(process.argv[3] || 8);
const CFG = process.env.SIM_CFG ? JSON.parse(process.env.SIM_CFG) : {};
const DT = 1 / 20;

const dur = [], firstFall = [], stuck = [], draws = [];
let stomps = 0, herons = 0, flies = 0, rescued = 0, falls = { wave: 0, heron: 0, miss: 0, stomp: 0 }, lots = 0;
const loserBy = {}, loserPos = new Array(N).fill(0), winBy = {};
for (let r = 0; r < RUNS; r++) {
  const g = createGame({ seed: 5000 + r, cfg: CFG, rng: (() => { let s = r * 7919 + 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; })() });
  const bots = new Map(), style = new Map();
  for (let i = 0; i < N; i++) {
    const st = STYLE_KEYS[(i + r) % STYLE_KEYS.length];
    g.addPlayer('b' + i, 'B' + i, i); bots.set('b' + i, createBot(st, r * 31 + i)); style.set('b' + i, st);
  }
  g.start();
  let over = null, guard = 0, firstT = null;
  while (!over && guard++ < 20 * 200) {
    for (const f of g.players) {
      const m = think(g, f, bots.get(f.id), DT);
      if (m) g.input(f.id, m, 0.05);
    }
    g.step(DT);
    for (const e of g.drainEvents()) {
      if (e.type === 'over') over = e;
      if (e.type === 'stomp') stomps++;
      if (e.type === 'strike') herons++;
      if (e.type === 'fly') flies++;
      if (e.type === 'jump' && e.rescued) rescued++;
      if (e.type === 'fall') { falls[e.cause] = (falls[e.cause] || 0) + 1; if (firstT == null) firstT = e.t; }
    }
  }
  if (!over) { stuck.push(r); continue; }
  dur.push(over.t); if (firstT != null) firstFall.push(firstT);
  if (over.draw) draws.push(r);
  if (over.lot) lots++;
  if (over.loser) { const k = style.get(over.loser); loserBy[k] = (loserBy[k] || 0) + 1; loserPos[Number(over.loser.slice(1))]++; }
  for (const k of over.kings) winBy[style.get(k)] = (winBy[style.get(k)] || 0) + 1;
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : '-'; };
const avg = a => (a.reduce((s, x) => s + x, 0) / (a.length || 1)).toFixed(1);
console.log(`Партий: ${RUNS}, лягушек: ${N}, зависло: ${stuck.length}${stuck.length ? ' (' + stuck.slice(0, 5) + ')' : ''}, ничьих: ${draws.length}, жребиев за неудачника: ${lots}`);
console.log(`Длительность, с: средняя ${avg(dur)}, медиана ${q(dur, .5)}, p10 ${q(dur, .1)}, p90 ${q(dur, .9)}, макс ${q(dur, 1)}`);
console.log(`Первое падение, с: средняя ${avg(firstFall)}, p10 ${q(firstFall, .1)}, p90 ${q(firstFall, .9)}`);
console.log(`За партию: вытеснений ${(stomps / RUNS).toFixed(1)}, цапель ${(herons / RUNS).toFixed(1)}, мух ${(flies / RUNS).toFixed(1)}, «спасён в последний момент» ${(rescued / RUNS).toFixed(2)}`);
console.log('Падения по причинам:', JSON.stringify(falls));
console.log('Неудачник по стилю:', JSON.stringify(loserBy), ' по стартовому месту:', loserPos.join(' '));
console.log('Царь по стилю:', JSON.stringify(winBy));
