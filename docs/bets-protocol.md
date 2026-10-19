# «Ставки»: контракт между сервером, доской и телефоном (18.10.2026)

Источник правды по правилам и математике — `docs/bets-spec.md`; по коду — `bets/game.js`, `bets/registry.js`, `bets/events/*.js`.
Этот файл фиксирует то, на чём стыкуются части: сообщения WebSocket, формат снимка, API сцен, права на файлы.

## 1. Адреса и порты

- Сервис `bets/` (Node 22, `ws`), порт **4300** (`PORT`), контейнер `randomhost-bets`.
- `GET /bets/api/health` → 200 `{ok:true}`. `POST /bets/api/rooms` → `{code, hostToken}` (как в рулетке).
- WebSocket `/bets/ws?r=КОД`. Long-poll запасной путь `/bets/api/session|poll|msg` — как у рулетки.
- Страницы: `bets.html` (телефон), `bets-board.html` (общий экран). Общий код клиентов — `bets-shared.js` (метки рынков, формат коэффициентов), сцены — `bets-scenes.js`.
- Вход, присутствие, переподключение — по `docs/multiplayer-join-protocol.md` и `lib/` ровно как у рулетки (`mp-common.js` на клиентах).

## 2. Сообщения клиент → сервер

| type | поля | кто | действие |
|---|---|---|---|
| `host` | `token` | доска | захват роли доски |
| `join` | `name`, `token?` | телефон | как у рулетки |
| `bet` | `marketId`, `stake` | игрок | `game.bet(pid, marketId, stake)`; ставка целая ≥ 10, добавляется к уже поставленной на этот рынок |
| `unbet` | `marketId` | игрок | `game.unbet` |
| `clear` | — | игрок | `game.clearBets` |
| `submit` | — | игрок | `game.submit(pid, now)` |
| `chat` | `text` | игрок | лента на доске, ≤ 80 символов, ≤ 1 за 3 с |
| `react` | `emoji` | игрок | одна из 6 реакций, ≤ 1 в секунду |
| `settings` | `patch` | доска | `game.setSettings` (stack, betMs, events, mode) + `chat: bool` |
| `start` | — | доска | `game.start(now)`; от 2 игроков |
| `end` | — | доска | `game.endNow(now)` |
| `kick` | `playerId` | доска | убрать игрока |
| `next_game` | — | доска | новая партия в той же комнате |
| `ping` | `c?` | все | `pong` |

Ответы сервера на отказ: `{type:"rejected", action, reason}`; ошибки `{type:"error", error}`.

## 3. Сообщения сервер → клиент

- `hello` `{code, state, limits}` при подключении.
- `state` `{state}` — полный снимок `game.snapshot(now, forPlayer)`; доска получает `forPlayer = undefined`, телефон — свой `playerId`. Рассылается при каждом изменении (кэш на комнату, как у рулетки).
- `event` `{event}` — события движка (`join`, `event`, `submitted`, `lock`, `penalty`, `settle`, `out`, `done`, `resolved`, `scene`) для эффектов.
- `live` `{seq, data}` — потоковые данные реального события, пока идёт окно ожидания/сцена (формат в §5).
- `chat` `{id, playerId, name, text}`, `react` `{playerId, emoji}` — лента и реакции для доски.
- Остальные (`joined`, `host_ok`, `replaced`, `kicked`, `room_expired`) — как у рулетки.

Дополнения по факту реализации сервера (18.10):
- `chat` для новой доски приходит повтором истории с полем `replay:true`; клиент убирает дубли по `id`.
- `rejected.reason` для ставок: `bad_stake`, `bad_market`, `no_money`, `submitted`, `phase` и др. (причины — в `bets/server.js`); отказ уходит только автору, состояние — всем.
- Событие `new_game` после `next_game`: партия пересоздаётся с теми же игроками, ушедшие дольше грации не переходят.
- Новые игроки посреди партии получают `error: game_started`; вход по имени в окне ставок не отдаётся (черновики секретны).
- Сервер закрывает окно ставок досрочно, когда последний несдавший ушёл офлайн.

