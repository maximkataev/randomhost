/* Общий код аукциона: словарь категорий, элементы карточки, фото из Википедии, превью из iTunes.
   Извлечено из random-picker/index.html; используется доской и пультом. */

// iOS 12–13 (Safari < 14) не знает replaceChildren: пульт рисовал пустой лот и ни одной кнопки.
// Файл подключён до кода страниц, поэтому полифил успевает раньше первого рендера.
(function () {
  function replaceChildren() {
    while (this.lastChild) this.removeChild(this.lastChild);
    if (arguments.length) this.append.apply(this, arguments);
  }
  [window.Element, window.Document, window.DocumentFragment].forEach(function (C) {
    if (C && C.prototype && !C.prototype.replaceChildren) C.prototype.replaceChildren = replaceChildren;
  });
})();

// Подписи общих виджетов (плеер на доске). Язык берём у i18n.js страницы; без него — русский.
const SHARED_I18N = {
  ru: { now_playing: "Сейчас играет", finding: "Ищу главный хит…", no_preview: "Превью не нашлось 🤷", no_music: "Музыка недоступна 🤷", toggle: "Пауза / играть" },
  en: { now_playing: "Now playing", finding: "Looking for the big hit…", no_preview: "No preview found 🤷", no_music: "Music unavailable 🤷", toggle: "Pause / play" },
  el: { now_playing: "Παίζει τώρα", finding: "Ψάχνω τη μεγάλη επιτυχία…", no_preview: "Δεν βρέθηκε δείγμα 🤷", no_music: "Η μουσική δεν είναι διαθέσιμη 🤷", toggle: "Παύση / αναπαραγωγή" },
};
function sharedT(key) {
  const lang = (window.I18N && window.I18N.lang) || "ru";
  return (SHARED_I18N[lang] || SHARED_I18N.ru)[key] || SHARED_I18N.ru[key] || key;
}
const AUCTION_KINDS = {
  artist:     { icon: "🎤", button: "Артист",    label: "Музыкальный исполнитель", another: "Другой" },
  film:       { icon: "🎬", button: "Фильм",     label: "Фильм",                   another: "Другой" },
  series:     { icon: "📺", button: "Сериал",    label: "Сериал",                  another: "Другой" },
  person:     { icon: "⭐", button: "Личность",  label: "Личность",                another: "Другая личность" },
  character:  { icon: "🦸", button: "Персонаж",  label: "Персонаж",                another: "Другой" },
  food:       { icon: "🍜", button: "Еда",       label: "Еда",                     another: "Другая" },
  city:       { icon: "🌆", button: "Город",     label: "Город",                   another: "Другой" },
  country:    { icon: "🌍", button: "Страна",    label: "Страна",                  another: "Другая" },
  place:      { icon: "🗿", button: "Место",     label: "Достопримечательность",   another: "Другое" },
  animal:     { icon: "🐼", button: "Животное",  label: "Животное",                another: "Другое" },
  painting:   { icon: "🖼️", button: "Картина",   label: "Картина",                 another: "Другая" },
  company:    { icon: "🏢", button: "Компания",  label: "Компания",                another: "Другая", logo: true },
  club:       { icon: "🏆", button: "Клуб",      label: "Спортивный клуб",         another: "Другой", logo: true },
  profession: { icon: "🧑‍🚀", button: "Профессия", label: "Профессия",               another: "Другая" },
  invention:  { icon: "💡", button: "Открытие",  label: "Изобретение",             another: "Другое" },
};

/*
 * Названия категорий на английском и греческом. Русские лежат выше в самом объекте, переводы —
 * отдельной таблицей: так форма AUCTION_KINDS не меняется и старый код продолжает работать.
 * `another` — подпись кнопки «другой лот», в русском она согласуется с родом категории;
 * в английском и греческом род другой, поэтому это отдельная строка, а не склейка.
 * Категория без перевода показывается по-русски: игра должна работать и с неполным переводом.
 */
