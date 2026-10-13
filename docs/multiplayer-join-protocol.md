# Протокол входа и присутствия в мультиплеере

Единый контракт «как человек попадает в комнату, как его место живёт без связи и как он возвращается» для десяти игр: аукцион, рулетка, бомба, «Вопрос ребром» (quip), «Не верю!» (fibs), «Последний вопрос» (lastq), «На одной волне» (wave), «Как все» (crowd), «Царь льдины» (floe), «Утиный сплав» (rapids).

Документ написан **по коду** (`lib/*.js`, `mp-common.js`, `*/server.js`, `docker-compose.yml`), состояние — ветка `main` на 13.10.2026 (волны W0–W4). Где игры отличаются, это записано в таблицах §9–§10, а не сглажено. Там, где код расходится с планом (`docs/playtests/2026-10-12/IMPLEMENTATION-PLAN.md`), побеждает код, расхождение отмечено словом «**отклонение**».

Правила игр здесь не описываются — их держат `docs/<игра>-spec.md` (у аукциона `auction/DESIGN.md` — только визуал, правил в `docs/` нет). Нумерация U-xx — вопросы владельцу из плана плейтеста; «класс A» — чиним без вопросов, «класс B» — правило игры, за флагом `RULE_*`, по умолчанию выключено («как было»).

---

## 1. Состав и слои

| Слой | Файл | Что делает |
|---|---|---|
| Имена | `lib/names.js` | `cleanName`, `nameKey`, `baseOf`, `nextFreeName` («База (N)»), `takenKeysOf`, `LIMITS` |
| Решение по `join` | `lib/seats.js` | `classifyJoin`, `decideJoin`, `claimSummary`, `pendingClaim` (`markPending` и др.) |
| Присутствие | `lib/presence.js` | `setOnline`, `ghostsToDrop`, `evictOldestGhost`, `pruneOfflineForNewGame`, `onRestore`, `ensureOffSince` |
| Сеть | `lib/net.js` | `ipKey` (/64 для IPv6), `clientIp`, `createGuessLimiter`, `rateOk`, `send` |
| Коды комнат | `lib/codes.js` | `roomCode` — слово + 2 цифры 2–9 («PANDA47»), список слов общий |
| Клиент | `mp-common.js` | `window.MP.*` (§8); без него страницы работают как раньше |
| Серверы игр | `<игра>/server.js` | собирают всё это; **wave** `lib/seats` и `lib/names` не использует (§7) |

`lib/*` в образы игр попадает из корня репозитория; правки скелета переносятся во все десять серверов (память: «Общий lib/»).

---

## 2. Транспорт и HTTP

- **WebSocket** `/<игра>/ws?r=КОД` (JSON-текст). Для floe и rapids — только он (long-poll «для реалтайма не годится»).
- **Long-poll запасной путь** (у восьми игр, кроме floe и rapids): `GET /<игра>/api/session?r=КОД` → `{sid, hello}`, `GET /<игра>/api/poll?sid=` (висит до 20 с), `POST /<игра>/api/msg`. Poll-клиент без опроса дольше `POLL_GAP_MS` (12 с) считается «зависшим».
- **Создание комнаты:** `POST /<игра>/api/rooms` → `{code, hostToken}` (400/429 с `{error}` при лимитах: `MAX_ROOMS`, `MAX_ROOMS_PER_IP`).
- **Комната есть?** `GET /<игра>/api/room?r=КОД` — **только floe и rapids**: `200 {ok:true, phase, players}` или `404 {error:"no_room"}`. Нужен, чтобы отличить «нет такой комнаты» (404) от «полно/сеть» (503). У остальных восьми игр такого эндпоинта нет: при неверном коде WebSocket получает `404` на апгрейде, poll-сессия — 404 на `/session`.
- **Health:** `GET /<игра>/api/health` → `{ok, rooms}` (+ `active` у floe/rapids, `judge` у аукциона).
- **Перебор кодов:** `createGuessLimiter(GUESS_LIMIT = 60)` на адрес за окно 10 мин; промахнувшийся 60 раз не получает ни одной комнаты до конца окна. Ключ адреса — `ipKey` (IPv6 → /64, `::ffff:a.b.c.d` → v4). Адрес берётся из `X-Real-IP` (его ставит внешний nginx), запасной путь — последний элемент `X-Forwarded-For`.
- **Соединения до входа (аноним):** сокет без игрока и без доски живёт `ANON_TTL_MS` (30 с); лимиты `MAX_ANON_PER_ROOM` (30; у floe/rapids — 12) и `MAX_ANON_PER_IP` (10; у crowd — 30). В WS закрывается кодом `4000 anon_timeout` — клиент переподключается молча.
- **Размер сообщения** `MAX_MSG_BYTES`: 8192 (floe/rapids — 1024). Частота: `MSG_RATE` 40/с на сокет (floe/rapids — 70, жёсткий `MSG_HARD` 120); у crowd отдельный `CMD_RATE` 5/с для голоса/ва-банка/мнения.

---

## 3. Сообщения

### 3.1 Сервер → клиент

| Сообщение | Когда | Поля |
|---|---|---|
| `hello` | сразу после открытия сокета | `code`, `state` (снимок; у floe/rapids вместо него `cfg`, `tick`, `max`), `limits` (§4), `mp:false` (аварийный выключатель), `rules` (auction, lastq), `flags` (fibs, только доске) |
| `joined` | вход принят | `playerId`, `token`, `name` (итоговое имя), `renamed` (имя изменили на «База (N)»), `resumed` (место возвращено, а не новое); у roulette ещё `viaName`, у lastq `byName` |
| `error` | отказ | `error`: см. §3.3 |
| `replaced` | место забрал другой сокет | у lastq `by: "claim"|"token"` |
| `kicked` | ведущий убрал игрока | — |
| `host_ok` / `host_lost` / `host_denied` | экран ведущего | `host_ok` (у аукциона с пультом `remote:true`); `host_lost` — доску сменила другая; `host_denied` — только пульт аукциона с неверным токеном |
| `pong` | ответ на `ping` | `t`, `c` (эхо счётчика) |
| `room_expired` | комната закрыта по TTL | как `error:"room_expired"`, потом `close(4000)` |

