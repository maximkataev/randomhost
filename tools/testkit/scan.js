"use strict";
/*
 * scanFrames — поиск секретов / запрещённых ключей в кадрах WS (T-W0-03).
 *
 *   scanFrames(frames, { forbiddenKeys, forbiddenSubstrings, phases, views }) -> violations[]
 *
 * frames  — массив: объект кадра, JSON-строка или запись ws-kit { view, frame } (view: "board"|"player"|…).
 *           Пустой результат = чисто.
 * forbiddenKeys       — имена ключей на любой глубине: строка (точное совпадение), RegExp
 *                       или функция (path, key, value) => truthy (нарушение; строка = пояснение).
 * forbiddenSubstrings — подстроки (строка/RegExp), которых не должно быть ни в строковых значениях,
 *                       ни в именах ключей (регистр учитывается).
 * phases  — белый список фаз: кадр с известной фазой (frame.phase | frame.state.phase) вне списка
 *           пропускается; кадры без фазы сканируются всегда.
 * views   — { board: {forbiddenKeys, forbiddenSubstrings, phases}, player: {...} }: правила вида
 *           ДОБАВЛЯЮТСЯ к общим; кадр с видом, которого нет в views, получает только общие.
 *
 * Нарушение: { frame, view, type, path, key?, match? }; type — "key" | "substring" | "surrogate".
 * Одиночный (непарный) суррогат в строковом значении — тоже нарушение: признак обрезки строки
 * по code unit (ломает «well-formed» потребителей).
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;

const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const keyMatches = (rule, key) => (rule instanceof RegExp ? rule.test(key) : typeof rule === "string" && rule === key);
const subMatches = (rule, text) => (rule instanceof RegExp ? rule.test(text) : typeof rule === "string" && rule !== "" && text.indexOf(rule) !== -1);

function normalise(item) {
  let view = null, frame = item;
  if (typeof item === "string") {
    try { frame = JSON.parse(item); } catch { return { view, frame: item, raw: true }; }
  } else if (item && typeof item === "object" && "frame" in item && ("view" in item || "t" in item)) {
    view = item.view || null;
    frame = item.frame;
    if (typeof frame === "string") { try { frame = JSON.parse(frame); } catch { return { view, frame, raw: true }; } }
  }
  return { view, frame };
}

function phaseOf(frame) {
  if (!frame || typeof frame !== "object") return undefined;
  if (typeof frame.phase === "string") return frame.phase;
  if (frame.state && typeof frame.state.phase === "string") return frame.state.phase;
  return undefined;
}

function scanFrames(frames, opts) {
  opts = opts || {};
  const out = [];
  const list = Array.isArray(frames) ? frames : [frames];
  list.forEach((item, i) => {
    const n = normalise(item);
    const vr = (opts.views && n.view && opts.views[n.view]) || {};
    const keys = asList(opts.forbiddenKeys).concat(asList(vr.forbiddenKeys));
    const subs = asList(opts.forbiddenSubstrings).concat(asList(vr.forbiddenSubstrings));
    const phases = vr.phases || opts.phases;
    if (phases && phases.length) {
      const ph = phaseOf(n.frame);
      if (ph !== undefined && phases.indexOf(ph) === -1) return;
    }
    const hit = (type, path, extra) => out.push(Object.assign({ frame: i, view: n.view, type, path }, extra));

    const checkString = (s, path, isKey) => {
      for (const r of subs) if (subMatches(r, s)) hit("substring", path, { match: String(r) });
      if (!isKey && LONE_SURROGATE.test(s)) hit("surrogate", path);
    };
    const seen = new Set();
    const walk = (v, path) => {
      if (typeof v === "string") return checkString(v, path || "$", false);
      if (!v || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) { v.forEach((x, j) => walk(x, path + "[" + j + "]")); return; }
      for (const k of Object.keys(v)) {
        const p = path ? path + "." + k : k;
        for (const r of keys) {
          if (typeof r === "function") {
            const res = r(p, k, v[k]);
            if (res) hit("key", p, { key: k, match: typeof res === "string" ? res : "fn" });
          } else if (keyMatches(r, k)) hit("key", p, { key: k, match: String(r) });
        }
        checkString(k, p, true);
        walk(v[k], p);
      }
    };
    if (n.raw) { if (typeof n.frame === "string") checkString(n.frame, "$", false); return; }
    walk(n.frame, "");
  });
  return out;
}

module.exports = { scanFrames, LONE_SURROGATE };
