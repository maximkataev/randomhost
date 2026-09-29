/*
 * «Царь льдины» — отрисовка арены на canvas. Картинка перенесена из penguin-floe.html
 * (море, льдина из осколков, пингвины в шапках, всплески); одиночная страница не тронута.
 * Рисует снимок движка (FloeGame.snapshot или кадр повтора), сама ничего не решает.
 *
 *   const r = FloeRender.create(canvas, { me: 'id' });
 *   r.apply(snapshot, events);   // каждый кадр
 *   r.draw(t, dt);
 *
 * Нужен floe/game.js (FloeGame.generateFloe) — льдина строится по seed из снимка.
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rnd = Math.random;
  const rr = (a, b) => a + (b - a) * rnd();

  const YS = 0.74;      // сплющивание земли по вертикали — взгляд сверху под углом
  const ICE_TH = 9;     // толщина льда на экране
  const TH_W = ICE_TH / YS;
  const VIEW_DY = 14;
  const TEX_K = 3;

  // шапка: основной цвет, тёмный, помпон (как в penguin-floe.html)
  const HAT_COLORS = [
    ['#ff5a5a', '#c93636', '#ffe0e0'], ['#ffd23f', '#d9a800', '#fff6c8'], ['#5fd3d0', '#2a9f9c', '#e0fbfa'],
    ['#b79cff', '#8264e0', '#efe8ff'], ['#7fe07a', '#3fae3a', '#e2fbe0'], ['#ff9f43', '#d9731c', '#ffe6cc'],
    ['#ff8fb1', '#d9607f', '#ffe3ec'], ['#6f8cff', '#4461d6', '#e0e6ff'], ['#f6f2e8', '#bdb4a0', '#ff6b6b'],
    ['#c7e86b', '#93b83a', '#f5fbe0'], ['#e0a3f0', '#b06fc8', '#faeafd'], ['#ff7f6e', '#d45443', '#ffe0db'],
    ['#8ee8ff', '#4bb8d6', '#ffffff'], ['#ffc09f', '#df9068', '#fff0e6'], ['#55555f', '#2e2e36', '#ffd23f'],
    ['#2fbf71', '#1f8a50', '#ffffff'], ['#f7a8c8', '#cf7aa0', '#ffffff'], ['#e8cf9a', '#bfa062', '#7a5230'],
    ['#3aa0ff', '#1f6fc2', '#ffd23f'], ['#d94f9c', '#a8326f', '#ffffff'],
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // общая грань двух осколков получает одинаковый излом: шум зависит только от её концов
  function jaggedPath(poly) {
    const pts = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      pts.push(a);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 9) continue;
      const k1 = Math.round(a[0] * 3) * 7919 + Math.round(a[1] * 3) * 104729;
      const k2 = Math.round(b[0] * 3) * 7919 + Math.round(b[1] * 3) * 104729;
      const flip = k1 > k2;
      const r = mulberry32((flip ? k2 * 31 + k1 : k1 * 31 + k2) | 0);
      const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
      const segs = len > 26 ? 3 : 2;
      const offs = [];
      for (let s = 1; s < segs; s++) offs.push((r() - 0.5) * Math.min(5, len * 0.16));
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        const o = offs[flip ? segs - 1 - s : s - 1] * (flip ? -1 : 1);
        pts.push([a[0] + (b[0] - a[0]) * t + nx * o, a[1] + (b[1] - a[1]) * t + ny * o]);
      }
    }
    return pts;
  }

  // ----- Звук (синтез, как в одиночной игре; общий выключатель — sound-toggle.js) -----
  const Sound = (() => {
    let ac = null, noiseBuf = null;
    const last = {};
    const gate = (k, gap) => { const n = performance.now(); if (n - (last[k] || 0) < gap) return false; last[k] = n; return true; };
    function ensure() {
      if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ac = new AC(); }
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    }
    function tone(freq, dur, type, vol, delay = 0, endFreq = null) {
      if (!ac) return;
      try {
        const t0 = ac.currentTime + delay;
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t0);
        if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(ac.destination);
        o.start(t0); o.stop(t0 + dur + 0.05);
      } catch (e) {}
    }
    function noise(dur, f0, f1, vol, type = 'lowpass', delay = 0, q = 0.8) {
      if (!ac) return;
      try {
        if (!noiseBuf) {
          noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
          const ch = noiseBuf.getChannelData(0);
          for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
        }
        const t0 = ac.currentTime + delay;
        const src = ac.createBufferSource();
        src.buffer = noiseBuf;
        const f = ac.createBiquadFilter();
        f.type = type; f.Q.value = q;
        f.frequency.setValueAtTime(f0, t0);
        f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(f); f.connect(g); g.connect(ac.destination);
        src.start(t0, Math.random() * 1.2); src.stop(t0 + dur + 0.05);
      } catch (e) {}
    }
    function honk(pitch = 1, delay = 0) {
      if (!ac) return;
      try {
        for (let i = 0; i < 2; i++) {
          const t0 = ac.currentTime + delay + i * 0.13;
          const o = ac.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(420 * pitch, t0);
          o.frequency.linearRampToValueAtTime(610 * pitch, t0 + 0.05);
          o.frequency.exponentialRampToValueAtTime(350 * pitch, t0 + 0.11);
          const bp = ac.createBiquadFilter();
          bp.type = 'bandpass'; bp.Q.value = 3; bp.frequency.value = 1100 * pitch;
          const g = ac.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.32, t0 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
          o.connect(bp); bp.connect(g); g.connect(ac.destination);
          o.start(t0); o.stop(t0 + 0.15);
        }
      } catch (e) {}
    }
    return {
      ensure,
      splash() { if (!gate('splash', 90)) return; noise(0.42, 2400, 260, 0.18); tone(220, 0.16, 'sine', 0.11, 0, 70); },
      crack() { if (!gate('crack', 80)) return; noise(0.12, 6000, 2600, 0.16, 'highpass', 0, 0.7); noise(0.08, 5000, 2000, 0.1, 'highpass', 0.07, 0.7); tone(95, 0.3, 'sine', 0.16, 0, 45); },
      creak() { if (!gate('creak', 200)) return; noise(0.25, 3000, 1400, 0.05, 'bandpass', 0, 4); },
      hit(k = 1) { if (!gate('hit', 40)) return; noise(0.14, 1800, 300, 0.26 * k); tone(140, 0.14, 'sine', 0.3 * k, 0, 60); },
      clash() { if (!gate('hit', 40)) return; tone(300, 0.12, 'square', 0.12, 0, 150); noise(0.2, 2400, 400, 0.24); },
      bump() { if (!gate('bump', 90)) return; tone(150, 0.1, 'sine', 0.12, 0, 80); noise(0.08, 900, 300, 0.05); },
      dash() { if (!gate('dash', 60)) return; noise(0.3, 1200, 3600, 0.07, 'bandpass', 0, 1.4); },
      honk(p) { if (!gate('honk', 150)) return; honk(p || rr(0.9, 1.3)); },
      tick() { tone(660, 0.12, 'triangle', 0.18); },
      go() { tone(880, 0.12, 'square', 0.12); tone(1320, 0.3, 'square', 0.12, 0.1); },
      host() { tone(392, 0.22, 'triangle', 0.18); tone(311, 0.22, 'triangle', 0.18, 0.18); tone(233, 0.5, 'triangle', 0.18, 0.36); },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.26, 'triangle', 0.15, i * 0.11)); },
    };
  })();

  // ===================================================================
  function create(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    let view = { w: 0, h: 0, dpr: 1, base: 1 };
    const cam = { x: 0, y: 0, zoom: 1 };
    const shakeFx = { a: 0, x: 0, y: 0 };
    let me = opts.me || null;
    // надписи над пингвинами — со страницы, на языке интерфейса
    let words = Object.assign({ bang: 'БАХ!', graze: 'вскользь', miss: 'мимо', ouch: 'ОЙ!', ko: '+1 в воду!', splash: 'ПЛЮХ!', clash: 'ЛОБ В ЛОБ!' }, opts.words || {});
    const WC = { good: '#ffd23f', bad: '#ff5a5a', dim: '#cfe3f0', water: '#8ee8ff', white: '#ffffff' };
    // фокус камеры: ведущий дейлика на итоге (прожектор) или метка «смотрите сюда» в повторе
    let focus = null, focusMode = null, camSnap = false;
    let floe = null, floeKey = '';
    let shardVis = [];
    let iceTex = null, TEX_R = 200;
    let snap = null;
    const vis = new Map();
    const rings = [], drops = [], bursts = [], puffs = [], later = [], popups = [], pulses = [];
    const vignette = { hit: 0, color: '255,60,60' };
    let rim = null;           // края льдины для «опасно близко к воде»
    let danger = 0;
    let seaWaves = [];
    const snow = [];
    let simT = 0;

    const S = () => view.base * cam.zoom;
    const sx = (x) => view.w / 2 + shakeFx.x + (x - cam.x) * S();
    const sy = (y) => view.h / 2 + VIEW_DY + shakeFx.y + (y - cam.y) * S() * YS;

    function rrect(g, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }
    function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
    function ell(g, x, y, rx, ry, rot = 0) { g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, TAU); g.fill(); }

    function resize() {
      const w = Math.max(200, canvas.clientWidth);
      const h = Math.max(150, canvas.clientHeight);
      // на телефонах плотность пикселей ограничена 1,5: разница на глаз мала, а кадр вдвое дешевле
      const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
      const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
      const R = floe ? floe.R : 150;
      const top = h < 500 ? 44 : 70;   // место под таймер сверху
      const base = Math.min(w / (R * 2 * 1.14), (h - top) / (R * 2 * YS * 1.08 + 30));
      if (w === view.w && h === view.h && dpr === view.dpr && Math.abs(base - view.base) < 1e-6) return;
      view = { w, h, dpr, base };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (!seaWaves.length) {
        seaWaves = Array.from({ length: 80 }, () => ({ x: rnd(), y: rnd(), l: rr(8, 22), ph: rnd() * TAU, sp: rr(0.4, 1.2) }));
        for (let i = 0; i < 46; i++) snow.push({ x: rnd(), y: rnd(), r: rr(0.8, 2.2), sp: rr(10, 26), ph: rnd() * TAU });
      }
    }

    function setFloe(seed, R) {
      const key = seed + ':' + R;
      if (key === floeKey) return;
      floeKey = key;
      floe = root.FloeGame.generateFloe(seed, R);
      floe.shards.forEach(s => { s.path = jaggedPath(s.poly); });
      shardVis = floe.shards.map(() => ({ st: 's', p: 0, drift: null }));
      rim = null;
      TEX_R = R * 1.3;
      buildIceTexture(seed);
      view.w = 0;   // пересчитать масштаб под новый радиус
    }

    // ----- Текстура льда: снег, голубые проталины, царапины, искры -----
    function buildIceTexture(seed) {
      const size = Math.ceil(TEX_R * 2 * TEX_K);
      if (!iceTex) iceTex = document.createElement('canvas');
      iceTex.width = iceTex.height = size;
      const g = iceTex.getContext('2d');
      g.setTransform(TEX_K, 0, 0, TEX_K, size / 2, size / 2);
      const gr = g.createRadialGradient(-TEX_R * 0.3, -TEX_R * 0.35, 10, 0, 0, TEX_R);
      gr.addColorStop(0, '#fdffff');
      gr.addColorStop(0.55, '#e6f5fc');
      gr.addColorStop(1, '#c4e3f3');
      g.fillStyle = gr;
      g.fillRect(-TEX_R, -TEX_R, TEX_R * 2, TEX_R * 2);
      const r = mulberry32(seed ^ 0x5bd1e995);
      const k = (TEX_R / 195) * (TEX_R / 195);
      const blob = (x, y, rad, col, a) => {
        const gg = g.createRadialGradient(x, y, 0, x, y, rad);
        gg.addColorStop(0, col.replace('A', a));
        gg.addColorStop(1, col.replace('A', 0));
        g.fillStyle = gg;
        g.beginPath();
        g.ellipse(x, y, rad, rad * (0.55 + r() * 0.4), r() * TAU, 0, TAU);
        g.fill();
      };
      for (let i = 0; i < 16 * k; i++) blob((r() - 0.5) * TEX_R * 1.8, (r() - 0.5) * TEX_R * 1.8, 12 + r() * 30, 'rgba(120,190,230,A)', 0.3);
      for (let i = 0; i < 46 * k; i++) blob((r() - 0.5) * TEX_R * 1.9, (r() - 0.5) * TEX_R * 1.9, 8 + r() * 22, 'rgba(255,255,255,A)', 0.8);
      g.lineCap = 'round';
      for (let i = 0; i < 46 * k; i++) {
        const x = (r() - 0.5) * TEX_R * 1.8, y = (r() - 0.5) * TEX_R * 1.8, a = r() * TAU, l = 6 + r() * 18;
        g.strokeStyle = `rgba(110,170,210,${0.12 + r() * 0.18})`;
        g.lineWidth = 0.4 + r() * 0.5;
        g.beginPath();
        g.moveTo(x, y);
        g.quadraticCurveTo(x + Math.cos(a + 0.4) * l * 0.6, y + Math.sin(a + 0.4) * l * 0.6, x + Math.cos(a) * l, y + Math.sin(a) * l);
        g.stroke();
      }
      for (let i = 0; i < 160 * k; i++) {
        g.fillStyle = `rgba(255,255,255,${0.5 + r() * 0.5})`;
        circle(g, (r() - 0.5) * TEX_R * 1.9, (r() - 0.5) * TEX_R * 1.9, 0.3 + r() * 0.5);
      }
    }

    // ----- Снимок и события -----
    function floeCenter() {
      let x = 0, y = 0, a = 0;
      floe.shards.forEach((s, i) => { if (shardVis[i].st !== 'g') { x += s.cx * s.area; y += s.cy * s.area; a += s.area; } });
      return a ? [x / a, y / a] : [0, 0];
    }

    // quiet — без анимаций откола (переход в повтор и обратно)
    // расстояние до кромки для точки на льду (по граням, за которыми вода)
    function edgeDist(x, y) {
      if (!floe) return 99;
      if (!rim) {
        rim = [];
        floe.shards.forEach((s, i) => {
          if (shardVis[i].st === 'g') return;
          s.poly.forEach((p1, k) => {
            const nb = s.edgeNb[k];
            if (nb >= 0 && shardVis[nb].st !== 'g') return;
            const p2 = s.poly[(k + 1) % s.poly.length];
            rim.push([p1[0], p1[1], p2[0], p2[1]]);
          });
        });
      }
      let best = 1e12;
      for (const e of rim) {
        const ex = e[2] - e[0], ey = e[3] - e[1];
        const l2 = ex * ex + ey * ey || 1e-6;
        const t = clamp(((x - e[0]) * ex + (y - e[1]) * ey) / l2, 0, 1);
        const dx = x - e[0] - ex * t, dy = y - e[1] - ey * t;
        best = Math.min(best, dx * dx + dy * dy);
      }
      return Math.sqrt(best);
    }

    function apply(s, events, quiet) {
      snap = s;
      if (s.seed && s.R) setFloe(s.seed, s.R);
      if (floe && s.sh) {
        const parts = s.sh.split(',');
        const c = floeCenter();
        parts.forEach((v, i) => {
          const sv = shardVis[i];
          if (!sv) return;
          if ((v === 'g') !== (sv.st === 'g')) rim = null;
          if (v === 'g') {
            if (sv.st !== 'g' && !quiet) {
              const sh = floe.shards[i];
              const dx = sh.cx - c[0], dy = sh.cy - c[1], l = Math.hypot(dx, dy) || 1;
              sv.drift = { ox: 0, oy: 0, ang: 0, vx: (dx / l) * rr(12, 22), vy: (dy / l) * rr(12, 22), va: rr(-0.5, 0.5), sink: 0, t: 0 };
              for (const v2 of sh.poly) if (rnd() < 0.5) chips(v2[0], v2[1], 2, 0.8);
            }
            sv.st = 'g';
          } else if (v[0] === 'c') {
            sv.st = 'c'; sv.p = Number(v.slice(1)) / 9; sv.drift = null;
          } else {
            sv.st = 's'; sv.p = 0; sv.drift = null;
          }
        });
      }
      for (const p of s.players) {
        let v = vis.get(p.id);
        if (!v) { v = { walkPh: rnd() * TAU, bob: rnd() * TAU, face: 1, la: 0, lastSt: p.st, trail: 0, hist: [], streak: 0, streakC: '#fff', cd: p.cd }; vis.set(p.id, v); }
        if (p.st === 'ice' || p.st === 'fall') { v.hist.push([p.x, p.y]); if (v.hist.length > 16) v.hist.shift(); } else v.hist.length = 0;
        // свой рывок перезарядился — кольцо-вспышка
        if (p.id === me && v.cd > 0 && p.cd <= 0 && p.st === 'ice' && !quiet) pulses.push({ id: p.id, life: 0 });
        v.cd = p.cd;
        if (p.st !== v.lastSt) {
          if (!quiet && p.st === 'ice' && (v.lastSt === 'swim' || v.lastSt === 'fall')) poof(p.x, p.y);
          v.lastSt = p.st;
        }
      }
      for (const id of [...vis.keys()]) if (!s.players.some(p => p.id === id)) vis.delete(id);
      if (events) for (const e of events) onEvent(e);
    }

    const hatOf = (id) => { const p = snap && snap.players.find(q => q.id === id); return HAT_COLORS[(p ? p.ci : 0) % HAT_COLORS.length][0]; };
    const posOf = (id) => { const p = snap && snap.players.find(q => q.id === id); return p ? [p.x, p.y] : null; };
    // всплывающая надпись над точкой льда; big — для своих действий
    function popup(x, y, text, color, big, delay = 0) {
      popups.push({ x, y, text, color, big: !!big, life: -delay, max: big ? 1.15 : 0.85 });
      if (popups.length > 24) popups.shift();
    }

    function onEvent(e) {
      switch (e.type) {
        case 'hit': {
          const mine = e.a === me || (e.clash && e.b === me);
          const onMe = !e.clash && e.b === me;
          const vp = posOf(e.b) || [e.x, e.y];
          if (e.clash) {
            burst(e.x, e.y, 1.2, '#ffffff'); shake(mine ? 9 : 5); Sound.clash();
            if (mine) popup(e.x, e.y, words.clash, WC.white, true);
          } else {
            const pw = e.power || 1;
            burst(e.x, e.y, 0.6 + pw * 0.8, hatOf(e.a));
            shake(mine ? 6 + 6 * pw : 2 + 3 * pw);
            Sound.hit(0.6 + 0.4 * pw);
            const v = vis.get(e.b);
            if (v) { v.streak = 0.8; v.streakC = hatOf(e.a); v.hitAt = simT; }
            const va = vis.get(e.a);
            if (va) va.hitAt = simT;
            // надписи — только когда участвует свой пингвин, чужие драки не засоряют экран
            if (mine) popup(vp[0], vp[1], pw > 0.6 ? words.bang : words.graze, pw > 0.6 ? WC.good : WC.dim, true);
            else if (onMe) popup(vp[0], vp[1], words.ouch, WC.bad, true);
          }
          if (onMe) { vignette.hit = 0.55; vignette.color = '255,60,60'; }
          break;
        }
        case 'whiff':
          if (e.id === me) popup(e.x, e.y, words.miss, WC.dim, true);
          break;
        case 'bump': chips(e.x, e.y, 3, 0.6); Sound.bump(); break;
        case 'dash': Sound.dash(); if (e.id === me) shake(2); break;
        case 'fall':
          later.push({ at: simT + 0.22, fn: () => { splash(e.x, e.y, 16, 1.1); Sound.splash(); } });
          Sound.honk();
          if (!e.practice) shake(4);
          if (e.by && e.by === me) popup(e.x, e.y, words.ko, WC.good, true, 0.25);
          if (e.id === me) { popup(e.x, e.y, words.splash, WC.water, true, 0.2); vignette.hit = 0.6; vignette.color = '70,170,255'; }
          break;
        case 'crack': Sound.creak(); break;
        case 'sink': Sound.crack(); shake(1.5); break;
      }
    }

    // ----- Частицы -----
    function shake(a) { shakeFx.a = Math.max(shakeFx.a, a); }
    function addRing(x, y, a, grow = 26) { if (rings.length > 120) rings.shift(); rings.push({ x, y, r: 4, a, grow, life: 0 }); }
    function splash(x, y, n, power = 1) {
      for (let i = 0; i < n; i++) {
        if (drops.length > 400) drops.shift();
        const a = rnd() * TAU, sp = rr(20, 70) * power;
        drops.push({ x, y, z: 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rr(60, 150) * power, s: rr(1, 2.4), c: 'rgba(235,250,255,0.95)' });
      }
      addRing(x, y, 0.7, 34);
      addRing(x, y, 0.4, 20);
    }
    function chips(x, y, n, power = 1) {
      for (let i = 0; i < n; i++) {
        if (drops.length > 400) drops.shift();
        const a = rnd() * TAU, sp = rr(15, 60) * power;
        drops.push({ x, y, z: 1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rr(40, 110) * power, s: rr(0.9, 1.9), c: rnd() < 0.5 ? '#ffffff' : '#bfe8ff' });
      }
    }
    function burst(x, y, k, color) {
      bursts.push({ x, y, k, color, life: 0, rot: rnd() * TAU });
      chips(x, y, Math.round(4 + 5 * k), 0.9);
    }
    function poof(x, y) {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        puffs.push({ x, y, vx: Math.cos(a) * 40, vy: Math.sin(a) * 40, life: 0, max: 0.6, r: rr(3, 6) });
      }
    }

    function updateParticles(dt) {
      for (let i = later.length - 1; i >= 0; i--) if (simT >= later[i].at) { later[i].fn(); later.splice(i, 1); }
      for (let i = rings.length - 1; i >= 0; i--) { const r = rings[i]; r.life += dt; r.r += r.grow * dt; if (r.life > 1.2) rings.splice(i, 1); }
      for (let i = drops.length - 1; i >= 0; i--) {
        const p = drops[i];
        p.vz -= 380 * dt; p.z += p.vz * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.z <= 0) drops.splice(i, 1);
      }
      for (let i = bursts.length - 1; i >= 0; i--) if ((bursts[i].life += dt) > 0.38) bursts.splice(i, 1);
      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i];
        p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= Math.exp(-dt * 4); p.vy *= Math.exp(-dt * 4);
        if (p.life > p.max) puffs.splice(i, 1);
      }
      for (const sv of shardVis) {
        const d = sv.drift;
        if (!d) continue;
        d.t += dt;
        d.ox += d.vx * dt; d.oy += d.vy * dt; d.ang += d.va * dt;
        d.vx *= Math.exp(-dt * 0.5); d.vy *= Math.exp(-dt * 0.5);
        if (d.t > 0.15) d.sink = Math.min(1, d.sink + dt / 1.1);
        if (d.sink >= 1) sv.drift = null;
      }
      // след рывка — снежная пыль
      if (snap) for (const p of snap.players) {
        if (p.st !== 'ice') continue;
        const sp = Math.hypot(p.vx, p.vy);
        const v = vis.get(p.id);
        if (!v) continue;
        if (p.dash || sp > 150) {
          v.trail += dt * (p.dash ? 60 : 25);
          while (v.trail > 1) {
            v.trail -= 1;
            puffs.push({ x: p.x + rr(-4, 4), y: p.y + rr(-3, 3), vx: -p.vx * 0.1 + rr(-10, 10), vy: -p.vy * 0.1 + rr(-10, 10), life: 0, max: rr(0.3, 0.55), r: rr(2, 4) });
          }
        }
      }
      if (puffs.length > 300) puffs.splice(0, puffs.length - 300);
      for (let i = popups.length - 1; i >= 0; i--) if ((popups[i].life += dt) > popups[i].max) popups.splice(i, 1);
      for (let i = pulses.length - 1; i >= 0; i--) if ((pulses[i].life += dt) > 0.5) pulses.splice(i, 1);
      for (const v of vis.values()) if (v.streak > 0) v.streak = Math.max(0, v.streak - dt);
      vignette.hit = Math.max(0, vignette.hit - dt * 1.4);
      const mp = snap && me && snap.players.find(p => p.id === me);
      const live = snap && (snap.phase === 'fight' || snap.phase === 'overtime' || snap.phase === 'lobby');
      const d = mp && live && mp.st === 'ice' ? edgeDist(mp.x, mp.y) : 99;
      danger += ((d < 26 ? 1 - d / 26 : 0) - danger) * Math.min(1, dt * 10);
    }

    // ----- Камера: во время боя придвигается к оставшемуся льду -----
    function updateCamera(dt) {
      let tx = 0, ty = 0, tz = 1;
      if (floe && snap && (snap.phase === 'fight' || snap.phase === 'overtime' || snap.phase === 'over' || snap.phase === 'replay')) {
        const c = floeCenter();
        let rad = 0;
        floe.shards.forEach((s, i) => {
          if (shardVis[i].st === 'g') return;
          for (const v of s.poly) rad = Math.max(rad, Math.hypot(v[0] - c[0], v[1] - c[1]));
        });
        tx = c[0] * 0.85; ty = c[1] * 0.85;
        tz = clamp((floe.R * 1.1) / (rad + 40), 1, 2.3);
      }
      const fp = focus && focusMode === 'host' && snap && snap.players.find(p => p.id === focus);
      if (fp) {
        const c = floe ? floeCenter() : [0, 0];
        tx = lerp(fp.x, c[0], 0.4); ty = lerp(fp.y, c[1], 0.4) - 10;
        tz = clamp((view.h * 0.42) / ((Math.hypot(fp.x - c[0], (fp.y - c[1]) * YS) * 0.6 + 60) * view.base), 1, 1.8);
      }
      shakeFx.a *= Math.exp(-dt * 9);
      shakeFx.x = (rnd() - 0.5) * 2 * shakeFx.a;
      shakeFx.y = (rnd() - 0.5) * 2 * shakeFx.a;
      // после итога камера не «доезжает» секундами до отсчёта — прыгает на место сразу
      if (camSnap) { cam.x = tx; cam.y = ty; cam.zoom = tz; camSnap = false; return; }
      const k = 1 - Math.exp(-dt * 1.6);
      cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; cam.zoom += (tz - cam.zoom) * k;
    }

    // ----- Рисование -----
    function screenTransform() { ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); }
    function groundTransform() {
      const s = S(), d = view.dpr;
      ctx.setTransform(d * s, 0, 0, d * s * YS, d * (view.w / 2 + shakeFx.x - cam.x * s), d * (view.h / 2 + VIEW_DY + shakeFx.y - cam.y * s * YS));
    }

    function drawSea(t) {
      screenTransform();
      const { w, h } = view;
      const gr = ctx.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#0a3355');
      gr.addColorStop(1, '#051b31');
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, w, h);
      const R0 = floe ? floe.R : 150;
      const cx = sx(0), cy = sy(0), R = R0 * 1.5 * S();
      const halo = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R);
      halo.addColorStop(0, 'rgba(90,190,230,0.32)');
      halo.addColorStop(1, 'rgba(90,190,230,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.4;
      for (const v of seaWaves) {
        const px = ((v.x * w - cam.x * S() * 0.9 + t * 7 * v.sp) % w + w) % w;
        const py = ((v.y * h - cam.y * S() * YS * 0.9) % h + h) % h;
        const a = 0.08 + 0.08 * Math.sin(t * 1.3 + v.ph);
        if (a <= 0.01) continue;
        ctx.strokeStyle = `rgba(185,232,255,${a})`;
        const l = v.l * Math.min(1.4, S());
        ctx.beginPath();
        ctx.moveTo(px - l / 2, py);
        ctx.quadraticCurveTo(px, py - 3, px + l / 2, py);
        ctx.stroke();
      }
    }

    function tracePath(g, pts, dy = 0) {
      g.moveTo(pts[0][0], pts[0][1] + dy);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1] + dy);
      g.closePath();
    }

    function drawRings() {
      groundTransform();
      for (const r of rings) {
        const a = r.a * (1 - r.life / 1.2);
        if (a <= 0.01) continue;
        ctx.strokeStyle = `rgba(225,248,255,${a})`;
        ctx.lineWidth = 1.4 / S();
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, r.r, r.r, 0, 0, TAU);
        ctx.stroke();
      }
    }

    function drawDrifting(s, d) {
      const k = 1 - d.sink;
      ctx.save();
      ctx.translate(s.cx + d.ox, s.cy + d.oy + d.sink * TH_W);
      ctx.rotate(d.ang);
      ctx.translate(-s.cx, -s.cy);
      ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.6));
      ctx.fillStyle = '#3f8fba';
      ctx.beginPath();
      tracePath(ctx, s.path, TH_W * k);
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      tracePath(ctx, s.path);
      ctx.clip();
      ctx.drawImage(iceTex, -TEX_R, -TEX_R, TEX_R * 2, TEX_R * 2);
      ctx.fillStyle = `rgba(16,70,110,${Math.min(0.85, d.sink * 1.1)})`;
      ctx.fillRect(-TEX_R, -TEX_R, TEX_R * 2, TEX_R * 2);
      ctx.restore();
      ctx.strokeStyle = `rgba(230,250,255,${0.5 * k})`;
      ctx.lineWidth = 1.2 / S();
      ctx.beginPath();
      tracePath(ctx, s.path, TH_W * k);
      ctx.stroke();
      ctx.restore();
    }

    // Держащие осколки рисуются в отдельный слой и пересобираются, только когда льдина изменилась
    // или камера придвинулась так, что слою не хватает чёткости: кадр — один drawImage вместо сотни путей с клипом
    const layer = { cv: null, key: '', scale: 0, x0: 0, y0: 0, w: 0, h: 0 };
    function floeLayer() {
      const hold = floe.shards.filter((s, i) => shardVis[i].st !== 'g');
      const key = shardVis.map(v => (v.st === 'g' ? 'g' : 's')).join('') + ':' + floeKey;
      const need = Math.min(4, S() * view.dpr);
      if (layer.cv && key === layer.key && need <= layer.scale * 1.25 && need >= layer.scale / 1.8) return layer;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const s of hold) for (const v of s.path) { x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]); x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]); }
      if (!hold.length) { layer.key = key; layer.w = 0; return layer; }
      x0 -= 6; y0 -= 6; x1 += 6; y1 += TH_W + 8;
      let scale = Math.max(1, need);
      scale = Math.min(scale, 2048 / (x1 - x0), 2048 / (y1 - y0));
      if (!layer.cv) layer.cv = document.createElement('canvas');
      layer.cv.width = Math.ceil((x1 - x0) * scale);
      layer.cv.height = Math.ceil((y1 - y0) * scale);
      const g = layer.cv.getContext('2d');
      g.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
      g.fillStyle = 'rgba(220,246,255,0.35)';
      g.beginPath();
      for (const s of hold) tracePath(g, s.path, TH_W + 2.5);
      g.fill();
      g.fillStyle = '#3f8fba';
      g.beginPath();
      for (const s of hold) tracePath(g, s.path, TH_W);
      g.fill();
      g.fillStyle = '#7cc3e4';
      g.beginPath();
      for (const s of hold) tracePath(g, s.path, TH_W * 0.45);
      g.fill();
      g.save();
      g.beginPath();
      for (const s of hold) tracePath(g, s.path);
      g.clip();
      g.drawImage(iceTex, -TEX_R, -TEX_R, TEX_R * 2, TEX_R * 2);
      g.strokeStyle = 'rgba(120,180,215,0.28)';
      g.lineWidth = 0.8 / scale * 1.4;
      g.beginPath();
      for (const s of hold) tracePath(g, s.path);
      g.stroke();
      g.restore();
      Object.assign(layer, { key, scale, x0, y0, w: x1 - x0, h: y1 - y0 });
      return layer;
    }

    function drawFloe(t) {
      if (!floe) return;
      groundTransform();
      floe.shards.forEach((s, i) => { if (shardVis[i].drift) drawDrifting(s, shardVis[i].drift); });
      const L = floeLayer();
      if (!L.w) return;
      ctx.drawImage(L.cv, L.x0, L.y0, L.w, L.h);

      // трещины: светящаяся кромка и тёмный пунктир, дрожь нарастает к отколу
      floe.shards.forEach((s, i) => {
        const sv = shardVis[i];
        if (sv.st !== 'c') return;
        const p = clamp(sv.p, 0, 1);
        const jx = Math.sin(t * 70 + i) * 0.8 * p, jy = Math.cos(t * 63 + i) * 0.8 * p;
        ctx.save();
        ctx.translate(jx, jy);
        ctx.lineJoin = 'round';
        ctx.fillStyle = `rgba(90,190,240,${0.12 + 0.2 * p + 0.08 * Math.sin(t * 20)})`;
        ctx.beginPath();
        tracePath(ctx, s.path);
        ctx.fill();
        ctx.strokeStyle = `rgba(140,220,255,${0.45 + 0.45 * p})`;
        ctx.lineWidth = (3 + 3 * p) / S();
        ctx.beginPath();
        tracePath(ctx, s.path);
        ctx.stroke();
        ctx.strokeStyle = `rgba(20,70,110,${0.5 + 0.5 * p})`;
        ctx.lineWidth = (0.8 + 1.4 * p) / S();
        ctx.setLineDash([6 * p + 1, 2 + 3 * (1 - p)]);
        ctx.beginPath();
        tracePath(ctx, s.path);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      });
    }

    function drawCrown(g, x, y) {
      g.fillStyle = '#ffd23f';
      g.strokeStyle = '#c98a00';
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(x - 7, y + 3); g.lineTo(x - 7, y - 3); g.lineTo(x - 3.5, y); g.lineTo(x, y - 5);
      g.lineTo(x + 3.5, y); g.lineTo(x + 7, y - 3); g.lineTo(x + 7, y + 3);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#ff5a5a';
      circle(g, x, y - 5, 1.3);
    }

    function paintHat(g, c, x, y, s = 1) {
      g.fillStyle = c[0];
      g.beginPath();
      g.ellipse(x, y, 9 * s, 7 * s, 0, Math.PI, TAU);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.28)';
      ell(g, x - 3 * s, y - 4 * s, 3 * s, 1.6 * s, -0.4);
      g.fillStyle = c[1];
      rrect(g, x - 9.8 * s, y - 1.5 * s, 19.6 * s, 4.4 * s, 2 * s);
      g.fill();
      g.fillStyle = c[2];
      circle(g, x, y - 7.6 * s, 3.1 * s);
    }

    function paintPenguin(g, c, o) {
      const f = o.face || 1;
      if (o.pose === 'swim') {
        g.fillStyle = '#1f2636';
        ell(g, 0, -5, 8.5, 8);
        g.fillStyle = '#f5f9fc';
        ell(g, f * 2.2 - 2.5, -6, 3, 3.2);
        ell(g, f * 2.2 + 2.5, -6, 3, 3.2);
        g.fillStyle = '#141821';
        circle(g, f * 2.6 - 2.5, -6.2, 1.3);
        circle(g, f * 2.6 + 2.5, -6.2, 1.3);
        g.fillStyle = '#ff9a3c';
        ell(g, f * 2.6, -2.8, 2.6, 1.7);
        paintHat(g, c, 0, -10, 0.85);
        g.fillStyle = 'rgba(10,52,86,0.92)';
        ell(g, 0, 2.5, 13, 5);
        g.strokeStyle = 'rgba(220,246,255,0.75)';
        g.lineWidth = 1;
        g.beginPath();
        g.ellipse(0, 0, 11 + Math.sin(o.walk) * 1.2, 3.6, 0, 0, TAU);
        g.stroke();
        return;
      }
      if (o.pose === 'slide') {
        g.save();
        g.rotate(o.dir);
        if (Math.cos(o.dir) < 0) g.scale(1, -1);
        g.fillStyle = 'rgba(40,90,130,0.25)';
        ell(g, 0, 1, 18, 5);
        g.fillStyle = '#ff9a3c';
        ell(g, -18, -4, 3.6, 2);
        ell(g, -17, -8, 3.6, 2);
        g.fillStyle = '#1f2636';
        ell(g, 0, -6, 16, 8);
        g.fillStyle = '#f5f9fc';
        ell(g, 1.5, -2.8, 12, 4.4);
        g.fillStyle = '#161b27';
        ell(g, -7, -12, 8, 2.5, -0.25);
        g.fillStyle = '#1f2636';
        circle(g, 13, -8, 7.5);
        g.fillStyle = '#f5f9fc';
        ell(g, 15.5, -8.5, 3, 3.2);
        g.fillStyle = '#141821';
        circle(g, 16.4, -8.8, 1.3);
        g.fillStyle = '#ff9a3c';
        g.beginPath();
        g.moveTo(19.5, -9); g.lineTo(25.5, -6.8); g.lineTo(19.5, -5);
        g.closePath();
        g.fill();
        g.save();
        g.translate(10, -14);
        g.rotate(-0.9);
        paintHat(g, c, 0, 0, 0.8);
        g.restore();
        g.restore();
        return;
      }

      const lift = Math.sin(o.walk || 0);
      g.save();
      g.rotate(o.tilt || 0);
      g.fillStyle = '#ff9a3c';
      ell(g, -4.6, -0.6 - Math.max(0, lift) * 2.2, 4.2, 2.3);
      ell(g, 4.6, -0.6 - Math.max(0, -lift) * 2.2, 4.2, 2.3);
      const q = o.squash || 1;
      g.scale(1 + (1 - q) * 0.9, q);
      g.fillStyle = '#1f2636';
      ell(g, 0, -14, 11, 14);
      const fa = o.flap || 0;
      g.fillStyle = '#161b27';
      g.save(); g.translate(-9, -18); g.rotate(0.22 + fa); ell(g, 0, 6, 3, 8.5); g.restore();
      g.save(); g.translate(9, -18); g.rotate(-0.22 - fa); ell(g, 0, 6, 3, 8.5); g.restore();
      g.fillStyle = '#f5f9fc';
      ell(g, f * 1.8, -11.5, 7.6, 10.5);
      ell(g, f * 2.2 - 2.7, -20.6, 3.4, 3.7);
      ell(g, f * 2.2 + 2.7, -20.6, 3.4, 3.7);
      g.fillStyle = '#141821';
      const eyeY = o.dizzy ? -20.4 + Math.sin(o.walk * 3) * 0.6 : -20.8;
      circle(g, f * 2.7 - 2.7, eyeY, 1.5);
      circle(g, f * 2.7 + 2.7, eyeY, 1.5);
      g.fillStyle = '#ffffff';
      circle(g, f * 2.7 - 2.3, eyeY - 0.6, 0.5);
      circle(g, f * 2.7 + 3.1, eyeY - 0.6, 0.5);
      g.fillStyle = 'rgba(255,130,150,0.55)';
      ell(g, f * 2.2 - 5.6, -17.4, 1.7, 1.1);
      ell(g, f * 2.2 + 5.6, -17.4, 1.7, 1.1);
      g.fillStyle = '#ff9a3c';
      ell(g, f * 2.7, -17.4, 2.9, 1.9);
      g.fillStyle = '#d9731c';
      ell(g, f * 2.7, -17, 2.2, 0.45);
      paintHat(g, c, 0, -25.5);
      if (o.crown) drawCrown(g, 0, -38);
      g.restore();
    }

    function poseOf(p, v, t, dt) {
      const sp = Math.hypot(p.vx, p.vy);
      if (Math.abs(p.vx) > 6) v.face = p.vx > 0 ? 1 : -1;
      else if (p.st === 'ice' && sp < 6) v.face = Math.cos(p.dir) >= 0 ? 1 : -1;
      v.walkPh += dt * Math.min(16, sp * 0.18) + dt * 0.5;
      const o = { face: v.face, pose: 'stand', walk: v.walkPh, tilt: 0, flap: 0, squash: 1 };
      if (snap && snap.kings && snap.kings.includes(p.id) && snap.phase === 'over') {
        o.crown = true;
        o.flap = 0.9 + Math.sin(t * 10) * 0.5;
        o.squash = 1 + Math.max(0, Math.sin(t * 7)) * 0.05;
        return o;
      }
      if (p.st === 'swim') { o.pose = 'swim'; o.walk = t * 3 + v.bob; return o; }
      if (p.st === 'fall') {
        const k = clamp(p.fallT / 0.4, 0, 1);
        o.tilt = (p.vx >= 0 ? 1 : -1) * 1.2 * k;
        o.flap = 1.2 + Math.sin(t * 40) * 0.4;
        o.sink = k * k * 30;
        return o;
      }
      if (p.dash || sp > 140) { o.pose = 'slide'; o.dir = Math.atan2(p.vy * YS, p.vx); return o; }
      o.tilt = Math.sin(v.walkPh) * 0.14 * Math.min(1, sp / 30) + Math.sin(t * 1.6 + v.bob) * 0.02;
      if (sp > 90) { o.flap = 0.5 + Math.sin(t * 30) * 0.3; o.dizzy = true; }
      return o;
    }

    // Под ногами: след отлёта у сбитого и прицел рывка у своего пингвина
    function drawGroundMarks(t) {
      if (!snap) return;
      groundTransform();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const p of snap.players) {
        const v = vis.get(p.id);
        if (!v || v.streak <= 0 || v.hist.length < 3) continue;
        const a = v.streak / 0.8;
        const h = v.hist;
        for (let i = 1; i < h.length; i++) {
          const k = i / h.length;
          ctx.strokeStyle = v.streakC;
          ctx.globalAlpha = a * k * 0.85;
          ctx.lineWidth = (3 + 9 * k) * a;
          ctx.beginPath();
          ctx.moveTo(h[i - 1][0], h[i - 1][1]);
          ctx.lineTo(h[i][0], h[i][1]);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      const fm = focus && snap.players.find(p => p.id === focus);
      if (fm && focusMode === 'mark') {
        ctx.setLineDash([6, 5]);
        ctx.lineDashOffset = -t * 20;
        ctx.strokeStyle = '#ff5a5a';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.ellipse(fm.x, fm.y, 24, 24, 0, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
      const mp = me && snap.players.find(p => p.id === me);
      const live = snap.phase === 'fight' || snap.phase === 'overtime' || snap.phase === 'lobby' || snap.phase === 'countdown';
      if (!mp || mp.st !== 'ice' || !live || mp.dash) return;
      const ready = mp.cd <= 0;
      const col = HAT_COLORS[mp.ci % HAT_COLORS.length][0];
      const ux = Math.cos(mp.dir), uy = Math.sin(mp.dir);
      const r0 = 15, L = 62;
      const x0 = mp.x + ux * r0, y0 = mp.y + uy * r0;
      const x1 = mp.x + ux * (r0 + L), y1 = mp.y + uy * (r0 + L);
      ctx.setLineDash(ready ? [7, 5] : [3, 6]);
      ctx.lineDashOffset = -t * 30;
      ctx.lineWidth = ready ? 3.2 : 2;
      ctx.strokeStyle = ready ? col : 'rgba(255,255,255,0.35)';
      ctx.globalAlpha = ready ? 0.75 + 0.25 * Math.sin(t * 8) : 1;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.setLineDash([]);
      // наконечник; пока перезарядка — заполняется от основания
      const hx = -uy, hy = ux, H = 11;
      ctx.fillStyle = ready ? col : 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(x1 + ux * H, y1 + uy * H);
      ctx.lineTo(x1 + hx * 7, y1 + hy * 7);
      ctx.lineTo(x1 - hx * 7, y1 - hy * 7);
      ctx.closePath();
      ctx.fill();
      if (!ready) {
        const k = 1 - clamp(mp.cd, 0, 1);
        ctx.strokeStyle = col;
        ctx.lineWidth = 3.2;
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + ux * L * k, y0 + uy * L * k); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function drawPenguins(t, dt) {
      if (!snap) return;
      const s = S(), d = view.dpr;
      const list = snap.players.filter(p => p.st !== 'gone').sort((a, b) => a.y - b.y);
      // тени и кольца под ногами: цвет шапки, дуга — перезарядка рывка
      screenTransform();
      for (const p of list) {
        if (p.st !== 'ice') continue;
        const X = sx(p.x), Y = sy(p.y);
        ctx.fillStyle = 'rgba(40,95,140,0.28)';
        ell(ctx, X, Y, 11 * s, 4.2 * s);
        const col = HAT_COLORS[p.ci % HAT_COLORS.length][0];
        const mine = p.id === me;
        const R = (mine ? 17 : 15) * s;
        ctx.lineWidth = mine ? 3 : 2;
        ctx.strokeStyle = mine ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.25)';
        if (mine && danger > 0.05) {
          ctx.globalAlpha = danger * (0.6 + 0.4 * Math.sin(t * 14));
          ctx.fillStyle = 'rgba(255,60,60,0.55)';
          ell(ctx, X, Y, R + 8 * s, (R + 8 * s) * YS);
          ctx.globalAlpha = 1;
        }
        if (mine) for (const pu of pulses) {
          const k = pu.life / 0.5;
          ctx.globalAlpha = 1 - k;
          ctx.lineWidth = 4 * (1 - k) + 1;
          ctx.strokeStyle = col;
          ctx.beginPath(); ctx.ellipse(X, Y, R + 20 * k * s, (R + 20 * k * s) * YS, 0, 0, TAU); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (mine) {
          ctx.globalAlpha = 0.45 + 0.25 * Math.sin(t * 5);
          ctx.beginPath(); ctx.ellipse(X, Y, R + 4 * s, (R + 4 * s) * YS, 0, 0, TAU); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = col;
        ctx.beginPath();
        const ready = 1 - clamp(p.cd, 0, 1);
        ctx.ellipse(X, Y, R, R * YS, 0, -Math.PI / 2, -Math.PI / 2 + TAU * ready);
        ctx.stroke();
        if (ready >= 1 && (mine || snap.players.length <= 8)) {
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = col;
          ell(ctx, X, Y, R, R * YS);
          ctx.globalAlpha = 1;
        }
      }
      for (const p of list) {
        const v = vis.get(p.id);
        if (!v) continue;
        const o = poseOf(p, v, t, dt);
        const X = sx(p.x), Y = sy(p.y);
        if (X < -60 || X > view.w + 60 || Y < -60 || Y > view.h + 80) continue;
        ctx.globalAlpha = p.online === false ? 0.55 : 1;
        ctx.setTransform(d * s, 0, 0, d * s, d * X, d * Y);
        const c = HAT_COLORS[p.ci % HAT_COLORS.length];
        if (o.sink) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(-40, -70, 80, 72);
          ctx.clip();
          ctx.translate(0, o.sink);
          paintPenguin(ctx, c, o);
          ctx.restore();
        } else {
          paintPenguin(ctx, c, o);
        }
      }
      screenTransform();
      ctx.globalAlpha = 1;
    }

    function drawFx() {
      screenTransform();
      const s = S();
      for (const p of puffs) {
        const k = p.life / p.max;
        ctx.fillStyle = `rgba(240,250,255,${0.7 * (1 - k)})`;
        circle(ctx, sx(p.x), sy(p.y) - 2 * s, p.r * s * (0.6 + k));
      }
      for (const b of bursts) {
        const k = b.life / 0.38;
        const X = sx(b.x), Y = sy(b.y) - 17 * s;
        const R = (9 + 15 * k) * s * (0.7 + b.k * 0.5);
        ctx.globalAlpha = Math.max(0, 1 - k);
        ctx.beginPath();
        for (let i = 0; i < 16; i++) {
          const a = b.rot + (i / 16) * TAU, r = i % 2 ? R * 0.45 : R;
          const px = X + Math.cos(a) * r, py = Y + Math.sin(a) * r;
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = '#fff3a8';
        ctx.fill();
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const p of drops) {
        ctx.fillStyle = p.c;
        circle(ctx, sx(p.x), sy(p.y) - p.z * s, p.s * Math.max(0.7, s * 0.7));
      }
    }

    function drawSnow(t, dt) {
      screenTransform();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (const f of snow) {
        f.y += (f.sp * dt) / view.h;
        if (f.y > 1.02) { f.y = -0.02; f.x = rnd(); }
        const x = (f.x + Math.sin(t * 0.7 + f.ph) * 0.01) * view.w;
        circle(ctx, x, f.y * view.h, f.r);
      }
    }

    function drawPopups() {
      screenTransform();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const s = S();
      for (const p of popups) {
        if (p.life < 0) continue;
        const k = p.life / p.max;
        const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : k < 0.22 ? 1.15 - ((k - 0.12) / 0.1) * 0.15 : 1;
        const size = (p.big ? 26 : 15) * pop * Math.max(0.85, Math.min(1.3, s));
        const X = sx(p.x), Y = sy(p.y) - (46 + 34 * k) * s;
        ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
        ctx.font = `900 ${size}px Montserrat, -apple-system, sans-serif`;
        ctx.lineWidth = p.big ? 9 : 5;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#06182c';
        ctx.strokeText(p.text, X, Y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, X, Y);
      }
      ctx.globalAlpha = 1;
    }

    // итог: сцена темнеет, ведущий дейлика — в луче
    function drawSpotlight(t) {
      const fp = focus && focusMode === 'host' && snap && snap.players.find(p => p.id === focus);
      if (!fp) return;
      screenTransform();
      const X = sx(fp.x), Y = sy(fp.y) - 16 * S();
      const R = 70 * S();
      const g = ctx.createRadialGradient(X, Y, R * 0.35, X, Y, R * 2.2);
      g.addColorStop(0, 'rgba(255,240,200,0.18)');
      g.addColorStop(0.35, 'rgba(3,12,24,0)');
      g.addColorStop(1, 'rgba(3,12,24,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, view.w, view.h);
    }

    // по краям экрана: красным — когда вас ударили или вы у самой воды, голубым — когда упали
    function drawVignette(t) {
      const dA = danger * (0.28 + 0.12 * Math.sin(t * 12));
      const a = Math.max(vignette.hit, dA);
      if (a < 0.02) return;
      const col = vignette.hit >= dA ? vignette.color : '255,60,60';
      screenTransform();
      const { w, h } = view;
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
      g.addColorStop(0, `rgba(${col},0)`);
      g.addColorStop(1, `rgba(${col},${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Подписи: имя над каждым, у своего — «вы»; ближние к зрителю стоят на месте, дальние уступают вверх
    function drawLabels(t, dt) {
      if (!snap) return;
      screenTransform();
      ctx.font = '700 11px Montserrat, -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const s = S();
      const list = snap.players.filter(p => p.st === 'ice' || p.st === 'fall' || p.st === 'swim');
      const boxes = [];
      const drawn = [];
      for (const p of list.slice().sort((a, b) => b.y - a.y)) {
        const v = vis.get(p.id);
        if (!v) continue;
        const show = p.st === 'ice' || p.id === me ? 1 : p.st === 'fall' ? 1 : 0.55;
        v.la += (show - v.la) * Math.min(1, dt * 8);
        if (v.la < 0.03) continue;
        const king = snap.phase === 'over' && snap.kings && snap.kings.includes(p.id);
        const host = snap.host && snap.host.id === p.id;
        const crowd = list.length > 5 && p.st === 'ice' && p.id !== me && !king && !host && !(v.streak > 0) && (simT - (v.hitAt || -9) > 2) && edgeDist(p.x, p.y) > 28;
        const text = crowd ? String(p.name).trim().charAt(0).toUpperCase() : (king ? '👑 ' : host ? '🎤 ' : '') + (p.online === false ? '📡 ' : '') + p.name + (p.id === me ? (opts.meSuffix || ' · вы') : '');
        const h = 18;
        const w = crowd ? 22 : ctx.measureText(text).width + 24;
        const X = sx(p.x);
        const top = p.st === 'swim' ? 22 : p.st === 'fall' ? 40 : king ? 50 : 42;
        const Y0 = sy(p.y) - top * s - h / 2 - 2;
        let Y = Y0;
        for (let pass = 0; pass < 6; pass++) {
          const hit = boxes.find(b => Math.abs(b.x - X) < (b.w + w) / 2 + 2 && Math.abs(b.y - Y) < h + 1);
          if (!hit) break;
          Y = hit.y - h - 2;
        }
        // далеко от своего пингвина подпись не уезжает и не лезет под таймер сверху
        Y = Math.max(Y, Y0 - 2 * (h + 2), (opts.topGap || 52) + h / 2);
        boxes.push({ x: X, y: Y, w });
        drawn.push({ p, X, Y, Y0, w, h, text, king, host, a: v.la, crowd });
      }
      drawn.reverse();
      const mi = drawn.findIndex(L => L.p.id === me);
      if (mi >= 0) drawn.push(drawn.splice(mi, 1)[0]);
      for (const L of drawn) {
        const { p, X, Y, Y0, w, h, text, king, host, a, crowd } = L;
        if (Math.abs(Y - Y0) > 1) {
          ctx.globalAlpha = a * 0.6;
          ctx.strokeStyle = 'rgba(230,246,255,0.7)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(X, Y + h / 2); ctx.lineTo(X, Y0 + h / 2); ctx.stroke();
        }
        ctx.globalAlpha = a;
        const mine = p.id === me;
        ctx.fillStyle = king ? 'rgba(255,210,63,0.97)' : host ? 'rgba(205,48,58,0.94)' : mine ? 'rgba(255,255,255,0.95)' : p.st !== 'ice' ? 'rgba(8,28,48,0.7)' : 'rgba(6,24,44,0.82)';
        rrect(ctx, X - w / 2, Y - h / 2, w, h, h / 2);
        ctx.fill();
        if (crowd) {
          ctx.strokeStyle = HAT_COLORS[p.ci % HAT_COLORS.length][0];
          ctx.lineWidth = 2;
          rrect(ctx, X - w / 2, Y - h / 2, w, h, h / 2);
          ctx.stroke();
          ctx.fillStyle = '#f4fbff';
          ctx.fillText(text, X, Y + 0.5);
          continue;
        }
        ctx.fillStyle = HAT_COLORS[p.ci % HAT_COLORS.length][0];
        circle(ctx, X - w / 2 + 8, Y, 3.2);
        ctx.fillStyle = king ? '#3b2400' : mine ? '#06182c' : p.st !== 'ice' ? '#b9d4e6' : '#f4fbff';
        ctx.fillText(text, X + 4, Y + 0.5);
      }
      ctx.globalAlpha = 1;
    }

    // замер стоимости кадра: среднее и худшее за последние ~2 с (смотрят проверки и отладка)
    const perf = { n: 0, sum: 0, max: 0, last: { avg: 0, max: 0 } };
    function draw(t, dt) {
      const t0 = performance.now();
      drawFrame(t, dt);
      const ms = performance.now() - t0;
      perf.n++; perf.sum += ms; perf.max = Math.max(perf.max, ms);
      if (perf.n >= 120) { perf.last = { avg: perf.sum / perf.n, max: perf.max }; perf.n = perf.sum = perf.max = 0; }
    }
    function drawFrame(t, dt) {
      simT += dt;
      resize();
      updateParticles(dt);
      updateCamera(dt);
      drawSea(t);
      drawRings();
      drawFloe(t);
      drawGroundMarks(t);
      drawPenguins(t, dt);
      drawFx();
      drawSnow(t, dt);
      drawSpotlight(t);
      drawPopups();
      drawLabels(t, dt);
      drawVignette(t);
    }

    // экранные координаты пингвина — для подсказок поверх холста
    function screenOf(x, y) { return [sx(x), sy(y)]; }

    return {
      apply, draw, screenOf,
      get perf() { return perf.last; },
      setMe(id) { me = id; },
      setWords(w) { Object.assign(words, w); },
      setFocus(id, mode) { if (focus && !id) camSnap = true; focus = id || null; focusMode = mode || null; },
      reset() { rings.length = drops.length = bursts.length = puffs.length = later.length = popups.length = pulses.length = 0; vignette.hit = 0; danger = 0; vis.clear(); snap = null; },
      get cam() { return cam; },
    };
  }

  root.FloeRender = { create, HAT_COLORS, Sound, YS };
})(typeof self !== 'undefined' ? self : this);
