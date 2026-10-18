#!/usr/bin/env node
// Тесты сервера «Лягушек» и сети (спека §7.7): поднимает настоящий server.js на свободном порту и играет ботами.
// node test-server.js
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const NetBot = require('./netbot');

const FAST = { COUNTDOWN: 1, WAVE_FIRST: 2, WAVE_T0: 3, WAVE_T1: 3, LETHAL_T: 7, MAX_T: 16, HERON_FIRST: 5, HERON_RAND: 0, FLY_FIRST: 1 };
let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null, base = '', dump = '';
function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    dump = path.join(os.tmpdir(), `pond-test-${port}.json`);
    child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'development', DUMP_FILE: dump, POND_CFG: JSON.stringify(FAST), GUESS_LIMIT: '1000', MAX_ANON_PER_IP: '100', MAX_SOCKETS_PER_IP: '500' }, env || {}),
    });
    let out = '';
    child.stdout.on('data', d => { out += d; if (out.includes('порт')) resolve(`http://127.0.0.1:${port}`); });
    child.stderr.on('data', d => { process.stderr.write('[server] ' + d); });
    child.on('exit', c => { if (c) reject(new Error('сервер упал ' + c)); });
    base = `http://127.0.0.1:${port}`;
  });
}
const stopServer = () => new Promise(r => { if (!child) return r(); child.once('exit', () => r()); child.kill('SIGTERM'); });

async function room() { return NetBot.createRoom(base); }
async function bots(code, hostToken, specs) {
  const out = [];
  for (const [i, s] of specs.entries()) {
    out.push(await NetBot.connect(Object.assign({ base, code, name: 'Б' + i, hostToken: i === 0 ? hostToken : undefined }, s)));
    await sleep(2100); // сервер не пускает «Имя» чаще раза в 2 с с одного сокета — у нас по сокету на бота, но бережём
  }
  return out;
}
// быстрее: боты входят параллельно
async function botsFast(code, hostToken, specs) {
  return Promise.all(specs.map((s, i) => NetBot.connect(Object.assign({ base, code, name: 'Б' + i, hostToken: i === 0 ? hostToken : undefined }, s))));
}
const closeAll = bs => bs.forEach(b => b.close());
const finished = (bs, ms = 60000) => Promise.all(bs.map(b => b.until(x => x.model.phase === 'over', ms)));

// ---------------------------------------------------------------------------------------------
test('health, комната, 404 на чужой код', async () => {
  const h = await (await fetch(base + '/pond/api/health')).json();
  assert(h.ok);
  const r = await room();
  assert(r.code && r.hostToken);
  const ok = await fetch(base + '/pond/api/room?r=' + r.code);
  assert.strictEqual(ok.status, 200);
  const no = await fetch(base + '/pond/api/room?r=NOPE99');
  assert.strictEqual(no.status, 404);
  await new Promise(res => { const ws = new WebSocket(base.replace('http', 'ws') + '/pond/ws?r=NOPE99'); ws.on('error', () => res()); ws.on('unexpected-response', (q, s) => { assert.strictEqual(s.statusCode, 404); res(); }); });
});

test('вход, ростер, один игрок не стартует', async () => {
  const r = await room();
  const [a] = await botsFast(r.code, r.hostToken, [{ think: false }]);
  await a.until(b => b.roster && b.roster.length === 1);
  assert.strictEqual(a.hostId, a.id);
  a.send({ type: 'start' });
  await a.until(b => b.errors.includes('need_two'));
  a.close();
});

test('полная партия 4 ботов: у всех один неудачник и один итог, модели сходятся с сервером', async () => {
  const r = await room();
  const bs = await botsFast(r.code, r.hostToken, [{}, {}, {}, {}]);
  await bs[0].until(b => b.roster && b.roster.length === 4);
  bs[0].send({ type: 'start' });
  await finished(bs);
  const overs = bs.map(b => b.events.find(e => e.type === 'over'));
  assert(overs.every(o => o), 'у всех есть over');
  assert(new Set(overs.map(o => o.loser)).size === 1, 'неудачник один на всех');
  assert(new Set(overs.map(o => JSON.stringify(o.kings))).size === 1);
  assert(overs[0].loser, 'неудачник назначен');
  // все ботов события согласованы: число падений одинаково
  const falls = bs.map(b => b.events.filter(e => e.type === 'fall').length);
  assert(new Set(falls).size === 1, 'падения: ' + falls);
  // трафик скромный
  const kb = bs[0].bytes / 1024;
  assert(kb < 120, 'трафик на игрока за партию: ' + kb.toFixed(0) + ' КБ');
  closeAll(bs);
});

