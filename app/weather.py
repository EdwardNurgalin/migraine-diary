"""Daily weather from Open-Meteo (free, no API key)."""
from collections import defaultdict
from datetime import datetime, timedelta

import httpx

from . import db

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
REFRESH_EVERY = timedelta(hours=6)


def geocode(query):
    r = httpx.get(GEOCODE_URL, params={"name": query, "count": 5, "language": "ru"}, timeout=10)
    r.raise_for_status()
    return [
        {
            "name": x["name"],
            "region": ", ".join(p for p in (x.get("admin1"), x.get("country")) if p),
            "lat": x["latitude"],
            "lon": x["longitude"],
            "timezone": x.get("timezone", "auto"),
        }
        for x in r.json().get("results", [])
    ]


def refresh(c, force=False):
    """Fetch the last ~3 months of hourly data and store daily means. No-op if fresh or no city set."""
    city = db.get_setting(c, "city")
    if not city:
        return
    last = db.get_setting(c, "weather_fetched_at")
    if not force and last and datetime.now() - datetime.fromisoformat(last) < REFRESH_EVERY:
        return
    r = httpx.get(
        FORECAST_URL,
        params={
            "latitude": city["lat"],
            "longitude": city["lon"],
            "hourly": "pressure_msl,temperature_2m,relative_humidity_2m",
            "past_days": 92,
            "forecast_days": 1,
            "timezone": city.get("timezone") or "auto",
        },
        timeout=20,
    )
    r.raise_for_status()
    hourly = r.json()["hourly"]

    buckets = defaultdict(lambda: {"p": [], "t": [], "h": []})
    for i, ts in enumerate(hourly["time"]):
        b = buckets[ts[:10]]
        for key, src in (("p", "pressure_msl"), ("t", "temperature_2m"), ("h", "relative_humidity_2m")):
            v = hourly[src][i]
            if v is not None:
                b[key].append(v)

    mean = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    dates = sorted(buckets)
    row = c.execute("SELECT pressure FROM weather WHERE date = date(?, '-1 day')", (dates[0],)).fetchone()
    prev_pressure = row["pressure"] if row else None
    for date in dates:
        b = buckets[date]
        pressure = mean(b["p"])
        delta = round(pressure - prev_pressure, 1) if pressure is not None and prev_pressure is not None else None
        c.execute(
            "INSERT OR REPLACE INTO weather(date, pressure, pressure_delta, temp, humidity) VALUES(?,?,?,?,?)",
            (date, pressure, delta, mean(b["t"]), mean(b["h"])),
        )
        prev_pressure = pressure
    db.set_setting(c, "weather_fetched_at", datetime.now().isoformat(timespec="seconds"))