### 3.2 Клиент → сервер

| Сообщение | Поля |
|---|---|
| `join` | `name`, `token?`, `caps:["claim"]`, `claim?:true`, `fresh?:true`, аватар/цвет/шапка по игре; у floe/rapids ещё `hostToken?` |
| `host` | `token` (hostToken комнаты); у аукциона `remote:true` — пульт ведущего на телефоне, не отбирающий права у доски |
| `leave` | — |
| `ping` | `c` (счётчик), у floe/rapids ещё `rtt` |

### 3.3 Коды `error`

| Код | Смысл | Поведение клиента |
|---|---|---|
| `name_claim` | на это имя есть офлайн-место: «Это ты?» (`name`, `summary`) | `MP.joinFlow.onClaimPrompt` |
| `name_claim` + `retry:true`, `retryInMs` | место закрыло сокет меньше грации назад; подождать | молчаливый повтор `join` (≤ 6 раз, потом `onGiveUp`) |
| `name_taken` | имя недоступно: `reason` (`online`, `phase`, `secret`, `ip`, `pending`, `pending_ip`, `pending_room`), `online`, `retry`, `suggested` | показ «имя занято» |
| `bad_name` | имя пустое после очистки | — |
| `token_gone` | токен ведёт к удалённому месту и имени нет | форма ввода имени |
| `room_full` | мест нет (и нечего вытеснять) | — |
| `game_started` | вход новым игроком посреди партии запрещён (аукцион, бомба) | — |
| `slow_down`, `too_fast` | повторный `join` чаще 1 с (токен/имя) или нового места чаще 2–3 с | — |
| `creator_away` | rapids: создателя комнаты, пока он офлайн, убрать нельзя | тост у ведущего |
| `bad host token` | неверный токен ведущего | — |
| `busy`, `need_two` | floe/rapids: 40 партий в бою / меньше двух | — |
| `room_expired` | комната закрыта | `MP.roomGone.gone` → «Комната закрыта» |

---

## 4. `hello`: ограничения, выключатель, правила

- **`limits.name`** — максимальная длина имени в символах (по символам, не по UTF-16): auction **24**, bomb 16, fibs 16 (+`limits.answer` = длина лжи, 25), lastq 16, quip 16, roulette 16, crowd **15**, floe **15**, rapids **15**. У **wave `limits` нет** (имя режется до 16 внутри `cleanText`). Клиент берёт значение из `MP.applyHello`, `MP.limits.name`.
- **`mp:false`** — аварийный выключатель каркаса: сервер ставит его при `MP_OFF=1`. Тогда `MP.applyHello(hello)` возвращает `false`, `MP.off = true`, `joinFlow.handle` → `false`, `nameCounter` без DOM, `sendQueue.push` → `false` (`onDrop(…, "off")`). Работает у **девяти** игр; **отклонение: у floe `hello.mp` не выставляется** — выключить каркас на floe через env нельзя (клиентский путь `localStorage['mp-off']='1'` работает везде). В `docker-compose.yml` `MP_OFF` нигде не прописан: чтобы им воспользоваться, нужно добавить строку `- MP_OFF=${MP_OFF:-}` в `environment` сервиса.
- **`rules`**: у аукциона `{RULE_U21_PASS_LABEL, judgeKey}`, у lastq `{RULE_U17_LANG_FOLLOW}`; у остальных игр поля нет. Wave кладёт `rules:{editClue}` в снимок (`state.rules`), не в `hello`.
- **`flags`**: только fibs, только доске: `{RULE_U03_HOST_QR:true}` при `RULE_U03_HOST_QR=1` (QR ссылки ведущего на 60 с).
- **Версии/`caps`:** сервер **не объявляет** `caps` в `hello`. Совместимость построена от клиента: клиент с `caps:["claim"]` в `join` понимает `name_claim`; клиент без `caps` (старая вкладка, страница аукциона) получает ответы «как раньше» + аддитивные поля `joined.name/renamed/resumed`.

---

## 5. Имя и место: `join`

Порядок разбора в серверах (за исключением wave, §7):

1. **Повторный `join` с того же сокета**, где игрок уже вошёл → `joined` с прежним токеном и `name` (новых мест сокет не плодит; `resumed:true` у bomb, crowd, floe, lastq, quip, roulette, rapids; у аукциона `resumed:false`, у wave и fibs поля нет).
2. **Токен**: `room.tokens[token]` → игрок; токен вашего места действует в **любой фазе**, молча (`kind:"token"`). Токен ведёт к удалённому месту: имя есть → идём по имени, имени нет → `token_gone`. Токен покинувшего (`left`) места игнорируется: `left`-места по имени «свободны», но crowd (`findLeft`) и lastq (`rejoinLeft`, тот же IP) возвращают вернувшемуся его же запись (очки, ва-банки) молча.
3. **Имя**: `lib/seats.decideJoin` (описание ниже). Результат — одно из действий `resume | create | claim | prompt | retry | taken | deny`.
4. После принятия: прежние сокеты того же места получают `replaced`; `clearPending`; `setOnline(true)`; отмена таймера «ушёл офлайн»; `joined`.

### 5.1 Очистка и ключ имени (`lib/names.js`)

