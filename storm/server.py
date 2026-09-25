"""
Молнии для «Грома» (thunder.html): вспышки со спутников NOAA GOES.

Детектор молний GLM на GOES-19 (восток) и GOES-18 (запад) каждые 20 секунд выкладывает файл
со всеми вспышками за интервал в открытые бакеты noaa-goes19 / noaa-goes18 на AWS. Данные —
общественное достояние. Браузер их не прочитает: у бакета нет CORS, а файлы в NetCDF4 (HDF5).
Поэтому сервис их скачивает, разбирает и отдаёт урезанными.

  GET /storm/api/draw?lat=&lon=&k=   ждёт первый интервал, который НАЧАЛСЯ после прихода запроса,
                                     и отдаёт k ближайших к точке вспышек из него. Подгадать нельзя:
                                     на момент нажатия этих молний ещё не было.
  GET /storm/api/recent              вспышки последнего готового интервала (прорежены) — фон, пока ждём
  GET /storm/api/latest              «Гром»: свежее окно целиком по времени, последняя вспышка — точно, с файлом
  GET /storm/api/stream?since=       «Гром», фон: до 4 готовых окон подряд — страница играет их без повторов
  GET /storm/api/health              жив ли процесс, возраст последнего файла по каждому спутнику

Зоны обзора спутников перекрываются, одна вспышка может прийти дважды — делим по долготе 106° з.д.:
восточнее берём только GOES-19, западнее только GOES-18.
Бакет опрашивается, только пока есть зрители: IDLE_S без запросов — опрос засыпает.
"""

import email.utils
import json
import math
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

import h5py
import numpy as np

PORT = int(os.environ.get("PORT", "3200"))
S3 = os.environ.get("STORM_S3", "https://{bucket}.s3.amazonaws.com/")
POLL_S = float(os.environ.get("POLL_S", "4"))
IDLE_S = float(os.environ.get("IDLE_S", "120"))
DRAW_TIMEOUT_S = float(os.environ.get("DRAW_TIMEOUT_S", "90"))
PAIR_WAIT_S = float(os.environ.get("PAIR_WAIT_S", "15"))   # второй спутник опоздал — играем по одному
KEEP_S = 600                                                # интервалы старше 10 минут выбрасываем
FETCH_TIMEOUT_S = 15
SPLIT_LON = -106.0
MAX_WAITERS = 300
UA = "randomhost.online-thunder/1.0 (+https://randomhost.online/thunder.html)"

SATS = [
    {"sat": "G19", "bucket": "noaa-goes19", "east": True},
    {"sat": "G18", "bucket": "noaa-goes18", "east": False},
]

KEY_RE = re.compile(r"_G(\d\d)_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_e(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_c")

lock = threading.Condition()
periods = {}          # start_ms → {"start", "end", "first_at", "sats": {sat: {...}}}
seen_keys = set()
last_client = 0.0
waiters = 0
sat_state = {s["sat"]: {"last_ok": 0.0, "last_err": ""} for s in SATS}


