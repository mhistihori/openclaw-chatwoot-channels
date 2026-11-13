#!/usr/bin/env python3
"""Draws assets/icon.png: two overlapping chat bubbles, a white one with typing dots (the bot)
and an amber one with a person (the human agent who takes over). Original artwork; it does not
reuse the Chatwoot or OpenClaw logos.

Usage: python3 scripts/make-icon.py            # writes assets/icon.png (512x512)
       python3 scripts/make-icon.py --preview /path/preview.png   # also a size/contrast sheet
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512
SS = 4  # draw at 4x and scale down for smooth edges
S = SIZE * SS

INDIGO = (59, 91, 219)
TEAL = (18, 184, 134)
INK = (38, 58, 160)  # dark indigo for dots, figure and the separating outline
WHITE = (255, 255, 255)
AMBER = (255, 197, 61)


def sc(v):
    return int(round(v * SS))


def box(x0, y0, x1, y1):
    return [sc(x0), sc(y0), sc(x1), sc(y1)]


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        row = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = row
    return img


def bubble(d, rect, radius, tail, fill, outline=None, width=0):
    """A rounded rectangle plus a triangular tail, optionally outlined."""
    x0, y0, x1, y1 = rect
    pts = [(sc(x), sc(y)) for x, y in tail]
    if outline:
        grow = width
        d.rounded_rectangle(box(x0 - grow, y0 - grow, x1 + grow, y1 + grow), radius=sc(radius + grow), fill=outline)
        cx = sum(p[0] for p in pts) / 3
        cy = sum(p[1] for p in pts) / 3
        d.polygon([(int(cx + (x - cx) * 1.35), int(cy + (y - cy) * 1.35)) for x, y in pts], fill=outline)
    d.rounded_rectangle(box(x0, y0, x1, y1), radius=sc(radius), fill=fill)
    d.polygon(pts, fill=fill)


def draw():
    bg = gradient(S, INDIGO, TEAL).convert("RGBA")
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=sc(112), fill=255)
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(canvas)

    # Bot: white bubble with typing dots.
    bubble(d, (70, 92, 330, 284), 58, [(138, 268), (138, 362), (222, 268)], WHITE)
    for cx in (146, 200, 254):
        d.ellipse(box(cx - 17, 172, cx + 17, 206), fill=INK)

    # Human: amber bubble in front, with a person.
    bubble(d, (206, 226, 442, 408), 52, [(390, 392), (390, 472), (322, 392)], AMBER, outline=INK, width=9)
    d.ellipse(box(300, 262, 352, 314), fill=INK)  # head
    d.pieslice(box(276, 328, 376, 428), 180, 360, fill=INK)  # shoulders

    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def preview(icon, path):
    sizes = [512, 128, 64, 32, 16]
    pad = 24
    cell = 140
    sheet = Image.new("RGB", (pad + len(sizes) * (cell + pad), 2 * (cell + pad) + pad), (255, 255, 255))
    for row, bgcol in enumerate([(255, 255, 255), (24, 26, 32)]):
        ImageDraw.Draw(sheet).rectangle([0, row * (cell + pad) + pad // 2, sheet.width, (row + 1) * (cell + pad) + pad // 2], fill=bgcol)
        for i, s in enumerate(sizes):
            small = icon.resize((s, s), Image.LANCZOS)
            shown = small.resize((cell, cell), Image.NEAREST if s < cell else Image.LANCZOS) if s < cell else small.resize((cell, cell), Image.LANCZOS)
            sheet.paste(shown, (pad + i * (cell + pad), row * (cell + pad) + pad), shown)
    sheet.save(path)


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "assets" / "icon.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    icon = draw()
    icon.save(out, optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    if "--preview" in sys.argv:
        preview(icon, Path(sys.argv[sys.argv.index("--preview") + 1]))
        print("wrote preview")