- `cleanName(raw, max)` — вырезает управляющие/невидимые символы, `<`, `>`, одиночные суррогаты, схлопывает пробелы, режет **по символам**, обрезает хвостовые `-`, `.`, пробелы. Регистр и «ё» не трогаются.
- `nameKey(s)` — ключ сравнения: NFKC, нижний регистр, без пробелов/невидимых, ё=е. «Хитрый » == «хитрый».
- **Исключения:** wave, crowd и аукцион — со своей `cleanName`/`nameKey` (у wave и crowd — ещё свёртка кириллица/латиница/греческий-двойников: «Сaшa» ≠ «Саша» не считается разным). Это поведение сохранено умышленно (защита от двойников).
- `nextFreeName(want, taken, max)` — формат U-05 «База (N)»: если очищенное `want` свободно — оно само; иначе база = `baseOf(want)` (убирает только хвост « (N)»), затем «База», «База (2)», «База (3)»… База усекается под `max`. «Маша (2) (2)» невозможно.

### 5.2 `classifyJoin` (чистая функция)

Порядок проверок: **токен > нет совпадения по имени > живой сокет > секретные фазы > белый список фаз > IP (policy strict) > грация**.

| `kind` | Условие | Результат |
|---|---|---|
| `token` | токен найден | вернуть молча, в любой фазе |
| `fresh` | имя свободно (нет места с таким `nameKey`, `left`-места пропускаются) | новое место |
| `taken_online` | у места есть живой сокет (и не «завис»: `isStale`) | занято |
| `secret_blocked` | фаза из `secretPhases` | `name_taken{retry:true}` |
| `phase_blocked` | фаза вне `claimablePhases` (`reason:"phase"`) либо `policy:"strict"` и другой IP (`reason:"ip"`) | занято |
| `pending` | сокет закрылся меньше `graceMs` назад | `retry` через `retryInMs` |
| `claimable` | офлайн-место можно вернуть после подтверждения | `prompt` |

Параметры: `claimablePhases` по умолчанию `["lobby","finished"]` (белый список), `graceMs` по умолчанию `CLAIM_GRACE_MS` = 2000 мс (у floe/rapids в бою 10 000 с `policy:"strict"`), `closedAt` без данных = «давно» (место из дампа после restore), «завис» (сокет есть, `misses ≥ 2`) = офлайн.

### 5.3 `decideJoin`

| Вход | Результат |
|---|---|
| `kind:token` | `{action:"resume", silent:true}` |
| имя пусто после очистки | `{action:"deny", error:"bad_name"}` |
| `fresh` | `{action:"create", name, renamed:false}` |
| клиент с `fresh:true` («Я другой») | `create` с «База (N)» при любом занятом имени |
| `claimable`, нет `caps:["claim"]` | `legacyClaim !== false` → молчаливый `claim` (`silent:true`, токены отозвать, `replaceSocket`); у floe/rapids `legacyClaim:false` → «База (N)» |
| `claimable`, `caps` есть, `claim:true` | `claim` (`silent:false`) — **те же** проверки грации/фазы/IP, обойти флагом нельзя |
| `claimable`, `caps` есть | `{action:"prompt", error:"name_claim", name, player}` |
| `pending`, `caps` есть | `{action:"retry", retry:true, retryInMs}` |
| `pending`, `caps` нет | `taken{reason:"pending"}` |
| `taken_online`/`secret_blocked`/`phase_blocked` | `{action:"taken", reason, online, retry (только secret_blocked), suggested}` |

Дальше игра решает, что делать с `taken`: в лобби/итогах — взять `suggested` и ответить `joined{name, renamed:true}` (так у bomb, crowd, lastq, quip, fibs, roulette, floe, rapids), в партии — отдать `name_taken` (crowd, fibs, quip с `caps`), либо «зритель» с новым именем (floe/rapids), либо `game_started` (bomb, auction).

### 5.4 Подтверждение «Это ты?» (`pendingClaim`)

- Сокет, которому ушёл `name_claim`/`retry`, помечается `pendingClaimAt` (`markPending`) и живёт **`CLAIM_WAIT_MS` = 120 с** (env `CLAIM_WAIT_MS`) вместо `ANON_TTL_MS` (30 с); он не вытесняется `evictAnon` и не входит в `MAX_ANON_PER_IP`.
- Потолки: `MAX_PENDING_PER_IP` = 6, `MAX_PENDING_PER_ROOM` = 12. При превышении — `name_taken{reason:"pending_ip"|"pending_room"}` (у lastq — тихо переход к «База (N)»).
- `accept()` = `join{claim:true}`; `decline()` = `join{fresh:true}`. Клиент `MP.joinFlow.resume()` после обрыва сокета повторяет `join` (без `claim`/`fresh`), чтобы сервер продлил ожидание и экран не пропал.
- `summary` в `name_claim` — только перечисленные ключи (`claimSummary`): score / stack / avatar / color / ci — никаких секретов.
- **При подтверждённом `claim` прежние токены места отзываются** (кроме аукциона: там молчаливый подхват токены не трогает — настоящий владелец вернётся по токену и вытеснит захватчика), прежнему сокету уходит `replaced`, выдаётся новый токен.

---

## 6. Присутствие, призраки, правила R1–R6

«Призрак» — место, у которого нет живого сокета. Состояние места: `online` (поле отсутствует = онлайн), `offSince` (мс, момент ухода в офлайн; **в дампе**; при `restore` ставится «сейчас», а не «давно»: после деплоя лобби не пустеет — `presence.onRestore`).

### 6.1 Правила (единые для десяти игр)

| № | Правило | Класс | Как в коде |
|---|---|---|---|
| **R1** | В игре место **никогда** не освобождается по таймеру; вернуться можно обновлением страницы в любой фазе (токен) | A | `ghostsToDrop`/`evictOldestGhost` при `stage:"game"` → `[]`/`null` |
| **R2** | В лобби и итогах офлайн-место живёт `GHOST_TTL_MS` (120 с, env), при заполнении комнаты вытесняется **самое давнее офлайн-место старше порога**; в итогах не удаляются места с очками/наградами/участием (`hasEarned`); перед новой партией офлайн дольше 8 с в неё не переходят (`left:true`, токен не отзывается) | A | `lib/presence` |
| **R3** | Выпавший **до** начала единицы игры (вопрос, раздача, лот, раунд) в ней не участвует и не теряет очков | **B**, `RULE_U08_GHOST_OUT` | §11 |
| **R4** | Автоответы за офлайн (🐌, авто-ложь, «нет ответа», автоставка) не дают очков, бонусов, лайков, «Ответа вечера», наград, побед | A | `game.js` игры |
| **R5** | Призрак исключён из счётчиков «ответили N из M», минимума игроков, кворума, пулов целей; виден серым «нет связи» тем же размером плитки | A | `game.js` игры |
| **R6** | Автовыбывания по времени нет — только кик ведущим (с подтверждением) | A | — |

