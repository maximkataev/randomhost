/*
 * «Утиный сплав» — отрисовка реки на canvas. Картинка перенесена из duck-race.html
 * (трава, берега, слои воды, камни, брёвна, водовороты, кувшинки с лягушкой, шлюз, финиш, болельщики, утки);
 * одиночная страница не тронута. Рисует снимок движка (RapidsGame.snapshot), сама ничего не решает.
 *
 *   const r = RapidsRender.create(canvas, { me: 'id', meSuffix: ' · вы', topGap: 56, bottomGap: 90 });
 *   r.apply(snapshot, events);   // каждый кадр (или на каждый снимок с сервера)
 *   r.draw(t, dt);               // каждый кадр
 *
 * Нужен rapids/game.js (RapidsGame.makeCourse) — русло и препятствия строятся по seed из снимка.
 * Новое против одиночной: быстрые струи на воде, подсветка своей утки, полоса прогресса справа,
 * плашки уток за кадром, места доплывших, корона чемпиона и микрофон ведущего.
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rnd = Math.random;
  const rr = (a, b) => a + (b - a) * rnd();
  function smooth01(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const TILE_H = 640;
  // На низком широком поле (телефон в ландшафте) реки должно быть видно не меньше стольких единиц
  const MIN_VH = 320;
  // в игре кроме того видно не меньше стольких единиц реки между панелями интерфейса — иначе на мониторе не видно, что впереди
  const PLAY_VH = 480;
  const FONT = 'Montserrat, -apple-system, BlinkMacSystemFont, sans-serif';

  // те же 20 расцветок, что в duck-race.html: основной, тёмный, светлый
  const DUCK_COLORS = [
    ['#ffd23f', '#e0a800', '#fff3b0'], ['#ff9f43', '#d9731c', '#ffd2a3'], ['#ff8fb1', '#d9607f', '#ffd0de'],
    ['#7fe0b0', '#3fb07c', '#c9f5de'], ['#7cc6ff', '#3f8fd6', '#cbe8ff'], ['#b79cff', '#8264e0', '#e3d8ff'],
    ['#f6f2e8', '#c9c0ad', '#ffffff'], ['#ff6b6b', '#cf4040', '#ffc0c0'], ['#c7e86b', '#93b83a', '#ecf8c4'],
    ['#ffc09f', '#df9068', '#ffe3d3'], ['#5fd3d0', '#2fa3a0', '#bdf1ef'], ['#e0a3f0', '#b06fc8', '#f4d6fa'],
    ['#ffe08a', '#d9b44a', '#fff4cc'], ['#ff7f6e', '#d45443', '#ffc6bd'], ['#6f8cff', '#4461d6', '#c7d3ff'],
    ['#55555f', '#2e2e36', '#8b8b96'], ['#f7a8c8', '#cf7aa0', '#fcdbe8'], ['#b9c27a', '#8b944c', '#e0e6bb'],
    ['#8ee8ff', '#4bb8d6', '#d3f7ff'], ['#e8cf9a', '#bfa062', '#f6ead0'],
  ];
  const ciIdx = (ci) => ((ci | 0) % DUCK_COLORS.length + DUCK_COLORS.length) % DUCK_COLORS.length;
  const colorOf = (ci) => DUCK_COLORS[ciIdx(ci)];

  const SKIN = ['#f5d0b5', '#e8b894', '#d49a6a', '#a8714a', '#7a4e2d', '#f1c6a6'];
  const HAIR = ['#2b1d14', '#5a3a22', '#8a5a2b', '#d9b36c', '#1b1b1f', '#b5482f', '#e8e2d6'];
  const SHIRT = ['#ff6b6b', '#ffd23f', '#5fd3d0', '#7cc6ff', '#b79cff', '#ff9f43', '#7fe0b0', '#f6f2e8', '#ff8fb1', '#6f8cff'];
  const SHALLOW = [127, 214, 194];
  const DEEP = [26, 104, 128];
  function mix(a, b, t) {
    return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
  }

  // ----- Звук (синтез, как в одиночной игре; общий выключатель — sound-toggle.js) -----
  // sound-toggle.js подменяет AudioNode.connect: всё, что идёт в динамики, проходит через его общий регулятор.
  // Поэтому достаточно подключить его раньше этого файла. Пока звук выключен, узлы даже не создаём.
  const Sound = (() => {
    let ac = null, noiseBuf = null, amb = null;
    const last = {};
    const gate = (k, gap) => { const n = performance.now(); if (n - (last[k] || 0) < gap) return false; last[k] = n; return true; };
    const muted = () => !!(root.SoundToggle && root.SoundToggle.muted);
    function ensure() {
      if (!ac) { const AC = root.AudioContext || root.webkitAudioContext; if (AC) ac = new AC(); }
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    }
    function tone(freq, dur, type, vol, delay = 0, endFreq = null) {
      if (!ac || muted()) return;
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
    function getNoise() {
      if (!noiseBuf) {
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
        const ch = noiseBuf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
      }
      return noiseBuf;
    }
    function noise(dur, f0, f1, vol, type = 'lowpass', delay = 0, q = 0.8) {
      if (!ac || muted()) return;
      try {
        const t0 = ac.currentTime + delay;
        const src = ac.createBufferSource();
        src.buffer = getNoise();
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
    function quack(pitch = 1, delay = 0) {
      if (!ac || muted()) return;
      try {
        const t0 = ac.currentTime + delay;
        const o = ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(560 * pitch, t0);
        o.frequency.exponentialRampToValueAtTime(320 * pitch, t0 + 0.17);
        const bp = ac.createBiquadFilter();
        bp.type = 'bandpass'; bp.Q.value = 4;
        bp.frequency.setValueAtTime(1350 * pitch, t0);
        bp.frequency.exponentialRampToValueAtTime(780 * pitch, t0 + 0.17);
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        o.connect(bp); bp.connect(g); g.connect(ac.destination);
        o.start(t0); o.stop(t0 + 0.24);
      } catch (e) {}
    }
    // шум воды на весь заплыв; выключатель сайта глушит его общим регулятором
    function ambience(on) {
      if (!ac) return;
      if (on) {
        if (amb || muted()) return;
        try {
          const src = ac.createBufferSource();
          src.buffer = getNoise();
          src.loop = true;
          const f = ac.createBiquadFilter();
          f.type = 'lowpass'; f.frequency.value = 650;
          const g = ac.createGain();
          g.gain.setValueAtTime(0.0001, ac.currentTime);
          g.gain.exponentialRampToValueAtTime(0.05, ac.currentTime + 0.8);
          src.connect(f); f.connect(g); g.connect(ac.destination);
          src.start();
          amb = { src, g };
        } catch (e) {}
      } else if (amb) {
        const a = amb;
        amb = null;
        try {
          a.g.gain.setValueAtTime(Math.max(0.0001, a.g.gain.value), ac.currentTime);
          a.g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 1.2);
          a.src.stop(ac.currentTime + 1.3);
        } catch (e) {}
      }
    }
    return {
      ensure,
      ambience,
      quack(p, d) { if (!gate('quack', 140)) return; quack(p || rr(0.9, 1.3), d || 0); },
      splash(v = 0.14) { if (!gate('splash', 110)) return; noise(0.28, 2600, 380, v); },
      hit(k = 1) { if (!gate('hit', 60)) return; tone(170, 0.12, 'sine', 0.16 * k, 0, 80); noise(0.28, 2600, 380, 0.1 * k); },
      bump(k = 1) { if (!gate('bump', 80)) return; tone(150, 0.1, 'sine', 0.14 * k, 0, 80); noise(0.12, 1400, 300, 0.08 * k); },
      log() { if (!gate('hit', 60)) return; tone(120, 0.16, 'triangle', 0.18, 0, 70); noise(0.22, 1800, 300, 0.1); },
      whirl() { if (!gate('whirl', 300)) return; noise(0.95, 300, 1500, 0.09, 'bandpass', 0, 2.2); },
      gate() { noise(1.2, 1100, 240, 0.22); tone(110, 0.35, 'triangle', 0.16, 0, 60); },
      tick() { tone(660, 0.12, 'triangle', 0.2); },
      go() { tone(880, 0.12, 'square', 0.12); tone(1320, 0.3, 'square', 0.12, 0.1); },
      whistle(d = 0) { tone(2350, 0.16, 'sine', 0.16, d, 2600); tone(2350, 0.34, 'sine', 0.16, d + 0.22, 2500); },
      cheer() {
        for (let i = 0; i < 5; i++) noise(1.8 + i * 0.2, rr(900, 1400), rr(1700, 2600), 0.08, 'bandpass', i * 0.12, 0.9);
        [0, 0.35, 0.7].forEach(d => tone(rr(700, 950), 0.25, 'triangle', 0.05, d, rr(1100, 1400)));
      },
      crowd() { if (!gate('crowd', 600)) return; noise(1.6, 600, 1500, 0.07, 'bandpass', 0, 1.1); },
      finish() { if (!gate('finish', 120)) return; noise(0.3, 2600, 380, 0.12); tone(1046, 0.18, 'triangle', 0.08, 0.05); },
      host() { tone(392, 0.22, 'triangle', 0.18); tone(311, 0.22, 'triangle', 0.18, 0.18); tone(233, 0.5, 'triangle', 0.18, 0.36); },
      win() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.3, 'triangle', 0.2, i * 0.11)); quack(1.2, 0.5); },
    };
  })();

  // ===================================================================
  function create(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const RG = () => root.RapidsGame;
    let cfg = Object.assign({}, RG() ? RG().DEFAULTS : {});
    let me = opts.me || null;
    let topGap = opts.topGap || 0, bottomGap = opts.bottomGap || 0;
    const meSuffix = () => (opts.meSuffix != null ? opts.meSuffix : ' · вы');
    // надписи над своей уткой — со страницы, на языке интерфейса
    const words = Object.assign({ bump: 'БУМ!', ouch: 'ОЙ!', whirl: 'ВОДОВОРОТ!' }, opts.words || {});

    let view = { w: 0, h: 0, dpr: 1, scale: 1, vh: 600, offX: 0 };
    let gapsKey = '';
    const cam = { y: 0 };
    let camSnap = true;
    const shakeFx = { a: 0, x: 0, y: 0 };
    let focus = null, focusKind = null;

    let course = null, courseKey = '', worldSeed = 0;
    let W = { W: 440, H: 1000, GATE: 250, FIN: 800, CLEAN: 420, DR: 12 };
    const tiles = new Map();
    let trees = [], crowd = [];
    let duckSprites = [], glowSprite = null, sparkSprite = null;

    let snap = null, snapAt = 0;
    const byId = new Map();
    const vis = new Map();
    const gate = { open: 0, opening: false };
    const ribbon = { broken: false, x: 0, t: -99 };
    const cheer = { level: 0 };
    const ripples = [], drops = [], feathers = [], popups = [];
    const flash = { a: 0 };
    let simT = 0;
    let lastPhase = null;
    let meFinAt = -1;

    const streaks = Array.from({ length: 70 }, () => ({ d: 0, y: -9999, len: 0, a: 0, w: 1, sp: 1 }));
    const sparkles = Array.from({ length: 30 }, () => ({ d: 0, y: -9999, ph: 0, sp: 1, life: 1 }));

    const inView = (y, m) => y > cam.y - m && y < cam.y + view.vh + m;
    const sxOf = (x) => view.offX + x * view.scale + shakeFx.x;
    const syOf = (y) => (y - cam.y) * view.scale + shakeFx.y;
    const inFinishZone = (y, m = 0) => y > W.FIN - W.CLEAN - m && y < W.FIN + 150 + m;

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

    // ----- Холст и спрайты -----
    // размеры холста читаем только после изменения окна: чтение clientWidth каждый кадр заставляло браузер пересчитывать раскладку
    // (объявлено через var: setCourse может позвать пересчёт раньше, чем дойдёт эта строка)
    var sizeDirty = true;
    root.addEventListener && root.addEventListener('resize', () => { sizeDirty = true; });
    if (root.ResizeObserver) new root.ResizeObserver(() => { sizeDirty = true; }).observe(canvas);
    function resize() {
      if (!sizeDirty && duckSprites.length && gapsKey === topGap + ':' + bottomGap) return;
      sizeDirty = false;
      const w = Math.max(200, canvas.clientWidth || canvas.width || 400);
      const h = Math.max(150, canvas.clientHeight || canvas.height || 600);
      // на телефонах плотность пикселей ограничена 1,5: разница на глаз мала, а кадр вдвое дешевле
      const coarse = root.matchMedia && root.matchMedia('(pointer: coarse)').matches;
      const dpr = Math.min(root.devicePixelRatio || 1, coarse ? 1.5 : 2);
      if (w === view.w && h === view.h && dpr === view.dpr && duckSprites.length && gapsKey === topGap + ':' + bottomGap) return;
      gapsKey = topGap + ':' + bottomGap;
      const minVh = opts.minVh || PLAY_VH;
      const scale = Math.min(w / W.W, h / MIN_VH, Math.max(120, h - topGap - bottomGap) / minVh);
      view = { w, h, dpr, scale, vh: h / scale, offX: (w - W.W * scale) / 2 };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      tiles.clear();
      for (const tr of trees) tr.spr = null;
      buildSprites();
      camSnap = true;
    }

    function paintDuck(g, c) {
      g.fillStyle = c[1];
      g.beginPath();
      g.moveTo(-16.5, 0);
      g.quadraticCurveTo(-12, -5.5, -7, -5.2);
      g.lineTo(-7, 5.2);
      g.quadraticCurveTo(-12, 5.5, -16.5, 0);
      g.fill();
      let gr = g.createRadialGradient(-4, -3, 1, -1, 0, 14);
      gr.addColorStop(0, c[2]);
      gr.addColorStop(0.55, c[0]);
      gr.addColorStop(1, c[1]);
      g.fillStyle = gr;
      ell(g, -1, 0, 13, 10);
      g.globalAlpha = 0.55;
      g.fillStyle = c[1];
      ell(g, -3, -6.2, 7.5, 3.2, -0.18);
      ell(g, -3, 6.2, 7.5, 3.2, 0.18);
      g.globalAlpha = 1;
      gr = g.createRadialGradient(6, -2.5, 0.5, 8, 0, 7.5);
      gr.addColorStop(0, c[2]);
      gr.addColorStop(0.6, c[0]);
      gr.addColorStop(1, c[1]);
      g.fillStyle = gr;
      circle(g, 8, 0, 6.8);
      g.fillStyle = '#ff8b24';
      ell(g, 14.6, 0, 4.3, 3);
      g.fillStyle = '#d9650c';
      ell(g, 15.6, 0, 2.6, 0.6);
      g.fillStyle = '#1b1b1f';
      circle(g, 10, -3.7, 1.4);
      circle(g, 10, 3.7, 1.4);
      g.fillStyle = '#ffffff';
      circle(g, 10.4, -4.1, 0.45);
      circle(g, 10.4, 3.3, 0.45);
      g.fillStyle = 'rgba(255,255,255,0.45)';
      ell(g, -4.5, -3.6, 5, 2, -0.35);
      ell(g, 6.5, -2.8, 2.2, 1.1, -0.5);
    }

    function buildSprites() {
      const k = view.scale * view.dpr;
      duckSprites = DUCK_COLORS.map((c) => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = Math.ceil(40 * k);
        const g = cv.getContext('2d');
        g.setTransform(k, 0, 0, k, 20 * k, 20 * k);
        paintDuck(g, c);
        return cv;
      });
      // мягкое свечение под своей уткой
      glowSprite = document.createElement('canvas');
      glowSprite.width = glowSprite.height = Math.ceil(64 * k);
      let g = glowSprite.getContext('2d');
      g.setTransform(k, 0, 0, k, 32 * k, 32 * k);
      let gr = g.createRadialGradient(0, 0, 4, 0, 0, 32);
      gr.addColorStop(0, 'rgba(255,255,240,0.75)');
      gr.addColorStop(0.45, 'rgba(255,250,210,0.35)');
      gr.addColorStop(1, 'rgba(255,250,210,0)');
      g.fillStyle = gr;
      circle(g, 0, 0, 32);
      // блик на воде
      sparkSprite = document.createElement('canvas');
      sparkSprite.width = Math.ceil(10 * k); sparkSprite.height = Math.ceil(10 * k);
      g = sparkSprite.getContext('2d');
      g.setTransform(k, 0, 0, k * 0.44, 5 * k, 5 * k);
      gr = g.createRadialGradient(0, 0, 0, 0, 0, 5);
      gr.addColorStop(0, 'rgba(255,255,255,0.7)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      circle(g, 0, 0, 5);
    }

    // ----- Мир по сиду -----
    function setCourse(seed) {
      const G = RG();
      if (!G) return;
      const key = seed + '|' + cfg.LEN + '|' + cfg.DR;
      if (key === courseKey) return;
      courseKey = key;
      course = G.makeCourse(seed >>> 0, cfg);
      worldSeed = (seed ^ 0x2545f491) >>> 0;
      W = { W: course.WORLD_W, H: course.WORLD_H, GATE: course.GATE_Y, FIN: course.FINISH_Y, CLEAN: course.CLEAN, DR: cfg.DR || 12 };
      // кувшинки качаются под утками, лягушка сидит на своей и прыгает, когда утка рядом
      for (const L of course.lilies) {
        for (const p of L.pads) { p.ox = 0; p.oy = 0; p.wob = 0; }
        const pad = L.frogPad >= 0 ? L.pads[L.frogPad] : null;
        L.frog = pad ? { pad, state: 'sit', t: 0, ang: mulberry32((seed ^ Math.round(pad.x * 7 + pad.y)) >>> 0)() * TAU, x: 0, y: 0, tx: 0, ty: 0 } : null;
      }
      tiles.clear();
      trees = buildTrees();
      crowd = buildCrowd();
      ripples.length = drops.length = feathers.length = 0;
      for (const s of streaks) s.y = -9999;
      for (const s of sparkles) s.life = 1;
      sizeDirty = true;   // ширина мира могла поменяться — пересчитать масштаб
      camSnap = true;
    }

    // ----- Статичный мир (трава, берега, дно, струи) режется на тайлы -----
    function riverLayer(g, y0, y1, extra, color, k = 1) {
      const c = course;
      const ys = [];
      for (let y = y0; y < y1 + 6; y += 6) ys.push(y);
      const width = (y) => { const hw = c.riverHw(y); return hw * k + extra * Math.min(1, hw / 30); };
      g.fillStyle = color;
      g.beginPath();
      ys.forEach((y, i) => { const x = c.riverCx(y) - width(y); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      for (let i = ys.length - 1; i >= 0; i--) g.lineTo(c.riverCx(ys[i]) + width(ys[i]), ys[i]);
      g.closePath();
      g.fill();
    }

    function bandRng(b, salt) {
      return mulberry32((worldSeed ^ Math.imul(b + salt, 2654435761)) >>> 0);
    }

    function drawGrassBand(g, b, sx = 0) {
      const c = course;
      const r = bandRng(b, 1000 + (sx > 0 ? 7919 : sx < 0 ? 104729 : 0));
      const y0 = b * 80;
      for (let i = 0; i < 3; i++) {
        g.fillStyle = r() < 0.5 ? 'rgba(120,180,90,0.13)' : 'rgba(15,50,22,0.16)';
        circle(g, r() * W.W, y0 + r() * 80, 26 + r() * 46);
      }
      g.lineCap = 'round';
      const blades = ['#5f9e4a', '#2c6230', '#78b457', '#467f3b'];
      for (let i = 0; i < 70; i++) {
        const x = r() * W.W, y = y0 + r() * 80, bw = r(), bh = r(), bc = r();
        if (!sx && Math.abs(x - c.riverCx(y)) < c.riverHw(y) + 12) continue;
        g.strokeStyle = blades[Math.floor(bc * blades.length)];
        g.lineWidth = 1 + bw;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (bw - 0.5) * 4, y - 3 - bh * 6);
        g.stroke();
      }
      for (let i = 0; i < 3; i++) {
        const x = r() * W.W, y = y0 + r() * 80, kind = r();
        if (!sx && Math.abs(x - c.riverCx(y)) < c.riverHw(y) + 22) continue;
        g.fillStyle = ['#fff7e6', '#ffd23f', '#ff9fc0', '#c9b2ff'][Math.floor(kind * 4)];
        for (let p = 0; p < 5; p++) {
          const a = (p / 5) * TAU;
          circle(g, x + Math.cos(a) * 2.6, y + Math.sin(a) * 2.6, 1.9);
        }
        g.fillStyle = '#e39b1b';
        circle(g, x, y, 1.4);
      }
    }

    function drawBankBand(g, b) {
      const c = course;
      const r = bandRng(b, 5000);
      const y0 = b * 80;
      for (let i = 0; i < 3; i++) {
        const y = y0 + r() * 80, d = r() * 1.6 - 0.8, rx = 5 + r() * 9, ry = rx * (0.5 + r() * 0.4), rot = r() * 3;
        const hw = c.riverHw(y);
        if (hw < 30) continue;
        g.fillStyle = 'rgba(8,40,48,0.10)';
        ell(g, c.riverCx(y) + d * hw * 0.85, y, rx, ry, rot);
      }
      for (const side of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          const y = y0 + r() * 80, off = r() * 12 - 3, rx = 1.6 + r() * 2.6, tone = r();
          const hw = c.riverHw(y);
          if (hw < 20) continue;
          const cc = Math.round(150 + tone * 70);
          g.fillStyle = `rgb(${cc},${cc - 6},${cc - 18})`;
          ell(g, c.riverCx(y) + side * (hw + off), y, rx, rx * 0.75, tone * 3);
        }
        const reedRoll = r(), ry = y0 + r() * 80, stems = 5 + Math.floor(r() * 5);
        if (reedRoll < 0.45 && c.riverHw(ry) > 40 && Math.abs(ry - W.GATE) > 40 && !inFinishZone(ry, 30)) {
          const bx = c.riverCx(ry) + side * (c.riverHw(ry) + 4);
          g.lineWidth = 1.8;
          for (let k = 0; k < stems; k++) {
            const a = (side < 0 ? 0 : Math.PI) + (r() - 0.5) * 1.6;
            const len = 12 + r() * 16, sx = bx + (r() - 0.5) * 10, sy = ry + (r() - 0.5) * 16;
            const ex = sx + Math.cos(a) * len, ey = sy + Math.sin(a) * len;
            g.strokeStyle = r() < 0.5 ? '#2f5d2a' : '#48793a';
            g.beginPath();
            g.moveTo(sx, sy);
            g.lineTo(ex, ey);
            g.stroke();
            if (r() < 0.45) {
              g.fillStyle = '#6b4526';
              ell(g, ex, ey, 4, 1.9, a);
            }
          }
        }
        const bushRoll = r(), by = y0 + r() * 80, bOff = 30 + r() * 50, bR = 9 + r() * 9;
        const blobs = [0, 1, 2, 3].map(() => [r() - 0.5, r() - 0.5, 0.55 + r() * 0.3]);
        if (bushRoll < 0.35 && !inFinishZone(by, 40)) {
          const bx = c.riverCx(by) + side * (c.riverHw(by) + bOff);
          g.fillStyle = 'rgba(8,30,12,0.3)';
          circle(g, bx + 4, by + 5, bR * 1.05);
          blobs.forEach((bl, k) => {
            g.fillStyle = k === 3 ? '#4f8f45' : '#2d6a31';
            circle(g, bx + bl[0] * bR, by + bl[1] * bR, bR * bl[2]);
          });
        }
      }
    }

    // Быстрые струи: светлая полоса вдоль оси струи, к концам сужается. Бегущие шевроны — поверх, каждый кадр
    function streamFade(s, y) {
      return smooth01(s.y0 - 40, s.y0 + 60, y) * (1 - smooth01(s.y1 - 60, s.y1 + 40, y));
    }
    function streamBand(g, s, y0, y1, k, color) {
      const a = Math.max(s.y0 - 40, y0), b = Math.min(s.y1 + 40, y1);
      if (b <= a) return;
      const ys = [];
      for (let y = a; y < b + 5; y += 5) ys.push(Math.min(y, b));
      const half = (y) => s.w * k * (0.15 + 0.85 * streamFade(s, y));
      g.fillStyle = color;
      g.beginPath();
      ys.forEach((y, i) => { const x = course.streamX(s, y) - half(y); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      for (let i = ys.length - 1; i >= 0; i--) g.lineTo(course.streamX(s, ys[i]) + half(ys[i]), ys[i]);
      g.closePath();
      g.fill();
    }
    function drawStreamGround(g, y0, y1) {
      for (const s of course.streams) {
        if (s.y1 + 40 < y0 || s.y0 - 40 > y1) continue;
        streamBand(g, s, y0, y1, 1.25, 'rgba(150,245,230,0.17)');
        streamBand(g, s, y0, y1, 0.95, 'rgba(170,250,238,0.2)');
        streamBand(g, s, y0, y1, 0.5, 'rgba(215,255,248,0.2)');
      }
    }

    function drawWorldBand(g, y0, y1) {
      // по бокам от мира (если поле шире) — продолжение газона
      const ex = view.offX / view.scale;
      g.fillStyle = '#3d7a3a';
      g.fillRect(-ex - 2, y0, W.W + ex * 2 + 4, y1 - y0);
      const b0 = Math.floor((y0 - 40) / 80), b1 = Math.floor((y1 + 40) / 80);
      for (const sx of ex > 0 ? [-W.W, 0, W.W] : [0]) {
        g.save();
        g.translate(sx, 0);
        for (let b = b0; b <= b1; b++) drawGrassBand(g, b, sx);
        g.restore();
      }
      const top = y0 - 20, bottom = y1 + 20;
      riverLayer(g, top, bottom, 22, 'rgba(24,52,22,0.35)');
      riverLayer(g, top, bottom, 12, '#c9b27c');
      riverLayer(g, top, bottom, 5, '#8f8a5c');
      const LAYERS = 16;
      for (let i = 0; i < LAYERS; i++) {
        const t = i / (LAYERS - 1);
        riverLayer(g, top, bottom, 0, mix(SHALLOW, DEEP, t), 1 - t * 0.78);
      }
      drawStreamGround(g, top, bottom);
      for (let b = b0; b <= b1; b++) drawBankBand(g, b);
      drawFinishGround(g, y0, y1);
    }

    // Клетчатая линия финиша на берегах и ограждение вдоль финишной прямой
    function drawFinishGround(g, y0, y1) {
      const c = course;
      const top = W.FIN - W.CLEAN, bottom = W.FIN + 150;
      if (bottom < y0 - 40 || top > y1 + 40) return;
      const cx = c.riverCx(W.FIN), hw = c.riverHw(W.FIN);
      const fy = W.FIN - 6;
      const ex = view.offX / view.scale;
      for (const [a, b] of [[-ex, cx - hw - 12], [cx + hw + 12, W.W + ex]]) {
        for (let x = a, i = 0; x < b; x += 6, i++) {
          for (let j = 0; j < 2; j++) {
            g.fillStyle = (i + j) % 2 ? '#1f2328' : '#f4f1e6';
            g.fillRect(x, fy + j * 6, Math.min(6, b - x), 6);
          }
        }
      }
      g.lineCap = 'round';
      for (const side of [-1, 1]) {
        const posts = [];
        for (let y = top - 10; y <= bottom; y += 30) posts.push([c.riverCx(y) + side * (c.riverHw(y) + 21), y]);
        g.beginPath();
        posts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.strokeStyle = 'rgba(8,30,12,0.3)';
        g.lineWidth = 2.4;
        g.save();
        g.translate(2, 3);
        g.stroke();
        g.restore();
        g.strokeStyle = '#fbfbf7';
        g.lineWidth = 1.8;
        g.stroke();
        g.setLineDash([5, 5]);
        g.strokeStyle = '#e63946';
        g.stroke();
        g.setLineDash([]);
        for (const [x, y] of posts) {
          g.fillStyle = 'rgba(8,30,12,0.35)';
          circle(g, x + 1.5, y + 2, 2.8);
          g.fillStyle = '#5b3a1f';
          circle(g, x, y, 2.6);
        }
      }
    }

    function getTile(i) {
      let t = tiles.get(i);
      if (t) return t;
      const k = view.scale * view.dpr;
      const t0 = performance.now();
      t = document.createElement('canvas');
      t.width = canvas.width;
      t.height = Math.ceil(TILE_H * k) + 2;
      const g = t.getContext('2d');
      g.setTransform(k, 0, 0, k, view.offX * view.dpr, -i * TILE_H * k);
      drawWorldBand(g, i * TILE_H, (i + 1) * TILE_H + 4 / k);
      tiles.set(i, t);
      stats.tiles++; stats.tileMs += performance.now() - t0;
      return t;
    }

    // в кэше — только видимые тайлы и по одному сверху и снизу: мир длинный, память на телефоне не бесконечная
    function trimTiles(first, last) {
      const fy = focus && byId.get(focus) ? Math.floor(posOf(byId.get(focus))[1] / TILE_H) : null;
      for (const key of [...tiles.keys()]) if ((key < first - 1 || key > last + 1) && (fy == null || Math.abs(key - fy) > 1)) tiles.delete(key);
    }

    // ----- Деревья над водой (каждое — готовая картинка, кадр рисует её одним drawImage) -----
    function buildTrees() {
      const c = course;
      const r = mulberry32((worldSeed ^ 0x9e3779b9) >>> 0);
      const list = [];
      for (let y = 30; y < W.H; y += 110 + r() * 90) {
        const side = r() < 0.5 ? -1 : 1;
        const rad = 38 + r() * 30;
        const shift = r() * 25;
        const blobs = [];
        for (let i = 0; i < 6; i++) {
          const a = r() * TAU, dd = r() * rad * 0.5;
          blobs.push([Math.cos(a) * dd, Math.sin(a) * dd, rad * (0.45 + r() * 0.3)]);
        }
        const spk = [];
        for (let i = 0; i < 7; i++) spk.push([(r() - 0.6) * rad * 0.9, (r() - 0.6) * rad * 0.9, 2 + r() * 4]);
        const ph = r() * TAU;
        if (Math.abs(y - W.GATE) < 70 || inFinishZone(y, rad)) continue;
        const x = c.riverCx(y) + side * (c.riverHw(y) + rad * 0.55 + shift);
        let ext = 0;
        for (const b of blobs) ext = Math.max(ext, Math.hypot(b[0], b[1]) + b[2] + 3);
        list.push({ x, y, rad, blobs, spk, ph, ext, spr: null });
      }
      return list;
    }

    function treeSprite(tr) {
      if (tr.spr) return tr.spr;
      stats.trees++;
      const k = view.scale * view.dpr;
      const E = tr.ext;
      const cv = document.createElement('canvas');
      cv.width = cv.height = Math.ceil(E * 2 * k);
      const g = cv.getContext('2d');
      g.setTransform(k, 0, 0, k, E * k, E * k);
      g.fillStyle = '#1d4724';
      g.beginPath();
      for (const b of tr.blobs) {
        g.moveTo(b[0] + b[2] + 2, b[1]);
        g.arc(b[0], b[1], b[2] + 2, 0, TAU);
      }
      g.fill();
      for (const b of tr.blobs) {
        const gr = g.createRadialGradient(b[0] - b[2] * 0.35, b[1] - b[2] * 0.4, 1, b[0], b[1], b[2]);
        gr.addColorStop(0, '#6aa855');
        gr.addColorStop(0.7, '#357438');
        gr.addColorStop(1, '#285d2d');
        g.fillStyle = gr;
        circle(g, b[0], b[1], b[2]);
      }
      g.fillStyle = 'rgba(180,225,130,0.22)';
      for (const s of tr.spk) circle(g, s[0], s[1], s[2]);
      tr.spr = cv;
      return cv;
    }

    function drawTreeShadows() {
      ctx.fillStyle = 'rgba(2,26,20,0.2)';
      ctx.beginPath();
      for (const tr of trees) {
        if (!inView(tr.y, tr.rad + 40)) continue;
        for (const b of tr.blobs) {
          ctx.moveTo(tr.x + b[0] + 16 + b[2], tr.y + b[1] + 20);
          ctx.arc(tr.x + b[0] + 16, tr.y + b[1] + 20, b[2], 0, TAU);
        }
      }
      ctx.fill();
    }

    function drawTrees(t) {
      for (const tr of trees) {
        if (!inView(tr.y, tr.ext + 20)) {
          if (tr.spr && !inView(tr.y, view.vh)) tr.spr = null;
          continue;
        }
        const sx = tr.x + Math.sin(t * 0.6 + tr.ph) * 1.4;
        const sy = tr.y + Math.cos(t * 0.5 + tr.ph) * 1;
        ctx.drawImage(treeSprite(tr), sx - tr.ext, sy - tr.ext, tr.ext * 2, tr.ext * 2);
      }
    }

    // ----- Болельщики вдоль финишной прямой -----
    function buildCrowd() {
      const c = course;
      const r = mulberry32((worldSeed ^ 0x51ed270b) >>> 0);
      const pick = (arr) => arr[Math.floor(r() * arr.length)];
      const list = [];
      const y0 = W.FIN - W.CLEAN + 20, y1 = W.FIN + 130;
      for (const side of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          for (let y = y0 + r() * 8; y < y1; y += 15 + r() * 5) {
            const skip = r() < 0.12 + row * 0.1;
            const jx = (r() - 0.5) * 6, jy = (r() - 0.5) * 6, roll = r();
            const person = {
              side, skin: pick(SKIN), hair: pick(HAIR), shirt: pick(SHIRT), propColor: pick(SHIRT),
              prop: roll < 0.16 ? 'flag' : roll < 0.26 ? 'sign' : roll < 0.32 ? 'foam' : null,
              ph: r() * TAU, sp: 0.8 + r() * 0.5, cap: r() < 0.25,
            };
            if (skip) continue;
            const x = c.riverCx(y) + side * (c.riverHw(y) + 34 + row * 16 + jx);
            if (x < 6 || x > W.W - 6) continue;
            list.push(Object.assign(person, { x, y: y + jy, ang: side < 0 ? 0 : Math.PI }));
          }
        }
      }
      return list.sort((a, b) => a.y - b.y);
    }

    function drawCrowd(t) {
      if (!inView(W.FIN, W.CLEAN + 170)) return;
      const lv = cheer.level;
      for (const p of crowd) {
        if (!inView(p.y, 20)) continue;
        const wave = Math.sin(t * 9 * p.sp + p.ph);
        const hop = Math.max(0, wave) * lv;
        const up = lv * (0.6 + 0.4 * wave);
        ctx.fillStyle = 'rgba(8,30,12,0.28)';
        ell(ctx, p.x + 3 + hop * 3, p.y + 4 + hop * 3, 7, 8.5);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.ang + Math.sin(t * 1.3 * p.sp + p.ph) * 0.12 * (1 - lv));
        const s = 1.12 * (1 + hop * 0.14);
        ctx.scale(s, s);
        // руки: в покое вдоль тела, при крике вскинуты к воде
        const hx = lerp(-1, 7, up);
        ctx.fillStyle = p.skin;
        for (const k of [-1, 1]) circle(ctx, hx, k * lerp(7.5, 8.5 + 1.5 * Math.sin(t * 12 + p.ph + k), up), 2.1);
        if (p.prop === 'foam') {
          ctx.fillStyle = '#ffd23f';
          ell(ctx, hx + 2, 8.5, 3.6, 2.5);
        }
        if (p.prop === 'flag') {
          const fx = hx + 5, fy = -8.5, fl = Math.sin(t * 10 + p.ph) * 2;
          ctx.strokeStyle = '#6b4a2b';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(hx, -8);
          ctx.lineTo(fx, fy - 4);
          ctx.stroke();
          ctx.fillStyle = p.propColor;
          ctx.beginPath();
          ctx.moveTo(fx, fy - 4);
          ctx.lineTo(fx - 7, fy - 7 + fl);
          ctx.lineTo(fx - 1, fy - 10);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = p.shirt;
        ell(ctx, -1, 0, 5, 7.6);
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ell(ctx, -2.5, 0, 2.6, 6.2);
        // сверху видна макушка: нос и лоб лишь выглядывают в сторону воды
        ctx.fillStyle = p.skin;
        ell(ctx, 3.4, 0, 1.8, 2.6);
        if (p.cap) {
          ctx.fillStyle = p.propColor;
          circle(ctx, 0.2, 0, 4);
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ell(ctx, 4.3, 0, 1.9, 3.3);
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          circle(ctx, -0.6, -1.2, 1.1);
        } else {
          ctx.fillStyle = p.hair;
          circle(ctx, 0, 0, 4);
          ctx.fillStyle = 'rgba(255,255,255,0.16)';
          ell(ctx, -0.8, -1.3, 1.8, 1.1, -0.4);
        }
        if (p.prop === 'sign') {
          const sx = lerp(3, 8, up);
          ctx.fillStyle = 'rgba(0,0,0,0.2)';
          ctx.fillRect(sx - 1.5, -5.5, 5, 13);
          ctx.fillStyle = '#fffbea';
          ctx.fillRect(sx - 2.5, -6.5, 5, 13);
          ctx.fillStyle = p.propColor;
          ctx.fillRect(sx - 2.5, -6.5, 5, 4.5);
        }
        ctx.restore();
      }
    }

    // ===================================================================
    // ----- Снимок и события -----
    // ===================================================================
    const active = (p) => !!snap && (snap.phase === 'lobby' || p.inGame);
    const swimming = (p) => p.inGame && p.st !== 'f' && !p.dnf;

    function vOf(p) {
      let v = vis.get(p.id);
      if (!v) {
        v = { bp: rnd() * TAU, ripT: rnd() * 0.4, la: 0, ly: 0, ax: null, lastSt: p.st, place: 0 };
        vis.set(p.id, v);
      }
      return v;
    }

    // положение утки на экране: снимок плюс немного вперёд по скорости, пока не пришёл следующий
    function posOf(p) {
      const age = Math.min(0.1, Math.max(0, simT - snapAt));
      return [p.x + (p.vx || 0) * age, p.y + (p.vy || 0) * age];
    }

    function apply(s, events, quiet) {
      if (!s) return;
      if (s.seed != null && RG()) setCourse(s.seed);
      const prevPhase = snap ? snap.phase : null;
      snap = s;
      snapAt = simT;
      byId.clear();
      for (const p of s.players || []) { byId.set(p.id, p); vOf(p); }
      for (const id of [...vis.keys()]) if (!byId.has(id)) vis.delete(id);

      const evs = Array.isArray(events) ? events : [];
      const hasGo = evs.some(e => e && e.type === 'go');
      if (!quiet) for (const e of evs) if (e) onEvent(e);

      // шлюз: закрыт в лобби и на отсчёте; открытым застаём, если пришли посреди заплыва
      if (s.phase === 'lobby' || s.phase === 'countdown') { gate.open = 0; gate.opening = false; }
      else if (!gate.opening || (quiet && hasGo)) { gate.opening = true; gate.open = hasGo && !quiet ? 0 : 1; }

      // ленточка рвётся, когда появился чемпион; без чемпиона — целая
      if (!s.champion) ribbon.broken = false;
      else if (!ribbon.broken) {
        const cp = byId.get(s.champion);
        breakRibbon(cp ? cp.x : (course ? course.riverCx(W.FIN) : 220), true);
      }

      if (s.phase !== prevPhase) {
        if (s.phase === 'lobby' || s.phase === 'countdown') { ribbon.broken = false; meFinAt = -1; }
        if (s.phase === 'lobby' || s.phase === 'over') Sound.ambience(false);
        if (s.phase === 'race' && quiet) Sound.ambience(true);
        if (prevPhase === null || s.phase === 'lobby') camSnap = true;
        lastPhase = s.phase;
      }

      // смена состояний: доплыла — запоминаем место; своя доплыла — запоминаем время для камеры
      for (const p of s.players || []) {
        const v = vOf(p);
        if (p.st !== v.lastSt) {
          if (p.st === 'f' && p.id === me) meFinAt = simT;
          v.lastSt = p.st;
        }
      }
    }

    function breakRibbon(x, late) {
      if (!course) return;
      const cx = course.riverCx(W.FIN), hw = course.riverHw(W.FIN);
      ribbon.broken = true;
      ribbon.t = late ? simT - 5 : simT;
      ribbon.x = clamp(x, cx - hw + 14, cx + hw - 14);
    }

    const near = (y) => y > cam.y - 160 && y < cam.y + view.vh + 160;
    const isMine = (e) => !!me && (e.id === me || e.by === me);

    function popup(id, text, color, delay = 0) {
      if (!text) return;
      for (let i = popups.length - 1; i >= 0; i--) if (popups[i].id === id && popups[i].life < 0.3) popups.splice(i, 1);
      const p = byId.get(id);
      popups.push({ id, x: p ? p.x : 0, y: p ? p.y : 0, text, color, life: -delay, max: 1.1 });
      if (popups.length > 8) popups.shift();
    }
    function shake(a) { shakeFx.a = Math.max(shakeFx.a, a); }

    function onEvent(e) {
      switch (e.type) {
        case 'go': {
          gate.opening = true; gate.open = 0;
          Sound.gate(); Sound.whistle(0.05);
          Sound.quack(1, 0.15);
          Sound.ambience(true);
          if (course) {
            const cx = course.riverCx(W.GATE), hw = course.riverHw(W.GATE);
            for (let i = 0; i < 18; i++) splash(cx + rr(-hw, hw) * 0.9, W.GATE + rr(2, 16), 2, 0.8);
          }
          break;
        }
        case 'phase':
          if (e.phase === 'over' || e.phase === 'lobby') Sound.ambience(false);
          break;
        case 'bump': {
          const mine = isMine(e);
          if (e.x != null) { splash(e.x, e.y, mine ? 9 : 6, 0.8); addRipple(e.x, e.y, 0.45, 30); }
          if (mine || near(e.y)) { Sound.bump(clamp((e.power || 60) / 140, 0.5, 1.2)); if (rnd() < 0.5 || mine) Sound.quack(rr(1.1, 1.4)); }
          if (mine) { popup(me, words.bump, '#ffd23f'); shake(3.5); }
          break;
        }
        case 'rock':
        case 'log': {
          const mine = e.id === me;
          if (e.x != null) splash(e.x, e.y, mine ? 10 : 7);
          if (mine || near(e.y)) { if (e.type === 'rock') Sound.hit(mine ? 1 : 0.7); else Sound.log(); }
          if (mine) { popup(me, words.ouch, '#ff6b6b'); shake(4); flash.a = 0.35; }
          break;
        }
        case 'whirl': {
          const mine = e.id === me;
          if (e.x != null) { addRipple(e.x, e.y, 0.5, 40); addRipple(e.x, e.y, 0.3, 26); }
          if (mine || near(e.y)) Sound.whirl();
          if (mine) { popup(me, words.whirl, '#8ee8ff'); Sound.quack(0.85); }
          break;
        }
        case 'whirlOut':
          if (e.x != null) splash(e.x, e.y, 8);
          if (e.id === me || near(e.y)) Sound.splash();
          break;
        case 'finish': {
          const x = e.x != null ? e.x : (byId.get(e.id) || {}).x || 220;
          splash(x, W.FIN + 6, 14, 1.1);
          addRipple(x, W.FIN + 6, 0.6, 40);
          if (e.place === 1) {
            breakRibbon(x, false);
            const p = byId.get(e.id);
            burstFeathers(p ? p.x : x, p ? p.y : W.FIN, p ? p.ci : 0);
            burstConfetti();
            Sound.whistle(); Sound.cheer(); Sound.quack(1.1, 0.3);
          } else {
            if (e.id === me || near(W.FIN)) { Sound.finish(); Sound.crowd(); }
            if (e.id === me) Sound.quack(1.3, 0.1);
          }
          break;
        }
        case 'champion': {
          if (!ribbon.broken || simT - ribbon.t > 1) {
            const p = byId.get(e.id);
            if (!ribbon.broken) breakRibbon(p ? p.x : 220, false);
          }
          break;
        }
        case 'removed': {
          const p = byId.get(e.id);
          if (p) splash(p.x, p.y, 8, 0.7);
          break;
        }
      }
    }

    // ----- Частицы -----
    function addRipple(x, y, a, grow = 22) {
      if (ripples.length > 200) ripples.shift();
      ripples.push({ x, y, r: 5, a, grow, life: 0 });
    }
    function splash(x, y, n, power = 1) {
      for (let i = 0; i < n; i++) {
        if (drops.length > 260) drops.shift();
        drops.push({ x, y, z: 1, vx: rr(-45, 45) * power, vy: rr(-45, 45) * power, vz: rr(40, 120) * power, s: rr(1, 2.4) });
      }
      addRipple(x, y, 0.5, 30);
    }
    function burstFeathers(x, y, ci) {
      for (let i = 0; i < 46; i++) {
        const a = rnd() * TAU, sp = rr(40, 150);
        const c = rnd() < 0.5 ? colorOf(ci) : DUCK_COLORS[Math.floor(rnd() * DUCK_COLORS.length)];
        feathers.push({
          x, y, z: rr(4, 16), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rr(60, 160),
          rot: rnd() * TAU, vr: rr(-6, 6), life: 0, color: rnd() < 0.3 ? '#ffe79a' : c[0], len: rr(4, 7),
        });
      }
    }
    function burstConfetti() {
      if (!course) return;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 34; i++) {
          const y = W.FIN + rr(-W.CLEAN * 0.4, 60);
          const x = course.riverCx(y) + side * (course.riverHw(y) + rr(30, 70));
          feathers.push({
            x, y, z: rr(8, 20), vx: -side * rr(40, 130), vy: rr(-40, 40), vz: rr(80, 170),
            rot: rnd() * TAU, vr: rr(-9, 9), life: 0, color: SHIRT[Math.floor(rnd() * SHIRT.length)], len: rr(2.5, 4.5),
          });
        }
      }
    }

    // скорость воды для ряби и струек: та же формула, что в движке, без кувшинок
    function flowAt(y, lat, x) {
      if (!course) return 0;
      let k = (cfg.BANK_K + (1 - cfg.BANK_K) * (1 - lat * lat)) * course.flowMul(y);
      if (x != null && y > W.GATE - 10 && y < W.FIN) k *= 1 + (cfg.STREAM_K - 1) * course.streamAt(x, y);
      if (y < W.GATE + 20) k *= lerp(0.12, 1, gate.open);
      return cfg.FLOW * k;
    }

    function updateParticles(dt) {
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.life += dt;
        r.r += r.grow * dt;
        r.y += flowAt(r.y, 0) * 0.4 * dt;
        if (r.life > 1.3) ripples.splice(i, 1);
      }
      for (let i = drops.length - 1; i >= 0; i--) {
        const p = drops[i];
        p.vz -= 340 * dt;
        p.z += p.vz * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.z <= 0) {
          if (rnd() < 0.25) addRipple(p.x, p.y, 0.25, 16);
          drops.splice(i, 1);
        }
      }
      for (let i = feathers.length - 1; i >= 0; i--) {
        const f = feathers[i];
        f.life += dt;
        if (f.z > 0) {
          f.vz -= 110 * dt;
          f.z = Math.max(0, f.z + f.vz * dt);
          f.vx *= Math.exp(-dt * 1.4);
          f.vy *= Math.exp(-dt * 1.4);
          f.rot += f.vr * dt;
        } else {
          f.vx *= Math.exp(-dt * 3);
          f.vy = lerp(f.vy, flowAt(f.y, 0) * 0.3, dt * 2);
        }
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.life > 5) feathers.splice(i, 1);
      }
      for (let i = popups.length - 1; i >= 0; i--) if ((popups[i].life += dt) > popups[i].max) popups.splice(i, 1);
      flash.a = Math.max(0, flash.a - dt * 1.2);
    }

    // рябь за плывущими утками, кувшинки под ними, лягушка
    function updateDucks(dt) {
      if (!snap || !course) return;
      for (const p of snap.players || []) {
        if (!active(p) || p.dnf) continue;
        const v = vis.get(p.id);
        if (!v) continue;
        const sp = Math.hypot(p.vx || 0, p.vy || 0);
        v.ripT -= dt;
        if (v.ripT <= 0 && inView(p.y, 60)) {
          v.ripT = sp > 30 ? 0.24 : 0.7;
          addRipple(p.x - Math.cos(p.ang) * 8, p.y - Math.sin(p.ang) * 8, sp > 30 ? 0.28 : 0.14);
        }
      }
      for (const L of course.lilies) {
        if (!inView(L.y, L.r + view.vh * 0.5)) continue;
        for (const pad of L.pads) {
          pad.ox *= Math.exp(-dt * 1.6);
          pad.oy *= Math.exp(-dt * 1.6);
          pad.wob *= Math.exp(-dt * 1.2);
        }
        for (const p of snap.players || []) {
          if (!active(p) || p.st === 'f' || Math.abs(L.y - p.y) > L.r + 24) continue;
          for (const pad of L.pads) {
            if (Math.hypot(pad.x + pad.ox - p.x, pad.y + pad.oy - p.y) < pad.r + W.DR * 0.6) {
              pad.ox = clamp(pad.ox + (p.vx || 0) * 0.5 * dt, -8, 8);
              pad.oy = clamp(pad.oy + (p.vy || 0) * 0.5 * dt, -8, 8);
              pad.wob = Math.min(1, pad.wob + 7 * dt);
              break;
            }
          }
        }
        const f = L.frog;
        if (!f) continue;
        if (f.state === 'sit') {
          if (snap.phase !== 'race') continue;
          const nearDuck = (snap.players || []).find(p => p.inGame && Math.hypot(p.x - f.pad.x, p.y - f.pad.y) < 52);
          if (nearDuck) {
            const a = Math.atan2(f.pad.y - nearDuck.y, f.pad.x - nearDuck.x) + rr(-0.5, 0.5);
            f.state = 'jump';
            f.t = 0;
            f.x = f.pad.x + f.pad.ox; f.y = f.pad.y + f.pad.oy;
            f.tx = f.x + Math.cos(a) * 44; f.ty = f.y + Math.sin(a) * 44;
            f.ang = a;
          }
        } else if (f.state === 'jump') {
          f.t += dt / 0.55;
          if (f.t >= 1) {
            f.state = 'gone';
            splash(f.tx, f.ty, 10, 0.8);
            if (inView(f.ty, 40)) Sound.splash(0.12);
          }
        }
      }
    }

    function updateCheer(dt) {
      let target = 0;
      if (snap && course) {
        if (snap.champion) target = 1;
        else if (snap.phase === 'race') {
          let lead = -1e9;
          for (const p of snap.players || []) if (swimming(p)) lead = Math.max(lead, p.y);
          target = 0.12 + 0.88 * smooth01(W.FIN - W.CLEAN - 60, W.FIN, lead);
        }
      }
      cheer.level += (target - cheer.level) * (1 - Math.exp(-dt * 3));
    }

    // ----- Живая вода -----
    function updateWaterFx(dt) {
      if (!course) return;
      for (const s of streaks) {
        const above = s.y < cam.y - 90, below = s.y > cam.y + view.vh + 90;
        if (above || below) {
          s.d = rr(-0.85, 0.85);
          s.len = rr(14, 34);
          s.a = rr(0.12, 0.28);
          s.w = rr(0.8, 1.8);
          s.sp = rr(0.85, 1.15);
          s.y = below ? cam.y - rr(5, 80) : cam.y + rr(-40, view.vh + 40);
          continue;
        }
        s.y += flowAt(s.y, s.d) * s.sp * dt;
      }
      for (const s of sparkles) {
        s.life += dt * s.sp;
        if (s.life >= 1 || !inView(s.y, 20)) {
          s.life = 0;
          s.sp = rr(0.5, 1.1);
          s.d = rr(-0.9, 0.9);
          s.y = cam.y + rr(0, view.vh);
        }
      }
    }

    function drawStreaks() {
      ctx.lineCap = 'round';
      for (const s of streaks) {
        const hw = course.riverHw(s.y);
        if (hw < 24) continue;
        const yb = s.y - s.len;
        ctx.strokeStyle = `rgba(235,255,250,${s.a})`;
        ctx.lineWidth = s.w;
        ctx.beginPath();
        ctx.moveTo(course.riverCx(yb) + s.d * course.riverHw(yb), yb);
        ctx.lineTo(course.riverCx(s.y) + s.d * hw, s.y);
        ctx.stroke();
      }
    }

    function drawSparkles() {
      for (const s of sparkles) {
        const hw = course.riverHw(s.y);
        if (hw < 24) continue;
        const a = Math.pow(Math.sin(s.life * Math.PI), 3);
        if (a < 0.02) continue;
        const x = course.riverCx(s.y) + s.d * hw;
        ctx.globalAlpha = a;
        ctx.drawImage(sparkSprite, x - 5, s.y - 5, 10, 10);
      }
      ctx.globalAlpha = 1;
    }

    // Струи: бегущие вниз шевроны по оси и две пунктирные кромки — «здесь вода быстрее»
    function drawStreams(t) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of course.streams) {
        if (s.y1 + 40 < cam.y - 20 || s.y0 - 40 > cam.y + view.vh + 20) continue;
        const lat = (s.lat + s.lat2) / 2;
        const speed = cfg.FLOW * (cfg.BANK_K + (1 - cfg.BANK_K) * (1 - lat * lat)) * cfg.STREAM_K;
        const gap = 34;
        const off = (t * speed * 0.85) % gap;
        const ya = Math.max(s.y0 - 30, cam.y - 20), yb = Math.min(s.y1 + 30, cam.y + view.vh + 20);
        // кромки струи: светлые пунктиры, бегут вместе с водой
        ctx.setLineDash([10, 14]);
        ctx.lineDashOffset = -t * speed * 0.85;
        ctx.lineWidth = 1.4;
        for (const side of [-1, 1]) {
          ctx.strokeStyle = 'rgba(235,255,250,0.32)';
          ctx.beginPath();
          let first = true;
          for (let y = ya; y <= yb; y += 8) {
            const f = streamFade(s, y);
            const x = course.streamX(s, y) + side * s.w * (0.15 + 0.85 * f) * 0.95;
            if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
        // шевроны вниз по течению
        ctx.lineWidth = 3;
        const start = Math.ceil((ya - off) / gap) * gap + off;
        for (let y = start; y <= yb; y += gap) {
          const f = streamFade(s, y);
          if (f < 0.08) continue;
          const x = course.streamX(s, y);
          const [dx, dy] = course.riverDir(y);
          const nx = dy, ny = -dx;
          const hw = 9 * (0.5 + 0.5 * f), back = 7;
          ctx.strokeStyle = `rgba(255,255,255,${0.55 * f})`;
          ctx.beginPath();
          ctx.moveTo(x - nx * hw - dx * back, y - ny * hw - dy * back);
          ctx.lineTo(x, y);
          ctx.lineTo(x + nx * hw - dx * back, y + ny * hw - dy * back);
          ctx.stroke();
        }
      }
    }

    function drawRipples() {
      ctx.lineWidth = 1.2;
      for (const r of ripples) {
        if (!inView(r.y, 40)) continue;
        ctx.strokeStyle = `rgba(235,255,250,${r.a * (1 - r.life / 1.3)})`;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, r.r, r.r * 0.85, 0, 0, TAU);
        ctx.stroke();
      }
    }

    // ----- Препятствия -----
    function drawFlower(x, y, t) {
      const rot = t * 0.2;
      for (let k = 0; k < 8; k++) {
        const a = rot + (k / 8) * TAU;
        ctx.fillStyle = k % 2 ? '#ffc2da' : '#ff9cc2';
        ell(ctx, x + Math.cos(a) * 4.2, y + Math.sin(a) * 4.2, 4.2, 2.1, a);
      }
      for (let k = 0; k < 5; k++) {
        const a = -rot + (k / 5) * TAU;
        ctx.fillStyle = '#fff0f6';
        ell(ctx, x + Math.cos(a) * 2.4, y + Math.sin(a) * 2.4, 2.6, 1.3, a);
      }
      ctx.fillStyle = '#ffd23f';
      circle(ctx, x, y, 2);
    }

    function drawFrog(f) {
      let x, y, s = 1;
      if (f.state === 'sit') { x = f.pad.x + f.pad.ox; y = f.pad.y + f.pad.oy; }
      else if (f.state === 'jump') { x = lerp(f.x, f.tx, f.t); y = lerp(f.y, f.ty, f.t); s = 1 + Math.sin(f.t * Math.PI) * 0.5; }
      else return;
      if (f.state === 'jump') {
        ctx.fillStyle = 'rgba(4,34,40,0.25)';
        ell(ctx, x + 6 * s, y + 8 * s, 7, 5.5, f.ang);
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(f.ang);
      ctx.scale(s, s);
      ctx.fillStyle = '#3f8f3a';
      ell(ctx, -4, -5.5, 4.5, 2, 0.5);
      ell(ctx, -4, 5.5, 4.5, 2, -0.5);
      ctx.fillStyle = '#5fb24a';
      ell(ctx, -0.5, 0, 7, 5.5);
      ctx.fillStyle = '#6cc257';
      circle(ctx, 5, 0, 4.2);
      ctx.fillStyle = '#3f8f3a';
      circle(ctx, -2.5, -1.5, 1.2);
      circle(ctx, -1, 2, 1);
      ctx.fillStyle = '#ffffff';
      circle(ctx, 6, -3, 1.9);
      circle(ctx, 6, 3, 1.9);
      ctx.fillStyle = '#111';
      circle(ctx, 6.6, -3, 0.9);
      circle(ctx, 6.6, 3, 0.9);
      ctx.restore();
    }

    function drawLilies(t) {
      for (const L of course.lilies) {
        if (!inView(L.y, L.r + 40)) continue;
        for (const p of L.pads) {
          const x = p.x + p.ox, y = p.y + p.oy;
          const rot = p.rot + Math.sin(t * 1.3 + p.x) * 0.05 + p.wob * Math.sin(t * 9) * 0.25;
          ctx.fillStyle = 'rgba(6,40,40,0.25)';
          circle(ctx, x + 1.5, y + 2.5, p.r);
          const gr = ctx.createRadialGradient(x - p.r * 0.3, y - p.r * 0.3, 1, x, y, p.r);
          gr.addColorStop(0, '#8ccf6a');
          gr.addColorStop(1, '#3d8a3e');
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.arc(x, y, p.r, rot + 0.3, rot + TAU - 0.3);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(30,85,35,0.4)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          for (let k = 1; k < 6; k++) {
            const a = rot + 0.3 + (k / 6) * (TAU - 0.6);
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(a) * p.r * 0.85, y + Math.sin(a) * p.r * 0.85);
          }
          ctx.stroke();
          if (p.flower) drawFlower(x, y, t);
        }
        if (L.frog) drawFrog(L.frog);
      }
    }

    function drawPools(t) {
      ctx.lineCap = 'round';
      for (const p of course.pools) {
        if (!inView(p.y, p.r * 1.5)) continue;
        const gr = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.r * 1.25);
        gr.addColorStop(0, 'rgba(6,34,46,0.6)');
        gr.addColorStop(0.45, 'rgba(12,70,86,0.3)');
        gr.addColorStop(1, 'rgba(12,70,86,0)');
        ctx.fillStyle = gr;
        circle(ctx, p.x, p.y, p.r * 1.25);
        const base = t * 2.1 * p.dir;
        ctx.strokeStyle = 'rgba(225,250,245,0.3)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        for (let a = 0; a < 4; a++) {
          for (let s = 0; s <= 22; s++) {
            const u = s / 22;
            const rad = p.r * (1.15 - u * 1.02);
            const ang = base + (a / 4) * TAU + u * 3.4 * p.dir;
            const x = p.x + Math.cos(ang) * rad, y = p.y + Math.sin(ang) * rad;
            if (s) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
        }
        ctx.stroke();
        ctx.setLineDash([3, 7]);
        ctx.lineDashOffset = -t * 30 * p.dir;
        ctx.strokeStyle = 'rgba(240,255,250,0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 1.08, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    function drawRockFoam(t) {
      ctx.lineCap = 'round';
      for (const r of course.rocks) {
        if (!inView(r.y, 80)) continue;
        ctx.strokeStyle = 'rgba(240,255,250,0.45)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r + 3 + Math.sin(t * 3 + r.x) * 1.2, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(240,255,250,0.22)';
        ctx.lineWidth = 1.6;
        const wob = Math.sin(t * 2 + r.y) * 2;
        ctx.beginPath();
        for (const s of [-1, 1]) {
          ctx.moveTo(r.x + s * r.r * 0.8, r.y + r.r * 0.3);
          ctx.quadraticCurveTo(r.x + s * r.r * 1.3, r.y + r.r * 1.6, r.x + s * r.r * 0.7 + wob, r.y + r.r * 2.8);
        }
        ctx.stroke();
      }
    }

    function rockPath(r, dx = 0, dy = 0, k = 1) {
      ctx.beginPath();
      r.pts.forEach((p, i) => {
        const x = r.x + dx + p[0] * k, y = r.y + dy + p[1] * k;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
    }

    function drawRocks() {
      for (const r of course.rocks) {
        if (!inView(r.y, 40)) continue;
        ctx.fillStyle = 'rgba(4,30,36,0.35)';
        rockPath(r, 3, 4);
        ctx.fill();
        const c = 138 + r.tone;
        const gr = ctx.createLinearGradient(r.x - r.r, r.y - r.r, r.x + r.r, r.y + r.r);
        gr.addColorStop(0, `rgb(${c + 40},${c + 42},${c + 38})`);
        gr.addColorStop(1, `rgb(${c - 50},${c - 46},${c - 44})`);
        ctx.fillStyle = gr;
        rockPath(r);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        rockPath(r, -r.r * 0.2, -r.r * 0.25, 0.55);
        ctx.fill();
        ctx.fillStyle = 'rgba(92,140,70,0.55)';
        for (const m of r.moss) circle(ctx, r.x + m[0], r.y + m[1], m[2]);
      }
    }

    function drawLogs() {
      for (const L of course.logs) {
        if (Math.max(L.y1, L.y2) < cam.y - 40 || Math.min(L.y1, L.y2) > cam.y + view.vh + 40) continue;
        const ang = Math.atan2(L.y2 - L.y1, L.x2 - L.x1);
        const len = Math.hypot(L.x2 - L.x1, L.y2 - L.y1);
        ctx.strokeStyle = 'rgba(240,255,250,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(L.x1, L.y1 - L.r - 3);
        ctx.lineTo(L.x2, L.y2 - L.r - 3);
        ctx.stroke();
        ctx.save();
        ctx.translate(L.x1, L.y1);
        ctx.rotate(ang);
        ctx.fillStyle = 'rgba(4,30,36,0.35)';
        rrect(ctx, -1, -L.r + 4, len + 8, L.r * 2, L.r);
        ctx.fill();
        ctx.strokeStyle = '#5a3b22';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        for (const tw of L.twigs) {
          const sx = len * tw.t, ex = sx + Math.cos(tw.a) * tw.l, ey = Math.sin(tw.a) * tw.l;
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          ctx.fillStyle = '#4f8f45';
          circle(ctx, ex, ey, 3.2);
        }
        const gr = ctx.createLinearGradient(0, -L.r, 0, L.r);
        gr.addColorStop(0, '#a4723f');
        gr.addColorStop(0.5, '#7a5230');
        gr.addColorStop(1, '#4e331d');
        ctx.fillStyle = gr;
        rrect(ctx, -4, -L.r, len + 8, L.r * 2, L.r);
        ctx.fill();
        ctx.strokeStyle = 'rgba(40,24,12,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 8; x < len - 6; x += 13) {
          ctx.moveTo(x, -L.r * 0.45);
          ctx.lineTo(x + 9, -L.r * 0.35);
          ctx.moveTo(x + 5, L.r * 0.3);
          ctx.lineTo(x + 13, L.r * 0.42);
        }
        ctx.stroke();
        ctx.fillStyle = '#c89a63';
        circle(ctx, len + 4, 0, L.r * 0.95);
        ctx.strokeStyle = 'rgba(110,70,35,0.6)';
        ctx.beginPath();
        ctx.arc(len + 4, 0, L.r * 0.6, 0, TAU);
        ctx.moveTo(len + 4 + L.r * 0.28, 0);
        ctx.arc(len + 4, 0, L.r * 0.28, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }

    function drawGate() {
      if (!inView(W.GATE, 200)) return;
      const y = W.GATE, cx = course.riverCx(y), hw = course.riverHw(y);
      for (const s of [-1, 1]) {
        const px = cx + s * (hw + 6);
        const open = gate.open * 1.5;
        const a = s < 0 ? open : Math.PI - open;
        const L = hw + 2;
        ctx.save();
        ctx.translate(px, y);
        ctx.rotate(a);
        ctx.fillStyle = 'rgba(4,30,36,0.35)';
        rrect(ctx, 3, -2, L, 12, 3);
        ctx.fill();
        const gr = ctx.createLinearGradient(0, -6, 0, 6);
        gr.addColorStop(0, '#b07c43');
        gr.addColorStop(1, '#6e4724');
        ctx.fillStyle = gr;
        rrect(ctx, 0, -6, L, 12, 3);
        ctx.fill();
        ctx.strokeStyle = 'rgba(50,30,14,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(4, -2); ctx.lineTo(L - 4, -2);
        ctx.moveTo(4, 2); ctx.lineTo(L - 4, 2);
        ctx.stroke();
        ctx.fillStyle = '#3a3a3f';
        ctx.fillRect(L * 0.25, -6, 4, 12);
        ctx.fillRect(L * 0.7, -6, 4, 12);
        ctx.restore();
        ctx.fillStyle = 'rgba(4,30,20,0.35)';
        rrect(ctx, px - 6, y - 5, 18, 18, 4);
        ctx.fill();
        ctx.fillStyle = '#5b3a1f';
        rrect(ctx, px - 9, y - 9, 18, 18, 4);
        ctx.fill();
        ctx.fillStyle = '#7d5430';
        circle(ctx, px, y, 5.5);
      }
    }

    // ----- Финиш: линия поплавков, стойки и ленточка -----
    function drawFinishLine(t) {
      if (!inView(W.FIN, 60)) return;
      const y = W.FIN, cx = course.riverCx(y), hw = course.riverHw(y);
      const n = Math.floor((hw * 2 - 8) / 11);
      const step = (hw * 2 - 8) / n;
      for (let i = 0; i <= n; i++) {
        const x = cx - hw + 4 + i * step;
        const by = y + 7 + Math.sin(t * 2.4 + i * 0.9) * 1.2;
        ctx.fillStyle = 'rgba(4,34,40,0.25)';
        circle(ctx, x + 1.5, by + 2, 3.6);
        ctx.fillStyle = i % 2 ? '#1f2328' : '#fbfbf7';
        circle(ctx, x, by, 3.4);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        circle(ctx, x - 1, by - 1.2, 1);
      }
    }

    function drawFinish(t) {
      if (!inView(W.FIN, 90)) return;
      const cx = course.riverCx(W.FIN), hw = course.riverHw(W.FIN);
      const xl = cx - hw - 7, xr = cx + hw + 7, hy = W.FIN - 2;
      const curve = (x0, y0, x1, y1, sag, wob) => {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo((x0 + x1) / 2 + wob, (y0 + y1) / 2 + sag, x1, y1);
      };
      const tape = (build) => {
        ctx.save();
        ctx.translate(3, 6);
        build();
        ctx.strokeStyle = 'rgba(4,34,40,0.22)';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.restore();
        build();
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.1;
        ctx.stroke();
      };
      ctx.lineCap = 'round';
      if (!ribbon.broken) {
        tape(() => curve(xl, hy, xr, hy, 5 + Math.sin(t * 1.7) * 1.5, Math.sin(t * 2.2) * 3));
      } else {
        // половинки откидываются к стойкам и повисают по течению
        const u = clamp((simT - ribbon.t) / 0.9, 0, 1);
        const e = 1 - Math.pow(1 - u, 3);
        const flut = Math.sin(simT * 11) * 4 * (1 - e * 0.6);
        const by = hy + 4;
        tape(() => curve(xl, hy, lerp(ribbon.x - 3, xl + 6, e), lerp(by, hy + 34, e) + flut, 6 + 10 * e, 0));
        tape(() => curve(xr, hy, lerp(ribbon.x + 3, xr - 6, e), lerp(by, hy + 34, e) - flut, 6 + 10 * e, 0));
      }
      for (const px of [xl, xr]) {
        ctx.fillStyle = 'rgba(8,30,12,0.3)';
        circle(ctx, px + 3, hy + 5, 6);
        ctx.fillStyle = '#fbfbf7';
        circle(ctx, px, hy, 5.5);
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, hy, 3.6, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = '#e63946';
        circle(ctx, px, hy, 1.5);
        // клетчатый флажок на стойке, развевается от воды
        const dir = px < cx ? -1 : 1;
        for (let i = 0; i < 3; i++) {
          const fl = Math.sin(t * 6 + px * 0.1 + i * 0.8) * 1.6 * (i / 2);
          for (let j = 0; j < 2; j++) {
            ctx.fillStyle = (i + j) % 2 ? '#1f2328' : '#fbfbf7';
            ctx.fillRect(px + dir * (5 + i * 4) - (dir < 0 ? 4 : 0), hy - 11 + j * 4 + fl, 4, 4);
          }
        }
      }
    }

    // ----- Утки -----
    function drawDucks(t) {
      if (!snap) return;
      const list = [];
      for (const p of snap.players || []) {
        const [x, y] = posOf(p);
        if (!inView(y, 40)) continue;
        list.push({ p, x, y, dim: p.dnf ? 0.35 : !active(p) ? 0.45 : p.online === false ? 0.6 : 1 });
      }
      list.sort((a, b) => a.y - b.y);
      const k = W.DR / 12;

      // под своей уткой — свечение и кольцо; чемпион — золотое кольцо, ведущий в фокусе — красное
      const fp = focus ? list.find(o => o.p.id === focus) : null;
      for (const o of list) {
        const id = o.p.id;
        if (id === me && o.dim > 0.4) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 4);
          ctx.globalAlpha = 0.75 + 0.25 * pulse;
          ctx.drawImage(glowSprite, o.x - 32 * k, o.y - 32 * k, 64 * k, 64 * k);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.arc(o.x, o.y, (19 + pulse * 1.5) * k, 0, TAU);
          ctx.stroke();
        }
        if (snap.champion === id) {
          ctx.strokeStyle = `rgba(255,210,63,${0.55 + 0.3 * Math.sin(t * 5)})`;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(o.x, o.y, (id === me ? 24 : 20) * k + Math.sin(t * 5) * 2, 0, TAU);
          ctx.stroke();
        }
      }
      if (fp) {
        ctx.setLineDash([6, 5]);
        ctx.lineDashOffset = -t * 20;
        ctx.strokeStyle = focusKind === 'host' ? '#ff5a5a' : '#ffd23f';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(fp.x, fp.y, 27 * k + Math.sin(t * 4) * 1.5, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = 'rgba(4,34,40,0.22)';
      for (const o of list) {
        ctx.globalAlpha = o.dim;
        ell(ctx, o.x + 3, o.y + 4, 14 * k, 12 * k, o.p.ang);
      }
      ctx.globalAlpha = 1;

      // усы от носа: в струе — длиннее и ярче
      ctx.lineCap = 'round';
      for (const o of list) {
        const p = o.p;
        const sp = Math.hypot(p.vx || 0, p.vy || 0);
        if (sp < 30 || p.st === 'c' || o.dim < 0.5) continue;
        const vx = p.vx / sp, vy = p.vy / sp;
        const fast = p.st === 'w' ? course.streamAt(o.x, o.y) : 0;
        const L = 26 + 16 * fast;
        ctx.strokeStyle = `rgba(240,255,250,${Math.min(0.32, sp / 400) + 0.2 * fast})`;
        ctx.lineWidth = 1.6 + fast;
        ctx.beginPath();
        for (const s of [-1, 1]) {
          ctx.moveTo(o.x - vx * 6 - vy * s * 9, o.y - vy * 6 + vx * s * 9);
          ctx.lineTo(o.x - vx * L - vy * s * (17 + 3 * fast), o.y - vy * L + vx * s * (17 + 3 * fast));
        }
        ctx.stroke();
      }

      for (const o of list) {
        const p = o.p;
        const v = vis.get(p.id);
        const bp = v ? v.bp : 0;
        const s = (1 + Math.sin(t * 3 + bp) * 0.03) * (p.st === 'c' ? 0.9 : 1) * k;
        ctx.globalAlpha = o.dim;
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.rotate((p.ang || 0) + Math.sin(t * 2.1 + bp) * 0.07);
        ctx.scale(s, s);
        ctx.drawImage(duckSprites[ciIdx(p.ci)], -20, -20, 40, 40);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    function drawDrops() {
      ctx.fillStyle = 'rgba(245,255,252,0.9)';
      ctx.beginPath();
      for (const p of drops) {
        if (!inView(p.y, 30)) continue;
        const y = p.y - p.z * 0.35;
        ctx.moveTo(p.x + p.s, y);
        ctx.arc(p.x, y, p.s, 0, TAU);
      }
      ctx.fill();
    }

    function drawFeathers() {
      for (const f of feathers) {
        if (!inView(f.y, 40)) continue;
        ctx.globalAlpha = f.life > 3.5 ? Math.max(0, 1 - (f.life - 3.5) / 1.5) : 1;
        ctx.save();
        ctx.translate(f.x, f.y - f.z * 0.4);
        ctx.rotate(f.rot);
        ctx.fillStyle = f.color;
        ell(ctx, 0, 0, f.len, f.len * 0.35);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    // ===================================================================
    // ----- Камера -----
    // ===================================================================
    function leaderY() {
      let y = -1e9;
      for (const p of snap.players || []) if (swimming(p)) y = Math.max(y, p.y);
      if (y < -1e8) for (const p of snap.players || []) if (p.inGame && !p.dnf) y = Math.max(y, p.y);
      return y;
    }

    function updateCamera(dt) {
      const top = topGap / view.scale;
      const U = Math.max(80, (view.h - topGap - bottomGap) / view.scale);
      let target = (70 + W.GATE + 30) / 2 - top - U / 2;
      let rate = 4;
      if (snap && course) {
        const fp = focus && byId.get(focus);
        const mp = me && byId.get(me);
        if (fp) {
          target = posOf(fp)[1] - top - U * 0.5;
          rate = 2.4;
        } else if (snap.phase !== 'lobby') {
          let y = null;
          // своя утка; доплыла — через пару секунд смотрим на тех, кто ещё плывёт
          if (mp && mp.inGame && !mp.dnf) {
            const othersSwim = (snap.players || []).some(p => p.id !== me && swimming(p));
            const done = mp.st === 'f' && meFinAt >= 0 && simT - meFinAt > 2.5;
            y = done && othersSwim && snap.phase === 'race' ? leaderY() : posOf(mp)[1];
          } else {
            const ly = leaderY();
            if (ly > -1e8) y = ly;
          }
          if (snap.phase === 'countdown' && (y == null || !(mp && mp.inGame))) y = W.GATE;
          if (y != null) target = y - top - U * 0.37;
          rate = 5;
        }
      }
      target = clamp(target, 0, Math.max(0, W.H - view.vh + bottomGap / view.scale));
      if (camSnap) { cam.y = target; camSnap = false; }
      else {
        // далеко — догоняем быстрее, чтобы не тянуться секундами через всю реку
        const far = Math.abs(target - cam.y) / Math.max(1, view.vh);
        cam.y += (target - cam.y) * (1 - Math.exp(-dt * rate * (1 + Math.min(2, far))));
      }
      shakeFx.a *= Math.exp(-dt * 9);
      shakeFx.x = (rnd() - 0.5) * 2 * shakeFx.a;
      shakeFx.y = (rnd() - 0.5) * 2 * shakeFx.a;
    }

    // ===================================================================
    // ----- Экранный слой: подписи, всплывашки, прогресс, плашки за кадром -----
    // ===================================================================
    function screenTransform() { ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); }

    const widthCache = new Map();
    function textW(font, text) {
      const key = font + '|' + text;
      let w = widthCache.get(key);
      if (w == null) {
        ctx.font = font;
        w = ctx.measureText(text).width;
        if (widthCache.size > 400) widthCache.clear();
        widthCache.set(key, w);
      }
      return w;
    }
    const shortName = (n, max = 14) => { n = String(n == null ? '' : n).trim(); return n.length > max ? n.slice(0, max - 1) + '…' : n; };
    // утка у самой кромки панели считается за кадром: вместо подписи — плашка со стрелкой, без двойных надписей
    const EDGE_IN = 10;
    const PLACE_C = { 1: '#ffd23f', 2: '#dfe6ea', 3: '#e3a06a' };
    function drawCrown(g, x, y) {
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#a86e00';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x - 7, y + 4); g.lineTo(x - 7, y - 3); g.lineTo(x - 3.5, y); g.lineTo(x, y - 5.5);
      g.lineTo(x + 3.5, y); g.lineTo(x + 7, y - 3); g.lineTo(x + 7, y + 4);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#ff5a5a';
      circle(g, x, y - 5.5, 1.4);
    }

    // Подписи: имя над каждой уткой, у своей — «вы»; при наложении верхняя уступает вверх, сдвиг плавный — не мерцает
    function drawLabels(dt) {
      if (!snap) return;
      screenTransform();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const H = 18;
      const s = view.scale;
      const list = [];
      for (const p of snap.players || []) {
        const v = vis.get(p.id);
        if (!v) continue;
        const [x, y] = posOf(p);
        const X = sxOf(x), Y = syOf(y);
        const onScreen = Y >= topGap + EDGE_IN && Y <= view.h - bottomGap - EDGE_IN;
        const show = onScreen ? (p.dnf ? 0.5 : !active(p) ? 0.55 : 1) : 0;
        v.la += (show - v.la) * Math.min(1, dt * 8);
        if (v.la < 0.03) continue;
        list.push({ p, v, X, Y });
      }
      // ближние к финишу (ниже на экране) стоят на месте, верхние уступают
      list.sort((a, b) => b.Y - a.Y);
      const boxes = [];
      const drawn = [];
      for (const L of list) {
        const { p, v, X, Y } = L;
        const mine = p.id === me;
        const champ = snap.champion === p.id;
        const host = snap.phase === 'over' && snap.host && snap.host.id === p.id;
        const fin = p.st === 'f' && !p.dnf && p.place > 0;
        const badge = fin && !champ ? String(p.place) : '';
        const pre = (host ? '🎤 ' : '') + (p.online === false ? '📡 ' : '');
        const narrow = view.w < 500;
        const text = pre + shortName(p.name, mine ? 14 : narrow ? (list.length > 6 ? 7 : 10) : 14) + (mine ? meSuffix() : '');
        const font = mine ? `800 12px ${FONT}` : `700 11px ${FONT}`;
        const h = mine ? H + 2 : H;
        const w = textW(font, text) + (badge || champ ? 32 : 22);
        const Y0 = Y - (W.DR + 7) * s - h / 2 - (mine ? 3 : 0);
        let Yt = Y0, crowded = false;
        for (let pass = 0; pass < 6; pass++) {
          const hit = boxes.find(b => Math.abs(b.x - X) < (b.w + w) / 2 + 2 && Math.abs(b.y - Yt) < (b.h + h) / 2 + 1);
          if (!hit) break;
          Yt = hit.y - (hit.h + h) / 2 - 2;
          if (Yt < Y0 - 3 * (H + 2)) { crowded = true; break; }
        }
        // в плотной стае чужие подписи, которым не хватило места, прячутся: своя, чемпион и ведущий видны всегда
        if (crowded && !mine && !champ && !host) { v.la = Math.min(v.la, 0.2); continue; }
        Yt = Math.max(Yt, Y0 - 3 * (H + 2));
        // сдвиг подписи догоняет нужный плавно: соседи обгоняют друг друга — подписи не прыгают
        const off = Yt - Y0;
        if (Math.abs(v.ly - off) > 60) v.ly = off;
        v.ly += (off - v.ly) * Math.min(1, dt * 10);
        const Yd = Math.max(Y0 + v.ly, topGap + h / 2 + 2 + (snap.phase === 'race' ? 22 : 0));
        boxes.push({ x: X, y: Yt, w, h });
        // подпись у берега не уходит за край экрана и не налезает на полосу прогресса справа
        const Xd = clamp(X, w / 2 + 4, Math.max(w / 2 + 4, view.w - 30 - w / 2));
        drawn.push({ p, X: Xd, Y: Yd, Y0, w, h, text, font, champ, host, mine, badge, a: v.la, fin });
      }
      drawn.reverse();
      const mi = drawn.findIndex(L => L.mine);
      if (mi >= 0) drawn.push(drawn.splice(mi, 1)[0]);
      for (const L of drawn) {
        const { p, X, Y, Y0, w, h, text, font, champ, host, mine, badge, a } = L;
        if (Y < Y0 - 3) {
          ctx.globalAlpha = a * 0.6;
          ctx.strokeStyle = 'rgba(230,246,255,0.75)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(X, Y + h / 2); ctx.lineTo(X, Y0 + h / 2); ctx.stroke();
        }
        ctx.globalAlpha = a;
        ctx.fillStyle = champ ? 'rgba(255,210,63,0.97)' : host ? 'rgba(205,48,58,0.95)' : mine ? 'rgba(255,255,255,0.96)' : 'rgba(4,30,27,0.76)';
        rrect(ctx, X - w / 2, Y - h / 2, w, h, h / 2);
        ctx.fill();
        if (mine && !champ && !host) {
          ctx.strokeStyle = colorOf(p.ci)[0];
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        const c = colorOf(p.ci);
        let tx = X + 4;
        if (champ) {
          drawCrown(ctx, X - w / 2 + 12, Y + 1);
          tx = X + 7;
        } else if (badge) {
          // место доплывшей: золото, серебро, бронза, дальше — белый кружок с номером
          ctx.fillStyle = PLACE_C[p.place] || (mine ? '#06182c' : '#ffffff');
          circle(ctx, X - w / 2 + 11, Y, 7.5);
          if (PLACE_C[p.place]) { ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke(); }
          ctx.fillStyle = PLACE_C[p.place] || !mine ? '#06182c' : '#ffffff';
          ctx.font = `800 9px ${FONT}`;
          ctx.fillText(badge, X - w / 2 + 11, Y + 0.5);
          tx = X + 7;
        } else {
          ctx.fillStyle = c[0];
          circle(ctx, X - w / 2 + 8, Y, 3.4);
          if (mine || champ) { ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke(); }
        }
        ctx.font = font;
        ctx.fillStyle = champ ? '#3b2400' : host ? '#ffffff' : mine ? '#06182c' : '#fffbea';
        ctx.fillText(text, tx, Y + 0.5);
      }
      ctx.globalAlpha = 1;
    }

    function drawPopups() {
      screenTransform();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const pp of popups) {
        if (pp.life < 0) continue;
        const p = byId.get(pp.id);
        if (p) { const q = posOf(p); pp.x = q[0]; pp.y = q[1]; }
        const k = pp.life / pp.max;
        const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : k < 0.22 ? 1.15 - ((k - 0.12) / 0.1) * 0.15 : 1;
        const size = 24 * pop;
        const X = sxOf(pp.x), Y = Math.max(topGap + 40, syOf(pp.y) - 44 - 30 * k);
        ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
        ctx.font = `900 ${size}px ${FONT}`;
        ctx.lineWidth = 8;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#06182c';
        ctx.strokeText(pp.text, X, Y);
        ctx.fillStyle = pp.color;
        ctx.fillText(pp.text, X, Y);
      }
      ctx.globalAlpha = 1;
    }

    // Полоса прогресса справа: шлюз сверху, финиш снизу, кружки уток; своя крупнее, с обводкой
    function drawProgress(t) {
      if (!snap || !course || snap.phase === 'lobby') return;
      screenTransform();
      const x = view.w - 11;
      const y0 = topGap + 22, y1 = view.h - bottomGap - 22;
      if (y1 - y0 < 80) return;
      const span = W.FIN - W.GATE;
      const Y = (wy) => y0 + clamp((wy - W.GATE) / span, 0, 1) * (y1 - y0);
      ctx.fillStyle = 'rgba(4,30,27,0.38)';
      rrect(ctx, x - 3.5, y0 - 4, 7, y1 - y0 + 8, 3.5);
      ctx.fill();
      // струи на полосе — голубыми отрезками
      ctx.fillStyle = 'rgba(150,245,230,0.55)';
      for (const s of course.streams) {
        const a = Y(s.y0), b = Y(s.y1);
        rrect(ctx, x - 2, a, 4, Math.max(2, b - a), 2);
        ctx.fill();
      }
      // видимая часть реки
      const va = Y(cam.y), vb = Y(cam.y + view.vh);
      if (vb - va > 2) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        rrect(ctx, x - 6, va, 12, vb - va, 4);
        ctx.stroke();
      }
      // шлюз и финиш
      ctx.fillStyle = '#7d5430';
      rrect(ctx, x - 7, y0 - 9, 14, 5, 2);
      ctx.fill();
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#1f2328' : '#f4f1e6';
        ctx.fillRect(x - 6 + i * 3, y1 + 4 + j * 3, 3, 3);
      }
      const list = (snap.players || []).filter(p => p.inGame && !p.dnf);
      for (const p of list) {
        if (p.id === me) continue;
        ctx.fillStyle = colorOf(p.ci)[0];
        circle(ctx, x, Y(p.y), 3.6);
        ctx.strokeStyle = 'rgba(4,30,27,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const mp = me && list.find(p => p.id === me);
      if (mp) {
        const yy = Y(posOf(mp)[1]);
        ctx.fillStyle = colorOf(mp.ci)[0];
        circle(ctx, x, yy, 6);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
    }

    // Утки за кадром: у верхнего края — кто отстал, у нижнего — кто впереди (течение вниз). По три ближайших
    function drawOffscreen(dt) {
      if (!snap || !course || snap.phase !== 'race') return;
      screenTransform();
      const topY = topGap + 14, botY = view.h - bottomGap - 14;
      const above = [], below = [];
      for (const p of snap.players || []) {
        if (!swimming(p) || p.id === focus) continue;
        const [x, y] = posOf(p);
        const Y = syOf(y);
        if (Y < topGap + EDGE_IN) above.push({ p, x, d: topGap - Y });
        else if (Y > view.h - bottomGap - EDGE_IN) below.push({ p, x, d: Y - (view.h - bottomGap) });
      }
      const font = `700 10px ${FONT}`;
      const lay = (arr, Y, up) => {
        arr.sort((a, b) => a.d - b.d);
        const pick = arr.slice(0, 3).sort((a, b) => a.x - b.x);
        const H = 18;
        let prevR = 6;
        const items = pick.map(o => {
          const name = shortName(o.p.name, 10) + (o.p.id === me ? meSuffix() : '');
          const w = textW(font, name) + 30;
          return { o, name, w };
        });
        // раскладка по x без наложений, внутри экрана и левее полосы прогресса
        const maxR = view.w - 26;
        for (const it of items) {
          let X = clamp(sxOf(it.o.x) - it.w / 2, 6, maxR - it.w);
          X = Math.max(X, prevR + 4);
          it.X = X;
          prevR = X + it.w;
        }
        // всем не хватило места — дальние прячутся, оставшиеся раскладываются заново
        while (items.length > 1 && items.reduce((a, it) => a + it.w + 4, 6) > maxR) {
          let far = 0;
          items.forEach((it, i) => { if (it.o.d > items[far].o.d) far = i; });
          items.splice(far, 1);
        }
        prevR = 6;
        for (const it of items) { it.X = Math.max(clamp(sxOf(it.o.x) - it.w / 2, 6, maxR - it.w), prevR + 4); prevR = it.X + it.w; }
        let over = prevR - maxR;
        for (let i = items.length - 1; i >= 0 && over > 0; i--) {
          const lim = i ? items[i - 1].X + items[i - 1].w + 4 : 6;
          const room = items[i].X - lim;
          const mv = Math.min(room, over);
          for (let j = i; j < items.length; j++) items[j].X -= mv;
          over -= mv;
        }
        for (const it of items) {
          const v = vis.get(it.o.p.id);
          if (v) {
            if (v.ax == null || Math.abs(v.ax - it.X) > 80) v.ax = it.X;
            v.ax += (it.X - v.ax) * Math.min(1, dt * 10);
          }
          const X = v ? v.ax : it.X;
          const c = colorOf(it.o.p.ci);
          ctx.fillStyle = 'rgba(4,30,27,0.8)';
          rrect(ctx, X, Y - H / 2, it.w, H, H / 2);
          ctx.fill();
          ctx.strokeStyle = c[0];
          ctx.lineWidth = 1.5;
          ctx.stroke();
          // стрелка в сторону утки
          const ax = X + 10;
          ctx.fillStyle = c[0];
          ctx.beginPath();
          if (up) { ctx.moveTo(ax, Y - 5); ctx.lineTo(ax + 5, Y + 3); ctx.lineTo(ax - 5, Y + 3); }
          else { ctx.moveTo(ax, Y + 5); ctx.lineTo(ax + 5, Y - 3); ctx.lineTo(ax - 5, Y - 3); }
          ctx.closePath();
          ctx.fill();
          ctx.font = font;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#fffbea';
          ctx.fillText(it.name, X + 19, Y + 0.5);
        }
      };
      lay(above, topY, true);
      lay(below, botY, false);
      ctx.textAlign = 'center';
    }

    // итог: сцена темнеет, ведущий дейлика — в пятне света
    function drawSpotlight(t) {
      const fp = focus && focusKind === 'host' && byId.get(focus);
      if (!fp) return;
      screenTransform();
      const [x, y] = posOf(fp);
      const X = sxOf(x), Y = syOf(y);
      const R = 46 * view.scale + 20;
      const g = ctx.createRadialGradient(X, Y, R * 0.6, X, Y, R * 3.2);
      g.addColorStop(0, 'rgba(255,240,200,0.10)');
      g.addColorStop(0.3, 'rgba(3,16,14,0)');
      g.addColorStop(1, 'rgba(3,16,14,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, view.w, view.h);
    }

    function drawFlash() {
      if (flash.a < 0.02) return;
      screenTransform();
      const { w, h } = view;
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
      g.addColorStop(0, 'rgba(255,60,60,0)');
      g.addColorStop(1, `rgba(255,60,60,${flash.a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // ===================================================================
    function render(t, dt) {
      const k = view.scale * view.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#3d7a3a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!course) return;
      const first = Math.max(0, Math.floor(cam.y / TILE_H));
      const last = Math.min(Math.floor(W.H / TILE_H), Math.floor((cam.y + view.vh) / TILE_H));
      trimTiles(first, last);
      const shx = shakeFx.x * view.dpr, shy = shakeFx.y * view.dpr;
      // новых тайлов — не больше одного за кадр (кроме самого первого кадра): прыжок камеры не даёт рывка в 100+ мс,
      // а недостроенная полоса кадр-другой стоит травой
      let built = tiles.size ? 0 : -99;
      for (let i = first; i <= last; i++) {
        if (!tiles.has(i)) { if (built >= 1) continue; built++; }
        ctx.drawImage(getTile(i), shx, Math.floor((i * TILE_H - cam.y) * k + shy));
      }
      ctx.setTransform(k, 0, 0, k, (view.offX + shakeFx.x) * view.dpr, (-cam.y * view.scale + shakeFx.y) * view.dpr);
      drawSparkles();
      drawStreaks();
      drawStreams(t);
      drawLilies(t);
      drawPools(t);
      drawRockFoam(t);
      drawRipples();
      drawFinishLine(t);
      drawRocks();
      drawLogs();
      drawGate();
      drawCrowd(t);
      drawDucks(t);
      drawDrops();
      drawFinish(t);
      drawFeathers();
      drawTreeShadows();
      drawTrees(t);
      // следующий тайл вниз по течению — заранее, пока кадр лёгкий (только если он один не готов)
      if (built <= 0 && last + 1 <= Math.floor(W.H / TILE_H) && !tiles.has(last + 1) && simT - prefetchAt > 0.25) {
        prefetchAt = simT;
        getTile(last + 1);
      } else if (built <= 0 && focus && byId.get(focus) && simT - prefetchAt > 0.1) {
        // камера едет к утке итога — тайлы вокруг неё строим заранее, по одному за кадр
        const fy = posOf(byId.get(focus))[1];
        const fi = Math.floor((fy - view.vh / 2) / TILE_H), fj = Math.floor((fy + view.vh / 2) / TILE_H);
        for (let i = Math.max(0, fi); i <= Math.min(Math.floor(W.H / TILE_H), fj); i++) if (!tiles.has(i)) { prefetchAt = simT; getTile(i); break; }
      }
      drawSpotlight(t);
      drawLabels(dt);
      drawPopups();
      drawOffscreen(dt);
      drawProgress(t);
      drawFlash();
    }
    let prefetchAt = 0;
    const stats = { tiles: 0, tileMs: 0, trees: 0 };

    // замер стоимости кадра: среднее и худшее за последние ~2 с (смотрят проверки и отладка)
    const perf = { n: 0, sum: 0, max: 0, last: { avg: 0, max: 0 } };
    function draw(t, dt) {
      const t0 = performance.now();
      try {
        drawFrame(t || 0, clamp(Number(dt) || 0, 0, 0.1));
      } catch (e) {
        // кадр не должен ронять цикл rAF: ошибку видно в консоли, следующий кадр рисуется заново
        if (!draw.warned) { draw.warned = true; console.error('RapidsRender.draw', e); }
      }
      const ms = performance.now() - t0;
      perf.n++; perf.sum += ms; perf.max = Math.max(perf.max, ms);
      if (perf.n >= 120) { perf.last = { avg: perf.sum / perf.n, max: perf.max }; perf.n = perf.sum = perf.max = 0; }
    }
    function drawFrame(t, dt) {
      simT += dt;
      resize();
      if (gate.opening) gate.open = Math.min(1, gate.open + dt * 1.6);
      updateCamera(dt);
      updateWaterFx(dt);
      updateDucks(dt);
      updateParticles(dt);
      updateCheer(dt);
      render(t, dt);
    }

    function setCfg(c) {
      const G = RG();
      cfg = Object.assign({}, G ? G.DEFAULTS : {}, c || {});
      if (course) { const seed = course.seed; courseKey = ''; setCourse(seed); }
    }

    function reset() {
      ripples.length = drops.length = feathers.length = popups.length = 0;
      snap = null;
      byId.clear();
      vis.clear();
      flash.a = 0;
      shakeFx.a = 0;
      cheer.level = 0;
      ribbon.broken = false;
      gate.open = 0; gate.opening = false;
      meFinAt = -1;
      lastPhase = null;
      camSnap = true;
      Sound.ambience(false);
    }

    // экранные координаты точки реки — для подсказок поверх холста
    function screenOf(x, y) { return [sxOf(x), syOf(y)]; }

    return {
      apply, draw, setCfg, reset, screenOf,
      get perf() { return perf.last; },
      get stats() { return stats; },
      get cam() { return cam; },
      get course() { return course; },
      setMe(id) { me = id || null; },
      setSuffix(sfx) { opts.meSuffix = sfx; },
      setWords(w) { Object.assign(words, w || {}); },
      setGaps(top, bottom) { if (top != null) topGap = top; if (bottom != null) bottomGap = bottom; },
      setFocus(id, kind) { if (focus && !id) camSnap = true; focus = id || null; focusKind = id ? (kind || null) : null; },
    };
  }

  root.RapidsRender = { create, Sound, DUCK_COLORS };
})(typeof self !== 'undefined' ? self : this);
