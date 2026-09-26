/*
 * Траектория шарика рулетки (roulette-spec.md §7.2). Чистый модуль: без DOM и three.js,
 * его же гоняет node-тест roulette/test-trajectory.js.
 *
 * Это не свободная физика, а путь, построенный назад от результата: число уже выбрано сервером,
 * а шарик доводится до ячейки правдоподобной цепочкой — круги по треку, скат, ромб, отскоки по фреткам.
 * Всё случайное берётся из сида, поэтому переподключившаяся доска строит ту же самую анимацию.
 *
 * Система координат (метры, локально к центру колеса, y вверх):
 *   x = r·cos(θ), z = r·sin(θ). При виде сверху (x вправо, z вниз по экрану) рост θ — по часовой стрелке.
 *   Шарик летит по часовой (+θ), ротор крутится против (W убывает).
 *   Ячейка WHEEL[i] в системе ротора лежит на угле φ = i·PA, в мире — θ = W + i·PA.
 *   В three.js это rotor.rotation.y = −W (поворот вокруг +y уводит +x к −z).
 *
 * Время: t — реальные мс от spinAt, τ — «физическое» время траектории. Они расходятся только
 * в окне замедления 0,4× на последнем отскоке (§7.3): замедление вшито сюда, чтобы все доски
 * показывали одно и то же, а шарик всё равно лёг к revealAt − 500 мс.
 */

const TAU = Math.PI * 2;

export const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const POCKETS = 37;
export const PA = TAU / POCKETS;
export const colorOf = (n) => (n === 0 ? "green" : RED.has(n) ? "red" : "black");
export const pocketIndex = (n) => WHEEL.indexOf(n);

/*
 * Геометрия колеса ~80 см: её же читает roulette-wheel.js, чтобы шарик и модель совпадали до миллиметра.
 * Высоты — центр шарика считается от них. Ромбы стоят на неподвижном склоне (статоре).
 */
export const GEOM = (() => {
  const g = {
    ballR: 0.0095,
    bowlR: 0.445, // внешний край деревянной чаши
    bowlTopY: 0.03,
    trackWallR: 0.395, // вертикальная стенка трека
    trackR: 0.3845, // центр шарика на треке
    statorOuterR: 0.395,
    statorOuterY: 0.0,
    statorInnerR: 0.268,
    statorInnerY: -0.038,
    rotorR: 0.263, // внешний край ротора (номерного кольца)
    ringOuterY: -0.04,
    ringInnerR: 0.227,
    ringInnerY: -0.047,
    pocketOuterR: 0.227,
    pocketInnerR: 0.166,
    pocketR: 0.197, // центр шарика в ячейке
    floorY: -0.0605,
    fretTopY: -0.049,
    fretW: 0.0022,
    coneTopR: 0.07,
    coneTopY: -0.012,
    diamondR: 0.325,
    diamondH: 0.008,
    diamonds: [],
  };
  // 8 ромбов: через один «вдоль» склона (длинная ось радиальная) и «поперёк» (длинная ось по кругу)
  for (let k = 0; k < 8; k++) {
    const radial = k % 2 === 0;
    g.diamonds.push({ a: (k * TAU) / 8 + TAU / 16, radial, halfR: radial ? 0.013 : 0.0055, halfT: radial ? 0.0055 : 0.013 });
  }
  return Object.freeze(g);
})();

export function statorY(r) {
  const g = GEOM;
  return g.statorInnerY + ((r - g.statorInnerR) * (g.statorOuterY - g.statorInnerY)) / (g.statorOuterR - g.statorInnerR);
}
export function ringY(r) {
  const g = GEOM;
  return g.ringInnerY + ((r - g.ringInnerR) * (g.ringOuterY - g.ringInnerY)) / (g.rotorR - g.ringInnerR);
}
const SLOPE_COS = Math.cos(Math.atan((GEOM.statorOuterY - GEOM.statorInnerY) / (GEOM.statorOuterR - GEOM.statorInnerR)));

// центр шарика на склоне и в ячейке
const Y_SLOPE = (r) => statorY(r) + GEOM.ballR / SLOPE_COS;
const Y_REST = GEOM.floorY + GEOM.ballR;
const Y_FRET = GEOM.fretTopY + GEOM.ballR; // шарик ровно на кромке фретки — точка удара
// сколько шарик может гулять по ячейке, не залезая на фретки
export const X_MAX = PA / 2 - (GEOM.ballR + GEOM.fretW / 2 + 0.0005) / GEOM.pocketR;

/*
 * Проверка «шарик не проходит сквозь фретку»: фретка — тонкая стенка на угле f.
 * Если центр шарика по горизонтали ближе ballR к стенке, он обязан быть выше её кромки.
 * Возвращает запас в метрах (<0 — пересечение). Та же формула стоит в тесте.
 */
export function fretClearance(phi, r, y) {
  const g = GEOM;
  if (r > g.pocketOuterR + g.ballR || r < g.pocketInnerR - g.ballR) return 1;
  const k = Math.round(phi / PA - 0.5);
  const f = (k + 0.5) * PA;
  const d = Math.abs(phi - f) * r - g.fretW / 2;
  if (d >= g.ballR) return 1;
  const need = g.fretTopY + Math.sqrt(g.ballR * g.ballR - Math.max(0, d) * Math.max(0, d));
  return y - need;
}

