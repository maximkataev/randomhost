/*
 * «Ставки»: сцена кубиков (Three.js). ES-модуль: bets-scenes.js подгружает его через import() и
 * регистрирует тип dice (BetsScenes.register("dice", factory)); контракт — docs/bets-protocol.md §6.
 *
 * Физики в сцене нет: исход [a,b,c] известен заранее, траектории строятся назад от него,
 * а ориентации кубиков в конце подбираются так, чтобы наверху оказались выпавшие грани.
 * Время — как у остальных сцен: фиксированный шаг 1/60 с (step — только числа, draw — только Three),
 * вся случайность из mulberry32(seed), поэтому кадр зависит только от (seed, outcome, момент времени).
 */
import * as THREE from "./vendor/three.module.min.js";

const TAU = Math.PI * 2;
const FACE_VAL = [3, 4, 2, 5, 1, 6];       // +x, −x, +y, −y, +z, −z: противоположные грани дают 7
const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(a[0], a[1], a[2]));
const PIPS = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
const REST_Y = 0.5;
const SHAKE_T = 2.2, LIFT_T = 0.5, RELEASE_T = SHAKE_T + 0.28, HOLD_T = 2.8;
const CAM_BASE = new THREE.Vector3(0, 7.9, 8.6), LOOK_BASE = new THREE.Vector3(0, 0.3, 0.4);
const LAND = [new THREE.Vector3(-1.9, REST_Y, 0.5), new THREE.Vector3(0.1, REST_Y, -1.1), new THREE.Vector3(1.9, REST_Y, 0.7)];
const NP = 220;

// ---------- строки (RU/EN/EL); язык читается на лету из <html lang>, неизвестный → ru ----------
const STR = {
  ru: { start: "Кубики в стакане. <em>Ставки закрыты.</em>", triple: "ТРОЙКА!", sum: "СУММА {n}", rolled: "Выпало <em>{r}</em>, сумма {n}", shake: "Трясём стакан… <em>что выпадет?</em>", out: "Кубики вылетели!", two: "Два кубика встали. <em>Последний ещё катится…</em>", big: "БОЛЬШЕ", small: "МЕНЬШЕ", odd: "НЕЧЁТ", even: "ЧЁТ", nogl: "WebGL недоступен", tbl: "ТОТАЛ", dice: "КОСТИ" },
  en: { start: "Dice are in the cup. <em>Bets are closed.</em>", triple: "TRIPLE!", sum: "TOTAL {n}", rolled: "Rolled <em>{r}</em>, total {n}", shake: "Shaking the cup… <em>what will it be?</em>", out: "The dice are out!", two: "Two dice have settled. <em>The last one is still rolling…</em>", big: "BIG", small: "SMALL", odd: "ODD", even: "EVEN", nogl: "WebGL unavailable", tbl: "TOTE", dice: "DICE" },
  el: { start: "Τα ζάρια στο κύπελλο. <em>Τα στοιχήματα έκλεισαν.</em>", triple: "ΤΡΙΑΔΑ!", sum: "ΑΘΡΟΙΣΜΑ {n}", rolled: "Έπεσαν <em>{r}</em>, άθροισμα {n}", shake: "Ανακινούμε το κύπελλο… <em>τι θα φέρει;</em>", out: "Τα ζάρια βγήκαν!", two: "Δύο ζάρια σταμάτησαν. <em>Το τελευταίο κυλά ακόμα…</em>", big: "ΜΕΓΑΛΟ", small: "ΜΙΚΡΟ", odd: "ΜΟΝΟ", even: "ΖΥΓΟ", nogl: "Το WebGL δεν είναι διαθέσιμο", tbl: "ΤΟΤΑΛ", dice: "ΖΑΡΙΑ" },
};
const curLang = () => { try { const l = ((document.documentElement.lang) || (window.I18N && window.I18N.lang) || "ru").slice(0, 2); return STR[l] ? l : "ru"; } catch (e) { return "ru"; } };
const i18t = (k, v) => {
  let s = (STR[curLang()] || STR.ru)[k]; if (s == null) s = STR.ru[k]; if (s == null) return k;
  return v ? s.replace(/\{(\w+)\}/g, (m, x) => (v[x] == null ? m : v[x])) : s;
};

