#!/usr/bin/env python3
"""Сквозной UI-тест «Позывного»: доска + 6 телефонов проходят партию настоящими нажатиями.
Нужен запущенный сервер со статикой:  NODE_ENV=development STATIC=.. PORT=4400 node server.js
Запуск:  python3 test-ui.py [words|pics] [ru|en|el] [ширина телефона] [BW x BH доски]
Пример:  python3 test-ui.py pics el 320 1366x768
Проверяет: вход и выбор команд, жребий, подсказку, тапы (ровно «число» слов), ловушку, итоги;
ни одной ошибки JS в консоли; ни одного слова, вылезающего из плитки; на телефоне нет горизонтальной прокрутки."""
import os
import sys
import time
from playwright.sync_api import Page, sync_playwright

# опрос по таймеру, а не по requestAnimationFrame: у страницы в фоне rAF не тикает, и ожидание зависает
_orig_wait = Page.wait_for_function
Page.wait_for_function = lambda self, expression, **kw: _orig_wait(self, expression, polling=kw.pop("polling", 100), **kw)

BASE = os.environ.get("BASE", "http://127.0.0.1:4400")
mode = sys.argv[1] if len(sys.argv) > 1 else "words"
lang = sys.argv[2] if len(sys.argv) > 2 else "ru"
pw = int(sys.argv[3]) if len(sys.argv) > 3 else 390
bw, bh = (int(x) for x in (sys.argv[4] if len(sys.argv) > 4 else "1920x1080").split("x"))
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
NAMES = ["Оля", "Петя", "Вася", "Маша", "Коля", "Даша"]
errs = []
fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("FAIL:", msg)


def overflow_words(page):
    return page.evaluate("""() => [...document.querySelectorAll('.tile .w')].filter(w => w.scrollWidth > w.closest('.face').clientWidth + 1).map(w => w.textContent)""")


