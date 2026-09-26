"use strict";

/*
 * Популярность лотов → popularity.json. Запускать руками после правки колод:
 *   node popularity.js
 *
 * В карточках нет поля «насколько это знаменито», а порядок в файлах — тематический (животные идут
 * семействами), так что по номеру карты популярность не угадать. Берём внешнюю и проверяемую меру —
 * просмотры статьи wiki_en в английской Википедии за последние 12 полных месяцев (люди, без ботов).
 * Редиректы разворачиваем: просмотры считаются по статье, куда ведёт заголовок.
 *
 * Результат: { kind: [просмотров за год в тысячах, …] } — номер совпадает с номером карты в
 * data/<kind>.json (переводы идут в том же порядке, это проверяет server.js). Сервер кладёт число
 * в card.pop; движок по нему выбирает самый популярный лот после серии непроданных (game.js).
 */

const fs = require("fs");
const path = require("path");

const UA = "randomhost-auction/1.0 (https://randomhost.online; popularity of auction lots)";
const DATA = path.join(__dirname, "data");
const OUT = path.join(__dirname, "popularity.json");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 404 — у статьи нет просмотров за период (честный ноль); сбой сети и 429 — повторяем с паузой,
// а если не вышло — undefined, чтобы сбой не записался нулём
async function getJson(url) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Api-User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
    } catch {}
    await wait(1000 * 2 ** i);
  }
  return undefined;
}

// заголовок → статья, куда он ведёт (пачками по 50 — лимит API)
async function resolveTitles(titles) {
  const map = new Map(titles.map((t) => [t, t]));
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const q = chunk.map(encodeURIComponent).join("|");
    const data = await getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&titles=${q}`);
    const norm = new Map(((data && data.query && data.query.normalized) || []).map((n) => [n.from, n.to]));
    const redir = new Map(((data && data.query && data.query.redirects) || []).map((n) => [n.from, n.to]));
    for (const t of chunk) {
      let x = norm.get(t) || t;
      x = redir.get(x) || x;
      map.set(t, x);
    }
  }
  return map;
}

function lastYear() {
  const d = new Date();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)); // последний день прошлого месяца
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth() + 1, 1));
  const f = (x) => x.toISOString().slice(0, 10).replace(/-/g, "");
  return [f(start) + "00", f(end) + "00"];
}

async function views(title, [from, to]) {
  const t = encodeURIComponent(title.replace(/ /g, "_"));
  const data = await getJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${t}/monthly/${from}/${to}`);
  if (data === undefined) throw new Error(`не скачались просмотры «${title}»`);
  return ((data && data.items) || []).reduce((sum, x) => sum + x.views, 0);
}

async function main() {
  const range = lastYear();
  const out = {};
  const kinds = fs.readdirSync(DATA).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  for (const kind of kinds) {
    const cards = JSON.parse(fs.readFileSync(path.join(DATA, kind + ".json"), "utf8"));
    const resolved = await resolveTitles([...new Set(cards.map((c) => c.wiki_en).filter(Boolean))]);
    const res = new Array(cards.length).fill(0);
    let next = 0;
    // 4 запроса параллельно: чаще REST API Викимедии начинает отвечать 429
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < cards.length) {
        const i = next++;
        const title = cards[i].wiki_en && resolved.get(cards[i].wiki_en);
        res[i] = title ? await views(title, range).then((v) => Math.round(v / 1000), () => undefined) : 0;
      }
    }));
    // что не скачалось в общем потоке (429), добираем по одному
    for (let i = 0; i < res.length; i++) {
      if (res[i] !== undefined) continue;
      await wait(1000);
      res[i] = Math.round((await views(resolved.get(cards[i].wiki_en), range)) / 1000);
    }
    out[kind] = res;
    const top = res.map((v, i) => [v, cards[i].name]).sort((a, b) => b[0] - a[0]).slice(0, 3);
    console.log(`${kind}: ${cards.length} карт, нулей ${res.filter((v) => !v).length}; топ: ${top.map((x) => `${x[1]} ${x[0]}k`).join(", ")}`);
  }
  // по строке на категорию: файл читается глазами и нормально диффается
  const body = kinds.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])}`).join(",\n");
  fs.writeFileSync(OUT, `{\n  "_range": ${JSON.stringify(range.map((x) => x.slice(0, 8)).join("-"))},\n${body}\n}\n`);
  console.log("записано", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
