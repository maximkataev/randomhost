# «Блэкджек»: контракт движка для доски, телефона и соло (18.10.2026)

Источник правды по правилам — `docs/blackjack-spec.md`; по коду — `blackjack/game.js` (движок), `blackjack/strategy.js` (базовая стратегия и подсказки Марго). Этот файл фиксирует то, на чём стыкуются части: снимок состояния, действия клиента, фазы и тайминги, сюжеты режиссёра, события, константы. Написан по коду этапа 1; сервер (этап 4) обязан отдавать `game.snapshot(now, forPlayer)` как есть и маппить сообщения на методы из §2.

Движок один и тот же на сервере (`require("./game")`) и в браузере соло (`<script src="blackjack/game.js">` → `window.BlackjackGame`, `strategy.js` → `window.BlackjackStrategy`). Синтаксис не выше ES2017, без зависимостей.

## 1. Снимок состояния `game.snapshot(now, forPlayer)`

`forPlayer` — `null`/`undefined`/`"board"` для доски, иначе `id` игрока. Все времена — серверные миллисекунды; клиент считает `phaseEndsAt − now` и тикает локально.

```
{ phase: "lobby"|"betting"|"closing"|"dealing"|"insurance"|"deciding"|"dealer"|"payout"|"finished"|"paused",
  pausedPhase: null|"betting",        // при phase "paused" — какая фаза стоит (пауза ведущего держится только в ставках)
  pauseNext: bool,                     // пауза заказана посреди раздачи — встанет на следующих ставках
  now, phaseEndsAt: ms|null,           // null — в лобби/итогах, на паузе и в соло в фазах betting/insurance/deciding (там таймеров нет)
  waveStart: ms|null,                  // deciding: начало текущей волны (после подлёта карт прошлой)
  game: n, hand: n (с 1), level: 0..12, levels: 13,
  minBet, overtime: 0|25|50|100, nextMinBet, handsToLevel: n|null,
  format: "last"|"hands"|"tournament", handsTotal: 15|20|30|null, cutIn: n|null, cutK: n|null,
  wave: n (0 вне deciding),
  shoe: { left: 0..1, cut: 0.25, reshuffle: bool },   // left — доля шуза в запасе; reshuffle — эта раздача началась с «Нового шуза»
  dealing: null | [{playerId, card} | {dealer:true, card} | {dealer:true, hidden:true}],   // порядок сдачи, только в фазе dealing
  dealer: null | {
    up: card|null, hole: card|null, cards: [card], value, soft, bust, blackjack,
    peek: null|"ace"|"ten", insurance: bool,                 // insurance — предлагалась ли страховка (туз)
    plot: null|"normal"|"longflip"|"cards"|"bust"|"allin"|"jackpot"|"rescue"|"dealerbj",
    revealAt: [ms], allin: [playerId], jackpot: bool, rescue: [playerId] },
  reveals: [{by, card, target, outcome:"ok"|"gone"|"busy"|"shielded"}],   // открытые карты-пакости этой раздачи (с фазы closing)
  players: [ … см. ниже … ],
  me: null | { id, cards: [trick], peekHole: card|null, hintOn: bool, muted: bool, lastBet: {main,pp,tp}|null, redealAvail: bool },
  events: [{t, hand, type, …}],         // последние 30 событий движка (§5); телефону — без secret-событий текущей раздачи до итога
  chat: [{id, pid, text, at}],          // последние 12 нескрытых
  settings: {format, handsTotal, stack, pace, betTime, cards, chat, calm, lang, solo},
  winnerId, winnerIds: [], draw: bool, finishedReason: null|"last"|"hands"|"all_out"|"host",   // только в finished
  stats: null | {biggestWin, biggestBust, blackjacks:{pid:n}, cruelCard, lastBreath:{pid:n}, exact21, dealerBusts, sideJackpot},
  casino: {won, paid}, minPlayers: 2|1 }

card = { r: "A"|"2".."10"|"J"|"Q"|"K", s: "s"|"h"|"d"|"c" }
trick = "peek"|"redeal"|"shield"|"freeze"|"extra"|"swap"|"tax"|"doublemin"
```

Игрок:

