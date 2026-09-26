/*
 * Музыка аукциона для общего экрана (доски). Всё синтезируется WebAudio на лету: ни одного
 * аудиофайла и ни одной чужой мелодии — только свои короткие последовательности аккордов.
 *
 * Что звучит:
 *  - «подложка» во время торгов: тихая петля из четырёх тактов (пэд, бас, перебор, шейкер).
 *    Характер — от семейства категорий: кино/сериалы — таинственный минор, музыка/люди/клубы —
 *    бодрый поп, города/страны/места — светлый «дорожный» лидийский, звери/еда — игривая маримба,
 *    картины/компании/профессии/изобретения — дорийский «клавесин». Каждый четвёртый такт петли
 *    без перебора — дыхание, чтобы за сорок минут партии петля не въедалась;
 *  - напряжение в последние 5 секунд лота: светлеет фильтр, перебор уплотняется, тикают восьмые,
 *    подползает высокий тон;
 *  - короткая заставка на новый лот (у «хита после серии пустых» — длиннее и ярче), удар «Продано»,
 *    мягкий спад на «мимо».
 *
 * Громкость рассчитана на разговор поверх: люди сидят в созвоне, музыка — фон, а не шоу.
 * Всё уходит в ctx.destination — sound-toggle.js перехватывает это подключение, так что общий
 * выключатель звука сайта глушит и музыку. Контекст создаётся и будится только жестом (клик,
 * клавиша): без жеста браузер звук не пустит, и пытаться незачем.
 */
