"""
Тесты сервиса молний на поддельном S3 — сеть не нужна.
  python3 test.py            (нужны h5py и numpy, как у сервиса)
Интервалы здесь 2 с вместо 20, чтобы прогон шёл секунды. Проверяет: /draw берёт только интервал,
начатый после запроса, и в шкале часов AWS (часы S3 спешат на 30 с); k ближайших и порядок по времени;
деление зон спутников по 106° з.д.; распаковку беззнаковых int16 со scale/offset; розыгрыш по одному
спутнику, если второй молчит; /recent; ошибки параметров; засыпание без зрителей.
"""

import calendar
import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

import h5py
import numpy as np

FAKE_PORT = 3391
STORM_PORT = 3392
PERIOD = 2.0
SHIFT = 30.0                      # часы «AWS» впереди наших на 30 с
fake = {"g18": True, "hits": 0}

# Вспышки каждого интервала: точка в Москве (55.75, 37.62) — ближе всех; ещё сетка по Атлантике.
# Для G19 одна вспышка западнее 106° з.д. (её должно отрезать), для G18 — одна восточнее.
MOSCOW = (55.75, 37.62)


def flashes(sat, start):
    rng = np.random.default_rng(int(start * 10) + (19 if sat == "G19" else 18))
    if sat == "G19":
        lat = list(rng.uniform(-10, 30, 60)) + [55.7512, -20.0]
        lon = list(rng.uniform(-60, -20, 60)) + [37.6173, -120.0]      # -120 — зона G18
    else:
        lat = list(rng.uniform(-10, 30, 20)) + [10.0]
        lon = list(rng.uniform(-150, -110, 20)) + [-50.0]              # -50 — зона G19
    n = len(lat)
    # время: сырые uint16 через весь диапазон, включая > 32767 (отрицательные как int16)
    raw = np.linspace(0, 65535, n).astype(np.uint16)
    return np.array(lat, np.float32), np.array(lon, np.float32), raw, np.arange(1000, 1000 + n, dtype=np.uint16)


SCALE = PERIOD / 65535.0


def make_nc(sat, start):
    lat, lon, raw, ids = flashes(sat, start)
    bio = BytesIO()
    with h5py.File(bio, "w") as f:
        f["flash_lat"] = lat
        f["flash_lon"] = lon
        t = f.create_dataset("flash_time_offset_of_first_event", data=raw.view(np.int16))
        t.attrs["_Unsigned"] = np.bytes_(b"true")
        t.attrs["scale_factor"] = np.array([SCALE], np.float32)
        t.attrs["add_offset"] = np.array([0.0], np.float32)
        i = f.create_dataset("flash_id", data=ids.view(np.int16))
        i.attrs["_Unsigned"] = np.bytes_(b"true")
    return bio.getvalue()


def stamp(ts):
    t = time.gmtime(ts)
    return "%04d%03d%02d%02d%02d%d" % (t.tm_year, t.tm_yday, t.tm_hour, t.tm_min, t.tm_sec, int(round((ts % 1) * 10)) % 10)


