#!/usr/bin/env python3
"""Generates build/icon.png — the 1024x1024 source electron-builder turns
into the .icns at package time.

The mark is three configuration sliders on the brand's warm near-black
(#231d1b family), knobs in the brand blues (#60a5fa / #2563eb) — "configure"
drawn literally. Rendered at 4x and downsampled so the edges stay clean.

Run from the repo root:  python3 scripts/make-icon.py
Requires Pillow:         pip3 install pillow
"""

from PIL import Image, ImageDraw
import pathlib

SCALE = 4
SIZE = 1024 * SCALE

# macOS icon grid: content sits inside a rounded square with ~100pt margin.
MARGIN = 100 * SCALE
RADIUS = 232 * SCALE

BG_TOP = (43, 35, 32)        # a touch above --brand-dark
BG_BOTTOM = (16, 12, 11)     # --brand-dark-hover
TRACK = (78, 68, 63)
KNOB_LIGHT = (96, 165, 250)  # --app-brand
KNOB_STRONG = (37, 99, 235)  # --app-brand-strong
WHITE = (244, 241, 239)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded-square plate with a vertical gradient, drawn row by row under a mask.
plate = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(plate).rounded_rectangle(
    [MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN], radius=RADIUS, fill=255
)
gradient = Image.new("RGBA", (SIZE, SIZE))
for y in range(SIZE):
    t = y / SIZE
    color = tuple(
        int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)
    ) + (255,)
    ImageDraw.Draw(gradient).line([(0, y), (SIZE, y)], fill=color)
img.paste(gradient, (0, 0), plate)

# Three slider rows, knobs staggered like a settings panel mid-edit.
track_w = 520 * SCALE
track_h = 44 * SCALE
knob_r = 62 * SCALE
cx = SIZE // 2
rows = [
    (cx - 130 * SCALE, KNOB_LIGHT),   # knob left of centre
    (cx + 150 * SCALE, WHITE),        # knob right of centre
    (cx - 30 * SCALE, KNOB_STRONG),   # knob near centre
]
row_gap = 190 * SCALE
first_y = SIZE // 2 - row_gap

for i, (knob_x, knob_color) in enumerate(rows):
    y = first_y + i * row_gap
    x0 = cx - track_w // 2
    x1 = cx + track_w // 2
    draw.rounded_rectangle(
        [x0, y - track_h // 2, x1, y + track_h // 2],
        radius=track_h // 2,
        fill=TRACK,
    )
    draw.ellipse(
        [knob_x - knob_r, y - knob_r, knob_x + knob_r, y + knob_r],
        fill=knob_color,
    )

out = pathlib.Path(__file__).resolve().parent.parent / "build" / "icon.png"
out.parent.mkdir(parents=True, exist_ok=True)
img.resize((1024, 1024), Image.LANCZOS).save(out)
print(f"wrote {out}")
