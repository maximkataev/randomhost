/*
 * blackjack-table.js — рендерер стола блэкджека (общий экран и соло). Этап 2: визуальная лаборатория.
 *
 *   var table = BJTable.create(root, {fx: true, lang: 'ru', layout: 'board'|'solo'|'solo-wide', onReady, autoSay: true,
 *                                     levelBase: 0|1 (0 — уровень движка с нуля, показываем +1), autoFinal: true,
 *                                     instantGapMs: 4000 (Infinity — разрыв по времени не считать переподключением),
 *                                     onMargotTap: fn (клик/тап по Марго), autoLobby: true (табличка с кодом в лобби)});
 *   table.say(text, ms, {hold:true}) — реплика страницы; hold глушит автореплики на время показа; table.setAutoSay(bool)
 *   Итоги (result/net/payout, стеки на рельсе) держатся до последнего revealAt хода дилера — спойлера на доске нет.
 *   table.render(snapshot)        — сам находит разницу с прошлым снапшотом и запускает анимации
 *   table.say(text, ms)           — реплика Марго
 *   table.margot(state, ms)       — состояние Марго (idle|dealing|suspense|smug|oops|congrats|peek|shuffle|sweep|think)
 *   table.brow()                  — фирменная бровь
 *   table.setLang(lang)           — переключить язык подписей
 *   table.setFx(on)               — спецэффекты вкл/выкл
 *   table.resize()                — пересчитать масштаб сцены (сам слушает resize)
 *   table.freeze() / thaw()       — остановить/пустить все анимации (для скриншотов стенда)
 *   table.destroy()
 *
 * Что рендерер делает сам по разнице снапшотов:
 *   новая карта в руке → вылет из шуза по дуге, посадка, переворот (у добора — зависание 150 мс);
 *   result появился → выплата (фишки из лотка к боксу, столбик к аватарке) или сгребание лопаткой;
 *   dealer.plot + revealAt[] → режиссёр по расписанию относительно snapshot.now (normal, longflip, cardbycard,
 *     dealerbust, allin, rescue, jackpot, dealerbj); после переподключения достраивает без повторов;
 *   shoe.reshuffle → тасовка; phase сменилась → HUD, Марго, реплики; level вырос → плашка; out → «выбыл».
 *
 * Сцена в логических координатах (доска 1920×1080, соло 420×760), масштабируется целиком transform: scale().
 * Синтаксис — ES2017 (Chromium 80–83): без `?.`, `??`, spread в объектах, .at(), replaceAll.
 */