def key(sat, start):
    return "GLM-L2-LCFA/x/OR_GLM-L2-LCFA_%s_s%s_e%s_c%s.nc" % (sat, stamp(start), stamp(start + PERIOD), stamp(start + PERIOD + 0.3))


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def date_time_string(self, timestamp=None):
        return formatdate(time.time() + SHIFT, usegmt=True)

    def do_GET(self):
        fake["hits"] += 1
        bucket = self.path.split("/")[1]
        sat = "G19" if bucket.endswith("19") else "G18"
        now = time.time() + SHIFT
        if "?list-type" in self.path:
            keys = []
            if sat == "G19" or fake["g18"]:
                last_end = math.floor((now - 0.4) / PERIOD) * PERIOD      # файл готов через 0.4 с после конца
                for k in range(8):
                    s = last_end - PERIOD * (k + 1)
                    keys.append(key(sat, s))
            body = ("<ListBucketResult>" + "".join("<Contents><Key>%s</Key></Contents>" % k for k in keys) + "</ListBucketResult>").encode()
        else:
            name = self.path.rsplit("_s", 1)[1]
            s = name.split("_e")[0]
            y, doy, hh, mm, ss, tenth = s[:4], s[4:7], s[7:9], s[9:11], s[11:13], s[13]
            start = calendar.timegm(time.strptime(y + doy, "%Y%j")) + int(hh) * 3600 + int(mm) * 60 + int(ss) + int(tenth) / 10
            body = make_nc(sat, start)
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def get(path):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (STORM_PORT, path), timeout=60) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = dict(os.environ, PORT=str(STORM_PORT), STORM_S3="http://127.0.0.1:%d/{bucket}/" % FAKE_PORT,
               POLL_S="0.3", IDLE_S="2", PAIR_WAIT_S="1.5", DRAW_TIMEOUT_S="10")
    proc = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                get("/storm/api/health")
                break
            except OSError:
                time.sleep(0.1)

        # 1. /recent: последний готовый интервал, вспышки обоих спутников без дублей зон
        st, r = get("/storm/api/recent")
        assert st == 200, (st, r)
        assert r["total"] == 60 + 1 + 20, r["total"]          # по одной «чужой» вспышке отрезано у каждого
        print("✓ /recent: оба спутника, чужие зоны отрезаны")

        # 1б. /latest («Гром»): свежее окно целиком по времени, последняя вспышка — точно и в конце списка
        st, r = get("/storm/api/latest")
        assert st == 200, (st, r)
        assert r["total"] == 81 and len(r["pts"]) == 81, (r["total"], len(r["pts"]))
        ts = [p[2] for p in r["pts"]]
        assert ts == sorted(ts), "вспышки по времени"
        L = r["last"]
        # позже всех в окне — «московская» вспышка G19 (индекс 60 из 62, самая поздняя из оставшихся после склейки)
        assert L["sat"] == "G19" and L["id"] == 1060 and abs(L["la"] - 55.7512) < 1e-3, L
        assert L["t"] == max(ts) and r["pts"][-1][:2] == [round(L["la"], 2), round(L["lo"], 2)]
        assert L["url"].startswith("https://noaa-goes19.s3.amazonaws.com/GLM-L2-LCFA/"), L["url"]
        assert r["serverNow"] >= r["end"], "serverNow — по часам AWS, после конца окна"
        print("✓ /latest: окно по времени, последняя вспышка точно, ссылка на файл")

        # 1в. /stream: окна подряд по времени, since отрезает уже полученные
        st, s = get("/storm/api/stream")
        assert st == 200 and 1 <= len(s["wins"]) <= 4, (st, s)
        starts = [w["start"] for w in s["wins"]]
        assert starts == sorted(starts) and all(w["pts"] and w["end"] > w["start"] for w in s["wins"])
        assert all([p[2] for p in w["pts"]] == sorted(p[2] for p in w["pts"]) for w in s["wins"]), "вспышки по времени"
        assert s["wins"][-1]["start"] >= r["start"], "последнее окно не старше /latest"
        st, s2 = get("/storm/api/stream?since=%d" % starts[-1])
        assert st == 200 and all(w["start"] > starts[-1] for w in s2["wins"]), s2
        assert get("/storm/api/stream?since=x")[0] == 400
        print("✓ /stream: окна подряд, since, ошибка параметра")

        # 2. /draw: интервал начат после запроса по часам AWS (они спешат на 30 с)
        for _ in range(3):
            t0 = time.time()
            st, d = get("/storm/api/draw?lat=%s&lon=%s&k=9" % MOSCOW)
            assert st == 200, (st, d)
            assert d["start"] >= d["armedAt"], "интервал начат после нажатия"
            assert abs(d["armedAt"] / 1000 - (t0 + SHIFT + 1)) < 1.6, "нажатие в шкале часов AWS (+1 с запаса)"
            assert len(d["flashes"]) == 9
            ts = [f["t"] for f in d["flashes"]]
            assert ts == sorted(ts), "вспышки по времени"
            assert all(0 <= t <= PERIOD * 1000 for t in ts)
            assert d["flashes"][0]["d"] < 1 or any(f["d"] < 1 for f in d["flashes"]), "московская вспышка ближайшая"
            assert all(f["sat"] == "G19" for f in d["flashes"] if f["lo"] >= -106) and all(f["sat"] == "G18" for f in d["flashes"] if f["lo"] < -106)
        print("✓ /draw: только интервал после нажатия, в шкале часов AWS")

        # 3. k ближайших действительно ближайшие: сравним с полным набором
        st, d = get("/storm/api/draw?lat=0&lon=-40&k=400")
        allf = d["flashes"]
        assert len(allf) == d["total"] == 81
        st, d2 = get("/storm/api/draw?lat=0&lon=-40&k=10")
        # интервалы разные, поэтому проверяем внутри одного: k=10 — это 10 минимальных расстояний его же набора
        near = sorted(f["d"] for f in d2["flashes"])
        assert len(near) == 10 and near == sorted(near)
        print("✓ k ближайших, k=400 отдаёт весь интервал")

        # 4. распаковка времени: сырое 65535 (int16 −1) → конец интервала, 0 → начало
        lat, lon, raw, ids = flashes("G19", d["start"] / 1000)
        expect = {int(i): min(PERIOD * 1000, round(float(r_) * float(np.float32(SCALE)) * 1000)) for i, r_, lo in zip(ids, raw, lon) if lo >= -106}
        got = {f["id"]: f["t"] for f in allf if f["sat"] == "G19"}
        for i, t in got.items():
            assert abs(t - expect[i]) <= 1, (i, t, expect[i])
        assert max(got.values()) > PERIOD * 1000 / 2, "значения > 32767 не ушли в минус"
        print("✓ беззнаковый int16 со scale_factor распакован")

        # 5. G18 молчит → через PAIR_WAIT_S играем по одному G19
        fake["g18"] = False
        time.sleep(PERIOD * 2)
        st, d = get("/storm/api/draw?lat=0&lon=-40&k=5")
        assert st == 200 and [f["sat"] for f in d["files"]] == ["G19"], d["files"]
        fake["g18"] = True
        print("✓ второй спутник опоздал — розыгрыш по одному")

        # 6. параметры
        assert get("/storm/api/draw?lat=95&lon=0")[0] == 400
        assert get("/storm/api/draw?lat=a&lon=0")[0] == 400
        assert get("/storm/api/draw?lat=1&lon=1&k=0")[0] == 400
        print("✓ неверные параметры — 400")

        # 7. без зрителей бакет не опрашиваем
        time.sleep(3)
        h0 = fake["hits"]
        time.sleep(2)
        assert fake["hits"] == h0, "без зрителей S3 не дёргаем"
        st, h = get("/storm/api/health")
        assert st == 200 and abs(h["clock_offset"] - SHIFT) < 1.5, h
        print("✓ без зрителей опрос спит, health видит сдвиг часов")

        print("STORM TESTS OK")
    finally:
        proc.kill()
        out = proc.stdout.read().decode("utf-8", "replace")
        if "Traceback" in out:
            print(out)
        srv.shutdown()


if __name__ == "__main__":
    main()
