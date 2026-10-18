"use strict";

/*
 * Синтетика для теста «Аэропорт-дуэль» (test-feed.js): истина о движении самолётов у 16 аэропортов за 40 минут
 * (взлёты, посадки, пролёты, такси) и построитель ответа ADS-B API по этой истине на любую секунду.
 * Формат ответа повторяет реальные образцы fixtures/airport-lol-lhr.json и airport-fi-fra.json.
 * Запуск: node bets/fixtures/gen-airport.js (перезаписывает airport-synth.json.gz). Детерминированно по сиду.
 */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const SPAN = 40 * 60;      // секунд истории
// взлётов в минуту (по измерению 18.10 порядок 0,5–1,5); пары подобраны близкими
const RATES = { LHR: 0.9, FRA: 0.8, AMS: 0.85, CDG: 0.95, DXB: 0.6, IST: 0.7, JFK: 0.75, LAX: 0.8, ATL: 1.0, DFW: 0.9, ORD: 1.0, DEN: 0.8, MAD: 0.55, MUC: 0.6, FCO: 0.5, BCN: 0.45 };

function build(seed = 20261018) {
  const rnd = mulberry32(seed);
  const truth = {};
  let n = 0;
  const hex = () => (0x400000 + (n++) * 977).toString(16).padStart(6, "0");
  for (const [ap, perMin] of Object.entries(RATES)) {
    const ev = [];
    // момент старта разбега: экспоненциальные интервалы, начиная до нулевой секунды, чтобы поток был установившимся
    for (let t = -300 - Math.log(1 - rnd()) * 60 / perMin; t < SPAN; t += -Math.log(1 - rnd()) * 60 / perMin) {
      ev.push({ kind: "takeoff", t0: Math.round(t), hex: hex(), flight: "TK" + (100 + Math.floor(rnd() * 900)), noGround: rnd() < 0.15 });
    }
    for (let t = rnd() * 80; t < SPAN; t += -Math.log(1 - rnd()) * 60 / (perMin * 0.9)) ev.push({ kind: "landing", t0: Math.round(t), hex: hex(), flight: "LD" + Math.floor(rnd() * 900) });
    for (let t = rnd() * 200; t < SPAN; t += -Math.log(1 - rnd()) * 60 / 0.3) ev.push({ kind: "over", t0: Math.round(t), hex: hex(), flight: "OV" + Math.floor(rnd() * 900) });
    truth[ap] = ev;
  }
  return { span: SPAN, truth };
}

const KM_LAT = 1 / 110.574;
// одно судно в момент s (секунд от t0): null, если его нет в кадре
function craft(e, s, A) {
  const lonK = 1 / (111.32 * Math.cos(A.lat * Math.PI / 180));
  const mk = (km, alt, gs, rate, extra) => Object.assign({ hex: e.hex, type: "adsb_icao", flight: e.flight.padEnd(8), alt_baro: alt, gs, baro_rate: rate, lat: A.lat + km * KM_LAT, lon: A.lon + 1.0 * lonK, category: "A3" }, extra);
  if (e.kind === "takeoff") {
    if (s < 0 || s > 240) return null;
    if (s < 15) return e.noGround ? null : mk(0.5, "ground", 4, 0);
    if (s < 40) return e.noGround ? null : mk(0.5 + 0.0385 * (s - 15), "ground", 20 + (s - 15) * 4.5, 0);
    const km = 0.5 + 0.0385 * (s - 15);
    if (km > 9.4) return null;
    return mk(km, Math.round(A.elev + 50 + (s - 40) * 35), 150, 2100);
  }
  if (e.kind === "landing") {
    if (s < 0 || s > 100) return null;
    if (s < 60) return mk(8 - 0.1167 * s, Math.round(A.elev + 1500 - s * 25), 140, -700);
    return mk(1, "ground", Math.max(10, 100 - (s - 60) * 3), 0);
  }
  if (s < 0 || s > 60) return null;                                   // пролёт на эшелоне
  return mk(-8 + s * 0.27, 12000, 420, 0);
}

// ответ API для аэропорта ap в момент sec; style "lol" ({ac}) или "fi" ({aircraft})
function snapshot(data, A, ap, sec, style = "lol") {
  const list = [];
  for (const e of data.truth[ap]) { const c = craft(e, sec - e.t0, A); if (c) list.push(c); }
  // неподвижные такси для шума
  for (let i = 0; i < 4; i++) list.push({ hex: "a0000" + i, flight: "TAXI" + i, alt_baro: "ground", gs: 6 + i, lat: A.lat + (0.3 + i * 0.1) * KM_LAT, lon: A.lon, category: "A3" });
  return style === "fi" ? { now: sec, total: list.length, aircraft: list } : { now: sec, total: list.length, ac: list };
}

if (require.main === module) {
  const data = build();
  fs.writeFileSync(path.join(__dirname, "airport-synth.json.gz"), zlib.gzipSync(JSON.stringify(data)));
  const tk = Object.values(data.truth).reduce((a, v) => a + v.filter((e) => e.kind === "takeoff").length, 0);
  console.log("airport-synth.json.gz: аэропортов", Object.keys(data.truth).length, "взлётов", tk);
}
module.exports = { build, snapshot, craft, RATES, SPAN };