### 6.2 Константы

| Что | Значение | Env | Где |
|---|---|---|---|
| Срок офлайн-места в лобби/итогах | 120 000 мс | `GHOST_TTL_MS` | `lib/presence`; floe/rapids — через `PROD_ENV` (диапазон 5 000…3 600 000) |
| Грация перед «офлайн» (сокет закрыт, ждём возврата) | 8 000 мс | `OFFLINE_GRACE_MS` | все, кроме floe/rapids (у них `setOnline(false)` сразу при закрытии, дальше `OFFLINE_T`) |
| Грация подхвата по имени | 2 000 мс | `CLAIM_GRACE_MS` (bomb, crowd, lastq, quip); fibs — константа; **roulette — `OFFLINE_GRACE_MS` (8 000)**; в игре без флага U01 у bomb/fibs/quip/roulette — 0 (молчаливый подхват) | `lib/seats.CLAIM_GRACE_MS` |
| В бою floe/rapids: офлайн перед подхватом по имени | 10 000 мс | — | `graceMs`, `policy:"strict"` |
| Ожидание «Это ты?» | 120 000 мс | `CLAIM_WAIT_MS` | `lib/seats` (floe/rapids — `PROD_ENV`) |
| Аноним без входа | 30 000 мс | `ANON_TTL_MS` | серверы |
| Офлайн перед новой партией не берут | 8 000 мс | — (`graceMs` у `pruneOfflineForNewGame`; у roulette/auction — `OFFLINE_GRACE_MS`) | `lib/presence.DEFAULT_NEWGAME_GRACE_MS` |
| Снятие офлайн-пингвина со льдины (floe) | 5 с | `FLOE_CFG` (dev) | `OFFLINE_T`; **rapids — 0** (утка плывёт) |
| Передача прав ведущего комнаты (floe/rapids) | 10 000 мс | — | `HOST_HANDOFF_MS` |

### 6.3 Как фаза игры «видит» призрака

`setOnline(p, online, now)` — единая точка (offline: `offSince = now`, `online=false`; online: поле стирается). Игры обновляют `online` по таймеру `OFFLINE_GRACE_MS` после закрытия последнего сокета места и по `ping/pong` (§9).

---

## 7. Игры вне общего пути

- **wave** — **собственная** логика входа в `wave/server.js` (`case "join"`), без `lib/seats` и `lib/names`; `caps`/`name_claim`/`retry` **не поддерживаются**. Подхват по имени — молчаливый, только в `lobby`/`finished` и только офлайн-места (в раундах — `name_taken{online}`); у игрока один действующий токен (`TOKENS_PER_PLAYER = 3` — запас, лишние выбиваются; при возврате по токену прочие отзываются); тёзке — «Имя 2» (не «Имя (2)»). Ответ `joined` без `renamed`/`resumed` в случае повторного `join`.
- **auction** — `lib/seats.decideJoin` вызывается с `caps:[]` и `graceMs:0`: клиент `caps` не шлёт, подхват **молчаливый** (`resumed:true` → плашка «Ты в игре как…»), `claimablePhases` — все фазы, `token`-вход не обновляется. Токены прежнего места **не отзываются**. Ведущий-пульт с телефона: `host{remote:true}`.
- **floe** — вход по имени в бою: **без токена только «снятый» (`st:"gone"`) место и только после подтверждения «Это ты?»**; прочих тёзок ждёт «Имя (N)» (зритель). Под `RULE_U01_CLAIM_IN_GAME` добавляется офлайн ≥ 10 с с того же IP (`policy:"strict"`).
- **rapids** — как floe, плюс в заплыве подхват только под `RULE_U01_CLAIM_IN_GAME` и только с того же IP (`seat.ip === client.ip`).
- **lastq** — в игре подхват **без флага** разрешён во всех фазах, но только `policy:"strict"` (тот же IP), с подтверждением (`caps`), с отзывом токенов; вернувшийся `left` с тем же именем и IP получает запись назад молча (`rejoinLeft`).

---

## 8. Ведущий

| Игра | Как становятся ведущим | Ссылка ведущего | Права при потере |
|---|---|---|---|
| auction, bomb, crowd, fibs, lastq, quip, roulette, wave | экран-доска шлёт `host{token}` (`hostToken` приходит из `POST /rooms`), хранится в `localStorage["<игра>-host-КОД"]`; **одна доска на комнату**: прежняя получает `host_lost` и становится зрителем | `…board.html?r=КОД&h=ТОКЕН` (кнопка «🔑 Ссылка ведущего» копирует в буфер, токен на экране не рисуется); страница читает `h`, кладёт в хранилище и убирает из адреса (`replaceState`). **У аукциона** токен в адресе доски — параметр `t` (`auction-board.html?r=…&t=…`), `MP.hostLink` не подключён | не переходят: нужен токен |
| floe | ведущий комнаты — **игрок**: в `join` присылает `hostToken`, иначе первый вошедший | `floe-battle.html?r=КОД&h=ТОКЕН` (`MP.hostLink`) | пропал на `HOST_HANDOFF_MS` (10 с) → следующему по времени входа онлайн |
| rapids | то же, плюс запоминается `creatorId` (создатель) | **отклонение: ссылки ведущего на странице нет** (`duck-rapids.html` не читает `h`, `MP.hostLink` не подключён); токен лежит в `rapids-host-КОД` того же браузера | как floe; создателя, пока он офлайн, убрать нельзя (`creator_away`) |