// ---------- окно замедления ----------

// Реальная длина окна 1,2 с: 150 мс спуск скорости до 0,4, 900 мс держим, 150 мс возврат.
export const SLOW = { ramp: 150, hold: 900, rate: 0.4 };
SLOW.real = SLOW.ramp * 2 + SLOW.hold;
SLOW.phys = SLOW.ramp * (1 + SLOW.rate) + SLOW.hold * SLOW.rate; // 570 мс физики
SLOW.extra = SLOW.real - SLOW.phys; // 630 мс — на столько реальное время обгоняет физическое

function makeWarp(tw0) {
  const { ramp, hold, rate } = SLOW;
  const k = (1 - rate) / (2 * ramp);
  const p1 = ramp - k * ramp * ramp;
  const p2 = p1 + rate * hold;
  const toTau = (t) => {
    const s = t - tw0;
    if (s <= 0) return t;
    if (s <= ramp) return tw0 + s - k * s * s;
    if (s <= ramp + hold) return tw0 + p1 + rate * (s - ramp);
    if (s <= SLOW.real) { const q = s - ramp - hold; return tw0 + p2 + rate * q + k * q * q; }
    return t - SLOW.extra;
  };
  const rateAt = (t) => {
    const s = t - tw0;
    if (s <= 0 || s >= SLOW.real) return 1;
    if (s <= ramp) return 1 - (1 - rate) * (s / ramp);
    if (s <= ramp + hold) return rate;
    return rate + (1 - rate) * ((s - ramp - hold) / ramp);
  };
  const toReal = (tau) => {
    if (tau <= tw0) return tau;
    if (tau >= tw0 + SLOW.phys) return tau + SLOW.extra;
    let lo = tw0, hi = tw0 + SLOW.real;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (toTau(m) < tau) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  return { toTau, toReal, rateAt, start: tw0 };
}

// ---------- случайность ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const U = (rng, a, b) => a + (b - a) * rng();
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const mod = (x, m) => ((x % m) + m) % m;

// ---------- колесо ----------

/*
 * Ротор: крупье толкает его перед броском, дальше он равномерно тормозит до холостого хода.
 * Угол аналитический — по нему считается, где окажется нужная ячейка в момент посадки.
 * Отрицательное τ (до spinAt) — просто линейное продолжение, сцена сама сводит холостой ход с этим.
 */
export function wheelModel(seed, over = {}) {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const w0 = over.w0 != null ? over.w0 : rng() * TAU;
  const speed = over.speed != null ? over.speed : U(rng, 2.0, 2.4); // рад/с, модуль
  const decel = over.decel != null ? over.decel : U(rng, 0.04, 0.055); // рад/с²
  const idle = over.idle != null ? over.idle : 0.55;
  const tStop = ((speed - idle) / decel) * 1000; // мс, когда торможение упирается в холостой ход
  const angleAt = (tau) => {
    const s = tau / 1000;
    if (tau <= 0) return w0 - speed * s;
    if (tau <= tStop) return w0 - (speed * s - (decel * s * s) / 2);
    const s1 = tStop / 1000;
    return w0 - (speed * s1 - (decel * s1 * s1) / 2) - idle * (s - s1);
  };
  const speedAt = (tau) => (tau <= 0 ? -speed : tau <= tStop ? -(speed - (decel * tau) / 1000) : -idle);
  return { w0, speed, decel, idle, angleAt, speedAt };
}

// ---------- построение ----------

const G_HOP = 2.4; // «киношная» гравитация отскоков, м/с²: при настоящей 9,8 скачки не успеть разглядеть
const G_HOP_ALLIN = 1.7; // ва-банк: финал медленнее
const G_DIAMOND = 3.0;
const LAUNCH_AT = 800; // мс: рука крупье подхватывает шарик и бросает

/*
 * Сегмент пути: [τ0, τ1], frame — в чьей системе считается угол ("world" — θ, "rotor" — φ),
 * f(τ) → [угол, r, y]. Внутри сегмента скорость не растёт; все скачки скорости — на границах-ударах.
 */
function seg(t0, t1, frame, phase, f, extra) {
  return Object.assign({ t0, t1, frame, phase, f }, extra || {});
}

// Параболический отскок с постоянной угловой скоростью относительно ротора
function hopSeg(t0, a0, a1, r0, r1, y0, y1, rise, g, phase, extra) {
  const yA = Math.max(y0, y1) + rise;
  const up = Math.sqrt((2 * (yA - y0)) / g);
  const down = Math.sqrt((2 * (yA - y1)) / g);
  const dur = (up + down) * 1000;
  const v0 = g * up;
  const s = seg(t0, t0 + dur, "rotor", phase, (tau) => {
    const u = Math.min(1, Math.max(0, (tau - t0) / dur));
    const q = (tau - t0) / 1000;
    // радиально — плавный заход, как шарик скатывается внутрь по номерному кольцу
    const ur = u * u * (3 - 2 * u);
    return [a0 + (a1 - a0) * u, r0 + (r1 - r0) * ur, y0 + v0 * q - (g * q * q) / 2];
  }, Object.assign({ air: true, apex: yA, a0, a1, rise, dur }, extra || {}));
  return s;
}

// Минимальная высота отскока, при которой шарик не цепляет фретки по пути
function minRise(a0, a1, r0, r1, y0, y1, g, start) {
  let rise = start;
  for (let it = 0; it < 60; it++) {
    const s = hopSeg(0, a0, a1, r0, r1, y0, y1, rise, g, "x");
    let ok = true;
    const n = 60;
    for (let i = 1; i < n; i++) {
      const [a, r, y] = s.f((s.t1 * i) / n);
      if (fretClearance(a, r, y) < 0.0004) { ok = false; break; }
    }
    if (ok) return rise;
    rise *= 1.12;
  }
  return rise;
}

/*
 * Докат в ячейке после посадки: катится вперёд с замедлением, (при tap) тукается о переднюю фретку
 * и откатывается к месту покоя. x — угол относительно центра ячейки, σ — направление захода.
 */
function settlePlan(rng, x0, v0, sigma, tap, slow) {
  const parts = [];
  if (tap) {
    const xw = sigma * X_MAX * 0.985;
    const dist = Math.abs(xw - x0);
    const f = U(rng, 1.25, 1.7);
    let tr1 = (dist / v0) * f * 1000;
    if (slow) tr1 *= 1.25;
    const vTap = Math.max(0.02, (2 * dist) / (tr1 / 1000) - v0);
    parts.push({ kind: "roll", x0, x1: xw, v0, v1: vTap, dur: tr1 });
    const xr = sigma * U(rng, -0.25, 0.3) * X_MAX;
    const dist2 = Math.abs(xw - xr);
    let vb = vTap * U(rng, 0.35, 0.55);
    let tr2 = ((2 * dist2) / vb) * 1000;
    if (tr2 > (slow ? 900 : 650)) { tr2 = slow ? 900 : 650; vb = (2 * dist2) / (tr2 / 1000); }
    if (vb > vTap * 0.8) { vb = vTap * 0.8; tr2 = ((2 * dist2) / vb) * 1000; }
    parts.push({ kind: "back", x0: xw, x1: xr, v0: vb, v1: 0, dur: tr2 });
    return { parts, rest: xr };
  }
  const xr = sigma * U(rng, 0.05, 0.45) * X_MAX;
  const dist = Math.abs(xr - x0);
  let v = v0;
  let tr = ((2 * dist) / v) * 1000;
  if (tr < 220) { tr = 220; v = (2 * dist) / 0.22; }
  parts.push({ kind: "roll", x0, x1: xr, v0: v, v1: 0, dur: tr });
  return { parts, rest: xr };
}

function rollSeg(t0, base, p) {
  const T = p.dur / 1000;
  const sgn = Math.sign(p.x1 - p.x0) || 1;
  const acc = (p.v1 - p.v0) / T;
  return seg(t0, t0 + p.dur, "rotor", "settle", (tau) => {
    const q = Math.min(T, Math.max(0, (tau - t0) / 1000));
    // равнозамедленно; концы совпадают с x0/x1 точно, погрешность дотягиваем линейно
    const raw = p.v0 * q + (acc * q * q) / 2;
    const full = p.v0 * T + (acc * T * T) / 2;
    const d = full > 0 ? (raw / full) * Math.abs(p.x1 - p.x0) : 0;
    return [base + p.x0 + sgn * d, GEOM.pocketR, Y_REST];
  }, { roll: p.kind });
}

/*
 * Цепочка отскоков по ротору, которая кончается посадкой в ячейку idx (развёрнутый индекс).
 * Строим назад: точка посадки → последний прыжок → средние (фретка → фретка) → первый прыжок с края ротора.
 */
function planChain(rng, o) {
  const { idx, kind, slow } = o;
  const g = slow ? G_HOP_ALLIN : G_HOP;
  let n;
  if (kind === "jump") n = pick(rng, [2, 3, 3]);
  else if (kind === "fake") n = pick(rng, [2, 3, 3, 4]);
  else n = pick(rng, [2, 3, 3, 4, 4, 5]);
  const m = rng() < 0.5 ? 0 : 1; // сколько ячеек перелетает последний прыжок
  const xL = -U(rng, 0.45, 0.95) * X_MAX; // шарик садится ближе к задней стенке и докатывается
  /*
   * Пролёты средних прыжков (фретка → фретка) строго растут к началу цепочки: 1, 2, 3…
   * Иначе при равных пролётах более высокий (а значит, более долгий) ранний прыжок летел бы
   * медленнее следующего — шарик «разгонялся» бы без удара.
   */
  const ks = [];
  let k = 0;
  for (let i = 0; i < n - 2; i++) { k += rng() < 0.75 ? 1 : 2; ks.push(k); }
  let k1 = kind === "jump" ? 5 + Math.floor(rng() * 4) : Math.min(6, k + 1 + Math.floor(rng() * 2));
  const frac = U(rng, 0.15, 0.85);

  // точки касаний в системе ротора, от последней к первой
  const land = idx * PA + xL;
  const pts = [land];
  let f = (idx - m - 0.5) * PA;
  pts.push(f);
  for (const kk of ks) { f -= kk * PA; pts.push(f); }
  const phiR = f - (k1 + frac) * PA;
  pts.push(phiR);
  pts.reverse(); // [φR, фретка..., посадка]

  const rE = GEOM.rotorR - 0.004;
  const yE = ringY(rE) + GEOM.ballR;
  const rP = GEOM.pocketR;
  // радиус касаний чуть гуляет — шарик не ходит по рельсу
  const rs = pts.map((_, i) => (i === 0 ? rE : rP + (i < pts.length - 1 ? U(rng, -0.004, 0.004) : 0)));
  const ys = pts.map((_, i) => (i === 0 ? yE : i === pts.length - 1 ? Y_REST : Y_FRET));
  const durOf = (i, rise) => {
    const yA = Math.max(ys[i], ys[i + 1]) + rise;
    return Math.sqrt((2 * (yA - ys[i])) / g) + Math.sqrt((2 * (yA - ys[i + 1])) / g);
  };
  const rateOf = (i, rise) => Math.abs(pts[i + 1] - pts[i]) / durOf(i, rise);

  // высоты: последняя минимальная, каждая предыдущая выше, но не настолько, чтобы прыжок стал медленнее следующего
  const rises = new Array(n);
  rises[n - 1] = minRise(pts[n - 1], pts[n], rs[n - 1], rs[n], ys[n - 1], ys[n], g, U(rng, 0.0045, 0.0065));
  for (let i = n - 2; i >= 0; i--) {
    const apexNext = ys[i + 1] + rises[i + 1];
    const floor = Math.max(apexNext - ys[i] + 0.0015, minRise(pts[i], pts[i + 1], rs[i], rs[i + 1], ys[i], ys[i + 1], g, 0.003));
    let want = rises[i + 1] * U(rng, 1.3, 1.7);
    if (i === 0) want = kind === "jump" ? U(rng, 0.05, 0.065) : Math.min(0.04, Math.max(want, U(rng, 0.018, 0.03)));
    let rise = Math.max(floor, want);
    // потолок по скорости: этот прыжок не медленнее следующего
    const need = rateOf(i + 1, rises[i + 1]) * 1.03;
    while (rise > floor && rateOf(i, rise) < need) rise = Math.max(floor, rise * 0.9);
    rises[i] = rise;
  }

  const hops = [];
  for (let i = 0; i < n; i++) {
    hops.push({ a0: pts[i], a1: pts[i + 1], r0: rs[i], r1: rs[i + 1], y0: ys[i], y1: ys[i + 1], rise: rises[i], first: i === 0, last: i === n - 1 });
  }
  return { hops, g, phiR, land, xL, idx };
}

/*
 * Задевает ли склон какой-нибудь ромб «по земле». Ромб, о который шарик бьётся нарочно (skip),
 * он перелетает в прыжке — его не считаем.
 */
function diamondHit(sgs, skip) {
  const g = GEOM;
  for (const s of sgs) {
    for (let tau = s.t0; tau <= s.t1; tau += 2) {
      const [th, r, y] = s.f(tau);
      const lift = y - Y_SLOPE(r);
      for (let j = 0; j < g.diamonds.length; j++) {
        if (j === skip && s.airFrom != null && tau >= s.airFrom - 1) continue;
        const dm = g.diamonds[j];
        const da = Math.abs(mod(th - dm.a + Math.PI, TAU) - Math.PI) * r;
        if (Math.abs(r - g.diamondR) < dm.halfR + g.ballR * 0.5 && da < dm.halfT + g.ballR * 0.7 && lift < g.diamondH * 0.5) return true;
      }
    }
  }
  return false;
}

const FAIL = {};
const fail = (why) => { FAIL[why] = (FAIL[why] || 0) + 1; return null; };

function attempt(rng, p, wheel, relax) {
  const story = p.story || {};
  const path = story.path === "fake" || story.path === "jump" ? story.path : "normal";
  const slow = Array.isArray(story.allin) && story.allin.length > 0;
  const D = p.spinMs;
  const T = pocketIndex(p.number);
  const settleMax = D - 500 - SLOW.extra; // к этому τ шарик обязан лежать

  // --- ротор: цепочки и докат (длительности не зависят от углов) ---
  let F = null; // ячейка ложной посадки, развёрнутый индекс
  let dF = 0;
  if (path === "fake") {
    const fi = pocketIndex(story.fakeFrom);
    let d = mod(T - fi, POCKETS);
    if (d > POCKETS / 2) d -= POCKETS;
    if (fi < 0 || d === 0 || Math.abs(d) > 3) d = rng() < 0.5 ? 1 : -1; // защита от мусорного fakeFrom
    dF = d;
    F = T - d;
  }
  const chainIdx = path === "fake" ? F : T;
  const chain = planChain(rng, { idx: chainIdx, kind: path, slow });

  const segs = [];
  const events = [];
  const impacts = [];
  const kicks = [LAUNCH_AT]; // удары, после которых скорость законно растёт

  // длительности цепочки
  let hopDur = 0;
  const hopSegsProto = chain.hops.map((h) => {
    const s = hopSeg(0, h.a0, h.a1, h.r0, h.r1, h.y0, h.y1, h.rise, chain.g, "bounce");
    hopDur += s.dur;
    return s;
  });
  const lastProto = hopSegsProto[hopSegsProto.length - 1];
  const lastRate = Math.abs(lastProto.a1 - lastProto.a0) / (lastProto.dur / 1000);
  const vLand = lastRate * U(rng, 0.45, 0.7);
  const s1 = settlePlan(rng, chain.xL, vLand, 1, path !== "fake", slow);
  const s1Dur = s1.parts.reduce((a, x) => a + x.dur, 0);

  let fakeDur = 0;
  let hopOut = null;
  let s2 = null;
  const restMs = 400 + Math.round(U(rng, 0, 60));
  if (path === "fake") {
    const sig = Math.sign(dF);
    const a0 = F * PA + s1.rest;
    const xL2 = -sig * U(rng, 0.4, 0.9) * X_MAX;
    const a1 = T * PA + xL2;
    const rise = Math.max(U(rng, 0.012, 0.018), minRise(a0, a1, GEOM.pocketR, GEOM.pocketR, Y_REST, Y_REST, chain.g, 0.008));
    hopOut = { a0, a1, rise, sig, xL2 };
    const proto = hopSeg(0, a0, a1, GEOM.pocketR, GEOM.pocketR, Y_REST, Y_REST, rise, chain.g, "hopout");
    const rate = Math.abs(a1 - a0) / (proto.dur / 1000);
    s2 = settlePlan(rng, xL2, rate * U(rng, 0.4, 0.6), sig, true, slow);
    fakeDur = restMs + proto.dur + s2.parts.reduce((a, x) => a + x.dur, 0);
    hopOut.dur = proto.dur;
  }
  const postRotor = hopDur + s1Dur + fakeDur;

  // --- склон ---
  const tauSettle = settleMax - U(rng, 0, 150);
  const tauR = tauSettle - postRotor;

  const g = GEOM;
  const rT = g.trackR;
  const rE = g.rotorR - 0.004;
  const W = wheel.angleAt;
  const thetaR = chain.phiR + W(tauR);
  const hit = rng() < 0.6;

  /*
   * Склон — две части, стык на поясе ромбов (r = diamondR):
   *  верх (T1): шарик сходит с трека и по спирали сползает к поясу, радиально разгоняясь;
   *  низ (T2): быстро проскакивает пояс и падает на ротор.
   * Точка стыка — передняя грань выбранного ромба (удар) или просвет между ромбами.
   * Выбор ромба даёт свободу в 1/8 круга: её забирают длительность T2 и скорость после пояса.
   * Верх и трек подстраиваются под результат — трек поглощает любой угол.
   */
  const rho = U(rng, 0.55, 0.8); // ωR/ωx: торможение на нижней части
  const kappa = hit ? U(rng, 0.5, 0.78) : 1; // сколько скорости оставляет ромб
  const mu = U(rng, 0.84, 0.95); // торможение на верхней части
  const T1 = U(rng, 550, 900) * (slow ? 1.25 : 1);
  const T1s = T1 / 1000;
  const hD = U(rng, 0.014, 0.022);
  const dD = 2 * Math.sqrt((2 * hD) / G_DIAMOND) * 1000;
  const T2lo = Math.max(hit ? dD + 50 : 0, 240) * (slow ? 1.2 : 1);
  const T2hi = 420 * (slow ? 1.3 : 1);
  const wxLo = 1.6, wxHi = 3.4;
  const k2 = (1 + rho) / 2;
  const dLo = wxLo * k2 * (T2lo / 1000);
  const dHi = wxHi * k2 * (T2hi / 1000);
  const lo2 = dLo + rng() * Math.max(0, dHi - dLo - Math.PI / 4);
  const dr1 = rT - g.diamondR;
  const vb = (2 * dr1) / T1s; // радиальная скорость на поясе
  const offsets = hit ? [0] : [0, -0.05, 0.05, -0.1, 0.1, -0.15, 0.15, -0.2, 0.2, -0.25, 0.25, 0.3, -0.3];

  let wd, thetaD, slopeSeg, dia = null, tauD = 0;
  for (const off of offsets) {
    let best = null;
    g.diamonds.forEach((dm, j) => {
      const aim = hit ? dm.a - (dm.halfT + g.ballR * 0.8) / g.diamondR : dm.a + TAU / 16 + off;
      const d2 = mod(thetaR - aim - lo2, TAU) + lo2;
      if (!best || d2 < best.d2) best = { j, d2 };
    });
    const d2 = best.d2;
    // T2 в пределах, где скорость после пояса правдоподобна
    const tA = Math.max(T2lo / 1000, d2 / (k2 * wxHi));
    const tB = Math.min(T2hi / 1000, d2 / (k2 * wxLo));
    if (tA > tB) continue;
    const T2s = tA + (tB - tA) * U(rng, 0.3, 0.7);
    const T2 = T2s * 1000;
    const wx = d2 / (k2 * T2s);
    const wR = wx * rho;
    const wpre = wx / kappa;
    const wdd = wpre / mu;
    if (wdd < 2.6 || wdd > 5.2) continue; // скорость схода с трека — в узком «реальном» коридоре
    const dr2 = g.diamondR - rE;
    const ar = (2 * (dr2 - vb * T2s)) / (T2s * T2s);
    if (vb + ar * T2s < vb * 0.5) continue; // низ склона обязан падать не медленнее, чем начал
    const tD = tauR - T1 - T2;
    const tCross = tD + T1;
    const d1 = (T1s * (wdd + wpre)) / 2;
    const thetaX = thetaR - d2;
    const thD = thetaX - d1;
    const v0h = Math.sqrt(2 * G_DIAMOND * hD);
    const hopY = (tau) => {
      if (!hit || tau < tCross || tau > tCross + dD) return 0;
      const q = (tau - tCross) / 1000;
      return Math.max(0, v0h * q - (G_DIAMOND * q * q) / 2);
    };
    const sgs = [
      seg(tD, tCross, "world", "slope", (tau) => {
        const q = (tau - tD) / 1000;
        const u = q / T1s;
        const r = rT - dr1 * u * u;
        return [thD + wdd * q - ((wdd - wpre) * q * q) / (2 * T1s), r, Y_SLOPE(r)];
      }, { w0: wdd, w1: wpre }),
      seg(tCross, tauR, "world", "slope", (tau) => {
        const q = (tau - tCross) / 1000;
        const r = g.diamondR - vb * q - (ar * q * q) / 2;
        return [thetaX + wx * q - ((wx - wR) * q * q) / (2 * T2s), r, Y_SLOPE(r) + hopY(tau)];
      }, hit ? { w0: wx, w1: wR, airFrom: tCross, airUntil: tCross + dD, hitDiamond: best.j } : { w0: wx, w1: wR }),
    ];
    if (diamondHit(sgs, hit ? best.j : -1)) continue;
    wd = wdd; thetaD = thD; slopeSeg = sgs; tauD = tD;
    if (hit) dia = { j: best.j, t: tCross, a: g.diamonds[best.j].a, rise: hD, dur: dD, wpre, wx };
    break;
  }
  if (!slopeSeg) return fail("slope");
  const Trim = tauD - LAUNCH_AT;
  if (Trim < (relax ? 1500 : 2600)) return fail("short");

  // --- трек: скорость броска подбираем под нужный угол (уравнение торможения) ---
  const thetaL = -Math.PI / 2; // бросок с дальней стороны колеса, где стоит крупье
  const Tr = Trim / 1000;
  const gam = U(rng, 0.3, 0.9);
  const shape = Tr * Tr * (0.5 + gam / 3);
  const base = mod(thetaD - thetaL, TAU);
  // целимся в 3–6 кругов по треку (§7.2); на длинных спинах торможение само добавит круг-другой
  const Atarget = TAU * U(rng, 3.5, 6);
  let laps = Math.round((Atarget - base) / TAU);
  let A = base + TAU * laps;
  while (A < wd * Tr * 1.12) { laps++; A += TAU; }
  if (A / TAU > (relax ? 16 : 9.5)) return fail("laps");
  const beta = (A - wd * Tr) / shape;
  const w0 = wd + beta * Tr * (1 + gam);
  if (w0 < 6.5 || w0 > (relax ? 22 : 15.5)) return fail("launch");
  const thetaL0 = thetaD - A; // развёрнутый угол старта (≡ thetaL по модулю 2π)
  const yTrack = Y_SLOPE(rT);

  segs.push(seg(-1e9, LAUNCH_AT, "world", "hand", () => [thetaL0, rT, yTrack]));
  segs.push(seg(LAUNCH_AT, tauD, "world", "rim", (tau) => {
    const t = (tau - LAUNCH_AT) / 1000;
    const s = Tr - t;
    const ang = wd * t + beta * ((Tr * Tr - s * s) / 2 + (gam * (Tr * Tr * Tr - s * s * s)) / (3 * Tr));
    return [thetaL0 + ang, rT, yTrack];
  }, { w0, w1: wd }));
  segs.push(...slopeSeg);

  events.push({ tau: 0, type: "pickup" });
  events.push({ tau: LAUNCH_AT, type: "launch", speed: w0 });
  impacts.push(LAUNCH_AT);
  events.push({ tau: tauD, type: "drop" });
  if (dia) {
    events.push({ tau: dia.t, type: "diamond", strength: Math.min(1, dia.wpre / 5), diamond: dia.j });
    impacts.push(dia.t);
  }
  events.push({ tau: tauR, type: "rotor", strength: 0.8 });
  impacts.push(tauR);

  // --- ротор: цепочка отскоков ---
  let t = tauR;
  const hopsOut = [];
  chain.hops.forEach((h, i) => {
    const s = hopSeg(t, h.a0, h.a1, h.r0, h.r1, h.y0, h.y1, h.rise, chain.g, "bounce", { chain: 0, index: i, pockets: Math.abs(h.a1 - h.a0) / PA });
    segs.push(s);
    hopsOut.push(s);
    t = s.t1;
    impacts.push(t);
    const strength = Math.max(0.15, 1 - i * 0.22) * (i === chain.hops.length - 1 ? 0.7 : 1);
    events.push({ tau: t, type: h.last ? (path === "fake" ? "fakeLand" : "land") : "fret", strength, index: i });
  });
  let base1 = chain.idx * PA;
  const addSettle = (plan, basePhi, final) => {
    plan.parts.forEach((pp, i) => {
      const s = rollSeg(t, basePhi, pp);
      segs.push(s);
      t = s.t1;
      if (pp.kind === "roll" && plan.parts[i + 1]) { impacts.push(t); events.push({ tau: t, type: "tap", strength: 0.35 }); }
    });
    events.push({ tau: t, type: final ? "settle" : "rest" });
  };
  addSettle(s1, base1, path !== "fake");
  let tLandFinal = hopsOut[hopsOut.length - 1].t1;
  let lastHop = hopsOut[hopsOut.length - 1];
  if (path === "fake") {
    const restPhi = base1 + s1.rest;
    segs.push(seg(t, t + restMs, "rotor", "fakeRest", () => [restPhi, GEOM.pocketR, Y_REST]));
    t += restMs;
    impacts.push(t);
    events.push({ tau: t, type: "hopOut", strength: 0.9 });
    kicks.push(t);
    const s = hopSeg(t, hopOut.a0, hopOut.a1, GEOM.pocketR, GEOM.pocketR, Y_REST, Y_REST, hopOut.rise, chain.g, "hopout", { chain: 1, index: 0, pockets: Math.abs(dF) });
    segs.push(s);
    hopsOut.push(s);
    t = s.t1;
    impacts.push(t);
    events.push({ tau: t, type: "land", strength: 0.75 });
    tLandFinal = t;
    lastHop = s;
    addSettle(s2, T * PA, true);
  }
  const tauSettled = t;
  const finalPhi = segs[segs.length - 1].f(tauSettled)[0];
  segs.push(seg(tauSettled, 1e12, "rotor", "ride", () => [finalPhi, GEOM.pocketR, Y_REST]));

  // --- замедление: последний прыжок попадает во вторую треть окна ---
  let tw0 = tLandFinal - 380;
  if (path === "fake") tw0 = Math.max(tw0, lastHop.t0 - 120);
  const warp = makeWarp(tw0);
  events.push({ tau: tw0, type: "slowStart" });
  events.push({ tau: tw0 + SLOW.phys, type: "slowEnd" });

  const jump = path === "jump" ? hopsOut[0] : null;

  return {
    segs, events, impacts, kicks, warp, wheel, path, slow, hit: !!dia, dia, laps: A / TAU, w0, wd,
    tauLaunch: LAUNCH_AT, tauDrop: tauD, tauRotor: tauR, tauSettled, tauLand: tLandFinal,
    hops: hopsOut, jump, lastHop, finalPhi, fakeIdx: F, target: T, spinMs: D,
  };
}

/*
 * Главная функция. p = {number, seed, story, spinMs, wheel?}.
 * Возвращает объект с sample(t) по реальному времени (мс от spinAt) и событиями для звука и камеры.
 */
export function buildTrajectory(p) {
  const number = Number(p.number);
  if (!(pocketIndex(number) >= 0)) throw new Error("bad number");
  const seed = Number.isFinite(p.seed) ? p.seed >>> 0 : (number * 7919 + 13) >>> 0;
  const spinMs = Math.max(8000, Math.min(16000, Number(p.spinMs) || 10000));
  const wheel = wheelModel(seed, p.wheel || {});
  const rng = mulberry32(seed);
  let tr = null;
  for (let i = 0; i < 60 && !tr; i++) {
    const cand = attempt(rng, { number, story: p.story, spinMs }, wheel);
    if (cand && validate(cand).ok) tr = cand;
  }
  if (!tr) {
    // запасной путь: обычный сюжет (ва-банк сохраняем — он лишь замедляет финал), потом с ослабленными рамками
    const rng2 = mulberry32(seed ^ 0x5bd1e995);
    const st = p.story || {};
    for (let i = 0; i < 260 && !tr; i++) {
      const story = { path: "normal", allin: i < 200 ? st.allin : [] };
      const cand = attempt(rng2, { number, story, spinMs }, wheel, i > 50);
      if (cand && validate(cand).ok) tr = cand;
    }
  }
  if (!tr) throw new Error("trajectory failed");
  return finish(tr, number, seed);
}

function locate(segs, tau) {
  // сегменты идут подряд; бинарный поиск по t1
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (tau < segs[m].t1) hi = m; else lo = m + 1;
  }
  return segs[lo];
}

