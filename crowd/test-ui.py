#!/usr/bin/env python3
"""UI-тест «Как все»: headless Chrome (Playwright), доска + N телефонов в отдельных контекстах проходят короткую партию
настоящими нажатиями. Запуск:  python3 test-ui.py [N телефонов, по умолчанию 4]   (LANG_UI=ru|en|el, BOARD=1600x900)
Сам поднимает dev-сервер со статикой сайта (порт случайный), комнату создаёт с ускорением ×3.
Проверяет на каждом шаге: нет JS-ошибок, телефоны и доска не прокручиваются вбок, партия доходит до итогов,
очки на доске и на телефонах совпадают, в фазе голосования доска не получает чужих голосов."""
import json, os, random, subprocess, sys, time, unicodedata, urllib.request

sys.path.insert(0, os.path.expanduser("~/.pyenv/versions/3.11.9/lib/python3.11/site-packages"))
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
N = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PHONES", 4))
LANG = os.environ.get("LANG_UI", "ru")
BW, BH = [int(x) for x in os.environ.get("BOARD", "1600x900").split("x")]
PORT = int(os.environ.get("UI_PORT", 5400 + random.randint(0, 400)))
BASE = f"http://127.0.0.1:{PORT}"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
WIDTHS = [390, 360, 320, 390, 360, 390, 320, 390]
failures = 0


def norm(t):
    """Сравнение текста без регистра, ударений и финальной сигмы (CSS text-transform: uppercase их стирает)."""
    t = "".join(c for c in unicodedata.normalize("NFD", t) if not unicodedata.combining(c))
    return t.lower().replace("ς", "σ")


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
    board.goto(f"{BASE}/crowd-board.html?r={code}", wait_until="domcontentloaded")
    board.wait_for_function("window.wvBoard && wvBoard.state")
    phones = []
    for i in range(N):
        ctx, p = mk_page(browser, WIDTHS[i % len(WIDTHS)], 780 if i else 460, True, lang_script, errs, f"phone{i}")
        p.goto(f"{BASE}/crowd.html?r={code}", wait_until="domcontentloaded")
        p.wait_for_selector("#name")
        p.fill("#name", f"Игрок{i + 1}")
        p.evaluate("document.getElementById('enterform').requestSubmit()")
        p.wait_for_function("window.wvPhone && wvPhone.me", timeout=10000)
        phones.append(p)
    board.wait_for_function(f"wvBoard.state.players.length === {N}")
    check(True, f"{N} телефонов вошли в комнату")

    # T-W1-06: «Это ты?» — первый телефон закрыт, тот же человек заходит из чистого контекста (без токена) под тем же именем
    old_id = phones[0].evaluate("wvPhone.me")
    phones[0].context.close()
    board.wait_for_function(f"wvBoard.state.players.some(p => p.id === '{old_id}' && !p.online)", timeout=15000)
    time.sleep(2.5)  # CLAIM_GRACE_MS: сокет места закрыт достаточно давно
    ctx, p0 = mk_page(browser, WIDTHS[0], 460, True, lang_script, errs, "phone0b")
    p0.goto(f"{BASE}/crowd.html?r={code}", wait_until="domcontentloaded")
    p0.wait_for_selector("#name")
    p0.fill("#name", "Игрок1")
    p0.evaluate("document.getElementById('enterform').requestSubmit()")
    p0.wait_for_selector("#claimyes", timeout=10000)
    claim_txt = p0.inner_text(".note")
    check("Игрок1" in claim_txt, "«Это ты?» показывает имя места")
    ov = p0.evaluate("({sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight})")
    check(ov["sw"] <= ov["iw"] + 1 and ov["sh"] <= ov["ih"] + 1, "экран «Это ты?» без прокрутки на 390×460")
    p0.click("#claimyes")
    p0.wait_for_function("window.wvPhone && wvPhone.me", timeout=10000)
    check(p0.evaluate("wvPhone.me") == old_id, "claim вернул то же место (тот же playerId)")
    phones[0] = p0
    board.wait_for_function(f"wvBoard.state.players.length === {N}")

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
    # «Ещё партия» при < 3 присутствующих: кнопка неактивна, на доске сказано, сколько не хватает
    ids = board.evaluate("wvBoard.state.players.map(p=>p.id)")
    for pid in ids[: max(0, len(ids) - 2)]:
        board.evaluate("(id)=>wvBoard.send({type:'kick',playerId:id})", pid)
    board.wait_for_function("wvBoard.state.players.length === 2", timeout=5000)
    board.wait_for_selector("#againhint", timeout=5000)
    check(board.evaluate("document.getElementById('again').disabled"), "«Ещё партия» неактивна при < 3 игроков")
    check(bool(board.evaluate("document.getElementById('againhint').textContent.trim()")), "под кнопкой написано, сколько игроков не хватает")
    if os.environ.get("HANDOFF_STAGE", "1") != "0":
        handoff_stage(browser, lang_script, errs)
    if os.environ.get("PAUSE_STAGE", "1") != "0":
        pause_stage(browser, lang_script, errs)
    check(not errs, "нет JS-ошибок на страницах" + (": " + "; ".join(errs[:3]) if errs else ""))
    browser.close()