Команды ведущего: `start`, `kick`, `settings`, `end`, `lobby` и т. п. — только от сокета с `host`. Двухтактные (`MP.twoTap`: первый тап «взводит» на 3 с, второй выполняет) — «Закончить», «Дальше», ✕ у игрока. В crowd кик — **не бан** (U-06, класс A: имя занимается заново новой записью; `room.bans` из старых дампов читается, но не пополняется).

---

## 9. Пинги, живость, офлайн

| Параметр | Значение | Env | Игры |
|---|---|---|---|
| Общий цикл `SWEEP` (WS-ping, TTL комнат) | `min(25 с, ROOM_TTL/4)` | — | все, кроме floe/rapids |
| Промахов подряд до `terminate` | 3 | `PONG_MISSES` | все (floe/rapids — цикл 20 с, `PROD_ENV`) |
| «Быстрый» пинг комнат в игре (не лобби/итоги) | 8 000 мс | `PING_MS` | auction, bomb, crowd, fibs, lastq, quip, wave |
| Промахов подряд на быстром цикле | 2 | `GAME_PONG_MISSES` (fibs: ещё `PONG_MISSES_GAME`) | то же |
| Минимум тишины перед закрытием (≥ 20 с) | 20 000 мс | `GAME_DEAD_MS` | то же |
| Комната без активности | 30 мин | `ROOM_TTL_MS` | все |
| Poll-клиент без опроса | 12 000 мс | `POLL_GAP_MS` | 8 игр с long-poll |
| Потолок неотправленного на сокет (больше — сокет рвётся) | 1 МиБ: auction, crowd, lastq, roulette, wave; 256 КиБ: bomb, fibs, quip, floe, rapids | `SEND_BUFFER_LIMIT` | все |
| `ws.ping` не отвечен → `misses` | — | — | сокет «завис» (`misses ≥ 2`) считается офлайн в `classifyJoin` |

**Roulette** — без быстрого цикла (только общий `SWEEP`, `PONG_MISSES`). **Floe/rapids** — клиент шлёт `ping{c, rtt}`, сервер отвечает `pong{c, t}` и отражает пинг в ростере; `ws.ping` раз в 20 с.

Клиентская живость: `MP.conn` — по тишине (любое входящее сообщение, включая `pong`, сбрасывает): ping по сокету каждые **5 с в игре** / 10 с в лобби; тишина > 10 с → `onOffline` (баннер «связь пропала»), > 22 с → `onDead` (игра закрывает сокет и переподключается). Подключён на страницах: auction, auction-board, bomb, bomb-board, crowd, crowd-board, fibs, fibs-board, lastq, lastq-board, quip, wave, wave-board.

---

## 10. Клиентский каркас `window.MP` (`mp-common.js`, версия 1.1.0)

Подключается строго `<script src="legacy-compat.js">` → `<script src="mp-common.js">` (на досках раньше `*-shared.js`). Игра обязана работать и без него: всё через `window.MP && …`. Синтаксис не выше ES2017 (проекторы с Chromium 80–83), проверяет `tools/testkit/mp-units.js`.

| API | Назначение |
|---|---|
| `MP.store.get/set/del` | localStorage в try/catch |
| `MP.applyHello(hello)`, `MP.limits`, `MP.charCount`, `MP.clip` | лимиты из `hello`, длина по символам |
| `MP.joinFlow({send, buildJoin, onClaimPrompt, onJoined, onTaken, onGiveUp, onRetry, maxRetries=6, retryMs=2000})` | разбор `joined`/`name_claim`/`name_taken`; `join(extra)`, `handle(msg)` (true = потреблено), `resume()`, `cancel()`, `state()` |
| `MP.nameCounter(input, max, {threshold=4})` | «12/16» при остатке ≤ 4 символа, срез по символам |
| `MP.replacedTab({rejoin, onReplaced, onTokenGone, auto, autoMinMs=5000, claimQuietMs=60000})` | «Ты открыл игру в другой вкладке»; `back()`, `canAutoReturn()`, `noteClaimElsewhere()` |
| `MP.draft({game, room, ttlMs=7 200 000, max})` | черновик текста: ключ `mp:draft:<game>:<КОД>`, один слот на комнату, TTL 2 ч; `save/load/clear/key` |
| `MP.sendQueue({send, keep, onDrop, ceilingMs=90 000, replace, max=8, minGapMs=250, probe})` | очередь действий, нажатых при обрыве; `push/flush/heard/size/has/clear`; `onDrop(m, "expired"|"unwanted"|"overflow"|"off")` обязателен |
| `MP.hostLink({hostKeyFn, boardPath, getRoom, onToast, sendHost, takeMinMs=3000})` | «🔑 Ссылка ведущего»: `url()`, `copy()` (буфер → Web Share → `prompt`), `adopt(text)`, `take()`; `MP.hostLink.build/parseToken` |
| `MP.roomGone({showForm, onClosed})` | «Такой комнаты нет» (404 до первого `hello`) vs «Комната закрыта» (после); `MP.roomGone.normalize(raw)` → A–Z2–9 ≤ 12 |
| `MP.twoTap(el, {onConfirm, armedMs=3000})`, `MP.twoTap.create` | двухтактная команда ведущего |
| `MP.conn({ping, inGame, onOffline, onOnline, onDead, pingGameMs=5000, pingLobbyMs=10000, warnMs=10000, closeMs=22000})` | живость сокета по тишине |
| `MP.progress.text(done, total, secs, {kind})` | «Ответили 4 из 6 · ~40 с» (`kind`: answered/voted/wrote/locked; ru/en/el) |
| `MP.rank(players, {score, tiebreak, exclude})` | ранг 1,1,3; `winnerIds`; `left` и `played===false` не участвуют |
| `MP.vibrate(pattern)` | только после жеста, без исключений |
| `MP.keyboardClass({className='kb', threshold=120})` | `html.kb` и `--kb-h`, когда клавиатура съела > 120 px |
| `MP.followRoomLang({getRoomLang, onSuggest, auto, enabled})`, `MP.rules` | «Язык комнаты: EN. Переключить?»; авто-следование — за `MP.rules.RULE_U17_LANG_FOLLOW` (§11) |

