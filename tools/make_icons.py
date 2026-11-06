"""Draws the app icon "Созвездие" without any image libraries.

Days are stars joined by a thin line, like the trend chart; one day is a warm star with a soft ring.
Everything sits inside the central safe zone, so iOS rounding and Android masks never cut it.
"""
import math
import struct
import sys
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "icons"

BG = (23, 32, 36)          # #172024, deep night green
LINE = (143, 185, 160)     # #8fb9a0, the app's calm green
STAR = (201, 216, 207)     # #c9d8cf
WARM = (210, 154, 116)     # #d29a74, the pain colour

# The drawing in a 120-unit square (same as the approved sketch).
PATH = [(22, 78), (40, 62), (56, 70), (70, 40), (86, 58), (100, 50)]
SMALL = [(22, 78), (40, 62), (56, 70), (86, 58), (100, 50)]
WARM_C, WARM_R, RING_R = (70, 40), 7.5, 12.5
LINE_W, RING_W, SMALL_R = 2.4, 1.6, 3.4
DY = 5.5  # the sketch sits high; this centres the drawing (ring top 27.5 to lowest star 81.4)


def seg_dist(px, py, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def mix(base, top, alpha):
    return tuple(b + (t - b) * alpha for b, t in zip(base, top))


def pixel(x, y):
    """Colour at a point given in 120-unit coordinates; layers are painted bottom to top."""
    y -= DY
    c = BG
    if any(seg_dist(x, y, PATH[i], PATH[i + 1]) <= LINE_W / 2 for i in range(len(PATH) - 1)):
        c = mix(c, LINE, 0.6)
    d = math.hypot(x - WARM_C[0], y - WARM_C[1])
    if abs(d - RING_R) <= RING_W / 2:
        c = mix(c, WARM, 0.45)
    if any(math.hypot(x - sx, y - sy) <= SMALL_R for sx, sy in SMALL):
        c = STAR
    if d <= WARM_R:
        c = WARM
    return c


def png(size):
    ss = 4  # supersampling for smooth edges
    k = 120 / size
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            acc = [0.0, 0.0, 0.0]
            for sj in range(ss):
                for si in range(ss):
                    c = pixel((i + (si + 0.5) / ss) * k, (j + (sj + 0.5) / ss) * k)
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
