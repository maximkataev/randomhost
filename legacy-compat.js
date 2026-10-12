/*
 * Совместимость со старыми движками на ТВ и проекторах.
 *
 * Общие экраны игр часто открывают в браузере Android-проектора: там встроенный Chromium 7x–8x,
 * который не обновляется. Самая заметная дыра — нет `gap` у флекс-контейнеров (Chrome 84+):
 * теги на главной слипались, чекбоксы «Последнего вопроса» налезали на подписи, кнопки
 * режимов «Бомбы» стояли вплотную. Переписывать вёрстку на поля ради одного проектора
 * не хочется, поэтому здесь — полифил: в старом движке отступы между детьми флекс-контейнера
 * выставляются полями (margin) инлайном и пересчитываются при перестройке DOM.
 *
 * В браузере с поддержкой flex gap файл ничего не делает (одна проверка при загрузке).
 * Остальные пробелы старых движков закрыты в самой вёрстке: inset расписан на top/right/bottom/left,
 * у subgrid и :where() есть запасной вариант.
 *
 * Подключение: <script src="legacy-compat.js"></script> в <head> общей доски или главной.
 */
(function () {
  'use strict';

  // ParentNode.replaceChildren — Chrome 86+. Доски зовут его для мест игроков, подсказок и QR:
  // без него в старом движке первая же перерисовка падает с TypeError, и доска остаётся пустой.
  if (!Element.prototype.replaceChildren) {
    var replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.append.apply(this, arguments);
    };
    [Element, Document, DocumentFragment].forEach(function (C) {
      if (C && !C.prototype.replaceChildren) C.prototype.replaceChildren = replaceChildren;
    });
  }

  function supportsFlexGap() {
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden;pointer-events:none';
    d.appendChild(document.createElement('div'));
    d.appendChild(document.createElement('div'));
    document.documentElement.appendChild(d);
    var ok = d.scrollHeight === 1;
    d.parentNode.removeChild(d);
    return ok;
  }

  var MINE = '__fgMargins'; // поля, которые выставил полифил: { marginLeft: '8px', … }
  var OWNER = '__fgOwner';  // контейнер, детям которого полифил выставлял поля
  var SIDES = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'];
  var CSS_SIDES = { marginTop: 'margin-top', marginRight: 'margin-right', marginBottom: 'margin-bottom', marginLeft: 'margin-left' };

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // выставить ребёнку нужные поля; свои старые — убрать; чужие (из CSS или инлайн от страницы) — не трогать
  function apply(el, want) {
    var had = el[MINE] || {};
    var now = {};
    for (var i = 0; i < SIDES.length; i++) {
      var p = SIDES[i];
      var ours = had[p] !== undefined && el.style[p] === had[p];
      if (want[p] === undefined) {
        if (ours) el.style[p] = '';
        continue;
      }
      if (!ours) {
        if (el.style[p]) continue; // поле задала сама страница
        if (num(getComputedStyle(el).getPropertyValue(CSS_SIDES[p])) !== 0) continue; // поле из CSS (в т.ч. auto)
      }
      el.style[p] = want[p];
      now[p] = want[p];
    }
    el[MINE] = now;
  }

  function clearKids(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c[MINE]) apply(c, {});
    el[OWNER] = false;
  }

  function fixOne(el) {
    if (el.nodeType !== 1) return;
    var cs = getComputedStyle(el);
    var flex = cs.display === 'flex' || cs.display === 'inline-flex';
    var cg = flex ? num(cs.columnGap) : 0, rg = flex ? num(cs.rowGap) : 0;
    if (!cg && !rg) { if (el[OWNER]) clearKids(el); return; }
    var dir = cs.flexDirection, row = dir.indexOf('row') === 0, rev = dir.indexOf('reverse') > 0;
    var wrap = cs.flexWrap !== 'nowrap';
    var kids = [];
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      var ks = getComputedStyle(c);
      if (ks.display === 'none' || ks.position === 'absolute' || ks.position === 'fixed') { if (c[MINE]) apply(c, {}); continue; }
      kids.push(c);
    }
    // без переноса: отступ перед каждым ребёнком, кроме первого.
    // с переносом: после каждого, кроме последнего (иначе начало второй строки съезжает на зазор), и снизу/справа по поперечной оси
    var mainBefore = row ? (rev ? 'marginRight' : 'marginLeft') : (rev ? 'marginBottom' : 'marginTop');
    var mainAfter = row ? (rev ? 'marginLeft' : 'marginRight') : (rev ? 'marginTop' : 'marginBottom');
    var mainGap = row ? cg : rg, crossGap = row ? rg : cg;
    var crossSide = row ? 'marginBottom' : 'marginRight';
    for (var k = 0; k < kids.length; k++) {
      var w = {};
      if (mainGap) {
        if (!wrap && k > 0) w[mainBefore] = mainGap + 'px';
        if (wrap && k < kids.length - 1) w[mainAfter] = mainGap + 'px';
      }
      if (wrap && crossGap && kids.length > 1) w[crossSide] = crossGap + 'px';
      apply(kids[k], w);
    }
    el[OWNER] = true;
  }

  function fixTree(root) {
    if (!root || root.nodeType !== 1) return;
    fixOne(root);
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) fixOne(all[i]);
  }

  function start() {
    if (!window.__legacyCompatForce && supportsFlexGap()) return; // __legacyCompatForce — для проверки в эмуляции старого движка
    document.documentElement.className += ' no-fgap';
    fixTree(document.body);

    var roots = [], timer = 0, lastFull = 0, fullTimer = 0;
    function queue(el) { if (el && el.nodeType === 1 && roots.indexOf(el) < 0) roots.push(el); }
    function flush() {
      timer = 0;
      var list = roots; roots = [];
      for (var i = 0; i < list.length; i++) if (document.documentElement.contains(list[i])) fixTree(list[i]);
    }
    function later() { if (!timer) timer = setTimeout(flush, 80); }
    // классы на body доски переключаются по ходу игры: полный проход не чаще раза в секунду (ТВ слабые)
    function full() {
      if (fullTimer) return;
      fullTimer = setTimeout(function () { fullTimer = 0; lastFull = Date.now(); fixTree(document.body); }, Math.max(80, 1000 - (Date.now() - lastFull)));
    }

    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'childList') queue(r.target);
        else if (r.target === document.body) full();
        else { queue(r.target); if (r.target.parentNode) queue(r.target.parentNode); }
      }
      later();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });

    // медиазапросы меняют направление и зазоры — после ресайза пересчитываем всё
    var rz = 0;
    window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { fixTree(document.body); }, 150); });
    // веб-шрифты и картинки догружаются позже — ещё один проход после load
    window.addEventListener('load', function () { fixTree(document.body); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