def log(*a):
    print(datetime.now(timezone.utc).strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def stamp_ms(y, doy, hh, mm, ss, tenth):
    d = datetime(int(y), 1, 1, tzinfo=timezone.utc).timestamp() + (int(doy) - 1) * 86400
    return int(round((d + int(hh) * 3600 + int(mm) * 60 + int(ss) + int(tenth) / 10) * 1000))


# Сдвиг наших часов относительно часов AWS. Интервал GLM подписан временем спутника, и «начался
# после нажатия» проверяется в той же шкале: если часы сервера отстают (на ноутбуке разработчика
# было −23 с), без поправки розыгрыш взял бы интервал, начавшийся ДО нажатия. Date в ответе S3
# точен до секунды — берём середину секунды и медиану последних замеров.
clock_samples = []


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
        body = r.read()
        date = r.headers.get("Date")
    t1 = time.time()
    if date and t1 - t0 < 2:
        try:
            remote = email.utils.parsedate_to_datetime(date).timestamp() + 0.5
            clock_samples.append(remote - (t0 + t1) / 2)
            del clock_samples[:-15]
        except (TypeError, ValueError):
            pass
    return body


def true_now():
    """Время по часам AWS, если удалось сверить, иначе наше."""
    if not clock_samples:
        return time.time()
    return time.time() + sorted(clock_samples)[len(clock_samples) // 2]


def list_keys(bucket, hour_ts):
    t = time.gmtime(hour_ts)
    prefix = "GLM-L2-LCFA/%04d/%03d/%02d/" % (t.tm_year, t.tm_yday, t.tm_hour)
    url = S3.format(bucket=bucket) + "?list-type=2&prefix=" + urllib.parse.quote(prefix)
    xml = http_get(url).decode("utf-8", "replace")
    return re.findall(r"<Key>([^<]+\.nc)</Key>", xml)


def unpack(ds):
    """int16 с _Unsigned/scale_factor/add_offset → float64, как это делает netCDF4."""
    a = ds[:]
    if ds.attrs.get("_Unsigned", b"") in (b"true", "true") and a.dtype.kind == "i":
        a = a.view(a.dtype.str.replace("i", "u"))
    a = a.astype(np.float64)
    if "scale_factor" in ds.attrs:
        a = a * float(np.asarray(ds.attrs["scale_factor"]).ravel()[0])
    if "add_offset" in ds.attrs:
        a = a + float(np.asarray(ds.attrs["add_offset"]).ravel()[0])
    return a


def parse(buf, east, start_ms, end_ms):
    with h5py.File(BytesIO(buf), "r") as f:
        if "flash_lat" not in f:
            return None
        lat = f["flash_lat"][:].astype(np.float64)
        lon = f["flash_lon"][:].astype(np.float64)
        t = unpack(f["flash_time_offset_of_first_event"])
        fid = unpack(f["flash_id"]).astype(np.int64)
    keep = (lon >= SPLIT_LON) if east else (lon < SPLIT_LON)
    keep &= np.isfinite(lat) & np.isfinite(lon) & (np.abs(lat) <= 90)
    span = end_ms - start_ms
    t_ms = np.clip(np.round(t * 1000), 0, span).astype(np.int64)   # вспышка, начатая в прошлом файле, — в начало
    return {"lat": lat[keep], "lon": lon[keep], "t": t_ms[keep], "id": fid[keep], "total": int(len(lat))}


def poll_sat(s, now):
    hours = {int(now // 3600) * 3600}
    if now % 3600 < 120:
        hours.add(int(now // 3600) * 3600 - 3600)
    keys = []
    for h in sorted(hours):
        keys += list_keys(s["bucket"], h)
    fresh = []
    for key in keys:
        if key in seen_keys:
            continue
        m = KEY_RE.search(key)
        if not m:
            continue
        start = stamp_ms(*m.group(2, 3, 4, 5, 6, 7))
        end = stamp_ms(*m.group(8, 9, 10, 11, 12, 13))
        if start < (now - 180) * 1000:          # старое не качаем — нужен только свежий хвост
            seen_keys.add(key)
            continue
        fresh.append((start, end, key))
    for start, end, key in sorted(fresh):
        buf = http_get(S3.format(bucket=s["bucket"]) + key)
        data = parse(buf, s["east"], start, end)
        seen_keys.add(key)
        if data is None:
            continue
        data["key"] = key
        data["url"] = "https://%s.s3.amazonaws.com/%s" % (s["bucket"], key)
        with lock:
            p = periods.setdefault(start, {"start": start, "end": end, "first_at": time.time(), "sats": {}})
            p["sats"][s["sat"]] = data
            lock.notify_all()


def poller():
    while True:
        now = true_now()
        active = time.time() - last_client < IDLE_S or waiters > 0
        if active:
            for s in SATS:
                try:
                    poll_sat(s, now)
                    sat_state[s["sat"]]["last_ok"] = time.time()
                except Exception as e:  # noqa: BLE001 — любой сбой источника не должен ронять опрос
                    sat_state[s["sat"]]["last_err"] = str(e)[:200]
                    log(s["sat"], "ошибка:", e)
            with lock:
                old = [k for k in periods if k < (true_now() - KEEP_S) * 1000]
                for k in old:
                    del periods[k]
                if len(seen_keys) > 5000:
                    seen_keys.clear()
                lock.notify_all()
        time.sleep(POLL_S if active else 1)


def ready(p):
    """Интервал готов: пришли оба спутника или второй опоздал больше чем на PAIR_WAIT_S."""
    return len(p["sats"]) == len(SATS) or (p["sats"] and time.time() - p["first_at"] > PAIR_WAIT_S)


def merged(p):
    parts = [p["sats"][s["sat"]] for s in SATS if s["sat"] in p["sats"]]
    sat = np.concatenate([np.full(len(d["lat"]), i) for i, d in enumerate(parts)]) if parts else np.zeros(0)
    names = [s["sat"] for s in SATS if s["sat"] in p["sats"]]
    return {
        "lat": np.concatenate([d["lat"] for d in parts]),
        "lon": np.concatenate([d["lon"] for d in parts]),
        "t": np.concatenate([d["t"] for d in parts]),
        "id": np.concatenate([d["id"] for d in parts]),
        "sat": sat.astype(np.int64),
        "names": names,
        "files": [{"sat": n, "key": d["key"], "url": d["url"], "total": d["total"]} for n, d in zip(names, parts)],
    }


def haversine_km(lat0, lon0, lat, lon):
    p0, p = math.radians(lat0), np.radians(lat)
    dp = p - p0
    dl = np.radians(lon - lon0)
    a = np.sin(dp / 2) ** 2 + math.cos(p0) * np.cos(p) * np.sin(dl / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(np.minimum(1, a)))


def nearest(p, lat0, lon0, k):
    m = merged(p)
    n = len(m["lat"])
    if n == 0:
        return m, []
    d = haversine_km(lat0, lon0, m["lat"], m["lon"])
    # при равном расстоянии порядок однозначный: время, потом номер вспышки
    order = np.lexsort((m["id"], m["t"], d))[:k]
    out = []
    for i in order:
        out.append({
            "id": int(m["id"][i]),
            "t": int(m["t"][i]),
            "la": round(float(m["lat"][i]), 4),
            "lo": round(float(m["lon"][i]), 4),
            "d": round(float(d[i]), 1),
            "sat": m["names"][int(m["sat"][i])],
        })
    out.sort(key=lambda f: (f["t"], f["id"], f["sat"]))
    return m, out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global last_client, waiters
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        now = time.time()

        if u.path == "/storm/api/health":
            with lock:
                done = [p for p in periods.values() if ready(p)]
                latest = max(done, key=lambda p: p["start"]) if done else None
            return self.send(200, {
                "ok": True,
                "latest": latest["start"] if latest else None,
                "age": round(true_now() - latest["end"] / 1000, 1) if latest else None,
                "clock_offset": round(true_now() - now, 1),
                "sats": {k: {"age": round(now - v["last_ok"], 1) if v["last_ok"] else None, "err": v["last_err"]} for k, v in sat_state.items()},
                "waiters": waiters,
            })

        if u.path == "/storm/api/recent":
            last_client = now
            with lock:
                done = [p for p in periods.values() if ready(p)]
                if not done:
                    lock.wait_for(lambda: any(ready(p) for p in periods.values()), timeout=25)
                    done = [p for p in periods.values() if ready(p)]
                if not done:
                    return self.send(503, {"error": "no data"})
                p = max(done, key=lambda p: p["start"])
                m = merged(p)
            n = len(m["lat"])
            step = max(1, math.ceil(n / 1500))
            pts = [[round(float(m["lat"][i]), 2), round(float(m["lon"][i]), 2)] for i in range(0, n, step)]
            return self.send(200, {"start": p["start"], "end": p["end"], "total": n, "pts": pts})

        # «Гром», фон до нажатия: готовые окна подряд (start > since, не больше 4), чтобы страница
        # проиграла каждую настоящую вспышку один раз в её время — с постоянной задержкой, без повторов.
        if u.path == "/storm/api/stream":
            last_client = now
            try:
                since = int(q.get("since", ["0"])[0])
            except ValueError:
                return self.send(400, {"error": "since"})
            with lock:
                if not any(ready(p) for p in periods.values()):
                    lock.wait_for(lambda: any(ready(p) for p in periods.values()), timeout=25)
                done = sorted((p for p in periods.values() if ready(p) and p["start"] > since), key=lambda p: p["start"])[-4:]
                wins = [(p, merged(p)) for p in done]
            out = []
            for p, m in wins:
                n = len(m["lat"])
                order = np.argsort(m["t"], kind="stable")
                step = max(1, math.ceil(n / 800))
                out.append({"start": p["start"], "end": p["end"], "total": n,
                            "pts": [[round(float(m["lat"][i]), 2), round(float(m["lon"][i]), 2), int(m["t"][i])] for i in order[::step]]})
            return self.send(200, {"serverNow": int(true_now() * 1000), "wins": out})

        # «Гром» (thunder.html): самое свежее готовое окно целиком. Последняя вспышка — точно, с файлом;
        # остальные — по времени, для повтора грозы (прорежены до 1200, последняя всегда в списке).
        # Окно без единой вспышки пропускаем — берём предыдущее. serverNow — чтобы страница честно
        # написала «ударила N секунд назад», не завися от часов посетителя.
        if u.path == "/storm/api/latest":
            last_client = now
            with lock:
                if not any(ready(p) for p in periods.values()):
                    lock.wait_for(lambda: any(ready(p) for p in periods.values()), timeout=25)
                done = sorted((p for p in periods.values() if ready(p)), key=lambda p: -p["start"])
                pick = None
                for p in done:
                    m = merged(p)
                    if len(m["lat"]):
                        pick = (p, m)
                        break
            if pick is None:
                return self.send(503, {"error": "no data"})
            p, m = pick
            n = len(m["lat"])
            order = np.lexsort((m["id"], m["t"]))          # по времени, при равенстве — по номеру
            li = int(order[-1])
            step = max(1, math.ceil(n / 1200))
            idx = list(order[::step])
            if idx[-1] != li:
                idx.append(li)
            sat = m["names"][int(m["sat"][li])]
            file = next(f for f in m["files"] if f["sat"] == sat)
            return self.send(200, {
                "start": p["start"],
                "end": p["end"],
                "total": n,
                "serverNow": int(true_now() * 1000),
                "pts": [[round(float(m["lat"][i]), 2), round(float(m["lon"][i]), 2), int(m["t"][i])] for i in idx],
                "last": {
                    "id": int(m["id"][li]),
                    "t": int(m["t"][li]),
                    "la": round(float(m["lat"][li]), 4),
                    "lo": round(float(m["lon"][li]), 4),
                    "sat": sat,
                    "url": file["url"],
                },
            })

        if u.path == "/storm/api/draw":
            try:
                lat0 = float(q["lat"][0])
                lon0 = float(q["lon"][0])
                k = int(q.get("k", ["41"])[0])
            except (KeyError, ValueError):
                return self.send(400, {"error": "lat, lon"})
            if not (-90 <= lat0 <= 90 and -180 <= lon0 <= 180 and 1 <= k <= 400):
                return self.send(400, {"error": "range"})
            # +1 с — запас на погрешность сверки часов: лучше подождать лишний интервал, чем взять ранний
            armed = int((true_now() + 1) * 1000)
            last_client = time.time()
            with lock:
                if waiters >= MAX_WAITERS:
                    return self.send(503, {"error": "busy"})
                waiters += 1
                try:
                    def target():
                        c = [p for p in periods.values() if p["start"] >= armed]
                        return min(c, key=lambda p: p["start"]) if c else None

                    def got():
                        p = target()
                        return p is not None and ready(p)

                    ok = lock.wait_for(got, timeout=DRAW_TIMEOUT_S)
                    p = target() if ok else None
                    if p is None:
                        return self.send(504, {"error": "timeout", "armedAt": armed})
                    m, flashes = nearest(p, lat0, lon0, k)
                finally:
                    waiters -= 1
            return self.send(200, {
                "armedAt": armed,
                "start": p["start"],
                "end": p["end"],
                "total": int(len(m["lat"])),
                "files": m["files"],
                "flashes": flashes,
            })

        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    threading.Thread(target=poller, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    log("storm: порт", PORT)
    srv.serve_forever()
