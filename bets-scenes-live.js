"use strict";

/*
 * «Ставки»: сцены РЕАЛЬНЫХ событий (docs/bets-spec.md §4.5, §4.6, §10; контракт — docs/bets-protocol.md §5, §6).
 * Файл подключается ПОСЛЕ ядра bets-scenes.js и регистрирует 12 типов через BetsScenes.register(types, factory):
 *   btc, btceth                      — график цены (линия тикает, полосы порогов ±σ, стоп-кадр);
 *   emoji, wikiduel, lightning, airport — дуэль счётчиков (два столбика растут от нуля);
 *   wikiedit, whales                 — пороги (лента падающих правок / транзакций, «киты» крупно);
 *   news, lang, wikinext             — категориальная рулетка (барабан реальных элементов потока);
 *   drand                            — маяк (пульс раз в 3 с, hex-цифры замирают слева направо).
 *
 * factory(host, ctx) → { show(opts), play(opts) → Promise, live(data), destroy() } (+ debug() для стенда).
 * ctx = { emit('say'|'stamp', ...), muted(), sound, now?() } — реплики и штампы только через ctx.emit.
 *
 * Время сцены τ (мс) считается от начала окна ожидания (для btc — от кадра s0). Сцена живёт в двух режимах:
 *   show()  — «ожидание»: рисует поток live() в реальном времени, исхода ещё нет (анимация ожидания, обратный отсчёт);
 *   play()  — исход известен (или outcome=null + voidAll → «исход не пришёл, ставки возвращены»): досчитывает недостающее
 *             по seed (мост Брауна к исходу, события дуэли, посадка барабана) и держит стоп-кадр до durationMs.
 * Если show() уже идёт, play() продолжает с текущего τ (реальные данные не пересчитываются); если сцены не было
 * (переподключение) — рисуется целиком по seed, offsetMs перематывает. Вся случайность — mulberry32(seed).
 */
