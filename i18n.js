/*
 * Lightweight client-side i18n + language switcher.
 * No build step, no dependencies. Works on static HTML served by nginx.
 *
 * How a page uses it:
 *   1. Define translations BEFORE loading this script:
 *        <script>window.I18N_DICT = { ru:{...}, en:{...}, el:{...} };</script>
 *      Keys map to either:
 *        - DOM nodes via [data-i18n="key"]            -> sets innerHTML
 *        - attributes via [data-i18n-attr="placeholder:key;title:key2"]
 *        - the document title via the special key "_title"
 *        - any meta description via [data-i18n-meta] on a <meta> tag
 *      Values may be strings, arrays or objects (used by page JS for
 *      dynamically generated text).
 *   2. Load this script:  <script src="i18n.js" defer></script>
 *   3. For dynamic JS strings, read window.I18N.t('key') and listen for the
 *      'langchange' event to re-render.
 *
 * Language is auto-detected from a saved choice, then navigator.language,
 * falling back to English. The choice is persisted in localStorage.
 */
(function () {
  'use strict';

  var SUPPORTED = ['ru', 'en', 'el'];
  var LABELS = { ru: 'RU', en: 'EN', el: 'GR' };
  var STORAGE_KEY = 'site-lang';

  function detect() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.indexOf(saved) !== -1) return saved;
    } catch (e) {}
    var nav = (navigator.language || navigator.userLanguage || 'en')
      .slice(0, 2)
      .toLowerCase();
    if (SUPPORTED.indexOf(nav) !== -1) return nav;
    return 'en';
  }

  var current = detect();

  function dict() {
    return window.I18N_DICT || {};
  }

  // Returns the raw value for a key in the current language, falling back
  // through en -> ru. Value may be a string, array or object.
  function t(key) {
    var d = dict();
    if (d[current] && key in d[current]) return d[current][key];
    if (d.en && key in d.en) return d.en[key];
    if (d.ru && key in d.ru) return d.ru[key];
    return key;
  }

  function applyDom() {
    var html = document.documentElement;
    if (html) html.setAttribute('lang', current);

    // Text content
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      var val = t(key);
      if (typeof val === 'string') nodes[i].innerHTML = val;
    }

    // Attributes: data-i18n-attr="placeholder:key;title:key2"
    var attrNodes = document.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrNodes.length; j++) {
      var spec = attrNodes[j].getAttribute('data-i18n-attr');
      var pairs = spec.split(';');
      for (var k = 0; k < pairs.length; k++) {
        var p = pairs[k].split(':');
        if (p.length === 2) {
          var av = t(p[1].trim());
          if (typeof av === 'string') attrNodes[j].setAttribute(p[0].trim(), av);
        }
      }
    }

    // <title>
    var d = dict();
    if (d[current] && '_title' in d[current]) {
      document.title = d[current]._title;
    }

    // <meta name="description"> and any [data-i18n-meta] meta tag
    var metaNodes = document.querySelectorAll('meta[data-i18n-meta]');
    for (var m = 0; m < metaNodes.length; m++) {
      var mk = metaNodes[m].getAttribute('data-i18n-meta');
      var mv = t(mk);
      if (typeof mv === 'string') metaNodes[m].setAttribute('content', mv);
    }
  }

  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) === -1 || lang === current) {
      if (lang === current) updateSwitcher();
      return;
    }
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
    applyDom();
    updateSwitcher();
    // Let page JS re-render dynamically generated strings.
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: lang } }));
  }

  /* ---------- Switcher UI ---------- */

  var switcherEl = null;

  function injectStyles() {
    if (document.getElementById('lang-switch-style')) return;
    var css =
      '.lang-switch{position:fixed;top:14px;right:14px;z-index:99999;' +
      'display:flex;gap:2px;padding:4px;border-radius:999px;' +
      'background:var(--lang-switch-bg,rgba(20,20,35,0.55));' +
      'border:1px solid var(--lang-switch-border,rgba(255,255,255,0.18));' +
      'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
      'box-shadow:0 4px 18px rgba(0,0,0,0.25);' +
      'font-family:var(--lang-switch-font,inherit);' +
      'font-size:13px;line-height:1;user-select:none;}' +
      '.lang-switch button{appearance:none!important;-webkit-appearance:none!important;border:0!important;cursor:pointer!important;' +
      'margin:0!important;min-width:0!important;width:auto!important;height:auto!important;box-shadow:none!important;outline:none!important;' +
      'text-transform:none!important;line-height:1!important;letter-spacing:.3px!important;' +
      'padding:6px 11px!important;border-radius:999px!important;font-weight:700!important;font-size:13px!important;font-family:inherit!important;' +
      'color:var(--lang-switch-fg,rgba(255,255,255,0.78))!important;' +
      'background:transparent!important;transition:background .18s,color .18s,transform .12s!important;}' +
      '.lang-switch button::before,.lang-switch button::after{display:none!important;content:none!important;}' +
      '.lang-switch button:hover{color:var(--lang-switch-fg-hover,#fff)!important;' +
      'background:var(--lang-switch-hover-bg,rgba(255,255,255,0.10))!important;}' +
      '.lang-switch button:active{transform:scale(.94)!important;}' +
      '.lang-switch button.is-active{' +
      'color:var(--lang-switch-active-fg,#fff)!important;' +
      'background:var(--lang-switch-active-bg,rgba(255,255,255,0.22))!important;' +
      'box-shadow:inset 0 0 0 1px var(--lang-switch-active-border,rgba(255,255,255,0.25))!important;}' +
      '@media (max-width:520px){.lang-switch{top:8px;right:8px;font-size:12px;}' +
      '.lang-switch button{padding:5px 9px!important;font-size:12px!important;}}';
    var style = document.createElement('style');
    style.id = 'lang-switch-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildSwitcher() {
    if (switcherEl) return;
    injectStyles();
    switcherEl = document.createElement('div');
    switcherEl.className = 'lang-switch';
    switcherEl.setAttribute('role', 'group');
    switcherEl.setAttribute('aria-label', 'Language');
    for (var i = 0; i < SUPPORTED.length; i++) {
      (function (lang) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-lang', lang);
        btn.textContent = LABELS[lang];
        btn.addEventListener('click', function () { setLang(lang); });
        switcherEl.appendChild(btn);
      })(SUPPORTED[i]);
    }
    document.body.appendChild(switcherEl);
    updateSwitcher();
  }

  function updateSwitcher() {
    if (!switcherEl) return;
    var btns = switcherEl.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var active = btns[i].getAttribute('data-lang') === current;
      btns[i].classList.toggle('is-active', active);
      btns[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  /* ---------- Public API ---------- */

  window.I18N = {
    t: t,
    setLang: setLang,
    supported: SUPPORTED,
    get lang() { return current; }
  };

  function init() {
    // Lock in the chosen/detected language so every other page shows the same one.
    try {
      if (!localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, current);
    } catch (e) {}
    applyDom();
    buildSwitcher();
    // Announce the initial language so page JS can build dynamic text.
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: current } }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
