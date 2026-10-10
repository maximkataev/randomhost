#!/usr/bin/env python3
"""UI-тест «Как все»: headless Chrome (Playwright), доска + N телефонов в отдельных контекстах проходят короткую партию
настоящими нажатиями. Запуск:  python3 test-ui.py [N телефонов, по умолчанию 4]   (LANG_UI=ru|en|el, BOARD=1600x900)
Сам поднимает dev-сервер со статикой сайта (порт случайный), комнату создаёт с ускорением ×3.
Проверяет на каждом шаге: нет JS-ошибок, телефоны и доска не прокручиваются вбок, партия доходит до итогов,
очки на доске и на телефонах совпадают, в фазе голосования доска не получает чужих голосов."""
import json, os, random, subprocess, sys, time, urllib.request

sys.path.insert(0, os.path.expanduser("~/.pyenv/versions/3.11.9/lib/python3.11/site-packages"))
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
N = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PHONES", 4))
LANG = os.environ.get("LANG_UI", "ru")
BW, BH = [int(x) for x in os.environ.get("BOARD", "1600x900").split("x")]
PORT = 5400 + random.randint(0, 400)
BASE = f"http://127.0.0.1:{PORT}"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
WIDTHS = [390, 360, 320, 390, 360, 390, 320, 390]
failures = 0


def check(ok, name):
    global failures
    print(("  ✓ " if ok else "  ✗ ") + name)
    if not ok:
        failures += 1


def main():
    env = {**os.environ, "PORT": str(PORT), "NODE_ENV": "development", "STATIC": "..", "DUMP_FILE": f"/tmp/claude-501/crowd-ui-{PORT}.json", "STATS_FILE": f"/tmp/claude-501/crowd-ui-stats-{PORT}.json"}
    node = "/opt/homebrew/Cellar/node@22/22.23.2_2/bin/node"
    srv = subprocess.Popen([node, "server.js"], cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"{BASE}/crowd/api/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        room = json.loads(urllib.request.urlopen(urllib.request.Request(f"{BASE}/crowd/api/rooms", data=json.dumps({"settings": {"lang": LANG, "short": True, "opinion": True}, "speed": 3}).encode(), method="POST")).read())
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


def run(pw, code, token):
    browser = pw.chromium.launch()
    errs = []
    lang_script = f"try{{localStorage.setItem('site-lang','{LANG}')}}catch(e){{}}"
    bctx, board = mk_page(browser, BW, BH, False, lang_script + f"try{{localStorage.setItem('crowd-host-{code}','{token}')}}catch(e){{}}", errs, "board")
    board.goto(f"{BASE}/crowd-board.html?r={code}")
    board.wait_for_function("window.wvBoard && wvBoard.state")
    phones = []
    for i in range(N):
        ctx, p = mk_page(browser, WIDTHS[i % len(WIDTHS)], 780 if i else 460, True, lang_script, errs, f"phone{i}")
        p.goto(f"{BASE}/crowd.html?r={code}")
        p.wait_for_selector("#name")
        p.fill("#name", f"Игрок{i + 1}")
        p.evaluate("document.getElementById('enterform').requestSubmit()")
        p.wait_for_function("window.wvPhone && wvPhone.me", timeout=10000)
        phones.append(p)
    board.wait_for_function(f"wvBoard.state.players.length === {N}")
    check(True, f"{N} телефонов вошли в комнату")

    board.evaluate("wvBoard.send({type:'settings',settings:{short:true,opinion:true}})")
    board.evaluate("wvBoard.send({type:'start'})")
    deadline = time.time() + 420
    seen = set()
    leaks = 0
    overflow_bad = []
    done_for = {}
    opin_for = {}
    while time.time() < deadline:
        st = board.evaluate("wvBoard.state && {phase: wvBoard.state.phase, game: wvBoard.state.game, n: wvBoard.state.n, round: wvBoard.state.round && {ready: wvBoard.state.round.ready, result: wvBoard.state.round.result ? 1 : 0}}")
        ph = st["phase"]
        seen.add(ph)
        if ph == "vote" and st["round"]["result"]:
            leaks += 1
        key = (st["n"], ph, (st["round"] or {}).get("ready") and 1)
        if ph == "vote":
            for i, p in enumerate(phones):
                tag = (st["game"], st["n"], i)
                if tag in done_for:
                    continue
                s = p.evaluate("wvPhone.state && wvPhone.state.me && wvPhone.state.me.inRound")
                if not s:
                    continue
                side = random.choice(["a", "b"])
                try:
                    p.evaluate("(s)=>{const b=document.querySelector('.side[data-s=\"'+s+'\"]'); if(b) b.click();}", side)
                    # ва-банк, если есть кнопка и осталось
                    if i == 0:
                        p.evaluate("()=>{const b=document.getElementById('bank'); if(b && !b.disabled) b.click();}")
                    p.evaluate("()=>{const d=document.getElementById('done'); if(d && !d.disabled) d.click();}")
                    done_for[tag] = 1
                except Exception:
                    pass
        elif ph == "opinion":
            for i, p in enumerate(phones):
                tag = (st["game"], st["n"], i)
                if tag in opin_for:
                    continue
                asked = p.evaluate("wvPhone.state && wvPhone.state.me && wvPhone.state.me.asked")
                if asked:
                    p.wait_for_timeout(450)
                    p.evaluate("(s)=>{const b=document.querySelector('.side[data-s=\"'+s+'\"]'); if(b) b.click();}", random.choice(["a", "b"]))
                    opin_for[tag] = 1
        # прокрутки вбок
        for i, p in enumerate(phones):
            o = p.evaluate("({sw: document.documentElement.scrollWidth, iw: innerWidth})")
            if o["sw"] > o["iw"] + 1:
                overflow_bad.append((i, ph, o))
        ob = board.evaluate("({sw: document.documentElement.scrollWidth, iw: innerWidth})")
        if ob["sw"] > ob["iw"] + 1:
            overflow_bad.append(("board", ph, ob))
        if ph == "finished":
            break
        time.sleep(0.25)

    check("finished" in seen, "партия дошла до итогов")
    check({"vote", "reveal", "scores"} <= seen, "прошли голосование, раскрытие и счёт")
    if N >= 4:
        check("opinion" in seen, "была фаза «Мнение»")
    else:
        check("opinion" not in seen, "при трёх игроках «Мнение» не спрашивается")
    check(leaks == 0, "доска в голосовании не получала результата раньше срока")
    check(not overflow_bad, "ни телефоны, ни доска не прокручиваются вбок" + (f" {overflow_bad[:3]}" if overflow_bad else ""))
    # очки доски и телефонов совпадают
    bs = board.evaluate("wvBoard.state.players.map(p=>[p.id,p.score])")
    ok = True
    for p in phones:
        mine = p.evaluate("(()=>{const s=wvPhone.state; const m=s.players.find(x=>x.id===wvPhone.me); return [m.id,m.score]})()")
        if [mine[0], mine[1]] not in bs:
            ok = False
    check(ok, "очки на телефонах совпадают с доской")
    ph = [p.evaluate("wvPhone.state.phase") for p in phones]
    check(all(x == "finished" for x in ph), "все телефоны показывают итоги")
    check(not errs, "нет JS-ошибок на страницах" + (": " + "; ".join(errs[:3]) if errs else ""))
    browser.close()


main()