const AUCTION_KINDS_I18N = {
  en: {
    artist: { button: "Artist", label: "Musician", another: "Another" },
    film: { button: "Film", label: "Film", another: "Another" },
    series: { button: "Series", label: "TV series", another: "Another" },
    person: { button: "People", label: "Public figure", another: "Another" },
    character: { button: "Character", label: "Character", another: "Another" },
    food: { button: "Food", label: "Dish", another: "Another" },
    city: { button: "City", label: "City", another: "Another" },
    country: { button: "Country", label: "Country", another: "Another" },
    place: { button: "Place", label: "Landmark", another: "Another" },
    animal: { button: "Animal", label: "Animal", another: "Another" },
    painting: { button: "Painting", label: "Painting", another: "Another" },
    company: { button: "Company", label: "Company", another: "Another" },
    club: { button: "Club", label: "Sports club", another: "Another" },
    profession: { button: "Job", label: "Profession", another: "Another" },
    invention: { button: "Invention", label: "Invention", another: "Another" },
  },
  el: {
    artist: { button: "Καλλιτέχνης", label: "Μουσικός", another: "Άλλος" },
    film: { button: "Ταινία", label: "Ταινία", another: "Άλλη" },
    series: { button: "Σειρά", label: "Σειρά", another: "Άλλη" },
    person: { button: "Πρόσωπο", label: "Προσωπικότητα", another: "Άλλο" },
    character: { button: "Ήρωας", label: "Ήρωας", another: "Άλλος" },
    food: { button: "Φαγητό", label: "Πιάτο", another: "Άλλο" },
    city: { button: "Πόλη", label: "Πόλη", another: "Άλλη" },
    country: { button: "Χώρα", label: "Χώρα", another: "Άλλη" },
    place: { button: "Μέρος", label: "Αξιοθέατο", another: "Άλλο" },
    animal: { button: "Ζώο", label: "Ζώο", another: "Άλλο" },
    painting: { button: "Πίνακας", label: "Πίνακας", another: "Άλλος" },
    company: { button: "Εταιρεία", label: "Εταιρεία", another: "Άλλη" },
    club: { button: "Σύλλογος", label: "Αθλητικός σύλλογος", another: "Άλλος" },
    profession: { button: "Επάγγελμα", label: "Επάγγελμα", another: "Άλλο" },
    invention: { button: "Εφεύρεση", label: "Εφεύρεση", another: "Άλλη" },
  },
};

// категория на нужном языке: иконка и флаги берутся из базового объекта, подписи — из перевода
function auctionKind(kind, lang) {
  const base = AUCTION_KINDS[kind] || {};
  const tr = (AUCTION_KINDS_I18N[lang] || {})[kind];
  if (!tr) return base;
  const out = {};
  for (const k in base) out[k] = base[k];
  for (const k in tr) out[k] = tr[k];
  return out;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}


const pickFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- фото: заглавная картинка статьи в Википедии ----------

let imageToken = 0; // как musicToken: не даём старому запросу дорисовать чужую карточку

