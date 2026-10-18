"use strict";

/*
 * 📡 drand quicknet (§10.5): раунд раз в 3 с, случайность неотличима от равномерной, оценок нет.
 *
 * Исход: randomness (hex, 64 символа) первого раунда r, опубликованного не раньше closeAt + 3 с.
 * Проверки в Node без внешних библиотек:
 *   1) randomness == sha256(signature) (в quicknet — «unchained», это определение случайности);
 *   2) номер раунда в ответе == запрошенному;
 *   3) значение подтверждено вторым независимым ретранслятором (api.drand.sh / drand.cloudflare.com / api2.drand.sh);
 *      расхождение — abort; если второй не ответил за 1,5 с — принимаем один (в status это видно).
 *
 * TODO(BLS): проверка подписи BLS12-381 (G1-подпись, ключ в G2) в Node без зависимостей не делается;
 * для неё нужен пакет @noble/curves (bls12-381) — тогда verifySig(round, sig) станет настоящим.
 * Сейчас защита от подмены — совпадение двух ретрансляторов + sha256(signature). Это НЕ проверка подписи.
 */
const crypto = require("crypto");
const { withDefaults, makeHandle } = require("./feed-util");

const CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const GENESIS = 1692803367;           // с
const PERIOD = 3;                     // с
const RELAYS = ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh"];

const roundTime = (r) => (GENESIS + (r - 1) * PERIOD) * 1000;                       // мс публикации раунда r
const roundAt = (ms) => Math.floor((ms / 1000 - GENESIS) / PERIOD) + 1;             // последний опубликованный к моменту ms
// первый раунд, опубликованный не раньше closeAt + 3 с
const targetRound = (closeAt) => Math.ceil((closeAt + 3000 - GENESIS * 1000) / (PERIOD * 1000)) + 1;

const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = (hexSig) => crypto.createHash("sha256").update(Buffer.from(hexSig, "hex")).digest("hex");

function validRound(o, r) {
  return !!o && Number(o.round) === r && typeof o.signature === "string" && /^[0-9a-f]+$/.test(o.signature)
    && HEX64.test(o.randomness || "") && sha256hex(o.signature) === o.randomness;
}

function create(d) {
  const deps = withDefaults(d);
  const relays = (deps.drandRelays || RELAYS);
  let lastOk = 0, lastNote = "не запущен", iv = null, lastCross = "";

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
    if (o && HEX64.test(o.randomness || "") && sha256hex(o.signature) === o.randomness) { lastOk = deps.now(); lastNote = `раунд ${o.round}`; } else lastNote = "ретранслятор не отвечает";
  }

  // ждём раунд r с одного ретранслятора до deadline; null — не дождались (ctl.stop прерывает ожидание)
  async function waitRound(relay, r, deadline, ctl) {
    for (;;) {
      if (ctl.stop) return null;
      const o = await getJson(`${relay}/${CHAIN}/public/${r}`);
      if (validRound(o, r)) return o;
      if (deps.now() >= deadline) return null;
      await sleep(400);
    }
  }

  function begin(type, opts) {
    const h = makeHandle(deps, opts, { timeoutMs: 11000 });
    const r = targetRound(opts.closeAt), pubAt = roundTime(r);
    h.live({ kind: "round", n: r - 1 });
    h.every(1500, () => h.live({ kind: "round", n: Math.min(r - 1, roundAt(deps.now())) }));
    const ctl = { stop: false };
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
      if (!ok.length) return h.abort("раунд drand не пришёл");
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
    start() { ping(); iv = deps.setInterval(ping, 10000); },
    stop() { deps.clearInterval(iv); },
    status() { const ok = lastOk > 0 && deps.now() - lastOk < 30000; return { ok, lastAt: lastOk, note: `${lastNote}${lastCross ? "; " + lastCross : ""}` }; },
    prepare() {
      if (!(lastOk > 0 && deps.now() - lastOk < 30000)) return null;
      return { input: {}, meta: { chain: CHAIN, period: PERIOD, explorer: `https://drand.love/` } };
    },
    begin, _ping: ping,
  };
}

module.exports = { create, targetRound, roundTime, roundAt, validRound, sha256hex, CHAIN, GENESIS };
