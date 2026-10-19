"use strict";

/*
 * «Ставки»: сцены событий для общего экрана (контракт — docs/bets-protocol.md §6).
 * Обычный скрипт (без модулей), экспортирует window.BetsScenes:
 *   BetsScenes.create(hostEl, {muted, sound}) → контроллер { show, play, live, on, setMuted, destroy }
 *   BetsScenes.register(types, factory)       → factory(host, ctx) → { show(o), play(o) → Promise, live(d), destroy() }
 *   ctx = { emit(name, ...args), muted(), sound, util }
 * Здесь: ядро (реестр, контроллер, цикл кадров, общие хелперы) и четыре 2D-сцены: dogs, rocket, penalties, rope.
 * Кубики (Three.js) живут в bets-scene-dice.js: ядро подгружает его через import() и регистрирует тип dice.
 *
 * Как устроено время (важно для детерминизма и переподключения):
 *   каждая сцена — «симуляция с фиксированным шагом» 1/60 с: sim.step(dt), sim.done(), sim.draw().
 *   Вся случайность — из mulberry32(seed), а размеры холста влияют только на draw(), не на step().
 *   Поэтому кадр в момент τ от старта зависит только от (seed, outcome, input, meta, τ).
 *   drive() заранее «прогоняет вхолостую» сцену, чтобы узнать её естественную длину, и ускоряет (не замедляет)
 *   ход времени так, чтобы сцена уложилась в durationMs; offsetMs перематывает симуляцию без показа эффектов.
 */
