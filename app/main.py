import csv
import io
import json
import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Optional, Union

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, db, stats, weather

log = logging.getLogger("diary")
STATIC = Path(__file__).resolve().parent / "static"
# When set, every API call must send it in the X-Token header. Leave empty only for local use.
ACCESS_TOKEN = os.environ.get("DIARY_TOKEN", "")

MED_KINDS = {"simple", "triptan", "combo", "opioid", "ergot", "preventive", "other"}
EFFECTS = {"full", "partial", "none", None}

@asynccontextmanager
async def lifespan(_app):
    db.init()
    yield


app = FastAPI(title="Дневник головной боли", lifespan=lifespan)


def require_token(x_token: str = Header(default="")):
    if ACCESS_TOKEN and not secrets.compare_digest(x_token, ACCESS_TOKEN):
        raise HTTPException(401, "Неверный ключ доступа")


api = Depends(require_token)


def parse_date(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"Некорректная дата: {s}")


def try_refresh_weather(c):
    try:
        weather.refresh(c)
    except Exception as e:  # weather is a nice-to-have; never break the diary because of it
        log.warning("weather refresh failed: %s", e)


# ---------- days ----------

class DoseIn(BaseModel):
    med_id: int
    time: Optional[str] = None
    effect: Optional[str] = None


class AttackIn(BaseModel):
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    intensity: int = Field(ge=1, le=10)
    location: list[str] = []
    character: list[str] = []
    symptoms: list[str] = []
    note: str = ""
    doses: list[DoseIn] = []


class DayIn(BaseModel):
    headache: bool
    # {factor key: value}, see config.MODULES. Only answered factors are sent.
    factors: dict[str, Union[bool, int, float]] = {}
    period: bool = False
    sleep_hours: Optional[float] = Field(default=None, ge=0, le=24)
    note: str = ""
    attacks: list[AttackIn] = []
    # Doses taken on a day without a logged attack (e.g. preventive medication).
    doses: list[DoseIn] = []


def load_day(c, d: str):
    day = c.execute("SELECT * FROM days WHERE date = ?", (d,)).fetchone()
    attacks = c.execute("SELECT * FROM attacks WHERE date = ? ORDER BY start_time", (d,)).fetchall()
    doses = c.execute("SELECT * FROM doses WHERE date = ? ORDER BY time", (d,)).fetchall()
    w = c.execute("SELECT * FROM weather WHERE date = ?", (d,)).fetchone()
    h = c.execute("SELECT * FROM health WHERE date = ?", (d,)).fetchone()
    return {
        "date": d,
        "day": {**dict(day), "factors": stats.load_factors(day["factors"])} if day else None,
        "attacks": [
            {**stats.parse_attack(a), "doses": [dict(x) for x in doses if x["attack_id"] == a["id"]]}
            for a in attacks
        ],
        "doses": [dict(x) for x in doses if x["attack_id"] is None],
        "weather": dict(w) if w else None,
        "health": dict(h) if h else None,
    }


@app.get("/api/day/{d}", dependencies=[api])
def get_day(d: str):
    parse_date(d)
    with db.connect() as c:
        return load_day(c, d)


