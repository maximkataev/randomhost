/* Общий код блэкджека для пульта (blackjack.html) и доски (blackjack-board.html):
   транспорт до сервера (WebSocket /blackjack/ws, запасной long-poll /blackjack/api/*), часы сервера,
   карты-пакости, итоги рук словами, общие подписи. Скелет — roulette-shared.js (там же история решений
   по транспорту). Синтаксис — ES2017 (доски в Chromium 80–83): без `?.`, `??`, spread в объектах, .at(). */

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

// ---------- карты-пакости, реакции (то же, что в blackjack/game.js) ----------

const BJ_TRICKS = {
  peek: { icon: "👁️", self: true },
  redeal: { icon: "🔁", self: true },
  shield: { icon: "🛡", self: true },
  freeze: { icon: "❄️", self: false },
  extra: { icon: "🃏", self: false },
  swap: { icon: "🔀", self: false },
  tax: { icon: "🧾", self: false },
  doublemin: { icon: "📈", self: false },
};
const BJ_REACTIONS = ["🔥", "😱", "😂", "👏", "🙏", "💀"];
const BJ_FORMATS = ["last", "hands", "tournament"];

// Подписи, общие для доски и пульта. Страница кладёт свой словарь в I18N_DICT, эти ключи домешиваются до i18n.js.
const BJ_SHARED_I18N = {
  ru: {
    dealer_name: "Марго",
    card_peek: "Подгляд", card_peek_d: "В этой раздаче видишь закрытую карту Марго у себя на телефоне. На экране — только «подглядел».",
    card_redeal: "Пересдача", card_redeal_d: "Один раз после первых двух карт можно заменить обе на две новые из шуза.",
    card_shield: "Щит", card_shield_d: "Сработает сам: отобьёт первую враждебную карту, нацеленную на тебя. Висит, пока не сработает.",
    card_freeze: "Заморозка", card_freeze_d: "Цель в этой раздаче не может брать, удваивать и сплитовать — автоматически «Хватит» на первых двух картах.",
    card_extra: "Лишняя карта", card_extra_d: "После решений цели ей сдаётся ещё одна карта, хочет она того или нет.",
    card_swap: "Обмен", card_swap_d: "После первых двух карт меняешься с целью руками. Решаешь, уже увидев обе руки.",
    card_tax: "Налог", card_tax_d: "Половина выигрыша цели в этой раздаче идёт тебе. Проигрыш не делится.",
    card_doublemin: "Двойной минимум", card_doublemin_d: "Минимум цели в следующей раздаче удвоен. Экран предупредит цель заранее.",
    out_ok: "сыграна", out_shielded: "Щит отбил", out_busy: "цель уже под ударом — карта вернулась", out_gone: "цели больше нет",
    fmt_last: "До последнего", fmt_hands: "{n} раздач", fmt_tournament: "Турнир",
    pace_fast: "быстро", pace_normal: "обычно", pace_slow: "долго",
    pp_mixed: "Пара разных мастей · 5:1", pp_colored: "Пара одного цвета · 10:1", pp_perfect: "Пара одной масти · 25:1",
    tp_flush: "Флеш · 5:1", tp_straight: "Стрит · 10:1", tp_trips: "Тройка · 30:1", tp_straightFlush: "Стрит-флеш · 40:1", tp_suitedTrips: "Тройка одной масти · 100:1",
    res_bust: "Перебор — больше 21", res_push: "Ничья — ставка назад", res_bj: "Блэкджек! Ставка {bet} → +{win}", res_win: "Выигрыш +{n}",
    res_win_dbust: "Марго перебрала — платят всем, кто остался", res_lose: "Минус {n}: у Марго {d}", res_lose_dbj: "У Марго блэкджек — ставка ушла", res_even: "Ровно 1:1: +{n}",
    res_push_bj: "Блэкджек на блэкджек — ничья", res_skip: "Раздача пропущена", res_lose_short: "Минус {n}",
    ins_won: "Страховка сыграла: +{n}", ins_lost: "Страховка сгорела: −{n}",
    side_won: "{box}: {kind} — +{n}",
    ev_level: "Минимум теперь {n}", ev_overtime: "Овертайм: минимум — {p}% от среднего стека",
    ev_card: "{by} → {target}: {card}", ev_card_self: "{by}: {card}", ev_penalty: "{name}: штраф {n}", ev_out: "{name} выбывает",
    ev_allin: "{name} идёт ва-банк", ev_rejoin: "{name}: с другого устройства", ev_cut: "Отсечение: уходит {name}", ev_cut_coin: "Отсечение по жребию: уходит {name}",
    ev_frozen: "{name}: заморозка", ev_swap: "{name} ↔ {target}: обмен руками", ev_tax: "{by} забирает налог у {target}: {n}", ev_cheer: "{name} болеет за {forName}",
    ev_dealer_bj: "Блэкджек Марго", ev_dealer_bust: "Марго перебрала: {v}", ev_dealer_stand: "У Марго {v}",
    err_connect: "Нет связи с сервером, переподключаемся…", conn_quiet: "Нет связи — проверяем…",
    box_main: "Основная", box_pp: "Perfect Pairs", box_tp: "21+3",
  },
  en: {
    dealer_name: "Margot",
    card_peek: "Peek", card_peek_d: "This hand you see Margot's hole card on your phone. The screen only says «peeked».",
    card_redeal: "Redeal", card_redeal_d: "Once, after the first two cards, swap both for two fresh ones from the shoe.",
    card_shield: "Shield", card_shield_d: "Triggers by itself: blocks the first hostile card aimed at you. Stays until it fires.",
    card_freeze: "Freeze", card_freeze_d: "This hand the target can't hit, double or split — automatic «Stand» on the first two cards.",
    card_extra: "Extra card", card_extra_d: "After decisions the target gets one more card, whether they want it or not.",
    card_swap: "Swap", card_swap_d: "After the first two cards you swap hands with the target. You decide having seen both hands.",
    card_tax: "Tax", card_tax_d: "Half of the target's win this hand goes to you. Losses are not shared.",
    card_doublemin: "Double minimum", card_doublemin_d: "The target's minimum next hand is doubled. The screen warns them in advance.",
    out_ok: "played", out_shielded: "Shield blocked it", out_busy: "target already hit — card returned", out_gone: "target is gone",
    fmt_last: "Last one standing", fmt_hands: "{n} hands", fmt_tournament: "Tournament",
    pace_fast: "fast", pace_normal: "normal", pace_slow: "slow",
    pp_mixed: "Mixed pair · 5:1", pp_colored: "Colored pair · 10:1", pp_perfect: "Perfect pair · 25:1",
    tp_flush: "Flush · 5:1", tp_straight: "Straight · 10:1", tp_trips: "Three of a kind · 30:1", tp_straightFlush: "Straight flush · 40:1", tp_suitedTrips: "Suited trips · 100:1",
    res_bust: "Bust — over 21", res_push: "Push — bet returned", res_bj: "Blackjack! Bet {bet} → +{win}", res_win: "Win +{n}",
    res_win_dbust: "Margot busted — everyone standing is paid", res_lose: "Minus {n}: Margot has {d}", res_lose_dbj: "Margot has blackjack — bet gone", res_even: "Even money: +{n}",
    res_push_bj: "Blackjack vs blackjack — push", res_skip: "Hand skipped", res_lose_short: "Minus {n}",
    ins_won: "Insurance paid: +{n}", ins_lost: "Insurance lost: −{n}",
    side_won: "{box}: {kind} — +{n}",
    ev_level: "Minimum is now {n}", ev_overtime: "Overtime: minimum is {p}% of the average stack",
    ev_card: "{by} → {target}: {card}", ev_card_self: "{by}: {card}", ev_penalty: "{name}: penalty {n}", ev_out: "{name} is out",
    ev_allin: "{name} goes all in", ev_rejoin: "{name}: from another device", ev_cut: "Cut: {name} leaves", ev_cut_coin: "Cut by coin toss: {name} leaves",
    ev_frozen: "{name}: frozen", ev_swap: "{name} ↔ {target}: hands swapped", ev_tax: "{by} taxes {target}: {n}", ev_cheer: "{name} cheers for {forName}",
    ev_dealer_bj: "Margot has blackjack", ev_dealer_bust: "Margot busts: {v}", ev_dealer_stand: "Margot has {v}",
    err_connect: "No connection, reconnecting…", conn_quiet: "No connection — checking…",
    box_main: "Main", box_pp: "Perfect Pairs", box_tp: "21+3",
  },
  el: {
    dealer_name: "Μαργκό",
    card_peek: "Ματιά", card_peek_d: "Σε αυτή τη μοιρασιά βλέπεις το κλειστό φύλλο της Μαργκό στο κινητό σου. Στην οθόνη φαίνεται μόνο «κρυφοκοίταξε».",
    card_redeal: "Ξαναμοίρασμα", card_redeal_d: "Μία φορά, μετά τα δύο πρώτα φύλλα, αλλάζεις και τα δύο με δύο νέα από το παπούτσι.",
    card_shield: "Ασπίδα", card_shield_d: "Ενεργοποιείται μόνη της: αποκρούει την πρώτη εχθρική κάρτα εναντίον σου. Μένει μέχρι να δουλέψει.",
    card_freeze: "Πάγωμα", card_freeze_d: "Ο στόχος σε αυτή τη μοιρασιά δεν τραβάει, δεν διπλασιάζει και δεν κάνει σπλιτ — αυτόματο «Στοπ» στα δύο πρώτα φύλλα.",
    card_extra: "Έξτρα φύλλο", card_extra_d: "Μετά τις αποφάσεις ο στόχος παίρνει ένα ακόμα φύλλο, είτε το θέλει είτε όχι.",
    card_swap: "Ανταλλαγή", card_swap_d: "Μετά τα δύο πρώτα φύλλα αλλάζεις χέρια με τον στόχο. Αποφασίζεις έχοντας δει και τα δύο.",
    card_tax: "Φόρος", card_tax_d: "Το μισό κέρδος του στόχου σε αυτή τη μοιρασιά πάει σε σένα. Η απώλεια δεν μοιράζεται.",
    card_doublemin: "Διπλό ελάχιστο", card_doublemin_d: "Το ελάχιστο του στόχου στην επόμενη μοιρασιά διπλασιάζεται. Η οθόνη τον προειδοποιεί.",
    out_ok: "παίχτηκε", out_shielded: "Η ασπίδα την απέκρουσε", out_busy: "ο στόχος έχει ήδη χτυπηθεί — η κάρτα επέστρεψε", out_gone: "ο στόχος δεν υπάρχει πια",
    fmt_last: "Μέχρι τον τελευταίο", fmt_hands: "{n} μοιρασιές", fmt_tournament: "Τουρνουά",
    pace_fast: "γρήγορα", pace_normal: "κανονικά", pace_slow: "αργά",
    pp_mixed: "Μικτό ζευγάρι · 5:1", pp_colored: "Ζευγάρι ίδιου χρώματος · 10:1", pp_perfect: "Τέλειο ζευγάρι · 25:1",
    tp_flush: "Φλος · 5:1", tp_straight: "Κέντα · 10:1", tp_trips: "Τρία όμοια · 30:1", tp_straightFlush: "Φλος κέντα · 40:1", tp_suitedTrips: "Τρία όμοια ίδιου χρώματος · 100:1",
    res_bust: "Κάψιμο — πάνω από 21", res_push: "Ισοπαλία — το ποντάρισμα επιστρέφει", res_bj: "Μπλακτζάκ! Ποντάρισμα {bet} → +{win}", res_win: "Κέρδος +{n}",
    res_win_dbust: "Η Μαργκό κάηκε — πληρώνονται όσοι έμειναν", res_lose: "Μείον {n}: η Μαργκό έχει {d}", res_lose_dbj: "Η Μαργκό έχει μπλακτζάκ — το ποντάρισμα χάθηκε", res_even: "Ακριβώς 1:1: +{n}",
    res_push_bj: "Μπλακτζάκ με μπλακτζάκ — ισοπαλία", res_skip: "Η μοιρασιά παραλείφθηκε", res_lose_short: "Μείον {n}",
    ins_won: "Η ασφάλεια πλήρωσε: +{n}", ins_lost: "Η ασφάλεια χάθηκε: −{n}",
    side_won: "{box}: {kind} — +{n}",
    ev_level: "Το ελάχιστο τώρα είναι {n}", ev_overtime: "Παράταση: ελάχιστο το {p}% της μέσης στοίβας",
    ev_card: "{by} → {target}: {card}", ev_card_self: "{by}: {card}", ev_penalty: "{name}: ποινή {n}", ev_out: "{name} αποκλείεται",
    ev_allin: "{name} πάει all in", ev_rejoin: "{name}: από άλλη συσκευή", ev_cut: "Κόψιμο: φεύγει {name}", ev_cut_coin: "Κόψιμο με κορώνα-γράμματα: φεύγει {name}",
    ev_frozen: "{name}: πάγωμα", ev_swap: "{name} ↔ {target}: ανταλλαγή χεριών", ev_tax: "{by} παίρνει φόρο από {target}: {n}", ev_cheer: "{name} υποστηρίζει {forName}",
    ev_dealer_bj: "Μπλακτζάκ της Μαργκό", ev_dealer_bust: "Η Μαργκό κάηκε: {v}", ev_dealer_stand: "Η Μαργκό έχει {v}",
    err_connect: "Χωρίς σύνδεση, επανασύνδεση…", conn_quiet: "Χωρίς σύνδεση — έλεγχος…",
    box_main: "Κύριο", box_pp: "Perfect Pairs", box_tp: "21+3",
  },
};
(function mergeSharedDict() {
  const d = (window.I18N_DICT = window.I18N_DICT || {});
  for (const lang of Object.keys(BJ_SHARED_I18N)) d[lang] = Object.assign({}, BJ_SHARED_I18N[lang], d[lang] || {});
})();

