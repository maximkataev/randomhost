#!/usr/bin/env python3
"""Дымовой UI-тест «Айфилю»: headless Chrome (Playwright), доска + N телефонов (по умолчанию 4) проходят партию
настоящими нажатиями — выбор категории, сочинение (кнопки 🎲), расстановка тапами (с проверкой «тап по поставленной
снимает её и всё ниже»), вето, ответы угадывающего. Запуск:  python3 test-ui.py [N]   (LANG_UI=ru|en|el, BOARD=1600x900, NODE=путь)
Сам поднимает dev-сервер со статикой сайта (порт 4150–4199, UI_PORT) и гасит только его (по PID). Комната с ускорением ×SPEED (3).
Проверяет: нет JS-ошибок; телефоны и доска не прокручиваются вбок; партия доходит до итогов; очки доски и телефонов
совпадают; до раскрытия никто не получает порядок мишени; зала нет (зрители видят экран «смотри на доску» без кнопок);
угадывающий видит «Твой ход!»; вопрос на доске — с текстами карточек; раскрытие поясняет очки; свой порядок виден после
«Готово»; вето подтверждается; на итогах названы победители. SHOT=префикс — скриншоты новых экранов (лучше с SPEED=1)."""
import json, os, random, re, shutil, subprocess, sys, time, urllib.request

sys.path.insert(0, os.path.expanduser("~/.pyenv/versions/3.11.9/lib/python3.11/site-packages"))
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
N = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PHONES", 4))
LANG = os.environ.get("LANG_UI", "ru")
SPEED = float(os.environ.get("SPEED", 3))
BW, BH = [int(x) for x in os.environ.get("BOARD", "1600x900").split("x")]
PORT = int(os.environ.get("UI_PORT", 4150 + random.randint(0, 49)))
BASE = f"http://127.0.0.1:{PORT}"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
WIDTHS = [390, 360, 320, 390, 360, 390, 320, 390]
NODE = os.environ.get("NODE") or shutil.which("node") or "/opt/homebrew/Cellar/node@22/22.23.2_2/bin/node"
SECRET_KEYS = ["order", "orders"]
HALL_KEYS = ["hall", "hallCount", "shadow", "myAnswers"]  # зала больше нет (решение владельца 18.10) — и следов в снимках тоже
failures = 0


def check(ok, name):
    global failures
    print(("  ✓ " if ok else "  ✗ ") + name)
    if not ok:
        failures += 1


def main():
    tmp = os.environ.get("TMPDIR", "/tmp")
    env = {**os.environ, "PORT": str(PORT), "NODE_ENV": "development", "STATIC": "..", "ROUND_EXTRA_SEC": "0", "DUMP_FILE": os.path.join(tmp, f"ifeel-ui-{PORT}.json")}
    srv = subprocess.Popen([NODE, "server.js"], cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"{BASE}/ifeel/api/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        room = json.loads(urllib.request.urlopen(urllib.request.Request(f"{BASE}/ifeel/api/rooms", data=json.dumps({"settings": {"lang": LANG}, "speed": SPEED}).encode(), method="POST")).read())
        code, token = room["code"], room["hostToken"]
        print(f"комната {code}, телефонов {N}, язык {LANG}, доска {BW}x{BH}, ускорение ×{SPEED}")
        with sync_playwright() as pw:
            run(pw, code, token)
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=3)
        except Exception:
            srv.kill()
    print("\nОШИБОК: %d" % failures if failures else "\nвсё прошло")
    sys.exit(1 if failures else 0)


