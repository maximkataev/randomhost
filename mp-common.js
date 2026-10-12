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
 *   MP.draft({game, room, ttlMs = 7200000, max, now}) -> d    черновик подсказки/ответа (К-6: localStorage, TTL 2 ч)
 *     ключ localStorage: "mp:draft:<game>:<ROOM>", значение {k, t, at}; один слот на комнату.
 *     d.save(k, text)   k — ключ фазы/раунда (ТОЛЬКО публичный: «game:ri»; сектор/target сюда не передавать);
 *                       пустой текст = удалить; текст режется по символам до max (MP.limits.clue → 200)
 *     d.load(k) -> string|null   текст, если слот того же k и моложе TTL; чужой k или просрочка — слот удаляется
 *     d.clear()         удалить слот (принятая отправка / kicked / expired)
 *     d.key()           ключ localStorage
 *   Любая ошибка хранилища (приватный режим, квота) глотается: черновик просто не переживёт reload.
 *
 *   MP.sendQueue({send, keep, onDrop, ceilingMs = 90000, replace, max = 8, minGapMs = 250,
 *                 probe, silenceMs = 8000, probeMs = 1500, now, setTimeout, clearTimeout}) -> q
 *     очередь действий, нажатых при обрыве; транспорт игры остаётся её собственным.
 *     send(m)           реальная отправка (игра: holder.api.send)
 *     keep(m) -> bool   актуально ли действие в момент отправки (проверяется на КАЖДОМ сообщении, не только в flush)
 *     onDrop(m, reason, at)   ОБЯЗАТЕЛЕН: reason = "expired" | "unwanted" | "overflow" | "off"; игра снимает «ушло» с кнопки
 *     ceilingMs         потолок возраста — число или {тип: мс, "*": по умолчанию}. По ТИПУ действия, а не общий:
 *                       ответы/черновики/lock — 90 с, быстрые (бросок, ставка, лайк) — 3–5 с
 *     replace           массив типов ("lock","clue") или fn(m) -> ключ|null: новое действие заменяет старое того же ключа
 *                       (замена — не потеря, onDrop не зовётся)
 *     max               общий размер; старейшее вытесняется через onDrop("overflow")
 *     minGapMs          повтор очереди не быстрее 4/с (иначе упрёмся в MSG_RATE/CMD_RATE сервера)
 *     probe(ms)         зовётся, если очередь стоит дольше silenceMs без вестей (игра: transport.probe)
 *     q.push(m) -> bool       false (и onDrop "off") при MP.off
 *     q.flush(keep?, onDrop?) связь вернулась: отправить подходящее с шагом minGapMs; ненужное — в onDrop.
 *                       flush(function () { return false; }) — выбросить всё (kicked / expired)
 *     q.heard()         пришло любое сообщение сервера (сбрасывает «тишину»)
 *     q.size() / q.has(type) / q.clear() (без onDrop) / q.setCeiling(type, ms)
 *   MP.hostLink({hostKeyFn, boardPath, getRoom, onToast, sendHost, navigator, location, prompt, takeMinMs = 3000})
 *     -> api   «🔑 Ссылка ведущего» (T-W1-10, U-03 вариант A). Токен ведущего НЕ рисуется на экране.
 *     hostKeyFn() -> ключ localStorage с токеном (bomb: "bomb-host-КОД"); getRoom() -> код; boardPath -> "bomb-board.html"
 *     api.url() -> "…/bomb-board.html?r=КОД&h=ТОКЕН" | null (нет токена или кода)
 *     api.copy() -> Promise<"copied"|"shared"|"prompt"|"cancelled"|"none">   clipboard -> Web Share -> prompt();
 *                                          onToast(kind) вызывается с тем же значением
 *     api.adopt(text) -> токен | null      «Я ведущий»: из вставленной ссылки (?h=) или голого токена; кладёт в localStorage
 *     api.take(now?, text?) -> bool        «Забрать»: sendHost(токен) не чаще раза в takeMinMs (3 с)
 *     MP.hostLink.build(href, boardPath, code, token), MP.hostLink.parseToken(text)
 *
 *   MP.roomGone({showForm, onClosed}) -> api   «Такой комнаты нет» против «Комната закрыта» (T-W1-12)
 *     api.hello()      пришёл hello — комната существовала
 *     api.gone(info?)  404 / room_expired: до первого hello -> showForm(info) («Такой комнаты нет» + поле кода),
 *                      после -> onClosed(info); возвращает "noroom" | "closed". Повторно не вызывает (404 не ретраится)
 *     api.seen()       был ли hello;  api.submit(raw) -> итоговый код ПОСЛЕ фильтра | null (пусто)
 *     MP.roomGone.normalize(raw) -> "BEAR74"  (верхний регистр, только A-Z и 2-9, ≤ 12)
 *     Серверного различителя нет (К-11): «нет такой» и «закрыта по TTL» до hello неразличимы.
 *   MP.twoTap(el, {onConfirm, armedMs = 3000, label, armedLabel, onArm, onDisarm, setTimeout, clearTimeout}) -> ctl
 *     Двухтактная команда ведущего (U-12, класс A): первый тап «взводит» (el[data-armed="1"], текст -> armedLabel
 *     «Точно завершить?», если задан), второй в течение armedMs (3 с) вызывает onConfirm(event); по истечении —
 *     само снимается. Защита от случайного «Закончить»/«Дальше». label — подпись по умолчанию (вернётся при снятии).
 *     Если MP.off — первый же тап выполняет команду (как до модуля).
 *     ctl.disarm() / ctl.isArmed() / ctl.destroy()
 *   MP.twoTap.create({armedMs, onChange(key|null), now, setTimeout, clearTimeout}) -> ctl
 *     Тот же двухтактный автомат без DOM — для списков, которые перерисовываются целиком (кнопка ✕ у игрока):
 *     ctl.tap(key) -> true, если это ВТОРОЙ тап по тому же key в окне (команду выполнять); иначе взводит key и
 *     возвращает false. Тап по другому key перевзводит. ctl.armed() -> key|null; ctl.isArmed(key); ctl.disarm().
 *     onChange вызывается при смене взведённого key (в т.ч. по таймеру) — игра перерисовывает кнопки.
 *   MP.rules.RULE_U17_LANG_FOLLOW (false по умолчанию; U-17, класс B) — «телефон следует языку комнаты».
 *   MP.followRoomLang({getRoomLang, onSuggest, auto = false, enabled, getLang, setLang, storageKey}) -> api
 *     Флаг выкл. (и enabled не задан) -> api инертен (check() всегда false), ничего не слушает.
 *     api.check(roomLang?)  язык комнаты берётся из аргумента или getRoomLang(); если он ru|en|el, отличается от
 *                           текущего и игрок ещё не выбирал язык вручную:
 *                             auto:true  -> setLang(room, {persist:false}) (site-lang не трогаем); возвращает "switched"
 *                             иначе      -> onSuggest({lang, accept(), decline()}) — «Язык комнаты: EN. Переключить?»;
 *                                           один раз на язык; возвращает "suggested"
 *     api.markManual()      ручной выбор: запоминается в sessionStorage (ключ mp-lang-manual) — дальше не следуем;
 *                           вызывается сам по событию 'langchange' с detail.persist !== false (клик по переключателю)
 *     api.isManual()
 *   getLang/setLang по умолчанию — window.I18N.lang / I18N.setLang. Подключение к играм — отдельными задачами.
 *
 *   MP.conn({ping, inGame, onOffline, onOnline, onDead, hidden, pingGameMs = 5000, pingLobbyMs = 10000,
 *             warnMs = 10000, closeMs = 22000, tickMs = 1000, now, setInterval, clearInterval}) -> api  (T-W1-08)
 *     Живость сокета по тишине. api.start()/stop(); api.seen() — на КАЖДОЕ входящее сообщение (в т.ч. pong);
 *     api.visible() — вкладка снова видна (тишина при document.hidden не считается); api.tick(now) — шаг (тесты);
 *     api.offline(); api.silentMs(). Пинг: 5 с в игре (inGame()), 10 с в лобби. onOffline — тишина > warnMs (баннер,
 *     без закрытия); onDead — тишина > closeMs (игра закрывает сокет и переподключается), по разу за период.
 *
 *   MP.progress.text(done, total, secsLeft?, {kind = 'answered' | 'voted' | 'wrote' | 'locked', lang?}) -> "Ответили 4 из 6 · ~40 с"  (T-W1-14)
 *     done ограничен total; секунды с «~» (шагом 5 с выше 10); язык: opts.lang | I18N.lang | ru (ru/en/el).
 *
 *   MP.rank(players, {score = 'score' | fn, tiebreak(a, b), exclude(p), fallbackAll = true})  (T-W1-15)
 *     -> {list: [{id, player, score, place, tie}], winnerIds, byId, excluded}  ранг 1,1,3; не участвуют left и played === false
 *
 *   MP.vibrate(pattern) -> bool       только после жеста (userActivation.hasBeenActive | первое касание); без исключений  (T-W1-16)
 *   MP.keyboardClass({className = 'kb', threshold = 120, element, onChange}) -> {active(), update(), stop()}
 *     visualViewport.resize -> html.kb, когда клавиатура съела > threshold px; CSS-переменная --kb-h; разметку не трогает
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

  // ── draft ──────────────────────────────────────────────────────────────────────────────────────
  MP.draft = function (opts) {
    var o = opts || {};
    var ttl = typeof o.ttlMs === 'number' ? o.ttlMs : 2 * 60 * 60 * 1000;
    var key = 'mp:draft:' + String(o.game || '') + ':' + String(o.room || '').toUpperCase();
    function nowOf() { return typeof o.now === 'function' ? o.now() : Date.now(); }
    function maxLen() { return typeof o.max === 'number' ? o.max : (MP.limits && MP.limits.clue) || 200; }
    function read() {
      var raw = safeGet(key);
      if (!raw) return null;
      try {
        var v = JSON.parse(raw);
        if (v && typeof v === 'object' && typeof v.k === 'string' && typeof v.t === 'string' && typeof v.at === 'number') return v;
      } catch (e) { /* битая запись */ }
      safeDel(key);
      return null;
    }
    return {
      key: function () { return key; },
      save: function (k, text) {
        if (MP.off) return false;
        var t = clip(text, maxLen());
        if (!t.trim()) { safeDel(key); return false; }
        return safeSet(key, JSON.stringify({ k: String(k), t: t, at: nowOf() }));
      },
      load: function (k) {
        if (MP.off) return null;
        var v = read();
        if (!v) return null;
        if (v.k !== String(k) || nowOf() - v.at > ttl || nowOf() < v.at - 60000) { safeDel(key); return null; }
        return v.t;
      },
      clear: function () { safeDel(key); }
    };
  };

  // ── sendQueue ──────────────────────────────────────────────────────────────────────────────────
  MP.sendQueue = function (opts) {
    var o = opts || {};
    var t = timers(o);
    var DEFAULT_CEIL = 90000;
    var ceil = {};
    if (typeof o.ceilingMs === 'number') ceil['*'] = o.ceilingMs;
    else copyInto(ceil, o.ceilingMs);
    if (typeof ceil['*'] !== 'number') ceil['*'] = DEFAULT_CEIL;
    var maxItems = typeof o.max === 'number' ? o.max : 8;
    var minGap = typeof o.minGapMs === 'number' ? o.minGapMs : 250;
    var silenceMs = typeof o.silenceMs === 'number' ? o.silenceMs : 8000;
    var probeMs = typeof o.probeMs === 'number' ? o.probeMs : 1500;
    var items = [];
    var flushing = false;
    var flushKeep = null, flushDrop = null;
    var lastSent = -Infinity, lastHeard = -Infinity, lastProbe = -Infinity;
    var pumpTimer = null, silenceTimer = null;

    function nowOf() { return typeof o.now === 'function' ? o.now() : Date.now(); }
    function ceilingFor(m) {
      var ty = m && m.type;
      return typeof ceil[ty] === 'number' ? ceil[ty] : ceil['*'];
    }
    function repKey(m) {
      if (typeof o.replace === 'function') return o.replace(m);
      if (o.replace && o.replace.indexOf && m && o.replace.indexOf(m.type) >= 0) return m.type;
      return null;
    }
    function drop(it, reason) {
      var f = flushDrop || o.onDrop;
      if (typeof f === 'function') f(it.m, reason, it.at);
    }
    function wanted(m) {
      var f = flushing && flushKeep ? flushKeep : o.keep;
      return typeof f !== 'function' || !!f(m);
    }
    function stopPump() { if (pumpTimer !== null) { t.clear(pumpTimer); pumpTimer = null; } }
    function stopSilence() { if (silenceTimer !== null) { t.clear(silenceTimer); silenceTimer = null; } }
    function pump() {
      stopPump();
      while (items.length) {
        var it = items[0];
        var n = nowOf();
        if (n - it.at > ceilingFor(it.m)) { items.shift(); drop(it, 'expired'); continue; }
        if (!wanted(it.m)) { items.shift(); drop(it, 'unwanted'); continue; }
        var wait = lastSent + minGap - n;
        if (wait > 0) { pumpTimer = t.set(pump, wait); return; }
        items.shift();
        lastSent = n;
        if (typeof o.send === 'function') o.send(it.m);
      }
      flushing = false; flushKeep = null; flushDrop = null;
      stopSilence();
    }
    function watchSilence() {
      if (silenceTimer !== null || flushing || typeof o.probe !== 'function') return;
      silenceTimer = t.set(function () {
        silenceTimer = null;
        if (!items.length || flushing) return;
        var n = nowOf();
        var quietSince = Math.max(lastHeard, items[0].at);
        if (n - quietSince > silenceMs && n - lastProbe > silenceMs) { lastProbe = n; o.probe(probeMs); }
        watchSilence();
      }, 1000);
    }

    var q = {
      push: function (m) {
        if (!m) return false;
        if (MP.off) { drop({ m: m, at: nowOf() }, 'off'); return false; }
        var k = repKey(m);
        if (k != null) {
          for (var i = items.length - 1; i >= 0; i--) if (repKey(items[i].m) === k) items.splice(i, 1);
        }
        items.push({ m: m, at: nowOf() });
        while (items.length > maxItems) drop(items.shift(), 'overflow');
        if (flushing) pump(); else watchSilence();
        return true;
      },
      flush: function (keepFn, dropFn) {
        flushing = true;
        flushKeep = typeof keepFn === 'function' ? keepFn : null;
        flushDrop = typeof dropFn === 'function' ? dropFn : null;
        stopSilence();
        pump();
      },
      heard: function () { lastHeard = nowOf(); },
      size: function () { return items.length; },
      isFlushing: function () { return flushing; },
      has: function (type) {
        for (var i = 0; i < items.length; i++) if (items[i].m.type === type) return true;
        return false;
      },
      setCeiling: function (type, ms) { ceil[type] = ms; },
      clear: function () { items = []; flushing = false; flushKeep = null; flushDrop = null; stopPump(); stopSilence(); }
    };
    return q;
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

  // ── roomGone ───────────────────────────────────────────────────────────────────────────────────
  function normalizeCode(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 12);
  }

  MP.roomGone = function (opts) {
    var o = opts || {};
    var seen = false;
    var fired = false;
    var api = {
      hello: function () { seen = true; },
      seen: function () { return seen; },
      gone: function (info) {
        if (fired) return seen ? 'closed' : 'noroom';
        fired = true;
        if (!seen) {
          if (typeof o.showForm === 'function') o.showForm(info);
          return 'noroom';
        }
        if (typeof o.onClosed === 'function') o.onClosed(info);
        return 'closed';
      },
      submit: function (raw) {
        var c = normalizeCode(raw);
        return c || null;
      }
    };
    return api;
  };
  MP.roomGone.normalize = normalizeCode;
  // ── twoTap ─────────────────────────────────────────────────────────────────────────────────────
  MP.twoTap = function (el, opts) {
    var o = opts || {};
    var armedMs = typeof o.armedMs === 'number' ? o.armedMs : 3000;
    var base = null; // подпись до взвода
    var ctl = MP.twoTap.create({
      armedMs: armedMs,
      setTimeout: o.setTimeout,
      clearTimeout: o.clearTimeout,
      onChange: function (key) {
        if (!el) return;
        if (key != null) {
          if (el.setAttribute) el.setAttribute('data-armed', '1');
          if (o.armedLabel != null) { base = el.textContent; el.textContent = o.armedLabel; }
          if (typeof o.onArm === 'function') o.onArm(el);
        } else {
          if (el.removeAttribute) el.removeAttribute('data-armed');
          if (o.armedLabel != null && base != null) { el.textContent = o.label != null ? o.label : base; base = null; }
          if (typeof o.onDisarm === 'function') o.onDisarm(el);
        }
      }
    });
    if (o.label != null && el) el.textContent = o.label;
    function onClick(ev) {
      if (ctl.tap('el') && typeof o.onConfirm === 'function') o.onConfirm(ev);
    }
    if (el && el.addEventListener) el.addEventListener('click', onClick);
    return {
      disarm: ctl.disarm,
      isArmed: function () { return ctl.isArmed('el'); },
      destroy: function () {
        ctl.disarm();
        if (el && el.removeEventListener) el.removeEventListener('click', onClick);
      }
    };
  };
  MP.twoTap.create = function (opts) {
    var o = opts || {};
    var t = timers(o);
    var armedMs = typeof o.armedMs === 'number' ? o.armedMs : 3000;
    var key = null;
    var timer = null;
    function set(k) {
      var changed = k !== key;
      key = k;
      if (timer != null) { t.clear(timer); timer = null; }
      if (k != null) timer = t.set(function () { timer = null; set(null); }, armedMs);
      if (changed && typeof o.onChange === 'function') o.onChange(key);
    }
    return {
      tap: function (k) {
        if (MP.off) return true; // модуль выключен: поведение «как раньше» — один тап
        if (key != null && key === k) { set(null); return true; }
        set(k);
        return false;
      },
      armed: function () { return key; },
      isArmed: function (k) { return key != null && key === k; },
      disarm: function () { if (key != null) set(null); }
    };
  };
  // ── followRoomLang (U-17, за флагом) ────────────────────────────────────────────────────────────
  MP.rules = { RULE_U17_LANG_FOLLOW: false };

  var LANGS = ['ru', 'en', 'el'];

  MP.followRoomLang = function (opts) {
    var o = opts || {};
    var enabled = typeof o.enabled === 'boolean' ? o.enabled : !!MP.rules.RULE_U17_LANG_FOLLOW;
    var key = o.storageKey || 'mp-lang-manual';
    var memManual = false;
    var suggested = {};
    var applying = false;

    function ss() { try { return root.sessionStorage || null; } catch (e) { return null; } }
    function isManual() {
      var s = ss();
      try { if (s && s.getItem(key) === '1') return true; } catch (e) { /* ignore */ }
      return memManual;
    }
    function markManual() {
      memManual = true;
      var s = ss();
      try { if (s) s.setItem(key, '1'); } catch (e) { /* ignore */ }
    }
    function curLang() {
      if (typeof o.getLang === 'function') return o.getLang();
      return root.I18N ? root.I18N.lang : null;
    }
    function applyLang(lang, persist) {
      if (typeof o.setLang === 'function') return o.setLang(lang, { persist: persist });
      if (root.I18N && typeof root.I18N.setLang === 'function') return root.I18N.setLang(lang, { persist: persist });
    }

    var api = {
      enabled: enabled,
      isManual: isManual,
      markManual: markManual,
      check: function (roomLang) {
        if (MP.off || !enabled) return false;
        var room = roomLang;
        if (room == null && typeof o.getRoomLang === 'function') room = o.getRoomLang();
        room = String(room == null ? '' : room).toLowerCase().slice(0, 2);
        if (LANGS.indexOf(room) === -1) return false;
        if (isManual() || room === curLang()) return false;
        if (o.auto) {
          applying = true;
          try { applyLang(room, false); } finally { applying = false; }
          return 'switched';
        }
        if (suggested[room] || typeof o.onSuggest !== 'function') return false;
        suggested[room] = true;
        o.onSuggest({
          lang: room,
          accept: function () { markManual(); applying = true; try { applyLang(room, true); } finally { applying = false; } },
          decline: function () { markManual(); }
        });
        return 'suggested';
      }
    };

    // ручное переключение (клик по .lang-switch) = persist !== false; наши собственные вызовы отсекаем флагом applying
    if (enabled && typeof root.addEventListener === 'function') {
      root.addEventListener('langchange', function (ev) {
        var d = ev && ev.detail;
        if (applying || !d || d.persist === false) return;
        if (d.initial) return; // стартовое объявление языка, не выбор
        markManual();
      });
    }
    return api;
  };

  // ── conn ───────────────────────────────────────────────────────────────────────────────────────
  // Живость соединения по тишине (T-W1-08, пакет P5). Игра передаёт, как слать ping и когда пришло последнее
  // сообщение; модуль решает, когда пинговать, когда показать «нет связи» и когда закрывать сокет.
  //   тишина > warnMs (10 с)  ->onOffline() один раз, без закрытия (баннер);
  //   тишина > closeMs (22 с) -> onDead() один раз за период тишины (игра закрывает сокет и переподключается);
  //   любое сообщение (api.seen()) -> onOnline(), если было onOffline.
  // Пока вкладка скрыта (document.hidden), тишиной ничего не считается; при возврате отсчёт идёт с этого момента
  // (api.visible()), чтобы не закрывать сокет сразу после разблокировки телефона.
  MP.conn = function (opts) {
    var o = opts || {};
    var setIv = o.setInterval || function (fn, ms) { return root.setInterval(fn, ms); };
    var clearIv = o.clearInterval || function (id) { return root.clearInterval(id); };
    var nowFn = o.now || function () { return Date.now(); };
    var pingGameMs = typeof o.pingGameMs === 'number' ? o.pingGameMs : 5000;
    var pingLobbyMs = typeof o.pingLobbyMs === 'number' ? o.pingLobbyMs : 10000;
    var warnMs = typeof o.warnMs === 'number' ? o.warnMs : 10000;
    var closeMs = typeof o.closeMs === 'number' ? o.closeMs : 22000;
    var tickMs = typeof o.tickMs === 'number' ? o.tickMs : 1000;
    var lastSeen = null, lastPing = null, base = null;
    var offline = false, dead = false, iv = null;

    function isHidden() {
      if (typeof o.hidden === 'function') return !!o.hidden();
      return !!(root.document && root.document.hidden);
    }
    var api = {
      offline: function () { return offline; },
      silentMs: function (now) {
        var n = typeof now === 'number' ? now : nowFn();
        var from = Math.max(lastSeen === null ? -Infinity : lastSeen, base === null ? -Infinity : base);
        return from === -Infinity ? 0 : Math.max(0, n - from);
      },
      // пришло любое сообщение от сервера
      seen: function (now) {
        lastSeen = typeof now === 'number' ? now : nowFn();
        dead = false;
        if (offline) {
          offline = false;
          if (typeof o.onOnline === 'function') o.onOnline();
        }
      },
      // вкладка снова видна: молчание до этого не считаем, сразу пингуем
      visible: function (now) {
        base = typeof now === 'number' ? now : nowFn();
        lastPing = null;
      },
      tick: function (now) {
        if (MP.off) return;
        var n = typeof now === 'number' ? now : nowFn();
        if (base === null && lastSeen === null) base = n;
        if (isHidden()) { base = n; return; }
        var inGame = typeof o.inGame === 'function' ? !!o.inGame() : false;
        var every = inGame ? pingGameMs : pingLobbyMs;
        if (lastPing === null || n - lastPing >= every) {
          lastPing = n;
          if (typeof o.ping === 'function') o.ping();
        }
        var silent = api.silentMs(n);
        if (silent > warnMs && !offline) {
          offline = true;
          if (typeof o.onOffline === 'function') o.onOffline(silent);
        }
        if (silent > closeMs && !dead) {
          dead = true;
          if (typeof o.onDead === 'function') o.onDead(silent);
        }
      },
      start: function () {
        if (MP.off || iv !== null) return false;
        base = nowFn();
        iv = setIv(function () { api.tick(); }, tickMs);
        return true;
      },
      stop: function () {
        if (iv !== null) { clearIv(iv); iv = null; }
        offline = false;
      }
    };
    return api;
  };

  // ── progress ───────────────────────────────────────────────────────────────────────────────────
  // «Ответили 4 из 6 · ~40 с» (T-W1-14, пакет P6, U-29). Знаменатель считает игра (онлайн + уже ответившие);
  // здесь — только строка: done не больше total («4 из 3» не бывает), секунды — «~», шагом 5 с выше 10.
  var PROGRESS_I18N = {
    // wrote/locked — «На одной волне» (T-W3-22): «Написали N из M» (подсказки) и «Зафиксировали N из M» (стрелки)
    ru: { answered: 'Ответили {a} из {b}', voted: 'Проголосовали {a} из {b}', wrote: 'Написали {a} из {b}', locked: 'Зафиксировали {a} из {b}', secs: ' · ~{s} с' },
    en: { answered: '{a} of {b} answered', voted: '{a} of {b} voted', wrote: '{a} of {b} wrote', locked: '{a} of {b} locked in', secs: ' · ~{s} s' },
    el: { answered: 'Απάντησαν {a} από {b}', voted: 'Ψήφισαν {a} από {b}', wrote: 'Έγραψαν {a} από {b}', locked: 'Κλείδωσαν {a} από {b}', secs: ' · ~{s} δ' } //EL:unverified
  };
  function progressLang(lang) {
    if (lang && PROGRESS_I18N[lang]) return lang;
    var l = root.I18N && root.I18N.lang;
    if (l && PROGRESS_I18N[l]) return l;
    return 'ru';
  }
  MP.progress = {
    // opts: {kind: 'answered' | 'voted' (по умолч. 'answered'), lang}
    text: function (done, total, secsLeft, opts) {
      var o = opts || {};
      var d = Math.max(0, Math.floor(Number(done) || 0));
      var tt = Math.max(d, Math.floor(Number(total) || 0));
      var dict = PROGRESS_I18N[progressLang(o.lang)];
      var s = dict[o.kind === 'voted' || o.kind === 'wrote' || o.kind === 'locked' ? o.kind : 'answered'].replace('{a}', d).replace('{b}', tt);
      var left = Number(secsLeft);
      if (isFinite(left) && left > 0) {
        var r = left > 10 ? Math.round(left / 5) * 5 : Math.ceil(left);
        s += dict.secs.replace('{s}', r);
      }
      return s;
    }
  };

  // ── rank ───────────────────────────────────────────────────────────────────────────────────────
  // «Соревновательный» ранг (T-W1-15, пакет P8, U-11/U-15): равные очки — одно место, следующее пропускается
  // (1, 1, 3). Порядок внутри ничьей — только для показа (tiebreak), на место не влияет.
  //   MP.rank(players, {score = 'score' | fn(p), tiebreak(a, b), exclude(p), fallbackAll = true})
  //     -> {list: [{id, player, score, place, tie}], winnerIds, byId: {id: entry}, excluded: [id]}
  //   Не участвуют: left === true и played === false («вошёл после финала»; поле нет = участвует).
  //   Если не играл никто (партия оборвалась в самом начале) — таблица строится по всем не ушедшим.
  //   winnerIds — все с place 1 (ничья за первое место); игры сохраняют и свой winnerId для статистики.
  MP.rank = function (players, opts) {
    var o = opts || {};
    var scoreOf = typeof o.score === 'function' ? o.score : function (p) {
      var v = p[o.score || 'score'];
      return typeof v === 'number' && isFinite(v) ? v : 0;
    };
    var skip = typeof o.exclude === 'function' ? o.exclude : function (p) { return p.left === true || p.played === false; };
    var tb = typeof o.tiebreak === 'function' ? o.tiebreak : function (a, b) {
      var an = String(a.name == null ? '' : a.name), bn = String(b.name == null ? '' : b.name);
      var c = an.localeCompare(bn);
      return c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    };
    var all = (players || []).filter(function (p) { return p && typeof p === 'object'; });
    var kept = all.filter(function (p) { return !skip(p); });
    if (!kept.length && o.fallbackAll !== false) kept = all.filter(function (p) { return p.left !== true; });
    var entries = kept.map(function (p) { return { id: p.id, player: p, score: scoreOf(p), place: 0, tie: false }; });
    entries.sort(function (a, b) { return b.score - a.score || tb(a.player, b.player); });
    for (var i = 0; i < entries.length; i++) {
      entries[i].place = i > 0 && entries[i - 1].score === entries[i].score ? entries[i - 1].place : i + 1;
    }
    for (var j = 0; j < entries.length; j++) {
      var same = (j > 0 && entries[j - 1].place === entries[j].place) || (j + 1 < entries.length && entries[j + 1].place === entries[j].place);
      entries[j].tie = same;
    }
    var byId = {}, winnerIds = [], excluded = [];
    entries.forEach(function (e) { byId[e.id] = e; if (e.place === 1) winnerIds.push(e.id); });
    all.forEach(function (p) { if (!byId[p.id]) excluded.push(p.id); });
    return { list: entries, winnerIds: winnerIds, byId: byId, excluded: excluded };
  };

  // ── vibrate ────────────────────────────────────────────────────────────────────────────────────
  // Вибрация только после жеста (T-W1-16, пакет P11, quip-027): без него Chrome пишет в консоль «Blocked call to
  // navigator.vibrate». Жест: navigator.userActivation.hasBeenActive, а где его нет — наш флаг по первому касанию.
  var gestured = false;
  (function listenGesture() {
    var d = root.document;
    if (!d || !d.addEventListener) return;
    var mark = function () { gestured = true; };
    ['pointerdown', 'touchend', 'keydown', 'click'].forEach(function (t) {
      try { d.addEventListener(t, mark, { capture: true, passive: true }); } catch (e) { /* старый движок */ }
    });
  })();
  MP.vibrate = function (pattern) {
    if (MP.off) return false;
    var nav = root.navigator;
    if (!nav || typeof nav.vibrate !== 'function') return false;
    var ua = nav.userActivation;
    var active = ua && typeof ua.hasBeenActive === 'boolean' ? ua.hasBeenActive : gestured;
    if (!active) return false;
    try { return !!nav.vibrate(pattern); } catch (e) { return false; }
  };

  // ── keyboardClass ──────────────────────────────────────────────────────────────────────────────
  // html.kb, пока экранная клавиатура съела > 120 px высоты (T-W1-16). Меряем от «полной» высоты окна:
  // Chrome с interactive-widget=resizes-content ужимает и layout viewport (innerHeight − vv.height = 0),
  // iOS — только visual viewport. Только класс и CSS-переменная --kb-h (px, на сколько клавиатура ЗАКРЫЛА
  // layout viewport; 0, если он ужался сам) — разметка не пересобирается, фокус поля не теряется.
  MP.keyboardClass = function (opts) {
    var o = opts || {};
    var cls = o.className || 'kb';
    var threshold = typeof o.threshold === 'number' ? o.threshold : 120;
    var vv = root.visualViewport || null;
    var doc = root.document;
    var el = o.element || (doc && doc.documentElement) || null;
    var base = 0, baseW = 0, on = false, stopped = false;

    function update() {
      if (MP.off || stopped) return on;
      var ih = root.innerHeight || 0;
      var vh = vv ? vv.height : ih;
      var off = vv && typeof vv.offsetTop === 'number' ? vv.offsetTop : 0;
      var w = root.innerWidth || 0;
      if (vv && typeof vv.scale === 'number' && vv.scale > 1.05) return on; // щипок-масштаб — не клавиатура
      var seen = Math.max(ih, vh);
      if (!base || w !== baseW) { base = seen; baseW = w; } else if (seen > base) { base = seen; }
      var next = base - vh > threshold;
      var obscured = Math.max(0, ih - (vh + off));
      if (el && el.style && el.style.setProperty) el.style.setProperty('--kb-h', (next ? Math.round(obscured) : 0) + 'px');
      if (next !== on) {
        on = next;
        if (el && el.classList) { if (on) el.classList.add(cls); else el.classList.remove(cls); }
        if (typeof o.onChange === 'function') o.onChange(on);
      }
      return on;
    }
    var api = {
      active: function () { return on; },
      update: update,
      stop: function () {
        stopped = true;
        if (vv && vv.removeEventListener) { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); }
        if (root.removeEventListener) root.removeEventListener('resize', update);
        if (on && el && el.classList) el.classList.remove(cls);
        on = false;
      }
    };
    if (MP.off) return api;
    if (vv && vv.addEventListener) { vv.addEventListener('resize', update); vv.addEventListener('scroll', update); }
    if (root.addEventListener) root.addEventListener('resize', update);
    update();
    return api;
  };

  root.MP = MP;
})(this);
