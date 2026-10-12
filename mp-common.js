/*
 * mp-common.js — общий клиентский каркас мультиплеера (IMPLEMENTATION-PLAN T-W1-04, пакет P1).
 * Без зависимостей и без стилей. Подключается ТОЛЬКО страницами пилота, тегом строго
 *   <script src="legacy-compat.js"></script>   (на досках — раньше)
 *   <script src="mp-common.js"></script>        (раньше *-shared.js)
 * Игра обязана работать и без него: всё через `window.MP && …`.
 *
 * СОВМЕСТИМОСТЬ. Проекторы открывают доски в Chromium 80–83: синтаксис не выше ES2017 — без `?.`, `??`,
 * object spread, rest/spread вообще, optional catch binding, `.at()`, `replaceAll`, `Object.hasOwn`,
 * `structuredClone`, `replaceChildren`. Проверяет tools/testkit/mp-units.js.
 *
 * АВАРИЙНЫЙ ВЫКЛЮЧАТЕЛЬ. Файл грузится с no-cache — ошибка сразу у всех телефонов. Поэтому:
 *   • localStorage['mp-off'] === '1'  -> window.MP не создаётся совсем;
 *   • сервер шлёт hello.mp === false (env MP_OFF=1)  -> MP.applyHello(hello) возвращает false,
 *     MP.off = true, все модули становятся пустыми (joinFlow.handle -> false, nameCounter без DOM).
 *
 * ПУБЛИЧНЫЙ API (MP.version = "1.1.0")
 *   MP.store.get(k) / set(k,v) / del(k)      localStorage в try/catch (null при недоступности)
 *   MP.applyHello(hello) -> bool             hello.mp === false -> выключить; иначе запомнить hello.limits
 *   MP.limits                                 {name, answer, item, clue, …} из hello.limits ({} по умолч.)
 *   MP.charCount(s) / MP.clip(s, max)         длина и срез по СИМВОЛАМ (не UTF-16)
 *
 *   MP.joinFlow({send, buildJoin, onClaimPrompt, onJoined, onTaken, onGiveUp, onRetry,
 *                maxRetries = 6, retryMs = 2000, setTimeout, clearTimeout}) -> flow
 *     flow.join(extra?)    шлёт {type:"join", …buildJoin(), caps:["claim"], …extra}; запоминает сообщение
 *     flow.handle(msg)     разбор ответа сервера; true = сообщение ПОТРЕБЛЕНО (игре его обрабатывать не надо)
 *         {type:"error", error:"name_claim", name, summary}   -> onClaimPrompt({name, summary, accept(), decline()});
 *                                          accept() = join{claim:true}, decline() = join{fresh:true} («Я другой»);
 *                                          повторный name_claim при открытом экране — тихо (true, без повторного показа)
 *         {type:"error", error:"name_claim", retry:true, retryInMs?}  -> молча повторить join через retryInMs
 *                                          (≤ maxRetries раз, потом onGiveUp(msg)); true
 *         {type:"joined", name, renamed, resumed}  -> сброс; onJoined(msg, {name, renamed, resumed}); false
 *         {type:"error", error:"name_taken"}        -> onTaken(msg); false (игра показывает как раньше)
 *         любое незнакомое                          -> false (поведение как раньше)
 *     flow.resume()        после обрыва сокета: если экран «Это ты?» открыт — повторить join (без claim/fresh),
 *                          чтобы сервер продлил ожидание; экран не пропадает
 *     flow.cancel()        сбросить таймеры и экран
 *     flow.state()         {retries, prompting}
 *   Старый сервер (без name_claim) просто никогда не присылает эти ответы — клиент ведёт себя как раньше.
 *
 *   MP.nameCounter(input, max, {threshold = 4, el, onUpdate}) -> {el, update(), count()}
 *     «12/16» появляется, когда осталось ≤ threshold символов (N−4); срез по символам при вводе;
 *     el: data-state="ok"|"near"|"full". Стилей нет — оформляет игра. MP.nameCounter.format(n, max) -> "12/16".
 *
 *   MP.replacedTab({rejoin, onReplaced, onTokenGone, auto = false, autoMinMs = 5000, claimQuietMs = 60000})
 *     -> api   «Ты открыл игру в другой вкладке»
 *     api.handle(msg)   {type:"replaced"} -> replaced=true, onReplaced(); {error:"token_gone"} после back() ->
 *                       onTokenGone() (идти обычным входом по имени); true если потреблено
 *     api.back(now?)    кнопка «Играть здесь»: rejoin(); учёт для авто-возврата
 *     api.canAutoReturn(now) -> bool   auto && ≥ autoMinMs с прошлого авто-возврата && за claimQuietMs не было
 *                                      claim с другого устройства (api.noteClaimElsewhere(now))
 *     api.isReplaced()
 *
 *   MP.hostLink({hostKeyFn, boardPath, getRoom, onToast, sendHost, navigator, location, prompt, takeMinMs = 3000})
 *     -> api   «🔑 Ссылка ведущего» (T-W1-10, U-03 вариант A). Токен ведущего НЕ рисуется на экране.
 *     hostKeyFn() -> ключ localStorage с токеном (bomb: "bomb-host-КОД"); getRoom() -> код; boardPath -> "bomb-board.html"
 *     api.url() -> "…/bomb-board.html?r=КОД&h=ТОКЕН" | null (нет токена или кода)
 *     api.copy() -> Promise<"copied"|"shared"|"prompt"|"cancelled"|"none">   clipboard -> Web Share -> prompt();
 *                                          onToast(kind) вызывается с тем же значением
 *     api.adopt(text) -> токен | null      «Я ведущий»: из вставленной ссылки (?h=) или голого токена; кладёт в localStorage
 *     api.take(now?, text?) -> bool        «Забрать»: sendHost(токен) не чаще раза в takeMinMs (3 с)
 *     MP.hostLink.build(href, boardPath, code, token), MP.hostLink.parseToken(text)
 */
