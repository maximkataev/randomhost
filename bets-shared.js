"use strict";

/*
 * Общий код клиентов «Ставок» (телефон и доска): подписи рынков, группы, форматирование, палитра.
 * Контракт — docs/bets-protocol.md. Подписи героев сцен (собаки, команды, бойцы) приходят с сервера в ev.meta.
 * Язык берётся из аргумента `lang` ("ru" | "en" | "el"), по умолчанию — из <html lang>.
 */
(function (root) {
  const LANG = () => (root.document && root.document.documentElement.lang || "ru").slice(0, 2);
  const pick = (d, lang) => d[lang] || d.ru;

  const W = {
    ru: { big: "Больше", small: "Меньше", odd: "Нечёт", even: "Чёт", has: "Выпадет", sum: "Сумма", triple: "Любая тройка", top2: "Топ-2", last: "Последняя", then: "затем", win: "Победа", over: "Больше", under: "Меньше",
      score: "Счёт", both3: "Обе забьют ≥ 3", post: "Будет штанга", scores: "забьёт", margin: "с перевесом 9+", comeback: "камбэк", target: "Долетит до", instant: "Взрыв на старте",
      up: "Выше", down: "Ниже", bothUp: "Обе вверх", bothDown: "Обе вниз", mixed: "Разошлись", beats: "сильнее", gap: "обгонит на", tie: "Поровну", more: "Больше", first: "Первой", digit: "Цифра", num: "Цифра", letter: "Буква", dollars: "$" },
    en: { big: "Big", small: "Small", odd: "Odd", even: "Even", has: "Shows", sum: "Total", triple: "Any triple", top2: "Top 2", last: "Last", then: "then", win: "Win", over: "Over", under: "Under",
      score: "Score", both3: "Both score ≥ 3", post: "Hits the post", scores: "scores", margin: "by 9+", comeback: "comeback", target: "Reaches", instant: "Crash at launch",
      up: "Up", down: "Down", bothUp: "Both up", bothDown: "Both down", mixed: "Split", beats: "outperforms", gap: "leads by", tie: "Tie", more: "More", first: "First", digit: "Digit", num: "Digit", letter: "Letter", dollars: "$" },
    el: { big: "Μεγάλο", small: "Μικρό", odd: "Μονό", even: "Ζυγό", has: "Θα φέρει", sum: "Άθροισμα", triple: "Οποιαδήποτε τριάδα", top2: "Top 2", last: "Τελευταίο", then: "μετά", win: "Νίκη", over: "Πάνω από", under: "Κάτω από",
      score: "Σκορ", both3: "Και οι δύο ≥ 3", post: "Δοκάρι", scores: "σκοράρει", margin: "με διαφορά 9+", comeback: "ανατροπή", target: "Φτάνει", instant: "Έκρηξη στην αρχή",
      up: "Πάνω", down: "Κάτω", bothUp: "Και τα δύο πάνω", bothDown: "Και τα δύο κάτω", mixed: "Αντίθετα", beats: "ξεπερνά", gap: "προηγείται κατά", tie: "Ισοπαλία", more: "Περισσότερα", first: "Πρώτο", digit: "Ψηφίο", num: "Ψηφίο", letter: "Γράμμα", dollars: "$" },
  };

  const TYPES = {
    dice: { icon: "🎲", title: { ru: "Кости", en: "Dice", el: "Ζάρια" } },
    dogs: { icon: "🐕", title: { ru: "Собачьи бега", en: "Greyhounds", el: "Κυνοδρομίες" } },
    rocket: { icon: "🚀", title: { ru: "Ракета", en: "Rocket", el: "Πύραυλος" } },
    penalties: { icon: "⚽", title: { ru: "Серия пенальти", en: "Penalty shootout", el: "Σειρά πέναλτι" } },
    rope: { icon: "💪", title: { ru: "Канат", en: "Tug of war", el: "Διελκυστίνδα" } },
    btc: { icon: "₿", title: { ru: "Биткоин: выше или ниже", en: "Bitcoin: up or down", el: "Bitcoin: πάνω ή κάτω" } },
    btceth: { icon: "₿", title: { ru: "BTC против ETH", en: "BTC vs ETH", el: "BTC εναντίον ETH" } },
    news: { icon: "📰", title: { ru: "Кто первый в новостях", en: "First in the news", el: "Πρώτο στις ειδήσεις" } },
    emoji: { icon: "😂", title: { ru: "Эмодзи-дуэль", en: "Emoji duel", el: "Μονομαχία emoji" } },
    wikiduel: { icon: "📚", title: { ru: "Википедия-дуэль", en: "Wikipedia duel", el: "Μονομαχία Wikipedia" } },
    wikiedit: { icon: "✏️", title: { ru: "Правка в Википедии", en: "Wikipedia edit", el: "Επεξεργασία Wikipedia" } },
    whales: { icon: "🐋", title: { ru: "Киты в мемпуле", en: "Mempool whales", el: "Φάλαινες στο mempool" } },
    lightning: { icon: "⚡", title: { ru: "Молнии", en: "Lightning", el: "Αστραπές" } },
    airport: { icon: "✈️", title: { ru: "Аэропорт-дуэль", en: "Airport duel", el: "Μονομαχία αεροδρομίων" } },
    lang: { icon: "🌐", title: { ru: "Язык следующего поста", en: "Language of the next post", el: "Γλώσσα επόμενης ανάρτησης" } },
    wikinext: { icon: "📖", title: { ru: "Следующая правка Википедии", en: "Next Wikipedia edit", el: "Επόμενη επεξεργασία Wikipedia" } },
    drand: { icon: "📡", title: { ru: "Маяк случайности", en: "Randomness beacon", el: "Φάρος τυχαιότητας" } },
  };

  const GROUP_TITLES = {
    ru: { main: "Основные", numbers: "Выпадет число", sums: "Пары сумм", exact: "Точная сумма", exotic: "Экзотика", win: "Победитель", place: "Топ-2", forecast: "Точная пара", winner: "Победитель серии", total: "Тотал голов", score: "Точный счёт", side: "Особые", shooters: "Бьющие",
      target: "Цель", price: "Цена", dir: "Направление", duel: "Дуэль", gap: "Разрыв", cat: "Категория", digit: "Цифра", parity: "Чёт / нечёт", kind: "Цифра или буква", quarter: "Четверть", first: "Первым" },
    en: { main: "Main", numbers: "Shows number", sums: "Sum pairs", exact: "Exact total", exotic: "Exotic", win: "Winner", place: "Top 2", forecast: "Exact pair", winner: "Shootout winner", total: "Total goals", score: "Exact score", side: "Specials", shooters: "Shooters",
      target: "Target", price: "Price", dir: "Direction", duel: "Duel", gap: "Gap", cat: "Category", digit: "Digit", parity: "Odd / even", kind: "Digit or letter", quarter: "Quarter", first: "First" },
    el: { main: "Κύρια", numbers: "Θα έρθει αριθμός", sums: "Ζεύγη αθροισμάτων", exact: "Ακριβές άθροισμα", exotic: "Εξωτικά", win: "Νικητής", place: "Top 2", forecast: "Ακριβές ζεύγος", winner: "Νικητής σειράς", total: "Σύνολο γκολ", score: "Ακριβές σκορ", side: "Ειδικά", shooters: "Εκτελεστές",
      target: "Στόχος", price: "Τιμή", dir: "Κατεύθυνση", duel: "Μονομαχία", gap: "Διαφορά", cat: "Κατηγορία", digit: "Ψηφίο", parity: "Μονό / ζυγό", kind: "Ψηφίο ή γράμμα", quarter: "Τέταρτο", first: "Πρώτο" },
  };

  const kcStr = (kc) => (kc / 100).toFixed(2).replace(".", ",");
  const num = (x) => String(x).replace(".", ",");
  const dog = (meta, i) => `№${i} ${(meta && meta.names && meta.names[i - 1]) || ""}`.trim();

  // Подпись рынка. type — тип события, id — id рынка, ev — { meta, input } события.
  function marketLabel(type, id, ev, lang) {
    lang = lang || LANG();
    const w = W[lang] || W.ru, meta = (ev && ev.meta) || {}, input = (ev && ev.input) || {};
    const [k, v] = id.split(":");
    switch (type) {
      case "dice":
        if (id === "big" || id === "small") return `${w[id]} ${id === "big" ? "11–17" : "4–10"}`;
        if (id === "odd" || id === "even" || id === "triple") return w[id];
        if (k === "has") return `${w.has} ${v}`;
        if (k === "sum") return v.replace(/-/g, " · ");
        if (k === "exact") return `${w.sum} ${v}`;
        break;
      case "dogs":
        if (k === "win") return dog(meta, +v);
        if (k === "top2") return `${w.top2}: ${dog(meta, +v)}`;
        if (k === "last") return `${w.last}: ${dog(meta, +v)}`;
        if (k === "ex") { const [a, b] = v.split("-"); return `${dog(meta, +a)}, ${w.then} ${dog(meta, +b)}`; }
        break;
      case "penalties": {
        const team = (t) => (meta[t] && meta[t].name) || t;
        if (k === "winner") return team(v);
        if (k === "over") return `${w.over} ${num(v)}`;
        if (k === "under") return `${w.under} ${num(v)}`;
        if (k === "score") return `${w.score} ${v.replace("-", ":")}`;
        if (id === "both3") return w.both3;
        if (id === "post") return w.post;
        if (k === "shooter") { const t = v[0], n = +v.slice(1); return `${(meta[t] && meta[t].men && meta[t].men[n - 1]) || v} ${w.scores}`; }
        break;
      }
      case "rope": {
        const hero = (t) => meta[t] || t;
        if (k === "win") return hero(v);
        if (k === "big") return `${hero(v)} ${w.margin}`;
        if (k === "comeback") return `${hero(v)}: ${w.comeback}`;
        break;
      }
      case "rocket":
        if (id === "instant") return w.instant;
        if (k === "target") return `${w.target} ×${num(v)}`;
        break;
      case "btc": {
        const z = +v, d = Math.round(z * (input.sigma || 0) * 100) / 100;
        if (k === "up") return z === 0 ? w.up : `${w.up} +${num(d)} ${w.dollars}`;
        if (k === "down") return z === 0 ? w.down : `${w.down} −${num(d)} ${w.dollars}`;
        break;
      }
      case "btceth":
        if (id === "bothUp" || id === "bothDown" || id === "mixed") return w[id];
        if (id === "btcBeats") return `BTC ${w.beats}`;
        if (id === "ethBeats") return `ETH ${w.beats}`;
        if (k === "btcGap") return `BTC ${w.gap} ${num(v)}σ`;
        if (k === "ethGap") return `ETH ${w.gap} ${num(v)}σ`;
        break;
      case "emoji": case "wikiduel": case "lightning": case "airport": {
        const lb = meta.labels || {};
        if (id === "A") return `${w.more}: ${lb.A || "A"}`;
        if (id === "B") return `${w.more}: ${lb.B || "B"}`;
        if (id === "tie") return w.tie;
        break;
      }
      case "wikiedit": case "whales": {
        const lb = meta.labels || {};
        if (k === "first") return `${w.first}: ${lb[v] || v}`;
        const m = /^(.+):ge(\d+)$/.exec(id);
        if (m) return `${lb[m[1]] || m[1]}${+m[2] > 1 ? " ×" + m[2] : ""}`;
        break;
      }
      case "news": case "lang": case "wikinext":
        if (k === "cat") return (meta.labels && meta.labels[v]) || v;
        break;
      case "drand":
        if (k === "digit") return `${w.digit} ${v.toUpperCase()}`;
        if (id === "even" || id === "odd") return w[id];
        if (id === "num" || id === "letter") return w[id];
        if (k === "quarter") return ["0–3", "4–7", "8–B", "C–F"][+v];
        break;
    }
    return id;
  }

  // Порядок групп по типу события и русские/английские/греческие заголовки
  const GROUP_ORDER = {
    dice: ["main", "numbers", "sums", "exact", "exotic"], dogs: ["win", "place", "forecast", "exotic"], rocket: ["target", "exotic"],
    penalties: ["winner", "total", "side", "shooters", "score", "exotic"], rope: ["winner", "side", "exotic"],
    btc: ["price"], btceth: ["dir", "duel", "gap"], duel: ["duel"], thresholds: ["win"], categorical: ["cat"], drand: ["digit", "parity", "kind", "quarter"],
  };

  // Группы рынков события: [{ id, title, markets }]
  function groupsFor(type, markets, lang) {
    lang = lang || LANG();
    const kind = { emoji: "duel", wikiduel: "duel", lightning: "duel", airport: "duel", wikiedit: "thresholds", whales: "thresholds", news: "categorical", lang: "categorical", wikinext: "categorical" }[type] || type;
    const order = GROUP_ORDER[kind] || [];
    const by = new Map();
    for (const m of markets) { if (!by.has(m.group)) by.set(m.group, []); by.get(m.group).push(m); }
    const ids = [...order.filter((g) => by.has(g)), ...[...by.keys()].filter((g) => !order.includes(g))];
    const titles = GROUP_TITLES[lang] || GROUP_TITLES.ru;
    return ids.map((id) => ({ id, title: type === "rope" && id === "winner" ? titles.win : titles[id] || id, markets: by.get(id) }));
  }

  // Фишки для телефона: кратны 10, от минимума до не больше стека
  function chips(min, stack) {
    const base = Math.max(10, Math.ceil(min / 10) * 10);
    const set = [...new Set([base, base * 2, base * 5, base * 10, base * 25].filter((x) => x <= stack))];
    return set.length ? set : [Math.max(10, Math.min(stack, base))];
  }

  const PLAYER_COLORS = ["#ff2e88", "#b6ff2e", "#38d3ff", "#ffd34d", "#a78bfa", "#ff7a2e", "#4dffb0", "#ff5c5c", "#7aa2ff", "#f0abfc", "#fde047", "#5eead4"];
  const REACTIONS = ["🔥", "😱", "😂", "👏", "💀", "🤡"];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // Потенциальный выигрыш по правилам движка (floor, целые фишки)
  const payout = (stake, kc) => Math.floor((stake * kc) / 100);

  const api = { TYPES, marketLabel, groupsFor, chips, kcStr, payout, mulberry32, PLAYER_COLORS, REACTIONS, typeTitle: (t, lang) => pick((TYPES[t] || { title: { ru: t } }).title, lang || LANG()), typeIcon: (t) => (TYPES[t] || {}).icon || "🎯" };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BetsShared = api;
})(typeof window !== "undefined" ? window : globalThis);
