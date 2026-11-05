"""Draws the app icons (teal square, white page with a pulse line) without any image libraries."""
import math
import struct
import sys
import zlib
from pathlib import Path

TEAL = (42, 140, 130)
WHITE = (255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "app" / "static" / "icons"

# Pulse line across the page, in unit coordinates.
PULSE = [(0.30, 0.56), (0.42, 0.56), (0.48, 0.42), (0.55, 0.70), (0.61, 0.50), (0.66, 0.56), (0.72, 0.56)]


def seg_dist(px, py, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def pixel(x, y):
    # Rounded white "card" in the middle (safe zone for maskable icons).
    cx, cy, hw, hh, r = 0.5, 0.5, 0.26, 0.30, 0.06
    qx, qy = max(abs(x - cx) - (hw - r), 0), max(abs(y - cy) - (hh - r), 0)
    inside = math.hypot(qx, qy) <= r
    if not inside:
        return TEAL
    if any(seg_dist(x, y, PULSE[i], PULSE[i + 1]) < 0.022 for i in range(len(PULSE) - 1)):
        return TEAL
    # Two short "text" lines above the pulse.
    for ly, lx2 in ((0.33, 0.62), (0.40, 0.52)):
        if abs(y - ly) < 0.012 and 0.33 <= x <= lx2:
            return (190, 220, 216)
    return WHITE


def png(size):
    ss = 3  # supersampling for smooth edges
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            acc = [0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    c = pixel((i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size)
                    acc = [a + b for a, b in zip(acc, c)]
            row += bytes(round(a / ss / ss) for a in acc)
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (int(a) for a in (sys.argv[1:] or ["180", "192", "512"])):
        (OUT / f"icon-{s}.png").write_bytes(png(s))
        print("wrote", OUT / f"icon-{s}.png")
