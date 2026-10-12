"use strict";

/*
 * Места игроков: что делать с `join` — одна чистая функция для всех игр
 * (IMPLEMENTATION-PLAN T-W1-02, пакет P1, К-1/К-4, решение U-01).
 * Без I/O, без таймеров, только встроенные модули; ни одна игра пока не вызывает.
 *
 * ── classifyJoin(o) -> { kind, player, reason?, retryInMs?, silent? } ─────────────────────────────
 *   o.players          массив {id, name, token?, tokens?[], left?}; места с left===true по имени
 *                      не подхватываются (имя свободно), но по токену находятся
 *   o.name, o.token    то, что прислал клиент
 *   o.tokenOwner(tok)  необязательно: -> player|null (если токены в игре лежат не в players[])
 *   o.hasLiveSocket(id, player) -> bool     есть ли у места живой сокет
 *   o.closedAt(id, player)      -> ms|null  когда закрылся последний сокет места (нет данных = «давно»,
 *                                           например место из дампа после restore)
 *   o.isStale(id, player)       -> bool     «завис»: сокет есть, но pong пропущен — считается офлайн
 *   o.now              ms
 *   o.phase            текущая фаза игры
 *   o.claimablePhases  БЕЛЫЙ список фаз, где офлайн-место по имени можно вернуть (по умолч. ["lobby","finished"])
 *   o.secretPhases     фазы с секретами (wave clue/guess, crowd vote/opinion): подхват по имени запрещён
 *   o.graceMs          сколько сокет должен быть закрыт, чтобы место считалось офлайн (по умолч. 2000;
 *                      floe/rapids в игре — 10000 вместе с policy:"strict")
 *   o.sameIp           bool: тот же IP, что у места (нужен при policy:"strict")
 *   o.policy           "claim" (по умолч.) | "strict" (lastq, floe/rapids в бою: только при sameIp)
 *   kind:
 *     "token"          токен найден -> вернуть молча, в ЛЮБОЙ фазе
 *     "fresh"          пустое/свободное имя -> новое место
 *     "claimable"      офлайн-место с этим именем можно вернуть ПОСЛЕ подтверждения («Это ты?»); silent:false
 *     "pending"        сокет закрылся < graceMs назад -> повторить через retryInMs
 *     "taken_online"   у места живой сокет
 *     "secret_blocked" фаза из secretPhases -> name_taken {retry:true}, подхват после смены фазы
 *     "phase_blocked"  фаза вне claimablePhases (reason:"phase") ИЛИ strict и другой IP (reason:"ip")
 *   Порядок проверок: токен > совпадения нет > живой сокет > secretPhases > claimablePhases > strict/IP > grace.
 *
 * ── decideJoin(o) -> action ───────────────────────────────────────────────────────────────────────
 *   Принимает всё из classifyJoin плюс: o.caps (массив из join; старый клиент без `caps` = []),
 *   o.claim (bool), o.fresh (bool), o.max (лимит имени игры, по умолч. 16), o.legacyClaim (по умолч. true:
 *   клиент без caps:["claim"] молча подхватывает офлайн-место, как сегодня; floe/rapids ставят false).
 *   action — что сделать серверу игры:
 *     {action:"resume", player, silent:true}                       вернуть место (joined.resumed=true)
 *     {action:"create", name, renamed}                             завести нового; name — итоговое «База (N)»
 *     {action:"claim", player, silent, revokeTokens:true, replaceSocket:true}
 *                                                                  подхват: прежние токены места ОТОЗВАТЬ,
 *                                                                  прежнему сокету — {type:"replaced"}
 *     {action:"prompt", error:"name_claim", name, player, claimSummary(keys)}
 *                                                                  отправить {type:"error",error:"name_claim",
 *                                                                  name, summary}; сокет -> pendingClaim
 *     {action:"retry", error:"name_claim", retry:true, retryInMs}  клиент молча повторит join через retryInMs
 *     {action:"taken", error:"name_taken", reason, online, retry, suggested}
 *                                                                  имя недоступно; suggested — «База (N)»
 *                                                                  (лобби/итоги: взять его и отдать
 *                                                                  joined.name+renamed:true; в игре: name_taken)
 *     {action:"deny", error:"bad_name"}                            имя пустое после очистки
 *   Клиент с fresh:true («Я другой») при любом занятом имени получает create с «База (N)»;
 *   claim:true проходит ТЕ ЖЕ проверки (grace, фаза, IP) — обойти их флагом нельзя.
 *   Старый клиент без caps не получает ни name_claim, ни retry (ответы как сегодня + аддитивное joined.name).
 *
 * ── Ожидание подтверждения (pendingClaim) ─────────────────────────────────────────────────────────
 *   Сокет, которому ушёл name_claim/retry, живёт CLAIM_WAIT_MS (120 с, env CLAIM_WAIT_MS) вместо
 *   ANON_TTL_MS (30 с), не вытесняется evictAnon и не входит в MAX_ANON_PER_IP, но ограничен
 *   MAX_PENDING_PER_IP (6) и MAX_PENDING_PER_ROOM (12). Функции над сокетами (поля сокета:
 *   ip, joined|playerId, host, createdAt, pendingClaimAt — их выставляет игра/эти функции):
 *     markPending(sock, {sockets, now, ip, maxPerIp, maxPerRoom}) -> {ok, reason?}  (ставит pendingClaimAt)
 *     clearPending(sock)            isPending(sock)           isAnon(sock)
 *     anonExpired(sock, now, {anonTtlMs, claimWaitMs}) -> bool
 *     anonCount(sockets, ip)  — анонимы без pending (для MAX_ANON_PER_IP)
 *     pendingCount(sockets, ip?)    evictableAnon(sockets) -> анонимы без pending
 *   claimSummary(player, keys) — безопасная выжимка для «Это ты? Вернуться как X (N очков)»:
 *   только перечисленные ключи (score|stack|points…), никаких секретов.
 */