function physAt(tr, tau) {
  const s = locate(tr.segs, tau);
  const [a, r, y] = s.f(tau);
  const W = tr.wheel.angleAt(tau);
  const world = s.frame === "world";
  const air = !!(s.air || (s.airUntil && tau < s.airUntil && tau >= s.airFrom));
  return { theta: world ? a : a + W, phi: world ? a - W : a, r, y, wheel: W, phase: s.phase, air, seg: s };
}

function finish(tr, number, seed) {
  const warp = tr.warp;
  const events = tr.events
    .map((e) => Object.assign({}, e, { t: warp.toReal(e.tau) }))
    .sort((a, b) => a.t - b.t);
  const sampleTau = (tau) => physAt(tr, tau);
  const sample = (t) => {
    const tau = warp.toTau(t);
    const p = physAt(tr, tau);
    // скорость качения для гула: по неподвижному склону — в мире, по ротору — относительно ротора
    const h = 6;
    const q = physAt(tr, tau - h);
    let da = p.seg.frame === "world" ? p.theta - q.theta : p.phi - q.phi;
    const rolling = p.air || p.phase === "hand" ? 0 : (Math.abs(da) / (h / 1000)) * p.r;
    return {
      t, tau, theta: p.theta, phi: p.phi, r: p.r, y: p.y, wheel: p.wheel, phase: p.phase, air: p.air,
      rolling, rate: warp.rateAt(t),
    };
  };
  return {
    number, seed, path: tr.path, slow: tr.slow, hit: tr.hit, laps: tr.laps, launchSpeed: tr.w0, dropSpeed: tr.wd,
    spinMs: tr.spinMs,
    target: tr.target, fakeIdx: tr.fakeIdx,
    events,
    impacts: tr.impacts.slice(),
    kicks: tr.kicks.slice(),
    sample,
    sampleTau,
    toTau: warp.toTau,
    toReal: warp.toReal,
    wheelAngle: (t) => tr.wheel.angleAt(warp.toTau(t)),
    wheelSpeed: (t) => tr.wheel.speedAt(warp.toTau(t)),
    wheel: tr.wheel,
    times: {
      launch: warp.toReal(tr.tauLaunch),
      drop: warp.toReal(tr.tauDrop),
      rotor: warp.toReal(tr.tauRotor),
      land: warp.toReal(tr.tauLand),
      settle: warp.toReal(tr.tauSettled),
      slowStart: warp.start,
      slowEnd: warp.start + SLOW.real,
      diamond: tr.dia ? warp.toReal(tr.dia.t) : null,
      jumpStart: tr.jump ? warp.toReal(tr.jump.t0) : null,
      jumpEnd: tr.jump ? warp.toReal(tr.jump.t1) : null,
      lastHopStart: warp.toReal(tr.lastHop.t0),
    },
    tau: { launch: tr.tauLaunch, drop: tr.tauDrop, rotor: tr.tauRotor, land: tr.tauLand, settle: tr.tauSettled },
    hops: tr.hops.map((s) => ({ t0: s.t0, t1: s.t1, apex: s.apex, chain: s.chain, pockets: s.pockets, a0: s.a0, a1: s.a1 })),
    diamond: tr.dia ? { index: tr.dia.j, tau: tr.dia.t, angle: tr.dia.a } : null,
    finalPhi: tr.finalPhi,
  };
}

