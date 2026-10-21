#!/usr/bin/env python3
"""Draws the app icon, no libraries: a coral ring around a white play triangle on a dark gradient.

    www/icon.png                    512×512 with rounded corners (the TV)
    phone/apple-touch-icon.png      512×512 edge to edge (iPhone rounds the corners itself)
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZE, SS = 512, 3                        # pixels, supersamples per axis
C = SIZE / 2
TOP, BOTTOM = (30, 33, 43), (14, 15, 20)  # background gradient
RING, PLAY = (255, 107, 74), (255, 255, 255)
RING_R, RING_W = 150, 24                 # ring centre-line radius and stroke width: ~65% of the icon
TRI_H, TRI_ROUND = 132, 12               # triangle height and corner rounding

# Equilateral triangle pointing right, its centroid on the centre so it looks centred inside the ring.
_w = TRI_H * math.sqrt(3) / 2
TRI = [(C - _w / 3, C - TRI_H / 2), (C + 2 * _w / 3, C), (C - _w / 3, C + TRI_H / 2)]
# Shrink it by the rounding so the rounded shape keeps the intended size.
_inset = TRI_ROUND * 2
TRI_IN = [(C + (x - C) * (1 - _inset / TRI_H), C + (y - C) * (1 - _inset / TRI_H)) for x, y in TRI]


def tri_distance(px, py):
    """Signed distance to the (unrounded, inset) triangle: negative inside."""
    inside = True
    best = float('inf')
    for i in range(3):
        (ax, ay), (bx, by) = TRI_IN[i], TRI_IN[(i + 1) % 3]
        ex, ey = bx - ax, by - ay
        t = max(0.0, min(1.0, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)))
        dx, dy = px - (ax + ex * t), py - (ay + ey * t)
        best = min(best, math.hypot(dx, dy))
        if ex * (py - ay) - ey * (px - ax) < 0:      # clockwise winding in screen coordinates
            inside = False
    return -best if inside else best


def inside_rounded(x, y, r=112):
    cx, cy = min(max(x, r), SIZE - r), min(max(y, r), SIZE - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color(x, y, rounded):
    if rounded and not inside_rounded(x, y):
        return None
    if tri_distance(x, y) <= TRI_ROUND:
        return PLAY
    if abs(math.hypot(x - C, y - C) - RING_R) <= RING_W / 2:
        return RING
    f = y / SIZE
    return tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * f) for i in range(3))


def render(path, rounded):
    rows, step = [], 1.0 / SS
    for py in range(SIZE):
        row = bytearray([0])
        for px in range(SIZE):
            acc, hits = [0, 0, 0], 0
            for sy in range(SS):
                for sx in range(SS):
                    c = color(px + (sx + .5) * step, py + (sy + .5) * step, rounded)
                    if c:
                        hits += 1
                        for i in range(3):
                            acc[i] += c[i]
            row += bytes([acc[0] // hits, acc[1] // hits, acc[2] // hits, 255 * hits // (SS * SS)]) if hits else b'\0\0\0\0'
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print('Wrote', os.path.relpath(path, ROOT))


if __name__ == '__main__':
    render(os.path.join(ROOT, 'www', 'icon.png'), rounded=True)
    render(os.path.join(ROOT, 'phone', 'apple-touch-icon.png'), rounded=False)
