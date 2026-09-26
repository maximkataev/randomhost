"use strict";

/*
 * Боты рулетки — для стенда баланса (sim.js) и серверных тестов. В живой игре ботов нет.
 * decide() возвращает полный набор ставок на спин (для setBets), playCard() — карту и цель или null.
 */

const { BETS } = require("./game");

const STRATEGIES = ["red", "spread", "martingale", "chaser", "minimum", "cards"];
const NUMBERS = Object.keys(BETS).filter((k) => k.startsWith("n:"));
const EVEN = ["red", "black", "even", "odd", "low", "high"];

const cap = (bets, stack) => {
  // урезаем набор до стека: сначала самые крупные позиции
  let total = Object.values(bets).reduce((a, b) => a + b, 0);
  if (total <= stack) return bets;
  const k = stack / total;
  const out = {};
  for (const [key, a] of Object.entries(bets)) {
    const v = Math.floor(a * k);
    if (v > 0) out[key] = v;
  }
  return out;
};

function decide(strategy, { game, player, mem, rnd }) {
  const min = game.need(player);
  const stack = player.stack;
  const leader = Math.max(...game.alive().map((p) => p.stack));
  let bets = {};
  switch (strategy) {
    case "red":
      bets = { red: Math.min(stack, Math.max(min, game.minBet() * 2)) };
      break;
    case "spread": {
      // 3–5 чисел, в сумме около двух минимумов
      const k = 3 + rnd(3);
      const each = Math.max(1, Math.floor((min * 2) / k));
      const pool = NUMBERS.slice();
      for (let i = 0; i < k; i++) bets[pool.splice(rnd(pool.length), 1)[0]] = each;
      // округление вниз не должно уводить под минимум — добиваем первую позицию
      const got = each * k;
      if (got < min) bets[Object.keys(bets)[0]] += min - got;
      break;
    }
    case "martingale": {
      mem.unit = mem.unit || min;
      if (mem.lastNet === undefined || mem.lastNet > 0) mem.stake = Math.max(min, mem.unit);
      else mem.stake = (mem.stake || min) * 2;
      if (mem.stake > stack / 2) mem.stake = min; // серия проиграна — начинаем заново
      bets = { [EVEN[rnd(2)]]: Math.min(stack, mem.stake) };
      break;
    }
    case "chaser":
      // отстаёт от лидера втрое — идёт ва-банк на число, иначе дюжина
      if (stack * 3 < leader) bets = { [NUMBERS[rnd(NUMBERS.length)]]: stack };
      else bets = { [`dz:${1 + rnd(3)}`]: Math.min(stack, min * 2) };
      break;
    case "minimum":
      bets = { [EVEN[rnd(EVEN.length)]]: min };
      break;
    case "cards":
      bets = { [EVEN[rnd(EVEN.length)]]: Math.min(stack, Math.max(min, game.minBet() * 2)) };
      break;
    default:
      bets = { red: min };
  }
  return cap(bets, stack);
}

// Карты: «cards» и «chaser» играют при первой возможности в самого богатого соперника, остальные — изредка
function playCard(strategy, { game, player, rnd }) {
  if (player.out) return null;
  const card = player.hand.find((c) => c !== "shield");
  if (!card) return null;
  if (strategy !== "cards" && strategy !== "chaser" && rnd(3)) return null;
  const rivals = game.alive().filter((p) => p.id !== player.id).sort((a, b) => b.stack - a.stack);
  if (!rivals.length) return null;
  return { card, target: rivals[0].id };
}

module.exports = { decide, playCard, STRATEGIES };