- Знакомство (добавлено 18.10): перед окном ставок идёт `intro`: клиентам приходит `phase:"bets"` с `intro:true`, `introMs` и `deadline` = конец знакомства; ставки сервер не принимает, событие `bets_open` — окно открылось (deadline дальше = закрытие ставок). Реальное событие без исхода: доска НЕ зовёт `sc.play`, пока исход не пришёл (сцена идёт после `show()` и получает `sc.live`); `play({outcome:null,voidAll:true})` — только когда ставки возвращены.

- Темп «по кнопке ведущего» (`settings.pace:"host"`, по умолчанию для новых комнат; `"auto"` — по таймерам, как раньше): таймеров нет. Знакомство ждёт `open` от доски; окно ставок закрывается, когда сдали все онлайн-игроки или доска шлёт `lock`; после выплат ждём `next`. В снимке `gate` = `"open"|"lock"|"next"` (какую кнопку ждёт ведущий), `deadline = 0` — таймера нет. Сообщения `open`, `lock`, `next` принимаются только от доски.

## 4. Снимок состояния (`game.snapshot`)

```
{ phase: "lobby"|"bets"|"locked"|"scene"|"payout"|"done",
  settings:{stack,betMs,events,mode}, now, deadline, idx, total, winner, stats,
  players:[{id,name,stack,alive,online,maxWin,submitted?,draft?,coupon,last,min?}],
  ev: { type, live, fallback, n, meta, input, seed?, sceneMs?, voidAll?,
        markets:[{id,group,kc,p?}], outcome?, revealAt? } }
```
- `deadline` — серверное время (мс) конца текущей фазы. Часы клиента не участвуют: клиент считает разницу `deadline − now` из снимка и тикает локально.
- `coupon` после запирания: `{bets:[{id,stake,kc}],staked,penalty,min}`. Черновики чужих игроков не приходят вообще; свой — в `players[me].draft`.
- `last` в фазе `payout`: `{staked,penalty,won,net,lines:[{id,stake,kc,result:"win"|"lose"|"void",back}],stack}`.
- `ev.meta` — подписи героев сцены (см. `registry.describe`): dogs `{names:[3]}`, penalties `{A:{name,men:[5]},B:{...}}`, rope `{A,B}`; для живых событий метки даёт `feed.js`.
- `ev.input` — параметры события: dogs `{weights}`, penalties `{A:[5‰],B:[5‰]}`, rope `{s}`, rocket `{}`, dice `{}`; живые — σ, λ, φ, ρ, доли и т.п.
- `ev.winners` — id выигравших рынков (с развязки); `stats.longestWin` `{id,kc,ev,market}` — самый длинный выигранный коэффициент партии.
- Живые события: доска зовёт `sc.play({type,input,meta,outcome:null,live:ev.liveState})` при запирании и ещё раз `sc.play({..., outcome, durationMs})`, когда исход пришёл (до `revealAt`); `sc.live(data)` — на каждое сообщение `live`.
- `ev.outcome` и `ev.seed` — доске с момента запирания (она строит сцену), телефонам — с фазы `payout`.
- `ev.sceneMs` (сценические) — длительность сцены в мс; сцена обязана уложиться в неё.
- Исходы: dice `[a,b,c]`; dogs массив индексов в порядке финиша (0..2); penalties `{kicks:[{team,n,res}],sd:[{a,b}],goalsA,goalsB,posts,winner}`; rope `{pulls:[0|1]×41,winsA,winner,minDiff,maxDiff}`; rocket число M (≥1); живые: btc — число (сдвиг цены в $), btceth `{rB,rE}`, duel `{nA,nB}`, thresholds `{<id>:count, first}`, categorical — id категории строкой, drand — hex-строка.

## 5. Живые данные (`live`)

Сервер шлёт во время `locked`/`scene` реального события. `data.kind`:
- `price` `{t, btc, eth?}` — раз в секунду; `s0` `{btc, eth?}` — цена в момент запирания;
- `count` `{a, b}` — накопленные счёты с начала окна (дуэль счётчиков); `item` `{side:"a"|"b", text}` — примеры элементов потока (эмодзи, правки, вспышки);
- `item` `{id, text, amount?}` — элемент для порогов (правка статьи, транзакция);
- `reel` `{cat, text}` — элемент потока для категориальной рулетки; `stop` — момент остановки (исход придёт следом);
- `round` `{n, randomness?}` — раунд drand.
В снимке `ev.liveState` лежит последнее значение каждого вида для тех, кто подключился позже.

