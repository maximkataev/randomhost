"""pw_kit — обрыв WS, «два устройства», телефонный контекст и сбор ошибок для Playwright (Python, sync).

T-W0-04. Причина: Playwright `context.set_offline(True)` в headless Chromium НЕ рвёт уже открытый WebSocket
(README плейтеста, «Ограничения метода»), поэтому находки «нет баннера “нет связи”» зависели от способа
обрыва. Здесь три явных режима:

    drop_socket(page, "close")        # настоящее закрытие сокетов страницей: сработает onclose (код 4999 по умолчанию)
    drop_socket(page, "blackhole")    # молчаливая дыра: кадры не приходят, send уходит в никуда, onclose/onopen НЕ срабатывают
    drop_socket(page, "cdp-offline")  # CDP Network.emulateNetworkConditions(offline) + (по умолчанию) close
    restore_socket(page, mode)        # вернуть сеть/кадры

Обёртка WebSocket ставится через add_init_script ДО скриптов страницы: используйте phone_ctx()/new_context()
этого модуля или install_ws_hook(context) сразу после создания контекста (до goto).

Другое:
    phone_ctx(browser, size="390x844", ...)   # iPhone UA, touch, viewport; ловит ошибки
    two_devices(browser, url, name_a, name_b)  # оригинал (онлайн/офлайн) + чистый контекст с тем же именем
    ErrorCollector                              # pageerror + console.error + CDP Runtime.exceptionThrown

Размеры синхронны с tools/testkit/sizes.js (менять в обоих).
"""
from __future__ import annotations

import re
import time

IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")
ANDROID_UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0.0.0 Mobile Safari/537.36")
DESKTOP_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0.0.0 Safari/537.36")
OLD_PROJECTOR_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/80.0.3987.162 Safari/537.36")

PHONE_SIZES = [
    (320, 568), (320, 268), (375, 667), (390, 844), (412, 915),          # портрет (320x268 — с клавиатурой)
    (568, 320), (667, 375), (844, 390), (915, 412),                      # ландшафт
]
TV_SIZES = [(1920, 1080), (1366, 768), (1280, 720), (1024, 768)]

MODES = ("close", "blackhole", "cdp-offline")

# Обёртка WebSocket. Состояние в window.__rh: { sockets:[], hole:false, log:[] }.
# Слушатель 'message'/'open' с capture ставится в конструкторе — раньше любого пользовательского,
# поэтому stopImmediatePropagation глушит и onmessage, и addEventListener-подписчиков.
WS_HOOK_JS = r"""
(() => {
  if (window.__rh) return;
  const rh = window.__rh = { sockets: [], hole: false, sent: 0, dropped: 0, got: 0, swallowed: 0, closes: [] };
  const Native = window.WebSocket;
  function Hooked(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    rh.sockets.push(ws);
    ws.addEventListener('message', (e) => {
      if (rh.hole) { rh.swallowed++; e.stopImmediatePropagation(); } else { rh.got++; }
    }, true);
    ws.addEventListener('open', (e) => { if (rh.hole) e.stopImmediatePropagation(); }, true);
    ws.addEventListener('close', (e) => { rh.closes.push({ code: e.code, t: Date.now() }); }, true);
    const nativeSend = ws.send.bind(ws);
    ws.send = function (data) {
      if (rh.hole) { rh.dropped++; return; }
      rh.sent++;
      return nativeSend(data);
    };
    return ws;
  }
  Hooked.prototype = Native.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { Hooked[k] = Native[k]; });
  window.WebSocket = Hooked;
  rh.closeAll = (code, reason) => {
    let n = 0;
    rh.sockets.forEach((s) => { if (s.readyState === 0 || s.readyState === 1) { try { s.close(code, reason); n++; } catch (e) {} } });
    return n;
  };
})();
"""

_CLOSE_CODE = 4999


def install_ws_hook(context_or_page):
    """Поставить обёртку WebSocket (add_init_script). Вызывать до первой навигации."""
    context_or_page.add_init_script(WS_HOOK_JS)
    return context_or_page