def mk_page(browser, w, h, mobile, init, errs, tag):
    ctx = browser.new_context(user_agent=UA if mobile else None, viewport={"width": w, "height": h}, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    ctx.add_init_script(init + WATCH_JS)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errs.append(f"{tag}: {e}"))
    page.on("console", lambda m: errs.append(f"{tag}: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text and "fonts" not in m.text.lower() and "metrika" not in m.text.lower() else None)
    return ctx, page


# рекурсивный поиск секретных ключей в снимке (в браузере)
LEAK_JS = """([secret, hall]) => { const s = %s; if (!s) return null;
  const walk = (o, p, keys) => { if (!o || typeof o !== 'object') return null; for (const k of Object.keys(o)) { if (keys.includes(k)) return p + '.' + k; const r = walk(o[k], p + '.' + k, keys); if (r) return r; } return null; };
  return walk(s, s.phase, hall) || (s.phase === 'reveal' || s.phase === 'finished' ? null : walk(s, s.phase, secret)); }"""
# короткие фазы (заставка хода — 1 с при ×3) цикл стенда может проскочить: страницы сами отмечают, что видели
WATCH_JS = """(() => { const mark = () => { try {
  const s = (window.wvBoard && wvBoard.state) || (window.wvPhone && wvPhone.state);
  if (s) (window.__ph = window.__ph || {})[s.phase] = 1;
  if (document.querySelector('.yourturn h1')) window.__yt = (window.__yt || 0) + 1;
} catch (e) {} }; setInterval(mark, 40); })();"""

CLICK = "(sel) => { const b = document.querySelector(sel); if (b && !b.disabled) { b.click(); return true; } return false; }"


def shot(page, name):
    pref = os.environ.get("SHOT")
    if pref and name not in SHOTS:
        SHOTS.add(name)
        page.screenshot(path=f"{pref}-{name}.png")


SHOTS = set()


def phone_step(p, i, done, stats):
    s = p.evaluate("wvPhone.state && {phase: wvPhone.state.phase, me: wvPhone.state.me, turn: wvPhone.state.turn, round: wvPhone.state.round && {n: wvPhone.state.round.n, ti: wvPhone.state.round.ti}, game: wvPhone.state.game}")
    if not s or not s.get("me"):
        return
    ph, me = s["phase"], s["me"]
    rk = (i, s["game"], (s["round"] or {}).get("n"), (s["round"] or {}).get("ti"))  # у каждого телефона свои отметки
    if ph == "pick" and me.get("offers") and ("pick",) + rk not in done:
        if p.evaluate(CLICK, ".offer"):
            done.add(("pick",) + rk)
    elif ph == "write" and me.get("write") and not me["write"].get("cards") and ("write",) + rk not in done:
        # три карточки 🎲, одна своя — остальное добьёт сервер
        for k in range(3):
            p.evaluate(CLICK, f'[data-d="{k}"]')
        p.fill("#w3", f"Своя карточка {i}")
        if p.evaluate(CLICK, "#send"):
            done.add(("write",) + rk)
    elif ph == "rank" and me.get("set") and not me.get("ranked") and ("rank",) + rk not in done:
        # вето — первый телефон во втором раунде
        if i == 0 and me.get("veto") and not me["veto"].get("used") and ("veto",) + rk not in done:
            p.evaluate(CLICK, "#veto")
            p.wait_for_timeout(100)
            p.evaluate(CLICK, '[data-p="1"]')
            done.add(("veto",) + rk)
            p.wait_for_timeout(500)
            # подтверждение замены: тост и отметка «новая» на заменённой карточке
            try:
                p.wait_for_function("document.querySelector('.pick.fresh .newtag')", timeout=4000)
                stats["veto_mark"] = True
            except Exception:
                stats["veto_mark"] = False
            stats["veto_toast"] = p.evaluate("document.getElementById('toast').textContent")
            return
        for _ in range(4):
            p.evaluate(CLICK, ".pool [data-p]")
            p.wait_for_timeout(30)
        # тап по второму месту снимает его и всё ниже: остаётся одна
        if ("untap",) + rk not in done:
            p.evaluate(CLICK, '[data-s="1"]')
            p.wait_for_timeout(30)
            placed = p.evaluate("document.querySelectorAll('.slot:not(.empty)').length")
            stats["untap"].append(placed == 1)
            done.add(("untap",) + rk)
        for _ in range(5):
            p.evaluate(CLICK, ".pool [data-p]")
            p.wait_for_timeout(30)
        if p.evaluate(CLICK, "#done"):
            done.add(("rank",) + rk)
            # свой порядок — из памяти телефона, после «Готово»
            # (последний «Готово» сразу закрывает фазу — тогда экрана «Готово!» нет, его проверит ход мишени)
            try:
                p.wait_for_function("document.querySelectorAll('.myorder li').length === 5 || wvPhone.state.phase !== 'rank'", timeout=4000)
                if p.evaluate("wvPhone.state.phase === 'rank'"):
                    stats["myorder"].append(True)
                    if i == 1:
                        shot(p, "phone-myorder")
            except Exception:
                stats["myorder"].append(False)
    elif ph == "tintro" and me.get("role") == "guesser":
        if p.evaluate("!!document.querySelector('.yourturn h1')"):
            shot(p, "phone-yourturn")
    elif ph == "ask" and me.get("role") in ("watch", "target") and s.get("turn"):
        if me["role"] == "target":
            stats["myorder_t"].append(p.evaluate("document.querySelectorAll('.myorder li').length === 5"))
        if me["role"] == "watch":
            ok = p.evaluate("!!document.querySelector('.watchcard') && !document.querySelector('[data-v],[data-p],#ans')")
            stats["watch"].append(ok)
            if ok:
                shot(p, "phone-watch")
    elif ph == "ask" and me.get("role") == "guesser" and s.get("turn"):
        qi = s["turn"]["qi"]
        tag = ("ask", qi) + rk
        if tag in done or (me.get("answered") or [False] * 3)[qi]:
            return
        q = s["turn"]["qs"][qi]
        if q["kind"] == "triple":
            for _ in range(3):
                p.evaluate(CLICK, ".pool [data-p]")
                p.wait_for_timeout(30)
            ok = p.evaluate(CLICK, "#ans")
        else:
            btns = p.evaluate("document.querySelectorAll('[data-v]').length")
            if btns and q["kind"] == "pair":
                shot(p, "phone-ask-pair")
            ok = btns > 0 and p.evaluate("(k) => { const b = document.querySelectorAll('[data-v]')[k]; if (b && !b.disabled) { b.click(); return true; } return false; }", random.randrange(btns))
        if ok:
            done.add(tag)
            stats["answers"] += 1
        elif os.environ.get("DEBUG"):
            print("   нет кнопки", i, qi, q["kind"], p.evaluate("document.getElementById('app').innerText.slice(0,200)").replace("\n", " | "))


def run(pw, code, token):
    browser = pw.chromium.launch()
    errs = []
    lang_script = f"try{{localStorage.setItem('site-lang','{LANG}')}}catch(e){{}}"
    bctx, board = mk_page(browser, BW, BH, False, lang_script + f"try{{localStorage.setItem('ifeel-host-{code}','{token}')}}catch(e){{}}", errs, "board")
    board.goto(f"{BASE}/ifeel-board.html?r={code}", wait_until="domcontentloaded")
    board.wait_for_function("window.wvBoard && wvBoard.state")
    board.wait_for_selector("#start", timeout=10000)
    phones = []
    for i in range(N):
        ctx, p = mk_page(browser, WIDTHS[i % len(WIDTHS)], 740 if i else 568, True, lang_script, errs, f"phone{i}")
        p.goto(f"{BASE}/ifeel.html?r={code}", wait_until="domcontentloaded")
        p.wait_for_selector("#name")
        p.fill("#name", f"Игрок{i + 1}" if i else "Очень длинное имя игрока")
        p.evaluate("document.getElementById('enterform').requestSubmit()")
        p.wait_for_function("window.wvPhone && wvPhone.me && wvPhone.state && wvPhone.state.me", timeout=10000)
        phones.append(p)
    board.wait_for_function(f"wvBoard.state.players.length === {N}")
    check(True, f"{N} телефонов вошли в комнату")
    long_name = phones[0].evaluate("wvPhone.state.players.find(x => x.id === wvPhone.me).name")
    check(len(long_name) <= 15, f"имя обрезано до 15 знаков: «{long_name}»")
    # режим edgy с доски
    board.evaluate("document.querySelector('.opt[data-v=\"edgy\"]').click()")
    board.wait_for_function("wvBoard.state.settings.mode === 'edgy'", timeout=5000)
    check(True, "ведущий включил edgy кнопкой на доске")
    board.wait_for_function("/EDGY/.test((document.querySelector('.calib .mode') || {}).textContent || '')", timeout=5000)
    calib = board.evaluate("!!document.querySelector('.calib .cl')")
    shot(board, "board-lobby")
    board.evaluate(CLICK, "#start")
    deadline = time.time() + 300
    seen, leaks, overflow_bad = set(), [], []
    done, stats = set(), {"untap": [], "answers": 0, "myorder": [], "yourturn": 0, "watch": [], "qtext": [], "explain": [], "myorder_t": []}
    reveal_cards = 0
    shots = set()
    while time.time() < deadline:
        st = board.evaluate("wvBoard.state && {phase: wvBoard.state.phase}")
        ph = st["phase"]
        if os.environ.get("DEBUG") and ph not in seen | {"ask"}:
            print("   фаза", ph, board.evaluate("JSON.stringify(wvBoard.state.round && {done: wvBoard.state.round.done, tt: wvBoard.state.round.turnsTotal})"))
        if os.environ.get("DEBUG") and ph == "tintro":
            print("   ход", board.evaluate("JSON.stringify(wvBoard.state.round.ti)"), board.evaluate("JSON.stringify(wvBoard.state.turn && wvBoard.state.turn.guessers)"))
        seen.add(ph)
        for v, pg in [("board", board)] + [(f"phone{i}", p) for i, p in enumerate(phones)]:
            leak = pg.evaluate(LEAK_JS % ("wvBoard.state" if v == "board" else "wvPhone.state"), [SECRET_KEYS, HALL_KEYS])
            if leak:
                leaks.append((v, leak))
        if ph == "ask":
            # вопрос на доске — с текстами карточек (пара) или с чипом места
            q = board.evaluate("(() => { const t = wvBoard.state.turn; const q = t && t.qs[t.qi]; return q && {kind: q.kind, qc: document.querySelectorAll('.qbig .qc').length, qp: document.querySelectorAll('.qbig .qplace').length, txt: document.querySelector('.qbig') && document.querySelector('.qbig').textContent}; })()")
            if q:
                good = (q["kind"] == "pair" and q["qc"] == 2) or (q["kind"] == "place" and q["qp"] == 1) or q["kind"] == "triple"
                stats["qtext"].append(good)
                if q["kind"] in ("pair", "place"):
                    shot(board, f"board-ask-{q['kind']}")
        for i, p in enumerate(phones):
            try:
                phone_step(p, i, done, stats)
            except Exception as e:
                print("   (шаг телефона", i, "—", str(e)[:120], ")")
            o = p.evaluate("({sw: document.documentElement.scrollWidth, iw: innerWidth})")
            if o["sw"] > o["iw"] + 1:
                overflow_bad.append((i, ph, o))
        ob = board.evaluate("({sw: document.documentElement.scrollWidth, iw: innerWidth})")
        if ob["sw"] > ob["iw"] + 1:
            overflow_bad.append(("board", ph, ob))
        if ph == "reveal":
            board.wait_for_timeout(200)
            reveal_cards = max(reveal_cards, board.evaluate("document.querySelectorAll('.rv .icard').length"))
            # пояснение очков у каждого вопроса (видно после прогрева кадра)
            # пояснение очков у каждого вопроса: текст есть сразу, проявляется после прогрева кадра (при ×3 раскрытие короче прогрева)
            ex = board.evaluate("[...document.querySelectorAll('.qrow .hl b')].map(x => x.textContent)")
            if ex:
                stats["explain"].append(len(ex) == 3 and all(re.search(r"\+\d+", x) for x in ex))
            if os.environ.get("SHOT") and "board-reveal" not in SHOTS and any(re.search(r"\+(100|200)", x) for x in ex):
                try:
                    board.wait_for_function("document.querySelectorAll('.qrow .hl.on b').length === 3 && document.querySelector('.total.on')", timeout=9000)
                    board.wait_for_timeout(400)
                    shot(board, "board-reveal")
                    for pg in phones:
                        if pg.evaluate("!!document.querySelector('.qres em')"):
                            shot(pg, "phone-reveal")
                            break
                except Exception:
                    pass
        if ph == "finished":
            break
        time.sleep(0.15)

    seen |= set(board.evaluate("Object.keys(window.__ph || {})"))
    yourturn = sum(p.evaluate("window.__yt || 0") > 0 for p in phones)
    check("finished" in seen, "партия дошла до итогов")
    # выбор и сочинение досрочно закрываются за один проход цикла — их видно по нажатиям телефонов, а не по доске
    picked = {k[1] for k in done if k[0] == "pick"}
    wrote = {k[1] for k in done if k[0] == "write"}
    check(len(picked) == N and len(wrote) == N, f"все выбрали категорию ({len(picked)}) и написали карточки ({len(wrote)})")
    check(any(k[0] == "veto" for k in done), "вето нажато во втором раунде")
    check({"rank", "tintro", "ask", "reveal", "scores"} <= seen, "прошли расстановку, ход, раскрытие и счёт")
    check(not leaks, "до раскрытия ни доска, ни телефоны не получали порядок мишени; следов зала нет" + (f" {leaks[:3]}" if leaks else ""))
    check(stats["untap"] and all(stats["untap"]), "тап по поставленной карточке снимает её и все ниже")
    check(stats["answers"] > 0, f"ответов с телефонов: {stats['answers']}")
    check(calib, "доска перед стартом показывает режим и язык карточек крупно")
    check(yourturn == N, f"«Твой ход!» видели все угадывающие ({yourturn} из {N})")
    check(stats["watch"] and all(stats["watch"]), f"зрители видят «смотри на доску» без кнопок ({len(stats['watch'])})")
    check(stats["qtext"] and all(stats["qtext"]), "вопрос на доске — с текстами карточек и выделенным местом")
    check(stats["explain"] and all(stats["explain"]), f"раскрытие поясняет очки каждого вопроса ({len(stats['explain'])})")
    check(stats["myorder"] and all(stats["myorder"]) and stats["myorder_t"] and all(stats["myorder_t"]), f"после «Готово» и в свой ход мишень видит свой порядок ({len(stats['myorder'])}/{len(stats['myorder_t'])})")
    check(stats.get("veto_mark") and stats.get("veto_toast"), f"вето подтверждено: отметка «новая» и тост «{stats.get('veto_toast')}»")
    check(reveal_cards == 5, "доска раскрывает порядок из 5 карточек")
    check(not overflow_bad, "ни телефоны, ни доска не прокручиваются вбок" + (f" {overflow_bad[:3]}" if overflow_bad else ""))
    bs = board.evaluate("wvBoard.state.players.map(p=>[p.id,p.score])")
    ok = all(p.evaluate("(()=>{const s=wvPhone.state; const m=s.players.find(x=>x.id===wvPhone.me); return [m.id,m.score]})()") in bs for p in phones)
    check(ok, "очки на телефонах совпадают с доской")
    check(sum(x[1] for x in bs) > 0, "очки начислены")
    check(all(p.evaluate("wvPhone.state.phase") == "finished" for p in phones), "все телефоны показывают итоги")
    check(board.evaluate("!!document.querySelector('.loud h2')"), "на итоговой доске есть блок «громких раскрытий»")
    check(board.evaluate("!!document.querySelector('.winplate')") and all(p.evaluate("!!document.querySelector('.winline')") for p in phones), "на итогах названы победители (доска и телефоны)")
    check(board.evaluate("wvBoard.state.settings.mode === 'edgy' && /EDGY/.test(document.getElementById('modechip').textContent)"), "доска показывает плашку 🌶️ EDGY")
    shot(board, "board-final")
    shot(phones[1], "phone-final")
    check(not errs, "нет JS-ошибок на страницах" + (": " + "; ".join(errs[:3]) if errs else ""))
    browser.close()


if __name__ == "__main__":
    main()
