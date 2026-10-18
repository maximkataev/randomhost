"use strict";

/*
 * Боты «Ставок» — только режим разработки (NODE_ENV=development), чтобы гонять партию одному.
 * decide() возвращает купон [[marketId, stake], ...] на текущее событие или null (бот «спит» и не сдаёт купон,
 * получая штраф за недобор). Ставки целые, не меньше MIN_STAKE, сумма не больше стека.
 */

const STRATEGIES = ["minimum", "coin", "long", "spread", "chaser", "sleeper"];

const round10 = (x) => Math.max(10, Math.round(x / 10) * 10);

function decide(strategy, { game, player, rnd }) {
  const markets = game.cur && game.cur.markets;
  if (!markets || !markets.length) return null;
  const stack = player.stack;
  const min = game.minStake(player);
  const pick = (list) => list[rnd(list.length)];
  const fit = (n) => Math.max(min, Math.min(stack, round10(n)));
  switch (strategy) {
    case "minimum": { // минимум на самый вероятный рынок
      const m = markets.slice().sort((a, b) => b.p - a.p)[0];
      return [[m.id, fit(min)]];
    }
    case "coin": { // 15% стека на рынок около «орла или решки»
      const ms = markets.filter((m) => m.p > 0.35 && m.p < 0.65);
      return [[pick(ms.length ? ms : markets).id, fit(stack * 0.15)]];
    }
    case "long": { // длинный коэффициент
      const ms = markets.filter((m) => m.kc >= 800 && m.kc <= 4000);
      return [[pick(ms.length ? ms : markets).id, fit(stack * 0.2)]];
    }
    case "spread": { // 2–3 разных рынка, поровну
      const k = Math.min(markets.length, 2 + rnd(2));
      const pool = markets.slice(), ids = [];
      while (ids.length < k) ids.push(pool.splice(rnd(pool.length), 1)[0].id);
      const each = Math.max(10, Math.floor(Math.max(min, stack * 0.25) / k / 10) * 10);
      const out = ids.map((id) => [id, Math.min(each, Math.floor(stack / k))]).filter(([, v]) => v >= 10);
      const total = out.reduce((a, [, v]) => a + v, 0);
      if (total < min && out.length) out[0][1] += Math.min(stack - total, min - total);
      return out.length ? out : [[ids[0], fit(min)]];
    }
    case "chaser": { // отстаёт — ва-банк на длинный, иначе осторожно
      const alive = game.alive();
      const leader = Math.max(...alive.map((p) => p.stack));
      if (stack * 3 < leader) {
        const ms = markets.filter((m) => m.kc >= 500);
        return [[pick(ms.length ? ms : markets).id, stack]];
      }
      const m = markets.slice().sort((a, b) => b.p - a.p)[0];
      return [[m.id, fit(min * 2)]];
    }
    case "sleeper": // иногда забывает про купон
      return rnd(2) ? null : [[pick(markets).id, fit(min)]];
    default:
      return [[markets[0].id, fit(min)]];
  }
}

module.exports = { decide, STRATEGIES };