**Какие страницы что используют** (по `grep MP.<модуль>`):

| Модуль | Страницы |
|---|---|
| `joinFlow` | bomb, crowd, fibs, floe-battle, duck-rapids, lastq, quip, roulette (**auction.html и wave.html — нет**) |
| `nameCounter` | auction, crowd, fibs, lastq, quip, roulette |
| `replacedTab` | crowd, lastq, roulette |
| `draft` | fibs, quip, wave |
| `sendQueue` | bomb, crowd, fibs, roulette |
| `hostLink` | bomb-board, crowd-board, fibs-board, lastq-board, quip-board, roulette-board, wave-board, floe-battle |
| `roomGone` | все 10 игр (телефоны и доски) |
| `twoTap` | auction-board, bomb-board, crowd-board, fibs-board, lastq-board, quip-board, roulette-board, wave-board, duck-rapids |
| `conn` | auction, auction-board, bomb, bomb-board, crowd, crowd-board, fibs, fibs-board, lastq, lastq-board, quip, wave, wave-board |
| `progress` | fibs, quip, wave |
| `keyboardClass` | fibs, quip, wave |
| `followRoomLang` | auction, crowd, fibs, lastq, quip, roulette, wave |
| `rank`, `vibrate` | **не вызываются ни одной страницей** (есть в API и в тестах) |

**Ключи хранилищ** (браузер игрока): `<игра>-token-<КОД>` (токен места), `<игра>-host-<КОД>` (токен ведущего), `<игра>-name` (последнее имя), где `<игра>` ∈ `auction, bomb, crowd, fibs, floe, lastq, quip, roulette, wave, rapids`; `mp:draft:<game>:<КОД>`; `mp-off` (`'1'` — аварийный выключатель каркаса); `site-lang`; `sessionStorage['mp-lang-manual']` (человек выбрал язык вручную).

---

## 11. Флаги правил `RULE_*` (класс B)

Принципы: **по умолчанию выключено («как сейчас»)**, включаются только по явному «да» владельца; повторный плейтест G2 шёл на стенде с включёнными рекомендованными. `docker-compose.yml` их **не прописывает**: контейнер видит только переменные, перечисленные в `environment:` сервиса (значения из `.env` подставляются только туда), поэтому для включения нужно добавить строку вида `- RULE_U01_CLAIM_IN_GAME=${RULE_U01_CLAIM_IN_GAME:-}` и пересоздать контейнер игры (перезапуск обрывает идущие комнаты — окно низкой нагрузки). Значения разбираются **по-разному**, поэтому писать надо `1`:

- только `"1"`: `RULE_U01_CLAIM_IN_GAME` (bomb, crowd, quip, rapids, roulette), `RULE_U08_GHOST_OUT` (auction, crowd, lastq, quip), `RULE_U20_DRY_T1`, `RULE_U21_PASS_LABEL`, `RULE_U26_BOMB_ONLINE`, `RULE_U28_SERVER_DRAFT`, `RULE_U48_ILLUSION`, `RULE_U51_COUNTDOWN_LEAVE`, `RULE_U53_NO_SPECTATOR_DASH`, `RULE_U17_LANG_FOLLOW`, `RULE_U43_*`, `RULE_U45_BET_WINDOW`, `RULE_U46_MINMS`;
- `1|true|on` (без учёта регистра): floe — `RULE_U01_CLAIM_IN_GAME`, `RULE_U39_START_RING`;
- `1|true|on|yes`: fibs — `RULE_U01_CLAIM_IN_GAME`, `RULE_U03_HOST_QR`, `RULE_U09B_CHOOSE_EXTEND`, `RULE_U31_LIKE_GRACE`, `RULE_U33_CAPITALIZE`; wave — `RULE_U08_GHOST_OUT`, `RULE_U34_WAVE_RULES`.

Флаги читаются на каждом вызове (`process.env` в `game.js`: lastq, crowd, quip, bomb, fibs) либо один раз при старте процесса (константы в `server.js`: auction, bomb-U01, crowd-U01, quip-U01, rapids, roulette, floe, wave).

