"use strict";

/*
 * Присутствие и призраки: политика офлайн-мест в виде чистых функций
 * (IMPLEMENTATION-PLAN T-W1-03, пакет P2, К-3/К-17, R1–R6, решение U-07).
 * Без таймеров и I/O, только встроенные модули; ни одна игра пока не вызывает.
 *
 * Правила (единые для 10 игр):
 *   R1  в игре место НИКОГДА не освобождается по таймеру;
 *   R2  в лобби и в итогах офлайн-место живёт GHOST_TTL_MS (по умолч. 120 000 мс, env GHOST_TTL_MS),
 *       при заполнении комнаты вытесняется САМОЕ ДАВНЕЕ офлайн-место СТАРШЕ порога (иначе тот, кто знает
 *       код комнаты, выбивал бы только что отвалившихся); в итогах удаляются только места без участия
 *       (played = 0 и нет очков/наград); перед новой партией офлайн дольше грации уходят в `left`
 *       (токен НЕ отзывается — вернуться по токену можно);
 *   offSince — персистентное поле игрока (мс, момент ухода в офлайн), хранится в дампе; при restore из
 *       дампа — момент restore (не «давно»): после деплоя лобби не должно опустеть.
 *
 * Игрок: {id, online?:bool, offSince?:ms, left?:bool, played?:number, score|points|stack|…, awards?}.
 * `online` отсутствует = онлайн (игры добавляют поле по месту). Весь код читает «поле отсутствует = как раньше».
 *
 * ПУБЛИЧНЫЙ API (всё принимает массив players; мутируют только setOnline, onRestore, ensureOffSince и
 * pruneOfflineForNewGame — они явно названы)
 *   GHOST_TTL_MS, ghostTtlMs(env?)
 *   isOnline(p)                       -> bool       (!left && online !== false)
 *   onlineIds(players)                -> id[]
 *   onlineCount(players)              -> number
 *   setOnline(p, online, now)         -> p          offline: offSince = now (если не стоял); online: offSince убран
 *   onRestore(players, now)           -> number     всем офлайн offSince = now (вызывать при restore из дампа)
 *   ensureOffSince(players, now)      -> number     офлайн без offSince получают now (страховка)
 *   ghostAge(p, now)                  -> ms|0       сколько место офлайн (0 для онлайн/без метки)
 *   hasEarned(p, keys?)               -> bool       очки/награды/участие: played>0, ненулевые числа keys, непустые awards
 *   ghostsToDrop({players, now, stage, ttlMs?, protect?, earnedKeys?, protectEarned?}) -> id[]
 *        stage: "lobby" | "finished" | "game" — «game» всегда [] (R1)
 *   evictOldestGhost(players, {now, minAgeMs?, protect?, stage?, earnedKeys?}) -> id|null
 *        самое давнее офлайн-место старше minAgeMs (по умолч. GHOST_TTL_MS) вне protect;
 *        stage "game" -> null; в "finished" места с очками/наградами не вытесняются
 *   pruneOfflineForNewGame(players, {now, graceMs = 8000}) -> id[]   помечает left=true (токен не трогает)
 *   seatsFree(players, cap)           -> number     cap − (не left)
 */

