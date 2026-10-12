#!/usr/bin/env node
"use strict";
/*
 * Юнит-тесты клиентского каркаса mp-common.js (T-W1-04/05): vm.runInNewContext, без браузера и без зависимостей.
 *   node tools/testkit/mp-units.js           (из корня репозитория или откуда угодно)
 * Печатает «  ✓ / ✗» (формат run-all-tests.sh), код выхода 1 при красных.
 * Первый блок — лексическая проверка уровня синтаксиса ES2017 (Chromium 80–83 на проекторах; acorn в репозитории нет).
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const FILE = path.join(__dirname, "..", "..", "mp-common.js");
const SRC = fs.readFileSync(FILE, "utf8");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + String(e && e.message || e).split("\n").slice(0, 3).join("\n    ")); }
}

// убрать комментарии и литералы строк/шаблонов, оставив код
function stripCode(src) {
  let out = "", i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

console.log("синтаксис ES2017 (проектор Chromium 80–83)");
const CODE = stripCode(SRC);
const FORBIDDEN = [
  [/\?\.(?!\d)/, "optional chaining ?."],
  [/\?\?/, "nullish ??"],
  [/\.\.\./, "rest/spread ..."],
  [/\bcatch\s*\{/, "optional catch binding"],
  [/\.at\s*\(/, ".at()"],
  [/\.replaceAll\s*\(/, "replaceAll"],
  [/\bObject\.hasOwn\b/, "Object.hasOwn"],
  [/\bstructuredClone\b/, "structuredClone"],
  [/\.replaceChildren\s*\(/, "replaceChildren"],
  [/\?\?=|\|\|=|&&=/, "logical assignment"],
  [/\d_\d/, "numeric separator"],
  [/\bfor\s+await\b/, "for await"],
  [/\bclass\b[^{]*\{[^}]*\bstatic\s*\{/, "static block"],
  [/\bnavigator\.userActivation\b/, "navigator.userActivation"],
];
for (const [re, label] of FORBIDDEN) {
  test("нет " + label, () => assert.ok(!re.test(CODE), "найдено: " + label));
}
test("нет стрелочных функций с await/async-генераторов (необязательно, но проверяем async *)", () => {
  assert.ok(!/async\s*\*|\*\s*async/.test(CODE));
});
test("файл разбирается как скрипт (new vm.Script)", () => {
  new vm.Script(SRC, { filename: "mp-common.js" });
});

// ── окружение ────────────────────────────────────────────────────────────────────────────────────
function load(opts) {
  const o = opts || {};
  const store = o.storage || {};
  const sandbox = {
    console,
    Date,
    Array, String, Object,
    sessionStorage: o.noSession ? undefined : (function () { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; })(),
    localStorage: o.noStorage ? undefined : {
      getItem: (k) => { if (o.storageThrows) throw new Error("denied"); return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: (k, v) => { if (o.storageThrows) throw new Error("denied"); store[k] = String(v); },
      removeItem: (k) => { if (o.storageThrows) throw new Error("denied"); delete store[k]; },
    },
  };
  sandbox.setTimeout = (fn, ms) => { sandbox.__timers.push({ fn, ms }); return sandbox.__timers.length; };
  sandbox.clearTimeout = () => {};
  sandbox.__timers = [];
  sandbox.window = sandbox;
  sandbox.__listeners = [];
  sandbox.addEventListener = (t, fn) => { sandbox.__listeners.push({ t, fn }); };
  sandbox.__fire = (t, detail) => sandbox.__listeners.filter((l) => l.t === t).forEach((l) => l.fn({ detail }));
  vm.runInNewContext(SRC, sandbox, { filename: "mp-common.js" });
  return sandbox;
}

console.log("инициализация и выключатель");
test("window.MP создаётся, MP.version строкой", () => {
  const w = load();
  assert.ok(w.MP);
  assert.equal(typeof w.MP.version, "string");
});
test("localStorage['mp-off']==='1' -> MP не создаётся", () => {
  const w = load({ storage: { "mp-off": "1" } });
  assert.equal(w.MP, undefined);
});
test("хранилище бросает исключения / отсутствует -> MP создаётся, store не падает", () => {
  for (const o of [{ storageThrows: true }, { noStorage: true }]) {
    const w = load(o);
    assert.ok(w.MP);
    assert.equal(w.MP.store.get("x"), null);
    assert.equal(w.MP.store.set("x", 1), false);
    assert.equal(w.MP.store.del("x"), false);
  }
});
test("hello.mp===false выключает модули; иначе limits запоминаются", () => {
  const w = load();
  assert.equal(w.MP.applyHello({ limits: { name: 15 } }), true);
  assert.equal(w.MP.limits.name, 15);
  assert.equal(w.MP.applyHello({ mp: false }), false);
  assert.equal(w.MP.off, true);
  const flow = w.MP.joinFlow({ send() { throw new Error("не должен слать"); } });
  assert.equal(flow.join(), false);
  assert.equal(flow.handle({ type: "error", error: "name_claim", name: "Маша" }), false);
});
test("charCount/clip считают символы, а не UTF-16", () => {
  const w = load();
  assert.equal(w.MP.charCount("😀😀😀"), 3);
  assert.equal(w.MP.clip("😀😀😀😀", 2), "😀😀");
});

console.log("joinFlow");
function flowEnv(extra) {
  const w = load();
  const sent = [];
  const log = { prompts: [], joined: [], taken: [], gaveUp: [] };
  const flow = w.MP.joinFlow(Object.assign({
    send: (m) => sent.push(JSON.parse(JSON.stringify(m))),
    buildJoin: () => ({ type: "join", name: "Маша", token: "t1", avatar: 3 }),
    onClaimPrompt: (p) => log.prompts.push(p),
    onJoined: (m, info) => log.joined.push(info),
    onTaken: (m) => log.taken.push(m),
    onGiveUp: (m) => log.gaveUp.push(m),
  }, extra || {}));
  return { w, sent, log, flow };
}
test("join: имя вместе с токеном, caps:[claim]", () => {
  const { flow, sent } = flowEnv();
  flow.join();
  assert.deepEqual(sent[0], { type: "join", name: "Маша", token: "t1", avatar: 3, caps: ["claim"] });
});
test("name_claim -> экран «Это ты?»: summary, accept шлёт claim:true, decline — fresh:true", () => {
  const { flow, sent, log } = flowEnv();
  flow.join();
  assert.equal(flow.handle({ type: "error", error: "name_claim", name: "Маша", summary: { score: 40 } }), true);
  assert.equal(log.prompts.length, 1);
  assert.equal(log.prompts[0].name, "Маша");
  assert.deepEqual(log.prompts[0].summary, { score: 40 });
  log.prompts[0].accept();
  assert.equal(sent[1].claim, true);
  assert.equal(sent[1].caps[0], "claim");
  flow.handle({ type: "error", error: "name_claim", name: "Маша", summary: {} });
  log.prompts[1].decline();
  assert.equal(sent[2].fresh, true);
  assert.equal(sent[2].claim, undefined);
});
test("повторный name_claim при открытом экране не мигает; resume() повторяет join без флагов", () => {
  const { flow, sent, log } = flowEnv();
  flow.join();
  flow.handle({ type: "error", error: "name_claim", name: "Маша" });
  assert.equal(flow.handle({ type: "error", error: "name_claim", name: "Маша" }), true);
  assert.equal(log.prompts.length, 1);
  assert.equal(flow.state().prompting, true);
  const before = sent.length;
  assert.equal(flow.resume(), true);
  assert.equal(sent.length, before + 1);
  assert.equal(sent[before].claim, undefined);
  assert.equal(sent[before].fresh, undefined);
});
test("retry:true -> тихий повтор через retryInMs, не больше 6 раз, затем onGiveUp", () => {
  const { w, flow, sent, log } = flowEnv();
  flow.join();
  for (let i = 0; i < 6; i++) {
    assert.equal(flow.handle({ type: "error", error: "name_claim", retry: true, retryInMs: 1500 }), true);
    assert.equal(w.__timers.length, i + 1);
    assert.equal(w.__timers[i].ms, 1500);
    w.__timers[i].fn();
  }
  assert.equal(sent.length, 7);
  assert.equal(log.prompts.length, 0);
  assert.equal(flow.handle({ type: "error", error: "name_claim", retry: true }), true);
  assert.equal(log.gaveUp.length, 1);
  assert.equal(w.__timers.length, 6);
});
test("retry без retryInMs -> 2000 мс; повтор сохраняет claim:true", () => {
  const { w, flow, sent } = flowEnv();
  flow.join({ claim: true });
  flow.handle({ type: "error", error: "name_claim", retry: true });
  assert.equal(w.__timers[0].ms, 2000);
  w.__timers[0].fn();
  assert.equal(sent[1].claim, true);
});
test("joined -> onJoined с name/renamed/resumed, сообщение НЕ потребляется; счётчик retry сброшен", () => {
  const { flow, log } = flowEnv();
  flow.join();
  flow.handle({ type: "error", error: "name_claim", retry: true });
  assert.equal(flow.handle({ type: "joined", name: "Маша (2)", renamed: true, playerId: 5 }), false);
  assert.deepEqual(log.joined[0], { name: "Маша (2)", renamed: true, resumed: false });
  assert.equal(flow.state().retries, 0);
});
test("name_taken и незнакомая ошибка не потребляются (поведение как раньше)", () => {
  const { flow, log } = flowEnv();
  assert.equal(flow.handle({ type: "error", error: "name_taken" }), false);
  assert.equal(log.taken.length, 1);
  assert.equal(flow.handle({ type: "error", error: "что-то-новое" }), false);
  assert.equal(flow.handle({ type: "state" }), false);
  assert.equal(flow.handle(null), false);
});

console.log("nameCounter");
function fakeInput(value) {
  const listeners = {};
  return {
    value, parentNode: null,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t) { (listeners[t] || []).forEach((f) => f()); },
  };
}
function fakeEl() {
  const attrs = {};
  return { textContent: "", style: {}, setAttribute(k, v) { attrs[k] = v; }, attrs };
}
test("счётчик «12/16» виден за 4 символа до лимита; срез по символам", () => {
  const w = load();
  const input = fakeInput("");
  const el = fakeEl();
  const c = w.MP.nameCounter(input, 16, { el });
  assert.equal(el.textContent, "");
  assert.equal(el.attrs["data-state"], "ok");
  input.value = "а".repeat(11); input.fire("input");
  assert.equal(el.textContent, "");
  input.value = "а".repeat(12); input.fire("input");
  assert.equal(el.textContent, "12/16");
  assert.equal(el.attrs["data-state"], "near");
  input.value = "😀".repeat(20); input.fire("input");
  assert.equal(input.value, "😀".repeat(16));
  assert.equal(el.textContent, "16/16");
  assert.equal(el.attrs["data-state"], "full");
  assert.equal(c.count(), 16);
  assert.equal(w.MP.nameCounter.format(12, 16), "12/16");
});

console.log("replacedTab");
test("replaced -> onReplaced; «Играть здесь» -> rejoin; token_gone -> onTokenGone", () => {
  const w = load();
  const calls = [];
  const rt = w.MP.replacedTab({ rejoin: () => calls.push("rejoin"), onReplaced: () => calls.push("replaced"), onTokenGone: () => calls.push("gone") });
  assert.equal(rt.handle({ type: "error", error: "token_gone" }), false); // не в режиме возврата
  assert.equal(rt.handle({ type: "replaced" }), true);
  assert.equal(rt.isReplaced(), true);
  rt.back(1000);
  assert.equal(rt.isReplaced(), false);
  assert.equal(rt.handle({ type: "error", error: "token_gone" }), true);
  assert.deepEqual(calls, ["replaced", "rejoin", "gone"]);
});
test("авто-возврат: выключен по умолчанию; ≥ 5 с между возвратами; не после claim с другого устройства (60 с)", () => {
  const w = load();
  assert.equal(w.MP.replacedTab({}).canAutoReturn(1e6), false);
  const rt = w.MP.replacedTab({ auto: true, rejoin() {} });
  assert.equal(rt.canAutoReturn(1e6), true);
  rt.back(1e6);
  assert.equal(rt.canAutoReturn(1e6 + 4000), false);
  assert.equal(rt.canAutoReturn(1e6 + 5000), true);
  rt.noteClaimElsewhere(1e6 + 6000);
  assert.equal(rt.canAutoReturn(1e6 + 30000), false);
  assert.equal(rt.canAutoReturn(1e6 + 66000), true);
});

console.log("followRoomLang (U-17, за флагом)");
function i18nStub(lang) {
  const st = { lang, calls: [] };
  st.api = { get lang() { return st.lang; }, setLang(l, o) { st.calls.push([l, o]); st.lang = l; } };
  return st;
}
test("флаг RULE_U17_LANG_FOLLOW по умолчанию выключен -> check() ничего не делает", () => {
  const w = load();
  assert.equal(w.MP.rules.RULE_U17_LANG_FOLLOW, false);
  const i = i18nStub("en"); w.I18N = i.api;
  const f = w.MP.followRoomLang({ getRoomLang: () => "ru", auto: true });
  assert.equal(f.check(), false);
  assert.equal(i.calls.length, 0);
});
test("auto: следует языку комнаты через setLang(.., {persist:false}); совпадение — без вызова", () => {
  const w = load();
  const i = i18nStub("en"); w.I18N = i.api;
  const f = w.MP.followRoomLang({ enabled: true, auto: true, getRoomLang: () => "ru" });
  assert.equal(f.check(), "switched");
  assert.deepEqual(i.calls, [["ru", { persist: false }]]);
  assert.equal(f.check(), false);
  assert.equal(f.check("xx"), false);
});
test("ручной выбор (langchange с persist) останавливает следование; стартовый langchange — нет", () => {
  const w = load();
  const i = i18nStub("en"); w.I18N = i.api;
  const f = w.MP.followRoomLang({ enabled: true, auto: true });
  w.__fire("langchange", { lang: "en", initial: true });
  assert.equal(f.isManual(), false);
  assert.equal(f.check("ru"), "switched");        // наш же setLang(persist:false) не считается ручным
  w.__fire("langchange", { lang: "ru", persist: false });
  assert.equal(f.isManual(), false);
  w.__fire("langchange", { lang: "el", persist: true });
  assert.equal(f.isManual(), true);
  i.lang = "el";
  assert.equal(f.check("ru"), false);
  assert.equal(w.sessionStorage.getItem("mp-lang-manual"), "1");
});
test("подсказка: onSuggest один раз на язык; accept запоминает выбор, decline — тоже", () => {
  const w = load();
  const i = i18nStub("ru"); w.I18N = i.api;
  const seen = [];
  const f = w.MP.followRoomLang({ enabled: true, onSuggest: (s) => seen.push(s) });
  assert.equal(f.check("en"), "suggested");
  assert.equal(f.check("en"), false);
  assert.equal(seen[0].lang, "en");
  seen[0].accept();
  assert.deepEqual(i.calls, [["en", { persist: true }]]);
  assert.equal(f.isManual(), true);
  const w2 = load(); w2.I18N = i18nStub("ru").api;
  const f2 = w2.MP.followRoomLang({ enabled: true, onSuggest: (s) => s.decline() });
  assert.equal(f2.check("el"), "suggested");
  assert.equal(f2.isManual(), true);
  assert.equal(f2.check("en"), false);
});
test("MP_OFF: followRoomLang инертен; без sessionStorage не падает", () => {
  const w = load({ noSession: true });
  const i = i18nStub("en"); w.I18N = i.api;
  const f = w.MP.followRoomLang({ enabled: true, auto: true });
  assert.equal(f.check("ru"), "switched");
  f.markManual();
  assert.equal(f.isManual(), true);
  w.MP.applyHello({ mp: false });
  assert.equal(f.check("el"), false);
});

console.log("twoTap");
function fakeEl(text) {
  const h = {};
  return { textContent: text, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { h[t] = f; }, removeEventListener(t) { delete h[t]; }, click() { if (h.click) h.click({ type: "click" }); } };
}
test("twoTap: первый тап взводит и меняет подпись, второй выполняет и возвращает подпись", () => {
  const w = load();
  const el = fakeEl("Закончить");
  let n = 0;
  const c = w.MP.twoTap(el, { onConfirm: () => n++, armedLabel: "Точно завершить?" });
  el.click();
  assert.equal(n, 0);
  assert.equal(c.isArmed(), true);
  assert.equal(el.attrs["data-armed"], "1");
  assert.equal(el.textContent, "Точно завершить?");
  el.click();
  assert.equal(n, 1);
  assert.equal(c.isArmed(), false);
  assert.equal(el.attrs["data-armed"], undefined);
  assert.equal(el.textContent, "Закончить");
});
test("twoTap: через 3 с само снимается, третий тап снова только взводит", () => {
  const w = load();
  const el = fakeEl("Дальше");
  let n = 0;
  const c = w.MP.twoTap(el, { onConfirm: () => n++, armedLabel: "Точно?" });
  el.click();
  assert.equal(w.__timers[w.__timers.length - 1].ms, 3000);
  w.__timers[w.__timers.length - 1].fn();
  assert.equal(c.isArmed(), false);
  assert.equal(el.textContent, "Дальше");
  el.click();
  assert.equal(n, 0);
  assert.equal(c.isArmed(), true);
});
test("twoTap.create: ключи, перевзвод по другому ключу, onChange", () => {
  const w = load();
  const ch = [];
  const c = w.MP.twoTap.create({ onChange: (k) => ch.push(k) });
  assert.equal(c.tap("a"), false);
  assert.equal(c.tap("b"), false); // другой — перевзвод
  assert.equal(c.armed(), "b");
  assert.equal(c.tap("b"), true);
  assert.equal(c.armed(), null);
  assert.deepEqual(ch, ["a", "b", null]);
  c.tap("a"); c.disarm();
  assert.equal(c.isArmed("a"), false);
});
test("twoTap при MP.off — один тап выполняет (как до модуля)", () => {
  const w = load();
  w.MP.applyHello({ mp: false });
  const el = fakeEl("X");
  let n = 0;
  w.MP.twoTap(el, { onConfirm: () => n++ });
  el.click();
  assert.equal(n, 1);
});

console.log("draft");
test("draft: save/load по ключу фазы, один слот на комнату, регистр кода не важен", () => {
  const st = {};
  const w = load({ storage: st });
  const d = w.MP.draft({ game: "wave", room: "tiger42" });
  assert.equal(d.key(), "mp:draft:wave:TIGER42");
  assert.equal(d.load("g:0"), null);
  assert.equal(d.save("g:0", "морской бриз"), true);
  assert.equal(d.load("g:0"), "морской бриз");
  assert.deepEqual(Object.keys(JSON.parse(st[d.key()])).sort(), ["at", "k", "t"]);
  assert.equal(d.load("g:1"), null, "другая фаза — не показываем");
  assert.equal(st[d.key()], undefined, "чужой слот удалён");
});
test("draft: пустой текст удаляет, clear удаляет, срез по символам", () => {
  const st = {};
  const w = load({ storage: st });
  const d = w.MP.draft({ game: "wave", room: "A1", max: 3 });
  d.save("k", "😀😀😀😀😀");
  assert.equal(d.load("k"), "😀😀😀");
  d.save("k", "   ");
  assert.equal(st[d.key()], undefined);
  d.save("k", "x"); d.clear();
  assert.equal(d.load("k"), null);
});
test("draft: TTL 2 ч (по часам now) и обновление at при новом вводе", () => {
  let t = 1e9;
  const w = load();
  const d = w.MP.draft({ game: "wave", room: "A1", now: () => t });
  d.save("k", "один");
  t += 2 * 3600e3 - 1;
  assert.equal(d.load("k"), "один");
  d.save("k", "один два");
  t += 2 * 3600e3 - 1;
  assert.equal(d.load("k"), "один два");
  t += 2;
  assert.equal(d.load("k"), null);
});
test("draft: хранилище бросает/нет -> не падает; битый JSON -> null", () => {
  for (const o of [{ storageThrows: true }, { noStorage: true }]) {
    const d = load(o).MP.draft({ game: "wave", room: "A1" });
    assert.equal(d.save("k", "x"), false);
    assert.equal(d.load("k"), null);
    d.clear();
  }
  const st = { "mp:draft:wave:A1": "{не json" };
  assert.equal(load({ storage: st }).MP.draft({ game: "wave", room: "A1" }).load("k"), null);
});
test("draft: mp.off -> пусто", () => {
  const w = load();
  const d = w.MP.draft({ game: "wave", room: "A1" });
  w.MP.applyHello({ mp: false });
  assert.equal(d.save("k", "x"), false);
  assert.equal(d.load("k"), null);
});

console.log("sendQueue");
function qEnv(extra) {
  const w = load();
  const clock = { now: 1000, timers: [] };
  const log = { sent: [], dropped: [], probes: [] };
  const q = w.MP.sendQueue(Object.assign({
    now: () => clock.now,
    setTimeout: (fn, ms) => { clock.timers.push({ fn, at: clock.now + ms, live: true }); return clock.timers.length - 1; },
    clearTimeout: (id) => { if (clock.timers[id]) clock.timers[id].live = false; },
    send: (m) => log.sent.push(m.type + (m.n != null ? m.n : "")),
    onDrop: (m, why) => log.dropped.push(m.type + (m.n != null ? m.n : "") + ":" + why),
    probe: (ms) => log.probes.push(ms),
    replace: ["lock", "clue"],
  }, extra));
  // продвинуть время, выполняя таймеры по порядку
  const advance = (ms) => {
    const end = clock.now + ms;
    for (;;) {
      const next = clock.timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false; clock.now = Math.max(clock.now, next.at); next.fn();
    }
    clock.now = end;
  };
  return { w, q, clock, log, advance };
}
test("sendQueue: flush отправляет по порядку, не быстрее 4/с", () => {
  const e = qEnv();
  for (let i = 0; i < 4; i++) e.q.push({ type: "vote", n: i });
  e.q.flush();
  assert.equal(JSON.stringify(e.log.sent), '["vote0"]');
  e.advance(250); assert.equal(e.log.sent.length, 2);
  e.advance(500); assert.equal(e.log.sent.length, 4);
  assert.equal(e.q.size(), 0);
  assert.equal(e.q.isFlushing(), false);
});
test("sendQueue: replace — свежее заменяет старое без onDrop", () => {
  const e = qEnv();
  e.q.push({ type: "lock", n: 1 }); e.q.push({ type: "pick", n: 5 }); e.q.push({ type: "lock", n: 2 });
  assert.equal(e.q.size(), 2);
  e.q.flush();
  e.advance(1000);
  assert.equal(JSON.stringify(e.log.sent), '["pick5","lock2"]');
  assert.equal(e.log.dropped.length, 0);
});
test("sendQueue: keep проверяется в момент отправки; ненужное — onDrop(unwanted)", () => {
  let alive = true;
  const e = qEnv({ keep: (m) => m.type !== "pick" || alive });
  e.q.push({ type: "pick", n: 1 }); e.q.push({ type: "lock", n: 2 });
  alive = false;
  e.q.flush();
  e.advance(1000);
  assert.equal(JSON.stringify(e.log.sent), '["lock2"]');
  assert.equal(JSON.stringify(e.log.dropped), '["pick1:unwanted"]');
});
test("sendQueue: потолок по типу действия, а не общий (бросок 4 с, lock 90 с)", () => {
  const e = qEnv({ ceilingMs: { throw: 4000, "*": 90000 } });
  e.q.push({ type: "throw", n: 1 }); e.q.push({ type: "lock", n: 2 });
  e.clock.now += 5000;
  e.q.flush();
  e.advance(1000);
  assert.equal(JSON.stringify(e.log.sent), '["lock2"]');
  assert.equal(JSON.stringify(e.log.dropped), '["throw1:expired"]');
  e.q.push({ type: "lock", n: 3 });
  e.clock.now += 91000;
  e.q.flush(); e.advance(1000);
  assert.equal(JSON.stringify(e.log.dropped), '["throw1:expired","lock3:expired"]');
});
test("sendQueue: переполнение вытесняет старейшее через onDrop(overflow)", () => {
  const e = qEnv({ max: 2 });
  e.q.push({ type: "a", n: 1 }); e.q.push({ type: "b", n: 2 }); e.q.push({ type: "c", n: 3 });
  assert.equal(JSON.stringify(e.log.dropped), '["a1:overflow"]');
  assert.equal(e.q.size(), 2);
});
test("sendQueue: flush(()=>false, onDrop) выбрасывает всё через переданный onDrop", () => {
  const e = qEnv();
  const mine = [];
  e.q.push({ type: "a", n: 1 }); e.q.push({ type: "b", n: 2 });
  e.q.flush(() => false, (m, why) => mine.push(m.type + ":" + why));
  assert.equal(JSON.stringify(mine), '["a:unwanted","b:unwanted"]');
  assert.equal(e.log.dropped.length, 0);
  assert.equal(e.log.sent.length, 0);
});
test("sendQueue: probe(1500) при тишине > 8 с, не чаще раза в 8 с; heard сбрасывает тишину", () => {
  const e = qEnv();
  e.q.push({ type: "lock", n: 1 });
  e.advance(7000);
  assert.equal(e.log.probes.length, 0);
  e.advance(2000);
  assert.equal(JSON.stringify(e.log.probes), "[1500]");
  e.advance(5000);
  assert.equal(e.log.probes.length, 1);
  e.advance(4000);
  assert.equal(e.log.probes.length, 2);
  e.q.heard();
  e.advance(7000);
  assert.equal(e.log.probes.length, 2);
});
test("sendQueue: push во время flush уходит с тем же шагом; clear без onDrop; MP.off -> push=false + onDrop(off)", () => {
  const e = qEnv();
  e.q.push({ type: "a", n: 1 }); e.q.push({ type: "b", n: 2 });
  e.q.flush();
  e.q.push({ type: "c", n: 3 });
  assert.equal(JSON.stringify(e.log.sent), '["a1"]');
  e.advance(600);
  assert.equal(JSON.stringify(e.log.sent), '["a1","b2","c3"]');
  e.q.push({ type: "d", n: 4 }); e.q.clear();
  assert.equal(e.q.size(), 0);
  e.w.MP.applyHello({ mp: false });
  assert.equal(e.q.push({ type: "e", n: 5 }), false);
  assert.equal(e.log.dropped[e.log.dropped.length - 1], "e5:off");
});

// ── hostLink / roomGone (T-W1-10, T-W1-12) ───────────────────────────────────────────────────────
const asyncTests = [];
function atest(name, fn) { asyncTests.push({ name, fn }); }

function hostEnv(extra) {
  const store = { "bomb-host-BEAR74": "tok_ABCdef123456" };
  const w = load({ storage: store });
  const log = { toasts: [], sent: [], prompts: [], copied: [], shared: [] };
  const o = Object.assign({
    hostKeyFn: () => "bomb-host-BEAR74",
    boardPath: "bomb-board.html",
    getRoom: () => "BEAR74",
    onToast: (k) => log.toasts.push(k),
    sendHost: (t) => log.sent.push(t),
    location: { href: "https://randomhost.online/bomb-board.html?r=BEAR74#x" },
    prompt: (m, v) => log.prompts.push(v),
    navigator: { clipboard: { writeText: (u) => { log.copied.push(u); return Promise.resolve(); } } },
  }, extra || {});
  return { w, log, store, hl: w.MP.hostLink(o) };
}

console.log("hostLink / roomGone");
test("hostLink.url: ?r=КОД&h=ТОКЕН рядом с доской, без хвоста старого адреса", () => {
  const e = hostEnv();
  assert.equal(e.hl.url(), "https://randomhost.online/bomb-board.html?r=BEAR74&h=tok_ABCdef123456");
});
test("hostLink.url: нет токена или кода -> null", () => {
  assert.equal(hostEnv({ hostKeyFn: () => "nokey" }).hl.url(), null);
  assert.equal(hostEnv({ getRoom: () => "" }).hl.url(), null);
});
test("hostLink.parseToken: ссылка с ?h=, голый токен, мусор", () => {
  const w = load();
  const P = w.MP.hostLink.parseToken;
  assert.equal(P("https://x.y/bomb-board.html?r=BEAR74&h=tok_ABCdef123456"), "tok_ABCdef123456");
  assert.equal(P("  tok_ABCdef123456 "), "tok_ABCdef123456");
  assert.equal(P("?h=a b"), null);
  assert.equal(P("привет"), null);
  assert.equal(P(""), null);
});
test("hostLink.adopt кладёт токен в localStorage; мусор не кладёт", () => {
  const e = hostEnv({ hostKeyFn: () => "bomb-host-NEW11" });
  assert.equal(e.hl.adopt("???"), null);
  assert.equal(e.store["bomb-host-NEW11"], undefined);
  assert.equal(e.hl.adopt("https://a/b?r=NEW11&h=zzzzzzzz9"), "zzzzzzzz9");
  assert.equal(e.store["bomb-host-NEW11"], "zzzzzzzz9");
});
test("hostLink.take: не чаще раза в 3 с, шлёт сохранённый токен; без токена — false", () => {
  const e = hostEnv();
  assert.equal(e.hl.take(1000), true);
  assert.equal(e.hl.take(3999), false);
  assert.equal(e.hl.take(4000), true);
  assert.deepEqual(e.log.sent, ["tok_ABCdef123456", "tok_ABCdef123456"]);
  assert.equal(hostEnv({ hostKeyFn: () => "nokey" }).hl.take(1), false);
});
atest("hostLink.copy: clipboard -> 'copied', токен не уходит в prompt", async () => {
  const e = hostEnv();
  assert.equal(await e.hl.copy(), "copied");
  assert.deepEqual(e.log.copied, ["https://randomhost.online/bomb-board.html?r=BEAR74&h=tok_ABCdef123456"]);
  assert.deepEqual(e.log.prompts, []);
  assert.deepEqual(e.log.toasts, ["copied"]);
});
atest("hostLink.copy: clipboard отказал -> Web Share; отмена шеринга не открывает prompt", async () => {
  const shared = [];
  let e = hostEnv({ navigator: { clipboard: { writeText: () => Promise.reject(new Error("denied")) }, share: (d) => { shared.push(d.url); return Promise.resolve(); } } });
  assert.equal(await e.hl.copy(), "shared");
  assert.equal(shared.length, 1);
  e = hostEnv({ navigator: { share: () => Promise.reject({ name: "AbortError" }) } });
  assert.equal(await e.hl.copy(), "cancelled");
  assert.deepEqual(e.log.prompts, []);
});
atest("hostLink.copy: ни clipboard, ни share -> prompt() с готовой ссылкой; без токена — 'none'", async () => {
  let e = hostEnv({ navigator: {} });
  assert.equal(await e.hl.copy(), "prompt");
  assert.equal(e.log.prompts.length, 1);
  assert.ok(e.log.prompts[0].indexOf("h=tok_ABCdef123456") > 0);
  e = hostEnv({ hostKeyFn: () => "nokey" });
  assert.equal(await e.hl.copy(), "none");
  assert.deepEqual(e.log.copied, []);
});
test("hostLink при MP_OFF: copy и take ничего не делают", () => {
  const e = hostEnv();
  e.w.MP.applyHello({ mp: false });
  assert.equal(e.hl.take(1), false);
  assert.deepEqual(e.log.sent, []);
});
test("roomGone: до hello 404 -> showForm; после hello -> onClosed; повторный gone молчит", () => {
  const w = load();
  const calls = [];
  let g = w.MP.roomGone({ showForm: () => calls.push("form"), onClosed: () => calls.push("closed") });
  assert.equal(g.seen(), false);
  assert.equal(g.gone(), "noroom");
  assert.equal(g.gone(), "noroom");
  assert.deepEqual(calls, ["form"]);
  g = w.MP.roomGone({ showForm: () => calls.push("form2"), onClosed: () => calls.push("closed") });
  g.hello();
  assert.equal(g.gone(), "closed");
  assert.deepEqual(calls, ["form", "closed"]);
});
test("roomGone.submit: итоговый код после фильтра, пустой -> null", () => {
  const w = load();
  const g = w.MP.roomGone({});
  assert.equal(g.submit(" bear 74 "), "BEAR74");
  assert.equal(g.submit("be-ar_01"), "BEAR");
  assert.equal(g.submit("   "), null);
  assert.equal(g.submit("!!!"), null);
  assert.equal(w.MP.roomGone.normalize("a".repeat(30)).length, 12);
});

(async () => {
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log("  ✓ " + t.name); }
    catch (e) { failed++; console.log("  ✗ " + t.name + "\n    " + String(e && e.message || e).split("\n").slice(0, 3).join("\n    ")); }
  }
  console.log("\n" + passed + " пройдено, " + failed + " провалено");
  process.exit(failed ? 1 : 0);
})();
