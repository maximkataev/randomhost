#!/usr/bin/env node
/*
 * Стенд «Царя льдины»: партии ботов без сети, быстрее реального времени.
 *   node sim.js            — все замеры (по 300 партий на состав)
 *   node sim.js 100        — по 100 партий
 * Цели — floe-battle-spec.md §11.
 */
'use strict';
const { createGame } = require('./game');
const Bots = require('./bots');

const GAMES = Number(process.argv[2]) || 300;
// SIM_CFG='{"DASH_HIT":150}' node sim.js — прогон с другими настройками
const CFG = process.env.SIM_CFG ? JSON.parse(process.env.SIM_CFG) : undefined;

function play(n, styles, seed, cfg) {
  const g = createGame({ seed, cfg });
  const bots = new Map();
  for (let i = 0; i < n; i++) {
    g.addPlayer('p' + i, 'P' + i, i);
    bots.set('p' + i, Bots.createBot(styles[i % styles.length]));
  }
  g.start();
  const dt = 1 / 30;
  let firstFall = null, overtime = false;
  for (let k = 0; k < 30 * 90 && g.phase !== 'over'; k++) {
    for (const p of g.players) {
      const b = Bots.think(g, p, bots.get(p.id), dt);
      g.setInput(p.id, b.mx, b.my, b.dash);
    }
    g.step(dt);
    for (const e of g.drainEvents()) {
      if (e.type === 'host' && firstFall === null) firstFall = e.clock;
      if (e.type === 'phase' && e.phase === 'overtime') overtime = true;
    }
  }
  return {
    over: g.phase === 'over',
    dur: g.clock,
    firstFall,
    overtime,
    host: g.host && g.host.id,
    tie: g.host && g.host.tie,
    kings: g.kings.length,
    self: g.stats ? g.stats.selfFallers.length : 0,
    hostSelf: g.stats ? g.stats.players.find(p => p.id === (g.host && g.host.id))?.selfFall : null,
  };
}

const q = (arr, k) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(k * s.length))]; };
const pct = (x) => (100 * x).toFixed(1) + '%';

function report(label, n, styles, cfg) {
  const res = [];
  const hostCount = new Map();
  for (let i = 0; i < GAMES; i++) {
    const r = play(n, styles, 1000 + i * 7919 + n * 13, cfg || CFG);
    res.push(r);
    hostCount.set(r.host, (hostCount.get(r.host) || 0) + 1);
  }
  const dur = res.map(r => r.dur), ff = res.map(r => r.firstFall ?? 99);
  const ot = res.filter(r => r.overtime).length / GAMES;
  const ties = res.filter(r => r.tie && r.tie !== 'none').length / GAMES;
  const selfHost = res.filter(r => r.hostSelf).length / GAMES;
  const notOver = res.filter(r => !r.over).length;
  const byStyle = {};
  for (let i = 0; i < n; i++) {
    const st = styles[i % styles.length];
    byStyle[st] = byStyle[st] || { seats: 0, hosts: 0 };
    byStyle[st].seats++;
    byStyle[st].hosts += hostCount.get('p' + i) || 0;
  }
  const seatRates = [...Array(n)].map((_, i) => (hostCount.get('p' + i) || 0) / GAMES);
  console.log(`\n${label} — ${n} игроков, ${GAMES} партий`);
  console.log(`  длительность: медиана ${q(dur, 0.5).toFixed(1)} с, p90 ${q(dur, 0.9).toFixed(1)} с, p95 ${q(dur, 0.95).toFixed(1)} с; добивание ${pct(ot)}${notOver ? `; НЕ ЗАКОНЧИЛИСЬ: ${notOver}` : ''}`);
  console.log(`  первое падение: медиана ${q(ff, 0.5).toFixed(1)} с, p10 ${q(ff, 0.1).toFixed(1)}, p90 ${q(ff, 0.9).toFixed(1)}; одновременных ${pct(ties)}; ведущий упал сам ${pct(selfHost)}`);
  console.log(`  ведёт по стилям: ` + Object.entries(byStyle).map(([k, v]) => `${k} ${pct(v.hosts / GAMES / v.seats)} на место`).join(', ') + `  (база ${pct(1 / n)})`);
  if (new Set(styles).size === 1) {
    const dev = Math.max(...seatRates.map(x => Math.abs(x - 1 / n)));
    console.log(`  разброс по местам: макс. отклонение от 1/N ${(dev * 100).toFixed(1)} п.п.`);
  }
  return res;
}

if (require.main === module) {
  const t0 = Date.now();
  for (const n of [2, 4, 6, 8, 12]) report('Все агрессоры', n, ['aggressor']);
  report('Смесь стилей', 6, ['aggressor', 'cautious', 'hunter', 'novice', 'aggressor', 'hunter']);
  report('Один новичок против агрессоров', 6, ['novice', 'aggressor', 'aggressor', 'aggressor', 'aggressor', 'aggressor']);
  report('Все осторожные', 6, ['cautious']);
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} с)`);
}

module.exports = { play, report };
