/*
 * blackjack-margot.js — Марго, хозяйка VIP-зала. Векторный персонаж по пояс (SVG, свой).
 * Роковая женщина в духе афиши Вегаса 1930-х: тёмно-рыжие волны, дымчатые глаза с ресницами, красные губы,
 * чёрный приталенный смокинг с атласными лацканами и глубоким V на белой шёлковой блузе, золотой чокер и
 * длинная цепочка, серьги-каскады, золотые браслеты, красные ногти. Поза: корпус наклонён, одно плечо вперёд.
 * Фирменный жест — одна приподнятая бровь (brow()); ещё — томный взгляд, подмигивание (wink()), взгляд искоса.
 *
 * Стили — в blackjack-table.css (секция «Марго»), состояния — атрибут data-state на корне персонажа.
 *
 * API (window.BJMargot):
 *   var m = BJMargot.create(container, {lang})
 *   m.set(state)         idle | dealing | suspense | smug | oops | congrats | peek | shuffle | sweep | think
 *   m.say(text, ms)      пузырь над головой (2–6 слов), ms — сколько держать (по умолчанию 2800)
 *   m.brow(ms)           приподнять бровь (по умолчанию 1400 мс)
 *   m.wink(ms)           подмигнуть (по умолчанию 900 мс); в congrats подмигивает сама
 *   m.lookAt(x)          взгляд: x от -1 (левый край стола) до 1 (правый), null — прямо
 *   m.tick(now)          моргание и прочая «жизнь» — звать из rAF
 *   m.state              текущее состояние
 *   BJMargot.pick(lang, category, rnd) — реплика из банка без повтора подряд; категории см. LINES
 *
 * Синтаксис — ES2017 (Chromium 80–83).
 */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var SKIN = '#f6d8c4', SKIN_SH = '#e3b096', SKIN_HI = '#fff0e3';
  var HAIR = '#a8321a', HAIR_DK = '#5a140d', HAIR_MID = '#85240f', HAIR_HI = '#f08a50';
  var LIP = '#d1122f', LIP_DK = '#8d0a22';
  var JACKET = '#14151b', SATIN = '#2b2d38', SATIN_HI = '#5a5e70', SILK = '#fbf6ee', SILK_SH = '#d9cfc0';
  var GOLD = '#e0b841', GOLD_DK = '#9a7a1f', GOLD_HI = '#fff0b0', INK = '#1a1316', IRIS = '#4c8d6a';

  function mk(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }
  function origin(g, x, y) { g.style.transformOrigin = x + 'px ' + y + 'px'; }

  // Сужающийся сегмент с круглыми концами: (x1,y1) шириной w1 → (x2,y2) шириной w2, блик по внешнему краю
  function seg(parent, x1, y1, w1, x2, y2, w2, fill, hi, cls) {
    var a = Math.atan2(y2 - y1, x2 - x1), nx = -Math.sin(a), ny = Math.cos(a);
    var g = mk('g', cls ? { 'class': cls } : {}, parent);
    mk('circle', { cx: x1, cy: y1, r: w1 / 2, fill: fill }, g);
    mk('circle', { cx: x2, cy: y2, r: w2 / 2, fill: fill }, g);
    mk('path', { d: 'M' + (x1 + nx * w1 / 2) + ' ' + (y1 + ny * w1 / 2) + ' L' + (x2 + nx * w2 / 2) + ' ' + (y2 + ny * w2 / 2) + ' L' + (x2 - nx * w2 / 2) + ' ' + (y2 - ny * w2 / 2) + ' L' + (x1 - nx * w1 / 2) + ' ' + (y1 - ny * w1 / 2) + ' Z', fill: fill }, g);
    if (hi) mk('path', { d: 'M' + (x1 + nx * (w1 / 2 - 4)) + ' ' + (y1 + ny * (w1 / 2 - 4)) + ' L' + (x2 + nx * (w2 / 2 - 3)) + ' ' + (y2 + ny * (w2 / 2 - 3)), stroke: hi, 'stroke-width': 1.8, 'stroke-linecap': 'round', opacity: .8, fill: 'none' }, g);
    return g;
  }

  // Кисть: узкая ладонь, длинные пальцы, красные ногти. (wx,wy) — запястье, a — направление предплечья,
  // s — сторона (−1 её правая/слева от зрителя, +1 её левая)
  function hand(parent, wx, wy, a, s) {
    var hg = mk('g', { 'class': 'm-hand m-hand-' + (s < 0 ? 'r' : 'l') }, parent);
    origin(hg, wx, wy);
    var dir = a - s * 0.16;
    var px = wx + Math.cos(dir) * 15, py = wy + Math.sin(dir) * 15;
    var nx = -Math.sin(dir), ny = Math.cos(dir);
    mk('path', { d: 'M' + (wx + nx * 5.6) + ' ' + (wy + ny * 5.6) + ' L' + (px + nx * 8) + ' ' + (py + ny * 8) + ' L' + (px - nx * 8) + ' ' + (py - ny * 8) + ' L' + (wx - nx * 5.6) + ' ' + (wy - ny * 5.6) + ' Z', fill: SKIN }, hg);
    mk('circle', { cx: wx, cy: wy, r: 5.6, fill: SKIN }, hg);
    var len = [17, 21, 20, 15], off = [-6, -2, 2, 6];
    for (var i = 0; i < 4; i++) {
      var fx = px + nx * off[i], fy = py + ny * off[i], fa = dir + (off[i] / 6) * 0.13;
      var tx = fx + Math.cos(fa) * len[i], ty = fy + Math.sin(fa) * len[i];
      mk('line', { x1: fx, y1: fy, x2: tx, y2: ty, stroke: SKIN, 'stroke-width': 3.9, 'stroke-linecap': 'round' }, hg);
      mk('ellipse', { cx: tx - Math.cos(fa) * .6, cy: ty - Math.sin(fa) * .6, rx: 2.5, ry: 1.7, fill: LIP, transform: 'rotate(' + (fa * 180 / Math.PI) + ' ' + tx + ' ' + ty + ')' }, hg);
      mk('ellipse', { cx: tx - Math.cos(fa) * 1.2, cy: ty - Math.sin(fa) * 1.2 - .5, rx: 1, ry: .5, fill: '#fff', opacity: .6, transform: 'rotate(' + (fa * 180 / Math.PI) + ' ' + tx + ' ' + ty + ')' }, hg);
    }
    var ta = dir - s * 0.95, tx0 = wx + nx * (-s) * 5.4 + Math.cos(dir) * 3, ty0 = wy + ny * (-s) * 5.4 + Math.sin(dir) * 3;
    mk('line', { x1: tx0, y1: ty0, x2: tx0 + Math.cos(ta) * 13, y2: ty0 + Math.sin(ta) * 13, stroke: SKIN, 'stroke-width': 4.2, 'stroke-linecap': 'round' }, hg);
    mk('ellipse', { cx: tx0 + Math.cos(ta) * 13, cy: ty0 + Math.sin(ta) * 13, rx: 2.3, ry: 1.6, fill: LIP, transform: 'rotate(' + (ta * 180 / Math.PI) + ' ' + (tx0 + Math.cos(ta) * 13) + ' ' + (ty0 + Math.sin(ta) * 13) + ')' }, hg);
    var tipx = px + Math.cos(dir) * 15, tipy = py + Math.sin(dir) * 15;
    if (s < 0) {
      var chip = mk('g', { 'class': 'm-chip' }, hg);
      origin(chip, tipx, tipy);
      mk('circle', { cx: tipx, cy: tipy, r: 9.5, fill: '#1b1d26', stroke: GOLD, 'stroke-width': 2, 'stroke-dasharray': '4.5 3.5' }, chip);
      mk('circle', { cx: tipx, cy: tipy, r: 4.5, fill: 'none', stroke: GOLD, 'stroke-width': 1 }, chip);
    } else {
      var cardg = mk('g', { 'class': 'm-card', transform: 'rotate(' + (dir * 180 / Math.PI - 90 + 12) + ' ' + tipx + ' ' + tipy + ')' }, hg);
      mk('rect', { x: tipx - 12, y: tipy - 6, width: 24, height: 34, rx: 2, fill: '#10213f', stroke: GOLD, 'stroke-width': 1 }, cardg);
      mk('rect', { x: tipx - 9, y: tipy - 3, width: 18, height: 28, rx: 1, fill: 'none', stroke: GOLD, 'stroke-width': .5, opacity: .7 }, cardg);
      var pad = mk('g', { 'class': 'm-paddle' }, hg);
      mk('line', { x1: tipx, y1: tipy, x2: tipx - 46, y2: tipy + 22, stroke: '#2b2f3a', 'stroke-width': 4.5, 'stroke-linecap': 'round' }, pad);
      mk('rect', { x: tipx - 72, y: tipy + 12, width: 28, height: 24, rx: 3, fill: '#3a3f4d', stroke: GOLD, 'stroke-width': 1.2, transform: 'rotate(-25 ' + (tipx - 58) + ' ' + (tipy + 24) + ')' }, pad);
    }
    return hg;
  }

  // Рука: плечо в чёрном рукаве три четверти → локоть в сторону → голое предплечье с золотыми браслетами → кисть.
  // side 'r' — её правая (слева от зрителя, плечо вперёд и ниже), 'l' — её левая (справа от зрителя)
  function arm(parent, side) {
    var s = side === 'r' ? -1 : 1;
    var sx = 220 + s * 66, sy = side === 'r' ? 230 : 222;
    var ex = 220 + s * 108, ey = 310;
    var wx = 220 + s * 124, wy = 394;
    var g = mk('g', { 'class': 'm-arm m-arm-' + side }, parent);
    origin(g, sx, sy);
    seg(g, sx, sy, 26, ex, ey, 20, JACKET, SATIN_HI);
    var fg = mk('g', { 'class': 'm-fore m-fore-' + side }, g);
    origin(fg, ex, ey);
    seg(fg, ex, ey, 16.5, wx, wy, 11, SKIN, SKIN_HI);
    var a = Math.atan2(wy - ey, wx - ex), ca = a * 180 / Math.PI;
    var k = 0.24, mx = ex + (wx - ex) * k, my = ey + (wy - ey) * k;
    seg(fg, ex, ey, 20, mx, my, 17, JACKET, SATIN_HI);
    mk('rect', { x: mx - 8.5, y: my - 1.5, width: 17, height: 3, rx: 1.4, fill: GOLD, transform: 'rotate(' + (ca + 90) + ' ' + mx + ' ' + my + ')' }, fg);
    var bx = wx - Math.cos(a) * 9, by = wy - Math.sin(a) * 9;
    var br = mk('g', { transform: 'rotate(' + (ca + 90) + ' ' + bx + ' ' + by + ')' }, fg);
    mk('rect', { x: bx - 7, y: by - 4.5, width: 14, height: 2.4, rx: 1.2, fill: GOLD }, br);
    mk('rect', { x: bx - 7, y: by - .8, width: 14, height: 2.4, rx: 1.2, fill: GOLD_DK }, br);
    if (side === 'l') {
      mk('rect', { x: bx - 7.5, y: by + 3, width: 15, height: 4.4, rx: 2, fill: GOLD }, br);
      mk('circle', { cx: bx, cy: by + 5.2, r: 1.9, fill: '#d1122f' }, br);
    } else {
      mk('rect', { x: bx - 7.5, y: by + 3, width: 15, height: 2.6, rx: 1.3, fill: GOLD_HI, opacity: .9 }, br);
    }
    hand(fg, wx, wy, a, s);
    return g;
  }

  function build(container) {
    var svg = mk('svg', { 'class': 'bj-margot', viewBox: '0 0 440 420', 'data-state': 'idle', 'aria-hidden': 'true' });
    var defs = mk('defs', null, svg);
    function lg(id, x1, y1, x2, y2, stops, units) {
      var g = mk('linearGradient', { id: id, x1: x1, y1: y1, x2: x2, y2: y2, gradientUnits: units || 'objectBoundingBox' }, defs);
      for (var i = 0; i < stops.length; i++) mk('stop', { offset: stops[i][0], 'stop-color': stops[i][1] }, g);
    }
    function rgrad(id, color, op0, op1) {
      var g = mk('radialGradient', { id: id, cx: .5, cy: .5, r: .5 }, defs);
      mk('stop', { offset: 0, 'stop-color': color, 'stop-opacity': op0 }, g);
      mk('stop', { offset: 1, 'stop-color': color, 'stop-opacity': op1 }, g);
    }
    lg('bjm-hair', 0, 36, 0, 300, [[0, '#cc4a1f'], [.4, HAIR], [1, '#6a1a0e']], 'userSpaceOnUse');
    lg('bjm-hairdk', 0, 0, 0, 1, [[0, HAIR_MID], [1, '#3a0c08']]);
    lg('bjm-lip', 0, 148, 0, 166, [[0, '#b00e2a'], [1, '#e8213e']], 'userSpaceOnUse');
    lg('bjm-satin', 0, 0, 1, 1, [[0, '#3a3d4c'], [.5, '#1c1d26'], [1, '#2e303d']]);
    rgrad('bjm-shadow', '#a8605f', .5, 0);
    rgrad('bjm-blush', '#f2808a', .34, 0);

    var root = mk('g', { 'class': 'm-root' }, svg);
    var body = mk('g', { 'class': 'm-body' }, root);

    // --- волосы сзади: объём и локоны за плечами (поворачиваются вместе с головой) ---
    var hbTurn = mk('g', { 'class': 'm-head-turn' }, body); origin(hbTurn, 220, 236);
    var hbHead = mk('g', { 'class': 'm-head' }, hbTurn); origin(hbHead, 220, 236);
    var hbShift = mk('g', { transform: 'translate(0 7)' }, hbHead);
    var hbSway = mk('g', { 'class': 'm-sway' }, hbShift); origin(hbSway, 220, 60);
    mk('path', { d: 'M222 34 C180 34 148 66 146 124 C144 164 130 196 136 232 C140 256 132 276 146 288 C158 298 176 290 174 274 C172 262 164 262 166 250 L170 210 L270 210 L274 250 C276 262 268 262 266 274 C264 290 282 298 294 288 C308 276 300 256 304 232 C310 196 296 164 294 124 C292 66 262 34 222 34 Z', fill: 'url(#bjm-hairdk)' }, hbSway);
    mk('path', { d: 'M146 150 C140 190 134 214 140 244 M294 150 C300 190 306 214 300 244', fill: 'none', stroke: HAIR_HI, 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: .35 }, hbSway);

    // --- шея ---
    mk('path', { d: 'M205 160 L204 190 C198 198 186 204 170 208 L270 208 C254 204 242 198 236 190 L235 160 Z', fill: SKIN }, body);
    mk('path', { d: 'M205 166 Q220 186 235 166 L235 178 Q220 194 205 178 Z', fill: SKIN_SH, opacity: .55 }, body);

    // --- торс: песочные часы — узкие плечи, грудь, тонкая талия, расклешённый низ ---
    var torso = mk('g', { 'class': 'm-torso' }, body);
    origin(torso, 220, 340);
    var tp = mk('g', { 'class': 'm-pose', transform: 'rotate(-2.5 220 340)' }, torso);
    var chest = mk('g', { 'class': 'm-breath' }, tp); origin(chest, 220, 320);
    mk('path', { d: 'M172 204 C158 208 150 218 150 232 C149 248 134 262 138 277 C142 291 158 298 170 301 C176 303 178 304 178 306 C178 320 164 330 154 346 L286 346 C276 330 262 320 262 306 C262 304 264 303 270 301 C282 298 298 291 302 277 C306 262 291 248 290 232 C290 218 282 208 268 204 L242 196 L198 196 Z', fill: 'url(#bjm-satin)' }, chest);
    // блуза в V
    mk('path', { d: 'M190 208 L220 312 L250 208 L238 196 L202 196 Z', fill: SILK }, chest);
    mk('path', { d: 'M203 198 L220 312 L206 222 Z', fill: SILK_SH, opacity: .5 }, chest);
    // кожа в декольте
    mk('path', { d: 'M204 190 L220 252 L236 190 Z', fill: SKIN }, chest);
    mk('path', { d: 'M204 190 Q214 212 220 252 Q214 216 204 190 Z', fill: SKIN_SH, opacity: .45 }, chest);
    mk('path', { d: 'M197 206 Q208 211 218 209 M243 206 Q232 211 222 209', fill: 'none', stroke: SKIN_SH, 'stroke-width': 1.3, 'stroke-linecap': 'round', opacity: .8 }, chest);
    // воротничок блузы
    mk('path', { d: 'M205 184 L186 207 L207 221 Z M235 184 L254 207 L233 221 Z', fill: SILK }, chest);
    mk('path', { d: 'M205 184 L186 207 L207 221 M235 184 L254 207 L233 221', fill: 'none', stroke: SILK_SH, 'stroke-width': 1 }, chest);
    // лацканы
    mk('path', { d: 'M187 206 L220 316 L209 316 C192 292 176 260 168 224 Z', fill: SATIN }, chest);
    mk('path', { d: 'M253 206 L220 316 L231 316 C248 292 264 260 272 224 Z', fill: SATIN }, chest);
    mk('path', { d: 'M187 206 L220 316 M253 206 L220 316', fill: 'none', stroke: GOLD, 'stroke-width': 1.3, opacity: .85 }, chest);
    mk('path', { d: 'M178 222 C184 252 196 280 211 302 M262 222 C256 252 244 280 229 302', fill: 'none', stroke: SATIN_HI, 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: .5 }, chest);
    // грудь: округлый силуэт под жакетом, мягкий блик атласа, подгрудная тень; дышит чуть заметнее плеч
    [[-1, 178], [1, 262]].forEach(function (b) {
      var bg = mk('g', { 'class': 'm-bust' }, chest); origin(bg, b[1], 292);
      mk('path', { d: 'M' + (b[1] + b[0] * -20) + ' 288 Q' + b[1] + ' ' + (b[0] < 0 ? 300 : 300) + ' ' + (b[1] + b[0] * 24) + ' 284', fill: 'none', stroke: '#000', 'stroke-width': 2.4, 'stroke-linecap': 'round', opacity: .45 }, bg);
      mk('ellipse', { cx: b[1] + b[0] * 2, cy: 262, rx: 14, ry: 18, fill: '#fff', opacity: .07 }, bg);
      mk('ellipse', { cx: b[1] + b[0] * 1, cy: 258, rx: 5, ry: 9, fill: '#fff', opacity: .12, transform: 'rotate(' + (-b[0] * 12) + ' ' + b[1] + ' 258)' }, bg);
    });
    // шёлк блузы натянут мягкими складками к центру
    mk('path', { d: 'M207 258 Q213 272 217 290 M233 258 Q227 272 223 290 M210 246 Q216 254 218 264 M230 246 Q224 254 222 264', fill: 'none', stroke: SILK_SH, 'stroke-width': 1, 'stroke-linecap': 'round', opacity: .7 }, chest);
    mk('path', { d: 'M160 286 C170 296 178 300 178 306 C178 320 164 330 154 346 L176 346 C180 330 188 320 186 306 C186 298 176 290 168 284 Z M280 286 C270 296 262 300 262 306 C262 320 276 330 286 346 L264 346 C260 330 252 320 254 306 C254 298 264 290 272 284 Z', fill: '#000', opacity: .3 }, chest);
    mk('circle', { cx: 220, cy: 326, r: 3.3, fill: GOLD }, chest);
    mk('circle', { cx: 219, cy: 325, r: 1.2, fill: GOLD_HI }, chest);
    // чокер и цепочка с подвеской
    mk('path', { d: 'M205 181 Q220 191 235 181', fill: 'none', stroke: GOLD, 'stroke-width': 3, 'stroke-linecap': 'round' }, chest);
    mk('path', { d: 'M220 190 L223.5 195 L220 201 L216.5 195 Z', fill: LIP }, chest);
    mk('path', { d: 'M208 196 Q220 250 232 196', fill: 'none', stroke: GOLD, 'stroke-width': 1.2 }, chest);
    mk('path', { d: 'M220 227 L224.5 234 L220 244 L215.5 234 Z', fill: GOLD }, chest);
    mk('path', { d: 'M220 228 L222.4 234 L220 241 L217.6 234 Z', fill: GOLD_HI }, chest);

    // --- руки ---
    arm(body, 'r');
    arm(body, 'l');

    // --- голова ---
    var turn = mk('g', { 'class': 'm-head-turn' }, root);
    origin(turn, 220, 236);
    var head = mk('g', { 'class': 'm-head' }, turn);
    origin(head, 220, 236);
    var pose = mk('g', { 'class': 'm-hpose', transform: 'translate(0 7) rotate(3 220 200)' }, head);

    // лицо: сердечком, высокие скулы, маленький подбородок (два тона тени + блик)
    mk('path', { d: 'M220 58 C250 58 267 80 266 108 C265 134 252 156 238 166 C231 172 225 174 220 174 C215 174 209 172 202 166 C188 156 175 134 174 108 C173 80 190 58 220 58 Z', fill: SKIN }, pose);
    mk('path', { d: 'M180 132 C186 148 196 160 208 169 C194 166 184 154 180 132 Z M260 132 C254 148 244 160 232 169 C246 166 256 154 260 132 Z', fill: SKIN_SH, opacity: .45 }, pose);
    mk('ellipse', { cx: 189, cy: 142, rx: 16, ry: 9, fill: 'url(#bjm-blush)' }, pose);
    mk('ellipse', { cx: 251, cy: 142, rx: 16, ry: 9, fill: 'url(#bjm-blush)' }, pose);
    mk('path', { d: 'M221 104 Q224 118 222 132', fill: 'none', stroke: SKIN_HI, 'stroke-width': 4, 'stroke-linecap': 'round', opacity: .45 }, pose);

    // глаза: большие миндалевидные, чёткая линия верхнего века с крылом, 4 ресницы дугой
    function eye(x, dir, side) {
      var g = mk('g', { 'class': 'm-eye m-eye-' + side }, pose);
      var cy = 118, xi = x - dir * 14, yi = cy + 2, xo = x + dir * 15, yo = cy - 1.5;
      var topc = 'C' + (xi + dir * 5) + ' ' + (cy - 10.5) + ' ' + (xo - dir * 7) + ' ' + (cy - 11.5) + ' ' + xo + ' ' + yo;
      var botc = 'C' + (xo - dir * 6) + ' ' + (cy + 8.5) + ' ' + (xi + dir * 6) + ' ' + (cy + 9.5) + ' ' + xi + ' ' + yi;
      var d = 'M' + xi + ' ' + yi + ' ' + topc + ' ' + botc + ' Z';
      mk('path', { d: d, fill: '#fdfaf8' }, g);
      var pup = mk('g', { 'class': 'm-pupil' }, g);
      origin(pup, x, cy);
      var gz = mk('g', { 'class': 'm-gaze' }, pup);
      mk('circle', { cx: x, cy: cy, r: 7.2, fill: IRIS }, gz);
      mk('circle', { cx: x, cy: cy + 2.4, r: 4.6, fill: '#8fc9a0', opacity: .45 }, gz);
      mk('circle', { cx: x, cy: cy, r: 7.2, fill: 'none', stroke: '#1d3a2c', 'stroke-width': 1.3 }, gz);
      mk('circle', { cx: x, cy: cy, r: 3.4, fill: INK }, gz);
      mk('circle', { cx: x + 2.6, cy: cy - 2.8, r: 1.8, fill: '#fff' }, gz);
      // верхнее веко: кожа + линия ресниц по нижней кромке (видна при моргании и прищуре)
      var lid = mk('g', { 'class': 'm-lid m-lid-' + side }, g);
      origin(lid, x, cy - 11);
      mk('path', { d: d, fill: SKIN }, lid);
      mk('path', { d: 'M' + xo + ' ' + yo + ' ' + botc, fill: 'none', stroke: INK, 'stroke-width': 1.8, 'stroke-linecap': 'round' }, lid);
      // дымчатые тени над веком (поверх века, мягкий тёплый градиент)
      mk('ellipse', { cx: x + dir * 1.5, cy: cy - 9, rx: 16.5, ry: 6.8, fill: 'url(#bjm-shadow)' }, g);
      var low = mk('path', { 'class': 'm-lidlow', d: d, fill: SKIN }, g);
      origin(low, x, cy + 9);
      // подводка: чёткая линия века и аккуратное крыло
      mk('path', { d: 'M' + (xi - dir * .6) + ' ' + (yi - .6) + ' ' + topc, fill: 'none', stroke: INK, 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
      mk('path', { d: 'M' + (xo - dir * 5) + ' ' + (cy - 9.2) + ' L' + (xo + dir * 7.5) + ' ' + (yo - 5.6) + ' L' + (xo - dir * .5) + ' ' + (yo + .8) + ' Z', fill: INK }, g);
      // складка века
      mk('path', { d: 'M' + (x - dir * 11) + ' ' + (cy - 9) + ' Q' + x + ' ' + (cy - 17) + ' ' + (x + dir * 14) + ' ' + (cy - 10), fill: 'none', stroke: '#b8786c', 'stroke-width': .9, 'stroke-linecap': 'round', opacity: .55 }, g);
      // ресницы: 4 штриха изящной дугой у внешнего края
      var L = [[4, 10.6], [8, 10.2], [11.4, 8], [14, 4.4]];
      for (var j = 0; j < L.length; j++) {
        var sxp = x + dir * L[j][0], syp = cy - L[j][1];
        mk('path', { d: 'M' + sxp + ' ' + (syp + .6) + ' Q' + (sxp + dir * 1.6) + ' ' + (syp - 3) + ' ' + (sxp + dir * (4.2 + j * .4)) + ' ' + (syp - 4.2), fill: 'none', stroke: INK, 'stroke-width': 1.2, 'stroke-linecap': 'round' }, g);
      }
      return g;
    }
    eye(200, -1, 'r');
    eye(240, 1, 'l');
    // брови: плавные дуги; её левая (справа от зрителя) — фирменная
    var browR = mk('path', { 'class': 'm-brow m-brow-r', d: 'M184 104 C192 95 205 93 216 99 C205 97 193 99 184 104 Z', fill: '#5a2218', stroke: '#5a2218', 'stroke-width': 1, 'stroke-linejoin': 'round' }, pose);
    origin(browR, 216, 98);
    var browL = mk('path', { 'class': 'm-brow m-brow-l', d: 'M256 104 C248 95 235 93 224 99 C235 97 247 99 256 104 Z', fill: '#5a2218', stroke: '#5a2218', 'stroke-width': 1, 'stroke-linejoin': 'round' }, pose);
    origin(browL, 224, 98);
    // нос: тонкий, прямой, тень с одной стороны, лёгкий кончик
    mk('path', { d: 'M218.5 122 Q217 135 214.8 142', fill: 'none', stroke: SKIN_SH, 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: .8 }, pose);
    mk('path', { d: 'M215 144 Q220 148.4 225 144', fill: 'none', stroke: SKIN_SH, 'stroke-width': 1.3, 'stroke-linecap': 'round' }, pose);
    mk('ellipse', { cx: 221.4, cy: 136, rx: 1.2, ry: 3.6, fill: SKIN_HI, opacity: .75 }, pose);

    // губы: шесть форм, чёткий купидонов лук, один блик
    var mouth = mk('g', { 'class': 'm-mouth' }, pose);
    function lips(cls, d, line, extra) {
      var g = mk('g', { 'class': 'm-lips ' + cls }, mouth);
      mk('path', { d: d, fill: 'url(#bjm-lip)' }, g);
      if (extra) extra(g);
      if (line) mk('path', { d: line, fill: 'none', stroke: LIP_DK, 'stroke-width': .9, 'stroke-linecap': 'round' }, g);
      return g;
    }
    lips('m-lips-neutral', 'M205 153.5 C210 150.5 215 149.5 220 152 C225 149.5 230 150.5 235 153.5 C230 160.5 225 162.5 220 162.5 C215 162.5 210 160.5 205 153.5 Z', 'M205.5 153.5 C212 155.5 228 155.5 234.5 153.5');
    lips('m-lips-smirk', 'M205 154 C210 151 215 150 220 152.3 C226 149.5 231 148.5 237 150.5 C231 159 225 162.5 220 162.5 C214 162.5 209 160.5 205 154 Z', 'M205.5 154 C213 156 229 154.5 237 150.5');
    lips('m-lips-pressed', 'M207 154 C212 151.5 216 151.5 220 153 C224 151.5 228 151.5 233 154 C228 158 224 159 220 159 C216 159 212 158 207 154 Z', 'M207.5 154 C214 155.8 226 155.8 232.5 154');
    lips('m-lips-part', 'M205 153 C210 150 215 149 220 151.5 C225 149 230 150 235 153 C231 162 225 164 220 164 C215 164 209 162 205 153 Z', null, function (g) {
      mk('path', { d: 'M210 154 Q220 157.5 230 154 Q220 160 210 154 Z', fill: '#4a0a18' }, g);
      mk('path', { d: 'M213 154.6 Q220 156.8 227 154.6 Q220 157.6 213 154.6 Z', fill: '#fff', opacity: .9 }, g);
    });
    var sm = lips('m-lips-smile', 'M202 150 C208 147 214 146 220 149 C226 146 232 147 238 150 C235 162 228 167 220 167 C212 167 205 162 202 150 Z', null, function (g) {
      mk('path', { d: 'M207 151.5 C214 154.5 226 154.5 233 151.5 C230 159 226 162 220 162 C214 162 210 159 207 151.5 Z', fill: '#fff' }, g);
    });
    mk('path', { d: 'M206 151 C214 154.8 226 154.8 234 151', fill: 'none', stroke: LIP_DK, 'stroke-width': .9 }, sm);
    var o = mk('g', { 'class': 'm-lips m-lips-o' }, mouth);
    mk('ellipse', { cx: 220, cy: 157, rx: 6.8, ry: 8, fill: 'url(#bjm-lip)' }, o);
    mk('ellipse', { cx: 220, cy: 157.6, rx: 3.2, ry: 4.8, fill: '#4a0a18' }, o);
    var gloss = mk('g', { 'class': 'm-gloss' }, mouth);
    mk('path', { d: 'M214.5 158.6 Q220 160.6 225.5 158.6', fill: 'none', stroke: '#fff', 'stroke-width': 1.5, 'stroke-linecap': 'round', opacity: .8 }, gloss);

    // --- волосы спереди: боковая волна, отдельные локоны на плечах, один блик ---
    var hs = mk('g', { 'class': 'm-sway' }, pose); origin(hs, 220, 60);
    var hair = mk('g', { 'class': 'm-hair' }, hs);
    mk('path', { d: 'M166 128 C154 66 188 34 226 36 C266 38 288 70 278 128 C276 102 268 84 256 76 C240 73 222 80 207 94 C196 104 188 116 185 134 C178 140 170 136 166 128 Z', fill: 'url(#bjm-hair)' }, hair);
    // левый локон (на плече): плавная волна, кончик завивается
    mk('path', { d: 'M172 96 C158 128 162 170 154 196 C148 216 152 232 150 246 C148 262 160 272 170 266 C178 260 174 250 168 250 C162 248 164 236 168 226 C176 208 184 192 186 170 C187 154 190 144 185 134 Z', fill: 'url(#bjm-hair)' }, hair);
    // правый локон
    mk('path', { d: 'M272 96 C284 128 280 170 288 196 C294 216 290 232 292 246 C294 262 282 272 272 266 C264 260 268 250 274 250 C280 248 278 236 274 226 C266 208 258 192 256 170 C255 154 252 144 257 134 Z', fill: 'url(#bjm-hair)' }, hair);
    // отдельные завитки у шеи
    mk('path', { d: 'M176 190 C168 212 172 236 184 246 C192 252 198 246 194 238 C188 232 190 220 192 206 Z', fill: HAIR_MID }, hair);
    mk('path', { d: 'M264 190 C272 212 268 236 256 246 C248 252 242 246 246 238 C252 232 250 220 248 206 Z', fill: HAIR_MID }, hair);
    // тень от волны на лбу и один широкий блик
    mk('path', { d: 'M207 94 C222 80 242 73 256 76 C244 80 226 88 212 100 Z', fill: HAIR_DK, opacity: .4 }, hair);
    mk('path', { d: 'M188 70 C200 50 228 44 250 50 C228 50 206 58 192 78 Z', fill: HAIR_HI, opacity: .7 }, hair);
    mk('path', { d: 'M161 176 C157 196 158 210 154 226 M287 176 C291 196 290 210 294 226', fill: 'none', stroke: HAIR_HI, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: .5 }, hair);

    // серьги-каскады: золото с красными камнями (одна искра по таймеру)
    [[181, 146], [259, 146]].forEach(function (p, idx) {
      var x = p[0], y = p[1];
      mk('circle', { cx: x, cy: y, r: 2.2, fill: GOLD }, hs);
      mk('line', { x1: x, y1: y, x2: x, y2: y + 13, stroke: GOLD, 'stroke-width': 1.1 }, hs);
      mk('path', { d: 'M' + x + ' ' + (y + 9) + ' L' + (x + 4.6) + ' ' + (y + 16) + ' L' + x + ' ' + (y + 23) + ' L' + (x - 4.6) + ' ' + (y + 16) + ' Z', fill: GOLD }, hs);
      mk('path', { d: 'M' + x + ' ' + (y + 12) + ' L' + (x + 2.5) + ' ' + (y + 16) + ' L' + x + ' ' + (y + 20) + ' L' + (x - 2.5) + ' ' + (y + 16) + ' Z', fill: LIP }, hs);
      mk('circle', { cx: x, cy: y + 27.5, r: 2, fill: GOLD_HI }, hs);
      var sp = mk('path', { 'class': 'm-spark' + (idx ? ' m-spark2' : ''), d: 'M' + x + ' ' + (y + 5) + ' L' + (x + 1.6) + ' ' + (y + 11) + ' L' + (x + 7) + ' ' + (y + 12.4) + ' L' + (x + 1.6) + ' ' + (y + 13.8) + ' L' + x + ' ' + (y + 20) + ' L' + (x - 1.6) + ' ' + (y + 13.8) + ' L' + (x - 7) + ' ' + (y + 12.4) + ' L' + (x - 1.6) + ' ' + (y + 11) + ' Z', fill: '#fff' }, hs);
      origin(sp, x, y + 12.4);
    });

    container.appendChild(svg);

    var bubble = document.createElement('div');
    bubble.className = 'bj-bubble';
    var btxt = document.createElement('span');
    bubble.appendChild(btxt);
    container.appendChild(bubble);

    return { svg: svg, bubble: bubble, btxt: btxt, pupils: svg.querySelectorAll('.m-pupil'), turns: svg.querySelectorAll('.m-head-turn') };
  }

  function create(container, opts) {
    opts = opts || {};
    var p = build(container);
    var m = { state: 'idle', el: p.svg, _look: 0 };
    var nextBlink = 0, blinkUntil = 0, sayTimer = null, browTimer = null, stateTimer = null, winkTimer = null;

    m.set = function (state, ms) {
      if (!state) state = 'idle';
      m.state = state;
      p.svg.setAttribute('data-state', state);
      // перезапуск одноразовых анимаций (кивок, подмигивание) при повторной установке того же состояния
      p.svg.classList.remove('m-replay');
      void p.svg.getBoundingClientRect();
      p.svg.classList.add('m-replay');
      if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
      if (ms) stateTimer = setTimeout(function () { m.set('idle'); }, ms);
      return m;
    };
    m.say = function (text, ms) {
      if (sayTimer) { clearTimeout(sayTimer); sayTimer = null; }
      if (!text) { p.bubble.classList.remove('on'); return m; }
      p.btxt.textContent = text;
      p.bubble.classList.remove('on');
      void p.bubble.getBoundingClientRect();
      p.bubble.classList.add('on');
      sayTimer = setTimeout(function () { p.bubble.classList.remove('on'); }, ms || 2800);
      return m;
    };
    m.brow = function (ms) {
      p.svg.classList.add('m-brow-up');
      if (browTimer) clearTimeout(browTimer);
      browTimer = setTimeout(function () { p.svg.classList.remove('m-brow-up'); }, ms || 1400);
      return m;
    };
    m.wink = function (ms) {
      p.svg.classList.add('m-wink');
      if (winkTimer) clearTimeout(winkTimer);
      winkTimer = setTimeout(function () { p.svg.classList.remove('m-wink'); }, ms || 900);
      return m;
    };
    m.lookAt = function (x) {
      if (x === null || x === undefined) x = 0;
      x = Math.max(-1, Math.min(1, x));
      m._look = x;
      for (var i = 0; i < p.pupils.length; i++) p.pupils[i].style.setProperty('--look', 'translate(' + (x * 3.5) + 'px, 1px)');
      for (var j = 0; j < p.turns.length; j++) p.turns[j].style.transform = 'rotate(' + (x * 4) + 'deg)';
      return m;
    };
    m.tick = function (now) {
      if (!nextBlink) nextBlink = now + 1200 + Math.random() * 3000;
      if (now >= nextBlink) {
        p.svg.classList.add('m-blink');
        blinkUntil = now + 170;
        nextBlink = now + 2400 + Math.random() * 3800;
      } else if (blinkUntil && now >= blinkUntil) {
        p.svg.classList.remove('m-blink');
        blinkUntil = 0;
      }
    };
    m.destroy = function () { if (p.svg.parentNode) p.svg.parentNode.removeChild(p.svg); if (p.bubble.parentNode) p.bubble.parentNode.removeChild(p.bubble); };
    return m;
  }

  // ---------- банк реплик: 2–6 слов, голос хозяйки VIP-зала — про ситуацию, не про человека ----------
  var LINES = {
    ru: {
      hello: ['Сядьте поближе', 'Добрый вечер. Ставки', 'Люблю смелых. Ставки', 'Вечер только начинается', 'Фишки на сукно, прошу', 'Ну что, рискнём?'],
      bets: ['Ставки приняты', 'Больше ставок нет', 'Красиво поставлено', 'Закрываю ставки', 'Руки от фишек', 'Не бойтесь, я не кусаюсь'],
      deal: ['Раздаю. Не моргайте', 'Карты пошли', 'Посмотрим, что выпало', 'Две каждому', 'Сдаю с улыбкой', 'Удача, будь добра'],
      playerBj: ['Вот это блэкджек', 'Мой любимый расклад', 'Три к двум. Браво', 'Удача к вам благосклонна', 'Мне нравится ваш вкус', 'Сорвали куш'],
      playerBust: ['Ох, не повезло', 'Перебор. Бывает', 'Жадность красит… не всегда', 'Чуть-чуть лишнего', 'Одна карта лишняя', 'Так близко, и всё же'],
      insurance: ['Страхуемся? Не бойтесь', 'Туз. Щекочет нервы', 'Я не кусаюсь… только фишки', 'Два к одному, если что', 'Смелым страховка не нужна', 'Страховка? Решайте'],
      peek: ['Загляну украдкой', 'Тсс… один взгляд', 'Что же там?', 'Любопытно, правда?', 'Секундочку, не дышите', 'Заглянем под карту'],
      dealerDraw: ['Беру ещё', 'Правила есть правила', 'Теперь моя очередь', 'Ещё одну, пожалуйста', 'До семнадцати', 'Посмотрим, что мне'],
      dealerBust: ['Ох, перебрала', 'Сегодня ваш вечер', 'Казино платит', 'Мне не жаль… почти', 'Поздравляю оставшихся', 'Признаю поражение'],
      dealer21: ['Ничего личного', 'Двадцать одно, увы', 'Простите… не очень', 'Так уж вышло', 'Не дуйтесь, прошу', 'Казино благодарит'],
      dealerWin: ['Ох, как жаль', 'Стол забирает', 'Не сегодня', 'В другой раз повезёт', 'Фишки возвращаются домой', 'Такова игра'],
      allin: ['Люблю смелых', 'Ва-банк? Обожаю', 'Всё на сукно', 'Вот это характер', 'Решительно. Мне нравится', 'Красивый жест'],
      jackpot: ['Вот это куш', 'Джекпот! Браво', 'Зал замер', 'Сорвали банк', 'Ох, какая красота', 'Стол аплодирует'],
      level: ['Ставки растут', 'Играем по-крупному', 'Планка выше', 'Дороже, значит интереснее', 'Отсидеться не выйдет', 'Становится жарко'],
      out: ['Было приятно', 'Заходите ещё', 'Стол будет скучать', 'До новой встречи', 'Спасибо за игру', 'Фишки кончились', 'Красиво держались'],
      shuffle: ['Новый шуз, свежие карты', 'Тасую… не скучайте', 'Минутку, перемешаю', 'Шесть колод, один шарм', 'Тасую с чувством', 'Отсечка. Свежее начало'],
      final: ['Последний за столом', 'Игра окончена', 'Поздравляю победителя', 'Стол закрыт. Жаль', 'Было красиво', 'Вечер был чудесный'],
      rescue: ['Спасены… пока', 'Удача любит упрямых', 'На волоске', 'С возвращением', 'Выдохнули? Рано', 'Ещё поживём'],
      hint: ['Ещё или хватит?', 'Не томите', 'Жду решений', 'Карты ждут', 'Время тикает', 'Решайтесь, я жду'],
      hit16: ['На шестнадцать? Смело', 'Рискуете? Люблю', 'Ну-ну, интересно', 'Как скажете', 'Отважно', 'Щекочете нервы'],
      solo: ['Не торопитесь', 'Я подожду', 'Сядьте поближе', 'Времени у нас много', 'Думайте, я не спешу', 'Ну что, рискнём?']
    },
    en: {
      hello: ['Come sit closer', 'Good evening. Bets', 'I love the bold', 'The night is young', 'Chips on the felt', 'Shall we risk it?'],
      bets: ['Bets are in', 'No more bets', 'Nicely placed', 'Closing the bets', 'Hands off the chips', "Don't worry, I don't bite"],
      deal: ["Dealing. Don't blink", 'Cards are out', "Let's see what falls", 'Two each', 'Dealing with a smile', 'Lady Luck, be kind'],
      playerBj: ['Blackjack. Delicious', 'My favorite kind of hand', 'Three to two. Bravo', 'Luck adores you', 'I like your taste', 'You hit the jackpot'],
      playerBust: ['Oh, not your night', 'Bust. It happens', 'A little too greedy', 'One card too many', 'So close, and yet', 'Ouch. Better luck'],
      insurance: ["Insure? Don't be shy", 'An ace. Nerve-racking', "I don't bite… only chips", 'Two to one, just in case', 'The bold skip it', 'Insurance? Decide'],
      peek: ['A little peek', 'Shh… one glance', "What's under there?", "Curious, aren't we?", "One second, don't breathe", 'Peeking underneath'],
      dealerDraw: ['One more for me', 'Rules are rules', 'My turn now', 'Drawing a card', 'Up to seventeen', "Let's see mine"],
      dealerBust: ['Oh, I busted', 'Tonight is yours', 'The house pays', "I don't mind… almost", 'Congrats to the rest', 'I admit defeat'],
      dealer21: ['Nothing personal', 'Twenty-one, sorry', 'Forgive me… not really', 'It just happened', "Don't pout, please", 'The house thanks you'],
      dealerWin: ['Oh, what a pity', 'The house takes it', 'Not tonight', 'Next time, perhaps', 'Chips come home', "That's the game"],
      allin: ['I love the bold', 'All in? Adore it', 'Everything on the felt', "Now that's character", 'Decisive. I like it', 'A lovely gesture'],
      jackpot: ['What a haul', 'Jackpot! Brava', 'The room froze', 'You broke the bank', 'Oh, gorgeous', 'The table applauds'],
      level: ['Stakes are rising', 'Playing for big', 'The bar is higher', 'Pricier means better', 'No sitting out', "Getting hot in here"],
      out: ['It was a pleasure', 'Do come back', 'The table will miss you', 'Until next time', 'Thanks for playing', 'Out of chips', 'You held on beautifully'],
      shuffle: ['New shoe, fresh cards', "Shuffling. Don't be bored", 'One minute, shuffling', 'Six decks, one charm', 'Shuffling with feeling', 'Cut card. Fresh start'],
      final: ['Last one standing', 'Game over', 'Congrats to the winner', 'Table closed. Pity', 'That was lovely', 'What a lovely evening'],
      rescue: ['Saved… for now', 'Luck loves the stubborn', 'By a thread', 'Welcome back', 'Breathe out? Too soon', 'Still alive'],
      hint: ['Hit or stand?', "Don't keep me waiting", 'Waiting on you', 'Cards are waiting', 'Clock is ticking', 'Take the leap'],
      hit16: ['On sixteen? Bold', 'Risky? I like it', 'Well, interesting', 'As you wish', 'Brave', 'Tickling the nerves'],
      solo: ['No rush', "I'll wait", 'Come sit closer', 'We have all night', "Think. I'm in no hurry", 'Shall we risk it?']
    },
    el: {
      hello: ['Καθίστε πιο κοντά', 'Καλησπέρα. Στοιχήματα', 'Λατρεύω τους τολμηρούς', 'Η βραδιά μόλις αρχίζει', 'Μάρκες στο τραπέζι', 'Ρισκάρουμε λοιπόν;'],
      bets: ['Τα στοιχήματα μπήκαν', 'Τέλος στοιχημάτων', 'Ωραίο στοίχημα', 'Κλείνω τα στοιχήματα', 'Χέρια μακριά από τις μάρκες', 'Μη φοβάστε, δεν δαγκώνω'],
      deal: ['Μοιράζω. Προσοχή', 'Τα φύλλα βγήκαν', 'Για να δούμε', 'Δύο στον καθένα', 'Μοιράζω με χαμόγελο', 'Τύχη, γίνε καλή'],
      playerBj: ['Μπλακτζάκ. Υπέροχο', 'Το αγαπημένο μου χαρτί', 'Τρία προς δύο. Μπράβο', 'Η τύχη σας λατρεύει', 'Μου αρέσει το γούστο σας', 'Πετύχατε διάνα'],
      playerBust: ['Ωχ, δεν είχατε τύχη', 'Κάηκε. Συμβαίνει', 'Λίγο υπερβολική απληστία', 'Ένα φύλλο παραπάνω', 'Τόσο κοντά, κι όμως', 'Άου. Την επόμενη'],
      insurance: ['Ασφάλεια; Μην ντρέπεστε', 'Άσος. Τσιγκλάει τα νεύρα', 'Δεν δαγκώνω… μόνο μάρκες', 'Δύο προς ένα, για σιγουριά', 'Οι τολμηροί την προσπερνούν', 'Ασφάλεια; Αποφασίστε'],
      peek: ['Μια κρυφή ματιά', 'Ψιτ… μία ματιά', 'Τι κρύβεται εκεί;', 'Περίεργοι, ε;', 'Μια στιγμή, μην αναπνέετε', 'Κρυφοκοιτάζω'],
      dealerDraw: ['Άλλο ένα για μένα', 'Κανόνες είναι', 'Η σειρά μου', 'Τραβάω φύλλο', 'Μέχρι το 17', 'Για να δούμε'],
      dealerBust: ['Ωχ, κάηκα', 'Η βραδιά είναι δική σας', 'Το καζίνο πληρώνει', 'Δεν με πειράζει… σχεδόν', 'Συγχαρητήρια στους υπόλοιπους', 'Παραδέχομαι την ήττα'],
      dealer21: ['Τίποτα προσωπικό', 'Είκοσι ένα, συγγνώμη', 'Συγχωρέστε με… όχι και τόσο', 'Έτσι ήρθε', 'Μη μουτρώνετε, παρακαλώ', 'Το καζίνο ευχαριστεί'],
      dealerWin: ['Ωχ, κρίμα', 'Το τραπέζι παίρνει', 'Όχι απόψε', 'Την άλλη φορά', 'Οι μάρκες γυρνούν σπίτι', 'Έτσι είναι το παιχνίδι'],
      allin: ['Λατρεύω τους τολμηρούς', 'Όλα μέσα; Το λατρεύω', 'Όλα στο τραπέζι', 'Έχετε χαρακτήρα', 'Αποφασιστικά. Μου αρέσει', 'Ωραία κίνηση'],
      jackpot: ['Τι μεγάλο κέρδος', 'Τζάκποτ! Μπράβο', 'Η αίθουσα πάγωσε', 'Έσπασε η μπάνκα', 'Ωχ, υπέροχο', 'Το τραπέζι χειροκροτεί'],
      level: ['Τα στοιχήματα ανεβαίνουν', 'Παίζουμε μεγάλα', 'Η μπάρα ανεβαίνει', 'Ακριβότερα, πιο ενδιαφέρον', 'Δεν κρυβόμαστε', 'Ζεσταίνεται η ατμόσφαιρα'],
      out: ['Χάρηκα πολύ', 'Ελάτε ξανά', 'Θα λείψετε στο τραπέζι', 'Μέχρι την επόμενη', 'Ευχαριστώ για το παιχνίδι', 'Τέλος οι μάρκες', 'Αντέξατε όμορφα'],
      shuffle: ['Νέο παπούτσι, φρέσκα φύλλα', 'Ανακατεύω, μην βαριέστε', 'Ένα λεπτό, ανακατεύω', 'Έξι τράπουλες, ένα σαρμ', 'Ανακατεύω με αίσθημα', 'Κόψιμο. Νέα αρχή'],
      final: ['Ο τελευταίος όρθιος', 'Τέλος παιχνιδιού', 'Συγχαρητήρια στον νικητή', 'Τραπέζι κλειστό. Κρίμα', 'Ήταν υπέροχα', 'Υπέροχη βραδιά'],
      rescue: ['Σωθήκατε… προς το παρόν', 'Η τύχη αγαπά τους πεισματάρηδες', 'Παρά τρίχα', 'Καλώς γυρίσατε', 'Ανάσα; Νωρίς ακόμα', 'Ακόμα ζωντανοί'],
      hint: ['Κι άλλο ή στοπ;', 'Μη με αφήνετε να περιμένω', 'Σας περιμένω', 'Τα φύλλα περιμένουν', 'Ο χρόνος τρέχει', 'Αποφασίστε, σας παρακαλώ'],
      hit16: ['Στο 16; Τολμηρά', 'Ρισκάρετε; Μου αρέσει', 'Για δες, ενδιαφέρον', 'Όπως θέλετε', 'Γενναία', 'Τσιγκλάτε τα νεύρα'],
      solo: ['Με την ησυχία σας', 'Θα περιμένω', 'Καθίστε πιο κοντά', 'Έχουμε όλη τη νύχτα', 'Σκεφτείτε, δεν βιάζομαι', 'Ρισκάρουμε λοιπόν;']
    }
  };
  var lastPick = {};   // категория → последние выданные индексы (память до 4, но не больше длины банка − 1)
  function pick(lang, category, rnd) {
    var bank = (LINES[lang] || LINES.ru)[category] || LINES.ru[category] || [category];
    if (bank.length === 1) return bank[0];
    var mem = lastPick[category] || (lastPick[category] = []);
    var keep = Math.min(4, bank.length - 1);
    var free = [];
    for (var j = 0; j < bank.length; j++) if (mem.indexOf(j) < 0) free.push(j);
    var r = typeof rnd === 'function' ? rnd() : Math.random();
    var i = free[Math.floor(r * free.length)];
    mem.push(i); while (mem.length > keep) mem.shift();
    return bank[i];
  }

  window.BJMargot = { create: create, pick: pick, LINES: LINES, STATES: ['idle', 'dealing', 'suspense', 'smug', 'oops', 'congrats', 'peek', 'shuffle', 'sweep', 'think'] };
})();
