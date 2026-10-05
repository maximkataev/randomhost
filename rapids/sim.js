// Стенд: заплывы ботами без сети. node sim.js [заплывов] [уток]
// Другие настройки движка: SIM_CFG='{"FLOW":180}' node sim.js
const { createGame } = require('./game');
const { createBot, think, STYLE_KEYS } = require('./bots');

const RUNS = Number(process.argv[2] || 200);
const N = Number(process.argv[3] || 6);
const CFG = process.env.SIM_CFG ? JSON.parse(process.env.SIM_CFG) : {};
const DT = 1 / 20;

const champT = [], lastT = [], spread = [];
let timeUps = 0, stuck = 0, bumps = 0, whirls = 0, rocks = 0;
const lastByStyle = {}, winByStyle = {};
for (let r = 0; r < RUNS; r++) {
  const g = createGame({ seed: 1000 + r, cfg: CFG });
  const bots = new Map();
  for (let i = 0; i < N; i++) {
    const style = STYLE_KEYS[(i + r) % STYLE_KEYS.length];
    g.addPlayer('b' + i, 'B' + i, i);
    bots.set('b' + i, createBot(style, r * 31 + i));
  }
  g.start();
  let over = null, guard = 0;
  while (!over && guard++ < 20 * 120) {
    for (const p of g.players) g.setInput(p.id, think(g, p, bots.get(p.id), DT));
    g.step(DT);
    for (const e of g.drainEvents()) {
      if (e.type === 'over') over = e;
      if (e.type === 'bump') bumps++;
      if (e.type === 'whirl') whirls++;
      if (e.type === 'rock') rocks++;
    }
  }
  if (!over) { stuck++; continue; }
  if (over.host.timeUp) timeUps++;
  const ps = over.stats.players;
  const fin = ps.filter(p => p.time != null);
  if (fin.length) champT.push(fin[0].time);
  // время последнего — когда доплыл предпоследний (на этом заплыв кончается)
  lastT.push(g.clock);
  if (fin.length > 1) spread.push(fin[fin.length - 1].time - fin[0].time);
  const st = (id) => bots.get(id).style;
  lastByStyle[st(over.host.id)] = (lastByStyle[st(over.host.id)] || 0) + 1;
  winByStyle[st(over.champion)] = (winByStyle[st(over.champion)] || 0) + 1;
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f = (a) => `ср ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} · p10 ${q(a, 0.1).toFixed(1)} · p90 ${q(a, 0.9).toFixed(1)} · max ${q(a, 1).toFixed(1)}`;
console.log(`заплывов ${RUNS}, уток ${N}${Object.keys(CFG).length ? ', cfg ' + JSON.stringify(CFG) : ''}`);
console.log(`чемпион, с:        ${f(champT)}`);
console.log(`конец заплыва, с:  ${f(lastT)}`);
console.log(`разрыв 1-го и предпоследнего, с: ${f(spread)}`);
console.log(`по пределу времени: ${timeUps}, зависли: ${stuck}`);
console.log(`на заплыв: толчков ${(bumps / RUNS).toFixed(1)}, водоворотов ${(whirls / RUNS).toFixed(1)}, камней ${(rocks / RUNS).toFixed(1)}`);
console.log('побеждает:', winByStyle, ' ведёт дейлик:', lastByStyle);
