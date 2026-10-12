"""UI-тест тапов «Как все» (T-W0-14/30): спам А/Б, повтор после rejected rate, flush перед «Готово», очередь и дроп.
Запуск: python3 test-taps.py (сам поднимает dev-сервер на случайном порту)."""
import json, os, subprocess, sys, time, urllib.request, random
sys.path.insert(0, os.path.expanduser("~/.pyenv/versions/3.11.9/lib/python3.11/site-packages"))
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 21000 + random.randint(0, 9000)
BASE = f"http://127.0.0.1:{PORT}"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
env = {**os.environ, "PORT": str(PORT), "NODE_ENV": "development", "STATIC": "..", "DUMP_FILE": f"/tmp/claude-501/sp-{PORT}.json", "STATS_FILE": f"/tmp/claude-501/sp-st-{PORT}.json"}
srv = subprocess.Popen(["/opt/homebrew/Cellar/node@22/22.23.2_2/bin/node", "server.js"], cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
fails = 0


def check(ok, n):
    global fails
    print(("  OK  " if ok else "  FAIL ") + n)
    if not ok:
        fails += 1


try:
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/crowd/api/health", timeout=1)
            break
        except Exception:
            time.sleep(0.1)
    room = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/crowd/api/rooms", data=json.dumps({"settings": {"lang": "ru", "opinion": False}}).encode(), method="POST")).read())
    code, tok = room["code"], room["hostToken"]
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        errs = []
        bc = br.new_context(viewport={"width": 1600, "height": 900})
        bc.add_init_script(f"try{{localStorage.setItem('crowd-host-{code}','{tok}')}}catch(e){{}}")
        board = bc.new_page()
        board.goto(f"{BASE}/crowd-board.html?r={code}")
        board.wait_for_function("window.wvBoard && wvBoard.state")
        spy = "try{localStorage.setItem('site-lang','ru')}catch(e){};window.__sent=[];const _s=WebSocket.prototype.send;WebSocket.prototype.send=function(d){try{const m=JSON.parse(d);if(m.type!=='ping')window.__sent.push([Date.now(),m.type,m.side||m.on])}catch(e){};return _s.apply(this,arguments)};"
        ph = []
        for i in range(3):
            c = br.new_context(user_agent=UA, viewport={"width": 360, "height": 740}, is_mobile=True, has_touch=True)
            c.add_init_script(spy)
            p = c.new_page()
            p.on("pageerror", lambda e: errs.append(str(e)))
            p.goto(f"{BASE}/crowd.html?r={code}")
            p.wait_for_selector("#name")
            p.fill("#name", f"Игрок{i+1}")
            p.evaluate("document.getElementById('enterform').requestSubmit()")
            p.wait_for_function("window.wvPhone && wvPhone.me", timeout=10000)
            ph.append(p)
        board.evaluate("wvBoard.send({type:'start'})")
        for p in ph:
            p.wait_for_selector(".side", timeout=10000)
        p0, p1 = ph[0], ph[1]
        p0.evaluate("window.__sent.length=0")
        p0.evaluate("""()=>{const a=document.querySelector('.side[data-s=a]'),b=document.querySelector('.side[data-s=b]');
            let i=0; const iv=setInterval(()=>{ (i%2?b:a).click(); i++; if(i>=30)clearInterval(iv)},6)}""")
        p0.wait_for_timeout(2800)
        sent = p0.evaluate("window.__sent")
        votes = [s for s in sent if s[1] == "vote"]
        check(1 <= len(votes) <= 4, f"30 тапов -> на сервер {len(votes)} vote (<=4 за ~3 с)")
        times = [s[0] for s in votes]
        check(all(times[i+1]-times[i] >= 240 for i in range(len(times)-1)), "интервалы между отправками >= 250 мс")
        st = p0.evaluate("wvPhone.state.me.vote")
        check(st == "b", f"сервер держит последнее значение (b), получил {st}")
        check(p0.evaluate("!document.getElementById('toast').classList.contains('on')"), "нет тоста про частоту")
        if p0.query_selector("#bank"):
            p0.click("#bank")
            p0.wait_for_timeout(100)
            hint = p0.evaluate("document.getElementById('bankhint').textContent")
            check("Готово" in hint, f"подсказка у ва-банка: {hint!r}")
        # прямой флуд в обход коалесцера: отказ по rate, повтор актуального желания
        p0.evaluate("window.__sent.length=0")
        p0.evaluate("()=>{ for(let i=0;i<9;i++) wvPhone.send({type:'vote',side:'a'}); document.querySelector('.side[data-s=b]').click(); }")
        p0.wait_for_timeout(2500)
        st = p0.evaluate("wvPhone.state.me.vote")
        check(st == "b", f"после отказа по rate повтор довёл желание b, сервер: {st}")
        check(p0.evaluate("!document.getElementById('toast').classList.contains('on')"), "тост не показан при удачном повторе")
        p0.evaluate("window.__sent.length=0")
        p0.evaluate("()=>{document.querySelector('.side[data-s=a]').click();document.getElementById('done').click()}")
        p0.wait_for_timeout(600)
        types = [s[1] for s in p0.evaluate("window.__sent")]
        check(types[-1:] == ["confirm"] and "vote" in types, f"перед confirm ушёл vote: {types}")
        p1.evaluate("conn.gated = true")
        p1.click(".side[data-s=a]")
        p1.wait_for_timeout(200)
        p1.click("#done")
        p1.wait_for_timeout(300)
        check(p1.evaluate("conn.pending()") >= 1, "действие в очереди")
        check("Отправляем" in p1.evaluate("document.getElementById('waittx') ? document.getElementById('waittx').textContent : ''"), "подпись «Отправляем…»")
        p1.wait_for_timeout(6300)
        p1.evaluate("flushQueued()")
        p1.wait_for_timeout(400)
        check(p1.evaluate("!!document.getElementById('done')"), "после дропа кнопка «Готово» снова на экране")
        check("Нет связи" in p1.evaluate("document.getElementById('toast').textContent"), "тост про нет связи")
        check(not errs, "нет JS-ошибок " + str(errs[:2]))
        br.close()
finally:
    srv.terminate()
print("FAILS", fails)
