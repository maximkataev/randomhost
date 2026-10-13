#!/usr/bin/env node
"use strict";
/*
 * Сводка трудности вопросов по логу сервера (T-W4-03, lastq-061/062, D8).
 *
 *   docker logs <контейнер lastq> 2>&1 | node qstat.js            — все вопросы, не реже 1 показа
 *   docker logs ... | node qstat.js --min 10 --easy 0.9 --hard 0.2 — только «слишком лёгкие» (>= 90 % верных)
 *                                                                    и «слишком трудные» (<= 20 %), от 10 показов
 *
 * Строка лога: `[lastq] qstat {"qid","lvl","final","lang","n","answered","right"}` — пишет server.js на каждое
 * раскрытие вопроса. Доля верных = right / n (не ответивший считается ошибившимся). Без имён и кодов комнат.
 * Скрипт ничего не правит: решение «поднять в Акт 2 / заменить» — за владельцем (агенты-LLM трудность не меряют).
 */
const readline = require("node:readline");

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i >= 0 ? Number(process.argv[i + 1]) : def; };
const MIN = arg("min", 1), EASY = arg("easy", null), HARD = arg("hard", null);

const by = new Map();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const i = line.indexOf("qstat ");
  if (i < 0) return;
  let r;
  try { r = JSON.parse(line.slice(i + 6)); } catch { return; }
  if (!r || typeof r.qid !== "string" || !(r.n > 0)) return;
  const x = by.get(r.qid) || { qid: r.qid, lvl: r.lvl, final: !!r.final, shows: 0, n: 0, right: 0 };
  x.shows++; x.n += r.n; x.right += r.right || 0;
  by.set(r.qid, x);
});
rl.on("close", () => {
  let rows = [...by.values()].filter((x) => x.shows >= MIN).map((x) => ({ ...x, share: x.right / x.n }));
  if (EASY != null || HARD != null) rows = rows.filter((x) => (EASY != null && x.share >= EASY) || (HARD != null && x.share <= HARD));
  rows.sort((a, b) => b.share - a.share);
  console.log("qid\tlvl\tfinal\tshows\tanswers\tright%");
  for (const x of rows) console.log([x.qid, x.lvl, x.final ? "F" : "", x.shows, x.n, (x.share * 100).toFixed(0)].join("\t"));
});