/*
 * Внутренняя проверка правдоподобия — ей же отбраковываются неудачные попытки.
 * Скорость меряем относительно ротора (dφ/dτ): она у настоящего шарика только падает,
 * а растёт лишь на ударе (ромб, фретка, выпрыгивание из ячейки).
 */
export function validate(tr) {
  const segs = tr.segs;
  const W = tr.wheel.angleAt;
  const at = (tau) => {
    const s = locate(segs, tau);
    const [a, r, y] = s.f(tau);
    return { phi: s.frame === "world" ? a - W(tau) : a, r, y, s };
  };
  const impacts = tr.impacts;
  const nearImpact = (tau, h) => impacts.some((x) => Math.abs(x - tau) <= h * 2.5);
  const h = 2;
  let prevRate = Infinity;
  let pt = tr.tauLaunch + 0.5;
  let prev = at(pt);
  const end = tr.tauSettled + 50;
  for (let tau = pt; tau <= end; ) {
    const step = tau < tr.tauDrop - 60 ? 8 : h;
    tau += step;
    const cur = at(tau);
    const rn = Math.abs(cur.phi - prev.phi) / step;
    if (!nearImpact(tau, step) && rn > prevRate * (1 + 1e-6) + 1e-9) return { ok: false, why: "speedup", tau };
    if (fretClearance(cur.phi, cur.r, cur.y) < -1e-6) return { ok: false, why: "fret", tau };
    // ромбы: проходить сквозь можно только в прыжке
    if (cur.s.phase === "slope") {
      const th = cur.phi + W(tau);
      const lift = cur.y - Y_SLOPE(cur.r);
      for (const dm of GEOM.diamonds) {
        const da = Math.abs(mod(th - dm.a + Math.PI, TAU) - Math.PI) * cur.r;
        if (tr.dia && dm === GEOM.diamonds[tr.dia.j] && tau >= tr.dia.t - 1) continue;
        if (Math.abs(cur.r - GEOM.diamondR) < dm.halfR + GEOM.ballR * 0.5 && da < dm.halfT + GEOM.ballR * 0.7 && lift < GEOM.diamondH * 0.5) return { ok: false, why: "diamond", tau };
      }
    }
    prevRate = rn;
    prev = cur;
  }
  // удар о фретку или ромб скорость только забирает; разгоняют лишь бросок и выпрыгивание из ячейки
  for (const x of impacts) {
    if (tr.kicks.includes(x)) continue;
    const a = at(x - 4), b = at(x - 2), c = at(x + 2), d = at(x + 4);
    if (Math.abs(d.phi - c.phi) > Math.abs(b.phi - a.phi) * 1.02 + 1e-9) return { ok: false, why: "impact-speedup", tau: x };
  }
  const fin = mod(tr.finalPhi / PA + 0.5, POCKETS);
  if (Math.floor(fin) !== tr.target) return { ok: false, why: "pocket" };
  if (Math.abs(tr.finalPhi - tr.target * PA - Math.round((tr.finalPhi - tr.target * PA) / TAU) * TAU) > X_MAX + 1e-9) return { ok: false, why: "wall" };
  if (tr.warp.toReal(tr.tauSettled) > tr.spinMs - 500 + 1e-6) return { ok: false, why: "late" };
  for (let c = 0; c <= 1; c++) {
    const ch = tr.hops.filter((x) => x.chain === c);
    for (let i = 1; i < ch.length; i++) if (!(ch[i].apex < ch[i - 1].apex)) return { ok: false, why: "apex" };
  }
  return { ok: true };
}

// для стенда: одна попытка построения без отбраковки
export const _internal = { FAIL, attempt, validate, wheelModel, mulberry32 };
