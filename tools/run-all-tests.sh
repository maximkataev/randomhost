#!/usr/bin/env bash
# Прогон тестов всех 10 игр (+ lib/) под Node 22 и таблица результатов (IMPLEMENTATION-PLAN T-W0-02).
#
#   tools/run-all-tests.sh                  — тесты всех игр, таблица в stdout
#   tools/run-all-tests.sh --bench          — плюс sim/bench: floe sim 100, rapids sim 300 6 и 300 12, lastq bench-cell
#   tools/run-all-tests.sh --out FILE       — таблица ещё и в FILE (markdown)
#   tools/run-all-tests.sh --logs DIR       — куда класть полные логи (по умолчанию: временный каталог)
#   tools/run-all-tests.sh quip fibs        — только перечисленные игры (имя «lib» — node --test lib/test-*.js + tools/testkit/mp-units.js)
#   tools/run-all-tests.sh --parallel       — игры параллельно (быстрее, но тайминговые тесты могут мигать)
#
# Код выхода: 0 — всё зелёное или красное только из списка известных (known_red ниже); 1 — новое красное;
# 2 — не нашли Node 22.
# Игры стартуют свои серверы сами на случайных портах (5000–5900); auction — на порту 4000–4899 (AUCTION_PORT).
# Скрипт ничего не убивает по шаблону: останавливает только процесс, который сам запустил.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GAMES_ALL="auction roulette bomb quip fibs wave floe lastq crowd rapids"
NODE22_DIR="${NODE22_DIR:-/opt/homebrew/Cellar/node@22/22.23.2_2/bin}"

BENCH=0; OUT=""; LOGS=""; PARALLEL=0; SEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bench) BENCH=1 ;;
    --out) OUT="$2"; shift ;;
    --logs) LOGS="$2"; shift ;;
    --parallel) PARALLEL=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) SEL="$SEL $1" ;;
  esac
  shift
done

# ---- Node 22 ----
if [ -x "$NODE22_DIR/node" ]; then export PATH="$NODE22_DIR:$PATH"; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "нужен Node >= 22 (найден: $(node -v 2>/dev/null || echo нет)); задайте NODE22_DIR" >&2
  exit 2
fi

[ -z "$SEL" ] && SEL="$GAMES_ALL lib"
[ -z "$LOGS" ] && LOGS="$(mktemp -d "${TMPDIR:-/tmp}/rh-tests.XXXXXX")"
mkdir -p "$LOGS"

# ---- известные красные (причина «уже красный до работ») ----
# формат: <игра>|<подстрока имени падающего теста / причина>
known_red() {
  case "$1" in
    lastq) echo "test-content: дубль space_nature-103 = science-109 (банк вопросов)" ;;
    *) echo "" ;;
  esac
}

now_s() { date +%s; }

# разбор счётчиков из лога: node --test (TAP: "# pass N") или самописные (строки "  ✓ " / "  ✗ ")
count_from_log() { # $1 лог → "pass fail"
  local log="$1" p f
  if grep -qE '^# pass [0-9]+' "$log"; then
    p="$(grep -E '^# pass [0-9]+' "$log" | awk '{s+=$3} END{print s+0}')"
    f="$(grep -E '^# fail [0-9]+' "$log" | awk '{s+=$3} END{print s+0}')"
  else
    p="$(grep -cE '^[[:space:]]*✓' "$log")"
    f="$(grep -cE '^[[:space:]]*✗' "$log")"
  fi
  # самописные раннеры и node --test могут идти в одном логе (auction) — суммируем «✓/✗» только если нет TAP
  echo "${p:-0} ${f:-0}"
}

run_step() { # $1 лог, $2 каталог, остальное — команда; возвращает код
  local log="$1" dir="$2"; shift 2
  ( cd "$dir" && "$@" ) >>"$log" 2>&1
  return $?
}

