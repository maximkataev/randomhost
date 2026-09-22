"use strict";

/*
 * Боты для отладки и симуляций. Стратегия смотрит на снимок и решает, ставить ли сейчас.
 * Каждая стратегия возвращает сумму ставки или null. Вызывается с частотой раз в ~700 мс на бота.
 */

const STRATEGIES = {
  // ставит почти на всё, но не выше трети бюджета за лот
  aggressive: (snap, me, rng) => {
    if (snap.price >= Math.max(3, Math.floor(snap.settings.budget / 3))) return null;
    return rng() < 0.6 ? snap.price + 1 : null;
  },
  // ждёт, пока лот подешевеет, берёт по $1–$3, иногда +$5 в конце
  frugal: (snap, me, rng) => {
    if (snap.price >= 3) return null;
    const lateGame = snap.round > snap.rounds * 0.6;
    if (lateGame && rng() < 0.3) return snap.price + 5;
    return rng() < 0.25 ? snap.price + 1 : null;
  },
  // почти не ставит: копит и скупает хвост
  passive: (snap, me, rng) => {
    const lateGame = snap.round > snap.rounds * 0.75;
    if (!lateGame) return rng() < 0.03 ? 1 : null;
    return rng() < 0.7 ? snap.price + 1 : null;
  },
  // «отвалившийся»: ничего не делает
  afk: () => null,
};

function decide(strategy, snap, playerId, rng = Math.random) {
  const me = snap.players.find((p) => p.id === playerId);
  if (!me || !me.canBid || snap.leaderId === playerId) return null;
  if (snap.phase !== "lot" && snap.phase !== "bidding") return null;
  const fn = STRATEGIES[strategy] || STRATEGIES.frugal;
  const amount = fn(snap, me, rng);
  if (amount == null) return null;
  return Math.min(amount, me.money);
}

module.exports = { STRATEGIES, decide };
