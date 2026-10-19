/*
 * «Лягушки на кувшинках» — клиентская модель мира: часы партии, события с метками времени, снимки, предсказание своего прыжка.
 * Общий файл браузерной страницы и сетевого бота: Node (require) и браузер (window.PondModel).
 * Модель ничего не знает про сокеты и canvas: ей скармливают сообщения сервера (feed), а она отдаёт состояние на момент времени.
 * Спека — frog-pond-spec.md §7.2, §7.4, §7.5.
 */
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module === 'object' ? require('./physics') : root.PondPhysics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PondModel = api;
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const keyOf = e => (e.t != null ? e.t : e.type === 'jump' ? e.t0 : null);

  // погружение сервер обрабатывает на GRACE позже метки (ждёт прыжки «задним числом»): эти события опаздывают намеренно,
  // а кувшинка и так тонет по своей метке sinkAt, которую клиент знает заранее
  const deferred = e => e.type === 'sunk' || e.type === 'shrunk' || (e.type === 'fall' && (e.cause === 'wave' || e.cause === 'heron'));

  function createModel(opts) {
    opts = opts || {};
    const m = {
      cfg: Object.assign({}, P.DEFAULTS), phase: 'lobby', R: 0, seed: 0, n0: 0,
      pads: [], frogs: new Map(), myId: null, loser: null, heron: null, over: null,
      delay: opts.delay != null ? opts.delay : 0.12,   // RENDER_DELAY: мир рисуется чуть в прошлом, чтобы события успели прийти
      queue: [], snap: null, pred: null, onEvent: opts.onEvent || null,
      clock: { samples: [], off: null, rtt: Infinity, jitter: 0 },
      stats: { snaps: 0, events: 0, corrections: 0, lateEvents: 0 },
    };

    // ---------- часы ----------
    // gt — часы партии на сервере в момент ответа, rtt — измеренный клиентом круг, local — свои часы (с)
    m.sync = function (gt, rtt, local) {
      const c = m.clock;
      const off = gt + rtt / 2 - local;
      // часы партии сбрасываются на новый раунд: старые образцы описывают другую шкалу времени — выбрасываем их,
      // иначе лучший по RTT образец из прошлого раунда сдвигает время на десятки секунд (нашёл плейтест 18.10)
      if (c.samples.length && Math.abs(off - c.samples[c.samples.length - 1].off) > 0.75) c.samples.length = 0;
      c.samples.push({ off, rtt, at: local });
      if (c.samples.length > 8) c.samples.shift();
      const fresh = c.samples.filter(s => local - s.at < 20);
      const best = fresh.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
      c.off = best.off; c.rtt = best.rtt;
      const rs = fresh.map(s => s.rtt);
      c.jitter = Math.max(...rs) - Math.min(...rs);
      // задержка отрисовки: события других игроков идут к нам через сервер (их путь + наш), поэтому она растёт с RTT и джиттером:
      // 120 мс в хорошей сети, до 300 мс в плохой. Свой прыжок это не задерживает — он предсказывается
      if (!opts.delay) m.delay = Math.min(0.3, Math.max(0.12, 0.06 + c.rtt / 2 + c.jitter * 0.6));
    };
    m.now = local => (m.clock.off == null ? 0 : local + m.clock.off);

    // ---------- раскладка и снимки ----------
    function buildPads(seed, n) {
      const L = P.makeLayout(seed, n, m.cfg);
      m.R = L.R;
      m.pads = L.pads.map(p => Object.assign({ state: 'ok', sinkAt: null, cause: null, flyUntil: 0 }, p));
    }
    function jumpOf(j) {
      const tx = j.x0 + Math.cos(j.ang) * j.dist, ty = j.y0 + Math.sin(j.ang) * j.dist;
      return { t0: j.t0, x0: j.x0, y0: j.y0, ang: j.ang, dist: j.dist, dur: j.dur, tx, ty, L: j.t0 + j.dur, forced: !!j.forced };
    }
    function applySnap(s) {
      m.stats.snaps++;
      m.phase = s.ph; m.loser = s.loser; m.heron = s.heron;
      if (s.over) m.over = Object.assign({ type: 'over' }, s.over);
      if (s.ph === 'lobby') { m.pads = []; m.over = null; m.frogs.clear(); }
      else if (s.seed !== m.seed || s.n0 !== m.n0 || !m.pads.length) { m.seed = s.seed; m.n0 = s.n0; buildPads(s.seed, s.n0); }
      m.seed = s.seed;
      for (const e of s.pads) {
        const p = m.pads[e[0]];
        if (!p) continue;
        p.state = e[1]; p.sinkAt = e[2]; p.cause = e[3]; p.flyUntil = e[4] || 0;
        if (e[5] === 1 && p.cap === 2) { p.cap = 1; p.r = m.cfg.PAD_R; p.big = false; }
      }
      const seen = new Set();
      for (const f of s.frogs) {
        seen.add(f.id);
        let o = m.frogs.get(f.id);
        const wasPred = o && m.pred && f.id === m.myId;
        if (!o) { o = { id: f.id }; m.frogs.set(f.id, o); }
        Object.assign(o, { name: f.name, ci: f.ci, inGame: !!f.ig, st: f.st, pad: f.pad, boost: !!f.boost, online: !!f.on, stomps: f.s || 0, readyAt: f.rd, tireAt: f.ta || 0, blockUntil: f.bu || 0, blockReadyAt: f.br || 0, blocks: f.bk || 0 });
        if (!wasPred || f.st !== 'pad') { o.x = f.x; o.y = f.y; }
        o.jump = f.j ? jumpOf(f.j) : null;
        if (wasPred && f.j) m.pred = null;
      }
      for (const id of [...m.frogs.keys()]) if (!seen.has(id)) m.frogs.delete(id);
    }

    // ---------- события ----------
    function seatFrog(f, pad, x, y, t, boost, ta) {
      f.tireAt = ta || 0; f.st = 'pad'; f.pad = pad; f.x = x; f.y = y; f.jump = null; f.readyAt = t + m.cfg.CROUCH; f.boost = !!boost;
      const p = m.pads[pad];
      if (p) p.flyUntil = 0;
    }
    function applyEvent(e) {
      m.stats.events++;
      const f = e.id != null ? m.frogs.get(e.id) : null;
      switch (e.type) {
        case 'start': m.clock.samples.length = 0; m.seed = e.seed; m.n0 = e.n; buildPads(e.seed, e.n); m.phase = 'countdown'; m.loser = null; m.over = null; m.heron = null; break;
        case 'go': m.phase = 'fight'; break;
        case 'jump':
          if (f) {
            f.st = 'air'; f.pad = -1;
            f.jump = jumpOf({ t0: e.t0, x0: e.x0, y0: e.y0, ang: e.ang, dist: e.dist, dur: e.dur });
            f.jump.forced = !!e.forced; f.readyAt = f.jump.L;
            if (!e.forced) f.boost = false;
            if (e.id === m.myId && m.pred) m.pred = null;
          }
          break;
        case 'land': if (f) seatFrog(f, e.pad, e.x, e.y, e.t, e.boost, e.ta); break;
        case 'fall': if (f) { f.st = 'out'; f.pad = -1; f.jump = null; if (e.x != null) { f.x = e.x; f.y = e.y; } if (e.id === m.myId) m.pred = null; } break;
        case 'block': if (f) { f.blockUntil = e.until; f.blockReadyAt = e.ready; } break;
        case 'blocked': if (f) f.blocks = (f.blocks || 0) + 1; break;
        case 'wave': {
          const ids = e.pads.concat(e.shrink || []);
          ids.forEach((id, i) => { const p = m.pads[id]; if (p) { p.sinkAt = e.sinkAts ? e.sinkAts[i] : e.sinkAt; p.cause = i >= e.pads.length ? 'shrink' : 'wave'; } });
          break;
        }
        case 'strike':
          for (const id of e.pads) { const p = m.pads[id]; if (p) { p.sinkAt = e.t + Math.hypot(p.x - e.x, p.y - e.y) / 400; p.cause = 'heron'; } }
          m.heron = null;
          break;
        case 'sunk': { const p = m.pads[e.pad]; if (p) { p.state = 'sunk'; p.flyUntil = 0; } break; }
        case 'shrunk': { const p = m.pads[e.pad]; if (p) { p.cap = 1; p.r = m.cfg.PAD_R; p.big = false; p.sinkAt = null; p.cause = null; } break; }
        case 'fly': { const p = m.pads[e.pad]; if (p) p.flyUntil = e.until; break; }
        case 'flyGot': { const p = m.pads[e.pad]; if (p) p.flyUntil = 0; break; }
        case 'heron': m.heron = { x: e.x, y: e.y, r: e.r, at: e.t, strikeAt: e.strikeAt }; break;
        case 'removed': if (f) { f.st = 'removed'; f.pad = -1; f.jump = null; } break;
        case 'offline': if (f) f.online = false; break;
        case 'online': if (f) f.online = true; break;
        case 'loser': m.loser = e.id; break;
        case 'over': m.phase = 'over'; m.over = e; break;
        default: break;
      }
      if (m.onEvent) m.onEvent(e);
    }

    // ---------- вход сообщений сервера ----------
    // local — свои часы в секундах, нужны только чтобы пометить опоздавшие события
    m.feed = function (msg, local) {
      if (msg.type === 'joined') m.myId = msg.playerId;
      else if (msg.type === 'hello') { if (msg.cfg) Object.assign(m.cfg, msg.cfg); }
      else if (msg.type === 'snap') {
        if (msg.ph === 'lobby' || msg.ph === 'countdown' || !m.pads.length) { m.queue = m.queue.filter(e => keyOf(e) == null); applySnap(msg); m.snap = null; }
        else m.snap = msg;
      } else if (msg.type === 'ev') {
        // у события есть метка времени партии (t, у прыжка t0) — ставим в очередь; без метки (start, react…) применяем сразу
        for (const e of msg.list) {
          if (keyOf(e) == null && e.type !== 'go') applyEvent(e);
          else m.queue.push(e);
        }
        m.queue.sort((a, b) => (keyOf(a) == null ? -1e9 : keyOf(a)) - (keyOf(b) == null ? -1e9 : keyOf(b)));
        if (local != null && m.clock.off != null) {
          const n = m.now(local);
          for (const e of msg.list) if (keyOf(e) != null && !deferred(e) && keyOf(e) < n - m.delay - 0.05) m.stats.lateEvents++;
        }
      } else if (msg.type === 'ack') {
        // отказ сервера (слишком часто / поздно): откатываем предсказание
        if (msg.ok === false && m.pred && m.pred.seq === msg.s) { cancelPred(); }
      }
    };

    function cancelPred() {
      const f = m.frogs.get(m.myId);
      if (m.pred && f && f.st === 'air' && !f.jump.srv) {
        f.st = 'pad'; f.pad = m.pred.fromPad; f.x = m.pred.x; f.y = m.pred.y; f.jump = null;
        m.stats.corrections++;
      }
      m.pred = null;
    }

    // применить всё, что должно было уже произойти к моменту t (время партии)
    m.advance = function (t) {
      if (m.snap && m.snap.t <= t) {
        const s = m.snap; m.snap = null;
        m.queue = m.queue.filter(e => keyOf(e) == null || keyOf(e) > s.t || e.type === 'over');
        applySnap(s);
      }
      while (m.queue.length) {
        const e = m.queue[0];
        if (keyOf(e) != null && keyOf(e) > t) break;
        m.queue.shift();
        applyEvent(e);
      }
    };

    // ---------- свой прыжок ----------
    // Возвращает true, если прыжок можно показывать сразу; дальше его подтвердит или откатит сервер
    m.predict = function (ang, pow, seq, nowT) {
      const f = m.frogs.get(m.myId);
      if (!f || m.phase !== 'fight' || f.st !== 'pad' || nowT < f.readyAt) return false;
      const plan = P.jumpPlan(f.x, f.y, ang, pow, f.boost, m.R, m.cfg);
      m.pred = { seq, fromPad: f.pad, x: f.x, y: f.y };
      f.st = 'air'; f.boost = false; f.jump = Object.assign({ t0: nowT, L: nowT + plan.dur, forced: false, srv: false }, plan);
      return true;
    };

    // ---------- свой блок ----------
    // Кнопка отзывается сразу: щит рисуем по своим часам, сервер подтвердит событием block (оно перезапишет значения)
    m.blockReady = function (nowT) {
      const f = m.frogs.get(m.myId);
      return !!f && m.phase === 'fight' && f.st === 'pad' && nowT >= (f.blockReadyAt || 0);
    };
    m.predictBlock = function (nowT) {
      const f = m.frogs.get(m.myId);
      if (!m.blockReady(nowT)) return false;
      f.blockUntil = nowT + m.cfg.BLOCK_T; f.blockReadyAt = f.blockUntil + m.cfg.BLOCK_CD;
      return true;
    };
    // кто-то летит на мой лист (вытеснение): для подсказки «нажми блок».
    // Смотрим и в очередь событий: тревога срабатывает, как только событие прыжка пришло, не дожидаясь задержки отрисовки.
    m.incoming = function (nowT) {
      const me = m.frogs.get(m.myId);
      if (!me || me.st !== 'pad') return null;
      const pd = m.pads[me.pad];
      if (!pd) return null;
      const react = m.cfg.STOMP_REACT || 0.35;
      const hits = (tx, ty) => Math.hypot(tx - pd.x, ty - pd.y) <= pd.r + m.cfg.LAND_SLACK;
      for (const f of m.frogs.values()) {
        if (f === me || f.st !== 'air' || !f.jump || f.jump.forced) continue;
        if (hits(f.jump.tx, f.jump.ty) && f.jump.L >= nowT - react) return { by: f.id, eta: Math.max(0, f.jump.L - nowT) };
      }
      for (const e of m.queue) {
        if (e.type !== 'jump' || e.forced || e.id === m.myId) continue;
        const L = e.t0 + e.dur;
        if (L >= nowT - react && hits(e.x0 + Math.cos(e.ang) * e.dist, e.y0 + Math.sin(e.ang) * e.dist)) return { by: e.id, eta: Math.max(0, L - nowT) };
      }
      return null;
    };

    // ---------- чтение состояния ----------
    // положение лягушки на момент t (для своей — по предсказанию в «текущем» времени вызывающий передаёт nowT)
    m.posOf = function (f, t) {
      if (f.st === 'air' && f.jump) return P.jumpPos(f.jump, (t - f.jump.t0) / f.jump.dur);
      return { x: f.x, y: f.y, z: 0 };
    };
    // вид «как у движка» для ботов (bots.js): мир на момент t
    m.view = function (t) {
      return { phase: m.phase, t, cfg: m.cfg, R: m.R, pads: m.pads, players: [...m.frogs.values()] };
    };
    return m;
  }

  return { createModel };
});
