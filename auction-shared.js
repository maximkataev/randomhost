/* Общий код аукциона: словарь категорий, элементы карточки, фото из Википедии, превью из iTunes.
   Извлечено из random-picker/index.html; используется доской и пультом. */
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

async function wikiImage(lang, params, { allowLogo = false, allowFlag = false } = {}) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1` +
    `&prop=pageimages|info&inprop=url&piprop=thumbnail&pithumbsize=1200&pilicense=any&${params}`;
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

async function findImage(pick, kind) {
  const q = encodeURIComponent;
  const opts = { allowLogo: !!AUCTION_KINDS[kind].logo };
  const attempts = [
    () => wikiImage("en", `titles=${q(pick.wiki_en)}`, opts),
    () => wikiImage("en", `generator=search&gsrlimit=3&gsrsearch=${q(pick.wiki_en)}`, opts),
    () => wikiImage("ru", `generator=search&gsrlimit=3&gsrsearch=${q(pick.name)}`, opts),
  ];
  // у части карточек (русские картины) есть точное название статьи в русской Википедии — оно надёжнее
  if (pick.wiki_ru) attempts.unshift(() => wikiImage("ru", `titles=${q(pick.wiki_ru)}`, opts));
  if (kind === "country") {
    // заглавная картинка страны — всегда флаг; сначала пробуем пейзаж из статьи о туризме, флаг — запасной вариант
    attempts.unshift(() => wikiImage("en", `titles=${q("Tourism in " + pick.wiki_en)}`));
    attempts.push(() => wikiImage("en", `titles=${q(pick.wiki_en)}`, { allowFlag: true }));
  }
  for (const attempt of attempts) {
    const found = await Promise.resolve(attempt()).catch(() => null);
    if (found) return found;
  }
  return null;
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

  findImage(pick, kind).then((found) => {
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
    const timer = setTimeout(() => { cleanup(); reject(new Error("iTunes timeout")); }, 8000);
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
  toggle.setAttribute("aria-label", "Пауза / играть");
  const info = el("div", "info");
  const song = el("div", "song", "Ищу главный хит…");
  info.append(el("div", "cap", "Сейчас играет"), song);
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
    // у русских исполнителей в US-витрине имена транслитом (Kino, Zemfira), в RU — кириллицей, как в карточке
    const track = await findPreview(pick.name, pick.top_song || "", pick.ru ? "RU" : "US");
    if (token !== musicToken) return;
    if (!track) { widget.song.textContent = "Превью не нашлось 🤷"; return; }
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
    if (!player.src || player.src === SILENCE) widget.song.textContent = "Музыка недоступна 🤷";
  } finally {
    widget.sync();
  }
}


// ---------- транспорт: WebSocket, а если прокси его не пропускает — long-polling ----------
// openTransport({code, onMessage, onClose, onOpen}) → { send(msg), close(), mode }.
// Сначала пробуем WebSocket; если он закрылся, не успев открыться, переключаемся на опрос.
function openTransport({ code, onMessage, onClose, onOpen, onSendFail, onGone }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let closed = false, opened = false, sid = null, ws = null, polling = false;
  // Половина обрывов на телефоне — не закрытие, а тишина: сокет формально открыт, события close
  // нет, а сквозь него уже ничего не идёт. Браузер об этом не сообщает, и пульт может простоять
  // так минуту, пока сервер не оборвёт его сам. Поэтому спрашиваем сами: раз в 20 с служебный
  // ping, и если за 45 с не пришло вообще ничего — считаем соединение мёртвым и переподключаемся.
  let lastSeen = 0, beat = null, notified = false;
  const stopBeat = () => { if (beat) { clearInterval(beat); beat = null; } };
  // Наверх onClose уходит ровно один раз на транспорт: и сторож, и штатное закрытие сокета ведут
  // в одну точку — иначе один обрыв запускал бы два переподключения сразу.
  const fireClose = () => {
    if (closed || notified) return;
    notified = true;
    stopBeat();
    if (onClose) onClose();
  };
  const deliver = (m) => { lastSeen = Date.now(); if (m && m.type === "pong") return; onMessage(m); };
  const startBeat = () => {
    stopBeat();
    lastSeen = Date.now();
    beat = setInterval(() => {
      if (closed) return stopBeat();
      if (Date.now() - lastSeen > 45000) { try { if (ws) ws.close(); } catch (e) {} fireClose(); return; }
      api.send({ type: "ping" });
    }, 20000);
  };
  const api = {
    // по long-polling действие может не дойти (перегруз прокси, моргнувшая сеть) —
    // молча терять ставку нельзя: повторяем пару раз и сообщаем наверх
    send(msg, attempt) {
      if (ws && ws.readyState === 1) return ws.send(JSON.stringify(msg));
      if (!sid) return;
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
    close() { closed = true; stopBeat(); try { if (ws) ws.close(); } catch (e) {} sid = null; },
    // «connecting» существует ради того, кто спрашивает «жив ли транспорт, не открыть ли новый»:
    // пока идёт рукопожатие, readyState ещё 0, и без этой ветки ответ был бы «none» — а значит,
    // второе событие возврата (сеть появилась, вкладка показалась) открывало бы второй сокет
    // поверх поднимающегося первого.
    get mode() {
      if (ws && ws.readyState === 1) return "ws";
      if (ws && ws.readyState === 0) return "connecting";
      if (sid) return "poll";
      if (polling) return "connecting";
      return "none";
    },
  };
  async function startPolling() {
    if (closed || polling) return;
    polling = true;
    try {
      const res = await fetch(`/auction/api/session?r=${encodeURIComponent(code)}`);
      // Комнаты нет — это конец истории, а не сбой связи: сервер закрыл её по неактивности или код
      // устарел. Отличить это можно только здесь: код ответа на неудачном рукопожатии WebSocket
      // браузер не показывает, поэтому 404 виден лишь на запасном транспорте. Пока он падал в общий
      // catch, клиент уходил в переподключение и стучался в сервер каждые две секунды часами, показывая
      // «нет связи» вместо внятного «комната закрыта»: в логах прода — 779 таких запросов за вечер
      // с одного адреса в две давно закрытые комнаты.
      if (res.status === 404) { closed = true; stopBeat(); if (onGone) onGone(); return; }
      if (!res.ok) throw new Error("session " + res.status);
      const data = await res.json();
      sid = data.sid; opened = true; startBeat(); if (onOpen) onOpen();
      for (const m of data.messages) deliver(m);
      while (!closed && sid) {
        const r = await fetch(`/auction/api/poll?sid=${sid}`);
        if (r.status === 410) throw new Error("session gone");
        if (!r.ok) { await new Promise((z) => setTimeout(z, 1500)); continue; }
        for (const m of (await r.json()).messages) deliver(m);
      }
    } catch { if (!closed) { sid = null; polling = false; fireClose(); } }
  }
  try {
    ws = new WebSocket(`${proto}://${location.host}/auction/ws?r=${encodeURIComponent(code)}`);
    ws.onopen = () => { opened = true; startBeat(); if (onOpen) onOpen(); };
    ws.onmessage = (e) => deliver(JSON.parse(e.data));
    ws.onclose = () => {
      if (closed) return;
      if (!opened) { ws = null; startPolling(); } // рукопожатие не прошло — прокси без WebSocket
      else fireClose();
    };
    ws.onerror = () => {};
  } catch { startPolling(); }
  return api;
}
