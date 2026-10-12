"use strict";
/*
 * restore — шаблон теста «restore из дампа прошлой версии» (T-W0-31, IMPLEMENTATION-PLAN §10.1, R2-7).
 *
 * ПРАВИЛО. Комнаты после деплоя поднимаются из дампа `game.s` целиком; `Game.from(state)` просто оборачивает
 * объект, миграции нет. Поэтому любое НОВОЕ поле состояния, которое добавляет задача, обязано читаться как
 * «поля нет = старое поведение» (`s.x || 0`, `s.x !== undefined`, `?? default`), а метки времени
 * (`offSince`, `waitUntil`) при отсутствии — это «момент restore», а не «давно» (иначе после каждого деплоя
 * выкинет всё лобби). Каждая задача, добавляющая поле, добавляет в test-server.js своей игры кейс
 * «restore-from-prev-dump: <поле>» по шаблону ниже.
 *
 * ШАБЛОН кейса (server-level, на живом сервере игры):
 *   1. поднять партию до состояния, где новое поле заполняется (или собрать состояние через Game.create);
 *   2. остановить сервер (SIGTERM пишет DUMP_FILE) и прочитать дамп — это формат «текущей» версии;
 *   3. restore.makeOldDump(dump, { "<code>": ["players[].played", "chooseExtended"] }) — вырезать новые поля;
 *      restore.assertAbsent(...) — убедиться, что в «старом» дампе их правда нет;
 *   4. записать, поднять сервер, зайти доской/по токену, провести партию дальше (end/ответы/голоса) и
 *      проверить финал, награды и снимки — без исключений, без нулей «вместо» старого поведения.
 *
 * Пути полей: "a.b" — вложенный объект, "arr[].x" — поле у каждого элемента массива, "m{}.x" — у каждого
 * значения объекта-словаря. Отсутствующий путь — не ошибка (поле могло не успеть появиться).
 *
 *   const restore = require("../tools/testkit/restore");
 *   const old = restore.makeOldDump(JSON.parse(fs.readFileSync(DUMP, "utf8")), { ROOM1: ["players[].played"] });
 *   fs.writeFileSync(DUMP, JSON.stringify(old));
 */

function stripPath(obj, segs) {
  if (obj == null || typeof obj !== "object" || !segs.length) return 0;
  const [head, ...rest] = segs;
  let n = 0;
  const m = /^(.*?)(\[\]|\{\})$/.exec(head);
  if (m) {
    const key = m[1];
    const holder = key ? obj[key] : obj;
    if (holder == null || typeof holder !== "object") return 0;
    const items = m[2] === "[]" ? (Array.isArray(holder) ? holder : []) : Object.values(holder);
    for (const it of items) n += rest.length ? stripPath(it, rest) : 0;
    return n;
  }
  if (!rest.length) {
    if (Object.prototype.hasOwnProperty.call(obj, head)) { delete obj[head]; return 1; }
    return 0;
  }
  return stripPath(obj[head], rest);
}

/** Удаляет поля по путям из глубокой копии состояния; возвращает { state, removed }. */
function stripFields(state, paths) {
  const copy = JSON.parse(JSON.stringify(state));
  let removed = 0;
  for (const p of paths || []) removed += stripPath(copy, p.split("."));
  return { state: copy, removed };
}

/** Есть ли путь (хотя бы один элемент) в состоянии — для assertAbsent. */
function hasPath(obj, segs) {
  if (obj == null || typeof obj !== "object" || !segs.length) return false;
  const [head, ...rest] = segs;
  const m = /^(.*?)(\[\]|\{\})$/.exec(head);
  if (m) {
    const holder = m[1] ? obj[m[1]] : obj;
    if (holder == null || typeof holder !== "object") return false;
    const items = m[2] === "[]" ? (Array.isArray(holder) ? holder : []) : Object.values(holder);
    return items.some((it) => (rest.length ? hasPath(it, rest) : false));
  }
  if (!rest.length) return Object.prototype.hasOwnProperty.call(obj, head);
  return hasPath(obj[head], rest);
}

function assertAbsent(state, paths) {
  const left = (paths || []).filter((p) => hasPath(state, p.split(".")));
  if (left.length) throw new Error("в «старом» дампе остались поля: " + left.join(", "));
}

/**
 * dump — массив записей комнат серверов игр ([{code, hostToken, tokens, state, ...}]).
 * fieldsByCode — { <код комнаты>: [пути…] } или массив путей для всех комнат.
 * Возвращает новый массив; исходный не меняется. Проверяет, что поля вырезаны (assertAbsent).
 */
function makeOldDump(dump, fieldsByCode) {
  return dump.map((room) => {
    const paths = Array.isArray(fieldsByCode) ? fieldsByCode : fieldsByCode[room.code];
    if (!paths || !paths.length) return room;
    const { state } = stripFields(room.state, paths);
    assertAbsent(state, paths);
    return Object.assign({}, room, { state });
  });
}

/** Одна запись дампа из готового состояния (для тестов, где состояние собрано через Game.create). */
function roomEntry({ code, hostToken, state, tokens, ip, touched }) {
  return { code, ip: ip || "", hostToken, tokens: tokens || {}, touched: touched || Date.now(), state };
}

module.exports = { stripFields, hasPath, assertAbsent, makeOldDump, roomEntry };