| Флаг | Игры | По умолчанию | Что меняет при включении |
|---|---|---|---|
| `RULE_U01_CLAIM_IN_GAME` | bomb, crowd, fibs, floe, quip, rapids, roulette | выкл. | Вход **по имени** (чистый контекст, без токена) в идущей партии. Выкл.: bomb/fibs/quip/roulette — офлайн-место возвращается **молча** (как раньше, без «Это ты?»); crowd — только лобби/итоги, посреди партии `name_taken{reason:"phase"}`; floe/rapids — только токен (floe — ещё «снятый»). Вкл.: «Это ты?» с подтверждением в несекретных фазах (crowd/quip: + `intro, reveal, scores`, crowd ещё `pause`; floe/rapids: офлайн ≥ 10 с и тот же IP; «Я другой» заводит тёзку «Имя (N)») |
| `RULE_U03_HOST_QR` | fibs | выкл. | `hello.flags.RULE_U03_HOST_QR` доске: можно показать QR ссылки ведущего на 60 с |
| `RULE_U08_GHOST_OUT` | auction, crowd, lastq, quip, wave | выкл. | R3: выпавший до начала единицы в ней не участвует и не теряет очков (auction — `away` на старте; crowd — `left` на старте; lastq — вне `eligible`, ставить на него нельзя; quip — не раздаём пары, партия не стартует без троих на связи; wave — «Поехали» без офлайн). Выкл.: «не ответил = ошибка/🐌» |
| `RULE_U09B_CHOOSE_EXTEND` | fibs | выкл. | Вернувшемуся без выбора продлить фазу выбора (не больше +8 с, одно продление на фазу) |
| `RULE_U17_LANG_FOLLOW` | lastq (сервер); клиент — `MP.rules` | выкл. | lastq: телефон шлёт `lang`, получает `question.tr`; `hello.rules` отдаёт флаг. **Отклонение:** у остальных страниц `MP.rules.RULE_U17_LANG_FOLLOW` — клиентская переменная, которую **никто не заполняет из `hello`** (`applyHello` копирует только `limits`): авто-следование языку на них фактически выключено, остаётся подсказка «Язык комнаты: EN. Переключить?» |
| `RULE_U20_DRY_T1` | auction | выкл. | После 2 пустых лотов подряд T1 лота — 10 с (`DRY_SHORT_T1`) |
| `RULE_U21_PASS_LABEL` | auction | выкл. | «Скип» → «Пас» в русском интерфейсе (`hello.rules`) |
| `RULE_U26_BOMB_ONLINE` | bomb | выкл. | Бомба достаётся и кидается только тем, кто на связи (`state.onlineOnly`, плитки «нет связи» серые, ответ сервера `reason:"offline"`) |
| `RULE_U28_SERVER_DRAFT` | quip | выкл. | Серверный черновик ответа засчитывается по таймауту вместо 🐌 (в плане назван `RULE_U28_DRAFT_SERVER`) |
| `RULE_U31_LIKE_GRACE` | fibs | выкл. | Окно лайков 2,5 → 5 с, раскрытие сразу, когда у всех потрачены оба лайка |
| `RULE_U33_CAPITALIZE` | fibs | выкл. | У всех вариантов (правда/ложь/ловушки) первая буква заглавная |
| `RULE_U34_WAVE_RULES` | wave | выкл. | Строгий валидатор (числа словом, перевод-заимствование, эмодзи), «Изменить» отправленную подсказку, раскрытие +2,8 с (`REVEAL_HOLD`), заставка ×2 — 5 с |
| `RULE_U39_START_RING` (и `START_RING`, `START_GUARD`) | floe | выкл. | Стартовое кольцо 0,45R → 0,30R («центр спасает»); `START_RING` числом (0,15…0,6) сильнее флага; `START_GUARD` (0,5…10 с, по умолчанию 2) — класс A |
| `OFFLINE_FALL_GRACE` (в коде `RULE_U38_FALL_GRACE` — только комментарий) | floe | `0` | Падение в первые N с (0…10) после отключения/`leave` засчитывается (иначе рывок + закрытая вкладка обходят роль неудачника); рекомендация плана — 1,5 |
| `RULE_U43_LATE_MIN` (синоним `RULE_U43_LATE_SCORE`) | lastq | выкл. | Вошедший под **новым** именем посреди партии стартует со счётом `min(0, минимум партии)`, а не с 0 |
| `RULE_U45_BET_WINDOW` | lastq | выкл. | Окно ставок на спасение `clamp(2000 + 1000·N, 3000, 6000)` мс вместо 3000 |
| `RULE_U46_MINMS` | lastq | выкл. | `minMs` испытаний по человеческому потолку (dig 100, saw 200, wires 150, order 170 мс на единицу) и запас времени на остальные испытания при выдаче |
| `RULE_U47_CROWD_DECIDER` (синоним `RULE_U47_DECIDER`) = `now`/`v1`/`v2` | crowd | `now` | Решающий вопрос: `now` — единодушие/ничья дают +50 и партия кончается; `v1` — +50 нет, победа делится; `v2` — как `v1` плюс ещё один решающий (всего ≤ 2) |
| `RULE_U48_ILLUSION` | crowd | выкл. | «Иллюзия» не два раунда подряд |
| `RULE_U51_COUNTDOWN_LEAVE` | rapids | выкл. | Добровольный выход в 3-секундном отсчёте не делает «неудачником» (кик ведущим — без наказания всегда, класс A) |
| `RULE_U53_NO_SPECTATOR_DASH` | rapids | выкл. | Рывок зрителя в идущем заплыве запрещён (в лобби остаётся) |

Нераскатанного по плану **нет**: все флаги из реестра §2.3б плана присутствуют в коде. Названия, отличающиеся от плана: `RULE_U28_DRAFT_SERVER` → `RULE_U28_SERVER_DRAFT`; `RULE_U47_DECIDER` → `RULE_U47_CROWD_DECIDER` (старое принимается); `OFFLINE_FALL_GRACE` вместо `RULE_U38_*`; `RULE_U46_MINMS`/`RULE_U45_BET_WINDOW` — как в плане. В коде есть флаги, которых в реестре плана нет: `RULE_U20_DRY_T1`, `RULE_U33_CAPITALIZE`, `RULE_U03_HOST_QR`, `RULE_U43_LATE_SCORE` (синоним), `RULE_U08_GHOST_OUT` у floe/rapids/bomb/fibs/roulette **не** реализован (там R3 не применимо или невозможно: в floe/rapids офлайн-утка плывёт, bomb — `RULE_U26`).

