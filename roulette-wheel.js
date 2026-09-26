/*
 * Рулетка: колесо, шарик и стол в одной 3D-сцене для общего экрана (roulette-spec.md §7, §10).
 *
 * Мир — подпольный казино-клуб: тёмный зал, одна тёплая лампа над столом, лакированный орех,
 * латунь, зелёное сукно. Всё строится кодом (без glTF и CDN), three.js лежит в vendor/.
 *
 * Путь шарика не симулируется, а берётся из roulette-trajectory.js: он построен назад от числа,
 * которое уже выбрал сервер, и по сиду одинаков на любой доске — переподключение показывает тот же спин.
 * Сцена отвечает только за картинку, камеру, звук и время.
 *
 * Время: opts.now() — серверные мс (спин, выплаты). Анимации интерфейса (фишки, руки) идут по
 * локальным часам — они не обязаны совпадать между досками.
 *
 * Текстов поверх сцены здесь нет: большое число, имена и «СПАСЁН» рисует страница.
 */

import * as THREE from "./vendor/three.module.min.js";
import { buildTrajectory, wheelHandoff, IDLE_SPEED, GEOM, WHEEL, PA, POCKETS, RED, statorY, ringY } from "./roulette-trajectory.js";

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (k) => { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); };
const easeOut = (k) => 1 - Math.pow(1 - clamp(k, 0, 1), 3);
const easeInOut = (k) => { k = clamp(k, 0, 1); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const wrapPi = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
function hash01(n) {
  n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const numColor = (n) => (n === 0 ? "green" : RED.has(n) ? "red" : "black");

// ---------- ставки: какие номера покрывает ключ (как buildBets в roulette/game.js) ----------

function betNumbers(key) {
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  if (key === "red") return range(1, 36).filter((n) => RED.has(n));
  if (key === "black") return range(1, 36).filter((n) => !RED.has(n));
  if (key === "even") return range(1, 36).filter((n) => n % 2 === 0);
  if (key === "odd") return range(1, 36).filter((n) => n % 2 === 1);
  if (key === "low") return range(1, 18);
  if (key === "high") return range(19, 36);
  const [t, rest] = String(key).split(":");
  if (t === "dz") { const d = Number(rest) - 1; return range(12 * d + 1, 12 * d + 12); }
  if (t === "col") { const c = Number(rest) - 1; return range(0, 11).map((r) => 3 * r + c + 1); }
  if (!rest) return [];
  return rest.split("-").map(Number).filter((n) => n >= 0 && n <= 36);
}

// ---------- раскладка стола (метры, мировые координаты; игроки со стороны +z, крупье — −z) ----------

const LAY = { x0: -0.47, z0: -0.2, cw: 0.085, ch: 0.07, zeroW: 0.078, colW: 0.08, rowH: 0.064 };
LAY.w = LAY.zeroW + 12 * LAY.cw + LAY.colW;
LAY.h = 3 * LAY.ch + 2 * LAY.rowH;
const streetX = (r) => LAY.x0 + LAY.zeroW + (r + 0.5) * LAY.cw;
const rowZ = (c) => LAY.z0 + (2 - c + 0.5) * LAY.ch; // c=0: 1,4,7… у игроков; c=2: 3,6,9… у крупье
function cellCenter(n) {
  if (n === 0) return [LAY.x0 + LAY.zeroW / 2, LAY.z0 + 1.5 * LAY.ch];
  const r = Math.floor((n - 1) / 3), c = (n - 1) % 3;
  return [streetX(r), rowZ(c)];
}
const OUTSIDE = ["low", "even", "red", "black", "odd", "high"];
function betPos(key) {
  const nearZ = LAY.z0 + 3 * LAY.ch;
  const edgeX = LAY.x0 + LAY.zeroW;
  if (key.startsWith("dz:")) { const d = Number(key.slice(3)) - 1; return [LAY.x0 + LAY.zeroW + (4 * d + 2) * LAY.cw, nearZ + LAY.rowH / 2]; }
  if (key.startsWith("col:")) { const c = Number(key.slice(4)) - 1; return [LAY.x0 + LAY.zeroW + 12 * LAY.cw + LAY.colW / 2, rowZ(c)]; }
  const oi = OUTSIDE.indexOf(key);
  if (oi >= 0) return [LAY.x0 + LAY.zeroW + (2 * oi + 1) * LAY.cw, nearZ + LAY.rowH * 1.5];
  const nums = betNumbers(key);
  const t = key.split(":")[0];
  if (nums.includes(0)) {
    // ставки с зеро лежат на его границе с первой улицей
    if (t === "n") return cellCenter(0);
    if (t === "sp") return [edgeX, cellCenter(nums[1])[1]];
    if (key === "st:0-1-2") return [edgeX, LAY.z0 + 2 * LAY.ch];
    if (key === "st:0-2-3") return [edgeX, LAY.z0 + LAY.ch];
    return [edgeX, nearZ]; // «первые четыре»
  }
  if (t === "st") return [streetX(Math.floor((nums[0] - 1) / 3)), nearZ];
  if (t === "sl") return [streetX(Math.floor((nums[0] - 1) / 3)) + LAY.cw / 2, nearZ];
  let x = 0, z = 0;
  for (const n of nums) { const p = cellCenter(n); x += p[0]; z += p[1]; }
  return nums.length ? [x / nums.length, z / nums.length] : [0, 0];
}

// инициалы — как на аватарке рельса доски: первые буквы слов, без эмодзи бота, максимум две
function initialsOf(p) {
  if (p && p.initials) return String(p.initials).slice(0, 3);
  return String((p && p.name) || "?").replace(/^\p{Extended_Pictographic}\s*/u, "").split(/\s+/).filter(Boolean).map((w) => [...w][0]).join("").slice(0, 2).toUpperCase() || "?";
}
// сумма ставки: 1 250 → «1 250», 12 500 → «12,5k»
function rlAmount(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 10000) return (Math.round(n / 100) / 10).toString().replace(".", ",") + "k";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
}

// ---------- процедурные текстуры ----------

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Орех: волокна идут по u — на телах вращения это кольца точёного дерева
function woodCanvas(w, h, seed, base, dark, light) {
  const c = canvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  let s = seed;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  // широкие полосы тона
  for (let i = 0; i < 18; i++) {
    const y = rnd() * h, hh = 6 + rnd() * h * 0.2;
    g.fillStyle = rnd() < 0.5 ? dark : light;
    g.globalAlpha = 0.06 + rnd() * 0.1;
    g.fillRect(0, y, w, hh);
  }
  // тонкие волокна с лёгкой волной
  for (let i = 0; i < 340; i++) {
    const y0 = rnd() * h;
    const amp = 1 + rnd() * 5;
    const f = (1 + Math.floor(rnd() * 4)) * TAU / w;
    const ph = rnd() * TAU;
    g.strokeStyle = rnd() < 0.62 ? dark : light;
    g.globalAlpha = 0.05 + rnd() * 0.22;
    g.lineWidth = 0.4 + rnd() * 1.8;
    g.beginPath();
    for (let x = 0; x <= w; x += 16) {
      const y = y0 + Math.sin(x * f + ph) * amp;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // поры
  g.fillStyle = dark;
  for (let i = 0; i < 2600; i++) {
    g.globalAlpha = 0.12 + rnd() * 0.25;
    g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 7, 0.8);
  }
  g.globalAlpha = 1;
  return c;
}

function tex(c, opts = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso || 8;
  if (opts.repeat) { t.wrapS = THREE.RepeatWrapping; t.repeat.set(opts.repeat, 1); }
  if (opts.wrapT) t.wrapT = THREE.RepeatWrapping;
  return t;
}

const FELT = "#1d5a3b";
const POCKET_RGB = { red: "#9c1c17", black: "#141112", green: "#0e6b3e" };
const GOLD = "#e3c27d";

/*
 * Номерное кольцо: 37 цветных секторов, золотые цифры, тонкие латунные разделители.
 * u идёт против угла (u = 1 − a/2π), иначе цифры читались бы зеркально снаружи колеса.
 * Вторая канва — карта металличности: цифры и разделители — металл, фон — лак.
 */
function numberRingCanvases(W, H) {
  const c = canvas(W, H), m = canvas(W, H);
  const g = c.getContext("2d"), gm = m.getContext("2d");
  gm.fillStyle = "#000";
  gm.fillRect(0, 0, W, H);
  const sw = W / POCKETS;
  for (let i = 0; i < POCKETS; i++) {
    const n = WHEEL[i];
    const cx = (((POCKETS - i) % POCKETS) + 0.5) * sw - sw / 2; // центр сектора: u = 1 − i/37
    for (const dx of [0, W, -W]) {
      const x = cx + dx - sw / 2;
      if (x > W || x + sw < 0) continue;
      const grd = g.createLinearGradient(0, 0, 0, H);
      const base = POCKET_RGB[numColor(n)];
      grd.addColorStop(0, base);
      grd.addColorStop(1, shade(base, -0.25));
      g.fillStyle = grd;
      g.fillRect(x, 0, sw + 1, H);
      // разделитель
      g.fillStyle = GOLD;
      g.fillRect(x - 1.5, 0, 3, H);
      gm.fillStyle = "#fff";
      gm.fillRect(x - 1.5, 0, 3, H);
      // цифра: низ к внешнему краю (низ канвы — v=0 — наружный радиус)
      const fs = Math.round(H * 0.5);
      g.font = `700 ${fs}px Georgia, "Times New Roman", serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const tx = x + sw / 2, ty = H * 0.54;
      g.save();
      g.translate(tx, ty);
      g.scale(n >= 10 ? 0.7 : 1, 1);
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillText(String(n), 2, 3);
      g.fillStyle = GOLD;
      g.fillText(String(n), 0, 0);
      g.restore();
      gm.save();
      gm.translate(tx, ty);
      gm.scale(n >= 10 ? 0.7 : 1, 1);
      gm.font = g.font;
      gm.textAlign = "center";
      gm.textBaseline = "middle";
      gm.fillStyle = "#fff";
      gm.fillText(String(n), 0, 0);
      gm.restore();
    }
  }
  // латунные кромки кольца
  g.fillStyle = GOLD;
  g.fillRect(0, 0, W, 5);
  g.fillRect(0, H - 5, W, 5);
  gm.fillStyle = "#fff";
  gm.fillRect(0, 0, W, 5);
  gm.fillRect(0, H - 5, W, 5);
  return [c, m];
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, clamp(hsl.l * (1 + k), 0, 1));
  return "#" + c.getHexString();
}

// Дно ячеек: цвет номера, к фреткам темнее — видно глубину
function pocketFloorCanvas(W, H) {
  const c = canvas(W, H);
  const g = c.getContext("2d");
  const sw = W / POCKETS;
  for (let i = 0; i < POCKETS; i++) {
    const n = WHEEL[i];
    const cx = (((POCKETS - i) % POCKETS) + 0.5) * sw - sw / 2;
    for (const dx of [0, W, -W]) {
      const x = cx + dx - sw / 2;
      const base = shade(POCKET_RGB[numColor(n)], -0.3);
      const grd = g.createLinearGradient(x, 0, x + sw, 0);
      grd.addColorStop(0, shade(base, -0.5));
      grd.addColorStop(0.2, base);
      grd.addColorStop(0.8, base);
      grd.addColorStop(1, shade(base, -0.5));
      g.fillStyle = grd;
      g.fillRect(x, 0, sw + 1, H);
    }
  }
  const v = g.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, "rgba(0,0,0,0.35)");
  v.addColorStop(0.5, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.45)");
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
  return c;
}

// Выпавший номер на кольце колеса: светлая золотая плашка, цифра цвета номера, рамка в цвет номера.
// Инверсия к кольцу (там золото по красному/чёрному) — поэтому плашка видна даже с общего плана.
const NUM_INK = { red: "#b3160f", black: "#15100c", green: "#0b7a45" };
function drawWinnerNumeral(c, n) {
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  const ink = NUM_INK[numColor(n)];
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, "#fff4cf");
  grd.addColorStop(1, "#f0c863");
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = ink;
  g.lineWidth = 18;
  g.strokeRect(9, 9, W - 18, H - 18);
  g.font = `900 ${Math.round(H * 0.66)}px Georgia, "Times New Roman", serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.save();
  g.translate(W / 2, H * 0.55);
  g.scale(n >= 10 ? 0.74 : 1, 1);
  g.fillStyle = ink;
  g.fillText(String(n), 0, 0);
  g.restore();
}

// Выпавшая клетка на сукне: светящийся ореол и светлая плашка с цифрой цвета номера (на зеро — зелёная)
function cellPlateCanvas(n) {
  const zero = n === 0;
  const w = zero ? LAY.zeroW : LAY.cw, h = zero ? 3 * LAY.ch : LAY.ch;
  const PX = 1600, pad = 0.024;
  const W = Math.round((w + 2 * pad) * PX), H = Math.round((h + 2 * pad) * PX);
  const c = canvas(W, H);
  const g = c.getContext("2d");
  const x0 = pad * PX, y0 = pad * PX, cw = w * PX, chh = h * PX;
  const halo = zero ? "rgba(110,255,170,1)" : "rgba(255,210,110,1)";
  // ореол: несколько обводок с размытием вокруг клетки
  g.shadowColor = halo;
  for (const blur of [46, 30, 16]) { g.shadowBlur = blur; g.fillStyle = halo; g.fillRect(x0, y0, cw, chh); }
  g.shadowBlur = 0;
  const grd = g.createLinearGradient(0, y0, 0, y0 + chh);
  grd.addColorStop(0, zero ? "#d6ffe6" : "#fff4cf");
  grd.addColorStop(1, zero ? "#5fe39a" : "#f0c863");
  g.fillStyle = grd;
  g.fillRect(x0, y0, cw, chh);
  const ink = NUM_INK[numColor(n)];
  g.strokeStyle = ink;
  g.lineWidth = Math.max(6, PX * 0.004);
  g.strokeRect(x0 + 3, y0 + 3, cw - 6, chh - 6);
  g.font = `900 ${Math.round(LAY.ch * PX * 0.62)}px Georgia, "Times New Roman", serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = ink;
  g.fillText(String(n), x0 + cw / 2, y0 + chh / 2 + 2);
  return { c, w: w + 2 * pad, h: h + 2 * pad };
}

// Сукно: зерно ворса без рисунка
function feltCanvas(n) {
  const c = canvas(n, n);
  const g = c.getContext("2d");
  const img = g.createImageData(n, n);
  let s = 12345;
  for (let i = 0; i < n * n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const v = 118 + ((s >>> 24) - 128) * 0.22;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

const LABELS = {
  ru: { dz: ["1-я 12", "2-я 12", "3-я 12"], low: "1–18", high: "19–36", even: "ЧЁТ", odd: "НЕЧЕТ" },
  en: { dz: ["1st 12", "2nd 12", "3rd 12"], low: "1–18", high: "19–36", even: "EVEN", odd: "ODD" },
  el: { dz: ["1η 12", "2η 12", "3η 12"], low: "1–18", high: "19–36", even: "ΖΥΓΑ", odd: "ΜΟΝΑ" },
};

/*
 * Разметка стола: прозрачная канва поверх сукна. Номера — золотом по тонированным
 * красным/чёрным клеткам: на ТВ через Zoom так читается лучше, чем красная цифра на зелёном.
 */
function layoutCanvas(lang) {
  const PX = 2000 / LAY.w;
  const W = Math.round(LAY.w * PX), H = Math.round(LAY.h * PX);
  const c = canvas(W, H);
  const g = c.getContext("2d");
  const L = LABELS[lang] || LABELS.ru;
  const X = (x) => (x - LAY.x0) * PX;
  const Z = (z) => (z - LAY.z0) * PX;
  const line = Math.max(3, Math.round(PX * 0.0022));
  g.lineJoin = "round";
  const serif = (sz, w = 700) => `${w} ${Math.round(sz)}px Georgia, "Times New Roman", serif`;
  // клетки номеров
  for (let n = 1; n <= 36; n++) {
    const [cx, cz] = cellCenter(n);
    const x = X(cx - LAY.cw / 2), y = Z(cz - LAY.ch / 2);
    g.fillStyle = RED.has(n) ? "rgba(150,24,18,0.72)" : "rgba(8,8,8,0.62)";
    g.fillRect(x, y, LAY.cw * PX, LAY.ch * PX);
    g.font = serif(LAY.ch * PX * 0.5);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "rgba(0,0,0,0.5)";
    g.fillText(String(n), X(cx) + 2, Z(cz) + 3);
    g.fillStyle = "#f1dfb0";
    g.fillText(String(n), X(cx), Z(cz));
  }
  g.strokeStyle = GOLD;
  g.lineWidth = line;
  // зеро — пятиугольник со скосом к колесу
  const zx0 = X(LAY.x0), zx1 = X(LAY.x0 + LAY.zeroW), zy0 = Z(LAY.z0), zy1 = Z(LAY.z0 + 3 * LAY.ch);
  const cut = (zx1 - zx0) * 0.45;
  g.beginPath();
  g.moveTo(zx1, zy0); g.lineTo(zx0 + cut, zy0); g.lineTo(zx0 + line, (zy0 + zy1) / 2); g.lineTo(zx0 + cut, zy1); g.lineTo(zx1, zy1);
  g.closePath();
  g.fillStyle = "rgba(10,90,52,0.55)";
  g.fill();
  g.stroke();
  g.font = serif(LAY.ch * PX * 0.62);
  g.fillStyle = "#f1dfb0";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("0", (zx0 + zx1) / 2 + cut * 0.2, (zy0 + zy1) / 2);
  // сетка номеров и колонок 2:1
  const gx0 = X(LAY.x0 + LAY.zeroW), gx1 = X(LAY.x0 + LAY.zeroW + 12 * LAY.cw), gx2 = X(LAY.x0 + LAY.w);
  for (let r = 0; r <= 12; r++) { const x = X(LAY.x0 + LAY.zeroW + r * LAY.cw); g.beginPath(); g.moveTo(x, zy0); g.lineTo(x, zy1); g.stroke(); }
  for (let k = 0; k <= 3; k++) { const y = Z(LAY.z0 + k * LAY.ch); g.beginPath(); g.moveTo(gx0, y); g.lineTo(gx2, y); g.stroke(); }
  g.beginPath(); g.moveTo(gx2, zy0); g.lineTo(gx2, zy1); g.stroke();
  g.font = serif(LAY.ch * PX * 0.36);
  g.fillStyle = GOLD;
  for (let c2 = 0; c2 < 3; c2++) g.fillText("2:1", (gx1 + gx2) / 2, Z(rowZ(c2)));
  // дюжины и равные шансы
  const dy0 = zy1, dy1 = Z(LAY.z0 + 3 * LAY.ch + LAY.rowH), ey1 = Z(LAY.z0 + 3 * LAY.ch + 2 * LAY.rowH);
  g.strokeRect(gx0, dy0, gx1 - gx0, dy1 - dy0);
  g.strokeRect(gx0, dy1, gx1 - gx0, ey1 - dy1);
  for (let d = 1; d < 3; d++) { const x = X(LAY.x0 + LAY.zeroW + 4 * d * LAY.cw); g.beginPath(); g.moveTo(x, dy0); g.lineTo(x, dy1); g.stroke(); }
  for (let k = 1; k < 6; k++) { const x = X(LAY.x0 + LAY.zeroW + 2 * k * LAY.cw); g.beginPath(); g.moveTo(x, dy1); g.lineTo(x, ey1); g.stroke(); }
  g.font = serif(LAY.rowH * PX * 0.42);
  g.fillStyle = "#f1dfb0";
  for (let d = 0; d < 3; d++) g.fillText(L.dz[d], X(LAY.x0 + LAY.zeroW + (4 * d + 2) * LAY.cw), (dy0 + dy1) / 2);
  const labels = [L.low, L.even, null, null, L.odd, L.high];
  for (let k = 0; k < 6; k++) {
    const cx = X(LAY.x0 + LAY.zeroW + (2 * k + 1) * LAY.cw), cy = (dy1 + ey1) / 2;
    if (labels[k]) { g.font = serif(LAY.rowH * PX * 0.4); g.fillStyle = "#f1dfb0"; g.fillText(labels[k], cx, cy); continue; }
    // красный и чёрный ромбы вместо слов
    const rw = LAY.cw * PX * 0.62, rh = LAY.rowH * PX * 0.33;
    g.beginPath(); g.moveTo(cx - rw, cy); g.lineTo(cx, cy - rh); g.lineTo(cx + rw, cy); g.lineTo(cx, cy + rh); g.closePath();
    g.fillStyle = k === 2 ? "#b3221a" : "#0c0c0c";
    g.fill();
    g.lineWidth = line * 0.8;
    g.stroke();
    g.lineWidth = line;
  }
  return { canvas: c, W, H };
}

// Мягкое круглое пятно: контактная тень шарика, свечение ячейки, искры
function blobCanvas(n, inner, outer) {
  const c = canvas(n, n);
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, n, n);
  return c;
}

/*
 * Фишка: канва в полярных координатах токарного профиля (x — угол, y — позиция по профилю).
 * Красный канал — маска вставок (белые «кирпичики» по кромке), зелёный — затемнение внутреннего круга.
 * Цвет игрока приходит как цвет инстанса и смешивается с маской в шейдере.
 */
function chipMaskCanvas(vTop, vSide) {
  const W = 512, H = 128;
  const c = canvas(W, H);
  const g = c.getContext("2d");
  g.fillStyle = "rgb(0,255,0)";
  g.fillRect(0, 0, W, H);
  const y = (v) => H - v * H; // v=0 внизу канвы (flipY)
  const spots = 6;
  // верх: внутренний круг темнее, тонкое кремовое кольцо
  g.fillStyle = "rgb(0,205,0)";
  g.fillRect(0, y(vTop * 0.62), W, y(0) - y(vTop * 0.62));
  g.fillStyle = "rgb(235,255,0)";
  g.fillRect(0, y(vTop * 0.66), W, y(vTop * 0.62) - y(vTop * 0.66));
  g.fillRect(0, y(1 - vTop * 0.66), W, y(1 - vTop * 0.62) - y(1 - vTop * 0.66));
  g.fillStyle = "rgb(0,205,0)";
  g.fillRect(0, y(1), W, y(1 - vTop * 0.62) - y(1));
  // вставки по кромке: на верхнем и нижнем кольце и на боку
  for (let k = 0; k < spots; k++) {
    const x0 = (k / spots) * W, x1 = x0 + W / spots / 2.2;
    g.fillStyle = "rgb(255,255,0)";
    g.fillRect(x0, y(vSide), x1 - x0, y(vTop * 0.82) - y(vSide));
    g.fillRect(x0, y(1 - vTop * 0.82), x1 - x0, y(1 - vSide) - y(1 - vTop * 0.82));
    g.fillRect(x0, y(1 - vSide), x1 - x0, y(vSide) - y(1 - vSide));
  }
  return c;
}

// ---------- геометрия ----------

/*
 * Тело вращения в «нашей» угловой системе: x = r·cos a, z = r·sin a, u = a/2π (или 1 − a/2π).
 * Нормали считаем по профилю, а не computeVertexNormals: так нет шва на стыке 0/2π.
 * Профиль идёт снаружи-сверху внутрь по видимой поверхности — нормаль смотрит «влево» от хода.
 */
function revolve(profile, segs, opts = {}) {
  const n = profile.length;
  const pos = [], nor = [], uv = [], idx = [];
  // длина профиля — для v
  const len = [0];
  for (let j = 1; j < n; j++) len.push(len[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  const total = len[n - 1] || 1;
  const pn = profile.map((p, j) => {
    const a = profile[Math.max(0, j - 1)], b = profile[Math.min(n - 1, j + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dr, dy) || 1;
    return [dy / l, -dr / l];
  });
  const a0 = opts.a0 || 0, a1 = opts.a1 != null ? opts.a1 : TAU;
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j < n; j++) {
      const [r, y] = profile[j];
      pos.push(r * ca, y, r * sa);
      nor.push(pn[j][0] * ca, pn[j][1], pn[j][0] * sa);
      const u = opts.flipU ? 1 - a / TAU : a / TAU;
      uv.push(u * (opts.uRepeat || 1), opts.vByIndex ? j / (n - 1) : len[j] / total);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < n - 1; j++) {
      const p = i * n + j, q = (i + 1) * n + j;
      idx.push(p, q, p + 1, q, q + 1, p + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  // порядок обхода сверяем с нормалью первого треугольника, чтобы лицевая сторона смотрела наружу
  const P = (k) => new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  for (let t = 0; t < idx.length; t += 3) {
    const A = P(idx[t]), B = P(idx[t + 1]), C = P(idx[t + 2]);
    const fn = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A));
    if (fn.lengthSq() < 1e-14) continue;
    const vn = new THREE.Vector3(nor[idx[t] * 3], nor[idx[t] * 3 + 1], nor[idx[t] * 3 + 2]);
    if (fn.dot(vn) < 0) for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    break;
  }
  geo.setIndex(idx);
  return geo;
}

// Скруглённый профиль: дуга из точек между двумя направлениями
function arc(cx, cy, rad, a0, a1, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return out;
}

// ---------- окружение для отражений ----------

/*
 * Маленькая «комната» для PMREM вместо HDRI-файла: тёмные стены, тёплый абажур над столом,
 * пара тусклых бра и полоска барной стойки. Латунь и лак берут блики отсюда.
 */
function buildEnvironment(renderer) {
  const env = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 12), new THREE.MeshBasicMaterial({ color: 0x120c08, side: THREE.BackSide }));
  box.position.y = 2;
  env.add(box);
  const glow = (w, h, color, x, y, z, ry = 0, rx = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    env.add(m);
  };
  const warm = new THREE.Color(1.0, 0.72, 0.42);
  // абажур над столом — небольшой, иначе он отражается во всём лаке сплошной белой заливкой
  glow(0.55, 0.55, warm.clone().multiplyScalar(14), 0, 2.4, 0, 0, Math.PI / 2);
  glow(0.12, 0.12, warm.clone().multiplyScalar(30), 0.9, 2.2, -0.6, 0, Math.PI / 2);
  glow(0.12, 0.12, warm.clone().multiplyScalar(30), -1.1, 2.2, 0.7, 0, Math.PI / 2);
  glow(0.5, 1.2, warm.clone().multiplyScalar(1.6), -5.9, 1.8, -2, Math.PI / 2);
  glow(0.5, 1.2, warm.clone().multiplyScalar(1.6), 5.9, 1.8, 2.5, -Math.PI / 2);
  glow(4.5, 0.25, new THREE.Color(0.9, 0.55, 0.3).multiplyScalar(1.2), 0, 1.2, -5.9);
  glow(3, 0.4, new THREE.Color(0.25, 0.2, 0.16), 1.5, 0.9, 5.9, Math.PI);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(env, 0.035);
  pm.dispose();
  env.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return rt.texture;
}

// ---------- колесо ----------

function buildWheel(Q) {
  const g = GEOM;
  const segs = Q.segs;
  const wheel = new THREE.Group();
  const rotor = new THREE.Group();
  wheel.add(rotor);

  const woodC = woodCanvas(1024, 256, 7, "#4a2614", "#1e0d05", "#7a4424");
  const woodDarkC = woodCanvas(1024, 256, 11, "#2c150a", "#120703", "#4b2615");
  const walnut = new THREE.MeshPhysicalMaterial({ map: tex(woodC, { repeat: 3 }), roughness: 0.4, clearcoat: 0.75, clearcoatRoughness: 0.14 });
  const walnutDark = new THREE.MeshPhysicalMaterial({ map: tex(woodDarkC, { repeat: 4 }), roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
  // общий свет окружения приглушён (тёмный зал), а металл и лак берут отражения в полную силу
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a25c, metalness: 1, roughness: 0.24, envMapIntensity: 3.2 });
  const brassBright = new THREE.MeshStandardMaterial({ color: 0xe0bf7a, metalness: 1, roughness: 0.16, envMapIntensity: 3.4 });
  walnut.envMapIntensity = 1.8;
  walnutDark.envMapIntensity = 2;

  // чаша: юбка → скруглённый верх → стенка трека → дорожка шарика
  const bowlProfile = [
    [g.bowlR + 0.03, -0.079],
    [g.bowlR + 0.03, -0.07],
    [g.bowlR + 0.012, -0.055],
    [g.bowlR + 0.012, 0.016],
    ...arc(g.bowlR - 0.006, 0.016, 0.018, 0, Math.PI / 2, 6),
    [0.415, g.bowlTopY + 0.004],
    ...arc(0.407, g.bowlTopY - 0.004, 0.008, Math.PI / 2, Math.PI, 5),
    [g.trackWallR, 0.006],
    ...arc(0.387, 0.006, 0.008, 0, -Math.PI / 2, 5),
    [0.386, statorY(0.386)],
  ];
  const bowl = new THREE.Mesh(revolve(bowlProfile, segs, { uRepeat: 1 }), walnut);
  bowl.castShadow = bowl.receiveShadow = true;
  wheel.add(bowl);

  // склон (статор) — тёмный лак; внизу уходит в щель под ротором
  const slope = new THREE.Mesh(revolve([
    [0.386, statorY(0.386)],
    [g.statorInnerR + 0.004, statorY(g.statorInnerR + 0.004)],
    [g.statorInnerR, g.statorInnerY - 0.002],
    [g.statorInnerR - 0.001, g.statorInnerY - 0.03],
  ], segs), walnutDark);
  slope.receiveShadow = true;
  wheel.add(slope);
  // тонкое латунное кольцо по краю склона — ловит свет и отделяет статор от ротора
  const lip = new THREE.Mesh(new THREE.TorusGeometry(g.statorInnerR + 0.002, 0.0016, 8, segs), brass);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = g.statorInnerY + 0.0005;
  wheel.add(lip);

  // ромбы-дефлекторы на склоне
  const slopeAng = Math.atan2(g.statorOuterY - g.statorInnerY, g.statorOuterR - g.statorInnerR);
  const diaGeo = new THREE.OctahedronGeometry(1, 0);
  // ромбы полированные: должны ловить лампу и читаться даже на общем плане
  const diaMat = new THREE.MeshStandardMaterial({ color: 0xf0d08a, metalness: 1, roughness: 0.26, envMapIntensity: 6, emissive: 0x3a2810, emissiveIntensity: 1 });
  for (const dm of g.diamonds) {
    const m = new THREE.Mesh(diaGeo, diaMat);
    const holder = new THREE.Group();
    holder.position.set(g.diamondR * Math.cos(dm.a), statorY(g.diamondR), g.diamondR * Math.sin(dm.a));
    holder.rotation.y = -dm.a; // локальная +x смотрит по радиусу наружу
    const tilt = new THREE.Group();
    tilt.rotation.z = slopeAng; // лежит на склоне
    m.scale.set(dm.halfR, g.diamondH * 1.15, dm.halfT);
    m.position.y = 0.001;
    m.castShadow = true;
    tilt.add(m);
    holder.add(tilt);
    wheel.add(holder);
  }

  // --- ротор ---
  const [ringC, ringM] = numberRingCanvases(4096, 256);
  const ringMat = new THREE.MeshPhysicalMaterial({
    map: tex(ringC, { aniso: 16 }),
    metalnessMap: tex(ringM, { linear: true, aniso: 16 }),
    metalness: 1,
    roughness: 0.3,
    clearcoat: 0.9,
    clearcoatRoughness: 0.08,
  });
  // металличность только там, где маска белая: фон остаётся лаком
  ringMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <metalnessmap_fragment>", `
      float metalnessFactor = metalness;
      #ifdef USE_METALNESSMAP
        vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
        metalnessFactor *= texelMetalness.r;
      #endif
    `);
  };
  const edge = new THREE.Mesh(revolve([
    [g.rotorR - 0.0005, g.ringOuterY - 0.012],
    [g.rotorR, g.ringOuterY - 0.002],
    [g.rotorR - 0.0015, g.ringOuterY],
  ], segs), brass);
  rotor.add(edge);
  const ring = new THREE.Mesh(revolve([
    [g.rotorR - 0.0015, g.ringOuterY],
    [g.ringInnerR, g.ringInnerY],
  ], Q.ringSegs, { flipU: true, vByIndex: true }), ringMat);
  ring.receiveShadow = true;
  rotor.add(ring);

  // ячейки: внешняя стенка, дно в цвет номера, внутренняя стенка
  const walls = new THREE.Mesh(revolve([
    [g.ringInnerR, g.ringInnerY],
    [g.pocketOuterR - 0.0005, g.floorY + 0.003],
    [g.pocketOuterR - 0.003, g.floorY],
  ], segs), walnutDark);
  walls.receiveShadow = true;
  rotor.add(walls);
  const floorMat = new THREE.MeshStandardMaterial({ map: tex(pocketFloorCanvas(2048, 64)), roughness: 0.72, metalness: 0, envMapIntensity: 0.6 });
  const floor = new THREE.Mesh(revolve([
    [g.pocketOuterR - 0.003, g.floorY],
    [g.pocketInnerR + 0.003, g.floorY],
  ], Q.ringSegs, { flipU: true, vByIndex: true }), floorMat);
  floor.receiveShadow = true;
  rotor.add(floor);
  const inner = new THREE.Mesh(revolve([
    [g.pocketInnerR + 0.003, g.floorY],
    [g.pocketInnerR + 0.0005, g.floorY + 0.003],
    [g.pocketInnerR, -0.047],
    [g.pocketInnerR - 0.004, -0.045],
  ], segs), walnutDark);
  inner.receiveShadow = true;
  rotor.add(inner);
  // конус ротора с латунными поясками
  const cone = new THREE.Mesh(revolve([
    [g.pocketInnerR - 0.004, -0.045],
    [0.125, -0.033],
    [g.coneTopR + 0.004, g.coneTopY - 0.001],
  ], segs), walnut);
  cone.receiveShadow = cone.castShadow = true;
  rotor.add(cone);
  for (const [r, y, t] of [[0.158, -0.0428, 0.0016], [0.118, -0.031, 0.0012]]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(r, t, 6, segs), brass);
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    rotor.add(band);
  }

  // фретки: полированная латунь, 37 штук одним инстансом
  const fretLen = g.pocketOuterR - g.pocketInnerR - 0.002;
  const fretH = g.fretTopY - g.floorY;
  const fretGeo = new THREE.BoxGeometry(fretLen, fretH, g.fretW);
  const frets = new THREE.InstancedMesh(fretGeo, brassBright, POCKETS);
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < POCKETS; i++) {
    const a = (i + 0.5) * PA;
    const rm = (g.pocketOuterR + g.pocketInnerR) / 2;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
    mtx.compose(new THREE.Vector3(rm * Math.cos(a), g.floorY + fretH / 2, rm * Math.sin(a)), q, one);
    frets.setMatrixAt(i, mtx);
  }
  frets.castShadow = true;
  rotor.add(frets);
  // кромки фреток сверху — тонкие цилиндры, чтобы блик бежал по краю
  const capGeo = new THREE.CylinderGeometry(g.fretW * 0.62, g.fretW * 0.62, fretLen, 6);
  capGeo.rotateZ(Math.PI / 2);
  const caps = new THREE.InstancedMesh(capGeo, brassBright, POCKETS);
  for (let i = 0; i < POCKETS; i++) {
    const a = (i + 0.5) * PA;
    const rm = (g.pocketOuterR + g.pocketInnerR) / 2;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
    mtx.compose(new THREE.Vector3(rm * Math.cos(a), g.fretTopY, rm * Math.sin(a)), q, one);
    caps.setMatrixAt(i, mtx);
  }
  rotor.add(caps);

  // турель: латунный купол, шпиндель и крестовина с шарами
  const turret = new THREE.Group();
  const dome = new THREE.Mesh(revolve([
    [g.coneTopR + 0.004, g.coneTopY - 0.001],
    ...arc(g.coneTopR - 0.004, g.coneTopY, 0.008, 0, Math.PI / 2, 4),
    [0.045, g.coneTopY + 0.012],
    [0.022, g.coneTopY + 0.022],
    [0.012, g.coneTopY + 0.03],
    [0.0001, g.coneTopY + 0.031],
  ], segs), brass);
  dome.castShadow = true;
  turret.add(dome);
  const spindle = new THREE.Mesh(revolve([
    [0.0115, g.coneTopY + 0.028],
    [0.009, 0.03],
    [0.0075, 0.055],
    [0.0105, 0.06],
    [0.0105, 0.066],
    [0.0065, 0.072],
    [0.0065, 0.086],
    ...arc(0.0001, 0.0975, 0.013, -Math.PI / 3, Math.PI / 2, 9),
  ], segs >> 1), brassBright);
  spindle.castShadow = true;
  turret.add(spindle);
  const armGeo = new THREE.CylinderGeometry(0.0042, 0.0058, 0.082, 12);
  armGeo.rotateZ(Math.PI / 2);
  armGeo.translate(0.041 + 0.006, 0, 0);
  const knobGeo = new THREE.SphereGeometry(0.0105, 20, 14);
  for (let k = 0; k < 4; k++) {
    const arm = new THREE.Group();
    arm.rotation.y = (k * Math.PI) / 2 + Math.PI / 4;
    const bar = new THREE.Mesh(armGeo, brassBright);
    bar.position.y = 0.063;
    bar.castShadow = true;
    const knob = new THREE.Mesh(knobGeo, brassBright);
    knob.position.set(0.094, 0.066, 0);
    knob.castShadow = true;
    arm.add(bar, knob);
    turret.add(arm);
  }
  rotor.add(turret);

  // шарик: слоновая кость с лаковым бликом
  const ballMat = new THREE.MeshPhysicalMaterial({ color: 0xf6f0e2, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.04, sheen: 0.3, sheenColor: new THREE.Color(0xffffff) });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(g.ballR, 32, 24), ballMat);
  ball.castShadow = true;
  wheel.add(ball);
  // шлейф на большой скорости: без него шарик на треке «стробит» по 7 см за кадр
  const ghosts = [];
  for (let k = 0; k < 6; k++) {
    const gm = new THREE.Mesh(ball.geometry, new THREE.MeshBasicMaterial({ color: 0xfff4e0, transparent: true, opacity: 0, depthWrite: false }));
    gm.visible = false;
    wheel.add(gm);
    ghosts.push(gm);
  }
  const blobTex = tex(blobCanvas(64, "rgba(0,0,0,0.85)", "rgba(0,0,0,0)"));
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(g.ballR * 3.2, g.ballR * 3.2), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.6 }));
  contact.rotation.x = -Math.PI / 2;
  contact.renderOrder = 2;
  wheel.add(contact);

  // свечение ячейки: пятно на дне + точечный свет, живут в системе ротора
  const glowTex = tex(blobCanvas(128, "rgba(255,255,255,1)", "rgba(255,255,255,0)"));
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, color: 0xffffff });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.renderOrder = 3;
  rotor.add(glow);
  // короткий радиус: иначе свет ячейки просвечивает сквозь колесо на склон и бортик
  const glowLight = new THREE.PointLight(0xffffff, 0, 0.09, 2);
  rotor.add(glowLight);

  /*
   * Подсветка выпавшего номера на кольце: сегмент поверх номерного кольца с яркой цифрой и золотой рамкой.
   * Неосвещаемый материал без тонмаппинга — цифра горит, а не просто отражает лампу, и читается с ТВ.
   * Геометрия построена для сектора у угла 0, на нужную ячейку ставим поворотом.
   */
  const segGeo = revolve([
    [g.rotorR - 0.0012, g.ringOuterY + 0.0009],
    [g.ringInnerR + 0.0004, g.ringInnerY + 0.0009],
  ], 12, { a0: -PA / 2, a1: PA / 2, vByIndex: true });
  const uv = segGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (PA / 2 - uv.getX(i) * TAU) / PA); // u поперёк сектора, как на кольце
  const numC = canvas(256, 224);
  const numTex = tex(numC, { aniso: 8 });
  const numMat = new THREE.MeshBasicMaterial({ map: numTex, transparent: true, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  const numHL = new THREE.Mesh(segGeo, numMat);
  numHL.renderOrder = 4;
  numHL.visible = false;
  rotor.add(numHL);

  return { wheel, rotor, ball, ghosts, contact, glow, glowLight, numHL, numC, numTex, materials: { walnut, walnutDark, brass, brassBright, ballMat } };
}

// ---------- стол ----------

// колесо стоит на своей тумбе над сукном: иначе ячейки ротора ушли бы ниже стола
const WHEEL_POS = new THREE.Vector3(LAY.x0 - 0.07 - GEOM.bowlR - 0.012, 0.078, LAY.z0 + LAY.h / 2);
const FELT_RECT = { x0: -1.58, x1: 0.88, z0: -0.62, z1: 0.46 };
const TRAY = { x: -0.14, z: -0.43, w: 0.5, d: 0.11 };
// фишки чуть крупнее настоящих (39 мм): с 3 м на ТВ и в Zoom иначе это точки в 20 px
const CHIP = { R: 0.0235, h: 0.0042, b: 0.001 };

function roundedRectShape(x0, z0, x1, z1, r) {
  const s = new THREE.Shape();
  s.moveTo(x0 + r, z0);
  s.lineTo(x1 - r, z0);
  s.quadraticCurveTo(x1, z0, x1, z0 + r);
  s.lineTo(x1, z1 - r);
  s.quadraticCurveTo(x1, z1, x1 - r, z1);
  s.lineTo(x0 + r, z1);
  s.quadraticCurveTo(x0, z1, x0, z1 - r);
  s.lineTo(x0, z0 + r);
  s.quadraticCurveTo(x0, z0, x0 + r, z0);
  return s;
}

function buildTable(Q, lang, mats) {
  const table = new THREE.Group();
  const F = FELT_RECT;
  const feltTex = tex(feltCanvas(256), { aniso: 4 });
  feltTex.wrapS = feltTex.wrapT = THREE.RepeatWrapping;
  feltTex.repeat.set(14, 6);
  const feltMat = new THREE.MeshPhysicalMaterial({ color: FELT, map: feltTex, roughness: 0.95, sheen: 0.8, sheenRoughness: 0.7, sheenColor: new THREE.Color(0x5fa27a) });
  const felt = new THREE.Mesh(new THREE.PlaneGeometry(F.x1 - F.x0, F.z1 - F.z0), feltMat);
  felt.rotation.x = -Math.PI / 2;
  felt.position.set((F.x0 + F.x1) / 2, 0, (F.z0 + F.z1) / 2);
  felt.receiveShadow = true;
  table.add(felt);

  const lay = layoutCanvas(lang);
  const layTex = tex(lay.canvas, { aniso: 16 });
  const layMat = new THREE.MeshStandardMaterial({ map: layTex, transparent: true, roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const layout = new THREE.Mesh(new THREE.PlaneGeometry(LAY.w, LAY.h), layMat);
  layout.rotation.x = -Math.PI / 2;
  layout.position.set(LAY.x0 + LAY.w / 2, 0.0004, LAY.z0 + LAY.h / 2);
  layout.receiveShadow = true;
  table.add(layout);

  // мягкий кожаный бортик по периметру сукна и ореховый фартук под ним
  const pad = 0.1;
  const outer = roundedRectShape(F.x0 - pad, F.z0 - pad, F.x1 + pad, F.z1 + pad, 0.12);
  outer.holes.push(roundedRectShape(F.x0, F.z0, F.x1, F.z1, 0.05));
  const railGeo = new THREE.ExtrudeGeometry(outer, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.022, bevelSize: 0.028, bevelSegments: Q.low ? 3 : 6, curveSegments: 10 });
  railGeo.rotateX(Math.PI / 2);
  const leather = new THREE.MeshPhysicalMaterial({ color: 0x1c0d07, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.45 });
  const rail = new THREE.Mesh(railGeo, leather);
  rail.position.y = 0.042;
  rail.castShadow = rail.receiveShadow = true;
  table.add(rail);
  const apron = new THREE.Mesh(new THREE.BoxGeometry(F.x1 - F.x0 + 2 * pad + 0.04, 0.7, F.z1 - F.z0 + 2 * pad + 0.04), mats.walnut);
  apron.position.set((F.x0 + F.x1) / 2, -0.36, (F.z0 + F.z1) / 2);
  table.add(apron);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.72;
  floor.receiveShadow = true;
  table.add(floor);

  // лоток казино у крупье: ореховый ящик с латунной кромкой
  const tray = new THREE.Group();
  const trayBox = new THREE.Mesh(new THREE.BoxGeometry(TRAY.w, 0.018, TRAY.d), mats.walnutDark);
  trayBox.position.y = 0.009;
  trayBox.receiveShadow = true;
  tray.add(trayBox);
  const rimGeo = new THREE.BoxGeometry(TRAY.w + 0.012, 0.006, 0.006);
  for (const dz of [-TRAY.d / 2, TRAY.d / 2]) { const r = new THREE.Mesh(rimGeo, mats.brass); r.position.set(0, 0.02, dz); tray.add(r); }
  const rimGeo2 = new THREE.BoxGeometry(0.006, 0.006, TRAY.d);
  for (const dx of [-TRAY.w / 2, TRAY.w / 2]) { const r = new THREE.Mesh(rimGeo2, mats.brass); r.position.set(dx, 0.02, 0); tray.add(r); }
  tray.position.set(TRAY.x, 0.001, TRAY.z);
  table.add(tray);
  return { table, layout, felt, feltMat };
}

// Токарный профиль фишки с фаской; v по длине профиля — снизу вверх
function chipGeometry(segs) {
  const { R, h, b } = CHIP;
  const prof = [[0.0001, -h / 2], [R - b, -h / 2], [R, -h / 2 + b], [R, h / 2 - b], [R - b, h / 2], [0.0001, h / 2]];
  const geo = revolve(prof, segs);
  const flat = R - b, bev = Math.SQRT2 * b, side = h - 2 * b;
  const total = 2 * flat + 2 * bev + side;
  return { geo, vTop: flat / total, vSide: (flat + bev) / total };
}

function chipMaterial(vTop, vSide) {
  const mask = tex(chipMaskCanvas(vTop, vSide), { linear: true, aniso: 4 });
  const mat = new THREE.MeshStandardMaterial({ map: mask, roughness: 0.42, metalness: 0 });
  // map — это маска, а не цвет: цвет даёт инстанс, маска добавляет кремовые вставки
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <map_fragment>", "")
      .replace("#include <color_fragment>", `
        #include <color_fragment>
        #ifdef USE_MAP
          vec4 chipM = texture2D( map, vMapUv );
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.82, 0.74 ), chipM.r ) * mix( 0.62, 1.0, chipM.g );
        #endif
      `);
  };
  return mat;
}

/*
 * Все фишки — один InstancedMesh. У фишки есть «покой» (x, y, z) и, возможно, анимация:
 * функция от прогресса k, которая возвращает позицию и масштаб. Каждый кадр пишем матрицы заново —
 * при ~1000 фишках это дешевле, чем следить за изменениями.
 */
class ChipPool {
  constructor(parent, geo, mat, cap) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    parent.add(this.mesh);
    this.cap = cap;
    this.list = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this.dirty = true;
  }
  add(c) {
    if (this.list.length >= this.cap) return null;
    c.rot = c.rot != null ? c.rot : Math.random() * TAU;
    c.s = c.s != null ? c.s : 1;
    this.list.push(c);
    this.dirty = true;
    return c;
  }
  animate(c, dur, fn, now, delay = 0, done) {
    c.anim = { t0: now + delay, dur, fn, done };
    this.dirty = true;
  }
  update(now) {
    const L = this.list;
    let any = this.dirty;
    for (const c of L) if (c.anim) { any = true; break; }
    if (!any) return;
    this.dirty = false;
    let w = 0;
    for (let i = 0; i < L.length; i++) {
      const c = L[i];
      let x = c.x, y = c.y, z = c.z, s = c.s, tilt = 0;
      if (c.anim) {
        const k = (now - c.anim.t0) / c.anim.dur;
        if (k >= 1) {
          const r = c.anim.fn(1);
          const done = c.anim.done;
          c.anim = null;
          if (r) { x = c.x = r[0]; y = c.y = r[1]; z = c.z = r[2]; if (r[3] != null) s = c.s = r[3]; }
          if (done) done(c);
        } else if (k > 0) {
          const r = c.anim.fn(k);
          if (r) { x = r[0]; y = r[1]; z = r[2]; if (r[3] != null) s = r[3]; tilt = r[4] || 0; }
        } else if (c.hideBefore) s = 0;
      }
      if (c.dead) continue;
      L[w++] = c;
      this._q.setFromAxisAngle(this._up, c.rot);
      if (tilt) this._q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt));
      this._m.compose(this._p.set(x, y, z), this._q, this._s.set(s, s, s));
      this.mesh.setMatrixAt(w - 1, this._m);
      this.mesh.setColorAt(w - 1, c.color);
    }
    L.length = w;
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------- руки крупье и лопатка ----------

function buildHand(skin, cuffMat, sleeveMat, mirror) {
  const hand = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), skin);
  palm.scale.set(0.034, 0.011, 0.044);
  palm.castShadow = true;
  hand.add(palm);
  const fingers = [[-0.024, 0.036], [-0.008, 0.042], [0.008, 0.04], [0.023, 0.031]];
  for (const [x, len] of fingers) {
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.0062, len, 4, 10), skin);
    f.rotation.x = Math.PI / 2 - 0.22; // пальцы чуть согнуты вниз — рука живая, а не перчатка на палке
    f.position.set(x * (mirror ? -1 : 1), -0.003, 0.04 + len / 2);
    f.castShadow = true;
    hand.add(f);
  }
  const th = new THREE.Mesh(new THREE.CapsuleGeometry(0.0085, 0.03, 4, 10), skin);
  th.rotation.set(Math.PI / 2, 0, (mirror ? -1 : 1) * 0.9);
  th.position.set((mirror ? 1 : -1) * 0.04, -0.004, 0.018);
  th.castShadow = true;
  hand.add(th);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.029, 0.03, 18), cuffMat);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.z = -0.058;
  hand.add(cuff);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.04, 0.5, 18), sleeveMat);
  sleeve.rotation.x = Math.PI / 2;
  sleeve.position.z = -0.32;
  sleeve.castShadow = true;
  hand.add(sleeve);
  return hand;
}

// Ключевые кадры: [{t, p:[x,y,z], r:[rx,ry,rz]}] — плавно между ними
function keyAt(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const k = easeInOut((t - a.t) / (b.t - a.t));
      return { p: a.p.map((v, j) => lerp(v, b.p[j], k)), r: a.r.map((v, j) => lerp(v, b.r[j], k)) };
    }
  }
  return keys[keys.length - 1];
}

class Dealer {
  constructor(parent) {
    const skin = new THREE.MeshPhysicalMaterial({ color: 0xc58f6d, roughness: 0.55, sheen: 0.5, sheenColor: new THREE.Color(0xffc9a8), sheenRoughness: 0.5 });
    const cuffMat = new THREE.MeshStandardMaterial({ color: 0xeeeae2, roughness: 0.7 });
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x0d0b0c, roughness: 0.6 });
    this.left = buildHand(skin, cuffMat, sleeveMat, true);
    this.right = buildHand(skin, cuffMat, sleeveMat, false);
    // отдельная рука для броска: «ставок больше нет» и бросок идут почти одновременно
    this.thrower = buildHand(skin, cuffMat, sleeveMat, false);
    // лопатка: длинная тёмная ручка, широкая плоская голова с латунной кромкой
    this.rake = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0065, 0.9, 10), new THREE.MeshPhysicalMaterial({ color: 0x1a0e08, roughness: 0.35, clearcoat: 1 }));
    // ручка уходит вверх к руке крупье, иначе прошла бы сквозь столбики фишек
    stick.rotation.x = -1.234;
    stick.position.set(0, 0.154, -0.425);
    stick.castShadow = true;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.016), new THREE.MeshPhysicalMaterial({ color: 0x241410, roughness: 0.3, clearcoat: 1 }));
    head.position.y = 0.004;
    head.castShadow = true;
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.202, 0.004, 0.004), new THREE.MeshStandardMaterial({ color: 0xc9a25c, metalness: 1, roughness: 0.25 }));
    edge.position.set(0, 0.004, 0.009);
    this.rake.add(stick, head, edge);
    this.rakeEdge = edge;
    this.rakeHand = buildHand(skin, cuffMat, sleeveMat, false);
    this.rakeHand.position.set(0, 0.3, -0.86);
    this.rakeHand.rotation.x = 0.35;
    this.rake.add(this.rakeHand);
    this.rakeHead = head;
    for (const o of [this.left, this.right, this.thrower, this.rake]) { o.visible = false; parent.add(o); }
    this.tracks = [];
    /*
     * Руки и лопатка входят с дальней стороны стола — то есть сверху кадра, под табло доски.
     * Плоскость отсечения проходит через камеру и верхнюю кромку свободной зоны экрана:
     * всё, что выше неё, не рисуется, и рука «выходит» из-под табло, а не лезет на логотип.
     */
    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 100);
    for (const o of [this.left, this.right, this.thrower, this.rake]) {
      o.traverse((m) => { if (m.material && !m.material.clippingPlanes) m.material.clippingPlanes = [this.clip]; });
    }
  }
  // yTop — верхняя граница свободной зоны в NDC (1 − 2·safe.top)
  updateClip(camera, yTop) {
    const O = camera.position;
    const A = new THREE.Vector3(-1, yTop, 0.5).unproject(camera);
    const B = new THREE.Vector3(1, yTop, 0.5).unproject(camera);
    const n = new THREE.Vector3().subVectors(A, O).cross(new THREE.Vector3().subVectors(B, O)).normalize();
    this.clip.setFromNormalAndCoplanarPoint(n, O);
    // видимая сторона — ниже кромки
    const below = new THREE.Vector3(0, yTop - 0.5, 0.5).unproject(camera);
    if (this.clip.distanceToPoint(below) < 0) this.clip.negate();
  }
  play(obj, keys, t0) {
    this.tracks = this.tracks.filter((tr) => tr.obj !== obj);
    this.tracks.push({ obj, keys, t0 });
  }
  update(now) {
    for (const tr of this.tracks) {
      const t = now - tr.t0;
      const end = tr.keys[tr.keys.length - 1].t;
      if (t < 0 || t > end) { tr.obj.visible = false; continue; }
      const k = keyAt(tr.keys, t);
      tr.obj.visible = true;
      tr.obj.position.set(k.p[0], k.p[1], k.p[2]);
      tr.obj.rotation.set(k.r[0], k.r[1], k.r[2]);
    }
    this.tracks = this.tracks.filter((tr) => now - tr.t0 <= tr.keys[tr.keys.length - 1].t + 50);
  }
  // «Ставок больше нет»: ладони вниз проходят над раскладкой от центра к краям
  sweep(now) {
    const y = 0.14, zA = -0.75, zB = LAY.z0 + LAY.h * 0.45;
    const cx = LAY.x0 + LAY.w / 2;
    this.play(this.left, [
      { t: 0, p: [cx - 0.1, y + 0.1, zA], r: [0.1, 0, 0] },
      { t: 420, p: [cx - 0.05, y, zB], r: [0.05, 0.1, 0] },
      { t: 1050, p: [cx - 0.55, y, zB + 0.02], r: [0.05, 0.35, 0] },
      { t: 1500, p: [cx - 0.5, y + 0.12, zA], r: [0.2, 0.2, 0] },
    ], now);
    this.play(this.right, [
      { t: 0, p: [cx + 0.1, y + 0.1, zA], r: [0.1, 0, 0] },
      { t: 420, p: [cx + 0.05, y, zB], r: [0.05, -0.1, 0] },
      { t: 1050, p: [cx + 0.55, y, zB + 0.02], r: [0.05, -0.35, 0] },
      { t: 1500, p: [cx + 0.5, y + 0.12, zA], r: [0.2, -0.2, 0] },
    ], now);
  }
  // Бросок: рука подходит к борту колеса с дальней стороны, щелчок вдоль трека, уходит
  launch(now, launchWorld, dir) {
    const [x, y, z] = launchWorld;
    const back = [x, y + 0.16, z - 0.5];
    this.play(this.thrower, [
      { t: 0, p: back, r: [0.3, 0, 0] },
      { t: 700, p: [x - 0.012, y + 0.018, z - 0.078], r: [0.25, 0.3, 0] },
      { t: 1250, p: [x - 0.012, y + 0.018, z - 0.078], r: [0.25, 0.3, 0] },
      { t: 1450, p: [x + dir * 0.09, y + 0.03, z - 0.07], r: [0.2, -0.5 * dir, 0] },
      { t: 2100, p: back, r: [0.3, 0, 0] },
    ], now);
  }
}

// ---------- камера ----------

/*
 * Критически демпфированная пружина: догоняет цель без перелёта и без рывков,
 * даже если цель прыгает (смена плана). Точное решение для постоянной цели на шаге dt.
 */
class Spring {
  constructor(n, w) {
    this.x = new Float64Array(n);
    this.v = new Float64Array(n);
    this.w = w;
    this.init = false;
  }
  set(vals) { for (let i = 0; i < vals.length; i++) { this.x[i] = vals[i]; this.v[i] = 0; } this.init = true; }
  step(target, dt, w = this.w) {
    if (!this.init) { this.set(target); return this.x; }
    const e = Math.exp(-w * dt);
    for (let i = 0; i < target.length; i++) {
      const d = this.x[i] - target[i];
      const tmp = (this.v[i] + w * d) * dt;
      this.x[i] = target[i] + (d + tmp) * e;
      this.v[i] = (this.v[i] - w * tmp) * e;
    }
    return this.x;
  }
}

// ---------- глубина резкости (дёшево): размытая копия кадра смешивается по экрану вокруг фокуса ----------

class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = false;
    this.amount = 0;
    this.focus = new THREE.Vector2(0.5, 0.5);
    const mk = (samples) => new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples, depthBuffer: samples > 0 });
    this.rtScene = mk(4);
    this.rtA = mk(0);
    this.rtB = mk(0);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    const vs = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tex: { value: null }, dir: { value: new THREE.Vector2() } },
      vertexShader: vs,
      fragmentShader: `
        uniform sampler2D tex; uniform vec2 dir; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tex, vUv).rgb * 0.19648;
          c += (texture2D(tex, vUv + dir * 1.41176).rgb + texture2D(tex, vUv - dir * 1.41176).rgb) * 0.29691;
          c += (texture2D(tex, vUv + dir * 3.29412).rgb + texture2D(tex, vUv - dir * 3.29412).rgb) * 0.09447;
          c += (texture2D(tex, vUv + dir * 5.17647).rgb + texture2D(tex, vUv - dir * 5.17647).rgb) * 0.01038;
          gl_FragColor = vec4(c, 1.0);
        }`,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: { sharp: { value: null }, soft: { value: null }, focus: { value: this.focus }, amount: { value: 0 }, aspect: { value: 1 } },
      vertexShader: vs,
      fragmentShader: `
        uniform sampler2D sharp; uniform sampler2D soft; uniform vec2 focus; uniform float amount; uniform float aspect;
        varying vec2 vUv;
        void main(){
          vec3 a = texture2D(sharp, vUv).rgb;
          vec3 b = texture2D(soft, vUv).rgb;
          vec2 d = (vUv - focus) * vec2(aspect * 0.7, 1.0);
          float k = smoothstep(0.1, 0.48, length(d)) * amount;
          gl_FragColor = vec4(mix(a, b, k), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
  }
  setSize(w, h) {
    this.rtScene.setSize(w, h);
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    this.rtA.setSize(qw, qh);
    this.rtB.setSize(qw, qh);
    this.comp.uniforms.aspect.value = w / h;
    this.qw = qw;
    this.qh = qh;
  }
  render(scene, camera) {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);
    this.quad.material = this.blur;
    this.blur.uniforms.tex.value = this.rtScene.texture;
    this.blur.uniforms.dir.value.set(1 / this.qw, 0);
    r.setRenderTarget(this.rtA);
    r.render(this.scene, this.cam);
    this.blur.uniforms.tex.value = this.rtA.texture;
    this.blur.uniforms.dir.value.set(0, 1 / this.qh);
    r.setRenderTarget(this.rtB);
    r.render(this.scene, this.cam);
    // второй круг на той же четверти: гладкое «боке» вместо двоящихся полос
    this.blur.uniforms.tex.value = this.rtB.texture;
    this.blur.uniforms.dir.value.set(1 / this.qw, 0);
    r.setRenderTarget(this.rtA);
    r.render(this.scene, this.cam);
    this.blur.uniforms.tex.value = this.rtA.texture;
    this.blur.uniforms.dir.value.set(0, 1 / this.qh);
    r.setRenderTarget(this.rtB);
    r.render(this.scene, this.cam);
    this.quad.material = this.comp;
    this.comp.uniforms.sharp.value = this.rtScene.texture;
    this.comp.uniforms.soft.value = this.rtB.texture;
    this.comp.uniforms.amount.value = this.amount;
    r.setRenderTarget(null);
    r.render(this.scene, this.cam);
  }
  dispose() {
    this.rtScene.dispose(); this.rtA.dispose(); this.rtB.dispose();
    this.blur.dispose(); this.comp.dispose(); this.quad.geometry.dispose();
  }
}