(function (root) {
  const BS = root.BetsScenes = root.BetsScenes || {};
  const DT = 1 / 60;
  const DISP = '"Big Shoulders Display", "Oswald", "Roboto Condensed", Impact, "Arial Narrow", sans-serif';
  // шрифты для canvas: у Big Shoulders нет кириллицы и греческого, догружаем запасные начертания заранее
  try { const d = root.document; if (d && d.fonts && d.fonts.load) { d.fonts.load('900 20px "Big Shoulders Display"'); d.fonts.load('900 20px "Oswald"', "Ж"); d.fonts.load('900 20px "Roboto Condensed"', "αβγ"); } } catch (e) { /* без шрифтов сработает запасной */ }
  const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
  const TAU = Math.PI * 2;

  // ---------- мелкие хелперы ----------
  function mulFallback(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  // BetsShared.mulberry32 подключается отдельным тегом; если его нет — идентичный запасной
  const mulberry32 = (seed) => ((root.BetsShared && root.BetsShared.mulberry32) || mulFallback)(seed | 0);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);
  // ---------- язык: читается на лету (document.documentElement.lang ставит i18n.js) ----------
  const STR = {
    ru: {
      loading: "СЦЕНА ЗАГРУЖАЕТСЯ…", m: "м", sec: "с",
      dStart: "Собаки на старте. <em>Ставки закрыты.</em>", dPhoto: "ФОТОФИНИШ", dPhotoSay: "Фотофиниш! <em>Нос к носу</em>…", dFin: "ФИНИШ!",
      dFinSay: "Финиш! Побеждает <em>№{n} {name}</em>", dWin: "Победил <em>№{n} {name}</em> — на {gap} с",
      dLead: "<em>№{n} {name}</em> выходит вперёд!", dGap: "<em>№{n} {name}</em> отрывается на {gap} м", dTight: "Идут <em>нос к носу</em>!",
      dGo: "Ловушки открыты — <em>забег пошёл!</em>", d100: "Сто метров до финиша. Впереди <em>№{n} {name}</em>", dPh2: "Двое рядом… <em>решит фотофиниш!</em>",
      dBoard: "ТОТАЛИЗАТОР · БЕГА", dStartL: "СТАРТ", dFinL: "ФИНИШ", dFinPhoto: "ФИНИШ · ФОТО", dGoBig: "ГО!",
      rStart: "Ракета на старте. <em>Ставки закрыты.</em>", rCrash0: "ВЗРЫВ НА СТАРТЕ", rCrash: "ВЗРЫВ", rSay0: "Ракета взорвалась <em>на старте</em>!",
      rSay: "Взрыв на <em>{x}</em>.", rSayN: " Долетели {w} из {n}", player: "Игрок", rReach: "<em>{name}</em> долетел до {x}!",
      r1: "Ракета набирает высоту… <em>держитесь!</em>", r4: "Уже <em>{x}</em> — остались самые смелые", r10: "Десятикратный! <em>Это уже безумие.</em>",
      rLaunch: "ПУСК", rOk: "долетели {ok} из {n}",
      pStart: "Серия пенальти. <em>Ставки закрыты.</em>", teamA: "Лаймы", teamB: "Маджента", pKickSd: "До первой ошибки: бьёт <em>{man}</em>", pKick: "Бьёт <em>{man}</em>, {team}",
      pWin: "ПОБЕДА: {team}", pEnd: "Серия окончена: <em>{team}</em> {a}:{b}", pEndSd: ", решили {n} пар до первой ошибки",
      pGoal: "ГОЛ!", pGoalSay: "<em>ГОЛ!</em> {man} забивает", pSave: "СЕЙВ!", pSaveSay: "<em>Сейв!</em> Вратарь вытаскивает мяч",
      pBar: "ПЕРЕКЛАДИНА!", pPost: "ШТАНГА!", pBarW: "Перекладина", pPostW: "Штанга", pPostSay: "<em>{w}!</em> Не повезло",
      pMiss: "МИМО", pMissSay: "<em>Мимо!</em> Мяч улетает {where}", pOver: "над перекладиной", pSide: "в сторону от ворот",
      pLime: "ЛАЙМ", pTotal: "ТОТАЛ", pSdBar: "ДО ПЕРВОЙ ОШИБКИ", pSdSub: " · до первой ошибки", pChance: " · шанс гола {p}%", pPairs: "  +{n} пар",
      tStart: "Бойцы взялись за канат. <em>Ставки закрыты.</em>", tStreak3: "Серия! {h} тянет три подряд", tStreakStamp: "СЕРИЯ!",
      tStreak5: "Пять рывков подряд! {h} <em>не оставляет шансов</em>", tBack: "{h} <em>отыгрывается!</em>", tMid: "Середина: {a}:{b}. <em>Всё впереди!</em>",
      tTight: "Последние рывки. <em>Всё решается сейчас!</em>", tTightStamp: "РЕШАЮЩИЕ!", tDec: "{h} уже не догнать", tComeback: "КАМБЭК!",
      tWinSay: "Победил {h}, {w}:{l}", tWinCb: " — после отставания {n} рывков!", tBoardA: "ТОТАЛ", tBoardB: "КАНАТ", tPull: "РЫВОК {k} / {n}", tVictory: "ПОБЕДА",
      bxStart: "Бойцы на ринге. <em>Ставки закрыты.</em>", bxRoundSay: "Раунд {n}. Бойцы сходятся в центре ринга", bxRoundWon: "Раунд {n} за {h}", bxKoStamp: "НОКАУТ!", bxKoSay: "Нокаут! {h} отправляет соперника на канвас в раунде {n}", bxDecStamp: "РЕШЕНИЕ СУДЕЙ", bxDecSay: "Бой дошёл до конца. По очкам побеждает {h}, {a}:{b} по раундам", bxWin: "ПОБЕДА: {h}", bxRoundOf: "РАУНД {n} / {t}", bxBoardA: "ТОТАЛ", bxBoardB: "БОЙ", bxByKo: "нокаутом", bxByDec: "по очкам"
    },
    en: {
      loading: "LOADING SCENE…", m: "m", sec: "s",
      dStart: "Dogs are at the start. <em>Bets are closed.</em>", dPhoto: "PHOTO FINISH", dPhotoSay: "Photo finish! <em>Neck and neck</em>…", dFin: "FINISH!",
      dFinSay: "Finish! <em>#{n} {name}</em> wins", dWin: "<em>#{n} {name}</em> wins by {gap} s",
      dLead: "<em>#{n} {name}</em> takes the lead!", dGap: "<em>#{n} {name}</em> pulls away by {gap} m", dTight: "They are <em>neck and neck</em>!",
      dGo: "Traps are open — <em>and they're off!</em>", d100: "One hundred metres to go. <em>#{n} {name}</em> leads", dPh2: "Two side by side… <em>the photo will decide!</em>",
      dBoard: "TOTE · DOG RACES", dStartL: "START", dFinL: "FINISH", dFinPhoto: "FINISH · PHOTO", dGoBig: "GO!",
      rStart: "Rocket is on the pad. <em>Bets are closed.</em>", rCrash0: "CRASH AT LAUNCH", rCrash: "CRASH", rSay0: "The rocket blew up <em>at launch</em>!",
      rSay: "Crash at <em>{x}</em>.", rSayN: " {w} of {n} cashed out", player: "Player", rReach: "<em>{name}</em> reached {x}!",
      r1: "The rocket is climbing… <em>hold on!</em>", r4: "Already <em>{x}</em> — only the bravest are left", r10: "Ten-fold! <em>This is madness.</em>",
      rLaunch: "LAUNCH", rOk: "{ok} of {n} made it",
      pStart: "Penalty shootout. <em>Bets are closed.</em>", teamA: "Limes", teamB: "Magenta", pKickSd: "Sudden death: <em>{man}</em> steps up", pKick: "<em>{man}</em> to shoot, {team}",
      pWin: "WINNER: {team}", pEnd: "Shootout over: <em>{team}</em> {a}:{b}", pEndSd: ", settled in {n} sudden-death pairs",
      pGoal: "GOAL!", pGoalSay: "<em>GOAL!</em> {man} scores", pSave: "SAVED!", pSaveSay: "<em>Saved!</em> The keeper gets a hand to it",
      pBar: "CROSSBAR!", pPost: "POST!", pBarW: "Crossbar", pPostW: "Post", pPostSay: "<em>{w}!</em> So unlucky",
      pMiss: "MISS", pMissSay: "<em>Missed!</em> The ball sails {where}", pOver: "over the bar", pSide: "wide of the goal",
      pLime: "LIME", pTotal: "TOTE", pSdBar: "SUDDEN DEATH", pSdSub: " · sudden death", pChance: " · goal chance {p}%", pPairs: "  +{n} pairs",
      tStart: "The fighters grip the rope. <em>Bets are closed.</em>", tStreak3: "Streak! {h} pulls three in a row", tStreakStamp: "STREAK!",
      tStreak5: "Five pulls in a row! {h} <em>leaves no chance</em>", tBack: "{h} <em>fights back!</em>", tMid: "Halfway: {a}:{b}. <em>Anything can happen!</em>",
      tTight: "Last pulls. <em>It's decided now!</em>", tTightStamp: "DECIDING PULLS!", tDec: "{h} can't be caught now", tComeback: "COMEBACK!",
      tWinSay: "{h} wins, {w}:{l}", tWinCb: " — after trailing by {n} pulls!", tBoardA: "TOTE", tBoardB: "TUG", tPull: "PULL {k} / {n}", tVictory: "VICTORY",
      bxStart: "The fighters are in the ring. <em>Betting is closed.</em>", bxRoundSay: "Round {n}. The fighters meet in the middle of the ring", bxRoundWon: "Round {n} goes to {h}", bxKoStamp: "KNOCKOUT!", bxKoSay: "Knockout! {h} drops the opponent in round {n}", bxDecStamp: "JUDGES' DECISION", bxDecSay: "The fight went the distance. {h} wins on points, {a}:{b} in rounds", bxWin: "WINNER: {h}", bxRoundOf: "ROUND {n} / {t}", bxBoardA: "TOTE", bxBoardB: "FIGHT", bxByKo: "by knockout", bxByDec: "on points"
    },
    el: {
      loading: "ΦΟΡΤΩΣΗ ΣΚΗΝΗΣ…", m: "μ.", sec: "δευτ.",
      dStart: "Οι σκύλοι στην εκκίνηση. <em>Τα στοιχήματα έκλεισαν.</em>", dPhoto: "ΦΩΤΟΓΡΑΦΙΑ ΤΕΡΜΑΤΙΣΜΟΥ", dPhotoSay: "Φωτογραφία τερματισμού! <em>Ακριβώς ισόπαλοι</em>…", dFin: "ΤΕΡΜΑ!",
      dFinSay: "Τέρμα! Νικά ο <em>#{n} {name}</em>", dWin: "Νίκησε ο <em>#{n} {name}</em> με διαφορά {gap} δευτ.",
      dLead: "Ο <em>#{n} {name}</em> παίρνει το προβάδισμα!", dGap: "Ο <em>#{n} {name}</em> ξεφεύγει κατά {gap} μ.", dTight: "Τρέχουν <em>δίπλα δίπλα</em>!",
      dGo: "Οι πόρτες άνοιξαν — <em>ξεκίνησε ο αγώνας!</em>", d100: "Εκατό μέτρα για το τέρμα. Μπροστά ο <em>#{n} {name}</em>", dPh2: "Δύο μαζί… <em>θα κρίνει η φωτογραφία!</em>",
      dBoard: "ΤΟΤΑΛΙΖΑΤΟΡ · ΚΥΝΟΔΡΟΜΙΕΣ", dStartL: "ΕΚΚΙΝΗΣΗ", dFinL: "ΤΕΡΜΑ", dFinPhoto: "ΤΕΡΜΑ · ΦΩΤΟ", dGoBig: "ΦΥΓΑΜΕ!",
      rStart: "Ο πύραυλος στην εκτόξευση. <em>Τα στοιχήματα έκλεισαν.</em>", rCrash0: "ΕΚΡΗΞΗ ΣΤΗΝ ΕΚΚΙΝΗΣΗ", rCrash: "ΕΚΡΗΞΗ", rSay0: "Ο πύραυλος εξερράγη <em>στην εκκίνηση</em>!",
      rSay: "Έκρηξη στο <em>{x}</em>.", rSayN: " Πρόλαβαν {w} από {n}", player: "Παίκτης", rReach: "Ο/Η <em>{name}</em> έφτασε στο {x}!",
      r1: "Ο πύραυλος ανεβαίνει… <em>κρατηθείτε!</em>", r4: "Ήδη <em>{x}</em> — έμειναν οι πιο γενναίοι", r10: "Δεκαπλάσιο! <em>Αυτό είναι τρέλα.</em>",
      rLaunch: "ΕΚΤΟΞΕΥΣΗ", rOk: "πρόλαβαν {ok} από {n}",
      pStart: "Διαδικασία πέναλτι. <em>Τα στοιχήματα έκλεισαν.</em>", teamA: "Λάιμ", teamB: "Ματζέντα", pKickSd: "Μέχρι το πρώτο λάθος: εκτελεί ο <em>{man}</em>", pKick: "Εκτελεί ο <em>{man}</em>, {team}",
      pWin: "ΝΙΚΗ: {team}", pEnd: "Τέλος διαδικασίας: <em>{team}</em> {a}:{b}", pEndSd: ", κρίθηκε σε {n} ζεύγη μέχρι το πρώτο λάθος",
      pGoal: "ΓΚΟΛ!", pGoalSay: "<em>ΓΚΟΛ!</em> Σκοράρει ο {man}", pSave: "ΣΕΪΦ!", pSaveSay: "<em>Απόκρουση!</em> Ο τερματοφύλακας βγάζει την μπάλα",
      pBar: "ΞΥΛΟ!", pPost: "ΔΟΚΑΡΙ!", pBarW: "Οριζόντιο δοκάρι", pPostW: "Δοκάρι", pPostSay: "<em>{w}!</em> Άτυχος",
      pMiss: "ΕΞΩ", pMissSay: "<em>Άουτ!</em> Η μπάλα φεύγει {where}", pOver: "πάνω από το δοκάρι", pSide: "έξω από το τέρμα",
      pLime: "ΛΑΪΜ", pTotal: "ΤΟΤΑΛ", pSdBar: "ΜΕΧΡΙ ΤΟ ΠΡΩΤΟ ΛΑΘΟΣ", pSdSub: " · μέχρι το πρώτο λάθος", pChance: " · πιθανότητα γκολ {p}%", pPairs: "  +{n} ζεύγη",
      tStart: "Οι αθλητές έπιασαν το σχοινί. <em>Τα στοιχήματα έκλεισαν.</em>", tStreak3: "Σερί! Ο/Η {h} τραβά τρεις στη σειρά", tStreakStamp: "ΣΕΡΙ!",
      tStreak5: "Πέντε τραβήγματα στη σειρά! Ο/Η {h} <em>δεν αφήνει περιθώρια</em>", tBack: "Ο/Η {h} <em>ανακτά έδαφος!</em>", tMid: "Μέση: {a}:{b}. <em>Όλα ανοιχτά!</em>",
      tTight: "Τελευταία τραβήγματα. <em>Όλα κρίνονται τώρα!</em>", tTightStamp: "ΚΡΙΣΙΜΑ!", tDec: "Τον/Την {h} δεν τον φτάνουν πια", tComeback: "ΑΝΑΤΡΟΠΗ!",
      tWinSay: "Νίκησε ο/η {h}, {w}:{l}", tWinCb: " — μετά από απώλεια {n} τραβηγμάτων!", tBoardA: "ΤΟΤΑΛ", tBoardB: "ΣΧΟΙΝΙ", tPull: "ΤΡΑΒΗΓΜΑ {k} / {n}", tVictory: "ΝΙΚΗ",
      bxStart: "Οι μαχητές στο ρινγκ. <em>Τα στοιχήματα έκλεισαν.</em>", bxRoundSay: "Γύρος {n}. Οι μαχητές συναντιούνται στο κέντρο", bxRoundWon: "Ο γύρος {n} πάει στον/στην {h}", bxKoStamp: "ΝΟΚ ΑΟΥΤ!", bxKoSay: "Νοκ άουτ! Ο/Η {h} στέλνει τον αντίπαλο κάτω στον γύρο {n}", bxDecStamp: "ΑΠΟΦΑΣΗ ΚΡΙΤΩΝ", bxDecSay: "Ο αγώνας έφτασε ως το τέλος. Νικά στα σημεία ο/η {h}, {a}:{b} στους γύρους", bxWin: "ΝΙΚΗΤΗΣ: {h}", bxRoundOf: "ΓΥΡΟΣ {n} / {t}", bxBoardA: "ΤΟΤΑΛ", bxBoardB: "ΑΓΩΝΑΣ", bxByKo: "με νοκ άουτ", bxByDec: "στα σημεία"
    },
  };
  // текущий язык: берём в момент вывода строки; неизвестный → ru
  const lang = () => { try { const l = ((root.document && root.document.documentElement.lang) || (root.I18N && root.I18N.lang) || "ru").slice(0, 2); return STR[l] ? l : "ru"; } catch (e) { return "ru"; } };
  const i18t = (key, vars) => {
    let s = (STR[lang()] || STR.ru)[key]; if (s == null) s = STR.ru[key]; if (s == null) return key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : vars[k])) : s;
  };
  // сцены могут добавить свои строки (кубики): BetsScenes.i18n.add({ru:{..},en:{..},el:{..}})
  BS.i18n = { lang, t: i18t, add(d) { Object.keys(d).forEach((l) => { STR[l] = Object.assign(STR[l] || {}, d[l]); }); } };
  const fmt2ru = (x) => x.toFixed(2).replace(".", ",");
  const fmt2 = (x) => { const s = x.toFixed(2); return lang() === "en" ? s : s.replace(".", ","); };
  // подбор размера шрифта под ширину: возвращает размер ≤ size, при котором text влезает в maxW (шрифт g.font уже задан шаблоном)
  function fitSize(g, text, wt, size, fam, maxW) {
    g.font = wt + " " + size + "px " + fam; const w = g.measureText(text).width;
    return w > maxW && w > 0 ? Math.max(6, size * maxW / w) : size;
  }
  // контрольная сумма состояния (для тестов детерминизма): FNV-1a по JSON
  function sig(o) { const s = JSON.stringify(o); let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- холст-слой: заполняет контейнер, devicePixelRatio, ResizeObserver ----------
  function makeLayer(host) {
    const cv = document.createElement("canvas");
    cv.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block";
    host.appendChild(cv);
    const L = { cv, g: cv.getContext("2d"), W: 640, H: 360, dpr: 1, dirty: true };
    L.fit = function () {
      const r = host.getBoundingClientRect();
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      const W = Math.max(2, Math.round(r.width)), H = Math.max(2, Math.round(r.height));
      if (this.dirty || W !== this.W || H !== this.H || dpr !== this.dpr) {
        this.W = W; this.H = H; this.dpr = dpr;
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        this.dirty = false;
      }
      this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      return this;
    };
    let ro = null;
    if (root.ResizeObserver) { ro = new root.ResizeObserver(() => { L.dirty = true; }); ro.observe(host); }
    root.addEventListener("resize", () => { L.dirty = true; });
    L.destroy = function () { if (ro) ro.disconnect(); if (cv.parentNode) cv.parentNode.removeChild(cv); };
    return L;
  }

  /*
   * drive(o): цикл кадров по фиксированному шагу.
   *  o.env     — объект окружения сцены (env.silent гасит say/stamp/звук при прогоне вхолостую и перемотке)
   *  o.make()  — создаёт симуляцию {step(dt), done(), draw(), dispose?()}
   *  o.idle    — бесконечная «декорация» (show): ничего не резолвится
   *  o.durationMs, o.offsetMs, o.natural(сек, если известна заранее)
   * Возвращает { promise (true — доиграла, false — прервали), stop() }.
   */
  function drive(o) {
    const env = o.env;
    let stopped = false, raf = 0, finished = false, res;
    const promise = new Promise((r) => { res = r; });
    const off = o.idle ? 0 : Math.max(0, (o.offsetMs || 0) / 1000);
    const D = (o.durationMs || 0) / 1000;
    let speed = 1;
    if (!o.idle) {
      let nat = o.natural;
      if (nat == null) {            // прогон вхолостую: сколько сцена длится «сама по себе»
        env.silent = true;
        const s = o.make();
        let n = 0;
        while (!s.done() && n < 60 * 120) { s.step(DT); n++; }
        nat = n * DT;
        if (s.dispose) s.dispose();
      }
      // только ускоряем: если сцена короче окна, она просто заканчивается раньше
      if (D > 0) speed = Math.max(1, nat / Math.max(0.5, D - 0.15));
    }
    env.silent = true;
    const sim = o.make();
    let steps = Math.floor(off * speed / DT);
    for (let i = 0; i < steps && !sim.done(); i++) sim.step(DT);
    env.silent = false;
    if (steps === 0 && sim.start) sim.start();   // вступительные реплики — только если сцена начинается с нуля
    const t0 = root.performance.now();

    function stop(ok) {
      if (finished) return;
      finished = true; stopped = true;
      if (raf) root.cancelAnimationFrame(raf);
      if (sim.dispose) { try { sim.dispose(); } catch (e) { /* ничего */ } }
      res(!!ok);
    }
    function frame() {
      if (stopped) return;
      raf = root.requestAnimationFrame(frame);
      const el = (root.performance.now() - t0) / 1000;
      const want = o.idle ? Math.floor(el / DT) : Math.floor((el + off) * speed / DT);
      let behind = want - steps;
      if (o.idle && behind > 120) { steps = want - 1; behind = 1; }
      // долгая пауза вкладки: старые шаги прокручиваем молча, эффекты — только свежим хвостом
      let guard = 0;
      while (steps < want && !sim.done() && guard++ < 60 * 150) {
        env.silent = (want - steps) > 40;
        sim.step(DT); steps++;
      }
      env.silent = false;
      sim.draw();
      if (!o.idle && sim.done()) {
        stopped = true; finished = true;
        sim.draw();
        res(true);
        if (sim.dispose) { try { sim.dispose(); } catch (e) { /* ничего */ } }
      }
    }
    sim.draw();   // сразу первый кадр, чтобы show() не показывал пустоту
    raf = root.requestAnimationFrame(frame);
    return { promise, stop, speed: () => speed, sim };
  }

  // ---------- адаптер для 2D-сцен ----------
  // def.make(o, env) → симуляция; env = { L (слой), say, stamp, snd, silent }
  function canvasScene(host, ctx, def) {
    const L = makeLayer(host);
    let run = null, dead = false;
    const env = {
      L, silent: false,
      say(h) { if (!env.silent && !dead) ctx.emit("say", h); },
      stamp(text, tone) { if (!env.silent && !dead) ctx.emit("stamp", text, tone || "neutral"); },
      snd(name) {
        if (env.silent || dead || ctx.muted()) return;
        const s = ctx.sound;
        if (s && typeof s.play === "function") { try { s.play(name); } catch (e) { /* звук не должен ронять сцену */ } }
      },
    };
    const stopRun = () => { if (run) { run.stop(false); run = null; } };
    return {
      show(o) {
        stopRun();
        run = drive({ env, idle: true, make: () => def.make(Object.assign({}, o, { mode: "show" }), env) });
      },
      play(o) {
        stopRun();
        const r = drive({
          env, durationMs: o.durationMs, offsetMs: o.offsetMs,
          make: () => def.make(Object.assign({}, o, { mode: "play" }), env),
        });
        run = r;
        return r.promise;
      },
      live() { /* сценические события живых данных не получают */ },
      debug() { return run && run.sim && run.sim.debug ? Object.assign({ speed: run.speed() }, run.sim.debug()) : null; },
      destroy() { dead = true; stopRun(); L.destroy(); },
    };
  }

  // ---------- общая графика ----------
  function rr(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function vignette(g, W, H, a, r0) {
    const vg = g.createRadialGradient(W / 2, H / 2, H * (r0 || 0.45), W / 2, H / 2, H * 0.95);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0," + a + ")");
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
  }
  function spotlights(g, W, H, xs, SC, y0) {
    const y = H * (y0 || 0.04);
    for (const fx of xs) {
      const x = W * fx, gl = g.createRadialGradient(x, y, 0, x, y, H * 0.5);
      gl.addColorStop(0, "rgba(255,244,220,.58)"); gl.addColorStop(0.14, "rgba(255,238,200,.17)"); gl.addColorStop(1, "rgba(255,238,200,0)");
      g.fillStyle = gl; g.fillRect(x - H * 0.55, 0, H * 1.1, H * 0.65);
      g.fillStyle = "#fff6dd"; g.fillRect(x - 22 * SC, y - 5 * SC, 44 * SC, 11 * SC);
    }
  }
  const CROWD_COL = ["#3b2f4a", "#4a2f3a", "#2f3f4a", "#463d2a", "#2c4a3c", "#4a3a2c", "#2f2f4a", "#503040"];
  function makeCrowd(seed, n, rows) {
    const r = mulberry32(seed), a = [];
    for (let i = 0; i < n; i++) a.push({ x: r(), row: Math.floor(r() * rows), c: Math.floor(r() * 8), ph: r() * TAU, h: 0.7 + r() * 0.5 });
    return a;
  }
  // трибуна: люди рядами между top и bot; shift — параллакс в пикселях; excite — амплитуда подпрыгивания
  function drawCrowd(g, crowd, rows, W, top, bot, t, excite, shift, size) {
    for (const c of crowd) {
      const x = ((c.x * W * 1.4 - shift) % (W * 1.4) + W * 1.4) % (W * 1.4) - W * 0.2;
      if (x < -12 || x > W + 12) continue;
      const y = top + (c.row + 0.6) / (rows + 0.4) * (bot - top);
      const bob = Math.sin(t * (4 + c.h * 3 + c.row * 0.4) + c.ph) * excite * (1.2 + c.row * 0.4);
      const s = size * (1 + c.row * 0.22);
      g.fillStyle = CROWD_COL[c.c];
      g.beginPath(); g.arc(x, y + bob, s, 0, TAU); g.fill();
      g.fillRect(x - s, y + bob, s * 2, s * 1.5);
    }
  }
  // неоновые щиты с чередующимися надписями
  function drawBoards(g, W, y, h, words, t, shift) {
    g.fillStyle = "#0a0c12"; g.fillRect(0, y - h, W, h);
    const n = 9, w = W / n;
    g.font = "900 " + (h * 0.7) + "px " + DISP; g.textAlign = "center";
    for (let i = 0; i < n; i++) {
      g.fillStyle = i % 2 ? "#b6ff2e" : "#ff2e88"; g.globalAlpha = 0.8 + 0.2 * Math.sin(t * 3 + i);
      g.fillText(words[i % 2], (((i + 0.5) * w - shift) % W + W) % W, y - h * 0.22);
    }
    g.globalAlpha = 1; g.textAlign = "left";
  }
  // подпись с плашкой (HUD)
  function chip(g, text, x, y, h, fg, bg, bar, font) {
    g.font = font; const w = g.measureText(text).width + h * 0.9;
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    if (bar) { g.fillStyle = bar; g.fillRect(x, y, Math.max(3, h * 0.2), h); }
    g.fillStyle = fg; g.textAlign = "left"; g.fillText(text, x + h * 0.45 + (bar ? h * 0.1 : 0), y + h * 0.72);
    return w;
  }
  function glowText(g, text, x, y, size, col, glow, align, maxW) {
    if (maxW) size = fitSize(g, text, 900, size, DISP, maxW);   // длинные подписи (en/el) сужаем, а не обрезаем
    g.font = "900 " + size + "px " + DISP; g.textAlign = align || "center";
    g.shadowColor = glow || col; g.shadowBlur = size * 0.35; g.fillStyle = col; g.fillText(text, x, y); g.shadowBlur = 0; g.textAlign = "left";
  }

  // ---------- реестр сцен ----------
  const registry = Object.create(null);
  const regListeners = [];
  BS.register = function (types, factory) {
    const list = Array.isArray(types) ? types : [types];
    if (typeof factory !== "function") throw new Error("BetsScenes.register: factory must be a function");
    list.forEach((t) => { registry[t] = factory; });
    regListeners.slice().forEach((fn) => { try { fn(list); } catch (e) { console.error(e); } });
  };
  BS.has = (type) => !!registry[type];

  // кубики: ES-модуль с Three.js подгружается лениво и регистрирует тип dice
  let diceLoad = null;
  const scriptSrc = (root.document && root.document.currentScript && root.document.currentScript.src) || "";
  BS.loadDice = function (url) {
    if (registry.dice) return Promise.resolve(true);
    if (diceLoad) return diceLoad;
    let u = url || "/bets-scene-dice.js";
    if (!url && scriptSrc) { try { u = new URL("bets-scene-dice.js", scriptSrc).href; } catch (e) { /* остаётся абсолютный путь */ } }
    diceLoad = import(u).then((m) => {
      BS.register("dice", m.default || m.factory);
      return true;
    }).catch((e) => { console.error("bets-scene-dice.js:", e); diceLoad = null; return false; });
    return diceLoad;
  };

  // заглушка, пока нужная сцена не зарегистрирована (или загружается)
  function makeStub(host, ctx, type) {
    const def = {
      make(o, env) {
        let t = 0;
        return {
          step(dt) { t += dt; }, done: () => false,
          draw() {
            const L = env.L.fit(), g = L.g, W = L.W, H = L.H;
            g.fillStyle = "#05070a"; g.fillRect(0, 0, W, H);
            const k = 0.5 + 0.5 * Math.sin(t * 4);
            g.globalAlpha = 0.35 + 0.5 * k; glowText(g, i18t("loading"), W / 2, H / 2, Math.min(Math.max(16, Math.min(W / 14, 52)), fitSize(g, i18t("loading"), 900, Math.max(16, Math.min(W / 14, 52)), DISP, W * 0.92)), "#b6ff2e"); g.globalAlpha = 1;
            g.font = "700 " + Math.max(10, H * 0.03) + "px " + MONO; g.fillStyle = "#7d8c93"; g.textAlign = "center"; g.fillText(type, W / 2, H / 2 + H * 0.08); g.textAlign = "left";
          },
        };
      },
    };
    const sc = canvasScene(host, ctx, def);
    sc.stub = true;
    return sc;
  }

  // ---------- контроллер ----------
  BS.create = function (hostEl, opts) {
    opts = opts || {};
    const st = { muted: !!opts.muted, listeners: Object.create(null), cur: null, seq: 0, dead: false };
    const cs = root.getComputedStyle ? root.getComputedStyle(hostEl) : null;
    if (cs && cs.position === "static") hostEl.style.position = "relative";
    hostEl.style.overflow = "hidden";
    if (!hostEl.style.background && !hostEl.style.backgroundColor) hostEl.style.background = "#05070a";

    function emit(name) {
      if (st.dead) return;
      const args = Array.prototype.slice.call(arguments, 1);
      (st.listeners[name] || []).slice().forEach((fn) => { try { fn.apply(null, args); } catch (e) { console.error(e); } });
    }
    const ctx = {
      emit, muted: () => st.muted, util: BS.util,
      get sound() { return opts.sound || root.BetsSound || null; },
    };

    function dispose() {
      const c = st.cur; if (!c) return;
      st.cur = null;
      try { c.inst.destroy(); } catch (e) { console.error(e); }
      if (c.wrap.parentNode) c.wrap.parentNode.removeChild(c.wrap);
    }
    function make(type) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden";
      hostEl.appendChild(wrap);
      const f = registry[type];
      let inst, stub = false;
      if (f) inst = f(wrap, ctx);
      else { inst = makeStub(wrap, ctx, type); stub = true; if (type === "dice") BS.loadDice(); }
      return { type, inst, wrap, stub, lastShow: null };
    }
    // возвращает актуальную сцену типа type (заглушка заменяется настоящей, как только та зарегистрирована)
    function scene(type) {
      const c = st.cur;
      if (c && c.type === type && !(c.stub && registry[type])) return c;
      dispose();
      st.cur = make(type);
      return st.cur;
    }
    // зарегистрировали тип, пока на экране его заглушка → сразу меняем и показываем «ожидание»
    regListeners.push(function onReg(types) {
      if (st.dead) { const i = regListeners.indexOf(onReg); if (i >= 0) regListeners.splice(i, 1); return; }
      const c = st.cur;
      if (c && c.stub && types.indexOf(c.type) >= 0) {
        const show = c.lastShow; const type = c.type;
        scene(type);
        if (show && !st.waiting) safe(() => st.cur.inst.show(show));
      }
    });
    function safe(fn) { try { return fn(); } catch (e) { console.error(e); } }
    const waiters = [];
    regListeners.push(function onReg2(types) {
      if (st.dead) { const i = regListeners.indexOf(onReg2); if (i >= 0) regListeners.splice(i, 1); return; }
      waiters.slice().forEach((w) => { if (types.indexOf(w.type) >= 0) w.fire(); });
    });

    const api = {
      show(type, o) {
        if (st.dead) return;
        st.seq++; st.waiting = false;
        const c = scene(type);
        c.lastShow = o || {};
        safe(() => c.inst.show(c.lastShow));
      },
      // o: {type, input, meta, outcome, seed, durationMs, offsetMs, markers?, live?}
      play(o) {
        if (st.dead) return Promise.resolve(false);
        o = o || {};
        const my = ++st.seq;
        const c = scene(o.type);
        if (!c.stub) {
          let p; try { p = c.inst.play(o); } catch (e) { console.error(e); return Promise.resolve(false); }
          return Promise.resolve(p).then((v) => v !== false);
        }
        // сцена ещё не загружена: рисуем заглушку и ждём регистрации, но не дольше окна сцены
        c.lastShow = c.lastShow || {};
        st.waiting = true;
        const total = Math.max(0, (o.durationMs || 0) - (o.offsetMs || 0));
        const t0 = root.performance.now();
        return new Promise((resolve) => {
          let tm = null;
          const w = {
            type: o.type,
            fire() {
              if (tm) clearTimeout(tm);
              const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1);
              if (my !== st.seq || st.dead) return resolve(false);
              st.waiting = false;
              const waited = root.performance.now() - t0;
              const c2 = scene(o.type);
              if (c2.stub) return resolve(false);
              const o2 = Object.assign({}, o, { offsetMs: (o.offsetMs || 0) + waited });
              let p; try { p = c2.inst.play(o2); } catch (e) { console.error(e); return resolve(false); }
              Promise.resolve(p).then((v) => resolve(v !== false));
            },
          };
          waiters.push(w);
          tm = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); if (my === st.seq) st.waiting = false; resolve(false); }, total || 1);
        });
      },
      live(data) {
        const c = st.cur;
        if (c && c.inst && c.inst.live) safe(() => c.inst.live(data));
      },
      on(name, fn) { (st.listeners[name] = st.listeners[name] || []).push(fn); return api; },
      off(name, fn) { const a = st.listeners[name]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } return api; },
      setMuted(m) { st.muted = !!m; },
      // для тестов и отладки: что сцена считает «результатом на экране»
      debug() { const c = st.cur; return c && c.inst && c.inst.debug ? c.inst.debug() : null; },
      destroy() {
        if (st.dead) return;
        st.dead = true; st.seq++;
        dispose();
        waiters.length = 0;
        st.listeners = Object.create(null);
      },
    };
    // кубики подгружаем заранее, но не мешая первой отрисовке
    if (!registry.dice) setTimeout(() => { if (!st.dead) BS.loadDice(); }, 800);
    return api;
  };

  BS.util = { sig, DT, DISP, MONO, TAU, mulberry32, clamp, lerp, ease, fmt2, esc, makeLayer, drive, canvasScene, rr, vignette, spotlights, makeCrowd, drawCrowd, drawBoards, chip, glowText, CROWD_COL };

  /* =====================================================================================
   *  🐕 Собачьи бега (3 собаки). Исход — порядок финиша (индексы собак), траектории строятся назад от него.
   * ===================================================================================== */
  const DOG_NAMES = ["Борщ", "Шпала", "Капуста", "Турбо", "Баклажан", "Карма", "Лютик", "Чебурек", "Молния", "Кекс", "Пельмень", "Бумер", "Тапок", "Хрущ", "Гром", "Огурчик"];
  const TRAPS = [
    { bg: "#e5322d", fg: "#fff" },
    { bg: "#1f6fe5", fg: "#fff" },
    { bg: "#f3f3ee", fg: "#111" },
  ];
  const COATS = [
    { body: "#8a5a35", dark: "#5d3a1f", belly: "#c49a6c" },
    { body: "#2b2b30", dark: "#161619", belly: "#4a4a52" },
    { body: "#d0a773", dark: "#9a7448", belly: "#ecd4ac" },
    { body: "#c9c9c9", dark: "#8d8d92", belly: "#efefef" },
    { body: "#a2603a", dark: "#6d3c20", belly: "#d49b73" },
    { body: "#e6dccb", dark: "#a99d88", belly: "#fbf6ea" },
  ];

  function dogsMake(o, env) {
    const N = 3, DL = 400, VIEW_M = 38, START_DELAY = 0.55, COUNT_T = 2.7;
    const L = env.L, play = o.mode === "play";
    const R = mulberry32(play ? (o.seed | 0) : 1234);
    const meta = o.meta || {};
    // подписи: сервер присылает meta.names; если нет — берём из сида (чтобы не падать)
    const names = [], pool = DOG_NAMES.slice();
    for (let i = 0; i < N; i++) {
      const fromR = pool.splice(Math.floor(R() * pool.length), 1)[0];
      names.push(meta.names && meta.names[i] ? String(meta.names[i]) : fromR);
    }
    const coats = COATS.slice();
    for (let i = coats.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const t = coats[i]; coats[i] = coats[j]; coats[j] = t; }
    let order = Array.isArray(o.outcome) && o.outcome.length === N ? o.outcome.map((x) => x | 0) : [0, 1, 2];
    const T = new Array(N).fill(20);
    let photo = false, A = [], react = [];
    if (play) {
      // моменты финиша «назад» от порядка: первый ~17 с, дальше зазоры
      let t = 17.1 + R() * 0.9;
      photo = R() < 0.35;
      order.forEach((dog, place) => {
        if (place > 0) t += place === 1 && photo ? 0.02 + R() * 0.04 : 0.1 + R() * 0.38;
        T[dog] = t;
      });
      // возмущение траектории: g(u) = b(u) + Σ a_k sin²(kπu)/(kπ) — на концах точное, монотонно при |a_k| ≤ 0,14/k
      A = T.map(() => [1, 2, 3].map((k) => (R() * 2 - 1) * 0.085 / k));
      react = T.map(() => R() * 0.16);
    }
    const bfun = (u) => u * u * (2 - u);
    function pos(i, t) {
      const tt = t - START_DELAY - react[i];
      if (tt <= 0) return 0;
      const Ti = T[i] - START_DELAY - react[i];
      const u = tt / Ti;
      if (u >= 1) { const v = DL / Ti, d = tt - Ti; return DL + v * 0.75 * (1 - Math.exp(-d / 0.75)); }
      let g = bfun(u);
      for (let k = 1; k <= 3; k++) { const s = Math.sin(k * Math.PI * u); g += A[i][k - 1] * s * s / (k * Math.PI); }
      return DL * g;
    }

    const S = {
      phase: play ? "count" : "idle", clk: 0, cd: 0, t: 0, ts: 1, cam: -14, dust: [], streak: [], phi: [0, 0.7, 1.4], speed: new Array(N).fill(0),
      prevPos: new Array(N).fill(0), P: new Array(N).fill(0), zoom: 1, shake: 0, shx: 0, shy: 0, lead: -1, leadChange: 0, flash: 0, sayAt: -9, said: {},
      finishedAt: new Array(N).fill(null), resT: 0, last: null,
    };
    const crowd = makeCrowd(7, 520, 5);
    let W = 0, H = 0, SC = 1, g = null;
    const viewM = () => (W < 600 ? 24 : VIEW_M);
    const laneGeom = (k) => ({ y: H * 0.55 + k * H * 0.18, s: (0.95 + k * 0.2) * SC * 1.15 });
    const snd = env.snd, say = env.say;

    const start = () => { if (play) { say(i18t("dStart")); snd("crowd"); } };

    function onFinish(i) {
      const place = order.indexOf(i);
      if (place === 0) {
        S.flash = 0.6; snd("finish");
        if (photo) { env.stamp(i18t("dPhoto"), "neutral"); say(i18t("dPhotoSay")); }
        else { env.stamp(i18t("dFin"), "neutral"); say(i18t("dFinSay", { n: i + 1, name: esc(names[i]) })); }
      }
      if (place === 1 && photo) {
        const gap = T[i] - T[order[0]];
        say(i18t("dWin", { n: order[0] + 1, name: esc(names[order[0]]), gap: fmt2(gap) }));
        env.stamp("№" + (order[0] + 1) + " " + names[order[0]].toUpperCase(), "win");
      }
    }

    function step(dt) {
      S.clk += dt;
      S.shake = Math.max(0, S.shake - dt * 2.2);
      if (S.flash > 0) S.flash -= dt * 2.2;
      if (S.shake > 0) { S.shx = (R() - 0.5) * 10 * S.shake; S.shy = (R() - 0.5) * 8 * S.shake; } else { S.shx = S.shy = 0; }
      // фазы
      if (S.phase === "count") {
        S.cd += dt;
        if (S.cd >= COUNT_T) { S.phase = "run"; S.t = 0; snd("start"); }
      }
      let targetTs = 1;
      if (S.phase === "run") {
        const leadX = Math.max.apply(null, S.P);
        if (photo) {
          const p2 = S.P[order[1]];
          if (leadX > DL - 12 && p2 < DL + 4) targetTs *= 0.28;
        } else if (leadX > DL - 8 && leadX < DL + 4) targetTs *= 0.6;
      }
      S.ts += (targetTs - S.ts) * Math.min(1, dt * 6);
      const sdt = dt * S.ts;
      if (S.phase === "run") {
        S.t += sdt;
        if (S.t > Math.max.apply(null, T) + 2.2) { S.phase = "result"; S.resT = 0; }
      } else if (S.phase === "result") {
        S.resT += dt;
      }
      const t = S.t;
      const running = S.phase === "run" || S.phase === "result";
      for (let i = 0; i < N; i++) {
        const x = play && running ? pos(i, t) : 0;
        const v = sdt > 0 && running ? (x - S.prevPos[i]) / sdt : S.speed[i];
        S.prevPos[i] = x;
        S.speed[i] += (v - S.speed[i]) * Math.min(1, dt * 8);
        S.P[i] = x;
        S.phi[i] += (S.phase === "run" || S.phase === "result" ? sdt : dt) * TAU * (running ? 0.55 + S.speed[i] / 6.5 : 0);
        if (!running) S.phi[i] += dt * TAU * 0.4 * (S.phase === "count" ? 1.4 : 0.15);
        if (S.phase === "run" && R() < dt * 14 * Math.min(1, S.speed[i] / 16) && S.dust.length < 260) {
          S.dust.push({ lane: i, wx: x, ox: -40, vx: -20 - R() * 25 - S.speed[i] * 0.5, vy: -10 - R() * 30, r: 3 + R() * 4, life: 0.5 + R() * 0.4, age: 0, dy: 0 });
        }
      }
      // лидер, камера, реплики
      const P = S.P;
      const leadIdx = P.indexOf(Math.max.apply(null, P));
      if (S.phase === "run") {
        if (S.lead !== leadIdx) {
          if (S.lead >= 0 && t > 3 && S.clk - S.leadChange > 1.4 && P[leadIdx] < DL - 40) say(i18t("dLead", { n: leadIdx + 1, name: esc(names[leadIdx]) }));
          S.lead = leadIdx; S.leadChange = S.clk;
        }
        const lx = P[leadIdx], sorted = P.slice().sort((a, b) => b - a);
        const focus = lx * 0.6 + sorted[2] * 0.4;
        // камера считается в «опорных» метрах (кадр VIEW_M); под реальную ширину поправляется в draw()
        const camTarget = clamp(focus - VIEW_M * 0.5, -16, DL - VIEW_M * 0.5 + 6);
        S.cam += (camTarget - S.cam) * Math.min(1, dt * 5);
        const zT = lx > DL - 45 ? 1.1 + (photo && lx > DL - 14 ? 0.1 : 0) : 1;
        S.zoom += (zT - S.zoom) * Math.min(1, dt * 2.5);
        const gap = lx - sorted[1];
        const bk = Math.floor(t / 3);
        if (t > 4 && S.clk - S.sayAt > 2.6 && lx < DL - 60 && gap > 6 && !S.said["gap" + bk]) { S.said["gap" + bk] = 1; S.sayAt = S.clk; say(i18t("dGap", { n: leadIdx + 1, name: esc(names[leadIdx]), gap: gap.toFixed(0) })); }
        if (t > 4 && S.clk - S.sayAt > 2.6 && lx < DL - 60 && gap < 2 && !S.said["tight" + bk]) { S.said["tight" + bk] = 1; S.sayAt = S.clk; say(i18t("dTight")); }
        if (t > 1.2 && !S.said.go) { S.said.go = 1; S.shake = 1; say(i18t("dGo")); }
        if (lx > 300 && !S.said.m100) { S.said.m100 = 1; say(i18t("d100", { n: leadIdx + 1, name: esc(names[leadIdx]) })); }
        if (lx > DL - 25 && photo && !S.said.ph) { S.said.ph = 1; say(i18t("dPh2")); }
        T.forEach((Ti, i) => { if (S.finishedAt[i] === null && t >= Ti) { S.finishedAt[i] = Ti; onFinish(i); } });
      } else if (S.phase === "idle" || S.phase === "count") {
        S.cam += (-14 - S.cam) * Math.min(1, dt * 3);
      } else if (S.phase === "result") {
        S.zoom += (1 - S.zoom) * Math.min(1, dt * 2.5);
      }
      if (R() < dt * 40 * (S.phase === "run" && Math.max.apply(null, S.speed) > 14 ? 1 : 0)) S.streak.push({ x: 1.02, y: 0.5 + R() * 0.48, len: 80 + R() * 160, v: 1400 + R() * 900 });
      for (let i = S.streak.length - 1; i >= 0; i--) { const d = S.streak[i]; d.x -= d.v * dt * Math.min(1, S.ts + 0.2) / 1280; if (d.x + d.len / 1280 < 0) S.streak.splice(i, 1); }
      for (let i = S.dust.length - 1; i >= 0; i--) {
        const d = S.dust[i]; d.age += dt;
        if (d.age > d.life) { S.dust.splice(i, 1); continue; }
        d.ox += d.vx * dt * S.ts; d.dy += d.vy * dt; d.vy += 40 * dt;
      }
    }

    // ---------- рисование ----------
    function drawBackground(t, camX) {
      let gr = g.createLinearGradient(0, 0, 0, H * 0.4);
      gr.addColorStop(0, "#05060d"); gr.addColorStop(0.55, "#14102a"); gr.addColorStop(1, "#3a1a38");
      g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.42);
      for (let i = 0; i < 4; i++) {
        const x = (((i * 520 + 120 - camX * 3.2) % 2080) + 2080) % 2080 / 2080 * (W + 200) - 100, y = H * 0.06;
        const gl = g.createRadialGradient(x, y, 0, x, y, H * 0.55);
        gl.addColorStop(0, "rgba(255,244,220,.55)"); gl.addColorStop(0.12, "rgba(255,238,200,.18)"); gl.addColorStop(1, "rgba(255,238,200,0)");
        g.fillStyle = gl; g.fillRect(x - H * 0.6, 0, H * 1.2, H * 0.7);
        g.fillStyle = "#0a0b10"; g.fillRect(x - 3, y, 6, H * 0.3);
        g.fillStyle = "#fff6dd"; g.fillRect(x - 24 * SC, y - 7 * SC, 48 * SC, 14 * SC);
        g.fillStyle = "rgba(255,246,221,.5)"; for (let j = 0; j < 4; j++) g.fillRect(x - 22 * SC + j * 12 * SC, y - 5 * SC, 8 * SC, 10 * SC);
      }
      const tribTop = H * 0.2, tribBot = H * 0.395;
      gr = g.createLinearGradient(0, tribTop, 0, tribBot);
      gr.addColorStop(0, "#1b1530"); gr.addColorStop(1, "#0d0b18");
      g.fillStyle = gr; g.fillRect(0, tribTop, W, tribBot - tribTop);
      const exc = S.phase === "run" ? 1 + (S.flash > 0 ? 1.5 : 0) : 0.4;
      drawCrowd(g, crowd, 5, W, tribTop, tribBot, t, exc, camX * 2.4, 5 * SC * 1.2);
      // световое табло на трибуне
      const bx = ((W * 0.58 - camX * 2.0) % (W * 1.4) + W * 1.4) % (W * 1.4) - W * 0.2;
      g.fillStyle = "#06090c"; g.fillRect(bx, H * 0.075, W * 0.26, H * 0.1);
      g.strokeStyle = "#ff2e88"; g.lineWidth = 2; g.shadowColor = "#ff2e88"; g.shadowBlur = 14; g.strokeRect(bx, H * 0.075, W * 0.26, H * 0.1); g.shadowBlur = 0;
      g.fillStyle = "#b6ff2e"; g.font = "900 " + (H * 0.062) + "px " + DISP; g.textAlign = "center";
      { const bt = i18t("dBoard"); g.font = "900 " + fitSize(g, bt, 900, H * 0.062, DISP, W * 0.24) + "px " + DISP; g.fillText(bt, bx + W * 0.13, H * 0.148); } g.textAlign = "left";
      g.fillStyle = "#171320"; g.fillRect(0, tribBot - 2, W, H * 0.03);
      g.fillStyle = "#2a2338"; g.fillRect(0, tribBot - 2, W, 3);
      gr = g.createLinearGradient(0, H * 0.42, 0, H * 0.46);
      gr.addColorStop(0, "#0e2a1d"); gr.addColorStop(1, "#143a27");
      g.fillStyle = gr; g.fillRect(0, H * 0.425, W, H * 0.04);
    }
    function drawTrack(camX, ppm) {
      const top = H * 0.465, bot = H;
      const gr = g.createLinearGradient(0, top, 0, bot);
      gr.addColorStop(0, "#6e5238"); gr.addColorStop(0.5, "#8b6a48"); gr.addColorStop(1, "#5a4129");
      g.fillStyle = gr; g.fillRect(0, top, W, bot - top);
      g.fillStyle = "rgba(0,0,0,.10)";
      for (let k = 0; k < N; k++) {
        const { y, s } = laneGeom(k), step3 = 3, m0 = Math.floor(camX / step3) * step3;
        for (let m = m0 - 3; m < m0 + viewM() + 6; m += step3) {
          const x = (m - camX) * ppm, jit = ((Math.sin(m * 12.9 + k * 78.2) * 43758.5) % 1 + 1) % 1;
          g.fillRect(x + jit * 18, y + 14 * s + jit * 6, 14 * s, 2);
        }
      }
      g.strokeStyle = "rgba(255,255,255,.35)"; g.lineWidth = 2;
      for (let k = 0; k <= N; k++) { const { y, s } = laneGeom(k - 0.5); g.beginPath(); g.moveTo(0, y + 20 * s); g.lineTo(W, y + 20 * s); g.stroke(); }
      const g0 = laneGeom(0);
      for (let m = Math.ceil(camX / 50) * 50; m < camX + viewM() + 5; m += 50) {
        const x = (m - camX) * ppm; if (m >= DL) break;
        g.fillStyle = "rgba(255,255,255,.55)"; g.fillRect(x - 1, g0.y - 40 * g0.s, 2, 8);
        g.fillStyle = "#fff"; g.font = "800 " + (H * 0.032) + "px " + MONO; g.textAlign = "center";
        g.fillText(m === 0 ? i18t("dStartL") : m + " " + i18t("m"), x, g0.y - 46 * g0.s); g.textAlign = "left";
      }
    }
    function drawTraps(camX, ppm, open) {
      const x = (0 - camX) * ppm;
      if (x < -300 || x > W + 100) return;
      for (let k = 0; k < N; k++) {
        const { y, s } = laneGeom(k), w = 150 * s, h = 62 * s, bx = x - w - 6;
        g.fillStyle = "#0c0f14"; g.fillRect(bx, y - h + 20 * s, w, h);
        g.strokeStyle = "#3a4650"; g.lineWidth = 2;
        for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(bx + 6 + i * (w - 12) / 5, y - h + 24 * s); g.lineTo(bx + 6 + i * (w - 12) / 5, y + 18 * s); g.stroke(); }
        g.fillStyle = "#222c34"; g.fillRect(x - 10 * s, y - h + 20 * s, 10 * s, (1 - open) * h);
        g.fillStyle = TRAPS[k].bg; g.fillRect(bx + 4, y - h + 24 * s, 22 * s, 22 * s);
        g.fillStyle = TRAPS[k].fg; g.font = "900 " + (18 * s) + "px " + DISP; g.textAlign = "center"; g.fillText(k + 1, bx + 4 + 11 * s, y - h + 24 * s + 18 * s);
        g.fillStyle = "#e8eef0"; g.font = "800 " + (17 * s) + "px " + DISP; g.textAlign = "left"; g.fillText((k + 1) + " " + names[k].toUpperCase(), bx + 4, y - h + 16 * s);
      }
    }
    function drawFinish(camX, ppm, t) {
      const x = (DL - camX) * ppm;
      if (x < -80 || x > W + 80) return;
      const top = laneGeom(0).y - 64 * laneGeom(0).s, bot = laneGeom(N - 1).y + 22 * laneGeom(N - 1).s;
      for (let k = 0; k < N; k++) {
        const { y, s } = laneGeom(k), h0 = y - 14 * s, hh = 34 * s, n = 4;
        for (let i = 0; i < n; i++) { g.fillStyle = (i + k) % 2 ? "#fff" : "#111"; g.fillRect(x - 5, h0 + i * hh / n, 10, hh / n + 0.5); }
      }
      const pulse = 0.65 + 0.35 * Math.sin(t * 12);
      g.strokeStyle = "rgba(255,46,136," + pulse + ")"; g.lineWidth = 3; g.shadowColor = "#ff2e88"; g.shadowBlur = 16;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bot); g.stroke(); g.shadowBlur = 0;
      g.fillStyle = "#0a0d11"; g.fillRect(x - 3, top - 26, 6, 26);
      g.fillStyle = "#111820"; g.fillRect(x - 70, top - 48, 140, 26);
      g.strokeStyle = "#b6ff2e"; g.shadowColor = "#b6ff2e"; g.shadowBlur = 10; g.lineWidth = 2; g.strokeRect(x - 70, top - 48, 140, 26); g.shadowBlur = 0;
      g.fillStyle = "#b6ff2e"; g.font = "900 " + (H * 0.04) + "px " + DISP; g.textAlign = "center"; g.fillText(i18t("dFinL"), x, top - 28); g.textAlign = "left";
    }
    function drawLure(x, t) {
      const g0 = laneGeom(0), y = g0.y - 34 * g0.s;
      g.strokeStyle = "#8d99a3"; g.lineWidth = 3; g.beginPath(); g.moveTo(0, y - 10); g.lineTo(W, y - 10); g.stroke();
      g.save(); g.translate(x, y); const s = g0.s * 1.1; g.scale(s, s);
      g.fillStyle = "#e9e3d8"; const hop = Math.abs(Math.sin(t * 9)) * 3;
      g.beginPath(); g.ellipse(0, -10 - hop, 15, 9, 0, 0, TAU); g.fill();
      g.beginPath(); g.ellipse(14, -16 - hop, 7, 6, 0, 0, TAU); g.fill();
      g.beginPath(); g.ellipse(12, -30 - hop, 3, 9, -0.2, 0, TAU); g.fill();
      g.beginPath(); g.ellipse(18, -29 - hop, 3, 8, 0.2, 0, TAU); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(-16, -11 - hop, 4, 0, TAU); g.fill();
      g.fillStyle = "#c00"; g.fillRect(16, -17 - hop, 2, 2);
      g.restore();
    }
    // собака: вид сбоку вправо; (cx, gy) — центр корпуса на земле; φ — фаза галопа
    function drawDog(cx, gy, s, phi, coat, trap, num, effort) {
      g.save(); g.translate(cx, gy); g.scale(s, s);
      const ext = 0.5 + 0.5 * Math.sin(phi), lift = -9 * Math.max(0, Math.sin(phi + 0.9)) * effort;
      g.fillStyle = "rgba(0,0,0,.28)"; g.beginPath(); g.ellipse(-2, 4, 52 - 6 * ext, 7, 0, 0, TAU); g.fill();
      g.translate(0, lift);
      const half = 33 + 9 * ext * effort;
      const hip = { x: -half, y: -50 - 9 * (1 - ext) * effort }, sho = { x: half, y: -48 - 4 * ext * effort };
      const leg = (jx, jy, L1, L2, ph, hind, col, wd) => {
        const sn = Math.sin(phi + ph), cs = Math.cos(phi + ph);
        const a1 = (hind ? -0.1 : 0.15) + (hind ? 0.9 : 1.0) * sn * effort;
        const bend = -(0.25 + (hind ? 0.9 : 0.85) * Math.max(0, cs)) * (0.45 + 0.55 * effort);
        const kx = jx + L1 * Math.sin(a1), ky = jy + L1 * Math.cos(a1);
        const a2 = a1 + (hind ? -bend : bend);
        const fx = kx + L2 * Math.sin(a2), fy = Math.min(0, ky + L2 * Math.cos(a2));
        g.strokeStyle = col; g.lineCap = "round"; g.lineJoin = "round";
        g.lineWidth = wd; g.beginPath(); g.moveTo(jx, jy); g.lineTo(kx, ky); g.stroke();
        g.lineWidth = wd * 0.72; g.beginPath(); g.moveTo(kx, ky); g.lineTo(fx, fy); g.stroke();
        g.lineWidth = wd * 0.6; g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx + 7, fy + 1); g.stroke();
      };
      leg(sho.x - 6, sho.y + 10, 24, 26, 0.9, false, coat.dark, 8);
      leg(hip.x + 8, hip.y + 8, 30, 30, 0.35, true, coat.dark, 9);
      g.strokeStyle = coat.body; g.lineWidth = 4; g.lineCap = "round";
      g.beginPath(); g.moveTo(hip.x - 8, hip.y - 4);
      g.bezierCurveTo(hip.x - 26, hip.y + 4, hip.x - 42, hip.y + 12 + 4 * Math.sin(phi), hip.x - 56, hip.y + 2 + 6 * Math.sin(phi + 1));
      g.stroke();
      const torso = new Path2D();
      const topY = Math.min(hip.y, sho.y) - 22 - 6 * (1 - ext) * effort;
      torso.moveTo(hip.x - 12, hip.y - 4);
      torso.bezierCurveTo(hip.x - 8, hip.y - 20, -6, topY, sho.x - 8, sho.y - 18);
      torso.quadraticCurveTo(sho.x + 10, sho.y - 22, sho.x + 14, sho.y - 2);
      torso.bezierCurveTo(sho.x + 14, sho.y + 16, sho.x - 4, sho.y + 22, sho.x - 22, sho.y + 16);
      torso.bezierCurveTo(-8, (hip.y + sho.y) / 2 + 2, hip.x + 20, hip.y + 2, hip.x + 6, hip.y + 12);
      torso.quadraticCurveTo(hip.x - 8, hip.y + 14, hip.x - 12, hip.y - 4);
      g.fillStyle = coat.body; g.fill(torso);
      g.save(); g.clip(torso);
      g.fillStyle = coat.belly; g.globalAlpha = 0.55; g.fillRect(hip.x, (hip.y + sho.y) / 2 + 6, half * 2, 30); g.globalAlpha = 1;
      g.fillStyle = trap.bg; g.fillRect(-12, topY - 4, 30, 80);
      g.restore();
      g.fillStyle = trap.fg;
      g.font = "900 17px " + DISP; g.textAlign = "center"; g.fillText(num, 6, (hip.y + sho.y) / 2 - 8); g.textAlign = "left";
      const hx = sho.x + 28 + 4 * ext * effort, hy = sho.y - 26 + 3 * Math.sin(phi + 0.5) * effort;
      g.strokeStyle = coat.body; g.lineCap = "round"; g.lineWidth = 15;
      g.beginPath(); g.moveTo(sho.x + 2, sho.y - 12); g.lineTo(hx - 4, hy + 4); g.stroke();
      g.fillStyle = coat.body;
      g.beginPath(); g.moveTo(hx - 10, hy - 8); g.lineTo(hx + 8, hy - 8); g.lineTo(hx + 34, hy + 3); g.lineTo(hx + 34, hy + 8); g.lineTo(hx + 6, hy + 11); g.lineTo(hx - 10, hy + 8); g.closePath(); g.fill();
      g.fillStyle = "#16161a"; g.beginPath(); g.arc(hx + 34, hy + 4, 4.2, 0, TAU); g.fill();
      g.strokeStyle = "rgba(0,0,0,.5)"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(hx + 10, hy + 9); g.lineTo(hx + 30, hy + 8); g.stroke();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(hx + 9, hy - 2, 2.8, 0, TAU); g.fill();
      g.fillStyle = "#111"; g.beginPath(); g.arc(hx + 10, hy - 2, 1.5, 0, TAU); g.fill();
      g.fillStyle = coat.dark; g.beginPath(); g.moveTo(hx - 8, hy - 8); g.quadraticCurveTo(hx - 24, hy - 12 - 4 * Math.sin(phi * 2), hx - 30, hy - 2); g.quadraticCurveTo(hx - 16, hy - 2, hx - 8, hy + 1); g.closePath(); g.fill();
      leg(sho.x - 6, sho.y + 10, 24, 26, 0, false, coat.body, 9);
      leg(hip.x + 8, hip.y + 8, 30, 30, 0.55, true, coat.body, 10);
      g.restore();
    }

    function draw() {
      L.fit(); g = L.g; W = L.W; H = L.H; SC = Math.max(W / 1280, H / 720);
      const now = S.clk, t = S.t, ppm = W / viewM();
      const camX = S.cam + (VIEW_M - viewM()) * 0.5;
      const P = S.P, running = S.phase === "run" || S.phase === "result";
      const leadIdx = P.indexOf(Math.max.apply(null, P));
      g.save();
      { const cx = W * 0.62, cy = H * 0.62, z = S.zoom; g.translate(cx + S.shx, cy + S.shy); g.scale(z, z); g.translate(-cx, -cy); }
      drawBackground(now, camX);
      drawTrack(camX, ppm);
      const open = S.phase === "run" || S.phase === "result" ? Math.min(1, Math.max(0, (t - START_DELAY + 0.1) / 0.18)) : 0;
      drawTraps(camX, ppm, open);
      drawFinish(camX, ppm, now);
      const lureX = running ? Math.min(P[leadIdx] + 9, DL + 40) : -6;
      drawLure((lureX - camX) * ppm, now);
      for (let k = 0; k < N; k++) {
        const { y, s } = laneGeom(k);
        const x = (P[k] - camX) * ppm + (running ? 0 : -52 * s);
        if (x < -160 || x > W + 160) continue;
        const eff = running ? Math.min(1, 0.2 + S.speed[k] / 13) : (S.phase === "count" ? 0.2 : 0);
        const idleBob = S.phase !== "run" ? Math.sin(now * 3 + k) * (S.phase === "count" ? 3 : 1) : 0;
        drawDog(x, y + 14 * s + idleBob * s, s * 0.95, S.phi[k], coats[k], TRAPS[k], k + 1, eff);
      }
      // подписи над собаками: у лидера лаймовая (в ожидании имена написаны на ловушках)
      if (running) {
        const rank = P.map((x, i) => i).sort((a, b) => P[b] - P[a]);
        for (let k = 0; k < N; k++) {
          const { y, s } = laneGeom(k);
          const x = (P[k] - camX) * ppm - 4 * s + (running ? 0 : -52 * s);
          if (x < -60 || x > W + 60) continue;
          const lead = running && rank[0] === k, fin = S.finishedAt[k] !== null;
          const label = (k + 1) + " " + names[k].toUpperCase() + (running && !lead && !fin ? "  +" + fmt2(P[rank[0]] - P[k]) : "");
          const fs = Math.round(15 * SC * 1.1 + 2);
          g.font = "800 " + fs + "px " + DISP;
          const tw = g.measureText(label).width + 20, th = 24 * SC * 1.1 + 2;
          const tx = x - tw / 2, ty = y - 120 * s;
          g.fillStyle = lead ? "#b6ff2e" : "rgba(9,12,16,.82)"; g.fillRect(tx, ty, tw, th);
          g.fillStyle = TRAPS[k].bg; g.fillRect(tx, ty, 5, th);
          g.fillStyle = lead ? "#07090c" : "#fff"; g.textAlign = "center"; g.fillText(label, tx + tw / 2 + 2, ty + th * 0.74); g.textAlign = "left";
          if (lead && !fin) { g.fillStyle = "#b6ff2e"; g.beginPath(); g.moveTo(x - 6, ty + th); g.lineTo(x + 6, ty + th); g.lineTo(x, ty + th + 7); g.fill(); }
        }
      }
      // линии скорости
      g.strokeStyle = "rgba(255,255,255,.22)"; g.lineWidth = 2;
      for (const d of S.streak) { g.beginPath(); g.moveTo(d.x * W, d.y * H); g.lineTo(d.x * W + d.len * SC / 1.0, d.y * H); g.stroke(); }
      // пыль
      g.fillStyle = "rgba(190,160,120,.5)";
      for (const d of S.dust) {
        const { y, s } = laneGeom(d.lane), k = d.age / d.life;
        g.globalAlpha = 0.5 * (1 - k);
        g.beginPath(); g.arc((d.wx - camX) * ppm + d.ox * s, y + 8 * s + d.dy * s, d.r * s * (0.6 + k), 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
      g.restore();

      // миникарта прогресса (HUD)
      if (running) {
        const mx = W * 0.06, mw = W * 0.88, my = H * 0.05, u = Math.max(0.7, SC * 1.1);
        g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(mx - 12, my - 14 * u, mw + 24, 38 * u);
        g.fillStyle = "#26323b"; g.fillRect(mx, my + 4 * u, mw, 3);
        g.fillStyle = "#ff2e88"; g.fillRect(mx + mw - 1, my - 4 * u, 3, 18 * u);
        for (let i = 0; i < N; i++) {
          const f = clamp(P[i] / DL, 0, 1), cy = my + 5.5 * u + (i - 1) * 2.4;
          g.fillStyle = TRAPS[i].bg; g.strokeStyle = "#000"; g.lineWidth = 2;
          g.beginPath(); g.arc(mx + f * mw, cy, 8.5 * u, 0, TAU); g.fill(); g.stroke();
          g.fillStyle = TRAPS[i].fg; g.font = "800 " + (9 * u) + "px " + MONO; g.textAlign = "center"; g.fillText(i + 1, mx + f * mw, cy + 3.3 * u); g.textAlign = "left";
        }
      }
      // отсчёт «3-2-1-ГО» на холсте
      if (S.phase === "count") {
        const n = 3 - Math.floor(S.cd / (COUNT_T / 3)), u = (S.cd % (COUNT_T / 3)) / (COUNT_T / 3);
        g.globalAlpha = 1 - u * 0.6; glowText(g, String(clamp(n, 1, 3)), W / 2, H * 0.3, H * (0.22 - 0.05 * u), "#fff", "#ff2e88"); g.globalAlpha = 1;
      } else if (S.phase === "run" && S.t < 0.9) {
        g.globalAlpha = 1 - S.t / 0.9; glowText(g, i18t("dGoBig"), W / 2, H * 0.3, H * 0.22, "#b6ff2e", null, "center", W * 0.9); g.globalAlpha = 1;
      }
      // итоговая таблица
      if (S.phase === "result") {
        const k = Math.min(1, S.resT / 0.4), u = Math.max(0.75, SC * 1.15);
        const pw = Math.min(W * 0.9, 330 * u), ph = (30 + N * 26) * u, px = (W - pw) / 2, py = H * 0.17 + (1 - k) * -20;
        g.globalAlpha = k;
        g.fillStyle = "rgba(6,9,12,.86)"; g.fillRect(px, py, pw, ph);
        g.strokeStyle = "#b6ff2e"; g.lineWidth = 2; g.strokeRect(px, py, pw, ph);
        g.font = "800 " + (13 * u) + "px " + MONO; g.fillStyle = "#7d8c93"; g.fillText(photo ? i18t("dFinPhoto") : i18t("dFinL"), px + 12 * u, py + 19 * u);
        order.forEach((d, p) => {
          const yy = py + (30 + p * 26 + 17) * u;
          g.fillStyle = TRAPS[d].bg; g.fillRect(px + 12 * u, yy - 15 * u, 5, 21 * u);
          g.font = "900 " + (20 * u) + "px " + DISP; g.fillStyle = p === 0 ? "#b6ff2e" : "#fff";
          g.fillText((p + 1) + "  №" + (d + 1) + " " + names[d].toUpperCase(), px + 26 * u, yy);
          g.textAlign = "right"; g.font = "800 " + (14 * u) + "px " + MONO; g.fillText(fmt2(T[d]) + " " + i18t("sec"), px + pw - 12 * u, yy); g.textAlign = "left";
        });
        g.globalAlpha = 1;
      }
      vignette(g, W, H, 0.45, 0.5);
      if (S.flash > 0) { g.fillStyle = "rgba(255,255,255," + Math.min(0.55, S.flash) + ")"; g.fillRect(0, 0, W, H); }
    }

    return {
      start, step, draw,
      done: () => play && S.phase === "result" && S.resT > 2.2,
      debug: () => ({ sig: sig(S), type: "dogs", phase: S.phase, order: order.slice(), shownOrder: order.slice(), finishedAt: S.finishedAt.slice(), names, photo, t: S.t }),
    };
  }

  /* =====================================================================================
   *  🚀 Ракета. Исход — число M (точка взрыва, ≥ 1). Вешки игроков приходят в play({markers:[{name,color,x}]}).
   * ===================================================================================== */
  const ROCKET_COLORS = ["#ff2e88", "#b6ff2e", "#38d3ff", "#ffd34d", "#a78bfa", "#ff7a2e", "#4dffb0", "#ff5c5c", "#7aa2ff", "#f0abfc", "#fde047", "#5eead4"];

  function rocketMake(o, env) {
    const GROWTH = 0.2;            // d ln M / dt, как в спеке §4.4
    const L = env.L, play = o.mode === "play";
    const R = mulberry32(play ? (o.seed | 0) : 77);
    const crash = play ? Math.max(1, Number(o.outcome) || 1) : 1;
    // если окно короткое (ранний взрыв), сжимаем отсчёт и паузу после взрыва
    const kPre = clamp((o.durationMs || 20000) / 9000, 0.55, 1);
    const CT = 1.5 * kPre, IG = 0.7 * kPre, BOOM_HOLD = 2.4 * Math.max(0.65, kPre);
    const marks = [];
    (o.markers || []).forEach((m, i) => {
      const x = Number(m && m.x);
      if (isFinite(x) && x > 1) marks.push({ name: String((m && m.name) || ""), color: (m && m.color) || ROCKET_COLORS[i % ROCKET_COLORS.length], x, status: "play" });
    });
    marks.sort((a, b) => a.x - b.x);
    const S = {
      phase: play ? "count" : "idle", clk: 0, cd: 0, igT: 0, t: 0, M: 1, ts: 1, shake: 0, flash: 0, ringT: -1, boomT: 0, alt: 0,
      smoke: [], sparks: [], debris: [], floats: [], said: {}, flick: 0, jx: 0, jy: 0, bx: 0, by: 0,
    };
    const stars = [], clouds = [];
    { const r = mulberry32(11); for (let i = 0; i < 160; i++) stars.push({ x: r(), y: r(), z: 0.2 + r() * 0.8, tw: r() * 6 }); for (let i = 0; i < 9; i++) clouds.push({ x: r(), y: r(), w: 0.2 + r() * 0.3 }); }
    let W = 0, H = 0, SC = 1, g = null;
    const fmtX = (x) => "×" + fmt2(x);
    const say = env.say, snd = env.snd;
    const ROCKET_X = () => W * 0.58, ROCKET_Y = () => H * 0.62, PX_LN = () => H * 0.3;
    const yOf = (M) => ROCKET_Y() - (Math.log(M) - Math.log(S.M)) * PX_LN();
    const rng = (a, b) => a + R() * (b - a);

    const start = () => { if (play) say(i18t("rStart")); };

    function explode() {
      S.phase = "boom"; S.boomT = 0; S.flash = 1; S.shake = 3; S.ringT = 0;
      snd("boom");
      for (let i = 0; i < 90; i++) { const a = rng(0, TAU), s = rng(80, 520); S.sparks.push({ x: 0, y: 0, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: rng(0.6, 1.6), age: 0, c: ["#ffffff", "#ffd34d", "#ff7a2e", "#ff2e88", "#b6ff2e"][Math.floor(rng(0, 5))], r: rng(2, 5) }); }
      for (let i = 0; i < 12; i++) S.debris.push({ x: 0, y: 0, vx: rng(-260, 260), vy: rng(-380, 100), rot: rng(0, 6), vr: rng(-8, 8), w: rng(8, 22), c: ["#fbfdff", "#ff2e88", "#b6ff2e", "#9aa6b2"][i % 4], life: 2 });
      marks.forEach((p) => { if (p.status === "play") p.status = p.x <= crash + 1e-9 ? "ok" : "burn"; });
      const winners = marks.filter((p) => p.status === "ok").length;
      env.stamp(i18t(crash <= 1.0001 ? "rCrash0" : "rCrash"), "lose");
      say(crash <= 1.0001 ? i18t("rSay0") : i18t("rSay", { x: fmtX(crash) }) + (marks.length ? i18t("rSayN", { w: winners, n: marks.length }) : ""));
    }

    function step(dt) {
      S.clk += dt;
      S.flick = R();
      S.shake = S.phase === "fly" || S.phase === "ignite" ? S.shake : Math.max(0, S.shake - dt * 2);
      if (S.shake > 0) { S.jx = R() - 0.5; S.jy = R() - 0.5; S.bx = R() - 0.5; S.by = R() - 0.5; } else { S.jx = S.jy = S.bx = S.by = 0; }
      if (S.flash > 0) S.flash -= dt * 2.4;
      if (S.ringT >= 0) { S.ringT += dt; if (S.ringT > 0.7) S.ringT = -1; }
      S.alt += (S.phase === "fly" ? 60 + 26 * Math.min(S.M, 25) : 8) * dt;

      if (S.phase === "count") {
        S.cd += dt;
        if (S.cd >= CT) { S.phase = "ignite"; S.igT = 0; snd("ignite"); }
      } else if (S.phase === "ignite") {
        S.igT += dt; S.shake = Math.min(1.2, S.igT * 1.1);
        if (S.igT > IG) {
          S.phase = "fly"; S.t = 0; S.shake = 0;
          if (crash <= 1.0001) { S.M = 1; explode(); }
        }
      } else if (S.phase === "fly") {
        let target = 1;
        const next = marks.find((p) => p.status === "play" && p.x > S.M);
        if (next && next.x / S.M < 1.045 && next.x <= crash + 0.2) target *= 0.55;
        if (crash / S.M < 1.04) target *= 0.5;      // до взрыва совсем близко: тишина перед ударом
        S.ts += (target - S.ts) * Math.min(1, dt * 6);
        S.t += dt * S.ts;
        S.M = Math.exp(GROWTH * S.t);
        S.shake = Math.min(1.6, Math.log(S.M) / 2.2);
        marks.forEach((p) => {
          if (p.status === "play" && S.M >= p.x) {
            p.status = "ok"; S.floats.push({ txt: "✓ " + p.name, x: p.x, t: 0, c: p.color }); snd("pass");
            say(i18t("rReach", { name: esc(p.name || i18t("player")), x: fmtX(p.x) }));
          }
        });
        if (S.M >= crash) { S.M = crash; explode(); }
        else {
          if (S.t > 1.2 && !S.said.s1) { S.said.s1 = 1; say(i18t("r1")); }
          if (S.M > 4 && !S.said.s4) { S.said.s4 = 1; say(i18t("r4", { x: fmtX(S.M) })); }
          if (S.M > 10 && !S.said.s10) { S.said.s10 = 1; say(i18t("r10")); }
        }
      } else if (S.phase === "boom") {
        S.boomT += dt;
      }
      // огонь и дым
      const thrust = S.phase === "fly" ? Math.min(1, 0.45 + Math.log(S.M) / 3) : S.phase === "ignite" ? 0.35 : 0;
      if (thrust > 0 && S.smoke.length < 260) {
        for (let i = 0; i < 2; i++) S.smoke.push({ x: rng(-8, 8), y: 48, vx: rng(-20, 20), vy: rng(60, 140) + thrust * 80, r: rng(5, 11), life: rng(0.7, 1.4), age: 0, hot: R() < 0.35 });
      }
      for (let i = S.smoke.length - 1; i >= 0; i--) {
        const s = S.smoke[i]; s.age += dt;
        if (s.age > s.life) { S.smoke.splice(i, 1); continue; }
        s.x += s.vx * dt; s.y += s.vy * dt * (S.phase === "fly" ? 1 : 0.6);
      }
      for (let i = S.sparks.length - 1; i >= 0; i--) {
        const s = S.sparks[i]; s.age += dt;
        if (s.age > s.life) { S.sparks.splice(i, 1); continue; }
        s.vy += 420 * dt; s.vx *= 0.99; s.x += s.vx * dt; s.y += s.vy * dt;
      }
      for (let i = S.debris.length - 1; i >= 0; i--) {
        const d = S.debris[i]; d.life -= dt;
        if (d.life <= 0) { S.debris.splice(i, 1); continue; }
        d.vy += 520 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt;
      }
      for (let i = S.floats.length - 1; i >= 0; i--) { S.floats[i].t += dt; if (S.floats[i].t > 1.4) S.floats.splice(i, 1); }
    }

    // ---------- рисование ----------
    function drawSky(now) {
      const k = Math.min(1, Math.log(S.M) / 3.2);
      const gr = g.createLinearGradient(0, 0, 0, H), lp = (a, b, t) => Math.round(a + (b - a) * t);
      gr.addColorStop(0, "rgb(" + lp(14, 3, k) + "," + lp(10, 4, k) + "," + lp(34, 12, k) + ")");
      gr.addColorStop(0.6, "rgb(" + lp(70, 10, k) + "," + lp(26, 8, k) + "," + lp(70, 30, k) + ")");
      gr.addColorStop(1, "rgb(" + lp(255, 40, k) + "," + lp(70, 18, k) + "," + lp(130, 70, k) + ")");
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      const speed = (S.phase === "fly" ? 60 + 26 * Math.min(S.M, 25) : 8) * SC, alt = S.alt * SC;
      for (const s of stars) {
        const y = ((s.y * H + alt * s.z * 0.5) % H + H) % H;
        const a = (0.35 + 0.65 * Math.abs(Math.sin(now * 1.5 + s.tw))) * (0.4 + k * 0.6);
        g.fillStyle = "rgba(255,255,255," + a + ")";
        const len = S.phase === "fly" ? Math.min(26, speed * 0.03 * s.z) : 0;
        g.fillRect(s.x * W, y, 1.5 + s.z, 1.5 + s.z + len);
      }
      if (S.M < 3) {
        g.fillStyle = "rgba(255,170,220," + (0.16 * (1 - k)) + ")";
        for (const c of clouds) { const y = ((c.y * H * 1.2 + alt) % (H * 1.2)); g.beginPath(); g.ellipse(c.x * W, y, c.w * W * 0.5, 18 * SC, 0, 0, TAU); g.fill(); }
      }
    }
    function drawGround(now) {
      const off = Math.log(S.M) * PX_LN(), gy = ROCKET_Y() + 62 * SC + off;
      if (gy > H + 40) return;
      g.fillStyle = "#0a0c12"; g.fillRect(0, gy, W, H - gy + 80);
      g.fillStyle = "#171a26"; g.fillRect(0, gy, W, 6);
      g.strokeStyle = "#b6ff2e"; g.shadowColor = "#b6ff2e"; g.shadowBlur = 14; g.lineWidth = 2; g.beginPath(); g.moveTo(0, gy + 1); g.lineTo(W, gy + 1); g.stroke(); g.shadowBlur = 0;
      const tx = ROCKET_X() - 110 * SC;
      g.fillStyle = "#11151f"; g.fillRect(tx, gy - 210 * SC, 26 * SC, 210 * SC);
      g.strokeStyle = "#2b3547"; g.lineWidth = 2; for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(tx, gy - i * 24 * SC); g.lineTo(tx + 26 * SC, gy - (i + 1) * 24 * SC); g.stroke(); }
      g.fillStyle = "#ff2e88"; g.fillRect(tx + 8 * SC, gy - 218 * SC, 10 * SC, 8 * SC);
      g.fillStyle = (Math.floor(now * 2) % 2) ? "#ff2e88" : "#3a1020"; g.beginPath(); g.arc(tx + 13 * SC, gy - 224 * SC, 4 * SC, 0, TAU); g.fill();
      g.fillStyle = "#0d101a";
      for (let i = 0; i < 18; i++) { const bx = i * (W / 17) - 20, bh = (28 + ((i * 53) % 70)) * SC; g.fillRect(bx, gy - bh, W / 17 - 6, bh); }
    }
    function drawRocket(x, y, s, tilt, thrust) {
      g.save(); g.translate(x, y); g.rotate(tilt); g.scale(s, s);
      if (thrust > 0) {
        const fl = 40 + thrust * 70 + S.flick * 18 * thrust;
        const gr = g.createLinearGradient(0, 40, 0, 40 + fl);
        gr.addColorStop(0, "#ffffff"); gr.addColorStop(0.25, "#ffe27a"); gr.addColorStop(0.6, "#ff5a2e"); gr.addColorStop(1, "rgba(255,46,136,0)");
        g.fillStyle = gr; g.beginPath(); g.moveTo(-13, 40); g.quadraticCurveTo(-20 - thrust * 4, 40 + fl * 0.6, 0, 40 + fl); g.quadraticCurveTo(20 + thrust * 4, 40 + fl * 0.6, 13, 40); g.closePath(); g.fill();
        g.globalCompositeOperation = "lighter"; const gl = g.createRadialGradient(0, 56, 0, 0, 56, 90 + thrust * 60); gl.addColorStop(0, "rgba(255,150,60,.45)"); gl.addColorStop(1, "rgba(255,46,136,0)"); g.fillStyle = gl; g.fillRect(-160, -80, 320, 360); g.globalCompositeOperation = "source-over";
      }
      g.fillStyle = "#b6ff2e";
      g.beginPath(); g.moveTo(-14, 6); g.lineTo(-40, 50); g.lineTo(-14, 40); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(14, 6); g.lineTo(40, 50); g.lineTo(14, 40); g.closePath(); g.fill();
      g.fillStyle = "#86c21f"; g.beginPath(); g.moveTo(0, 20); g.lineTo(-7, 50); g.lineTo(7, 50); g.closePath(); g.fill();
      const bg = g.createLinearGradient(-20, 0, 20, 0); bg.addColorStop(0, "#9aa6b2"); bg.addColorStop(0.45, "#fbfdff"); bg.addColorStop(1, "#8a95a3");
      g.fillStyle = bg; g.beginPath(); g.moveTo(0, -78); g.bezierCurveTo(26, -50, 22, 0, 20, 42); g.lineTo(-20, 42); g.bezierCurveTo(-22, 0, -26, -50, 0, -78); g.closePath(); g.fill();
      g.fillStyle = "#ff2e88"; g.beginPath(); g.moveTo(0, -78); g.bezierCurveTo(14, -62, 17, -52, 19, -46); g.lineTo(-19, -46); g.bezierCurveTo(-17, -52, -14, -62, 0, -78); g.closePath(); g.fill();
      g.fillStyle = "#101820"; g.beginPath(); g.arc(0, -14, 11, 0, TAU); g.fill();
      g.fillStyle = "#38d3ff"; g.beginPath(); g.arc(-2, -16, 7.5, 0, TAU); g.fill();
      g.fillStyle = "rgba(255,255,255,.7)"; g.beginPath(); g.arc(-5, -19, 2.6, 0, TAU); g.fill();
      g.fillStyle = "#b6ff2e"; g.fillRect(-21, 18, 42, 5);
      g.fillStyle = "#2b3140"; g.fillRect(-14, 40, 28, 8);
      g.restore();
    }
    function drawRuler() {
      const rx = Math.max(66 * Math.min(1, SC * 1.6 + 0.3), 78 * SC + 10);
      g.fillStyle = "rgba(6,8,12,.72)"; g.fillRect(0, 0, rx + 20, H);
      g.strokeStyle = "#2b3a46"; g.lineWidth = 2; g.beginPath(); g.moveTo(rx, 0); g.lineTo(rx, H); g.stroke();
      const ticks = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 1000];
      g.textAlign = "right"; g.font = "800 " + (13 * Math.max(0.8, SC)) + "px " + MONO;
      for (const m of ticks) {
        const y = yOf(m); if (y < -10 || y > H + 10) continue;
        const major = [2, 5, 10, 20, 50, 100].indexOf(m) >= 0;
        g.strokeStyle = major ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.22)"; g.lineWidth = major ? 2 : 1;
        g.beginPath(); g.moveTo(rx - (major ? 16 : 9), y); g.lineTo(rx, y); g.stroke();
        g.fillStyle = major ? "#fff" : "#8f9aa3"; g.fillText("×" + m, rx - 22 * Math.max(0.6, SC * 1.4), y + 4);
      }
      g.textAlign = "left";
      let prevY = -99, shiftN = 0;
      marks.forEach((p) => {
        const y = yOf(p.x); if (y < -20 || y > H + 20) return;
        shiftN = Math.abs(y - prevY) < 24 * Math.max(0.85, SC) ? shiftN + 1 : 0; prevY = y;
        const done = p.status === "ok", burn = p.status === "burn";
        const col = done ? "#b6ff2e" : burn ? "#ff2e88" : p.color;
        g.strokeStyle = col; g.globalAlpha = done ? 0.9 : burn ? 0.5 : 0.55; g.lineWidth = done ? 2.5 : 1.5;
        if (g.setLineDash) g.setLineDash(done ? [] : [5, 6]);
        g.beginPath(); g.moveTo(rx, y); g.lineTo(W - 12, y); g.stroke(); if (g.setLineDash) g.setLineDash([]); g.globalAlpha = 1;
        const label = (p.name ? p.name + " " : "") + "×" + String(p.x).replace(".", ",");
        g.font = "800 " + (14 * Math.max(0.85, SC)) + "px " + DISP;
        const tw = g.measureText(label + (done || burn ? " ✓" : "")).width + 22, th = 22 * Math.max(0.85, SC), cx = rx + 14 + shiftN * (tw + 8), cy = y - th / 2;
        g.fillStyle = done ? "#b6ff2e" : burn ? "#4a1530" : "rgba(8,10,14,.9)"; g.fillRect(cx, cy, tw, th);
        g.fillStyle = p.color; g.fillRect(cx, cy, 5, th);
        g.fillStyle = done ? "#07090c" : burn ? "#ff9ac4" : "#fff"; g.fillText(label + (done ? " ✓" : burn ? " ✗" : ""), cx + 11, cy + th * 0.74);
      });
      const y = ROCKET_Y();
      g.fillStyle = "#fff"; g.beginPath(); g.moveTo(rx + 2, y); g.lineTo(rx + 16, y - 7); g.lineTo(rx + 16, y + 7); g.fill();
    }
    function drawBigX() {
      const M = S.M, hot = Math.min(1, Math.log(M) / 3);
      const boomed = S.phase === "boom";
      const col = boomed ? "#ff2e88" : hot < 0.5 ? "#b6ff2e" : hot < 0.85 ? "#ffd34d" : "#ff7a2e";
      const size = (86 + Math.min(1, Math.log(Math.max(1.001, M)) / 3) * 40) * SC;
      g.font = "900 " + size + "px " + DISP; g.textAlign = "center";
      g.shadowColor = col; g.shadowBlur = 24 + 20 * hot; g.fillStyle = "#fff";
      const sx = S.bx * S.shake * 5, sy = S.by * S.shake * 4;
      g.fillText(fmtX(M), W * 0.58 + sx, H * 0.2 + sy);
      g.shadowBlur = 0; g.fillStyle = col; g.globalAlpha = 0.32; g.fillText(fmtX(M), W * 0.58 + sx, H * 0.2 + sy); g.globalAlpha = 1;
      g.textAlign = "left";
    }

    function draw() {
      L.fit(); g = L.g; W = L.W; H = L.H; SC = Math.min(W / 1100, H / 690);
      const now = S.clk, ox = ROCKET_X(), oy = ROCKET_Y();
      g.save();
      const sh = S.shake * SC;
      g.translate(S.jx * 6 * sh, S.jy * 5 * sh);
      drawSky(now);
      drawGround(now);
      const thrust = S.phase === "fly" ? Math.min(1, 0.45 + Math.log(S.M) / 3) : S.phase === "ignite" ? 0.35 : 0;
      for (const s of S.smoke) {
        const a = 1 - s.age / s.life;
        g.fillStyle = s.hot ? "rgba(255," + Math.round(120 + a * 100) + ",60," + (a * 0.55) + ")" : "rgba(200,190,215," + (a * 0.28) + ")";
        g.beginPath(); g.arc(ox + s.x * SC, oy + s.y * SC, s.r * SC * (1 + (1 - a) * 1.6), 0, TAU); g.fill();
      }
      if (S.phase !== "boom") {
        const tilt = Math.sin(now * 17) * 0.012 * S.shake;
        drawRocket(ox + S.bx * S.shake * 3, oy + (S.phase === "idle" || S.phase === "count" ? 0 : S.by * S.shake * 2), SC, tilt, thrust);
      }
      if (S.ringT >= 0) {
        const r = S.ringT * 700 * SC, a = Math.max(0, 1 - S.ringT / 0.7);
        g.strokeStyle = "rgba(255,255,255," + a + ")"; g.lineWidth = 8 * a * SC + 1; g.beginPath(); g.arc(ox, oy, r, 0, TAU); g.stroke();
        g.strokeStyle = "rgba(255,46,136," + a + ")"; g.lineWidth = 4 * a * SC + 1; g.beginPath(); g.arc(ox, oy, r * 0.75, 0, TAU); g.stroke();
      }
      g.globalCompositeOperation = "lighter";
      for (const s of S.sparks) { g.globalAlpha = Math.max(0, 1 - s.age / s.life); g.fillStyle = s.c; g.beginPath(); g.arc(ox + s.x * SC, oy + s.y * SC, s.r * SC, 0, TAU); g.fill(); }
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      for (const d of S.debris) {
        g.save(); g.translate(ox + d.x * SC, oy + d.y * SC); g.rotate(d.rot); g.globalAlpha = Math.min(1, d.life); g.fillStyle = d.c;
        g.fillRect(-d.w * SC / 2, -d.w * SC / 4, d.w * SC, d.w * SC / 2); g.restore();
      }
      g.globalAlpha = 1;
      drawRuler();
      for (const f of S.floats) {
        g.globalAlpha = Math.max(0, 1 - f.t / 1.4); g.fillStyle = "#b6ff2e"; g.font = "900 " + (26 * Math.max(0.9, SC)) + "px " + DISP;
        g.fillText(f.txt, W * 0.58 + 70 * SC, yOf(f.x) - f.t * 50); g.globalAlpha = 1;
      }
      g.restore();
      drawBigX();
      // отсчёт
      if (S.phase === "count") {
        const per = CT / 3, n = 3 - Math.floor(S.cd / per), u = (S.cd % per) / per;
        g.globalAlpha = 1 - u * 0.6; glowText(g, String(clamp(n, 1, 3)), W * 0.58, H * 0.46, H * (0.2 - 0.04 * u), "#fff", "#ff2e88"); g.globalAlpha = 1;
      } else if (S.phase === "ignite") {
        glowText(g, i18t("rLaunch"), W * 0.58, H * 0.46, H * 0.16, "#b6ff2e", null, "center", W * 0.8);
      }
      // итог после взрыва: сколько долетело
      if (S.phase === "boom" && marks.length) {
        const k = Math.min(1, S.boomT / 0.5), ok = marks.filter((p) => p.status === "ok").length;
        g.globalAlpha = k; glowText(g, i18t("rOk", { ok: ok, n: marks.length }), W * 0.58, H * 0.3, Math.max(14, 30 * Math.max(0.6, SC)), ok ? "#b6ff2e" : "#ff9ac4", null, "center", W * 0.8); g.globalAlpha = 1;
      }
      if (S.flash > 0) { g.fillStyle = "rgba(255,255,255," + Math.min(0.85, S.flash) + ")"; g.fillRect(0, 0, W, H); }
      vignette(g, W, H, 0.5, 0.45);
    }

    return {
      start, step, draw,
      done: () => play && S.phase === "boom" && S.boomT > BOOM_HOLD,
      debug: () => ({ sig: sig(S), type: "rocket", phase: S.phase, M: S.M, crash, shown: fmt2ru(S.M), marks: marks.map((p) => ({ name: p.name, x: p.x, status: p.status })) }),
    };
  }

  /* =====================================================================================
   *  ⚽ Серия пенальти. Исход: {kicks:[{team,n,res}], sd:[{a,b}], goalsA, goalsB, posts, winner}.
   *  Зона удара и ход вратаря выбираются из seed и результата удара (гол / сейв / штанга / мимо).
   * ===================================================================================== */
  const PEN_MEN_A = ["Шашков", "Коробов", "Лютиков", "Бубнов", "Клюшкин"];
  const PEN_MEN_B = ["Гвоздев", "Пончиков", "Кубиков", "Тапкин", "Рельсов"];

  function penMake(o, env) {
    const L = env.L, play = o.mode === "play";
    const R = mulberry32(play ? (o.seed | 0) : 99);
    const rnd = (a, b) => a + R() * (b - a);
    const pick = (a) => a[Math.floor(R() * a.length)];
    const meta = o.meta || {}, input = o.input || {};
    const mk = (t, col, dark, men0, nm0) => {
      const m = meta[t] || {};
      const men = [];
      for (let i = 0; i < 5; i++) men.push(m.men && m.men[i] ? String(m.men[i]) : men0[i]);
      const nmFix = m.name ? String(m.name) : null;
      return { get name() { return nmFix || i18t(nm0); }, col, dark, men };
    };
    const TEAM = { A: mk("A", "#b6ff2e", "#07090c", PEN_MEN_A, "teamA"), B: mk("B", "#ff2e88", "#ffffff", PEN_MEN_B, "teamB") };
    const cls = { A: (input.A || []).slice(0, 5), B: (input.B || []).slice(0, 5) };      // шансы гола бьющих, ‰
    const meanOf = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 700);
    const sdCls = { A: meanOf(cls.A), B: meanOf(cls.B) };
    const out = o.outcome && Array.isArray(o.outcome.kicks) ? o.outcome : { kicks: [], sd: [], goalsA: 0, goalsB: 0, posts: 0, winner: "A" };
    const sdList = Array.isArray(out.sd) ? out.sd : [];

    // последовательность ударов; в серии «до первой ошибки» промахи делим на сейв/мимо (штангу не показываем: рынок штанги — только первые 10 ударов)
    const seq = [];
    out.kicks.forEach((k) => seq.push({ team: k.team, n: k.n, res: k.res, sd: false }));
    sdList.forEach((r, i) => {
      const bad = () => pick(["save", "save", "miss"]);
      seq.push({ team: "A", n: i % 5, res: r.a ? "goal" : bad(), sd: true });
      seq.push({ team: "B", n: i % 5, res: r.b ? "goal" : bad(), sd: true });
    });
    // индексы точек табло: регулярные (по 5) и серия
    const dotIdx = { A: { reg: [], sd: [] }, B: { reg: [], sd: [] } };
    seq.forEach((k, j) => { dotIdx[k.team][k.sd ? "sd" : "reg"].push(j); });

    const T_INTRO = 0.8, T_PREP = 0.85, T_RUN = 0.7, T_FLY = 0.5, T_AFTER = 1.1, T_GAP = 0.2, T_END = 2.6;
    const CAMZ = -9, CAMY = 1.85, GZ = 11;
    const S = {
      phase: play ? "intro" : "idle", clk: 0, wait: T_INTRO, k: -1, cur: null, A: 0, B: 0, ts: 1, endT: 0,
      ball: { x: 0, y: 0.11, z: 0, spin: 0 }, trail: [], net: [], sparks: [], flash: 0, shake: 0, shx: 0, shy: 0, zoom: 1, heart: 0,
      keeper: { x: 0, y: 0.92, rot: 0, dive: 0 }, hist: [],
    };
    const crowd = makeCrowd(5, 380, 8);
    let W = 0, H = 0, SC = 1, g = null;
    const say = env.say, snd = env.snd;
    const FOCAL = () => W * (W / H < 1.5 ? 1.0 : 1.25), HY = () => H * 0.31;
    const P = (x, y, z) => { const k = FOCAL() / (z - CAMZ); return { x: W / 2 + x * k, y: HY() + (CAMY - y) * k, k }; };

    const start = () => { if (play) say(i18t("pStart")); };

    // зона удара в системе ворот: ширина ±3,66 м, высота 2,44 м
    function planKick(k) {
      const side = pick([-1, 1]);
      const zones = [[-0.78, 0.2], [-0.78, 0.8], [0, 0.82], [0.78, 0.2], [0.78, 0.8]];
      const zn = pick(zones);
      const hw = 3.66, hh = 2.44;
      let tx, ty, post = null, wide = null;
      if (k.res === "goal" || k.res === "save") {
        tx = zn[0] * hw * 0.92 + rnd(-0.12, 0.12); ty = zn[1] * hh * 0.92 + rnd(-0.1, 0.1);
        if (zn[0] === 0 && k.res === "goal") tx = side * rnd(0.2, 0.7);
      } else if (k.res === "post") {
        post = pick(["L", "R", "T"]);
        if (post === "L") { tx = -hw; ty = rnd(0.7, 1.9); } else if (post === "R") { tx = hw; ty = rnd(0.7, 1.9); } else { tx = side * rnd(0.8, 2.6); ty = hh; }
      } else {
        wide = pick(["L", "R", "U"]);
        if (wide === "L") { tx = -hw - rnd(0.7, 1.8); ty = rnd(0.5, 1.8); } else if (wide === "R") { tx = hw + rnd(0.7, 1.8); ty = rnd(0.5, 1.8); } else { tx = side * rnd(0.5, 2.5); ty = hh + rnd(0.7, 1.4); }
      }
      // вратарь: гол — не достаёт, сейв — достаёт, штанга — почти, мимо — гадает
      let kx, ky;
      const dirTo = tx >= 0 ? 1 : -1;
      if (k.res === "save") { kx = tx + rnd(-0.1, 0.1); ky = ty + rnd(-0.08, 0.08); }
      else if (k.res === "goal") {
        if (Math.abs(tx) < 0.8) { kx = pick([-1, 1]) * 2.3; ky = 0.9; }
        else if (R() < 0.55) { kx = -dirTo * rnd(1.8, 2.8); ky = rnd(0.6, 1.5); }
        else { kx = dirTo * rnd(1.0, 1.7); ky = ty > 1.2 ? rnd(0.3, 0.7) : rnd(1.5, 2.0); }
      } else if (k.res === "post") { kx = dirTo * rnd(1.5, 2.4); ky = Math.min(1.9, ty); }
      else { kx = pick([-1, 1]) * rnd(1.4, 2.5); ky = rnd(0.7, 1.7); }
      return { tx, ty, kx, ky, post, wide };
    }

    function sparks(x, y, z, n) { for (let i = 0; i < n; i++) S.sparks.push({ x, y, z, vx: rnd(-3, 3), vy: rnd(0.5, 4), vz: rnd(-3, 1), life: rnd(0.5, 1.1), age: 0 }); }

    function nextKick() {
      S.k++;
      if (S.k >= seq.length) { finish(); return; }
      const k = seq[S.k];
      S.cur = Object.assign({}, k, planKick(k), { t: 0, stage: "prep", struck: false, resolved: false, tK: 0, dfl: null });
      S.phase = "kick"; S.ball = { x: 0, y: 0.11, z: 0, spin: 0 }; S.trail.length = 0; S.keeper = { x: 0, y: 0.92, rot: 0, dive: 0 }; S.net.length = 0;
      const man = TEAM[k.team].men[k.n];
      say(i18t(k.sd ? "pKickSd" : "pKick", { man: esc(man), team: esc(TEAM[k.team].name) }));
      snd("whistle");
    }
    function finish() {
      S.phase = "end"; S.cur = null; S.endT = 0;
      const w = out.winner;
      env.stamp(i18t("pWin", { team: TEAM[w].name.toUpperCase() }), "win");
      say(i18t("pEnd", { team: esc(TEAM[w].name), a: w === "A" ? out.goalsA : out.goalsB, b: w === "A" ? out.goalsB : out.goalsA }) + (sdList.length ? i18t("pEndSd", { n: sdList.length }) : ""));
      snd("whistle");
    }
    function onResult() {
      const c = S.cur; c.resolved = true;
      const t = c.team;
      if (c.res === "goal") {
        if (!c.sd) S[t]++;
        S.flash = 0.5; S.shake = 1.2; S.net.push({ x: c.tx, y: c.ty, t: 0 });
        env.stamp(i18t("pGoal"), "win"); say(i18t("pGoalSay", { man: esc(TEAM[t].men[c.n]) })); snd("goal"); snd("crowd");
      } else if (c.res === "save") {
        env.stamp(i18t("pSave"), "neutral"); say(i18t("pSaveSay")); S.shake = 0.8; snd("save");
      } else if (c.res === "post") {
        env.stamp(i18t(c.post === "T" ? "pBar" : "pPost"), "neutral"); say(i18t("pPostSay", { w: i18t(c.post === "T" ? "pBarW" : "pPostW") }));
        S.shake = 1.6; S.flash = 0.35; sparks(c.tx, c.ty, GZ, 26); snd("post");
      } else {
        env.stamp(i18t("pMiss"), "lose"); say(i18t("pMissSay", { where: i18t(c.wide === "U" ? "pOver" : "pSide") })); snd("miss");
      }
      S.hist.push({ team: t, n: c.n, res: c.res, sd: c.sd });
    }
    const ballAt = (c, s) => { const arc = 0.28 + Math.max(0, c.ty) * 0.12; return { x: c.tx * s, y: 0.11 + (c.ty - 0.11) * s + 4 * arc * s * (1 - s), z: GZ * s }; };

    function step(dt) {
      S.clk += dt;
      const c = S.cur;
      let target = 1;
      if (c && c.stage === "fly") { const s = (c.t - c.tK) / T_FLY; if (s > 0.62) target *= 0.38; }
      if (c && c.stage === "after") target *= (c.t - c.tK - T_FLY < 0.5 ? 0.5 : 1);
      S.ts += (target - S.ts) * Math.min(1, dt * 8);
      const sdt = dt * S.ts;
      if (S.phase === "intro") { S.wait -= dt; if (S.wait <= 0) { S.phase = "between"; S.wait = 0.05; } }
      else if (S.phase === "between") { S.wait -= dt; if (S.wait <= 0) nextKick(); }
      else if (S.phase === "kick" && c) {
        c.t += sdt;
        if (c.stage === "prep" && c.t >= T_PREP) c.stage = "run";
        if (c.stage === "run" && c.t >= T_PREP + T_RUN) { c.stage = "fly"; c.struck = true; c.tK = c.t; S.shake = 0.4; snd("kick"); }
        if (c.stage === "fly") {
          const s = Math.min(1, (c.t - c.tK) / T_FLY), p = ballAt(c, s);
          S.ball.x = p.x; S.ball.y = p.y; S.ball.z = p.z; S.ball.spin += sdt * 24;
          S.trail.unshift({ x: p.x, y: p.y, z: p.z }); if (S.trail.length > 9) S.trail.pop();
          const kd = clamp((c.t - c.tK - 0.05) / 0.5, 0, 1), ke = 1 - Math.pow(1 - kd, 2);
          S.keeper.x = c.kx * ke; S.keeper.y = 0.92 + (c.ky - 0.92) * ke;
          S.keeper.rot = clamp((c.kx / 2.4) * 1.15, -1.35, 1.35) * ke * 0.9; S.keeper.dive = ke;
          if (s >= 1) { c.stage = "after"; onResult(); }
        } else if (c.stage === "after") {
          const u = c.t - c.tK - T_FLY, b = S.ball;
          b.spin += sdt * 18;
          if (c.res === "goal") { b.z = Math.min(12.8, b.z + sdt * 9 * Math.max(0, 1 - u * 1.6)); b.y = Math.max(0.12, b.y - sdt * (1.5 + u * 3)); b.x += sdt * (c.tx > 0 ? 0.4 : -0.4); if (u > 0.4) b.z = Math.min(12.5, b.z - sdt * 0.6); }
          else if (c.res === "save") { if (!c.dfl) c.dfl = { vx: rnd(-3.5, 3.5), vy: rnd(2, 4.5), vz: rnd(-6, -3) }; b.x += c.dfl.vx * sdt; b.y += c.dfl.vy * sdt; c.dfl.vy -= 9.8 * sdt; b.z += c.dfl.vz * sdt; if (b.y < 0.11) { b.y = 0.11; c.dfl.vy *= -0.45; c.dfl.vx *= 0.7; c.dfl.vz *= 0.6; } }
          else if (c.res === "post") { if (!c.dfl) c.dfl = { vx: (c.post === "L" ? 1 : c.post === "R" ? -1 : pick([-1, 1])) * rnd(2, 4), vy: c.post === "T" ? rnd(-2, 0) : rnd(1, 3), vz: rnd(-8, -5) }; b.x += c.dfl.vx * sdt; b.y += c.dfl.vy * sdt; c.dfl.vy -= 9.8 * sdt; b.z += c.dfl.vz * sdt; if (b.y < 0.11) { b.y = 0.11; c.dfl.vy *= -0.45; } }
          else { b.z += sdt * 14; b.x += (c.tx > 0 ? 1 : -1) * sdt * 1.5; b.y += sdt * (c.wide === "U" ? 3 : -1.5); if (b.y < 0.11) b.y = 0.11; }
          S.trail.unshift({ x: b.x, y: b.y, z: b.z }); if (S.trail.length > 9) S.trail.pop();
          if (u > T_AFTER) { c.stage = "done"; S.phase = "between"; S.wait = T_GAP; S.cur = null; }
        }
      } else if (S.phase === "end") { S.endT += dt; }
      S.shake = Math.max(0, S.shake - dt * 3);
      if (S.shake > 0) { S.shx = R() - 0.5; S.shy = R() - 0.5; } else { S.shx = S.shy = 0; }
      for (const n of S.net) n.t += dt;
      if (S.flash > 0) S.flash -= dt * 2.4;
      const cc = S.cur;
      const prepZoom = cc && (cc.stage === "prep" || cc.stage === "run") ? 1 + 0.07 * Math.min(1, cc.t / (T_PREP + T_RUN)) : 1;
      const flyZoom = cc && (cc.stage === "fly" || cc.stage === "after") ? 1.1 : 1;
      S.zoom += ((cc ? Math.max(prepZoom, flyZoom) : 1) - S.zoom) * Math.min(1, dt * 3);
      const tension = cc && (cc.stage === "prep" || cc.stage === "run") ? 1 : 0;
      S.heart += (tension - S.heart) * Math.min(1, dt * 4);
      for (let i = S.sparks.length - 1; i >= 0; i--) {
        const s = S.sparks[i]; s.age += dt;
        if (s.age > s.life) { S.sparks.splice(i, 1); continue; }
        s.vy -= 8 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      }
    }

    // ---------- рисование ----------
    const line = (a, b) => { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); };
    function drawStadium(now) {
      const gr = g.createLinearGradient(0, 0, 0, HY() + 40);
      gr.addColorStop(0, "#04050b"); gr.addColorStop(0.6, "#161028"); gr.addColorStop(1, "#2c1634");
      g.fillStyle = gr; g.fillRect(0, 0, W, HY() + 60);
      spotlights(g, W, H, [0.08, 0.92, 0.3, 0.7], SC, 0.04);
      const top = P(0, 8.5, 21).y, bot = P(0, 1.0, 17).y;
      g.fillStyle = "#130f22"; g.fillRect(0, top, W, bot - top + 6);
      const cc = S.cur;
      const excite = cc && cc.stage === "after" && cc.res === "goal" ? 3 : cc ? 1 : 0.5;
      drawCrowd(g, crowd, 8, W, top, bot, now, excite, 0, 3 * SC * 1.2);
      const a = P(-16, 1.05, 13.8), b = P(16, 0, 13.8);
      g.fillStyle = "#0a0c12"; g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      const n = 9, w = (b.x - a.x) / n;
      g.font = "900 " + ((b.y - a.y) * 0.62) + "px " + DISP; g.textAlign = "center";
      for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? "#b6ff2e" : "#ff2e88"; g.globalAlpha = 0.85 + 0.15 * Math.sin(now * 3 + i); g.fillText(i % 2 ? i18t("pLime") : i18t("pTotal"), a.x + w * (i + 0.5), a.y + (b.y - a.y) * 0.72); }
      g.globalAlpha = 1; g.textAlign = "left";
    }
    function drawPitch() {
      for (let z = -8; z < 40; z += 3) {
        const k = Math.floor((z + 8) / 3) % 2, z0 = Math.max(z, CAMZ + 0.4);
        g.fillStyle = k ? "#13321f" : "#183a25";
        const p1 = P(-60, 0, z0), p2 = P(60, 0, z0), p3 = P(60, 0, z + 3), p4 = P(-60, 0, z + 3);
        g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.lineTo(p3.x, p3.y); g.lineTo(p4.x, p4.y); g.closePath(); g.fill();
      }
      g.strokeStyle = "rgba(255,255,255,.8)";
      const seg = (x1, z1, x2, z2, wd) => { wd = wd || 0.12; const a = P(x1, 0, Math.max(z1, CAMZ + 0.4)), b = P(x2, 0, Math.max(z2, CAMZ + 0.4)); g.lineWidth = Math.max(1, wd * (a.k + b.k) / 2); line(a, b); };
      seg(-40, GZ, 40, GZ);
      seg(-9.16, GZ, -9.16, GZ - 5.5); seg(9.16, GZ, 9.16, GZ - 5.5); seg(-9.16, GZ - 5.5, 9.16, GZ - 5.5);
      seg(-20.16, GZ, -20.16, GZ - 16.5); seg(20.16, GZ, 20.16, GZ - 16.5);
      const sp = P(0, 0, 0); g.fillStyle = "#fff"; g.beginPath(); g.ellipse(sp.x, sp.y, 0.16 * sp.k, 0.06 * sp.k, 0, 0, TAU); g.fill();
    }
    function drawNetAndGoal(front) {
      const hw = 3.66, hh = 2.44, bz = 13.1, bhw = 3.2, bhh = 2.15;
      if (!front) {
        g.strokeStyle = "rgba(235,240,245,.34)"; g.lineWidth = Math.max(1, 1.2 * SC);
        const disp = (x, y) => { let dz = 0; for (const n of S.net) { const r2 = (x - n.x * 0.9) ** 2 + (y - n.y) ** 2; dz += Math.exp(-r2 / 1.1) * Math.sin(n.t * 14) * Math.exp(-n.t * 2.2) * 0.9; } return dz; };
        const vx = 14, vy = 11;
        for (let i = 0; i <= vx; i++) {
          g.beginPath();
          for (let j = 0; j <= vy; j++) { const x = -bhw + 2 * bhw * i / vx, y = bhh * j / vy, p = P(x, y, bz + disp(x, y)); j ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }
          g.stroke();
        }
        for (let j = 0; j <= vy; j++) {
          g.beginPath();
          for (let i = 0; i <= vx; i++) { const x = -bhw + 2 * bhw * i / vx, y = bhh * j / vy, p = P(x, y, bz + disp(x, y)); i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }
          g.stroke();
        }
        for (let i = 0; i <= 8; i++) { const x = -hw + 2 * hw * i / 8; line(P(x, hh, GZ), P(x * bhw / hw, bhh, bz)); }
        for (let j = 0; j <= 5; j++) { const y = hh * j / 5; line(P(-hw, y, GZ), P(-bhw, y * bhh / hh, bz)); line(P(hw, y, GZ), P(bhw, y * bhh / hh, bz)); }
        return;
      }
      const cc = S.cur;
      const hit = cc && cc.res === "post" && cc.struck && cc.t > cc.tK + T_FLY - 0.05 ? Math.max(0, 1 - (cc.t - (cc.tK + T_FLY)) * 1.8) : 0;
      const a = P(-hw, 0, GZ), b = P(-hw, hh, GZ), c = P(hw, hh, GZ), d = P(hw, 0, GZ);
      g.lineCap = "round"; g.strokeStyle = hit ? "rgb(255," + Math.round(220 - hit * 100) + "," + Math.round(220 - hit * 140) + ")" : "#f4f7fa"; g.lineWidth = Math.max(3, 0.13 * a.k);
      g.shadowColor = hit ? "#ff2e88" : "rgba(255,255,255,.4)"; g.shadowBlur = 8 + hit * 30;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y); g.lineTo(d.x, d.y); g.stroke(); g.shadowBlur = 0; g.lineCap = "butt";
    }
    // ---- люди: сужающиеся конечности, форма с объёмом, голова с причёской. Координаты в метрах, y вниз, ноль у ног/бёдер ----
    const SKINS = ["#f0c8a0", "#d9a07a", "#b98660", "#8d5d3f"];
    const HAIRS = ["#241812", "#c9a24a", "#4a2c1a", "#16161a"];
    function shade(hex, f) {
      const n = parseInt(hex.slice(1), 16), r = Math.min(255, Math.round((n >> 16) * f)), gg = Math.min(255, Math.round(((n >> 8) & 255) * f)), bb = Math.min(255, Math.round((n & 255) * f));
      return "rgb(" + r + "," + gg + "," + bb + ")";
    }
    function taper(x1, y1, x2, y2, w1, w2, fill) {
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, a = Math.atan2(ny, nx);
      g.fillStyle = fill; g.beginPath();
      g.moveTo(x1 + nx * w1 / 2, y1 + ny * w1 / 2); g.lineTo(x2 + nx * w2 / 2, y2 + ny * w2 / 2);
      g.arc(x2, y2, w2 / 2, a, a - Math.PI, true); g.lineTo(x1 - nx * w1 / 2, y1 - ny * w1 / 2);
      g.arc(x1, y1, w1 / 2, a + Math.PI, a, true); g.closePath(); g.fill();
    }
    function boot(x, y, side, col, lifted) {
      g.save(); g.translate(x, y);
      g.fillStyle = "#14181f"; g.beginPath(); g.ellipse(side * 0.01, -0.01, 0.085, 0.055, 0, 0, TAU); g.fill();
      g.fillStyle = col; g.fillRect(-0.07, -0.045, 0.14, 0.018);                       // полоска цвета команды
      if (lifted > 0.25) { g.fillStyle = "#c9ced6"; g.fillRect(-0.06, 0.02, 0.12, 0.018); } // видна подошва
      g.restore();
    }
    function headBack(cx, cy, skin, hairC, style) {
      g.fillStyle = skin; g.beginPath(); g.ellipse(cx - 0.105, cy, 0.03, 0.04, 0, 0, TAU); g.ellipse(cx + 0.105, cy, 0.03, 0.04, 0, 0, TAU); g.fill();   // уши
      g.beginPath(); g.ellipse(cx, cy, 0.105, 0.125, 0, 0, TAU); g.fill();
      g.fillStyle = hairC; g.beginPath();
      if (style === 2) { g.globalAlpha = 0.45; g.ellipse(cx, cy - 0.025, 0.108, 0.1, 0, 0, TAU); g.fill(); g.globalAlpha = 1; }          // бритый: тень щетины
      else { g.ellipse(cx, cy - 0.02, 0.112, 0.115, 0, 0, TAU); g.fill(); if (style === 1) { g.beginPath(); g.moveTo(cx - 0.1, cy); g.quadraticCurveTo(cx, cy + 0.17, cx + 0.1, cy); g.lineTo(cx + 0.09, cy - 0.04); g.lineTo(cx - 0.09, cy - 0.04); g.closePath(); g.fill(); } }
    }
    function headFront(cx, cy, skin, hairC, mouthOpen) {
      g.fillStyle = skin; g.beginPath(); g.ellipse(cx - 0.115, cy + 0.01, 0.03, 0.042, 0, 0, TAU); g.ellipse(cx + 0.115, cy + 0.01, 0.03, 0.042, 0, 0, TAU); g.fill();
      g.beginPath(); g.ellipse(cx, cy, 0.112, 0.13, 0, 0, TAU); g.fill();
      g.fillStyle = hairC; g.beginPath(); g.ellipse(cx, cy - 0.06, 0.118, 0.085, 0, Math.PI, 0); g.fill();                       // чёлка
      g.fillStyle = "#fff"; g.beginPath(); g.ellipse(cx - 0.045, cy - 0.012, 0.024, 0.018, 0, 0, TAU); g.ellipse(cx + 0.045, cy - 0.012, 0.024, 0.018, 0, 0, TAU); g.fill();
      g.fillStyle = "#1b1f27"; g.beginPath(); g.arc(cx - 0.043, cy - 0.01, 0.011, 0, TAU); g.arc(cx + 0.047, cy - 0.01, 0.011, 0, TAU); g.fill();
      g.strokeStyle = hairC; g.lineWidth = 0.012; g.beginPath(); g.moveTo(cx - 0.07, cy - 0.04); g.lineTo(cx - 0.02, cy - 0.034); g.moveTo(cx + 0.02, cy - 0.034); g.lineTo(cx + 0.07, cy - 0.04); g.stroke();
      if (mouthOpen) { g.fillStyle = "#4a1018"; g.beginPath(); g.ellipse(cx, cy + 0.07, 0.03, 0.022 + 0.02 * mouthOpen, 0, 0, TAU); g.fill(); }
      else { g.strokeStyle = "#7a4a3a"; g.lineWidth = 0.012; g.beginPath(); g.moveTo(cx - 0.03, cy + 0.07); g.lineTo(cx + 0.03, cy + 0.07); g.stroke(); }
    }
    // вратарь: вид спереди, бедро в нуле; s — степень «броска» (руки вытянуты вверх и в стороны)
    function drawKeeper(kp) {
      const z = GZ + 0.2, sc = P(0, 0, z).k, base = P(kp.x, 0, z);
      g.save(); g.translate(base.x, base.y - kp.y * sc); g.rotate(kp.rot); g.scale(sc, sc);
      const s = kp.dive, kit = "#ffd34d", kitDark = shade(kit, 0.78), pants = "#1a212b", skin = "#e3b58f", hairC = "#2a1c14";
      g.lineJoin = "round";
      // ноги: носки, бутсы, трусы
      for (const d of [-1, 1]) {
        const hx = d * 0.1, kx = d * (0.15 + 0.08 * s), fx = d * (0.2 + 0.12 * s);
        taper(hx, 0.02, kx, 0.46, 0.2, 0.15, skin);
        taper(kx, 0.46, fx, 0.9, 0.15, 0.11, kit);
        boot(fx, 0.95, d, kit, 0);
        taper(hx, 0.0, d * (0.13 + 0.05 * s), 0.34, 0.25, 0.22, pants);
      }
      g.fillStyle = pants; g.fillRect(-0.19, -0.06, 0.38, 0.16);
      // майка с объёмом
      const gr = g.createLinearGradient(-0.27, 0, 0.27, 0); gr.addColorStop(0, kitDark); gr.addColorStop(0.5, kit); gr.addColorStop(1, kitDark);
      g.fillStyle = gr; g.beginPath(); g.moveTo(-0.19, 0.0); g.lineTo(-0.25, -0.34); g.quadraticCurveTo(-0.28, -0.5, -0.2, -0.58); g.lineTo(0.2, -0.58); g.quadraticCurveTo(0.28, -0.5, 0.25, -0.34); g.lineTo(0.19, 0.0); g.closePath(); g.fill();
      g.fillStyle = "#1a212b"; g.font = "900 0.26px " + DISP; g.textAlign = "center"; g.fillText("1", 0, -0.22); g.textAlign = "left";
      // руки: длинные рукава и большие перчатки
      for (const d of [-1, 1]) {
        const sx = d * 0.27, sy = -0.5, hx = d * (0.45 + 0.28 * s), hy = -(0.62 + 0.78 * s), ex = (sx + hx) / 2 + d * 0.03, ey = (sy + hy) / 2;
        taper(sx, sy, ex, ey, 0.15, 0.13, kit); taper(ex, ey, hx, hy, 0.13, 0.1, kit);
        g.fillStyle = "#f4f6f8"; g.beginPath(); g.arc(hx, hy, 0.1, 0, TAU); g.fill();                                                    // ладонь
        g.fillStyle = "#e2e6ea"; for (let f = -1; f <= 1; f++) { g.beginPath(); g.arc(hx + f * 0.05, hy - 0.085, 0.032, 0, TAU); g.fill(); } // пальцы
        g.fillStyle = "#14181f"; g.fillRect(hx - 0.08, hy + 0.04, 0.16, 0.026);                                                          // манжета
      }
      taper(0, -0.55, 0, -0.65, 0.12, 0.11, skin);
      headFront(0, -0.78, skin, hairC, 0.4 + 0.6 * s);
      g.restore();
    }
    // бьющий: вид со спины, у ног начало координат; бежит к мячу, бьёт правой
    function drawKicker(c) {
      const team = TEAM[c.team];
      const run = clamp((c.t - T_PREP) / T_RUN, 0, 1), e = run * run * (3 - 2 * run);
      const z = -3.6 + 2.9 * e, x = -2.6 + 1.6 * e;
      const sc = P(0, 0, z).k, base = P(x, 0, z);
      const kick = c.struck ? Math.max(0, 1 - (c.t - c.tK) * 2.6) : 0;
      const gone = c.struck ? clamp((c.t - c.tK) / 0.5, 0, 1) : 0;
      const moving = run > 0 && run < 1 && !c.struck;
      const ph = run * 5 * TAU, bob = moving ? Math.abs(Math.sin(ph)) * 0.035 : 0;
      const skin = SKINS[c.n % 4], hairC = HAIRS[(c.n + 1) % 4], hairStyle = c.n % 3;
      const jersey = team.col, dark = shade(jersey, 0.72), shorts = "#101820";
      g.save(); g.globalAlpha = 1 - gone; g.translate(base.x - gone * 140, base.y); g.scale(sc, sc);
      g.lineJoin = "round"; g.lineCap = "round";
      g.fillStyle = "rgba(0,0,0,.38)"; g.beginPath(); g.ellipse(0, 0.02, 0.44, 0.12, 0, 0, TAU); g.fill();       // тень под ногами
      const hipY = -(0.97 - bob);
      // ноги: шаг от фазы бега; бьющая правая уходит вперёд-вверх после удара
      for (const sd of [-1, 1]) {
        const sw = moving ? Math.sin(ph + (sd > 0 ? 0 : Math.PI)) : 0, fw = Math.max(0, sw), bk = Math.max(0, -sw), ka = sd > 0 ? kick : 0;
        const fx = sd * (0.13 + 0.04 * ka), fy = -(0.07 + 0.3 * fw + 0.22 * bk + 0.55 * ka);
        const kx = sd * (0.15 + 0.03 * fw), ky = -(0.52 + 0.1 * fw + 0.05 * bk + 0.28 * ka);
        taper(sd * 0.1, hipY, kx, ky, 0.2, 0.16, skin);
        taper(kx, ky, fx, fy, 0.16, 0.115, jersey);                                                               // гетры цвета команды
        g.fillStyle = dark; g.fillRect(Math.min(kx, fx) - 0.09, (ky + fy) / 2 - 0.012, 0.18, 0.022);              // кольцо на гетре
        boot(fx, fy, sd, jersey, fw + bk + ka);
        taper(sd * 0.1, hipY, sd * (0.12 + 0.01 * fw), hipY + 0.2, 0.25, 0.22, shorts);                          // штанина трусов
      }
      g.fillStyle = shorts; g.beginPath(); g.moveTo(-0.2, hipY - 0.05); g.lineTo(0.2, hipY - 0.05); g.lineTo(0.2, hipY + 0.1); g.lineTo(-0.2, hipY + 0.1); g.closePath(); g.fill();
      // майка со спины: градиент по ширине, шов по позвоночнику, номер
      const gr = g.createLinearGradient(-0.27, 0, 0.27, 0); gr.addColorStop(0, dark); gr.addColorStop(0.45, jersey); gr.addColorStop(1, dark);
      g.fillStyle = gr; g.beginPath(); g.moveTo(-0.19, hipY + 0.02); g.lineTo(-0.245, -1.3 - bob); g.quadraticCurveTo(-0.275, -1.46 - bob, -0.2, -1.53 - bob); g.lineTo(0.2, -1.53 - bob);
      g.quadraticCurveTo(0.275, -1.46 - bob, 0.245, -1.3 - bob); g.lineTo(0.19, hipY + 0.02); g.closePath(); g.fill();
      g.strokeStyle = "rgba(0,0,0,.16)"; g.lineWidth = 0.012; g.beginPath(); g.moveTo(0, -1.5 - bob); g.lineTo(0, hipY); g.stroke();
      g.fillStyle = team.dark; g.font = "900 0.34px " + DISP; g.textAlign = "center"; g.fillText(String(c.n + 7), 0, -1.12 - bob); g.textAlign = "left";
      // руки: размах против шага; перед ударом разведены
      for (const sd of [-1, 1]) {
        const an = moving ? Math.sin(ph + (sd > 0 ? 0 : Math.PI) + Math.PI) : 0, up = Math.max(0, an), open = c.struck ? Math.max(0.0, 1 - (c.t - c.tK) * 1.4) : 0;
        const shx = sd * 0.27, shy = -1.47 - bob, ex = sd * (0.33 + 0.03 * up + 0.14 * open), ey = -1.2 + 0.1 * up, hx = sd * (0.31 + 0.26 * open), hy = -0.98 + 0.28 * up - 0.18 * open;
        taper(shx, shy, (shx + ex) / 2, (shy + ey) / 2, 0.16, 0.14, jersey);                                   // короткий рукав
        taper((shx + ex) / 2, (shy + ey) / 2, ex, ey, 0.1, 0.085, skin); taper(ex, ey, hx, hy, 0.085, 0.07, skin);
        g.fillStyle = skin; g.beginPath(); g.arc(hx, hy, 0.045, 0, TAU); g.fill();
      }
      taper(0, -1.5 - bob, 0, -1.62 - bob, 0.12, 0.11, skin);
      headBack(0, -1.74 - bob, skin, hairC, hairStyle);
      g.restore();
    }
    function drawBall(b) {
      const p = P(b.x, b.y, b.z), r = Math.max(2.5, 0.11 * p.k);
      const sh = P(b.x, 0, b.z); g.fillStyle = "rgba(0,0,0,.35)"; g.beginPath(); g.ellipse(sh.x, sh.y, r * 1.1, r * 0.4, 0, 0, TAU); g.fill();
      g.save(); g.translate(p.x, p.y); g.rotate(b.spin);
      const gr = g.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r); gr.addColorStop(0, "#fff"); gr.addColorStop(1, "#c7ccd3");
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
      g.fillStyle = "#1c2128"; for (let i = 0; i < 5; i++) { const a = i * 1.2566 + 0.3; g.beginPath(); g.arc(Math.cos(a) * r * 0.58, Math.sin(a) * r * 0.58, r * 0.2, 0, TAU); g.fill(); }
      g.beginPath(); g.arc(0, 0, r * 0.22, 0, TAU); g.fill();
      g.restore();
    }

    // табло серии в углу холста: команды, точки ударов (5 + «до первой ошибки»), счёт
    function drawScoreboard() {
      const u = Math.max(0.7, Math.min(1.4, SC * 1.15)), pad = 10 * u, x0 = 12 * u, y0 = 12 * u, rowH = 30 * u;
      const nSd = sdList.length;
      const dotR = 7 * u, gap = 4 * u;
      const dotsW = (5 + nSd) * (dotR * 2 + gap);
      g.font = "900 " + (17 * u) + "px " + DISP;
      const nameW = Math.max(g.measureText(TEAM.A.name.toUpperCase()).width, g.measureText(TEAM.B.name.toUpperCase()).width) + 6;
      const w = pad * 2 + nameW + dotsW + 40 * u, h = rowH * 2 + pad * 2 + (S.cur && S.cur.sd ? 18 * u : 0);
      const wMax = Math.min(w, W - 24 * u);
      g.fillStyle = "rgba(6,8,12,.82)"; g.fillRect(x0, y0, wMax, h);
      g.strokeStyle = "#26323b"; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, wMax - 1, h - 1);
      ["A", "B"].forEach((t, row) => {
        const y = y0 + pad + row * rowH + rowH / 2;
        g.fillStyle = TEAM[t].col; g.fillRect(x0, y - rowH / 2 + 2 * u, 4 * u, rowH - 4 * u);
        g.font = "900 " + (17 * u) + "px " + DISP; g.fillStyle = "#fff"; g.textAlign = "left"; g.fillText(TEAM[t].name.toUpperCase(), x0 + pad, y + 6 * u);
        const doneUpTo = (j) => j < S.hist.length;
        const drawDot = (j, i, isSd) => {
          const cx = x0 + pad + nameW + (isSd ? i + 5 : i) * (dotR * 2 + gap) + dotR + (isSd ? gap * 2 : 0);
          if (cx + dotR > x0 + wMax) return;
          const idx = j;
          const done = idx >= 0 && doneUpTo(idx), cur = idx >= 0 && idx === S.k && !done && !!S.cur;
          let col = "#1a232b", stroke = "#33434f";
          if (done) { const res = seq[idx].res; col = res === "goal" ? TEAM[t].col : "#3a1626"; stroke = res === "goal" ? TEAM[t].col : "#ff2e88"; }
          g.fillStyle = col; g.strokeStyle = cur ? "#fff" : stroke; g.lineWidth = cur ? 2 : 1.5;
          g.beginPath(); g.arc(cx, y, dotR * (isSd ? 0.8 : 1), 0, TAU); g.fill(); g.stroke();
          if (done && seq[idx].res !== "goal") { g.strokeStyle = "#ff2e88"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx - dotR * 0.4, y - dotR * 0.4); g.lineTo(cx + dotR * 0.4, y + dotR * 0.4); g.moveTo(cx + dotR * 0.4, y - dotR * 0.4); g.lineTo(cx - dotR * 0.4, y + dotR * 0.4); g.stroke(); }
        };
        for (let i = 0; i < 5; i++) drawDot(dotIdx[t].reg[i] === undefined ? -1 : dotIdx[t].reg[i], i, false);
        for (let i = 0; i < nSd; i++) drawDot(dotIdx[t].sd[i] === undefined ? -1 : dotIdx[t].sd[i], i, true);
        g.font = "900 " + (28 * u) + "px " + DISP; g.textAlign = "right"; g.fillStyle = "#fff"; g.fillText(String(S[t]), x0 + wMax - pad, y + 9 * u); g.textAlign = "left";
      });
      if (S.cur && S.cur.sd) { g.font = "800 " + (11 * u) + "px " + MONO; g.fillStyle = "#ffd34d"; g.fillText(i18t("pSdBar"), x0 + pad, y0 + h - 7 * u); }
    }
    // плашка «кто бьёт» внизу слева
    function drawWho() {
      const c = S.cur; if (!c || c.stage === "done") return;
      const u = Math.max(0.7, Math.min(1.4, SC * 1.15)), team = TEAM[c.team];
      const man = team.men[c.n], pct = Math.round((c.sd ? sdCls[c.team] : (cls[c.team][c.n] || 700)) / 10);
      const x = 14 * u, y = H - 70 * u;
      g.font = "900 " + (30 * u) + "px " + DISP; const w1 = g.measureText(man.toUpperCase()).width;
      g.font = "700 " + (12 * u) + "px " + MONO;
      const sub = team.name + " · №" + (c.n + 1) + (c.sd ? i18t("pSdSub") : "") + i18t("pChance", { p: pct });
      const w = Math.min(W - 28 * u, Math.max(w1, g.measureText(sub).width) + 28 * u);
      g.fillStyle = "rgba(6,8,12,.82)"; g.fillRect(x, y, w, 58 * u);
      g.fillStyle = team.col; g.fillRect(x, y, 4 * u, 58 * u);
      g.fillStyle = team.col; g.font = "900 " + (30 * u) + "px " + DISP; g.font = "900 " + fitSize(g, man.toUpperCase(), 900, 30 * u, DISP, w - 22 * u) + "px " + DISP; g.fillText(man.toUpperCase(), x + 14 * u, y + 30 * u);
      g.fillStyle = "#9fb0b8"; g.font = "700 " + fitSize(g, sub, 700, 12 * u, MONO, w - 22 * u) + "px " + MONO; g.fillText(sub, x + 14 * u, y + 49 * u);
    }

    function draw() {
      L.fit(); g = L.g; W = L.W; H = L.H; SC = Math.min(W / 1280, H / 720);
      const now = S.clk, c = S.cur;
      g.save();
      g.translate(W / 2 + S.shx * 7 * SC, H * 0.45 + S.shy * 6 * SC);
      g.scale(S.zoom, S.zoom); g.translate(-W / 2, -H * 0.45);
      drawStadium(now);
      drawPitch();
      drawNetAndGoal(false);
      drawKeeper(S.keeper);
      const ball = S.ball, inside = ball.z > GZ;
      if (inside) drawBall(ball);
      drawNetAndGoal(true);
      if (S.trail.length > 1 && c && (c.stage === "fly" || c.stage === "after")) {
        for (let i = 1; i < S.trail.length; i++) { const p = P(S.trail[i].x, S.trail[i].y, S.trail[i].z); g.globalAlpha = (1 - i / S.trail.length) * 0.35; g.fillStyle = "#fff"; g.beginPath(); g.arc(p.x, p.y, Math.max(1.5, 0.08 * p.k * (1 - i / 12)), 0, TAU); g.fill(); }
        g.globalAlpha = 1;
      }
      if (!inside) drawBall(ball);
      if (c && c.stage !== "done") drawKicker(c);
      for (const s of S.sparks) { const p = P(s.x, s.y, s.z); g.globalAlpha = Math.max(0, 1 - s.age / s.life); g.fillStyle = "#ffd34d"; g.beginPath(); g.arc(p.x, p.y, 2.2 * SC + 0.5, 0, TAU); g.fill(); }
      g.globalAlpha = 1;
      g.restore();

      const beat = (0.5 + 0.5 * Math.sin(now * 7)) * S.heart;
      const vg = g.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.95);
      vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(" + Math.round(30 + beat * 120) + ",0," + Math.round(20 + beat * 30) + "," + (0.5 + beat * 0.2) + ")");
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
      if (S.flash > 0) { g.fillStyle = "rgba(255,255,255," + Math.min(0.6, S.flash) + ")"; g.fillRect(0, 0, W, H); }
      drawScoreboard();
      drawWho();
      if (S.phase === "end") {
        const k = Math.min(1, S.endT / 0.4), w = out.winner;
        g.globalAlpha = k;
        g.fillStyle = "rgba(6,8,12," + (0.55 * k) + ")"; g.fillRect(0, H * 0.28, W, H * 0.36);
        glowText(g, i18t("pWin", { team: TEAM[w].name.toUpperCase() }), W / 2, H * 0.44, Math.min(H * 0.14, W / 12), TEAM[w].col, null, "center", W * 0.94);
        glowText(g, out.goalsA + " : " + out.goalsB + (sdList.length ? i18t("pPairs", { n: sdList.length }) : ""), W / 2, H * 0.58, Math.min(H * 0.1, W / 18), "#fff", TEAM[w].col);
        g.globalAlpha = 1;
      }
    }

    return {
      start, step, draw,
      done: () => play && S.phase === "end" && S.endT > T_END,
      debug: () => ({ sig: sig(S), type: "penalties", phase: S.phase, scoreA: S.A, scoreB: S.B, goalsA: out.goalsA, goalsB: out.goalsB, winner: out.winner, kicksShown: S.hist.length, kicksTotal: seq.length, sd: sdList.length }),
    };
  }

  /* =====================================================================================
   *  💪 Канат. Исход: {pulls:[0|1]×41, winsA, winner, minDiff, maxDiff}; input.s — сила A в ‰; meta {A, B} — имена бойцов.
   * ===================================================================================== */
  function ropeMake(o, env) {
    const L = env.L, play = o.mode === "play", PULLS = 41;
    const R = mulberry32(play ? (o.seed | 0) : 55);
    const rnd = (a, b) => a + R() * (b - a);
    const meta = o.meta || {};
    const nm = (v, def) => (v && typeof v === "object" ? String(v.name || def) : v ? String(v) : def);
    const HERO = {
      A: { name: nm(meta.A, "Бугай"), col: "#b6ff2e", dark: "#07090c", skin: "#e8b48a" },
      B: { name: nm(meta.B, "Жила"), col: "#ff2e88", dark: "#ffffff", skin: "#d9a07a" },
    };
    const out = o.outcome && Array.isArray(o.outcome.pulls) && o.outcome.pulls.length ? o.outcome : { pulls: [], winsA: 0, winner: "B", minDiff: 0, maxDiff: 0 };
    const pulls = out.pulls;
    const T_INTRO = 1.2, T_END = 3.2;
    const S = {
      phase: play ? "intro" : "idle", clk: 0, wait: T_INTRO, k: -1, pt: 0, dur: 0.5, d: 0, dFrom: 0, dTo: 0, a: 0, b: 0, ts: 1, w: "A",
      lean: { A: 0.15, B: 0.15 }, jerk: { A: 0, B: 0 }, streak: 0, lastWinner: null, parts: [], shake: 0, shx: 0, shy: 0, flash: 0, said: {}, endT: 0, tight: false,
    };
    const crowd = makeCrowd(3, 360, 7);
    let W = 0, H = 0, SC = 1, g = null;
    const say = env.say;
    const ease2 = (t) => t * t * (3 - 2 * t);
    const easeBack = (t) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
    const ln = (t) => "<em>" + esc(HERO[t].name) + "</em>";
    void ease2;

    const start = () => { if (play) say(i18t("tStart")); };

    function nextPull() {
      S.k++;
      if (S.k >= PULLS || S.k >= pulls.length) { finish(); return; }
      const w = pulls[S.k] ? "A" : "B";
      S.dFrom = S.d; S.dTo = S.d + (w === "A" ? 1 : -1);
      const prev = S.lastWinner;
      S.streak = prev === w ? S.streak + 1 : 1;
      const left = PULLS - 1 - S.k, decided = Math.abs(S.dTo) > left, tight = !decided && left <= 6;
      S.dur = decided ? 0.3 : tight ? 0.9 : S.streak >= 3 ? 0.36 : prev && prev !== w ? 0.62 : 0.48;
      S.pt = 0; S.w = w; S.lastWinner = w; S.phase = "pull"; S.tight = tight;
      S.jerk[w] = 1; S.jerk[w === "A" ? "B" : "A"] = -1;
      if (w === "A") S.a++; else S.b++;
      if (S.streak === 3) { say(i18t("tStreak3", { h: ln(w) })); env.stamp(i18t("tStreakStamp"), "neutral"); S.shake = 0.7; env.snd("crowd"); }
      else if (S.streak === 5) { say(i18t("tStreak5", { h: ln(w) })); S.shake = 1; env.snd("crowd"); }
      else if ((prev && prev !== w && Math.abs(S.dFrom) >= 4 && Math.sign(S.dTo) !== Math.sign(S.dFrom)) || (Math.abs(S.dFrom) >= 4 && Math.sign(S.dFrom) === (w === "A" ? -1 : 1) && Math.abs(S.dTo) === Math.abs(S.dFrom) - 1 && Math.abs(S.dTo) <= 1)) say(i18t("tBack", { h: ln(w) }));
      if (!S.said.mid && S.k === 20) { S.said.mid = 1; say(i18t("tMid", { a: S.a, b: S.b })); }
      if (tight && !S.said.tight) { S.said.tight = 1; say(i18t("tTight")); env.stamp(i18t("tTightStamp"), "neutral"); }
      if (decided && !S.said.dec) { S.said.dec = 1; say(i18t("tDec", { h: ln(w) })); }
      env.snd("pull");
    }
    function finish() {
      S.phase = "end"; S.endT = 0;
      const wn = out.winner, cb = (wn === "A" && out.minDiff <= -5) || (wn === "B" && out.maxDiff >= 5);
      S.cb = cb;
      env.stamp(cb ? i18t("tComeback") : i18t("pWin", { team: HERO[wn].name.toUpperCase() }), "win");
      const win = wn === "A" ? out.winsA : PULLS - out.winsA, lose = PULLS - win;
      say(i18t("tWinSay", { h: ln(wn), w: win, l: lose }) + (cb ? i18t("tWinCb", { n: wn === "A" ? -out.minDiff : out.maxDiff }) : ""));
      S.flash = 0.4; S.shake = 1.4; env.snd("win");
    }

    function step(dt) {
      S.clk += dt;
      const target = S.phase === "pull" && S.tight ? 0.7 : 1;
      S.ts += (target - S.ts) * Math.min(1, dt * 6);
      const sdt = dt * S.ts;
      if (S.phase === "intro") { S.wait -= dt; if (S.wait <= 0) nextPull(); }
      else if (S.phase === "pull") {
        S.pt += sdt / S.dur;
        const e = easeBack(Math.min(1, S.pt));
        S.d = S.dFrom + (S.dTo - S.dFrom) * e;
        if (S.pt >= 1) { S.d = S.dTo; S.phase = "gap"; S.wait = S.tight ? 0.25 : 0.04; S.shake = Math.max(S.shake, 0.25); }
      } else if (S.phase === "gap") { S.wait -= sdt; if (S.wait <= 0) nextPull(); }
      else if (S.phase === "end") S.endT += dt;
      ["A", "B"].forEach((t) => {
        const tg = S.phase === "pull" ? (S.jerk[t] > 0 ? 0.62 : -0.05) : S.phase === "end" ? 0 : 0.25;
        S.lean[t] += (tg - S.lean[t]) * Math.min(1, dt * (S.phase === "pull" ? 14 : 5));
      });
      S.shake = Math.max(0, S.shake - dt * 2.5);
      if (S.shake > 0) { S.shx = R() - 0.5; S.shy = R() - 0.5; } else { S.shx = S.shy = 0; }
      if (S.flash > 0) S.flash -= dt * 2.2;
      // частицы (в единицах холста при SC=1; якорь выбирает draw)
      if (S.phase === "pull" && R() < dt * 45) {
        const loser = S.jerk.A < 0 ? "A" : "B", winner = loser === "A" ? "B" : "A";
        S.parts.push({ t: "dust", side: loser, ox: (loser === "A" ? 1 : -1) * 0, oy: 0, vx: (loser === "A" ? 1 : -1) * rnd(40, 160), vy: rnd(-60, -10), life: rnd(0.4, 0.9), age: 0, r: rnd(3, 7) });
        S.parts.push({ t: "spark", side: winner, ox: 0, oy: 0, vx: rnd(-80, 80), vy: rnd(-140, -30), life: rnd(0.3, 0.6), age: 0, r: rnd(1.5, 3) });
        if (R() < 0.5) { const sd = R() < 0.5 ? "A" : "B"; S.parts.push({ t: "sweat", side: sd, ox: 0, oy: 0, vx: rnd(-40, 40), vy: rnd(-90, -20), life: 0.7, age: 0, r: 2.5 }); }
      }
      for (let i = S.parts.length - 1; i >= 0; i--) {
        const p = S.parts[i]; p.age += dt;
        if (p.age > p.life) { S.parts.splice(i, 1); continue; }
        p.vy += (p.t === "dust" ? 40 : 300) * dt; p.ox += p.vx * dt; p.oy += p.vy * dt;
      }
    }

    // ---------- рисование ----------
    function drawBg(now, cx, hype) {
      let gr = g.createLinearGradient(0, 0, 0, H * 0.5);
      gr.addColorStop(0, "#04050b"); gr.addColorStop(0.6, "#161028"); gr.addColorStop(1, "#2c1634"); g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.55);
      spotlights(g, W, H, [0.1, 0.35, 0.65, 0.9], SC, 0.04);
      const top = H * 0.17, bot = H * 0.52; g.fillStyle = "#130f22"; g.fillRect(0, top, W, bot - top);
      drawCrowd(g, crowd, 7, W, top, bot, now, 0.6 + hype * 3.2, cx * 0.15, 3.5 * SC * 1.2);
      drawBoards(g, W, H * 0.52, H * 0.07, [i18t("tBoardA"), i18t("tBoardB")], now, cx * 0.4);
    }
    function drawFloor(cx, d) {
      const top = H * 0.52;
      const gr = g.createLinearGradient(0, top, 0, H); gr.addColorStop(0, "#1a2a2e"); gr.addColorStop(1, "#0a1012"); g.fillStyle = gr; g.fillRect(0, top, W, H - top);
      const U = 36 * SC;
      for (let m = -60; m <= 60; m++) {
        const x = cx + (m + d) * U; if (x < -20 || x > W + 20) continue;
        const major = m % 5 === 0, zero = m === 0;
        g.strokeStyle = zero ? "#ff2e88" : major ? "rgba(255,255,255,.4)" : "rgba(255,255,255,.12)"; g.lineWidth = zero ? 4 : major ? 2 : 1;
        if (zero) { g.shadowColor = "#ff2e88"; g.shadowBlur = 14; }
        g.beginPath(); g.moveTo(x, top + 6); g.lineTo(x - (x - cx) * 0.18, H); g.stroke(); g.shadowBlur = 0;
        if (major && !zero) { g.fillStyle = "rgba(255,255,255,.35)"; g.font = "800 " + (12 * Math.max(0.8, SC)) + "px " + MONO; g.textAlign = "center"; g.fillText(Math.abs(m), x, top + 22 * SC); g.textAlign = "left"; }
      }
      g.strokeStyle = "rgba(182,255,46,.35)"; g.lineWidth = 2; g.shadowColor = "#b6ff2e"; g.shadowBlur = 8;
      g.beginPath(); g.moveTo(0, top + 2); g.lineTo(W, top + 2); g.stroke(); g.shadowBlur = 0;
    }
    function limb(x1, y1, x2, y2, w, col) { g.strokeStyle = col; g.lineWidth = w; g.lineCap = "round"; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
    function drawFighter(x, gy, dir, lean, hero, mood, now) {
      const s = SC * 1.15, shake = (mood === "pull" ? Math.sin(now * 40) * 1.2 : 0);
      g.save(); g.translate(x + shake, gy); g.scale(s * dir, s);
      const col = hero.col, skin = hero.skin, pants = "#232a35";
      const hipY = -78 + (mood === "stumble" ? 10 : 0), hipX = -lean * 46;
      const shX = hipX - Math.sin(lean) * 62, shY = hipY - Math.cos(lean) * 62;
      const handX = 96, handY = -128;
      const spread = 26 + lean * 52;
      limb(hipX, hipY, hipX + spread, 0, 17, pants); limb(hipX + spread, 0, hipX + spread + 20, 0, 13, "#10151c");
      limb(hipX, hipY, hipX - spread * 0.9, 0, 18, pants); limb(hipX - spread * 0.9, 0, hipX - spread * 0.9 + 20, 0, 13, "#10151c");
      limb(hipX, hipY, shX, shY, 46, col);
      g.fillStyle = hero.dark; g.font = "900 24px " + DISP; g.textAlign = "center";
      g.save(); g.translate((hipX + shX) / 2, (hipY + shY) / 2 + 8); g.scale(dir, 1); g.fillText(hero.name.charAt(0).toUpperCase(), 0, 0); g.restore(); g.textAlign = "left";
      limb(shX + 4, shY + 4, handX, handY, 13, col); limb(shX - 6, shY + 8, handX - 10, handY + 6, 12, skin);
      g.fillStyle = skin; g.beginPath(); g.arc(handX, handY, 9, 0, TAU); g.fill();
      const hx = shX + 8, hy = shY - 26;
      g.fillStyle = skin; g.beginPath(); g.arc(hx, hy, 20, 0, TAU); g.fill();
      g.fillStyle = "#2a1c18"; g.beginPath(); g.arc(hx - 3, hy - 6, 20, Math.PI * 1.05, Math.PI * 1.95); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(hx + 10, hy - 3, 4, 0, TAU); g.fill(); g.fillStyle = "#111"; g.beginPath(); g.arc(hx + 11, hy - 3, 2, 0, TAU); g.fill();
      g.strokeStyle = "#111"; g.lineWidth = 3; g.beginPath(); g.moveTo(hx + 4, hy - 11); g.lineTo(hx + 16, hy - 8); g.stroke();
      if (mood === "pull") { g.fillStyle = "#3a0b17"; g.beginPath(); g.ellipse(hx + 12, hy + 9, 6, 8, 0, 0, TAU); g.fill(); }
      else { g.strokeStyle = "#111"; g.lineWidth = 3; g.beginPath(); g.moveTo(hx + 7, hy + 10); g.lineTo(hx + 16, hy + 10); g.stroke(); }
      g.restore();
      return { hx: x + dir * handX * s, hy: gy + handY * s };
    }
    // HUD: имена, счёт, номер рывка и шкала перевеса — всё внутри холста
    function drawHud() {
      const u = clamp(SC * 1.1, 0.6, 1.3), bw = Math.min(W * 0.92, 760 * u), x0 = (W - bw) / 2, y0 = 10 * u;
      g.textBaseline = "alphabetic";
      // имя + счёт
      g.font = "900 " + (20 * u) + "px " + DISP;
      g.fillStyle = HERO.A.col; g.textAlign = "left"; g.fillText(HERO.A.name.toUpperCase(), x0, y0 + 40 * u);
      const wA = g.measureText(HERO.A.name.toUpperCase()).width;
      g.font = "900 " + (46 * u) + "px " + DISP; g.fillStyle = "#fff"; g.fillText(String(S.a), x0 + wA + 10 * u, y0 + 40 * u);
      g.font = "900 " + (20 * u) + "px " + DISP; g.fillStyle = HERO.B.col; g.textAlign = "right"; g.fillText(HERO.B.name.toUpperCase(), x0 + bw, y0 + 40 * u);
      const wB = g.measureText(HERO.B.name.toUpperCase()).width;
      g.font = "900 " + (46 * u) + "px " + DISP; g.fillStyle = "#fff"; g.fillText(String(S.b), x0 + bw - wB - 10 * u, y0 + 40 * u);
      // номер рывка по центру
      g.textAlign = "center"; g.font = "700 " + (11 * u) + "px " + MONO;
      const txt = i18t("tPull", { k: Math.max(0, S.k + (S.phase === "pull" ? 1 : 0)), n: PULLS });
      const tw = g.measureText(txt).width + 16 * u;
      g.fillStyle = "rgba(6,8,12,.7)"; g.fillRect(W / 2 - tw / 2, y0 + 22 * u, tw, 18 * u);
      g.fillStyle = "#9fb0b8"; g.fillText(txt, W / 2, y0 + 35 * u);
      // шкала: метка уезжает к лидеру, заливка от центра до метки в цвете лидера
      const by = y0 + 48 * u, bh = 12 * u;
      g.fillStyle = "#151c22"; g.fillRect(x0, by, bw, bh); g.strokeStyle = "#26323b"; g.lineWidth = 1; g.strokeRect(x0 + 0.5, by + 0.5, bw - 1, bh - 1);
      const mx = x0 + bw / 2 - S.d / PULLS * (bw / 2);
      if (S.d > 0.001) { const gr = g.createLinearGradient(x0 + bw / 2, 0, mx, 0); gr.addColorStop(0, "rgba(182,255,46,.1)"); gr.addColorStop(1, "rgba(182,255,46,.7)"); g.fillStyle = gr; g.fillRect(mx, by, x0 + bw / 2 - mx, bh); }
      else if (S.d < -0.001) { const gr = g.createLinearGradient(x0 + bw / 2, 0, mx, 0); gr.addColorStop(0, "rgba(255,46,136,.1)"); gr.addColorStop(1, "rgba(255,46,136,.7)"); g.fillStyle = gr; g.fillRect(x0 + bw / 2, by, mx - (x0 + bw / 2), bh); }
      g.fillStyle = "rgba(255,255,255,.33)"; g.fillRect(x0 + bw / 2 - 1, by - 3 * u, 2, bh + 6 * u);
      g.shadowColor = "#fff"; g.shadowBlur = 12; g.fillStyle = "#fff"; g.fillRect(mx - 3 * u, by - 5 * u, 6 * u, bh + 10 * u); g.shadowBlur = 0;
      g.textAlign = "left";
    }

    function draw() {
      L.fit(); g = L.g; W = L.W; H = L.H; SC = Math.min(W / 1100, H / 620);
      const now = S.clk, cx = W / 2;
      const hype = Math.min(1, (S.streak >= 3 ? 0.6 : 0.15) + (S.phase === "end" ? 0.8 : 0) + (S.tight ? 0.3 : 0));
      g.save(); g.translate(S.shx * 7 * SC, S.shy * 5 * SC);
      const d = S.d;
      drawBg(now, d * 36, hype);
      drawFloor(cx, d);
      const gy = H * 0.86, span = 255 * SC * 1.15;
      const endFall = S.phase === "end" ? Math.min(1, S.endT / 0.7) : 0;
      const winner = out.winner;
      const moodOf = (t) => S.phase === "pull" ? (S.jerk[t] > 0 ? "pull" : "stumble") : S.phase === "end" ? (t === winner ? "pull" : "stumble") : "idle";
      const ax = cx - span, bx = cx + span;
      const lA = S.lean.A + (S.phase === "end" && winner === "B" ? -0.4 * endFall : 0), lB = S.lean.B + (S.phase === "end" && winner === "A" ? -0.4 * endFall : 0);
      const hA = drawFighter(ax, gy, 1, lA, HERO.A, moodOf("A"), now), hB = drawFighter(bx, gy, -1, lB, HERO.B, moodOf("B"), now);
      const tension = S.phase === "pull" || S.phase === "gap" ? 1 : 0.5;
      const sag = (14 + 40 * (1 - tension)) * SC + Math.sin(now * 30) * (S.phase === "pull" ? 2 : 0);
      g.strokeStyle = "#e9d7a6"; g.lineWidth = 7 * SC; g.lineCap = "round"; g.beginPath(); g.moveTo(hA.hx, hA.hy);
      g.quadraticCurveTo(cx, hA.hy + sag, hB.hx, hB.hy); g.stroke();
      g.strokeStyle = "#8a7448"; g.lineWidth = 2; if (g.setLineDash) g.setLineDash([6, 5]); g.beginPath(); g.moveTo(hA.hx, hA.hy); g.quadraticCurveTo(cx, hA.hy + sag, hB.hx, hB.hy); g.stroke(); if (g.setLineDash) g.setLineDash([]);
      const my = hA.hy + sag * 0.5;
      g.fillStyle = "#ff2e88"; g.shadowColor = "#ff2e88"; g.shadowBlur = 14; g.fillRect(cx - 6 * SC, my - 16 * SC, 12 * SC, 34 * SC); g.shadowBlur = 0;
      g.fillStyle = "#fff"; g.fillRect(cx - 2 * SC, my - 16 * SC, 4 * SC, 34 * SC);
      // частицы
      for (const p of S.parts) {
        const a = 1 - p.age / p.life, hand = p.side === "A" ? hA : hB, fx = p.side === "A" ? ax : bx, dir = p.side === "A" ? 1 : -1;
        let x, y;
        if (p.t === "dust") { x = fx + dir * 20 * SC; y = gy; }
        else if (p.t === "spark") { x = hand.hx; y = hand.hy; }
        else { x = hand.hx - dir * 70 * SC; y = gy - 180 * SC; }
        g.globalAlpha = a * (p.t === "dust" ? 0.5 : 1); g.fillStyle = p.t === "dust" ? "#b8a98a" : p.t === "spark" ? "#ffd34d" : "#9fe6ff";
        g.beginPath(); g.arc(x + p.ox * SC, y + p.oy * SC, p.r * SC * (p.t === "dust" ? 1 + (1 - a) : 1), 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
      g.restore();
      vignette(g, W, H, 0.5, 0.45);
      if (S.flash > 0) { g.fillStyle = "rgba(255,255,255," + Math.min(0.6, S.flash) + ")"; g.fillRect(0, 0, W, H); }
      drawHud();
      if (S.phase === "end") {
        const k = Math.min(1, S.endT / 0.4), wn = out.winner;
        g.globalAlpha = k;
        g.fillStyle = "rgba(6,8,12," + (0.5 * k) + ")"; g.fillRect(0, H * 0.3, W, H * 0.22);
        glowText(g, S.cb ? i18t("tComeback") : i18t("tVictory"), W / 2, H * 0.4, Math.min(H * 0.13, W / 9), HERO[wn].col, null, "center", W * 0.9);
        glowText(g, HERO[wn].name.toUpperCase() + "  " + out.winsA + ":" + (PULLS - out.winsA), W / 2, H * 0.49, Math.min(H * 0.075, W / 16), "#fff", HERO[wn].col);
        g.globalAlpha = 1;
      }
    }

    return {
      start, step, draw,
      done: () => play && S.phase === "end" && S.endT > T_END,
      debug: () => ({ sig: sig(S), type: "rope", phase: S.phase, shownA: S.a, shownB: S.b, pullsShown: Math.max(0, S.k + (S.phase === "end" ? 0 : 0)), winner: out.winner, winsA: out.winsA, d: S.d }),
    };
  }


  // ---------- бокс: 5 раундов, нокаут или решение судей ----------
  function boxMake(o, env) {
    const L = env.L, play = o.mode === "play", ROUNDS = 5;
    const R = mulberry32(play ? (o.seed | 0) : 77);
    const rnd = (a, b) => a + R() * (b - a);
    const meta = o.meta || {};
    const nm = (v, def) => (v && typeof v === "object" ? String(v.name || def) : v ? String(v) : def);
    const FIG = {
      A: { name: nm(meta.A, "Громила"), col: "#b6ff2e", dark: "#07090c", skin: "#e0aa82", hair: "#241812" },
      B: { name: nm(meta.B, "Ураган"), col: "#ff2e88", dark: "#ffffff", skin: "#c98f68", hair: "#16161a" },
    };
    const out = o.outcome && o.outcome.winner ? o.outcome : { winner: "B", method: "DEC", round: ROUNDS, rounds: [], scoreA: 0, scoreB: 0 };
    const rounds = Array.isArray(out.rounds) ? out.rounds : [];
    const isKO = out.method === "KO", koBy = out.koBy || out.winner, loserOf = (t) => (t === "A" ? "B" : "A");
    const nRounds = isKO ? out.round : ROUNDS;
    const scoreA = out.scoreA != null ? out.scoreA : rounds.filter((x) => x === "A").length;
    const scoreB = out.scoreB != null ? out.scoreB : rounds.filter((x) => x === "B").length;
    const T_INTRO = 1.2, T_BELL = 0.9, T_FIGHT = 3.8, T_FIGHT_KO = 2.6, T_REST = 1.0, T_KO = 4.1, T_DEC = 2.6, T_END = 3.2, PUNCH = 0.28;
    const S = {
      phase: play ? "intro" : "idle", clk: 0, wait: T_INTRO, pt: 0, r: 0, ts: 1, slow: 0,
      ev: [], evi: 0, punch: { A: 0, B: 0 }, hit: { A: 0, B: 0 }, hp: { A: 1, B: 1 }, pips: [], parts: [], shake: 0, shx: 0, shy: 0, flash: 0,
      down: 0, count: 0, endT: 0, said: {}, fightT: 0, roundW: null,
    };
    const crowd = makeCrowd(5, 360, 7);
    let W = 0, H = 0, SC = 1, g = null;
    const say = env.say, ease = (x) => x * x * (3 - 2 * x), hn = (t) => "<em>" + esc(FIG[t].name) + "</em>";

    const start = () => { if (play) say(i18t("bxStart")); };

    // план обмена ударами в раунде: победитель раунда чаще бьёт и чаще попадает; в раунде нокаута последний удар — решающий
    function planRound(r) {
      const koRound = isKO && r === out.round;
      const wn = koRound ? koBy : rounds[r - 1] || "A";
      const dur = koRound ? T_FIGHT_KO : T_FIGHT, n = koRound ? 6 + Math.floor(R() * 3) : 8 + Math.floor(R() * 4);
      const ev = [];
      for (let i = 0; i < n; i++) {
        const t = (i + 0.6 + R() * 0.5) / (n + 0.4) * (dur - 0.3);
        const by = R() < 0.68 ? wn : loserOf(wn);
        ev.push({ t, by, hit: by === wn ? R() < 0.82 : R() < 0.35, ko: false });
      }
      if (koRound) ev.push({ t: dur - 0.05, by: koBy, hit: true, ko: true });
      S.ev = ev.sort((a, b) => a.t - b.t); S.evi = 0; S.roundW = wn; S.fightT = 0; S.fightDur = dur;
    }
    function beginRound() {
      S.r++; S.phase = "bell"; S.wait = T_BELL;
      say(i18t("bxRoundSay", { n: S.r }));
      env.snd("bell");
    }
    function throwPunch(e) {
      S.punch[e.by] = PUNCH;
      const victim = loserOf(e.by);
      if (e.hit) {
        S.hit[victim] = 0.4; S.shake = Math.max(S.shake, e.ko ? 1.6 : 0.35);
        if (!e.ko) S.hp[victim] = Math.max(0.2, S.hp[victim] - 0.05);
        for (let i = 0; i < (e.ko ? 12 : 4); i++) S.parts.push({ t: "spark", side: victim, ox: 0, oy: 0, vx: rnd(-160, 160) * (e.ko ? 1.6 : 1), vy: rnd(-200, -20), life: rnd(0.3, 0.7), age: 0, r: rnd(1.5, 3.5) });
        if (R() < 0.6) S.parts.push({ t: "sweat", side: victim, ox: 0, oy: 0, vx: rnd(-60, 60), vy: rnd(-110, -30), life: 0.7, age: 0, r: 2.5 });
        env.snd("kick");
      } else env.snd("pull");
    }
    function startKO() {
      S.phase = "ko"; S.pt = 0; S.down = 0; S.count = 0; S.slow = 0.7; S.flash = 0.5;
      S.hp[loserOf(koBy)] = 0;
      env.stamp(i18t("bxKoStamp"), "win"); say(i18t("bxKoSay", { h: hn(koBy), n: out.round })); env.snd("crowd");
    }
    function endRound() {
      S.pips.push(S.roundW);
      S.phase = "rest"; S.wait = T_REST;
      say(i18t("bxRoundWon", { n: S.r, h: hn(S.roundW) }));
    }
    function finish() {
      S.phase = "end"; S.endT = 0;
      env.stamp(i18t("bxWin", { h: FIG[out.winner].name.toUpperCase() }), "win");
      S.flash = 0.4; env.snd("win");
    }

    function step(dt) {
      S.clk += dt;
      const target = S.slow > 0 ? 0.4 : 1;
      S.ts += (target - S.ts) * Math.min(1, dt * 8);
      const sdt = dt * S.ts;
      if (S.slow > 0) S.slow -= dt;
      for (const k of ["A", "B"]) { S.punch[k] = Math.max(0, S.punch[k] - sdt); S.hit[k] = Math.max(0, S.hit[k] - sdt); }
      if (S.phase === "intro") { S.wait -= dt; if (S.wait <= 0) { planRound(S.r + 1); beginRound(); } }
      else if (S.phase === "bell") { S.wait -= dt; if (S.wait <= 0) { S.phase = "fight"; S.fightT = 0; } }
      else if (S.phase === "fight") {
        S.fightT += sdt;
        while (S.evi < S.ev.length && S.ev[S.evi].t <= S.fightT) { const e = S.ev[S.evi++]; throwPunch(e); if (e.ko) { startKO(); break; } }
        if (S.phase === "fight" && S.fightT >= S.fightDur) endRound();
      } else if (S.phase === "rest") {
        S.wait -= dt;
        if (S.wait <= 0) { if (S.r >= nRounds) { S.phase = "dec"; S.pt = 0; env.stamp(i18t("bxDecStamp"), "neutral"); say(i18t("bxDecSay", { h: hn(out.winner), a: Math.max(scoreA, scoreB), b: Math.min(scoreA, scoreB) })); } else { planRound(S.r + 1); beginRound(); } }
      } else if (S.phase === "ko") {
        S.pt += sdt;
        S.down = ease(Math.min(1, S.pt / 0.5));
        const n = Math.max(0, Math.min(10, Math.floor((S.pt - 0.7) / 0.28) + 1));
        if (n !== S.count && n > 0) { S.count = n; env.snd("tick"); }
        if (S.pt >= T_KO) finish();
      } else if (S.phase === "dec") { S.pt += dt; if (S.pt >= T_DEC) finish(); }
      else if (S.phase === "end") S.endT += dt;
      S.shake = Math.max(0, S.shake - dt * 2.8);
      if (S.shake > 0) { S.shx = R() - 0.5; S.shy = R() - 0.5; } else { S.shx = S.shy = 0; }
      if (S.flash > 0) S.flash -= dt * 2.2;
      if ((S.phase === "fight") && R() < dt * 6) S.parts.push({ t: "sweat", side: R() < 0.5 ? "A" : "B", ox: 0, oy: 0, vx: rnd(-40, 40), vy: rnd(-90, -20), life: 0.7, age: 0, r: 2.2 });
      for (let i = S.parts.length - 1; i >= 0; i--) {
        const p = S.parts[i]; p.age += dt;
        if (p.age > p.life) { S.parts.splice(i, 1); continue; }
        p.vy += 320 * dt; p.ox += p.vx * dt; p.oy += p.vy * dt;
      }
    }

    // ---------- рисование ----------
    function taper(x1, y1, x2, y2, w1, w2, fill) {
      const dx = x2 - x1, dy = y2 - y1, Ln = Math.hypot(dx, dy) || 1, nx = -dy / Ln, ny = dx / Ln, a = Math.atan2(ny, nx);
      g.fillStyle = fill; g.beginPath();
      g.moveTo(x1 + nx * w1 / 2, y1 + ny * w1 / 2); g.lineTo(x2 + nx * w2 / 2, y2 + ny * w2 / 2);
      g.arc(x2, y2, w2 / 2, a, a - Math.PI, true); g.lineTo(x1 - nx * w1 / 2, y1 - ny * w1 / 2);
      g.arc(x1, y1, w1 / 2, a + Math.PI, a, true); g.closePath(); g.fill();
    }
    function glove(x, y, r, col) {
      g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.fillStyle = "rgba(255,255,255,.35)"; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.35, r * 0.35, 0, TAU); g.fill();
      g.fillStyle = "#f2f2f2"; g.fillRect(x - r * 1.05, y + r * 0.55, r * 0.9, r * 0.5);   // манжета
    }
    // боец: профиль, смотрит вправо в локальных координатах (dir = -1 зеркалит); (x, gy) — между ногами на канвасе
    function drawFighter(x, gy, dir, who, now) {
      const f = FIG[who], p = S.punch[who] > 0 ? Math.sin(Math.PI * (1 - S.punch[who] / PUNCH)) : 0, h = S.hit[who] / 0.4;
      const winnerEnd = (S.phase === "end" || (S.phase === "ko" && S.count >= 10)) && out.winner === who;
      const loserDown = isKO && who === loserOf(koBy) && (S.phase === "ko" || S.phase === "end");
      const down = loserDown ? (S.phase === "end" ? 1 : S.down) : 0;
      const bob = Math.sin(now * 5 + (who === "A" ? 0 : 2)) * 3;
      const s = SC * 1.2;
      g.save(); g.translate(x - dir * down * 60 * SC, gy); g.scale(s * dir, s);
      if (down) { g.translate(0, -78 * 0); g.rotate(-down * 1.5); }
      const lean = 0.1 + p * 0.25 - h * 0.35;
      const hipY = -82 + bob * 0.4, shY = -146 + bob, shX = lean * 60 - 4;
      const hx = shX + 18 - h * 18, hy = shY - 28 + (down ? 6 : 0);
      // ноги: передняя, задняя; бутсы
      taper(-6, hipY, -30 + p * 14, 0, 26, 18, f.skin); taper(10, hipY, 40 + p * 10, 0, 26, 18, f.skin);
      g.fillStyle = "#14181f"; g.fillRect(-52 + p * 14, -8, 34, 10); g.fillRect(26 + p * 10, -8, 38, 10);
      // шорты: цвет бойца, белый пояс
      g.fillStyle = f.col; g.beginPath(); g.moveTo(-26, hipY - 12); g.lineTo(34, hipY - 12); g.lineTo(44, hipY + 38); g.lineTo(-34, hipY + 38); g.closePath(); g.fill();
      g.fillStyle = "#f4f4f4"; g.fillRect(-27, hipY - 14, 62, 8);
      // торс, задняя рука (защита), голова, передняя рука с ударом
      taper(0, hipY - 8, shX, shY, 50, 54, f.skin);
      taper(shX - 6, shY + 4, shX + 22, shY + 38, 17, 14, f.skin); taper(shX + 22, shY + 38, shX + 38, shY + 10, 14, 13, f.skin);
      glove(shX + 40, shY + 6, 17, f.col);
      g.fillStyle = f.skin; g.beginPath(); g.ellipse(hx, hy, 21, 25, 0, 0, TAU); g.fill();
      g.fillStyle = f.hair; g.beginPath(); g.ellipse(hx - 5, hy - 9, 22, 18, 0, Math.PI, 0); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.ellipse(hx + 11, hy - 3, 5, 4, 0, 0, TAU); g.fill();
      g.fillStyle = "#111"; g.beginPath(); g.arc(hx + 12, hy - 3, 2, 0, TAU); g.fill();
      g.strokeStyle = "#111"; g.lineWidth = 3; g.beginPath(); g.moveTo(hx + 4, hy - 11); g.lineTo(hx + 17, hy - 8); g.stroke();
      if (h > 0.1 || p > 0.2 || loserDown) { g.fillStyle = "#3a0b17"; g.beginPath(); g.ellipse(hx + 13, hy + 12, 6, 5, 0, 0, TAU); g.fill(); g.fillStyle = "#fff"; g.fillRect(hx + 9, hy + 8, 9, 3); }
      else { g.strokeStyle = "#7a3a2a"; g.lineWidth = 3; g.beginPath(); g.moveTo(hx + 7, hy + 12); g.lineTo(hx + 17, hy + 12); g.stroke(); }
      // передняя рука: выпрямляется при ударе
      const gx = shX + 36 + p * 98 + (winnerEnd ? 0 : 0), gyy = shY + 2 - (winnerEnd ? 70 : 0) - p * 4;
      taper(shX + 6, shY + 6, gx, gyy, 18, 14, f.skin); glove(gx, gyy, 19, f.col);
      g.restore();
      return { hx: x + dir * (hx + 20) * s, hy: gy + (hy) * s, gx: x + dir * gx * s };
    }
    function drawReferee(cx, y) {
      const s = SC * 0.95;
      g.save(); g.translate(cx, y); g.scale(s, s);
      taper(-10, -40, -14, 0, 18, 14, "#1a1a22"); taper(10, -40, 14, 0, 18, 14, "#1a1a22");
      taper(0, -48, 0, -96, 40, 44, "#f2f2f2");
      g.fillStyle = "#e3b58f"; g.beginPath(); g.arc(0, -112, 15, 0, TAU); g.fill();
      g.fillStyle = "#222"; g.beginPath(); g.ellipse(0, -118, 16, 9, 0, Math.PI, 0); g.fill();
      g.fillStyle = "#111"; g.fillRect(-7, -96, 14, 5);
      const wave = S.phase === "ko" ? Math.sin(S.clk * 12) * 0.5 : 0;
      taper(18, -90, 40, -118 + wave * 20, 12, 10, "#f2f2f2"); g.fillStyle = "#e3b58f"; g.beginPath(); g.arc(41, -121 + wave * 20, 7, 0, TAU); g.fill();
      g.restore();
    }
    function drawRing(now, hype) {
      let gr = g.createLinearGradient(0, 0, 0, H * 0.5);
      gr.addColorStop(0, "#04050b"); gr.addColorStop(0.6, "#161028"); gr.addColorStop(1, "#2c1634"); g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.6);
      spotlights(g, W, H, [0.1, 0.35, 0.65, 0.9], SC, 0.04);
      const top = H * 0.16, bot = H * 0.5; g.fillStyle = "#130f22"; g.fillRect(0, top, W, bot - top);
      drawCrowd(g, crowd, 7, W, top, bot, now, 0.6 + hype * 3.2, 0, 3.5 * SC * 1.2);
      drawBoards(g, W, H * 0.5, H * 0.06, [i18t("bxBoardA"), i18t("bxBoardB")], now, 0);
      // помост
      const yB = H * 0.57, yF = H * 0.93, xBL = W * 0.17, xBR = W * 0.83, xFL = W * 0.03, xFR = W * 0.97;
      gr = g.createLinearGradient(0, yB, 0, yF); gr.addColorStop(0, "#1c2430"); gr.addColorStop(1, "#0d141b");
      g.fillStyle = gr; g.beginPath(); g.moveTo(xBL, yB); g.lineTo(xBR, yB); g.lineTo(xFR, yF); g.lineTo(xFL, yF); g.closePath(); g.fill();
      g.strokeStyle = "#b6ff2e"; g.lineWidth = 3; g.shadowColor = "#b6ff2e"; g.shadowBlur = 12; g.beginPath(); g.moveTo(xFL, yF); g.lineTo(xFR, yF); g.stroke(); g.shadowBlur = 0;
      g.fillStyle = "rgba(255,255,255,.07)"; g.beginPath(); g.ellipse(W / 2, (yB + yF) / 2 + 6 * SC, W * 0.2, (yF - yB) * 0.22, 0, 0, TAU); g.fill();
      // канаты за бойцами и угловые стойки
      const cols = ["#ff2e88", "#f4f4f4", "#b6ff2e"];
      for (let i = 0; i < 3; i++) {
        const y = yB - (24 + i * 34) * SC;
        g.strokeStyle = cols[i]; g.lineWidth = 5 * SC; g.lineCap = "round"; g.beginPath(); g.moveTo(xBL, y); g.lineTo(xBR, y); g.stroke();
      }
      for (const xp of [xBL, xBR]) { g.fillStyle = "#1a2230"; g.fillRect(xp - 7 * SC, yB - 125 * SC, 14 * SC, 125 * SC); g.fillStyle = "#ff2e88"; g.fillRect(xp - 9 * SC, yB - 128 * SC, 18 * SC, 22 * SC); }
    }
    function drawHud() {
      const u = clamp(SC * 1.1, 0.6, 1.3), bw = Math.min(W * 0.94, 820 * u), x0 = (W - bw) / 2, y0 = 10 * u;
      g.textBaseline = "alphabetic";
      const side = (who, left) => {
        const f = FIG[who], hp = S.hp[who];
        g.font = "900 " + (22 * u) + "px " + DISP; g.fillStyle = f.col; g.textAlign = left ? "left" : "right";
        g.fillText(f.name.toUpperCase(), left ? x0 : x0 + bw, y0 + 26 * u, bw * 0.34);
        const w = bw * 0.36, bx = left ? x0 : x0 + bw - w, by = y0 + 34 * u;
        g.fillStyle = "#151c22"; g.fillRect(bx, by, w, 12 * u); g.strokeStyle = "#26323b"; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, w - 1, 12 * u - 1);
        g.fillStyle = hp > 0.45 ? f.col : "#ff5c5c"; const ww = Math.max(0, w * hp); g.fillRect(left ? bx : bx + w - ww, by, ww, 12 * u);
      };
      side("A", true); side("B", false);
      g.textAlign = "center"; g.font = "800 " + (13 * u) + "px " + MONO; g.fillStyle = "#cfd8dc";
      g.fillText(i18t("bxRoundOf", { n: Math.max(1, S.r), t: ROUNDS }), W / 2, y0 + 22 * u);
      // карточки раундов: цвет бойца, взявшего раунд; нокаут — красный
      const sw = 22 * u, gap = 6 * u, tot = ROUNDS * sw + (ROUNDS - 1) * gap;
      for (let i = 0; i < ROUNDS; i++) {
        const x = W / 2 - tot / 2 + i * (sw + gap), y = y0 + 32 * u, pw = S.pips[i];
        g.fillStyle = pw ? FIG[pw].col : "#151c22"; g.fillRect(x, y, sw, 14 * u);
        g.strokeStyle = "#26323b"; g.strokeRect(x + 0.5, y + 0.5, sw - 1, 14 * u - 1);
        if (isKO && i + 1 === out.round && (S.phase === "ko" || S.phase === "end")) { g.fillStyle = "#ff3030"; g.fillRect(x, y, sw, 14 * u); g.fillStyle = "#fff"; g.font = "900 " + (11 * u) + "px " + MONO; g.fillText("KO", x + sw / 2, y + 11 * u); }
      }
      g.textAlign = "left";
    }
    function draw() {
      L.fit(); g = L.g; W = L.W; H = L.H; SC = Math.min(W / 1100, H / 620);
      const now = S.clk, cx = W / 2;
      const fighting = S.phase === "fight" || S.phase === "ko";
      const hype = Math.min(1, (fighting ? 0.55 : 0.2) + (S.phase === "ko" || S.phase === "end" ? 0.45 : 0));
      g.save(); g.translate(S.shx * 8 * SC, S.shy * 6 * SC);
      drawRing(now, hype);
      const gy = H * 0.84, gap = (170 + Math.sin(now * 2.2) * 8) * SC;
      drawReferee(cx, gy - 34 * SC);
      const posA = cx - gap / 2 - (S.punch.A > 0 ? -10 : 0) * SC, posB = cx + gap / 2 + (S.punch.B > 0 ? -10 : 0) * SC;
      const fA = drawFighter(posA, gy, 1, "A", now), fB = drawFighter(posB, gy, -1, "B", now);
      for (const p of S.parts) {
        const a = 1 - p.age / p.life, tgt = p.side === "A" ? fA : fB;
        g.globalAlpha = a; g.fillStyle = p.t === "spark" ? "#ffd34d" : "#9fe6ff";
        g.beginPath(); g.arc(tgt.hx + p.ox * SC, tgt.hy + p.oy * SC, p.r * SC, 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
      g.restore();
      vignette(g, W, H, 0.5, 0.45);
      if (S.flash > 0) { g.fillStyle = "rgba(255,255,255," + Math.min(0.6, S.flash) + ")"; g.fillRect(0, 0, W, H); }
      drawHud();
      // номер раунда при гонге
      if (S.phase === "bell") { g.globalAlpha = clamp(S.wait / T_BELL * 1.6, 0, 1); glowText(g, i18t("bxRoundOf", { n: S.r, t: ROUNDS }), W / 2, H * 0.34, Math.min(H * 0.1, W / 11), "#fff", "#ff2e88", "center", W * 0.9); g.globalAlpha = 1; }
      // отсчёт рефери
      if (S.phase === "ko" && S.count > 0) glowText(g, String(S.count), W / 2, H * 0.4, Math.min(H * 0.28, W / 5), S.count >= 10 ? "#ff3030" : "#fff", "#ff2e88", "center", W * 0.5);
      if (S.phase === "dec") {
        const k = Math.min(1, S.pt / 0.5); g.globalAlpha = k;
        g.fillStyle = "rgba(6,8,12,.6)"; g.fillRect(0, H * 0.28, W, H * 0.24);
        glowText(g, i18t("bxDecStamp"), W / 2, H * 0.38, Math.min(H * 0.09, W / 14), "#ffd34d", null, "center", W * 0.9);
        glowText(g, FIG.A.name.toUpperCase() + "  " + scoreA + " : " + scoreB + "  " + FIG.B.name.toUpperCase(), W / 2, H * 0.48, Math.min(H * 0.065, W / 18), "#fff", null, "center", W * 0.92);
        g.globalAlpha = 1;
      }
      if (S.phase === "end") {
        const k = Math.min(1, S.endT / 0.4), wn = out.winner;
        g.globalAlpha = k; g.fillStyle = "rgba(6,8,12," + (0.5 * k) + ")"; g.fillRect(0, H * 0.3, W, H * 0.22);
        glowText(g, i18t("bxWin", { h: FIG[wn].name.toUpperCase() }), W / 2, H * 0.4, Math.min(H * 0.12, W / 10), FIG[wn].col, null, "center", W * 0.92);
        glowText(g, isKO ? i18t("bxKoStamp") + " · " + out.round : i18t("bxByDec").toUpperCase() + " " + Math.max(scoreA, scoreB) + ":" + Math.min(scoreA, scoreB), W / 2, H * 0.49, Math.min(H * 0.06, W / 18), "#fff", FIG[wn].col, "center", W * 0.92);
        g.globalAlpha = 1;
      }
    }
    return {
      start, step, draw,
      done: () => play && S.phase === "end" && S.endT > T_END,
      debug: () => ({ sig: sig(S), type: "boxing", phase: S.phase, round: S.r, pips: S.pips.slice(), winner: out.winner, method: out.method, koRound: isKO ? out.round : null }),
    };
  }

  // ---------- регистрация сценических сцен ----------
  BS.register("dogs", (host, ctx) => canvasScene(host, ctx, { make: dogsMake }));
  BS.register("rocket", (host, ctx) => canvasScene(host, ctx, { make: rocketMake }));
  BS.register("penalties", (host, ctx) => canvasScene(host, ctx, { make: penMake }));
  BS.register("rope", (host, ctx) => canvasScene(host, ctx, { make: ropeMake }));
  BS.register("boxing", (host, ctx) => canvasScene(host, ctx, { make: boxMake }));
})(typeof window !== "undefined" ? window : this);
