"use strict";

/*
 * Анонимные счётчики по вопросам для калибровки колоды (crowd-spec.md §6): сколько голосов «за» каждую сторону
 * и сколько мнений. Идентификаторов игроков нет. Берём только раунды с ≥ 4 голосами (их отфильтровывает движок),
 * с потолком вклада одной комнаты (не более 3 раундов одного вопроса), чтобы три знакомых человека не перекосили данные.
 * Файл лежит в томе (STATS_FILE, по умолчанию state/qstats.json); если он недоступен, игра не падает.
 */

const fs = require("fs");
const path = require("path");

const FILE = process.env.STATS_FILE || path.join(__dirname, "state", "qstats.json");
const ROOM_CAP = 3;
const MAX_IDS = 20000; // потолок записей: чужой id из подделанного события не раздувает файл

let data = {}; // id → {n, a, b, oa, ob}
let dirty = false;
const perRoom = new Map(); // "код|id" → сколько раз учтено

function load() {
  try {
    if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (err) {
    console.warn("[crowd] статистика не прочиталась:", err.message);
    data = {};
  }
}

function record(room, e) {
  if (!e || typeof e.id !== "string" || e.id.length > 40) return;
  const key = room + "|" + e.id;
  const have = perRoom.get(key) || 0;
  if (have >= ROOM_CAP) return;
  if (!data[e.id] && Object.keys(data).length >= MAX_IDS) return;
  if (perRoom.size > 50000) perRoom.clear();
  perRoom.set(key, have + 1);
  const d = data[e.id] || (data[e.id] = { n: 0, a: 0, b: 0, oa: 0, ob: 0 });
  d.n++; d.a += e.a | 0; d.b += e.b | 0; d.oa += e.oa | 0; d.ob += e.ob | 0;
  dirty = true;
}

function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(data));
    fs.renameSync(FILE + ".tmp", FILE);
    dirty = false;
  } catch (err) {
    console.warn("[crowd] статистика не записалась:", err.message);
  }
}

module.exports = { load, record, flush, get: () => data };