(function () {
  'use strict';

  // ---------- тексты доски ----------
  var TEXT = {
    ru: {
      hit: 'Ещё', stand: 'Хватит', double: '×2', split: 'Сплит', bust: 'Перебор', push: 'Ничья', blackjack: 'Блэкджек', bj32: 'Blackjack 3:2',
      dealer: 'Марго', dealerBust: 'Дилер перебрал', dealerBustSub: 'Платят всем, кто остался', dealerBj: 'Блэкджек дилера', dealerBjSub: 'Страховка платит 2:1',
      allinSub: 'Ва-банк', saved: 'Спасён!', out: 'Выбыл', jackpot: 'Джекпот', pair: 'Пара', poker: '21+3', ins: 'Страховка', even: '1:1',
      level: 'Уровень', min: 'Минимум', hand: 'Раздача', cut: 'до отсечения', levelUp: 'Минимум теперь', pause: 'Пауза', pauseSub: 'Ведущий поставил игру на паузу',
      lobbyTitle: 'Блэкджек', lobbyRoom: 'Код комнаты', lobbyWait: 'Ждём игроков', lobbyHint: 'Фишки виртуальные, на деньги не играем',
      winner: 'Последний за столом', finalTitle: 'Партия окончена', again: 'Ещё партию', timerBets: 'Ставки', timerDecide: 'Решения', timerIns: 'Страховка',
      stBiggestWin: 'Крупнейший выигрыш', stBiggestBust: 'Самый дорогой перебор', stBjs: 'Блэкджеков', stMeanCard: 'Самая злая карта', stLast: 'Дольше всех на последних', stTwentyOne: 'Ровно 21', stDealerBusts: 'Переборов дилера', stSideJackpot: 'Джекпот побочной',
      trick_peek: 'Подгляд', trick_redeal: 'Пересдача', trick_shield: 'Щит', trick_freeze: 'Заморозка', trick_extra: 'Лишняя карта', trick_swap: 'Обмен', trick_tax: 'Налог', trick_doublemin: 'Двойной минимум',
      ph_lobby: 'Лобби', ph_betting: 'Ставки', ph_closing: 'Ставок больше нет', ph_dealing: 'Раздача', ph_insurance: 'Страховка', ph_deciding: 'Решения', ph_dealer: 'Ход дилера', ph_payout: 'Выплаты', ph_finished: 'Финал', ph_paused: 'Пауза',
      sec: 'с', penalty: 'штраф', wave: 'волна', shoeLeft: 'шуз', reshuffle: 'Новый шуз', soloOver: 'Фишки кончились', thinking: 'думает', decided: 'решили', cutNow: 'отсечение после этой', handsN: 'раздач'
    },
    en: {
      hit: 'Hit', stand: 'Stand', double: '×2', split: 'Split', bust: 'Bust', push: 'Push', blackjack: 'Blackjack', bj32: 'Blackjack 3:2',
      dealer: 'Margot', dealerBust: 'Dealer busts', dealerBustSub: 'Everyone standing gets paid', dealerBj: 'Dealer blackjack', dealerBjSub: 'Insurance pays 2:1',
      allinSub: 'All in', saved: 'Saved!', out: 'Out', jackpot: 'Jackpot', pair: 'Pair', poker: '21+3', ins: 'Insurance', even: '1:1',
      level: 'Level', min: 'Minimum', hand: 'Hand', cut: 'to the cut', levelUp: 'Minimum is now', pause: 'Paused', pauseSub: 'The host paused the game',
      lobbyTitle: 'Blackjack', lobbyRoom: 'Room code', lobbyWait: 'Waiting for players', lobbyHint: 'Chips are virtual, no real money',
      winner: 'Last one standing', finalTitle: 'Game over', again: 'Play again', timerBets: 'Bets', timerDecide: 'Decisions', timerIns: 'Insurance',
      stBiggestWin: 'Biggest win', stBiggestBust: 'Priciest bust', stBjs: 'Blackjacks', stMeanCard: 'Meanest card', stLast: 'Longest on last chips', stTwentyOne: 'Exactly 21', stDealerBusts: 'Dealer busts', stSideJackpot: 'Side-bet jackpot',
      trick_peek: 'Peek', trick_redeal: 'Redeal', trick_shield: 'Shield', trick_freeze: 'Freeze', trick_extra: 'Extra card', trick_swap: 'Swap', trick_tax: 'Tax', trick_doublemin: 'Double minimum',
      ph_lobby: 'Lobby', ph_betting: 'Bets', ph_closing: 'No more bets', ph_dealing: 'Dealing', ph_insurance: 'Insurance', ph_deciding: 'Decisions', ph_dealer: "Dealer's turn", ph_payout: 'Payouts', ph_finished: 'Final', ph_paused: 'Paused',
      sec: 's', penalty: 'penalty', wave: 'wave', shoeLeft: 'shoe', reshuffle: 'New shoe', soloOver: 'Out of chips', thinking: 'thinking', decided: 'decided', cutNow: 'cut after this hand', handsN: 'hands'
    },
    el: {
      hit: 'Κι άλλο', stand: 'Στοπ', double: '×2', split: 'Σπλιτ', bust: 'Κάηκε', push: 'Ισοπαλία', blackjack: 'Μπλακτζάκ', bj32: 'Blackjack 3:2',
      dealer: 'Μαργκό', dealerBust: 'Ο ντίλερ κάηκε', dealerBustSub: 'Πληρώνονται όλοι όσοι έμειναν', dealerBj: 'Μπλακτζάκ ντίλερ', dealerBjSub: 'Η ασφάλεια πληρώνει 2:1',
      allinSub: 'Όλα μέσα', saved: 'Σώθηκε!', out: 'Εκτός', jackpot: 'Τζάκποτ', pair: 'Ζευγάρι', poker: '21+3', ins: 'Ασφάλεια', even: '1:1',
      level: 'Επίπεδο', min: 'Ελάχιστο', hand: 'Μοιρασιά', cut: 'ως το κόψιμο', levelUp: 'Ελάχιστο τώρα', pause: 'Παύση', pauseSub: 'Ο οικοδεσπότης έβαλε παύση',
      lobbyTitle: 'Μπλακτζάκ', lobbyRoom: 'Κωδικός δωματίου', lobbyWait: 'Περιμένουμε παίκτες', lobbyHint: 'Οι μάρκες είναι εικονικές, χωρίς χρήματα',
      winner: 'Ο τελευταίος όρθιος', finalTitle: 'Τέλος παιχνιδιού', again: 'Ξανά', timerBets: 'Στοιχήματα', timerDecide: 'Αποφάσεις', timerIns: 'Ασφάλεια',
      stBiggestWin: 'Μεγαλύτερο κέρδος', stBiggestBust: 'Ακριβότερο κάψιμο', stBjs: 'Μπλακτζάκ', stMeanCard: 'Πιο κακό φύλλο', stLast: 'Πιο πολύ στις τελευταίες', stTwentyOne: 'Ακριβώς 21', stDealerBusts: 'Καψίματα ντίλερ', stSideJackpot: 'Τζάκποτ πλαϊνού',
      trick_peek: 'Ματιά', trick_redeal: 'Ξαναμοίρασμα', trick_shield: 'Ασπίδα', trick_freeze: 'Πάγωμα', trick_extra: 'Έξτρα φύλλο', trick_swap: 'Ανταλλαγή', trick_tax: 'Φόρος', trick_doublemin: 'Διπλό ελάχιστο',
      ph_lobby: 'Λόμπι', ph_betting: 'Στοιχήματα', ph_closing: 'Τέλος στοιχημάτων', ph_dealing: 'Μοιρασιά', ph_insurance: 'Ασφάλεια', ph_deciding: 'Αποφάσεις', ph_dealer: 'Σειρά ντίλερ', ph_payout: 'Πληρωμές', ph_finished: 'Τελικό', ph_paused: 'Παύση',
      sec: 'δ', penalty: 'ποινή', wave: 'κύμα', shoeLeft: 'παπούτσι', reshuffle: 'Νέο παπούτσι', soloOver: 'Τέλος οι μάρκες', thinking: 'σκέφτεται', decided: 'αποφάσισαν', cutNow: 'κόψιμο μετά από αυτή', handsN: 'μοιρασιές'
    }
  };
  var COLORS = ['#f2c14e', '#4ea8f2', '#b57bff', '#ff8fc7', '#ff4d4d', '#ff9a3c', '#e8e8e8', '#b8efff', '#7f8cff', '#d9a86c', '#ff6f91', '#d96bff'];

  // ---------- геометрия сцен ----------
  var GEOM = {
    board: {
      W: 1920, H: 1080,
      felt: { cx: 960, cy: 330, rx: 860, ry: 660 },
      boxes: { cx: 960, cy: 384, rx: 760, ry: 500 },
      shoe: { x: 1142, y: 404 }, tray: { x: 960, y: 384 }, discard: { x: 690, y: 384 }, dealer: { x: 960, y: 436 },
      arcs: { ins: [390, 272], big: [480, 326], mid: [570, 372] }
    },
    'solo-wide': {
      W: 760, H: 440,
      felt: { cx: 380, cy: 196, rx: 400, ry: 230 },
      boxes: null,
      shoe: { x: 472, y: 232 }, tray: { x: 380, y: 222 }, discard: { x: 256, y: 222 }, dealer: { x: 112, y: 262 },
      arcs: { ins: [150, 120], big: [200, 150], mid: [250, 182] }
    },
    solo: {
      W: 420, H: 760,
      felt: { cx: 210, cy: 290, rx: 290, ry: 410 },
      boxes: null,
      shoe: { x: 306, y: 334 }, tray: { x: 210, y: 325 }, discard: { x: 54, y: 328 }, dealer: { x: 92, y: 352 },
      arcs: { ins: [160, 200], big: [200, 240], mid: [240, 282] }
    }
  };

  // ---------- утилиты ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }
  function fmt(n) {
    n = Math.round(n || 0);
    var s = String(Math.abs(n)), out = '';
    while (s.length > 3) { out = '\u2009' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '−' : '') + s + out;
  }
  function signed(n) { return n > 0 ? '+' + fmt(n) : fmt(n); }
  function shade(hex, k) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    var f = function (v) { return Math.max(0, Math.min(255, Math.round(k < 1 ? v * k : v + (255 - v) * (k - 1)))); };
    return 'rgb(' + f(n >> 16) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
  }
  function lum(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 0.5;
    var n = parseInt(m[1], 16);
    var c = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * c(n >> 16) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255);
  }
  function chipVars(color) {
    return '--c:' + color + ';--cd:' + shade(color, 0.55) + ';--cs:' + (lum(color) > 0.55 ? '#2b2118' : '#fff6e2');
  }
  function stackLayers(amount, min) {
    var k = amount / Math.max(1, min || 1);
    return k >= 25 ? 5 : k >= 10 ? 4 : k >= 4 ? 3 : k >= 2 ? 2 : 1;
  }
  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    var s = parts[0].slice(0, 1) + (parts.length > 1 ? parts[1].slice(0, 1) : '');
    return s.toUpperCase();
  }
  function isEmoji(s) { return typeof s === 'string' && s.length <= 4 && /[☀-⟿\ud83c-\ud83e]/.test(s); }
  function cardKey(c) { return c ? c.r + c.s : ''; }
  function handKey(pid, i) { return pid + ':' + i; }
  function softText(value, soft, done) {
    if (soft && !done && value < 21 && value - 10 >= 1) return (value - 10) + ' / ' + value;
    return String(value);
  }
  // равномерное распределение n точек по дуге эллипса (по длине дуги, не по параметру)
  function arcPoints(cx, cy, rx, ry, a0, a1, n) {
    var steps = 400, pts = [], len = [0], px = cx - rx * Math.cos(a0), py = cy + ry * Math.sin(a0);
    for (var i = 1; i <= steps; i++) {
      var t = a0 + (a1 - a0) * i / steps, x = cx - rx * Math.cos(t), y = cy + ry * Math.sin(t);
      len.push(len[i - 1] + Math.hypot(x - px, y - py)); px = x; py = y;
    }
    var total = len[steps];
    for (var k = 0; k < n; k++) {
      var want = n === 1 ? total / 2 : total * k / (n - 1), j = 0;
      while (j < steps && len[j + 1] < want) j++;
      var f = (len[j + 1] - len[j]) > 0 ? (want - len[j]) / (len[j + 1] - len[j]) : 0;
      var tt = a0 + (a1 - a0) * (j + f) / steps;
      pts.push({ x: cx - rx * Math.cos(tt), y: cy + ry * Math.sin(tt), t: tt });
    }
    return pts;
  }

  // ---------- создание ----------
  function create(root, opts) {
    opts = opts || {};
    var layout = opts.layout || root.getAttribute('data-layout') || 'board';
    var G = GEOM[layout] || GEOM.board;
    var lang = opts.lang || (window.I18N && window.I18N.lang) || 'ru';
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var fx = opts.fx === undefined ? !reduced : !!opts.fx;
    var autoSay = opts.autoSay !== false;
    var isSolo = layout === 'solo' || layout === 'solo-wide';
    var levelBase = opts.levelBase === 1 ? 1 : 0;              // 0 — как движок (уровень с нуля), 1 — уже человеческий
    var autoFinal = opts.autoFinal !== false;                   // плашка финала силами рендерера
    var autoLobby = opts.autoLobby !== false;                   // центральная табличка с кодом в лобби (доска рисует своё)
    var instantGapMs = typeof opts.instantGapMs === 'number' ? opts.instantGapMs : 4000; // Infinity — не считать разрыв переподключением
    var T = function (k) { var d = TEXT[lang] || TEXT.ru; return d[k] !== undefined ? d[k] : (TEXT.ru[k] !== undefined ? TEXT.ru[k] : k); };
    var K = function () { return fx ? 1 : 0.5; }; // множитель длительностей

    root.classList.add('bj');
    root.setAttribute('data-layout', layout);
    root.setAttribute('data-fx', fx ? 'on' : 'off');
    while (root.firstChild) root.removeChild(root.firstChild);
    if (window.BJCards) window.BJCards.install();

    // --- каркас сцены ---
    var stage = el('div', 'bj-stage');
    root.appendChild(stage);
    var room = el('div', 'bj-room'); stage.appendChild(room);
    // атмосфера зала: огни дальнего игрового зала, свет за спиной крупье, бархатные портьеры
    ['bj-bokeh', 'bj-backglow', 'bj-curt bj-curt-l', 'bj-curt bj-curt-r'].forEach(function (c) { room.appendChild(el('div', c)); });
    var table = el('div', 'bj-table'); stage.appendChild(table);
    var feltSvg = svgEl('svg', { 'class': 'bj-felt-svg', viewBox: '0 0 ' + G.W + ' ' + G.H });
    table.appendChild(feltSvg);
    buildFelt(feltSvg, G, layout);
    var printBoxes = svgEl('g', { 'class': 'bj-print-boxes' }, feltSvg);
    var lamp = el('div', 'bj-lamp'); stage.appendChild(lamp);
    if (layout === 'board') buildLamps(lamp);

    var discard = el('div', 'bj-discard'); discard.innerHTML = '<div class="bj-discard-body"></div><div class="bj-discard-pile"></div>'; stage.appendChild(discard);
    var tray = el('div', 'bj-tray');
    ['#1b1d26', '#c8102e', '#2c6fd6', '#1f8f4e', '#d4af37'].forEach(function (c, i) {
      var r = el('div', 'bj-tray-row'); r.style.cssText = '--c:' + c + ';--cs:' + (i === 0 ? '#3a3d4a' : '#f6f1e4') + ';left:' + (isSolo ? 10 + i * 30 : 14 + i * 40) + 'px';
      tray.appendChild(r);
    });
    if (layout !== 'solo') { /* пять колонок по 44 px — лоток 220 px */ }
    stage.appendChild(tray);
    var margotWrap = el('div', 'bj-margot-wrap'); stage.appendChild(margotWrap);
    var margot = window.BJMargot ? window.BJMargot.create(margotWrap, { lang: lang }) : null;
    // хук «Спроси Марго»: клик/тап по персонажу
    if (typeof opts.onMargotTap === 'function') {
      margotWrap.classList.add('is-tappable');
      margotWrap.addEventListener('click', function (e) { opts.onMargotTap(e); });
    }

    var shoe = el('div', 'bj-shoe');
    shoe.innerHTML = '<div class="bj-shoe-body"></div><div class="bj-shoe-stack"></div><div class="bj-shoe-cut"></div><div class="bj-shoe-mouth"></div><div class="bj-shoe-left"></div>';
    stage.appendChild(shoe);
    var shoeStack = shoe.querySelector('.bj-shoe-stack'), shoeLeft = shoe.querySelector('.bj-shoe-left');

    var dealer = el('div', 'bj-dealer');
    var dlabel = el('div', 'bj-dlabel', T('dealer')); dealer.appendChild(dlabel);
    var dcards = el('div', 'bj-dcards'); dealer.appendChild(dcards);
    var dscore = el('div', 'bj-dscore'); dealer.appendChild(dscore);
    stage.appendChild(dealer);

    var boxesWrap = el('div', 'bj-boxes'); stage.appendChild(boxesWrap);
    var rail = el('div', 'bj-rail'); stage.appendChild(rail);

    var hudL = el('div', 'bj-hud bj-hud-left');
    hudL.innerHTML = '<div class="bj-sign"><span class="bj-sign-num">21</span><span class="bj-sign-word">BLACKJACK</span></div><div class="bj-timer"><i></i></div><div class="bj-timer-label"></div>';
    stage.appendChild(hudL);
    var timerEl = hudL.querySelector('.bj-timer'), timerBar = timerEl.querySelector('i'), timerLabel = hudL.querySelector('.bj-timer-label');
    var phaseEl = el('div', 'bj-phase'); stage.appendChild(phaseEl);
    var hudR = el('div', 'bj-hud bj-hud-right');
    hudR.innerHTML =
      '<div class="bj-blk bj-blk-level"><span class="bj-k"></span><span class="bj-v"></span><span class="bj-pips"></span></div>' +
      '<div class="bj-blk bj-blk-min"><span class="bj-k"></span><span class="bj-v is-gold"></span><span class="bj-sub"></span></div>' +
      '<div class="bj-blk bj-blk-hand"><span class="bj-k"></span><span class="bj-v"></span><span class="bj-sub"></span></div>';
    stage.appendChild(hudR);
    var H = {
      levelK: hudR.querySelector('.bj-blk-level .bj-k'), levelV: hudR.querySelector('.bj-blk-level .bj-v'), pips: hudR.querySelector('.bj-pips'),
      minK: hudR.querySelector('.bj-blk-min .bj-k'), minV: hudR.querySelector('.bj-blk-min .bj-v'), minSub: hudR.querySelector('.bj-blk-min .bj-sub'),
      handK: hudR.querySelector('.bj-blk-hand .bj-k'), handV: hudR.querySelector('.bj-blk-hand .bj-v'), handSub: hudR.querySelector('.bj-blk-hand .bj-sub')
    };

    var fxCanvas = document.createElement('canvas'); fxCanvas.className = 'bj-fx'; stage.appendChild(fxCanvas);
    var ctx2d = fxCanvas.getContext('2d');
    var dim = el('div', 'bj-dim'); stage.appendChild(dim);
    var flash = el('div', 'bj-flash'); stage.appendChild(flash);
    var banner = el('div', 'bj-banner'); stage.appendChild(banner);
    var center = el('div', 'bj-center'); stage.appendChild(center);

    // --- состояние ---
    var S = {
      prev: null, snap: null, scale: 1, offX: 0, offY: 0, frozen: false,
      boxes: {},            // pid -> {el, hands:{}, bet, ...}
      seats: {},            // pid -> el
      slots: [],            // позиции боксов
      dealerCards: [],      // элементы карт дилера
      dealerShown: 0,       // сколько карт дилера показано (лицом)
      dealClock: 0,         // очередь полётов карт (абс. время)
      plan: null,           // режиссёр: {hand, plot, timers}
      phaseSeen: { phase: null, at: 0, endsAt: 0 },
      lastSay: 0, lastSayCat: '',
      lastHandNo: null,
      timers: [],
      particles: [], flights: [], raf: 0, lastFrame: 0,
      payoutHand: null, seatPending: {},
      shuffleSeen: false, allinOn: false,
      fpsSamples: []
    };

    function later(fn, ms) {
      var id = setTimeout(function () { var i = S.timers.indexOf(id); if (i >= 0) S.timers.splice(i, 1); fn(); }, Math.max(0, ms));
      S.timers.push(id);
      return id;
    }
    function sfx(name, k) { if (window.BJSfx && !S.frozen) window.BJSfx.play(name, k); }

    // --- масштаб ---
    function resize() {
      var w = root.clientWidth || 1, h = root.clientHeight || 1;
      var s = Math.min(w / G.W, h / G.H);
      S.scale = s; S.offX = (w - G.W * s) / 2; S.offY = (h - G.H * s) / 2;
      stage.style.transform = 'translate(' + S.offX + 'px,' + S.offY + 'px) scale(' + s + ')';
      var dpr = Math.min(1.5, (window.devicePixelRatio || 1) * s);
      fxCanvas.width = Math.round(G.W * dpr); fxCanvas.height = Math.round(G.H * dpr);
      fxCanvas.style.width = G.W + 'px'; fxCanvas.style.height = G.H + 'px';
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener('resize', resize);
    resize();

    // логический прямоугольник элемента (в координатах сцены)
    function lrect(node) {
      var r = node.getBoundingClientRect(), rr = root.getBoundingClientRect();
      return { x: (r.left - rr.left - S.offX) / S.scale, y: (r.top - rr.top - S.offY) / S.scale, w: r.width / S.scale, h: r.height / S.scale };
    }
    function lcenter(node) { var r = lrect(node); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }

    // ---------- Марго ----------
    // say(text, ms, {hold:true}) — на время показа глушит автореплики, чтобы реплику страницы не перекрыло «Как скажете»
    function say(text, ms, o) {
      if (margot) margot.say(text, ms);
      if (o && o.hold) S.sayHoldUntil = Date.now() + (ms || 2800);
    }
    function setMargot(state, ms) { if (margot) margot.set(state, ms); }
    // эмоция поверх состояния (мимика/жесты Марго, см. BJMargot.EMOTES); слабая не перебивает сильную, пока та не отыграла
    function emote(name, ms) { if (margot && margot.emote) margot.emote(name, ms); }
    function autoLine(cat, force) {
      if (!autoSay || !margot) return;
      var now = Date.now();
      if (now < (S.sayHoldUntil || 0)) return;
      if (!force && now - S.lastSay < 2600) return;
      S.lastSay = now; S.lastSayCat = cat;
      say(window.BJMargot.pick(lang, cat));
    }

    // ---------- подвесные лампы с зелёным латунным плафоном и конусом света ----------
    function buildLamps(host) {
      var svg = svgEl('svg', { 'class': 'bj-lamp-svg', viewBox: '0 0 1920 1080' });
      var defs = svgEl('defs', {}, svg);
      function stops(g, list) { list.forEach(function (st) { svgEl('stop', { offset: st[0], 'stop-color': st[1], 'stop-opacity': st.length > 2 ? st[2] : 1 }, g); }); }
      var beam = svgEl('linearGradient', { id: 'bj-beam', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      stops(beam, [['0', '#ffe2a0', .17], ['.5', '#ffd68c', .05], ['1', '#ffd68c', 0]]);
      var shade = svgEl('linearGradient', { id: 'bj-shade', x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
      stops(shade, [['0', '#04281c'], ['.3', '#1f8a5e'], ['.45', '#35b17c'], ['.7', '#0d5a3e'], ['1', '#031a12']]);
      var brass = svgEl('linearGradient', { id: 'bj-shade-brass', x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
      stops(brass, [['0', '#7a5517'], ['.3', '#f1d278'], ['.5', '#fff0a8'], ['.75', '#b98a2c'], ['1', '#5e4010']]);
      var bulb = svgEl('radialGradient', { id: 'bj-bulb', cx: '50%', cy: '50%', r: '50%' }, defs);
      stops(bulb, [['0', '#fffbe6', 1], ['.35', '#ffe08a', .9], ['1', '#ffb84a', 0]]);
      [500, 1420].forEach(function (x) {
        // конус света (трапеция) на сукно
        svgEl('path', { d: 'M' + (x - 70) + ' 84 L' + (x + 70) + ' 84 L' + (x + 330) + ' 700 L' + (x - 330) + ' 700 Z', fill: 'url(#bj-beam)' }, svg);
        svgEl('ellipse', { cx: x, cy: 90, rx: 120, ry: 60, fill: 'url(#bj-bulb)', opacity: .5 }, svg);
        // шнур
        svgEl('rect', { x: x - 1.5, y: 0, width: 3, height: 34, fill: '#120a07' }, svg);
        // плафон
        svgEl('path', { d: 'M' + (x - 24) + ' 34 L' + (x + 24) + ' 34 L' + (x + 92) + ' 88 L' + (x - 92) + ' 88 Z', fill: 'url(#bj-shade)' }, svg);
        svgEl('path', { d: 'M' + (x - 24) + ' 34 L' + (x + 24) + ' 34 L' + (x + 28) + ' 40 L' + (x - 28) + ' 40 Z', fill: 'url(#bj-shade-brass)' }, svg);
        svgEl('rect', { x: x - 94, y: 86, width: 188, height: 7, rx: 3, fill: 'url(#bj-shade-brass)' }, svg);
        svgEl('path', { d: 'M' + (x - 60) + ' 50 L' + (x - 40) + ' 50 L' + (x - 66) + ' 82 L' + (x - 80) + ' 82 Z', fill: '#fff', opacity: .12 }, svg);
        svgEl('ellipse', { cx: x, cy: 94, rx: 56, ry: 9, fill: '#fff2b0', opacity: .85 }, svg);
      });
      host.appendChild(svg);
    }

    // ---------- сукно ----------
    // Мир рулетки: изумрудное сукно под конусом лампы, кожаный стёганый борт «капитоне», латунь, орех.
    function buildFelt(svg, G, layout) {
      var f = G.felt, defs = svgEl('defs', {}, svg);
      var board = layout === 'board';
      var k = board ? 1 : (layout === 'solo' ? 0.42 : 0.4);     // масштаб ширины борта: на соло он тоньше
      function stops(g, list) { list.forEach(function (s) { svgEl('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s.length > 2 ? s[2] : 1 }, g); }); }
      function lin(id, y1, y2, list, abs) {
        var a = { id: id, x1: 0, y1: y1, x2: 0, y2: y2 };
        if (abs) a.gradientUnits = 'userSpaceOnUse';
        stops(svgEl('linearGradient', a, defs), list);
      }
      var top = board ? f.cy - 30 : f.cy - 8;
      var bot = f.cy + f.ry;
      // сукно: изумруд рулетки (#0c6a44), светлее в центре под лампой, темнее к краям
      var grad = svgEl('radialGradient', { id: 'bj-felt-grad', cx: '50%', cy: '30%', r: '78%' }, defs);
      stops(grad, [['0', '#12895a'], ['.35', '#0e7a4e'], ['.7', '#0a5a3a'], ['1', '#06362a']]);
      // ворс: мелкая зернистость + крупная «пятнистость» ткани
      var filt = svgEl('filter', { id: 'bj-felt-noise', x: '0', y: '0', width: '100%', height: '100%' }, defs);
      svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.9', numOctaves: '2', seed: '7', result: 'n' }, filt);
      svgEl('feColorMatrix', { 'in': 'n', type: 'matrix', values: '0 0 0 0 .8  0 0 0 0 1  0 0 0 0 .85  0 0 0 .15 0' }, filt);
      var pat = svgEl('pattern', { id: 'bj-felt-pat', width: 220, height: 220, patternUnits: 'userSpaceOnUse' }, defs);
      svgEl('rect', { width: 220, height: 220, filter: 'url(#bj-felt-noise)' }, pat);
      var filt2 = svgEl('filter', { id: 'bj-felt-mottle', x: '0', y: '0', width: '100%', height: '100%' }, defs);
      svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.035 0.12', numOctaves: '2', seed: '3', result: 'n' }, filt2);
      svgEl('feColorMatrix', { 'in': 'n', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 .08  0 0 0 0 .03  0 0 0 .5 -.12' }, filt2);
      var pat2 = svgEl('pattern', { id: 'bj-felt-pat2', width: 480, height: 480, patternUnits: 'userSpaceOnUse' }, defs);
      svgEl('rect', { width: 480, height: 480, filter: 'url(#bj-felt-mottle)' }, pat2);
      // конус света лампы и виньетка
      var cone = svgEl('radialGradient', { id: 'bj-felt-cone', cx: '50%', cy: '50%', r: '50%' }, defs);
      stops(cone, [['0', '#ffe9b0', .4], ['.45', '#ffd68c', .17], ['1', '#ffd68c', 0]]);
      var vig = svgEl('radialGradient', { id: 'bj-felt-vig', cx: '50%', cy: '42%', r: '68%' }, defs);
      stops(vig, [['.5', '#00110a', 0], ['1', '#00110a', .72]]);
      var sheen = svgEl('radialGradient', { id: 'bj-felt-sheen', cx: '50%', cy: '50%', r: '50%' }, defs);
      stops(sheen, [['0', '#e8fff0', .1], ['1', '#e8fff0', 0]]);
      // золото (кант, печать, кольца)
      lin('bj-gold-lin', 0, 1, [['0', '#fff3b0'], ['.35', '#e2b84a'], ['.7', '#9a7320'], ['1', '#d9ae44']]);
      lin('bj-gold-text', 0, 1, [['0', '#fff1b4'], ['.5', '#e0b648'], ['1', '#a67c24']]);
      // латунь борта: вертикальный градиент по всей высоте стола
      lin('bj-brass', top - 60, bot + 100, [['0', '#fff0a8'], ['.12', '#e9c658'], ['.3', '#a67a22'], ['.5', '#f1d278'], ['.7', '#8a6118'], ['1', '#c9a043']], true);
      // орех: тёплый красно-коричневый, светлее на плечах (лампа сверху)
      lin('bj-wood', top - 60, bot + 100, [['0', '#7a4326'], ['.3', '#5c301a'], ['.65', '#3c1d10'], ['1', '#220f08']], true);
      lin('bj-wood-hi', top - 60, bot + 100, [['0', '#ffcf9a', .0], ['.25', '#ffcf9a', .32], ['.5', '#ffcf9a', .1], ['1', '#ffcf9a', 0]], true);
      // кожа: бордовая с глянцем на плечах
      var lea = svgEl('radialGradient', { id: 'bj-leather', gradientUnits: 'userSpaceOnUse', cx: f.cx, cy: f.cy + 120, r: f.rx + 120 }, defs);
      stops(lea, [['.78', '#3a0a14'], ['.9', '#4a0f1a'], ['1', '#2a060d']]);
      lin('bj-leather-gl', top - 60, bot + 100, [['0', '#ffd0d0', 0], ['.22', '#ffd0d0', .34], ['.45', '#ffd0d0', .12], ['.7', '#ffd0d0', .02], ['1', '#ffd0d0', 0]], true);
      // стёжка капитоне: ромбы с пуговицей в узле
      var q = board ? 34 : 18;
      var qp = svgEl('pattern', { id: 'bj-quilt', width: q, height: q, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      svgEl('rect', { width: q, height: q, fill: 'rgba(120,20,36,.0)' }, qp);
      svgEl('path', { d: 'M0 0H' + q + 'M0 0V' + q, stroke: '#14030a', 'stroke-width': board ? 2.2 : 1.2, fill: 'none', opacity: .8 }, qp);
      svgEl('path', { d: 'M1.4 1.4H' + q + 'M1.4 1.4V' + q, stroke: '#ff9aa8', 'stroke-width': board ? 0.9 : 0.5, fill: 'none', opacity: .22 }, qp);
      var puff = svgEl('radialGradient', { id: 'bj-puff', cx: '50%', cy: '50%', r: '50%' }, defs);
      stops(puff, [['0', '#ff8fa0', .3], ['.55', '#a01830', .05], ['1', '#14030a', .35]]);
      svgEl('circle', { cx: q / 2, cy: q / 2, r: q * 0.62, fill: 'url(#bj-puff)' }, qp);
      svgEl('circle', { cx: 0, cy: 0, r: board ? 3.4 : 2, fill: '#d9ae44' }, qp);
      svgEl('circle', { cx: 0, cy: 0, r: board ? 1.5 : 0.9, fill: '#fff3b0' }, qp);
      svgEl('circle', { cx: q, cy: q, r: board ? 3.4 : 2, fill: '#d9ae44' }, qp);
      svgEl('circle', { cx: q, cy: q, r: board ? 1.5 : 0.9, fill: '#fff3b0' }, qp);
      svgEl('circle', { cx: q, cy: 0, r: board ? 3.4 : 2, fill: '#d9ae44' }, qp);
      svgEl('circle', { cx: q, cy: 0, r: board ? 1.5 : 0.9, fill: '#fff3b0' }, qp);
      svgEl('circle', { cx: 0, cy: q, r: board ? 3.4 : 2, fill: '#d9ae44' }, qp);
      svgEl('circle', { cx: 0, cy: q, r: board ? 1.5 : 0.9, fill: '#fff3b0' }, qp);
      // кольца боксов: утопленная заливка
      var pit = svgEl('radialGradient', { id: 'bj-pit', cx: '50%', cy: '60%', r: '55%' }, defs);
      stops(pit, [['0', '#06402a', .55], ['.7', '#032619', .75], ['1', '#010d08', .9]]);

      function half(e, yTop) {
        var rx = f.rx + e, ry = f.ry + e, x0 = f.cx - rx, x1 = f.cx + rx;
        return 'M' + x0 + ' ' + yTop + ' L' + x1 + ' ' + yTop + ' L' + x1 + ' ' + f.cy + ' A' + rx + ' ' + ry + ' 0 0 1 ' + x0 + ' ' + f.cy + ' Z';
      }
      function ring(e) { return half(e, top - e * 0.3); }     // контур на расстоянии e от края сукна; у дилерской кромки борт ниже
      function path(e, attrs) { attrs.d = ring(e); return svgEl('path', attrs, svg); }
      function stroke(e, color, w, op, extra) { var a = { fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linejoin': 'round' }; if (op !== undefined) a.opacity = op; if (extra) for (var kk in extra) a[kk] = extra[kk]; return path(e, a); }

      var eLeaTop = 66 * k, eBrass = 66 * k, eWood = 118 * k, ePipe = 7 * k;
      if (!board) { eLeaTop = 30; eBrass = 31; eWood = 46; ePipe = 4; }
      // тень стола на пол: ступенчатая, смещена вниз
      var sh = svgEl('g', { transform: 'translate(0 ' + (board ? 26 : 10) + ')' }, svg);
      [24, 16, 9, 3].forEach(function (d, i) { svgEl('path', { d: ring(eWood + d), fill: '#000', opacity: .13 + i * .03 }, sh); });
      // орех: основа, волокна по дуге, блик лампы, фаска
      path(eWood, { fill: 'url(#bj-wood)' });
      var gr = [[.5, 6, '#1a0a04', .5], [1.2, 12, '#120602', .35], [.7, 19, '#b06a3a', .16], [1.6, 26, '#120602', .4], [.6, 31, '#d08a54', .14], [1, 38, '#1a0a04', .42], [.6, 44, '#b06a3a', .12], [1.4, 51, '#120602', .3]];
      gr.forEach(function (g) { if (board || g[1] < 30) stroke(eBrass + (eWood - eBrass) * (g[1] / 52) , g[2], g[0], g[3]); });
      stroke((eBrass + eWood) / 2, 'url(#bj-wood-hi)', (eWood - eBrass) * 0.5, 1);
      stroke(eWood - 1, '#050201', 2, .9);
      stroke(eWood - 3, '#ffd2a0', 1, .28);
      // латунная окантовка: полоса, фаски, блик
      stroke(eBrass, 'url(#bj-brass)', 7 * Math.max(.5, k), 1);
      stroke(eBrass + 3.8 * Math.max(.5, k), '#2a1604', .8, .8);
      stroke(eBrass - 3.8 * Math.max(.5, k), '#2a1604', .8, .8);
      stroke(eBrass - 1.4 * Math.max(.5, k), '#fff6c8', .9, .6);
      // кожаный стёганый борт
      var eLeaMid = (eLeaTop + ePipe + 5 * Math.max(.5, k)) / 2, wLea = eLeaTop - ePipe - 3 * Math.max(.5, k);
      // заливка кожи как сплошная область до кромки латуни (под стёжкой)
      path(eBrass - 3 * Math.max(.5, k), { fill: 'url(#bj-leather)' });
      path(eBrass - 3 * Math.max(.5, k), { fill: 'url(#bj-quilt)' });
      // валик: светлая середина, тёмные края — борт выглядит набитым
      stroke(eLeaMid, '#ff9aa8', wLea * 0.5, .09);
      stroke(eLeaMid, '#ff9aa8', wLea * 0.22, .1);
      stroke(eBrass - 3 * Math.max(.5, k) - 3, '#0b0205', 6 * Math.max(.5, k), .5);
      stroke(ePipe + 6 * Math.max(.5, k), '#0b0205', 7 * Math.max(.5, k), .42);
      stroke(eLeaMid, 'url(#bj-leather-gl)', wLea * 0.55, 1);
      // золотой кант вдоль сукна
      stroke(ePipe, 'url(#bj-brass)', 4.2 * Math.max(.6, k), 1);
      stroke(ePipe + 2.4 * Math.max(.6, k), '#1a0a04', .8, .8);
      stroke(ePipe - 1 * Math.max(.6, k), '#fff6c8', .8, .55);

      // сукно
      var feltD = half(0, top);
      var cp = svgEl('clipPath', { id: 'bj-felt-clip' }, defs);
      svgEl('path', { d: feltD }, cp);
      svgEl('path', { d: feltD, fill: 'url(#bj-felt-grad)' }, svg);
      svgEl('path', { d: feltD, fill: 'url(#bj-felt-pat2)' }, svg);
      svgEl('path', { d: feltD, fill: 'url(#bj-felt-pat)' }, svg);
      var fc = svgEl('g', { 'clip-path': 'url(#bj-felt-clip)' }, svg);
      // конус лампы над столом: центр ярче, края темнее; блик на ворсе
      var cw = board ? 1500 : f.rx * 1.6, ch = board ? 760 : f.ry * 0.95;
      svgEl('ellipse', { cx: f.cx, cy: f.cy + (board ? 230 : f.ry * 0.3), rx: cw / 2, ry: ch / 2, fill: 'url(#bj-felt-cone)' }, fc);
      svgEl('ellipse', { cx: f.cx, cy: f.cy + (board ? 250 : f.ry * 0.3), rx: cw / 3.4, ry: ch / 4.6, fill: 'url(#bj-felt-sheen)' }, fc);
      if (board) {
        // два дополнительных пятна под абажурами и тень Марго у дилерской кромки
        [500, 1420].forEach(function (x) { svgEl('ellipse', { cx: x, cy: 540, rx: 300, ry: 190, fill: 'url(#bj-felt-cone)', opacity: .55 }, fc); });
        var ms = svgEl('radialGradient', { id: 'bj-margot-shadow', cx: '50%', cy: '50%', r: '50%' }, defs);
        stops(ms, [['0', '#000', .5], ['1', '#000', 0]]);
        svgEl('ellipse', { cx: f.cx, cy: top + 70, rx: 330, ry: 70, fill: 'url(#bj-margot-shadow)' }, fc);
      }
      svgEl('path', { d: feltD, fill: 'url(#bj-felt-vig)' }, svg);
      // внутренняя тень борта на сукне
      var ins = svgEl('g', { 'clip-path': 'url(#bj-felt-clip)' }, svg);
      var wi = board ? 1 : 0.5;
      [[2, 14, .5], [10, 22, .26], [24, 40, .14]].forEach(function (s) { svgEl('path', { d: half(-s[0] * wi - 2, top + s[0] * wi), fill: 'none', stroke: '#000a05', 'stroke-width': s[1] * wi, opacity: s[2] }, ins); });
      // внутренняя дуга с золотой каймой по сукну
      svgEl('path', { d: half(-14 * Math.max(.6, k), top + 14 * Math.max(.6, k)), fill: 'none', stroke: 'url(#bj-gold-lin)', 'stroke-width': board ? 1.4 : 1, opacity: .5 }, svg);
      svgEl('path', { d: half(-19 * Math.max(.6, k), top + 19 * Math.max(.6, k)), fill: 'none', stroke: '#e2b84a', 'stroke-width': .7, opacity: .22 }, svg);

      // печать на сукне: дуги текста
      function arcPath(id, rx, ry) {
        var a = board ? 0.3 : 0.2;
        var x0 = f.cx - rx * Math.cos(a), y0 = f.cy + ry * Math.sin(a), x1 = f.cx + rx * Math.cos(a);
        svgEl('path', { id: id, d: 'M' + x0 + ' ' + y0 + ' A' + rx + ' ' + ry + ' 0 0 0 ' + x1 + ' ' + y0, fill: 'none' }, defs);
      }
      function arcText(id, cls, str) {
        var t = svgEl('text', { 'class': cls, 'text-anchor': 'middle' }, svg);
        var tp = svgEl('textPath', { startOffset: '50%' }, t);
        tp.setAttribute('href', '#' + id);
        tp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + id);
        tp.textContent = str;
      }
      var A = G.arcs;
      arcPath('bj-arc-ins', A.ins[0], A.ins[1]);
      arcPath('bj-arc-big', A.big[0], A.big[1]);
      arcPath('bj-arc-mid', A.mid[0], A.mid[1]);
      // полоса страховки: две золотые линии (тёмная подложка + металлик)
      var ia = board ? 0.3 : 0.2, kk2 = board ? 20 : 10;
      [A.ins[0] - kk2, A.ins[0] + kk2].forEach(function (rx, i) {
        var ry = A.ins[1] + (i ? kk2 : -kk2);
        var x0 = f.cx - rx * Math.cos(ia), y0 = f.cy + ry * Math.sin(ia), x1 = f.cx + rx * Math.cos(ia);
        var d = 'M' + x0 + ' ' + y0 + ' A' + rx + ' ' + ry + ' 0 0 0 ' + x1 + ' ' + y0;
        svgEl('path', { d: d, fill: 'none', stroke: '#02160d', 'stroke-width': board ? 3.6 : 2.2, opacity: .55, transform: 'translate(0 1.4)' }, svg);
        svgEl('path', { d: d, fill: 'none', stroke: '#e9c458', 'stroke-width': board ? 1.7 : 1, opacity: .85 }, svg);
      });
      arcText('bj-arc-ins', 'bj-print-ins', 'INSURANCE PAYS 2 TO 1');
      arcText('bj-arc-big', 'bj-print-big', 'BLACKJACK PAYS 3 TO 2');
      arcText('bj-arc-mid', 'bj-print-mid', 'DEALER MUST STAND ON 17 AND DRAW TO 16');
    }

    // ---------- раскладка боксов ----------
    function computeSlots(n) {
      if (layout === 'solo') return [{ x: 210, y: 650, rot: 0, size: 'big' }];
      if (layout === 'solo-wide') return [{ x: 600, y: 346, rot: 0, size: 'big' }];
      var B = G.boxes, size = n <= 6 ? 'big' : n <= 9 ? 'mid' : 'small';
      var a0 = n <= 4 ? 0.62 : n <= 6 ? 0.5 : n <= 9 ? 0.4 : 0.3;
      var rx = n >= 10 ? 780 : B.rx, ry = n >= 10 ? 520 : B.ry, cy = n >= 10 ? 368 : B.cy;
      var pts = arcPoints(B.cx, cy, rx, ry, a0, Math.PI - a0, Math.max(1, n));
      var out = [];
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], ang = Math.atan2(p.y - G.felt.cy, p.x - G.felt.cx);
        out.push({ x: p.x, y: p.y, rot: (ang - Math.PI / 2) * 0.45 * 180 / Math.PI, size: size });
      }
      return out;
    }
    function applySize(size) {
      var w = size === 'big' ? 100 : size === 'mid' ? 86 : 76;
      if (layout === 'solo') w = 92;
      if (layout === 'solo-wide') w = 80;
      root.style.setProperty('--bj-card-w', w + 'px');
      root.style.setProperty('--bj-card-h', Math.round(w * 1.4) + 'px');
      root.style.setProperty('--bj-chip', (size === 'big' ? 40 : 32) + 'px');
      S.cardW = w; S.cardH = Math.round(w * 1.4); S.size = size;
    }
    function drawPrintBoxes(slots) {
      while (printBoxes.firstChild) printBoxes.removeChild(printBoxes.firstChild);
      var r = S.size === 'big' ? 36 : 28;
      if (layout === 'solo') r = 34;
      if (layout === 'solo-wide') r = 30;
      slots.forEach(function (s, i) {
        // утопленная «вышитая» заливка, золотое кольцо, тонкое внешнее кольцо и номер места
        svgEl('circle', { cx: s.x, cy: s.y, r: r, fill: 'url(#bj-pit)' }, printBoxes);
        svgEl('circle', { cx: s.x, cy: s.y + 1.5, r: r - 1.5, fill: 'none', stroke: '#000', 'stroke-width': 3, opacity: .35 }, printBoxes);
        svgEl('circle', { cx: s.x, cy: s.y, r: r, fill: 'none', stroke: 'url(#bj-gold-lin)', 'stroke-width': 2.6 }, printBoxes);
        svgEl('circle', { cx: s.x, cy: s.y, r: r + 6, fill: 'none', stroke: '#e2b84a', 'stroke-width': .9, opacity: .5 }, printBoxes);
        if (layout !== 'solo' && layout !== 'solo-wide') svgEl('text', { x: s.x, y: s.y + r - 9, 'class': 'bj-print-box bj-seatno', 'text-anchor': 'middle' }, printBoxes).textContent = String(i + 1);
      });
    }

    // ---------- боксы и рельс ----------
    function ensureBox(p) {
      var b = S.boxes[p.id];
      if (b) return b;
      var node = el('div', 'bj-box');
      node.style.cssText = chipVars(p.color || COLORS[p.seat % 12]);
      var ring = el('div', 'bj-ring'); ring.appendChild(el('i')); node.appendChild(ring);
      var hands = el('div', 'bj-hands'); node.appendChild(hands);
      var bet = el('div', 'bj-bet'); node.appendChild(bet);
      var net = el('div', 'bj-net'); node.appendChild(net);
      var plaque = el('div', 'bj-plaque'); node.appendChild(plaque);
      var mark = el('div', 'bj-mark'); node.appendChild(mark);
      var tag = el('div', 'bj-tag');
      var av = el('span', 'bj-av'); tag.appendChild(av);
      var nm = el('span', 'bj-nm'); tag.appendChild(nm);
      var ins = el('span', 'bj-ins'); tag.appendChild(ins);
      node.appendChild(tag);
      boxesWrap.appendChild(node);
      b = { el: node, hands: {}, handsEl: hands, betEl: bet, net: net, plaque: plaque, mark: mark, av: av, nm: nm, ins: ins, ring: ring, tag: tag, bet: 0, side: { pp: 0, tp: 0 }, stacks: {}, slot: null, out: false };
      S.boxes[p.id] = b;
      return b;
    }
    function ensureHand(b, idx) {
      var h = b.hands[idx];
      if (h) return h;
      var node = el('div', 'bj-hand');
      var cards = el('div', 'bj-cards'); node.appendChild(cards);
      var score = el('div', 'bj-score'); node.appendChild(score);
      var dec = el('div', 'bj-dec'); node.appendChild(dec);
      b.handsEl.appendChild(node);
      h = { el: node, cardsEl: cards, score: score, dec: dec, cards: [], n: 0, value: 0, bust: false, bj: false, shown21: false, shownBust: false, shownBj: false, result: null, pending: 0 };
      b.hands[idx] = h;
      return h;
    }
    function placeHands(b, count) {
      var w = S.cardW, hGap = w * 0.95;
      for (var i = 0; i < count; i++) {
        var h = ensureHand(b, i);
        var dx = count === 1 ? 0 : (i - (count - 1) / 2) * (w * (isSolo ? 1.22 : 1.62));
        h.el.style.transform = 'translate(' + dx + 'px,0)' + (isSolo && count > 1 ? ' scale(.84)' : '');
      }
      b.handsEl.classList.toggle('two', count > 1);
      for (var k in b.hands) if (parseInt(k, 10) >= count) { b.handsEl.removeChild(b.hands[k].el); delete b.hands[k]; }
    }
    // позиция карт в руке: диагональный каскад + лёгкий веер, контейнер наклонён к дилеру
    function cardTransform(i, n) {
      var w = S.cardW, h = S.cardH;
      var step = n <= 3 ? w * 0.34 : Math.min(w * 0.34, (w * 1.1) / Math.max(1, n - 1));
      var x = i * step - (n - 1) * step / 2 - w / 2, y = -h / 2 - i * 5;
      var rot = (i - (n - 1) / 2) * 3;
      return 'translate(' + x + 'px,' + y + 'px) rotate(' + rot + 'deg)';
    }
    function layoutCards(h) {
      var n = h.cards.length;
      for (var i = 0; i < n; i++) { var c = h.cards[i]; if (!c.classList.contains('is-flying')) c.style.transform = cardTransform(i, n); }
    }
    function handsOrigin(slot) {
      // контейнер рук: над кружком, повёрнут к дилеру
      return 'translate(0px,' + (-S.cardH * 0.62 - 10) + 'px) rotate(' + slot.rot.toFixed(1) + 'deg)';
    }
    function placeBox(b, slot) {
      b.slot = slot;
      b.el.style.transform = 'translate(' + slot.x.toFixed(1) + 'px,' + slot.y.toFixed(1) + 'px)';
      b.handsEl.style.transform = handsOrigin(slot);
      b.tag.style.top = (isSolo ? 42 : (S.size === 'big' ? 44 : 36)) + 'px';
    }
    function setAvatar(node, p) {
      node.textContent = isEmoji(p.avatar) ? p.avatar : initials(p.name);
      node.style.fontSize = isEmoji(p.avatar) ? '18px' : '';
    }
    function ensureSeat(p) {
      var s = S.seats[p.id];
      if (s) return s;
      var node = el('div', 'bj-seat');
      node.style.cssText = chipVars(p.color || COLORS[p.seat % 12]);
      var av = el('span', 'bj-av'); node.appendChild(av);
      var nm = el('span', 'bj-nm'); node.appendChild(nm);
      var st = el('span', 'bj-st'); node.appendChild(st);
      var rn = el('span', 'bj-rn'); node.appendChild(rn);
      rail.appendChild(node);
      s = { el: node, av: av, nm: nm, st: st, rn: rn, stack: null };
      S.seats[p.id] = s;
      return s;
    }
    function renderStack(container, key, amount, color, min, label, pos, side) {
      var st = container.querySelector('[data-stack="' + key + '"]');
      if (!amount) { if (st) container.removeChild(st); return null; }
      var layers = stackLayers(amount, min);
      if (!st) {
        st = el('div', 'bj-stack' + (side ? ' is-side' : ''));
        st.setAttribute('data-stack', key);
        container.appendChild(st);
      }
      st.style.cssText = chipVars(color) + ';left:' + pos.x + 'px;top:' + pos.y + 'px';
      var chips = st.querySelectorAll('.bj-chip');
      if (chips.length !== layers) {
        while (st.firstChild) st.removeChild(st.firstChild);
        for (var i = 0; i < layers; i++) { var c = el('div', 'bj-chip'); c.style.transform = 'translateY(' + (-i * 3.5) + 'px)'; st.appendChild(c); }
        var amt = el('span', 'bj-amt' + (amount >= 1000 ? ' is-long' : ''), String(Math.round(amount))); amt.style.transform = 'translate(-50%,-50%) translateY(' + (-(layers - 1) * 3.5) + 'px)'; st.appendChild(amt);
        if (label) st.appendChild(el('span', 'bj-side-lbl', label));
      } else {
        st.querySelector('.bj-amt').textContent = String(Math.round(amount)); st.querySelector('.bj-amt').classList.toggle('is-long', amount >= 1000);
      }
      st.classList.remove('is-gone');
      return st;
    }

    // ---------- карты: полёт из шуза ----------
    function shoePoint() { return { x: G.shoe.x, y: G.shoe.y }; }
    // cardEl уже стоит на месте; измеряем, откуда лететь, ставим стартовый transform, запускаем переход
    function flyIn(cardEl, finalTransform, parentRot, delay, cb, opts) {
      opts = opts || {};
      var instant = !!opts.instant;
      cardEl.style.transform = finalTransform;
      if (instant) { cardEl.classList.remove('is-down'); if (opts.keepDown) cardEl.classList.add('is-down'); if (cb) cb(); return; }
      cardEl.classList.add('is-down');
      cardEl.style.visibility = 'hidden';
      later(function () {
        var c = lcenter(cardEl), from = shoePoint();
        var dx = from.x - c.x, dy = from.y - c.y;
        var r = -parentRot * Math.PI / 180, ldx = dx * Math.cos(r) - dy * Math.sin(r), ldy = dx * Math.sin(r) + dy * Math.cos(r);
        cardEl.style.transition = 'none';
        cardEl.style.transform = 'translate(' + ldx + 'px,' + ldy + 'px) ' + finalTransform + ' rotate(18deg) scale(1.04)';
        cardEl.style.visibility = '';
        void cardEl.getBoundingClientRect();
        cardEl.style.transition = '';
        cardEl.classList.add('is-flying');
        cardEl.style.transform = finalTransform;
        sfx('slide');
        var dur = 300 * K();
        later(function () {
          cardEl.classList.remove('is-flying');
          var pause = opts.hit ? 150 * K() : 20;
          if (opts.keepDown) { if (cb) cb(); return; }
          later(function () {
            if (opts.slow) cardEl.classList.add('flip-slow');
            if (opts.last) cardEl.classList.add('flip-last');
            cardEl.classList.remove('is-down');
            sfx('flip');
            var fl = (opts.slow ? 600 : opts.last ? 620 : 250) * K();
            later(function () { cardEl.classList.remove('flip-slow'); cardEl.classList.remove('flip-last'); if (cb) cb(); }, fl + 30);
          }, pause);
        }, dur + 20);
      }, delay);
    }
    // очередь полётов: карты идут одна за другой с шагом step
    function queueSlot(step) {
      var now = Date.now();
      S.dealClock = Math.max(S.dealClock + step, now);
      return S.dealClock - now;
    }

    // ---------- счёт ----------
    function crackSvg() {
      var s = svgEl('svg', { 'class': 'bj-crack', viewBox: '0 0 100 60', preserveAspectRatio: 'none' });
      svgEl('path', { d: 'M48 0 L44 18 L56 26 L46 40 L58 50 L52 60', fill: 'none', stroke: '#e9eef7', 'stroke-width': 2.2, 'stroke-linejoin': 'round' }, s);
      svgEl('path', { d: 'M56 26 L72 22 M46 40 L30 44', fill: 'none', stroke: '#e9eef7', 'stroke-width': 1.4 }, s);
      return s;
    }
    function setScore(node, value, soft, bust, bj, animate, done) {
      if (!value) { node.classList.remove('on'); return; }
      var txt = bj ? T('blackjack').toUpperCase() : softText(value, soft, done);
      var html = txt.indexOf('/') >= 0 ? txt.split(' / ')[0] + '<small>/</small>' + txt.split(' / ')[1] : esc(txt);
      if (node.getAttribute('data-v') !== txt) {
        node.innerHTML = html;
        node.setAttribute('data-v', txt);
        if (animate) { node.classList.remove('flip'); void node.offsetWidth; node.classList.add('flip'); }
      }
      node.classList.add('on');
      node.classList.toggle('is-21', !bj && value === 21 && !bust);
      node.classList.toggle('is-bj', !!bj);
      if (bust) { if (!node.querySelector('.bj-crack')) node.appendChild(crackSvg()); node.classList.add('is-bust'); }
      else node.classList.remove('is-bust');
    }

    // ---------- canvas: частицы и полёт фишек ----------
    function drawChip(c, x, y, r, color, label) {
      c.save();
      c.translate(x, y);
      c.beginPath(); c.arc(2, 3, r, 0, Math.PI * 2); c.fillStyle = 'rgba(0,0,0,.45)'; c.fill();
      c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fillStyle = color; c.fill();
      c.strokeStyle = shade(color, 0.55); c.lineWidth = 1.5; c.stroke();
      c.strokeStyle = lum(color) > 0.55 ? '#2b2118' : '#fff6e2'; c.lineWidth = r * 0.3;
      for (var i = 0; i < 8; i++) { c.beginPath(); c.arc(0, 0, r * 0.78, i * Math.PI / 4, i * Math.PI / 4 + 0.26); c.stroke(); }
      c.beginPath(); c.arc(0, 0, r * 0.5, 0, Math.PI * 2); c.fillStyle = '#f6f1e4'; c.fill();
      c.strokeStyle = shade(color, 0.55); c.lineWidth = 1; c.stroke();
      if (label) { c.fillStyle = '#15110e'; c.font = '700 ' + Math.round(r * 0.62) + 'px "Inter Tight", Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, 0, 1); }
      c.restore();
    }
    function addFlight(f) {
      f.t0 = performance.now(); f.dur = f.dur || 500 * K();
      if (!fx && f.quick !== false) f.dur *= 0.5;
      S.flights.push(f); loop();
    }
    function burst(x, y, n, kind, spread) {
      if (!fx && kind !== 'coin') n = Math.floor(n / 3);
      var cap = 400 - S.particles.length; if (n > cap) n = Math.max(0, cap);
      var golds = ['#f3dd8a', '#d4af37', '#fff3c4', '#b8902a'];
      var confetti = ['#f3dd8a', '#d4af37', '#f3efe4', '#c8102e', '#4ea8f2', '#9fe8ff'];
      for (var i = 0; i < n; i++) {
        var a = kind === 'rain' ? Math.PI / 2 + (Math.random() - 0.5) * 0.6 : Math.random() * Math.PI * 2;
        var sp = kind === 'rain' ? 60 + Math.random() * 120 : (spread || 220) * (0.4 + Math.random());
        S.particles.push({
          x: kind === 'rain' ? Math.random() * G.W : x, y: kind === 'rain' ? -20 - Math.random() * 300 : y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (kind === 'wave' ? 120 : 0),
          life: 1, decay: kind === 'rain' ? 0.25 + Math.random() * 0.2 : 0.9 + Math.random() * 0.8,
          size: kind === 'coin' ? 5 + Math.random() * 4 : kind === 'rain' ? 6 + Math.random() * 6 : 2 + Math.random() * 3,
          color: (kind === 'rain' ? confetti : golds)[Math.floor(Math.random() * (kind === 'rain' ? confetti.length : golds.length))],
          kind: kind, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8
        });
      }
      loop();
    }
    function fpsSample(dt) { S.fpsSamples.push(dt); if (S.fpsSamples.length > 240) S.fpsSamples.shift(); }
    function loop() {
      if (S.raf || S.frozen) return;
      S.raf = requestAnimationFrame(frame);
    }
    function frame(t) {
      S.raf = 0;
      var dt = S.lastFrame ? Math.min(0.05, (t - S.lastFrame) / 1000) : 0.016;
      if (S.lastFrame) fpsSample(t - S.lastFrame);
      S.lastFrame = t;
      if (margot) margot.tick(t);
      tickTimer();
      var c = ctx2d;
      // холст чистим только когда на нём что-то было: в покое кадр бесплатный
      var busy = S.flights.length || S.particles.length;
      if (!busy && !S.canvasDirty) { S.raf = requestAnimationFrame(frame); return; }
      c.clearRect(0, 0, G.W, G.H);
      S.canvasDirty = !!busy;
      // полёты фишек
      for (var i = S.flights.length - 1; i >= 0; i--) {
        var f = S.flights[i], k = Math.min(1, (t - f.t0) / f.dur), e = 1 - Math.pow(1 - k, 3);
        var x = f.x0 + (f.x1 - f.x0) * e, y = f.y0 + (f.y1 - f.y0) * e - Math.sin(k * Math.PI) * (f.arc || 40);
        var n = f.layers || 1;
        for (var j = 0; j < n; j++) drawChip(c, x, y - j * 3.5, f.r || 19, f.color, j === n - 1 ? f.label : null);
        if (k >= 1) { S.flights.splice(i, 1); if (f.onDone) f.onDone(); }
      }
      // частицы
      for (var p = S.particles.length - 1; p >= 0; p--) {
        var q = S.particles[p];
        q.life -= q.decay * dt; if (q.life <= 0) { S.particles.splice(p, 1); continue; }
        q.vy += (q.kind === 'rain' ? 140 : 420) * dt; q.vx *= (q.kind === 'rain' ? 0.995 : 0.98);
        q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vr * dt;
        c.globalAlpha = Math.min(1, q.life * 1.5);
        c.fillStyle = q.color;
        if (q.kind === 'rain') { c.save(); c.translate(q.x, q.y); c.rotate(q.rot); c.fillRect(-q.size / 2, -q.size / 4, q.size, q.size / 2); c.restore(); }
        else if (q.kind === 'coin') { c.save(); c.translate(q.x, q.y); c.scale(Math.abs(Math.cos(q.rot)), 1); c.beginPath(); c.arc(0, 0, q.size, 0, Math.PI * 2); c.fill(); c.restore(); }
        else { c.beginPath(); c.arc(q.x, q.y, q.size * q.life, 0, Math.PI * 2); c.fill(); }
      }
      c.globalAlpha = 1;
      // цикл живёт всегда (Марго моргает, таймер идёт), но дёшево
      S.raf = requestAnimationFrame(frame);
    }

    // ---------- таймер ----------
    function tickTimer() {
      var s = S.snap; if (!s) return;
      var ps = S.phaseSeen;
      if (!s.phaseEndsAt || !ps.endsAt) { timerBar.style.transform = 'scaleX(0)'; timerEl.classList.remove('is-hot'); timerLabel.textContent = ''; return; }
      var now = Date.now() + (S.clockOffset || 0);
      var total = Math.max(1000, ps.endsAt - ps.at), left = Math.max(0, ps.endsAt - now);
      timerBar.style.transform = 'scaleX(' + Math.min(1, left / total).toFixed(3) + ')';
      var hot = left < 5000 && left > 0 && (s.phase === 'betting' || s.phase === 'deciding' || s.phase === 'insurance');
      if (hot && !timerEl.classList.contains('is-hot') && s.phase !== 'insurance') { emote('drum'); autoLine('drum', true); }
      timerEl.classList.toggle('is-hot', hot);
      var sec = Math.ceil(left / 1000);
      var dk = sec + ':' + S.decN + '/' + S.decM;
      if (timerLabel.getAttribute('data-s') !== dk) {
        timerLabel.setAttribute('data-s', dk);
        var lbl = s.phase === 'betting' ? T('timerBets') : s.phase === 'insurance' ? T('timerIns') : s.phase === 'deciding' ? T('timerDecide') : T('ph_' + s.phase);
        timerLabel.innerHTML = lbl + (s.phase === 'deciding' && s.wave ? ' · ' + T('wave') + ' ' + s.wave : '') + (s.phase === 'deciding' && S.decM ? ' · ' + T('decided') + ' <b>' + S.decN + '/' + S.decM + '</b>' : '') + ' <b>' + sec + '</b>' + T('sec');
        if (hot && sec > 0) sfx('tick', true);
      }
    }

    // ---------- HUD ----------
    function renderHud(s, prev) {
      H.levelK.textContent = T('level'); H.minK.textContent = T('min'); H.handK.textContent = T('hand');
      var lvl = (s.level || 0) + (levelBase === 0 ? 1 : 0); // показываем человеческий номер
      H.levelV.textContent = Math.max(1, lvl);
      H.minV.textContent = fmt(s.minBet || 0);
      H.handV.textContent = s.hand || 0;
      H.minSub.textContent = s.shoe ? T('shoeLeft') + ' ' + Math.round((s.shoe.left || 0) * 100) + '%' : '';
      H.handSub.textContent = s.handsTotal ? '/ ' + s.handsTotal : (s.cutIn === 0 ? T('cutNow') : s.cutIn ? T('cut') + ': ' + s.cutIn : '');
      if (H.pips.children.length !== 10) { H.pips.innerHTML = ''; for (var i = 0; i < 10; i++) H.pips.appendChild(el('i')); }
      for (var j = 0; j < 10; j++) { var pip = H.pips.children[j]; pip.className = j < lvl - 1 ? 'on' : j === lvl - 1 ? 'cur' : ''; }
      phaseEl.textContent = s.phaseEndsAt ? '' : (T('ph_' + s.phase) || '');
      if (prev && prev.level !== s.level) { H.levelV.classList.remove('bump'); void H.levelV.offsetWidth; H.levelV.classList.add('bump'); H.minV.classList.remove('bump'); void H.minV.offsetWidth; H.minV.classList.add('bump'); }
      if (s.shoe) {
        shoeStack.style.transform = 'scaleY(' + Math.max(0.08, Math.min(1, s.shoe.left || 0)).toFixed(2) + ')';
        shoeLeft.textContent = Math.round((s.shoe.left || 0) * 100) + '%';
      }
    }

    // ---------- центральные плашки ----------
    function showCenter(html, cls, ms) {
      center.className = 'bj-center on' + (cls ? ' ' + cls : '');
      center.innerHTML = '<div class="bj-plate">' + html + '</div>';
      if (ms) later(function () { if (center.classList.contains(cls)) center.classList.remove('on'); }, ms);
    }
    function hideCenter() { center.classList.remove('on'); }
    function showBanner(title, sub, cls, sticky) {
      banner.className = 'bj-banner' + (cls ? ' ' + cls : '') + (sticky ? ' is-sticky' : '');
      banner.innerHTML = '<span class="bj-bt">' + title + '</span>' + (sub ? '<span class="bj-bs">' + sub + '</span>' : '');
      void banner.offsetWidth;
      banner.classList.add('on');
    }
    function hideBanner() { banner.className = 'bj-banner'; }
    function flashAt(x, y) {
      if (!fx) return;
      flash.style.setProperty('--x', (x / G.W * 100).toFixed(1) + '%'); flash.style.setProperty('--y', (y / G.H * 100).toFixed(1) + '%');
      flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    }
    function esc(s) { return String(s || '').replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

    // ---------- главный render ----------
    function render(snap) {
      if (!snap) return;
      var prev = S.prev, now = Date.now();
      S.snap = snap;
      S.clockOffset = typeof snap.now === 'number' ? snap.now - now : 0;
      // «переподключение»: большой разрыв по времени И при этом сменилась раздача или фаза (в соло игрок может думать
      // сколько угодно — сам по себе разрыв не повод рисовать без анимации); instantGapMs: Infinity отключает
      var gap = (typeof snap.now === 'number' && typeof prev_now(prev) === 'number') ? snap.now - prev.now : 0;
      var ORD = { lobby: 0, betting: 1, closing: 2, dealing: 3, insurance: 4, deciding: 5, dealer: 6, payout: 7, finished: 8 };
      var po = prev ? ORD[prev.phase] : 0, no = ORD[snap.phase];
      // прыжок = назад по фазам в той же раздаче, вперёд на 3+ фаз, или новая раздача посреди чужой фазы;
      // betting→closing→dealing подряд (ставки с картами-пакостями тянутся 5–7 с) — всегда анимируем
      var jumped = !!prev && ((prev.hand === snap.hand && (no < po || no - po >= 3)) || (prev.hand !== snap.hand && po !== undefined && po < 7));
      var instant = !prev || (gap > instantGapMs && jumped) || (prev && prev.hand !== snap.hand && prev.phase !== 'payout' && prev.phase !== 'betting' && prev.phase !== 'finished' && prev.phase !== 'lobby' && prev.phase !== 'closing');
      var players = (snap.players || []).slice().sort(function (a, b) { return (a.seat || 0) - (b.seat || 0); });
      var phaseChanged = !prev || prev.phase !== snap.phase;
      if (phaseChanged) { S.phaseSeen = { phase: snap.phase, at: now + S.clockOffset, endsAt: snap.phaseEndsAt || 0 }; }
      else if (snap.phaseEndsAt && snap.phaseEndsAt !== S.phaseSeen.endsAt) { S.phaseSeen.endsAt = snap.phaseEndsAt; }

      // новая раздача — чистим стол
      if (prev && prev.hand !== snap.hand) newHand(snap);

      // размер и раскладка
      var slots = computeSlots(players.length);
      var sizeChanged = !S.slots.length || S.slots.length !== slots.length || S.slots[0].size !== slots[0].size;
      if (sizeChanged) { applySize(slots[0].size); drawPrintBoxes(slots); }
      S.slots = slots;

      renderHud(snap, prev);
      renderDealer(snap, prev, instant);
      renderPlayers(snap, prev, players, slots, instant, phaseChanged);
      renderRail(snap, prev, players);
      if (phaseChanged) onPhase(snap, prev, players);
      handleEvents(snap);
      // тасовка
      var rs = !!(snap.shoe && snap.shoe.reshuffle);
      if (rs && !S.shuffleSeen) { S.shuffleSeen = true; doShuffle(); }
      if (!rs) S.shuffleSeen = false;
      // уровень вырос
      if (prev && snap.level > prev.level && snap.phase !== 'lobby') levelUp(snap);
      S.prev = snap;
      loop();
    }

    function prev_now(p) { return p ? p.now : undefined; }

    function newHand(snap) {
      // карты уезжают в дискард, результаты и решения гаснут
      var all = stage.querySelectorAll('.bj-card');
      var d = G.discard;
      for (var i = 0; i < all.length; i++) (function (c, i) {
        var p = lcenter(c);
        c.style.transition = 'transform ' + (350 * K()) + 'ms ease-in ' + (i * 12) + 'ms, opacity .2s ease-in ' + (i * 12 + 200) + 'ms';
        c.style.transform = 'translate(' + (d.x - p.x) + 'px,' + (d.y - p.y) + 'px) rotate(-8deg) scale(.6)';
        c.style.opacity = '0';
        c.style.pointerEvents = 'none';
        later(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 600 + i * 12);
      })(all[i], i);
      if (all.length) sfx('whoosh');
      for (var pid in S.boxes) {
        var b = S.boxes[pid];
        for (var k in b.hands) { var h = b.hands[k]; h.cards = []; h.n = 0; h.value = 0; h.bust = false; h.bj = false; h.shown21 = h.shownBust = h.shownBj = false; h.result = null; h.pending = 0; h.score.className = 'bj-score'; h.score.removeAttribute('data-v'); h.dec.className = 'bj-dec'; h.el.className = 'bj-hand'; }
        b.plaque.className = 'bj-plaque'; b.net.className = 'bj-net'; b.sideShown = {};
        b.bet = 0; b.side = { pp: 0, tp: 0 };
        var sts = b.betEl.querySelectorAll('.bj-stack'); for (var j = 0; j < sts.length; j++) b.betEl.removeChild(sts[j]);
      }
      S.dealerCards = []; S.dealerShown = 0; dscore.className = 'bj-dscore'; dscore.removeAttribute('data-v'); dealer.classList.remove('is-zoom');
      if (S.plan) { S.plan = null; }
      dim.className = 'bj-dim'; hideBanner();
      S.allinOn = false; S.payoutHand = null;
      if (window.BJSfx) window.BJSfx.duck(1);
    }

    // ---------- игроки ----------
    function renderPlayers(snap, prev, players, slots, instant, phaseChanged) {
      var seen = {};
      S.decN = 0; S.decM = 0;
      var activeX = null, activeN = 0;
      players.forEach(function (p, idx) {
        seen[p.id] = true;
        var b = ensureBox(p), slot = slots[idx] || slots[slots.length - 1];
        if (!b.slot || b.slot.x !== slot.x || b.slot.y !== slot.y || b.slot.size !== slot.size) placeBox(b, slot);
        setAvatar(b.av, p); b.nm.textContent = p.name || '';
        b.el.classList.toggle('is-out', !!p.out);
        b.el.classList.toggle('is-offline', p.online === false && !p.out);
        if (p.out && !b.out) { b.out = true; if (prev) playerOut(b, p); }
        if (!p.out) b.out = false;
        // страховка / even money
        b.ins.textContent = p.evenMoney ? T('even') : (p.insurance ? T('ins') + ' ' + fmt(p.insurance) : '');
        // ставка
        var min = snap.minBet || 10, color = p.color || COLORS[p.seat % 12];
        var betPos = { x: 0, y: 0 };
        if ((p.bet || 0) !== b.bet) {
          var st = renderStack(b.betEl, 'main', p.bet || 0, color, min, null, betPos, false);
          if (st && (p.bet || 0) > b.bet && !instant) { st.classList.remove('drop'); void st.offsetWidth; st.classList.add('drop'); sfx(stackLayers(p.bet, min) > 1 ? 'stack' : 'chip', stackLayers(p.bet, min)); b.ring.classList.remove('ping'); void b.ring.offsetWidth; b.ring.classList.add('ping'); }
          b.bet = p.bet || 0;
          if (p.bet && p.stack === 0 && snap.phase === 'betting' && !instant) { if (margot) margot.brow(); emote('lean'); autoLine('allin'); }
        }
        var side = p.side || {};
        ['pp', 'tp'].forEach(function (k, i) {
          var amt = side[k] || 0;
          if (amt !== b.side[k]) {
            var sp = { x: i === 0 ? -(S.size === 'big' ? 46 : 38) : (S.size === 'big' ? 46 : 38), y: 6 };
            var st2 = renderStack(b.betEl, k, amt, color, min, i === 0 ? T('pair') : T('poker'), sp, true);
            if (st2 && amt > b.side[k] && !instant) { st2.classList.add('drop'); sfx('chip'); }
            b.side[k] = amt;
          }
        });
        // руки
        var hands = p.hands || [];
        if (hands.length !== Object.keys(b.hands).length) {
          var wasOne = Object.keys(b.hands).length === 1 && hands.length === 2 && b.hands[0] && b.hands[0].cards.length === 2;
          placeHands(b, Math.max(1, hands.length));
          if (wasOne && hands[1] && hands[1].fromSplit) doSplit(b, hands);
        }
        hands.forEach(function (hd, hi) {
          var h = ensureHand(b, hi);
          renderHand(b, h, hd, p, hi, snap, instant);
          if (snap.phase === 'deciding' && !hd.done && !p.out) { activeX += (activeX === null ? 0 : 0) + (slot.x - G.W / 2) / (G.W / 2); activeN++; }
        });
        // решение: подпись держится до конца волны/хода дилера; у думающих — пульс и кольцо на боксе
        var dec = p.decision;
        var thinking = false;
        hands.forEach(function (hd, hi) {
          var h = b.hands[hi]; if (!h) return;
          var node = h.dec;
          if (snap.phase !== 'deciding' && snap.phase !== 'dealer') h.lastDec = null;
          if (dec && snap.phase === 'deciding') h.lastDec = dec;
          if ((snap.phase === 'deciding' || snap.phase === 'dealer') && hd.done && !hd.bust && !hd.blackjack && !hd.doubled && !h.lastDec && hd.value < 21 && hd.cards && hd.cards.length > 1) h.lastDec = 'stand';
          if (snap.phase === 'deciding' && !hd.done && !p.out && !hd.bust) {
            if (!dec) { thinking = true; node.className = 'bj-dec on is-think'; if (!node.querySelector('i')) node.innerHTML = '<span>' + esc(T('thinking')) + '</span><i></i><i></i><i></i>'; }
            else {
              var txt = dec === 'hit' ? T('hit') : dec === 'stand' ? T('stand') : dec === 'double' ? T('double') : T('split');
              if (node.textContent !== txt || !node.classList.contains('on')) {
                node.className = 'bj-dec on' + (dec === 'double' ? ' is-double' : '');
                node.textContent = txt;
                if (!instant && dec === 'hit' && hd.value === 16 && !hd.soft && margot) { margot.brow(); emote('sly'); autoLine('hit16'); }
                if (!instant && dec === 'hit' && hd.value >= 19 && !hd.soft && margot) { emote('facepalm'); autoLine('hit20', true); }
                if (!instant && dec === 'double' && margot) margot.brow();
              }
            }
          } else if (hd.doubled && snap.phase !== 'payout' && snap.phase !== 'betting') { node.className = 'bj-dec on is-double'; node.textContent = T('double'); }
          else if (h.lastDec && !hd.bust && (snap.phase === 'deciding' || snap.phase === 'dealer')) {
            var t2 = h.lastDec === 'hit' ? T('hit') : h.lastDec === 'stand' ? T('stand') : h.lastDec === 'double' ? T('double') : T('split');
            node.className = 'bj-dec on' + (h.lastDec === 'double' ? ' is-double' : ''); node.textContent = t2;
          }
          else node.className = 'bj-dec';
        });
        b.el.classList.toggle('is-thinking', thinking);
        if (snap.phase === 'deciding' && !p.out && hands.length) { S.decM++; if (!thinking) S.decN++; }
        // побочные ставки решились
        var sr = p.sideResults || {};
        ['pp', 'tp'].forEach(function (k) {
          var r = sr[k];
          if (r && !(b.sideShown && b.sideShown[k])) {
            b.sideShown = b.sideShown || {}; b.sideShown[k] = true;
            if (!instant) sideWin(b, p, k, r, snap);
          }
        });
        // спасение по событию/флагу
        if (p.rescued && !b.rescuedShown) { b.rescuedShown = true; if (!instant) later(function () { rescue(b, p); }, 1200); }
        if (!p.rescued) b.rescuedShown = false;
      });
      for (var pid in S.boxes) if (!seen[pid]) { boxesWrap.removeChild(S.boxes[pid].el); delete S.boxes[pid]; }
      if (margot && snap.phase === 'deciding' && activeN) margot.lookAt(activeX / activeN);
      else if (margot && (snap.phase === 'dealer' || snap.phase === 'insurance')) margot.lookAt(0);
    }

    function renderHand(b, h, hd, p, hi, snap, instant) {
      var cards = hd.cards || [], n = cards.length;
      if (instant) { h.shownBust = !!hd.bust; h.shown21 = hd.value === 21; h.shownBj = !!hd.blackjack; }
      h.el.classList.toggle('is-done', !!hd.done);
      // новые карты
      if (n < h.cards.length) { // пересдача/обмен: убираем лишние
        while (h.cards.length > n) { var c = h.cards.pop(); if (c.parentNode) c.parentNode.removeChild(c); }
      }
      for (var i = 0; i < n; i++) {
        var ce = h.cards[i];
        if (ce && ce.getAttribute('data-card') !== cardKey(cards[i])) { ce.bjSetCard(cards[i]); }
        if (!ce) {
          ce = window.BJCards.element(cards[i], { down: !instant });
          h.cardsEl.appendChild(ce);
          h.cards.push(ce);
          (function (ce, i, hd, h, b, p) {
            layoutCards(h);
            var ft = cardTransform(i, h.cards.length);
            var isHit = i >= 2 || (hd.fromSplit && i >= 1);
            var prevVal = h.value, prevSoft = h.soft;
            var focus = isHit && !prevSoft && prevVal >= 12 && prevVal <= 16;
            if (focus && fx) h.el.classList.add('is-focus');
            h.pending++;
            var delay = instant ? 0 : queueSlot(isHit ? 350 * K() : 300 * K());
            if (!instant && snap.phase === 'dealing') setMargot('dealing');
            flyIn(ce, ft, b.slot.rot, delay, function () {
              h.pending--;
              layoutCards(h);
              afterCard(b, h, p, snap);
              if (focus) later(function () { h.el.classList.remove('is-focus'); }, 900);
              if (h.pending === 0 && snap.phase === 'dealing' && Date.now() >= S.dealClock - 50 && margot && margot.state === 'dealing') setMargot('idle');
            }, { instant: instant, hit: isHit, slow: focus });
          })(ce, i, hd, h, b, p);
        } else if (ce && !ce.classList.contains('is-flying') && !h.pending) ce.style.transform = cardTransform(i, n);
      }
      // серым рука становится только когда последняя карта уже перевёрнута (иначе перебор виден до вскрытия карты);
      // проверка — после цикла, чтобы учесть только что запущенный полёт новой карты
      if (!h.pending || instant) h.el.classList.toggle('is-bust', !!hd.bust);
      else if (!hd.bust) h.el.classList.remove('is-bust');
      // счёт — только когда карты на месте
      h.value = hd.value || 0; h.soft = !!hd.soft; h.bust = !!hd.bust; h.bj = !!hd.blackjack; h.data = hd;
      if (!h.pending) { setScore(h.score, h.value, h.soft, h.bust, h.bj, false, !!hd.done || !!hd.result); if (!n) h.score.classList.remove('on'); }
      // результат — только когда ход дилера дорисован (иначе доска выдаст итог, пока Марго ещё тянет)
      if (hd.result && h.result !== hd.result && !resultsHeld(snap)) applyResult(b, h, hd, p, snap, instant);
      if (!hd.result) h.result = null;
    }

    // ход дилера этой раздачи ещё показывается — итоги, суммы и стеки не выдаём
    function resultsHeld(snap) {
      return !!(S.plan && S.plan.hand === snap.hand && !S.plan.done);
    }
    function applyResult(b, h, hd, p, snap, instant) {
      h.result = hd.result;
      if (!instant) queuePayout(b, h, hd, p, snap);
      else h.score.classList.add('on');
    }
    // после последней карты дилера: выдать накопившиеся итоги по последнему снапшоту
    function flushResults() {
      var snap = S.snap; if (!snap) return;
      var players = (snap.players || []).slice().sort(function (a, b) { return (a.seat || 0) - (b.seat || 0); });
      players.forEach(function (p) {
        var b = S.boxes[p.id]; if (!b) return;
        (p.hands || []).forEach(function (hd, hi) {
          var h = b.hands[hi]; if (!h) return;
          if (hd.result && h.result !== hd.result) applyResult(b, h, hd, p, snap, false);
        });
      });
      renderRail(snap, S.prev, players);
    }

    // карта села: обновить счёт по последнему снапшоту, 21 / перебор / блэкджек
    function afterCard(b, h, p, snap) {
      var cur = findHand(p.id, b, h);
      if (!cur) return;
      var wasV = h.score.getAttribute('data-v');
      setScore(h.score, cur.value, cur.soft, cur.bust, cur.blackjack, true, !!cur.done || !!cur.result);
      if (!h.pending) h.el.classList.toggle('is-bust', !!cur.bust);
      var c = lcenter(h.cardsEl);
      if (cur.blackjack && !h.shownBj) {
        h.shownBj = true;
        h.cards.forEach(function (ce, i) { later(function () { ce.classList.remove('bounce'); void ce.offsetWidth; ce.classList.add('bounce'); ce.classList.add('is-glow'); }, i * 80); });
        burst(c.x, c.y, 70, 'spark', 260);
        b.plaque.innerHTML = esc(T('blackjack')) + '<small>3 : 2</small>'; b.plaque.classList.add('on');
        sfx('bj');
        setMargot('congrats', 2200); emote('wow'); autoLine('playerBj', true);
      } else if (cur.bust && !h.shownBust) {
        h.shownBust = true;
        sfx('crack');
        // перебор: «ой-ой» с ухмылкой; если следом ещё один за 3 с — хохот и реплика про коллективный перебор
        var nowB = Date.now(), multi = nowB - (S.lastBustAt || 0) < 3000;
        S.lastBustAt = nowB;
        if (multi) { emote('laugh'); autoLine('multiBust', true); } else { emote('pity'); autoLine('playerBust'); }
      } else if (cur.value === 21 && !cur.bust && !h.shown21 && !cur.blackjack) {
        h.shown21 = true;
        burst(c.x, c.y, 40, 'wave', 140);
        sfx('gold');
      }
    }
    function findHand(pid, b, h) {
      var s = S.snap; if (!s) return null;
      for (var i = 0; i < s.players.length; i++) if (s.players[i].id === pid) {
        for (var k in b.hands) if (b.hands[k] === h) return (s.players[i].hands || [])[parseInt(k, 10)] || null;
      }
      return null;
    }
    function doSplit(b, hands) {
      // вторая карта первой руки переезжает во вторую
      var h0 = b.hands[0], h1 = b.hands[1];
      if (!h0 || !h1 || h0.cards.length < 2) return;
      var ce = h0.cards.pop();
      var from = lcenter(ce);
      h1.cardsEl.appendChild(ce); h1.cards.push(ce);
      ce.style.transform = cardTransform(0, 1);
      var to = lcenter(ce);
      ce.style.transition = 'none';
      ce.style.transform = 'translate(' + (from.x - to.x) + 'px,' + (from.y - to.y) + 'px) ' + cardTransform(0, 1);
      void ce.offsetWidth;
      ce.style.transition = '';
      ce.classList.add('is-flying');
      ce.style.transform = cardTransform(0, 1);
      later(function () { ce.classList.remove('is-flying'); }, 320 * K());
      layoutCards(h0);
      h0.value = 0; h1.value = 0;
      sfx('flip');
      if (margot) margot.brow();
    }

    // ---------- побочные ставки, джекпот, спасение, выбывание ----------
    function sideWin(b, p, k, r, snap) {
      if (!r || !r.mult) return;
      var c = lcenter(b.el);
      b.ring.classList.remove('ping'); void b.ring.offsetWidth; b.ring.classList.add('ping');
      b.plaque.innerHTML = esc(k === 'pp' ? T('pair') : T('poker')) + '<small>' + esc(kindName(r.kind)).toUpperCase() + ' · ' + r.mult + ' : 1</small>';
      b.plaque.classList.add('on');
      later(function () { b.plaque.classList.remove('on'); }, 3200);
      if (r.mult >= 25) jackpotFx(b, T('jackpot') + ' ' + r.mult + ':1');
      else { burst(c.x, c.y - 40, 30, 'spark', 160); sfx('pay', 2); }
    }
    function jackpotFx(b, label) {
      var c = lcenter(b.el);
      flashAt(c.x, c.y);
      burst(c.x, c.y - 40, 160, 'coin', 320);
      burst(c.x, c.y - 40, 80, 'spark', 400);
      sfx('coins');
      b.plaque.innerHTML = esc(label) + '<small>' + esc(b.nm.textContent) + '</small>'; b.plaque.classList.add('on');
      later(function () { b.plaque.classList.remove('on'); }, 3600);
      setMargot('congrats', 2400); emote('wow'); autoLine('jackpot', true);
      // столбики фишек из лотка — щедро
      var color = b.el.style.getPropertyValue('--c') || '#d4af37';
      for (var i = 0; i < 4; i++) addFlight({ x0: G.tray.x + (i - 1.5) * 20, y0: G.tray.y, x1: c.x + (i - 1.5) * 26, y1: c.y + 2, color: color, layers: 5, dur: 600 * K() + i * 90, arc: 90 });
    }
    function rescue(b, p) {
      var c = lcenter(b.el);
      flashAt(c.x, c.y);
      b.mark.className = 'bj-mark on'; b.mark.textContent = T('saved');
      later(function () { b.mark.classList.remove('on'); }, 2600);
      burst(c.x, c.y - 60, 50, 'spark', 220);
      sfx('gold');
      emote('joy'); autoLine('rescue', true);
      var seat = S.seats[p.id]; if (seat) { seat.el.classList.remove('hit'); void seat.el.offsetWidth; seat.el.classList.add('hit'); }
    }
    function playerOut(b, p) {
      b.mark.className = 'bj-mark on is-out'; b.mark.textContent = (p.name || '') + ' · ' + T('out');
      later(function () { b.mark.classList.remove('on'); }, 4200);
      var c = lcenter(b.el); burst(c.x, c.y, 24, 'spark', 120);
      addFlight({ x0: c.x, y0: c.y, x1: G.tray.x, y1: G.tray.y, color: (b.el.style.getPropertyValue('--c') || '#888'), layers: 2, dur: 700 * K(), arc: 50 });
      sfx('lose'); sfx('sweep');
      autoLine('out', true);
      setMargot('idle'); emote('pity');
    }

    // ---------- выплаты ----------
    function queuePayout(b, h, hd, p, snap) {
      // проигравшие сгребаются сразу (одно движение лопатки на всех), выигрыши — по очереди
      if (S.payoutHand !== snap.hand) { S.payoutHand = snap.hand; S.payIdx = 0; S.sweepDone = false; S.payBase = Date.now() + 300; }
      var color = p.color || COLORS[p.seat % 12], min = snap.minBet || 10;
      var box = lcenter(b.el), stackEl = b.betEl.querySelector('[data-stack="main"]');
      var seat = S.seats[p.id], seatPt = seat ? lcenter(seat.av) : { x: G.W / 2, y: G.H };
      var bet = hd.doubled ? (p.bet || 0) * 2 : (p.bet || 0);
      var payout = hd.payout || 0;
      var idx = S.payIdx++;
      if (hd.result !== 'lose') S.seatPending[p.id] = true;
      if (hd.result === 'lose') {
        if (!S.sweepDone) { S.sweepDone = true; setMargot('sweep', 1300 * K()); later(function () { sfx('sweep'); }, 450 * K()); if (Math.random() < .35) later(function () { emote('tease'); autoLine('dealerWin'); }, 900 * K()); }
        later(function () {
          if (stackEl) stackEl.classList.add('is-gone');
          addFlight({ x0: box.x, y0: box.y, x1: G.tray.x, y1: G.tray.y, color: color, layers: stackLayers(bet, min), label: fmt(bet), dur: 520 * K(), arc: 10 });
          b.net.className = 'bj-net on is-lose'; b.net.textContent = signed(-bet);
          if (!hd.bust) sfx('lose');
        }, 500 * K() + idx * 60);
        return;
      }
      var at = 900 * K() + idx * 260 * K();
      later(function () {
        var win = hd.result === 'push' ? 0 : Math.max(0, payout - bet); // payout движка — брутто (ставка + выигрыш); показываем нетто
        if (win > 0) {
          var layers = stackLayers(win, min);
          sfx('pay', idx);
          if (hd.result === 'bj' && snap.dealer && snap.dealer.plot === 'jackpot') jackpotFx(b, T('jackpot'));
          addFlight({ x0: G.tray.x, y0: G.tray.y, x1: box.x + 30, y1: box.y, color: color, layers: layers, label: fmt(win), dur: 480 * K(), arc: 70, onDone: function () {
            sfx('stack', layers);
            later(function () {
              if (stackEl) stackEl.classList.add('is-gone');
              addFlight({ x0: box.x + 12, y0: box.y, x1: seatPt.x, y1: seatPt.y, color: color, layers: Math.min(6, layers + stackLayers(bet, min)), label: fmt(win + bet), dur: 560 * K(), arc: 60, onDone: function () { seatArrive(p.id); } });
            }, 420 * K());
          } });
          b.net.className = 'bj-net on ' + (hd.result === 'bj' ? 'is-bj' : 'is-win'); b.net.textContent = signed(win);
        } else {
          b.net.className = 'bj-net on is-push'; b.net.textContent = T('push');
          if (!S.pushSaid || S.pushSaid !== snap.hand) { S.pushSaid = snap.hand; emote('shrug'); autoLine('push'); }
          later(function () {
            if (stackEl) stackEl.classList.add('is-gone');
            addFlight({ x0: box.x, y0: box.y, x1: seatPt.x, y1: seatPt.y, color: color, layers: stackLayers(bet, min), label: fmt(bet), dur: 520 * K(), arc: 50, onDone: function () { seatArrive(p.id); } });
          }, 300 * K());
        }
      }, at);
    }
    function seatArrive(pid) {
      S.seatPending[pid] = false;
      var seat = S.seats[pid]; if (!seat) return;
      var p = null; (S.snap.players || []).forEach(function (q) { if (q.id === pid) p = q; });
      if (p) { seat.st.textContent = fmt(p.stack); seat.stack = p.stack; }
      seat.el.classList.remove('hit'); void seat.el.offsetWidth; seat.el.classList.add('hit');
      sfx('stack', 4);
    }

    // ---------- рельс ----------
    function renderRail(snap, prev, players) {
      rail.classList.toggle('many', players.length > 8);
      var seen = {};
      players.forEach(function (p) {
        seen[p.id] = true;
        var s = ensureSeat(p);
        setAvatar(s.av, p); s.nm.textContent = p.name || '';
        var held = resultsHeld(snap);
        if (!held && !S.seatPending[p.id] && s.stack !== p.stack) {
          if (s.stack !== null && prev) { s.st.classList.remove('bump'); void s.st.offsetWidth; s.st.classList.add('bump'); }
          s.st.textContent = fmt(p.stack); s.stack = p.stack;
        }
        s.el.classList.toggle('is-out', !!p.out);
        s.el.classList.toggle('is-offline', p.online === false && !p.out);
        var net = p.net;
        if (held) { if (snap.phase !== 'closing') s.rn.className = 'bj-rn'; }
        else if ((snap.phase === 'payout' || snap.phase === 'finished' || snap.phase === 'betting' || snap.phase === 'dealer') && typeof net === 'number' && net !== 0 && p.hands && p.hands.length && p.hands[0].result) {
          s.rn.className = 'bj-rn on ' + (net > 0 ? 'is-win' : 'is-lose'); s.rn.textContent = signed(net);
        } else if ((snap.phase === 'payout' || snap.phase === 'dealer') && p.hands && p.hands.length && p.hands[0].result === 'push') { s.rn.className = 'bj-rn on is-push'; s.rn.textContent = T('push'); }
        else if (snap.phase === 'closing' && p.penalty) { s.rn.className = 'bj-rn on is-lose'; s.rn.textContent = '−' + fmt(p.penalty) + ' ' + T('penalty'); }
        else if (snap.phase !== 'payout' && snap.phase !== 'finished') s.rn.className = 'bj-rn';
        if (p.shield && !s.shieldEl) { s.shieldEl = el('span', 'bj-shield', '🛡'); s.el.appendChild(s.shieldEl); }
        if (!p.shield && s.shieldEl) { s.el.removeChild(s.shieldEl); s.shieldEl = null; }
        rail.appendChild(s.el);
      });
      for (var pid in S.seats) if (!seen[pid]) { rail.removeChild(S.seats[pid].el); delete S.seats[pid]; }
    }

    // ---------- дилер ----------
    // рука дилера: с ростом веера сдвигаем его влево, чтобы счёт не уехал в правый бокс
    function dealerOffset(n) { return isSolo ? -60 : -60 - Math.max(0, n - 2) * 17; }
    // шаг веера сжимается с числом карт, чтобы ряд (и счёт справа) всегда помещался
    function dealerStep(n) { return isSolo ? Math.max(15, 38 - Math.max(0, n - 3) * 6) : Math.max(30, 44 - Math.max(0, n - 4) * 4); }
    function dealerTransform(i, n) {
      var step = dealerStep(n || S.dealerCards.length || 1);
      return 'translate(' + (dealerOffset(n || S.dealerCards.length || 1) + i * step) + 'px,0px) rotate(' + ((i - 1) * 1.5) + 'deg)';
    }
    function dealerScorePos(n) {
      var step = dealerStep(n);
      dscore.style.left = (dealerOffset(n) + (Math.max(1, n) - 1) * step + S.cardW + 24) + 'px';
      for (var i = 0; i < S.dealerCards.length; i++) { var ce = S.dealerCards[i]; if (!ce.classList.contains('is-flying')) ce.style.transform = dealerTransform(i, n); }
    }
    function renderDealer(snap, prev, instant) {
      var d = snap.dealer || {};
      var up = d.up || (d.cards && d.cards[0]) || null;
      var holeKnown = d.hole || (d.cards && d.cards[1]) || null;
      var allHaveTwo = (snap.players || []).every(function (p) { return p.out || !p.bet || !p.hands || !p.hands.length || p.hands[0].cards.length >= 2; });
      var holeDealt = !!up && (holeKnown || snap.phase === 'insurance' || snap.phase === 'deciding' || snap.phase === 'dealer' || snap.phase === 'payout' || (snap.phase === 'dealing' && allHaveTwo && (snap.players || []).some(function (p) { return p.hands && p.hands.length && p.hands[0].cards.length >= 2; })));
      if (!up) { return; }
      // карта 0 — открытая
      if (!S.dealerCards[0]) {
        var c0 = window.BJCards.element(up, { down: !instant });
        dcards.appendChild(c0); S.dealerCards.push(c0);
        var delay0 = instant ? 0 : queueSlot(300 * K());
        flyIn(c0, dealerTransform(0, 1), 0, delay0, function () { S.dealerShown = Math.max(S.dealerShown, 1); dealerScore(snap); }, { instant: instant });
        dealerScorePos(1);
      } else if (S.dealerCards[0].getAttribute('data-card') !== cardKey(up)) S.dealerCards[0].bjSetCard(up);
      // карта 1 — закрытая
      if (holeDealt && !S.dealerCards[1]) {
        var c1 = window.BJCards.element(holeKnown, { down: true });
        dcards.appendChild(c1); S.dealerCards.push(c1);
        var delay1 = instant ? 0 : queueSlot(300 * K());
        flyIn(c1, dealerTransform(1, 2), 0, delay1, function () { if (margot && margot.state === 'dealing' && Date.now() >= S.dealClock - 50) setMargot('idle'); }, { instant: instant, keepDown: true });
        dealerScorePos(2);
      } else if (S.dealerCards[1] && holeKnown && S.dealerCards[1].getAttribute('data-card') !== cardKey(holeKnown)) S.dealerCards[1].bjSetCard(holeKnown);
      // ход дилера: план по revealAt
      if (snap.phase === 'dealer' && d.cards && d.cards.length >= 2 && (!S.plan || S.plan.hand !== snap.hand)) planDealer(snap);
      if (snap.phase === 'payout' || snap.phase === 'finished') {
        // всё уже должно быть показано; достраиваем без анимации, если отстали
        if (d.cards) ensureDealerShown(d.cards, d.cards.length, true, snap);
      }
      if (!d.cards || d.cards.length < 2) dealerScore(snap);
    }
    // показать первые n карт дилера лицом (instant — без анимации)
    function ensureDealerShown(cards, n, instant, snap) {
      for (var i = 0; i < n && i < cards.length; i++) {
        var ce = S.dealerCards[i];
        if (!ce) {
          ce = window.BJCards.element(cards[i], { down: !instant });
          dcards.appendChild(ce); S.dealerCards.push(ce);
          flyIn(ce, dealerTransform(i, Math.max(n, cards.length)), 0, 0, null, { instant: true });
        } else if (ce.getAttribute('data-card') !== cardKey(cards[i])) ce.bjSetCard(cards[i]);
        if (instant) ce.classList.remove('is-down');
      }
      S.dealerShown = Math.max(S.dealerShown, Math.min(n, cards.length));
      dealerScorePos(S.dealerCards.length);
      if (instant) dealerScore(snap);
    }
    function dealerValue(cards) { return window.BJCards.value(cards); }
    function dealerScore(snap) {
      var d = snap.dealer || {}, cards = d.cards || [];
      var shown = cards.slice(0, S.dealerShown);
      if (!shown.length && d.up) shown = [d.up];
      if (!shown.length) { dscore.className = 'bj-dscore'; dscore.removeAttribute('data-v'); return; }
      var v = dealerValue(shown);
      var full = S.dealerShown >= cards.length && cards.length >= 2;
      setScore(dscore, v.value, v.soft, full && (d.bust || v.bust), full && d.blackjack, true, full);
      dscore.classList.remove('is-pulse');
    }

    // ---------- режиссёр ----------
    function planDealer(snap) {
      var d = snap.dealer, plot = d.plot || 'normal', times = d.revealAt || [];
      var nowS = snap.now || Date.now();
      var steps = [];
      var plan = { hand: snap.hand, plot: plot };
      S.plan = plan;
      var cards = d.cards;
      var n = cards.length;
      // расписание: revealAt[0] — переворот закрытой, revealAt[k] — k-я карта добора (cards[k+1])
      function at(ms) { return Math.max(0, ms - nowS); }
      var t0 = times.length ? times[0] : nowS + 800;
      var reduced = !fx;
      // эффекты до переворота
      if (plot === 'longflip' && !reduced) {
        steps.push({ t: at(t0 - 1300), f: function () { dim.className = 'bj-dim on'; setMargot('suspense'); if (window.BJSfx) window.BJSfx.duck(0.3, 2400); sfx('pulse', 0.4); } });
        steps.push({ t: at(t0 - 500), f: function () { sfx('pulse', 0.8); } });
      } else if (plot === 'allin') {
        var ap = null; (snap.players || []).forEach(function (p) { if (p.allin || (p.bet && p.stack === 0)) ap = ap || p; });
        steps.push({ t: at(t0 - 900), f: function () {
          S.allinOn = true;
          if (ap) { var b = S.boxes[ap.id]; if (b) { var c = lcenter(b.el); dim.style.setProperty('--x', (c.x / G.W * 100).toFixed(1) + '%'); dim.style.setProperty('--y', (c.y / G.H * 100).toFixed(1) + '%'); } showBanner(esc(ap.name), T('allinSub'), 'is-name', true); }
          dim.className = 'bj-dim on is-allin';
          emote('lean');
          if (window.BJSfx) window.BJSfx.duck(0, 0);
          setMargot('suspense');
        } });
      } else if (plot === 'dealerbj') {
        // переворот сразу
        t0 = Math.min(t0, nowS + 300);
      } else if (plot !== 'cardbycard') {
        steps.push({ t: at(t0 - 600), f: function () { setMargot('suspense'); } });
      }
      // переворот закрытой
      steps.push({ t: at(t0), f: function () {
        var ce = S.dealerCards[1];
        if (!ce) { ensureDealerShown(cards, 2, true, snap); return; }
        if (ce.getAttribute('data-card') !== cardKey(cards[1])) ce.bjSetCard(cards[1]);
        if (plot === 'longflip') ce.classList.add('flip-slow');
        ce.classList.remove('is-down');
        sfx('flip');
        var fl = (plot === 'longflip' ? 600 : 250) * K();
        later(function () {
          ce.classList.remove('flip-slow');
          S.dealerShown = 2; dealerScore(snap);
          if (plot === 'longflip') { dim.className = 'bj-dim'; if (window.BJSfx) window.BJSfx.duck(1); }
          if (plot === 'dealerbj') { showBanner(T('dealerBj'), T('dealerBjSub'), 'is-dark'); sfx('crack'); setMargot('smug', 2500); emote('cold'); autoLine('dealer21', true); }
          else if (n === 2) finishDealer(snap, plot);
          else { setMargot(plot === 'cardbycard' ? 'suspense' : 'dealing'); autoLine('dealerDraw'); if (plot === 'cardbycard' && fx) dealer.classList.add('is-zoom'); }
        }, fl + 40);
      } });
      // добор
      for (var k = 1; k < n - 1; k++) (function (k) {
        var tk = times[k] !== undefined ? times[k] : t0 + 900 * k;
        var last = k === n - 2;
        steps.push({ t: at(tk), f: function () {
          var idx = k + 1;
          var ce = S.dealerCards[idx];
          if (!ce) { ce = window.BJCards.element(cards[idx], { down: true }); dcards.appendChild(ce); S.dealerCards.push(ce); }
          dealerScorePos(idx + 1);
          if (plot === 'cardbycard') { dscore.classList.add('is-pulse'); sfx('pulse', Math.min(1, 0.3 + k * 0.25)); }
          flyIn(ce, dealerTransform(idx, idx + 1), 0, 0, function () {
            S.dealerShown = idx + 1; dealerScorePos(S.dealerCards.length); dealerScore(snap);
            if (last) finishDealer(snap, plot);
          }, { hit: true, slow: plot === 'cardbycard' && !last, last: plot === 'cardbycard' && last });
        } });
      })(k);
      steps.forEach(function (st) {
        if (st.t <= 0 && st.t > -50) later(st.f, 0);
        else if (st.t > 0) later(st.f, st.t);
        // уже прошло — не повторяем; итог достроит finishDealer/ensureDealerShown ниже
      });
      // переподключились позже всех revealAt — показать всё сразу
      var lastT = times.length ? times[times.length - 1] : t0;
      if (nowS > lastT + 100) { ensureDealerShown(cards, n, true, snap); S.dealerShown = n; dealerScore(snap); plan.done = true; }
    }
    function finishDealer(snap, plot) {
      var d = snap.dealer || {};
      if (S.plan && S.plan.hand === snap.hand) S.plan.done = true;
      dealer.classList.remove('is-zoom'); dscore.classList.remove('is-pulse');
      dim.className = 'bj-dim'; if (window.BJSfx) window.BJSfx.duck(1);
      if (S.allinOn) { S.allinOn = false; hideBanner(); }
      if (d.bust) {
        if (plot === 'dealerbust' || (plot !== 'allin' && fx)) {
          showBanner(T('dealerBust'), T('dealerBustSub'), 'is-dark');
          burst(0, 0, fx ? 320 : 60, 'rain');
          sfx('salvo');
        }
        setMargot('oops', 2600); emote('gasp'); autoLine('dealerBust', true);
      } else if (d.value === 21) { setMargot('smug', 2000); emote('triumph'); autoLine('dealer21', true); }
      else { setMargot('idle'); }
      flushResults();
    }

    // ---------- фазы ----------
    function onPhase(snap, prev, players) {
      var ph = snap.phase;
      if (ph !== 'paused' && ph !== 'lobby' && ph !== 'finished') hideCenter();
      switch (ph) {
        case 'lobby':
          if (autoLobby) showCenter('<div class="bj-ct">' + esc(T('lobbyTitle')) + '</div>' + (snap.code ? '<div class="bj-cs">' + esc(T('lobbyRoom')) + '</div><div class="bj-cc">' + esc(snap.code) + '</div>' : '<div class="bj-cs">' + esc(T('lobbyWait')) + '</div>') + '<div class="bj-cn">' + esc(T('lobbyHint')) + '</div>', 'is-lobby');
          setMargot('shuffle'); autoLine('hello', true);
          break;
        case 'betting':
          setMargot('idle'); if (prev) autoLine(snap.hand <= 1 ? 'hello' : 'hint', true);
          break;
        case 'closing':
          setMargot('idle'); autoLine('bets', true); sfx('tap');
          if (margot) margot.lookAt(0);
          break;
        case 'dealing':
          setMargot('dealing'); autoLine('deal', true);
          break;
        case 'insurance':
          setMargot('peek'); if (margot) margot.brow(); emote('dare'); autoLine('insurance', true);
          var hc = S.dealerCards[1]; if (hc && fx) { later(function () { hc.classList.add('is-peek'); sfx('flip'); later(function () { hc.classList.remove('is-peek'); }, 1500 * K()); }, 900); }
          break;
        case 'deciding':
          setMargot('idle'); if (snap.wave === 1) autoLine('hint');
          break;
        case 'dealer':
          if (margot) margot.lookAt(0);
          break;
        case 'payout':
          break;
        case 'finished':
          if (autoFinal) { if (snap.settings && snap.settings.solo) showSoloFinal(snap, players); else showFinal(snap, players); }
          break;
        case 'paused':
          showCenter('<div class="bj-ct">' + esc(T('pause')) + '</div><div class="bj-cs">' + esc(T('pauseSub')) + '</div>', 'is-pause');
          setMargot('think');
          break;
      }
    }
    function levelUp(snap) {
      showCenter('<div class="bj-cs">' + esc(T('level')) + ' ' + ((snap.level || 0) + (levelBase === 0 ? 1 : 0)) + '</div><div class="bj-ct">' + esc(T('levelUp')) + ' ' + fmt(snap.minBet) + '</div>', 'is-level', 2700);
      sfx('level'); S.levelSays = (S.levelSays || 0) + 1; emote('grin'); if (S.levelSays % 2 === 1) autoLine('level', true);
    }
    function doShuffle() {
      shoe.classList.add('is-shuffling');
      setMargot('shuffle', 3000 * K());
      sfx('shuffle'); autoLine('shuffle', true);
      later(function () { shoe.classList.remove('is-shuffling'); }, 3000 * K());
    }
    // соло: не «последний за столом», а «фишки кончились · N раздач» (+ stats, если движок их отдал)
    function showSoloFinal(snap, players) {
      var hands = snap.hand || 0;
      var html = '<div class="bj-cs">' + esc(T('soloOver')) + '</div><div class="bj-ct">' + hands + ' ' + esc(handsWord(hands)) + '</div>' + statsHtml(statsList(snap));
      showCenter(html, 'is-final bj-final is-solo');
      setMargot('idle'); emote('sigh'); autoLine('soloEnd', true);
      sfx('lose');
    }
    // stats от движка — объект {biggestWin:{playerId,amount}, biggestBust, blackjacks:{pid:n}, cruelCard:{by,target,card,amount},
    // lastBreath:{pid:n}, exact21, dealerBusts, sideJackpot:{playerId,kind,amount}}; стенд может отдать готовый массив
    // склонение «раздача»: ru 1 / 2–4 / 5+, en 1 hand / N hands, el 1 μοιρασιά / N μοιρασιές
    function handsWord(n) {
      if (lang === 'ru') { var m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? 'раздача' : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) ? 'раздачи' : 'раздач'; }
      if (lang === 'el') return n === 1 ? 'μοιρασιά' : 'μοιρασιές';
      return n === 1 ? 'hand' : 'hands';
    }
    // названия комбинаций побочных ставок
    var KINDS = {
      ru: { mixed: 'пара', colored: 'одноцветная пара', perfect: 'пара одной масти', flush: 'флеш', straight: 'стрит', trips: 'тройка', straightFlush: 'стрит-флеш', suitedTrips: 'тройка одной масти' },
      en: { mixed: 'mixed pair', colored: 'colored pair', perfect: 'perfect pair', flush: 'flush', straight: 'straight', trips: 'three of a kind', straightFlush: 'straight flush', suitedTrips: 'suited trips' },
      el: { mixed: 'ζευγάρι', colored: 'ζευγάρι ίδιου χρώματος', perfect: 'ζευγάρι ίδιας φυσικής', flush: 'φλας', straight: 'στρέιτ', trips: 'τριάδα', straightFlush: 'στρέιτ φλας', suitedTrips: 'τριάδα ίδιας φυσικής' }
    };
    function kindName(k) { var d = KINDS[lang] || KINDS.ru; return d[k] || String(k || ''); }
    function statsList(snap) {
      var st = snap.stats; if (!st) return [];
      if (Object.prototype.toString.call(st) === '[object Array]') return st;
      var names = {}; (snap.players || []).forEach(function (p) { names[p.id] = p.name; });
      var nm = function (id) { return names[id] || ''; };
      var top = function (map) { var best = null, n = 0; for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k) && map[k] > n) { n = map[k]; best = k; } return { id: best, n: n }; };
      var out = [];
      if (st.biggestWin && st.biggestWin.amount) out.push({ key: 'biggestWin', name: nm(st.biggestWin.playerId), value: signed(st.biggestWin.amount) });
      if (st.biggestBust && st.biggestBust.amount) out.push({ key: 'biggestBust', name: nm(st.biggestBust.playerId), value: signed(-Math.abs(st.biggestBust.amount)) });
      if (st.blackjacks) { var tb = top(st.blackjacks), total = 0; for (var k in st.blackjacks) if (Object.prototype.hasOwnProperty.call(st.blackjacks, k)) total += st.blackjacks[k]; if (total) out.push({ key: 'bjs', name: tb.n > 1 ? nm(tb.id) : '', value: total }); }
      if (st.cruelCard && st.cruelCard.card) out.push({ key: 'meanCard', name: nm(st.cruelCard.by), value: (T('trick_' + st.cruelCard.card) || st.cruelCard.card) + (st.cruelCard.amount ? ' · ' + signed(-Math.abs(st.cruelCard.amount)) : '') });
      if (st.lastBreath) { var tl = top(st.lastBreath); if (tl.n) out.push({ key: 'last', name: nm(tl.id), value: tl.n + ' ' + handsWord(tl.n) }); }
      if (st.exact21) out.push({ key: 'twentyOne', value: st.exact21 });
      if (st.dealerBusts) out.push({ key: 'dealerBusts', value: st.dealerBusts });
      if (st.sideJackpot && st.sideJackpot.amount) out.push({ key: 'sideJackpot', name: nm(st.sideJackpot.playerId), value: kindName(st.sideJackpot.kind) + ' ' + signed(st.sideJackpot.amount) });
      return out;
    }
    function statsHtml(list) {
      if (!list.length) return '';
      return '<div class="bj-stats">' + list.map(function (st) {
        var label = st.label || T('st' + String(st.key || '').charAt(0).toUpperCase() + String(st.key || '').slice(1)) || st.key;
        return '<div><div class="bj-k">' + esc(label) + '</div><div class="bj-v">' + (st.name ? '<b>' + esc(st.name) + '</b> · ' : '') + esc(String(st.value)) + '</div></div>';
      }).join('') + '</div>';
    }
    function showFinal(snap, players) {
      // места: по place движка (победитель первым, выбывшие раньше — в хвосте); без place — по стеку
      var hasPlace = players.some(function (p) { return typeof p.place === 'number' && p.place > 0; });
      var alive = players.slice().sort(function (a, b) {
        if (hasPlace) {
          var pa = typeof a.place === 'number' && a.place > 0 ? a.place : 99, pb = typeof b.place === 'number' && b.place > 0 ? b.place : 99;
          if (pa !== pb) return pa - pb;
        }
        return (b.stack || 0) - (a.stack || 0);
      });
      var wid = snap.winner || snap.winnerId;
      var w = null; alive.forEach(function (p) { if (wid ? p.id === wid : !w) w = w || p; });
      if (!w) return;
      alive = [w].concat(alive.filter(function (p) { return p !== w; }));
      var color = w.color || COLORS[w.seat % 12];
      var html = '<div class="bj-wav" style="' + chipVars(color) + '">' + esc(isEmoji(w.avatar) ? w.avatar : initials(w.name)) + '</div>' +
        '<div class="bj-cs">' + esc(T('winner')) + '</div><div class="bj-ct">' + esc(w.name) + '</div><div class="bj-cs">' + fmt(w.stack) + '</div>';
      html += '<div class="bj-places' + (alive.length > 6 ? ' is-two' : '') + '">' + alive.slice(0, 12).map(function (p, i) { return '<span class="bj-pl" style="' + chipVars(p.color || COLORS[p.seat % 12]) + '"><i></i>' + (i + 1) + '. ' + esc(p.name) + ' · ' + fmt(p.stack) + '</span>'; }).join('') + '</div>';
      html += statsHtml(statsList(snap));
      showCenter(html, 'is-final bj-final');
      burst(0, 0, fx ? 260 : 40, 'rain');
      sfx('gold'); setMargot('congrats', 3000); later(function () { emote('winkgrin'); }, 700); autoLine('final', true);
      var b = S.boxes[w.id]; if (b) { var c = lcenter(b.el); flashAt(c.x, c.y); burst(c.x, c.y, 60, 'coin', 260); }
    }

    // ---------- события от движка (необязательные) ----------
    var seenEvents = {};
    function handleEvents(snap) {
      (snap.events || []).forEach(function (ev) {
        var pid = ev.id || ev.playerId || '';
        var key = ev.t + ':' + ev.type + ':' + pid + ':' + (ev.text || '');
        if (seenEvents[key]) return; seenEvents[key] = true;
        if (S.prev === null) return; // первый render: события не проигрываем
        switch (ev.type) {
          case 'say': say(ev.text || window.BJMargot.pick(lang, ev.cat || 'hint')); break;
          case 'brow': if (margot) margot.brow(); break;
          case 'rescue': var b = S.boxes[pid]; (function (p) { (snap.players || []).forEach(function (q) { if (q.id === pid) p = q; }); if (b && p) later(function () { rescue(b, p); }, ev.delay || 1500); })(null); break;
          case 'allin': if (margot) margot.brow(); emote('lean'); autoLine('allin', true); break;
          case 'trick': emote('sly'); autoLine('trick', true); break;
          case 'penalty': emote('sly'); autoLine('trick'); var s = S.seats[pid]; if (s) { s.rn.className = 'bj-rn on is-lose'; s.rn.textContent = '−' + fmt(ev.amount) + ' ' + T('penalty'); addFlight({ x0: lcenter(s.av).x, y0: lcenter(s.av).y, x1: G.tray.x, y1: G.tray.y, color: s.el.style.getPropertyValue('--c') || '#fff', layers: 1, label: fmt(ev.amount), dur: 600 * K(), arc: 80 }); sfx('chip'); } break;
          case 'peek': setMargot('peek', 1600); autoLine('peek', true); break;
          case 'cut': showCenter('<div class="bj-ct">' + esc(ev.text || '') + '</div>', 'is-level', 2600); break;
        }
      });
    }

    // ---------- публичное ----------
    var api = {
      render: render,
      say: say,
      setAutoSay: function (on) { autoSay = !!on; },
      margot: setMargot,
      brow: function () { if (margot) margot.brow(); },
      emote: function (name, ms, force) { if (margot) margot.emote(name, ms, force); },
      lookAt: function (x) { if (margot) margot.lookAt(x); },
      setLang: function (l) { lang = l; if (S.snap) { renderHud(S.snap, null); dlabel.textContent = T('dealer'); } },
      setFx: function (on) { fx = !!on; root.setAttribute('data-fx', fx ? 'on' : 'off'); },
      resize: resize,
      freeze: function () {
        S.frozen = true; if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
        try { document.getAnimations().forEach(function (a) { a.pause(); }); } catch (e) { root.classList.add('bj-frozen'); }
      },
      thaw: function () { S.frozen = false; try { document.getAnimations().forEach(function (a) { a.play(); }); } catch (e) {} root.classList.remove('bj-frozen'); loop(); },
      fps: function () { var s = S.fpsSamples; if (!s.length) return 0; var sum = 0; s.forEach(function (d) { sum += d; }); return 1000 / (sum / s.length); },
      fpsMin: function () { var s = S.fpsSamples; if (!s.length) return 0; var mx = 0; s.forEach(function (d) { if (d > mx) mx = d; }); return 1000 / mx; },
      state: S, geom: G, text: T,
      destroy: function () { S.timers.forEach(clearTimeout); if (S.raf) cancelAnimationFrame(S.raf); window.removeEventListener('resize', resize); while (root.firstChild) root.removeChild(root.firstChild); }
    };
    loop();
    if (opts.onReady) later(function () { opts.onReady(api); }, 0);
    return api;
  }

  window.BJTable = { create: create, TEXT: TEXT, COLORS: COLORS, GEOM: GEOM };
})();
