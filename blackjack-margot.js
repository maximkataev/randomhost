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
 *   m.emote(name, ms)    эмоция поверх состояния (слой m-e-*): grin winkgrin triumph laugh joy eyeroll sly dare pity gasp facepalm wow cold
 *                        tease lean drum shrug sigh + idle-мелочи bracelet hairtuck chiptoss; m.calm() снимает; список — BJMargot.EMOTES
 *   m.tick(now)          моргание и «жизнь» в покое (взгляд на игроков, браслет, прядь, фишка) — звать из rAF
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
  function hand(parent, wx, wy, a, s, pre) {
    pre = pre || 'm';
    var hg = mk('g', { 'class': pre + '-hand ' + pre + '-hand-' + (s < 0 ? 'r' : 'l') }, parent);
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
  function arm(parent, side, pre) {
    pre = pre || 'm';
    var s = side === 'r' ? -1 : 1;
    var sx = 220 + s * 66, sy = side === 'r' ? 230 : 222;
    var ex = 220 + s * 108, ey = 310;
    var wx = 220 + s * 124, wy = 394;
    var g = mk('g', { 'class': pre + '-arm ' + pre + '-arm-' + side }, parent);
    origin(g, sx, sy);
    seg(g, sx, sy, 26, ex, ey, 20, JACKET, SATIN_HI);
    var fg = mk('g', { 'class': pre + '-fore ' + pre + '-fore-' + side }, g);
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
    hand(fg, wx, wy, a, s, pre);
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
    // усиленный румянец: проявляется при азарте и смущении (на opacity)
    mk('ellipse', { 'class': 'm-blush2', cx: 188, cy: 141, rx: 17, ry: 10, fill: 'url(#bjm-blush)' }, pose);
    mk('ellipse', { 'class': 'm-blush2', cx: 252, cy: 141, rx: 17, ry: 10, fill: 'url(#bjm-blush)' }, pose);
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
      mk('path', { 'class': 'm-lidline', d: 'M' + xo + ' ' + yo + ' ' + botc, fill: 'none', stroke: INK, 'stroke-width': 1.8, 'stroke-linecap': 'round' }, lid);
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
      // «смеющийся» глаз: дуга-«крышка» с двумя ресничками, видна только в смехе и радости
      var arc = mk('g', { 'class': 'm-eyearc' }, g);
      mk('path', { d: 'M' + (xi - dir * .5) + ' ' + (yi + 1) + ' Q' + (x + dir * .5) + ' ' + (cy - 14) + ' ' + (xo + dir * .5) + ' ' + (yo + 2.5), fill: 'none', stroke: INK, 'stroke-width': 2.3, 'stroke-linecap': 'round' }, arc);
      mk('path', { d: 'M' + (xo - dir * 1) + ' ' + (yo + .5) + ' L' + (xo + dir * 6) + ' ' + (yo - 3.5) + ' M' + (xo - dir * 3.5) + ' ' + (yo - 3.2) + ' L' + (xo + dir * 3) + ' ' + (yo - 7.5), fill: 'none', stroke: INK, 'stroke-width': 1.2, 'stroke-linecap': 'round' }, arc);
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
    // новые формы рта: ухмылка с зубами, хохот, надутые губы, прикушенная губа, язык, сочувственный «подковой»
    lips('m-lips-grin', 'M203 152 C209 148 215 147 220 150 C226 147 233 146 239 148 C236 160 228 165 220 165 C212 165 206 161 203 152 Z', null, function (g) {
      mk('path', { d: 'M207.5 153 C214 155.6 227 154.4 236 150.6 C232 158 227 161.4 220 161.4 C214 161.4 210 158 207.5 153 Z', fill: '#fff' }, g);
      mk('path', { d: 'M213 157.4 Q220 159.6 227 157.2', fill: 'none', stroke: '#e8c7bd', 'stroke-width': .8 }, g);
    }).appendChild(mk('path', { d: 'M207 152.4 C214 155.6 227 154.2 236.6 150', fill: 'none', stroke: LIP_DK, 'stroke-width': .9, 'stroke-linecap': 'round' }));
    lips('m-lips-laugh', 'M200 148.5 C208 145 214 144.6 220 147.8 C226 144.6 232 145 240 148.5 C240 165 231 175 220 175 C209 175 200 165 200 148.5 Z', null, function (g) {
      mk('path', { d: 'M204.5 150.6 Q220 154.4 235.5 150.6 C235 162 228.5 170.6 220 170.6 C211.5 170.6 205 162 204.5 150.6 Z', fill: '#4a0a18' }, g);
      mk('path', { d: 'M205.4 151 Q220 155 234.6 151 L233.4 156.4 Q220 159.2 206.6 156.4 Z', fill: '#fff' }, g);
      mk('path', { d: 'M211 167 C213 162 227 162 229 167 C226 171 214 171 211 167 Z', fill: '#e0566b' }, g);
    });
    lips('m-lips-pout', 'M209.5 153.4 C212.5 148.6 217 148.8 220 151.6 C223 148.8 227.5 148.6 230.5 153.4 C228.4 160.6 224.4 162.6 220 162.6 C215.6 162.6 211.6 160.6 209.5 153.4 Z', 'M210 153.6 C214 155.4 226 155.4 230 153.6', function (g) {
      mk('ellipse', { cx: 220, cy: 158.6, rx: 3.6, ry: 1.1, fill: '#fff', opacity: .7 }, g);
    });
    lips('m-lips-bite', 'M204 153 C209 149.6 215 148.6 220 151.4 C225 148.6 231 149.6 236 153 C231 160.6 225 163 220 163 C215 163 209 160.6 204 153 Z', null, function (g) {
      mk('path', { d: 'M208.5 154.4 Q220 158.4 231.5 154.4 L230 158.8 Q220 161.4 210 158.8 Z', fill: '#fff' }, g);
      mk('path', { d: 'M209.5 158.4 Q220 163 230.5 158.4 Q220 166.6 209.5 158.4 Z', fill: '#d9142f' }, g);
      mk('path', { d: 'M205 153 C212 155.4 228 155.4 235 153', fill: 'none', stroke: LIP_DK, 'stroke-width': .9, 'stroke-linecap': 'round' }, g);
    });
    lips('m-lips-tongue', 'M203 151.6 C209 148 215 147.4 220 150.6 C226 147.4 232 148 237 151.6 C233 161.4 226 164 220 164 C214 164 207 161.4 203 151.6 Z', null, function (g) {
      mk('path', { d: 'M207 152.6 Q220 156.4 233 152.6 Q220 160.6 207 152.6 Z', fill: '#4a0a18' }, g);
      mk('path', { d: 'M211 154 Q220 156.8 229 154 L228 156 Q220 158.6 212 156 Z', fill: '#fff' }, g);
      mk('path', { d: 'M213.5 157.6 C214 168 232 170 232 159 C231 156.8 226 156.2 222 157.6 Z', fill: '#e8566e' }, g);
      mk('path', { d: 'M222.4 158.6 Q223 163 222.2 166', fill: 'none', stroke: '#b83a52', 'stroke-width': .9, 'stroke-linecap': 'round' }, g);
    });
    lips('m-lips-sad', 'M205.5 158 C210.5 150.6 216 150 220 152.2 C224 150 229.5 150.6 234.5 158 C229.5 155.4 224.4 155 220 155.2 C215.6 155 210.5 155.4 205.5 158 Z', 'M206 157.6 C212 154.6 228 154.6 234 157.6', function (g) {
      mk('path', { d: 'M211 156.6 C215 155.4 225 155.4 229 156.6 C227 161.4 223.6 162.2 220 162.2 C216.4 162.2 213 161.4 211 156.6 Z', fill: 'url(#bjm-lip)' }, g);
    });
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

    // накладная левая рука поверх головы: фейспалм, ладонь у рта, поправить прядь (своя копия руки, включается классом m-ov-on)
    var ov = mk('g', { 'class': 'mo-layer' }, root);
    arm(ov, 'l', 'mo');

    container.appendChild(svg);

    var bubble = document.createElement('div');
    bubble.className = 'bj-bubble';
    var btxt = document.createElement('span');
    bubble.appendChild(btxt);
    container.appendChild(bubble);

    return { svg: svg, bubble: bubble, btxt: btxt, pupils: svg.querySelectorAll('.m-pupil'), turns: svg.querySelectorAll('.m-head-turn') };
  }

  // ---------- эмоции: слой поверх состояний (класс m-e-<имя> на корне), состояния не трогает ----------
  // ms — сколько держится; then/thenMs — на что перетекает (двухактные реакции); prio: 3 — событие, 1 — мелочь в покое;
  // ov — нужна накладная рука поверх головы
  var EMOTES = {
    grin:     { ms: 1800, prio: 2 },                         // ухмылка с зубами
    winkgrin: { ms: 1500, prio: 2 },                         // победная ухмылка с подмигиванием
    triumph:  { ms: 2200, prio: 3 },                         // откинулась назад, подбородок вверх, подмигнула
    laugh:    { ms: 2200, prio: 4 },                         // хохот: плечи трясутся, глаза-«крышки»
    joy:      { ms: 1800, prio: 3 },                         // радость за другого: смеющиеся глаза, румянец
    eyeroll:  { ms: 1500, prio: 3 },                         // закатила глаза
    sly:      { ms: 1800, prio: 2 },                         // бровь + прищур, хитрый взгляд
    dare:     { ms: 1800, prio: 2 },                         // «боимся?»: надутые губы, брови домиком
    pity:     { ms: 1000, prio: 3, then: 'grin', thenMs: 1100 },   // «ох»: ладонь к груди, потом ухмылка
    gasp:     { ms: 1000, prio: 3, then: 'eyeroll', thenMs: 1400 },   // ахнула, ладонь к груди, потом глаза к небу
    facepalm: { ms: 1800, prio: 3, ov: 'face' },
    wow:      { ms: 1200, prio: 3, then: 'winkgrin', thenMs: 1400 },  // «вау»: брови вверх, хлопки, потом подмигнула
    cold:     { ms: 900, prio: 3, then: 'triumph', thenMs: 1500 },    // ледяной взгляд, затем торжество
    tease:    { ms: 1500, prio: 2 },                         // показывает язык, подмигивает
    lean:     { ms: 2200, prio: 3 },                         // наклон к камере: вызов на ва-банк
    drum:     { ms: 2400, prio: 2 },                         // нетерпеливо стучит ногтями
    shrug:    { ms: 1500, prio: 2 },                         // пожимает плечами
    sigh:     { ms: 1500, prio: 2, then: 'grin', thenMs: 900 },  // сочувственный вздох
    bracelet: { ms: 1900, prio: 1 },                         // idle: проверяет браслет
    hairtuck: { ms: 1900, prio: 1, ov: 'hair' },             // idle: поправляет прядь
    chiptoss: { ms: 1300, prio: 1 }                          // idle: подбрасывает фишку
  };
  var REDUCED = false;
  try { REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}

  function create(container, opts) {
    opts = opts || {};
    var p = build(container);
    var m = { state: 'idle', el: p.svg, _look: 0, emoting: null };
    var nextBlink = 0, blinkUntil = 0, sayTimer = null, browTimer = null, stateTimer = null, winkTimer = null;
    var emoTimer = null, emoStart = 0, emoUntil = 0, emoPrio = 0, glanceTimer = null, nextIdle = 0, idleN = 0, glanceN = 0;

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
    // эмоция: m.emote('laugh') / m.emote('facepalm', 1500). Слабая не перебивает сильную, пока та не отыграла.
    function clearEmote() {
      if (emoTimer) { clearTimeout(emoTimer); emoTimer = null; }
      if (m.emoting) p.svg.classList.remove('m-e-' + m.emoting);
      p.svg.classList.remove('m-em', 'm-ov-on', 'm-ov-face', 'm-ov-mouth', 'm-ov-hair');
      m.emoting = null; emoPrio = 0; emoUntil = 0;
    }
    m.emote = function (name, ms, force) {
      var d = EMOTES[name];
      if (!d) return m;
      var now = Date.now();
      // не перебивать: слабую — сильной; равную — пока та не прожила хотя бы 0,9 с (одна большая реакция на событие)
      if (m.emoting && now < emoUntil && !force && (d.prio < emoPrio || (d.prio === emoPrio && now - emoStart < 900))) return m;
      clearEmote();
      var dur = ms || d.ms;
      m.emoting = name; emoPrio = d.prio; emoUntil = now + dur; emoStart = now;
      p.svg.classList.add('m-em', 'm-e-' + name);
      if (d.ov) p.svg.classList.add('m-ov-on', 'm-ov-' + d.ov);
      // перезапуск анимаций эмоции при повторном вызове
      void p.svg.getBoundingClientRect();
      emoTimer = setTimeout(function () {
        var nx = d.then, nms = d.thenMs;
        clearEmote();
        if (nx) m.emote(nx, nms, true);
      }, dur);
      if (REDUCED) p.svg.classList.add('m-calm'); else p.svg.classList.remove('m-calm');
      return m;
    };
    m.calm = function () { clearEmote(); return m; };
    m.lookAt = function (x) {
      if (x === null || x === undefined) x = 0;
      x = Math.max(-1, Math.min(1, x));
      m._look = x;
      for (var i = 0; i < p.pupils.length; i++) p.pupils[i].style.setProperty('--look', 'translate(' + (x * 3.5) + 'px, 1px)');
      for (var j = 0; j < p.turns.length; j++) p.turns[j].style.transform = 'rotate(' + (x * 4) + 'deg)';
      return m;
    };
    // живой покой: раз в 3–5 с одно маленькое действие — взгляд на игроков по очереди, браслет, прядь, фишка, редкое подмигивание
    function idleLife(now) {
      if (REDUCED) return;
      if (!nextIdle) { nextIdle = now + 2500 + Math.random() * 2000; return; }
      if (now < nextIdle) return;
      nextIdle = now + 3200 + Math.random() * 2200;
      if (m.state !== 'idle' || (m.emoting && Date.now() < emoUntil) || p.svg.classList.contains('m-wink')) return;
      idleN++;
      var k = idleN % 6;
      if (k === 1 || k === 3 || k === 5) {
        var seq = [-1, -.35, .5, 1, .1, -.7];
        var gx = seq[glanceN++ % seq.length];
        for (var i = 0; i < p.pupils.length; i++) p.pupils[i].style.setProperty('--gl', (gx * 3.2) + 'px');
        if (glanceTimer) clearTimeout(glanceTimer);
        glanceTimer = setTimeout(function () { for (var j = 0; j < p.pupils.length; j++) p.pupils[j].style.setProperty('--gl', '0px'); }, 1500);
      } else if (k === 2) m.emote('bracelet');
      else if (k === 4) m.emote(idleN % 12 === 4 ? 'hairtuck' : 'chiptoss');
      else if (Math.random() < .5) m.wink(800);
      else m.emote('hairtuck');
    }
    m.tick = function (now) {
      idleLife(now);
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
    m.destroy = function () { clearEmote(); if (glanceTimer) clearTimeout(glanceTimer); if (p.svg.parentNode) p.svg.parentNode.removeChild(p.svg); if (p.bubble.parentNode) p.bubble.parentNode.removeChild(p.bubble); };
    return m;
  }

  // ---------- банк реплик: 2–8 слов, голос хозяйки VIP-зала — сухая острота про ситуацию, решение, удачу и жадность, не про человека ----------
  var LINES = {
    ru: {
      hello: ['Садитесь. Я почти не кусаюсь', 'Добрый вечер. Кошельки к бою', 'Люблю смелых. И их фишки', 'Вечер только начинается', 'Фишки на сукно, прошу', 'Ну что, рискнём?', 'Добро пожаловать в VIP. Без эго', 'Везёт смелым. Мне — чаще'],
      bets: ['Ставки сделаны. Пути назад нет', 'Красиво поставлено', 'Закрываю. Передумывать поздно', 'Руки от фишек, господа', 'Смело. Посмотрим, надолго ли', 'Ставки приняты. Нервы — тоже', 'Всё, торг окончен', 'Решились. Уважаю'],
      deal: ['Раздаю. Не моргайте', 'Карты пошли. Нервы — следом', 'Посмотрим, что вам выпало', 'Две каждому. Я не жадная', 'Сдаю с улыбкой. Острой', 'Удача, будь добра', 'Не подглядывать. Себе дороже', 'Лёгкая рука, тяжёлые карты'],
      playerBj: ['Блэкджек! Вот это вкус', 'Двадцать одно с двух карт. Наглость', 'Красиво. Почти обидно', 'Вам везёт — мне платить', 'Три к двум. Забирайте, пока дают', 'Это называется «с места в карьер»', 'Блэкджек. Не буду делать вид, что рада', 'Ох. Вот теперь я впечатлена'],
      playerBust: ['Жадность — не порок. Пока не раздаю я', 'Красиво проиграно', 'Храбрость города берёт. Фишки — нет', 'Одна лишняя — и всё', 'Ой-ой. Бывает и с лучшими', 'Так близко. И так мимо', 'Карта знала меру. Вы — нет', 'Аппетит больше колоды'],
      multiBust: ['Перебор — теперь коллективный', 'Стол перебрал. Я ни при чём', 'Ну вы даёте. Все разом', 'Это что, забастовка?', 'Жадность заразна. Вижу', 'Перебор — командный вид спорта'],
      insurance: ['Туз. Боимся? Страхуйтесь', 'Страховка — для умеющих бояться', 'Два к одному. Я бы подумала', 'Туз у меня. Нервы у вас', 'Бояться не стыдно. Платить — да', 'Смелым страховка не нужна. Говорят', 'Страховка: цена спокойного сна', 'Один туз — и столько сомнений'],
      peek: ['Загляну украдкой', 'Тсс… один взгляд', 'Минутку. Проверю, не блефую ли', 'Любопытно. Не дышите', 'Что там? Сама заинтригована', 'Заглянем под карту. Без паники'],
      dealerDraw: ['Беру ещё. Правила есть правила', 'Теперь моя очередь', 'До семнадцати. Закон, не каприз', 'Посмотрим, что мне', 'Мне тоже придётся рискнуть', 'Нервничаете? Я тоже. Немного'],
      dealerBust: ['Ох. Перебрала. Какая досада… нет', 'Сегодня ваш вечер. Наслаждайтесь', 'Казино платит. Казино страдает', 'Ну вот. Теперь все счастливы', 'Признаю: вышло некрасиво', 'Перебор у дилера. Запишите дату', 'Мне не жаль. Совсем. Ну почти', 'Бывает и у лучших. У меня — редко'],
      dealer21: ['Двадцать одно. Ничего личного', 'Простите. Нет, не прошу', 'Казино благодарит за щедрость', 'Так вышло. Мне понравилось', 'Не дуйтесь. Дом есть дом', 'Двадцать одно. Совпадение? Вряд ли', 'Красивая карта. Моя', 'Удача сегодня на моей стороне'],
      dealerWin: ['Стол забирает. С любовью', 'Не сегодня, господа', 'В другой раз повезёт. Может', 'Фишки возвращаются домой', 'Красиво проиграно. Я оценила', 'Дом не всегда выигрывает. Сейчас — да', 'Спасибо за щедрость', 'Хорошая попытка. Правда'],
      allin: ['Ва-банк? Дыхание перехватило', 'Всё сразу? Люблю характер', 'Либо пан, либо пропал', 'Красивый жест. Посмотрим на конец', 'Вот это азарт. Или отчаяние?', 'Одна ставка — вся судьба', 'Сильно. Очень сильно', 'Я бы поволновалась. Но я дилер'],
      jackpot: ['Джекпот! Зал замер', 'Вот это куш. Хочу такой же', 'Банк сорван. Я в шоке', 'Стол аплодирует стоя', 'Ох, какая красота', 'Ну вы даёте. Казино плачет', 'Запомните этот вечер', 'Сорвали банк. И мои нервы'],
      level: ['Ставки растут. Нервы — тоже', 'Играем по-крупному', 'Планка выше. Отсидеться не выйдет', 'Дороже — значит интереснее', 'Становится жарко', 'Пора платить дороже', 'Минимум вырос. Аппетиты тоже?', 'Слабонервным — к автомату'],
      out: ['Красиво держались', 'Фишки кончились, достоинство нет', 'Стол будет скучать. Я — чуть-чуть', 'Заходите ещё. Я дождусь', 'Жаль. Правда. Почти', 'Было приятно. Мне — особенно', 'Фишек нет — есть истории', 'Красивый уход. Бывает хуже'],
      shuffle: ['Тасую. Не скучайте', 'Новый шуз, свежие карты', 'Шесть колод, один шарм', 'Тасую с чувством. С расстановкой', 'Минутку. Перемешаю вашу удачу', 'Отсечка. Картам — новая жизнь', 'Тасую. Привет, счётчикам'],
      final: ['Последний за столом. Респект', 'Победитель есть. Остальные — героически', 'Игра окончена. Победителю — уважение', 'Поздравляю. Заслуженно', 'Стол закрыт. Было красиво', 'Остался один. Как в кино', 'Вечер принадлежит вам', 'Один выстоял. Остальные пытались'],
      rescue: ['Спасены… пока', 'Удача любит упрямых', 'На волоске. Мне нравится', 'С возвращением с того света', 'Выдохнули? Рано, но приятно', 'Ещё поживём. И поиграем', 'Последняя фишка — самая везучая', 'Воскресли. Красиво'],
      hint: ['Ну так что? Время тикает', 'Решайтесь, я не вечная', 'Карты ждут. Я — не очень', 'Жду решений. Стучу ногтями', 'Не томите. Я и так томная', 'Тик-так. Это нервы, не часы', 'Ещё или хватит? Это не экзамен', 'Фишки сами не поставятся'],
      drum: ['Тик-так. Я ещё здесь', 'Решайтесь, ногти устали', 'Мы уже состарились. Ну?', 'Я могу и до утра. Но не буду', 'Время — деньги. Ваши', 'Ногти стучат. Нервы тоже'],
      hit16: ['На шестнадцати? Смело. Очень', 'Я бы взяла… если б хотела проиграть', 'Ну-ну. Интересный выбор', 'Отважно. Или отчаянно', 'Нервы — тоже капитал', 'Как скажете. Я не осуждаю', 'Любите щекотать нервы. Мои'],
      hit20: ['На двадцати? Серьёзно?', 'Берёте ещё? Вау', 'Это смелость или арифметика?', 'Я молчу. Громко', 'Туз — ваш единственный друг', 'Берёте на двадцати? Сильно'],
      push: ['Ничья. Ни вам, ни мне', 'Пуш. Скучно… приятно', 'Поровну. Редкая справедливость', 'Ничья — вежливый проигрыш', 'Каждому своё. То есть ничего', 'Равенство. Как в утопии'],
      trick: ['Хитро. Я бы не заметила', 'Пакость в игре. Обожаю', 'Ох уж эти ваши карты…', 'Ловко. И чуточку подло', 'Играем грязно? Мне нравится', 'Интрига, господа. Интрига'],
      soloEnd: ['Фишек нет. Достоинство есть', 'Дом вас запомнит', 'Заходите отыграться. Я никуда', 'Хорошая игра. Плохая удача', 'Казино благодарит. Искренне', 'Реванш? Я всегда здесь'],
      solo: ['Не торопитесь. Я подожду', 'Думайте. Я не спешу', 'Сядьте поближе. Не кусаюсь', 'Времени у нас много', 'Ну что, рискнём?', 'Я подожду. Профессионально']
    },
    en: {
      hello: ['Sit closer. I rarely bite', 'Good evening. Wallets ready', 'I love the bold. And their chips', 'The night is young', 'Chips on the felt, please', 'Shall we gamble? Rhetorical', 'Welcome to VIP. Mind the ego', 'Fortune favors the brave. Me, mostly'],
      bets: ['Bets are in. No take-backs', 'Nicely placed', 'Closing. Too late for doubts', 'Hands off the chips', 'Bold. Let us see how long', 'Bets in. Nerves too', 'No more haggling', 'Decisive. I respect it'],
      deal: ["Dealing. Don't blink", 'Cards are out. So are nerves', "Let's see what you're holding", 'Two each. I am generous', 'Dealing with a smile. A sharp one', 'Lady Luck, behave', 'No peeking. For your own good', 'Light hand, heavy cards'],
      playerBj: ['Blackjack! Show-off', 'Twenty-one on two cards. Cheeky', 'Lovely. Almost offensive', 'You win, I pay. Charming', 'Three to two. Take it while it lasts', 'Straight to the point. I like it', 'Blackjack. I will not pretend to be thrilled', 'Oh. Now I am impressed'],
      playerBust: ["Greed isn't a sin. Not at my table", 'Beautifully lost', 'Courage takes cities. Not chips', 'One card too many', 'Oh dear. It happens to the best', 'So close. So wrong', 'The card knew moderation. You did not', 'Appetite bigger than the deck'],
      multiBust: ['A bust? Now a group effort', 'The whole table overshot', 'Is this a strike?', 'Greed is contagious, I see', 'Busting is a team sport', 'Well, you all went for it'],
      insurance: ['An ace. Scared? Insure it', 'Insurance is for those who fear well', 'Two to one. I would think twice', 'My ace, your nerves', "Fear is free. Insurance isn't", 'The brave skip it. Allegedly', 'Insurance: the price of sleeping well', 'One ace. So many doubts'],
      peek: ['A little peek', 'Shh… one glance', 'One second. Checking my bluff', 'Curious? Do not breathe', 'What is under there? I wonder too', 'A peek. No panic'],
      dealerDraw: ['One more for me. Rules are rules', 'My turn now', 'Up to seventeen. Law, not whim', "Let's see what I get", 'I have to risk it too', 'Nervous? Me too. A little'],
      dealerBust: ['Oh. I busted. Such a shame… not', 'Tonight is yours. Enjoy', 'The house pays. The house weeps', 'Well. Everyone is happy now', 'I admit: not my finest hand', 'Dealer bust. Mark the date', 'I do not mind. Almost', 'Even I slip. Rarely'],
      dealer21: ['Twenty-one. Nothing personal', 'Sorry. No, I am not', 'The house thanks you for your generosity', 'It just happened. I liked it', "Don't pout. The house is the house", 'Twenty-one. Coincidence? Hardly', 'Pretty card. Mine', 'Luck is on my side tonight'],
      dealerWin: ['The house takes it. Lovingly', 'Not tonight, friends', 'Next time. Maybe', 'Chips come home', 'Nicely lost. I noticed', 'The house loses sometimes. Not now', 'Thanks for your generosity', 'Good try. Truly'],
      allin: ['All in? Breathtaking', 'Everything at once? I like character', 'Do or die, then', 'Lovely gesture. Let us see the ending', 'Bold. Or desperate?', 'One bet, one fate', 'Strong. Very strong', 'I would worry. But I am the dealer'],
      jackpot: ['Jackpot! The room froze', 'What a haul. I want one too', 'Bank broken. I am shocked', 'The table is on its feet', 'Oh, gorgeous', 'Well played. The casino weeps', 'Remember this night', 'You broke the bank. And my nerves'],
      level: ['Stakes rising. So are nerves', 'Playing for big', 'Higher bar. No hiding', 'Pricier means better', 'Getting hot in here', 'Time to pay more', 'Higher minimum. Higher appetite?', 'Faint-hearted: slot machines, that way'],
      out: ['You held on beautifully', 'Out of chips. Not out of dignity', 'The table will miss you. I might', 'Do come back. I will wait', 'A pity. Honestly. Almost', 'It was a pleasure. Mostly mine', 'No chips, plenty of stories', 'Beautiful exit. They get worse'],
      shuffle: ['Shuffling. Do not be bored', 'New shoe, fresh cards', 'Six decks, one charm', 'Shuffling with feeling', 'One moment. Mixing your luck', 'Cut card. Fresh lives for the cards', 'Shuffling. Counters, hello'],
      final: ['Last one standing. Respect', 'We have a winner. The rest: heroic', 'Game over. Winner, my respect', 'Congratulations. Well deserved', 'Table closed. It was good', 'Only one left. Like a movie', 'The night is yours', 'One stood. The others tried'],
      rescue: ['Saved… for now', 'Luck loves the stubborn', 'By a thread. I like it', 'Back from the dead', 'Breathe out? Early, but lovely', 'Still alive. Still playing', 'The last chip is the luckiest', 'Resurrected. Nicely done'],
      hint: ['Well? The clock is ticking', 'Decide. I am not eternal', 'Cards wait. I do not', 'Waiting. Drumming my nails', "Don't keep me. I'm already languid", 'Tick-tock. Nerves, not a clock', 'Hit or stand? It is not an exam', 'Chips will not place themselves'],
      drum: ['Tick-tock. Still here', 'Decide. My nails are tired', 'We have aged. Well?', 'I could wait all night. I won\'t', 'Time is money. Yours', 'Nails tapping. Nerves too'],
      hit16: ['On sixteen? Bold. Very', 'I would hit too… if I wanted to lose', 'Well. Interesting choice', 'Brave. Or desperate', 'Nerves are capital too', 'As you wish. I do not judge', 'You like tickling nerves. Mine'],
      hit20: ['On twenty? Seriously?', 'Hitting again? Wow', 'Courage or arithmetic?', 'I say nothing. Loudly', 'An ace is your only friend', 'Hitting twenty: bold statement'],
      push: ['A push. Neither you nor me', 'Level. Boringly pleasant', 'Even. A rare kind of justice', 'A tie is a polite loss', 'To each their own. That is, nothing', 'Equality. Like utopia'],
      trick: ['Sneaky. I would not have noticed', 'Foul play. I adore it', 'Oh, those cards of yours…', 'Smooth. And slightly mean', 'Playing dirty? I like it', 'Intrigue, ladies and gentlemen'],
      soloEnd: ['Out of chips. Dignity intact', 'The house will remember you', 'Come back and win it back', 'Good game. Bad luck', 'The casino thanks you. Sincerely', 'Rematch? I am always here'],
      solo: ['No rush. I will wait', 'Think. I am in no hurry', 'Sit closer. I do not bite', 'We have all night', 'Shall we gamble?', 'I will wait. Professionally']
    },
    el: {
      hello: ['Καθίστε πιο κοντά. Δεν δαγκώνω', 'Καλησπέρα. Έτοιμα τα πορτοφόλια;', 'Λατρεύω τους τολμηρούς. Και τις μάρκες τους', 'Η βραδιά μόλις αρχίζει', 'Μάρκες στο τραπέζι, παρακαλώ', 'Ρισκάρουμε λοιπόν; Ρητορικό', 'Καλώς ήρθατε στο VIP. Χωρίς εγώ', 'Η τύχη ευνοεί τους τολμηρούς. Εμένα, κυρίως'],
      bets: ['Τα στοιχήματα μπήκαν. Χωρίς επιστροφή', 'Ωραίο στοίχημα', 'Κλείνω. Αργά για δεύτερες σκέψεις', 'Χέρια μακριά από τις μάρκες', 'Τολμηρό. Να δούμε πόσο θα κρατήσει', 'Τα στοιχήματα μπήκαν. Και τα νεύρα', 'Τέρμα το παζάρι', 'Αποφασιστικά. Σέβομαι'],
      deal: ['Μοιράζω. Μην ανοιγοκλείνετε', 'Τα φύλλα βγήκαν. Και τα νεύρα', 'Για να δούμε τι κρατάτε', 'Δύο στον καθένα. Είμαι γενναιόδωρη', 'Μοιράζω με χαμόγελο. Κοφτερό', 'Τύχη, φέρσου καλά', 'Όχι κρυφοκοίταγμα. Για το καλό σας', 'Ελαφρύ χέρι, βαριά φύλλα'],
      playerBj: ['Μπλακτζάκ! Επιδειξιομανία', 'Είκοσι ένα με δύο φύλλα. Θράσος', 'Ωραίο. Σχεδόν προσβλητικό', 'Κερδίζετε εσείς, πληρώνω εγώ. Χαριτωμένο', 'Τρία προς δύο. Πάρτε το όσο προλαβαίνετε', 'Κατευθείαν στο ψητό. Μου αρέσει', 'Μπλακτζάκ. Δεν θα προσποιηθώ ενθουσιασμό', 'Ω. Τώρα εντυπωσιάστηκα'],
      playerBust: ['Η απληστία δεν είναι αμαρτία. Όχι εδώ', 'Όμορφη ήττα', 'Το θάρρος παίρνει πόλεις. Όχι μάρκες', 'Ένα φύλλο παραπάνω', 'Ωχ. Συμβαίνει και στους καλύτερους', 'Τόσο κοντά. Τόσο μακριά', 'Το φύλλο ήξερε από μέτρο. Εσείς όχι', 'Όρεξη μεγαλύτερη από την τράπουλα'],
      multiBust: ['Ομαδική υπέρβαση, βλέπω', 'Όλο το τραπέζι το παράκανε', 'Απεργία είναι αυτό;', 'Η απληστία κολλάει', 'Το κάψιμο είναι ομαδικό σπορ', 'Εντάξει, πήγατε όλοι μαζί'],
      insurance: ['Άσος. Φοβάστε; Ασφαλιστείτε', 'Ασφάλεια για όσους φοβούνται σωστά', 'Δύο προς ένα. Εγώ θα το σκεφτόμουν', 'Δικός μου ο άσος, δικά σας τα νεύρα', 'Ο φόβος είναι δωρεάν. Η ασφάλεια όχι', 'Οι τολμηροί την προσπερνούν. Λέει', 'Ασφάλεια: το τίμημα του καλού ύπνου', 'Ένας άσος. Τόσες αμφιβολίες'],
      peek: ['Μια κρυφή ματιά', 'Ψιτ… μία ματιά', 'Μια στιγμή. Ελέγχω το μπλόφα μου', 'Περίεργοι; Μην αναπνέετε', 'Τι κρύβεται εκεί; Αναρωτιέμαι κι εγώ', 'Μια ματιά. Χωρίς πανικό'],
      dealerDraw: ['Άλλο ένα για μένα. Κανόνες', 'Η σειρά μου', 'Μέχρι το 17. Νόμος, όχι καπρίτσιο', 'Για να δούμε τι θα μου τύχει', 'Πρέπει να ρισκάρω κι εγώ', 'Αγχωμένοι; Κι εγώ. Λίγο'],
      dealerBust: ['Ωχ. Κάηκα. Τι κρίμα… όχι', 'Η βραδιά είναι δική σας. Απολαύστε', 'Το καζίνο πληρώνει. Και κλαίει', 'Λοιπόν, τώρα είναι όλοι χαρούμενοι', 'Ομολογώ: όχι το καλύτερό μου φύλλο', 'Κάηκε η ντίλερ. Σημειώστε την ημερομηνία', 'Δεν με πειράζει. Σχεδόν', 'Γλιστράω κι εγώ. Σπάνια'],
      dealer21: ['Είκοσι ένα. Τίποτα προσωπικό', 'Συγγνώμη. Όχι, δεν ζητάω', 'Το καζίνο ευχαριστεί για τη γενναιοδωρία', 'Έτσι ήρθε. Μου άρεσε', 'Μη μουτρώνετε. Το σπίτι είναι σπίτι', 'Είκοσι ένα. Σύμπτωση; Δύσκολο', 'Όμορφο φύλλο. Δικό μου', 'Η τύχη απόψε είναι με το μέρος μου'],
      dealerWin: ['Το τραπέζι παίρνει. Με αγάπη', 'Όχι απόψε, φίλοι', 'Την άλλη φορά. Ίσως', 'Οι μάρκες γυρνούν σπίτι', 'Όμορφη ήττα. Το πρόσεξα', 'Το σπίτι δεν κερδίζει πάντα. Τώρα ναι', 'Ευχαριστώ για τη γενναιοδωρία', 'Καλή προσπάθεια. Αλήθεια'],
      allin: ['Όλα μέσα; Κόβεται η ανάσα', 'Όλα μαζί; Μου αρέσει ο χαρακτήρας', 'Ή όλα ή τίποτα, λοιπόν', 'Ωραία κίνηση. Για να δούμε το τέλος', 'Τολμηρό. Ή απελπισμένο;', 'Ένα στοίχημα, μία μοίρα', 'Δυνατό. Πολύ δυνατό', 'Εγώ θα αγχωνόμουν. Μα είμαι η ντίλερ'],
      jackpot: ['Τζάκποτ! Πάγωσε η αίθουσα', 'Τι κέρδος. Θέλω κι εγώ ένα', 'Έσπασε η μπάνκα. Σοκ', 'Το τραπέζι σηκώθηκε όρθιο', 'Ω, υπέροχο', 'Μπράβο. Το καζίνο κλαίει', 'Θυμηθείτε αυτή τη βραδιά', 'Σπάσατε την μπάνκα. Και τα νεύρα μου'],
      level: ['Τα στοιχήματα ανεβαίνουν. Και τα νεύρα', 'Παίζουμε μεγάλα', 'Ψηλότερη μπάρα. Δεν κρυβόμαστε', 'Ακριβότερα, πιο ενδιαφέρον', 'Ζεσταίνεται η ατμόσφαιρα', 'Ώρα να πληρώσουμε περισσότερο', 'Ψηλότερο ελάχιστο. Και όρεξη;', 'Οι διστακτικοί: στο φρουτάκι, παρακαλώ'],
      out: ['Αντέξατε όμορφα', 'Τέλος οι μάρκες. Όχι η αξιοπρέπεια', 'Θα λείψετε στο τραπέζι. Ίσως κι εμένα', 'Ελάτε ξανά. Θα περιμένω', 'Κρίμα. Ειλικρινά. Σχεδόν', 'Χάρηκα. Ιδιαίτερα εγώ', 'Μάρκες δεν έμειναν, ιστορίες ναι', 'Όμορφη έξοδος. Υπάρχουν και χειρότερες'],
      shuffle: ['Ανακατεύω. Μην βαριέστε', 'Νέα τράπουλα, φρέσκα φύλλα', 'Έξι τράπουλες, ένα σαρμ', 'Ανακατεύω με αίσθημα', 'Μια στιγμή. Ανακατεύω την τύχη σας', 'Κόψιμο. Τα φύλλα ξαναγεννιούνται', 'Ανακατεύω. Χαιρετώ τους μετρητές'],
      final: ['Ο τελευταίος όρθιος. Σεβασμός', 'Έχουμε νικητή. Οι υπόλοιποι: ηρωικά', 'Τέλος. Στον νικητή, σεβασμός', 'Συγχαρητήρια. Δίκαια', 'Το τραπέζι κλείνει. Ήταν ωραία', 'Έμεινε ένας. Σαν σε ταινία', 'Η βραδιά είναι δική σας', 'Ένας άντεξε. Οι άλλοι προσπάθησαν'],
      rescue: ['Σωθήκατε… προς το παρόν', 'Η τύχη αγαπά τους πεισματάρηδες', 'Παρά τρίχα. Μου αρέσει', 'Από τον άλλο κόσμο', 'Ανάσα; Νωρίς, αλλά ωραία', 'Ακόμα ζωντανοί. Ακόμα παίζουμε', 'Η τελευταία μάρκα είναι η πιο τυχερή', 'Αναστηθήκατε. Μπράβο'],
      hint: ['Λοιπόν; Ο χρόνος τρέχει', 'Αποφασίστε. Δεν είμαι αιώνια', 'Τα φύλλα περιμένουν. Εγώ όχι', 'Περιμένω. Χτυπάω τα νύχια', 'Μη με αφήνετε. Ήδη μαραζώνω', 'Τικ-τακ. Νεύρα είναι, όχι ρολόι', 'Κι άλλο ή στοπ; Δεν είναι εξέταση', 'Οι μάρκες δεν μπαίνουν μόνες τους'],
      drum: ['Τικ-τακ. Ακόμα εδώ είμαι', 'Αποφασίστε. Κουράστηκαν τα νύχια', 'Γεράσαμε. Λοιπόν;', 'Μπορώ να περιμένω όλη νύχτα. Δεν θα', 'Ο χρόνος είναι χρήμα. Δικό σας', 'Τα νύχια χτυπούν. Και τα νεύρα'],
      hit16: ['Στο 16; Τολμηρό. Πολύ', 'Κι εγώ θα έπαιρνα… αν ήθελα να χάσω', 'Για δες. Ενδιαφέρουσα επιλογή', 'Γενναίο. Ή απελπισμένο', 'Και τα νεύρα κεφάλαιο είναι', 'Όπως θέλετε. Δεν κρίνω', 'Τσιγκλάτε τα νεύρα. Τα δικά μου'],
      hit20: ['Στο 20; Σοβαρά;', 'Παίρνετε κι άλλο; Ουάου', 'Θάρρος ή αριθμητική;', 'Δεν λέω τίποτα. Δυνατά', 'Ο άσος είναι ο μόνος σας φίλος', 'Φύλλο στο 20: ισχυρή δήλωση'],
      push: ['Ισοπαλία. Ούτε εσείς ούτε εγώ', 'Στα ίσια. Βαρετά ευχάριστο', 'Ίσα-ίσα. Σπάνιο είδος δικαιοσύνης', 'Η ισοπαλία είναι ευγενική ήττα', 'Στον καθένα το δικό του. Δηλαδή τίποτα', 'Ισότητα. Σαν ουτοπία'],
      trick: ['Πονηρό. Δεν θα το πρόσεχα', 'Βρόμικο παιχνίδι. Το λατρεύω', 'Αχ, αυτά τα φύλλα σας…', 'Έξυπνο. Και λίγο κακό', 'Παίζουμε βρόμικα; Μου αρέσει', 'Ίντριγκα, κυρίες και κύριοι'],
      soloEnd: ['Τέλος οι μάρκες. Η αξιοπρέπεια μένει', 'Το σπίτι θα σας θυμάται', 'Ελάτε να τα πάρετε πίσω', 'Καλό παιχνίδι. Κακή τύχη', 'Το καζίνο ευχαριστεί. Ειλικρινά', 'Ρεβάνς; Είμαι πάντα εδώ'],
      solo: ['Χωρίς βιασύνη. Θα περιμένω', 'Σκεφτείτε. Δεν βιάζομαι', 'Καθίστε πιο κοντά. Δεν δαγκώνω', 'Έχουμε όλη τη νύχτα', 'Ρισκάρουμε λοιπόν;', 'Θα περιμένω. Επαγγελματικά']
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

  window.BJMargot = { create: create, pick: pick, LINES: LINES, EMOTES: Object.keys(EMOTES), STATES: ['idle', 'dealing', 'suspense', 'smug', 'oops', 'congrats', 'peek', 'shuffle', 'sweep', 'think'] };
})();
