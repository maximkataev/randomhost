"use strict";

/*
 * Динамика партии по журналам агентов-игроков (state/<код>-<имя>.log.jsonl, их пишет play.js):
 *   node timeline.js <код>
 * Склеивает журналы всех игроков комнаты и считает по игровому времени (serverNow): длина партии, ходы, подсказки,
 * сколько оперативники думали до первого тапа, мёртвое время («экран ничего не ждёт от меня»), кто на что тратил время.
 * Игровые секунды — то, что чувствовали бы люди; реальные зависят от speed комнаты.
 */

const fs = require("fs");
const path = require("path");
const code = process.argv[2];
if (!code) { console.log("usage: node timeline.js <код>"); process.exit(2); }
const dir = path.join(__dirname, "state");
const files = fs.readdirSync(dir).filter((f) => f.startsWith(code + "-") && f.endsWith(".log.jsonl"));
if (!files.length) { console.log("журналов нет"); process.exit(1); }
const by = {};
for (const f of files) {
  const who = f.slice(code.length + 1).replace(/\.log\.jsonl$/, "");
  by[who] = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
// единая лента: каждое состояние по игровому времени (берём самое раннее наблюдение сигнатуры)
const seen = new Map();
for (const [who, rows] of Object.entries(by)) for (const r of rows) {
  if (r.ev !== "state" || !r.srv) continue;
  const k = [r.game, r.phase, r.team, r.opened, r.logLen, r.clue && r.clue[0]].join(":");
  if (!seen.has(k) || seen.get(k).srv > r.srv) seen.set(k, { ...r, who });
}
const line = [...seen.values()].sort((a, b) => a.srv - b.srv);
const sec = (ms) => (ms / 1000).toFixed(1) + " с";
const out = [];
out.push(`# Динамика комнаты ${code}`);
out.push(`Игроков с журналами: ${Object.keys(by).join(", ")}. Событий состояния: ${line.length}.`);
const games = [...new Set(line.map((r) => r.game))].filter((g) => g);
for (const g of games) {
  const L = line.filter((r) => r.game === g);
  const t0 = L[0].srv, t1 = L[L.length - 1].srv;
  out.push(`\n## Партия ${g}: ${sec(t1 - t0)} игрового времени, ${L.filter((r) => r.phase === "clue").length} фаз подсказки`);
  // ходы
  let turns = 0, clues = [], firstTap = [], gaps = [];
  let curClueAt = null, curGuessAt = null, lastOpened = 0, lastTapAt = null;
  for (let i = 0; i < L.length; i++) {
    const r = L[i];
    if (r.phase === "clue" && (!L[i - 1] || L[i - 1].phase !== "clue")) curClueAt = r.srv;
    if (r.phase === "guess" && (!L[i - 1] || L[i - 1].phase !== "guess")) { clues.push({ team: r.team, dur: r.srv - curClueAt, word: r.clue && r.clue[0], n: r.clue && r.clue[1] }); curGuessAt = r.srv; lastOpened = 0; lastTapAt = r.srv; turns++; }
    if (r.phase === "guess" && r.opened > lastOpened) {
      if (lastOpened === 0) firstTap.push(r.srv - curGuessAt); else gaps.push(r.srv - lastTapAt);
      lastTapAt = r.srv; lastOpened = r.opened;
    }
  }
  out.push(`Ходов: ${turns}. Подсказка капитана: ${clues.map((c) => `${c.team === "red" ? "К" : "С"} «${c.word}» ${c.n} за ${sec(c.dur)}`).join("; ") || "—"}`);
  if (clues.length) out.push(`Среднее на подсказку: ${sec(clues.reduce((a, c) => a + c.dur, 0) / clues.length)}`);
  if (firstTap.length) out.push(`До первого тапа оперативников после подсказки: среднее ${sec(firstTap.reduce((a, b) => a + b, 0) / firstTap.length)}, макс ${sec(Math.max(...firstTap))}`);
  if (gaps.length) out.push(`Между тапами внутри хода: среднее ${sec(gaps.reduce((a, b) => a + b, 0) / gaps.length)}`);
  const last = L[L.length - 1];
  out.push(`Конец: фаза ${last.phase}, осталось красных ${last.left && last.left[0]}, синих ${last.left && last.left[1]}`);
}
// кто сколько действовал
out.push("\n## Действия игроков (cmd/событий)");
for (const [who, rows] of Object.entries(by)) {
  const cmds = rows.filter((r) => r.ev === "cmd").map((r) => r.msg);
  const cnt = {};
  cmds.forEach((c) => (cnt[c] = (cnt[c] || 0) + 1));
  const rej = rows.filter((r) => r.ev === "rejected").map((r) => r.action + ":" + r.reason);
  const closes = rows.filter((r) => r.ev === "ws_close").length;
  out.push(`- ${who}: ${JSON.stringify(cnt)}${rej.length ? `; отказы: ${rej.join(", ")}` : ""}${closes ? `; обрывов сокета: ${closes}` : ""}`);
}
// реальные паузы: самый долгий промежуток между изменениями состояния
const real = [];
for (const rows of Object.values(by)) for (const r of rows) if (r.ev === "state") real.push(r.t);
real.sort((a, b) => a - b);
let maxGap = 0;
for (let i = 1; i < real.length; i++) maxGap = Math.max(maxGap, real[i] - real[i - 1]);
out.push(`\nСамая долгая реальная пауза без изменений экрана: ${(maxGap / 1000).toFixed(0)} реальных с (если она в десятки раз больше игровых таймеров — это агенты думали, а не игра ждала)`);
console.log(out.join("\n"));