// Если i18n.js не доехал (блокировщик) — работаем по-русски, а не белым экраном
function bjT(key) {
  if (window.I18N && window.I18N.t) return window.I18N.t(key);
  const d = (window.I18N_DICT || {}).ru || {};
  return key in d ? d[key] : key;
}
const bjTpl = (key, vars) => String(bjT(key)).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
const bjLang = () => (window.I18N && window.I18N.lang) || "ru";
const BJ_NUM_LOCALE = { ru: "ru-RU", en: "en-US", el: "el-GR" };
const bjNum = (n) => Number(n || 0).toLocaleString(BJ_NUM_LOCALE[bjLang()] || "en-US");
// сумма в фишке: 1250 → «1 250», 12500 → «12,5k»
function bjAmount(n) {
  n = Math.round(Number(n) || 0);
  const loc = BJ_NUM_LOCALE[bjLang()] || "en-US";
  if (n >= 10000) return (Math.round(n / 100) / 10).toLocaleString(loc, { maximumFractionDigits: 1 }) + "k";
  return n.toLocaleString(loc);
}
// счёт руки: мягкая — «7 / 17»
function bjHandText(value, soft) {
  if (soft && value <= 21 && value - 10 >= 1) return (value - 10) + " / " + value;
  return String(value);
}
// фишка цвета игрока: --c тело, --cd кант (темнее), --cs пятна на ребре
function bjShade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(k < 1 ? v * k : v + (255 - v) * (k - 1))));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}
function bjLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const c = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * c(n >> 16) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255);
}
function bjChipVars(color) {
  return `--c:${color};--cd:${bjShade(color, 0.55)};--cs:${bjLum(color) > 0.55 ? "#2b2118" : "#fff6e2"}`;
}
// по кодовым точкам, а не по UTF-16: у «😀 Emoji Cat» аватар был «�E»; «Маша (2)» → «М2»
function initials(name) {
  let n = String(name || "?").replace(/^🤖\s*/, "");
  let idx = "";
  const m = n.match(/^(.*\S)\s+\((\d{1,2})\)$/);
  if (m) { n = m[1]; idx = m[2]; }
  const mark = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
  const out = n.split(/\s+/).map((w) => Array.from(w).find((c) => mark.test(c)) || "").join("");
  return (Array.from(out).slice(0, idx ? 1 : 2).join("").toUpperCase() + idx) || "?";
}
// вибро: Chrome пишет [Intervention] в консоль, если вибрировать до первого тапа
function bjBuzz(pattern) {
  try {
    if (typeof navigator === "undefined" || !navigator.vibrate) return false;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
    return !!navigator.vibrate(pattern);
  } catch (e) { return false; }
}

