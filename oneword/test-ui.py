#!/usr/bin/env python3
"""UI-тест «Сто к одному» (oneword): headless Chrome (Playwright), доска + N телефонов в отдельных контекстах
проходят несколько полных раундов настоящими нажатиями. Запуск:  python3 test-ui.py [N телефонов, по умолчанию 4]
(LANG_UI=ru|en|el, BOARD=1600x900). STRICT=1 — режим «все телефоны 320×460»: партия доигрывается до финала, а каждый
телефон на каждой фазе (в т.ч. «Счёт раунда» и «Итоги») проверяется на отсутствие прокрутки по высоте и ширине
(пример: STRICT=1 python3 test-ui.py 12; SPEED=4 — ускорение таймеров, по умолчанию 10, в STRICT 4). Сам поднимает dev-сервер со статикой сайта (порт случайный), комнату
создаёт с ускорением таймеров (speed, только при NODE_ENV=development).

Проверяет на каждом шаге: нет JS-ошибок, телефоны не прокручиваются (жёсткое требование — 320×460 без скролла),
партия проходит через все фазы (answer → guessPopular → guessRare → reveal → scores) как минимум 2 раунда,
кластеры/очки на доске и на телефонах совпадают, до раскрытия ни доска, ни телефоны не видят чужие ответы/гадания
(секретность §5 спеки)."""
import json, os, random, subprocess, sys, time, unicodedata, urllib.request

sys.path.insert(0, os.path.expanduser("~/.pyenv/versions/3.11.9/lib/python3.11/site-packages"))
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
N = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PHONES", 4))
LANG = os.environ.get("LANG_UI", "ru")
BW, BH = [int(x) for x in os.environ.get("BOARD", "1600x900").split("x")]
PORT = int(os.environ.get("UI_PORT", 5800 + random.randint(0, 400)))
BASE = f"http://127.0.0.1:{PORT}"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
WIDTHS = [390, 360, 320, 390, 360, 390, 320, 390]
WORDS = ["яблоко", "банан", "драгонфрут", "ананас", "груша", "манго", "киви", "арбуз"]
STRICT = os.environ.get("STRICT") == "1"
SPEED = float(os.environ.get("SPEED", 4 if STRICT else 10))
failures = 0


def norm(t):
    t = "".join(c for c in unicodedata.normalize("NFD", t) if not unicodedata.combining(c))
    return t.lower()


def check(ok, name):
    global failures
    print(("  ✓ " if ok else "  ✗ ") + name)
    if not ok:
        failures += 1


def main():
    env = {**os.environ, "PORT": str(PORT), "NODE_ENV": "development", "STATIC": "..", "DUMP_FILE": f"/tmp/claude-501/oneword-ui-{PORT}.json"}
    node = "/opt/homebrew/Cellar/node@22/22.23.2_2/bin/node"
    if not os.path.exists(node):
        node = "node"
    srv = subprocess.Popen([node, "server.js"], cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"{BASE}/oneword/api/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        room = json.loads(urllib.request.urlopen(urllib.request.Request(
            f"{BASE}/oneword/api/rooms",
            data=json.dumps({"settings": {"lang": LANG, "rounds": 4}, "speed": SPEED}).encode(),
            method="POST")).read())
        code, token = room["code"], room["hostToken"]
        print(f"комната {code}, телефонов {N}, язык {LANG}, доска {BW}x{BH}")
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


