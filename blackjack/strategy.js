"use strict";

/*
 * Базовая стратегия блэкджека для правил нашего стола (6 колод, дилер стоит на любых 17, удвоение после сплита,
 * без сдачи, один сплит) и подсказки Марго человеческим языком (blackjack-spec.md §8).
 *
 * advise(hand, up) → {action, fallback, key}: action — лучший ход по таблице, fallback — что делать, если удвоение
 * или сплит недоступны (не хватает фишек, уже сплитовали), key — ситуация для текста подсказки.
 * hint(hand, up, lang, rnd) → строка от Марго: по 3–4 формулировки на ситуацию на каждом языке, чтобы не звучало как робот.
 *
 * Файл работает и в Node (module.exports), и в браузере (window.BlackjackStrategy); синтаксис не выше ES2017 (см. game.js).
 */
(function () {

const VALUE = { A: 11, K: 10, Q: 10, J: 10, "10": 10 };
const cardValue = (r) => VALUE[r] || Number(r);
const rankOf = (c) => (typeof c === "string" ? c : c.r);

function handValue(cards) {
  let v = 0;
  let aces = 0;
  for (const c of cards) { v += cardValue(rankOf(c)); if (rankOf(c) === "A") aces++; }
  while (v > 21 && aces > 0) { v -= 10; aces--; }
  return { value: v, soft: aces > 0 && v <= 21 };
}

// столбцы таблицы — открытая карта дилера 2,3,4,5,6,7,8,9,10,A
const UP = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "A"];
const upIndex = (up) => { const r = rankOf(up); return UP.indexOf(cardValue(r) === 10 ? "10" : r); };

// H — ещё, S — хватит, D — удвоить (нельзя — ещё), d — удвоить (нельзя — хватит), P — сплит (нельзя — как жёсткая рука)
const HARD = {
  5: "HHHHHHHHHH", 6: "HHHHHHHHHH", 7: "HHHHHHHHHH", 8: "HHHHHHHHHH",
  9: "HDDDDHHHHH",
  10: "DDDDDDDDHH",
  11: "DDDDDDDDDH",
  12: "HHSSSHHHHH",
  13: "SSSSSHHHHH", 14: "SSSSSHHHHH", 15: "SSSSSHHHHH", 16: "SSSSSHHHHH",
  17: "SSSSSSSSSS", 18: "SSSSSSSSSS", 19: "SSSSSSSSSS", 20: "SSSSSSSSSS", 21: "SSSSSSSSSS",
};
const SOFT = {
  12: "HHHHHHHHHH", // два туза без сплита
  13: "HHHDDHHHHH", 14: "HHHDDHHHHH",
  15: "HHDDDHHHHH", 16: "HHDDDHHHHH",
  17: "HDDDDHHHHH",
  18: "SddddSSHHH",
  19: "SSSSSSSSSS", 20: "SSSSSSSSSS", 21: "SSSSSSSSSS",
};
const PAIRS = {
  A: "PPPPPPPPPP",
  2: "PPPPPPHHHH", 3: "PPPPPPHHHH",
  4: "HHHPPHHHHH",
  5: "DDDDDDDDHH",
  6: "PPPPPHHHHH",
  7: "PPPPPPHHHH",
  8: "PPPPPPPPPP",
  9: "PPPPPSPPSS",
  10: "SSSSSSSSSS",
};
const ACTION = { H: "hit", S: "stand", D: "double", d: "double", P: "split" };

/*
 * hand: {cards, canDouble, canSplit, fromSplit} (cards — [{r,s}] или ранги); up — карта дилера или ранг.
 * Возвращает {action, fallback, key, value, soft}: fallback — ход, если action недоступен.
 */
function advise(hand, up) {
  const cards = hand.cards || hand;
  const canDouble = hand.canDouble !== false;
  const canSplit = hand.canSplit !== false && !hand.fromSplit;
  const col = upIndex(up);
  const hv = handValue(cards);
  const ranks = cards.map(rankOf);
  const pair = cards.length === 2 && cardValue(ranks[0]) === cardValue(ranks[1]);
  const pairKey = pair ? (cardValue(ranks[0]) === 10 ? "10" : ranks[0]) : null;
  const two = cards.length === 2;
  let code = null;
  let key = null;

  if (two && !hand.fromSplit && hv.value === 21) return { action: "stand", fallback: "stand", key: "blackjack", value: 21, soft: true };
  if (hv.value > 21) return { action: "stand", fallback: "stand", key: "bust", value: hv.value, soft: false };

  if (pair) {
    code = PAIRS[pairKey][col];
    if (code === "P") {
      if (canSplit) {
        key = pairKey === "A" ? "split_aces" : pairKey === "8" ? "split_eights" : "split";
        return { action: "split", fallback: fallbackFor(cards, col, canDouble, hv), key: key, value: hv.value, soft: hv.soft };
      }
      // сплит недоступен — играем как обычную руку
      const f = fallbackFor(cards, col, canDouble, hv);
      return { action: f, fallback: f, key: "split_na", value: hv.value, soft: hv.soft };
    }
  }
  const row = hv.soft ? SOFT[hv.value] : HARD[Math.max(5, hv.value)];
  code = code && code !== "P" ? code : row[col];
  const action = ACTION[code];
  if ((code === "D" || code === "d") && !(two && canDouble)) {
    const f = code === "D" ? "hit" : "stand";
    return { action: f, fallback: f, key: "double_na", value: hv.value, soft: hv.soft };
  }
  const fallback = code === "D" ? "hit" : code === "d" ? "stand" : action;
  if (pair && code !== "P") key = action === "hit" ? "pair_hit" : action === "stand" ? "pair_stand" : "pair_double";
  else if (hv.value === 21) key = "twentyone";
  else if (hv.soft) key = action === "double" ? "soft_double" : action === "hit" ? (hv.value === 18 ? "soft18_hit" : "soft_hit") : "soft_stand";
  else if (action === "double") key = hv.value === 11 ? "double_11" : "double";
  else if (action === "stand") key = hv.value >= 17 ? "stand_high" : "stand_vs_weak";
  else key = hv.value <= 11 ? "hit_free" : "hit_scary";
  return { action: action, fallback: fallback, key: key, value: hv.value, soft: hv.soft };
}

// ход для пары, которую не сплитуем: по таблице жёстких/мягких рук
function fallbackFor(cards, col, canDouble, hv) {
  const row = hv.soft ? SOFT[hv.value] : HARD[Math.max(5, hv.value)];
  const code = row[col];
  if (code === "D") return canDouble ? "double" : "hit";
  if (code === "d") return canDouble ? "double" : "stand";
  return ACTION[code];
}

// ---------- тексты Марго ----------

const CARD_NAMES = {
  ru: { 2: "двойка", 3: "тройка", 4: "четвёрка", 5: "пятёрка", 6: "шестёрка", 7: "семёрка", 8: "восьмёрка", 9: "девятка", 10: "десятка", A: "туз" },
  en: { 2: "a two", 3: "a three", 4: "a four", 5: "a five", 6: "a six", 7: "a seven", 8: "an eight", 9: "a nine", 10: "a ten", A: "an ace" },
  el: { 2: "δυάρι", 3: "τριάρι", 4: "τεσσάρι", 5: "πεντάρι", 6: "εξάρι", 7: "εφτάρι", 8: "οχτάρι", 9: "εννιάρι", 10: "δεκάρι", A: "άσο" },
};
// родительный падеж для «против …» (только в русском; в английском и греческом форма та же)
const CARD_NAMES_GEN = {
  ru: { 2: "двойки", 3: "тройки", 4: "четвёрки", 5: "пятёрки", 6: "шестёрки", 7: "семёрки", 8: "восьмёрки", 9: "девятки", 10: "десятки", A: "туза" },
};
// английское название карты без артикля — для «my four» (артикль + притяжательное дают «my a four»)
const CARD_NAMES_BARE = {
  en: { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", A: "ace" },
};
const PAIR_NAMES = {
  ru: { 2: "пара двоек", 3: "пара троек", 4: "пара четвёрок", 5: "пара пятёрок", 6: "пара шестёрок", 7: "пара семёрок", 8: "пара восьмёрок", 9: "пара девяток", 10: "две десятки", A: "пара тузов" },
  en: { 2: "a pair of twos", 3: "a pair of threes", 4: "a pair of fours", 5: "a pair of fives", 6: "a pair of sixes", 7: "a pair of sevens", 8: "a pair of eights", 9: "a pair of nines", 10: "two tens", A: "a pair of aces" },
  el: { 2: "δύο δυάρια", 3: "δύο τριάρια", 4: "δύο τεσσάρια", 5: "δύο πεντάρια", 6: "δύο εξάρια", 7: "δύο εφτάρια", 8: "δύο οχτάρια", 9: "δύο εννιάρια", 10: "δύο δεκάρια", A: "δύο άσοι" },
};

/*
 * Тексты подсказок: «Слово-действие|причина». Слово-действие подсвечивается в цвет кнопки, причина — короткий кусок «почему».
 * Подстановки: {act} — слово запасного хода (для double_na/split_na), {you} — счёт руки (мягкая — «7/17»), {hard} — значение,
 * {dealer} — карта дилера словом, {dealerGen} — она же в родительном (ru), {pair} — пара словами. Всего ≤ 10 слов.
 */
const PHRASES = {
  ru: {
    blackjack: [
      "Блэкджек|Сиди красиво, платят 3:2.",
      "Блэкджек|Кнопки отдыхают. Туз и десятка — это 3:2.",
      "Блэкджек|Редкая красота. Просто жди выплаты.",
      "Блэкджек|Тут всё решено. Не спугни удачу.",
      "Блэкджек|Ничего не нажимай. Платить — моя работа.",
    ],
    bust: [
      "Перебор|Больше 21 — рука отыграла.",
      "Перебор|Бывает. Следующая раздача чистая.",
      "Перебор|Красиво горело. Идём дальше.",
      "Перебор|Я видела хуже. Правда.",
      "Перебор|Карты не виноваты. Почти.",
    ],
    twentyone: [
      "Стой|21 — лучше не бывает.",
      "Стой|21. Дальше только хуже.",
      "Хватит|Ровно 21. Не искушай судьбу.",
      "Стой|Это 21 — не трогай.",
      "Стой|21 на руках. Береги как есть.",
    ],
    stand_high: [
      "Стой|{you} — дальше только перебор.",
      "Хватит|{you} — уже рука. Остальное за мной.",
      "Стой|Брать на {you} — дарить мне фишки.",
      "Стой|С {you} не играют, с ним сидят.",
      "Хватит|{you} достаточно. Дай мне понервничать.",
    ],
    stand_vs_weak: [
      "Стой|У меня {dealer} — перебрать могу я.",
      "Хватит|{you} против {dealerGen}: пусть дилер перебирает.",
      "Стой|Рискую я, не ты. Жди моего перебора.",
      "Стой|{you} против {dealerGen} — не лезь.",
      "Хватит|С такой картой я часто горю. Не мешай.",
    ],
    hit_scary: [
      "Бери|{you} против {dealerGen} — стоять хуже.",
      "Ещё|Страшно, но стоять на {you} проигрышнее.",
      "Бери|У меня {dealer}: {you} не хватит.",
      "Бери|{you} сами не выиграют. Нужна карта.",
      "Ещё|Смелее. Стоять тут — сдаваться.",
    ],
    hit_free: [
      "Бери|С {you} перебрать нельзя.",
      "Ещё|{you} — ещё не рука.",
      "Бери|Риска нет: перебор невозможен.",
      "Бери|Перебор не светит, так что смелее.",
      "Ещё|{you} — только начало. Без страха.",
    ],
    double: [
      "Удваивай|{you} против {dealerGen}: момент твой.",
      "Удваивай|У меня {dealer} — ставка ×2 тут выгодна.",
      "Удваивай|Карта у меня слабая, рука у тебя сильная.",
      "Удваивай|{you} против {dealerGen}. Один раз, но жирно.",
      "Удваивай|Редкий случай: можно давить.",
    ],
    double_11: [
      "Удваивай|11 — лучший старт вечера.",
      "Удваивай|Любая десятка даст тебе 21.",
      "Удваивай|11 против {dealerGen}: не думай, давай.",
      "Удваивай|Одиннадцать. Ставка ×2 и жди десятку.",
      "Удваивай|Самая сладкая рука. Не упусти.",
    ],
    double_na: [
      "{act}|Удвоить не выйдет — вот запасной ход.",
      "{act}|Тут просилось удвоение, но не вышло.",
      "{act}|Без удвоения — по-простому.",
      "{act}|Удвоение недоступно, играем так.",
      "{act}|Жаль, удвоить нельзя. Тогда так.",
    ],
    soft_hit: [
      "Бери|С тузом перебор не грозит.",
      "Ещё|Мягкие {you}: туз подстрахует.",
      "Бери|{you} с тузом — риск нулевой.",
      "Бери|Туз прикроет, бери смело.",
      "Ещё|Мягкая рука просит карту.",
    ],
    soft18_hit: [
      "Бери|Мягкие 18 против {dealerGen} — мало.",
      "Бери|У меня {dealer}: 18 тут слабоваты.",
      "Ещё|18 с тузом — туз подстрахует.",
      "Бери|Туз не даст перебрать. Попробуй улучшить.",
      "Бери|Мягкие 18 не держат такую карту.",
    ],
    soft_double: [
      "Удваивай|{you} с тузом — перебор не страшен.",
      "Удваивай|У меня {dealer}: давим ставкой ×2.",
      "Удваивай|Туз прикрывает, моя карта слабая.",
      "Удваивай|{you} против {dealerGen} — удвой и жди.",
      "Удваивай|Тот случай, когда жадность оправдана.",
    ],
    soft_stand: [
      "Стой|Мягкие {you} — уже отличная рука.",
      "Хватит|{you} с тузом — отложи карты.",
      "Стой|Лучше не станет. Не трогай.",
      "Стой|Сиди ровно: {you} стоят дорого.",
      "Хватит|Мягкие {you}: красиво, закончили.",
    ],
    split_aces: [
      "Сплит|Два туза — всегда делим.",
      "Дели|Каждому тузу — своя рука.",
      "Сплит|Тузы вместе — потеря. Делим.",
      "Сплит|Два шанса лучше одного.",
      "Дели|Эту пару я бы вместе не держала.",
    ],
    split_eights: [
      "Сплит|Две восьмёрки — всегда делим.",
      "Дели|16 — худшая рука. Разбей её.",
      "Сплит|Восьмёрки вместе — это 16. Фу.",
      "Сплит|Даже против {dealerGen} восьмёрки делят.",
      "Дели|Две руки из восьмёрок лучше одной 16.",
    ],
    split: [
      "Сплит|{pair} против {dealerGen} — делим.",
      "Дели|Две руки против {dealerGen} выгоднее.",
      "Сплит|{pair}: два шанса лучше одного.",
      "Дели|У меня {dealer} — две руки опаснее одной.",
      "Сплит|{pair} лучше порознь.",
    ],
    split_na: [
      "{act}|Сплит недоступен. Играем руку целиком.",
      "{act}|Делить нельзя — запасной ход.",
      "{act}|Пару не разделить: играем как {hard}.",
      "{act}|Без сплита это просто {hard}.",
      "{act}|Сплит закрыт. Берём запасной ход.",
    ],
    pair_hit: [
      "Бери|Против {dealerGen} пару не делят.",
      "Ещё|Не делим: это просто {hard}.",
      "Бери|Играем как {hard}, без сплита.",
      "Бери|Делить выйдет хуже. Просто карту.",
      "Бери|Эта пара делёжки не стоит.",
    ],
    pair_stand: [
      "Стой|Не делим: {hard} — уже сильная рука.",
      "Хватит|{hard} против {dealerGen} — держи целиком.",
      "Стой|Делить такое — дарить мне фишки.",
      "Стой|Пара хороша целиком. Не трогай.",
      "Хватит|Целиком эта пара сильнее, чем по частям.",
    ],
    pair_double: [
      "Удваивай|Две пятёрки — это 10, а не пара.",
      "Удваивай|Пятёрки не делят — удваивают.",
      "Удваивай|10 против {dealerGen}: ставка ×2.",
      "Удваивай|Это 10, а не две пятёрки.",
      "Удваивай|Десять очков — давим ставкой ×2.",
    ],
  },
  en: {
    blackjack: [
      "Blackjack|Sit pretty, it pays 3:2.",
      "Blackjack|Buttons can rest. Ace and ten pays 3:2.",
      "Blackjack|Rare beauty. Just wait for the payout.",
      "Blackjack|Already decided. Don't jinx it.",
      "Blackjack|Touch nothing. Paying is my job now.",
    ],
    bust: [
      "Bust|Over 21, this hand is done.",
      "Bust|It happens. The next hand is clean.",
      "Bust|Burned bright. On to the next.",
      "Bust|I've seen worse. Honestly.",
      "Bust|The cards aren't to blame. Mostly.",
    ],
    twentyone: [
      "Stand|21 doesn't get better.",
      "Stand|21. Anything more is downhill.",
      "Hold|Exactly 21. Don't tempt fate.",
      "Stand|That's 21. Leave it alone.",
      "Stand|21 in hand. Keep it as is.",
    ],
    stand_high: [
      "Stand|{you} — more is just a bust.",
      "Hold|{you} is a hand already. The rest is mine.",
      "Stand|Hitting {you} just gifts me chips.",
      "Stand|You don't play {you}, you keep it.",
      "Hold|{you} is plenty. Let me sweat.",
    ],
    stand_vs_weak: [
      "Stand|I show {dealer} — I'm the one at risk.",
      "Hold|{you} against {dealer}: let the dealer bust.",
      "Stand|My card is weak. The risk is mine.",
      "Stand|{you} against {dealer}: wait for my bust.",
      "Hold|I bust a lot with that card. Stay put.",
    ],
    hit_scary: [
      "Hit|{you} against {dealer} — standing is worse.",
      "Hit|Scary, but standing on {you} loses more.",
      "Hit|I show {dealer}: {you} won't hold up.",
      "Hit|{you} won't win alone. Take a card.",
      "Hit|Be brave. Standing here is surrender.",
    ],
    hit_free: [
      "Hit|You can't bust on {you}.",
      "Hit|{you} isn't a hand yet.",
      "Hit|Zero risk. Bust is impossible.",
      "Hit|No bust possible, so be bold.",
      "Hit|{you} is just a start. No fear.",
    ],
    double: [
      "Double|{you} against {dealer}: your moment.",
      "Double|I show {dealer} — ×2 pays here.",
      "Double|Weak card for me, strong hand for you.",
      "Double|{you} against {dealer}. Once, but big.",
      "Double|Rare spot. Time to press.",
    ],
    double_11: [
      "Double|11 is the best start of the night.",
      "Double|Any ten gives you 21.",
      "Double|11 against {dealer}: don't think, press.",
      "Double|Eleven. Bet ×2 and wait for a ten.",
      "Double|The sweetest hand. Don't waste it.",
    ],
    double_na: [
      "{act}|Double isn't happening — here's plan B.",
      "{act}|This wanted a double, but no luck.",
      "{act}|No double, so keep it simple.",
      "{act}|Double's off, so play it plain.",
      "{act}|Shame, no double. Then this.",
    ],
    soft_hit: [
      "Hit|With an ace, bust isn't a risk.",
      "Hit|Soft {you}: the ace has your back.",
      "Hit|{you} with an ace — zero risk.",
      "Hit|The ace covers you. Be bold.",
      "Hit|A soft hand wants one more card.",
    ],
    soft18_hit: [
      "Hit|Soft 18 against {dealer} is too little.",
      "Hit|I show {dealer}: 18 won't hold.",
      "Hit|18 with an ace — the ace has you.",
      "Hit|The ace stops a bust. Try to improve.",
      "Hit|Soft 18 can't hold that card.",
    ],
    soft_double: [
      "Double|{you} with an ace — bust doesn't bite.",
      "Double|I show {dealer}: press with ×2.",
      "Double|The ace covers you, my card is weak.",
      "Double|{you} against {dealer}. Double and wait.",
      "Double|Greed is justified here.",
    ],
    soft_stand: [
      "Stand|Soft {you} is already a great hand.",
      "Hold|{you} with an ace — put the cards down.",
      "Stand|It won't get better. Don't touch.",
      "Stand|Sit tight, {you} is worth a lot.",
      "Hold|Soft {you}: lovely. We're done.",
    ],
    split_aces: [
      "Split|Two aces — always split.",
      "Split|Each ace gets its own hand.",
      "Split|Aces together are a waste. Split.",
      "Split|Two shots beat one.",
      "Split|I'd never keep that pair together.",
    ],
    split_eights: [
      "Split|Two eights — always split.",
      "Split|16 is the worst hand. Break it up.",
      "Split|Eights together make 16. Ugh.",
      "Split|Even against {dealer}, eights get split.",
      "Split|Two hands of eights beat one 16.",
    ],
    split: [
      "Split|{pair} against {dealer} — split.",
      "Split|Two hands against {dealer} pays more.",
      "Split|{pair}: two chances beat one.",
      "Split|I show {dealer} — two hands hurt more.",
      "Split|{pair} is better apart.",
    ],
    split_na: [
      "{act}|Split isn't available. Play the whole hand.",
      "{act}|Can't split, so it's plan B.",
      "{act}|No splitting the pair: play it as {hard}.",
      "{act}|No split — it's just {hard}.",
      "{act}|Split is closed. Take the backup move.",
    ],
    pair_hit: [
      "Hit|Against {dealer} you don't split.",
      "Hit|Don't split: it's just {hard}.",
      "Hit|Play it as {hard}, no split.",
      "Hit|Splitting makes it worse. Just a card.",
      "Hit|This pair isn't worth the split.",
    ],
    pair_stand: [
      "Stand|Don't split: {hard} is already strong.",
      "Stand|{hard} against {dealer} — keep it whole.",
      "Hold|Splitting that just gifts me chips.",
      "Stand|The pair is better whole. Don't touch.",
      "Hold|This pair is stronger whole than in parts.",
    ],
    pair_double: [
      "Double|Two fives make 10, not a pair.",
      "Double|Fives don't get split — they double.",
      "Double|10 against {dealer}: bet ×2.",
      "Double|That's a 10, not two fives.",
      "Double|Ten points — press with ×2.",
    ],
  },
  el: {
    blackjack: [
      "Μπλακτζάκ|Κάτσε όμορφα, πληρώνει 3:2.",
      "Μπλακτζάκ|Τα κουμπιά ξεκουράζονται. Πληρώνει 3:2.",
      "Μπλακτζάκ|Σπάνια ομορφιά. Περίμενε την πληρωμή.",
      "Μπλακτζάκ|Όλα κρίθηκαν. Μη γρουσουζέψεις.",
      "Μπλακτζάκ|Μην αγγίξεις τίποτα. Πληρώνω εγώ.",
    ],
    bust: [
      "Κάηκες|Πάνω από 21, το χέρι τελείωσε.",
      "Κάηκες|Συμβαίνει. Το επόμενο χέρι είναι καθαρό.",
      "Κάηκες|Κάηκες με στυλ. Πάμε παρακάτω.",
      "Κάηκες|Έχω δει και χειρότερα. Στα σοβαρά.",
      "Κάηκες|Τα φύλλα δεν φταίνε. Σχεδόν.",
    ],
    twentyone: [
      "Στοπ|21 — καλύτερα δεν γίνεται.",
      "Στοπ|21. Από εδώ και πέρα κατηφόρα.",
      "Μείνε|Ακριβώς 21. Μην προκαλείς τη μοίρα.",
      "Στοπ|Είναι 21. Άφησέ το ήσυχο.",
      "Στοπ|21 στο χέρι. Κράτα το όπως είναι.",
    ],
    stand_high: [
      "Στοπ|{you} — παραπάνω είναι μόνο κάψιμο.",
      "Μείνε|Το {you} είναι ήδη χέρι. Τα υπόλοιπα δικά μου.",
      "Στοπ|Αν τραβήξεις στο {you}, μου χαρίζεις μάρκες.",
      "Στοπ|Το {you} δεν το παίζεις, το κρατάς.",
      "Μείνε|Φτάνει το {you}. Άσε με να ιδρώσω.",
    ],
    stand_vs_weak: [
      "Στοπ|Δείχνω {dealer} — ο κίνδυνος είναι δικός μου.",
      "Μείνε|{you} απέναντι σε {dealer}: άσε τον ντίλερ να καεί.",
      "Στοπ|Το φύλλο μου είναι αδύναμο. Ρισκάρω εγώ.",
      "Στοπ|{you} απέναντι σε {dealer}: περίμενε το κάψιμό μου.",
      "Μείνε|Με τέτοιο φύλλο καίγομαι συχνά. Μείνε.",
    ],
    hit_scary: [
      "Τράβα|{you} απέναντι σε {dealer} — το στοπ είναι χειρότερο.",
      "Τράβα|Τρομάζει, αλλά το στοπ στο {you} χάνει περισσότερο.",
      "Τράβα|Δείχνω {dealer}: το {you} δεν θα αντέξει.",
      "Τράβα|Το {you} μόνο του δεν κερδίζει. Φύλλο.",
      "Τράβα|Κουράγιο. Το στοπ εδώ είναι παράδοση.",
    ],
    hit_free: [
      "Τράβα|Με {you} δεν καίγεσαι.",
      "Τράβα|Το {you} δεν είναι ακόμα χέρι.",
      "Τράβα|Ρίσκο μηδέν — κάψιμο δεν γίνεται.",
      "Τράβα|Κάψιμο αδύνατο, οπότε με τόλμη.",
      "Τράβα|Άφοβα. Το {you} είναι μόνο η αρχή.",
    ],
    double: [
      "Διπλό|{you} απέναντι σε {dealer}: η στιγμή σου.",
      "Διπλό|Δείχνω {dealer} — το ×2 αξίζει εδώ.",
      "Διπλό|Αδύναμο φύλλο για μένα, δυνατό χέρι για σένα.",
      "Διπλό|{you} απέναντι σε {dealer}. Μία φορά, αλλά γερά.",
      "Διπλό|Σπάνια θέση. Πίεσε.",
    ],
    double_11: [
      "Διπλό|Το 11 είναι η καλύτερη αρχή της βραδιάς.",
      "Διπλό|Όποιο δεκάρι κι αν έρθει, κάνεις 21.",
      "Διπλό|11 απέναντι σε {dealer}: μη σκέφτεσαι, πίεσε.",
      "Διπλό|Έντεκα. Ποντάρισμα ×2 και περίμενε δεκάρι.",
      "Διπλό|Το πιο γλυκό χέρι. Μην το χαραμίσεις.",
    ],
    double_na: [
      "{act}|Διπλό δεν γίνεται — να η εφεδρική κίνηση.",
      "{act}|Εδώ ήθελε διπλό, αλλά δεν βγαίνει.",
      "{act}|Χωρίς διπλό, το κρατάμε απλό.",
      "{act}|Το διπλό δεν επιτρέπεται, οπότε έτσι.",
      "{act}|Κρίμα, όχι διπλό. Τότε αυτό.",
    ],
    soft_hit: [
      "Τράβα|Με άσο το κάψιμο δεν απειλεί.",
      "Τράβα|Μαλακό {you}: ο άσος σε καλύπτει.",
      "Τράβα|{you} με άσο — μηδενικό ρίσκο.",
      "Τράβα|Ο άσος σε σώζει. Με τόλμη.",
      "Τράβα|Το μαλακό χέρι θέλει άλλο ένα.",
    ],
    soft18_hit: [
      "Τράβα|Μαλακό 18 απέναντι σε {dealer} είναι λίγο.",
      "Τράβα|Δείχνω {dealer}: το 18 δεν αντέχει.",
      "Τράβα|18 με άσο — ο άσος σε προστατεύει.",
      "Τράβα|Ο άσος κόβει το κάψιμο. Δοκίμασε βελτίωση.",
      "Τράβα|Το μαλακό 18 δεν κρατά τέτοιο φύλλο.",
    ],
    soft_double: [
      "Διπλό|{you} με άσο — το κάψιμο δεν δαγκώνει.",
      "Διπλό|Δείχνω {dealer}: πίεσε με ×2.",
      "Διπλό|Ο άσος σε καλύπτει, το φύλλο μου είναι αδύναμο.",
      "Διπλό|{you} απέναντι σε {dealer} — διπλασίασε και περίμενε.",
      "Διπλό|Εδώ η απληστία δικαιολογείται.",
    ],
    soft_stand: [
      "Στοπ|Το μαλακό {you} είναι ήδη εξαιρετικό χέρι.",
      "Μείνε|{you} με άσο — κατέβασε τα φύλλα.",
      "Στοπ|Καλύτερα δεν γίνεται. Μην αγγίζεις.",
      "Στοπ|Κάτσε ήσυχα, το {you} αξίζει πολλά.",
      "Μείνε|Μαλακό {you}: υπέροχο. Τελειώσαμε.",
    ],
    split_aces: [
      "Σπλιτ|Δύο άσοι — πάντα χωρίζονται.",
      "Σπλιτ|Κάθε άσος παίρνει δικό του χέρι.",
      "Σπλιτ|Οι άσοι μαζί πάνε χαμένοι. Χώρισέ τους.",
      "Σπλιτ|Δύο ευκαιρίες κερδίζουν μία.",
      "Σπλιτ|Αυτό το ζευγάρι εγώ δεν το κρατάω μαζί.",
    ],
    split_eights: [
      "Σπλιτ|Δύο οχτάρια — πάντα χωρίζονται.",
      "Σπλιτ|Το 16 είναι το χειρότερο χέρι. Σπάστο.",
      "Σπλιτ|Τα οχτάρια μαζί κάνουν 16. Άχ.",
      "Σπλιτ|Ακόμα και απέναντι σε {dealer}, τα οχτάρια χωρίζονται.",
      "Σπλιτ|Δύο χέρια από οχτάρια κερδίζουν ένα 16.",
    ],
    split: [
      "Σπλιτ|{pair} απέναντι σε {dealer} — χώρισέ τα.",
      "Σπλιτ|Δύο χέρια απέναντι σε {dealer} αποδίδουν.",
      "Σπλιτ|{pair}: δύο ευκαιρίες κερδίζουν μία.",
      "Σπλιτ|Δείχνω {dealer} — δύο χέρια πονάνε περισσότερο.",
      "Σπλιτ|{pair} είναι καλύτερα χωριστά.",
    ],
    split_na: [
      "{act}|Σπλιτ δεν υπάρχει. Παίξε όλο το χέρι.",
      "{act}|Δεν χωρίζεται, οπότε εφεδρική κίνηση.",
      "{act}|Το ζευγάρι δεν χωρίζεται: παίξε το σαν {hard}.",
      "{act}|Χωρίς σπλιτ το χέρι είναι {hard}.",
      "{act}|Το σπλιτ έκλεισε. Πάρε την εφεδρική κίνηση.",
    ],
    pair_hit: [
      "Τράβα|Απέναντι σε {dealer} δεν χωρίζεις.",
      "Τράβα|Μην χωρίσεις: είναι απλώς {hard}.",
      "Τράβα|Παίξε το σαν {hard}, χωρίς σπλιτ.",
      "Τράβα|Το σπλιτ θα το χειροτερέψει. Απλώς φύλλο.",
      "Τράβα|Αυτό το ζευγάρι δεν αξίζει σπλιτ.",
    ],
    pair_stand: [
      "Στοπ|Μην χωρίσεις: το {hard} είναι ήδη δυνατό.",
      "Στοπ|{hard} απέναντι σε {dealer} — κράτα το ολόκληρο.",
      "Μείνε|Αν το χωρίσεις, μου χαρίζεις μάρκες.",
      "Στοπ|Το ζευγάρι είναι καλύτερο ολόκληρο. Μην αγγίζεις.",
      "Μείνε|Αυτό το ζευγάρι είναι δυνατότερο ενωμένο.",
    ],
    pair_double: [
      "Διπλό|Δύο πεντάρια κάνουν 10, όχι ζευγάρι.",
      "Διπλό|Τα πεντάρια δεν χωρίζονται — διπλασιάζονται.",
      "Διπλό|10 απέναντι σε {dealer}: ποντάρισμα ×2.",
      "Διπλό|Είναι 10, όχι δύο πεντάρια.",
      "Διπλό|Δέκα πόντοι — πίεσε με ×2.",
    ],
  },
};

// слово-действие для запасного хода ({act}) — то же, что подсвечивается в подсказке
const FALLBACK_WORDS = {
  ru: { hit: "Бери", stand: "Стой", double: "Удваивай", split: "Сплит" },
  en: { hit: "Hit", stand: "Stand", double: "Double", split: "Split" },
  el: { hit: "Τράβα", stand: "Στοπ", double: "Διπλό", split: "Σπλιτ" },
};
// очевидные ситуации: после первых раздач хватает одного слова-действия, без «почему»
const OBVIOUS_KEYS = ["blackjack", "bust", "twentyone", "stand_high", "hit_free", "soft_stand"];

const defaultRnd = (n) => Math.floor(Math.random() * n);

function upName(up, lang, gen) {
  const r = rankOf(up);
  const key = cardValue(r) === 10 ? "10" : r;
  if (gen && CARD_NAMES_GEN[lang]) return CARD_NAMES_GEN[lang][key];
  return (CARD_NAMES[lang] || CARD_NAMES.ru)[key];
}

function bareName(up, lang) {
  const r = rankOf(up);
  const key = cardValue(r) === 10 ? "10" : r;
  return (CARD_NAMES_BARE[lang] || CARD_NAMES[lang] || CARD_NAMES.ru)[key];
}

// «Рука N:» — для рук после сплита; на других языках то же
const HAND_PREFIX = { ru: "Рука", en: "Hand", el: "Χέρι" };

// страховка от склеек слов в шаблонах: «пара пара», «a a» — второе подряд такое же слово убираем
const DUP_WORD = /(^|[\s,:;—-])([A-Za-zА-Яа-яЁёΑ-Ωα-ωΆ-ώ]{2,})\s+\2(?=[\s.,:;!?—]|$)/gi;

function pairName(cards, lang) {
  const r = rankOf(cards[0]);
  const key = cardValue(r) === 10 ? "10" : r;
  return (PAIR_NAMES[lang] || PAIR_NAMES.ru)[key];
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/*
 * Подсказка Марго по частям: {action, key, lead, rest, prefix, text}. lead — слово-действие («Бери»), rest — одна короткая причина,
 * prefix — «Рука 2» после сплита (если задан hand.handIdx), text — всё вместе («Рука 2: Бери. 14 против шестёрки…»).
 * hand — как в advise(); lang — ru|en|el; rnd(n) — случайность снаружи. hand.lastHint (текст прошлой подсказки, с префиксом или без)
 * в выборе не участвует: такую же фразу подряд не выдаём.
 */
function hintParts(hand, up, lang, rnd) {
  lang = PHRASES[lang] ? lang : "ru";
  rnd = rnd || defaultRnd;
  const a = advise(hand, up);
  const cards = hand.cards || hand;
  const hardVal = a.soft ? a.value - 10 : a.value;
  const you = a.soft && a.value !== 21 ? hardVal + "/" + a.value : String(a.value);
  const fill = (tpl) => tpl
    .replace(/\{act\}/g, FALLBACK_WORDS[lang][a.action])
    .replace(/\{you\}/g, you)
    .replace(/\{hard\}/g, String(a.value))
    .replace(/\{dealerGen\}/g, upName(up, lang, true))
    .replace(/\{dealerBare\}/g, bareName(up, lang))
    .replace(/\{dealer\}/g, upName(up, lang))
    .replace(/\{pair\}/g, pairName(cards, lang))
    .replace(DUP_WORD, "$1$2");
  const rendered = PHRASES[lang][a.key].map((tpl) => { const i = tpl.indexOf("|"); return { lead: capitalize(fill(tpl.slice(0, i))), rest: capitalize(fill(tpl.slice(i + 1))) }; });
  const last = hand && hand.lastHint ? String(hand.lastHint).replace(/^[^:]{1,12}\d:\s/, "") : "";
  let pool = rendered;
  if (last && rendered.length > 1) pool = rendered.filter((x) => x.lead + ". " + x.rest !== last);
  const pick = pool[rnd(pool.length)];
  const prefix = hand && hand.fromSplit && typeof hand.handIdx === "number" ? HAND_PREFIX[lang] + " " + (hand.handIdx + 1) : "";
  const body = pick.lead + ". " + pick.rest;
  return { action: a.action, key: a.key, lead: pick.lead, rest: pick.rest, prefix: prefix, body: body, text: prefix ? prefix + ": " + body : body };
}

/*
 * Нарастающая подача: сколько показывать, если игрок уже видел подсказки в seen раздачах.
 * full — слово + причина; lead — только слово-действие (причина по тапу в «Спроси Марго»); quiet — приглушённое слово.
 * Первые 3 раздачи объясняем всё; очевидное сокращается раньше (до слова, потом приглушается), нетривиальное — позже всех.
 */
function hintMode(key, seen) {
  seen = seen > 0 ? seen : 0;
  if (seen < 3) return "full";
  if (OBVIOUS_KEYS.indexOf(key) >= 0) return seen < 8 ? "lead" : "quiet";
  return seen < 12 ? "full" : "lead";
}

// Подсказка одной строкой (для листа «Спроси Марго» и тестов)
function hint(hand, up, lang, rnd) { return hintParts(hand, up, lang, rnd).text; }

const API = { advise: advise, hint: hint, hintParts: hintParts, OBVIOUS_KEYS: OBVIOUS_KEYS, hintMode: hintMode, handValue: handValue, HARD: HARD, SOFT: SOFT, PAIRS: PAIRS, UP: UP, ACTION: ACTION, PHRASES: PHRASES, CARD_NAMES: CARD_NAMES, CARD_NAMES_GEN: CARD_NAMES_GEN, CARD_NAMES_BARE: CARD_NAMES_BARE, PAIR_NAMES: PAIR_NAMES, FALLBACK_WORDS: FALLBACK_WORDS, upName: upName, pairName: pairName };
if (typeof module !== "undefined" && module.exports) module.exports = API;
else window.BlackjackStrategy = API;

})();