// Итог руки словами (§8 «Марго объясняет»): hand — рука из снимка с result, p — игрок, d — дилер из снимка
function bjResultText(hand, p, d) {
  if (!hand || !hand.result) return "";
  const bet = hand.bet || p.bet || 0;
  const net = Math.max(0, (hand.payout || 0) - bet); // payout — со ставкой; в тексте только чистый выигрыш
  const dv = d ? bjHandText(d.value, d.soft) : "";
  switch (hand.result) {
    case "bj": return bjTpl("res_bj", { bet: bjNum(bet), win: bjNum(net) });
    case "push": return hand.blackjack ? bjT("res_push_bj") : bjT("res_push");
    case "win":
      if (hand.evenMoney) return bjTpl("res_even", { n: bjNum(net) });
      if (d && d.bust) return bjT("res_win_dbust");
      return bjTpl("res_win", { n: bjNum(net) });
    default:
      if (hand.bust) return bjT("res_bust");
      if (d && d.blackjack) return bjT("res_lose_dbj");
      return dv ? bjTpl("res_lose", { n: bjNum(bet), d: dv }) : bjTpl("res_lose_short", { n: bjNum(bet) });
  }
}
// stake — ставка на побочный бокс: r.win приходит со ставкой, показываем чистый выигрыш
function bjSideText(box, r, stake) {
  if (!r || !r.kind) return "";
  return bjTpl("side_won", { box: bjT("box_" + box), kind: bjT(box + "_" + r.kind), n: bjNum(stake ? Math.max(0, r.win - stake) : r.win) });
}
function bjTrickName(card) { return (BJ_TRICKS[card] ? BJ_TRICKS[card].icon + " " : "") + bjT("card_" + card); }

