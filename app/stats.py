"""Aggregates for the stats screen and the doctor report."""
import json
from collections import Counter, defaultdict
from datetime import date, timedelta

from . import config

# ICHD-3 medication-overuse thresholds: days per month with acute medication.
# Triptans, ergots, opioids and combination analgesics: >=10 days; simple analgesics/NSAIDs: >=15 days;
# any mix of acute classes: >=10 days.
OVERUSE_LIMITS = {"specific": 10, "simple": 15, "any": 10}
SPECIFIC_KINDS = {"triptan", "ergot", "opioid", "combo"}
ACUTE_KINDS = SPECIFIC_KINDS | {"simple"}

# Factor analysis is only shown once there is enough data for it to mean anything.
MIN_DAYS_FOR_FACTORS = 30
MIN_FACTOR_DAYS = 5
TRIGGER_RATIO = 1.5
PROTECTOR_RATIO = 0.67


def date_range(start, end):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def load_factors(raw):
    """Factors used to be a list of keys; now a {key: value} dict."""
    data = json.loads(raw or "{}")
    return {k: True for k in data} if isinstance(data, list) else data


def is_migraine(attack):
    """Rough ICHD-3 migraine features for a single attack (criteria C and D, or aura).

    It is a hint for the diary and the doctor, not a diagnosis.
    """
    location, character, symptoms = (set(attack[k]) for k in ("location", "character", "symptoms"))
    if "aura" in symptoms:
        return True
    c = sum([
        bool(location & {"left", "right", "eye"}),
        "pulsating" in character,
        attack["intensity"] >= 4,
        "movement" in symptoms,
    ])
    d = bool(symptoms & {"nausea", "vomiting"}) or {"photo", "phono"} <= symptoms
    return c >= 2 and d


def parse_attack(a):
    a = dict(a)
    for k in ("location", "character", "symptoms"):
        a[k] = json.loads(a[k])
    a["migraine"] = is_migraine(a)
    return a


