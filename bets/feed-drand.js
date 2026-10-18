"use strict";

/*
 * 📡 drand quicknet (§10.5): раунд раз в 3 с, случайность неотличима от равномерной, оценок нет.
 *
 * Исход: randomness (hex, 64 символа) первого раунда r, опубликованного не раньше closeAt + 3 с.
 * Проверки (раунд, не прошедший любую из них, отбрасывается; если подходящего нет — abort, ставки возвращаются):
 *   1) подпись BLS12-381 настоящая: сеть quicknet — схема bls-unchained-g1-rfc9380, подпись в G1 (48 байт),
 *      публичный ключ в G2 (96 байт), сообщение = sha256(номер раунда, big-endian uint64),
 *      хеш в кривую по RFC 9380 с DST "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_" (@noble/curves);
 *   2) randomness == sha256(signature) (в «unchained»-сети это определение случайности);
 *   3) номер раунда в ответе == запрошенному (номер входит в подписанное сообщение, подмена не пройдёт п.1);
 *   4) значение подтверждено вторым независимым ретранслятором (api.drand.sh / drand.cloudflare.com / api2.drand.sh);
 *      расхождение — abort; если второй не ответил за 1,5 с — принимаем один (в status это видно).
 * После п.1 ретрансляторам доверять не нужно вовсе: подделать подпись без ключей сети нельзя.
 *
 * Публичный ключ и параметры сети зашиты константами. Раз в сутки (и при старте) сверяются с /info ретранслятора;
 * расхождение — событие выключается (prepare → null, begin → abort) и пишется в лог.
 */
const crypto = require("crypto");
const { withDefaults, makeHandle } = require("./feed-util");

const CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const GENESIS = 1692803367;           // с
const PERIOD = 3;                     // с
// публичный ключ цепи quicknet (G2, 96 байт) — взят из https://api.drand.sh/<CHAIN>/info
const PUBLIC_KEY = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
const SCHEME = "bls-unchained-g1-rfc9380";
const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const INFO_EVERY = 24 * 3600 * 1000;
const RELAYS = ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh"];

const roundTime = (r) => (GENESIS + (r - 1) * PERIOD) * 1000;                       // мс публикации раунда r
const roundAt = (ms) => Math.floor((ms / 1000 - GENESIS) / PERIOD) + 1;             // последний опубликованный к моменту ms
// первый раунд, опубликованный не раньше closeAt + 3 с
const targetRound = (closeAt) => Math.ceil((closeAt + 3000 - GENESIS * 1000) / (PERIOD * 1000)) + 1;

const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = (hexSig) => crypto.createHash("sha256").update(Buffer.from(hexSig, "hex")).digest("hex");

// ---- BLS12-381: подпись в G1, ключ в G2 ----
// @noble/curves v2 — ESM; в Node ≥ 22.12 require() его подгружает. Не загрузилась — проверка всегда «нет» (fail-closed).
let bls = null, blsErr = null, pkBytes = null;
try {
  bls = require("@noble/curves/bls12-381.js").bls12_381.shortSignatures;
  pkBytes = Buffer.from(PUBLIC_KEY, "hex");
} catch (e) { bls = null; blsErr = e; }
const SIG_CACHE = new Map();   // «round:sig» → bool; одна и та же подпись от трёх ретрансляторов проверяется один раз
const roundMsg = (r) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(r));
  return crypto.createHash("sha256").update(b).digest();
};
function verifySig(r, sigHex) {
  if (!bls || !Number.isSafeInteger(r) || r < 1) return false;
  if (typeof sigHex !== "string" || !/^[0-9a-f]{96}$/.test(sigHex)) return false;
  const key = r + ":" + sigHex;
  if (SIG_CACHE.has(key)) return SIG_CACHE.get(key);
  let ok = false;
  try { ok = bls.verify(Buffer.from(sigHex, "hex"), bls.hash(roundMsg(r), DST), pkBytes) === true; } catch (e) { ok = false; }
  if (SIG_CACHE.size > 64) SIG_CACHE.clear();
  SIG_CACHE.set(key, ok);
  return ok;
}

function validRound(o, r) {
  return !!o && Number(o.round) === r && typeof o.signature === "string" && /^[0-9a-f]+$/.test(o.signature)
    && HEX64.test(o.randomness || "") && sha256hex(o.signature) === o.randomness && verifySig(r, o.signature);
}

