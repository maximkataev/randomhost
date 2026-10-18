"use strict";

/*
 * Звук «Ставок»: всё синтезируется WebAudio, файлов нет. Громкость и выключатель — общий sound-toggle.js
 * (он перехватывает AudioNode.connect и ведёт звук через общий мастер-гейн, так что отдельного mute здесь не нужно).
 *
 * Использование: <script src="bets-sound.js"></script>, затем BetsSound.play("win") или BetsSound("win").
 * Сцены получают тот же объект через ctx.sound.play(имя). Контекст создаётся лениво и «будится» первым жестом.
 */
(function (root) {
  let ac = null, noiseBuf = null, ambient = null;
  const AC = root.AudioContext || root.webkitAudioContext;

  function ctx() {
    if (!AC) return null;
    if (!ac) { try { ac = new AC(); } catch (e) { return null; } }
    if (ac.state === "suspended") ac.resume().catch(() => {});
    return ac;
  }
  function noise(c) {
    if (noiseBuf) return noiseBuf;
    noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // Базовые кирпичики: тон с огибающей и шумовой всплеск с фильтром
  function tone(c, { f = 440, f2 = null, t = 0.15, type = "sine", v = 0.2, at = 0, attack = 0.005, filter = null }) {
    const t0 = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t0 + t);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(v, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + t);
    let out = o;
    if (filter) { const fl = c.createBiquadFilter(); fl.type = filter.type; fl.frequency.value = filter.f; o.connect(fl); out = fl; }
    out.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + t + 0.05);
  }
  function burst(c, { t = 0.2, v = 0.2, at = 0, type = "bandpass", f = 1800, f2 = null, q = 1 }) {
    const t0 = c.currentTime + at, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noise(c); s.loop = true; fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f, t0);
    if (f2) fl.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + t);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(v, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + t);
    s.connect(fl); fl.connect(g); g.connect(c.destination); s.start(t0, Math.random()); s.stop(t0 + t + 0.05);
  }

  // Звуки по именам. Имена свободные: неизвестное просто молчит.
  const SOUNDS = {
    // интерфейс
    tick: (c) => tone(c, { f: 1800, t: 0.03, type: "square", v: 0.05 }),
    flap: (c) => { burst(c, { t: 0.05, v: 0.09, f: 3200, q: 4 }); tone(c, { f: 900, f2: 500, t: 0.05, type: "square", v: 0.04 }); },
    chip: (c) => { tone(c, { f: 2400, f2: 1800, t: 0.07, type: "triangle", v: 0.12 }); tone(c, { f: 3200, t: 0.05, at: 0.04, type: "triangle", v: 0.08 }); },
    submit: (c) => { tone(c, { f: 520, t: 0.08, type: "square", v: 0.08 }); tone(c, { f: 780, t: 0.12, at: 0.07, type: "square", v: 0.08 }); },
    lock: (c) => { burst(c, { t: 0.18, v: 0.25, f: 300, f2: 60, type: "lowpass" }); tone(c, { f: 120, f2: 60, t: 0.25, type: "sine", v: 0.25 }); },
    count: (c) => tone(c, { f: 660, t: 0.18, type: "square", v: 0.12 }),
    go: (c) => tone(c, { f: 990, t: 0.4, type: "square", v: 0.15 }),
    penalty: (c) => { tone(c, { f: 220, f2: 110, t: 0.3, type: "sawtooth", v: 0.12 }); },
    // выплаты
    win: (c) => [523, 659, 784, 1047].forEach((f, i) => tone(c, { f, t: 0.22, at: i * 0.07, type: "triangle", v: 0.16 })),
    coins: (c) => { for (let i = 0; i < 7; i++) tone(c, { f: 2600 + Math.random() * 1200, f2: 2000, t: 0.12, at: i * 0.05 + Math.random() * 0.03, type: "triangle", v: 0.09 }); },
    jackpot: (c) => { SOUNDS.win(c); for (let i = 0; i < 12; i++) tone(c, { f: 2200 + Math.random() * 1800, f2: 1800, t: 0.14, at: 0.2 + i * 0.06, type: "triangle", v: 0.08 }); },
    lose: (c) => { tone(c, { f: 330, f2: 140, t: 0.45, type: "sawtooth", v: 0.1, filter: { type: "lowpass", f: 900 } }); },
    out: (c) => { tone(c, { f: 260, f2: 55, t: 0.9, type: "sawtooth", v: 0.14, filter: { type: "lowpass", f: 700 } }); burst(c, { t: 0.5, v: 0.12, f: 400, f2: 80, type: "lowpass" }); },
    // сцены
    whistle: (c) => { tone(c, { f: 2900, t: 0.35, type: "sine", v: 0.12 }); tone(c, { f: 3050, t: 0.35, type: "sine", v: 0.08 }); },
    kick: (c) => { burst(c, { t: 0.09, v: 0.3, f: 700, f2: 120, type: "lowpass" }); tone(c, { f: 140, f2: 70, t: 0.12, type: "sine", v: 0.25 }); },
    goal: (c) => { burst(c, { t: 0.9, v: 0.18, f: 900, type: "bandpass", q: 0.4 }); SOUNDS.win(c); },
    save: (c) => { burst(c, { t: 0.12, v: 0.25, f: 1200, f2: 500, type: "bandpass" }); tone(c, { f: 180, f2: 90, t: 0.15, type: "square", v: 0.1 }); },
    post: (c) => { tone(c, { f: 1320, f2: 1280, t: 0.9, type: "sine", v: 0.22 }); tone(c, { f: 2640, t: 0.6, type: "sine", v: 0.1 }); burst(c, { t: 0.05, v: 0.3, f: 3000 }); },
    crowd: (c) => burst(c, { t: 1.6, v: 0.09, f: 700, f2: 1500, type: "bandpass", q: 0.5 }),
    groan: (c) => tone(c, { f: 220, f2: 90, t: 0.9, type: "sawtooth", v: 0.1, filter: { type: "lowpass", f: 500 } }),
    rattle: (c) => { for (let i = 0; i < 12; i++) burst(c, { t: 0.04, v: 0.12, at: i * 0.05 + Math.random() * 0.02, f: 2000 + Math.random() * 2500, q: 6 }); },
    dice: (c) => { burst(c, { t: 0.05, v: 0.28, f: 2400, q: 8 }); tone(c, { f: 420, f2: 300, t: 0.06, type: "triangle", v: 0.12 }); },
    whoosh: (c) => burst(c, { t: 1.1, v: 0.2, f: 300, f2: 2400, type: "bandpass", q: 0.8 }),
    boom: (c) => { burst(c, { t: 1.2, v: 0.45, f: 1400, f2: 40, type: "lowpass" }); tone(c, { f: 90, f2: 25, t: 1.0, type: "sine", v: 0.45 }); },
    pull: (c) => { burst(c, { t: 0.12, v: 0.14, f: 500, f2: 200, type: "bandpass" }); },
    beacon: (c) => { tone(c, { f: 880, t: 0.12, type: "sine", v: 0.12 }); tone(c, { f: 1760, t: 0.2, at: 0.06, type: "sine", v: 0.06 }); },
    reel: (c) => tone(c, { f: 1400 + Math.random() * 400, t: 0.025, type: "square", v: 0.05 }),
    stop: (c) => { tone(c, { f: 330, t: 0.3, type: "square", v: 0.15 }); burst(c, { t: 0.1, v: 0.2, f: 1000 }); },
    photo: (c) => { burst(c, { t: 0.06, v: 0.3, f: 4000, q: 3 }); tone(c, { f: 3000, t: 0.04, type: "square", v: 0.1, at: 0.09 }); },
    bell: (c) => { tone(c, { f: 1568, t: 1.1, type: "sine", v: 0.18 }); tone(c, { f: 2349, t: 0.8, type: "sine", v: 0.08 }); },
  };

  function play(name) {
    const c = ctx();
    if (!c || !SOUNDS[name]) return;
    try { SOUNDS[name](c); } catch (e) { /* звук не должен ронять страницу */ }
  }

  // Фоновый гул зала: тихий шум с медленной модуляцией; включается/гасится явно
  function ambience(on) {
    const c = ctx();
    if (!c) return;
    if (!on) { if (ambient) { try { ambient.g.gain.linearRampToValueAtTime(0.0001, c.currentTime + 0.6); ambient.s.stop(c.currentTime + 0.7); } catch (e) {} ambient = null; } return; }
    if (ambient) return;
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    s.buffer = noise(c); s.loop = true; f.type = "bandpass"; f.frequency.value = 520; f.Q.value = 0.35;
    g.gain.value = 0.0001; g.gain.linearRampToValueAtTime(0.028, c.currentTime + 2);
    lfo.frequency.value = 0.13; lg.gain.value = 140; lfo.connect(lg); lg.connect(f.frequency); lfo.start();
    s.connect(f); f.connect(g); g.connect(c.destination); s.start();
    ambient = { s, g };
  }

  // Первый жест пользователя будит контекст (политика автозапуска)
  if (root.document) {
    const wake = () => { ctx(); root.document.removeEventListener("pointerdown", wake); root.document.removeEventListener("keydown", wake); };
    root.document.addEventListener("pointerdown", wake, { once: false }); root.document.addEventListener("keydown", wake, { once: false });
  }

  const api = function (name) { play(name); };
  api.play = play; api.ambience = ambience; api.names = Object.keys(SOUNDS);
  root.BetsSound = api;
})(typeof window !== "undefined" ? window : globalThis);