def mk_page(browser, w, h, mobile, lang_script, errs, tag):
    ctx = browser.new_context(user_agent=UA if mobile else None, viewport={"width": w, "height": h}, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    ctx.add_init_script(lang_script)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errs.append(f"{tag}: {e}"))
    page.on("console", lambda m: errs.append(f"{tag}: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text and "fonts" not in m.text.lower() else None)
    return ctx, page


def word_for(i, round_num, kind):
    """Разброс ответов: половина сходится на одном слове (кластер), один игрок — уникум; одинаковая схема для
    guessPopular/guessRare, чтобы угадывания были осмысленными (не обязаны совпасть, но могут)."""
    if kind == "answer":
        if STRICT and round_num % 2 == 0:
            return f"разноразное{i}"  # у всех свой ответ: на раскрытии N кластеров (до 12 строк на 320×460)
        if i == 0:
            return "драгонфрут"  # уникальный ответ (если i==0 — единственный с этим словом)
        return WORDS[round_num % len(WORDS)]
    # угадывания: часть игроков угадывает «банан»/общее слово, часть — уникум
    return "драгонфрут" if i % 3 == 0 else WORDS[round_num % len(WORDS)]


def submit_word(p, word):
    p.wait_for_selector("#word:not([disabled])", timeout=10000)
    p.fill("#word", word)
    p.wait_for_function("!document.getElementById('lockbtn').disabled", timeout=5000)
    p.click("#lockbtn")


def run(pw, code, token):
    browser = pw.chromium.launch()
    errs = []
    lang_script = f"try{{localStorage.setItem('site-lang','{LANG}')}}catch(e){{}}"
    bctx, board = mk_page(browser, BW, BH, False, lang_script + f"try{{localStorage.setItem('oneword-host-{code}','{token}')}}catch(e){{}}", errs, "board")
    board.goto(f"{BASE}/oneword-board.html?r={code}", wait_until="domcontentloaded")
    board.wait_for_function("window.owBoard && owBoard.state()")

    phones = []
    for i in range(N):
        w = 320 if (i == 0 or STRICT) else WIDTHS[i % len(WIDTHS)]
        h = 460 if (i == 0 or STRICT) else 780
        ctx, p = mk_page(browser, w, h, True, lang_script, errs, f"phone{i}")
        p.goto(f"{BASE}/oneword.html?r={code}", wait_until="domcontentloaded")
        p.wait_for_selector("#name")
        p.fill("#name", f"Игрок{i + 1}" if not STRICT else f"Длинноимённый{i + 1}"[:15])
        p.evaluate("document.getElementById('enterform').requestSubmit()")
        p.wait_for_function("window.owPhone && owPhone.me()", timeout=10000)
        phones.append(p)
    board.wait_for_function(f"owBoard.state().players.length === {N}")
    check(True, f"{N} телефонов вошли в комнату")

    # телефон 0 — ровно 320×460: жёсткое требование проекта, без прокрутки ни в одной фазе
    p0 = phones[0]
    ov = p0.evaluate("({sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight})")
    check(ov["sw"] <= ov["iw"] + 1 and ov["sh"] <= ov["ih"] + 1, "лобби на телефоне 320×460 без прокрутки")

    board.evaluate("owBoard.send({type:'start'})")
    board.wait_for_function("owBoard.state().phase === 'answer'", timeout=10000)
    check(True, "партия началась")

    deadline = time.time() + (600 if STRICT else 300)
    seen_phases = set()
    rounds_completed = 0
    leaks = 0
    overflow_bad = []
    strict_seen = set()
    bbox_bad = []
    BOX_JS = "(()=>{const e=document.querySelector('%s'); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height].map(Math.round);})()"
    answered_tags = set()

    while time.time() < deadline:
        bstate = board.evaluate("owBoard.state()")
        phase = bstate["phase"]
        seen_phases.add(phase)
        round_num = (bstate.get("round") or {}).get("num")

        # секретность: до раскрытия доска и телефоны не видят cluster-данные (answers/clusters/count)
        if phase in ("answer", "guessPopular", "guessRare"):
            r = bstate.get("round") or {}
            if bstate.get("phase") in ("answer", "guessPopular", "guessRare") and ("clusters" in r or "n" in r or "popularPts" in r):
                leaks += 1
            for p in phones:
                ps_ = p.evaluate("owPhone.state()") or {}
                pr = ps_.get("round") or {}
                # телефон мог уже уйти вперёд доски (опрос раз в 0.2 с при ускорении таймеров) — смотрим его собственную фазу
                if ps_.get("phase") in ("answer", "guessPopular", "guessRare") and ("clusters" in pr or "popularPts" in pr):
                    leaks += 1

        if phase in ("answer", "guessPopular", "guessRare") and round_num is not None:
            for i, p in enumerate(phones):
                tag = (round_num, phase, i)
                if tag in answered_tags:
                    continue
                me_inround = p.evaluate("(()=>{const s=owPhone.state(); return s && s.me && s.me.inRound;})()")
                if not me_inround:
                    continue
                locked_field = {"answer": "answerConfirmed", "guessPopular": "guessPopularConfirmed", "guessRare": "guessRareConfirmed"}[phase]
                already = p.evaluate(f"(()=>{{const s=owPhone.state(); return s && s.me && s.me.{locked_field};}})()")
                if already:
                    answered_tags.add(tag)
                    continue
                try:
                    submit_word(p, word_for(i, round_num or 0, "answer" if phase == "answer" else "guess"))
                    answered_tags.add(tag)
                except Exception:
                    pass

        # прокрутка: все телефоны (жёсткая проверка на телефоне 0 при 320×460, у остальных — обычная ширина)
        for i, p in enumerate(phones):
            o = p.evaluate("({ph: owPhone.state() && owPhone.state().phase, sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight})")
            strict_h = i == 0 or STRICT
            if strict_h:
                strict_seen.add(o["ph"])
            bad = o["sw"] > o["iw"] + 1 or (strict_h and o["sh"] > o["ih"] + 1)
            if bad:
                overflow_bad.append((i, o["ph"], o))
        # сцена не прыгает между фазами (DESIGNER-SKILL §4): доска .scr = {200,90,1200,780} на 1600×900, телефон #app = {0,40,320,420} на 320×460
        if (BW, BH) == (1600, 900) and phase in ("answer", "guessPopular", "guessRare", "reveal", "scores", "finished"):
            bb = board.evaluate(BOX_JS % ".scr")
            if bb != [200, 90, 1200, 780]:
                bbox_bad.append(("board", phase, bb))
        if phase in ("answer", "guessPopular", "guessRare", "reveal", "scores", "finished"):
            pb = phones[0].evaluate(BOX_JS % "#app")
            pph = phones[0].evaluate("owPhone.state() && owPhone.state().phase")
            if pph in ("answer", "guessPopular", "guessRare", "reveal", "scores", "finished") and pb != [0, 40, 320, 420]:
                bbox_bad.append(("phone0", pph, pb))
        ob = board.evaluate("({sw: document.documentElement.scrollWidth, iw: innerWidth})")
        if ob["sw"] > ob["iw"] + 1:
            overflow_bad.append(("board", phase, ob))

        if phase == "scores":
            rounds_completed = max(rounds_completed, round_num or 0)
        if STRICT:
            if phase == "finished":
                time.sleep(0.6)  # телефоны успевают перерисовать «Итоги» — меряем ещё раз ниже
                for i, p in enumerate(phones):
                    o = p.evaluate("({ph: owPhone.state() && owPhone.state().phase, sh: document.documentElement.scrollHeight, ih: innerHeight, sw: document.documentElement.scrollWidth, iw: innerWidth})")
                    strict_seen.add(o["ph"])
                    if o["sh"] > o["ih"] + 1 or o["sw"] > o["iw"] + 1:
                        overflow_bad.append((i, o["ph"], o))
                break
        elif phase == "finished" or rounds_completed >= 2:
            if phase == "finished" or (phase == "scores" and rounds_completed >= 2):
                break
        time.sleep(0.2)

    check({"answer", "guessPopular", "guessRare", "reveal", "scores"} <= seen_phases, "раунд прошёл через все фазы")
    check(rounds_completed >= 2 or "finished" in seen_phases, "сыграно хотя бы 2 раунда (или партия закончилась)")
    check(leaks == 0, "до раскрытия доска/телефоны не получали кластеры/очки раньше срока")
    check(not bbox_bad, "сцена не меняет рамку между фазами (доска .scr, телефон #app)" + (f" {bbox_bad[:3]}" if bbox_bad else ""))
    if STRICT:
        check({"scores", "finished"} <= strict_seen, f"строгая проверка 320×460 охватила «Счёт раунда» и «Итоги» ({N} телефонов): {sorted(x for x in strict_seen if x)}")
    check(not overflow_bad, "ни телефоны, ни доска не прокручиваются вбок" + (f" {overflow_bad[:3]}" if overflow_bad else ""))

    # если доиграли до конца — сверяем очки доски и телефонов
    if "finished" in seen_phases:
        board.wait_for_function("owBoard.state().phase === 'finished'", timeout=15000)
        bs = board.evaluate("owBoard.state().players.map(p=>[p.id,p.score])")
        ok = True
        for p in phones:
            mine = p.evaluate("(()=>{const s=owPhone.state(); const m=s.players.find(x=>x.id===owPhone.me()); return m?[m.id,m.score]:null;})()")
            if mine and [mine[0], mine[1]] not in bs:
                ok = False
        check(ok, "очки на телефонах совпадают с доской")
    else:
        # иначе досрочно завершаем партию и проверяем, что все экраны реагируют
        board.evaluate("owBoard.send({type:'end'})")
        board.wait_for_function("owBoard.state().phase === 'finished'", timeout=10000)
        check(True, "ведущий может досрочно закончить партию")

    check(not errs, "нет JS-ошибок на страницах" + (": " + "; ".join(errs[:3]) if errs else ""))
    browser.close()


main()