```
{ id, name, color, avatar, seat: n|null, stack, free,   // free — стек минус всё, что на столе (ставки, руки, страховка)
  online, left, out, outHand, spectator, place: n|null (finished),
  ready, bet, side: {pp, tp}, need,                     // need — сколько обязан поставить (минимум ×2 под «Двойным минимумом», не больше стека)
  inHand, skip, allIn, insurance: n, evenMoney, insDecided,
  hands: [{ cards: [card], bet, value, soft, bust, blackjack, done, doubled, fromSplit,
            decision: null|"hit"|"stand"|"double"|"split", auto: bool,     // auto — «Хватит» по таймеру/заморозке/уходу
            result: null|"win"|"lose"|"push"|"bj", payout, evenMoney,
            options: null | {hit, stand, double, split, redeal} }],        // только своя рука в deciding, пока не done
  penalty, net: n|null,                                 // net — итог раздачи по всем источникам, виден с итога
  cardsCount, shield: bool (свой/доске), played: bool,  // played — сыграл карту в этой раздаче (тип не виден до closing)
  frozen, extraIncoming, taxed: playerId|null, doubleMin, doubleMinNext, peeked,
  sideResults: { pp: null|{kind, mult, win}, tp: null|{kind, mult, win} },
  muted }
```

**Скрытность (что телефон не видит):**
- `dealer.hole`, `dealer.cards[1..]`, `dealer.value` по всем картам, `bust`, `blackjack`, `plot`, `allin`, `rescue`, `hands[].result/payout`, `players[].net` — доске с начала фазы `dealer`, телефону — когда `now ≥ revealAt[последний]` (движок сам сравнивает `now`). До этого телефон получает `dealer.cards = [up]`, `dealer.value` = очки открытой карты, `dealer.revealAt = [итог]` (один элемент).
- `me.peekHole` — закрытая карта дилера владельцу «Подгляда» с фазы `dealing`; у остальных `null`, в `players[]` всем видно `peeked: true`.
- Чужие карты-пакости — только `cardsCount`; `shield` виден только владельцу и доске; сыгранные — `played: true` без типа до `closing`, потом в `reveals`.
- Карты игроков, решения, ставки, побочные результаты — открыты всем.
- События `dealer` и `dealer_blackjack` помечены `secret: true` и уходят телефону только с итога раздачи.

## 2. Действия клиента → методы движка

Телефон (игрок):

| сообщение | метод | фаза | отказы (`reason`) |
|---|---|---|---|
| `{type:"bet", amount}` | `bet(pid, amount)` — фишка на основную | betting | closed, bad_amount, no_money |
| `{type:"side_bet", box:"pp"\|"tp", amount}` | `sideBet(pid, box, amount)` — не больше основной | betting | closed, bad_box, bad_amount, over_main, no_money |
| `{type:"unbet"}` | `unbet(pid)` — снять последнюю фишку | betting | closed, empty |
| `{type:"clear"}` | `clearBets(pid)` | betting | closed |
| `{type:"repeat"}` | `repeatBet(pid)` — прошлый набор, урезанный до стека | betting | closed, no_last |
| `{type:"set_bets", main, pp, tp}` | `setBets(pid, {main,pp,tp})` — набор целиком («Удвоить ставку» считает клиент) | betting | closed, bad_bet, bad_amount, no_money |
| `{type:"all_in"}` | `allIn(pid)` | betting | closed, no_money |
| `{type:"ready", ready:true\|false}` | `ready(pid, ready, now)` — все готовы → ставки закрываются досрочно | betting | closed |
| `{type:"play_card", card, target?}` | `playCard(pid, card, targetId)` — одна карта за раздачу; «себе» без цели | betting | no_cards, closed, passive, no_card, one_per_hand, bad_target |
| `{type:"insure", choice:true\|false\|"evenMoney"}` | `insure(pid, choice, now)` | insurance (только при тузе) | closed, not_in_hand, decided, no_blackjack, even_money_only, bad_amount, no_money |
| `{type:"decide", hand, action}` | `decide(pid, handIdx, action, now)`; action — `hit\|stand\|double\|split\|redeal`; решение можно менять до закрытия волны | deciding | closed, not_in_hand, bad_hand, hand_done, not_allowed, bad_action |
| `{type:"hint", on}` | `setHint(pid, on)` | любая | no_player |
| `{type:"chat", text}` | `chat(pid, text, now)` — ≤ 80 символов, ≤ 1 за 3 с | любая | no_player, chat_off, muted, empty, too_fast |
| `{type:"react", emoji, forId?}` | `react(pid, emoji, now, forId)`; `emoji:"💛"` + `forId` — «Болею за…» (только за живого) | любая | bad, too_fast |