const names = require("./names");

function envInt(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

const CLAIM_GRACE_MS = 2000;
const DEFAULT_CLAIMABLE = Object.freeze(["lobby", "finished"]);
const CLAIM_WAIT_MS = envInt("CLAIM_WAIT_MS", 120000);
const ANON_TTL_MS = envInt("ANON_TTL_MS", 30000);
const MAX_PENDING_PER_IP = 6;
const MAX_PENDING_PER_ROOM = 12;

function hasToken(p, token) {
  if (p.token === token) return true;
  return Array.isArray(p.tokens) && p.tokens.indexOf(token) !== -1;
}

function findByToken(o) {
  const t = o.token;
  if (typeof t !== "string" || !t) return null;
  if (typeof o.tokenOwner === "function") return o.tokenOwner(t) || null;
  for (const p of o.players || []) if (p && hasToken(p, t)) return p;
  return null;
}

function findByName(o) {
  const key = names.nameKey(o.name);
  if (!key) return null;
  let found = null;
  for (const p of o.players || []) {
    if (!p || (p.left === true && !o.matchLeft)) continue;
    if (names.nameKey(p.name) !== key) continue;
    if (!found) found = p;
    else if (live(o, p) && !live(o, found)) found = p; // дубль ключа (не должен быть): предпочесть живого
  }
  return found;
}

function live(o, p) {
  if (typeof o.hasLiveSocket !== "function" || !o.hasLiveSocket(p.id, p)) return false;
  if (typeof o.isStale === "function" && o.isStale(p.id, p)) return false;
  return true;
}

function classifyJoin(o) {
  const tp = findByToken(o);
  if (tp) return { kind: "token", player: tp, silent: true };

  const p = findByName(o);
  if (!p) return { kind: "fresh", player: null };

  if (live(o, p)) return { kind: "taken_online", player: p, reason: "online" };

  const phase = o.phase;
  if (Array.isArray(o.secretPhases) && o.secretPhases.indexOf(phase) !== -1) {
    return { kind: "secret_blocked", player: p, reason: "secret" };
  }
  const claimable = Array.isArray(o.claimablePhases) ? o.claimablePhases : DEFAULT_CLAIMABLE;
  if (claimable.indexOf(phase) === -1) return { kind: "phase_blocked", player: p, reason: "phase" };

  if (o.policy === "strict" && o.sameIp !== true) return { kind: "phase_blocked", player: p, reason: "ip" };

  // «завис» (сокет есть, pong пропущен) — давно офлайн; нет данных о закрытии (restore из дампа) — тоже
  const grace = Number.isFinite(o.graceMs) && o.graceMs >= 0 ? o.graceMs : CLAIM_GRACE_MS;
  let closed = typeof o.closedAt === "function" ? o.closedAt(p.id, p) : null;
  const stale = typeof o.hasLiveSocket === "function" && o.hasLiveSocket(p.id, p);
  const age = stale || !Number.isFinite(closed) ? Infinity : (Number.isFinite(o.now) ? o.now : Date.now()) - closed;
  if (age < grace) return { kind: "pending", player: p, retryInMs: Math.max(0, Math.ceil(grace - age)) };
  return { kind: "claimable", player: p, silent: false };
}

function claimSummary(player, keys) {
  const out = {};
  if (!player) return out;
  for (const k of keys || ["score"]) if (Object.prototype.hasOwnProperty.call(player, k)) out[k] = player[k];
  return out;
}

function decideJoin(o) {
  const max = Number.isInteger(o.max) && o.max > 0 ? o.max : names.LIMITS.DEFAULT;
  const c = classifyJoin(o);
  const caps = Array.isArray(o.caps) ? o.caps : [];
  const canClaim = caps.indexOf("claim") !== -1;
  const cleaned = names.cleanName(o.name, max);

  if (c.kind === "token") return { action: "resume", kind: c.kind, player: c.player, silent: true };
  if (!cleaned) return { action: "deny", kind: c.kind, error: "bad_name" };
  if (c.kind === "fresh") return { action: "create", kind: c.kind, name: cleaned, renamed: false };

  const taken = names.takenKeysOf(o.players, { skipLeft: !o.matchLeft });
  const suggested = names.nextFreeName(cleaned, taken, max);
  const rename = { action: "create", kind: c.kind, name: suggested, renamed: suggested !== cleaned };

  if (o.fresh === true) return rename; // «Я другой»

  if (c.kind === "claimable") {
    if (!canClaim) {
      if (o.legacyClaim === false) return rename;
      return { action: "claim", kind: c.kind, player: c.player, silent: true, revokeTokens: true, replaceSocket: true };
    }
    if (o.claim === true) {
      return { action: "claim", kind: c.kind, player: c.player, silent: false, revokeTokens: true, replaceSocket: true };
    }
    return { action: "prompt", kind: c.kind, error: "name_claim", name: c.player.name, player: c.player };
  }

  if (c.kind === "pending") {
    if (canClaim) return { action: "retry", kind: c.kind, error: "name_claim", retry: true, retryInMs: c.retryInMs, player: c.player };
    return { action: "taken", kind: c.kind, error: "name_taken", reason: "pending", online: false, retry: false, suggested };
  }

  // taken_online / secret_blocked / phase_blocked
  return {
    action: "taken", kind: c.kind, error: "name_taken", reason: c.reason,
    online: c.kind === "taken_online", retry: c.kind === "secret_blocked", suggested,
  };
}

// ── pendingClaim ─────────────────────────────────────────────────────────────────────────────────
function isPending(sock) { return !!sock && Number.isFinite(sock.pendingClaimAt); }
function isAnon(sock) { return !!sock && !sock.joined && sock.playerId == null && !sock.host; }
function clearPending(sock) { if (sock) sock.pendingClaimAt = null; }

function pendingCount(sockets, ip) {
  let n = 0;
  for (const s of sockets || []) if (isPending(s) && (ip == null || s.ip === ip)) n++;
  return n;
}
function anonCount(sockets, ip) {
  let n = 0;
  for (const s of sockets || []) if (isAnon(s) && !isPending(s) && (ip == null || s.ip === ip)) n++;
  return n;
}
function evictableAnon(sockets) {
  const out = [];
  for (const s of sockets || []) if (isAnon(s) && !isPending(s)) out.push(s);
  return out;
}

function markPending(sock, o) {
  const opt = o || {};
  if (isPending(sock)) return { ok: true, already: true };
  const ip = opt.ip != null ? opt.ip : sock.ip;
  const perIp = Number.isInteger(opt.maxPerIp) ? opt.maxPerIp : MAX_PENDING_PER_IP;
  const perRoom = Number.isInteger(opt.maxPerRoom) ? opt.maxPerRoom : MAX_PENDING_PER_ROOM;
  const sockets = opt.sockets || [];
  if (pendingCount(sockets, ip) >= perIp) return { ok: false, reason: "pending_ip" };
  if (pendingCount(sockets) >= perRoom) return { ok: false, reason: "pending_room" };
  sock.pendingClaimAt = Number.isFinite(opt.now) ? opt.now : Date.now();
  return { ok: true };
}

function anonExpired(sock, now, cfg) {
  const c = cfg || {};
  if (!isAnon(sock) && !isPending(sock)) return false;
  if (sock.joined || sock.playerId != null) return false;
  if (isPending(sock)) return now - sock.pendingClaimAt > (c.claimWaitMs || CLAIM_WAIT_MS);
  return now - (sock.createdAt || now) > (c.anonTtlMs || ANON_TTL_MS);
}

module.exports = {
  classifyJoin, decideJoin, claimSummary,
  markPending, clearPending, isPending, isAnon, anonExpired, anonCount, pendingCount, evictableAnon,
  CLAIM_GRACE_MS, DEFAULT_CLAIMABLE, CLAIM_WAIT_MS, ANON_TTL_MS, MAX_PENDING_PER_IP, MAX_PENDING_PER_ROOM,
};
