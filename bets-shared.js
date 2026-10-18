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

  // ---- Правила события: коротко, что происходит и как выиграть (показываются в окне ставок на доске и на телефоне) ----
  // Подстановки: {A}, {B} — подписи сторон из ev.meta.labels; {T} — длина окна в секундах.
  const RULES = {
    dice: {
      ru: "Три кубика падают из стакана. Ставь на сумму, на число, на «больше/меньше» (11–17 против 4–10) или «чёт/нечёт». Если выпала тройка (три одинаковых), «больше/меньше» и «чёт/нечёт» проигрывают.",
      en: "Three dice drop from the cup. Bet on the total, on a number, on big/small (11–17 vs 4–10) or odd/even. If all three match (a triple), big/small and odd/even lose.",
      el: "Τρία ζάρια πέφτουν από το ποτήρι. Πόνταρε στο άθροισμα, σε αριθμό, μεγάλο/μικρό (11–17 ή 4–10) ή μονό/ζυγό. Αν έρθει τριάδα, χάνουν τα μεγάλο/μικρό και μονό/ζυγό.",
    },
    dogs: {
      ru: "Три собаки бегут 400 метров. Ставь на победителя, на «в двойке» (первые два места), на последнего или на точную пару «первый, затем второй». Чем слабее собака, тем больше коэффициент.",
      en: "Three greyhounds run 400 metres. Bet on the winner, on a top-2 finish, on the last one, or on the exact pair (first, then second). The weaker the dog, the bigger the odds.",
      el: "Τρία γκρέιχαουντ τρέχουν 400 μέτρα. Πόνταρε στον νικητή, στους δύο πρώτους, στον τελευταίο ή στο ακριβές ζεύγος (πρώτος, μετά δεύτερος). Όσο πιο αδύναμος ο σκύλος, τόσο μεγαλύτερη η απόδοση.",
    },
    rocket: {
      ru: "Ракета растёт от ×1 и взрывается в случайный момент. Выбери цель: ставка выигрывает, если ракета успела долететь до неё. Цель и есть коэффициент: чем выше, тем больше выигрыш и меньше шанс.",
      en: "The rocket climbs from ×1 and explodes at a random moment. Pick a target: the bet wins if the rocket reaches it. The target is the payout: the higher it is, the bigger the win and the smaller the chance.",
      el: "Ο πύραυλος ανεβαίνει από ×1 και εκρήγνυται σε τυχαία στιγμή. Διάλεξε στόχο: το στοίχημα κερδίζει αν ο πύραυλος τον φτάσει. Ο στόχος είναι η απόδοση: όσο ψηλότερα, τόσο μεγαλύτερο το κέρδος και μικρότερη η πιθανότητα.",
    },
    penalties: {
      ru: "Две команды бьют по 5 пенальти, при ничьей — по одному удару до первой ошибки. Ставь на победителя серии, число голов, точный счёт, штангу или на конкретного бьющего.",
      en: "Two teams take 5 penalties each; if tied, one kick each until someone misses. Bet on the winner, the number of goals, the exact score, a post hit or a particular shooter.",
      el: "Δύο ομάδες εκτελούν από 5 πέναλτι· σε ισοπαλία, ένα σουτ η καθεμία μέχρι το πρώτο λάθος. Πόνταρε στον νικητή, στα γκολ, στο ακριβές σκορ, στο δοκάρι ή σε συγκεκριμένο εκτελεστή.",
    },
    rope: {
      ru: "Канат, 41 рывок. Кто выиграл больше рывков, тот и победил. Ставь на победителя, на победу с перевесом 9+ рывков или на «камбэк» (победитель в какой-то момент отставал на 5+).",
      en: "Tug of war, 41 pulls. Whoever wins more pulls wins. Bet on the winner, on a margin of 9+ pulls, or on a comeback (the winner trailed by 5+ at some point).",
      el: "Διελκυστίνδα, 41 τραβήγματα. Όποιος κερδίσει τα περισσότερα νικά. Πόνταρε στον νικητή, σε διαφορά 9+ ή σε ανατροπή (ο νικητής έχανε με 5+ κάποια στιγμή).",
    },
    btc: {
      ru: "Цена биткоина в момент закрытия ставок — точка отсчёта. Через 20 секунд сравниваем: выросла или упала. «Выше +N $» значит «вырастет больше чем на N долларов за 20 секунд».",
      en: "The Bitcoin price at the moment betting closes is the starting point. After 20 seconds we compare: up or down. “Up +N $” means “rises by more than N dollars within 20 seconds”.",
      el: "Η τιμή του Bitcoin τη στιγμή που κλείνουν τα στοιχήματα είναι το σημείο εκκίνησης. Μετά από 20 δευτερόλεπτα συγκρίνουμε: πάνω ή κάτω. «Πάνω +N $» σημαίνει άνοδο πάνω από N δολάρια σε 20 δευτερόλεπτα.",
    },
    btceth: {
      ru: "BTC и ETH стартуют с нуля в момент закрытия ставок. Через 20 секунд смотрим: обе выросли, обе упали, разошлись в разные стороны — и какая монета выросла сильнее.",
      en: "BTC and ETH start from zero when betting closes. After 20 seconds: did both rise, both fall, or split — and which coin gained more.",
      el: "Τα BTC και ETH ξεκινούν από το μηδέν όταν κλείνουν τα στοιχήματα. Μετά από 20 δευτερόλεπτα: ανέβηκαν και τα δύο, έπεσαν ή χωρίστηκαν — και ποιο κέρδισε περισσότερο.",
    },
    emoji: {
      ru: "Считаем настоящие посты в соцсети Bluesky за {T} секунд после закрытия ставок: чего больше, {A} или {B}. Поровну — отдельная ставка с большим коэффициентом.",
      en: "We count real Bluesky posts for {T} seconds after betting closes: which shows up more, {A} or {B}. A tie is its own bet with a big payout.",
      el: "Μετράμε πραγματικές αναρτήσεις στο Bluesky για {T} δευτερόλεπτα μετά το κλείσιμο: τι εμφανίζεται περισσότερο, {A} ή {B}. Η ισοπαλία είναι ξεχωριστό στοίχημα με μεγάλη απόδοση.",
    },
    wikiduel: {
      ru: "Считаем настоящие правки Википедии за {T} секунд после закрытия ставок: в каком разделе их больше, {A} или {B}. Поровну — отдельная ставка.",
      en: "We count real Wikipedia edits for {T} seconds after betting closes: which edition gets more, {A} or {B}. A tie is its own bet.",
      el: "Μετράμε πραγματικές επεξεργασίες της Wikipedia για {T} δευτερόλεπτα: σε ποια έκδοση είναι περισσότερες, {A} ή {B}. Η ισοπαλία είναι ξεχωριστό στοίχημα.",
    },
    wikiedit: {
      ru: "За {T} секунд после закрытия ставок: появится ли правка в статьях на эту тему в Википедии. Ставки независимы, можно ставить на несколько тем сразу.",
      en: "Within {T} seconds after betting closes: will a Wikipedia article on this topic get edited. The bets are independent, so you can back several topics.",
      el: "Μέσα σε {T} δευτερόλεπτα από το κλείσιμο: θα γίνει επεξεργασία σε άρθρο της Wikipedia για αυτό το θέμα. Τα στοιχήματα είναι ανεξάρτητα, μπορείς να παίξεις σε πολλά θέματα.",
    },
    whales: {
      ru: "Появится ли за {T} секунд крупная транзакция биткоина больше указанной суммы. Ставки независимы.",
      en: "Will a Bitcoin transaction larger than the stated amount appear within {T} seconds. The bets are independent.",
      el: "Θα εμφανιστεί μέσα σε {T} δευτερόλεπτα συναλλαγή Bitcoin μεγαλύτερη από το ποσό; Τα στοιχήματα είναι ανεξάρτητα.",
    },
    lightning: {
      ru: "Спутник считает молнии над Америкой. Где вспыхнет больше за период, {A} или {B}. Поровну — отдельная ставка.",
      en: "A satellite counts lightning over the Americas. Which side flashes more over the period, {A} or {B}. A tie is its own bet.",
      el: "Δορυφόρος μετρά αστραπές πάνω από την Αμερική. Ποια πλευρά έχει περισσότερες, {A} ή {B}. Η ισοπαλία είναι ξεχωριστό στοίχημα.",
    },
    airport: {
      ru: "Считаем настоящие взлёты за {T} секунд у двух аэропортов по открытым данным самолётов: где взлетит больше, {A} или {B}. Поровну бывает часто — это отдельная ставка.",
      en: "We count real take-offs for {T} seconds at two airports from open aircraft data: which gets more, {A} or {B}. Ties are common, so a tie is its own bet.",
      el: "Μετράμε πραγματικές απογειώσεις για {T} δευτερόλεπτα σε δύο αεροδρόμια από ανοιχτά δεδομένα: πού περισσότερες, {A} ή {B}. Οι ισοπαλίες είναι συχνές και είναι ξεχωριστό στοίχημα.",
    },
    lang: {
      ru: "Поток постов Bluesky замедлится и остановится. Ставь на язык поста, который окажется на экране в момент остановки.",
      en: "The stream of Bluesky posts slows down and stops. Bet on the language of the post on screen at the moment it stops.",
      el: "Η ροή αναρτήσεων του Bluesky επιβραδύνεται και σταματά. Πόνταρε στη γλώσσα της ανάρτησης τη στιγμή που σταματά.",
    },
    wikinext: {
      ru: "Поток правок Википедии замедлится и остановится. Ставь на проект, в котором окажется правка в момент остановки.",
      en: "The stream of Wikipedia edits slows down and stops. Bet on the project the edit belongs to at the moment it stops.",
      el: "Η ροή επεξεργασιών της Wikipedia επιβραδύνεται και σταματά. Πόνταρε στο πρότζεκτ της επεξεργασίας τη στιγμή που σταματά.",
    },
    news: {
      ru: "Первая новость после закрытия ставок. Ставь, из какой страны или о чём она будет.",
      en: "The first news headline after betting closes. Bet on which country or topic it is about.",
      el: "Η πρώτη είδηση μετά το κλείσιμο των στοιχημάτων. Πόνταρε σε ποια χώρα ή θέμα αφορά.",
    },
    drand: {
      ru: "Публичный маяк случайности drand выдаёт число каждые 3 секунды. Ставь на последнюю цифру числа следующего раунда, чёт/нечёт или на «цифра/буква». Любой может проверить результат на сайте drand.",
      en: "The public drand randomness beacon publishes a number every 3 seconds. Bet on the last digit of the next round, odd/even, or digit/letter. Anyone can verify the result on the drand site.",
      el: "Ο δημόσιος φάρος τυχαιότητας drand δημοσιεύει έναν αριθμό κάθε 3 δευτερόλεπτα. Πόνταρε στο τελευταίο ψηφίο του επόμενου γύρου, μονό/ζυγό ή ψηφίο/γράμμα. Οποιοσδήποτε μπορεί να ελέγξει το αποτέλεσμα στο drand.",
    },
  };
  const RULES_GENERAL = {
    ru: "Ставки открыты ограниченное время. Выигрыш = ставка × коэффициент. Фишки виртуальные.",
    en: "Betting is open for a limited time. Win = stake × odds. Chips are virtual.",
    el: "Τα στοιχήματα είναι ανοιχτά για περιορισμένο χρόνο. Κέρδος = ποντάρισμα × απόδοση. Οι μάρκες είναι εικονικές.",
  };

  // Текст правил для события: { text, general }
  function rules(type, ev, lang) {
    lang = lang || LANG();
    const r = RULES[type] || {};
    const lb = (ev && ev.meta && ev.meta.labels) || {};
    const T = (ev && ev.input && ev.input.T) || (type === "airport" ? 90 : 20);
    const fill = (t) => String(t || "").replace(/\{A\}/g, lb.A || "A").replace(/\{B\}/g, lb.B || "B").replace(/\{T\}/g, T);
    return { text: fill(r[lang] || r.ru || ""), general: RULES_GENERAL[lang] || RULES_GENERAL.ru };
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

  const api = { TYPES, rules, marketLabel, groupsFor, chips, kcStr, payout, mulberry32, PLAYER_COLORS, REACTIONS, typeTitle: (t, lang) => pick((TYPES[t] || { title: { ru: t } }).title, lang || LANG()), typeIcon: (t) => (TYPES[t] || {}).icon || "🎯" };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BetsShared = api;
})(typeof window !== "undefined" ? window : globalThis);
