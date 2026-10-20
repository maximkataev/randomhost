/*
 * blackjack-sfx.js — звук стола блэкджека. Без семплов: всё синтезируется через WebAudio,
 * как rlSfx в roulette-shared.js. Всё идёт в ctx.destination — sound-toggle.js перехватывает это подключение
 * и глушит общим выключателем (localStorage['site-muted']). Контекст создаём на первом касании/клавише.
 *
 * API (window.BJSfx):
 *   BJSfx.play(name, k)   slide | flip | chip | stack | pay | crack | gold | pulse | salvo | tick | shuffle | sweep | lose | coins | bj | level | whoosh
 *   BJSfx.ambient(on)     тихий шум зала (розовый шум + редкие дальние звяки); уважает site-muted
 *   BJSfx.muted()         true, если выключено общим выключателем
 *   BJSfx.unlock()        создать контекст (звать из обработчика жеста, если нужно раньше первого касания)
 *
 * Синтаксис — ES2017 (Chromium 80–83).
 */
(function () {
  'use strict';
  var ctx = null, noise = null, pink = null, amb = null;

  function muted() {
    try { return localStorage.getItem('site-muted') === '1'; } catch (e) { return false; }
  }
  function ac(create) {
    if (ctx) { if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} } return ctx; }
    if (!create) return null;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    var d = noise.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // розовый шум для зала: несколько интеграторов (Paul Kellet)
    pink = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 4), ctx.sampleRate);
    var p = pink.getChannelData(0), b0 = 0, b1 = 0, b2 = 0;
    for (var j = 0; j < p.length; j++) {
      var w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
      p[j] = (b0 + b1 + b2 + w * 0.1848) * 0.08;
    }
    if (ambWanted) startAmbient();
    return ctx;
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) {
    window.addEventListener(t, function () { ac(true); }, { passive: true, capture: true });
  });

  function out(c, node, vol) { var g = c.createGain(); g.gain.value = vol; node.connect(g); g.connect(c.destination); return g; }
  function env(g, t, a, d, v) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function tone(f0, f1, at, dur, type, vol) {
    var c = ac(); if (!c || c.state !== 'running') return;
    var t = c.currentTime + at;
    var o = c.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    var g = out(c, o, 1); env(g, t, 0.004, dur, vol);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function hiss(at, dur, vol, type, f, q, f1) {
    var c = ac(); if (!c || c.state !== 'running' || !noise) return;
    var t = c.currentTime + at;
    var s = c.createBufferSource(); s.buffer = noise;
    var fl = c.createBiquadFilter(); fl.type = type || 'bandpass'; fl.frequency.setValueAtTime(f || 2500, t); fl.Q.value = q || 1.2;
    if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
    s.connect(fl);
    var g = out(c, fl, 1); env(g, t, 0.003, dur, vol);
    s.start(t, Math.random() * 0.25); s.stop(t + dur + 0.05);
  }

  var SFX = {
    // карта выскальзывает из шуза: шорох картона по пластику, с понижением
    slide: function () { hiss(0, 0.18, 0.3, 'bandpass', 3200, 0.9, 1400); hiss(0.14, 0.05, 0.25, 'highpass', 4000, 1); },
    // переворот: щелчок и короткий шорох
    flip: function () { hiss(0, 0.05, 0.3, 'highpass', 2600, 0.8); tone(420, 240, 0.03, 0.06, 'sine', 0.1); hiss(0.07, 0.08, 0.14, 'bandpass', 1800, 1); },
    // глиняная фишка о сукно
    chip: function () { hiss(0, 0.035, 0.5, 'bandpass', 2800, 1.6); tone(540, 380, 0, 0.03, 'sine', 0.12); hiss(0.05, 0.025, 0.18, 'bandpass', 3400, 2); },
    // столбик: несколько фишек подряд
    stack: function (n) { n = n || 3; for (var i = 0; i < n; i++) { hiss(i * 0.045, 0.03, 0.4, 'bandpass', 2600 + i * 200, 1.8); tone(600 + i * 40, 420, i * 0.045, 0.025, 'sine', 0.1); } },
    // звон выплаты: k — порядковый номер, тон растёт
    pay: function (k) { k = k || 0; var f = 880 * Math.pow(1.0595, k * 2); tone(f, f, 0, 0.3, 'triangle', 0.16); tone(f * 2, f * 2, 0.02, 0.22, 'sine', 0.06); hiss(0, 0.04, 0.25, 'bandpass', 3000, 2); },
    // трещина перебора: сухой треск, падение
    crack: function () { hiss(0, 0.06, 0.6, 'highpass', 1200, 0.5); hiss(0.05, 0.12, 0.35, 'bandpass', 600, 0.6, 180); tone(180, 60, 0.04, 0.2, 'sawtooth', 0.12); },
    // золотой аккорд 21 / блэкджека
    gold: function () { [659, 831, 988, 1319].forEach(function (f, i) { tone(f, f, i * 0.06, 0.6, 'triangle', 0.13); tone(f * 2, f * 2, i * 0.06 + 0.02, 0.4, 'sine', 0.04); }); for (var i = 0; i < 10; i++) tone(2400 + Math.random() * 2400, 0, 0.25 + i * 0.05, 0.07, 'sine', 0.05); },
    bj: function () { SFX.gold(); tone(1319, 1319, 0.35, 0.8, 'triangle', 0.1); tone(1976, 1976, 0.4, 0.7, 'sine', 0.05); },
    // пульс для «карты за картой»: k — интенсивность 0..1
    pulse: function (k) { var v = 0.3 + 0.4 * (k || 0); tone(68, 44, 0, 0.13, 'sine', v); tone(62, 40, 0.18, 0.1, 'sine', v * 0.7); },
    // залп: перебор дилера — хлопок и россыпь
    salvo: function () { tone(120, 50, 0, 0.3, 'sine', 0.6); hiss(0, 0.25, 0.6, 'lowpass', 900, 0.7); for (var i = 0; i < 18; i++) tone(1800 + Math.random() * 2600, 0, 0.1 + i * 0.04, 0.08, 'sine', 0.06); hiss(0.3, 0.5, 0.15, 'bandpass', 5000, 1); },
    // такт таймера
    tick: function (hot) { tone(hot ? 1500 : 1100, hot ? 1400 : 1000, 0, 0.04, 'triangle', hot ? 0.16 : 0.07); },
    // тасовка: серия шорохов
    shuffle: function () { for (var i = 0; i < 14; i++) hiss(i * 0.07, 0.05, 0.22 + Math.random() * 0.1, 'bandpass', 2200 + Math.random() * 1500, 1.2); hiss(1.05, 0.2, 0.25, 'bandpass', 1600, 0.8, 600); },
    // лопатка сгребает фишки
    sweep: function () { hiss(0, 0.4, 0.22, 'bandpass', 1100, 0.6, 500); for (var i = 0; i < 4; i++) hiss(0.1 + i * 0.07, 0.03, 0.2, 'bandpass', 2600, 1.8); },
    lose: function () { tone(392, 370, 0, 0.2, 'triangle', 0.12); tone(311, 233, 0.22, 0.4, 'triangle', 0.12); },
    // монеты джекпота
    coins: function () { for (var i = 0; i < 24; i++) { var f = 2200 + Math.random() * 3200; tone(f, f * 0.9, i * 0.05, 0.09, 'sine', 0.07); hiss(i * 0.05, 0.02, 0.2, 'bandpass', 5000, 3); } tone(1047, 1047, 0, 0.9, 'triangle', 0.08); },
    level: function () { tone(523, 523, 0, 0.18, 'triangle', 0.12); tone(784, 784, 0.16, 0.35, 'triangle', 0.12); },
    whoosh: function () { hiss(0, 0.3, 0.25, 'bandpass', 600, 0.5, 2400); },
    // щелчок браслета по шузу
    tap: function () { tone(1900, 1500, 0, 0.03, 'sine', 0.12); hiss(0, 0.02, 0.3, 'highpass', 5000, 1); }
  };

  var ambWanted = false;
  function startAmbient() {
    var c = ac(); if (!c || amb || !pink) return;
    var s = c.createBufferSource(); s.buffer = pink; s.loop = true;
    var fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 900; fl.Q.value = 0.4;
    var g = c.createGain(); g.gain.value = 0.0001;
    s.connect(fl); fl.connect(g); g.connect(c.destination);
    s.start();
    g.gain.exponentialRampToValueAtTime(0.11, c.currentTime + 2);
    // далёкие звяки фишек раз в несколько секунд
    var timer = setInterval(function () {
      if (!amb || Math.random() < 0.35) return;
      hiss(0, 0.03, 0.05 + Math.random() * 0.05, 'bandpass', 2400 + Math.random() * 1200, 2);
    }, 1700);
    amb = { src: s, gain: g, timer: timer };
  }
  function stopAmbient() {
    if (!amb) return;
    var a = amb; amb = null;
    clearInterval(a.timer);
    try { a.gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8); a.src.stop(ctx.currentTime + 0.9); } catch (e) {}
  }
  function ambient(on) {
    ambWanted = !!on;
    if (on) { if (!muted()) startAmbient(); } else stopAmbient();
  }
  // ambient «приглушить» на время (ва-банк: тишина) — k 0..1
  function duck(k, ms) {
    if (!amb || !ctx) return;
    try {
      amb.gain.gain.cancelScheduledValues(ctx.currentTime);
      amb.gain.gain.setTargetAtTime(Math.max(0.0001, 0.11 * k), ctx.currentTime, 0.3);
      if (ms) setTimeout(function () { if (amb) amb.gain.gain.setTargetAtTime(0.11, ctx.currentTime, 0.6); }, ms);
    } catch (e) {}
  }

  window.BJSfx = {
    play: function (name, k) { if (SFX[name]) { try { SFX[name](k); } catch (e) {} } },
    ambient: ambient,
    duck: duck,
    muted: muted,
    unlock: function () { ac(true); },
    names: Object.keys(SFX)
  };
})();