def _cdp(page):
    sess = getattr(page, "_rh_cdp", None)
    if sess is None:
        sess = page.context.new_cdp_session(page)
        page._rh_cdp = sess  # type: ignore[attr-defined]
    return sess


def drop_socket(page, mode: str = "close", *, seconds: float | None = None, code: int = _CLOSE_CODE,
                also_close: bool = True) -> dict:
    """Оборвать связь страницы одним из трёх способов; вернуть {'mode', 'closed': n}.

    seconds — если задано, блокирующе подождать и вызвать restore_socket (удобно для «дыра на 12 с»).
    cdp-offline: CDP offline; also_close=True дополнительно закрывает сокеты (иначе, как показал плейтест,
    уже открытый WS может остаться «живым»).
    """
    if mode not in MODES:
        raise ValueError(f"mode должен быть один из {MODES}")
    info = {"mode": mode, "closed": 0}
    if mode == "close":
        info["closed"] = page.evaluate("(c) => window.__rh ? window.__rh.closeAll(c, 'drop_socket') : -1", code)
        if info["closed"] == -1:
            raise RuntimeError("ws-hook не установлен: создайте контекст через phone_ctx()/install_ws_hook()")
    elif mode == "blackhole":
        ok = page.evaluate("() => { if (!window.__rh) return false; window.__rh.hole = true; return true; }")
        if not ok:
            raise RuntimeError("ws-hook не установлен: создайте контекст через phone_ctx()/install_ws_hook()")
    else:
        _cdp(page).send("Network.enable")
        _cdp(page).send("Network.emulateNetworkConditions",
                        {"offline": True, "latency": 0, "downloadThroughput": 0, "uploadThroughput": 0})
        if also_close:
            info["closed"] = page.evaluate("(c) => window.__rh ? window.__rh.closeAll(c, 'cdp-offline') : 0", code)
    if seconds:
        time.sleep(seconds)
        restore_socket(page, mode)
    return info


def restore_socket(page, mode: str = "blackhole") -> None:
    """Снять дыру / вернуть сеть. Для 'close' ничего восстанавливать не нужно (страница сама переподключается)."""
    if mode == "blackhole":
        page.evaluate("() => { if (window.__rh) window.__rh.hole = false; }")
    elif mode == "cdp-offline":
        _cdp(page).send("Network.emulateNetworkConditions",
                        {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})


def ws_stats(page) -> dict:
    """Счётчики обёртки: got (кадров принято), swallowed (проглочено дырой), sent, dropped, closes, open sockets."""
    return page.evaluate("""() => { const r = window.__rh; if (!r) return null;
        return { got: r.got, swallowed: r.swallowed, sent: r.sent, dropped: r.dropped, closes: r.closes.length,
                 open: r.sockets.filter(s => s.readyState === 1).length, total: r.sockets.length }; }""")


class ErrorCollector:
    """pageerror + console.error + CDP Runtime.exceptionThrown со всех страниц контекста.

        errs = ErrorCollector(context)       # ловит и для уже открытых, и для будущих страниц
        ...
        errs.assert_empty()                  # AssertionError со списком
        errs.items                           # [{'src': 'pageerror'|'console'|'cdp', 'text': ..., 'url': ...}]
    """

    def __init__(self, context, *, ignore: list[str] | None = None, console_errors: bool = True, cdp: bool = True):
        self.items: list[dict] = []
        self._ignore = [re.compile(p) for p in (ignore or [])]
        self._console = console_errors
        self._cdp = cdp
        self._seen = set()
        context.on("page", self.attach)
        for p in context.pages:
            self.attach(p)

    def _add(self, src, text, url=""):
        if any(r.search(text) for r in self._ignore):
            return
        self.items.append({"src": src, "text": text, "url": url})

    def attach(self, page):
        if id(page) in self._seen:
            return
        self._seen.add(id(page))
        page.on("pageerror", lambda e: self._add("pageerror", str(e), page.url))
        if self._console:
            page.on("console", lambda m: m.type == "error" and self._add("console", m.text, page.url))
        if self._cdp:
            try:
                s = page.context.new_cdp_session(page)
                s.send("Runtime.enable")

                def on_exc(ev, _url=lambda: page.url):
                    d = ev.get("exceptionDetails", {})
                    ex = (d.get("exception") or {}).get("description") or d.get("text", "")
                    # pageerror уже поймал то же самое; различаем только по источнику «cdp»
                    self._add("cdp", ex, _url())
                s.on("Runtime.exceptionThrown", on_exc)
            except Exception:  # страница уже закрыта и т.п.
                pass

    def texts(self, src: str | None = None) -> list[str]:
        return [i["text"] for i in self.items if src is None or i["src"] == src]

    def clear(self):
        self.items.clear()

    def assert_empty(self, msg: str = "ошибки на странице"):
        if self.items:
            raise AssertionError(msg + ":\n  " + "\n  ".join(f"[{i['src']}] {i['text'][:200]}" for i in self.items[:10]))