def handoff_stage(browser, lang_script, errs):
    """T-W2-36: «Ссылка ведущего» (?h= из чистого контекста), заменённая вкладка не отбирает место при обрыве сокета,
    действие, нажатое без связи, доходит после возвращения (S-09, S-12, S-13)."""
    room = json.loads(urllib.request.urlopen(urllib.request.Request(f"{BASE}/crowd/api/rooms", data=json.dumps({"settings": {"lang": LANG, "short": True, "opinion": False}, "speed": 1}).encode(), method="POST")).read())
    code, token = room["code"], room["hostToken"]
    bctx, board = mk_page(browser, BW, BH, False, lang_script + f"try{{localStorage.setItem('crowd-host-{code}','{token}')}}catch(e){{}}", errs, "boardH")
    board.goto(f"{BASE}/crowd-board.html?r={code}", wait_until="domcontentloaded")
    board.wait_for_function("window.wvBoard && wvBoard.state && document.body.classList.contains('host')")
    check(board.evaluate("!!document.querySelector('#hostctl .linkbtn')"), "у ведущего на доске есть «Ссылка ведущего»")
    url = board.evaluate("HL.url()")
    check(bool(url) and f"h={token}" in url and "crowd-board.html" in url, "ссылка ведущего содержит токен и путь доски")
    check(token not in board.evaluate("document.body.innerText"), "токен не нарисован на экране")
    # чистый контекст по ссылке: токен подхватывается, адрес очищается, команды ведущего проходят
    b2ctx, board2 = mk_page(browser, BW, BH, False, lang_script, errs, "boardH2")
    board2.goto(url.replace("http://127.0.0.1:%d" % PORT, BASE) if url.startswith("http") else f"{BASE}/{url}", wait_until="domcontentloaded")
    board2.wait_for_function("document.body.classList.contains('host')", timeout=8000)
    check("h=" not in board2.evaluate("location.search"), "?h= убран из адреса")
    board.wait_for_selector("#hostctl .note", timeout=5000)
    check(board.evaluate("!document.body.classList.contains('host')"), "прежняя доска стала зрителем")
    check(board.evaluate("document.querySelectorAll('#hostctl .linkbtn').length") == 1, "у зрителя есть «Забрать управление»")
    # чистый контекст без ключа: «Я ведущий»
    b3ctx, board3 = mk_page(browser, BW, BH, False, lang_script, errs, "boardH3")
    board3.goto(f"{BASE}/crowd-board.html?r={code}", wait_until="domcontentloaded")
    board3.wait_for_function("window.wvBoard && wvBoard.state")
    board3.wait_for_selector("#hostctl .linkbtn", timeout=5000)
    check(not board3.evaluate("document.body.classList.contains('host')"), "без ключа — зритель, «Я ведущий» предложено")
    # три телефона, у третьего две вкладки по одному токену
    phones = []
    for i in range(3):
        ctx, p = mk_page(browser, 390, 780, True, lang_script, errs, f"pH{i}")
        p.goto(f"{BASE}/crowd.html?r={code}", wait_until="domcontentloaded")
        p.wait_for_selector("#name")
        p.fill("#name", f"Ведомый{i + 1}")
        p.evaluate("document.getElementById('enterform').requestSubmit()")
        p.wait_for_function("window.wvPhone && wvPhone.me", timeout=10000)
        phones.append((ctx, p))
    ptoken = phones[2][1].evaluate(f"localStorage.getItem('crowd-token-{code}') || localStorage.getItem(Object.keys(localStorage).find(k=>k.indexOf('token')>=0))")
    keyname = phones[2][1].evaluate("Object.keys(localStorage).find(k=>k.indexOf('token')>=0)")
    ctxB = browser.new_context(user_agent=UA, viewport={"width": 390, "height": 780}, is_mobile=True, has_touch=True)
    ctxB.add_init_script(lang_script + f"try{{localStorage.setItem('{keyname}','{ptoken}');localStorage.setItem('crowd-name','Ведомый3')}}catch(e){{}}")
    pB = ctxB.new_page()
    pB.goto(f"{BASE}/crowd.html?r={code}", wait_until="domcontentloaded")
    pB.wait_for_function("window.wvPhone && wvPhone.me", timeout=10000)
    phones[2][1].wait_for_selector("#here", timeout=8000)
    check(True, "вкладка, которую заменили, показывает «Играть здесь»")
    # обрыв сокета у заменённой вкладки: активная остаётся играть (crowd-042)
    phones[2][0].set_offline(True)
    phones[2][1].wait_for_timeout(1500)
    phones[2][0].set_offline(False)
    phones[2][1].evaluate("conn.api && conn.api.mode !== 'none' && conn.api.probe(500)")
    phones[2][1].wait_for_timeout(4000)
    check(pB.evaluate("!!wvPhone.me") and phones[2][1].evaluate("!!document.getElementById('here')"), "обрыв заменённой вкладки не отбирает место у активной")
    # S-13: действие без связи доходит после возвращения
    board.evaluate("1")
    board2.evaluate("wvBoard.send({type:'start'})")
    board2.wait_for_function("wvBoard.state.phase === 'vote' || wvBoard.state.phase === 'intro'", timeout=8000)
    p0 = phones[0][1]
    p0.wait_for_function("wvPhone.state && wvPhone.state.phase === 'vote'", timeout=8000)
    phones[0][0].set_offline(True)
    p0.evaluate("wvPhone.send({type:'vote', side:'a'})")
    p0.wait_for_timeout(1200)
    check(p0.evaluate("document.getElementById('conn').classList.contains('on')"), "без сети сразу виден баннер «нет связи»")
    phones[0][0].set_offline(False)
    p0.wait_for_function("wvPhone.state && wvPhone.state.me && wvPhone.state.me.vote === 'a'", timeout=25000)
    check(True, "голос, нажатый без связи, дошёл после возвращения")
    # T-W2-43: неверный код — «Такой комнаты нет» + поле кода, не «Комната закрылась»
    nctx, nph = mk_page(browser, 390, 780, True, lang_script, [], "pNoRoom")
    nph.goto(f"{BASE}/crowd.html?r=NOPE99", wait_until="domcontentloaded")
    nph.wait_for_selector("#codeform", timeout=10000)
    ntxt = nph.evaluate("document.getElementById('app').innerText")
    check(norm(nph.evaluate("T('noroom_title')")) in norm(ntxt) and norm(nph.evaluate("T('expired_title')")) not in norm(ntxt), "неверный код: «Такой комнаты нет» и поле кода")
    nctx.close()
    for c in (bctx, b2ctx, b3ctx, ctxB):
        c.close()
    for c, _ in phones:
        c.close()