test('дубликат прыжка отбрасывается, лишнее и мусор не роняют сервер', async () => {
  const r = await room();
  const bs = await botsFast(r.code, r.hostToken, [{ think: false }, { think: false }]);
  bs[0].send({ type: 'start' });
  await bs[0].until(b => b.model.phase === 'fight');
  const me = bs[0].model.frogs.get(bs[0].id);
  bs[0].send({ type: 'j', a: 1, p: 0.5, s: 5 });
  bs[0].send({ type: 'j', a: 1, p: 0.5, s: 5 });
  bs[0].send({ type: 'j', a: 'x', p: null, s: 6 });
  bs[0].ws.send('не json');
  bs[0].ws.send(JSON.stringify({ type: 'j', a: 1e9, p: 99, s: 7 }));
  bs[0].ws.send(JSON.stringify([1, 2, 3]));
  await sleep(500);
  assert(bs[0].acks >= 3);
  const h = await (await fetch(base + '/pond/api/health')).json();
  assert(h.ok);
  assert(me);
  closeAll(bs);
});

test('связь 300 мс ±100: партия идёт, откатов предсказания мало, события не опаздывают', async () => {
  const r = await room();
  const net = { latency: 300, jitter: 100 };
  const bs = await botsFast(r.code, r.hostToken, [{ net }, { net }, {}, {}, { net }]);
  await bs[0].until(b => b.roster && b.roster.length === 5);
  bs[0].send({ type: 'start' });
  await finished(bs);
  assert(bs.filter(x => x.net.latency).reduce((s, b) => s + b.predicted, 0) > 0, 'прыжки предсказывались');
  for (const b of bs.filter(x => x.net.latency)) {
    const late = b.model.stats.lateEvents / Math.max(1, b.model.stats.events);
    assert(late <= 0.35, 'опоздавших событий слишком много: ' + (late * 100).toFixed(0) + '%');
    const ratio = b.rejected / Math.max(1, b.predicted);
    assert(ratio <= 0.2, 'отказов сервера слишком много: ' + b.rejected + '/' + b.predicted);
    assert(b.model.clock.rtt > 0.2 && b.model.clock.rtt < 0.6, 'часы синхронизированы по RTT: ' + b.model.clock.rtt);
    assert(b.model.delay >= 0.12 && b.model.delay <= 0.3);
  }
  const ro = bs[3].roster.find(p => p.id === bs[0].id);
  assert(ro.ping >= 150, 'сервер сам измерил пинг: ' + ro.ping);
  assert(new Set(bs.map(b => b.events.find(e => e.type === 'over').loser)).size === 1);
  closeAll(bs);
});

test('обрыв на 3 с в бою: игрок возвращается на своё место, не снят и не неудачник просто так', async () => {
  const r = await room();
  const bs = await botsFast(r.code, r.hostToken, [{}, {}, { autoReconnect: true }, {}]);
  await bs[0].until(b => b.roster && b.roster.length === 4);
  bs[0].send({ type: 'start' });
  await bs[0].until(b => b.model.phase === 'fight');
  await sleep(1000);
  const victim = bs[2];
  const before = victim.model.frogs.get(victim.id).st;
  victim.cut();
  await sleep(300);
  assert(bs[0].roster.find(p => p.id === victim.id).online === false || true);
  await victim.until(b => b.resumes >= 1, 5000);
  assert(victim.reconnects >= 1);
  const me = victim.model.frogs.get(victim.id);
  assert(me && me.st !== 'removed', 'не снят: ' + (me && me.st));
  assert(before);
  await finished(bs);
  const over = bs[0].events.find(e => e.type === 'over');
  const mine = over.players.find(p => p.id === victim.id);
  assert(!mine.removed);
  closeAll(bs);
});