function create(d) {
  const deps = withDefaults(d);
  const relays = (deps.drandRelays || RELAYS);
  const verify = deps.drandVerify || validRound;   // подмена — только для тестов расхождения ретрансляторов
  let lastOk = 0, lastNote = "не запущен", iv = null, ivInfo = null, lastCross = "", keyBad = "";

  const sleep = (ms) => new Promise((res) => deps.setTimeout(res, ms));
  async function getJson(url) {
    try {
      const res = await deps.fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  }
  async function ping() {
    const o = await getJson(`${relays[0]}/${CHAIN}/public/latest`);
    if (o && verify(o, Number(o.round))) { lastOk = deps.now(); lastNote = `раунд ${o.round}, BLS ✓`; }
    else lastNote = o ? "подпись BLS не прошла" : "ретранслятор не отвечает";
  }

  // сверка зашитых параметров сети с /info ретранслятора; несовпадение — событие выключено до перезапуска/следующей сверки
  async function checkInfo() {
    for (const x of relays) {
      const o = await getJson(`${x}/${CHAIN}/info`);
      if (!o || typeof o.public_key !== "string") continue;   // не ответил — пробуем следующего
      const bad = [];
      if (o.public_key !== PUBLIC_KEY) bad.push("public_key");
      if (o.hash !== undefined && o.hash !== CHAIN) bad.push("hash");
      if (o.period !== undefined && Number(o.period) !== PERIOD) bad.push("period");
      if (o.genesis_time !== undefined && Number(o.genesis_time) !== GENESIS) bad.push("genesis_time");
      if (o.schemeID !== undefined && o.schemeID !== SCHEME) bad.push("schemeID");
      const prev = keyBad;
      keyBad = bad.join(",");
      if (keyBad && keyBad !== prev) deps.log(`[drand] параметры сети на ${x} не совпадают с зашитыми (${keyBad}) — событие выключено`);
      return;
    }
  }

  // ждём раунд r с одного ретранслятора до deadline; null — не дождались (ctl.stop прерывает ожидание)
  async function waitRound(relay, r, deadline, ctl) {
    for (;;) {
      if (ctl.stop) return null;
      const o = await getJson(`${relay}/${CHAIN}/public/${r}`);
      if (o) { if (verify(o, r)) return o; ctl.rejected++; }   // ответ есть, но не прошёл проверку (BLS/sha256/номер)
      if (deps.now() >= deadline) return null;
      await sleep(400);
    }
  }

  function begin(type, opts) {
    const h = makeHandle(deps, opts, { timeoutMs: 11000 });
    const r = targetRound(opts.closeAt), pubAt = roundTime(r);
    h.live({ kind: "round", n: r - 1 });
    h.every(1500, () => h.live({ kind: "round", n: Math.min(r - 1, roundAt(deps.now())) }));
    const ctl = { stop: false, rejected: 0 };
    (async () => {
      await sleep(Math.max(0, pubAt + 150 - deps.now()));
      if (h.done) return;
      const deadline = opts.closeAt + 10500;
      // опрашиваем все ретрансляторы; после первого валидного ответа ждём остальных не дольше 1,65 с
      const ok = await new Promise((resolve) => {
        const got = [];
        let pending = relays.length, timer = null;
        const fin = () => { deps.clearTimeout(timer); resolve(got.slice()); };
        for (const x of relays) {
          waitRound(x, r, deadline, ctl).then((o) => {
            if (o) { got.push(o); if (got.length === 1) timer = deps.setTimeout(fin, 1650); }
            if (--pending === 0) fin();
          });
        }
      });
      ctl.stop = true;
      if (h.done) return;
      if (keyBad) return h.abort("параметры сети drand не совпали с зашитыми");
      if (!ok.length) return h.abort(ctl.rejected ? "подпись BLS раунда drand не прошла" : "раунд drand не пришёл");
      if (ok.some((o) => o.randomness !== ok[0].randomness)) { lastCross = "расхождение"; return h.abort("ретрансляторы разошлись"); }
      lastCross = ok.length > 1 ? `подтверждено ${ok.length === 2 ? "двумя" : "тремя"}` : "один ретранслятор";
      lastOk = deps.now();
      h.live({ kind: "round", n: r, randomness: ok[0].randomness });
      h.resolve(ok[0].randomness);
    })();
    return { cancel: () => { ctl.stop = true; h.cancel(); } };
  }

  return {
    types: ["drand"],
    start() {
      if (!bls) deps.log(`[drand] BLS недоступен (${blsErr && blsErr.message}) — источник отключён`);
      checkInfo(); ping();
      iv = deps.setInterval(ping, 10000);
      ivInfo = deps.setInterval(checkInfo, INFO_EVERY);
    },
    stop() { deps.clearInterval(iv); deps.clearInterval(ivInfo); },
    status() { const ok = !keyBad && lastOk > 0 && deps.now() - lastOk < 30000; return { ok, lastAt: lastOk, note: `${keyBad ? "параметры сети не совпали: " + keyBad + "; " : ""}${lastNote}${lastCross ? "; " + lastCross : ""}` }; },
    prepare() {
      if (keyBad || !(lastOk > 0 && deps.now() - lastOk < 30000)) return null;
      return { input: {}, meta: { chain: CHAIN, period: PERIOD, explorer: `https://drand.love/` } };
    },
    begin, _ping: ping, _checkInfo: checkInfo,
  };
}

module.exports = { create, verifySig, PUBLIC_KEY, targetRound, roundTime, roundAt, validRound, sha256hex, CHAIN, GENESIS };
