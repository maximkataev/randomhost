#!/usr/bin/env node
"use strict";
/*
 * Добавить ботов в комнату «Царя льдины» (проверки, нагрузка, игра агентами):
 *   node play.js --base http://localhost:3700 --code FLOE23 --n 4 --style mix --secs 120 [--host TOKEN] [--start]
 * --start — бот с host-токеном сам начинает партию, когда все вошли.
 */
const NetBot = require("./netbot");
const Bots = require("./bots");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes("--" + k);
const NAMES = ["Шкипер", "Ковальски", "Рико", "Прапор", "Кеша", "Пинго", "Лёдик", "Снежок", "Мумбл", "Пуфик", "Лоло"];

(async () => {
  const base = arg("base", "http://localhost:3700");
  let code = arg("code");
  let host = arg("host");
  if (!code) { const r = await NetBot.createRoom(base); code = r.code; host = r.hostToken; console.log("комната", code); }
  const n = Number(arg("n", 3)), style = arg("style", "mix"), secs = Number(arg("secs", 90));
  const bots = [];
  for (let i = 0; i < n; i++) {
    const st = style === "mix" ? Bots.STYLE_KEYS[i % Bots.STYLE_KEYS.length] : style;
    bots.push(await NetBot.connect({ base, code, name: NAMES[i % NAMES.length], style: st, hostToken: i === 0 ? host : undefined }));
  }
  console.log(`вошли ${n} ботов в ${code}`);
  if (flag("start")) setTimeout(() => bots[0].send({ type: "start" }), 1500);
  setTimeout(() => { bots.forEach((b) => b.close()); process.exit(0); }, secs * 1000);
})().catch((e) => { console.error(e.message); process.exit(1); });
