/*
 * «Лягушки на кувшинках» — отрисовка и звук. Ночное болото: тёмная бирюзовая вода, светлячки, луна, кувшинки с цветами,
 * резиновые лягушки, трясущиеся тонущие листья, тень цапли. Всё рисуется из модели мира (pond/model.js), игровой логики здесь нет.
 * Мир: центр пруда (0,0), радиус R. Спека — docs/frog-pond-spec.md §6.
 */
(function () {
  'use strict';
  const P = window.PondPhysics;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  // цвета лягушек: [тело, светлое брюшко, тёмный контур]; запоминаются по имени (ci), как шапки в других играх
  const FROG_COLORS = [
    ['#c8f23a', '#f6ffc9', '#5d7a12'], ['#35c9a4', '#d3fff1', '#14735c'], ['#ffb43a', '#fff0c4', '#a86a0c'], ['#ff6f91', '#ffe0e8', '#a8294a'],
    ['#7aa8ff', '#e1ecff', '#2b52b0'], ['#c58bff', '#f0e1ff', '#6a32a8'], ['#f6e04a', '#fffbd0', '#9a8a05'], ['#ff8a4a', '#ffe3d0', '#a8480f'],
    ['#4fd6e8', '#d6fbff', '#15788a'], ['#a3e04a', '#f1ffd0', '#547a0c'], ['#ff5d5d', '#ffdede', '#a31f1f'], ['#d9a6ff', '#f7ecff', '#7c4aa8'],
    ['#8fe8b0', '#e6fff0', '#2e8052'], ['#ffd1a3', '#fff4e6', '#a8742f'], ['#6fb6ff', '#dcf0ff', '#1f6aa8'], ['#e8f06a', '#fcffd6', '#7d8a12'],
  ];

  // ===================================================================
  // Звук (Web Audio): всё синтезируется, файлов нет. Включается по первому касанию.
  // ===================================================================
  const Sound = (function () {
    let ctx = null, noiseBuf = null, muted = false;
    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return ctx;
    }
    function tone(freq, dur, o) {
      if (!ctx || muted) return;
      o = o || {};
      const t0 = ctx.currentTime + (o.delay || 0);
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(o.vol || 0.12, t0 + (o.attack || 0.01));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    }
    function noise(dur, o) {
      if (!ctx || muted) return;
      o = o || {};
      const t0 = ctx.currentTime + (o.delay || 0);
      const src = ctx.createBufferSource(); src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter(); f.type = o.filter || 'lowpass';
      f.frequency.setValueAtTime(o.f0 || 1200, t0);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(o.vol || 0.15, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(ctx.destination);
      src.start(t0, Math.random() * 0.2, dur + 0.05);
    }
    return {
      ensure,
      get muted() { return muted; }, set muted(v) { muted = !!v; },
      jump(pow) { tone(180 + pow * 160, 0.16, { type: 'triangle', to: 420 + pow * 260, vol: 0.12 }); },
      land(big) { noise(0.12, { f0: 700, f1: 200, vol: big ? 0.2 : 0.12 }); tone(110, 0.1, { type: 'sine', to: 70, vol: 0.12 }); },
      splash(big) { noise(big ? 0.55 : 0.32, { f0: 3200, f1: 500, vol: big ? 0.3 : 0.2, filter: 'bandpass' }); tone(320, 0.2, { type: 'sine', to: 90, vol: 0.1 }); },
      stomp() { tone(95, 0.22, { type: 'square', to: 45, vol: 0.2 }); noise(0.2, { f0: 1500, f1: 200, vol: 0.2 }); },
      croak(v) { v = v || 1; tone(130, 0.09, { type: 'sawtooth', to: 190, vol: 0.07 * v }); tone(150, 0.1, { type: 'sawtooth', to: 120, vol: 0.07 * v, delay: 0.1 }); },
      warn() { tone(520, 0.12, { type: 'triangle', vol: 0.07 }); tone(400, 0.14, { type: 'triangle', vol: 0.07, delay: 0.14 }); },
      crack() { noise(0.1, { f0: 5000, f1: 1500, vol: 0.18, filter: 'highpass' }); },
      gurgle() { for (let i = 0; i < 4; i++) tone(240 + i * 70, 0.08, { type: 'sine', to: 400 + i * 90, vol: 0.07, delay: i * 0.07 }); },
      heron() { tone(700, 0.5, { type: 'sawtooth', to: 260, vol: 0.09 }); tone(540, 0.35, { type: 'sawtooth', to: 220, vol: 0.06, delay: 0.1 }); },
      strike() { noise(0.5, { f0: 2400, f1: 200, vol: 0.34 }); tone(80, 0.4, { type: 'sine', to: 40, vol: 0.25 }); },
      fly() { tone(900, 0.2, { type: 'square', to: 1300, vol: 0.03 }); },
      lick() { tone(1200, 0.06, { type: 'sine', to: 400, vol: 0.14 }); tone(700, 0.1, { type: 'triangle', to: 1500, vol: 0.1, delay: 0.05 }); },
      go() { tone(440, 0.12, { type: 'triangle', vol: 0.14 }); tone(880, 0.25, { type: 'triangle', vol: 0.14, delay: 0.12 }); },
      tick() { tone(660, 0.08, { type: 'triangle', vol: 0.1 }); },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.28, { type: 'triangle', vol: 0.13, delay: i * 0.11 })); this.choir(); },
      lose() { tone(330, 0.3, { type: 'sawtooth', to: 110, vol: 0.12 }); tone(247, 0.5, { type: 'sawtooth', to: 80, vol: 0.12, delay: 0.25 }); },
      choir() { for (let i = 0; i < 6; i++) tone(120 + Math.random() * 90, 0.12, { type: 'sawtooth', to: 150 + Math.random() * 90, vol: 0.05, delay: 0.5 + i * 0.13 }); },
    };
  })();

  // ===================================================================
  // Рисование
  // ===================================================================
  function create(canvas, opts) {
    opts = opts || {};
    const cx = canvas.getContext('2d');
    const r = {
      model: null, shake: 0, shakeT: 0, flash: 0, flashColor: '255,255,255', insets: { l: 0, t: 0, r: 0, b: 0 },
      parts: [], flies: [], reduced: matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches,
      cam: { s: 1, ox: 0, oy: 0 }, w: 0, h: 0, dpr: 1, quality: 1, slow: 0, frameMs: [], lastTs: 0, banner: null,
      seen: { pads: new Map(), fly: new Set() }, face: new Map(), drown: [], names: [],
    };

    r.resize = function () {
      r.dpr = Math.min(2, window.devicePixelRatio || 1);
      r.w = canvas.clientWidth; r.h = canvas.clientHeight;
      canvas.width = Math.round(r.w * r.dpr); canvas.height = Math.round(r.h * r.dpr);
    };
    function camera() {
      const m = r.model, R = (m && m.R) || 200;
      const aw = Math.max(80, r.w - r.insets.l - r.insets.r), ah = Math.max(80, r.h - r.insets.t - r.insets.b);
      const s = Math.min(aw, ah) / (2 * (R + 46));
      r.cam.s = s; r.cam.ox = r.insets.l + aw / 2; r.cam.oy = r.insets.t + ah / 2;
    }
    r.w2s = (x, y) => ({ x: r.cam.ox + x * r.cam.s, y: r.cam.oy + y * r.cam.s });
    r.s2w = (x, y) => ({ x: (x - r.cam.ox) / r.cam.s, y: (y - r.cam.oy) / r.cam.s });

    // ----- частицы -----
    const push = (p) => { if (r.parts.length < 700 * r.quality) r.parts.push(p); };
    r.fx = {
      ring(x, y, rad, color, life, w) { push({ k: 'ring', x, y, r0: rad * 0.3, r1: rad, life: life || 0.9, max: life || 0.9, color: color || '190,240,255', w: w || 1.6 }); },
      splash(x, y, n, power) {
        n = Math.round((n || 14) * r.quality);
        for (let i = 0; i < n; i++) { const a = Math.random() * TAU, v = (30 + Math.random() * 70) * (power || 1); push({ k: 'drop', x, y, z: 0, vx: Math.cos(a) * v * 0.5, vy: Math.sin(a) * v * 0.5, vz: 80 + Math.random() * 140 * (power || 1), life: 0.9, max: 0.9, size: 1.5 + Math.random() * 2.2 }); }
        r.fx.ring(x, y, 34 * (power || 1), '200,245,255', 0.9); r.fx.ring(x, y, 20 * (power || 1), '255,255,255', 0.6, 1.2);
      },
      bubbles(x, y, n) { for (let i = 0; i < (n || 4) * r.quality; i++) push({ k: 'bub', x: x + (Math.random() - 0.5) * 24, y: y + (Math.random() - 0.5) * 24, z: 0, vz: 12 + Math.random() * 22, life: 1.1, max: 1.1, size: 1.5 + Math.random() * 3 }); },
      burst(x, y, color, n) { for (let i = 0; i < (n || 18) * r.quality; i++) { const a = Math.random() * TAU, v = 50 + Math.random() * 110; push({ k: 'spark', x, y, z: 6, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6, vz: 40 + Math.random() * 90, life: 0.7, max: 0.7, size: 2 + Math.random() * 2.4, color: color || '255,230,120' }); } },
      leaf(x, y) { for (let i = 0; i < 5; i++) { const a = Math.random() * TAU; push({ k: 'leaf', x, y, z: 4, vx: Math.cos(a) * 36, vy: Math.sin(a) * 26, vz: 60, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 8, life: 1.1, max: 1.1, size: 5 + Math.random() * 4 }); } },
      text(x, y, s, color) { push({ k: 'text', x, y, z: 30, vz: 34, s, color: color || '#fff', life: 1.1, max: 1.1 }); },
    };
    function stepParts(dt) {
      for (let i = r.parts.length - 1; i >= 0; i--) {
        const p = r.parts[i];
        p.life -= dt;
        if (p.life <= 0) { r.parts.splice(i, 1); continue; }
        if (p.k === 'drop' || p.k === 'spark' || p.k === 'leaf') {
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vz -= 320 * dt;
          if (p.k === 'leaf') p.rot += p.vr * dt;
          if (p.z < 0 && p.k === 'drop') { p.z = 0; p.life = Math.min(p.life, 0.12); p.vz = 0; p.vx = p.vy = 0; }
        } else if (p.k === 'bub' || p.k === 'text') { p.z += p.vz * dt; if (p.k === 'bub') p.x += Math.sin(p.life * 9 + p.size) * 6 * dt; }
      }
    }

    // светлячки — фон, независимо от модели
    for (let i = 0; i < 26; i++) r.flies.push({ a: hash(i) * TAU, d: 0.2 + hash(i + 40) * 1.1, sp: 0.05 + hash(i + 80) * 0.12, ph: hash(i + 120) * TAU, sz: 1.2 + hash(i + 160) * 1.6 });

    r.setModel = (m) => { if (r.model !== m) { r.model = m; r.seen.pads.clear(); r.seen.fly.clear(); r.parts.length = 0; r.face.clear(); r.drown.length = 0; } };

    // ----- события: эффекты и звук -----
    r.event = function (e, m, mine) {
      const me = m && m.myId;
      switch (e.type) {
        case 'jump': {
          const f = m.frogs.get(e.id);
          r.face.set(e.id, e.ang);
          r.fx.ring(e.x0, e.y0, 24, '210,250,255', 0.5, 1.2);
          if (e.id === me || mine) Sound.jump(e.pow); else if (Math.random() < 0.5) Sound.jump(e.pow * 0.6);
          if (f && e.boost) r.fx.burst(e.x0, e.y0, '255,220,90', 10);
          break;
        }
        case 'land': {
          r.fx.ring(e.x, e.y, 30, '210,250,255', 0.7); r.fx.splash(e.x, e.y, 5, 0.45);
          const pad = m.pads[e.pad];
          if (pad) pad._bump = 1;
          Sound.land(pad && pad.big);
          if (e.stomp) r.shake = Math.max(r.shake, 7);
          if (e.bounce != null) { const bp = m.pads[e.bounce]; if (bp) { r.fx.burst(bp.x, bp.y, '200,240,255', 8); r.fx.text(bp.x, bp.y - 14, '↩', '#bfefff'); } Sound.land(false); }
          break;
        }
        case 'stomp': {
          const pad = m.pads[e.pad];
          if (pad) { r.fx.burst(pad.x, pad.y, '255,240,160', 22); r.fx.leaf(pad.x, pad.y); r.fx.text(pad.x, pad.y - 10, '💥', '#fff'); }
          r.shake = Math.max(r.shake, 10); r.flash = Math.max(r.flash, 0.18); r.flashColor = '255,235,170';
          Sound.stomp(); Sound.croak(1.4);
          break;
        }
        case 'fall': {
          const col = (m.frogs.get(e.id) || {}).ci || 0;
          r.fx.splash(e.x, e.y, 22, 1.2); r.fx.bubbles(e.x, e.y, 8);
          r.drown.push({ x: e.x, y: e.y, ci: col, life: 1.1, max: 1.1 });
          Sound.splash(true);
          if (e.id === me) { r.shake = Math.max(r.shake, 8); Sound.lose(); }
          break;
        }
        case 'wave': Sound.warn(); break;
        case 'sunk': {
          const pad = m.pads[e.pad];
          if (pad) { r.fx.splash(pad.x, pad.y, 12, 1); r.fx.bubbles(pad.x, pad.y, 6); }
          Sound.gurgle();
          break;
        }
        case 'shrunk': { const pad = m.pads[e.pad]; if (pad) { r.fx.leaf(pad.x, pad.y); r.fx.burst(pad.x, pad.y, '255,170,80', 12); } Sound.crack(); break; }
        case 'heron': Sound.heron(); break;
        case 'strike': r.flash = 0.55; r.flashColor = '255,255,255'; r.shake = Math.max(r.shake, 12); r.fx.ring(e.x, e.y, e.r * 1.6, '255,255,255', 0.8, 3); r.fx.splash(e.x, e.y, 26, 1.6); Sound.strike(); break;
        case 'fly': Sound.fly(); break;
        case 'flyGot': { const pad = m.pads[e.pad]; if (pad) r.fx.burst(pad.x, pad.y, '255,235,80', 16); Sound.lick(); r.fx.text(pad.x, pad.y - 12, '🪰', '#fff'); break; }
        case 'go': Sound.go(); break;
        case 'react': break;
        case 'over': r.flash = 0.4; r.flashColor = '255,240,150'; break;
        default: break;
      }
    };

    // ----- вода, берег, фон -----
    function drawBackdrop(t, R) {
      // за прудом — тёмный берег
      cx.fillStyle = '#04141f'; cx.fillRect(-4000, -4000, 8000, 8000);
      const g = cx.createRadialGradient(0, 0, R * 0.3, 0, 0, R * 1.9);
      g.addColorStop(0, '#0c3a36'); g.addColorStop(0.6, '#07241f'); g.addColorStop(1, '#030d12');
      cx.fillStyle = g; cx.beginPath(); cx.arc(0, 0, R * 3, 0, TAU); cx.fill();
      // трава и камыши по кольцу
      const seed = (r.model && r.model.seed) || 1;
      for (let i = 0; i < 46; i++) {
        const a = hash(i + seed) * TAU, d = R + 26 + hash(i * 3 + seed) * 70, h = 26 + hash(i * 7 + seed) * 40;
        const x = Math.cos(a) * d, y = Math.sin(a) * d, sway = Math.sin(t * 1.4 + i) * 4;
        cx.strokeStyle = i % 5 === 0 ? '#2d6f3f' : '#1d4d33'; cx.lineWidth = 2.4;
        cx.beginPath(); cx.moveTo(x, y); cx.quadraticCurveTo(x + sway * 0.5, y - h * 0.5, x + sway, y - h); cx.stroke();
        if (i % 6 === 0) { cx.fillStyle = '#6b3a1f'; cx.beginPath(); cx.ellipse(x + sway, y - h, 2.6, 7, 0, 0, TAU); cx.fill(); }
      }
    }
    function pondPath(R, t) {
      cx.beginPath();
      const N = 72;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * TAU, rr = R + 22 + Math.sin(a * 5 + 1.3) * 5 + Math.sin(a * 11) * 2.5;
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        if (i) cx.lineTo(x, y); else cx.moveTo(x, y);
      }
      cx.closePath();
    }
    function drawWater(t, R) {
      pondPath(R, t);
      const g = cx.createRadialGradient(-R * 0.25, -R * 0.35, R * 0.1, 0, 0, R * 1.2);
      g.addColorStop(0, '#16707a'); g.addColorStop(0.5, '#0d4a5e'); g.addColorStop(1, '#072a3f');
      cx.fillStyle = g; cx.fill();
      cx.save(); pondPath(R, t); cx.clip();
      // блики: бегущие волнистые линии
      cx.lineWidth = 1.2;
      for (let i = 0; i < 16; i++) {
        const y = -R + (i / 15) * R * 2.2 + Math.sin(t * 0.5 + i) * 6;
        cx.strokeStyle = `rgba(150,235,240,${0.05 + 0.035 * Math.sin(t + i * 1.7)})`;
        cx.beginPath();
        for (let x = -R; x <= R; x += 18) { const yy = y + Math.sin(x * 0.04 + t * 1.2 + i) * 4; if (x === -R) cx.moveTo(x, yy); else cx.lineTo(x, yy); }
        cx.stroke();
      }
      // луна и её дорожка
      const mx = -R * 0.45, my = -R * 0.55;
      const mg = cx.createRadialGradient(mx, my, 4, mx, my, R * 0.55);
      mg.addColorStop(0, 'rgba(255,248,210,0.38)'); mg.addColorStop(0.35, 'rgba(255,248,210,0.1)'); mg.addColorStop(1, 'rgba(255,248,210,0)');
      cx.fillStyle = mg; cx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
      for (let i = 0; i < 9; i++) {
        const k = i / 8, y = my + k * R * 1.2, w = 40 - k * 18 + Math.sin(t * 1.5 + i) * 6;
        cx.fillStyle = `rgba(255,246,200,${0.14 - k * 0.1})`;
        cx.fillRect(mx + k * 90 - w / 2, y, w, 3);
      }
      cx.restore();
      // кромка
      pondPath(R, t);
      cx.strokeStyle = 'rgba(120,230,225,0.22)'; cx.lineWidth = 3; cx.stroke();
      pondPath(R + 6, t);
      cx.strokeStyle = 'rgba(10,50,45,0.9)'; cx.lineWidth = 7; cx.globalCompositeOperation = 'destination-over'; cx.stroke(); cx.globalCompositeOperation = 'source-over';
    }

    // ----- кувшинки -----
    function padInfo(p, nowT, m) {
      // dr: показываемый радиус плавно догоняет настоящий (лист рвётся пополам)
      p._dr = p._dr == null ? p.r : p._dr + (p.r - p._dr) * 0.12;
      const info = { state: 'ok', u: 0, sink: 0 };
      if (p.state === 'sunk') {
        // не стираем сразу: дорисовываем погружение по метке
        const since = nowT - (p.sinkAt != null ? p.sinkAt : nowT - 9);
        if (since > 1.0) return null;
        info.state = 'sinking'; info.sink = clamp(since / 0.9, 0, 1);
      } else if (p.sinkAt != null) {
        const tel = (m.cfg.TELEGRAPH || 2.5);
        if (nowT >= p.sinkAt && p.cause !== 'shrink') { info.state = 'sinking'; info.sink = clamp((nowT - p.sinkAt) / 0.9, 0, 1); if (info.sink >= 1) return null; }
        else info.state = p.cause === 'shrink' ? 'shrinking' : 'warn', info.u = clamp(1 - (p.sinkAt - nowT) / tel, 0, 1);
      }
      return info;
    }
    function drawPad(p, info, t, nowT) {
      const seed = p.id * 7 + 3;
      const hue = 112 + hash(seed) * 34, lum = 27 + hash(seed + 1) * 9;
      let x = p.x, y = p.y, s = 1, rot = 0, alpha = 1;
      const bump = p._bump || 0; p._bump = bump * 0.88;
      if (info.state === 'warn' || info.state === 'shrinking') { const k = info.u; x += Math.sin(t * 38 + p.id) * 1.6 * k; y += Math.cos(t * 33 + p.id) * 1.6 * k; }
      if (info.state === 'sinking') { const e = info.sink; s = 1 - e * 0.85; rot = e * 1.4 * (p.id % 2 ? 1 : -1); alpha = 1 - e * e; y += e * 6; }
      const sy = Math.sin(t * 0.9 + p.id) * 1.4;
      cx.save(); cx.translate(x, y + sy); cx.rotate(rot + Math.sin(t * 0.4 + p.id) * 0.03); cx.scale(s * (1 + bump * 0.06), s * (1 - bump * 0.05)); cx.globalAlpha = alpha;
      const rad = p._dr;
      // тень на воде
      cx.fillStyle = 'rgba(2,20,30,0.38)'; cx.beginPath(); cx.ellipse(4, 6, rad * 1.02, rad * 0.94, 0, 0, TAU); cx.fill();
      // лист с вырезом
      const notch = hash(seed + 2) * TAU;
      cx.beginPath(); cx.moveTo(0, 0); cx.arc(0, 0, rad, notch + 0.2, notch + TAU - 0.2); cx.closePath();
      const g = cx.createRadialGradient(-rad * 0.3, -rad * 0.35, rad * 0.1, 0, 0, rad);
      g.addColorStop(0, `hsl(${hue},58%,${lum + 17}%)`); g.addColorStop(1, `hsl(${hue + 6},52%,${lum - 3}%)`);
      cx.fillStyle = g; cx.fill();
      cx.strokeStyle = `hsl(${hue},45%,${lum - 9}%)`; cx.lineWidth = 2; cx.stroke();
      // прожилки
      cx.strokeStyle = `hsla(${hue},60%,${lum + 22}%,0.45)`; cx.lineWidth = 1;
      for (let i = 0; i < 9; i++) { const a = notch + 0.45 + i * ((TAU - 0.9) / 8); cx.beginPath(); cx.moveTo(0, 0); cx.lineTo(Math.cos(a) * rad * 0.92, Math.sin(a) * rad * 0.92); cx.stroke(); }
      cx.strokeStyle = 'rgba(210,255,200,0.22)'; cx.lineWidth = 1.5; cx.beginPath(); cx.arc(0, 0, rad - 2.5, notch + 0.3, notch + 2.4); cx.stroke();
      // цветок на каждой пятой и на больших
      if (p.big || hash(seed + 5) > 0.82) {
        const fx = -rad * 0.28, fy = -rad * 0.22;
        for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; cx.fillStyle = i % 2 ? '#ff9ac2' : '#ffc4dd'; cx.beginPath(); cx.ellipse(fx + Math.cos(a) * 5.5, fy + Math.sin(a) * 5.5, 6, 2.8, a, 0, TAU); cx.fill(); }
        cx.fillStyle = '#ffe36a'; cx.beginPath(); cx.arc(fx, fy, 3.2, 0, TAU); cx.fill();
      }
      // тревога: красная пульсация / трещина у рвущегося листа
      if (info.state === 'warn') {
        const pulse = 0.5 + 0.5 * Math.sin(t * (6 + info.u * 14));
        cx.globalCompositeOperation = 'source-atop';
        cx.fillStyle = `rgba(255,60,50,${(0.12 + info.u * 0.38) * (0.55 + 0.45 * pulse)})`; cx.beginPath(); cx.arc(0, 0, rad + 2, 0, TAU); cx.fill();
        cx.globalCompositeOperation = 'source-over';
        cx.strokeStyle = `rgba(255,90,70,${0.4 + 0.5 * pulse})`; cx.lineWidth = 2.5; cx.beginPath(); cx.arc(0, 0, rad + 3, 0, TAU); cx.stroke();
      } else if (info.state === 'shrinking') {
        const pulse = 0.5 + 0.5 * Math.sin(t * 12);
        cx.strokeStyle = `rgba(255,190,70,${0.6 + 0.4 * pulse})`; cx.lineWidth = 3; cx.setLineDash([6, 4]);
        cx.beginPath(); cx.moveTo(-rad * 0.95, -rad * 0.2); cx.lineTo(-rad * 0.3, rad * 0.1); cx.lineTo(rad * 0.2, -rad * 0.15); cx.lineTo(rad * 0.95, rad * 0.25); cx.stroke(); cx.setLineDash([]);
      }
      cx.restore();
      if (info.state === 'warn' && Math.random() < 0.06 + info.u * 0.35) r.fx.bubbles(p.x, p.y, 1);
      if (info.state === 'warn' && info.u > 0.8 && Math.random() < 0.12) r.fx.ring(p.x, p.y, p.r + 8, '255,120,100', 0.6);
    }

    function drawFlyOn(p, nowT, t) {
      if (!p.flyUntil || p.flyUntil <= nowT || p.state === 'sunk') return;
      const left = p.flyUntil - nowT;
      if (left < 1.5 && Math.sin(t * 24) > 0.2) return; // мигает перед исчезновением
      const a = t * 3.2 + p.id, rr = 11 + Math.sin(t * 5) * 2;
      const x = p.x + Math.cos(a) * rr, y = p.y + Math.sin(a * 1.3) * rr * 0.6 - 10 - Math.abs(Math.sin(t * 2)) * 4;
      const glow = cx.createRadialGradient(x, y, 0, x, y, 18); glow.addColorStop(0, 'rgba(255,235,90,0.55)'); glow.addColorStop(1, 'rgba(255,235,90,0)');
      cx.fillStyle = glow; cx.beginPath(); cx.arc(x, y, 18, 0, TAU); cx.fill();
      cx.fillStyle = '#1b1b1b'; cx.beginPath(); cx.ellipse(x, y, 3.2, 2.2, a, 0, TAU); cx.fill();
      const flap = 0.5 + 0.5 * Math.sin(t * 60);
      cx.fillStyle = 'rgba(220,245,255,0.8)';
      cx.beginPath(); cx.ellipse(x - 2, y - 3, 4 * flap + 1, 2, -0.5, 0, TAU); cx.fill();
      cx.beginPath(); cx.ellipse(x + 2, y - 3, 4 * flap + 1, 2, 0.5, 0, TAU); cx.fill();
    }

    // ----- лягушка (вид сверху, «голова» смотрит вдоль +x, потом поворот) -----
    function drawFrog(f, pos, face, o) {
      const col = FROG_COLORS[(f.ci | 0) % FROG_COLORS.length];
      const sc = o.scale || 1;
      const air = o.air, z = pos.z || 0;
      // тень
      const shScale = clamp(1 - z / 160, 0.45, 1);
      cx.fillStyle = `rgba(0,15,25,${0.32 * shScale})`;
      cx.beginPath(); cx.ellipse(pos.x + 3, pos.y + 6, 15 * shScale * sc, 11 * shScale * sc, 0, 0, TAU); cx.fill();
      cx.save();
      cx.translate(pos.x, pos.y - z * 0.55 - 3);
      cx.rotate(face);
      // светлый ореол: лягушка не сливается с листом
      cx.fillStyle = 'rgba(255,255,255,0.2)'; cx.beginPath(); cx.ellipse(0, 0, 21, 17, 0, 0, TAU); cx.fill();
      // резина: присед (сплющивание вдоль взгляда не нужно — сплющиваем «высоту», то есть сжимаем по y и растягиваем по x)
      let sx = 1, sy = 1;
      if (air) { const u = o.u; sx = 1 + 0.32 * Math.sin(u * Math.PI); sy = 1 - 0.14 * Math.sin(u * Math.PI); }
      else { const c = o.crouch || 0; sx = 1 - 0.14 * c; sy = 1 + 0.2 * c; const br = Math.sin(o.t * 2.4 + (f.ci | 0)) * 0.025; sx += br; sy -= br; }
      cx.scale(sx * sc, sy * sc);
      const [body, belly, edge] = col;
      // задние лапы
      cx.fillStyle = edge;
      const kick = air ? 1 : (1 - (o.crouch || 0) * 0.6);
      for (const side of [-1, 1]) {
        cx.beginPath(); cx.moveTo(-6, side * 7);
        cx.quadraticCurveTo(-18 * kick - 4, side * 15, -22 - (air ? 6 : 0), side * (air ? 6 : 13)); cx.lineTo(-17 - (air ? 6 : 0), side * (air ? 3 : 9)); cx.quadraticCurveTo(-13, side * 9, -4, side * 4); cx.closePath(); cx.fill();
        cx.beginPath(); cx.ellipse(-22 - (air ? 6 : 0), side * (air ? 6 : 13), 4.5, 2.6, side * 0.5, 0, TAU); cx.fill();
      }
      // передние лапы
      for (const side of [-1, 1]) { cx.beginPath(); cx.ellipse(10, side * 11, 5.5, 2.3, side * 0.7, 0, TAU); cx.fill(); }
      // тело
      const bg = cx.createRadialGradient(-3, -4, 2, 0, 0, 17);
      bg.addColorStop(0, belly); bg.addColorStop(0.18, body); bg.addColorStop(1, edge);
      cx.fillStyle = bg; cx.strokeStyle = edge; cx.lineWidth = 1.4;
      cx.beginPath(); cx.ellipse(-1, 0, 14, 11.5, 0, 0, TAU); cx.fill(); cx.stroke();
      // голова
      cx.beginPath(); cx.ellipse(10, 0, 8.5, 8, 0, 0, TAU); cx.fillStyle = body; cx.fill(); cx.stroke();
      // горловой мешок раздувается при приседе / квакании
      if ((o.crouch || 0) > 0.05 || o.croak) { cx.fillStyle = belly; cx.globalAlpha = 0.85; cx.beginPath(); cx.ellipse(15, 0, 3 + 3 * Math.max(o.crouch || 0, o.croak || 0), 2.4 + 2.5 * Math.max(o.crouch || 0, o.croak || 0), 0, 0, TAU); cx.fill(); cx.globalAlpha = 1; }
      // глаза
      for (const side of [-1, 1]) {
        cx.fillStyle = body; cx.beginPath(); cx.arc(12, side * 6, 4.4, 0, TAU); cx.fill(); cx.stroke();
        cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(13, side * 6, 3, 0, TAU); cx.fill();
        cx.fillStyle = '#10202a'; cx.beginPath(); cx.arc(14.2 + (o.look || 0) * 0.8, side * 6, 1.6, 0, TAU); cx.fill();
      }
      // пятнышки
      cx.fillStyle = edge; cx.globalAlpha = 0.28;
      for (let i = 0; i < 4; i++) { cx.beginPath(); cx.arc(-8 + (i % 2) * 6, -5 + (i >> 1) * 8 + (i % 2) * 2, 2.2, 0, TAU); cx.fill(); }
      cx.globalAlpha = 1;
      accessory(f, cx);
      cx.restore();
    }
    function accessory(f, c) {
      const k = (f.ci | 0) % 8;
      if (k === 1) { c.fillStyle = '#ffd23f'; c.beginPath(); c.moveTo(5, -4); c.lineTo(7, -9); c.lineTo(9, -5); c.lineTo(11, -9); c.lineTo(13, -4); c.closePath(); c.fill(); }
      else if (k === 2) { c.fillStyle = '#ff5d7e'; c.beginPath(); c.moveTo(2, 0); c.lineTo(-4, -5); c.lineTo(-4, 5); c.closePath(); c.fill(); c.beginPath(); c.arc(2, 0, 2, 0, TAU); c.fill(); }
      else if (k === 3) { c.strokeStyle = '#fff'; c.lineWidth = 1.4; c.beginPath(); c.moveTo(7, -3); c.quadraticCurveTo(2, -14, -1, -12); c.stroke(); c.fillStyle = '#ff5d7e'; c.beginPath(); c.arc(-1, -12, 2.6, 0, TAU); c.fill(); }
      else if (k === 4) { c.fillStyle = '#3b6bd9'; c.beginPath(); c.ellipse(4, 0, 6, 7.5, 0, 0, TAU); c.fill(); c.fillStyle = '#2a4faa'; c.beginPath(); c.ellipse(9, 0, 3, 7, 0, 0, TAU); c.fill(); }
      else if (k === 5) { c.fillStyle = '#ff9ac2'; for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU; c.beginPath(); c.ellipse(5 + Math.cos(a) * 2.4, -5 + Math.sin(a) * 2.4, 2.1, 1.3, a, 0, TAU); c.fill(); } c.fillStyle = '#ffe36a'; c.beginPath(); c.arc(5, -5, 1.2, 0, TAU); c.fill(); }
      else if (k === 6) { c.strokeStyle = '#222'; c.lineWidth = 1.3; c.beginPath(); c.arc(13, -6, 3.2, 0, TAU); c.arc(13, 6, 3.2, 0, TAU); c.moveTo(13, -2.8); c.lineTo(13, 2.8); c.stroke(); }
    }

    // ----- цапля -----
    function drawHeron(h, nowT, t) {
      const total = h.strikeAt - h.at, u = clamp((nowT - h.at) / total, 0, 1);
      // красная метка зоны
      const pulse = 0.5 + 0.5 * Math.sin(t * (8 + u * 16));
      cx.save();
      cx.fillStyle = `rgba(255,60,50,${0.1 + 0.18 * u})`; cx.beginPath(); cx.arc(h.x, h.y, h.r, 0, TAU); cx.fill();
      cx.strokeStyle = `rgba(255,${90 + 100 * pulse | 0},70,${0.55 + 0.4 * pulse})`; cx.lineWidth = 3; cx.setLineDash([10, 7]); cx.lineDashOffset = -t * 40;
      cx.beginPath(); cx.arc(h.x, h.y, h.r, 0, TAU); cx.stroke(); cx.setLineDash([]);
      // тень птицы: пикирует сверху-слева
      const k = 1 - u, bx = h.x - k * 180, by = h.y - k * 140, sc = 1.7 - u * 0.7, flap = Math.sin(t * 18) * 0.35;
      cx.translate(bx, by); cx.rotate(Math.atan2(140, 180) * 0.2); cx.scale(sc, sc); cx.fillStyle = 'rgba(0,10,16,0.55)';
      cx.beginPath(); cx.ellipse(0, 0, 10, 26, 0, 0, TAU); cx.fill();
      for (const sd of [-1, 1]) { cx.beginPath(); cx.moveTo(0, -4); cx.quadraticCurveTo(sd * 36, -10 + flap * 26 * sd, sd * 62, 8 + flap * 18 * sd); cx.quadraticCurveTo(sd * 36, 6, 0, 10); cx.closePath(); cx.fill(); }
      cx.beginPath(); cx.moveTo(-2, -24); cx.lineTo(0, -52); cx.lineTo(2, -24); cx.closePath(); cx.fill();
      cx.restore();
    }

    // ----- прицел -----
    function drawAim(a, m, nowT, t) {
      const me = m.frogs.get(m.myId);
      if (!me || !a || !a.active || me.st === 'out') return;
      const plan = P.jumpPlan(me.x, me.y, a.ang, a.pow, me.boost, m.R, m.cfg);
      const jm = P.jumpMax(m.R, m.cfg) * (me.boost ? m.cfg.FLY_BOOST : 1);
      // оценка места приземления
      const hit = P.padAt(m.pads, plan.tx, plan.ty, m.cfg);
      let kind = 'bad';
      if (hit && hit.state !== 'sunk') {
        const doomed = hit.sinkAt != null && hit.cause !== 'shrink' && (nowT + plan.dur) >= hit.sinkAt;
        const occ = [...m.frogs.values()].filter((o) => o !== me && o.st === 'pad' && o.pad === hit.id).length;
        kind = doomed ? 'bad' : occ >= hit.cap ? 'stomp' : hit.sinkAt != null ? 'risky' : 'ok';
      }
      const color = { ok: '120,255,150', stomp: '255,210,70', risky: '255,170,80', bad: '255,100,90' }[kind];
      // максимальная дальность
      cx.strokeStyle = 'rgba(255,255,255,0.1)'; cx.lineWidth = 1.2; cx.setLineDash([3, 6]); cx.beginPath(); cx.arc(me.x, me.y, jm, 0, TAU); cx.stroke(); cx.setLineDash([]);
      // дуга пунктиром
      for (let i = 1; i <= 14; i++) {
        const u = i / 15, p = P.jumpPos(plan, u);
        cx.fillStyle = `rgba(${color},${0.35 + 0.5 * u})`; cx.beginPath(); cx.arc(p.x, p.y - p.z * 0.55, 2.2 + u * 1.2, 0, TAU); cx.fill();
      }
      // кольцо приземления
      const pr = 14 + Math.sin(t * 9) * 1.5;
      cx.strokeStyle = `rgba(${color},0.95)`; cx.lineWidth = 3; cx.beginPath(); cx.arc(plan.tx, plan.ty, pr, 0, TAU); cx.stroke();
      cx.fillStyle = `rgba(${color},0.22)`; cx.beginPath(); cx.arc(plan.tx, plan.ty, pr, 0, TAU); cx.fill();
      if (kind === 'stomp') { cx.font = '700 14px Montserrat, sans-serif'; cx.textAlign = 'center'; cx.fillStyle = '#ffe28a'; cx.fillText('💥', plan.tx, plan.ty - pr - 6); }
      // резинка: от лягушки в сторону оттяжки
      const bx = me.x - Math.cos(a.ang) * (20 + a.pow * 34), by = me.y - Math.sin(a.ang) * (20 + a.pow * 34);
      cx.strokeStyle = 'rgba(255,240,200,0.85)'; cx.lineWidth = 2.4 + a.pow * 2;
      cx.beginPath(); cx.moveTo(me.x + Math.cos(a.ang + 1.5) * 8, me.y + Math.sin(a.ang + 1.5) * 8); cx.lineTo(bx, by); cx.lineTo(me.x + Math.cos(a.ang - 1.5) * 8, me.y + Math.sin(a.ang - 1.5) * 8); cx.stroke();
      cx.fillStyle = `rgba(${color},0.9)`; cx.beginPath(); cx.arc(bx, by, 4, 0, TAU); cx.fill();
    }

    // ===================================================================
    // кадр
    // ===================================================================
    r.draw = function (ts, c) {
      const m = r.model;
      const dt = r.lastTs ? Math.min(0.1, (ts - r.lastTs) / 1000) : 0.016;
      r.lastTs = ts;
      // адаптивное качество: кадры дольше 24 мс три секунды подряд — меньше частиц
      r.frameMs.push(dt * 1000); if (r.frameMs.length > 180) r.frameMs.shift();
      if (r.frameMs.length >= 150 && r.frameMs.reduce((s, v) => s + v, 0) / r.frameMs.length > 24) r.quality = Math.max(0.35, r.quality - 0.3), r.frameMs.length = 0;
      const t = ts / 1000;
      c = c || {};
      const nowT = c.nowT != null ? c.nowT : 0, renderT = c.renderT != null ? c.renderT : nowT;
      camera();
      cx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
      cx.clearRect(0, 0, r.w, r.h);
      r.shake = r.reduced ? 0 : Math.max(0, r.shake - dt * 30);
      const sh = r.shake, shx = (Math.random() - 0.5) * sh, shy = (Math.random() - 0.5) * sh;
      cx.translate(r.cam.ox + shx, r.cam.oy + shy); cx.scale(r.cam.s, r.cam.s);
      const R = (m && m.R) || 200;
      drawBackdrop(t, R); drawWater(t, R);
      stepParts(dt);
      // кольца на воде — под листьями
      for (const p of r.parts) if (p.k === 'ring') drawRing(p);
      for (const p of r.parts) if (p.k === 'bub') drawPart(p);
      if (m) {
        // кувшинки
        for (const p of m.pads) {
          const info = padInfo(p, nowT, m);
          if (info) { drawPad(p, info, t, nowT); if (info.state !== 'sinking') drawFlyOn(p, nowT, t); }
        }
        if (m.heron && m.phase === 'fight') drawHeron(m.heron, nowT, t);
        // лягушки сзади вперёд
        const list = [];
        for (const f of m.frogs.values()) {
          if (f.st === 'out' || f.st === 'removed' || f.st === 'watch' || f.st === 'lobby') continue;
          const mine = f.id === m.myId;
          const pos = m.posOf(f, mine ? nowT : renderT);
          list.push({ f, pos, mine });
        }
        list.sort((a, b) => a.pos.y - b.pos.y);
        r.names.length = 0;
        for (const it of list) {
          const { f, pos, mine } = it;
          let face = r.face.has(f.id) ? r.face.get(f.id) : Math.atan2(-pos.y, -pos.x);
          const aim = mine && c.aim && c.aim.active ? c.aim : null;
          if (aim) face = aim.ang;
          if (f.st === 'air' && f.jump) { face = f.jump.ang; r.face.set(f.id, face); }
          const cr = f.st === 'pad' ? clamp(((f.readyAt || 0) - (mine ? nowT : renderT)) / (m.cfg.CROUCH || 0.25), 0, 1) : 0;
          const air = f.st === 'air' && f.jump;
          const u = air ? clamp(((mine ? nowT : renderT) - f.jump.t0) / f.jump.dur, 0, 1) : 0;
          if (f.boost) { const g = cx.createRadialGradient(pos.x, pos.y, 4, pos.x, pos.y, 34); g.addColorStop(0, 'rgba(255,225,90,0.5)'); g.addColorStop(1, 'rgba(255,225,90,0)'); cx.fillStyle = g; cx.beginPath(); cx.arc(pos.x, pos.y, 34, 0, TAU); cx.fill(); }
          if (mine) { cx.strokeStyle = 'rgba(255,255,255,0.8)'; cx.lineWidth = 2; cx.setLineDash([5, 4]); cx.lineDashOffset = -t * 14; cx.beginPath(); cx.ellipse(pos.x, pos.y + 2, 24, 20, 0, 0, TAU); cx.stroke(); cx.setLineDash([]); }
          // кольцо усталости: лист под лягушкой «устаёт», дойдёт круг — лист начнёт тонуть (на месте не отсидеться)
          if (f.st === 'pad' && f.tireAt > 0 && m.phase === 'fight') {
            const pd = m.pads[f.pad], tn = mine ? nowT : renderT;
            if (pd && pd.state === 'ok' && pd.sinkAt == null) {
              const u = clamp(1 - (f.tireAt - tn) / (m.cfg.STAY_T || 9), 0, 1);
              if (u > 0.12) {
                const pulse = u > 0.82 ? 0.5 + 0.5 * Math.sin(t * 16) : 1;
                cx.lineWidth = 3.5; cx.lineCap = 'round';
                cx.strokeStyle = u < 0.6 ? 'rgba(255,230,120,0.6)' : u < 0.82 ? 'rgba(255,170,70,0.8)' : `rgba(255,80,70,${0.5 + 0.5 * pulse})`;
                cx.beginPath(); cx.arc(pd.x, pd.y, (pd._dr || pd.r) + 5, -Math.PI / 2, -Math.PI / 2 + u * TAU); cx.stroke();
              }
            }
          }
          drawFrog(f, pos, face, { air, u, crouch: aim ? aim.pow * 0.9 : cr, t, scale: mine ? 1.08 : 1, croak: f._croak > t ? 1 : 0, look: aim ? 1 : 0 });
          r.names.push({ f, x: pos.x, y: pos.y - (pos.z || 0) * 0.55, mine });
        }
        drawAim(c.aim, m, nowT, t);
        // тонущие лягушки
        for (let i = r.drown.length - 1; i >= 0; i--) {
          const d = r.drown[i]; d.life -= dt; if (d.life <= 0) { r.drown.splice(i, 1); continue; }
          const k = 1 - d.life / d.max;
          cx.save(); cx.globalAlpha = 1 - k; cx.translate(d.x, d.y + k * 8); cx.scale(1 - k * 0.5, 1 - k * 0.5);
          const col = FROG_COLORS[d.ci % FROG_COLORS.length];
          cx.fillStyle = col[0]; cx.beginPath(); cx.ellipse(0, 0, 13, 11, 0, 0, TAU); cx.fill(); cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(5, -4, 3, 0, TAU); cx.arc(5, 4, 3, 0, TAU); cx.fill();
          cx.restore();
        }
      }
      // остальные частицы
      for (const p of r.parts) { if (p.k !== 'ring' && p.k !== 'bub') drawPart(p); }
      // светлячки
      for (const f of r.flies) {
        const a = f.a + t * f.sp, d = (f.d + Math.sin(t * 0.3 + f.ph) * 0.08) * (R + 50);
        const x = Math.cos(a) * d, y = Math.sin(a * 1.1) * d * 0.9, b = 0.5 + 0.5 * Math.sin(t * 2 + f.ph);
        const g = cx.createRadialGradient(x, y, 0, x, y, 10 * f.sz); g.addColorStop(0, `rgba(220,255,140,${0.55 * b})`); g.addColorStop(1, 'rgba(220,255,140,0)');
        cx.fillStyle = g; cx.beginPath(); cx.arc(x, y, 10 * f.sz, 0, TAU); cx.fill();
        cx.fillStyle = `rgba(250,255,200,${0.9 * b})`; cx.beginPath(); cx.arc(x, y, f.sz * 0.7, 0, TAU); cx.fill();
      }
      // виньетка и вспышки — в экранных координатах
      cx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
      const vg = cx.createRadialGradient(r.w / 2, r.h / 2, Math.min(r.w, r.h) * 0.35, r.w / 2, r.h / 2, Math.max(r.w, r.h) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,6,10,0.65)');
      cx.fillStyle = vg; cx.fillRect(0, 0, r.w, r.h);
      if (r.flash > 0.01) { cx.fillStyle = `rgba(${r.flashColor},${r.flash})`; cx.fillRect(0, 0, r.w, r.h); r.flash *= 0.9; }
      // подписи имён
      cx.font = '700 12px Montserrat, sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'alphabetic';
      for (const n of r.names) {
        const s = r.w2s(n.x + (r.shake ? 0 : 0), n.y - 26 * r.cam.s / r.cam.s);
        const label = (n.f.name || '') + (n.mine ? ' ⬅' : '') + (n.f.online === false ? ' 📡' : '');
        const wdt = cx.measureText(label).width + 12;
        cx.fillStyle = n.mine ? 'rgba(255,214,64,0.92)' : 'rgba(4,22,34,0.72)';
        const y = s.y - 6;
        roundRect(s.x - wdt / 2, y - 12, wdt, 17, 8); cx.fill();
        cx.fillStyle = n.mine ? '#1b2a00' : '#eaf8ff'; cx.fillText(label, s.x, y + 1);
      }
      // текстовые частицы поверх
      for (const p of r.parts) if (p.k === 'text') {
        const s = r.w2s(p.x, p.y - p.z); cx.globalAlpha = clamp(p.life / p.max * 1.4, 0, 1); cx.font = '800 22px Montserrat, sans-serif'; cx.fillStyle = p.color; cx.fillText(p.s, s.x, s.y); cx.globalAlpha = 1;
      }
    };
    function roundRect(x, y, w, h, rr) { cx.beginPath(); cx.moveTo(x + rr, y); cx.arcTo(x + w, y, x + w, y + h, rr); cx.arcTo(x + w, y + h, x, y + h, rr); cx.arcTo(x, y + h, x, y, rr); cx.arcTo(x, y, x + w, y, rr); cx.closePath(); }
    function drawRing(p) {
      const k = 1 - p.life / p.max, rad = lerp(p.r0, p.r1, 1 - (1 - k) * (1 - k));
      cx.strokeStyle = `rgba(${p.color},${(1 - k) * 0.7})`; cx.lineWidth = p.w * (1 - k * 0.5);
      cx.beginPath(); cx.ellipse(p.x, p.y, rad, rad * 0.85, 0, 0, TAU); cx.stroke();
    }
    function drawPart(p) {
      const a = clamp(p.life / p.max, 0, 1);
      if (p.k === 'drop') { cx.fillStyle = `rgba(210,245,255,${a})`; cx.beginPath(); cx.arc(p.x, p.y - p.z * 0.6, p.size, 0, TAU); cx.fill(); }
      else if (p.k === 'bub') { cx.strokeStyle = `rgba(210,250,255,${a * 0.8})`; cx.lineWidth = 1; cx.beginPath(); cx.arc(p.x, p.y - p.z * 0.4, p.size, 0, TAU); cx.stroke(); }
      else if (p.k === 'spark') { cx.fillStyle = `rgba(${p.color},${a})`; cx.beginPath(); cx.arc(p.x, p.y - p.z * 0.6, p.size * (0.4 + a * 0.6), 0, TAU); cx.fill(); }
      else if (p.k === 'leaf') { cx.save(); cx.translate(p.x, p.y - p.z * 0.6); cx.rotate(p.rot); cx.globalAlpha = a; cx.fillStyle = '#4fae52'; cx.beginPath(); cx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, TAU); cx.fill(); cx.restore(); }
    }

    // подсказка для страницы: кто сейчас в кадре (для кликов по лягушке, если понадобится)
    r.frogAt = function (sx, sy) { const w = r.s2w(sx, sy); let best = null, bd = 34; for (const n of r.names) { const d = Math.hypot(n.x - w.x, n.y - w.y); if (d < bd) { bd = d; best = n.f; } } return best; };
    r.croak = function (id) { const m = r.model; const f = m && m.frogs.get(id); if (f) f._croak = performance.now() / 1000 + 0.35; };
    r.resize();
    window.addEventListener('resize', r.resize);
    return r;
  }

  window.PondRender = { create, Sound, FROG_COLORS };
})();