Доска (host-токен): `start` → `start(now)`; `settings {patch}` → `setSettings(patch)` (лобби); `pause`/`resume` → `pause(now)`/`resume(now)`; `end` → `finishNow(now)`; `kick {playerId}` → `removePlayer(id, now)`; `mute {playerId, muted}` → `mute(id, muted)`; `hide {id}` → `hideMessage(id)`; `next_game` → `reset()`.

Сервер зовёт `tick(now)` к `phaseEndsAt` и перед каждым действием; `addPlayer({id, name})`, `removePlayer`, `setOnline(id, online, now)` — по `docs/multiplayer-join-protocol.md`. Все методы действий возвращают `{ok, reason?, events?}`; `tick`, `closeBets`, `closeWave`, `settle`, `pause`, `resume`, `finishNow`, `reset`, `mute`, `hideMessage`, `removePlayer`, `setOnline` — массив событий.

Фаза `insurance` при десятке дилера (`dealer.peek === "ten"`, `dealer.insurance === false`) — молчаливое подглядывание 1 с, действий нет.

Соло (`settings.solo = true`): один игрок (`minPlayers: 1`), карт-пакостей нет, `phaseEndsAt === null` в `betting`, `insurance` (при тузе) и `deciding` — страница сама зовёт `ready`/`insure`/`decide`; в `deciding` карта приходит сразу по `decide` (волна = одно действие, `wave` растёт с каждым; после сплита вторая рука ждёт своего решения, `hands[].decision === null`), ход дилера — когда все руки `done`; остальные фазы с таймингами как обычно, `tick(now)` их двигает.

## 3. Фазы и тайминги (`T` в game.js)

| фаза | длительность | что происходит |
|---|---|---|
| `betting` | `settings.betTime` 15/20/30 с (+3 с `T.reshuffle`, если `shoe.reshuffle`) | ставки, карты-пакости лицом вниз; все `ready` → досрочно |
| `closing` | 2000 + 1000 × карт-пакостей | штрафы (`penalty`), карты открываются по одной (`card_reveal`) |
| `dealing` | 300 × (2 × играющих + 2) | порядок в `dealing[]`; побочные решены и выплачены (`side_win`) |
| `insurance` | 6000 при тузе / 1000 при десятке | «Страховка?»/«Ровно 1:1?»; все ответили → досрочно |
| `deciding` | волна 1 — 12000, волны 2+ — 8000, отсчёт от `waveStart` (= закрытие прошлой + 350 × сданных карт) | решения; все решили → досрочно; нет решения — «Хватит» |
| `dealer` | по `dealer.revealAt` (≤ 10 с от начала + `lead`) | доска анимирует по расписанию: `revealAt[0]` переворот закрытой, далее по карте добора, последний — итог |
| `payout` | 4000 (6000 при `dealer.jackpot`) | выплаты, выбывание, отсечение турнира, конец партии |
| `finished` | — | `winnerId`, `winnerIds`, `draw`, `stats`, `place` |

Расписание дилера: переворот через 1000 мс (`longflip` — 2400, `dealerbj` — 1500; `allin` — сначала 1800 мс тишины), карты добора по 1000 (`cards` — каждая на 400 медленнее), после последней — 1200 (`bust` — 2500, `rescue` — 1500). Если играющих нет (все пропустили), фаза `dealer` мгновенная, `dealer.cards = []`.

## 4. Сюжеты режиссёра (`dealer.plot`)

`dealerbj` (дилер подглядел блэкджек — к выплатам) → `allin` (кто-то поставил весь стек при стеке > 2 минимумов) → `jackpot` (побочная ≥ 25:1 или блэкджек на ставку ≥ 5 минимумов) → `rescue` (игрок со стеком ≤ 2 минимумов выиграл не меньше остатка) → квотные `longflip` (≥ 2 рук стоят на 18–20 и это не меньше половины живых) / `cards` (дилер добирает 2+ карты) / `bust` (дилер перебрал при ≥ 2 живых руках) — не чаще одного на 3 раздачи и с вероятностью `SPECIAL_CHANCE` 45% → `normal`. Флаги `allin[]`, `jackpot`, `rescue[]` отдаются и при другом `plot` — эффекты накладываются. Стенд: особых 33%.

