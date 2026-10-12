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