@app.put("/api/day/{d}", dependencies=[api])
def put_day(d: str, body: DayIn):
    if parse_date(d) > date.today():
        raise HTTPException(400, "Нельзя заполнять будущие дни")
    all_doses = body.doses + [x for a in body.attacks for x in a.doses]
    with db.connect() as c:
        known = {r["id"] for r in c.execute("SELECT id FROM meds")}
        for x in all_doses:
            if x.med_id not in known:
                raise HTTPException(400, "Неизвестное лекарство")
            if x.effect not in EFFECTS:
                raise HTTPException(400, "Некорректный эффект")
        for k, v in body.factors.items():
            if not config.validate_value(k, v):
                raise HTTPException(400, f"Некорректное значение фактора: {k}")

        c.execute(
            "INSERT INTO days(date, headache, factors, period, sleep_hours, stress, note, updated_at) "
            "VALUES(?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(date) DO UPDATE SET "
            "headache=excluded.headache, factors=excluded.factors, period=excluded.period, "
            "sleep_hours=excluded.sleep_hours, stress=excluded.stress, note=excluded.note, updated_at=excluded.updated_at",
            (d, int(body.headache), json.dumps(body.factors),
             int(body.period), body.sleep_hours, body.factors.get("stress"), body.note),
        )
        # Attacks and doses for the day are replaced wholesale: the form always sends the full day.
        c.execute("DELETE FROM doses WHERE date = ?", (d,))
        c.execute("DELETE FROM attacks WHERE date = ?", (d,))
        for a in body.attacks if body.headache else []:
            cur = c.execute(
                "INSERT INTO attacks(date, start_time, end_time, intensity, location, character, symptoms, note) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (d, a.start_time, a.end_time, a.intensity, json.dumps(a.location), json.dumps(a.character),
                 json.dumps(a.symptoms), a.note),
            )
            for x in a.doses:
                c.execute("INSERT INTO doses(date, attack_id, med_id, time, effect) VALUES(?,?,?,?,?)",
                          (d, cur.lastrowid, x.med_id, x.time, x.effect))
        for x in body.doses:
            c.execute("INSERT INTO doses(date, attack_id, med_id, time, effect) VALUES(?,?,?,?,?)",
                      (d, None, x.med_id, x.time, x.effect))
        return load_day(c, d)


@app.delete("/api/day/{d}", dependencies=[api])
def delete_day(d: str):
    parse_date(d)
    with db.connect() as c:
        c.execute("DELETE FROM doses WHERE date = ?", (d,))
        c.execute("DELETE FROM attacks WHERE date = ?", (d,))
        c.execute("DELETE FROM days WHERE date = ?", (d,))
    return {"ok": True}


# ---------- calendar & stats ----------

@app.get("/api/month/{ym}", dependencies=[api])
def get_month(ym: str):
    start = parse_date(f"{ym}-01")
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    with db.connect() as c:
        try_refresh_weather(c)
        s = stats.summary(c, start, end)
    return {k: s[k] for k in ("from", "to", "series", "headache_days", "migraine_days", "pain_free_days",
                              "med_days", "logged_days", "overuse")}


@app.get("/api/stats", dependencies=[api])
def get_stats(start: str = Query(alias="from"), end: str = Query(alias="to")):
    s, e = parse_date(start), parse_date(end)
    if e < s or (e - s).days > 366:
        raise HTTPException(400, "Период должен быть не длиннее года")
    with db.connect() as c:
        try_refresh_weather(c)
        return stats.summary(c, s, e)


# ---------- medications ----------

class MedIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    dose: str = Field(default="", max_length=40)
    kind: str
    active: bool = True


@app.get("/api/meds", dependencies=[api])
def list_meds():
    with db.connect() as c:
        return [dict(r) for r in c.execute("SELECT * FROM meds ORDER BY active DESC, name")]


