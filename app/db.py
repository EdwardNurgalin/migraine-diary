import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get("DIARY_DB", Path(__file__).resolve().parent.parent / "data" / "diary.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS days(
  date TEXT PRIMARY KEY,
  headache INTEGER NOT NULL,
  factors TEXT NOT NULL DEFAULT '[]',
  period INTEGER NOT NULL DEFAULT 0,
  sleep_hours REAL,
  stress INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attacks(
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  intensity INTEGER NOT NULL,
  location TEXT NOT NULL DEFAULT '[]',
  character TEXT NOT NULL DEFAULT '[]',
  symptoms TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS attacks_date ON attacks(date);
CREATE TABLE IF NOT EXISTS meds(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  dose TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS doses(
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  attack_id INTEGER REFERENCES attacks(id) ON DELETE CASCADE,
  med_id INTEGER NOT NULL REFERENCES meds(id),
  time TEXT,
  effect TEXT
);
CREATE INDEX IF NOT EXISTS doses_date ON doses(date);
CREATE TABLE IF NOT EXISTS weather(
  date TEXT PRIMARY KEY,
  pressure REAL,
  pressure_delta REAL,
  temp REAL,
  humidity REAL
);
CREATE TABLE IF NOT EXISTS health(
  date TEXT PRIMARY KEY,
  sleep_hours REAL,
  resting_hr REAL,
  hrv REAL,
  steps INTEGER
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def init():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as c:
        c.executescript(SCHEMA)


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def get_setting(c, key, default=None):
    row = c.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(c, key, value):
    c.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )
