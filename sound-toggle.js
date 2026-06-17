/*
 * Shared sound on/off toggle.
 * Works on any page regardless of its audio implementation: it patches
 * AudioNode.connect so every connection to the speakers is routed through a
 * per-context master gain that this module can mute. The choice is persisted
 * in localStorage and shared across pages.
 *
 * Usage on a page:
 *   1. Place a <button class="sound-toggle-btn ..."> somewhere (e.g. next to the
 *      Equalize button). Give it the same class as the neighbouring icon button
 *      so it matches the page style. Leave it empty — the icon is injected here.
 *   2. Load this script: <script src="sound-toggle.js" defer></script>
 *   3. (Optional) add i18n keys "sound_off" / "sound_on" to the page dictionary
 *      for a translated tooltip.
 */
(function () {
  'use strict';

  var KEY = 'site-muted';
  var muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) {}

  var masters = [];
  var AC = window.AudioContext || window.webkitAudioContext;
  if (AC && window.AudioNode && AudioNode.prototype && AudioNode.prototype.connect) {
    var origConnect = AudioNode.prototype.connect;
    var origCreateGain = AC.prototype.createGain;
    AudioNode.prototype.connect = function (dest) {
      try {
        var ctx = this.context;
        if (ctx && dest && dest === ctx.destination && origCreateGain) {
          if (!ctx.__stMaster) {
            var g = origCreateGain.call(ctx);
            origConnect.call(g, ctx.destination);
            g.gain.value = muted ? 0 : 1;
            ctx.__stMaster = g;
            masters.push(g);
          }
          var args = [ctx.__stMaster];
          for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
          return origConnect.apply(this, args);
        }
      } catch (e) {}
      return origConnect.apply(this, arguments);
    };
  }

  var ICON_ON =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a4 4 0 0 1 0 7"/><path d="M18.5 6a7 7 0 0 1 0 12"/></svg>';
  var ICON_OFF =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 9v6h4l5 4V5L8 9H4z"/><line x1="16" y1="9" x2="22" y2="15"/><line x1="22" y1="9" x2="16" y2="15"/></svg>';

  function applyMasters() {
    for (var i = 0; i < masters.length; i++) {
      try { masters[i].gain.value = muted ? 0 : 1; } catch (e) {}
    }
  }

  var TIP = {
    ru: { off: 'Выключить звук', on: 'Включить звук' },
    en: { off: 'Mute', on: 'Unmute' },
    el: { off: 'Σίγαση', on: 'Ενεργοποίηση ήχου' }
  };

  function updateButtons() {
    var lang = (window.I18N && I18N.lang) || 'ru';
    var t = (TIP[lang] || TIP.ru)[muted ? 'on' : 'off'];
    var btns = document.querySelectorAll('.sound-toggle-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.innerHTML = muted ? ICON_OFF : ICON_ON;
      b.classList.toggle('muted', muted);
      b.setAttribute('aria-pressed', muted ? 'true' : 'false');
      b.setAttribute('title', t);
      b.setAttribute('aria-label', t);
    }
  }

  function toggle() {
    muted = !muted;
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) {}
    applyMasters();
    updateButtons();
  }

  window.SoundToggle = { get muted() { return muted; }, toggle: toggle };

  // Minimal layout so the icon always centres, whatever button class the page uses.
  (function injectStyle() {
    if (document.getElementById('sound-toggle-style')) return;
    var s = document.createElement('style');
    s.id = 'sound-toggle-style';
    s.textContent =
      '.sound-toggle-btn{display:inline-flex;align-items:center;justify-content:center;cursor:pointer;}' +
      '.sound-toggle-btn svg{display:block;}';
    (document.head || document.documentElement).appendChild(s);
  })();

  function wire() {
    var btns = document.querySelectorAll('.sound-toggle-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.__stWired) continue;
      b.__stWired = true;
      try { b.type = 'button'; } catch (e) {}
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      });
    }
    updateButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
  window.addEventListener('langchange', updateButtons);
})();