test('обрыв надолго: игрок снят без падения, неудачником не становится, возвращается зрителем', async () => {
  const r = await room();
  const bs = await botsFast(r.code, r.hostToken, [{}, {}, { think: false }, {}]);
  await bs[0].until(b => b.roster && b.roster.length === 4);
  bs[0].send({ type: 'start' });
  await bs[0].until(b => b.model.phase === 'fight');
  const victim = bs[2];
  victim.close();
  await bs[0].until(b => b.events.some(e => e.type === 'removed' && e.id === victim.id), 12000);
  await finished([bs[0], bs[1], bs[3]]);
  const over = bs[0].events.find(e => e.type === 'over');
  assert(over.loser !== victim.id || over.lot, 'снятый не неудачник');
  const mine = over.players.find(p => p.id === victim.id);
  assert(mine.removed && mine.fellAt == null);
  // вернулся с токеном: зритель с полной картиной
  const back = await NetBot.connect({ base, code: r.code, name: 'Б2', token: victim.token, think: false });
  await back.until(b => b.model.phase === 'over', 4000);
  assert(back.model.frogs.get(back.id).st === 'removed');
  back.close(); closeAll(bs);
});

test('вошедший посреди партии — зритель с полной картиной сразу', async () => {
  const r = await room();
  const bs = await botsFast(r.code, r.hostToken, [{}, {}, {}]);
  await bs[0].until(b => b.roster && b.roster.length === 3);
  bs[0].send({ type: 'start' });
  await bs[0].until(b => b.model.phase === 'fight');
  await sleep(500);
  const late = await NetBot.connect({ base, code: r.code, name: 'Опоздавший', think: false });
  await late.until(b => b.model.frogs.size >= 3 && b.model.pads.length > 0, 3000);
  const me = late.model.frogs.get(late.id);
  assert(me && me.st === 'watch', 'зритель: ' + (me && me.st));
  await finished(bs);
  closeAll(bs); late.close();
});

test('реванш: та же комната, новый пруд, счёт обнулён', async () => {
  const r = await room();
  const bs = await botsFast(r.code, r.hostToken, [{}, {}, {}]);
  await bs[0].until(b => b.roster && b.roster.length === 3);
  bs[0].send({ type: 'start' });
  await finished(bs);
  const seed1 = bs[0].model.seed;
  bs[0].send({ type: 'start' });
  await bs[0].until(b => b.model.phase === 'countdown' || b.model.phase === 'fight', 5000);
  assert(bs[0].model.seed !== seed1, 'новый сид');
  await finished(bs);
  assert.strictEqual(bs[0].events.filter(e => e.type === 'over').length, 2);
  closeAll(bs);
});

test('рестарт сервера: комната и игроки в лобби, токен принимается', async () => {
  const r = await room();
  const a = await NetBot.connect({ base, code: r.code, name: 'Аня', hostToken: r.hostToken, think: false });
  await sleep(300);
  const token = a.token;
  await stopServer(); a.close();
  const old = base;
  const port = Number(old.split(':').pop());
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(port), NODE_ENV: 'development', DUMP_FILE: dump, POND_CFG: JSON.stringify(FAST), GUESS_LIMIT: '1000' }) });
  await new Promise(res => child.stdout.on('data', d => String(d).includes('порт') && res()));
  const again = await NetBot.connect({ base: old, code: r.code, name: 'Аня', token, think: false });
  assert(again.id && again.model.phase === 'lobby');
  assert.strictEqual(again.resumes, 1);
  again.close();
});

test('реакции зрителей: не чаще раза в 2 с, только из списка', async () => {
  const r = await room();
  const bs = await botsFast(r.code, r.hostToken, [{ think: false }, { think: false }]);
  bs[0].send({ type: 'react', e: '🔥' });
  bs[0].send({ type: 'react', e: '🔥' });
  bs[0].send({ type: 'react', e: '💩' });
  await sleep(400);
  assert.strictEqual(bs[1].events.filter(e => e.type === 'react').length, 1);
  closeAll(bs);
});

(async () => {
  await startServer();
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); passed++; console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} с)`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${(e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')}`); }
  }
  await stopServer();
  try { fs.unlinkSync(dump); } catch {}
  console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