// ---------- звук: всё синтезируется на лету, семплов нет ----------

/*
 * Шина: sfx и гул → реверб комнаты → мастер → динамики. sound-toggle.js перехватывает подключение
 * к destination и сам глушит мастер, поэтому здесь обычный WebAudio.
 * Контекст создаётся по первому жесту: без жеста браузер всё равно держит его на паузе.
 */
class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.ambOn = true;
    this.duck = 1;
    this._unlock = () => this.start();
    window.addEventListener("pointerdown", this._unlock, true);
    window.addEventListener("keydown", this._unlock, true);
    window.addEventListener("touchstart", this._unlock, true);
  }
  start() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC(); } catch (e) { return; }
    this.ctx = ctx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.impulse(1.7, 2.8);
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 0.5;
    this.verbIn.connect(this.verb);
    this.verb.connect(this.master);
    this.noise = this.noiseBuffer(2);
    this.brown = this.brownBuffer(4);
    this.startHum();
    this.startAmbience();
  }
  noiseBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  brownBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    return b;
  }
  impulse(sec, decay) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay) * (i < 200 ? i / 200 : 1);
    }
    return b;
  }
  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }
  get live() { return !!this.ctx && this.ctx.state === "running" && !this.muted; }
  // короткий шумовой всплеск через фильтр
  burst(at, dur, type, f0, f1, q, gain, verb = 0.2) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(flt); flt.connect(g); g.connect(this.sfx);
    if (verb) { const v = ctx.createGain(); v.gain.value = verb; g.connect(v); v.connect(this.verbIn); }
    src.start(at, Math.random());
    src.stop(at + dur + 0.05);
  }
  tone(at, freq, dur, gain, type = "sine", f1 = null, verb = 0.25) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(this.sfx);
    if (verb) { const v = ctx.createGain(); v.gain.value = verb; g.connect(v); v.connect(this.verbIn); }
    o.start(at);
    o.stop(at + dur + 0.02);
  }
  at(delayMs) { return this.ctx.currentTime + Math.max(0, delayMs) / 1000; }

  // сухой «вжих» броска
  whoosh(d = 0) { if (!this.live) return; const t = this.at(d); this.burst(t, 0.38, "bandpass", 700, 2600, 1.1, 0.35, 0.15); this.tone(t, 180, 0.08, 0.05, "sine", 90, 0); }
  // латунный ромб: негармонические обертоны + щелчок
  clack(s = 1, d = 0, pitch = 1) {
    if (!this.live) return;
    const t = this.at(d);
    this.burst(t, 0.03, "highpass", 2500, 2500, 0.7, 0.4 * s, 0.3);
    for (const [f, g, dur] of [[2380, 0.22, 0.16], [3710, 0.14, 0.11], [5230, 0.08, 0.07], [1270, 0.1, 0.09]]) this.tone(t, f * pitch, dur, g * s, "sine", null, 0.35);
  }
  // стук по фретке: тупое «тук» с коротким звоном металла
  tuk(s = 1, d = 0, pitch = 1) {
    if (!this.live) return;
    const t = this.at(d);
    this.tone(t, 1250 * pitch, 0.045, 0.28 * s, "triangle", 760 * pitch, 0.2);
    this.tone(t, 3100 * pitch, 0.03, 0.08 * s, "sine", null, 0.2);
    this.burst(t, 0.018, "bandpass", 3200, 3200, 1.5, 0.3 * s, 0.1);
  }
  settle(s = 1, d = 0) {
    if (!this.live) return;
    const t = this.at(d);
    this.tone(t, 1900, 0.05, 0.12 * s, "sine", 1500, 0.2);
    this.tone(t, 170, 0.12, 0.2 * s, "sine", 110, 0);
  }
  // шуршание лопатки по сукну
  swish(d = 0, dur = 0.5) { if (!this.live) return; const t = this.at(d); this.burst(t, dur, "bandpass", 1100, 2200, 0.6, 0.2, 0.2); this.burst(t, dur * 0.9, "lowpass", 600, 400, 0.5, 0.12, 0); }
  // звон фишек: пара высоких негармоник, в стопке — несколько подряд
  clink(n = 1, d = 0, gain = 0.2) {
    if (!this.live) return;
    for (let i = 0; i < n; i++) {
      const t = this.at(d + i * (28 + Math.random() * 40));
      const f = 3400 + Math.random() * 1900;
      this.tone(t, f, 0.07, gain, "sine", null, 0.25);
      this.tone(t, f * 1.47, 0.05, gain * 0.5, "sine", null, 0.25);
      this.burst(t, 0.012, "highpass", 5000, 5000, 0.7, gain * 0.6, 0.1);
    }
  }
  coins(d = 0) { if (!this.live) return; for (let i = 0; i < 16; i++) this.clink(1, d + i * 55 + Math.random() * 60, 0.14 + Math.random() * 0.1); }

  // гул шарика: коричневый шум через полосовой фильтр + «дробь» амплитуды с частотой вращения шарика
  startHum() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    this.humF = ctx.createBiquadFilter();
    this.humF.type = "bandpass";
    this.humF.Q.value = 0.9;
    this.humF.frequency.value = 300;
    this.humG = ctx.createGain();
    this.humG.gain.value = 0;
    this.humAM = ctx.createGain();
    this.humAM.gain.value = 0.75;
    this.humLfo = ctx.createOscillator();
    this.humLfo.frequency.value = 20;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.25;
    this.humLfo.connect(lfoG);
    lfoG.connect(this.humAM.gain);
    src.connect(this.humF);
    this.humF.connect(this.humAM);
    this.humAM.connect(this.humG);
    this.humG.connect(this.sfx);
    const v = ctx.createGain();
    v.gain.value = 0.25;
    this.humG.connect(v);
    v.connect(this.verbIn);
    src.start();
    this.humLfo.start();
  }
  // v — скорость качения, м/с; surface: "wood" (трек, склон) | "rotor"
  hum(v, surface, rate = 1) {
    if (!this.ctx || !this.humG) return;
    const t = this.ctx.currentTime;
    const k = clamp(v / 4.2, 0, 1);
    const g = v < 0.02 ? 0 : (surface === "rotor" ? 0.1 : 0.2) * Math.pow(k, 0.7) + 0.015;
    this.humG.gain.setTargetAtTime(this.muted ? 0 : g, t, 0.04);
    const f = (surface === "rotor" ? 900 : 180) + (surface === "rotor" ? 1400 : 950) * k;
    this.humF.frequency.setTargetAtTime(f * (0.6 + 0.4 * rate), t, 0.05);
    this.humLfo.frequency.setTargetAtTime(Math.max(4, (v / (TAU * GEOM.ballR)) * 0.5 * rate), t, 0.05);
  }

  // фон казино: гомон (шум с медленной модуляцией), тон зала, редкий далёкий звон фишек
  startAmbience() {
    const ctx = this.ctx;
    this.amb = ctx.createGain();
    this.amb.gain.value = this.ambOn ? 0.55 : 0;
    this.amb.connect(this.master);
    const room = ctx.createBufferSource();
    room.buffer = this.brown;
    room.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 220;
    const rg = ctx.createGain();
    rg.gain.value = 0.06;
    room.connect(lp); lp.connect(rg); rg.connect(this.amb);
    room.start();
    // несколько «голосов»: полосы 300–1400 Гц, каждая дышит своей медленной волной
    for (let i = 0; i < 4; i++) {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.playbackRate.value = 0.7 + i * 0.13;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 320 + i * 280;
      bp.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.value = 0.012;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13 + i * 0.07;
      const lg = ctx.createGain();
      lg.gain.value = 0.01;
      lfo.connect(lg); lg.connect(g.gain);
      s.connect(bp); bp.connect(g); g.connect(this.amb);
      const v = ctx.createGain(); v.gain.value = 0.6; g.connect(v); v.connect(this.verbIn);
      s.start(0, Math.random() * 1.5);
      lfo.start();
    }
    const tick = () => {
      if (!this.ctx) return;
      if (this.live && this.ambOn && this.duck > 0.5) {
        const n = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) {
          const t = this.at(i * (35 + Math.random() * 50));
          const f = 3000 + Math.random() * 2400;
          const o = ctx.createOscillator();
          o.frequency.value = f;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.018, t + 0.002);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
          o.connect(g); g.connect(this.verbIn);
          const dry = ctx.createGain(); dry.gain.value = 0.3; g.connect(dry); dry.connect(this.amb);
          o.start(t); o.stop(t + 0.1);
        }
      }
      this.ambTimer = setTimeout(tick, 1500 + Math.random() * 5000);
    };
    this.ambTimer = setTimeout(tick, 2000);
  }
  // ва-банк: зал затихает, остаётся только шарик
  setDuck(k) {
    this.duck = k;
    if (this.amb) this.amb.gain.setTargetAtTime(this.ambOn ? 0.55 * k : 0, this.ctx.currentTime, 0.4);
  }
  dispose() {
    window.removeEventListener("pointerdown", this._unlock, true);
    window.removeEventListener("keydown", this._unlock, true);
    window.removeEventListener("touchstart", this._unlock, true);
    clearTimeout(this.ambTimer);
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

// ---------- искры джекпота ----------

class Sparks {
  constructor(parent, n = 150) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.02,
      map: tex(blobCanvas(64, "rgba(255,236,170,1)", "rgba(255,170,40,0)")),
      color: 0xffd98a,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    parent.add(this.points);
    this.active = false;
  }
  burst(x, y, z) {
    for (let i = 0; i < this.n; i++) {
      this.pos.set([x, y, z], i * 3);
      const a = Math.random() * TAU, up = 0.9 + Math.random() * 1.6, out = 0.15 + Math.random() * 0.55;
      this.vel.set([Math.cos(a) * out, up, Math.sin(a) * out], i * 3);
      this.life[i] = 0.9 + Math.random() * 1.1;
    }
    this.active = true;
    this.points.visible = true;
  }
  update(dt) {
    if (!this.active) return;
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -10; continue; }
      alive++;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 2.6 * dt;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.mat.opacity = 1;
    if (!alive) { this.active = false; this.points.visible = false; }
  }
}

