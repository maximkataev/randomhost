"use strict";

/*
 * Коэффициенты и выплаты (bets-spec.md §3).
 * k = floor₀,₀₁((1 − m) / p). Все коэффициенты хранятся целыми сотыми (kc = 188 → 1,88), выплата — целые фишки.
 * Округление всегда вниз: оно не может сыграть в пользу игрока.
 */

// Классы маржи (§3.2, §4, §10). Сценические события — точные, реальные — оценки, у них маржа выше.
const MARGIN = {
  main: 0.06,
  side: 0.08,
  exotic: 0.10,
  forecast: 0.12, // точная пара (форкаст)
  live: 0.08,     // оценки по котировкам и счётчикам: центр
  liveTail: 0.10, // то же, хвосты
  thresh: 0.12,   // пороговые рынки (правки, киты)
  news: 0.15,     // оценки по новостям
  categ: 0.08,    // категориальные рулетки реального мира
  beacon: 0.05,   // drand: точные вероятности
};

const K_MIN = 105;   // 1,05: ниже ставить бессмысленно
const K_MAX = 20000; // 200,00: выше — лотерея, размывает табло
const MIN_STAKE = 10;

// Коэффициент в сотых или null, если рынок не предлагается
function quote(p, m) {
  if (!(p > 0 && p < 1)) return null;
  const kc = Math.floor((1 - m) / p * 100 + 1e-9);
  return kc < K_MIN || kc > K_MAX ? null : kc;
}

const payout = (stake, kc) => Math.floor((stake * kc) / 100);

/*
 * Рынок: id, group, p (вероятность), m (маржа), kc (коэффициент в сотых), test(outcome) → выиграл ли.
 * Рынок вне диапазона коэффициентов не создаётся (null).
 */
function market(id, group, p, m, test) {
  const kc = quote(p, m);
  return kc === null ? null : { id, group, p, m, kc, test };
}

const clean = (list) => list.filter(Boolean);

// Вероятность рынка по полному перебору исходов: omega — [{o, P}]
function enumerateP(omega, test) {
  let p = 0;
  for (const { o, P } of omega) if (test(o)) p += P;
  return p;
}

// Инварианты книги (используются тестами): p·k ≤ 1 − m, потеря на округлении ≤ 0,01·p
function checkBook(markets) {
  const bad = [];
  for (const mk of markets) {
    const rtp = mk.p * mk.kc / 100;
    if (rtp > 1 - mk.m + 1e-9) bad.push(`${mk.id}: RTP ${rtp} > ${1 - mk.m}`);
    if (rtp < 1 - mk.m - 0.01 * mk.p - 1e-9) bad.push(`${mk.id}: округление съело больше 0,01·p`);
    if (mk.kc < K_MIN || mk.kc > K_MAX) bad.push(`${mk.id}: kc ${mk.kc} вне диапазона`);
  }
  return bad;
}

// Сумма обратных коэффициентов полного набора взаимоисключающих рынков («книга», §3.3)
const bookSum = (markets) => markets.reduce((s, mk) => s + 100 / mk.kc, 0);

module.exports = { MARGIN, K_MIN, K_MAX, MIN_STAKE, quote, payout, market, clean, enumerateP, checkBook, bookSum };
