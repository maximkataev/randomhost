"use strict";

/*
 * ИИ-судья: один запрос в OpenAI Responses API со strict JSON schema.
 * Игроки в промпте обозначены как p1, p2… — имена в модель не уходят (защита от инъекций через имя),
 * клиент подставляет их сам. Возвращает {ranking, summary} или бросает ошибку → сервер включает голосование.
 */

const { modeById } = require("./modes");

// что за лоты в колоде — нужно, когда задание переопределяет цель («собери худший набор»)
const KIND_LABELS = {
  artist: "музыкальные исполнители", film: "фильмы", series: "сериалы", person: "известные личности",
  character: "вымышленные персонажи", food: "блюда", city: "города", country: "страны", place: "достопримечательности",
  animal: "животные", painting: "картины", company: "компании и бренды", club: "спортивные клубы",
  profession: "профессии", invention: "изобретения",
};

const FRAMES = {
  artist: ["лайнап музыкального фестиваля", "хедлайнеры, сочетаемость, «пойдёшь ли на такой фест»"],
  film: ["киномарафон на выходные", "разнообразие, качество, смотрибельность подряд"],
  series: ["подписка на сезон сериалов", "затягивает ли, баланс жанров"],
  person: ["список гостей на ужин", "насколько интересный и взрывной вечер получится"],
  character: ["отряд персонажей", "кто победит в замесе, синергия способностей"],
  food: ["меню ужина", "гастрономическая логика, баланс, вкусно ли вместе"],
  city: ["маршрут путешествия", "логистика, впечатления, разнообразие"],
  country: ["кругосветное путешествие", "логистика, впечатления, разнообразие"],
  place: ["тур по чудесам света", "впечатления, логистика"],
  animal: ["зоопарк", "зрелищность, разнообразие, на кого пойдут смотреть"],
  painting: ["частная галерея", "ценность, узнаваемость, цельность коллекции"],
  company: ["инвестиционный портфель", "стоимость, диверсификация, перспективы"],
  club: ["спортивная империя", "титулы, аудитория, стоимость"],
  profession: ["экипаж для выживания на необитаемом острове", "выживут ли, полезность набора"],
  invention: ["набор изобретений, который берём в прошлое", "насколько изменят историю"],
};

// Язык партии. Сам промпт остаётся русским: модель многоязычная и инструкции понимает,
// а три параллельных перевода промпта пришлось бы править синхронно при каждой правке задания.
// Меняется только то, что видит игрок: язык ответа и подпись пустого слота.
const LANGS = {
  ru: { answer: "Отвечай по-русски.", empty: "пусто" },
  en: { answer: "Answer in English.", empty: "empty" },
  el: { answer: "Απάντησε στα ελληνικά. Answer in Greek.", empty: "κενό" },
};
const langPack = (lang) => LANGS[lang] || LANGS.ru;

function buildPrompt(kind, lineups, slots, modeId, lang) {
  const mode = modeById(modeId);
  const base = FRAMES[kind] || ["набор", "качество и цельность"];
  const what = mode.what || base[0];
  const criteria = mode.criteria || base[1];
  const extra = mode.prompt ? mode.prompt + "\n" : "";
  const L = langPack(lang);
  const lines = lineups.map((l) => {
    const items = l.lots.map((x) => `${x.name} (${(x.meta || []).join(", ")})`);
    while (items.length < slots) items.push(L.empty);
    return `${l.pid}: ${items.join("; ")}`;
  });
  return (
    `Ты ведущий весёлого шоу-аукциона. У каждого игрока ${slots} слотов, лоты — ${KIND_LABELS[kind] || "разные лоты"}. ` +
    `Задание: собрать ${what}. ` +
    `Оцени составы по критериям: ${criteria}. Пустые слоты — минус. Деньги не учитывай.\n` +
    extra +
    `Игроки обозначены p1, p2… — обращайся к ним ровно так, не выдумывай имён.\n\n` +
    lines.join("\n") +
    `\n\nДай каждому оценку 0–100 (без одинаковых оценок), одну фразу-вердикт с юмором, но по-доброму, ` +
    `и общий итог в 1–2 предложения. ` + L.answer
  );
}

// Один повтор при кривом ответе (§9 спеки): схема strict, но модель может отдать неполный список.
async function judge(opts) {
  try {
    return await askJudge(opts);
  } catch (err) {
    if (err.name === "AbortError") throw err; // таймаут повторять нечем
    return await askJudge(opts);
  }
}

async function askJudge({ kind, lineups, slots, mode, lang, apiKey, model, timeoutMs = 60000, fetchImpl = fetch }) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["results", "summary"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["player", "score", "verdict"],
          properties: {
            player: { type: "string", enum: lineups.map((l) => l.pid) },
            score: { type: "integer" },
            verdict: { type: "string" },
          },
        },
      },
      summary: { type: "string" },
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: buildPrompt(kind, lineups, slots, mode, lang) }],
        reasoning: { effort: "low" },
        max_output_tokens: 1500,
        text: { format: { type: "json_schema", name: "auction_verdict", strict: true, schema } },
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    const text = (data.output || [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("");
    const parsed = JSON.parse(text);
    const seen = new Set();
    for (const r of parsed.results) {
      if (seen.has(r.player)) throw new Error("duplicate player in verdict");
      seen.add(r.player);
      r.score = Math.max(0, Math.min(100, Math.round(r.score)));
    }
    if (seen.size !== lineups.length) throw new Error("verdict is incomplete");
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { judge, askJudge, buildPrompt, FRAMES, KIND_LABELS, LANGS };