// size — ширина превью в пикселях. Пульту хватает ~240 (картинка там 120 CSS-пикселей): 1200px
// тянули до 1,7 МБ на лот, ~10 МБ за партию — на EDGE это забивало канал, и state шёл минутами.
async function wikiImage(lang, params, { allowLogo = false, allowFlag = false, size = 1200 } = {}) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1` +
    `&prop=pageimages|info&inprop=url&piprop=thumbnail&pithumbsize=${size}&pilicense=any&${params}`;
  const data = await (await fetch(url)).json();
  const pages = Object.values((data.query && data.query.pages) || {}).sort((x, y) => (x.index || 0) - (y.index || 0));
  // у городов заглавной картинкой бывает герб, флаг или карта — они нам не нужны
  const bad = /flag|coat_of_arms|\bcoa\b|escudo|bandera|wappen|герб|флаг|locator|location_map|_map[_.]/i;
  const usable = (src) => (allowFlag || !bad.test(src)) && (allowLogo || allowFlag || !/\.svg/i.test(src));
  const page = pages.find((p) => p.thumbnail && usable(decodeURIComponent(p.thumbnail.source)));
  if (!page) return null;
  const { source, width, height } = page.thumbnail;
  return { src: source, link: page.fullurl, portrait: height > width * 1.15, logo: allowFlag || /\.svg|logo/i.test(source) };
}

async function findImage(pick, kind, size) {
  const q = encodeURIComponent;
  size = size || 1200;
  const opts = { allowLogo: !!AUCTION_KINDS[kind].logo, size };
  const attempts = [
    () => wikiImage("en", `titles=${q(pick.wiki_en)}`, opts),
    () => wikiImage("en", `generator=search&gsrlimit=3&gsrsearch=${q(pick.wiki_en)}`, opts),
    () => wikiImage("ru", `generator=search&gsrlimit=3&gsrsearch=${q(pick.name)}`, opts),
  ];
  // у части карточек (русские картины) есть точное название статьи в русской Википедии — оно надёжнее
  if (pick.wiki_ru) attempts.unshift(() => wikiImage("ru", `titles=${q(pick.wiki_ru)}`, opts));
  if (kind === "country") {
    // заглавная картинка страны — всегда флаг; сначала пробуем пейзаж из статьи о туризме, флаг — запасной вариант
    attempts.unshift(() => wikiImage("en", `titles=${q("Tourism in " + pick.wiki_en)}`, { size }));
    attempts.push(() => wikiImage("en", `titles=${q(pick.wiki_en)}`, { allowFlag: true, size }));
  }
  for (const attempt of attempts) {
    const found = await Promise.resolve(attempt()).catch(() => null);
    if (found) return found;
  }
  return null;
}

// Ширина фото для доски — по её реальному размеру: 4K-телевизору 1200, ноутбуку хватает меньше.
function heroSize() {
  const px = (window.innerWidth || 1280) * (window.devicePixelRatio || 1) * 0.45;
  return px > 900 ? 1200 : px > 600 ? 800 : 640;
}

function heroWidget(pick, kind) {
  const token = ++imageToken;
  const box = el("div", "hero");
  const img = el("img");
  img.alt = pick.name;
  const credit = el("a", null, "Wikipedia ↗");
  credit.target = "_blank";
  credit.rel = "noopener";
  box.append(img, credit);

  findImage(pick, kind, heroSize()).then((found) => {
    if (token !== imageToken) return;
    if (!found) { box.classList.add("gone"); return; }
    if (found.logo && (AUCTION_KINDS[kind].logo || kind === "country")) {
      box.classList.add("logo");
    } else if (found.portrait) {
      // постер или высокий кадр обрезать нельзя — показываем целиком поверх размытой копии
      const blur = el("img", "blur");
      blur.alt = "";
      blur.src = found.src;
      box.prepend(blur);
      box.classList.add("poster");
    }
    img.onload = () => box.classList.add("ready");
    img.onerror = () => box.classList.add("gone");
    img.src = found.src;
    credit.href = found.link;
  });
  return box;
}

// ---------- музыка: 30-секундное превью хита из iTunes ----------

const player = new Audio();
// общий выключатель звука сайта (sound-toggle.js) ловит только Web Audio,
// поэтому <audio> с превью хита гасим сами и следим за переключением
function syncMuted() {
  try { player.muted = localStorage.getItem("site-muted") === "1"; } catch (e) {}
}
syncMuted();
window.addEventListener("storage", function (e) { if (!e || e.key === "site-muted") syncMuted(); });
document.addEventListener("click", function (e) {
  if (e.target && e.target.closest && e.target.closest(".sound-toggle-btn")) setTimeout(syncMuted, 0);
}, true);
player.loop = true;
player.preload = "auto";
const VOLUME = 0.45;
const SILENCE = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";
let fadeTimer = null;
let musicToken = 0; // отменяет устаревшие поиски, если уже крутим следующего

function fadeTo(target, ms, done) {
  clearInterval(fadeTimer);
  const from = player.volume;
  const started = performance.now();
  fadeTimer = setInterval(() => {
    const t = Math.min(1, (performance.now() - started) / ms);
    player.volume = from + (target - from) * t;
    if (t === 1) { clearInterval(fadeTimer); if (done) done(); }
  }, 40);
}

function stopMusic() {
  musicToken++;
  if (player.paused) return;
  fadeTo(0, 350, () => player.pause());
}

// Safari разрешает play() без жеста только на элементе, который уже запускали из клика —
// поэтому прямо в обработчике клика «прогреваем» плеер тишиной.
function unlockAudio() {
  if (!player.paused) return;
  player.src = SILENCE;
  player.volume = 0;
  player.play().catch(() => {});
}

// У поиска iTunes нет CORS-заголовков, fetch не пройдёт — только JSONP.
function itunesSearch(term, country) {
  return new Promise((resolve, reject) => {
    const cb = "__itunes_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    const cleanup = () => { delete window[cb]; script.remove(); clearTimeout(timer); };
    // По таймауту колбэк не удаляем, а глушим: запоздавший ответ всё равно вызовет его, и без
    // заглушки в консоли был «ReferenceError: __itunes_… is not defined».
    const timer = setTimeout(() => {
      window[cb] = function () { try { delete window[cb]; } catch (e) {} };
      script.remove();
      reject(new Error("iTunes timeout"));
    }, 8000);
    window[cb] = (data) => { cleanup(); resolve(data.results || []); };
    script.onerror = () => { cleanup(); reject(new Error("iTunes недоступен")); };
    script.src = `https://itunes.apple.com/search?media=music&entity=song&limit=25&country=${country}&term=${encodeURIComponent(term)}&callback=${cb}`;
    document.head.append(script);
  });
}

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const JUNK = /karaoke|tribute|cover|remix|instrumental|live|acoustic|edition|sped up|slowed|version|originally performed/i;