export default function factory(host, ctx) {
  const U = ctx.util;
  const DISP = U.DISP, MONO = U.MONO;
  let dead = false, run = null;

  // ---------- контейнеры ----------
  const view = document.createElement("div");
  view.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0";
  host.appendChild(view);
  const hud = document.createElement("canvas");               // плашка суммы поверх WebGL
  hud.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    renderer.domElement.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block";
    view.appendChild(renderer.domElement);
  } catch (e) { renderer = null; console.warn("bets-scene-dice: WebGL недоступен", e); }
  view.appendChild(hud);
  const hg = hud.getContext("2d");

  // ---------- сцена ----------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);
  scene.fog = new THREE.Fog(0x05070a, 18, 42);
  const camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 80);
  camera.position.copy(CAM_BASE); camera.lookAt(LOOK_BASE);

  scene.add(new THREE.HemisphereLight(0x6b7fa0, 0x0a0d12, 0.9));
  const spot = new THREE.SpotLight(0xfff0d6, 1400, 40, 0.62, 0.65, 2);
  spot.position.set(0.5, 13, 4); spot.target.position.set(0, 0, 0); spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048); spot.shadow.bias = -0.0004; spot.shadow.radius = 5; spot.shadow.camera.near = 6; spot.shadow.camera.far = 24;
  scene.add(spot, spot.target);
  const pm = new THREE.PointLight(0xff2e88, 260, 26, 2); pm.position.set(-8, 3.2, -4); scene.add(pm);
  const pl = new THREE.PointLight(0xb6ff2e, 220, 26, 2); pl.position.set(8, 3.2, -4); scene.add(pl);

  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  let tableLang = curLang();
  function tableTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 1024;
    const g = c.getContext("2d");
    const tex = track(new THREE.CanvasTexture(c)); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    tex.userData.paint = () => paint(g);
    paint(g);
    return tex;
  }
  function paint(g) {
    const rg = g.createRadialGradient(512, 512, 40, 512, 512, 512);
    rg.addColorStop(0, "#16282e"); rg.addColorStop(0.55, "#0c171b"); rg.addColorStop(1, "#06090b");
    g.fillStyle = rg; g.fillRect(0, 0, 1024, 1024);
    g.strokeStyle = "rgba(255,255,255,.035)"; g.lineWidth = 1;
    for (let i = 0; i <= 1024; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 1024); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(1024, i); g.stroke(); }
    const ring = (r, col, w, blur) => { g.strokeStyle = col; g.lineWidth = w; g.shadowColor = col; g.shadowBlur = blur; g.beginPath(); g.arc(512, 512, r, 0, TAU); g.stroke(); g.shadowBlur = 0; };
    ring(468, "#b6ff2e", 5, 26); ring(430, "#ff2e88", 2, 14); ring(250, "rgba(182,255,46,.55)", 2, 10);
    g.fillStyle = "rgba(182,255,46,.8)"; g.font = "800 44px " + DISP; g.textAlign = "center";
    g.save(); g.translate(512, 512); for (let i = 0; i < 12; i++) { g.rotate(Math.PI / 6); g.fillText([i18t("tbl"), "×", i18t("dice"), "×"][i % 4], 0, -454 + 8); } g.restore();
  }
  const tableTex = tableTexture();
  const table = new THREE.Mesh(track(new THREE.CircleGeometry(10, 96)), track(new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.42, metalness: 0.25 })));
  table.rotation.x = -Math.PI / 2; table.receiveShadow = true; scene.add(table);
  const rim = new THREE.Mesh(track(new THREE.TorusGeometry(10.1, 0.28, 16, 120)), track(new THREE.MeshStandardMaterial({ color: 0x0b0f13, roughness: 0.35, metalness: 0.6 })));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.05; scene.add(rim);

  // ---------- кубики ----------
  function pipTexture(v) {
    const S = 256, c = document.createElement("canvas"); c.width = c.height = S;
    const g = c.getContext("2d");
    const bg = g.createLinearGradient(0, 0, S, S); bg.addColorStop(0, "#1b2229"); bg.addColorStop(1, "#0a0d10");
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.strokeStyle = "rgba(255,255,255,.08)"; g.lineWidth = 6; g.strokeRect(3, 3, S - 6, S - 6);
    for (const [px, py] of PIPS[v]) {
      const x = S / 2 + px * S * 0.25, y = S / 2 + py * S * 0.25, r = v === 1 ? S * 0.15 : S * 0.085;
      const col = v === 1 ? "#ff2e88" : "#b6ff2e";
      g.shadowColor = col; g.shadowBlur = 16; g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.shadowBlur = 0; g.fillStyle = "rgba(255,255,255,.65)"; g.beginPath(); g.arc(x - r * 0.25, y - r * 0.25, r * 0.4, 0, TAU); g.fill();
    }
    const t = track(new THREE.CanvasTexture(c)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  }
  const pipTex = [1, 2, 3, 4, 5, 6].map(pipTexture);
  const faceMats = FACE_VAL.map((v) => track(new THREE.MeshStandardMaterial({ map: pipTex[v - 1], emissive: 0xffffff, emissiveMap: pipTex[v - 1], emissiveIntensity: 0.55, roughness: 0.28, metalness: 0.15 })));
  function roundedCube(size, r, seg) {
    const g = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
    const pos = g.attributes.position, nor = g.attributes.normal, half = size / 2 - r;
    const v = new THREE.Vector3(), inner = new THREE.Vector3(), d = new THREE.Vector3();
    const cl = (x) => Math.max(-half, Math.min(half, x));
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i); inner.set(cl(v.x), cl(v.y), cl(v.z)); d.copy(v).sub(inner);
      if (d.lengthSq() > 1e-9) { d.normalize(); v.copy(inner).addScaledVector(d, r); nor.setXYZ(i, d.x, d.y, d.z); }
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    return g;
  }
  const dieGeo = track(roundedCube(1, 0.15, 7));
  const dice = [0, 1, 2].map(() => { const m = new THREE.Mesh(dieGeo, faceMats); m.castShadow = true; m.receiveShadow = true; return m; });

  // ориентация, при которой наверху грань v, с поворотом yaw вокруг вертикали
  function qFor(v, yaw) {
    const n = NORMALS[FACE_VAL.indexOf(v)];
    const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 1, 0));
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(q);
  }

  // ---------- стакан ----------
  const cup = new THREE.Group();
  const glass = track(new THREE.MeshPhysicalMaterial({ color: 0x9fd9c8, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false }));
  const cupBody = new THREE.Mesh(track(new THREE.CylinderGeometry(1.5, 1.22, 2.5, 40, 1, true)), glass); cupBody.position.y = 1.25; cup.add(cupBody);
  const cupBase = new THREE.Mesh(track(new THREE.CylinderGeometry(1.22, 1.22, 0.14, 40)), track(new THREE.MeshStandardMaterial({ color: 0x10161b, roughness: 0.4, metalness: 0.6 }))); cupBase.position.y = 0.07; cupBase.castShadow = true; cup.add(cupBase);
  const cupRim = new THREE.Mesh(track(new THREE.TorusGeometry(1.5, 0.05, 12, 60)), track(new THREE.MeshBasicMaterial({ color: 0xb6ff2e }))); cupRim.rotation.x = Math.PI / 2; cupRim.position.y = 2.5; cup.add(cupRim);
  const cupGlow = new THREE.PointLight(0xb6ff2e, 18, 6, 2); cupGlow.position.y = 2.5; cup.add(cupGlow);
  scene.add(cup);

  // ---------- искры ----------
  const pGeo = track(new THREE.BufferGeometry());
  pGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NP * 3), 3));
  const points = new THREE.Points(pGeo, track(new THREE.PointsMaterial({ color: 0xb6ff2e, size: 0.11, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
  points.frustumCulled = false; scene.add(points);

  // ---------- размеры ----------
  let sized = false, sw = 0, sh = 0;
  const ro = window.ResizeObserver ? new ResizeObserver(() => { sized = false; }) : null;
  if (ro) ro.observe(host);
  function fit() {
    const r = host.getBoundingClientRect();
    const w = Math.max(2, Math.round(r.width)), h = Math.max(2, Math.round(r.height)), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (sized && w === sw && h === sh) return;
    sized = true; sw = w; sh = h;
    if (renderer) { renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); }
    hud.width = Math.round(w * dpr); hud.height = Math.round(h * dpr);
    camera.aspect = w / h;
    camera.fov = w / h < 1.5 ? 46 : 36;      // на узком экране камера отъезжает, чтобы стол с кубиками помещался
    camera.updateProjectionMatrix();
  }

  // ---------- симуляция (только числа) ----------
  function planRoll(o, R) {
    const rand = (a, b) => a + R() * (b - a);
    const order = [0, 1, 2];
    for (let i = 2; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    return o.map((v, i) => {
      const Lp = LAND[order[i]].clone(); Lp.x += rand(-0.25, 0.25); Lp.z += rand(-0.25, 0.25);
      const T = [1.8, 2.1, 2.7][i] * rand(0.95, 1.05);      // последний кубик катится дольше
      const Rl = new THREE.Vector3(rand(-0.4, 0.4) - 2.2, 3.3, rand(-0.5, 0.5) - 1.0);
      const dirx = Lp.x - Rl.x, dirz = Lp.z - Rl.z;
      const perp = new THREE.Vector3(-dirz, 0, dirx).normalize();
      const X1 = Rl.clone().lerp(Lp, 0.58).addScaledVector(perp, rand(-0.9, 0.9)); X1.y = REST_Y;
      const X2 = Rl.clone().lerp(Lp, 0.86).addScaledVector(perp, rand(-0.35, 0.35)); X2.y = REST_Y;
      const X3 = Lp.clone().lerp(X2, 0.12);
      return {
        v, T, delay: i * 0.13, R: Rl, L: Lp,
        seg: [{ a: Rl, b: X1, f: 0.36, h: 0.5, fall: true }, { a: X1, b: X2, f: 0.27, h: 1.25 }, { a: X2, b: X3, f: 0.2, h: 0.55 }, { a: X3, b: Lp, f: 0.17, h: 0.14 }],
        axis: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(), spin: Math.PI * rand(9, 13) * (R() < 0.5 ? -1 : 1),
        qEnd: qFor(v, rand(0, TAU)), hits: 0, landed: false,
      };
    });
  }
  function posAt(p, s) {
    let acc = 0;
    for (let i = 0; i < p.seg.length; i++) {
      const g = p.seg[i];
      if (s <= acc + g.f || i === p.seg.length - 1) {
        const u = Math.min(1, Math.max(0, (s - acc) / g.f));
        const x = g.a.x + (g.b.x - g.a.x) * u, z = g.a.z + (g.b.z - g.a.z) * u;
        const y = g.fall ? REST_Y + (g.a.y - REST_Y) * (1 - u * u) + 4 * g.h * u * (1 - u) : REST_Y + 4 * g.h * u * (1 - u);
        return { x, y, z, seg: i, u };
      }
      acc += g.f;
    }
  }

  function makeSim(o, env) {
    const play = o.mode === "play";
    const R = U.mulberry32(play ? (o.seed | 0) : 31);
    const rand = (a, b) => a + R() * (b - a);
    const oc = Array.isArray(o.outcome) && o.outcome.length === 3 && o.outcome.every((v) => v >= 1 && v <= 6) ? o.outcome.map((v) => v | 0) : [1, 2, 3];
    const plan = planRoll(oc, R);
    const S = {
      phase: play ? "shake" : "idle", t: 0, clk: 0, ts: 1, released: false, landedN: 0, said: {}, doneT: 0, camShake: 0, cjx: 0, cjy: 0,
      cx: CAM_BASE.x, cy: CAM_BASE.y, cz: CAM_BASE.z, shakeSeed: R() * 10, rot: [new THREE.Vector3(0.4, 0, 0.2), new THREE.Vector3(1.4, 0.7, 0.2), new THREE.Vector3(2.4, 1.4, 0.2)],
      pPos: new Float32Array(NP * 3), pVel: new Float32Array(NP * 3), pLife: new Float32Array(NP), pCursor: 0,
    };
    for (let i = 0; i < NP; i++) S.pPos[i * 3 + 1] = -50;
    function sparks(x, y, z, n, power) {
      for (let i = 0; i < n; i++) {
        const k = S.pCursor++ % NP, a = R() * TAU, s = (0.4 + R()) * power;
        S.pPos[k * 3] = x; S.pPos[k * 3 + 1] = y; S.pPos[k * 3 + 2] = z;
        S.pVel[k * 3] = Math.cos(a) * s; S.pVel[k * 3 + 1] = 1.2 + R() * power; S.pVel[k * 3 + 2] = Math.sin(a) * s;
        S.pLife[k] = 0.5 + R() * 0.4;
      }
    }
    const sum = oc[0] + oc[1] + oc[2], triple = oc[0] === oc[1] && oc[1] === oc[2];
    const start = () => { if (play) { env.say(i18t("start")); env.snd("shake"); } };

    function finishRoll() {
      S.phase = "done"; S.doneT = 0;
      env.stamp(triple ? i18t("triple") : i18t("sum", { n: sum }), triple ? "win" : "neutral");
      env.say(i18t("rolled", { r: oc.join(" · "), n: sum }));
      sparks(0, 0.5, 0, 40, 2.4); env.snd("land");
    }
    function step(dt) {
      S.clk += dt;
      let target = 1;
      if (S.phase === "throw" && S.released) {
        const p = plan[2], s = (S.t - RELEASE_T - p.delay) / p.T;
        if (s > 0.62 && s < 0.97) target *= 0.38;
      }
      S.ts += (target - S.ts) * Math.min(1, dt * 7);
      const sdt = dt * S.ts;
      if (S.phase === "shake" || S.phase === "throw") S.t += sdt;
      const t = S.t;
      if (S.phase === "shake") {
        S.rot.forEach((r, i) => { r.x += sdt * (9 + i * 3); r.y += sdt * (7 - i * 2); r.z += sdt * (11 + i); });
        if (t > 0.5 && !S.said.sh) { S.said.sh = 1; env.say(i18t("shake")); }
        if (t >= SHAKE_T) { S.phase = "throw"; env.snd("throw"); }
      }
      if (S.phase === "throw") {
        if (!S.released && t >= RELEASE_T) { S.released = true; env.say(i18t("out")); }
        if (S.released) {
          let all = true;
          plan.forEach((p) => {
            const ft = t - RELEASE_T - p.delay;
            if (ft < 0) { all = false; return; }
            const s = Math.min(1, ft / p.T), pos = posAt(p, s);
            if (pos.seg > p.hits) { p.hits = pos.seg; sparks(pos.x, 0.1, pos.z, 10 + (3 - pos.seg) * 2, 1.4 - pos.seg * 0.25); S.camShake = Math.max(S.camShake, 0.35 - pos.seg * 0.08); env.snd("click"); }
            if (s >= 1) { if (!p.landed) { p.landed = true; S.landedN++; sparks(pos.x, 0.1, pos.z, 14, 1.0); env.snd("click"); } } else all = false;
          });
          if (!plan[2].landed && plan[0].landed && plan[1].landed && !S.said.last) { S.said.last = 1; env.say(i18t("two")); }
          if (all) finishRoll();
        }
      } else if (S.phase === "done") S.doneT += dt;
      // камера: наезд на последний кубик, лёгкая тряска на ударах
      S.camShake = Math.max(0, S.camShake - dt * 2.2);
      let push = 0;
      if (S.phase === "throw" && S.released) { const p = plan[2], s = (t - RELEASE_T - p.delay) / p.T; push = Math.min(1, Math.max(0, (s - 0.35) / 0.4)); }
      const tp = S.phase === "done" ? 1 : push;
      const tx = S.phase === "idle" || S.phase === "shake" ? CAM_BASE.x : CAM_BASE.x + (plan[2].L.x * 0.4 - CAM_BASE.x) * 0.55 * tp;
      const ty = CAM_BASE.y + (6.4 - CAM_BASE.y) * 0.55 * tp, tz = CAM_BASE.z + (7.4 - CAM_BASE.z) * 0.55 * tp;
      S.cx += (tx - S.cx) * Math.min(1, dt * 3); S.cy += (ty - S.cy) * Math.min(1, dt * 3); S.cz += (tz - S.cz) * Math.min(1, dt * 3);
      S.tp = tp;
      if (S.camShake > 0) { S.cjx = R() - 0.5; S.cjy = R() - 0.5; } else { S.cjx = S.cjy = 0; }
      // искры
      for (let i = 0; i < NP; i++) {
        if (S.pLife[i] <= 0) { S.pPos[i * 3 + 1] = -50; continue; }
        S.pLife[i] -= dt; S.pVel[i * 3 + 1] -= 9 * dt;
        S.pPos[i * 3] += S.pVel[i * 3] * dt; S.pPos[i * 3 + 1] += S.pVel[i * 3 + 1] * dt; S.pPos[i * 3 + 2] += S.pVel[i * 3 + 2] * dt;
        if (S.pPos[i * 3 + 1] < 0.02) { S.pPos[i * 3 + 1] = 0.02; S.pVel[i * 3 + 1] *= -0.3; }
      }
    }

    const look = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
    function draw() {
      if (tableLang !== curLang()) { tableLang = curLang(); tableTex.userData.paint(); tableTex.needsUpdate = true; }   // подпись на столе перерисовывается при смене языка
      fit();
      const t = S.t, k = S.clk;
      // стакан и кубики
      if (S.phase === "idle") {
        cup.visible = true; glass.opacity = 0.24; cup.rotation.set(0, 0, 0);
        cup.position.set(0, Math.sin(k * 1.4) * 0.04, 0); cupGlow.intensity = 14 + Math.sin(k * 3) * 4;
        dice.forEach((d, i) => { cup.add(d); d.position.set([-0.45, 0.45, 0][i], 0.55, [0.2, 0.1, -0.4][i]); d.rotation.set(0.4 + i, 0.7 * i, 0.2); });
      } else if (S.phase === "shake") {
        const kk = Math.min(1, t / 0.25), amp = 0.55 * kk;
        cup.visible = true; glass.opacity = 0.24; cupGlow.intensity = 14;
        cup.position.set(Math.sin(t * 19) * amp, 0.3 + Math.abs(Math.sin(t * 13)) * 0.55 * kk, Math.cos(t * 16) * amp * 0.7);
        cup.rotation.set(Math.sin(t * 17) * 0.17 * kk, 0, Math.cos(t * 21) * 0.2 * kk);
        dice.forEach((d, i) => {
          cup.add(d);
          const ph = i * 2.1 + S.shakeSeed;
          d.position.set(Math.sin(t * 23 + ph) * 0.52, 0.55 + Math.abs(Math.sin(t * 29 + ph)) * 0.8, Math.cos(t * 19 + ph) * 0.5);
          d.rotation.set(S.rot[i].x, S.rot[i].y, S.rot[i].z);
        });
      } else {
        const u = Math.min(1, Math.max(0, (t - SHAKE_T) / LIFT_T)), e = u * u * (3 - 2 * u);
        cup.position.set(-2.2, 0.3 + 2.6 * e, -1.0 + 0.2 * e); cup.rotation.set(0, 0, e * 1.9);
        if (!S.released) {
          cupGlow.intensity = 14; glass.opacity = 0.24; cup.visible = true;
          dice.forEach((d, i) => { cup.add(d); const ph = i * 2.1 + S.shakeSeed; d.position.set(Math.sin(t * 23 + ph) * 0.52, 0.55 + Math.abs(Math.sin(t * 29 + ph)) * 0.8, Math.cos(t * 19 + ph) * 0.5); d.rotation.set(S.rot[i].x, S.rot[i].y, S.rot[i].z); });
        } else {
          const kk = Math.min(1, (t - RELEASE_T) / 0.7);
          cup.position.x = -2.2 - 3.5 * kk; cup.position.y = 2.9 + 1.5 * kk; glass.opacity = 0.24 * (1 - kk); cupGlow.intensity = 14 * (1 - kk); cup.visible = kk < 1;
          plan.forEach((p, i) => {
            const d = dice[i]; scene.add(d);
            const ft = t - RELEASE_T - p.delay;
            if (ft < 0) { // ещё в воздухе у горловины стакана
              d.position.copy(p.R); d.quaternion.setFromAxisAngle(p.axis, p.spin).multiply(p.qEnd); return;
            }
            const s = Math.min(1, ft / p.T), pos = posAt(p, s);
            d.position.set(pos.x, pos.y, pos.z);
            // вращение гаснет к концу и точно приходит в нужную грань
            tmpQ.setFromAxisAngle(p.axis, p.spin * Math.pow(1 - s, 1.7));
            d.quaternion.copy(tmpQ).multiply(p.qEnd);
          });
        }
      }
      // камера
      look.copy(LOOK_BASE).lerp(plan[2].L, 0.5 * (S.tp || 0));
      camera.position.set(S.cx + S.cjx * S.camShake * 0.35, S.cy + S.cjy * S.camShake * 0.25, S.cz);
      camera.lookAt(look);
      pGeo.attributes.position.array.set(S.pPos); pGeo.attributes.position.needsUpdate = true;
      pm.intensity = 240 + Math.sin(k * 2.3) * 40; pl.intensity = 210 + Math.sin(k * 1.9 + 1) * 36;
      if (renderer) renderer.render(scene, camera);
      drawHud();
    }
    function drawHud() {
      const dpr = hud.width / Math.max(1, sw);
      hg.setTransform(dpr, 0, 0, dpr, 0, 0); hg.clearRect(0, 0, sw, sh);
      if (!renderer) {
        hg.fillStyle = "#05070a"; hg.fillRect(0, 0, sw, sh);
        hg.textAlign = "center"; hg.fillStyle = "#b6ff2e"; hg.font = "900 " + Math.min(sh * 0.12, 40) + "px " + DISP; hg.fillText(i18t("nogl"), sw / 2, sh * 0.45);
        if (S.phase === "done") hg.fillText(oc.join(" · ") + "  =  " + sum, sw / 2, sh * 0.62);
        return;
      }
      if (S.phase !== "done") return;
      const a = Math.min(1, S.doneT / 0.35), u = Math.max(0.6, Math.min(1.3, sh / 540));
      hg.globalAlpha = a; hg.textAlign = "center";
      const tags = triple ? [i18t("triple")] : [i18t(sum >= 11 ? "big" : "small"), i18t(sum % 2 ? "odd" : "even")];
      const y0 = 14 * u;
      hg.font = "700 " + (11 * u) + "px " + MONO; const tw = tags.reduce((s, x) => s + hg.measureText(x).width + 22 * u, 0);
      const w = Math.max(tw, 150 * u) + 30 * u, x0 = sw / 2 - w / 2;
      hg.fillStyle = "rgba(6,8,12,.82)"; hg.fillRect(x0, y0, w, 92 * u);
      hg.strokeStyle = "#b6ff2e"; hg.lineWidth = 2; hg.strokeRect(x0, y0, w, 92 * u);
      hg.shadowColor = "#b6ff2e"; hg.shadowBlur = 18; hg.fillStyle = "#fff"; hg.font = "900 " + (62 * u) + "px " + DISP; hg.fillText(String(sum), sw / 2, y0 + 62 * u); hg.shadowBlur = 0;
      hg.font = "800 " + (13 * u) + "px " + MONO; let tx = sw / 2 - tw / 2 + 11 * u; hg.textAlign = "left";
      tags.forEach((x) => { const wx = hg.measureText(x).width; hg.fillStyle = "#b6ff2e"; hg.fillText(x, tx, y0 + 84 * u); tx += wx + 22 * u; });
      hg.globalAlpha = 1; hg.textAlign = "left";
    }

    return {
      start, step, draw,
      done: () => play && S.phase === "done" && S.doneT > HOLD_T,
      // верхняя грань каждого кубика, как она сейчас видна на экране (для самопроверки)
      debug() {
        const up = dice.map((d) => {
          let best = -2, val = 0;
          NORMALS.forEach((n, i) => { const y = n.clone().applyQuaternion(d.quaternion).y; if (y > best) { best = y; val = FACE_VAL[i]; } });
          return { val, flat: +best.toFixed(4), y: +d.position.y.toFixed(3) };
        });
        return { sig: U.sig(S), type: "dice", phase: S.phase, want: oc.slice(), got: up, landed: S.landedN, sum };
      },
    };
  }

  // ---------- интерфейс сцены ----------
  const env = {
    silent: false,
    say(h) { if (!env.silent && !dead) ctx.emit("say", h); },
    stamp(t, tone) { if (!env.silent && !dead) ctx.emit("stamp", t, tone || "neutral"); },
    snd(n) { if (env.silent || dead || ctx.muted()) return; const s = ctx.sound; if (s && typeof s.play === "function") { try { s.play(n); } catch (e) { /* звук не должен ронять сцену */ } } },
  };
  const stopRun = () => { if (run) { run.stop(false); run = null; } };
  return {
    show(o) {
      stopRun();
      run = U.drive({ env, idle: true, make: () => makeSim(Object.assign({}, o, { mode: "show" }), env) });
    },
    play(o) {
      stopRun();
      const r = U.drive({ env, durationMs: o.durationMs, offsetMs: o.offsetMs, make: () => makeSim(Object.assign({}, o, { mode: "play" }), env) });
      run = r;
      return r.promise;
    },
    live() { /* у кубиков нет потоковых данных */ },
    debug() { return run && run.sim && run.sim.debug ? Object.assign({ speed: run.speed() }, run.sim.debug()) : null; },
    destroy() {
      dead = true; stopRun();
      if (ro) ro.disconnect();
      disposables.forEach((o) => { try { o.dispose(); } catch (e) { /* ничего */ } });
      if (renderer) { try { renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); } catch (e) { /* ничего */ } if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement); }
      if (view.parentNode) view.parentNode.removeChild(view);
    },
  };
}