# ---- прогон одной игры → файл результата $LOGS/<game>.res: "<rc> <pass> <fail> <секунды>" ----
run_game() {
  local g="$1" log="$LOGS/$1.log" rc=0 t0 srv_pid="" port
  : >"$log"; t0="$(now_s)"
  case "$g" in
    lib)
      local files; files="$(ls "$ROOT"/lib/test-*.js 2>/dev/null)"
      if [ -z "$files" ]; then echo "- нет lib/test-*.js" >>"$log"; echo "skip 0 0 0" >"$LOGS/$g.res"; return; fi
      # глоб файлов, не каталог (Node >= 21 каталог не раскрывает)
      ( cd "$ROOT" && node --test lib/test-*.js ) >>"$log" 2>&1 || rc=$?
      # клиентский каркас mp-common.js (vm-тесты + проверка уровня ES2017, T-W1-04): строки «✓/✗»
      ( cd "$ROOT" && node tools/testkit/mp-units.js ) >>"$log" 2>&1 || rc=1 ;;
    auction)
      # у auction нет npm test: движок — node --test test-game.js; протокол — test-server.js против dev-сервера
      run_step "$log" "$ROOT/auction" node --test test-game.js || rc=1
      port="${AUCTION_PORT:-$((4000 + RANDOM % 900))}"
      ( cd "$ROOT/auction" && NODE_ENV=development PORT="$port" DUMP_FILE="$LOGS/auction-dump.json" exec node server.js ) >"$LOGS/auction-server.log" 2>&1 &
      srv_pid=$!
      local up=0 i
      for i in $(seq 1 60); do
        if curl -sf "http://127.0.0.1:$port/auction/api/health" >/dev/null 2>&1; then up=1; break; fi
        sleep 0.25
      done
      if [ "$up" = 1 ]; then
        run_step "$log" "$ROOT/auction" node test-server.js "http://127.0.0.1:$port" || rc=1
      else
        echo "✗ dev-сервер auction не поднялся на порту $port" >>"$log"; rc=1
      fi
      kill "$srv_pid" 2>/dev/null; wait "$srv_pid" 2>/dev/null ;;
    floe|rapids)
      run_step "$log" "$ROOT/$g" npm test || rc=$? ;;
    *)
      run_step "$log" "$ROOT/$g" npm test || rc=$? ;;
  esac
  local c p f; c="$(count_from_log "$log")"; p="${c% *}"; f="${c#* }"
  # auction: сумма TAP (test-game) и самописных ✓/✗ (test-server); lib: TAP lib/test-*.js + ✓/✗ mp-units
  if [ "$g" = auction ] || [ "$g" = lib ]; then
    local tp tf sp sf
    tp="$(grep -E '^# pass [0-9]+' "$log" | awk '{s+=$3} END{print s+0}')"
    tf="$(grep -E '^# fail [0-9]+' "$log" | awk '{s+=$3} END{print s+0}')"
    sp="$(grep -cE '^[[:space:]]*✓' "$log")"; sf="$(grep -cE '^[[:space:]]*✗' "$log")"
    p=$((tp + sp)); f=$((tf + sf))
  fi
  [ "$f" -gt 0 ] && rc=1
  echo "$rc $p $f $(( $(now_s) - t0 ))" >"$LOGS/$g.res"
}

# ---- sim / bench ----
run_bench() { # $1 метка, $2 каталог, остальное команда
  local label="$1" dir="$2"; shift 2
  local log="$LOGS/bench-$label.log" t0; t0="$(now_s)"
  ( cd "$ROOT/$dir" && "$@" ) >"$log" 2>&1
  echo "$? $(( $(now_s) - t0 ))" >"$LOGS/bench-$label.res"
}

for g in $SEL; do
  if [ "$PARALLEL" = 1 ]; then run_game "$g" & else run_game "$g"; fi
done
wait

if [ "$BENCH" = 1 ]; then
  run_bench floe-sim100 floe node sim.js 100
  run_bench rapids-sim300x6 rapids node sim.js 300 6
  run_bench rapids-sim300x12 rapids node sim.js 300 12
  run_bench lastq-bench-cell lastq node bench-cell.js
fi

# ---- таблица ----
REPORT="$LOGS/report.md"
{
  echo "Node $(node -v), $(date '+%Y-%m-%d %H:%M'), commit $(cd "$ROOT" && command git rev-parse --short HEAD 2>/dev/null || echo ?)"
  echo
  echo "| игра | зелёных | красных | с | статус | примечание |"
  echo "|---|---|---|---|---|---|"
} >"$REPORT"
NEW_RED=0
for g in $SEL; do
  [ -f "$LOGS/$g.res" ] || continue
  read -r rc p f s <"$LOGS/$g.res"
  if [ "$rc" = skip ]; then echo "| $g | – | – | – | пропуск | нет файлов тестов |" >>"$REPORT"; continue; fi
  k="$(known_red "$g")"
  if [ "$rc" = 0 ]; then st="OK"; note=""
  elif [ -n "$k" ]; then st="RED (известный)"; note="$k"
  else st="RED"; note="см. $LOGS/$g.log"; NEW_RED=1
  fi
  # сами имена упавших — в примечание (до 3)
  if [ "$rc" != 0 ]; then
    names="$(grep -E '^not ok|^[[:space:]]*✗' "$LOGS/$g.log" | head -3 | sed -E 's/^[[:space:]]*(not ok [0-9]+ - |✗ )//' | cut -c1-90 | paste -sd';' -)"
    [ -n "$names" ] && note="$note${note:+ | }падают: $names"
  fi
  echo "| $g | $p | $f | $s | $st | $note |" >>"$REPORT"
done
if [ "$BENCH" = 1 ]; then
  {
    echo
    echo "### sim / bench"
    for label in floe-sim100 rapids-sim300x6 rapids-sim300x12 lastq-bench-cell; do
      [ -f "$LOGS/bench-$label.res" ] || continue
      read -r rc s <"$LOGS/bench-$label.res"
      echo
      echo "#### $label (код $rc, ${s} с)"
      echo '```'
      cat "$LOGS/bench-$label.log"
      echo '```'
    done
  } >>"$REPORT"
fi

cat "$REPORT"
[ -n "$OUT" ] && cp "$REPORT" "$OUT"
echo
echo "логи: $LOGS"
exit "$NEW_RED"