// ---------- качество ----------

function pickQuality(q) {
  if (q === "high") return { level: 2, auto: false };
  if (q === "low") return { level: 0, auto: false };
  const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4 || /Mobi|Android/i.test(navigator.userAgent || "");
  return { level: weak ? 1 : 2, auto: true };
}

function webglOk() {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch (e) {
    return false;
  }
}

// Скатывание сцены на поверхность под шариком: для контактной тени
function surfaceY(r) {
  const g = GEOM;
  if (r >= g.statorInnerR) return statorY(Math.min(r, 0.386));
  if (r >= g.ringInnerR && r <= g.rotorR) return ringY(r);
  if (r >= g.pocketInnerR && r < g.pocketOuterR) return g.floorY;
  return null;
}

// ячейка «загорается» тёплым светом: чисто красное свечение на красном дне не читается
const GLOW_COLOR = { red: 0xffa47a, black: 0xffe2a8, green: 0x6dffb0 };
const CHIP_H = CHIP.h + 0.00012;

function create3D(container, opts) {
  const dbg = { time: null, silent: false };
  const nowS = () => (dbg.time ? dbg.time.s : opts.now ? opts.now() : Date.now());
  const nowL = () => (dbg.time ? dbg.time.l : performance.now());
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const QP = pickQuality(opts.quality || "auto");
  let level = QP.level;
  const Q = { segs: level === 0 ? 96 : 160, ringSegs: level === 0 ? 148 : 296, low: level === 0 };

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: !!opts.preserveDrawingBuffer });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true; // руки крупье не залезают под табло (см. Dealer.updateClip)
  const cv = renderer.domElement;
  cv.style.display = "block";
  cv.style.width = "100%";
  cv.style.height = "100%";
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  container.appendChild(cv);
  // виньетка — CSS-слой поверх канвы: бесплатно и одинаково при любом качестве
  const vig = document.createElement("div");
  vig.style.cssText = "position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 75% 70% at 50% 46%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%);";
  container.appendChild(vig);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060403);
  scene.environment = buildEnvironment(renderer);
  scene.environmentIntensity = 0.3;
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.04, 20);
  /*
   * Безопасная зона: доля экрана под интерфейсом страницы (сверху табло, справа чат, снизу рельс игроков).
   * Центр кадра смещаем в середину свободной части через setViewOffset — сцена не прячется под HUD.
   */
  // по умолчанию — под доску: табло сверху (~12%), чат справа внизу (~18%), рельс игроков снизу (~15%)
  const safe = Object.assign({ top: 0.12, right: 0.18, bottom: 0.15, left: 0.02 }, opts.safeArea || {});
  const fitK = () => Math.max(1 / Math.max(0.4, 1 - safe.left - safe.right), (1 / Math.max(0.4, 1 - safe.top - safe.bottom)) * 0.92);

  // одна тёплая лампа над столом + её же «второй плафон» над колесом, без теней
  // лампа низко над столом: к краям стола свет заметно падает — «пятно» света в тёмном зале
  const lamp = new THREE.SpotLight(0xffd2a0, 17, 6, 0.95, 0.85, 2);
  lamp.position.set(-0.4, 1.75, 0.0);
  lamp.target.position.set(-0.36, 0, -0.08);
  lamp.castShadow = true;
  lamp.shadow.bias = -0.00015;
  lamp.shadow.normalBias = 0.004;
  lamp.shadow.camera.near = 0.8;
  lamp.shadow.camera.far = 3.0;
  lamp.shadow.mapSize.set(2048, 2048);
  lamp.shadow.radius = 4;
  scene.add(lamp, lamp.target);
  const wheelFill = new THREE.SpotLight(0xffc88e, 7, 3, 0.42, 0.9, 2);
  wheelFill.position.set(WHEEL_POS.x + 0.1, 1.5, WHEEL_POS.z + 0.25);
  wheelFill.target.position.copy(WHEEL_POS);
  scene.add(wheelFill, wheelFill.target);
  const hemi = new THREE.HemisphereLight(0x4a3522, 0x050302, 0.12);
  scene.add(hemi);
  const lampColor = new THREE.Color(0xffd2a0);

  const W3 = buildWheel(Q);
  W3.wheel.position.copy(WHEEL_POS);
  scene.add(W3.wheel);
  const T3 = buildTable(Q, opts.lang || "ru", W3.materials);
  scene.add(T3.table);
  const chipG = chipGeometry(level === 0 ? 24 : 36);
  const chipMat = chipMaterial(chipG.vTop, chipG.vSide);
  const pool = new ChipPool(scene, chipG.geo, chipMat, 1800);
  const trayPool = new ChipPool(scene, chipG.geo, chipMat, 160);
  const dealer = new Dealer(scene);
  const sparks = new Sparks(scene);
  const post = new Post(renderer);
  const sound = new Sound();

  // дольки — фишки казино в лотке, статичный декор: грифель и кость (не спорят с цветами игроков)
  const HOUSE = [new THREE.Color(0x46525c), new THREE.Color(0xd8ccb0), new THREE.Color(0x6b5a44)];
  for (let col = 0; col < 8; col++) {
    const n = 6 + Math.floor(hash01(col + 3) * 12);
    for (let i = 0; i < n; i++) {
      trayPool.add({ x: TRAY.x - TRAY.w / 2 + 0.035 + col * 0.061, y: 0.02 + i * CHIP_H + CHIP.h / 2, z: TRAY.z + (col % 2 ? 0.018 : -0.018), color: HOUSE[col % 3], rot: hash01(col * 31 + i) * TAU });
    }
  }
  trayPool.update(0);

  // маркер (dolly): латунная «шахматная» фигура — крупная, чтобы номер под ней читался с общего плана
  const dolly = new THREE.Group();
  const dMat = W3.materials.brassBright;
  const dollyGeo = revolve([
    [0.0001, 0.086], ...arc(0.0001, 0.074, 0.012, Math.PI / 2, -Math.PI / 3, 8),
    [0.005, 0.06], [0.006, 0.045], [0.012, 0.03], [0.016, 0.02], [0.022, 0.012], [0.024, 0.006], [0.024, 0.0], [0.0001, 0.0],
  ].reverse(), 40);
  // тело цвета слоновой кости: латунь в тёмном зале выглядит чёрным силуэтом, а светлый маркер читается на любой клетке
  const dollyMesh = new THREE.Mesh(dollyGeo, W3.materials.ballMat);
  dollyMesh.castShadow = true;
  dolly.add(dollyMesh);
  const dRing = new THREE.Mesh(new THREE.TorusGeometry(0.0125, 0.0026, 8, 28), dMat);
  dRing.rotation.x = Math.PI / 2;
  dRing.position.y = 0.03;
  dolly.add(dRing);
  dolly.visible = false;
  scene.add(dolly);

  // подсветка выпавшей клетки на столе и тёплый свет над ней (свет живёт с начала — иначе при появлении перекомпилируются все шейдеры)
  const cellHL = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }));
  cellHL.rotation.x = -Math.PI / 2;
  cellHL.renderOrder = 5;
  cellHL.visible = false;
  scene.add(cellHL);
  const cellLight = new THREE.PointLight(0xffd79a, 0, 0.55, 2);
  scene.add(cellLight);
  // ореол шире клетки (его не закрывают фишки и маркер) и волна, раз в секунду расходящаяся по сукну —
  // глаз цепляется за выпавший номер даже на общем плане
  const haloMat = new THREE.MeshBasicMaterial({ map: tex(blobCanvas(128, "rgba(255,255,255,1)", "rgba(255,255,255,0)")), transparent: true, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffc860 });
  const cellHalo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat);
  cellHalo.rotation.x = -Math.PI / 2;
  cellHalo.renderOrder = 4;
  cellHalo.visible = false;
  scene.add(cellHalo);
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffd98a }));
  ripple.rotation.x = -Math.PI / 2;
  ripple.renderOrder = 4;
  ripple.visible = false;
  scene.add(ripple);
  // выпавший номер: на колесе — сектор кольца, на столе — клетка; держится до новых ставок
  const win = { n: null, wheel: false, table: false, t0: 0 };
  function showWinner(n, where) {
    if (!(n >= 0 && n <= 36)) return;
    if (win.n !== n) {
      win.n = n;
      drawWinnerNumeral(W3.numC, n);
      W3.numTex.needsUpdate = true;
      W3.numHL.rotation.y = -WHEEL.indexOf(n) * PA;
      const zero = n === 0;
      const plate = cellPlateCanvas(n);
      if (cellHL.material.map) cellHL.material.map.dispose();
      cellHL.material.map = tex(plate.c, { aniso: 8 });
      cellHL.material.needsUpdate = true;
      cellHL.scale.set(plate.w, plate.h, 1);
      const [cx, cz] = cellCenter(n);
      cellHL.position.set(cx, 0.0014, cz);
      cellHalo.position.set(cx, 0.0011, cz);
      cellHalo.scale.set(plate.w + 0.16, plate.h + 0.16, 1);
      haloMat.color.set(zero ? 0x6dffb0 : 0xffc860);
      ripple.position.set(cx, 0.0012, cz);
      ripple.material.color.set(zero ? 0x8dffc0 : 0xffd98a);
      win.rip = Math.max(plate.w, plate.h) * 0.55;
      cellLight.position.set(cx, 0.16, cz + 0.04);
      cellLight.color.set(zero ? 0x9dffc4 : 0xffd79a);
      win.wheel = win.table = false;
      win.t0 = nowL();
    }
    if (where === "wheel" || where === "both") win.wheel = true;
    if (where === "table" || where === "both") win.table = true;
  }
  function clearWinner() {
    win.n = null;
    win.wheel = win.table = false;
    W3.numHL.visible = false;
    cellHL.visible = false;
    cellHalo.visible = false;
    ripple.visible = false;
    cellLight.intensity = 0;
  }

  // ---------- состояние ----------
  const listeners = {};
  const emit = (ev, data) => { for (const fn of listeners[ev] || []) { try { fn(data); } catch (e) { console.error(e); } } };
  const st = {
    mode: "idle",
    calm: !!opts.calm || reduce,
    wheelA: Math.random() * TAU,
    wheelV: IDLE_SPEED,
    ballPhi: Math.floor(Math.random() * POCKETS) * PA,
    ballShown: true,
    spin: null,
    pay: null,
    stacks: new Map(),
    unit: 0,
    glow: { idx: -1, level: 0, target: 0, color: new THREE.Color() },
    effects: { green: 0, gold: 0, flash: 0 },
    tableDim: 0,
  };

  // ---------- колесо: холостой ход, разгон перед броском, траектория ----------
  // угол ротора во время спина: стыковка с холостым ходом живёт в roulette-trajectory.js (там же её тест)
  function spinWheelAngle(sp, t) {
    return sp.wheel.angle(t);
  }
  function currentWheelAngle(ns) {
    if (st.spin && st.mode !== "idle") return spinWheelAngle(st.spin, ns - st.spin.spinAt);
    return st.wheelA;
  }

  // ---------- ярлыки ставок ----------
  /*
   * С 3 м на ТВ цвет фишки мало что говорит — над каждым столбиком висит ярлык: инициалы игрока
   * (как на аватарке рельса) и сумма, на плашке цвета игрока. Размер задан в долях высоты экрана,
   * а не в метрах, поэтому он одинаково читается на любом экране. Если ярлыки налезают друг на друга,
   * крупная ставка остаётся, мелкая гаснет (цвет фишки всё равно показывает, чья она).
   * На общей клетке — один ярлык: плашки до трёх игроков, «+N» и общая сумма.
   */
  const tagGroup = new THREE.Group();
  scene.add(tagGroup);
  const tags = new Map();
  let tagFade = 0;
  let tagTick = 0;
  // ярлык: одна плашка цвета игрока «инициалы сумма»; у общей клетки — плашки нескольких игроков и общая сумма
  function drawTag(items, total) {
    const H = 64;
    const font = `800 ${Math.round(H * 0.62)}px "Roboto Condensed", "Arial Narrow", Arial, sans-serif`;
    const m = canvas(8, 8).getContext("2d");
    m.font = font;
    const pad = H * 0.28, gap = H * 0.16;
    const single = items.length === 1;
    const show = single ? items : items.slice(0, 3);
    const more = items.length - show.length;
    const parts = show.map((it) => ({ ...it, text: single ? it.ini + " " + rlAmount(it.amount) : it.ini }));
    parts.forEach((pt) => { pt.w = m.measureText(pt.text).width + pad * 2; });
    const tail = single ? "" : (more > 0 ? `+${more} ` : "") + rlAmount(total);
    const tailW = tail ? m.measureText(tail).width + pad * 2 : 0;
    const W = Math.ceil(parts.reduce((a, pt) => a + pt.w + gap, 0) + tailW + 4);
    const c = canvas(W, H);
    const g = c.getContext("2d");
    g.font = font;
    g.textBaseline = "middle";
    let x = 2;
    const pill = (w, fill) => {
      g.beginPath();
      g.roundRect(x, 2, w, H - 4, H / 2 - 3);
      g.fillStyle = fill;
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = "rgba(10,6,3,0.85)";
      g.stroke();
    };
    for (const pt of parts) {
      pill(pt.w, pt.hex);
      g.fillStyle = "#120c07";
      g.fillText(pt.text, x + pad, H / 2 + 2);
      x += pt.w + gap;
    }
    if (tail) {
      pill(tailW, "rgba(20,14,9,0.92)");
      g.fillStyle = "#f1e6cf";
      g.fillText(tail, x + pad, H / 2 + 2);
    }
    return c;
  }
  function syncTags(dt) {
    // один ярлык на клетку ставки: игроки на общей клетке собираются в одну строку, а не спорят за место
    const groups = new Map();
    for (const s2 of st.stacks.values()) {
      let gr = groups.get(s2.key);
      if (!gr) { gr = { key: s2.key, items: [], total: 0, top: 0 }; groups.set(s2.key, gr); }
      gr.items.push({ ini: s2.ini || "?", amount: s2.amount, hex: s2.hex || "#ccc" });
      gr.total += s2.amount;
      gr.top = Math.max(gr.top, s2.chips.length * CHIP_H);
    }
    for (const [id, t] of tags) if (!groups.has(id)) { tagGroup.remove(t.sp); t.sp.material.map.dispose(); t.sp.material.dispose(); tags.delete(id); }
    for (const [id, gr] of groups) {
      gr.items.sort((a, b) => b.amount - a.amount);
      const text = gr.items.map((it) => it.ini + ":" + it.amount + ":" + it.hex).join("|");
      let t = tags.get(id);
      if (!t) {
        const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false, opacity: 0 });
        t = { sp: new THREE.Sprite(mat), text: "", a: 0, aim: 1, ratio: 1 };
        t.sp.renderOrder = 20;
        t.sp.frustumCulled = false;
        tagGroup.add(t.sp);
        tags.set(id, t);
        const [bx, bz] = betPos(id);
        t.x = bx;
        t.z = bz;
      }
      if (t.text !== text) {
        const c = drawTag(gr.items, gr.total);
        if (t.sp.material.map) t.sp.material.map.dispose();
        t.sp.material.map = tex(c, { aniso: 1 });
        t.sp.material.needsUpdate = true;
        t.ratio = c.width / c.height;
        t.text = text;
      }
      t.total = gr.total;
      t.top = gr.top;
    }
    // высота ярлыка — 3% высоты кадра, но не меньше 22 px
    const hPx = Math.max(22, 0.03 * renderer.domElement.clientHeight);
    const hFrac = hPx / Math.max(1, renderer.domElement.clientHeight);
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    // ярлыки нужны на общем плане во время ставок; на колесе и на выплатах они только мешают
    const want = st.mode !== "payout" && shotName === "overview" ? 1 : 0;
    tagFade += (want - tagFade) * Math.min(1, dt * 6);
    tagGroup.visible = tagFade > 0.01;
    if (!tagGroup.visible) return;
    // раскладка без наложений: раз в несколько кадров, по убыванию суммы — мелкие ставки уступают крупным
    if (++tagTick % 4 === 0) {
      const list = [...tags.values()].sort((a, b) => b.total - a.total);
      const placed = [];
      const aspect = camera.aspect;
      for (const t of list) {
        tmpV.set(t.x, t.top + 0.004, t.z).project(camera);
        const h = hFrac * 2, w = (hFrac * 2 * t.ratio) / aspect;
        const y0 = tmpV.y + h * 0.45;
        const rect = [tmpV.x - w / 2, y0, tmpV.x + w / 2, y0 + h];
        let hit = false;
        for (const q of placed) {
          const ox = Math.min(rect[2], q[2]) - Math.max(rect[0], q[0]);
          const oy = Math.min(rect[3], q[3]) - Math.max(rect[1], q[1]);
          if (ox > 0 && oy > 0 && ox * oy > 0.08 * w * h) { hit = true; break; }
        }
        t.aim = hit ? 0 : 1;
        if (!hit) placed.push(rect);
      }
    }
    for (const t of tags.values()) {
      t.a += (t.aim - t.a) * Math.min(1, dt * 8);
      t.sp.position.set(t.x, t.top + 0.004, t.z);
      t.sp.center.set(0.5, -0.45); // над столбиком, а не на нём: сами фишки остаются видны
      t.sp.scale.set(hFrac * k * t.ratio, hFrac * k, 1);
      t.sp.material.opacity = t.a * tagFade;
      t.sp.visible = t.sp.material.opacity > 0.01;
    }
  }

  // ---------- фишки ----------
  const PAY = { 1: 35, 2: 17, 3: 11, 4: 8, 6: 5, 12: 2, 18: 1 };
  function chipCount(amount) {
    const u = st.unit || amount;
    const r = amount / u;
    if (r <= 10) return Math.max(1, Math.round(r));
    return Math.min(20, 10 + Math.round(Math.log2(r / 10) * 4));
  }
  const colorCache = new Map();
  const colorOfHex = (hex) => {
    if (!colorCache.has(hex)) { let c; try { c = new THREE.Color(hex); } catch (e) { c = new THREE.Color(0xcccccc); } colorCache.set(hex, c); }
    return colorCache.get(hex);
  };
  // веер: если на ставке несколько игроков, их столбики расходятся по дуге
  function fanOffset(i, n, key) {
    if (n <= 1) return [0, 0];
    const big = !key.includes(":") || key.startsWith("dz:") || key.startsWith("col:");
    const rad = (big ? 0.024 : 0.015) + 0.002 * n;
    const a = -Math.PI / 2 + ((i + 0.5) / n) * TAU + (strHash(key) % 100) / 100;
    return [Math.cos(a) * rad, Math.sin(a) * rad];
  }
  function chipRest(stack, i) {
    const h = strHash(stack.id) + i * 7919;
    return {
      x: stack.x + (hash01(h) - 0.5) * 0.0016,
      y: 0.0006 + i * CHIP_H + CHIP.h / 2,
      z: stack.z + (hash01(h + 1) - 0.5) * 0.0016,
      rot: hash01(h + 2) * TAU,
    };
  }
  function dropChip(stack, i, now, delay) {
    const r = chipRest(stack, i);
    const c = pool.add({ x: r.x, y: r.y, z: r.z, rot: r.rot, color: stack.color, hideBefore: true });
    if (!c) return null;
    const from = r.y + 0.09 + i * 0.002;
    pool.animate(c, 300, (k) => {
      // падение с лёгким отскоком — фишка глиняная, тяжёлая
      const kk = k < 0.72 ? (k / 0.72) ** 2 : 1 - Math.sin(((k - 0.72) / 0.28) * Math.PI) * 0.06;
      return [r.x, lerp(from, r.y, Math.min(1, kk)) + (k >= 0.72 ? (1 - kk) * 0.02 : 0), r.z, 1];
    }, now, delay);
    return c;
  }
  function liftChip(c, now, delay) {
    const x = c.x, y = c.y, z = c.z;
    pool.animate(c, 240, (k) => [x, y + easeOut(k) * 0.05, z, 1 - easeInOut(k)], now, delay, (cc) => { cc.dead = true; });
  }
  let clinkBudget = 0;
  function syncStacks(players, instant) {
    // вкладка скрыта — анимировать некому: ставим фишки сразу на места
    if (typeof document !== "undefined" && document.hidden) instant = true;
    const now = nowL();
    const want = new Map();
    const byKey = new Map();
    let minAmt = Infinity;
    (players || []).forEach((p) => {
      if (!p || !p.bets) return;
      for (const [key, amt] of Object.entries(p.bets)) {
        const a = Number(amt);
        if (!(a > 0) || !betNumbers(key).length) continue;
        minAmt = Math.min(minAmt, a);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ p, a });
      }
    });
    if (!st.stacks.size || !st.unit || minAmt < st.unit) {
      const u = opts.chipUnit || (Number.isFinite(minAmt) ? minAmt : 0);
      if (u && u !== st.unit) {
        st.unit = u;
        // единица сменилась — пересобираем высоты уже стоящих столбиков
        for (const s of st.stacks.values()) s.count = -1;
      }
    }
    for (const [key, arr] of byKey) {
      const [bx, bz] = betPos(key);
      arr.forEach(({ p, a }, i) => {
        const [ox, oz] = fanOffset(i, arr.length, key);
        const id = p.id + "|" + key;
        want.set(id, { id, pid: p.id, key, amount: a, count: chipCount(a), color: colorOfHex(p.color || "#cccccc"), hex: p.color || "#cccccc", ini: initialsOf(p), row: i, x: bx + ox, z: bz + oz });
      });
    }
    let added = 0;
    // убираем лишнее
    for (const [id, s] of st.stacks) {
      if (want.has(id)) continue;
      s.chips.forEach((c, i) => { if (instant) c.dead = true; else liftChip(c, now, (s.chips.length - i) * 20); });
      st.stacks.delete(id);
      pool.dirty = true;
    }
    for (const [id, w] of want) {
      let s = st.stacks.get(id);
      if (!s) {
        s = Object.assign({ chips: [] }, w);
        st.stacks.set(id, s);
      }
      s.amount = w.amount;
      s.color = w.color;
      s.hex = w.hex;
      s.ini = w.ini;
      s.row = w.row;
      const moved = Math.abs(s.x - w.x) > 1e-6 || Math.abs(s.z - w.z) > 1e-6;
      if (moved) {
        s.x = w.x;
        s.z = w.z;
        s.chips.forEach((c, i) => {
          const r = chipRest(s, i);
          const fx = c.x, fz = c.z;
          c.anim = null;
          if (instant) { c.x = r.x; c.z = r.z; c.y = r.y; }
          else pool.animate(c, 260, (k) => { const e = easeInOut(k); return [lerp(fx, r.x, e), r.y, lerp(fz, r.z, e), 1]; }, now);
        });
      }
      const need = w.count;
      while (s.chips.length > need) { const c = s.chips.pop(); if (instant) c.dead = true; else liftChip(c, now, 0); pool.dirty = true; }
      while (s.chips.length < need) {
        const i = s.chips.length;
        let c;
        if (instant) {
          const r = chipRest(s, i);
          c = pool.add({ x: r.x, y: r.y, z: r.z, rot: r.rot, color: s.color });
        } else {
          // лесенка падений короткая: при пачке ставок (переподключение) иначе последние фишки ждали бы секундами
          c = dropChip(s, i, now, Math.min(600, added * 30));
          added++;
        }
        if (!c) break;
        s.chips.push(c);
      }
      s.count = need;
      for (const c of s.chips) c.color = s.color;
    }
    if (added && !instant && !dbg.silent && clinkBudget < 6) {
      clinkBudget++;
      sound.clink(Math.min(4, added), 260, 0.12);
      setTimeout(() => { clinkBudget = Math.max(0, clinkBudget - 1); }, 400);
    }
  }

  // ---------- спин ----------
  function spin(result) {
    if (!result || !Number.isFinite(Number(result.number))) return;
    const key = `${result.seed}|${result.spinAt}|${result.number}`;
    if (st.spin && st.spin.key === key && st.mode === "spin") return;
    finishPayout();
    clearWinner();
    dolly.visible = false;
    const ns = nowS();
    const spinAt = Number(result.spinAt) || ns;
    const revealAt = Number(result.revealAt) || spinAt + ((result.story && result.story.duration) || 10000);
    let traj;
    try {
      traj = buildTrajectory({ number: Number(result.number), seed: Number(result.seed), story: result.story || {}, spinMs: revealAt - spinAt });
    } catch (e) {
      console.error("[roulette] траектория не построилась", e);
      return;
    }
    const tCall = ns - spinAt;
    const cur = currentWheelAngle(ns);
    const sp = { key, res: result, traj, spinAt, revealAt, story: result.story || {}, tCall, fired: new Set(), landed: false, revealed: false };
    // текущая скорость ротора (со знаком): холостой ход крутит угол вниз
    const curV = st.spin && st.mode !== "idle" ? (currentWheelAngle(ns + 1) - currentWheelAngle(ns - 1)) / 0.002 : -st.wheelV;
    sp.wheel = wheelHandoff(traj, cur, curV, tCall);
    // шарик из прошлой ячейки уходит в руку крупье, если спин начат вовремя
    sp.pick = st.ballShown && tCall < 300 ? { phi: st.ballPhi, a: clamp(tCall, -900, -100), b: clamp(tCall, -900, -100) + 650 } : null;
    // события, которые уже прошли, не звучат (переподключение)
    for (const e of traj.events) if (e.t < tCall - 250) sp.fired.add(e);
    if (tCall >= traj.times.settle) sp.landed = true;
    // где будут отскоки (средний мировой угол шарика от касания ротора до посадки) — для камеры
    let sum = 0, cnt = 0;
    for (let q = traj.times.rotor; q <= traj.times.land; q += 20) { sum += traj.sample(q).theta; cnt++; }
    sp.side = sum / Math.max(1, cnt);
    st.spin = sp;
    st.mode = "spin";
    if (tCall < 700) {
      const lp = WHEEL_POS.clone().add(new THREE.Vector3(0, traj.sample(0).y, -GEOM.trackR));
      dealer.launch(nowL() + (-650 - tCall), [lp.x, lp.y, lp.z], 1);
    }
  }

  // ---------- выплаты ----------
  function railTarget(fx) {
    const v = new THREE.Vector3(fx * 2 - 1, -1.05, 0.5).unproject(camera);
    const dir = v.sub(camera.position).normalize();
    const t = (0.03 - camera.position.y) / (dir.y || -1e-6);
    const p = camera.position.clone().add(dir.multiplyScalar(Math.max(0.2, t)));
    return [p.x, p.z];
  }
  function payout(data) {
    if (!data) return;
    const number = Number(data.number);
    if (st.pay && st.pay.number === number && st.pay.spinKey === (st.spin && st.spin.key)) return;
    const now = nowL();
    if (data.players) syncStacks(data.players, true);
    // переподключились сразу к выплатам: спина не видели — шарик просто лежит в выпавшей ячейке
    if (!st.spin || Number(st.spin.res.number) !== number) {
      st.spin = null;
      st.ballPhi = WHEEL.indexOf(number) * PA;
      st.ballShown = true;
      setGlow(WHEEL.indexOf(number), 0.8);
    }
    showWinner(number, "both");
    st.mode = "payout";
    const pay = { number, t0: now, spinKey: st.spin && st.spin.key, done: false, jackpot: !!(st.spin && st.spin.story.jackpot) };
    st.pay = pay;
    // маркер падает на выпавший номер
    const [dx, dz] = cellCenter(number);
    dolly.visible = true;
    pay.dolly = { x: dx, z: dz, t0: now + 250 };
    const players = data.players || [];
    const order = new Map(players.map((p, i) => [p.id, i]));
    const losers = [], winners = [];
    for (const s of st.stacks.values()) (betNumbers(s.key).includes(number) ? winners : losers).push(s);
    // лопатка: проигравшие столбики по полосам ~20 см, максимум 4 прохода; на зеро — один широкий
    const strokes = [];
    const zero = number === 0;
    if (losers.length) {
      if (zero) strokes.push({ x: LAY.x0 + LAY.w / 2, w: LAY.w + 0.06, list: losers.slice() });
      else {
        const sorted = losers.slice().sort((a, b) => a.x - b.x);
        let cur = null;
        for (const s of sorted) {
          if (!cur || s.x - cur.x0 > 0.2) { cur = { x0: s.x, list: [] }; strokes.push(cur); }
          cur.list.push(s);
        }
        while (strokes.length > 4) {
          // сливаем самые близкие соседние полосы
          let bi = 0, bd = Infinity;
          for (let i = 0; i < strokes.length - 1; i++) { const d = strokes[i + 1].x0 - strokes[i].x0; if (d < bd) { bd = d; bi = i; } }
          strokes[bi].list.push(...strokes[bi + 1].list);
          strokes.splice(bi + 1, 1);
        }
        for (const s of strokes) {
          const xs = s.list.map((q) => q.x);
          s.x = (Math.min(...xs) + Math.max(...xs)) / 2;
          s.w = Math.max(0.2, Math.max(...xs) - Math.min(...xs) + 0.06);
        }
      }
    }
    const STROKE = zero ? 900 : 440;
    const rake0 = now + 600; // лопатка появляется из-за стола, первый проход — через 350 мс
    const zNear = LAY.z0 + LAY.h + 0.035, zFar = TRAY.z + TRAY.d / 2 + 0.012;
    const rakeKeys = [];
    const headZ = (tt) => lerp(zNear, zFar, easeInOut((tt - STROKE * 0.18) / (STROKE * 0.64)));
    strokes.forEach((s, k) => {
      const t = 350 + k * STROKE;
      s.t0 = rake0 + t;
      rakeKeys.push(
        { t: t, p: [s.x, 0.09, zNear + 0.02], r: [0, 0, 0] },
        { t: t + STROKE * 0.18, p: [s.x, 0.004, zNear], r: [0, 0, 0] },
        { t: t + STROKE * 0.82, p: [s.x, 0.004, zFar], r: [0, 0, 0] },
        { t: t + STROKE * 0.98, p: [s.x, 0.07, zFar - 0.02], r: [0, 0, 0] },
      );
      // фишки едут перед лопаткой: трогаются, когда кромка до них дошла
      for (const st2 of s.list) {
        st2.chips.forEach((c) => {
          const cz = c.z, cx = c.x, cy = c.y;
          const off = CHIP.R + 0.009;
          let tc = STROKE * 0.18;
          for (let q = STROKE * 0.18; q <= STROKE * 0.82; q += 8) { if (headZ(q) - 0.008 <= cz + off) { tc = q; break; } }
          const dur = STROKE * 0.82 - tc + 160;
          pool.animate(c, dur, (kk) => {
            const tt = tc + kk * dur;
            const hz = tt <= STROKE * 0.82 ? headZ(tt) - off : zFar - off;
            const z = Math.min(cz, hz);
            // в конце фишки ссыпаются в лоток
            const sink = clamp((tt - STROKE * 0.8) / 160, 0, 1);
            return [lerp(cx, s.x + (cx - s.x) * 0.6, kk), cy * (1 - sink * 0.5) + sink * 0.012, z, 1 - sink * 0.9];
          }, s.t0, tc, (cc) => { cc.dead = true; });
        });
      }
    });
    if (strokes.length) {
      rakeKeys.unshift({ t: 0, p: [strokes[0].x, 0.25, -0.95], r: [0, 0, 0] });
      const last = strokes[strokes.length - 1];
      rakeKeys.push({ t: 350 + strokes.length * STROKE + 250, p: [last.x, 0.25, -0.95], r: [0, 0, 0] });
      // на зеро — одна длинная лопатка через весь стол: «сгребает всё одним движением»
      dealer.rakeHead.scale.x = dealer.rakeEdge.scale.x = zero ? (LAY.w + 0.06) / 0.2 : 1;
      dealer.play(dealer.rake, rakeKeys, rake0);
      if (!dbg.silent) strokes.forEach((s) => sound.swish(s.t0 - now + STROKE * 0.18, (STROKE / 1000) * 0.7));
    }
    for (const s of losers) st.stacks.delete(s.id);
    // казино доплачивает: фишки вылетают из лотка к каждому выигравшему столбику
    const tWin = strokes.length ? rake0 + 350 + strokes.length * STROKE + 100 : now + 900;
    pay.tWin = tWin;
    let flyIdx = 0;
    const houseColor = HOUSE[0];
    const winList = winners.slice().sort((a, b) => (order.get(a.pid) || 0) - (order.get(b.pid) || 0));
    for (const s of winList) {
      const nums = betNumbers(s.key).length;
      const profit = s.amount * (PAY[nums] || 1);
      const n = Math.min(16, chipCount(profit));
      s.house = [];
      const hx = s.x + 0.027, hz = s.z + 0.006;
      for (let i = 0; i < n; i++) {
        const r = { x: hx + (hash01(i + s.x * 1e4) - 0.5) * 0.0015, y: 0.0006 + i * CHIP_H + CHIP.h / 2, z: hz };
        const fx = TRAY.x + (hash01(i * 3 + 1) - 0.5) * TRAY.w * 0.8, fz = TRAY.z;
        const c = pool.add({ x: r.x, y: r.y, z: r.z, color: houseColor, hideBefore: true });
        if (!c) break;
        const delay = tWin - now + flyIdx * 55;
        pool.animate(c, 420, (k) => {
          const e = easeInOut(k);
          return [lerp(fx, r.x, e), lerp(0.03, r.y, e) + Math.sin(Math.PI * k) * 0.12, lerp(fz, r.z, e), 1, (1 - k) * 2.5];
        }, now, delay);
        s.house.push(c);
        flyIdx++;
      }
    }
    if (flyIdx && !dbg.silent) {
      for (let i = 0; i < Math.min(flyIdx, 10); i++) sound.clink(1, tWin - now + 420 + i * 55 * Math.max(1, flyIdx / 10), 0.16);
    }
    // столбики уезжают вниз экрана, к рельсу игроков на странице
    const tSlide = tWin + flyIdx * 55 + 600;
    pay.tSlide = tSlide;
    pay.tEnd = tSlide + 1100;
    const rail = data.railX || {};
    for (const s of winList) {
      const idx = order.has(s.pid) ? order.get(s.pid) : 0;
      const fx = rail[s.pid] != null ? rail[s.pid] : (idx + 0.5) / Math.max(1, players.length);
      pay.slides = pay.slides || [];
      pay.slides.push({ s, fx });
    }
    pay.slideStarted = false;
  }
  function startSlides(now) {
    const pay = st.pay;
    pay.slideStarted = true;
    for (const { s, fx } of pay.slides || []) {
      const [tx, tz] = railTarget(fx);
      const all = s.chips.concat(s.house || []);
      all.forEach((c, i) => {
        const x0 = c.x, y0 = c.y, z0 = c.z;
        pool.animate(c, 800, (k) => {
          const e = easeInOut(k);
          return [lerp(x0, tx, e), y0 + Math.sin(Math.PI * k) * 0.02, lerp(z0, tz, e), 1 - smooth((k - 0.6) / 0.4)];
        }, now, i * 12, (cc) => { cc.dead = true; });
      });
      st.stacks.delete(s.id);
    }
  }
  function finishPayout() {
    if (!st.pay) return;
    // досрочно: всё, что ещё едет по столу, просто исчезает
    for (const c of pool.list) c.dead = true;
    pool.dirty = true;
    st.stacks.clear();
    st.pay = null;
    dealer.tracks = [];
  }

  // ---------- камера ----------
  const C = WHEEL_POS;
  const camPos = new Spring(3, 2.2), camLook = new Spring(3, 2.2), camFov = new Spring(1, 2.0), orbit = new Spring(1, 3.0);
  let shotName = "overview";
  /*
   * Общий план подбирается по кадру, а не константами: раскладка целиком и большая часть колеса
   * должны влезть в свободную часть экрана (без табло, чата и рельса), и не мельче, чем нужно.
   * Считается на ресайз: бинарный поиск расстояния + подгонка точки взгляда к центру свободной зоны.
   */
  const fitCam = new THREE.PerspectiveCamera();
  let overviewFit = null;
  function fitShot(points, elev, yaw, fov) {
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(elev), Math.sin(elev), Math.cos(yaw) * Math.cos(elev));
    const look = new THREE.Vector3();
    for (const p of points) look.add(p);
    look.multiplyScalar(1 / points.length);
    fitCam.copy(camera);
    fitCam.fov = fov;
    const fx0 = -1 + 2 * safe.left, fx1 = 1 - 2 * safe.right, fy0 = -1 + 2 * safe.bottom, fy1 = 1 - 2 * safe.top;
    const box = (d) => {
      fitCam.position.copy(look).addScaledVector(dir, d);
      fitCam.lookAt(look);
      fitCam.updateMatrixWorld();
      fitCam.updateProjectionMatrix();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of points) { tmpV.copy(p).project(fitCam); x0 = Math.min(x0, tmpV.x); x1 = Math.max(x1, tmpV.x); y0 = Math.min(y0, tmpV.y); y1 = Math.max(y1, tmpV.y); }
      return [x0, x1, y0, y1];
    };
    let d = 2;
    for (let it = 0; it < 4; it++) {
      let lo = 0.5, hi = 8;
      for (let k = 0; k < 28; k++) {
        const m = (lo + hi) / 2;
        const [x0, x1, y0, y1] = box(m);
        if (x1 - x0 <= (fx1 - fx0) * 0.96 && y1 - y0 <= (fy1 - fy0) * 0.96) hi = m; else lo = m;
      }
      d = hi;
      // сдвигаем точку взгляда, чтобы рамка точек встала по центру свободной зоны
      const [x0, x1, y0, y1] = box(d);
      const ex = (x0 + x1) / 2 - (fx0 + fx1) / 2, ey = (y0 + y1) / 2 - (fy0 + fy1) / 2;
      const right = new THREE.Vector3().setFromMatrixColumn(fitCam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(fitCam.matrixWorld, 1);
      const scale = d * Math.tan(THREE.MathUtils.degToRad(fov) / 2);
      look.addScaledVector(right, ex * scale * camera.aspect).addScaledVector(up, ey * scale);
    }
    return { pos: look.clone().addScaledVector(dir, d).toArray(), look: look.toArray(), fov };
  }
  function computeOverview() {
    const y = 0.03;
    const pts = [
      new THREE.Vector3(LAY.x0 - 0.01, y, LAY.z0 - 0.02), new THREE.Vector3(LAY.x0 + LAY.w + 0.01, y, LAY.z0 - 0.02),
      new THREE.Vector3(LAY.x0 - 0.01, 0, LAY.z0 + LAY.h + 0.02), new THREE.Vector3(LAY.x0 + LAY.w + 0.01, 0, LAY.z0 + LAY.h + 0.02),
      // колесо целиком, с деревянным бортиком чаши и небольшим запасом — владелец любит его больше всего
      ...Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * TAU, R = GEOM.bowlR + 0.045;
        return new THREE.Vector3(WHEEL_POS.x + Math.cos(a) * R, WHEEL_POS.y + GEOM.bowlTopY, WHEEL_POS.z + Math.sin(a) * R);
      }),
      new THREE.Vector3(TRAY.x, 0.03, TRAY.z - TRAY.d / 2),
    ];
    overviewFit = fitShot(pts, THREE.MathUtils.degToRad(64), THREE.MathUtils.degToRad(Number(opts.overviewYaw) || 0), 35);
  }
  function overviewShot(tl) {
    if (!overviewFit) computeOverview();
    const drift = [Math.sin(tl * 0.00007) * 0.03, Math.sin(tl * 0.00005) * 0.015, Math.cos(tl * 0.00006) * 0.02];
    const o = overviewFit;
    return { pos: [o.pos[0] + drift[0], o.pos[1] + drift[1], o.pos[2] + drift[2]], look: o.look, fov: o.fov };
  }
  function wheelShot(push) {
    const a = camera.aspect;
    const k = Math.pow(Math.max(1, 1.5 / a), 0.8) * Math.pow(fitK(), 0.7);
    const o = [lerp(0.36, 0.26, push), lerp(1.02, 0.84, push), lerp(0.86, 0.72, push)];
    return { pos: [C.x + o[0] * k, C.y + o[1] * k, C.z + o[2] * k], look: [C.x + 0.12, C.y - 0.04, C.z + 0.03], fov: 34 };
  }
  function tableShot(n) {
    const [x, z] = n != null ? cellCenter(n) : [LAY.x0 + LAY.w / 2, LAY.z0 + LAY.h / 2];
    const lx = lerp(x, LAY.x0 + LAY.w / 2, 0.45);
    const a = camera.aspect;
    const k = Math.pow(Math.max(1, 1.6 / a), 0.85) * Math.pow(fitK(), 0.8);
    return { pos: [lx + 0.02, 1.02 * k, z + 0.78 * k], look: [lx, 0, z - 0.02], fov: 36 };
  }

  // ---------- кадр ----------
  const tmpV = new THREE.Vector3();
  const ballLocal = new THREE.Vector3();
  let lastL = 0;
  let lastHum = 0;

  function ballAt(sp, t, W) {
    // возвращает локальные координаты шарика в системе колеса и данные сэмпла
    const tr = sp.traj;
    if (t < tr.times.launch) {
      const s = tr.sample(t);
      const hand = [s.r * Math.cos(s.theta), s.y, s.r * Math.sin(s.theta)];
      if (sp.pick && t < sp.pick.b) {
        const k = smooth((t - sp.pick.a) / (sp.pick.b - sp.pick.a));
        const th = W + sp.pick.phi;
        const rest = [GEOM.pocketR * Math.cos(th), GEOM.floorY + GEOM.ballR, GEOM.pocketR * Math.sin(th)];
        return { p: [lerp(rest[0], hand[0], k), lerp(rest[1], hand[1], k) + Math.sin(Math.PI * k) * 0.07, lerp(rest[2], hand[2], k)], s, shown: true, air: true };
      }
      // замах: шарик в руке чуть уходит назад по треку и уже с ходом вперёд срывается в бросок — без мёртвой паузы
      const w0 = sp.pick ? sp.pick.b : Math.max(150, sp.tCall);
      const k = clamp((t - w0) / (tr.times.launch - w0), 0, 1);
      const d = -0.06 * 6.75 * k * k * (1 - k);
      const th = s.theta + d;
      return { p: [s.r * Math.cos(th), s.y, s.r * Math.sin(th)], s, shown: sp.pick ? true : t > 150, air: true };
    }
    const s = tr.sample(t);
    return { p: [s.r * Math.cos(s.theta), s.y, s.r * Math.sin(s.theta)], s, shown: true, air: s.air };
  }

  function fire(sp, e, s) {
    sp.fired.add(e);
    const loud = !dbg.silent && sound.live;
    const pitch = s && s.rate < 0.9 ? 0.78 : 1;
    const g = (x) => Math.max(0.05, x);
    switch (e.type) {
      case "launch": if (loud) sound.whoosh(); break;
      case "diamond": if (loud) sound.clack(g(e.strength || 1), 0, pitch); break;
      case "rotor": if (loud) sound.tuk(0.9, 0, pitch * 0.9); break;
      case "fret": if (loud) sound.tuk(g(e.strength || 0.6), 0, pitch); break;
      case "fakeLand": case "land": if (loud) { sound.tuk(g((e.strength || 0.6) * 0.8), 0, pitch); } break;
      case "tap": if (loud) sound.tuk(0.25, 0, pitch * 1.1); break;
      case "rest":
        if (loud) sound.settle(0.7);
        // ложная посадка: ячейка уже будто выиграла
        if (sp.traj.fakeIdx != null) setGlow(((sp.traj.fakeIdx % POCKETS) + POCKETS) % POCKETS, 0.55);
        break;
      case "hopOut": if (loud) sound.tuk(0.7, 0, pitch); setGlow(-1, 0); break;
      case "settle":
        if (loud) sound.settle(1);
        setGlow(sp.traj.target, 0.5);
        if (!sp.landed) { sp.landed = true; emit("land", { number: Number(sp.res.number), at: sp.spinAt + e.t }); }
        break;
    }
    emit("sfx", { type: e.type, t: e.t });
  }
  function setGlow(idx, level) {
    const G = st.glow;
    if (idx >= 0 && idx !== G.idx) {
      G.idx = idx;
      G.level = 0;
      const n = WHEEL[idx];
      G.color.setHex(GLOW_COLOR[numColor(n)]);
      const a = idx * PA;
      W3.glow.position.set(GEOM.pocketR * Math.cos(a), GEOM.floorY + 0.0015, GEOM.pocketR * Math.sin(a));
      W3.glowLight.position.set(GEOM.pocketR * Math.cos(a), GEOM.floorY + 0.02, GEOM.pocketR * Math.sin(a));
    }
    G.target = level;
  }

  function reveal(sp) {
    sp.revealed = true;
    emit("reveal", { number: Number(sp.res.number), at: sp.revealAt });
    setGlow(sp.traj.target, 1);
    st.glow.level = 1.4; // вспышка поверх и спад к 1
    showWinner(Number(sp.res.number), "both");
    const story = sp.story || {};
    const n = Number(sp.res.number);
    if (n === 0 || story.zero) st.effects.green = 1;
    if (story.jackpot) {
      st.effects.gold = 1;
      W3.glow.getWorldPosition(tmpV);
      sparks.burst(tmpV.x, tmpV.y + 0.01, tmpV.z);
      if (!dbg.silent) sound.coins(80);
    }
    if (story.save && story.save.length) sp.saveAt = nowL() + 350;
    if (!dbg.silent && sound.live) sound.settle(0.5, 0);
  }

  function update(dt) {
    const ns = nowS(), nl = nowL();
    const sp = st.spin;
    let W;
    let ball = null;
    let t = 0;
    if (sp && st.mode !== "idle") {
      t = ns - sp.spinAt;
      W = spinWheelAngle(sp, t);
      ball = ballAt(sp, t, W);
      // события траектории
      for (const e of sp.traj.events) if (!sp.fired.has(e) && e.t <= t) fire(sp, e, ball.s);
      if (!sp.revealed && ns >= sp.revealAt) reveal(sp);
      if (sp.saveAt && nl >= sp.saveAt) { sp.saveAt = 0; st.effects.flash = 1; emit("sfx", { type: "save" }); }
      // гул
      const s = ball.s;
      const surface = s.phase === "rim" || s.phase === "slope" ? "wood" : "rotor";
      const v = t < sp.traj.times.launch ? 0 : s.rolling;
      if (!dbg.silent) sound.hum(v, surface, s.rate);
      // ва-банк: зал стихает от схода с трека до посадки
      const allin = sp.story && Array.isArray(sp.story.allin) && sp.story.allin.length > 0;
      const quiet = allin && t > sp.traj.times.drop - 800 && t < sp.traj.times.settle + 1200;
      if (sound.ctx && (quiet ? 0.08 : 1) !== sound.duck) sound.setDuck(quiet ? 0.08 : 1);
    } else {
      st.wheelV += (IDLE_SPEED - st.wheelV) * Math.min(1, dt * 0.35);
      st.wheelA -= st.wheelV * dt;
      W = st.wheelA;
      if (sound.ctx && nl - lastHum > 200) { sound.hum(0, "rotor"); lastHum = nl; if (sound.duck !== 1) sound.setDuck(1); }
    }
    W3.rotor.rotation.y = -W;

    // шарик
    if (ball) {
      ballLocal.set(ball.p[0], ball.p[1], ball.p[2]);
      W3.ball.visible = ball.shown;
    } else {
      const th = W + st.ballPhi;
      ballLocal.set(GEOM.pocketR * Math.cos(th), GEOM.floorY + GEOM.ballR, GEOM.pocketR * Math.sin(th));
      W3.ball.visible = st.ballShown;
    }
    W3.ball.position.copy(ballLocal);
    const r = Math.hypot(ballLocal.x, ballLocal.z);
    const sy = surfaceY(r);
    if (sy != null && W3.ball.visible) {
      W3.contact.visible = true;
      W3.contact.position.set(ballLocal.x, sy + 0.0009, ballLocal.z);
      const h = ballLocal.y - GEOM.ballR - sy;
      W3.contact.material.opacity = 0.6 * clamp(1 - h / 0.035, 0, 1);
      const sc = 1 + clamp(h / 0.035, 0, 1) * 0.6;
      W3.contact.scale.set(sc, sc, sc);
    } else W3.contact.visible = false;
    // шлейф
    const fast = ball && ball.s && (ball.s.phase === "rim" || ball.s.phase === "slope") && level > 0;
    for (let k = 0; k < W3.ghosts.length; k++) {
      const gm = W3.ghosts[k];
      if (!fast || ball.s.rolling < 1.3) { gm.visible = false; continue; }
      const s2 = sp.traj.sample(t - (k + 1) * 6);
      gm.visible = true;
      gm.position.set(s2.r * Math.cos(s2.theta), s2.y, s2.r * Math.sin(s2.theta));
      gm.material.opacity = 0.2 * (1 - k / W3.ghosts.length) * clamp((ball.s.rolling - 1.3) / 1.8, 0, 1);
      const sc = 1 - k * 0.06;
      gm.scale.set(sc, sc, sc);
    }

    // свечение ячейки
    const G = st.glow;
    G.level += (G.target - G.level) * Math.min(1, dt * (G.level > G.target ? 1.6 : 9));
    const pulse = G.target >= 1 ? 0.85 + 0.15 * Math.sin(nl * 0.006) : 1;
    W3.glow.material.opacity = clamp(G.level, 0, 1.5) * 0.85 * pulse;
    W3.glow.material.color.copy(G.color).multiplyScalar(4); // аддитивное пятно ярче цвета ячейки — видно и на красном
    W3.glowLight.color.copy(G.color);
    W3.glowLight.intensity = G.level * 0.14 * pulse;
    W3.glow.visible = G.level > 0.01;
    // выпавший номер пульсирует: вспышка при появлении, потом ровное «дыхание» раз в ~1,2 с
    if (win.n != null) {
      const age = (nl - win.t0) / 1000;
      const beat = 0.5 + 0.5 * Math.sin(age * 5.2);
      const pop = Math.max(0, 1 - age / 0.6);
      W3.numHL.visible = win.wheel;
      W3.numHL.material.color.setScalar(0.9 + 0.25 * beat + 0.6 * pop);
      cellHL.visible = win.table;
      cellHL.material.opacity = smooth(age / 0.35);
      cellHL.material.color.setScalar(0.82 + 0.3 * beat + 0.4 * pop);
      cellLight.intensity = win.table ? (0.22 + 0.12 * beat) * smooth(age / 0.35) : 0;
      cellHalo.visible = ripple.visible = win.table;
      haloMat.opacity = (0.55 + 0.35 * beat) * smooth(age / 0.35);
      const ph = (age % 1.25) / 1.25;
      ripple.scale.setScalar(win.rip + ph * 0.12); // волна небольшая: не должна заходить на колесо
      ripple.material.opacity = (1 - ph) * (1 - ph) * 0.9;
    }

    // свет: во время спина стол уходит в полутень, зеро красит лампу зелёным, джекпот — золото
    const spinning = st.mode === "spin" && t > -600 && !(sp && sp.revealed && t > sp.revealAt - sp.spinAt + 1500);
    st.tableDim += ((spinning ? 1 : 0) - st.tableDim) * Math.min(1, dt * 1.5);
    const E = st.effects;
    E.green = Math.max(0, E.green - dt * 0.35);
    E.gold = Math.max(0, E.gold - dt * 0.45);
    E.flash = Math.max(0, E.flash - dt * 2.2);
    lamp.intensity = 17 * (1 - 0.45 * st.tableDim) * (1 + E.flash * 0.8);
    wheelFill.intensity = 7 * (1 + 0.9 * st.tableDim) + E.gold * 10;
    lamp.color.copy(lampColor).lerp(new THREE.Color(0x6dff9e), E.green * 0.28);
    wheelFill.color.set(0xffc88e).lerp(new THREE.Color(0x4dff90), E.green * 0.5).lerp(new THREE.Color(0xffd36a), E.gold * 0.6);

    // маркер
    if (st.pay && st.pay.dolly) {
      const d = st.pay.dolly;
      const k = clamp((nl - d.t0) / 450, 0, 1);
      const yb = k < 0.75 ? lerp(0.3, 0, (k / 0.75) ** 2) : Math.sin(((k - 0.75) / 0.25) * Math.PI) * 0.008;
      dolly.position.set(d.x, 0.0008 + yb, d.z);
      dolly.visible = nl >= d.t0;
      if (!d.clinked && k >= 0.75) { d.clinked = true; if (!dbg.silent) sound.clink(1, 0, 0.2); }
    }
    if (st.pay && !st.pay.slideStarted && nl >= st.pay.tSlide) startSlides(nl);
    if (st.pay && !st.pay.done && nl >= st.pay.tEnd) st.pay.done = true;

    pool.update(nl);
    dealer.update(nl);
    sparks.update(dt);

    // ---------- режиссёр камеры ----------
    let shot;
    let dof = 0;
    let wPos = 2.2;
    let wLook = 0;
    if (st.mode === "spin" && sp) {
      const T = sp.traj.times;
      const finale = !st.calm && t > T.drop - 250;
      const kk = Math.pow(Math.max(1, 1.5 / camera.aspect), 0.8) * Math.pow(fitK(), 0.7);
      const a0 = Math.atan2(0.86, 0.36);
      const aT = a0 + wrapPi(sp.side - a0);
      /*
       * Облёт начинается сразу с вызова spin(), а не с броска: иначе камера успевала доехать
       * от общего плана до колеса, почти замереть (0,01 м/с) и лишь потом снова тронуться —
       * это и читалось как «пауза при раскрутке». Теперь цель движется всё время, пружина её догоняет.
       */
      const t0 = clamp(sp.tCall, -12000, T.launch - 500);
      if (st.calm && !finale) {
        const push = smooth((t - t0) / Math.max(1, T.drop - t0)) * 0.6 + smooth((t - T.drop) / 2500) * 0.4;
        shot = wheelShot(push);
        shotName = "wheel";
      } else if (!finale) {
        /*
         * Круги по треку: камера плавно облетает колесо и опускается к той стороне,
         * где потом будут отскоки (режиссёр знает траекторию заранее). Медленно — за всё время до схода,
         * поэтому к падению шарика камера уже на месте и не мечется за ним.
         */
        const u = smooth((t - t0) / Math.max(1, T.drop - 250 - t0));
        const al = lerp(a0, aT, u);
        const R = lerp(0.932 * kk, 0.74, u), y = lerp(1.02 * kk, 0.56, u);
        shot = { pos: [C.x + Math.cos(al) * R, C.y + y, C.z + Math.sin(al) * R], look: [C.x + 0.12 * (1 - u), C.y - 0.04, C.z + 0.03 * (1 - u)], fov: lerp(34, 32, u) };
        shotName = "wheel";
        orbit.set([al]);
        sp.orbitInit = true;
      } else {
        // Финал: камера у обода на стороне отскоков, дальше ведёт шарик
        const th = ball.s.theta;
        // после касания ротора орбита ведёт сам шарик (с запаздыванием пружины), до него — место отскоков
        const track = wrapPi(th - sp.side);
        if (!sp.orbitInit) { orbit.set([aT]); sp.orbitInit = true; } // переподключились прямо в финал
        const jump = T.jumpStart != null && t > T.jumpStart - 50 && t < T.jumpEnd + 250;
        // после посадки камера «замирает на ячейке»: держит её в кадре и едет вместе с ротором
        const settled = t > T.settle - 150;
        /*
         * Пружина, догоняющая движущуюся цель, отстаёт на 2v/ω — при шарике на роторе это целый радиан,
         * и шарик уезжал на дальнюю сторону. Поэтому к цели добавляем упреждение по сглаженной скорости.
         */
        const vRaw = sp.prevTh != null && dt > 0 ? wrapPi(th - sp.prevTh) / dt : 0;
        sp.prevTh = th;
        sp.vs = (sp.vs || 0) + (clamp(vRaw, -8, 8) - (sp.vs || 0)) * Math.min(1, dt * 4);
        const wO = jump ? 1.2 : settled ? 3.2 : 2.2;
        const lead = t > T.rotor - 200 ? (sp.vs * 2) / wO : 0;
        const a = orbit.step([aT + (t > T.rotor - 200 ? track : 0) + lead], dt, wO)[0];
        const slow = clamp(Math.min((t - T.slowStart) / 200, (T.slowEnd + 150 - t) / 300), 0, 1);
        const lift = smooth((t - T.settle + 150) / 1200);
        const dive = smooth((t - T.drop + 250) / 900); // от «кругового» плана вниз к ободу
        const Rc = lerp(lerp(0.74, lerp(0.6, 0.5, slow), dive), 0.56, lift);
        const yc = lerp(lerp(0.56, lerp(0.3, 0.21, slow), dive), 0.42, lift);
        const wp = W3.wheel.localToWorld(tmpV.copy(ballLocal));
        // до касания ротора смотрим на место будущих отскоков, потом — на шарик
        const onBall = smooth((t - (T.rotor - 600)) / 500);
        const ax = C.x + Math.cos(sp.side) * GEOM.pocketR * dive, az = C.z + Math.sin(sp.side) * GEOM.pocketR * dive;
        shot = {
          pos: [C.x + Math.cos(a) * Rc, C.y + yc, C.z + Math.sin(a) * Rc],
          look: [lerp(ax, wp.x, onBall), lerp(C.y - 0.045, wp.y, onBall * 0.8), lerp(az, wp.z, onBall)],
          fov: lerp(lerp(32, lerp(30, 25, slow), dive), 30, lift),
        };
        // гладкость здесь даёт пружина орбиты; позиция и взгляд идут за целью почти без запаздывания
        wLook = 9;
        shotName = lift > 0.3 ? "freeze" : slow > 0.1 ? "slow" : "follow";
        wPos = lerp(2.5, 9, dive);
        dof = 0.75 * dive * (1 - lift * 0.6);
      }
    } else if (st.mode === "payout" && st.pay) {
      const age = nl - st.pay.t0;
      if (st.calm || age > 4200) { shot = overviewShot(nl); shotName = "overview"; }
      else { shot = tableShot(st.pay.number); shotName = "table"; }
    } else { shot = overviewShot(nl); shotName = "overview"; }
    if (dbg.cam) {
      const c = dbg.cam;
      shot = { pos: [C.x + c[0], C.y + c[1], C.z + c[2]], look: [C.x + c[3], C.y + c[4], C.z + c[5]], fov: c[6] || 35 };
      camPos.set(shot.pos); camLook.set(shot.look); camFov.set([shot.fov]);
    }
    const p = camPos.step(shot.pos, dt, wPos);
    const l = camLook.step(shot.look, dt, wLook || wPos);
    const f = camFov.step([shot.fov], dt)[0];
    camera.position.set(p[0], p[1], p[2]);
    camera.lookAt(l[0], l[1], l[2]);
    if (Math.abs(camera.fov - f) > 1e-4) { camera.fov = f; camera.updateProjectionMatrix(); }

    dealer.updateClip(camera, 1 - 2 * safe.top);

    // глубина резкости: фокус на шарике
    const dofOn = level >= 2 && !st.calm;
    post.amount += ((dofOn ? dof : 0) - post.amount) * Math.min(1, dt * 3);
    if (post.amount > 0.02) {
      W3.wheel.localToWorld(tmpV.copy(ballLocal)).project(camera);
      post.focus.set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5);
    }
    syncTags(dt);
  }

  function render() {
    if (post.amount > 0.02) post.render(scene, camera);
    else renderer.render(scene, camera);
  }

  // ---------- качество и цикл ----------
  function applyLevel(lv) {
    level = lv;
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(lv === 2 ? Math.min(dpr, 2) : lv === 1 ? Math.min(dpr, 1.5) : 1);
    const ms = lv === 2 ? 2048 : 1024;
    if (lamp.shadow.mapSize.x !== ms) {
      lamp.shadow.mapSize.set(ms, ms);
      if (lamp.shadow.map) { lamp.shadow.map.dispose(); lamp.shadow.map = null; }
    }
    const type = lv === 0 ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    if (renderer.shadowMap.type !== type) { renderer.shadowMap.type = type; renderer.shadowMap.needsUpdate = true; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); }
    resize();
  }
  function resize() {
    const w = Math.max(1, container.clientWidth || window.innerWidth), h = Math.max(1, container.clientHeight || window.innerHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.setViewOffset(w, h, ((safe.right - safe.left) / 2) * w, ((safe.bottom - safe.top) / 2) * h, w, h);
    camera.updateProjectionMatrix();
    overviewFit = null; // пересчитать общий план под новый размер
    const pr = renderer.getPixelRatio();
    post.setSize(Math.round(w * pr), Math.round(h * pr));
  }

  let raf = 0, running = true, disposed = false;
  const perf = { ema: 16.7, bad: 0, since: 0, cool: 0, fps: 60, frames: 0, acc: 0, cpu: 0 };
  function frame() {
    raf = 0;
    if (disposed || !running) return;
    const nl = performance.now();
    const dtMs = lastL ? nl - lastL : 16.7;
    lastL = nl;
    const dt = clamp(dtMs / 1000, 0, 0.1);
    if (!dbg.time) {
      const c0 = performance.now();
      update(dt);
      render();
      const spent = performance.now() - c0;
      perf.cpu += (spent - perf.cpu) * 0.05; // время JS на кадр (без ожидания GPU)
      if (dbg.trace) {
        // стенд: покадровая запись движения — ловить рывки и провалы скорости
        const bw = W3.wheel.localToWorld(tmpV.copy(W3.ball.position));
        dbg.trace.push([nl, dtMs, spent, nowS() - (st.spin ? st.spin.spinAt : 0), -W3.rotor.rotation.y, bw.x, bw.y, bw.z, camera.position.x, camera.position.y, camera.position.z, renderer.info.programs.length, shotName, W3.ball.visible ? 1 : 0]);
      }
    }
    // автоснижение качества: кадр стабильно дольше 20 мс
    perf.frames++;
    perf.acc += dtMs;
    if (perf.acc >= 1000) { perf.fps = (perf.frames * 1000) / perf.acc; perf.frames = 0; perf.acc = 0; }
    perf.ema += (dtMs - perf.ema) * 0.05;
    perf.since += dtMs;
    if (QP.auto && !dbg.time && perf.since > 3000 && nl > perf.cool) {
      if (perf.ema > 20 && dtMs < 250) perf.bad++;
      else perf.bad = Math.max(0, perf.bad - 2);
      if (perf.bad > 90 && level > 0) {
        applyLevel(level - 1);
        perf.bad = 0;
        perf.cool = nl + 4000;
        emit("quality", { level });
      }
    }
    raf = requestAnimationFrame(frame);
  }
  function onVis() {
    if (document.hidden) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    else if (!running) {
      running = true; lastL = 0; perf.since = 0;
      // вкладка снова видна: сразу кадр с досчитанными (по времени) анимациями — фишки не «висят в воздухе»
      if (!dbg.time) { try { update(0.1); render(); } catch (e) { console.error(e); } }
      raf = requestAnimationFrame(frame);
    }
  }
  document.addEventListener("visibilitychange", onVis);
  // контейнер может менять размер и без resize окна (раскладка страницы)
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(container);
  applyLevel(level);
  // прогрев: компилируем шейдеры сцены и глубины резкости заранее, иначе первый финал дёрнется
  // (руки, лопатка, маркер, шлейф, свечения и искры скрыты — на прогреве показываем всё на один кадр)
  try {
    const hidden = [];
    scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    // и оба варианта шейдеров: на экран (с тонмаппингом) и в буфер глубины резкости (линейный) —
    // иначе при первом «полёте за шариком» компилировались недостающие варианты (~70 мс на M1)
    renderer.setRenderTarget(post.rtScene);
    renderer.compile(scene, camera);
    renderer.setRenderTarget(null);
    renderer.compile(scene, camera);
    // обзорная камера сверху — чтобы в кадр попало всё, включая то, что вне общего плана
    const wide = new THREE.PerspectiveCamera(80, 1.6, 0.05, 20);
    wide.position.set(-0.3, 2.6, 0.6);
    wide.lookAt(-0.3, 0, -0.05);
    post.render(scene, wide);
    renderer.render(scene, wide);
    post.render(scene, camera);
    renderer.render(scene, camera);
    for (const o of hidden) o.visible = false;
  } catch (e) { /* не критично */ }
  raf = requestAnimationFrame(frame);

  // ---------- API ----------
  const api = {
    setIdle() {
      if (st.mode === "idle") return;
      const ns = nowS();
      if (st.spin) {
        const t = ns - st.spin.spinAt;
        st.wheelA = spinWheelAngle(st.spin, t);
        st.wheelV = Math.abs(st.spin.traj.wheelSpeed(Math.max(0, t)));
        if (t >= st.spin.traj.times.launch) { st.ballPhi = st.spin.traj.finalPhi; st.ballShown = true; }
      }
      finishPayout();
      st.mode = "idle";
      dolly.visible = false;
      setGlow(-1, 0);
      clearWinner();
    },
    setBets(players, unit) {
      if (unit > 0) opts.chipUnit = unit;
      if (st.mode === "payout" && st.pay && !st.pay.done) return;
      if (st.mode === "payout") { finishPayout(); st.mode = "idle"; dolly.visible = false; setGlow(-1, 0); clearWinner(); }
      syncStacks(players || [], false);
    },
    noMoreBets() {
      dealer.sweep(nowL());
      if (!dbg.silent) sound.swish(250, 0.9);
    },
    spin,
    payout,
    setCalm(b) { st.calm = !!b || reduce; },
    setMuted(m) { sound.setMuted(m); },
    resize,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      if (ro) ro.disconnect();
      sound.dispose();
      post.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of ms) { for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); }
      });
      if (scene.environment) scene.environment.dispose();
      renderer.dispose();
      cv.remove();
      vig.remove();
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); }; },
    get mode() { return "webgl"; },
    // для стенда roulette-wheel-lab.html: детерминированный кадр в заданный момент
    _debug: {
      get traj() { return st.spin && st.spin.traj; },
      get fps() { return perf.fps; },
      get cpu() { return perf.cpu; },
      traceStart() { dbg.trace = []; },
      progs() { return renderer.info.programs.map((p) => p.name + "|" + p.cacheKey); },
      traceStop() { const t = dbg.trace; dbg.trace = null; return t; },
      get level() { return level; },
      get shot() { return shotName; },
      setLevel(lv) { applyLevel(clamp(lv, 0, 2)); },
      // прогоняет обновления с шагом 1/60 с между двумя моментами (серверным и локальным), затем рисует
      simulate(s0, s1, l0) {
        dbg.silent = true;
        const step = 1000 / 60;
        const n = Math.max(1, Math.ceil((s1 - s0) / step));
        for (let i = 0; i <= n; i++) {
          dbg.time = { s: s0 + i * step, l: l0 + i * step };
          update(i === 0 ? 0 : step / 1000);
        }
        render();
      },
      freeze(s, l) { dbg.time = { s, l }; dbg.silent = true; },
      unfreeze() { dbg.time = null; dbg.silent = false; lastL = 0; },
      renderNow() { render(); },
      get parts() { return W3; },
      // сколько фишек ещё в полёте и сколько всего — стенд проверяет, что после скрытой вкладки всё осело
      get chips() { return { total: pool.list.length, moving: pool.list.filter((c) => c.anim).length, tags: tags.size }; },
      get glow() { return { idx: st.glow.idx, level: st.glow.level, target: st.glow.target, vis: W3.glow.visible, op: W3.glow.material.opacity, pos: W3.glow.position.toArray(), light: W3.glowLight.intensity }; },
      // камера стенда относительно центра колеса: [x, y, z, lookX, lookY, lookZ, fov]
      cam(c) { dbg.cam = c; },
      sound,
    },
  };
  return api;
}