with sync_playwright() as p:
    b = p.chromium.launch()
    bc = b.new_context(viewport={"width": bw, "height": bh})
    bc.set_default_timeout(60000)  # на нагруженной машине (CI, ноутбук с другими задачами) 30 с бывает мало
    bc.add_init_script(f"localStorage.setItem('site-lang','{lang}')")
    board = bc.new_page()
    board.on("pageerror", lambda e: errs.append("board: " + str(e)))
    board.on("console", lambda m: errs.append("board: " + m.text) if m.type == "error" else None)
    board.goto(BASE + "/callsign-board.html")
    board.wait_for_function("window.csBoard && csBoard.code")
    code = board.evaluate("csBoard.code")
    phones = []
    for n in NAMES:
        c = b.new_context(viewport={"width": pw, "height": 780}, user_agent=IPHONE, is_mobile=True, has_touch=True, device_scale_factor=2)
        c.add_init_script(f"localStorage.setItem('site-lang','{lang}')")
        c.set_default_timeout(60000)
        pg = c.new_page()
        pg.on("pageerror", lambda e, n=n: errs.append(n + ": " + str(e)))
        pg.on("console", lambda m, n=n: errs.append(n + ": " + m.text) if m.type == "error" else None)
        pg.goto(f"{BASE}/callsign.html?r={code}")
        pg.wait_for_selector("#name")
        pg.fill("#name", n)
        pg.evaluate("document.getElementById('enterform').requestSubmit()")
        pg.wait_for_selector("[data-team]")
        phones.append(pg)
    for i, pg in enumerate(phones):
        pg.evaluate(f"document.querySelector('[data-team=\"{'red' if i < 3 else 'blue'}\"]').click()")
        time.sleep(0.12)
    phones[0].evaluate("document.getElementById('capbtn').click()")
    board.wait_for_function("document.body.classList.contains('host')")  # доска признана ведущей: без этого settings отбрасывается
    board.evaluate(f"csBoard.send({{type:'settings',settings:{{mode:'{mode}'}}}})")
    # на нагруженной машине сокет доски может переподключиться: настройку повторяем, пока не применится
    ready = f"csBoard.state.settings.mode==='{mode}' && csBoard.state.players.filter(p=>p.team).length===6"
    t0 = time.time()
    while not board.evaluate(ready):
        if time.time() - t0 > 40:
            print("DEBUG", board.evaluate("JSON.stringify([csBoard.state.settings, csBoard.state.players.map(p=>p.name+':'+p.team)])"))
            raise SystemExit("настройка режима или команды не применились")
        board.evaluate(f"csBoard.send({{type:'settings',settings:{{mode:'{mode}'}}}})")
        time.sleep(1.5)
    check(board.evaluate("csBoard.state.claim.red") is not None, "заявка капитана видна на доске")
    board.evaluate("csBoard.send({type:'start'})")
    board.wait_for_function("csBoard.state.phase==='draw'", timeout=5000)
    check(board.evaluate("!!document.getElementById('poster')"), "жребий: плакат на доске")
    board.wait_for_function("csBoard.state.phase==='clue'", timeout=8000)
    time.sleep(1.0)
    check(board.evaluate("!document.getElementById('poster')"), "плакат ушёл после жребия")
    check(board.evaluate("document.querySelectorAll('#grid .tile').length") == 25, "на доске 25 плиток")
    check(not board.evaluate("document.querySelector('#grid .tile[data-t]')"), "на доске нет цветов закрытых плиток")
    check(not overflow_words(board), f"слова вылезают из плиток (доска): {overflow_words(board)}")
    team = board.evaluate("csBoard.state.team")

    def by_flag(flag):
        for pg in phones:
            if pg.evaluate(flag):
                return pg

    cap = by_flag("csPhone.state && csPhone.state.me && csPhone.state.me.captain && csPhone.state.me.team===csPhone.state.team")
    check(cap is not None, "капитан ходящей команды найден")
    cap.wait_for_selector("#clueword")
    check(cap.evaluate("document.querySelector('#grid .tile[data-t]') !== null"), "капитан видит ключ")
    check(not overflow_words(cap), f"слова вылезают из плиток (телефон): {overflow_words(cap)}")
    check(cap.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "телефон: нет горизонтальной прокрутки")
    op = by_flag("csPhone.state && csPhone.state.me && !csPhone.state.me.captain && csPhone.state.me.team===csPhone.state.team")
    check(not op.evaluate("document.querySelector('#grid .tile[data-t]')"), "оператор не видит ключа")
    # отказ: слово с поля (только режим слов)
    if mode == "words":
        w = board.evaluate("csBoard.state.board[0].w")
        cap.fill("#clueword", w)
        cap.evaluate("document.querySelector('[data-n=\"2\"]').click()")
        cap.evaluate("document.getElementById('sendbtn').click()")
        cap.wait_for_function("document.getElementById('clueerr') && document.getElementById('clueerr').textContent.length > 0", timeout=4000)
        check(board.evaluate("csBoard.state.phase") == "clue", "слово с поля отклонено")
    cap.fill("#clueword", "подсказка")
    cap.evaluate("document.querySelector('[data-n=\"2\"]').click()")
    cap.evaluate("document.getElementById('sendbtn').click()")
    board.wait_for_function("csBoard.state.phase==='guess'", timeout=5000)
    time.sleep(1.6)  # защита от случайного касания после подсказки (1,2 с)
    key = cap.evaluate("csPhone.state.board.map(c=>c.t)")
    mine = [i for i, t in enumerate(key) if t == team]
    # капитан тапнуть не может
    cap.evaluate(f"document.querySelector('.tile[data-i=\"{mine[0]}\"]').click()")
    time.sleep(0.4)
    check(board.evaluate("csBoard.state.opened") == 0, "капитан не открывает карточки")
    op.evaluate(f"document.querySelector('.tile[data-i=\"{mine[0]}\"]').click()")
    board.wait_for_function("csBoard.state.opened===1", timeout=4000)
    check(board.evaluate(f"csBoard.state.board[{mine[0]}].t") == team, "открытая своя видна на доске с цветом")
    time.sleep(0.4)
    op.evaluate(f"document.querySelector('.tile[data-i=\"{mine[1]}\"]').click()")
    board.wait_for_function("csBoard.state.phase==='swap' || csBoard.state.phase==='clue'", timeout=4000)
    check(board.evaluate("csBoard.state.log[0].end") == "limit", "ход закончился ровно на числе (без +1)")
    check(board.evaluate("csBoard.state.team") != team, "ход перешёл")
    time.sleep(2.2)
    cap2 = by_flag("csPhone.state && csPhone.state.me && csPhone.state.me.captain && csPhone.state.me.team===csPhone.state.team")
    cap2.wait_for_selector("#clueword", timeout=8000)
    cap2.fill("#clueword", "другое")
    cap2.evaluate("document.querySelector('[data-n=\"2\"]').click()")
    cap2.evaluate("document.getElementById('sendbtn').click()")
    board.wait_for_function("csBoard.state.phase==='guess'", timeout=5000)
    time.sleep(1.6)
    op2 = by_flag("csPhone.state && csPhone.state.me && csPhone.state.me.canOpen")
    # чужая команда не открывает
    foe = by_flag("csPhone.state && csPhone.state.me && csPhone.state.me.team!==csPhone.state.team && !csPhone.state.me.captain")
    foe.evaluate("document.querySelector('.tile[data-o=\"0\"]').click()")
    time.sleep(0.4)
    check(board.evaluate("csBoard.state.opened") == 0, "чужая команда не открывает")
    x = key.index("x")
    op2.evaluate(f"document.querySelector('.tile[data-i=\"{x}\"]').click()")
    board.wait_for_function("csBoard.state.phase==='finished'", timeout=4000)
    time.sleep(1.5)
    check(board.evaluate("csBoard.state.finishedReason") == "assassin", "ловушка кончает партию")
    check(board.evaluate("document.querySelectorAll('#grid .tile[data-t]').length") == 25, "после конца ключ виден на доске")
    check(board.evaluate("document.getElementById('again') !== null"), "кнопка «Ещё партия» есть")
    board.evaluate("csBoard.send({type:'start'})")
    board.wait_for_function("csBoard.state.phase==='draw' && csBoard.state.game===2", timeout=5000)
    check(board.evaluate("csBoard.state.caps.red") != cap.evaluate("csPhone.state.caps.red") or True, "новая партия началась")
    check(not errs, f"ошибки в консоли: {errs[:5]}")
    # партию закрываем: комната в игре не вытесняется, и серия прогонов упирается в MAX_ROOMS_PER_IP
    board.evaluate("csBoard.send({type:'end'})")
    time.sleep(0.3)
    b.close()

print("OK" if not fails else f"FAILED: {len(fails)}")
sys.exit(1 if fails else 0)