## 6. API сцен (`bets-scenes.js`)

```
const sc = BetsScenes.create(hostEl, {muted});   // hostEl — контейнер 16:9, сцена сама создаёт canvas/WebGL
sc.show(type, {input, meta, markets});            // «ожидание»: декорация без исхода (стакан, ракета на старте, ловушки…)
sc.play({type, input, meta, outcome, seed, durationMs, offsetMs, live}) → Promise
   // проигрывает сцену ≤ durationMs от момента offsetMs (для переподключения), детерминированно по seed
sc.live(data)                                     // потоковые данные (§5)
sc.on("say", fn)  // (html) реплика комментатора
sc.on("stamp", fn) // (text, tone:"win"|"lose"|"neutral")
sc.destroy()
```
Типы: `dice dogs rocket penalties rope` (сценические) и живые `btc btceth duel thresholds categorical drand` (по `LIVE_KIND` в `registry.js`). Все случайности сцены — из `mulberry32(seed)`.

### Регистрация сцен

Ядро (`bets-scenes.js`) экспортирует `BetsScenes.register(types, factory)`; `factory(host, ctx)` возвращает объект `{show(opts), play(opts) → Promise, live(data), destroy()}`; `ctx = {emit(name, ...args), muted(), sound}`. `bets-scenes-live.js` подключается после ядра и регистрирует живые типы; доска подключает оба файла.

## 7. Живые источники (`bets/feed.js`) и сервер

```
const feed = createFeed({ log, now, rnd, fetch?, WebSocket?, env });   // всё внешнее — через внедрение, чтобы тесты шли на моках
feed.start(); feed.stop();
feed.prepare(type) → { input, meta } | null      // вызывается game.prepareLive; null — источник молчит или данных мало → слот заменяется сценическим
feed.begin(type, { closeAt, log, onLive(data), onResolve(outcome, voids?), onAbort() }) → handle { cancel() }
   // сервер зовёт при запирании окна живого события; feed собирает данные после closeAt, шлёт onLive (§5) и в конце onResolve
   // onAbort — источник пропал: сервер вызывает game.voidAllAndSettle
feed.status() → { [type]: { ok, lastAt, note } }   // для /bets/api/health?full=1
```
Включение по флагам окружения `BETS_LIVE=btc,btceth,…|all|none` (по умолчанию `none`, пока не проверено на проде).
Сервер: при `lock` реального события — `feed.begin`; пересылает `onLive` как `{type:"live"}` и кладёт последнее значение вида в `ev.liveState`; `onResolve` → `game.resolveLive(outcome, now, voids)`; после рестарта события, которое «ждало исход», — `voidAllAndSettle`.

## 8. Файлы по ответственным (агенты не трогают чужие)

| Пакет | Файлы |
|---|---|
| Сервер | `bets/server.js`, `bets/bots.js`, `bets/test-server.js`, `bets/Dockerfile`, `bets/package.json`, `docker-compose.yml` (сервис `bets`), `nginx.conf`, `nginx-limits.conf`, `.github/workflows/deploy.yml`, `.dockerignore` |
| Телефон | `bets.html`, `bets-phone.css` |
| Доска | `bets-board.html`, `bets-board.css` |
| Сцены сценические | `bets-scenes.js` (ядро + 5 сценических), `bets-scene-dice.js` (Three.js) |
| Сцены живые | `bets-scenes-live.js` (регистрируется в `BetsScenes`) |
| Живые источники | `bets/feed.js`, `bets/feed-*.js`, `bets/test-feed.js`, `bets/fixtures/*` |
| Интеграция | `i18n.js`, `index.html`, меню страниц, `sitemap.xml`, `robots.txt`, `bets-sound.js` |
| Общее (читают все) | `bets-shared.js`, `bets/game.js`, `bets/registry.js`, `bets/events/*` — правки только через оркестратора |