// ---------- запасной путь без WebGL: 2D-колесо сверху с той же траекторией и тем же таймингом ----------

function createFallback(container, opts) {
  const nowS = () => (opts.now ? opts.now() : Date.now());
  const cv = document.createElement("canvas");
  cv.style.cssText = "display:block;width:100%;height:100%";
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  container.appendChild(cv);
  const g = cv.getContext("2d");
  const sound = new Sound();
  const listeners = {};
  const emit = (ev, d) => { for (const fn of listeners[ev] || []) { try { fn(d); } catch (e) { console.error(e); } } };
  const st = { mode: "idle", wheelA: 0, wheelV: IDLE_SPEED, ballPhi: 0, spin: null, bets: [], pay: null, calm: true };
  let W = 1, H = 1, dpr = 1, geo = null;
  const layC = layoutCanvas(opts.lang || "ru");

  // статичные слои колеса рисуем один раз на размер
  function layers() {
    const R = geo.R;
    const S = Math.ceil(R * 2 * dpr);
    const stator = canvas(S, S), rotor = canvas(S, S);
    const a = stator.getContext("2d"), b = rotor.getContext("2d");
    const k = (R * dpr) / GEOM.bowlR;
    a.translate(S / 2, S / 2);
    const wood = a.createRadialGradient(0, 0, GEOM.statorInnerR * k, 0, 0, GEOM.bowlR * k);
    wood.addColorStop(0, "#2a140a"); wood.addColorStop(0.8, "#4a2614"); wood.addColorStop(1, "#1a0c05");
    a.fillStyle = wood;
    a.beginPath(); a.arc(0, 0, GEOM.bowlR * k, 0, TAU); a.fill();
    a.strokeStyle = "rgba(0,0,0,0.5)"; a.lineWidth = 2 * dpr;
    a.beginPath(); a.arc(0, 0, GEOM.trackWallR * k, 0, TAU); a.stroke();
    a.fillStyle = "#d9b56a";
    for (const dm of GEOM.diamonds) {
      a.save(); a.rotate(dm.a); a.translate(GEOM.diamondR * k, 0);
      a.beginPath(); a.moveTo(-dm.halfR * k, 0); a.lineTo(0, -dm.halfT * k); a.lineTo(dm.halfR * k, 0); a.lineTo(0, dm.halfT * k); a.closePath(); a.fill();
      a.restore();
    }
    b.translate(S / 2, S / 2);
    for (let i = 0; i < POCKETS; i++) {
      const n = WHEEL[i];
      const a0 = (i - 0.5) * PA, a1 = (i + 0.5) * PA;
      b.fillStyle = POCKET_RGB[numColor(n)];
      b.beginPath(); b.arc(0, 0, GEOM.rotorR * k, a0, a1); b.arc(0, 0, GEOM.pocketInnerR * k, a1, a0, true); b.closePath(); b.fill();
      b.strokeStyle = GOLD; b.lineWidth = 1.2 * dpr;
      b.beginPath(); b.moveTo(Math.cos(a1) * GEOM.pocketInnerR * k, Math.sin(a1) * GEOM.pocketInnerR * k); b.lineTo(Math.cos(a1) * GEOM.rotorR * k, Math.sin(a1) * GEOM.rotorR * k); b.stroke();
      b.save(); b.rotate(i * PA); b.translate(((GEOM.rotorR + GEOM.ringInnerR) / 2) * k, 0); b.rotate(Math.PI / 2);
      b.fillStyle = GOLD; b.font = `700 ${Math.round(0.022 * k)}px Georgia, serif`; b.textAlign = "center"; b.textBaseline = "middle";
      b.fillText(String(n), 0, 0); b.restore();
    }
    b.strokeStyle = GOLD;
    b.beginPath(); b.arc(0, 0, GEOM.ringInnerR * k, 0, TAU); b.stroke();
    const cone = b.createRadialGradient(0, 0, 0, 0, 0, GEOM.pocketInnerR * k);
    cone.addColorStop(0, "#c9a25c"); cone.addColorStop(0.35, "#5a2e17"); cone.addColorStop(1, "#3a1c0d");
    b.fillStyle = cone;
    b.beginPath(); b.arc(0, 0, GEOM.pocketInnerR * k, 0, TAU); b.fill();
    geo.stator = stator; geo.rotor = rotor; geo.k = k / dpr;
  }
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, container.clientWidth || window.innerWidth);
    H = Math.max(1, container.clientHeight || window.innerHeight);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const R = Math.min(H * 0.4, W * 0.2);
    const tw = W * 0.5, th = (tw * LAY.h) / LAY.w;
    geo = { R, cx: W * 0.24, cy: H * 0.47, tx: W * 0.45, ty: H * 0.47 - th / 2, tw, th };
    layers();
  }
  const tpt = (x, z) => [geo.tx + ((x - LAY.x0) / LAY.w) * geo.tw, geo.ty + ((z - LAY.z0) / LAY.h) * geo.th];

  function wheelAngle(ns) {
    const sp = st.spin;
    if (!sp || st.mode === "idle") return st.wheelA;
    const t = ns - sp.spinAt;
    return sp.wheel.angle(t);
  }
  let last = 0, raf = 0, disposed = false;
  function frame(nl) {
    raf = 0;
    if (disposed) return;
    const dt = last ? clamp((nl - last) / 1000, 0, 0.1) : 0.016;
    last = nl;
    const ns = nowS();
    const sp = st.spin;
    let Wa, ball = null, t = 0;
    if (sp && st.mode !== "idle") {
      t = ns - sp.spinAt;
      Wa = wheelAngle(ns);
      if (t >= sp.traj.times.launch - 300) ball = sp.traj.sample(t);
      for (const e of sp.traj.events) {
        if (sp.fired.has(e) || e.t > t) continue;
        sp.fired.add(e);
        const s = e.strength || 0.6;
        if (e.type === "launch") sound.whoosh();
        else if (e.type === "diamond") sound.clack(s);
        else if (e.type === "fret" || e.type === "rotor" || e.type === "land" || e.type === "fakeLand" || e.type === "hopOut") sound.tuk(s);
        else if (e.type === "settle") { sound.settle(1); if (!sp.landed) { sp.landed = true; emit("land", { number: Number(sp.res.number), at: sp.spinAt + e.t }); } }
        emit("sfx", { type: e.type });
      }
      if (!sp.revealed && ns >= sp.revealAt) { sp.revealed = true; st.win = Number(sp.res.number); st.winT = nl; emit("reveal", { number: Number(sp.res.number), at: sp.revealAt }); }
      if (ball) sound.hum(ball.rolling, ball.phase === "rim" || ball.phase === "slope" ? "wood" : "rotor", ball.rate);
    } else {
      st.wheelV += (IDLE_SPEED - st.wheelV) * Math.min(1, dt * 0.35);
      st.wheelA -= st.wheelV * dt;
      Wa = st.wheelA;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = g.createRadialGradient(W * 0.45, H * 0.4, 0, W * 0.45, H * 0.45, Math.max(W, H) * 0.7);
    bg.addColorStop(0, "#1f5a3b"); bg.addColorStop(0.7, "#113221"); bg.addColorStop(1, "#070504");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    // стол
    g.drawImage(layC.canvas, geo.tx, geo.ty, geo.tw, geo.th);
    const scale = geo.tw / LAY.w;
    for (const s of st.bets) {
      const [x, y] = tpt(s.x, s.z);
      let alpha = 1, dy = 0;
      if (st.pay) {
        const age = nl - st.pay.t0;
        if (s.lose) alpha = 1 - smooth((age - 900) / 700);
        else { dy = smooth((age - 3200) / 900) * (H - y); alpha = 1 - smooth((age - 3600) / 600); }
      }
      if (alpha <= 0) continue;
      g.globalAlpha = alpha;
      for (let i = 0; i < Math.min(s.count, 12); i++) {
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.beginPath(); g.arc(x + 1, y + dy - i * 2 + 2, CHIP.R * scale, 0, TAU); g.fill();
        g.fillStyle = s.color;
        g.beginPath(); g.arc(x, y + dy - i * 2, CHIP.R * scale, 0, TAU); g.fill();
        g.strokeStyle = "rgba(255,250,235,0.8)"; g.setLineDash([3, 3]); g.lineWidth = 2;
        g.beginPath(); g.arc(x, y + dy - i * 2, CHIP.R * scale * 0.8, 0, TAU); g.stroke(); g.setLineDash([]);
      }
      g.globalAlpha = 1;
    }
    // выпавший номер: клетка стола светится и пульсирует до новых ставок (на зеро — зелёным)
    const beat = st.win != null ? 0.5 + 0.5 * Math.sin(((nl - st.winT) / 1000) * 5.2) : 0;
    if (st.win != null) {
      const n = st.win, zero = n === 0;
      const [cx, cz] = cellCenter(n);
      const [x, y] = tpt(cx, cz);
      const w = (zero ? LAY.zeroW : LAY.cw) * scale, h = (zero ? 3 * LAY.ch : LAY.ch) * scale;
      const edge = zero ? "#8dffc0" : "#ffd98a";
      g.save();
      g.fillStyle = zero ? `rgba(90,255,160,${0.25 + 0.2 * beat})` : `rgba(255,205,110,${0.25 + 0.2 * beat})`;
      g.fillRect(x - w / 2, y - h / 2, w, h);
      g.shadowColor = edge; g.shadowBlur = 14 + 10 * beat;
      g.strokeStyle = edge; g.lineWidth = 4;
      g.strokeRect(x - w / 2, y - h / 2, w, h);
      g.restore();
      g.fillStyle = "#f4ecd8";
      g.beginPath(); g.arc(x, y, CHIP.R * scale * 0.6, 0, TAU); g.fill();
    }
    // колесо
    const k = geo.k;
    g.drawImage(geo.stator, geo.cx - geo.R, geo.cy - geo.R, geo.R * 2, geo.R * 2);
    g.save(); g.translate(geo.cx, geo.cy); g.rotate(Wa);
    g.drawImage(geo.rotor, -geo.R, -geo.R, geo.R * 2, geo.R * 2);
    if (st.win != null) {
      // сектор выпавшего номера: яркая рамка по ячейке и номеру
      const i = WHEEL.indexOf(st.win), a0 = (i - 0.5) * PA, a1 = (i + 0.5) * PA;
      g.save();
      g.shadowColor = st.win === 0 ? "#8dffc0" : "#ffd98a"; g.shadowBlur = 12 + 10 * beat;
      g.strokeStyle = g.shadowColor; g.lineWidth = 3 + 2 * beat;
      g.fillStyle = `rgba(255,240,200,${0.18 + 0.2 * beat})`;
      g.beginPath(); g.arc(0, 0, GEOM.rotorR * k, a0, a1); g.arc(0, 0, GEOM.pocketInnerR * k, a1, a0, true); g.closePath();
      g.fill(); g.stroke();
      g.restore();
    }
    g.restore();
    let bx, by, bs;
    if (ball) { bx = geo.cx + Math.cos(ball.theta) * ball.r * k; by = geo.cy + Math.sin(ball.theta) * ball.r * k; bs = 1 + (ball.y - (GEOM.floorY + GEOM.ballR)) * 9; }
    else { const th = Wa + st.ballPhi; bx = geo.cx + Math.cos(th) * GEOM.pocketR * k; by = geo.cy + Math.sin(th) * GEOM.pocketR * k; bs = 1; }
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.beginPath(); g.arc(bx + 2 * bs, by + 3 * bs, GEOM.ballR * k, 0, TAU); g.fill();
    const bgr = g.createRadialGradient(bx - 2, by - 2, 0, bx, by, GEOM.ballR * k * bs);
    bgr.addColorStop(0, "#fff"); bgr.addColorStop(1, "#cfc6b4");
    g.fillStyle = bgr;
    g.beginPath(); g.arc(bx, by, GEOM.ballR * k * bs, 0, TAU); g.fill();
    raf = requestAnimationFrame(frame);
  }
  function syncBets(players, keep) {
    const out = [];
    let minA = Infinity;
    for (const p of players || []) for (const a of Object.values(p.bets || {})) if (a > 0) minA = Math.min(minA, a);
    const byKey = new Map();
    for (const p of players || []) for (const [key, a] of Object.entries(p.bets || {})) {
      if (!(a > 0) || !betNumbers(key).length) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ p, a });
    }
    for (const [key, arr] of byKey) {
      const [bx, bz] = betPos(key);
      arr.forEach(({ p, a }, i) => {
        const n = arr.length;
        const off = n > 1 ? [Math.cos((i / n) * TAU) * 0.014, Math.sin((i / n) * TAU) * 0.014] : [0, 0];
        out.push({ key, pid: p.id, color: p.color || "#ccc", x: bx + off[0], z: bz + off[1], count: Math.max(1, Math.min(12, Math.round(a / (opts.chipUnit || minA)))) });
      });
    }
    st.bets = out;
    void keep;
  }
  resize();
  raf = requestAnimationFrame(frame);
  const onVis = () => { if (!document.hidden && !raf && !disposed) { last = 0; raf = requestAnimationFrame(frame); } };
  document.addEventListener("visibilitychange", onVis);
  return {
    setIdle() {
      if (st.spin && st.mode !== "idle") {
        const ns = nowS();
        st.wheelA = wheelAngle(ns);
        st.ballPhi = st.spin.traj.finalPhi;
      }
      st.mode = "idle";
      st.pay = null;
      st.win = null;
    },
    setBets(players, unit) { if (unit > 0) opts.chipUnit = unit; if (st.pay && nowS() - st.pay.at < 4500) return; st.pay = null; syncBets(players); },
    noMoreBets() { sound.swish(200, 0.8); },
    spin(result) {
      if (!result) return;
      const key = `${result.seed}|${result.spinAt}|${result.number}`;
      if (st.spin && st.spin.key === key && st.mode === "spin") return;
      const ns = nowS();
      const spinAt = Number(result.spinAt) || ns, revealAt = Number(result.revealAt) || spinAt + 10000;
      let traj;
      try { traj = buildTrajectory({ number: Number(result.number), seed: Number(result.seed), story: result.story || {}, spinMs: revealAt - spinAt }); } catch (e) { console.error(e); return; }
      const cur = wheelAngle(ns);
      const tCall = ns - spinAt;
      const sp = { key, res: result, traj, spinAt, revealAt, fired: new Set() };
      sp.wheel = wheelHandoff(traj, cur, st.spin && st.mode !== "idle" ? undefined : -st.wheelV, tCall);
      for (const e of traj.events) if (e.t < tCall - 250) sp.fired.add(e);
      st.spin = sp;
      st.mode = "spin";
      st.win = null;
      st.pay = null;
    },
    payout(d) {
      if (!d) return;
      if (d.players) syncBets(d.players);
      const number = Number(d.number);
      for (const s of st.bets) s.lose = !betNumbers(s.key).includes(number);
      st.pay = { number, t0: performance.now(), at: nowS() };
      if (st.win !== number) { st.win = number; st.winT = performance.now(); }
      st.mode = "payout";
      sound.swish(900, 0.6);
      sound.clink(4, 2600, 0.16);
    },
    setCalm() {},
    setMuted(m) { sound.setMuted(m); },
    resize,
    dispose() { disposed = true; if (raf) cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); sound.dispose(); cv.remove(); },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); }; },
    get mode() { return "2d"; },
    _debug: { get traj() { return st.spin && st.spin.traj; }, get fps() { return 60; }, get level() { return -1; }, get shot() { return "2d"; }, setLevel() {}, sound },
  };
}

// ---------- вход ----------

/*
 * opts: { now: () => серверные мс, calm, quality: "auto"|"high"|"low", lang, chipUnit?, safeArea?: {top,right,bottom,left} в долях экрана, force2d? }
 * Без WebGL2 (или если 3D не собралось) — тот же API на 2D-канве.
 */
export function createRouletteScene(container, opts = {}) {
  if (!opts.force2d && webglOk()) {
    try {
      // ручка для отладки со стенда и из DevTools: window.__rouletteScene._debug
      return (window.__rouletteScene = create3D(container, opts));
    } catch (e) {
      console.error("[roulette] 3D не запустилось, рисуем 2D", e);
      container.querySelectorAll("canvas").forEach((c) => c.remove());
    }
  }
  return (window.__rouletteScene = createFallback(container, opts));
}