async function findPreview(artist, song, country) {
  const a = norm(artist);
  const byArtist = (r) => r.previewUrl && norm(r.artistName).includes(a);
  const s = norm(song);
  // сначала ищем конкретный хит и берём только совпадение по названию…
  if (s) {
    const hits = (await itunesSearch(`${artist} ${song}`, country)).filter(byArtist);
    const exact =
      hits.find((r) => norm(r.trackName) === s) ||
      hits.find((r) => norm(r.trackName).startsWith(s) && !JUNK.test(r.trackName)) ||
      hits.find((r) => norm(r.trackName).includes(s) && !JUNK.test(r.trackName));
    if (exact) return exact;
  }
  // …а если в каталоге iTunes его нет — самое релевантное у этого исполнителя
  const any = (await itunesSearch(artist, country)).filter(byArtist);
  const own = any.filter((r) => norm(r.artistName) === a); // сольные важнее фитов
  for (const list of [own, any]) {
    const best = list.find((r) => !JUNK.test(r.trackName)) || list[0];
    if (best) return best;
  }
  return null;
}

function playerWidget() {
  const box = el("div", "player");
  const toggle = el("button", "toggle", "▶");
  toggle.setAttribute("aria-label", sharedT("toggle"));
  const info = el("div", "info");
  const song = el("div", "song", sharedT("finding"));
  info.append(el("div", "cap", sharedT("now_playing")), song);
  const eq = el("div", "eq");
  for (let i = 0; i < 4; i++) eq.append(el("i"));
  box.append(toggle, info, eq);

  const sync = () => {
    const on = !player.paused && player.src !== SILENCE;
    box.classList.toggle("playing", on);
    toggle.textContent = on ? "❚❚" : "▶";
  };
  toggle.onclick = () => {
    if (player.paused) { syncMuted(); player.volume = VOLUME; player.play().catch(() => {}); }
    else player.pause();
  };
  player.onplay = player.onpause = sync;
  return { box, song, sync };
}

async function startMusic(pick, widget) {
  syncMuted();
  const token = ++musicToken;
  try {
    // у русских исполнителей в US-витрине имена транслитом (Kino, Zemfira), в RU — кириллицей.
    // В переводных колодах имя в карточке транслитом, поэтому ищем по оригиналу (name_ru от сервера).
    const track = await findPreview(pick.ru ? pick.name_ru || pick.name : pick.name, pick.top_song || "", pick.ru ? "RU" : "US");
    if (token !== musicToken) return;
    if (!track) { widget.song.textContent = sharedT("no_preview"); return; }
    widget.song.textContent = `${track.trackName} — ${track.artistName}`;
    widget.song.title = widget.song.textContent;
    clearInterval(fadeTimer);
    player.src = track.previewUrl;
    player.volume = 0;
    await player.play();
    fadeTo(VOLUME, 900);
  } catch (err) {
    if (token !== musicToken) return;
    // автоплей заблокирован или iTunes не ответил — трек (если нашёлся) запустится кнопкой ▶
    if (!player.src || player.src === SILENCE) widget.song.textContent = sharedT("no_music");
  } finally {
    widget.sync();
  }
}


// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------
// openTransport({code, onMessage, onClose, onOpen, onSendFail, onClock, onGone}) → { send(msg), close(), probe(), mode }.
// Сначала пробуем WebSocket; если он закрылся, не успев открыться, или рукопожатие повисло
// (прокси «глотает» upgrade) — переключаемся на опрос.
let wsBroken = false; // рукопожатие WebSocket на этой странице уже не прошло — сразу опрос
const WS_HANDSHAKE_MS = 5000;
const POLL_FETCH_MS = 28000; // сервер держит опрос до 20 с; дольше — запрос повис на старой сети
const PROBE_MS = 3000;

