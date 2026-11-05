"""Diary modules and factors. The single source of truth for both the form and the analysis.

Factor types:
  level - 0 нет, 1 немного, 2 заметно, 3 сильно
  count - whole number (cups, drinks)
  hours - hours, step 0.5
  bool  - yes / no
`exposed` is the threshold from which a day counts as "the factor was present" in the analysis.
"""

MODULES = [
    {"key": "emotions", "title": "Эмоции", "icon": "🙂", "factors": [
        {"key": "stress", "label": "Стресс", "icon": "😣", "type": "level", "exposed": 2},
        {"key": "anxiety", "label": "Тревога", "icon": "😟", "type": "level", "exposed": 2},
        {"key": "sadness", "label": "Грусть", "icon": "😔", "type": "level", "exposed": 2},
        {"key": "irritation", "label": "Раздражение", "icon": "😠", "type": "level", "exposed": 2},
        {"key": "relax", "label": "Расслабилась после стресса", "icon": "😌", "type": "bool", "exposed": True},
    ]},
    {"key": "sleep", "title": "Сон", "icon": "🌙", "factors": [
        {"key": "sleep_bad", "label": "Плохое качество сна", "icon": "🛌", "type": "level", "exposed": 2},
        {"key": "wakeups", "label": "Просыпалась ночью", "icon": "⏰", "type": "count", "exposed": 2, "max": 10},
        {"key": "nap", "label": "Спала днём", "icon": "💤", "type": "bool", "exposed": True},
        {"key": "sleep_late", "label": "Легла позже обычного", "icon": "🕐", "type": "bool", "exposed": True},
    ]},
    {"key": "diet", "title": "Питание", "icon": "🍽", "factors": [
        {"key": "meal_skip", "label": "Пропустила приём пищи", "icon": "🍽", "type": "bool", "exposed": True},
        {"key": "coffee", "label": "Кофе, чашек", "icon": "☕", "type": "count", "exposed": 3, "max": 10},
        {"key": "caffeine_less", "label": "Меньше кофе, чем обычно", "icon": "🫗", "type": "bool", "exposed": True},
        {"key": "alcohol", "label": "Алкоголь, порций", "icon": "🍷", "type": "count", "exposed": 1, "max": 10},
        {"key": "chocolate", "label": "Шоколад", "icon": "🍫", "type": "bool", "exposed": True},
        {"key": "water_low", "label": "Мало воды", "icon": "💧", "type": "bool", "exposed": True},
    ]},
    {"key": "lifestyle", "title": "Образ жизни", "icon": "🏃", "factors": [
        {"key": "exercise", "label": "Физическая нагрузка", "icon": "🏃", "type": "level", "exposed": 2},
        {"key": "outside", "label": "Время на улице, часов", "icon": "🌳", "type": "hours", "exposed": 1, "max": 16},
        {"key": "screen", "label": "За экраном, часов", "icon": "💻", "type": "hours", "exposed": 6, "max": 18},
        {"key": "overwork", "label": "Много работы", "icon": "📋", "type": "bool", "exposed": True},
    ]},
    {"key": "environment", "title": "Окружение", "icon": "🌆", "factors": [
        {"key": "bright_light", "label": "Яркий или мерцающий свет", "icon": "💡", "type": "bool", "exposed": True},
        {"key": "smell", "label": "Резкие запахи", "icon": "👃", "type": "bool", "exposed": True},
        {"key": "noise", "label": "Шум", "icon": "🔊", "type": "bool", "exposed": True},
        {"key": "stuffy", "label": "Духота или жара", "icon": "🥵", "type": "bool", "exposed": True},
    ]},
    {"key": "travel", "title": "Поездки", "icon": "✈", "factors": [
        {"key": "travel", "label": "Поездка или перелёт", "icon": "✈", "type": "bool", "exposed": True},
        {"key": "timezone", "label": "Смена часового пояса", "icon": "🌐", "type": "bool", "exposed": True},
    ]},
    {"key": "women", "title": "Женское здоровье", "icon": "♀", "factors": [
        # `period` is stored in its own column; the form shows it here.
        {"key": "pms", "label": "ПМС", "icon": "🌸", "type": "bool", "exposed": True},
        {"key": "ovulation", "label": "Овуляция", "icon": "🌼", "type": "bool", "exposed": True},
    ]},
]

FACTORS = {f["key"]: f for m in MODULES for f in m["factors"]}

# Factors the server derives itself rather than asking for.
DERIVED = {
    "period": {"label": "Менструация", "icon": "🩸"},
    "sleep_short": {"label": "Сон меньше 6 часов", "icon": "🌙"},
    "pressure_jump": {"label": "Скачок давления ≥5 гПа", "icon": "🌦"},
}

DEFAULT_MODULES = [m["key"] for m in MODULES]


def is_exposed(key, value):
    f = FACTORS.get(key)
    if f is None or value is None:
        return False
    if f["type"] == "bool":
        return bool(value)
    return float(value) >= f["exposed"]


def validate_value(key, value):
    f = FACTORS.get(key)
    if f is None:
        return False
    if f["type"] == "bool":
        return isinstance(value, bool)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    hi = 3 if f["type"] == "level" else f.get("max", 24)
    return 0 <= value <= hi