// ---------- часы сервера ----------
// Смещение «сервер − устройство» по самому быстрому ping/pong (RTT/2); пока замера нет — по state.now
const bjClock = { offset: null, rtt: Infinity, at: 0, states: [] };
function bjClockSample(serverT, sentAt) {
  const t = Date.now(), rtt = t - sentAt;
  if (!(rtt >= 0) || typeof serverT !== "number") return;
  if (rtt <= bjClock.rtt || t - bjClock.at > 60000) {
    bjClock.rtt = rtt;
    bjClock.offset = serverT + rtt / 2 - t;
    bjClock.at = t;
  }
}
function bjStateSample(serverNow) {
  if (typeof serverNow !== "number") return;
  bjClock.states.push(serverNow - Date.now());
  if (bjClock.states.length > 12) bjClock.states.shift();
}
function bjOffset() {
  const byState = bjClock.states.length ? Math.max.apply(null, bjClock.states) : 0;
  return bjClock.offset != null ? Math.max(bjClock.offset, byState) : byState;
}
const bjNow = () => Date.now() + bjOffset();

// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------

let bjWsBroken = false;
const BJ_WS_HANDSHAKE_MS = 5000;
const BJ_POLL_FETCH_MS = 28000;
const BJ_PROBE_MS = 3000;