// Смещение часов «сервер − устройство» по самому быстрому обмену ping/pong (RTT/2), общее на
// страницу: state мог простоять в очереди секунды, и таймер по нему был завышен на задержку сети.
const auctionClock = { offset: null, rtt: Infinity, at: 0 };
function clockSample(serverT, sentAt) {
  const t = Date.now(), rtt = t - sentAt;
  if (!(rtt >= 0) || typeof serverT !== "number") return;
  // старые замеры устаревают: сеть поменялась — лучший RTT прошлой минуты уже не про нас
  if (rtt <= auctionClock.rtt || t - auctionClock.at > 60000) {
    auctionClock.rtt = rtt;
    auctionClock.offset = serverT + rtt / 2 - t;
    auctionClock.at = t;
  }
}

// Итоговое смещение для таймеров. Пока нет замера ping/pong — по state: у него задержка сети
// только прибавляется к времени доставки, поэтому самый большой из недавних замеров ближе всего
// к правде (раньше брали последний — и таймер врал на задержку каждого конкретного state).
const stateOffsets = [];
function serverOffset(serverNow) {
  if (typeof serverNow === "number") {
    stateOffsets.push(serverNow - Date.now());
    if (stateOffsets.length > 12) stateOffsets.shift();
  }
  const byState = stateOffsets.length ? Math.max.apply(null, stateOffsets) : 0;
  return auctionClock.offset != null ? Math.max(auctionClock.offset, byState) : byState;
}

