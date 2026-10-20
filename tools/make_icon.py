#!/usr/bin/env python3
"""Draws www/icon.png (512×512): a coral ring with a white play triangle on a dark rounded square. No libraries."""
import os
import struct
import zlib

SIZE, SS = 512, 3                      # pixels, supersamples per axis
BG, RING, PLAY = (22, 24, 31), (255, 107, 74), (255, 255, 255)
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'www', 'icon.png')


def inside_rounded(x, y, r=110):
    cx, cy = min(max(x, r), SIZE - r), min(max(y, r), SIZE - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color(x, y):
    if not inside_rounded(x, y):
        return None
    dx, dy = x - SIZE / 2, y - SIZE / 2
    d = (dx * dx + dy * dy) ** 0.5
    if 150 <= d <= 186:
        return RING
    # Play triangle, pointing right, centred a little right of the middle.
    tx, ty = dx + 22, dy
    if -60 <= tx <= 84 and abs(ty) <= (84 - tx) * 0.62:
        return PLAY
    return BG


def main():
    rows = []
    step = 1.0 / SS
    for py in range(SIZE):
        row = bytearray([0])
        for px in range(SIZE):
            acc, hits = [0, 0, 0], 0
            for sy in range(SS):
                for sx in range(SS):
                    c = color(px + (sx + .5) * step, py + (sy + .5) * step)
                    if c:
                        hits += 1
                        for i in range(3):
                            acc[i] += c[i]
            if hits:
                row += bytes([acc[0] // hits, acc[1] // hits, acc[2] // hits, 255 * hits // (SS * SS)])
            else:
                row += b'\0\0\0\0'
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b''))
    with open(OUT, 'wb') as f:
        f.write(png)
    print('Wrote', OUT)


if __name__ == '__main__':
    main()
