#!/usr/bin/env python3
"""Самопроверка pw_kit на заглушке (без зависимостей, кроме Playwright): python3 tools/testkit/selftest.py

Заглушка — минимальный HTTP+WebSocket-сервер на asyncio в этом же файле (шлёт кадр раз в 200 мс).
Страница-заглушка: считает кадры, показывает баннер «нет связи» только по onclose, переподключается через 500 мс,
по кнопке бросает исключение.

Кейсы (приёмка T-W0-04):
  1. blackhole 12 с: кадры не приходят, onclose не срабатывает, баннера нет; после restore кадры идут
  2. close: сработал onclose, баннер показан, страница переподключилась
  3. cdp-offline (+close): сокеты закрыты, кадров нет; после restore страница снова получает кадры
  4. исключение в странице попадает в errors (pageerror и cdp)
  5. two_devices: два изолированных контекста с одним именем, у A обрыв не трогает B
  6. phone_ctx: iPhone UA, viewport, touch
"""
import asyncio
import base64
import hashlib
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pw_kit  # noqa: E402

PAGE = b"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>stub</title>
<body style="font:16px sans-serif">
<input id=name type=text placeholder=name>
<div id=banner hidden>\xd0\xbd\xd0\xb5\xd1\x82 \xd1\x81\xd0\xb2\xd1\x8f\xd0\xb7\xd0\xb8</div>
<button id=boom onclick="setTimeout(function(){throw new Error('boom-from-page')},0)">boom</button>
<pre id=out></pre>
<script>
var frames = 0, closes = 0, opens = 0, me = '';
function connect() {
  var ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onopen = function () { opens++; document.getElementById('banner').hidden = true; ws.send(JSON.stringify({type:'join', name: me})); };
  ws.onmessage = function () { frames++; window.__frames = frames; };
  ws.onclose = function () { closes++; window.__closes = closes; document.getElementById('banner').hidden = false; setTimeout(connect, 500); };
}
document.getElementById('name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { me = this.value; localStorage.setItem('me', me); } });
connect();
window.__frames = 0; window.__closes = 0;
window.__state = function () { return { frames: frames, closes: closes, opens: opens, banner: !document.getElementById('banner').hidden, me: localStorage.getItem('me') }; };
</script>"""

OPEN_CONNS = []  # (writer) — для проверки, что у сервера соединение реально живо при blackhole


async def handle(reader, writer):
    try:
        head = await reader.readuntil(b"\r\n\r\n")
    except Exception:
        return writer.close()
    text = head.decode("latin1")
    first = text.split("\r\n", 1)[0]
    if "Upgrade: websocket" not in text and "upgrade: websocket" not in text.lower():
        body = PAGE
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
        await writer.drain()
        return writer.close()
    key = [l.split(":", 1)[1].strip() for l in text.split("\r\n") if l.lower().startswith("sec-websocket-key")][0]
    acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  "Sec-WebSocket-Accept: %s\r\n\r\n" % acc).encode())
    await writer.drain()
    OPEN_CONNS.append(writer)
    alive = True

    async def pump():
        n = 0
        while alive:
            n += 1
            payload = b'{"type":"tick","n":%d}' % n
            try:
                writer.write(bytes([0x81, len(payload)]) + payload)
                await writer.drain()
            except Exception:
                return
            await asyncio.sleep(0.2)
    task = asyncio.ensure_future(pump())
    try:
        while True:  # читаем и игнорируем клиентские кадры; закрытие — выход
            h = await reader.readexactly(2)
            op, ln = h[0] & 0x0F, h[1] & 0x7F
            if ln == 126:
                ln = int.from_bytes(await reader.readexactly(2), "big")
            elif ln == 127:
                ln = int.from_bytes(await reader.readexactly(8), "big")
            await reader.readexactly(4 + ln)
            if op == 8:
                break
    except Exception:
        pass
    finally:
        alive = False
        task.cancel()
        if writer in OPEN_CONNS:
            OPEN_CONNS.remove(writer)
        try:
            writer.close()
        except Exception:
            pass


def start_stub():
    ready = threading.Event()
    box = {}

    def run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        srv = loop.run_until_complete(asyncio.start_server(handle, "127.0.0.1", 0))
        box["port"] = srv.sockets[0].getsockname()[1]
        box["loop"], box["srv"] = loop, srv
        ready.set()
        loop.run_forever()
    t = threading.Thread(target=run, daemon=True)
    t.start()
    ready.wait(5)
    return box


results = []


def case(name):
    def deco(fn):
        def run(*a):
            try:
                fn(*a)
                results.append((name, True, ""))
                print("  ✓ " + name)
            except Exception as e:  # noqa: BLE001
                results.append((name, False, str(e)))
                print("  ✗ " + name + "\n    " + str(e).replace("\n", "\n    ")[:600])
        run.__name__ = fn.__name__
        return run
    return deco


def wait_until(fn, timeout=6.0, step=0.1):
    t = time.time()
    while time.time() - t < timeout:
        if fn():
            return True
        time.sleep(step)
    return False


def st(page):
    return page.evaluate("window.__state()")


def main():
    from playwright.sync_api import sync_playwright
    stub = start_stub()
    url = "http://127.0.0.1:%d/" % stub["port"]
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        @case("1. blackhole 12 с: кадры не приходят, onclose нет, баннера нет; после restore — идут")
        def t1():
            ctx = pw_kit.phone_ctx(browser)
            page = ctx.new_page()
            page.goto(url)
            assert wait_until(lambda: st(page)["frames"] >= 3), "кадры не пошли"
            before = st(page)
            pw_kit.drop_socket(page, "blackhole")
            time.sleep(12)
            mid = st(page)
            stats = pw_kit.ws_stats(page)
            assert mid["frames"] <= before["frames"] + 1, f"кадры продолжали приходить: {before['frames']} -> {mid['frames']}"
            assert stats["swallowed"] >= 20, f"сервер шлёт, а дыра ничего не проглотила: {stats}"
            assert mid["closes"] == before["closes"], "onclose сработал при blackhole"
            assert mid["banner"] is False, "баннер без close не должен появляться"
            pw_kit.restore_socket(page, "blackhole")
            assert wait_until(lambda: st(page)["frames"] > mid["frames"] + 2), "после restore кадры не вернулись"
            ctx.close()
        t1()

        @case("2. close: сработал onclose, баннер показан, страница переподключилась")
        def t2():
            ctx = pw_kit.phone_ctx(browser)
            page = ctx.new_page()
            page.goto(url)
            assert wait_until(lambda: st(page)["frames"] >= 2)
            c0 = st(page)["closes"]
            info = pw_kit.drop_socket(page, "close")
            assert info["closed"] >= 1, info
            assert wait_until(lambda: st(page)["closes"] == c0 + 1, 3), "onclose не вызван"
            assert pw_kit.ws_stats(page)["closes"] >= 1
            # баннер виден до переподключения (500 мс) — ловим либо его, либо факт нового open
            assert wait_until(lambda: st(page)["opens"] >= 2, 5), "страница не переподключилась"
            ctx.close()
        t2()

        @case("3. cdp-offline: сокеты закрыты, кадров нет; после restore кадры снова идут")
        def t3():
            ctx = pw_kit.phone_ctx(browser)
            page = ctx.new_page()
            page.goto(url)
            assert wait_until(lambda: st(page)["frames"] >= 2)
            pw_kit.drop_socket(page, "cdp-offline")
            assert wait_until(lambda: st(page)["closes"] >= 1, 3), "сокет не закрыт"
            f = st(page)["frames"]
            time.sleep(2)
            f2 = st(page)["frames"]
            assert f2 <= f + 1, f"в офлайне кадры идут: {f} -> {f2}"
            pw_kit.restore_socket(page, "cdp-offline")
            assert wait_until(lambda: st(page)["frames"] > f2 + 2, 8), "после restore кадры не вернулись"
            ctx.close()
        t3()

        @case("4. исключение в странице попадает в errors (pageerror и cdp)")
        def t4():
            ctx = pw_kit.phone_ctx(browser)
            page = ctx.new_page()
            page.goto(url)
            assert ctx.rh_errors.items == []
            page.click("#boom")
            assert wait_until(lambda: any("boom-from-page" in t for t in ctx.rh_errors.texts("pageerror")), 3), ctx.rh_errors.items
            assert wait_until(lambda: any("boom-from-page" in t for t in ctx.rh_errors.texts("cdp")), 3), ctx.rh_errors.items
            try:
                ctx.rh_errors.assert_empty()
                raise RuntimeError("assert_empty не упал")
            except AssertionError:
                pass
            ctx.close()
        t4()

        @case("5. two_devices: изолированные контексты с одним именем; обрыв A не трогает B")
        def t5():
            pair = pw_kit.two_devices(browser, url, "Маша")
            try:
                assert wait_until(lambda: st(pair.A.page)["frames"] >= 2 and st(pair.B.page)["frames"] >= 2)
                assert st(pair.A.page)["me"] == "Маша" and st(pair.B.page)["me"] == "Маша"
                assert pair.A.ctx is not pair.B.ctx
                # localStorage изолирован: имя A не видно B, пока B сам не ввёл (имя ввёл → у обоих своё)
                pair.B.page.evaluate("localStorage.setItem('only_b','1')")
                assert pair.A.page.evaluate("localStorage.getItem('only_b')") is None
                fb = st(pair.B.page)["frames"]
                pw_kit.drop_socket(pair.A.page, "blackhole")
                time.sleep(1.5)
                assert st(pair.B.page)["frames"] > fb + 2, "обрыв A остановил B"
                pw_kit.restore_socket(pair.A.page, "blackhole")
            finally:
                pair.close()
        t5()

        @case("6. phone_ctx: iPhone UA, viewport 320x568, touch")
        def t6():
            ctx = pw_kit.phone_ctx(browser, "320x568")
            page = ctx.new_page()
            page.goto(url)
            assert "iPhone" in page.evaluate("navigator.userAgent")
            vp = page.evaluate("[innerWidth, innerHeight]")
            assert vp == [320, 568], vp
            assert page.evaluate("'ontouchstart' in window") is True
            assert pw_kit.parse_size((412, 915)) == (412, 915)
            ctx.close()
        t6()

        browser.close()

    bad = [r for r in results if not r[1]]
    print("\n%d зелёных, %d красных" % (len(results) - len(bad), len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