function openTransport({ code, onMessage, onClose, onOpen, onSendFail, onClock, onGone }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let closed = false, opened = false, sid = null, ws = null, polling = false, pollAbort = null;
  // Половина обрывов на телефоне — не закрытие, а тишина: сокет формально открыт, события close
  // нет, а сквозь него уже ничего не идёт. Браузер об этом не сообщает, и пульт может простоять
  // так минуту, пока сервер не оборвёт его сам. Поэтому спрашиваем сами: раз в 20 с служебный
  // ping, и если за 45 с не пришло вообще ничего — считаем соединение мёртвым и переподключаемся.
  let lastSeen = 0, beat = null, notified = false, probeTimer = null;
  const stopBeat = () => { if (beat) { clearInterval(beat); beat = null; } clearTimeout(probeTimer); probeTimer = null; };
  // Наверх onClose уходит ровно один раз на транспорт: и сторож, и штатное закрытие сокета ведут
  // в одну точку — иначе один обрыв запускал бы два переподключения сразу. Транспорт при этом
  // гасится целиком: раньше сторож в poll-режиме звал onClose, а старый цикл опроса жил дальше —
  // и его «replaced» мог закрыть уже новое соединение.
  const fireClose = () => {
    if (closed || notified) return;
    notified = true;
    stopBeat();
    closed = true;
    try { if (ws) ws.close(); } catch (e) {}
    try { if (pollAbort) pollAbort.abort(); } catch (e) {}
    sid = null;
    if (onClose) onClose();
  };
  const ping = () => api.send({ type: "ping", c: Date.now() });
  const deliver = (m) => {
    if (closed) return; // сообщения погашенного транспорта никому не нужны
    lastSeen = Date.now();
    if (m && m.type === "pong") {
      if (typeof m.c === "number") { clockSample(m.t, m.c); if (onClock && auctionClock.offset != null) onClock(auctionClock.offset); }
      return;
    }
    onMessage(m);
  };
  const startBeat = () => {
    stopBeat();
    lastSeen = Date.now();
    // несколько быстрых замеров часов сразу после подключения — лучший из них и возьмём
    ping(); setTimeout(ping, 400); setTimeout(ping, 1500);
    beat = setInterval(() => {
      if (closed) return stopBeat();
      if (Date.now() - lastSeen > 45000) { fireClose(); return; }
      ping();
    }, 20000);
  };
  const api = {
    // по long-polling действие может не дойти (перегруз прокси, моргнувшая сеть) —
    // молча терять ставку нельзя: повторяем пару раз и сообщаем наверх
    send(msg, attempt) {
      if (closed) { if (onSendFail && msg && msg.type !== "ping") onSendFail(msg); return; }
      if (ws && ws.readyState === 1) return ws.send(JSON.stringify(msg));
      // соединение ещё поднимается или уже умерло: действие не уходит — говорим об этом, а не молчим
      if (!sid) { if (onSendFail && msg && msg.type !== "ping") onSendFail(msg); return; }
      const tries = attempt || 0;
      fetch("/auction/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid, msg }) })
        .then((r) => {
          if (r.ok || r.status === 410) return;
          if (tries < 2) setTimeout(() => api.send(msg, tries + 1), 400 * (tries + 1));
          else if (onSendFail) onSendFail(msg);
        })
        .catch(() => {
          if (tries < 2) setTimeout(() => api.send(msg, tries + 1), 400 * (tries + 1));
          else if (onSendFail) onSendFail(msg);
        });
    },
    close() { closed = true; stopBeat(); try { if (ws) ws.close(); } catch (e) {} try { if (pollAbort) pollAbort.abort(); } catch (e) {} sid = null; },
    // Проверка «жив ли транспорт» по событию устройства (сеть вернулась, экран включился): после
    // смены сети сокет формально открыт, но мёртв. Спрашиваем ping и ждём ответа PROBE_MS —
    // не дождались, значит соединение мертво, переподключаемся сразу, а не через 45 с.
    probe(ms) {
      if (closed || !opened) return;
      clearTimeout(probeTimer);
      const asked = Date.now();
      ping();
      probeTimer = setTimeout(() => { if (!closed && lastSeen < asked) fireClose(); }, ms || PROBE_MS);
    },
    // «connecting» существует ради того, кто спрашивает «жив ли транспорт, не открыть ли новый»:
    // пока идёт рукопожатие, readyState ещё 0, и без этой ветки ответ был бы «none» — а значит,
    // второе событие возврата (сеть появилась, вкладка показалась) открывало бы второй сокет
    // поверх поднимающегося первого.
    get mode() {
      if (closed) return "none";
      if (ws && ws.readyState === 1) return "ws";
      if (ws && ws.readyState === 0) return "connecting";
      if (sid) return "poll";
      if (polling) return "connecting";
      return "none";
    },
  };
  // fetch с таймаутом: у висящего на старой сети опроса своего таймаута нет вовсе
  const timedFetch = (url, ms) => {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    pollAbort = ctl;
    const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).finally(() => clearTimeout(t));
  };
  async function startPolling() {
    if (closed || polling) return;
    polling = true;
    try {
      const res = await timedFetch(`/auction/api/session?r=${encodeURIComponent(code)}`, 15000);
      // комнаты нет вовсе (закрыта по TTL, сервер её не знает) — переподключаться некуда
      if (res.status === 404 && onGone) { closed = true; stopBeat(); polling = false; onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      if (closed) return;
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await timedFetch(`/auction/api/poll?sid=${sid}`, POLL_FETCH_MS);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        const body = await r.json();
        for (const m of body.messages) deliver(m);
      }
    } catch (e) { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  if (wsBroken || typeof WebSocket !== "function") { startPolling(); return api; }
  try {
    ws = new WebSocket(`${proto}://${location.host}/auction/ws?r=${encodeURIComponent(code)}`);
    // Рукопожатие повисло (корпоративный прокси держит upgrade и не отвечает): без таймера доска
    // оставалась пустой минутами — onclose приходил только по таймауту самого прокси.
    const handshake = setTimeout(() => {
      if (closed || opened || !ws || ws.readyState !== 0) return;
      wsBroken = true;
      const dead = ws; ws = null;
      dead.onclose = dead.onmessage = dead.onopen = null;
      try { dead.close(); } catch (e) {}
      startPolling();
    }, WS_HANDSHAKE_MS);
    ws.onopen = () => { clearTimeout(handshake); opened = true; startBeat(); if (onOpen) onOpen(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } deliver(m); };
    ws.onclose = () => {
      clearTimeout(handshake);
      if (closed) return;
      // рукопожатие не прошло — прокси без WebSocket (или сервер перезапускается: поэтому
      // wsBroken тут не ставим, следующее переподключение снова попробует WebSocket)
      if (!opened) { ws = null; startPolling(); }
      else fireClose();
    };
    ws.onerror = () => {};
  } catch (e) { startPolling(); }
  return api;
}