(function (root) {
  const doc = root.document;
  const BS = root.BetsShared || null;

  // ---------- палитра и шрифты ----------
  const C = { bg: "#07090c", glass: "#0d1217", glass2: "#121a21", line: "#1f2b34", text: "#eef2ee", dim: "#7d8c93", lime: "#b6ff2e", mag: "#ff2e88", amber: "#ffd34d", cyan: "#38d3ff", silver: "#c9d6df", violet: "#a78bfa", orange: "#ff7a2e", mint: "#4dffb0" };
  const CATCOL = [C.lime, C.mag, C.amber, C.cyan, C.violet, C.orange, C.mint];
  const DISP = '"Big Shoulders Display", "Oswald", "Roboto Condensed","Arial Narrow",Impact,sans-serif';
  const MONO = '"JetBrains Mono",ui-monospace,Menlo,monospace';

  // окно ожидания реального исхода по типам (дублирует bets/registry.js LIVE_WAIT_MS), мс
  const WAIT = { btc: 20000, btceth: 20000, news: 45000, emoji: 20000, wikiduel: 20000, wikiedit: 20000, whales: 20000, lightning: 40000, airport: 90000, lang: 9000, wikinext: 9000, drand: 12000 };
  const ICON = { btc: "₿", btceth: "₿", news: "📰", emoji: "😂", wikiduel: "📚", wikiedit: "✏️", whales: "🐋", lightning: "⚡", airport: "✈️", lang: "🌐", wikinext: "📖", drand: "📡" };
  const TITLE = { btc: "Биткоин: выше или ниже", btceth: "BTC против ETH", news: "Кто первый в новостях", emoji: "Эмодзи-дуэль", wikiduel: "Википедия-дуэль", wikiedit: "Правка в Википедии", whales: "Киты в мемпуле", lightning: "Молнии", airport: "Аэропорт-дуэль", lang: "Язык следующего поста", wikinext: "Следующая правка Википедии", drand: "Маяк случайности" };

  const TXT = {
    ru: { est: "≈ оценка модели", estS: "≈ модель", exact: "точная случайность", wait: "ждём исход", voidT: "ИСХОД НЕ ПРИШЁЛ", voidS: "ставки возвращены", left: "осталось", verify: "проверь на drand", tie: "НИЧЬЯ", wins: "побеждает", rush: "ФИНАЛЬНЫЙ РЫВОК", first: "ПЕРВЫМ", pre: "ставки открыты · цена закрытия зафиксируется при старте", s0: "цена закрытия", lead: "ЛИДЕР", gap: "разрыв", events: "событий", hit: "совпало", round: "раунд", spin: "ждём раунд маяка", digit: "последняя цифра", odd: "нечёт", even: "чёт", num: "цифра", letter: "буква", reel: "ждём элемент потока", stop: "СТОП", next: "следующий раунд через", total: "итог", lead2: "Лидер сменился", more: "больше", sec: "с" },
    en: { est: "≈ model estimate", estS: "≈ model", exact: "exact randomness", wait: "waiting for the result", voidT: "NO RESULT", voidS: "bets refunded", left: "left", verify: "verify on drand", tie: "TIE", wins: "wins", rush: "FINAL SPRINT", first: "FIRST", pre: "bets open · closing price locks at start", s0: "closing price", lead: "LEAD", gap: "gap", events: "events", hit: "matched", round: "round", spin: "waiting for a beacon round", digit: "last digit", odd: "odd", even: "even", num: "digit", letter: "letter", reel: "waiting for a stream item", stop: "STOP", next: "next round in", total: "result", lead2: "Lead changed", more: "more", sec: "s" },
    el: { est: "≈ εκτίμηση μοντέλου", estS: "≈ μοντέλο", exact: "ακριβής τυχαιότητα", wait: "αναμονή αποτελέσματος", voidT: "ΔΕΝ ΥΠΑΡΧΕΙ ΑΠΟΤΕΛΕΣΜΑ", voidS: "οι στοιχηματισμοί επιστρέφονται", left: "απομένουν", verify: "έλεγχος στο drand", tie: "ΙΣΟΠΑΛΙΑ", wins: "νικά", rush: "ΤΕΛΙΚΟ ΣΠΡΙΝΤ", first: "ΠΡΩΤΟ", pre: "ανοιχτά στοιχήματα · η τιμή κλεισίματος κλειδώνει στην εκκίνηση", s0: "τιμή κλεισίματος", lead: "ΕΠΙΚΕΦΑΛΗΣ", gap: "διαφορά", events: "γεγονότα", hit: "ταίριαξαν", round: "γύρος", spin: "αναμονή γύρου φάρου", digit: "τελευταίο ψηφίο", odd: "μονό", even: "ζυγό", num: "ψηφίο", letter: "γράμμα", reel: "αναμονή στοιχείου ροής", stop: "ΣΤΟΠ", next: "επόμενος γύρος σε", total: "αποτέλεσμα", lead2: "Άλλαξε ο επικεφαλής", more: "περισσότερα", sec: "δευτ." },
  };
  const lang = () => ((doc && doc.documentElement.lang) || "ru").slice(0, 2);
  const tr = (k) => (TXT[lang()] || TXT.ru)[k] || TXT.ru[k] || k;

  // ---------- мелкие утилиты ----------
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeInOut = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const fmt = (x, d) => { const s = Number(x).toFixed(d == null ? 2 : d); return lang() === "en" ? s : s.replace(".", ","); };
  const sgn = (x, d) => (x < 0 ? "−" : "+") + fmt(Math.abs(x), d);
  const money = (x) => { const s = fmt(Math.abs(x), 2); return (x < 0 ? "−" : "+") + "$" + s; };
  const kcFmt = (kc) => fmt(kc / 100, 2);
  const isEmoji = (s) => { try { return /\p{Extended_Pictographic}/u.test(s || ""); } catch (e) { return false; } };

  function hash32(a, b) {
    let h = ((a | 0) ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (b | 0), 0x85ebca6b) >>> 0; h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    return h >>> 0;
  }
  function fbMulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const mkRng = (seed) => ((BS && BS.mulberry32) || fbMulberry)(seed >>> 0);
  const gauss = (r) => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  // мост Брауна: заполняет NaN между известными узлами; zArr[i] — стандартные нормальные «инновации»
  function bridgeFill(arr, sd, zArr) {
    let a = 0;
    while (a < arr.length) {
      if (isNaN(arr[a])) { a++; continue; }
      let b = a + 1;
      while (b < arr.length && isNaN(arr[b])) b++;
      if (b >= arr.length) break;
      for (let i = a + 1; i < b; i++) {
        const rem = b - (i - 1);
        const mean = arr[i - 1] + (arr[b] - arr[i - 1]) / rem;
        arr[i] = mean + sd * Math.sqrt((rem - 1) / rem) * zArr[i];
      }
      a = b;
    }
    return arr;
  }

  // ---------- состояние и цикл сцены ----------
  function newScene(type, def, host, ctx) {
    ctx = ctx || {};
    const S = {
      type: ctx.type || type, def, host, ctx, W: 0, H: 0, k: 1, dpr: 1, mode: "idle", stale: false, destroyed: false,
      input: {}, meta: {}, markets: null, seed: 1, clockStart: null, tau: 0, dt: 16, lastNow: null, f: 1, dataEnd: Infinity, end: Infinity, wms: WAIT[type] || 20000,
      outcome: null, void: false, voidAt: 0, done: false, resolve: null, shown: {}, stamped: false, hasLive: false, synthetic: false, rafId: 0, timer: 0,
    };
    S.now = () => (ctx.now ? ctx.now() : (root.performance ? root.performance.now() : Date.now()));
    S.emit = (...a) => { try { ctx.emit && ctx.emit(...a); } catch (e) { /* реплики не должны ломать сцену */ } };
    S.snd = (n) => { try { if (!(ctx.muted && ctx.muted()) && ctx.sound && ctx.sound.play) ctx.sound.play(n); } catch (e) { /* звук необязателен */ } };
    S.rng = (salt) => mkRng(hash32(S.seed | 0, salt | 0));
    S.fs = (n) => Math.max(9, Math.round(n * S.k));
    S.u = (n) => n * S.k;
    S.lbl = (id) => ((S.meta && S.meta.labels && S.meta.labels[id]) != null ? S.meta.labels[id] : id);

    // канва
    host.style.position = host.style.position || "relative";
    const cv = doc.createElement("canvas");
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;background:" + C.bg;
    host.appendChild(cv);
    S.cv = cv; S.g = cv.getContext("2d");
    function resize() {
      const r = host.getBoundingClientRect();
      const W = Math.max(40, Math.round(r.width)), H = Math.max(40, Math.round(r.height));
      const dpr = Math.min(3, root.devicePixelRatio || 1);
      if (W === S.W && H === S.H && dpr === S.dpr) return;
      S.W = W; S.H = H; S.dpr = dpr;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      S.k = clamp(Math.sqrt(W * H) / 700, 0.62, 1.55);
      S.hh = Math.round(30 * S.k);
      S.sizeVer = (S.sizeVer || 0) + 1;
    }
    resize();
    if (root.ResizeObserver) { S.ro = new root.ResizeObserver(resize); S.ro.observe(host); }
    try { if (doc.fonts && doc.fonts.load) { doc.fonts.load('800 20px "Big Shoulders Display", "Oswald", "Roboto Condensed"'); doc.fonts.load('700 14px "JetBrains Mono"'); } } catch (e) { /* шрифты подтянутся сами */ }

    // текст
    S.txt = (str, x, y, o) => {
      o = o || {}; const g = S.g;
      const size = o.s || 14;
      g.font = (o.f === "m" ? `${o.w || 700} ${size}px ${MONO}` : `${o.w || 800} ${size}px ${DISP}`);
      g.textAlign = o.a || "left"; g.textBaseline = o.b || "middle";
      str = String(str);
      if (o.maxW && g.measureText(str).width > o.maxW) {
        while (str.length > 1 && g.measureText(str + "…").width > o.maxW) str = str.slice(0, -1);
        str += "…";
      }
      g.save();
      g.globalAlpha = (o.alpha == null ? 1 : o.alpha) * g.globalAlpha;
      if (o.glow) { g.shadowColor = o.glow; g.shadowBlur = o.gb == null ? 12 : o.gb; }
      g.fillStyle = o.c || C.text;
      g.fillText(str, x, y);
      g.restore();
      return g.measureText(str).width;
    };
    S.measure = (str, size, f, w) => { S.g.font = (f === "m" ? `${w || 700} ${size}px ${MONO}` : `${w || 800} ${size}px ${DISP}`); return S.g.measureText(String(str)).width; };
    // подгоняет размер шрифта под ширину
    S.fit = (str, size, maxW, f) => { let s = size; while (s > 8 && S.measure(str, s, f) > maxW) s -= 1; return s; };
    S.rr = (x, y, w, h, r) => { const g = S.g; r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    S.pill = (str, x, y, o) => { // плашка с текстом; x — центр
      o = o || {}; const s = o.s || S.fs(12);
      const tw = S.measure(str, s, o.f || "m", o.w || 800), pw = tw + s * 1.4, ph = s * 1.9;
      const g = S.g; g.save(); g.globalAlpha *= (o.alpha == null ? 1 : o.alpha);
      S.rr(x - pw / 2, y - ph / 2, pw, ph, ph / 2);
      g.fillStyle = o.bg || "rgba(13,18,23,.9)"; g.fill();
      g.lineWidth = Math.max(1, S.k); g.strokeStyle = o.c || C.lime;
      if (o.glow) { g.shadowColor = o.c || C.lime; g.shadowBlur = 10; }
      g.stroke(); g.restore();
      S.txt(str, x, y + 1, { s, f: o.f || "m", w: o.w || 800, c: o.tc || o.c || C.lime, a: "center", alpha: o.alpha });
      return pw;
    };

    // ---------- API ----------
    function adopt(o) {
      o = o || {};
      if (o.type) S.type = o.type;
      if (o.input) S.input = o.input;
      if (o.meta) S.meta = o.meta;
      if (o.markets) S.markets = o.markets;
      if (o.seed != null) S.seed = o.seed | 0;
      const inp = S.input || {};
      const T = inp.T || (inp.opts && inp.opts.T);
      S.wms = T ? T * 1000 : (WAIT[S.type] || 20000);
      S.sizeVer++;
    }
    function reset() {
      S.clockStart = null; S.tau = 0; S.f = 1; S.dataEnd = Infinity; S.end = Infinity; S.outcome = null; S.void = false; S.done = false; S.resolve = null;
      S.stamped = false; S.played = false; S.hasLive = false; S.synthetic = false; S.shown = {}; S.lastNow = null; S.revealAt = null; S.stale = false;
      def.reset(S);
    }
    function loop() {
      if (S.destroyed) return;
      S.rafId = root.requestAnimationFrame(loop);
      frame();
    }
    function frame() {
      const now = S.now();
      S.dt = S.lastNow == null ? 16 : clamp(now - S.lastNow, 0, 100); S.lastNow = now;
      S.tau = S.clockStart == null ? 0 : now - S.clockStart;
      const g = S.g;
      g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      background(S);
      S.shown.mode = S.mode;
      def.draw(S, S.tau);
      chrome(S);
      if (S.void) voidBanner(S);
      if (S.played && !S.done && S.tau >= S.end) finish();
    }
    function finish() {
      if (S.done) return;
      S.done = true; S.stale = true; S.mode = "done"; S.shown.doneAt = Math.round(S.tau); S.shown.endPlanned = Math.round(S.end);
      if (S.timer) { clearTimeout(S.timer); S.timer = 0; }
      const r = S.resolve; S.resolve = null; if (r) r({ type: S.type, outcome: S.outcome, void: S.void });
    }
    S.stamp = (text, tone) => { if (S.stamped) return; S.stamped = true; S.shown.stamp = text; S.emit("stamp", text, tone || "neutral"); };

    reset();
    const api = {
      show(o) {
        if (S.stale || S.mode === "play" || S.mode === "done" || (S.mode === "show" && !(o && o.keep))) reset();
        adopt(o);
        S.mode = "show";
        if (def.startOnShow && S.clockStart == null) S.clockStart = S.now();
        def.onShow && def.onShow(S);
        if (!S.rafId) loop();
      },
      live(d) {
        if (!d || S.destroyed || S.void) return;   // после «исход не пришёл» поток игнорируем
        S.hasLive = true;
        if (S.clockStart == null && !def.clockOnData && S.mode !== "idle") S.clockStart = S.now();
        def.live(S, d);
      },
      play(o) {
        o = o || {};
        if (S.mode === "idle" && !S.hasLive) reset(); else if (S.mode === "done") { const keepLive = false; if (!keepLive) reset(); }
        adopt(o);
        const now = S.now();
        const hadClock = S.clockStart != null;
        const hist = def.hasHistory(S);
        if (o.offsetMs != null && o.offsetMs > 0) { S.clockStart = now - o.offsetMs; S.synthetic = !hist; }
        else if (!hadClock) { S.clockStart = now; S.synthetic = !hist; }
        S.mode = "play"; S.played = true; S.done = false; S.stamped = false;
        S.tau = now - S.clockStart;
        const tau0 = S.tau;
        const D = o.durationMs > 0 ? o.durationMs : S.wms + 4000;
        S.void = o.outcome == null || o.voidAll === true;
        S.outcome = S.void ? null : o.outcome;
        if (S.void) {
          S.voidAt = tau0;
          S.dataEnd = Math.min(S.dataEnd, tau0);
          S.end = tau0 + clamp(D - tau0, 1500, 3200);
          def.prepVoid && def.prepVoid(S);
        } else {
          const R = Math.min(4500, D * 0.3);
          if (hist && !S.synthetic) { S.f = 1; S.dataEnd = S.wms; }
          else { S.f = clamp((D - R) / S.wms, 0.12, 1); S.dataEnd = S.f * S.wms; }
          S.end = Math.max(D, S.dataEnd + 2500, tau0 + 3500);
          def.prep(S, tau0, D);   // может переопределить dataEnd/end (барабан)
        }
        S.D = D;
        if (!ctx.now) S.timer = setTimeout(() => { if (!S.done && !S.destroyed) finish(); }, Math.max(300, S.end - tau0 + 400)); // страховка, если вкладка в фоне
        if (!S.rafId) loop();
        return new Promise((res) => { S.resolve = res; });
      },
      destroy() {
        S.destroyed = true;
        if (S.rafId) root.cancelAnimationFrame(S.rafId);
        if (S.timer) clearTimeout(S.timer);
        if (S.ro) S.ro.disconnect();
        def.destroy && def.destroy(S);
        if (cv.parentNode) cv.parentNode.removeChild(cv);
        if (S.resolve) { const r = S.resolve; S.resolve = null; r({ type: S.type, destroyed: true }); }
      },
      debug() { return JSON.parse(JSON.stringify(S.shown)); },
      // для стенда: один шаг отрисовки без rAF
      _frame: frame,
    };
    return api;
  }

  // ---------- общий фон и шапка ----------
  function background(S) {
    const g = S.g, W = S.W, H = S.H;
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const gr = g.createRadialGradient(W / 2, H * 0.55, 10, W / 2, H * 0.55, Math.max(W, H) * 0.7);
    gr.addColorStop(0, "rgba(255,46,136,.06)"); gr.addColorStop(0.55, "rgba(182,255,46,.02)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(125,140,147,.07)"; g.lineWidth = 1;
    const step = Math.round(40 * S.k);
    g.beginPath();
    for (let x = step; x < W; x += step) { g.moveTo(x + 0.5, S.hh); g.lineTo(x + 0.5, H); }
    for (let y = S.hh + step; y < H; y += step) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); }
    g.stroke();
  }

  function chrome(S) {
    const g = S.g, W = S.W, hh = S.hh;
    g.fillStyle = "rgba(13,18,23,.92)"; g.fillRect(0, 0, W, hh);
    g.fillStyle = C.line; g.fillRect(0, hh - 1, W, 1);
    const pad = S.u(10);
    // прогресс окна
    let prog = 0;
    const span = isFinite(S.dataEnd) ? S.dataEnd : S.wms;
    if (S.clockStart != null) prog = clamp(S.tau / span, 0, 1);
    g.fillStyle = S.void ? C.amber : C.lime; g.globalAlpha = 0.9; g.fillRect(0, hh - 2, W * prog, 2); g.globalAlpha = 1;
    // заголовок
    const icon = (BS && BS.typeIcon && BS.typeIcon(S.type)) || ICON[S.type] || "🎯";
    const title = (BS && BS.typeTitle && BS.typeTitle(S.type, lang())) || TITLE[S.type] || S.type;
    const ts = S.fs(17);
    const iw = S.txt(icon, pad, hh / 2 + 1, { s: ts, f: "m" });
    const tw = S.txt(String(title).toUpperCase(), pad + iw + S.u(8), hh / 2 + 1, { s: ts, c: "#fff", glow: C.mag, gb: 8, maxW: W * 0.5 });
    // таймер справа
    let rem;
    if (S.played) rem = Math.max(0, S.end - S.tau);
    else if (S.clockStart != null) rem = Math.max(0, S.wms - S.tau);
    else rem = null;
    const waiting = S.mode === "show" && S.clockStart != null && S.tau >= S.wms;
    const ctext = rem == null ? "--:--" : waiting ? "…" : String(Math.floor(rem / 60000)).padStart(2, "0") + ":" + String(Math.floor(rem / 1000) % 60).padStart(2, "0");
    const cw = S.txt(ctext, W - pad, hh / 2 + 1, { s: S.fs(16), f: "m", c: S.void ? C.amber : C.lime, a: "right", glow: C.lime, gb: 6 });
    // «LIVE»-точка
    const blink = 0.45 + 0.55 * Math.abs(Math.sin(S.now() / 500));
    g.fillStyle = S.void ? C.amber : C.lime; g.globalAlpha = blink; g.beginPath(); g.arc(W - pad - cw - S.u(12), hh / 2, S.u(3.5), 0, 6.3); g.fill(); g.globalAlpha = 1;
    // плашка «оценка модели»
    const exact = S.type === "drand";
    const room = W - pad - cw - S.u(30) - (pad + iw + S.u(8) + tw + S.u(14));
    const full = exact ? tr("exact") : tr("est"), short = exact ? tr("exact") : tr("estS");
    const bs = S.fs(10);
    const text = S.measure(full, bs, "m", 800) + bs * 1.4 < room ? full : short;
    if (S.measure(text, bs, "m", 800) + bs * 1.4 < room) {
      const bx = pad + iw + S.u(8) + tw + S.u(14) + (S.measure(text, bs, "m", 800) + bs * 1.4) / 2;
      S.pill(text, bx, hh / 2 + 1, { s: bs, c: exact ? C.lime : C.amber });
    }
    S.shown.badge = text;
  }

  function voidBanner(S) {
    const g = S.g, W = S.W, H = S.H;
    const a = easeOut((S.tau - S.voidAt) / 500);
    g.save(); g.globalAlpha = 0.55 * a; g.fillStyle = "#07090c"; g.fillRect(0, S.hh, W, H - S.hh);
    g.globalAlpha = 0.18 * a; g.strokeStyle = C.amber; g.lineWidth = S.u(8);
    g.beginPath(); for (let x = -H; x < W + H; x += S.u(46)) { g.moveTo(x, H); g.lineTo(x + H, S.hh); } g.stroke();
    g.restore();
    g.save(); g.globalAlpha = a;
    const cy = S.hh + (H - S.hh) / 2, bw = Math.min(W * 0.86, S.u(760)), bh = S.u(96);
    S.rr((W - bw) / 2, cy - bh / 2, bw, bh, S.u(6)); g.fillStyle = "rgba(13,18,23,.94)"; g.fill(); g.strokeStyle = C.amber; g.lineWidth = 2; g.shadowColor = C.amber; g.shadowBlur = 18; g.stroke(); g.shadowBlur = 0;
    const big = S.fit(tr("voidT"), S.fs(46), bw - S.u(30));
    S.txt(tr("voidT"), W / 2, cy - bh * 0.12, { s: big, c: C.amber, a: "center", glow: C.amber });
    S.txt(tr("voidS").toUpperCase(), W / 2, cy + bh * 0.26, { s: S.fit(tr("voidS").toUpperCase(), S.fs(20), bw - S.u(30), "m"), f: "m", c: C.text, a: "center", w: 800 });
    g.restore();
    S.shown.void = true;
    S.stamp(tr("voidT") + " · " + tr("voidS"), "neutral");
  }

  // сводка победивших рынков (в виде подписей) в нижней полосе
  function chipsRow(S, labels, y, color, alpha, cx, maxW) {
    if (!labels.length) return;
    cx = cx == null ? S.W / 2 : cx; maxW = maxW || S.W - S.u(20);
    const s = S.fs(12);
    let widths = labels.map((l) => S.measure(l, s, "m", 800) + s * 1.4 + S.u(8)), total = widths.reduce((a, b) => a + b, 0);
    let list = labels.slice();
    while (total > maxW && list.length > 1) { list.pop(); widths.pop(); total = widths.reduce((a, b) => a + b, 0); }
    let x = cx - total / 2;
    list.forEach((l, i) => { S.pill(l, x + widths[i] / 2 - S.u(4), y, { s, c: color, glow: true, alpha }); x += widths[i]; });
  }

  function mlabel(S, id) {
    try { if (BS && BS.marketLabel) return BS.marketLabel(S.type, id, { meta: S.meta, input: S.input }, lang()); } catch (e) { /* запасная подпись */ }
    return id;
  }
  function mkc(S, id) { const m = S.markets && S.markets.find((x) => x.id === id); return m ? m.kc : null; }

  // ====================================================================================================
  //   BTC: график цены
  // ====================================================================================================
  const btcDef = {
    clockOnData: true,
    reset(S) { S.pre = []; S.ticks = new Map(); S.s0 = null; S.full = null; S.yMax = null; S.flashAt = -1e9; S.wig = {}; S.lastTickK = -1; },
    hasHistory(S) { return S.s0 != null; },
    live(S, d) {
      if (d.kind === "s0") {
        if (S.s0 != null || S.synthetic) return;
        S.s0 = d.btc; S.clockStart = S.now(); S.ticks.set(0, 0); S.flashAt = S.now();
        S.snd("lock");
      } else if (d.kind === "price") {
        const p = d.btc; if (p == null) return;
        S.lastPrice = p;
        if (S.s0 == null) { S.pre.push({ t: S.now(), v: p }); if (S.pre.length > 80) S.pre.shift(); }
        else if (!S.synthetic) {
          const k = Math.round(((S.now() - S.clockStart) / S.f) / 1000);
          if (k >= 0 && k <= Math.round(S.wms / 1000)) { S.ticks.set(k, p - S.s0); S.lastTickK = Math.max(S.lastTickK, k); }
        }
      }
    },
    prepVoid(S) { },
    prep(S, tau0) {
      if (S.s0 == null) { S.s0 = S.input.s0 || 0; S.flashAt = S.now() - Math.max(0, S.tau); } // переподключение: S₀ неизвестна, график идёт в долларах от неё
      const n = Math.round(S.wms / 1000), sg = S.input.sigma || 1;
      const arr = new Array(n + 1).fill(NaN);
      S.ticks.forEach((v, k) => { if (k >= 0 && k <= n) arr[k] = v; });
      arr[0] = 0; arr[n] = S.outcome;
      const r = S.rng(11), z = []; for (let i = 0; i <= n; i++) z.push(gauss(r));
      S.full = bridgeFill(arr, sg / Math.sqrt(n), z);
    },
    arr(S) {
      if (S.full) return S.full;
      const n = Math.round(S.wms / 1000), arr = new Array(n + 1).fill(NaN);
      S.ticks.forEach((v, k) => { if (k >= 0 && k <= n) arr[k] = v; });
      return arr;
    },
    wiggle(S, i, f, sg, n) {
      let w = S.wig[i];
      if (!w) {
        const r = S.rng(500 + i), a = [0]; let c = 0;
        for (let j = 1; j <= 10; j++) { c += gauss(r) * Math.sqrt(0.1) * (sg / Math.sqrt(n)) * 0.55; a.push(c); }
        w = a.map((v, j) => v - (j / 10) * c); S.wig[i] = w;
      }
      const x = f * 10, j = Math.floor(x); return lerp(w[j], w[Math.min(10, j + 1)], x - j);
    },
    draw(S, tau) {
      const g = S.g, W = S.W, H = S.H, k = S.k, sg = S.input.sigma || 1;
      const n = Math.round(S.wms / 1000);
      const L = S.u(14), Rm = Math.min(S.u(170), W * 0.2), top = S.hh + S.u(16), bot = H - S.u(46);
      const x0 = L, x1 = W - Rm, ph = bot - top, cy = top + ph / 2;
      // --- до закрытия окна: бегущая цена ---
      if (S.s0 == null) {
        const pre = S.pre, now = S.now();
        S.txt(tr("pre"), W / 2, bot + S.u(24), { s: S.fs(11), f: "m", c: C.dim, a: "center", maxW: W - S.u(20) });
        if (pre.length > 1) {
          let lo = Infinity, hi = -Infinity; pre.forEach((p) => { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
          const pad = Math.max((hi - lo) * 0.2, sg * 0.3); lo -= pad; hi += pad;
          const sx = (t) => x0 + (1 - (now - t) / 40000) * (x1 - x0), sy = (v) => bot - (v - lo) / (hi - lo) * ph;
          g.strokeStyle = C.silver; g.lineWidth = Math.max(1.5, 2 * k); g.shadowColor = C.cyan; g.shadowBlur = 10; g.beginPath();
          pre.forEach((p, i) => { const x = sx(p.t), y = sy(p.v); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.shadowBlur = 0;
          const lp = pre[pre.length - 1];
          g.fillStyle = C.cyan; g.beginPath(); g.arc(sx(lp.t), sy(lp.v), S.u(4), 0, 6.3); g.fill();
          S.txt("$" + Math.round(lp.v).toLocaleString("en").replace(/,/g, " "), x1 + S.u(10), sy(lp.v), { s: S.fs(18), f: "m", c: "#fff" });
        }
        S.shown.phase = "pre";
        return;
      }
      // --- шкала ---
      const arr = this.arr(S), f = S.f, dataEnd = isFinite(S.dataEnd) ? S.dataEnd : S.wms;
      const reveal = S.played && !S.void && tau >= dataEnd;
      // голова линии (в секундах данных)
      let last = -1; for (let i = 0; i < arr.length; i++) if (!isNaN(arr[i])) last = i;
      let sHead = S.full ? clamp(tau / (1000 * f), 0, n) : clamp(tau / (1000 * f) - 0.7, 0, last);
      if (S.void) sHead = Math.min(sHead, last);
      let mx = 0; for (let i = 0; i <= Math.floor(sHead); i++) if (!isNaN(arr[i])) mx = Math.max(mx, Math.abs(arr[i]));
      const tgt = Math.max(2.4 * sg, 1.15 * mx);
      S.yMax = S.yMax == null ? tgt : lerp(S.yMax, tgt, 1 - Math.exp(-S.dt / 400));
      const Y = S.yMax, sy = (v) => cy - v / Y * (ph / 2), sx = (s) => x0 + clamp(s / n, 0, 1) * (x1 - x0);
      const zs = [0.5, 1, 1.5, 2];
      const dOf = (z) => Math.round(z * sg * 100) / 100 + 0.005;
      const curV = (() => { const i = Math.floor(sHead); const a = arr[i], b = arr[Math.min(i + 1, n)]; if (isNaN(a)) return 0; return isNaN(b) ? a : lerp(a, b, sHead - i); })();
      // достигнутые линии
      let mxUp = 0, mxDn = 0; for (let i = 0; i <= Math.floor(sHead); i++) if (!isNaN(arr[i])) { mxUp = Math.max(mxUp, arr[i]); mxDn = Math.min(mxDn, arr[i]); }
      mxUp = Math.max(mxUp, curV); mxDn = Math.min(mxDn, curV);
      const dFinal = S.outcome;
      const flashK = easeOut((S.now() - S.flashAt) / 700);
      // полосы
      g.save();
      g.beginPath(); g.rect(0, top - S.u(4), W, ph + S.u(8)); g.clip();
      const lineIds = [];
      zs.forEach((z) => {
        [1, -1].forEach((sd) => {
          const dd = dOf(z) * sd, y = sy(dd);
          const hit = sd > 0 ? mxUp > dd : mxDn < dd;
          const win = reveal && dFinal != null && (sd > 0 ? dFinal > dd : dFinal < dd);
          g.strokeStyle = win ? C.lime : hit ? C.amber : "rgba(125,140,147,.45)";
          g.lineWidth = win ? 2.2 * k : hit ? 1.6 * k : 1; g.setLineDash(win || hit ? [] : [S.u(5), S.u(5)]);
          if (win || hit) { g.shadowColor = win ? C.lime : C.amber; g.shadowBlur = 10; }
          g.globalAlpha = reveal && !win ? 0.5 : 1;
          g.beginPath(); g.moveTo(x0, y); g.lineTo(x1 + S.u(8), y); g.stroke();
          g.shadowBlur = 0; g.setLineDash([]); g.globalAlpha = 1;
          // подпись справа
          const idm = (sd > 0 ? "up:" : "down:") + z, kc = mkc(S, idm);
          const col = win ? C.lime : hit ? C.amber : C.dim;
          S.txt((sd > 0 ? "+" : "−") + fmt(z, 1) + "σ", x1 + S.u(12), y - (kc != null ? S.u(7) : 0), { s: S.fs(15), c: col, glow: win ? C.lime : null });
          S.txt(kc != null ? "×" + kcFmt(kc) : (sd > 0 ? "+$" : "−$") + fmt(dOf(z), 0), x1 + S.u(12), y + S.u(8), { s: S.fs(11), f: "m", c: col, alpha: 0.9 });
          if (win) S.txt("✓", W - S.u(10), y, { s: S.fs(16), f: "m", c: C.lime, a: "right" });
        });
      });
      // закраска между S0 и текущей ценой
      if (reveal && dFinal != null) {
        g.fillStyle = dFinal >= 0 ? "rgba(182,255,46,.10)" : "rgba(255,46,136,.10)";
        const yy = sy(dFinal); g.fillRect(x0, Math.min(cy, yy), x1 - x0, Math.abs(yy - cy));
      }
      // линия S0
      const wipe = clamp(flashK * 1.4, 0, 1);
      g.strokeStyle = C.lime; g.lineWidth = 2.2 * k; g.shadowColor = C.lime; g.shadowBlur = 14 + 20 * (1 - flashK);
      g.beginPath(); g.moveTo(x0, cy); g.lineTo(x0 + (x1 + S.u(8) - x0) * wipe, cy); g.stroke(); g.shadowBlur = 0;
      if (flashK < 1) { g.fillStyle = `rgba(182,255,46,${0.25 * (1 - flashK)})`; g.fillRect(0, cy - S.u(30) * (1 - flashK), W, S.u(60) * (1 - flashK)); }
      S.txt("S₀", x1 + S.u(12), cy, { s: S.fs(18), c: C.lime, glow: C.lime });
      // сама цена
      const pts = []; const stepS = 0.1;
      for (let s = 0; s <= sHead + 1e-6; s += stepS) {
        const i = Math.floor(s + 1e-9), a = arr[i], b = arr[Math.min(i + 1, n)];
        if (isNaN(a) || (isNaN(b) && s > i + 1e-9)) continue;
        let v = isNaN(b) ? a : lerp(a, b, s - i);
        if (!isNaN(b) && i < n) v += this.wiggle(S, i, s - i, sg, n);
        pts.push([sx(s), sy(v)]);
      }
      if (pts.length) {
        const lastp = pts[pts.length - 1], hv = curV;
        [[true, C.lime], [false, C.mag]].forEach(([up, col]) => {
          g.save(); g.beginPath(); if (up) g.rect(0, 0, W, cy); else g.rect(0, cy, W, H); g.clip();
          g.strokeStyle = col; g.lineWidth = 2.6 * k; g.lineJoin = "round"; g.shadowColor = col; g.shadowBlur = 12;
          g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke(); g.restore();
        });
        // голова
        const pulse = 0.5 + 0.5 * Math.sin(S.now() / 160);
        g.fillStyle = "#fff"; g.shadowColor = "#fff"; g.shadowBlur = 14;
        g.beginPath(); g.arc(lastp[0], lastp[1], S.u(4.5), 0, 6.3); g.fill(); g.shadowBlur = 0;
        if (!reveal) { g.strokeStyle = `rgba(255,255,255,${0.5 * (1 - pulse)})`; g.lineWidth = 1.5; g.beginPath(); g.arc(lastp[0], lastp[1], S.u(6 + 10 * pulse), 0, 6.3); g.stroke(); }
        // метка цены
        const lx = Math.min(lastp[0] + S.u(10), x1 - S.u(80));
        if (!reveal) S.pill(money(hv), lx + S.u(40), clamp(lastp[1] - S.u(18), top + S.u(10), bot - S.u(10)), { s: S.fs(12), c: hv >= 0 ? C.lime : C.mag, glow: true });
      }
      g.restore();
      // шкала времени
      const secLeft = Math.max(0, Math.ceil(n - tau / (1000 * f)));
      for (let s = 0; s <= n; s += 5) { S.txt(String(s), sx(s), bot + S.u(12), { s: S.fs(10), f: "m", c: C.dim, a: "center", w: 600 }); g.fillStyle = C.line; g.fillRect(sx(s), bot, 1, S.u(4)); }
      // большой обратный отсчёт
      const waiting = S.mode === "show" && tau >= S.wms;
      if (!reveal && !S.void) {
        const big = waiting ? "…" : String(secLeft);
        S.txt(big, x0 + (x1 - x0) * 0.5, top + ph * 0.5, { s: S.fs(150), c: "rgba(238,242,238,.06)", a: "center" });
      }
      // низ: σ и S0
      const sigTxt = "σ₂₀ = $" + fmt(sg, sg < 10 ? 2 : 1);
      if (!reveal || W > 700) S.txt(sigTxt + (S.s0 ? "   S₀ = $" + fmt(S.s0, 2) : ""), L, H - S.u(14), { s: S.fs(11), f: "m", c: C.dim, maxW: W * 0.35 });
      if (waiting) S.txt(tr("wait") + " " + ".".repeat(1 + Math.floor(S.now() / 400) % 3), W - S.u(12), H - S.u(14), { s: S.fs(12), f: "m", c: C.amber, a: "right" });
      S.shown.phase = reveal ? "reveal" : "run";
      S.shown.sHead = +sHead.toFixed(2);
      if (reveal && dFinal != null) {
        const wins = [];
        [0].concat(zs).forEach((z) => { const dd = dOf(z); if (dFinal > dd) wins.push("up:" + z); if (dFinal < -dd) wins.push("down:" + z); });
        S.shown.outcome = dFinal; S.shown.text = money(dFinal); S.shown.wins = wins;
        const a = easeOut((tau - dataEnd) / 600);
        chipsRow(S, wins.slice(0, 5).map((id) => mlabel(S, id)), H - S.u(14), C.lime, a);
        S.pill(money(dFinal), W / 2, top + S.u(14), { s: S.fs(20), c: dFinal >= 0 ? C.lime : C.mag, glow: true, alpha: a });
        S.stamp(money(dFinal) + " · " + (dFinal >= 0 ? "↑" : "↓"), "neutral");
      }
    },
  };

  // ====================================================================================================
  //   BTCETH: две монеты
  // ====================================================================================================
  const bethDef = {
    clockOnData: true,
    reset(S) { S.pre = []; S.tB = new Map(); S.tE = new Map(); S.s0 = null; S.fB = null; S.fE = null; S.flashAt = -1e9; S.yMax = null; S.wig = {}; S.lastLead = null; },
    hasHistory(S) { return S.s0 != null; },
    live(S, d) {
      if (d.kind === "s0") {
        if (S.s0 != null || S.synthetic) return;
        S.s0 = { btc: d.btc, eth: d.eth }; S.clockStart = S.now(); S.tB.set(0, 0); S.tE.set(0, 0); S.flashAt = S.now();
      } else if (d.kind === "price") {
        if (S.s0 == null) { S.pre.push({ t: S.now(), b: d.btc, e: d.eth }); if (S.pre.length > 80) S.pre.shift(); return; }
        if (S.synthetic) return;
        const k = Math.round(((S.now() - S.clockStart) / S.f) / 1000);
        if (k >= 0 && k <= Math.round(S.wms / 1000)) {
          if (d.btc != null) S.tB.set(k, d.btc / S.s0.btc - 1);
          if (d.eth != null && S.s0.eth) S.tE.set(k, d.eth / S.s0.eth - 1);
        }
      }
    },
    prepVoid() { },
    prep(S) {
      if (S.s0 == null) { S.s0 = { btc: 0, eth: 0 }; S.flashAt = S.now() - Math.max(0, S.tau); }
      const n = Math.round(S.wms / 1000), inp = S.input, sB = inp.sigB || 0.0005, sE = inp.sigE || 0.0007, rho = clamp(inp.rho == null ? 0.8 : inp.rho, -0.99, 0.99);
      const mk = (m) => { const a = new Array(n + 1).fill(NaN); m.forEach((v, k) => { if (k <= n) a[k] = v; }); a[0] = 0; return a; };
      const aB = mk(S.tB), aE = mk(S.tE);
      aB[n] = S.outcome.rB; aE[n] = S.outcome.rE;
      const r = S.rng(21), zB = [], zE = [];
      for (let i = 0; i <= n; i++) { const a = gauss(r), b = gauss(r); zB.push(a); zE.push(rho * a + Math.sqrt(1 - rho * rho) * b); }
      S.fB = bridgeFill(aB, sB / Math.sqrt(n), zB); S.fE = bridgeFill(aE, sE / Math.sqrt(n), zE);
    },
    arrs(S) {
      if (S.fB) return [S.fB, S.fE];
      const n = Math.round(S.wms / 1000), mk = (m) => { const a = new Array(n + 1).fill(NaN); m.forEach((v, k) => { if (k <= n) a[k] = v; }); return a; };
      return [mk(S.tB), mk(S.tE)];
    },
    draw(S, tau) {
      const g = S.g, W = S.W, H = S.H, k = S.k, inp = S.input;
      const sB = inp.sigB || 0.0005, sE = inp.sigE || 0.0007, rho = inp.rho == null ? 0.8 : inp.rho;
      const sd = inp.sd || Math.sqrt(sB * sB + sE * sE - 2 * rho * sB * sE);
      const n = Math.round(S.wms / 1000);
      const L = S.u(14), Rm = Math.min(S.u(150), W * 0.22), top = S.hh + S.u(14), meterH = S.u(54), bot = H - S.u(44) - meterH;
      const x0 = L, x1 = W - Rm, ph = bot - top, cy = top + ph / 2;
      const col = { B: C.amber, E: C.silver };
      if (S.s0 == null) {
        S.txt(tr("pre"), W / 2, H / 2, { s: S.fs(12), f: "m", c: C.dim, a: "center", maxW: W - S.u(30) });
        const p = S.pre[S.pre.length - 1];
        if (p) { S.txt("BTC $" + Math.round(p.b), W * 0.3, H / 2 - S.u(40), { s: S.fs(22), f: "m", c: col.B, a: "center" }); S.txt("ETH $" + fmt(p.e || 0, 1), W * 0.7, H / 2 - S.u(40), { s: S.fs(22), f: "m", c: col.E, a: "center" }); }
        S.shown.phase = "pre"; return;
      }
      const [aB, aE] = this.arrs(S), f = S.f, dataEnd = isFinite(S.dataEnd) ? S.dataEnd : S.wms;
      const reveal = S.played && !S.void && tau >= dataEnd;
      let last = -1; for (let i = 0; i < aB.length; i++) if (!isNaN(aB[i]) && !isNaN(aE[i])) last = i;
      let sHead = S.fB ? clamp(tau / (1000 * f), 0, n) : clamp(tau / (1000 * f) - 0.7, 0, last);
      if (S.void) sHead = Math.min(sHead, last);
      const val = (a, s) => { const i = Math.floor(s + 1e-9), x = a[i], y = a[Math.min(i + 1, n)]; if (isNaN(x)) return NaN; return isNaN(y) ? x : lerp(x, y, s - i); };
      let mx = 0; for (let i = 0; i <= Math.floor(sHead); i++) { if (!isNaN(aB[i])) mx = Math.max(mx, Math.abs(aB[i])); if (!isNaN(aE[i])) mx = Math.max(mx, Math.abs(aE[i])); }
      const tgt = Math.max(2.1 * Math.max(sB, sE), 1.15 * mx);
      S.yMax = S.yMax == null ? tgt : lerp(S.yMax, tgt, 1 - Math.exp(-S.dt / 400));
      const Y = S.yMax, sy = (v) => cy - v / Y * (ph / 2), sx = (s) => x0 + clamp(s / n, 0, 1) * (x1 - x0);
      // сетка в %
      const stepP = (() => { const raw = Y * 100 / 2; const p = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw * 0.9) || p * 10; })();
      for (let p = -Math.floor(Y * 100 / stepP) * stepP; p <= Y * 100 + 1e-9; p += stepP) {
        const y = sy(p / 100); if (y < top || y > bot) continue;
        g.strokeStyle = Math.abs(p) < 1e-9 ? C.lime : "rgba(125,140,147,.18)"; g.lineWidth = Math.abs(p) < 1e-9 ? 2 * k : 1;
        if (Math.abs(p) < 1e-9) { g.shadowColor = C.lime; g.shadowBlur = 10; }
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.shadowBlur = 0;
        S.txt((p > 0 ? "+" : p < 0 ? "−" : "") + fmt(Math.abs(p), stepP < 0.1 ? 3 : 2) + "%", x1 + S.u(6), y, { s: S.fs(10), f: "m", c: Math.abs(p) < 1e-9 ? C.lime : C.dim, w: 600 });
      }
      // линии
      const pts = { B: [], E: [] };
      for (let s = 0; s <= sHead + 1e-6; s += 0.1) { const vb = val(aB, s), ve = val(aE, s); if (isNaN(vb) || isNaN(ve)) continue; pts.B.push([sx(s), sy(vb), vb]); pts.E.push([sx(s), sy(ve), ve]); }
      if (pts.B.length > 1) {
        // заливка разрыва цветом лидера
        for (let i = 1; i < pts.B.length; i++) {
          const a = pts.B[i - 1], b = pts.B[i], ea = pts.E[i - 1], eb = pts.E[i];
          g.fillStyle = (b[2] - eb[2]) >= 0 ? "rgba(255,211,77,.13)" : "rgba(201,214,223,.13)";
          g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(eb[0], eb[1]); g.lineTo(ea[0], ea[1]); g.closePath(); g.fill();
        }
        ["E", "B"].forEach((key) => {
          g.strokeStyle = col[key]; g.lineWidth = 2.6 * k; g.lineJoin = "round"; g.shadowColor = col[key]; g.shadowBlur = 12;
          g.beginPath(); pts[key].forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke(); g.shadowBlur = 0;
        });
        const lb = pts.B[pts.B.length - 1], le = pts.E[pts.E.length - 1];
        [["B", lb, "BTC"], ["E", le, "ETH"]].forEach(([key, p, name]) => {
          g.fillStyle = col[key]; g.shadowColor = col[key]; g.shadowBlur = 12; g.beginPath(); g.arc(p[0], p[1], S.u(5), 0, 6.3); g.fill(); g.shadowBlur = 0;
          S.txt(name, Math.min(p[0] + S.u(10), W - S.u(70)), p[1] - (key === "B") * 0 + (key === (lb[2] >= le[2] ? "B" : "E") ? -S.u(10) : S.u(10)), { s: S.fs(14), c: col[key], glow: col[key], gb: 8 });
        });
        // разрыв и лидер
        const gap = (lb[2] - le[2]) / sd, ldr = gap >= 0 ? "B" : "E";
        const phase2 = Math.floor(tau / (2000 * f));
        const tp = (tau / (2000 * f)) % 1;
        const rv = reveal ? 1 : 0;
        const pop = reveal ? 1 : easeOut(tp / 0.25) * (1 - easeInOut((tp - 0.65) / 0.35));
        if (!reveal) { S.shown.leadTick = phase2; }
        if (S.lastLead !== ldr && S.lastLead != null && !reveal) S.emit("say", `<b>${ldr === "B" ? "BTC" : "ETH"}</b> ${tr("lead2").toLowerCase()}: ${sgn(Math.abs(gap), 2)}σ`);
        S.lastLead = ldr;
        const name = ldr === "B" ? "BTC" : "ETH";
        S.pill(`${tr("lead")}: ${name}  ${fmt(Math.abs(gap), 2)}σ_d`, (x0 + x1) / 2, top + S.u(14), { s: S.fs(13), c: col[ldr], glow: true, alpha: reveal ? 1 : 0.35 + 0.65 * pop });
        // измеритель разрыва
        const my = H - S.u(44) - meterH / 2 + S.u(4), mw = (x1 - x0), mxA = x0 + mw / 2;
        const gx = (z) => mxA + clamp(z, -2.4, 2.4) / 2.4 * (mw / 2);
        g.fillStyle = "rgba(13,18,23,.9)"; S.rr(x0, my - S.u(10), mw, S.u(20), S.u(10)); g.fill();
        [-1.5, -1, -0.5, 0, 0.5, 1, 1.5].forEach((z) => {
          const hit = z !== 0 && (z > 0 ? gap > z : gap < z);
          g.fillStyle = hit ? (z > 0 ? C.amber : C.silver) : C.line; g.fillRect(gx(z) - 1, my - S.u(14), 2, S.u(28));
          if (z !== 0) S.txt((z > 0 ? "+" : "−") + fmt(Math.abs(z), 1) + "σ", gx(z), my + S.u(25), { s: S.fs(9), f: "m", c: hit ? (z > 0 ? C.amber : C.silver) : C.dim, a: "center", w: 600 });
        });
        S.txt("ETH ◂", x0 + S.u(4), my - S.u(22), { s: S.fs(10), f: "m", c: C.silver, w: 800 });
        S.txt("▸ BTC", x1 - S.u(4), my - S.u(22), { s: S.fs(10), f: "m", c: C.amber, w: 800, a: "right" });
        g.fillStyle = col[ldr]; g.shadowColor = col[ldr]; g.shadowBlur = 12;
        g.beginPath(); g.arc(gx(gap), my, S.u(7), 0, 6.3); g.fill(); g.shadowBlur = 0;
        S.txt(`${tr("gap")} ${sgn(gap, 2)}σ_d`, W - S.u(10), my, { s: S.fs(13), f: "m", c: col[ldr], a: "right", w: 800 });
        S.shown.gap = +gap.toFixed(3);
        // таблица справа
        S.txt(sgn(lb[2] * 100, 3) + "%", W - S.u(10), top + S.u(44), { s: S.fs(15), f: "m", c: col.B, a: "right" });
        S.txt(sgn(le[2] * 100, 3) + "%", W - S.u(10), top + S.u(64), { s: S.fs(15), f: "m", c: col.E, a: "right" });
      }
      const waiting = S.mode === "show" && tau >= S.wms;
      if (waiting) S.txt(tr("wait") + " " + ".".repeat(1 + Math.floor(S.now() / 400) % 3), x0, H - S.u(12), { s: S.fs(12), f: "m", c: C.amber });
      else if (!reveal) S.txt("σ_B " + fmt(sB * 100, 3) + "%  σ_E " + fmt(sE * 100, 3) + "%  ρ " + fmt(rho, 2), x0, H - S.u(12), { s: S.fs(10), f: "m", c: C.dim, maxW: W * 0.7 });
      S.shown.phase = reveal ? "reveal" : "run";
      if (reveal && S.outcome) {
        const o = S.outcome, gapF = (o.rB - o.rE) / sd;
        const wins = [];
        if (o.rB > 0 && o.rE > 0) wins.push("bothUp"); if (o.rB < 0 && o.rE < 0) wins.push("bothDown"); if (o.rB * o.rE < 0) wins.push("mixed");
        wins.push(o.rB - o.rE > 0 ? "btcBeats" : "ethBeats");
        [0.5, 1, 1.5].forEach((z) => { if (gapF > z) wins.push("btcGap:" + z); if (-gapF > z) wins.push("ethGap:" + z); });
        S.shown.outcome = o; S.shown.wins = wins; S.shown.gapSigma = +gapF.toFixed(3);
        S.shown.text = `BTC ${sgn(o.rB * 100, 3)}% · ETH ${sgn(o.rE * 100, 3)}%`;
        const a = easeOut((tau - dataEnd) / 600);
        chipsRow(S, wins.map((id) => mlabel(S, id)), H - S.u(10), C.lime, a);
        S.stamp(S.shown.text, "neutral");
      }
    },
  };

  // ====================================================================================================
  //   ДУЭЛЬ СЧЁТЧИКОВ (emoji, wikiduel, lightning, airport)
  // ====================================================================================================
  const DUEL_POOL = {
    emoji: ["ахах", "лол 😂", "ну всё", "кот!", "wow", "ничего себе", "спасибо ❤️", "сегодня ок", "доброе утро", "gm"],
    wikiduel: ["Москва", "Berlin", "Chess", "Луна", "Paris", "Python", "Эйнштейн", "Jazz", "Alps", "Баскетбол", "Tokyo", "Opera"],
    lightning: ["34.1°N 98.2°W", "12.4°S 51.0°W", "29.8°N 95.1°W", "4.2°N 74.0°W", "−8.1° 63.5°", "40.2°N 88.0°W"],
    airport: ["BA 283", "LH 401", "AF 1480", "KL 1002", "EZY 12", "SU 2578", "TK 1983"],
  };
  const duelDef = {
    startOnShow: true,
    reset(S) { S.samples = []; S.items = []; S.ex = null; S.chipsSynth = []; S.scale = 8; S.bump = [-1e9, -1e9]; S.leadSign = 0; S.leadAt = -1e9; S.leadSays = 0; S.disp = [0, 0]; S.base = [0, 0]; S.tau0 = 0; },
    hasHistory(S) { return S.samples.length > 0; },
    live(S, d) {
      if (S.synthetic) return;
      const tau = S.clockStart == null ? 0 : S.now() - S.clockStart;
      if (d.kind === "count") { const a = d.a | 0, b = d.b | 0; S.samples.push({ tau, a, b }); }
      else if (d.kind === "item" && d.side) S.items.push({ tau, side: d.side === "b" || d.side === "B" ? 1 : 0, text: String(d.text == null ? "" : d.text) });
    },
    prepVoid() { },
    prep(S, tau0) {
      const out = S.outcome || { nA: 0, nB: 0 };
      const lastS = S.samples.length ? S.samples[S.samples.length - 1] : { tau: 0, a: 0, b: 0 };
      S.tau0 = S.synthetic || !S.samples.length ? 0 : lastS.tau;
      S.base = [S.synthetic ? 0 : lastS.a, S.synthetic ? 0 : lastS.b];
      if (S.synthetic) { S.samples = []; S.items = []; }
      const t0 = S.tau0, t1 = S.dataEnd, r = S.rng(31);
      const gen = (side, n) => {
        const arr = [], bc = [r(), r(), r()];
        for (let i = 0; i < n; i++) {
          let x = r() < 0.28 ? clamp(bc[Math.floor(r() * 3)] + gauss(r) * 0.04, 0, 0.999) : 1 - Math.pow(1 - r(), 1.35);
          arr.push(t0 + x * (t1 - t0) * 0.995);
        }
        return arr.sort((a, b) => a - b);
      };
      const nA = Math.max(0, (out.nA | 0) - S.base[0]), nB = Math.max(0, (out.nB | 0) - S.base[1]);
      S.ex = [gen(0, nA), gen(1, nB)];
      // примеры элементов: каждое третье событие (если нет реальных)
      const pool = DUEL_POOL[S.type] || DUEL_POOL.emoji, lb = (S.meta && S.meta.labels) || {};
      S.chipsSynth = [];
      [0, 1].forEach((side) => S.ex[side].forEach((t, i) => { if (i % 3 === 0) S.chipsSynth.push({ tau: t - 650, side, text: S.type === "emoji" ? (lb[side ? "B" : "A"] || pool[0]) : pool[Math.floor(r() * pool.length)] }); }));
    },
    // счёт в момент τ (для show — по последнему образцу, для play — реальные образцы до tau0 + синтетика)
    countsAt(S, tau) {
      let a = 0, b = 0;
      const sm = S.samples;
      if (sm.length) { let lo = 0, hi = sm.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (sm[m].tau <= tau) { idx = m; lo = m + 1; } else hi = m - 1; } if (idx >= 0) { a = sm[idx].a; b = sm[idx].b; } }
      if (S.ex) {
        const cnt = (arr) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= tau) lo = m + 1; else hi = m; } return lo; };
        if (tau >= S.tau0 || !sm.length) { a = Math.max(a, S.base[0]) + cnt(S.ex[0]); b = Math.max(b, S.base[1]) + cnt(S.ex[1]); }
      }
      return [a, b];
    },
    draw(S, tau) {
      const g = S.g, W = S.W, H = S.H, k = S.k;
      const dataEnd = isFinite(S.dataEnd) ? S.dataEnd : S.wms;
      const reveal = S.played && !S.void && tau >= dataEnd;
      let [a, b] = this.countsAt(S, tau);
      if (reveal && S.outcome) { a = S.outcome.nA; b = S.outcome.nB; }
      // плавные значения
      const sm = (i, v) => { const cur = S.disp[i]; S.disp[i] = Math.abs(v - cur) < 0.05 ? v : lerp(cur, v, 1 - Math.exp(-S.dt / (reveal ? 60 : 110))); return S.disp[i]; };
      const prev = [S.disp[0], S.disp[1]];
      const dA = sm(0, a), dB = sm(1, b);
      [a, b].forEach((v, i) => { const jump = v - Math.round(prev[i]); if (jump >= Math.max(2, S.scale * 0.05)) S.bump[i] = S.now(); });
      const peak = Math.max(a, b, 4);
      const tgtScale = Math.max(8, Math.ceil(peak * 1.25));
      S.scale = S.scale < tgtScale ? lerp(S.scale, tgtScale, 1 - Math.exp(-S.dt / 250)) : S.scale;
      const top = S.hh + S.u(46), base = H - S.u(78), bh = base - top;
      const cxs = [W * (W < 500 ? 0.26 : 0.3), W * (W < 500 ? 0.74 : 0.7)], bw = Math.min(W * 0.2, S.u(150));
      const cols = [C.lime, C.mag], lb = (S.meta && S.meta.labels) || {}, names = [lb.A || "A", lb.B || "B"];
      const vals = [dA, dB], ints = [a, b];
      const rush = !reveal && S.mode !== "idle" && tau > dataEnd * 0.88 && tau <= dataEnd && S.clockStart != null && !S.void && S.mode === "play" ? 1 : 0;
      const winner = reveal ? (a > b ? 0 : b > a ? 1 : -1) : -2;
      // земля
      g.fillStyle = C.line; g.fillRect(W * 0.08, base, W * 0.84, 2);
      for (let i = 0; i < 2; i++) {
        const cx = cxs[i], h = clamp(vals[i] / S.scale, 0, 1) * bh, x = cx - bw / 2, y = base - h;
        const dim = reveal && winner !== -1 && winner !== i;
        const bumpK = 1 - clamp((S.now() - S.bump[i]) / 450, 0, 1);
        g.save();
        g.globalAlpha = dim ? 0.45 : 1;
        // тело
        const grad = g.createLinearGradient(0, y, 0, base);
        grad.addColorStop(0, cols[i]); grad.addColorStop(1, i ? "#6b0f38" : "#46701a");
        g.shadowColor = cols[i]; g.shadowBlur = 10 + 26 * bumpK + (reveal && winner === i ? 18 : 0);
        if (S.scale <= 30) { // блоки
          const unit = bh / S.scale, gap = Math.max(1.5, S.u(2));
          for (let j = 0; j < Math.ceil(vals[i]); j++) {
            const fill = clamp(vals[i] - j, 0, 1), by = base - (j + 1) * unit + gap / 2;
            g.globalAlpha = (dim ? 0.45 : 1) * (0.35 + 0.65 * fill);
            g.fillStyle = cols[i]; g.fillRect(x, by + unit * (1 - fill), bw, Math.max(1, (unit - gap) * fill));
          }
        } else { g.fillStyle = grad; g.fillRect(x, y, bw, h); g.fillStyle = "rgba(255,255,255,.9)"; g.fillRect(x, y, bw, Math.max(2, S.u(3))); }
        g.restore();
        // число
        const numS = S.fs(54) * (1 + 0.12 * bumpK);
        S.txt(String(Math.round(vals[i])), cx, Math.max(top - S.u(6), y - S.u(26)), { s: numS, c: "#fff", a: "center", glow: cols[i], gb: 14, alpha: dim ? 0.5 : 1 });
        // подпись
        const nm = String(names[i]);
        const em = isEmoji(nm) && nm.length <= 4;
        if (em) S.txt(nm, cx, base + S.u(32), { s: S.fs(44), f: "m", a: "center", alpha: dim ? 0.5 : 1 });
        else S.txt(nm.toUpperCase(), cx, base + S.u(32), { s: S.fit(nm.toUpperCase(), S.fs(32), Math.min(W * 0.4, S.u(300))), c: cols[i], a: "center", glow: cols[i], gb: 8, maxW: W * 0.42, alpha: dim ? 0.55 : 1 });
        if (reveal && winner === i) S.txt("👑", cx, y - S.u(66) < top - S.u(30) ? top - S.u(30) : y - S.u(66), { s: S.fs(40), f: "m", a: "center" });
        // искры при всплеске
        if (bumpK > 0.02) {
          const r = mkRngLocal(S, 700 + i * 31 + Math.floor(S.bump[i] % 997));
          for (let p = 0; p < 7; p++) { const ang = -Math.PI / 2 + (r() - 0.5) * 2.2, d = (1 - bumpK) * S.u(60) * (0.5 + r()); g.fillStyle = cols[i]; g.globalAlpha = bumpK; g.fillRect(cx + Math.cos(ang) * d - 1, y + Math.sin(ang) * d - 1, 3, 3); }
          g.globalAlpha = 1;
        }
      }
      // летящие элементы потока
      const chips = S.items.concat(S.chipsSynth);
      let drawn = 0;
      for (let ci = chips.length - 1; ci >= 0 && drawn < 14; ci--) {
        const c = chips[ci], p = (tau - c.tau) / 700;
        if (p < 0 || p > 1.3) continue;
        // элемент влетает в столбик сбоку (снаружи), чтобы не закрывать счёт
        const hj = hash32(ci, 7) % 1000 / 1000, side = c.side ? 1 : -1;
        const barTop = base - clamp(vals[c.side] / S.scale, 0, 1) * bh;
        const y = clamp(barTop + S.u(16) + hj * Math.min(base - barTop - S.u(24), S.u(110)), top, base - S.u(14));
        const x = cxs[c.side] + side * lerp(bw * 0.5 + S.u(190), bw * 0.5 + S.u(6), easeInOut(Math.min(1, p)));
        S.txt(c.text, x, y, { s: S.fs(12), f: "m", c: cols[c.side], a: c.side ? "left" : "right", alpha: (1 - clamp((p - 0.85) / 0.4, 0, 1)) * clamp(p * 5, 0, 1), maxW: S.u(170), w: 700 });
        drawn++;
      }
      // центр: VS и отсчёт
      const cxm = W / 2, remain = Math.max(0, Math.ceil((dataEnd - tau) / 1000 * (S.wms / dataEnd)));
      S.txt("VS", cxm, top + bh * 0.42, { s: S.fs(40), c: "rgba(238,242,238,.25)", a: "center" });
      const waiting = S.mode === "show" && S.clockStart != null && tau >= S.wms;
      if (!reveal) S.txt(waiting ? "…" : String(remain), cxm, top + bh * 0.42 + S.u(46), { s: S.fs(30), f: "m", c: waiting ? C.amber : C.cyan, a: "center", glow: C.cyan, gb: 8 });
      // смена лидера
      const sg = Math.sign(a - b);
      if (sg !== S.leadSign && a + b >= 6 && S.leadSign !== 0 && sg !== 0 && !reveal && S.now() - S.leadAt > 2500 && S.leadSays < 4) {
        S.leadAt = S.now(); S.leadSays++; S.emit("say", `${tr("lead2")}: <b>${names[sg > 0 ? 0 : 1]}</b> ${a}:${b}`);
      }
      if (sg !== 0) S.leadSign = sg;
      // финальный рывок
      if (rush) {
        const pu = 0.5 + 0.5 * Math.sin(S.now() / 90);
        g.fillStyle = `rgba(255,46,136,${0.05 + 0.06 * pu})`; g.fillRect(0, S.hh, W, H - S.hh);
        S.pill(tr("rush"), cxm, top - S.u(14) + S.hh * 0, { s: S.fs(13), c: C.mag, glow: true, alpha: 0.6 + 0.4 * pu });
      }
      // подвал
      if (waiting) S.txt(tr("wait") + " " + ".".repeat(1 + Math.floor(S.now() / 400) % 3), cxm, H - S.u(12), { s: S.fs(12), f: "m", c: C.amber, a: "center" });
      else if (!reveal) S.txt(`${tr("events")}: ${a + b}`, cxm, H - S.u(12), { s: S.fs(11), f: "m", c: C.dim, a: "center" });
      S.shown.phase = reveal ? "reveal" : "run"; S.shown.counts = [Math.round(a), Math.round(b)];
      if (reveal) {
        const txt = winner === -1 ? `${tr("tie")} ${a}:${b}` : `${names[winner]} ${tr("wins")} ${a}:${b}`;
        const col = winner === -1 ? C.amber : cols[winner], pa = easeOut((tau - dataEnd) / 500);
        S.pill(txt, cxm, H - S.u(14), { s: S.fs(15), c: col, glow: true, alpha: pa });
        S.shown.outcome = { nA: a, nB: b }; S.shown.text = txt; S.shown.winner = winner === -1 ? "tie" : winner === 0 ? "A" : "B";
        if (winner === -1) S.txt(tr("tie"), cxm, top + bh * 0.2, { s: S.fs(60), c: C.amber, a: "center", glow: C.amber, alpha: pa });
        S.stamp(txt, "neutral");
      }
    },
  };
  function mkRngLocal(S, salt) { return S.rng(salt); }

  // ====================================================================================================
  //   ПОРОГИ (wikiedit, whales)
  // ====================================================================================================
  const THR_POOL = {
    wikiedit: ["Москва", "Кот", "Chess", "Футбол", "Berlin", "Война", "Пушкин", "Moon", "Сочи", "Jazz", "Eurovision", "Банан"],
    whales: ["0.8 BTC", "3.1 BTC", "12 BTC", "0.2 BTC", "1.7 BTC", "27 BTC", "0.04 BTC"],
  };
  const thrDef = {
    startOnShow: true,
    reset(S) { S.items = []; S.synth = []; S.cnt = {}; S.firstId = null; S.rowFlash = {}; S.maxAmt = 1; },
    hasHistory(S) { return S.items.length > 0; },
    ids(S) {
      const lb = (S.meta && S.meta.labels) || {};
      let ids = Object.keys(lb).filter((x) => x !== "other");
      if (S.input && S.input.kinds) S.input.kinds.forEach((kd) => { if (!ids.includes(kd.id)) ids.push(kd.id); });
      return ids.slice(0, 8);
    },
    // какие рынки задел элемент: it.ids (массив) | it.id | it.kind | подстрока метки в тексте
    match(S, it) {
      const ids = this.ids(S), out = [];
      [].concat(it.ids || [], it.id != null ? [it.id] : [], it.kind != null ? [it.kind] : []).forEach((x) => { x = String(x); if (ids.includes(x) && !out.includes(x)) out.push(x); });
      if (out.length) return out;
      const low = String(it.text || "").toLowerCase();
      for (const id of ids) { const l = String(S.lbl(id)).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim(); if (l && low.includes(l)) out.push(id); }
      return out;
    },
    live(S, d) {
      if (d.kind !== "item" || d.side != null || S.synthetic) return;
      const tau = S.clockStart == null ? 0 : S.now() - S.clockStart;
      const it = { tau, id: d.id, text: String(d.text == null ? "" : d.text), amount: d.amount };
      it.ms = this.match(S, it); it.m = it.ms[0] || null;
      it.ms.forEach((m) => { S.cnt[m] = (S.cnt[m] || 0) + 1; if (S.firstId == null) S.firstId = m; S.rowFlash[m] = S.now(); });
      if (it.amount) S.maxAmt = Math.max(S.maxAmt, it.amount);
      S.items.push(it);
      if (S.items.length > 400) S.items.shift();
    },
    prepVoid() { },
    prep(S, tau0) {
      const out = S.outcome || {}, ids = this.ids(S), r = S.rng(41);
      if (S.synthetic) { S.items = []; S.cnt = {}; S.firstId = null; }
      const t0 = S.synthetic ? 0 : tau0, t1 = S.dataEnd * 0.97, pool = THR_POOL[S.type] || THR_POOL.wikiedit;
      const list = [];
      ids.forEach((id) => {
        const need = Math.max(0, (out[id] | 0) - (S.cnt[id] || 0));
        for (let i = 0; i < need; i++) list.push({ id, tau: t0 + (0.04 + 0.9 * r()) * (t1 - t0) });
      });
      // «первым» — выставленный сервером победитель гонки
      if (out.first && ids.includes(out.first) && S.firstId == null) {
        const mine = list.filter((x) => x.id === out.first).sort((a, b) => a.tau - b.tau);
        if (mine.length) { const others = list.filter((x) => x.id !== out.first); const fo = others.length ? Math.min.apply(null, others.map((x) => x.tau)) : t1; mine[0].tau = Math.max(t0 + 0.02 * (t1 - t0), Math.min(mine[0].tau, fo - 0.05 * (t1 - t0))); }
      }
      const filler = Math.round(2 + list.length * 2 + r() * 4);
      for (let i = 0; i < filler; i++) list.push({ id: null, tau: t0 + r() * (t1 - t0) });
      list.sort((a, b) => a.tau - b.tau);
      list.forEach((e, i) => {
        const lbl = e.id ? String(S.lbl(e.id)) : null;
        let text = e.id ? (S.type === "wikiedit" ? lbl : lbl) : pool[Math.floor(r() * pool.length)];
        let amount;
        if (S.type === "whales") amount = e.id ? 30 + r() * 400 : Math.exp(r() * Math.log(20)) * 0.6;
        S.synth.push({ tau: e.tau, id: e.id, text, amount, m: e.id, ms: e.id ? [e.id] : [], syn: true });
      });
      S.items = S.items.concat(S.synth);
      S.maxAmt = Math.max(S.maxAmt, ...S.items.map((x) => x.amount || 0));
      S.synthCounts = out;
    },
    draw(S, tau) {
      const g = S.g, W = S.W, H = S.H, k = S.k, out = S.outcome;
      const dataEnd = isFinite(S.dataEnd) ? S.dataEnd : S.wms;
      const reveal = S.played && !S.void && tau >= dataEnd;
      const ids = this.ids(S), n = Math.max(1, ids.length);
      const narrow = W < 520;
      const lw = narrow ? W * 0.38 : Math.min(W * 0.34, S.u(430));
      const top = S.hh + S.u(10), bot = H - S.u(40), rowH = Math.min(S.u(58), (bot - top) / n);
      // счётчики по τ
      const cnt = {}; let tot = 0, hit = 0, firstNow = null;
      S.items.forEach((it) => { if (it.tau <= tau) { tot++; if (it.m) { hit++; it.ms.forEach((m) => { cnt[m] = (cnt[m] || 0) + 1; }); if (firstNow == null) firstNow = it.m; } } });
      // лента (правая часть)
      const lx = lw + S.u(18), rx = W - S.u(12), laneW = rx - lx, poolY = bot - S.u(6);
      g.fillStyle = "rgba(13,18,23,.7)"; S.rr(lx - S.u(6), top, laneW + S.u(12), bot - top + S.u(4), S.u(6)); g.fill();
      g.strokeStyle = C.line; g.stroke();
      // пул внизу
      const wave = (x) => Math.sin(x * 0.02 + S.now() / 400) * S.u(2.5);
      g.fillStyle = "rgba(182,255,46,.10)"; g.beginPath(); g.moveTo(lx, bot); for (let x = lx; x <= rx; x += 8) g.lineTo(x, poolY - S.u(8) + wave(x)); g.lineTo(rx, bot); g.closePath(); g.fill();
      g.strokeStyle = "rgba(182,255,46,.5)"; g.lineWidth = 1.5; g.beginPath(); for (let x = lx; x <= rx; x += 8) { const y = poolY - S.u(8) + wave(x); x === lx ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke();
      S.txt(S.type === "whales" ? "MEMPOOL" : "RECENT CHANGES", lx + S.u(6), bot - S.u(3), { s: S.fs(10), f: "m", c: C.lime, alpha: 0.7, w: 700 });
      const fall = 2600; let shownN = 0;
      g.save(); g.beginPath(); g.rect(lx - S.u(4), top, laneW + S.u(8), bot - top); g.clip();
      for (let i = S.items.length - 1; i >= 0 && shownN < 40; i--) {
        const it = S.items[i], p = (tau - it.tau) / fall;
        if (p < 0 || p > 1.5) continue;
        shownN++;
        const rnd = hash32(i + 1, strHash(String(it.text)) ^ 0x51), xr = (Math.floor((rnd % 1000) / 1000 * 7) + 0.15 + (rnd >>> 10) % 70 / 100) / 7.9;
        const whale = S.type === "whales" && it.amount;
        const rad = whale ? S.u(7 + 26 * Math.sqrt(it.amount / Math.max(S.maxAmt, 1))) : 0;
        const pw = whale ? rad * 2 : 0;
        const cx = lx + S.u(16) + rad + xr * (laneW - S.u(32) - pw - 90 * k * !whale);
        const y = lerp(top + S.u(8), poolY - S.u(14) - rad, Math.min(1, p) * Math.min(1, p));
        const col = it.m ? C.lime : C.dim;
        if (whale) {
          g.globalAlpha = p > 1 ? clamp(1.5 - p, 0, 1) * 2 : 1;
          g.fillStyle = it.m ? "rgba(182,255,46,.22)" : "rgba(125,140,147,.14)"; g.strokeStyle = col; g.lineWidth = 1.5 * k; if (it.m) { g.shadowColor = C.lime; g.shadowBlur = 14; }
          g.beginPath(); g.arc(cx, y, rad, 0, 6.3); g.fill(); g.stroke(); g.shadowBlur = 0;
          if (rad > S.u(13)) S.txt(fmt(it.amount, it.amount < 10 ? 1 : 0), cx, y, { s: Math.max(S.fs(9), rad * 0.62), f: "m", c: it.m ? "#fff" : C.dim, a: "center", w: 800 });
          if (p >= 1 && p < 1.4 && rad > S.u(16)) { g.strokeStyle = `rgba(182,255,46,${0.8 - (p - 1) * 2})`; g.beginPath(); g.arc(cx, poolY - S.u(8), rad * (1 + (p - 1) * 4), Math.PI, 0); g.stroke(); }
        } else {
          g.globalAlpha = p > 1 ? clamp(1.5 - p, 0, 1) * 2 : 1;
          const ps = S.fs(12), tw = Math.min(S.measure(it.text, ps, "m", 700) + ps, laneW * 0.6);
          S.rr(cx - 4, y - ps, tw, ps * 2, ps); g.fillStyle = it.m ? "rgba(182,255,46,.16)" : "rgba(13,18,23,.85)"; g.fill(); g.strokeStyle = it.m ? C.lime : "rgba(125,140,147,.4)"; g.lineWidth = 1; if (it.m) { g.shadowColor = C.lime; g.shadowBlur = 10; } g.stroke(); g.shadowBlur = 0;
          S.txt(it.text, cx + ps / 2 - 4, y + 1, { s: ps, f: "m", c: it.m ? "#fff" : C.dim, maxW: laneW * 0.6 - ps });
        }
        g.globalAlpha = 1;
      }
      g.restore();
      // рынки слева
      const firstShown = reveal && out && out.first ? out.first : firstNow;
      ids.forEach((id, i) => {
        const y = top + i * rowH, h = rowH - S.u(6), n0 = reveal && out ? (out[id] | 0) : (cnt[id] || 0);
        const lit = n0 >= 1, flash = 1 - clamp((S.now() - (S.rowFlash[id] || -1e9)) / 600, 0, 1);
        const fl = S.synthetic || S.mode === "play" ? 0 : flash;
        S.rr(S.u(10), y, lw, h, S.u(6));
        g.fillStyle = lit ? `rgba(182,255,46,${0.14 + 0.2 * fl})` : "rgba(13,18,23,.92)"; g.fill();
        g.strokeStyle = lit ? C.lime : C.line; g.lineWidth = lit ? 1.6 : 1; if (lit) { g.shadowColor = C.lime; g.shadowBlur = 8 + 14 * fl; } g.stroke(); g.shadowBlur = 0;
        const label = String(S.lbl(id)), ls = S.fit(label, S.fs(19), lw - S.u(90));
        S.txt(label, S.u(22), y + h / 2, { s: ls, c: lit ? "#fff" : C.text, maxW: lw - S.u(90) });
        S.txt(String(n0), S.u(10) + lw - S.u(12), y + h / 2, { s: S.fs(26), f: "m", c: lit ? C.lime : C.dim, a: "right", w: 800 });
        if (firstShown === id) S.pill(tr("first"), S.u(10) + lw - S.u(66), y + S.u(2), { s: S.fs(9), c: C.amber, glow: true });
      });
      const waiting = S.mode === "show" && S.clockStart != null && tau >= S.wms;
      const remain = Math.max(0, Math.ceil((dataEnd - tau) / 1000 * (S.wms / dataEnd)));
      S.txt(`${tr("events")}: ${tot}  ·  ${tr("hit")}: ${hit}`, S.u(12), H - S.u(14), { s: S.fs(11), f: "m", c: C.dim });
      if (!reveal) S.txt(waiting ? tr("wait") + " " + ".".repeat(1 + Math.floor(S.now() / 400) % 3) : String(remain), W - S.u(14), H - S.u(14), { s: S.fs(waiting ? 12 : 20), f: "m", c: waiting ? C.amber : C.cyan, a: "right", glow: waiting ? null : C.cyan, gb: 6 });
      S.shown.phase = reveal ? "reveal" : "run"; S.shown.counts = {}; ids.forEach((id) => (S.shown.counts[id] = reveal && out ? (out[id] | 0) : (cnt[id] || 0)));
      if (reveal && out) {
        const winsL = ids.filter((id) => (out[id] | 0) >= 1);
        S.shown.outcome = out; S.shown.wins = winsL; S.shown.first = out.first || null;
        const txt = winsL.length ? winsL.map((id) => S.lbl(id) + (out[id] > 1 ? " ×" + out[id] : "")).join(" · ") : "—";
        S.shown.text = txt;
        const pa = easeOut((tau - dataEnd) / 500);
        chipsRow(S, winsL.map((id) => S.lbl(id) + (out[id] > 1 ? " ×" + out[id] : "")), bot - S.u(40), C.lime, pa, lx + laneW / 2, laneW - S.u(10));
        S.stamp(txt, "neutral");
      }
    },
  };

  // ====================================================================================================
  //   КАТЕГОРИИ: барабан (news, lang, wikinext)
  // ====================================================================================================
  const REEL_V0 = 1.5, REEL_VMAX = 13, REEL_TC = 3500;
  const reelPos = (t) => { t /= 1000; const tc = REEL_TC / 1000; return REEL_V0 * t + REEL_VMAX * (t - tc * (1 - Math.exp(-t / tc))); };
  const reelVel = (t) => REEL_V0 + REEL_VMAX * (1 - Math.exp(-t / REEL_TC));
  const reelDef = {
    startOnShow: true,
    reset(S) { S.reel = []; S.cells = new Map(); S.stopTau = null; S.land = null; S.lastItem = null; S.chosen = null; S.hit = {}; },
    hasHistory(S) { return S.reel.length > 0; },
    live(S, d) {
      if (S.synthetic) return;
      const tau = S.clockStart == null ? 0 : S.now() - S.clockStart;
      if (d.kind === "reel") { if (S.stopTau == null) { const it = { cat: String(d.cat), text: String(d.text == null ? "" : d.text) }; S.reel.push(it); S.lastItem = it; if (S.reel.length > 500) S.reel.shift(); } }
      else if (d.kind === "stop" && S.stopTau == null) { S.stopTau = tau; this.mkLand(S); }
    },
    cats(S) { const lb = (S.meta && S.meta.labels) || {}; const ids = Object.keys(lb); return ids.length ? ids : ["other"]; },
    mkLand(S) {
      const t = S.stopTau, s = reelPos(t), v = reelVel(t) , nominal = 5;
      const L = Math.ceil(s + v * v / (2 * nominal));
      const a = v * v / (2 * (L - s));
      S.land = { s, v, a, L, tb: v / a * 1000, t0: t };
      S.dataEnd = t + S.land.tb;
    },
    prepVoid(S) { },
    prep(S, tau0, D) {
      if (S.synthetic) { S.reel = []; S.lastItem = null; S.cells = new Map(); }
      if (S.stopTau == null) {
        if (S.synthetic) {
          // ищем момент стопа так, чтобы посадка барабана закончилась не позже D − 1,5 с
          let t = clamp(0.6 * D, 1500, Math.max(1500, D - 2500));
          for (; ; t -= 100) { S.stopTau = t; this.mkLand(S); if (t <= 1500 || t + S.land.tb <= D - 1500) break; }
        } else { S.stopTau = Math.max(tau0, 0); this.mkLand(S); }
      }
      S.dataEnd = S.land.t0 + S.land.tb;                       // момент посадки барабана — начало стоп-кадра
      S.end = Math.max(D || 0, S.dataEnd + (S.synthetic ? 1200 : 2200), S.synthetic ? 0 : tau0 + 3500);
    },
    cellAt(S, i) {
      if (S.land && i === S.land.L && S.outcome != null) {
        const li = S.lastItem;
        return { cat: String(S.outcome), text: li && li.cat === String(S.outcome) ? li.text : "", fin: true };
      }
      if (S.land && i === S.land.L && S.outcome == null && S.lastItem) return { cat: S.lastItem.cat, text: S.lastItem.text, fin: true };
      let c = S.cells.get(i);
      if (c) return c;
      const cats = this.cats(S);
      if (i >= 0 && i < S.reel.length && !(S.land && i >= S.land.L)) c = S.reel[i];
      else {
        const r = mkRngLocal(S, 900 + (i + 1000));
        if (S.reel.length && r() < 0.8) c = S.reel[Math.floor(r() * S.reel.length)];
        else { const cat = cats[Math.floor(r() * cats.length)]; c = { cat, text: "" }; }
      }
      if (S.cells.size > 400) S.cells.clear();
      S.cells.set(i, c); return c;
    },
    draw(S, tau) {
      const g = S.g, W = S.W, H = S.H, k = S.k;
      const cats = this.cats(S), lb = (S.meta && S.meta.labels) || {};
      const colOf = (cat) => CATCOL[Math.max(0, cats.indexOf(cat)) % CATCOL.length];
      // положение барабана
      let s, v, stopped = false;
      if (S.land && tau >= S.land.t0) {
        const t = Math.min((tau - S.land.t0) / 1000, S.land.tb / 1000);
        s = S.land.s + S.land.v * t - 0.5 * S.land.a * t * t; v = Math.max(0, S.land.v - S.land.a * t);
        stopped = tau >= S.land.t0 + S.land.tb;
        if (stopped) { s = S.land.L; v = 0; }
      } else { s = reelPos(tau); v = reelVel(tau); }
      const cw = W < 520 ? W * 0.36 : Math.min(W * 0.2, S.u(300)), ch = Math.min(S.u(170), (H - S.hh) * 0.4), cx0 = W / 2, cy = S.hh + (H - S.hh) * 0.43;
      // тень-желоб
      g.fillStyle = "rgba(13,18,23,.9)"; g.fillRect(0, cy - ch / 2 - S.u(14), W, ch + S.u(28));
      g.fillStyle = C.line; g.fillRect(0, cy - ch / 2 - S.u(14), W, 1); g.fillRect(0, cy + ch / 2 + S.u(14), W, 1);
      const first = Math.floor(s - W / cw / 2) - 1, lastI = Math.ceil(s + W / cw / 2) + 1;
      let centerCat = null, centerD = 9;
      const blur = clamp(v / 12, 0, 1);
      for (let i = first; i <= lastI; i++) {
        const c = this.cellAt(S, i), x = cx0 + (i - s) * cw, d = Math.abs(i - s);
        const col = colOf(c.cat), isC = d < 0.5;
        if (d < centerD) { centerD = d; centerCat = c; }
        const sc = 1 - 0.18 * clamp(d / 2, 0, 1), w = (cw - S.u(10)) * sc, h = ch * sc;
        g.save(); g.globalAlpha = (1 - 0.55 * clamp(d / 3, 0, 1)) * (1 - 0.35 * blur * (isC ? 0 : 1));
        S.rr(x - w / 2, cy - h / 2, w, h, S.u(8)); g.fillStyle = C.glass2; g.fill();
        g.strokeStyle = col; g.lineWidth = 1.5 * k; g.globalAlpha *= 0.8; g.stroke(); g.globalAlpha /= 0.8;
        g.fillStyle = col; g.globalAlpha *= 0.9; g.fillRect(x - w / 2 + S.u(10), cy - h / 2 + S.u(10), S.u(26), S.u(3)); g.globalAlpha /= 0.9;
        // метка и текст элемента
        const label = String(lb[c.cat] != null ? lb[c.cat] : c.cat);
        const ls = S.fit(label, S.fs(34) * sc, w - S.u(16));
        const em = isEmoji(label);
        S.txt(label.toUpperCase(), x, cy - h * (c.text ? 0.08 : 0), { s: ls, c: "#fff", a: "center", glow: col, gb: 8, maxW: w - S.u(12) });
        if (c.text) S.txt(c.text, x, cy + h * 0.32, { s: S.fs(10) * sc, f: "m", c: C.dim, a: "center", maxW: w - S.u(16), w: 600 });
        g.restore();
      }
      // рамка прицела
      const pulse = stopped ? 0.5 + 0.5 * Math.sin(S.now() / 200) : 0;
      const fw = cw + S.u(10), fh = ch + S.u(18);
      g.strokeStyle = C.lime; g.lineWidth = (2 + pulse) * k; g.shadowColor = C.lime; g.shadowBlur = stopped ? 22 + 10 * pulse : 12;
      S.rr(cx0 - fw / 2, cy - fh / 2, fw, fh, S.u(10)); g.stroke(); g.shadowBlur = 0;
      g.fillStyle = C.lime;
      g.beginPath(); g.moveTo(cx0 - S.u(9), cy - fh / 2 - S.u(16)); g.lineTo(cx0 + S.u(9), cy - fh / 2 - S.u(16)); g.lineTo(cx0, cy - fh / 2 - S.u(4)); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(cx0 - S.u(9), cy + fh / 2 + S.u(16)); g.lineTo(cx0 + S.u(9), cy + fh / 2 + S.u(16)); g.lineTo(cx0, cy + fh / 2 + S.u(4)); g.closePath(); g.fill();
      // левая/правая шторки
      [0, 1].forEach((side) => { const gr = g.createLinearGradient(side ? W : 0, 0, side ? W * 0.7 : W * 0.3, 0); gr.addColorStop(0, "rgba(7,9,12,.95)"); gr.addColorStop(1, "rgba(7,9,12,0)"); g.fillStyle = gr; g.fillRect(side ? W * 0.7 : 0, cy - ch / 2 - S.u(14), W * 0.3, ch + S.u(28)); });
      // легенда категорий
      const reveal = S.played && !S.void && stopped;
      const ly = H - S.u(52), chipS = S.fs(11);
      const rowsW = cats.map((c) => S.measure(String(lb[c] != null ? lb[c] : c), chipS, "m", 800) + chipS * 1.8);
      let rows = [[]], rw = 0; cats.forEach((c, i) => { if (rw + rowsW[i] > W - S.u(20) && rows[rows.length - 1].length) { rows.push([]); rw = 0; } rows[rows.length - 1].push(i); rw += rowsW[i] + S.u(6); });
      rows.slice(0, 3).forEach((row, ri) => {
        const tw = row.reduce((a, i) => a + rowsW[i] + S.u(6), -S.u(6)); let x = (W - tw) / 2;
        const y = ly + ri * chipS * 2.2 - (rows.length > 1 ? (rows.length - 1) * chipS * 1.1 : 0);
        row.forEach((i) => {
          const c = cats[i], on = centerCat && centerCat.cat === c, win = reveal && String(S.outcome) === c;
          S.pill(String(lb[c] != null ? lb[c] : c), x + rowsW[i] / 2, y, { s: chipS, c: win ? C.lime : on ? colOf(c) : "rgba(125,140,147,.5)", tc: win ? "#07090c" : on ? "#fff" : C.dim, bg: win ? C.lime : "rgba(13,18,23,.9)", glow: win || on, alpha: reveal && !win ? 0.4 : 1 });
          x += rowsW[i] + S.u(6);
        });
      });
      // статус
      const sp = S.stopTau != null && !stopped;
      if (!stopped) {
        S.txt(sp ? tr("stop") + "…" : tr("reel") + " " + ".".repeat(1 + Math.floor(S.now() / 400) % 3), W / 2, S.hh + S.u(24), { s: S.fs(sp ? 22 : 13), f: sp ? "d" : "m", c: sp ? C.mag : C.amber, a: "center", glow: sp ? C.mag : null });
        S.txt(`${S.reel.length} ${tr("events")}`, W - S.u(12), H - S.u(12), { s: S.fs(10), f: "m", c: C.dim, a: "right" });
      }
      S.shown.phase = reveal ? "reveal" : stopped ? "stopped" : "run";
      S.shown.centerCat = centerCat && centerCat.cat;
      if (reveal) {
        const o = String(S.outcome), lab = String(lb[o] != null ? lb[o] : o), pa = easeOut((tau - S.dataEnd) / 500);
        S.shown.outcome = o; S.shown.text = lab; S.shown.landedCat = centerCat && centerCat.cat;
        const kc = mkc(S, "cat:" + o);
        S.pill(lab + (kc != null ? "  ×" + kcFmt(kc) : ""), W / 2, S.hh + S.u(26), { s: S.fs(16), c: C.lime, glow: true, alpha: pa });
        S.stamp(lab, "neutral");
      }
    },
  };

  // ====================================================================================================
  //   DRAND: маяк
  // ====================================================================================================
  const CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
  const HEX = "0123456789abcdef";
  const drandDef = {
    startOnShow: true,
    reset(S) { S.rounds = []; S.pubTau = null; S.hex = null; S.roundN = null; S.link = null; },
    hasHistory(S) { return S.rounds.length > 0; },
    live(S, d) {
      if (d.kind !== "round" || S.synthetic) return;
      const tau = S.clockStart == null ? 0 : S.now() - S.clockStart;
      S.rounds.push({ tau, n: d.n }); S.roundN = d.n != null ? d.n : S.roundN;
      if (d.randomness && S.pubTau == null) { S.pubTau = tau; S.hex = String(d.randomness).toLowerCase(); S.snd("lock"); }
    },
    prepVoid() { },
    prep(S, tau0, D) {
      if (S.synthetic) { S.rounds = []; }
      const hex = String(S.outcome || "").toLowerCase();
      if (S.pubTau == null) S.pubTau = S.synthetic ? Math.max(3000, Math.floor(Math.max(0, D - 4600) / 3000) * 3000) : tau0;
      S.hex = hex;
      S.slotsT = 120; // шаг замирания слотов, мс
      S.dataEnd = S.pubTau + 16 * S.slotsT + 500;
      S.end = Math.max(S.D || D, S.dataEnd + 1500, tau0 + 3500);
    },
    pulses(S, tau) {
      const ts = S.rounds.length ? S.rounds.map((r) => r.tau) : [];
      for (let t = 3000; t < Math.max(tau, 3000) + 3000; t += 3000) if (!ts.some((x) => Math.abs(x - t) < 1200)) ts.push(t);
      return ts;
    },
    draw(S, tau) {
      const g = S.g, W = S.W, H = S.H, k = S.k;
      const narrow = W < 520;
      const bx = narrow ? W * 0.5 : W * 0.24, by = narrow ? S.hh + (H - S.hh) * 0.3 : H * 0.62;
      const published = S.pubTau != null && tau >= S.pubTau;
      // кольца пульса
      const pulses = this.pulses(S, tau);
      pulses.forEach((pt) => {
        const p = (tau - pt) / 1800; if (p < 0 || p > 1) return;
        g.strokeStyle = `rgba(182,255,46,${0.55 * (1 - p)})`; g.lineWidth = 2 * k * (1 - p) + 1;
        g.beginPath(); g.arc(bx, by - S.u(30), S.u(20) + p * S.u(narrow ? 120 : 200), 0, 6.3); g.stroke();
      });
      // луч
      const ang = (tau / 3000) * Math.PI * 2 - Math.PI / 2;
      const lr = S.u(narrow ? 140 : 260);
      const grd = g.createRadialGradient(bx, by - S.u(30), 0, bx, by - S.u(30), lr);
      grd.addColorStop(0, "rgba(182,255,46,.35)"); grd.addColorStop(1, "rgba(182,255,46,0)");
      g.fillStyle = grd; g.beginPath(); g.moveTo(bx, by - S.u(30)); g.arc(bx, by - S.u(30), lr, ang - 0.16, ang + 0.16); g.closePath(); g.fill();
      // башня
      const th = S.u(narrow ? 60 : 110), tw1 = S.u(narrow ? 16 : 26), tw2 = S.u(narrow ? 10 : 16);
      g.fillStyle = "#11171d"; g.strokeStyle = C.line; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(bx - tw1, by + th * 0.4); g.lineTo(bx - tw2, by - th * 0.4); g.lineTo(bx + tw2, by - th * 0.4); g.lineTo(bx + tw1, by + th * 0.4); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = C.mag; for (let i = 0; i < 3; i++) g.fillRect(bx - (tw1 + tw2) / 2 * 0.9 + 0, by + th * 0.4 - (i + 1) * th * 0.22, (tw1 + tw2) * 0.9, S.u(5));
      const flick = published ? 1 : 0.6 + 0.4 * Math.abs(Math.sin(tau / 300));
      g.fillStyle = C.lime; g.shadowColor = C.lime; g.shadowBlur = 24 * flick; g.beginPath(); g.arc(bx, by - S.u(30), S.u(narrow ? 9 : 14) , 0, 6.3); g.fill(); g.shadowBlur = 0;
      g.fillStyle = "#0a0d11"; g.fillRect(bx - tw1 * 1.6, by + th * 0.4, tw1 * 3.2, S.u(8));
      // раунд
      const nxt = pulses.filter((p) => p > tau).sort((a, b) => a - b)[0] || tau + 3000;
      const rn = S.roundN != null ? "#" + S.roundN : "";
      S.txt(`${tr("round")} ${rn}`.trim(), narrow ? W / 2 : bx, narrow ? S.hh + S.u(18) : by + th * 0.4 + S.u(34), { s: S.fs(20), c: "#fff", a: "center", glow: C.lime, gb: 8 });
      if (!published && S.mode !== "idle") S.txt(`${tr("next")} ${fmt(Math.max(0, (nxt - tau) / 1000), 1)} ${tr("sec")}`, narrow ? W / 2 : bx, narrow ? by + th * 0.4 + S.u(22) : by + th * 0.4 + S.u(56), { s: S.fs(11), f: "m", c: C.cyan, a: "center" });
      // слоты hex
      const nSl = narrow ? 8 : 16, areaL = narrow ? 0 : W * 0.42, areaW = narrow ? W : W * 0.58 - S.u(14);
      const sw = Math.min(S.u(52), (areaW * 0.94) / nSl), sh = sw * 1.5;
      const rowW = sw * nSl, sx0 = areaL + (areaW - rowW) / 2, rowCx = sx0 + rowW / 2, sy = narrow ? H * 0.6 : H * 0.4;
      const hex = S.hex || "";
      const tail = hex ? hex.slice(-nSl).padStart(nSl, "0") : "";
      const frozenAt = (i) => (S.pubTau == null ? Infinity : S.pubTau + i * (S.slotsT || 120) + 250);
      let allFrozen = true;
      for (let i = 0; i < nSl; i++) {
        const x = sx0 + i * sw, fa = frozenAt(i), frozen = tau >= fa && !!tail && !S.void;
        if (!frozen) allFrozen = false;
        const lastSlot = i === nSl - 1;
        const popK = frozen ? 1 - clamp((tau - fa) / 350, 0, 1) : 0;
        S.rr(x + 2, sy - sh / 2, sw - 4, sh, S.u(5));
        g.fillStyle = frozen ? (lastSlot ? "rgba(255,211,77,.18)" : "rgba(182,255,46,.1)") : "rgba(13,18,23,.95)"; g.fill();
        g.strokeStyle = frozen ? (lastSlot ? C.amber : C.lime) : C.line; g.lineWidth = frozen && lastSlot ? 2.2 * k : 1.2;
        if (frozen && popK > 0) { g.shadowColor = C.lime; g.shadowBlur = 16 * popK; } g.stroke(); g.shadowBlur = 0;
        const ch = frozen ? tail[i] : HEX[hash32(Math.floor(tau / 55) + i * 7, S.seed) % 16];
        S.txt(ch.toUpperCase(), x + sw / 2, sy + 1 - popK * S.u(4), { s: sw * 0.78, f: "m", c: frozen ? (lastSlot ? C.amber : "#fff") : "rgba(125,140,147,.55)", a: "center", w: 800, glow: frozen && lastSlot ? C.amber : null, gb: 14 });
        if (!frozen && !S.void) { g.fillStyle = "rgba(255,255,255,.04)"; g.fillRect(x + 4, sy - sh / 2 + 2, sw - 8, sh * 0.35); }
      }
      if (!tail) S.txt(tr("spin") + " " + ".".repeat(1 + Math.floor(S.now() / 400) % 3), sx0 + rowW / 2, sy + sh * 0.9, { s: S.fs(12), f: "m", c: C.amber, a: "center" });
      S.txt("…" + (hex.length > nSl ? hex.slice(-nSl - 0).slice(0, 0) : ""), sx0 - 2, sy, { s: S.fs(16), f: "m", c: C.dim, a: "right" });
      const reveal = S.played && !S.void && !!tail && allFrozen;
      S.shown.phase = reveal ? "reveal" : published ? "freezing" : "spin";
      // финальная цифра и свойства
      if (reveal) {
        const d = HEX.indexOf(tail[nSl - 1]), pa = easeOut((tau - frozenAt(nSl - 1)) / 450);
        const parity = d % 2 === 0 ? tr("even") : tr("odd"), kind = d < 10 ? tr("num") : tr("letter"), q = ["0–3", "4–7", "8–B", "C–F"][Math.floor(d / 4)];
        const yy = sy + sh * 0.5 + S.u(14);
        S.txt(tail[nSl - 1].toUpperCase(), rowCx, yy + S.u(narrow ? 24 : 52), { s: S.fs(narrow ? 70 : 100), c: C.amber, a: "center", glow: C.amber, alpha: pa });
        chipsRow(S, [parity, kind, q], yy + S.u(narrow ? 66 : 124), C.lime, pa, rowCx, areaW);
        S.shown.outcome = hex; S.shown.digit = tail[nSl - 1]; S.shown.text = tail.toUpperCase() + " → " + tail[nSl - 1].toUpperCase();
        S.shown.props = { parity, kind, quarter: q };
        S.stamp(`${tr("digit")}: ${tail[nSl - 1].toUpperCase()} · ${parity}`, "neutral");
      }
      // ссылка на проверку
      if (!S.linkEl && doc) {
        const a = doc.createElement("a"); a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "";
        a.style.cssText = "position:absolute;left:50%;transform:translateX(-50%);bottom:6px;color:" + C.cyan + ";font:700 11px " + MONO + ";text-decoration:underline;white-space:nowrap;max-width:96%;overflow:hidden;text-overflow:ellipsis;display:none;z-index:2";
        S.host.appendChild(a); S.linkEl = a;
      }
      if (S.linkEl) {
        const n = S.roundN, show = published && !S.void;
        S.linkEl.style.display = show ? "block" : "none";
        S.linkEl.style.fontSize = S.fs(11) + "px";
        if (show) {
          S.linkEl.href = "https://api.drand.sh/" + CHAIN + "/public/" + (n != null ? n : "latest");
          S.linkEl.textContent = tr("verify") + " ↗  drand.love · " + (n != null ? "#" + n : "quicknet");
        }
        S.shown.link = show ? S.linkEl.href : null;
      }
      if (!published && !S.void) S.txt("drand · quicknet · 3 s", W - S.u(12), H - S.u(12), { s: S.fs(10), f: "m", c: C.dim, a: "right" });
    },
    destroy(S) { if (S.linkEl && S.linkEl.parentNode) S.linkEl.parentNode.removeChild(S.linkEl); },
  };

  // ---------- регистрация ----------
  const DEFS = { btc: btcDef, btceth: bethDef, emoji: duelDef, wikiduel: duelDef, lightning: duelDef, airport: duelDef, wikiedit: thrDef, whales: thrDef, news: reelDef, lang: reelDef, wikinext: reelDef, drand: drandDef };
  function register() {
    const BSc = root.BetsScenes;
    if (!BSc || typeof BSc.register !== "function") return false;
    Object.keys(DEFS).forEach((type) => {
      const factory = (host, ctx) => newScene(type, DEFS[type], host, ctx);
      try { BSc.register([type], factory); } catch (e) { try { BSc.register(type, factory); } catch (e2) { /* ядро не приняло регистрацию */ } }
    });
    return true;
  }
  register();
  // для стенда и ручной отладки
  root.BetsScenesLive = { register, newScene, DEFS };
})(typeof window !== "undefined" ? window : globalThis);