def overuse(c, end=None):
    """Distinct days with acute medication over the 30 days ending at `end`."""
    end = min(end or date.today(), date.today())
    start = end - timedelta(days=29)
    rows = c.execute(
        "SELECT DISTINCT d.date, m.kind FROM doses d JOIN meds m ON m.id = d.med_id WHERE d.date BETWEEN ? AND ?",
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    days = {"specific": set(), "simple": set(), "any": set()}
    for r in rows:
        if r["kind"] not in ACUTE_KINDS:
            continue
        days["any"].add(r["date"])
        days["specific" if r["kind"] in SPECIFIC_KINDS else "simple"].add(r["date"])

    result = {}
    worst = "ok"
    for key, limit in OVERUSE_LIMITS.items():
        n = len(days[key])
        status = "over" if n >= limit else "warn" if n >= limit - 2 else "ok"
        result[key] = {"days": n, "limit": limit, "status": status}
        if status == "over" or (status == "warn" and worst == "ok"):
            worst = status
    result["status"] = worst
    result["from"], result["to"] = start.isoformat(), end.isoformat()
    return result


def summary(c, start, end):
    s, e = start.isoformat(), end.isoformat()
    days = {r["date"]: r for r in c.execute("SELECT * FROM days WHERE date BETWEEN ? AND ?", (s, e))}
    attacks = [parse_attack(a) for a in
               c.execute("SELECT * FROM attacks WHERE date BETWEEN ? AND ? ORDER BY date, start_time", (s, e))]
    doses = c.execute(
        "SELECT d.*, m.name, m.dose AS med_dose, m.kind FROM doses d JOIN meds m ON m.id = d.med_id "
        "WHERE d.date BETWEEN ? AND ? ORDER BY d.date, d.time",
        (s, e),
    ).fetchall()
    weather = {r["date"]: dict(r) for r in c.execute("SELECT * FROM weather WHERE date BETWEEN ? AND ?", (s, e))}
    health = {r["date"]: dict(r) for r in c.execute("SELECT * FROM health WHERE date BETWEEN ? AND ?", (s, e))}

    max_intensity = defaultdict(int)
    migraine_days = set()
    for a in attacks:
        max_intensity[a["date"]] = max(max_intensity[a["date"]], a["intensity"])
        if a["migraine"]:
            migraine_days.add(a["date"])
    med_days = {d["date"] for d in doses if d["kind"] in ACUTE_KINDS}
    headache_days = {d for d, r in days.items() if r["headache"]}

    series = []
    for d in date_range(start, end):
        k = d.isoformat()
        w, h, day = weather.get(k, {}), health.get(k, {}), days.get(k)
        series.append({
            "date": k,
            "logged": day is not None,
            "headache": k in headache_days,
            "type": None if day is None else "migraine" if k in migraine_days else "headache" if k in headache_days else "none",
            "intensity": max_intensity.get(k, 0),
            "meds": k in med_days,
            "period": bool(day and day["period"]),
            "pressure": w.get("pressure"),
            "pressure_delta": w.get("pressure_delta"),
            "temp": w.get("temp"),
            "sleep": (day["sleep_hours"] if day and day["sleep_hours"] is not None else h.get("sleep_hours")),
            "hrv": h.get("hrv"),
        })

    # Medication effectiveness: share of doses with full / partial / no relief.
    eff = defaultdict(Counter)
    for d in doses:
        eff[(d["name"], d["med_dose"])][d["effect"] or "unknown"] += 1
    med_effect = [
        {"name": name, "dose": dose, "count": sum(cnt.values()), **{k: cnt.get(k, 0) for k in ("full", "partial", "none", "unknown")}}
        for (name, dose), cnt in sorted(eff.items(), key=lambda x: -sum(x[1].values()))
    ]

    symptoms, locations, characters = Counter(), Counter(), Counter()
    for a in attacks:
        symptoms.update(a["symptoms"])
        locations.update(a["location"])
        characters.update(a["character"])

    return {
        "from": s,
        "to": e,
        "logged_days": len(days),
        "total_days": (end - start).days + 1,
        "headache_days": len(headache_days),
        "migraine_days": len(migraine_days),
        "pain_free_days": len(days) - len(headache_days),
        "attack_count": len(attacks),
        "avg_intensity": round(sum(a["intensity"] for a in attacks) / len(attacks), 1) if attacks else None,
        "med_days": len(med_days),
        "series": series,
        "med_effect": med_effect,
        "symptoms": symptoms.most_common(),
        "locations": locations.most_common(),
        "characters": characters.most_common(),
        "factors": factor_analysis(days, series),
        "attacks": [{**a, "doses": [dict(d) for d in doses if d["attack_id"] == a["id"]]} for a in attacks],
        "overuse": overuse(c, end),
    }


def factor_analysis(days, series):
    """Compare how often the head hurts on days with vs. without each factor.

    A factor counts only on days where it was answered (missing key = unknown, not "no").
    """
    logged = list(days.values())
    if len(logged) < MIN_DAYS_FOR_FACTORS:
        return {"ready": False, "need": MIN_DAYS_FOR_FACTORS, "have": len(logged), "items": []}

    answered, exposed = defaultdict(set), defaultdict(set)
    for r in logged:
        for k, v in load_factors(r["factors"]).items():
            if k not in config.FACTORS:
                continue
            answered[k].add(r["date"])
            if config.is_exposed(k, v):
                exposed[k].add(r["date"])
        answered["period"].add(r["date"])
        if r["period"]:
            exposed["period"].add(r["date"])
    for p in series:
        if not p["logged"]:
            continue
        if p["pressure_delta"] is not None:
            answered["pressure_jump"].add(p["date"])
            if abs(p["pressure_delta"]) >= 5:
                exposed["pressure_jump"].add(p["date"])
        if p["sleep"] is not None:
            answered["sleep_short"].add(p["date"])
            if p["sleep"] < 6:
                exposed["sleep_short"].add(p["date"])

    headache = {r["date"] for r in logged if r["headache"]}
    items = []
    for f, base in answered.items():
        with_f = exposed[f]
        without_f = base - with_f
        if len(with_f) < MIN_FACTOR_DAYS or len(without_f) < MIN_FACTOR_DAYS:
            continue
        p_with = len(with_f & headache) / len(with_f)
        p_without = len(without_f & headache) / len(without_f)
        ratio = p_with / p_without if p_without else (None if p_with else 1.0)
        kind = ("trigger" if ratio is None or ratio >= TRIGGER_RATIO
                else "protector" if ratio <= PROTECTOR_RATIO else "neutral")
        items.append({
            "factor": f,
            "days": len(with_f),
            "p_with": round(p_with, 2),
            "p_without": round(p_without, 2),
            "ratio": round(ratio, 2) if ratio is not None else None,
            "kind": kind,
        })
    # No ratio means the head never hurt without the factor: the strongest association, so it goes first.
    items.sort(key=lambda x: -(x["ratio"] if x["ratio"] is not None else float("inf")))
    return {"ready": True, "have": len(logged), "preliminary": len(logged) < 90, "items": items}
