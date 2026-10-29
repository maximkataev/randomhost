/* Общий код «Позывного» для пульта (callsign.html) и доски (callsign-board.html):
   транспорт до сервера, часы сервера, подписи на трёх языках, звуки, карточки поля.
   Транспорт и часы перенесены из wave-shared.js (а туда — из fibs-shared.js и bomb/roulette/auction): там подробная история решений. */


// iOS 12–13 не знает replaceChildren
(function () {
  function replaceChildren() {
    while (this.lastChild) this.removeChild(this.lastChild);
    if (arguments.length) this.append.apply(this, arguments);
  }
  [window.Element, window.Document, window.DocumentFragment].forEach(function (C) {
    if (C && C.prototype && !C.prototype.replaceChildren) C.prototype.replaceChildren = replaceChildren;
  });
})();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- подписи, общие для доски и пульта ----------
// Страница кладёт свой словарь в I18N_DICT, эти ключи домешиваются туда до загрузки i18n.js.

function csT(key) {
  if (window.I18N && window.I18N.t) return window.I18N.t(key);
  const d = (window.I18N_DICT || {}).ru || {};
  return key in d ? d[key] : key;
}
const csTpl = (key, vars) => String(csT(key)).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const csLang = () => (window.I18N && window.I18N.lang) || "ru";
const csSec = (ms) => String(Math.round(Math.max(0, ms) / 100) / 10).replace(".", csLang() === "en" ? "." : ",");
// число + слово: ru — 1 очко, 2–4 очка, 5–20 очков (11–14 — «очков»); en/el — один/много
function csPlural(n, forms) {
  const f = Array.isArray(forms) ? forms : [String(forms)];
  const a = Math.abs(Math.round(Number(n) || 0));
  if (f.length >= 3) {
    const m10 = a % 10, m100 = a % 100;
    return m10 === 1 && m100 !== 11 ? f[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? f[1] : f[2];
  }
  return a === 1 ? f[0] : f[f.length - 1];
}
// имена через запятую — именительный падеж, не склоняем
const csNames = (ids, player) => ids.map((id) => (player(id) || {}).name || "?").join(", ");

// ---------- место под переключатель языка ----------
// i18n.js ставит его fixed в правый верхний угол, а ширина у него своя на каждом экране и языке.
// Меряем: --lsw — отступ от правого края до его левой кромки (шапка на него не заезжает), --lsc/--lsh — его центр и высота.
(function reserveLangSwitch() {
  let seen = null;
  const measure = () => {
    const sw = document.querySelector(".lang-switch");
    if (!sw) return false;
    const r = sw.getBoundingClientRect();
    if (r.width) {
      const root = document.documentElement.style;
      root.setProperty("--lsw", Math.ceil(window.innerWidth - r.left + 10) + "px");
      // центр и высота переключателя: кнопка звука встаёт с ним на одну линию и той же высоты
      // страница может сделать переключатель absolute (wave.html: уезжает вместе с шапкой) — тогда считаем от верха документа
      const scrolled = getComputedStyle(sw).position === "absolute" ? (window.pageYOffset || 0) : 0;
      root.setProperty("--lsc", Math.round(r.top + scrolled + r.height / 2) + "px");
      root.setProperty("--lsh", Math.round(r.height) + "px");
    }
    if (sw !== seen && window.ResizeObserver) { seen = sw; new ResizeObserver(measure).observe(sw); }
    return true;
  };
  const poll = (n) => { if (!measure() && n < 200) requestAnimationFrame(() => poll(n + 1)); };
  poll(0);
  window.addEventListener("resize", measure);
  window.addEventListener("langchange", () => requestAnimationFrame(measure));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
})();

// ---------- вибрация: не везде есть, а где есть — может бросить исключение ----------
function csVibrate(p) { if (navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} }

// ---------- часы сервера ----------
// Смещение «сервер − устройство» по самому быстрому ping/pong (RTT/2); пока замера нет —
// по state (у него задержка только прибавляется, поэтому берём наибольший из недавних).
const csClock = { offset: null, rtt: Infinity, at: 0, states: [] };
function csClockSample(serverT, sentAt) {
  const t = Date.now(), rtt = t - sentAt;
  if (!(rtt >= 0) || typeof serverT !== "number") return;
  if (rtt <= csClock.rtt || t - csClock.at > 60000) {
    csClock.rtt = rtt;
    csClock.offset = serverT + rtt / 2 - t;
    csClock.at = t;
  }
}
function csStateSample(serverNow) {
  if (typeof serverNow !== "number") return;
  csClock.states.push(serverNow - Date.now());
  if (csClock.states.length > 12) csClock.states.shift();
}
function csOffset() {
  const byState = csClock.states.length ? Math.max.apply(null, csClock.states) : 0;
  return csClock.offset != null ? Math.max(csClock.offset, byState) : byState;
}
const csNow = () => Date.now() + csOffset();

// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------

let csWsBroken = false;
const BM_WS_HANDSHAKE_MS = 5000;
const BM_POLL_FETCH_MS = 28000;
const BM_PROBE_MS = 3000;

function csOpenTransport({ code, onMessage, onClose, onOpen, onSendFail, onGone, onQuiet }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let closed = false, opened = false, sid = null, ws = null, polling = false, pollAbort = null;
  let lastSeen = 0, beat = null, notified = false, probeTimer = null;
  // MP.conn (mp-common.js, T-W2-03): пинг 5 с в игре / 10 с в лобби, баннер «нет связи» после 10 с тишины,
  // закрытие и переподключение после 22 с. Без mp-common.js (или при MP.off) — прежний цикл ниже (20 с / 45 с).
  let mpConn = null, inGame = false;
  const stopBeat = () => { if (beat) { clearInterval(beat); beat = null; } if (mpConn) { mpConn.stop(); mpConn = null; } clearTimeout(probeTimer); probeTimer = null; };
  const fireClose = () => {
    if (closed || notified) return;
    notified = true;
    stopBeat();
    closed = true;
    try { if (ws) ws.close(); } catch (e) {}
    try { if (pollAbort) pollAbort.abort(); } catch (e) {}
    sid = null;
    if (onClose) onClose();
  };
  const ping = () => api.send({ type: "ping", c: Date.now() });
  const deliver = (m) => {
    if (closed) return;
    lastSeen = Date.now();
    // сервер выключил каркас (MP_OFF=1): возвращаемся к прежнему циклу пингов
    if (m && m.type === "hello" && window.MP && MP.applyHello && !MP.applyHello(m) && mpConn) startBeat();
    if (mpConn) mpConn.seen(lastSeen);
    if (m && m.type === "pong") { if (typeof m.c === "number") csClockSample(m.t, m.c); return; }
    if (m && (m.type === "state" || m.type === "hello") && m.state) {
      csStateSample(m.state.serverNow);
      inGame = !!m.state.phase && m.state.phase !== "lobby" && m.state.phase !== "finished";
    }
    onMessage(m);
  };
  const startBeat = () => {
    stopBeat();
    lastSeen = Date.now();
    ping(); setTimeout(ping, 400); setTimeout(ping, 1500);
    if (window.MP && typeof MP.conn === "function" && !MP.off) {
      mpConn = MP.conn({
        ping: () => { if (!closed) ping(); },
        inGame: () => inGame,
        onOffline: () => { if (onQuiet) onQuiet(true); },
        onOnline: () => { if (onQuiet) onQuiet(false); },
        onDead: () => fireClose(),
      });
      mpConn.start();
      return;
    }
    beat = setInterval(() => {
      if (closed) return stopBeat();
      if (Date.now() - lastSeen > 45000) { fireClose(); return; }
      ping();
    }, 20000);
  };
  const api = {
    send(msg, attempt) {
      if (closed) { if (onSendFail && msg && msg.type !== "ping") onSendFail(msg); return; }
      if (ws && ws.readyState === 1) return ws.send(JSON.stringify(msg));
      if (!sid) { if (onSendFail && msg && msg.type !== "ping") onSendFail(msg); return; }
      const tries = attempt || 0;
      fetch("/callsign/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
        .then((r) => {
          if (r.ok || r.status === 410) return;
          if (tries < 2) setTimeout(() => api.send(msg, tries + 1), 400 * (tries + 1));
          else if (onSendFail) onSendFail(msg);
        })
        .catch(() => {
          if (tries < 2) setTimeout(() => api.send(msg, tries + 1), 400 * (tries + 1));
          else if (onSendFail) onSendFail(msg);
        });
    },
    close() { closed = true; stopBeat(); try { if (ws) ws.close(); } catch (e) {} try { if (pollAbort) pollAbort.abort(); } catch (e) {} sid = null; },
    // вкладка снова видна: тишину, пока она была скрыта, MP.conn не считает
    visible() { if (mpConn) mpConn.visible(Date.now()); },
    probe(ms) {
      if (closed || !opened) return;
      clearTimeout(probeTimer);
      const asked = Date.now();
      ping();
      probeTimer = setTimeout(() => { if (!closed && lastSeen < asked) fireClose(); }, ms || BM_PROBE_MS);
    },
    get mode() {
      if (closed) return "none";
      if (ws && ws.readyState === 1) return "ws";
      if (ws && ws.readyState === 0) return "connecting";
      if (sid) return "poll";
      if (polling) return "connecting";
      return "none";
    },
  };
  const timedFetch = (url, ms) => {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    pollAbort = ctl;
    const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).finally(() => clearTimeout(t));
  };
  async function startPolling() {
    if (closed || polling) return;
    polling = true;
    try {
      const res = await timedFetch(`/callsign/api/session?r=${encodeURIComponent(code)}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/callsign/api/poll?sid=${sid}`, BM_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (csWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/callsign/ws?r=${encodeURIComponent(code)}`);
    const handshake = setTimeout(() => {
      if (closed || opened || !ws || ws.readyState !== 0) return;
      csWsBroken = true;
      const dead = ws; ws = null;
      dead.onclose = dead.onmessage = dead.onopen = null;
      try { dead.close(); } catch (e) {}
      startPolling();
    }, BM_WS_HANDSHAKE_MS);
    ws.onopen = () => { clearTimeout(handshake); opened = true; startBeat(); if (onOpen) onOpen(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } deliver(m); };
    ws.onclose = (e) => {
      clearTimeout(handshake);
      if (closed) return;
      // комнаты нет (404 на рукопожатии не видно из браузера) — это выяснит опрос сессии
      if (!opened) { ws = null; startPolling(); }
      else fireClose();
    };
    ws.onerror = () => {};
  } catch (e) { startPolling(); }
  return api;
}

// Потолок возраста действия в очереди — по ТИПУ (MP.sendQueue). Раньше было общие 6 с и «просрочено»;
// теперь решает keep(m) страницы: тап по карточке и «Хватит» актуальны, пока не сменился ход (keep страницы). Потолок страхует от залежавшегося.
const CS_QUEUE_CEILING_MS = { "*": 90000 };

// Переподключение с нарастающей паузой: сеть моргнула — вернуться сразу, сервер лежит — не долбить
function csConnect({ code, onMessage, onOpen, onGone, onState, onDrop, onQuiet }) {
  let t = null, delay = 500, stopped = false;
  // Действие, нажатое между обрывом и возвращением связи, раньше терялось молча (а кнопка уже горела «ушло»).
  // Теперь оно ждёт в очереди MP.sendQueue и уходит после входа по токену: сокет без игрока действие бы отбросил.
  // Если общего каркаса нет (аварийный выключатель mp-off) — очереди нет: действие без связи сразу «не дошло».
  const queue = window.MP && MP.sendQueue ? MP.sendQueue({
    send: (m) => { if (holder.api) holder.api.send(m); },
    onDrop: (m, why, at) => { if (onDrop) onDrop(m, why, at); },
    ceilingMs: CS_QUEUE_CEILING_MS,
    replace: ["clue"], // подсказка: свежее заменяет прежнее, а не копится рядом
    max: 8,
    minGapMs: 250,
    probe: (ms) => { if (holder.api) holder.api.probe(ms); },
  }) : null;
  const enqueue = (m) => {
    if (queue) return queue.push(m);
    if (onDrop) onDrop(m, "off", Date.now());
    return false;
  };
  const holder = {
    api: null,
    onDrop,
    queue,
    gated: false, // страница держит действия до входа по токену и сама снимает флаг через flush
    send(m) {
      const a = holder.api;
      // пока очередь разгребается (шаг 4/с), новое действие встаёт за ней: порядок не нарушаем
      if (m && m.type !== "ping" && m.type !== "join" && m.type !== "host" && (holder.gated || !a || a.mode === "none" || a.mode === "connecting" || (queue && queue.isFlushing()))) {
        enqueue(m);
        return;
      }
      if (a) a.send(m);
    },
    // keep(m) — нужно ли это действие ещё; ненужные и залежавшиеся отбрасываются через onDrop
    flush(keep, dropFn) {
      holder.gated = false;
      if (queue) queue.flush(keep, dropFn);
    },
    // «тишина»: проверить, жив ли сокет (страница зовёт, когда кнопка отпущена без ответа)
    probe(ms) { if (holder.api && holder.api.mode !== "none") holder.api.probe(ms); },
    stop() { stopped = true; clearTimeout(t); if (queue) queue.clear(); if (holder.api) holder.api.close(); },
  };
  const open = () => {
    if (stopped) return;
    if (onState) onState("connecting");
    holder.api = csOpenTransport({
      code,
      onQuiet,
      onMessage: (m) => { if (queue) queue.heard(); onMessage(m); },
      // отправка не удалась после повторов (long-polling): не теряем, а ставим в очередь до входа по токену
      onSendFail: (m) => { if (stopped || !m || m.type === "join" || m.type === "host") return; enqueue(m); },
      onOpen: () => { delay = 500; if (onState) onState("open"); if (onOpen) onOpen(); },
      onClose: () => { if (stopped) return; if (onState) onState("lost"); t = setTimeout(open, delay); delay = Math.min(delay * 2, 8000); },
      onGone: () => { stopped = true; if (onGone) onGone(); },
    });
  };
  open();
  // вернулись в вкладку или сеть появилась — проверяем, жив ли сокет, не дожидаясь 45 с тишины
  const wake = () => { if (holder.api && holder.api.mode !== "none") holder.api.probe(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { if (holder.api && holder.api.visible) holder.api.visible(); wake(); } });
  window.addEventListener("online", wake);
  return holder;
}



// ---------- «Позывной»: подписи, цвета, звуки, карточки поля ----------

const CS_SHARED_I18N = {
  ru: {
    game_name: "Позывной",
    team_red: "Красные", team_blue: "Синие",
    turn_of: "Ход: {team}", starts: "Начинают: {team}", win_of: "Победа: {team}",
    captain: "Капитан", ops: "Оперативники", cap_short: "капитан",
    left_n: "осталось {n}",
    clue_wait: "Капитан придумывает подсказку", clue_for: "{n} {w}", words_w: ["слово", "слова", "слов"],
    off_note: "нет связи", err_connect: "Нет связи с сервером, переподключаемся…", conn_lost: "Нет связи — проверяем…",
    mode_words: "Слова", mode_pics: "Картинки",
    end_cleared: "Все слова команды открыты", end_assassin: "Открыта ловушка", end_few: "В команде никого не осталось", end_host: "Ведущий закончил партию",
    aw_sniper: "Снайпер", aw_sniper_d: "своих открыл: {n}", aw_oops: "Рисковая рука", aw_oops_d: "промахов: {n}",
    aw_trap: "Попал в ловушку", aw_clue: "Лучшая подсказка", aw_clue_d: "«{word}» — {n} {w}",
    pts_you: "Это ты!",
    snail: "не успел",
    log_noclue: "не успели с подсказкой",
    end_t_limit: "открыли всё, что назвали", end_t_neutral: "промах: пустая карточка", end_t_enemy: "промах: карточка соперников",
    end_t_stop: "остановились сами", end_t_time: "время вышло", end_t_noclue: "капитан не успел с подсказкой", end_t_skip: "пропущен ведущим",
    cap_change_offline: "Капитан {team}: теперь {name} — прежний пропал со связи", cap_change_left: "Капитан {team}: теперь {name} — прежний ушёл",
    pause_t: "Пауза", pause_d: "Три хода подряд прошли впустую. Вы ещё здесь?", btn_resume: "Играем!",
  },
  en: {
    game_name: "Callsign",
    team_red: "Red", team_blue: "Blue",
    turn_of: "Turn: {team}", starts: "{team} start", win_of: "{team} win",
    captain: "Captain", ops: "Operatives", cap_short: "captain",
    left_n: "{n} left",
    clue_wait: "The captain is thinking of a clue", clue_for: "{n} {w}", words_w: ["word", "words"],
    off_note: "offline", err_connect: "No connection, reconnecting…", conn_lost: "No signal — checking…",
    mode_words: "Words", mode_pics: "Pictures",
    end_cleared: "All of the team's words are open", end_assassin: "The trap was opened", end_few: "Nobody is left in the team", end_host: "The host ended the game",
    aw_sniper: "Sharpshooter", aw_sniper_d: "own cards opened: {n}", aw_oops: "Bold Hand", aw_oops_d: "misses: {n}",
    aw_trap: "Walked into the trap", aw_clue: "Best clue", aw_clue_d: "“{word}” — {n} {w}",
    pts_you: "That's you!",
    snail: "too slow",
    log_noclue: "ran out of time for a clue",
    end_t_limit: "opened everything they named", end_t_neutral: "miss: a blank card", end_t_enemy: "miss: a rival's card",
    end_t_stop: "stopped on their own", end_t_time: "time ran out", end_t_noclue: "the captain ran out of time", end_t_skip: "skipped by the host",
    cap_change_offline: "{team} captain: now {name} — the previous one lost connection", cap_change_left: "{team} captain: now {name} — the previous one left",
    pause_t: "Paused", pause_d: "Three turns in a row went by empty. Still here?", btn_resume: "Let's play!",
  },
  el: {
    game_name: "Σήμα",
    team_red: "Κόκκινοι", team_blue: "Μπλε",
    turn_of: "Σειρά: {team}", starts: "Ξεκινούν: {team}", win_of: "Νίκη: {team}",
    captain: "Αρχηγός", ops: "Πράκτορες", cap_short: "αρχηγός",
    left_n: "μένουν {n}",
    clue_wait: "Ο αρχηγός σκέφτεται υπόδειξη", clue_for: "{n} {w}", words_w: ["λέξη", "λέξεις"],
    off_note: "εκτός σύνδεσης", err_connect: "Χωρίς σύνδεση, επανασύνδεση…", conn_lost: "Χωρίς σήμα — έλεγχος…",
    mode_words: "Λέξεις", mode_pics: "Εικόνες",
    end_cleared: "Άνοιξαν όλες οι λέξεις της ομάδας", end_assassin: "Άνοιξε η παγίδα", end_few: "Δεν έμεινε κανείς στην ομάδα", end_host: "Ο οικοδεσπότης τερμάτισε",
    aw_sniper: "Ελεύθερος σκοπευτής", aw_sniper_d: "άνοιξε δικές του: {n}", aw_oops: "Τολμηρό χέρι", aw_oops_d: "λάθη: {n}",
    aw_trap: "Έπεσε στην παγίδα", aw_clue: "Καλύτερη υπόδειξη", aw_clue_d: "«{word}» — {n} {w}",
    pts_you: "Εσύ είσαι!",
    snail: "άργησε",
    log_noclue: "δεν πρόλαβαν να δώσουν υπόδειξη",
    end_t_limit: "άνοιξαν όσα είπαν", end_t_neutral: "λάθος: κενή κάρτα", end_t_enemy: "λάθος: κάρτα αντιπάλων",
    end_t_stop: "σταμάτησαν μόνοι τους", end_t_time: "τέλος χρόνου", end_t_noclue: "ο αρχηγός δεν πρόλαβε", end_t_skip: "παραλείφθηκε από τον οικοδεσπότη",
    cap_change_offline: "Αρχηγός {team}: τώρα {name} — ο προηγούμενος έχασε τη σύνδεση", cap_change_left: "Αρχηγός {team}: τώρα {name} — ο προηγούμενος έφυγε",
    pause_t: "Παύση", pause_d: "Τρεις γύροι στη σειρά πέρασαν άδειοι. Είστε ακόμα εδώ;", btn_resume: "Παίζουμε!",
  },
};
(function mergeSharedDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const lang of Object.keys(CS_SHARED_I18N)) d[lang] = Object.assign({}, CS_SHARED_I18N[lang], d[lang] || {});
})();

const CS_RED = "#ff4a3d";
const CS_BLUE = "#2f9bff";
const CS_INK = "#111";
const csTeamColor = (t) => (t === "red" ? CS_RED : CS_BLUE);
const csTeamName = (t) => csT(t === "red" ? "team_red" : "team_blue");
const csOther = (t) => (t === "red" ? "blue" : "red");
const csWords = (n) => csPlural(n, csT("words_w"));
const csEndText = (reason) => { const k = "end_t_" + reason; const v = csT(k); return v === k ? reason : v; };
// «капитан сменился»: понятная фраза для табло и телефонов
const csCapText = (cc, nameOf) => csTpl(cc.reason === "left" ? "cap_change_left" : "cap_change_offline", { team: csTeamName(cc.team), name: nameOf(cc.playerId) });

// ---------- звуки: короткий синтез без файлов (всё идёт в ctx.destination — sound-toggle.js глушит общим выключателем) ----------
const csSfx = (function () {
  let ctx = null, noise = null;
  function ac() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume().catch(() => {}); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  ["pointerdown", "keydown"].forEach((t) => window.addEventListener(t, () => ac(), { passive: true, capture: true }));
  function env(g, t, a, d, v) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function tone(f0, f1, at, dur, type, vol) {
    const c = ac(); if (!c || c.state !== "running") return;
    const t = c.currentTime + at;
    const o = c.createOscillator(); o.type = type || "sine";
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); o.connect(g); g.connect(c.destination); env(g, t, 0.004, dur, vol);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function hiss(at, dur, vol, type, f, q, attack) {
    const c = ac(); if (!c || c.state !== "running" || !noise) return;
    const t = c.currentTime + at;
    const s = c.createBufferSource(); s.buffer = noise;
    const fl = c.createBiquadFilter(); fl.type = type || "bandpass"; fl.frequency.value = f || 2500; fl.Q.value = q || 1.2;
    const g = c.createGain(); s.connect(fl); fl.connect(g); g.connect(c.destination); env(g, t, attack || 0.002, dur, vol);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  return {
    tick(hot) { tone(hot ? 1500 : 1200, hot ? 1400 : 1100, 0, 0.03, "square", hot ? 0.06 : 0.035); },
    tap() { tone(700, 900, 0, 0.03, "triangle", 0.08); },
    send() { tone(660, 990, 0, 0.08, "triangle", 0.14); tone(990, 1320, 0.07, 0.1, "triangle", 0.1); },
    // шторка смены хода
    whoosh() { hiss(0, 0.32, 0.28, "bandpass", 900, 0.6, 0.12); },
    // подсказка пришла: короткий «дзынь» из двух нот
    clue() { tone(880, 880, 0, 0.14, "triangle", 0.16); tone(1318, 1318, 0.1, 0.22, "triangle", 0.14); },
    // своя карточка: восходящий щелчок
    good() { tone(523, 784, 0, 0.1, "triangle", 0.16); tone(784, 1046, 0.08, 0.14, "triangle", 0.14); hiss(0, 0.04, 0.2, "highpass", 5000, 0.7, 0.001); },
    // нейтральная: глухой шлёп
    neutral() { tone(220, 150, 0, 0.12, "triangle", 0.14); hiss(0, 0.06, 0.12, "lowpass", 800, 0.7, 0.001); },
    // чужая: «womp»
    foe() { tone(330, 300, 0, 0.18, "sawtooth", 0.09); tone(250, 170, 0.18, 0.4, "sawtooth", 0.11); },
    // ловушка: низкий удар и шипение
    boom() { tone(90, 40, 0, 0.7, "sine", 0.5); tone(70, 35, 0, 0.9, "sawtooth", 0.08); hiss(0, 0.8, 0.3, "lowpass", 600, 0.8, 0.003); },
    // «твой ход»: два быстрых восходящих тона
    turn() { tone(660, 660, 0, 0.09, "triangle", 0.16); tone(990, 990, 0.1, 0.16, "triangle", 0.16); },
    fanfare() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, f, i * 0.1, 0.18, "triangle", 0.16)); },
    buzz() { tone(140, 120, 0, 0.22, "sawtooth", 0.12); },
  };
})();

// ---------- карточки поля (общие для доски и телефона) ----------
const CS_PICS = "/callsign/pics/";
const csPicUrl = (id) => CS_PICS + encodeURIComponent(id) + ".svg";

// card — элемент state.board; i — индекс. Слово или картинка; цвет (data-t) есть только у открытых и у капитанов.
// tag: "button" на телефоне (тап), "div" на доске.
function csTileHtml(card, i, tag) {
  const face = card.w !== undefined
    ? `<span class="w">${escapeHtml(String(card.w).toUpperCase())}</span>`
    : `<img src="${csPicUrl(card.p)}" alt="" draggable="false">`;
  const t = card.t ? ` data-t="${card.t}"` : "";
  const open = card.o ? "1" : "0";
  const att = tag === "button" ? ` type="button"` : "";
  return `<${tag} class="tile" data-i="${i}" data-o="${open}"${t}${att}><span class="face">${face}</span></${tag}>`;
}

// слово вписывается в плитку: кегль от высоты, потом — пока не влезет; не помогло — сжимаем гарнитуру (wdth);
// и если даже так не влезло (длинное слово на узкой плитке) — переносим на две строки: «ПРИКЛЮ-/ЧЕНИЕ»
function csFitWord(w, face, startFs, minFs, baseWd) {
  const word = w.dataset.word || (w.dataset.word = w.textContent);
  w.textContent = word;
  w.style.whiteSpace = "";
  w.style.lineHeight = "";
  let fs = startFs;
  w.style.fontSize = fs + "px";
  w.style.fontStretch = "";
  w.style.fontVariationSettings = "";
  const room = face.clientWidth * 0.92;
  const over = () => w.scrollWidth > room;
  let guard = 0;
  while (fs > minFs && over() && guard++ < 80) { fs -= 0.5; w.style.fontSize = fs + "px"; }
  let wd = baseWd || 100;
  guard = 0;
  while (over() && wd > 35 && guard++ < 30) { wd -= 4; w.style.fontStretch = wd + "%"; w.style.fontVariationSettings = `"wdth" ${wd}`; }
  if (!over()) return;
  // перенос: ближе к середине, после гласной (так читается как слоговой)
  const chars = Array.from(word);
  const n = chars.length;
  if (n < 6) return;
  const vow = /[аеёиоуыэюяaeiouyαεηιοωυάέήίόώύ]/i;
  let at = Math.round(n / 2);
  for (let d = 0; d <= Math.floor(n / 4); d++) {
    const cand = [at - d, at + d].find((k) => k >= 3 && k <= n - 3 && vow.test(chars[k - 1]) && !vow.test(chars[k]));
    if (cand) { at = cand; break; }
  }
  w.innerHTML = escapeHtml(chars.slice(0, at).join("")) + "-<br>" + escapeHtml(chars.slice(at).join(""));
  w.style.whiteSpace = "nowrap";
  w.style.lineHeight = "1.05";
  w.style.fontStretch = (baseWd || 100) + "%";
  w.style.fontVariationSettings = `"wdth" ${baseWd || 100}`;
  fs = Math.min(startFs, Math.round(face.clientHeight * 0.3));
  w.style.fontSize = fs + "px";
  guard = 0;
  while (fs > 8 && (w.scrollWidth > room || w.scrollHeight > face.clientHeight * 0.9) && guard++ < 60) { fs -= 0.5; w.style.fontSize = fs + "px"; }
}