## 5. События (`events[].type`)

Каждое с `t` (ms) и `hand`. Партия: `started {game, format}`, `level {level, minBet, overtime}`, `reshuffle`, `betting {hand, cutIn, reshuffled}`, `cut_warning`, `settings`, `paused`, `resumed`, `new_game`, `left {playerId}`, `finished {winnerId, winnerIds, draw, reason}`, `final`.
Ставки: `allin {playerId, amount}`, `card_played {playerId}`, `closed {reveals}`, `penalty {playerId, amount, skip}`, `out {playerId, reason:"penalty"|"bust"}`, `card_reveal {playerId, card, target, outcome}`.
Раздача: `dealt {cards}`, `side_win {playerId, box, kind, mult, win}`, `swap {playerId, target}`, `blackjack {playerId}`, `insurance {offered}`, `dealer_blackjack` (secret), `no_blackjack`, `frozen {playerId}`.
Решения: `wave {wave, hands}`, `decision {playerId, hand, action}`, `redeal {playerId}`, `card {playerId, hand, card, value, soft, why:"hit"|"double"|"split"|"extra"}`, `split {playerId}`, `bust {playerId, hand, value}`, `twentyone {playerId, hand}`.
Дилер и выплаты: `dealer {plot, cards, revealAt}` (secret), `reveal {dealer:[card], value, bust, bj}`, `tax {playerId, target, amount}`, `payout {net:[{playerId, net}]}`, `cut {playerId, coin, among}`.
Не пишутся в лог, только возвращаются методами: `chat {message}`, `react {playerId, emoji}`, `cheer {playerId, forId}`, `chat_hidden {id}`, `muted {playerId, muted}`.

## 6. Константы

- `LEVELS` = 1, 2, 3, 5, 8, 12, 18, 25, 35, 50 % стартового стека; `OVERTIME` = 25, 50, 100 % среднего стека живых (не в «N раздач»); `levels` = 13.
- `PACE` = {fast: 1, normal: 2, slow: 3} раздач на уровень (в турнире +1). Спека предлагала 2/3/4 — стенд дал 22 мин вместо 15–20.
- Турнир: `K = max(2, round(20 / (N − 1)))`, `cutIn` = раздач до отсечения (0 — после этой).
- `MAX_PLAYERS` 12, `MIN_PLAYERS` 2, `NAME_MAX` 15, чат 80 символов / 3 с / 50 в памяти / 12 в снимке, реакции `🔥 😱 😂 👏 🙏 💀` + `💛` («болею»), ≤ 1 в секунду.
- Карты-пакости: 8 типов × 3, две на старте, +1 на уровне, на руках ≤ 3 (`TRICK_HAND`), одна за раздачу, одна враждебная на цель.
- Шуз: 6 колод = 312, отсечка 75% (`shoe.left` ≤ 0.25 → перетасовка перед следующей раздачей).
- Perfect Pairs: mixed 5, colored 10, perfect 25; 21+3: flush 5, straight 10, trips 30, straightFlush 40, suitedTrips 100 (`kind` в `sideResults`).
- Блэкджек 3:2 (`floor(bet × 2.5)`), страховка — ровно половина основной, 2:1; even money — 1:1 (`result:"win"`, `evenMoney:true`).
- Цвета и аватарки — `COLORS`/`AVATARS` из game.js (те же, что в oneword).

## 7. Подсказки Марго (`strategy.js`)

`advise({cards, canDouble, canSplit, fromSplit}, up)` → `{action, fallback, key, value, soft}`; `hint(hand, up, lang, rnd)` → строка; `hand.lastHint` — не повторять эту фразу. Ситуации (`key`): blackjack, bust, twentyone, stand_high, stand_vs_weak, hit_scary, hit_free, double, double_11, double_na, soft_hit, soft18_hit, soft_double, soft_stand, split_aces, split_eights, split, split_na, pair_hit, pair_stand, pair_double — по 3–4 формулировки на ru/en/el. Телефон берёт `canDouble`/`canSplit` из `hands[].options`.
