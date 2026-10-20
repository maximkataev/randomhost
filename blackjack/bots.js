"use strict";

/*
 * Боты блэкджека — для стенда баланса (sim.js) и серверных тестов. В живой игре ботов нет.
 * Стратегии из спеки §12: базовая, «никогда не беру на 12+», «всегда удваиваю 9–11», «ровно минимум»,
 * «побочные всегда», «ва-банк при отставании», «карты при первой возможности».
 *
 * decideBet()    → {main, pp, tp, allIn} на фазу ставок (сим применяет через setBets/allIn)
 * decideAction() → "hit" | "stand" | "double" | "split" для одной руки в волне
 * decideInsurance() → true | false | "evenMoney"
 * playCard()     → {card, target} | null
 */

const { advise, handValue } = require("./strategy");
const { SELF_TRICKS } = require("./game");

const STRATEGIES = ["basic", "never12", "double911", "minimum", "sides", "allin", "cards"];

function decideBet(strategy, ctx) {
  const { game, player, rnd } = ctx;
  const need = game.need(player);
  const min = game.levelNeed();
  const stack = player.stack;
  const leader = Math.max.apply(null, game.alive().map((p) => p.stack));
  // обычная ставка — два минимума, но не больше четверти стека: так ставят люди, пока минимум не прижал
  const usual = Math.min(stack, Math.max(need, Math.min(min * 2, Math.floor(stack / 4))));
  switch (strategy) {
    case "minimum":
      return { main: need, pp: 0, tp: 0 };
    case "sides": {
      const main = usual;
      const side = Math.min(main, Math.max(1, Math.floor(main / 2)));
      const free = stack - main;
      const pp = Math.min(side, Math.floor(free / 2));
      const tp = Math.min(side, free - pp);
      return { main: main, pp: pp, tp: tp };
    }
    case "allin":
      // отстаёт от лидера втрое — весь стек на основную
      if (stack * 3 < leader) return { main: stack, pp: 0, tp: 0, allIn: true };
      return { main: usual, pp: 0, tp: 0 };
    default:
      // лёгкая вариативность, чтобы столы не были одинаковыми: иногда 3 минимума
      return { main: Math.min(stack, rnd(4) === 0 ? Math.max(need, min * 3) : usual), pp: 0, tp: 0 };
  }
}

// действие по руке: options — что разрешено движком (game.options(p, h))
function decideAction(strategy, ctx) {
  const { hand, up, options } = ctx;
  const a = advise({ cards: hand.cards, canDouble: options.double, canSplit: options.split, fromSplit: hand.fromSplit }, up);
  let action = options[a.action] ? a.action : a.fallback;
  const hv = handValue(hand.cards);
  if (strategy === "never12" && !hv.soft && hv.value >= 12) action = "stand";
  if (strategy === "double911" && hand.cards.length === 2 && !hv.soft && hv.value >= 9 && hv.value <= 11 && options.double) action = "double";
  if (!options[action]) action = options.hit ? "hit" : "stand";
  return action;
}

// страховку по базовой стратегии не берут; «побочные всегда» — азартный, берёт
function decideInsurance(strategy, ctx) {
  const { player } = ctx;
  const bj = player.hands[0].cards.length === 2 && handValue(player.hands[0].cards).value === 21;
  if (bj) return strategy === "sides" ? "evenMoney" : false;
  return strategy === "sides";
}

// Карты: «cards» и «allin» играют при первой возможности — враждебные в самого богатого соперника; остальные — изредка
function playCard(strategy, ctx) {
  const { game, player, rnd } = ctx;
  if (player.out) return null;
  const card = player.trick.find((c) => c !== "shield");
  if (!card) return null;
  if (strategy !== "cards" && strategy !== "allin" && rnd(3)) return null;
  if (SELF_TRICKS.indexOf(card) >= 0) return { card: card, target: player.id };
  const rivals = game.alive().filter((p) => p.id !== player.id).sort((a, b) => b.stack - a.stack);
  if (!rivals.length) return null;
  return { card: card, target: rivals[0].id };
}

module.exports = { decideBet, decideAction, decideInsurance, playCard, STRATEGIES };
