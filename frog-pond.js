/*
 * «Кувшинки» — страница мультиплеера: вход, лобби, игра, итог. frog-pond-spec.md §4, §7, §8.
 * Мир — pond/model.js (события с метками времени + снимки), рисует pond-render.js. Здесь: сеть с переподключением, управление
 * рогаткой, панели, витрина и тренировка на локальном движке.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const T = (k) => (window.I18N ? I18N.t(k) : k);
  const tpl = (k, v) => String(T(k)).replace(/\{(\w+)\}/g, (_, n) => (v[n] != null ? v[n] : ''));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num1 = (x) => { try { return Number(x).toLocaleString(document.documentElement.lang || 'en', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); } catch (e) { return Number(x).toFixed(1); } };
  const P = window.PondPhysics, PM = window.PondModel, PG = window.PondGame, PB = window.PondBots, PR = window.PondRender;
  const Sound = PR.Sound, COLORS = PR.FROG_COLORS;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const nowS = () => performance.now() / 1000;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (isTouch) document.body.classList.add('is-touch');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  const vibrate = (p) => { try { if (window.MP && MP.vibrate) MP.vibrate(p); else if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} };

  const params = new URLSearchParams(location.search);
  let CODE = (params.get('r') || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 14);
  const tokenKey = () => 'pond-token-' + CODE;
  const hostKey = () => 'pond-host-' + CODE;
  try {
    const hp = params.get('h');
    if (hp && CODE && /^[A-Za-z0-9_-]{8,80}$/.test(hp)) {
      store.set(hostKey(), hp);
      const u = new URL(location.href); u.searchParams.delete('h');
      history.replaceState(null, '', u.pathname + u.search);
    }
  } catch (e) {}

  const ui = { name: store.get('pond-name') || '', ci: Number(store.get('pond-color')), claim: null, joinErr: null, codeOpen: false, colorOpen: false, dead: null };
  if (!Number.isInteger(ui.ci) || ui.ci < 0 || ui.ci > 15) ui.ci = Math.floor(Math.random() * 16);
  const net = {
    ws: null, open: false, everOpen: false, retry: 0, dead: false, me: null, token: CODE ? store.get(tokenKey()) : null, hostId: null, roster: [],
    lastMsgAt: 0, wantJoin: false, seq: 0, pending: new Map(), pingN: 0, pingSent: new Map(), connectedAt: 0, reconnects: 0,
  };

  const render = PR.create($('arena'));
render.compact = isTouch;
render.setVibrate((p) => vibrate(p));   // на телефоне имён над лягушками нет: подсвечивается только своя
  const aim = { active: false, ang: 0, pow: 0 };

  // ===================================================================
  // Модели: онлайн (с сервера) и локальная (витрина / тренировка)
  // ===================================================================
  const online = PM.createModel({ onEvent: (e) => onEvent(e, online, false) });
  let local = null;
  const useOnline = () => !!(net.me && online.pads.length && online.phase !== 'lobby');
  const cur = () => (useOnline() ? online : local ? local.model : online);

  function startLocal(mode) {
    const cfg = mode === 'demo' ? { COUNTDOWN: 0.01 } : { COUNTDOWN: 0.01, WAVE_FIRST: 1e9, HERON_FIRST: 1e9, LETHAL_T: 1e9, MAX_T: 1e9, FLY_FIRST: 2, STAY_T: 1e9 };   // тренировка: листья не устают и не тонут
    const g = PG.createGame({ seed: Math.floor(Math.random() * 4294967295) + 1, cfg, rng: Math.random });
    const model = PM.createModel({ delay: 0, onEvent: (e) => onEvent(e, model, true) });
    const L = { g, model, mode, bots: new Map(), meId: mode === 'practice' ? 'me' : null, restartAt: 0, acc: 0 };
    const names = mode === 'demo' ? ['🐸', 'Kvak', 'Pip', 'Lily', 'Rana', 'Toad'] : ['Kvak', 'Pip', 'Lily'];
    const styles = PB.STYLE_KEYS;
    if (L.meId) g.addPlayer('me', ui.name || '…', ui.ci);
    names.forEach((n, i) => { g.addPlayer('b' + i, n, (ui.ci + 3 + i * 3) % 16); L.bots.set('b' + i, PB.createBot(styles[i % styles.length], Math.random() * 1e9)); });
    g.start();
    model.feed({ type: 'hello', cfg: g.cfg });
    model.myId = L.meId;
    model.feed({ type: 'ev', gt: 0, list: g.drainEvents() }, nowS());
    model.feed(Object.assign({ type: 'snap' }, g.snapshot()), nowS());
    local = L;
    return L;
  }
  function tickLocal(dt) {
    const L = local;
    if (!L) return;
    const g = L.g;
    for (const f of g.players) {
      const bot = L.bots.get(f.id);
      if (!bot) continue;
      const m = PB.think(g, f, bot, dt);
      if (m) g.input(f.id, m, 0);
      if (PB.wantBlock(g, f, bot)) g.block(f.id, 0);
    }
    g.step(dt);
    const evs = g.drainEvents();
    if (evs.length) L.model.feed({ type: 'ev', gt: g.clock(), list: evs }, nowS());
    L.model.sync(g.clock(), 0, nowS());
    L.model.advance(g.clock());
    const me = L.meId && g.byId.get(L.meId);
    if (g.phase === 'over' || (me && me.st === 'out')) {
      if (!L.restartAt) L.restartAt = nowS() + (me && me.st === 'out' ? 1.1 : 2.6);
      else if (nowS() > L.restartAt) { const mode = L.mode; local = null; startLocal(mode); }
    }
  }
  function ensureLocal() {
    const wantMode = net.me ? 'practice' : 'demo';
    if (!local || local.mode !== wantMode) startLocal(wantMode);
  }

  // ===================================================================
  // Сеть
  // ===================================================================
  function connect() {
    if (net.dead || !CODE) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/pond/ws?r=${encodeURIComponent(CODE)}`); } catch (e) { return retryLater(); }
    net.ws = ws;
    ws.onopen = () => {
      if (net.ws !== ws) return;
      net.open = true; net.everOpen = true; net.retry = 0; net.lastMsgAt = nowS(); net.connectedAt = nowS();
      $('conn').classList.remove('on');
      if (flow && flow.resume()) return;
      if (net.token || net.wantJoin) sendJoin();
      sendPing();
    };
    ws.onmessage = (e) => { if (net.ws !== ws) return; net.lastMsgAt = nowS(); try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = (ev) => {
      if (net.ws !== ws) return;
      net.open = false;
      if (net.dead) return;
      if (ev && ev.code === 4000 && ev.reason === 'anon_timeout') { setTimeout(connect, 50); return; }
      if (!net.everOpen && net.retry === 0) {
        net.retry = 1;
        fetch('/pond/api/room?r=' + encodeURIComponent(CODE), { cache: 'no-store' })
          .then((r) => { if (r.status === 404) return roomGoneNow(); retryLater(); })
          .catch(() => retryLater());
        return;
      }
      retryLater();
    };
    ws.onerror = () => {};
  }
  function roomGoneNow() { if (rg) return rg.gone(); showDead('no_room'); }
  // 0,3 → 0,6 → 1,2 → 2 с с джиттером, без ограничения числа попыток (§7.6)
  function retryLater() {
    if (net.dead) return;
    net.retry++;
    net.reconnects++;
    $('conn').textContent = net.retry > 6 && !net.everOpen ? T('conn_blocked') : T('conn_lost');
    // баннер не мигает на коротких обрывах
    setTimeout(() => { if (!net.open && !net.dead) $('conn').classList.add('on'); }, net.retry > 1 ? 0 : 900);
    const d = Math.min(2000, 300 * Math.pow(2, Math.min(net.retry - 1, 3))) * (0.8 + Math.random() * 0.4);
    setTimeout(connect, d);
  }
  function forceReconnect() {
    if (net.dead || !CODE) return;
    const old = net.ws;
    net.ws = null; net.open = false;
    try { old && old.close(); } catch (e) {}
    net.retry = 0;
    connect();
  }
  function send(m) { if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(m)); }
  function buildJoin() { return { type: 'join', name: ui.name, ci: ui.ci, token: net.token, hostToken: store.get(hostKey()) || undefined }; }
  function sendJoin(extra) {
    if (flow && flow.join(extra)) return;
    const m = buildJoin();
    if (extra) for (const k in extra) m[k] = extra[k];
    send(m);
  }
  let flow = null, rg = null;
  if (window.MP) {
    flow = MP.joinFlow({
      send: (m) => send(m), buildJoin,
      onClaimPrompt: (c) => { ui.claim = c; redraw(true); },
      onGiveUp: () => { ui.claim = null; net.wantJoin = false; ui.joinErr = 'name_taken'; redraw(true); },
    });
    rg = MP.roomGone({
      showForm: () => { net.dead = false; CODE = ''; net.wantJoin = false; ui.codeOpen = true; ui.joinErr = 'no_room'; try { history.replaceState(null, '', location.pathname); } catch (e) {} redraw(true); },
      onClosed: () => showDead('room_closed'),
    });
  }

  // синхронизация часов и пульс: клиент меряет свой RTT, сервер — свой (по hb/hbr)
  function sendPing() { const c = ++net.pingN; net.pingSent.set(c, nowS()); if (net.pingSent.size > 6) net.pingSent.delete(net.pingSent.keys().next().value); send({ type: 'ping', c }); }
  setInterval(() => { if (net.open) sendPing(); }, 2000);
  // «тихий» обрыв: сервер шлёт пульс раз в 2 с; нет ни одного сообщения 5 с — сокет мёртв, переподключаемся сразу
  setInterval(() => { if (net.open && nowS() - net.lastMsgAt > 5) forceReconnect(); }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (CODE && !net.dead && (!net.open || nowS() - net.lastMsgAt > 3)) forceReconnect();
    if (wantWake) wake(true);
  });
  window.addEventListener('online', () => { if (CODE && !net.dead) forceReconnect(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted && CODE && !net.dead) forceReconnect(); });

  let wl = null, wantWake = false;
  async function wake(on) {
    wantWake = on;
    try {
      if (on && !wl && navigator.wakeLock) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); }
      else if (!on && wl) { await wl.release(); wl = null; }
    } catch (e) { wl = null; }
  }

  function onMsg(m) {
    if (flow && flow.handle(m)) return;
    switch (m.type) {
      case 'hello': online.feed(m, nowS()); if (window.MP) MP.applyHello(m); if (rg) rg.hello(); break;
      case 'joined':
        ui.claim = null;
        if (m.name) { ui.name = m.name; store.set('pond-name', m.name); if (m.renamed) toast(tpl('renamed_toast', { name: m.name })); }
        net.me = m.playerId; net.token = m.token; store.set(tokenKey(), m.token);
        online.feed(m, nowS());
        ui.joinErr = null;
        redraw(true);
        break;
      case 'roster': net.roster = m.players; net.hostId = m.hostId; if (!document.body.classList.contains('playing')) redraw(); break;
      case 'snap': online.feed(m, nowS()); break;
      case 'ev': online.feed(m, nowS()); break;
      case 'ack': net.pending.delete(m.s); online.feed(m, nowS()); break;
      case 'hb': send({ type: 'hbr', c: m.c }); break;
      case 'pong': {
        const t0 = net.pingSent.get(m.c);
        if (t0 != null) { net.pingSent.delete(m.c); const rtt = nowS() - t0; if (rtt >= 0 && rtt < 5) online.sync(m.gt, rtt, nowS()); }
        break;
      }
      case 'error':
        if (m.error === 'room_expired') return rg ? rg.gone() : showDead('no_room');
        if (!net.me) { ui.joinErr = m.error; net.wantJoin = false; redraw(true); } else toast(T(m.error));
        break;
      case 'kicked': net.me = null; store.set(tokenKey(), ''); net.token = null; showDead('kicked'); break;
      case 'replaced': net.me = null; showDead('replaced'); break;
      default: break;
    }
  }

  // ===================================================================
  // События: эффекты, лента, баннеры
  // ===================================================================
  let lastLoser = null;
  function nameOf(m, id) { const f = m.frogs.get(id); if (f) return f.name; const p = net.roster.find((x) => x.id === id); return p ? p.name : '?'; }
  function onEvent(e, m, isLocal) {
    if (m !== cur()) return;
    Sound.muted = isLocal && !!local && local.mode === 'demo';   // витрина на главной играет без звука
    render.event(e, m, false);
    Sound.muted = false;
    const feed = $('feed');
    const line = (s) => { const d = document.createElement('div'); d.textContent = s; feed.appendChild(d); while (feed.children.length > 4) feed.firstChild.remove(); setTimeout(() => d.remove(), 5000); };
    switch (e.type) {
      case 'stomp': if (!isLocal) line(tpl('f_stomp', { a: nameOf(m, e.by), b: nameOf(m, e.id) })); if (e.id === m.myId) vibrate([30, 40, 30]); break;
      case 'fall':
        if (!isLocal) line(tpl(e.cause === 'heron' ? 'f_heron' : e.cause === 'wave' ? 'f_wave' : e.cause === 'stomp' ? 'f_stomped' : 'f_miss', { n: nameOf(m, e.id) }));
        if (e.id === m.myId) vibrate(220);
        break;
      case 'land': if (e.id === m.myId) vibrate(10); break;
      case 'loser': if (!isLocal) { lastLoser = e.id; showVerdict(e.id === m.myId ? T('verdict_you') : tpl('verdict', { name: nameOf(m, e.id) })); } break;
      case 'go': if (!isLocal) bigText(T('go_word')); break;
      case 'over': if (!isLocal) { wake(false); const w = (e.kings || []).includes(m.myId); if (w) { Sound.win(); } redraw(true); } break;
      case 'react': { const R = m.R || 200; render.fx.text((Math.random() - 0.5) * R * 1.4, (Math.random() - 0.5) * R * 1.2, e.e, '#fff'); break; }
      case 'start': if (!isLocal) { aim.active = false; lastLoser = null; hideVerdict(); wake(true); redraw(true); } break;
      default: break;
    }
  }
  let verdictT = 0;
  function showVerdict(s) { const v = $('verdict'); v.textContent = s; v.classList.add('show'); clearTimeout(verdictT); verdictT = setTimeout(hideVerdict, 1800); }
  function hideVerdict() { $('verdict').classList.remove('show'); }
  function bigText(s) { const b = $('big'); b.textContent = s; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show'); }

  // ===================================================================
  // Управление: рогатка
  // ===================================================================
  const canvas = $('arena');
  let drag = null;
  // Оттяжка привязана к масштабу на экране: палец на 0,7 экранной длины прыжка = прыжок на эту длину, поэтому дальней кувшинки
  // достаёшь коротким движением большого пальца (раньше на телефоне нужно было тянуть ~120 px и цель почти не двигалась)
  const PULL_K = 0.7;
  function pullToPow(len) {
    const m = cur(), f = mine(m), s = render.cam.s || 1;
    if (!m || !m.R) return 0;
    const jmax = P.jumpMax(m.R, m.cfg), jmin = m.cfg.JUMP_MIN;
    let D = len / (PULL_K * s);
    if (f && f.boost) D /= m.cfg.FLY_BOOST;
    return clamp((D - jmin) / (jmax - jmin), 0, 1);
  }
  const DEAD = 12;
  function mine(m) { return m && m.myId ? m.frogs.get(m.myId) : null; }
  function canPlay() {
    const m = cur(), f = mine(m);
    if (!f || !(f.st === 'pad' || f.st === 'air')) return false;
    if (local && m === local.model) return local.mode === 'practice' && local.g.phase === 'fight';
    return m.phase === 'fight';
  }
  function setPull(on, x0, y0, x, y, pow) {
    const s = $('pull');
    s.classList.toggle('on', !!on);
    if (!on) return;
    $('pullA').setAttribute('cx', x0); $('pullA').setAttribute('cy', y0);
    $('pullB').setAttribute('cx', x); $('pullB').setAttribute('cy', y);
    $('pullL').setAttribute('x1', x0); $('pullL').setAttribute('y1', y0); $('pullL').setAttribute('x2', x); $('pullL').setAttribute('y2', y);
    $('pullA').setAttribute('r', 16 + pow * 16);
  }
  function updateAimFromDrag(x, y) {
    const vx = drag.x0 - x, vy = drag.y0 - y, len = Math.hypot(vx, vy);
    if (len < DEAD) { aim.active = false; document.body.classList.remove('aimed'); setPull(true, drag.x0, drag.y0, x, y, 0); return; }
    aim.active = true; aim.ang = Math.atan2(vy, vx); aim.pow = pullToPow(len);
    document.body.classList.add('aimed');
    setPull(true, drag.x0, drag.y0, x, y, aim.pow);
  }
  canvas.addEventListener('pointerdown', (e) => {
    Sound.ensure();
    if (!canPlay() || drag || e.button > 0) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    updateAimFromDrag(e.clientX, e.clientY);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.id) { updateAimFromDrag(e.clientX, e.clientY); e.preventDefault(); } });
  function endDrag(e, fire) {
    if (!drag || e.pointerId !== drag.id) return;
    const was = aim.active, a = aim.ang, p = aim.pow;
    drag = null; aim.active = false; document.body.classList.remove('aimed'); setPull(false);
    if (fire && was) doJump(a, p);
  }
  canvas.addEventListener('pointerup', (e) => endDrag(e, true));
  canvas.addEventListener('pointercancel', (e) => endDrag(e, false));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // клавиатура: стрелки/WASD — направление, зажатый пробел — сила
  const keys = new Set();
  let charge = null;
  window.addEventListener('keydown', (e) => {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's', ' '].includes(k)) {
      if (!canPlay()) return;
      e.preventDefault();
      Sound.ensure();
      if (k === ' ') { if (!charge) charge = { t0: nowS() }; } else keys.add(k);
      kbAim();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') {
      if (charge && aim.active) { const a = aim.ang, p = aim.pow; charge = null; aim.active = false; keys.clear(); doJump(a, p); }
      charge = null;
    } else keys.delete(k);
  });
  function kbAim() {
    let dx = 0, dy = 0;
    if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
    if (keys.has('arrowright') || keys.has('d')) dx += 1;
    if (keys.has('arrowup') || keys.has('w')) dy -= 1;
    if (keys.has('arrowdown') || keys.has('s')) dy += 1;
    if (dx || dy) aim.ang = Math.atan2(dy, dx);
    else if (!aim.active) { const f = mine(cur()); aim.ang = f ? Math.atan2(-f.y, -f.x) : 0; }
    aim.active = true;
    if (!charge) aim.pow = Math.max(aim.pow, 0.35);
  }
  function stepKeyboard() {
    if (!charge) return;
    const t = (nowS() - charge.t0) / 0.9;
    aim.pow = clamp(0.1 + t * 0.9, 0, 1);
    if (!canPlay()) { charge = null; aim.active = false; }
  }

  let jumpsMade = Number(store.get('pond-jumps')) || 0;
  function doJump(ang, pow) {
    if (!canPlay()) return;
    if (jumpsMade < 3) { jumpsMade++; store.set('pond-jumps', String(jumpsMade)); }
    Sound.ensure();
    if (local && cur() === local.model) { local.g.input(local.meId, { ang, pow, seq: ++net.seq }, 0); return; }
    const s = ++net.seq, a = r3(ang), p = r3(pow), msg = { type: 'j', a, p, s };
    const nowT = online.now(nowS());
    if (online.predict(a, p, s, nowT)) { Sound.jump(p); render.face.set(online.myId, a); vibrate(8); }
    net.pending.set(s, { msg, at: nowS(), n: 0 });
    send(msg);
  }
  // ----- блок -----
  const blockBtn = $('blockBtn');
  function doBlock() {
    Sound.ensure();
    const m = cur();
    if (local && m === local.model) {
      if (local.g.block(local.meId, 0)) { m.predictBlock(local.g.clock()); }
      return;
    }
    const nowT = online.now(nowS());
    if (!online.predictBlock(nowT)) return;
    Sound.shield(); vibrate(12);
    send({ type: 'b' });
  }
  blockBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); doBlock(); });
  blockBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'b' || e.key === 'B' || e.key === 'и' || e.key === 'И') { if (canPlay()) { e.preventDefault(); doBlock(); } }
  });
  let lastBlockClass = '', lastBlockLbl = '';
  function updateBlockBtn(m, nowT) {
    const f = mine(m);
    if (!f || !blockBtn) return;
    const bt = (m.cfg.BLOCK_T || 1), cd = (m.cfg.BLOCK_CD || 2.5);
    let cls = 'ready', p = 1;
    if (nowT < (f.blockUntil || 0)) { cls = 'active'; p = clamp((f.blockUntil - nowT) / bt, 0, 1); }
    else if (nowT < (f.blockReadyAt || 0)) { cls = 'cool'; p = clamp(1 - (f.blockReadyAt - nowT) / cd, 0, 1); }
    const inc = (cls === 'ready') && m.incoming(nowT);
    const full = cls + (inc ? ' warn' : '');
    if (full !== lastBlockClass) { blockBtn.className = 'block-btn ' + full; lastBlockClass = full; }
    blockBtn.style.setProperty('--p', p.toFixed(3));
    const lbl = cls === 'cool' ? (Math.max(0, f.blockReadyAt - nowT)).toFixed(1) : '🛡';
    if (lbl !== lastBlockLbl) { blockBtn.firstElementChild.textContent = lbl; lastBlockLbl = lbl; }
    render.incoming = !!m.incoming(nowT);
  }

  // неподтверждённый прыжок повторяем (тот же номер — сервер дубль не исполнит)
  setInterval(() => {
    const rtt = online.clock.rtt === Infinity ? 0 : online.clock.rtt;
    for (const [s, p] of net.pending) {
      if (nowS() - p.at > Math.max(0.3, rtt * 1.5 + 0.1) && p.n < 3) { p.n++; p.at = nowS(); send(p.msg); }
      else if (p.n >= 3 && nowS() - p.at > 1) net.pending.delete(s);
    }
  }, 100);

  // ===================================================================
  // Панели
  // ===================================================================
  function toast(s) { const t = $('toast'); t.textContent = s; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200); }
  function setPanel(body, foot) { $('pbody').innerHTML = body; $('pfoot').innerHTML = foot || ''; $('pfoot').style.display = foot ? '' : 'none'; $('pbody').scrollTop = 0; fitInsets(); }
  const brand = () => `<div class="brand">🐸 ${esc(T('game'))}<small>${esc(T('sub'))}</small></div>`;
  const rulesHtml = () => `<div class="rules"><div><span>👆</span><span>${esc(T('rule1'))}</span></div><div><span>🔴</span><span>${esc(T('rule2'))}</span></div><div><span>💥</span><span>${esc(T('rule3'))}</span></div><div><span>😅</span><span>${esc(T('rule4'))}</span></div></div>`;
  const swatches = (sel, taken) => `<div class="swatches">${COLORS.map((c, i) => `<button type="button" class="sw${i === sel ? ' on' : ''}" data-ci="${i}" style="--c:${c[0]}" ${taken.has(i) ? 'disabled' : ''} aria-label="${i + 1}"></button>`).join('')}</div>`;
  const ciOf = (id) => { const p = net.roster.find((x) => x.id === id); return p ? p.ci : 0; };

  function phaseNow() { return net.me ? online.phase : 'lobby'; }
  let panelKey = '';
  function redraw(force) {
    const key = [CODE, net.me, phaseNow(), net.roster.length, !!ui.claim, ui.dead, ui.codeOpen, ui.joinErr, ui.colorOpen, net.hostId, net.roster.map((p) => p.id + p.online + p.ci + (p.ping > 250 ? 'x' : '')).join(','), online.over ? 'o' : ''].join('|');
    if (!force && key === panelKey) return;
    panelKey = key;
    if (ui.dead) return;
    if (ui.claim) return drawClaim();
    if (!CODE) return drawHome();
    if (!net.me) return drawJoin();
    const ph = phaseNow();
    if (ph === 'over') return drawResults();
    if (ph === 'countdown' || ph === 'fight') return; // панель уехала
    drawLobby();
  }
  function drawHome() {
    setPanel(`<a class="back" href="index.html">${esc(T('back'))}</a>${brand()}<p class="lede">${esc(T('lede'))}</p><div class="sec">${rulesHtml()}</div>
      ${ui.codeOpen ? `<div class="sec"><div class="name-row"><label class="fine" for="codeIn">${esc(T('code_ph'))}</label><span class="err">${ui.joinErr ? esc(T(ui.joinErr)) : ''}</span></div>
        <input class="field" id="codeIn" placeholder="${esc(T('code_ph'))}" autocapitalize="characters" autocomplete="off" enterkeyhint="go" style="margin-top:6px"></div>` : ''}`,
      `<button class="btn" id="create" type="button">${esc(T('create'))}</button>` +
      (ui.codeOpen ? `<button class="btn ghost" id="enter" type="button">${esc(T('enter'))}</button>` : `<button class="btn ghost" id="haveCode" type="button">${esc(T('have_code'))}</button>`));
    $('create').onclick = createRoom;
    if ($('haveCode')) $('haveCode').onclick = () => { ui.codeOpen = true; ui.joinErr = null; redraw(true); setTimeout(() => $('codeIn') && $('codeIn').focus(), 50); };
    const go = () => { const c = ($('codeIn').value || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 14); if (c) enterRoom(c); };
    if ($('enter')) $('enter').onclick = go;
    if ($('codeIn')) $('codeIn').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }
  function drawJoin() {
    const taken = new Set(net.roster.map((p) => p.ci));
    if (taken.has(ui.ci)) { for (let i = 0; i < 16; i++) if (!taken.has(i)) { ui.ci = i; break; } }
    setPanel(`<a class="back" href="index.html">${esc(T('back'))}</a>${brand()}
      <div class="sec"><h3>${esc(T('room'))} <span>${esc(CODE)}</span></h3>
        <div class="name-row"><label class="fine" for="nameIn">${esc(T('name_title'))}</label><span class="err" id="err">${ui.joinErr ? esc(T(ui.joinErr)) : ''}</span></div>
        <input class="field" id="nameIn" ${window.MP ? '' : 'maxlength="15"'} placeholder="${esc(T('name_ph'))}" value="${esc(ui.name)}" autocomplete="nickname" enterkeyhint="go" style="margin-top:6px">
        <div class="fine" style="margin:12px 0 6px">${esc(T('color'))}</div>${swatches(ui.ci, taken)}</div>
      <div class="sec">${rulesHtml()}</div>
      ${net.roster.length ? `<div class="sec"><h3>${esc(T('players'))} <span>${esc(tpl('of_max', { n: net.roster.length, m: 12 }))}</span></h3>${playerList(false)}</div>` : ''}`,
      (online.phase === 'fight' || online.phase === 'countdown' ? `<div class="waitline">${esc(T('join_later'))}</div>` : '') + `<button class="btn" id="joinBtn" type="button">${esc(T('join'))}</button>`);
    const go = () => {
      const n = window.MP ? MP.clip($('nameIn').value.trim(), 15) : $('nameIn').value.trim();
      if (!n) { ui.joinErr = 'bad_name'; $('err').textContent = T('bad_name'); return; }
      ui.name = n; store.set('pond-name', n); store.set('pond-color', String(ui.ci));
      Sound.ensure(); net.wantJoin = true; sendJoin();
    };
    $('joinBtn').onclick = go;
    $('nameIn').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $('nameIn').oninput = () => { if (window.MP) { const v = MP.clip($('nameIn').value, 15); if (v !== $('nameIn').value) $('nameIn').value = v; } ui.name = $('nameIn').value; };
    document.querySelectorAll('.sw').forEach((b) => (b.onclick = () => { ui.ci = Number(b.dataset.ci); drawJoin(); }));
  }
  function drawClaim() {
    const c = ui.claim;
    setPanel(`<a class="back" href="index.html">${esc(T('back'))}</a>${brand()}<div class="sec"><h3>${esc(T('claim_title'))}</h3><p class="lede">${esc(tpl('claim_text', { name: c.name }))}</p></div>`,
      `<button class="btn" id="claimYes" type="button">${esc(T('btn_claim_yes'))}</button><button class="btn ghost" id="claimNo" type="button">${esc(T('btn_claim_no'))}</button>`);
    $('claimYes').onclick = () => { const p = ui.claim; ui.claim = null; net.wantJoin = true; Sound.ensure(); if (p) p.accept(); };
    $('claimNo').onclick = () => { const p = ui.claim; ui.claim = null; net.wantJoin = true; if (p) p.decline(); };
  }
  function playerList(withKick) {
    const iAmHost = net.me && net.me === net.hostId;
    return `<div class="plist">${net.roster.map((p) => `<div class="pl${p.id === net.me ? ' me' : ''}${p.online ? '' : ' off'}">
      <span class="dot" style="--c:${COLORS[p.ci % 16][0]}"></span>
      <b>${p.id === net.hostId ? '🔑 ' : ''}${esc(p.name)}${p.id === net.me ? esc(T('you')) : ''}</b>
      <span class="ping${p.ping > 250 ? ' bad' : ''}" title="${p.ping > 250 ? esc(T('ping_bad')) : ''}">${p.online ? (p.ping ? p.ping + ' ms' : '') : '📡'}</span>
      ${withKick && iAmHost && p.id !== net.me ? `<button class="x" type="button" data-kick="${esc(p.id)}" aria-label="kick">✕</button>` : '<span></span>'}
    </div>`).join('')}</div>`;
  }
  function drawLobby() {
    const iAmHost = net.me === net.hostId;
    const host = net.roster.find((p) => p.id === net.hostId);
    const n = net.roster.filter((p) => p.online).length;
    const meP = net.roster.find((p) => p.id === net.me);
    const taken = new Set(net.roster.filter((p) => p.id !== net.me).map((p) => p.ci));
    const url = location.origin + location.pathname + '?r=' + CODE;
    setPanel(`${brand()}
      <div class="sec"><h3>${esc(T('room'))}</h3><div class="code-box"><div><div class="code">${esc(CODE)}</div><button class="link" id="copy" type="button">${esc(T('copy'))}</button>${window.MP && !MP.off && store.get(hostKey()) ? `<button class="link" id="hostLink" type="button">${esc(T('host_link'))}</button>` : ''}</div><div class="qr" id="qr"></div></div></div>
      <div class="sec"><h3>${esc(T('players'))} <span>${esc(tpl('of_max', { n: net.roster.length, m: 12 }))}</span></h3>${playerList(true)}</div>
      <div class="sec"><h3>${esc(T('controls'))}</h3><p class="fine">${esc(T('ctrl_touch'))}</p><p class="fine" style="margin-top:4px">${esc(T('ctrl_kb'))}</p><p class="fine" style="margin-top:8px">${esc(T('practice'))}</p></div>
      <div class="sec"><h3>${esc(T('color'))}</h3>${ui.colorOpen ? swatches(meP ? meP.ci : 0, taken) : `<button class="link" id="colorOpen" type="button">${esc(T('change_color'))}</button>`}</div>`,
      iAmHost ? `<button class="btn" id="startBtn" type="button" ${n < 2 ? 'disabled' : ''}>${esc(n < 2 ? T('need_two') : T('start'))}</button>`
        : `<div class="waitline">${esc(tpl('wait_host', { name: host ? host.name : '…' }))}</div>`);
    if ($('startBtn')) $('startBtn').onclick = () => { Sound.ensure(); send({ type: 'start' }); };
    $('copy').onclick = () => copyLink(url);
    if ($('hostLink')) $('hostLink').onclick = () => MP.hostLink({ hostKeyFn: hostKey, boardPath: 'frog-pond.html', getRoom: () => CODE, onToast: (k) => { if (k === 'copied' || k === 'shared') toast(T('copied')); } }).copy();
    document.querySelectorAll('[data-kick]').forEach((b) => (b.onclick = () => send({ type: 'kick', playerId: b.dataset.kick })));
    if ($('colorOpen')) $('colorOpen').onclick = () => { ui.colorOpen = true; redraw(true); };
    document.querySelectorAll('.sw').forEach((b) => (b.onclick = () => { ui.ci = Number(b.dataset.ci); ui.colorOpen = false; store.set('pond-color', String(ui.ci)); send({ type: 'hat', ci: ui.ci }); }));
    const mkQr = () => { if (window.QRCode && $('qr') && !$('qr').children.length) new QRCode($('qr'), { text: url, width: 176, height: 176, colorDark: '#06222c', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M }); };
    mkQr(); setTimeout(mkQr, 800);
  }
  function copyLink(url) {
    const ok = () => toast(T('copied'));
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok, () => prompt('', url)); else prompt('', url);
  }
  function drawResults() {
    const ov = online.over;
    if (!ov) return drawLobby();
    const pl = ov.players || [];
    const nm = (id) => { const p = pl.find((x) => x.id === id); return p ? p.name : '?'; };
    const lo = pl.find((x) => x.id === ov.loser);
    const note = ov.lot ? T('res_lot') : lo && lo.fellAt != null ? tpl('res_first_at', { s: num1(lo.fellAt) }) : '';
    const kings = (ov.kings || []).map(nm).join(', ');
    const rows = pl.filter((p) => p.place != null || p.removed).sort((a, b) => (a.place || 99) - (b.place || 99)).map((p) => `<div class="r${p.id === net.me ? ' me' : ''}"><span>${p.place || '—'}</span><span class="dot" style="--c:${COLORS[ciOf(p.id) % 16][0]}"></span><span class="nm">${esc(p.name)}${p.id === ov.loser ? ' 😅' : ''}${(ov.kings || []).includes(p.id) ? ' 👑' : ''}</span><span class="ex">${p.stomps ? esc(tpl('stomps', { n: p.stomps })) : ''}${p.cause === 'heron' ? ' 🐦' : p.cause === 'wave' ? ' 🌊' : p.cause === 'miss' ? ' 🙃' : ''}${p.removed ? ' 📡' : ''}</span></div>`).join('');
    const top = pl.slice().sort((a, b) => b.stomps - a.stomps)[0];
    const selfs = pl.filter((p) => p.cause === 'miss' && p.fellAt != null).sort((a, b) => a.fellAt - b.fellAt)[0];
    const noms = [];
    if (top && top.stomps > 0) noms.push(`<div><span>${esc(T('nom_stomp'))}</span><b>${esc(top.name)} · ${top.stomps}</b></div>`);
    const bb = pl.slice().sort((a, b) => (b.blocks || 0) - (a.blocks || 0))[0];
    if (bb && bb.blocks > 0) noms.push(`<div><span>${esc(T('nom_block'))}</span><b>${esc(bb.name)} · ${bb.blocks}</b></div>`);
    if (selfs) noms.push(`<div><span>${esc(T('nom_self'))}</span><b>${esc(selfs.name)}</b></div>`);
    const iAmHost = net.me === net.hostId, host = net.roster.find((p) => p.id === net.hostId);
    setPanel(`${brand()}<div class="host-card"><div class="lbl">${esc(T('res_host'))}</div><div class="nm">😅 ${esc(nm(ov.loser))}</div><div class="note">${esc(note)}</div></div>
      <div class="king-line">${ov.draw ? esc(T('res_draw')) : `${esc(String(T('res_king')).split('{names}')[0])}<b>${esc(kings || '—')}</b>`}</div>
      <div class="table">${rows}</div><div class="noms">${noms.join('')}</div>`,
      iAmHost ? `<div class="res-btns"><button class="btn" id="again" type="button">${esc(T('again'))}</button><button class="btn ghost" id="lob" type="button">${esc(T('to_lobby'))}</button></div>`
        : `<div class="waitline">${esc(tpl('wait_again', { name: host ? host.name : '…' }))}</div>`);
    if ($('again')) $('again').onclick = () => { Sound.ensure(); send({ type: 'start' }); };
    if ($('lob')) $('lob').onclick = () => send({ type: 'lobby' });
  }
  function showDead(kind) {
    net.dead = true; ui.dead = kind;
    try { net.ws && net.ws.close(); } catch (e) {}
    $('conn').classList.remove('on');
    document.body.classList.remove('playing', 'watching');
    const map = { no_room: ['no_room', 'no_room_text'], room_closed: ['room_closed', 'room_closed_text'], kicked: ['kicked', ''], replaced: ['replaced', ''] };
    const [title, text] = map[kind] || [kind, ''];
    setPanel(`<a class="back" href="index.html">${esc(T('back'))}</a>${brand()}<h2 style="font-size:20px">${esc(T(title))}</h2>${text ? `<p class="lede">${esc(T(text))}</p>` : ''}`,
      kind === 'replaced' ? `<button class="btn" id="here" type="button">${esc(T('play_here'))}</button>` : `<a class="btn" href="frog-pond.html">${esc(T('new_game'))}</a>`);
    if ($('here')) $('here').onclick = () => { net.dead = false; ui.dead = null; net.retry = 0; net.everOpen = false; $('conn').classList.remove('on'); connect(); redraw(true); };
  }
  async function createRoom() {
    Sound.ensure();
    $('create').disabled = true;
    try {
      const r = await fetch('/pond/api/rooms', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'server_error');
      store.set('pond-host-' + j.code, j.hostToken);
      enterRoom(j.code);
    } catch (e) { ui.joinErr = /too_many/.test(e.message) ? 'too_many_rooms' : 'conn_blocked'; ui.codeOpen = false; redraw(true); toast(T(ui.joinErr)); }
  }
  function enterRoom(code) {
    CODE = code; net.token = store.get(tokenKey()); net.me = null; net.roster = []; net.dead = false; ui.dead = null; ui.codeOpen = false; ui.joinErr = null;
    try { history.replaceState(null, '', location.pathname + '?r=' + CODE); } catch (e) {}
    connect(); redraw(true);
  }

  // ===================================================================
  // Раскладка: куда ставить пруд
  // ===================================================================
  function fitInsets() {
    const body = document.body, pn = $('panel');
    const ins = { l: 0, t: 0, r: 0, b: 0 };
    if (body.classList.contains('playing') || body.classList.contains('watching')) { ins.t = 46; ins.b = isTouch ? 56 : 24; }
    else {
      // размеры панели — по раскладке (offset*), а не по getBoundingClientRect: во время въезда/выезда панель сдвинута transform-ом
      const narrow = innerWidth < 740 && !(innerHeight <= 560 && innerWidth > innerHeight);
      if (narrow) { ins.b = pn.offsetHeight + 12; ins.t = 46; }
      else ins.l = pn.offsetLeft + pn.offsetWidth + 8;
    }
    render.insets = ins;
  }
  window.addEventListener('resize', () => { render.resize(); fitInsets(); });

  // ===================================================================
  // Кадр
  // ===================================================================
  let lastK = null, lastPhase = '', lastFrame = 0, lastBody = '';
  function syncBody(m) {
    const f = mine(m), body = document.body;
    const inRound = useOnline() && (m.phase === 'countdown' || m.phase === 'fight');
    const playing = inRound && f && f.inGame && (f.st === 'pad' || f.st === 'air');
    const watching = inRound && !playing;
    const key = (playing ? 'p' : '') + (watching ? 'w' : '') + (!useOnline() ? 'l' : '');
    if (key !== lastBody) {
      lastBody = key;
      body.classList.toggle('playing', !!playing);
      body.classList.toggle('watching', !!watching);
      body.classList.toggle('inlobby', !inRound);
      fitInsets();
      if (watching) $('outpill').innerHTML = `${esc(T('spectate'))} ${['🔥', '😂', '😱', '👏'].map((e) => `<button type="button" data-e="${e}">${e}</button>`).join('')}`;
      document.querySelectorAll('#outpill button').forEach((b) => (b.onclick = () => send({ type: 'react', e: b.dataset.e })));
    }
  }
  function updateHud(m, nowT) {
    if (m.phase === 'countdown') {
      const k = Math.ceil(-nowT);
      if (k !== lastK && k > 0 && k <= 3) { lastK = k; bigText(String(k)); Sound.tick(); }
    } else lastK = null;
    if (m.phase === 'fight') {
      const t = Math.max(0, Math.floor(nowT));
      $('timer').textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
      let n = 0; for (const f of m.frogs.values()) if (f.st === 'pad' || f.st === 'air') n++;
      $('alive').textContent = '🐸 ' + n;
    }
    // индикатор связи
    const chip = $('chip');
    if (useOnline() && online.clock.rtt !== Infinity) {
      const ms = Math.round(online.clock.rtt * 1000);
      chip.textContent = ms + ' ms';
      chip.className = 'net-chip ' + (ms > 250 ? 'bad' : ms > 100 ? 'mid' : '');
    }
    $('hint').textContent = jumpsMade >= 3 ? '' : isTouch ? T('hint_aim') : T('hint_kb');
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0.016;
    lastFrame = ts;
    ensureLocalIfNeeded();
    if (!useOnline() && local) tickLocal(dt);
    const m = cur();
    render.setModel(m);
    let nowT, renderT;
    if (m === online) {
      nowT = online.now(nowS()); renderT = nowT - online.delay;
      if (online.clock.off != null) online.advance(renderT);
    } else { nowT = local ? local.g.clock() : 0; renderT = nowT; }
    stepKeyboard();
    syncBody(m);
    const ph = phaseNow();
    if (ph !== lastPhase) { lastPhase = ph; redraw(true); }
    updateHud(m, nowT);
    updateBlockBtn(m, nowT);
    render.draw(ts, { nowT, renderT, aim, incoming: !!render.incoming });
  }
  function ensureLocalIfNeeded() { if (!useOnline()) ensureLocal(); }

  // ===================================================================
  // Старт
  // ===================================================================
  document.addEventListener('langchange', () => { panelKey = ''; redraw(true); });
  window.addEventListener('keydown', () => Sound.ensure(), { once: true });
  window.addEventListener('pointerdown', () => Sound.ensure(), { once: true });
  if (CODE) connect();
  redraw(true);
  fitInsets();
  requestAnimationFrame(frame);
  // для проверок headless-ом
  window.__pond = { net, ui, online, render, aim, cur, get local() { return local; }, doJump, enterRoom, send };
})();