function bjOpenTransport({ code, onMessage, onClose, onOpen, onSendFail, onGone, onQuiet, onHeard, auth }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let closed = false, opened = false, sid = null, ws = null, polling = false, pollAbort = null;
  let lastSeen = 0, beat = null, notified = false, probeTimer = null;
  // MP.conn (mp-common.js): пинг 5 с в игре / 10 с в лобби, баннер после 10 с тишины, переподключение после 22 с
  let mpConn = null, inGame = false, quiet = false;
  // ?h=/&t= — доска с host-токеном и телефон с токеном места не считаются анонимами (лимиты сервера)
  const q = (typeof auth === "function" ? auth() : "") || "";
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
    if (onHeard) onHeard();
    if (m && m.type === "hello" && window.MP && MP.applyHello && !MP.applyHello(m) && mpConn) { startBeat(); }
    if (mpConn) mpConn.seen(lastSeen);
    if (quiet) { quiet = false; if (onQuiet) onQuiet(false); }
    if (m && m.type === "pong") { if (typeof m.c === "number") bjClockSample(m.t, m.c); return; }
    if (m && (m.type === "state" || m.type === "hello") && m.state) {
      bjStateSample(m.state.now);
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
        onOffline: () => { quiet = true; if (onQuiet) onQuiet(true); },
        onOnline: () => { quiet = false; if (onQuiet) onQuiet(false); },
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
      fetch("/blackjack/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
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
    visible() { if (mpConn) mpConn.visible(Date.now()); },
    netOffline() { if (!closed && opened && onQuiet) { quiet = true; onQuiet(true); } },
    probe(ms) {
      if (closed || !opened) return;
      clearTimeout(probeTimer);
      const asked = Date.now();
      ping();
      probeTimer = setTimeout(() => { if (!closed && lastSeen < asked) fireClose(); }, ms || BJ_PROBE_MS);
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
      const res = await timedFetch(`/blackjack/api/session?r=${encodeURIComponent(code)}${q}`, 15000);
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/blackjack/api/poll?sid=${sid}`, BJ_POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (bjWsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/blackjack/ws?r=${encodeURIComponent(code)}${q}`);
    const handshake = setTimeout(() => {
      if (closed || opened || !ws || ws.readyState !== 0) return;
      bjWsBroken = true;
      const dead = ws; ws = null;
      dead.onclose = dead.onmessage = dead.onopen = null;
      try { dead.close(); } catch (e) {}
      startPolling();
    }, BJ_WS_HANDSHAKE_MS);
    ws.onopen = () => { clearTimeout(handshake); opened = true; startBeat(); if (onOpen) onOpen(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } deliver(m); };
    ws.onclose = () => {
      clearTimeout(handshake);
      if (closed) return;
      if (!opened) { ws = null; startPolling(); }
      else fireClose();
    };
    ws.onerror = () => {};
  } catch (e) { startPolling(); }
  return api;
}

// Переподключение с нарастающей паузой: сеть моргнула — вернуться сразу, сервер лежит — не долбить
function bjConnect({ code, onMessage, onOpen, onGone, onState, onSendFail, onQuiet, onHeard, auth }) {
  let t = null, delay = 500, stopped = false;
  const holder = { api: null, send: (m) => holder.api && holder.api.send(m), stop() { stopped = true; clearTimeout(t); if (holder.api) holder.api.close(); } };
  const open = () => {
    if (stopped) return;
    if (onState) onState("connecting");
    holder.api = bjOpenTransport({
      code, onMessage, onQuiet, onHeard, auth,
      onOpen: () => { delay = 500; if (onState) onState("open"); if (onOpen) onOpen(); },
      onClose: () => { if (stopped) return; if (onState) onState("lost"); t = setTimeout(() => { t = null; open(); }, delay); delay = Math.min(delay * 2, 8000); },
      onGone: () => { stopped = true; if (onGone) onGone(); },
      onSendFail,
    });
  };
  open();
  const wake = () => { if (holder.api && holder.api.mode !== "none") holder.api.probe(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { if (holder.api && holder.api.visible) holder.api.visible(); wake(); } });
  window.addEventListener("online", () => {
    // сеть вернулась: не ждём нарастающую паузу, открываем сокет сразу
    if (t && !stopped) { clearTimeout(t); t = null; delay = 500; open(); } else wake();
  });
  window.addEventListener("offline", () => { if (holder.api && holder.api.netOffline) holder.api.netOffline(); });
  return holder;
}