(function (root) {
  'use strict';

  var VERSION = '1.1.0';

  function safeGet(k) {
    try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function safeSet(k, v) {
    try { if (root.localStorage) { root.localStorage.setItem(k, String(v)); return true; } } catch (e) { /* нет места/запрещено */ }
    return false;
  }
  function safeDel(k) {
    try { if (root.localStorage) { root.localStorage.removeItem(k); return true; } } catch (e) { /* ignore */ }
    return false;
  }

  if (safeGet('mp-off') === '1') return; // аварийный выключатель: window.MP не создаётся

  function charCount(s) {
    return Array.from(String(s == null ? '' : s)).length;
  }
  function clip(s, max) {
    var a = Array.from(String(s == null ? '' : s));
    return a.length > max ? a.slice(0, max).join('') : a.join('');
  }
  function copyInto(dst, src) {
    if (src) { for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) dst[k] = src[k]; } }
    return dst;
  }
  function timers(opts) {
    return {
      set: opts.setTimeout || function (fn, ms) { return root.setTimeout(fn, ms); },
      clear: opts.clearTimeout || function (id) { return root.clearTimeout(id); }
    };
  }

  var MP = {
    version: VERSION,
    off: false,
    limits: {},
    store: { get: safeGet, set: safeSet, del: safeDel },
    charCount: charCount,
    clip: clip
  };

  MP.applyHello = function (hello) {
    if (hello && hello.mp === false) { MP.off = true; return false; }
    if (hello && hello.limits && typeof hello.limits === 'object') MP.limits = hello.limits;
    return !MP.off;
  };

  // ── joinFlow ───────────────────────────────────────────────────────────────────────────────────
  MP.joinFlow = function (opts) {
    var o = opts || {};
    var t = timers(o);
    var maxRetries = typeof o.maxRetries === 'number' ? o.maxRetries : 6;
    var retryMs = typeof o.retryMs === 'number' ? o.retryMs : 2000;
    var retries = 0;
    var timer = null;
    var prompting = false;
    var lastMsg = null;

    function stopTimer() {
      if (timer !== null) { t.clear(timer); timer = null; }
    }
    function emit(msg) {
      lastMsg = msg;
      if (typeof o.send === 'function') o.send(msg);
    }
    function build(extra) {
      var base = typeof o.buildJoin === 'function' ? o.buildJoin() : {};
      var msg = copyInto({}, base);
      if (!msg.type) msg.type = 'join';
      msg.caps = ['claim'];
      return copyInto(msg, extra);
    }

    var flow = {
      join: function (extra) {
        if (MP.off) return false;
        stopTimer();
        emit(build(extra));
        return true;
      },
      handle: function (m) {
        if (MP.off || !m || typeof m !== 'object') return false;
        if (m.type === 'joined') {
          stopTimer(); retries = 0; prompting = false;
          if (typeof o.onJoined === 'function') o.onJoined(m, { name: m.name, renamed: !!m.renamed, resumed: !!m.resumed });
          return false;
        }
        if (m.type !== 'error') return false;
        if (m.error === 'name_taken') {
          if (typeof o.onTaken === 'function') o.onTaken(m);
          return false;
        }
        if (m.error !== 'name_claim') return false;

        if (m.retry === true) {
          if (retries >= maxRetries) {
            stopTimer();
            if (typeof o.onGiveUp === 'function') o.onGiveUp(m);
            return true;
          }
          retries++;
          if (typeof o.onRetry === 'function') o.onRetry(retries, m);
          stopTimer();
          var wait = typeof m.retryInMs === 'number' && m.retryInMs > 0 ? Math.max(m.retryInMs, 200) : retryMs;
          var again = lastMsg ? copyInto({}, lastMsg) : build();
          timer = t.set(function () { timer = null; emit(again); }, wait);
          return true;
        }

        retries = 0;
        stopTimer();
        if (prompting) return true; // экран «Это ты?» уже открыт — не мигаем
        prompting = true;
        if (typeof o.onClaimPrompt === 'function') {
          o.onClaimPrompt({
            name: m.name,
            summary: m.summary || {},
            accept: function () { prompting = false; flow.join({ claim: true }); },
            decline: function () { prompting = false; flow.join({ fresh: true }); }
          });
        }
        return true;
      },
      resume: function () {
        if (MP.off || !prompting) return false;
        stopTimer();
        emit(build());
        return true;
      },
      cancel: function () {
        stopTimer(); retries = 0; prompting = false;
      },
      state: function () {
        return { retries: retries, prompting: prompting };
      }
    };
    return flow;
  };

  // ── nameCounter ────────────────────────────────────────────────────────────────────────────────
  function formatCount(n, max) {
    return n + '/' + max;
  }

  MP.nameCounter = function (input, max, opts) {
    var o = opts || {};
    var threshold = typeof o.threshold === 'number' ? o.threshold : 4;
    var el = o.el || null;
    var api = {
      el: null,
      count: function () { return input ? charCount(input.value) : 0; },
      update: function () {
        if (!input || MP.off) return;
        var v = String(input.value == null ? '' : input.value);
        if (charCount(v) > max) { v = clip(v, max); input.value = v; }
        var n = charCount(v);
        var state = n >= max ? 'full' : (n >= max - threshold ? 'near' : 'ok');
        if (api.el) {
          api.el.textContent = state === 'ok' ? '' : formatCount(n, max);
          if (api.el.setAttribute) api.el.setAttribute('data-state', state);
          if (api.el.style) api.el.style.visibility = state === 'ok' ? 'hidden' : 'visible';
        }
        if (typeof o.onUpdate === 'function') o.onUpdate(n, max, state);
      }
    };
    if (!input || MP.off) return api;
    if (!el && root.document && input.parentNode) {
      el = root.document.createElement('span');
      el.setAttribute('aria-live', 'polite');
      if (input.nextSibling) input.parentNode.insertBefore(el, input.nextSibling);
      else input.parentNode.appendChild(el);
    }
    api.el = el;
    if (input.addEventListener) {
      input.addEventListener('input', api.update);
      input.addEventListener('change', api.update);
    }
    api.update();
    return api;
  };
  MP.nameCounter.format = formatCount;

  // ── replacedTab ────────────────────────────────────────────────────────────────────────────────
  MP.replacedTab = function (opts) {
    var o = opts || {};
    var replaced = false;
    var rejoining = false;
    var lastAuto = -Infinity;
    var claimElsewhereAt = -Infinity;
    var autoMinMs = typeof o.autoMinMs === 'number' ? o.autoMinMs : 5000;
    var quietMs = typeof o.claimQuietMs === 'number' ? o.claimQuietMs : 60000;

    function nowOf(n) { return typeof n === 'number' ? n : Date.now(); }

    var api = {
      isReplaced: function () { return replaced; },
      handle: function (m) {
        if (MP.off || !m || typeof m !== 'object') return false;
        if (m.type === 'joined') rejoining = false; // не потребляем: игра обработает сама
        if (m.type === 'replaced') {
          replaced = true;
          if (typeof o.onReplaced === 'function') o.onReplaced(m);
          return true;
        }
        if (m.type === 'error' && m.error === 'token_gone' && rejoining) {
          rejoining = false;
          if (typeof o.onTokenGone === 'function') o.onTokenGone(m);
          return true;
        }
        return false;
      },
      back: function (now) {
        if (MP.off) return false;
        replaced = false;
        rejoining = true;
        lastAuto = nowOf(now);
        if (typeof o.rejoin === 'function') o.rejoin();
        return true;
      },
      noteClaimElsewhere: function (now) { claimElsewhereAt = nowOf(now); },
      canAutoReturn: function (now) {
        if (MP.off || !o.auto) return false;
        var n = nowOf(now);
        if (n - lastAuto < autoMinMs) return false;
        if (n - claimElsewhereAt < quietMs) return false;
        return true;
      }
    };
    return api;
  };

  // ── hostLink ───────────────────────────────────────────────────────────────────────────────────
  var TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

  function buildHostUrl(href, boardPath, code, token) {
    var base = String(href || '').split('#')[0].split('?')[0];
    base = base.slice(0, base.lastIndexOf('/') + 1) + boardPath;
    return base + '?r=' + encodeURIComponent(code) + '&h=' + encodeURIComponent(token);
  }
  function parseHostToken(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return null;
    var m = /[?&]h=([^&#\s]+)/.exec(s);
    if (m) {
      var v = m[1];
      try { v = decodeURIComponent(v); } catch (e) { /* оставляем как есть */ }
      return TOKEN_RE.test(v) ? v : null;
    }
    return TOKEN_RE.test(s) ? s : null;
  }

  MP.hostLink = function (opts) {
    var o = opts || {};
    var minMs = typeof o.takeMinMs === 'number' ? o.takeMinMs : 3000;
    var lastTake = -Infinity;
    function env(k) { return o[k] || root[k]; }
    function key() { return typeof o.hostKeyFn === 'function' ? o.hostKeyFn() : null; }
    function token() { var k = key(); return k ? safeGet(k) : null; }
    function toast(kind) { if (typeof o.onToast === 'function') o.onToast(kind); return kind; }

    var api = {
      url: function () {
        var t = token();
        var code = typeof o.getRoom === 'function' ? o.getRoom() : '';
        var loc = env('location');
        if (!t || !code || !loc) return null;
        return buildHostUrl(loc.href, o.boardPath || 'bomb-board.html', code, t);
      },
      copy: function () {
        if (MP.off) return Promise.resolve('none');
        var url = api.url();
        if (!url) return Promise.resolve(toast('none'));
        var nav = env('navigator') || {};
        function viaPrompt() {
          var pr = env('prompt');
          if (typeof pr === 'function') { try { pr('', url); } catch (e) { /* ignore */ } }
          return toast('prompt');
        }
        function viaShare() {
          if (typeof nav.share !== 'function') return Promise.resolve(viaPrompt());
          var p;
          try { p = nav.share({ url: url }); } catch (e) { return Promise.resolve(viaPrompt()); }
          return Promise.resolve(p).then(function () { return toast('shared'); }, function (e) {
            if (e && e.name === 'AbortError') return toast('cancelled'); // игрок закрыл меню — не спорим
            return viaPrompt();
          });
        }
        if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          var w;
          try { w = nav.clipboard.writeText(url); } catch (e) { return viaShare(); }
          return Promise.resolve(w).then(function () { return toast('copied'); }, viaShare);
        }
        return viaShare();
      },
      adopt: function (text) {
        var t = parseHostToken(text);
        var k = key();
        if (!t || !k) return null;
        safeSet(k, t);
        return t;
      },
      take: function (now, text) {
        if (MP.off) return false;
        var n = typeof now === 'number' ? now : Date.now();
        if (n - lastTake < minMs) return false;
        var t = text ? api.adopt(text) : token();
        if (!t) return false;
        lastTake = n;
        if (typeof o.sendHost === 'function') o.sendHost(t);
        return true;
      }
    };
    return api;
  };
  MP.hostLink.build = buildHostUrl;
  MP.hostLink.parseToken = parseHostToken;

  root.MP = MP;
})(this);