@app.post("/api/meds", dependencies=[api])
def add_med(m: MedIn):
    if m.kind not in MED_KINDS:
        raise HTTPException(400, "Неизвестный тип лекарства")
    with db.connect() as c:
        cur = c.execute("INSERT INTO meds(name, dose, kind, active) VALUES(?,?,?,?)",
                        (m.name.strip(), m.dose.strip(), m.kind, int(m.active)))
        return dict(c.execute("SELECT * FROM meds WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/meds/{med_id}", dependencies=[api])
def update_med(med_id: int, m: MedIn):
    if m.kind not in MED_KINDS:
        raise HTTPException(400, "Неизвестный тип лекарства")
    with db.connect() as c:
        c.execute("UPDATE meds SET name=?, dose=?, kind=?, active=? WHERE id=?",
                  (m.name.strip(), m.dose.strip(), m.kind, int(m.active), med_id))
        return {"ok": True}


# ---------- settings & weather ----------

class SettingsIn(BaseModel):
    city: Optional[dict] = None
    reminder_time: Optional[str] = None
    modules: Optional[list[str]] = None


@app.get("/api/config", dependencies=[api])
def get_config():
    """Diary modules/factors for the form, plus which modules are switched on."""
    with db.connect() as c:
        enabled = db.get_setting(c, "modules", config.DEFAULT_MODULES)
    return {"modules": config.MODULES, "derived": config.DERIVED, "enabled": enabled}


@app.get("/api/settings", dependencies=[api])
def get_settings():
    with db.connect() as c:
        return {"city": db.get_setting(c, "city"), "reminder_time": db.get_setting(c, "reminder_time", "21:00"),
                "modules": db.get_setting(c, "modules", config.DEFAULT_MODULES)}


@app.put("/api/settings", dependencies=[api])
def put_settings(s: SettingsIn):
    with db.connect() as c:
        if s.modules is not None:
            known = {m["key"] for m in config.MODULES}
            db.set_setting(c, "modules", [m for m in s.modules if m in known])
        if s.city is not None:
            city_changed = s.city != db.get_setting(c, "city")
            db.set_setting(c, "city", s.city)
            if city_changed:
                c.execute("DELETE FROM weather")
                try:
                    weather.refresh(c, force=True)
                except Exception as e:
                    log.warning("weather refresh failed: %s", e)
        if s.reminder_time is not None:
            db.set_setting(c, "reminder_time", s.reminder_time)
    return get_settings()


@app.get("/api/geocode", dependencies=[api])
def geocode(q: str = Query(min_length=2)):
    try:
        return weather.geocode(q)
    except Exception:
        raise HTTPException(502, "Сервис поиска городов недоступен")


# ---------- health data (from an iPhone Shortcut) ----------

class HealthIn(BaseModel):
    date: Optional[str] = None
    sleep_hours: Optional[float] = None
    resting_hr: Optional[float] = None
    hrv: Optional[float] = None
    steps: Optional[int] = None


@app.post("/api/health", dependencies=[api])
def post_health(h: HealthIn):
    d = h.date[:10] if h.date else date.today().isoformat()
    parse_date(d)
    with db.connect() as c:
        c.execute(
            "INSERT INTO health(date, sleep_hours, resting_hr, hrv, steps) VALUES(?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
            "sleep_hours=coalesce(excluded.sleep_hours, sleep_hours), resting_hr=coalesce(excluded.resting_hr, resting_hr), "
            "hrv=coalesce(excluded.hrv, hrv), steps=coalesce(excluded.steps, steps)",
            (d, h.sleep_hours, h.resting_hr, h.hrv, h.steps),
        )
    return {"ok": True, "date": d}


# ---------- export ----------

@app.get("/api/export.csv", dependencies=[api])
def export_csv():
    with db.connect() as c:
        rows = c.execute(
            "SELECT d.date, d.headache, d.factors, d.period, d.sleep_hours, d.stress, d.note AS day_note, "
            "a.start_time, a.end_time, a.intensity, a.location, a.character, a.symptoms, a.note AS attack_note, "
            "(SELECT group_concat(m.name || ' ' || m.dose || ' [' || coalesce(x.effect,'?') || ']', '; ') "
            "   FROM doses x JOIN meds m ON m.id = x.med_id WHERE x.attack_id = a.id) AS meds, "
            "w.pressure, w.pressure_delta, w.temp, w.humidity, h.hrv, h.resting_hr "
            "FROM days d LEFT JOIN attacks a ON a.date = d.date LEFT JOIN weather w ON w.date = d.date "
            "LEFT JOIN health h ON h.date = d.date ORDER BY d.date, a.start_time"
        ).fetchall()
    buf = io.StringIO()
    buf.write("﻿")  # BOM so Excel opens Cyrillic correctly
    w = csv.writer(buf, delimiter=";")
    if rows:
        w.writerow(rows[0].keys())
    w.writerows([tuple(r) for r in rows])
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": "attachment; filename=headache-diary.csv"})


# ---------- PWA shell ----------

@app.get("/sw.js")
def service_worker():
    # Served from the root so its scope covers the whole app.
    return FileResponse(STATIC / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