def pause_stage(browser, lang_script, errs):
    """Три телефона не голосуют: два аннулированных раунда → короткая «пассивная» пауза с причиной (не «ждём игроков»)."""
    room = json.loads(urllib.request.urlopen(urllib.request.Request(f"{BASE}/crowd/api/rooms", data=json.dumps({"settings": {"lang": LANG, "short": True, "opinion": False}}).encode(), method="POST")).read())
    code, token = room["code"], room["hostToken"]
    bctx, board = mk_page(browser, BW, BH, False, lang_script + f"try{{localStorage.setItem('crowd-host-{code}','{token}')}}catch(e){{}}", errs, "board2")
    board.goto(f"{BASE}/crowd-board.html?r={code}", wait_until="domcontentloaded")
    board.wait_for_function("window.wvBoard && wvBoard.state")
    phones = []
    for i in range(3):
        ctx, p = mk_page(browser, 390, 780, True, lang_script, errs, f"p2-{i}")
        p.goto(f"{BASE}/crowd.html?r={code}", wait_until="domcontentloaded")
        p.wait_for_selector("#name")
        p.fill("#name", f"Молчун{i + 1}")
        p.evaluate("document.getElementById('enterform').requestSubmit()")
        p.wait_for_function("window.wvPhone && wvPhone.me", timeout=10000)
        phones.append(p)
    board.wait_for_function("wvBoard.state.players.length === 3")
    board.evaluate("wvBoard.send({type:'start'})")
    print("  … ждём два аннулированных раунда (≈ 70 с)")
    board.wait_for_function("wvBoard.state.phase === 'pause'", timeout=120000, polling=100)
    reason = board.evaluate("wvBoard.state.pauseReason")
    check(reason == "passive", "причина паузы — пассивные игроки (pauseReason=passive)")
    txt = board.evaluate("document.getElementById('upper').innerText")
    off = board.evaluate("T('pause_title')")
    pas = board.evaluate("T('pause_pt')")
    check(norm(pas) in norm(txt) and norm(off) not in norm(txt), "на доске нет «ждём игроков», написано про голоса")
    ptxt = phones[0].evaluate("document.getElementById('app').innerText")
    check(norm(phones[0].evaluate("T('pause_pt')")) in norm(ptxt), "на телефоне тот же смысл: мало голосов")
    check(board.evaluate("document.querySelectorAll('#upper [data-k]').length") == 3, "ведущему предложено убрать молчунов")
    board.wait_for_function("wvBoard.state.phase === 'vote'", timeout=15000)
    check(True, "после короткой паузы игра идёт дальше (не 60 с)")
    bctx.close()


main()