def parse_size(size) -> tuple[int, int]:
    if isinstance(size, (tuple, list)):
        return int(size[0]), int(size[1])
    m = re.match(r"^(\d+)x(\d+)$", str(size))
    if not m:
        raise ValueError(f"размер вида '390x844', получено {size!r}")
    return int(m.group(1)), int(m.group(2))


def phone_ctx(browser, size="390x844", *, ua: str = IPHONE_UA, locale: str = "ru-RU", hook: bool = True,
              errors: bool = True, ignore_errors: list[str] | None = None, **ctx_kwargs):
    """Контекст «телефон»: iPhone UA (plinko isMobile — по UA), touch, is_mobile, WS-hook, ErrorCollector.

    Возвращает контекст; сборщик ошибок — context.rh_errors (или None).
    """
    w, h = parse_size(size)
    ctx = browser.new_context(viewport={"width": w, "height": h}, user_agent=ua, is_mobile=True, has_touch=True,
                              device_scale_factor=2, locale=locale, **ctx_kwargs)
    if hook:
        install_ws_hook(ctx)
    ctx.rh_errors = ErrorCollector(ctx, ignore=ignore_errors) if errors else None  # type: ignore[attr-defined]
    return ctx


def tv_ctx(browser, size="1920x1080", *, old_projector: bool = False, locale: str = "ru-RU", **kw):
    w, h = parse_size(size)
    ctx = browser.new_context(viewport={"width": w, "height": h},
                              user_agent=OLD_PROJECTOR_UA if old_projector else DESKTOP_UA, locale=locale, **kw)
    install_ws_hook(ctx)
    ctx.rh_errors = ErrorCollector(ctx)  # type: ignore[attr-defined]
    return ctx


def default_enter(page, name: str) -> None:
    """Эвристика входа в лобби: поле имени + Enter/первая кнопка. Для точной формы передайте свой enter=."""
    box = page.locator("input[type=text], input:not([type]), input[name=name], #name").first
    box.fill(name)
    try:
        box.press("Enter")
    except Exception:
        page.locator("button").first.click()


def two_devices(browser, url: str, name_a: str, name_b: str | None = None, *, size="390x844",
                enter=default_enter, goto_kwargs: dict | None = None):
    """Сценарий «одно имя — два устройства» (S-xx про name_claim/replaced).

    A — оригинал (контекст с WS-hook: его можно перевести в офлайн drop_socket(A.page, ...));
    B — чистый контекст (свои localStorage/токены) с тем же именем (name_b по умолчанию = name_a).
    Возвращает объект с A.page/A.ctx/A.errors и B.page/B.ctx/B.errors; .close() закрывает оба контекста.
    """
    class Device:
        def __init__(self, ctx, page):
            self.ctx, self.page, self.errors = ctx, page, ctx.rh_errors

    ctx_a = phone_ctx(browser, size)
    ctx_b = phone_ctx(browser, size)  # новый контекст = чистое хранилище, другой токен
    kw = goto_kwargs or {}
    pa, pb = ctx_a.new_page(), ctx_b.new_page()
    pa.goto(url, **kw)
    if enter:
        enter(pa, name_a)
    pb.goto(url, **kw)
    if enter:
        enter(pb, name_b or name_a)

    class Pair:
        A = Device(ctx_a, pa)
        B = Device(ctx_b, pb)

        @staticmethod
        def close():
            ctx_a.close()
            ctx_b.close()
    return Pair