Прочие env, влияющие на присутствие и лимиты (не флаги правил): `GHOST_TTL_MS`, `CLAIM_WAIT_MS`, `CLAIM_GRACE_MS`, `ANON_TTL_MS`, `PONG_MISSES`, `PING_MS`, `GAME_PONG_MISSES`, `GAME_DEAD_MS`, `OFFLINE_GRACE_MS`, `POLL_GAP_MS`, `MAX_ANON_PER_IP`, `MAX_ANON_PER_ROOM`, `MAX_ROOMS`, `MAX_ROOMS_PER_IP`, `MAX_SOCKETS_PER_ROOM`, `MAX_TOTAL_SOCKETS`, `MAX_SOCKETS_PER_IP`, `MSG_RATE`, `MSG_HARD`, `CMD_RATE`, `GUESS_LIMIT`, `SEND_BUFFER_LIMIT`, `ROOM_TTL_MS`, `DUMP_FILE`, `ROUND_EXTRA_SEC` (quip/fibs/wave, 0…60, по умолчанию 15), `INPUT_STALE_MS` (floe 1500 / rapids 1200), `MAX_ACTIVE` (floe/rapids 40), `MP_OFF`. В compose прописаны: `GHOST_TTL_MS`, `CLAIM_WAIT_MS`, `ANON_TTL_MS`, `PONG_MISSES`, `OFFLINE_GRACE_MS` (все, кроме floe/rapids — у них `GHOST_TTL_MS`, `CLAIM_WAIT_MS`, `INPUT_STALE_MS`), `PING_MS`, `GAME_PONG_MISSES`, `GAME_DEAD_MS` (auction, bomb, quip, fibs, wave, crowd), `ROUND_EXTRA_SEC` (quip, fibs, wave), `OPENAI_*` (auction).

---

## 12. Что поддерживает какая игра

| | auction | bomb | crowd | fibs | floe | lastq | quip | rapids | roulette | wave |
|---|---|---|---|---|---|---|---|---|---|---|
| `lib/seats.decideJoin` | да (`caps:[]`) | да | да | да | да | да (strict) | да | да | да | **нет** |
| `limits.name` в `hello` | 24 | 16 | 15 | 16 (+`answer` 25) | 15 | 16 | 16 | 15 | 16 | **нет** |
| `hello.mp:false` (`MP_OFF`) | да | да | да | да | **нет** | да | да | да | да | да |
| `name_claim` («Это ты?») в лобби/итогах | нет (молча) | да | да | да | да | да | да | да | да | нет (молча) |
| то же в партии | нет (молча, любая фаза) | флаг U01 | флаг U01 | флаг U01 | снятый всегда, офлайн ≥ 10 с — флаг | **всегда**, тот же IP | флаг U01 | флаг U01 (тот же IP) | флаг U01 | нет (секретные фазы — запрет) |
| секретные фазы подхвата | — | — | `vote`, `opinion` | — | — | — | `answer`, `vote` | — | — | всё, кроме `lobby`/`finished` |
| имя тёзки | «Имя 2» | «Имя (N)» | «Имя (N)» | «Имя (N)» | «Имя (N)» | «Имя (N)» | «Имя (N)» | «Имя (N)» | «Имя (N)» | «Имя 2» |
| отзыв токенов при `claim` | нет | да | да | да | да | да | да | да | да | да |
| `GHOST_TTL_MS` (сносит офлайн в лобби) | лобби | лобби | **только вытеснение при полной комнате** | **нет** | лобби + итоги (без участвовавших) | лобби + итоги | **нет** | лобби + итоги | лобби + итоги | лобби + итоги |
| вытеснение самого давнего при заполнении | да (лобби) | да (лобби) | да (лобби/итоги) | **нет** | да (не в бою) | да | **нет** | да | да | да |
| `pruneOfflineForNewGame` / офлайн не берут в новую партию | нет (старт требует ≥ 2 на связи) | при «Старт» из итогов | только под `RULE_U08_GHOST_OUT` (`left`) | — | при старте | при «Ещё партию» | — | при старте | при старте | при старте |
| `RULE_U08_GHOST_OUT` | да | — | да | — | — | да | да | — | — | да |
| быстрый пинг (`PING_MS`) в игре | да | да | да | да | — (20 с) | да | да | — (20 с) | **нет** | да |
| `GET /<игра>/api/room` | нет | нет | нет | нет | **да** | нет | нет | **да** | нет | нет |
| long-poll запасной путь | да | да | да | да | нет | да | да | нет | да | да |
| ссылка ведущего (`?h=`) | `?t=` | да | да | да | да | да | да | **нет** | да | да |
| передача прав ведущего | нет | нет | нет | нет | да (10 с) | нет | нет | да (10 с) | нет | нет |
| `creator_away` | — | — | — | — | нет | — | — | да | — | — |
| `MP.joinFlow` на странице | нет | да | да | да | да | да | да | да | да | нет |
| `MP.sendQueue` | нет | да | да | да | нет | нет | нет | нет | да | нет |
| `MP.draft` | нет | нет | нет | да | нет | нет | да | нет | нет | да |
| мест (макс.) / минимум для старта | 100 / 2 | 16 / 2 | 12 / 3 | 16 / 3 | 12 / 2 | 10 / 2 | 16 / 3 | 12 / 2 | 12 / 2 | 12 / 3 |

**Известные отклонения от плана (на 13.10.2026)**, зафиксированные как есть — менять код вне задачи этого документа:

1. **fibs и quip** не удаляют офлайн-места по `GHOST_TTL_MS` и не вытесняют самое давнее при `room_full`, хотя `docker-compose.yml` передаёт им `GHOST_TTL_MS`: места-призраки копятся до закрытия комнаты, 17-й вход получит `room_full`.
2. **crowd** вытесняет самое давнее офлайн-место только при заполнении комнаты (`evictGhost`), по таймеру `GHOST_TTL_MS` не снимает.
3. **floe**: `MP_OFF` не доходит до клиента (`hello.mp` не выставляется).
4. **rapids**: нет ссылки ведущего `?h=` на странице.
5. **`MP.rules.RULE_U17_LANG_FOLLOW`** на страницах auction/crowd/fibs/quip/roulette/wave не получает значение с сервера — флаг по факту работает только у lastq.
6. **wave** и **аукцион** не используют `name_claim`: подхват по имени там молчаливый (в wave — только лобби/итоги и офлайн-место).
7. **`MP.rank`, `MP.vibrate`** реализованы и покрыты тестами каркаса, но страницами не используются.
