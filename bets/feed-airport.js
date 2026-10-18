"use strict";

/*
 * ✈ Аэропорт-дуэль (R9, §10.2): честная заглушка. prepare() всегда null — слот заменяется сценическим событием.
 *
 * Почему: airplanes.live без договорённости отдаёт отказ («Please contact us at contact@airplanes.live...»
 * с описанием проекта), а анонимный OpenSky ограничен ~400 запросами в сутки и для взлётов (опрос раз в 5–10 с
 * в течение 90 с у двух аэропортов) не годится. Когда будет разрешение или ключ, сюда добавляется опрос
 * {BETS_ADSB_URL}/point/lat/lon/8nm и счёт перехода «на земле» → набор высоты; математика (duel с точной
 * свёрткой, φ ≈ 1.3, T = 90) уже есть в events/live.js.
 */
function create() {
  return {
    types: ["airport"],
    start() {}, stop() {},
    status() { return { ok: false, lastAt: 0, note: "заглушка: нет доступа к ADS-B" }; },
    prepare() { return null; },
    begin(type, opts) { setTimeout(() => opts.onAbort && opts.onAbort("airport: источник не подключён"), 0); return { cancel() {} }; },
  };
}
module.exports = { create };