function envInt(env, name, def) {
  const n = Number((env || {})[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

const DEFAULT_GHOST_TTL_MS = 120000;
const DEFAULT_NEWGAME_GRACE_MS = 8000;
const DEFAULT_EARNED_KEYS = Object.freeze(["score", "points", "stack", "wins"]);

function ghostTtlMs(env) {
  return envInt(env || process.env, "GHOST_TTL_MS", DEFAULT_GHOST_TTL_MS);
}
const GHOST_TTL_MS = ghostTtlMs();

const isOnline = (p) => !!p && p.left !== true && p.online !== false;
const isGhost = (p) => !!p && p.left !== true && p.online === false;

function onlineIds(players) {
  const out = [];
  for (const p of players || []) if (isOnline(p)) out.push(p.id);
  return out;
}
function onlineCount(players) { return onlineIds(players).length; }

function setOnline(p, online, now) {
  if (!p) return p;
  if (online) {
    p.online = true;
    delete p.offSince;
  } else {
    if (p.online !== false || !Number.isFinite(p.offSince)) p.offSince = Number.isFinite(now) ? now : Date.now();
    p.online = false;
  }
  return p;
}

function onRestore(players, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  let n = 0;
  for (const p of players || []) if (isGhost(p)) { p.offSince = t; n++; }
  return n;
}

function ensureOffSince(players, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  let n = 0;
  for (const p of players || []) if (isGhost(p) && !Number.isFinite(p.offSince)) { p.offSince = t; n++; }
  return n;
}

function ghostAge(p, now) {
  if (!isGhost(p) || !Number.isFinite(p.offSince)) return 0;
  return Math.max(0, (Number.isFinite(now) ? now : Date.now()) - p.offSince);
}

function nonEmpty(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

function hasEarned(p, keys) {
  if (!p) return false;
  if (Number(p.played) > 0) return true;
  for (const k of keys || DEFAULT_EARNED_KEYS) {
    const v = p[k];
    if (typeof v === "number" && v !== 0) return true;
  }
  return nonEmpty(p.awards) || nonEmpty(p.rewards) || nonEmpty(p.trophies);
}

function protectFn(protect) {
  if (typeof protect === "function") return protect;
  if (protect && typeof protect.has === "function") return (id) => protect.has(id);
  if (Array.isArray(protect)) return (id) => protect.indexOf(id) !== -1;
  if (protect != null) return (id) => id === protect;
  return () => false;
}

function ghostsToDrop(o) {
  const stage = o.stage;
  if (stage !== "lobby" && stage !== "finished") return []; // «game» и всё неизвестное — никогда (R1)
  const ttl = Number.isFinite(o.ttlMs) ? o.ttlMs : GHOST_TTL_MS;
  const prot = protectFn(o.protect);
  const guardEarned = o.protectEarned != null ? !!o.protectEarned : stage === "finished";
  const out = [];
  for (const p of o.players || []) {
    if (!isGhost(p) || prot(p.id)) continue;
    if (!Number.isFinite(p.offSince)) continue; // метки нет — ждём ensureOffSince, не «давно»
    if (ghostAge(p, o.now) < ttl) continue;
    if (guardEarned && hasEarned(p, o.earnedKeys)) continue;
    out.push(p.id);
  }
  return out;
}

function evictOldestGhost(players, o) {
  const opt = o || {};
  if (opt.stage === "game") return null;
  const minAge = Number.isFinite(opt.minAgeMs) ? opt.minAgeMs : GHOST_TTL_MS;
  const prot = protectFn(opt.protect);
  const guardEarned = opt.stage === "finished" || opt.protectEarned === true;
  let best = null;
  for (const p of players || []) {
    if (!isGhost(p) || prot(p.id) || !Number.isFinite(p.offSince)) continue;
    if (ghostAge(p, opt.now) < minAge) continue;
    if (guardEarned && hasEarned(p, opt.earnedKeys)) continue;
    if (!best || p.offSince < best.offSince) best = p;
  }
  return best ? best.id : null;
}

function pruneOfflineForNewGame(players, o) {
  const opt = o || {};
  const grace = Number.isFinite(opt.graceMs) ? opt.graceMs : DEFAULT_NEWGAME_GRACE_MS;
  const out = [];
  for (const p of players || []) {
    if (!isGhost(p)) continue;
    // без метки — считаем «только что» (restore): не выкидываем
    if (!Number.isFinite(p.offSince)) continue;
    if (ghostAge(p, opt.now) > grace) { p.left = true; out.push(p.id); }
  }
  return out;
}

function seatsFree(players, cap) {
  let used = 0;
  for (const p of players || []) if (p && p.left !== true) used++;
  return Math.max(0, cap - used);
}

module.exports = {
  GHOST_TTL_MS, DEFAULT_GHOST_TTL_MS, DEFAULT_NEWGAME_GRACE_MS, ghostTtlMs,
  isOnline, isGhost, onlineIds, onlineCount, setOnline, onRestore, ensureOffSince, ghostAge, hasEarned,
  ghostsToDrop, evictOldestGhost, pruneOfflineForNewGame, seatsFree,
};
