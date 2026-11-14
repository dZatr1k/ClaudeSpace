#!/usr/bin/env python3
"""Generate the app icon (build/icon.png 512 px, build/icon.ico 16..256 px) with the stdlib only.

The design is the ◆ of the title bar and tray: an accent-orange diamond on a dark rounded square. No third-party art.
Run: python3 scripts/make-icon.py  (outputs are committed; electron-builder takes them from build/).
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'build'
BG = (0x26, 0x24, 0x22)      # dark warm grey
FG = (0xD9, 0x77, 0x57)      # --accent (dark theme)
SS = 4                       # supersampling per axis


def inside_rounded(x: float, y: float, r: float) -> bool:
    # unit square [0,1]^2 with corner radius r
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def inside_diamond(x: float, y: float, h: float) -> bool:
    return abs(x - 0.5) + abs(y - 0.5) <= h


def render(size: int) -> bytes:
    rows = []
    n = SS * SS
    for py in range(size):
        row = bytearray(b'\x00')  # filter: none
        for px in range(size):
            bg = fg = 0
            for sy in range(SS):
                y = (py + (sy + 0.5) / SS) / size
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    if inside_rounded(x, y, 0.2):
                        if inside_diamond(x, y, 0.3):
                            fg += 1
                        else:
                            bg += 1
            a = bg + fg
            if a == 0:
                row += b'\x00\x00\x00\x00'
                continue
            # colour weighted by coverage of each layer, alpha by total coverage
            c = [round((BG[i] * bg + FG[i] * fg) / a) for i in range(3)]
            row += bytes(c) + bytes([round(255 * a / n)])
        rows.append(bytes(row))
    raw = b''.join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def ico(pngs: dict) -> bytes:
    # ICO with PNG-compressed images (Windows Vista+)
    sizes = sorted(pngs)
    head = struct.pack('<HHH', 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b''
    body = b''
    for s in sizes:
        data = pngs[s]
        entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset + len(body))
        body += data
    return head + entries + body


def main() -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / 'icon.png').write_bytes(render(512))
    pngs = {s: render(s) for s in (16, 24, 32, 48, 64, 128, 256)}
    (OUT / 'icon.ico').write_bytes(ico(pngs))
    print('written', OUT / 'icon.png', OUT / 'icon.ico')


if __name__ == '__main__':
    main()