(function () {
  "use strict";

  // Семейства категорий → характер. Неизвестная категория звучит как кино — самый нейтральный.
  const FAMILY = {
    film: "cinema", series: "cinema", character: "cinema",
    artist: "pop", person: "pop", club: "pop",
    city: "travel", country: "travel", place: "travel",
    animal: "playful", food: "playful",
    painting: "classy", company: "classy", profession: "classy", invention: "classy",
  };

  // root — MIDI-нота основы; prog — четыре аккорда (полутоны от основы); arp — тембр перебора.
  // Прогрессии — самые общие обороты гармонии (i–VI–III–VII, I–V–vi–IV и т. п.), никакой цитаты.
  const MOODS = {
    cinema: { bpm: 84, root: 57, prog: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], arp: "triangle", arpCut: 1400, pad: 1, hat: 0, bass: [0, 4], pat: [[0, 1, 2, 1, 3, 2, 1, 2], [0, 2, 1, 3, 2, 1, 0, 1]] },
    pop: { bpm: 112, root: 60, prog: [[0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0]], arp: "sawtooth", arpCut: 1800, pad: 0.7, hat: 1, bass: [0, 3, 4, 7], pat: [[0, 2, 1, 2, 3, 2, 1, 2], [0, 1, 2, 3, 2, 1, 2, 1]] },
    travel: { bpm: 96, root: 62, prog: [[0, 4, 7], [2, 6, 9], [-3, 2, 6], [-5, -1, 2]], arp: "sine", arpCut: 3000, pad: 0.9, hat: 0.6, bass: [0, 4, 6], pat: [[0, 1, 2, 3, 2, 1, 2, 1], [3, 2, 1, 0, 1, 2, 1, 2]] },
    playful: { bpm: 104, root: 65, prog: [[0, 4, 7], [-3, 0, 4], [2, 5, 9], [-5, -1, 2]], arp: "sine", arpCut: 3000, pad: 0.5, hat: 0.8, bass: [0, 2, 4, 6], pat: [[0, 2, 1, 3, 0, 2, 1, 3], [0, 1, 2, 1, 3, 1, 2, 1]] },
    classy: { bpm: 90, root: 64, prog: [[0, 3, 7], [5, 9, 12], [0, 3, 7], [-2, 2, 5]], arp: "square", arpCut: 1600, pad: 0.8, hat: 0, bass: [0, 4], pat: [[0, 1, 2, 3, 2, 1, 2, 1], [0, 2, 3, 2, 1, 2, 3, 2]] },
  };

  const LEVEL = 0.8; // общий уровень подложки; отдельные голоса ещё тише (см. gain у каждого)
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  let ctx = null, out = null, bed = null, bedFilter = null, stingBus = null, noise = null, drone = null, droneGain = null;
  let mood = MOODS.cinema, kind = null;
  let timer = null, nextTime = 0, step = 0, tension = 0, bedTarget = 0, bedOn = false;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    // мягкий компрессор на выходе: заставка поверх подложки не даёт скачка громкости
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.3;
    out = ctx.createGain(); out.gain.value = 1;
    out.connect(comp); comp.connect(ctx.destination);
    bed = ctx.createGain(); bed.gain.value = 0;
    bedFilter = ctx.createBiquadFilter(); bedFilter.type = "lowpass"; bedFilter.frequency.value = 1400; bedFilter.Q.value = 0.4;
    bed.connect(bedFilter); bedFilter.connect(out);
    stingBus = ctx.createGain(); stingBus.gain.value = 1; stingBus.connect(out);
    // шум для шейкера и «вдоха» перед лотом: одна секунда, дальше переиспользуем
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // высокий тон напряжения: всегда звучит, громкость — от tension (0 в покое)
    drone = ctx.createOscillator(); drone.type = "triangle";
    droneGain = ctx.createGain(); droneGain.gain.value = 0;
    drone.connect(droneGain); droneGain.connect(bed);
    drone.start();
    return ctx;
  }

  // Жест пользователя: создаём или будим контекст. Вызывается на любой клик/клавишу по доске.
  function unlock() {
    const c = ensure();
    if (c && c.state === "suspended") c.resume().catch(function () {});
  }
  ["pointerdown", "keydown", "touchstart"].forEach(function (t) { document.addEventListener(t, unlock, { capture: true, passive: true }); });
  const live = () => ctx && ctx.state === "running";

  // ---------- голоса ----------

  function tone(bus, type, freq, t, dur, gain, attack, cutoff) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    let node = o;
    if (cutoff) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cutoff; o.connect(f); node = f; }
    node.connect(g); g.connect(bus);
    const a = attack || 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
    o.start(t); o.stop(t + a + dur + 0.05);
  }

  function hiss(bus, t, dur, gain, hp) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise; f.type = "highpass"; f.frequency.value = hp || 7000;
    s.connect(f); f.connect(g); g.connect(bus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  // маримба/колокольчик: основной тон и негармонический обертон, который гаснет быстрее
  function bell(bus, freq, t, gain, dur) {
    tone(bus, "sine", freq, t, dur || 0.5, gain);
    tone(bus, "sine", freq * 3.99, t, (dur || 0.5) * 0.25, gain * 0.25);
  }

  // ---------- подложка: планировщик с упреждением ----------

  function scheduleStep(t, stepDur) {
    const bar = Math.floor(step / 8), s8 = step % 8, cycle = Math.floor(bar / 4);
    const chord = mood.prog[bar % 4];
    const base = mood.root;
    // пэд: аккорд на весь такт, медленная атака
    if (s8 === 0 && mood.pad) {
      chord.forEach(function (n, i) { tone(bed, i ? "triangle" : "sawtooth", hz(base + n - 12), t, stepDur * 7.4, 0.012 * mood.pad, stepDur * 1.5, 900); });
    }
    // бас
    if (mood.bass.indexOf(s8) >= 0) tone(bed, "triangle", hz(base + chord[0] - 24), t, stepDur * 1.6, 0.05, 0.01, 500);
    // перебор: каждый четвёртый такт отдыхает (кроме напряжения — тогда наоборот, гуще)
    const rest = bar % 4 === 3 && tension < 0.2;
    if (!rest) {
      const pat = mood.pat[cycle % mood.pat.length];
      const notes = chord.concat([chord[0] + 12]);
      const n = notes[pat[s8] % notes.length];
      const f = hz(base + n + (tension > 0.5 ? 12 : 0));
      if (mood.arp === "sine") bell(bed, f, t, 0.03, stepDur * 1.8);
      else tone(bed, mood.arp, f, t, stepDur * 1.2, mood.arp === "square" ? 0.012 : 0.02, 0.004, mood.arpCut);
      // последние секунды: шестнадцатые — между восьмыми ещё одна нота
      if (tension > 0.55) {
        const n2 = notes[(pat[s8] + 2) % notes.length];
        tone(bed, "triangle", hz(base + n2 + 12), t + stepDur / 2, stepDur * 0.5, 0.012 * tension, 0.003, 2500);
      }
    }
    if (mood.hat && s8 % 2 === 1) hiss(bed, t, 0.05, 0.006 * mood.hat);
    // тиканье восьмыми — только под конец лота
    if (tension > 0.05) tone(bed, "sine", s8 % 2 ? 1760 : 2093, t, 0.04, 0.02 * tension, 0.002);
  }

  function pump() {
    if (!live()) return;
    const stepDur = 60 / (mood.bpm * (1 + 0.08 * tension)) / 2; // восьмая
    if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.05;
    while (nextTime < ctx.currentTime + 0.3) {
      if (bedOn) scheduleStep(nextTime, stepDur);
      nextTime += stepDur;
      step++;
    }
  }

  function setBed(target) {
    if (!ctx) return;
    if (target === bedTarget) return;
    bedTarget = target;
    bed.gain.setTargetAtTime(target * LEVEL, ctx.currentTime, target ? 0.6 : 0.35);
    if (target > 0 && !bedOn) { bedOn = true; step = 0; nextTime = ctx.currentTime + 0.05; }
    if (!timer) timer = setInterval(pump, 100);
    if (target === 0) {
      // подложку не гоняем впустую: после затухания планировщик встаёт
      clearTimeout(setBed.off);
      setBed.off = setTimeout(function () { if (bedTarget === 0) { bedOn = false; clearInterval(timer); timer = null; } }, 1500);
    }
  }

  function setTension(t) {
    t = Math.max(0, Math.min(1, t));
    if (Math.abs(t - tension) < 0.02) return;
    tension = t;
    if (!ctx) return;
    const now = ctx.currentTime;
    bedFilter.frequency.setTargetAtTime(mood.arpCut + 2600 * t, now, 0.2);
    droneGain.gain.setTargetAtTime(0.012 * t * t, now, 0.2);
    drone.frequency.setTargetAtTime(hz(mood.root + 24 + 7 * t), now, 0.3);
  }

  // ---------- публичное ----------

  // Состояние доски: зовётся из её цикла кадров. left — сколько мс осталось до конца фазы.
  // preview — играет превью песни исполнителя (категория «артист»): подложка тогда молчит.
  function update(state, left, preview) {
    if (!state) return;
    if (state.kind !== kind) { kind = state.kind; mood = MOODS[FAMILY[kind]] || MOODS.cinema; }
    if (!live()) return;
    const ph = state.phase;
    const bidding = ph === "lot" || ph === "bidding" || ph === "pickup" || ph === "draft";
    const between = ph === "sold" || ph === "taken" || ph === "unsold" || ph === "intro";
    let target = 0;
    if (!state.paused && !preview) target = bidding ? 1 : between ? 0.7 : 0;
    setBed(target);
    setTension(bidding && !state.paused && (ph === "lot" || ph === "bidding") && left < 5000 ? 1 - left / 5000 : 0);
  }

  // Новый лот: короткая восходящая фраза на тонике. hot — хит после серии пустых: шире и ярче.
  function lot(hot) {
    if (!live()) return;
    const t = ctx.currentTime + 0.02, c = mood.prog[0], r = mood.root;
    const notes = hot ? [c[0], c[1], c[2], c[0] + 12, c[1] + 12, c[2] + 12] : [c[0], c[1], c[2], c[0] + 12];
    notes.forEach(function (n, i) { bell(stingBus, hz(r + n), t + i * 0.07, hot ? 0.05 : 0.035, 0.6); });
    if (hot) {
      tone(stingBus, "sine", hz(r - 24), t, 0.9, 0.12, 0.01);
      hiss(stingBus, t, 0.5, 0.02, 3000);
      c.forEach(function (n) { tone(stingBus, "sawtooth", hz(r + n), t + notes.length * 0.07, 0.8, 0.018, 0.02, 2200); });
    }
  }

  // «Продано»: глухой удар молотка и светлый мажорный аккорд
  function sold() {
    if (!live()) return;
    const t = ctx.currentTime + 0.01, r = mood.root;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g); g.connect(stingBus); o.start(t); o.stop(t + 0.4);
    hiss(stingBus, t, 0.06, 0.05, 2000);
    [0, 4, 7, 12].forEach(function (n, i) { tone(stingBus, "triangle", hz(r + 12 + n), t + 0.06 + i * 0.015, 0.7, 0.03, 0.01, 3500); });
  }

  // «Забрали даром» — то же, но скромнее
  function taken() {
    if (!live()) return;
    const t = ctx.currentTime + 0.01, r = mood.root;
    [0, 7, 12].forEach(function (n, i) { bell(stingBus, hz(r + 12 + n), t + i * 0.06, 0.03, 0.4); });
  }

  // «Мимо»: мягкий спуск на малую терцию
  function unsold() {
    if (!live()) return;
    const t = ctx.currentTime + 0.01, r = mood.root;
    tone(stingBus, "sine", hz(r + 12), t, 0.25, 0.03, 0.01);
    tone(stingBus, "sine", hz(r + 9), t + 0.18, 0.4, 0.03, 0.01);
  }

  function stop() {
    if (ctx) setBed(0);
    setTension(0);
  }

  window.AuctionMusic = { update: update, lot: lot, sold: sold, taken: taken, unsold: unsold, stop: stop, unlock: unlock, ctx: function () { return ctx; }, _moods: MOODS, _family: FAMILY };
})();
