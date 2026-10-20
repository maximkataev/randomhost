/*
 * blackjack-cards.js — колода блэкджека: SVG-спрайт на 52 лица + рубашка клуба.
 * Спрайт собирается кодом в один <svg><symbol>…</symbol></svg> (52 файла писать незачем),
 * карта на столе — <use href="#bj-c-As">. Индексы «джамбо» (≥ 1/4 высоты карты), чтобы читались с дивана;
 * пипсы мелкие; картинки J/Q/K — геометричные ар-деко силуэты, без портретов.
 *
 * API (window.BJCards):
 *   BJCards.install()                — добавить спрайт в document.body (один раз; face()/element() делают это сами)
 *   BJCards.code(card)               — {r:"A",s:"s"} → "As"
 *   BJCards.face(card)               — <svg class="bj-face"> с лицом карты (viewBox 0 0 100 140)
 *   BJCards.back()                   — <svg class="bj-back-svg"> с рубашкой
 *   BJCards.element(card, opts)      — полная карта с переворотом: .bj-card > .bj-lift > .bj-card-in > .bj-face/.bj-back
 *                                      opts.down = true — лежит рубашкой вверх; el.bjFlip(up) переворачивает
 *   BJCards.value(cards)             — {value, soft, bust, blackjack} (для стенда; движок считает сам)
 *
 * Синтаксис — ES2017 (доски открываются в Chromium 80–83): без `?.`, `??`, spread в объектах.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUITS = ['s', 'h', 'd', 'c'];
  var RED = '#c8102e', BLACK = '#111111', GOLD = '#c9a227', GOLD_DK = '#8a6d1a', NAVY = '#10213f', NAVY_DK = '#0a1630';
  var W = 100, H = 140;

  // ---------- масти: пути в квадрате 0..100, центр (50,50) ----------
  var SUIT_PATH = {
    h: 'M50 90 C22 64 8 50 8 30 A20 20 0 0 1 50 22 A20 20 0 0 1 92 30 C92 50 78 64 50 90 Z',
    d: 'M50 4 L90 50 L50 96 L10 50 Z',
    s: 'M50 8 C32 34 10 46 10 64 A18 18 0 0 0 46 68 C45 78 40 86 33 94 L67 94 C60 86 55 78 54 68 A18 18 0 0 0 90 64 C90 46 68 34 50 8 Z',
    c: 'M50 6 A17 17 0 0 1 63 34 A18 18 0 1 1 56 62 C57 76 61 86 67 94 L33 94 C39 86 43 76 44 62 A18 18 0 1 1 37 34 A17 17 0 0 1 50 6 Z'
  };
  function suitColor(s) { return (s === 'h' || s === 'd') ? RED : BLACK; }

  // ---------- раскладка пипсов (x, y, перевёрнут) — классика ----------
  var C = [38, 57, 76], R = { t: 44, u: 60, m: 76, d: 92, b: 108 };
  var PIPS = {
    '2': [[57, 40, 0], [57, 112, 1]],
    '3': [[57, 40, 0], [57, 76, 0], [57, 112, 1]],
    '4': [[38, 42, 0], [76, 42, 0], [38, 110, 1], [76, 110, 1]],
    '5': [[38, 42, 0], [76, 42, 0], [57, 76, 0], [38, 110, 1], [76, 110, 1]],
    '6': [[38, 42, 0], [76, 42, 0], [38, 76, 0], [76, 76, 0], [38, 110, 1], [76, 110, 1]],
    '7': [[38, 42, 0], [76, 42, 0], [57, 59, 0], [38, 76, 0], [76, 76, 0], [38, 110, 1], [76, 110, 1]],
    '8': [[38, 42, 0], [76, 42, 0], [57, 59, 0], [38, 76, 0], [76, 76, 0], [57, 93, 1], [38, 110, 1], [76, 110, 1]],
    '9': [[38, 42, 0], [76, 42, 0], [38, 65, 0], [76, 65, 0], [57, 76, 0], [38, 87, 1], [76, 87, 1], [38, 110, 1], [76, 110, 1]],
    '10': [[38, 42, 0], [76, 42, 0], [57, 53, 0], [38, 65, 0], [76, 65, 0], [38, 87, 1], [76, 87, 1], [57, 99, 1], [38, 110, 1], [76, 110, 1]]
  };

  function mk(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }
  function useSuit(parent, s, x, y, size, flip) {
    var u = mk('use', { x: 0, y: 0, width: size, height: size, fill: suitColor(s) }, parent);
    u.setAttribute('href', '#bj-s-' + s);
    u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#bj-s-' + s);
    var t = 'translate(' + (x - size / 2) + ' ' + (y - size / 2) + ')';
    if (flip) t = 'translate(' + (x + size / 2) + ' ' + (y + size / 2) + ') rotate(180)';
    u.setAttribute('transform', t);
    return u;
  }
  function text(parent, x, y, str, attrs) {
    var t = mk('text', attrs, parent);
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.textContent = str;
    return t;
  }

  // ---------- картинки: ар-деко силуэты (простые, геометричные) ----------
  // Общая рамка картинки: x 30..84, y 30..110 — под неё лучи-солнце и фигура в цвете масти + золото.
  function courtFrame(g, s) {
    var col = suitColor(s);
    mk('rect', { x: 29, y: 31, width: 54, height: 80, rx: 2, fill: 'none', stroke: GOLD, 'stroke-width': 1.2 }, g);
    mk('rect', { x: 32, y: 34, width: 48, height: 74, fill: 'none', stroke: col, 'stroke-width': .6, opacity: .5 }, g);
    // лучи
    var rays = mk('g', { stroke: GOLD, 'stroke-width': .7, opacity: .55 }, g);
    for (var i = 0; i < 9; i++) {
      var a = Math.PI + (i / 8) * Math.PI; // веер сверху
      var x2 = 56 + Math.cos(a) * 60, y2 = 92 + Math.sin(a) * 60;
      mk('line', { x1: 56, y1: 92, x2: x2, y2: y2 }, rays);
    }
    mk('rect', { x: 32, y: 34, width: 48, height: 74, fill: '#fff', opacity: 0 }, g);
  }
  function court(g, r, s) {
    var col = suitColor(s);
    courtFrame(g, s);
    var fig = mk('g', {}, g);
    if (r === 'K') {
      // корона с зубцами, квадратное лицо, борода-треугольник, скипетр
      mk('path', { d: 'M40 52 L40 40 L46 46 L52 36 L56 46 L60 36 L66 46 L72 40 L72 52 Z', fill: GOLD }, fig);
      mk('rect', { x: 40, y: 50, width: 32, height: 3, fill: GOLD_DK }, fig);
      mk('rect', { x: 44, y: 53, width: 24, height: 22, rx: 3, fill: col }, fig);
      mk('path', { d: 'M44 75 L68 75 L56 96 Z', fill: col }, fig);
      mk('path', { d: 'M38 104 L48 84 L64 84 L74 104 Z', fill: col, opacity: .85 }, fig);
      mk('line', { x1: 76, y1: 60, x2: 76, y2: 104, stroke: GOLD, 'stroke-width': 2 }, fig);
      mk('circle', { cx: 76, cy: 58, r: 3, fill: GOLD }, fig);
      mk('rect', { x: 49, y: 60, width: 5, height: 2, fill: '#fff' }, fig);
      mk('rect', { x: 58, y: 60, width: 5, height: 2, fill: '#fff' }, fig);
    } else if (r === 'Q') {
      // диадема из трёх ромбов, овальное лицо, волны волос, веер
      mk('path', { d: 'M46 44 L50 38 L54 44 L50 50 Z M52 40 L56 32 L60 40 L56 48 Z M58 44 L62 38 L66 44 L62 50 Z', fill: GOLD }, fig);
      mk('ellipse', { cx: 56, cy: 64, rx: 11, ry: 14, fill: col }, fig);
      mk('path', { d: 'M44 60 C40 70 40 82 46 92 L50 92 C46 82 46 72 48 62 Z', fill: col, opacity: .8 }, fig);
      mk('path', { d: 'M68 60 C72 70 72 82 66 92 L62 92 C66 82 66 72 64 62 Z', fill: col, opacity: .8 }, fig);
      mk('path', { d: 'M56 106 L40 96 A20 20 0 0 1 72 96 Z', fill: GOLD }, fig);
      mk('path', { d: 'M56 106 L44 97 M56 106 L50 93 M56 106 L56 90 M56 106 L62 93 M56 106 L68 97', stroke: GOLD_DK, 'stroke-width': .8 }, fig);
      mk('rect', { x: 50, y: 62, width: 4, height: 1.6, fill: '#fff' }, fig);
      mk('rect', { x: 58, y: 62, width: 4, height: 1.6, fill: '#fff' }, fig);
      mk('circle', { cx: 56, cy: 73, r: 1.4, fill: GOLD }, fig);
    } else {
      // валет: берет с пером, ромбовидное лицо, шевроны воротника
      mk('path', { d: 'M40 50 Q56 34 72 50 L68 54 L44 54 Z', fill: col }, fig);
      mk('path', { d: 'M66 46 L82 34 L80 42 Z', fill: GOLD }, fig);
      mk('path', { d: 'M56 52 L68 66 L56 84 L44 66 Z', fill: col }, fig);
      mk('path', { d: 'M38 104 L46 86 L56 92 L66 86 L74 104 Z', fill: col, opacity: .85 }, fig);
      mk('path', { d: 'M46 96 L56 102 L66 96', fill: 'none', stroke: GOLD, 'stroke-width': 1.6 }, fig);
      mk('path', { d: 'M48 91 L56 96 L64 91', fill: 'none', stroke: GOLD, 'stroke-width': 1.2 }, fig);
      mk('rect', { x: 50, y: 64, width: 4, height: 1.6, fill: '#fff' }, fig);
      mk('rect', { x: 58, y: 64, width: 4, height: 1.6, fill: '#fff' }, fig);
    }
    // масть в углах рамки
    useSuit(g, s, 35, 37, 7);
    useSuit(g, s, 77, 105, 7, true);
  }

  // ---------- одно лицо ----------
  function buildFace(sym, r, s) {
    var col = suitColor(s);
    mk('rect', { x: 0, y: 0, width: W, height: H, rx: 7, fill: '#fbf8f1' }, sym);
    mk('rect', { x: 1, y: 1, width: W - 2, height: H - 2, rx: 6, fill: 'none', stroke: '#d9d2c3', 'stroke-width': 1 }, sym);
    // индексы «джамбо»: верх-лево и низ-право (перевёрнут)
    var idx = mk('g', { 'font-family': '"Inter Tight",Arial,sans-serif', 'font-weight': 700, fill: col }, sym);
    var big = r === '10';
    text(idx, 7, 40, r, { 'font-size': big ? 31 : 36, 'letter-spacing': big ? -2 : 0 });
    useSuit(idx, s, 15, 55, 17);
    var bot = mk('g', { transform: 'rotate(180 50 70)' }, idx);
    text(bot, 7, 40, r, { 'font-size': big ? 31 : 36, 'letter-spacing': big ? -2 : 0 });
    useSuit(bot, s, 15, 55, 17);
    if (r === 'A') {
      useSuit(sym, s, 57, 76, 42);
      // тонкий ар-деко ободок у туза — он ценнее
      mk('circle', { cx: 57, cy: 76, r: 28, fill: 'none', stroke: GOLD, 'stroke-width': .8, opacity: .8 }, sym);
      mk('circle', { cx: 57, cy: 76, r: 31, fill: 'none', stroke: GOLD, 'stroke-width': .4, opacity: .6 }, sym);
    } else if (PIPS[r]) {
      var p = PIPS[r];
      for (var i = 0; i < p.length; i++) useSuit(sym, s, p[i][0], p[i][1], 14, p[i][2]);
    } else {
      court(sym, r, s);
    }
  }

  function buildBack(sym) {
    mk('rect', { x: 0, y: 0, width: W, height: H, rx: 7, fill: '#f3efe5' }, sym);
    mk('rect', { x: 5, y: 5, width: W - 10, height: H - 10, rx: 4, fill: NAVY }, sym);
    mk('rect', { x: 5, y: 5, width: W - 10, height: H - 10, rx: 4, fill: 'url(#bj-back-pat)' }, sym);
    mk('rect', { x: 8, y: 8, width: W - 16, height: H - 16, rx: 3, fill: 'none', stroke: GOLD, 'stroke-width': 1 }, sym);
    mk('rect', { x: 10.5, y: 10.5, width: W - 21, height: H - 21, rx: 2, fill: 'none', stroke: GOLD, 'stroke-width': .4, opacity: .8 }, sym);
    // монограмма «21» в двойном овале
    mk('ellipse', { cx: 50, cy: 70, rx: 22, ry: 28, fill: NAVY_DK, stroke: GOLD, 'stroke-width': 1.2 }, sym);
    mk('ellipse', { cx: 50, cy: 70, rx: 18.5, ry: 24.5, fill: 'none', stroke: GOLD, 'stroke-width': .5 }, sym);
    text(sym, 50, 81, '21', { 'text-anchor': 'middle', 'font-family': '"Bodoni Moda","Didot","Times New Roman",serif', 'font-weight': 500, 'font-size': 30, fill: GOLD, 'letter-spacing': -1 });
    mk('path', { d: 'M38 86 L62 86', stroke: GOLD, 'stroke-width': .8 }, sym);
    mk('path', { d: 'M42 52 L58 52', stroke: GOLD, 'stroke-width': .8 }, sym);
  }

  var installed = false;
  function install() {
    if (installed || !document.body) return;
    installed = true;
    var svg = mk('svg', { id: 'bj-sprite', width: 0, height: 0, style: 'position:absolute;width:0;height:0;overflow:hidden', 'aria-hidden': 'true' });
    var defs = mk('defs', {}, svg);
    for (var i = 0; i < SUITS.length; i++) {
      var sy = mk('symbol', { id: 'bj-s-' + SUITS[i], viewBox: '0 0 100 100' }, defs);
      mk('path', { d: SUIT_PATH[SUITS[i]] }, sy);
    }
    // узор рубашки: золотая ромбовидная решётка на синем
    var pat = mk('pattern', { id: 'bj-back-pat', width: 10, height: 10, patternUnits: 'userSpaceOnUse' }, defs);
    mk('path', { d: 'M5 0 L10 5 L5 10 L0 5 Z', fill: 'none', stroke: GOLD, 'stroke-width': .5, opacity: .55 }, pat);
    mk('circle', { cx: 5, cy: 5, r: .9, fill: GOLD, opacity: .7 }, pat);
    for (var a = 0; a < RANKS.length; a++) for (var b = 0; b < SUITS.length; b++) {
      var sym = mk('symbol', { id: 'bj-c-' + RANKS[a] + SUITS[b], viewBox: '0 0 100 140' }, defs);
      buildFace(sym, RANKS[a], SUITS[b]);
    }
    buildBack(mk('symbol', { id: 'bj-c-back', viewBox: '0 0 100 140' }, defs));
    document.body.insertBefore(svg, document.body.firstChild);
  }

  function code(card) { return card ? (card.r + card.s) : 'back'; }

  function useCard(id) {
    var svg = mk('svg', { viewBox: '0 0 100 140', preserveAspectRatio: 'none' });
    var u = mk('use', {}, svg);
    u.setAttribute('href', '#bj-c-' + id);
    u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#bj-c-' + id);
    return svg;
  }
  function face(card) {
    install();
    var svg = useCard(code(card));
    svg.setAttribute('class', 'bj-face-svg');
    return svg;
  }
  function back() {
    install();
    var svg = useCard('back');
    svg.setAttribute('class', 'bj-back-svg');
    return svg;
  }

  // Полная карта: внешний .bj-card двигается (полёт), .bj-lift — дуга и тень, .bj-card-in — 3D-переворот
  function element(card, opts) {
    opts = opts || {};
    install();
    var el = document.createElement('div');
    el.className = 'bj-card' + (opts.down ? ' is-down' : '');
    el.setAttribute('data-card', code(card));
    var lift = document.createElement('div'); lift.className = 'bj-lift';
    var inner = document.createElement('div'); inner.className = 'bj-card-in';
    var f = document.createElement('div'); f.className = 'bj-face';
    if (card) f.appendChild(face(card));
    var b = document.createElement('div'); b.className = 'bj-back';
    b.appendChild(back());
    inner.appendChild(f); inner.appendChild(b);
    lift.appendChild(inner); el.appendChild(lift);
    el.bjSetCard = function (c) {
      el.setAttribute('data-card', code(c));
      while (f.firstChild) f.removeChild(f.firstChild);
      if (c) f.appendChild(face(c));
    };
    el.bjFlip = function (up) { el.classList.toggle('is-down', !up); };
    return el;
  }

  // Счёт руки — только для стенда и подписей; движок считает сам
  function value(cards) {
    var total = 0, aces = 0;
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].r;
      if (r === 'A') { aces++; total += 11; }
      else if (r === 'J' || r === 'Q' || r === 'K' || r === '10') total += 10;
      else total += parseInt(r, 10);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { value: total, soft: aces > 0 && total <= 21, bust: total > 21, blackjack: cards.length === 2 && total === 21 };
  }

  window.BJCards = { install: install, code: code, face: face, back: back, element: element, value: value, RANKS: RANKS, SUITS: SUITS };
})();
