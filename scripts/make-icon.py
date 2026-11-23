#!/usr/bin/env python3
"""Generates the desktop app icons from the mobile app's light icon.

The source is scripts/icon-source.png, a copy of the React Native app's
assets/icon.png: the default Config bot avatar on the brushed-metal
ground. electron-builder previously used one 1024 PNG for every platform;
macOS needs the rounded-square mark with transparent padding so the Dock
size matches other apps, while Windows and Linux use the full-bleed square.

Writes:

  build/icon.png            1024 full-bleed (Linux / general)
  build/icons/{N}x{N}.png   Linux hicolor sizes
  build/icon.ico            Windows multi-size ICO (full-bleed)
  build/icon-mac.png        1024 with 100px pad + rounded-square mask
  build/icon.icns           macOS icon set from the padded mark

Run from the repo root:  python3 scripts/make-icon.py
Requires Pillow:         pip3 install pillow
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(__file__).resolve().parent / "icon-source.png"
BUILD = ROOT / "build"
LINUX_ICONS = BUILD / "icons"

# macOS icon grid: the mark sits in a rounded square with ~100pt of
# transparent margin, so 824px of art on a 1024 canvas. Radius matches the
# previous desktop icon so the Dock silhouette stays the same size.
CANVAS = 1024
MARGIN = 100
RADIUS = 232
SCALE = 4

# Full-bleed sizes for the Linux hicolor set and the Windows ICO.
LINUX_SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)

# PNG-based ICNS types, including the @2x / retina partners. Sizes are the
# pixel dimensions stored in that slot.
ICNS_SLOTS = (
    (16, b"icp4"),
    (32, b"ic11"),  # 16@2x
    (32, b"icp5"),
    (64, b"ic12"),  # 32@2x
    (128, b"ic07"),
    (256, b"ic13"),  # 128@2x
    (256, b"ic08"),
    (512, b"ic14"),  # 256@2x
    (512, b"ic09"),
    (1024, b"ic10"),  # 512@2x
)


def load_source() -> Image.Image:
    if not SOURCE.is_file():
        raise SystemExit(f"missing icon source: {SOURCE}")
    return Image.open(SOURCE).convert("RGBA")


def resize(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.LANCZOS)


def png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def full_bleed(source: Image.Image) -> Image.Image:
    """Opaque 1024 square, same pixels as the mobile light icon."""
    image = resize(source, CANVAS)
    # The mobile master is opaque RGB; keep the full-bleed assets opaque so
    # Windows and Linux don't treat a fully-white alpha as a transparent frame.
    if image.getextrema()[3] == (255, 255):
        return image.convert("RGB")
    return image


def mac_padded(source: Image.Image) -> Image.Image:
    """Rounded-square mark on a transparent 1024 canvas, rendered at 4x."""
    work = CANVAS * SCALE
    margin = MARGIN * SCALE
    radius = RADIUS * SCALE
    art_size = work - 2 * margin
    art = resize(source.convert("RGBA"), art_size)

    canvas = Image.new("RGBA", (work, work), (0, 0, 0, 0))
    canvas.paste(art, (margin, margin), art)

    mask = Image.new("L", (work, work), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [margin, margin, work - margin, work - margin],
        radius=radius,
        fill=255,
    )
    canvas.putalpha(ImageChops.multiply(canvas.getchannel("A"), mask))
    return canvas.resize((CANVAS, CANVAS), Image.LANCZOS)


def write_linux_icons(full: Image.Image) -> None:
    LINUX_ICONS.mkdir(parents=True, exist_ok=True)
    wanted = {f"{size}x{size}.png" for size in LINUX_SIZES}
    rgba = full.convert("RGBA")
    for size in LINUX_SIZES:
        resize(rgba if size != CANVAS else full, size).save(
            LINUX_ICONS / f"{size}x{size}.png", optimize=True
        )
    for stale in LINUX_ICONS.glob("*.png"):
        if stale.name not in wanted:
            stale.unlink()


def write_ico(full: Image.Image, dest: Path) -> None:
    # Pillow downsamples from this image into each ICO slot.
    full.convert("RGBA").save(
        dest,
        format="ICO",
        sizes=[(size, size) for size in ICO_SIZES],
    )


def write_icns(padded: Image.Image, dest: Path) -> None:
    """Write a PNG-based .icns (the format iconutil / modern macOS expect)."""
    png_by_size = {size: png_bytes(resize(padded, size)) for size, _ in ICNS_SLOTS}
    entries = b"".join(
        ostype + struct.pack(">I", len(png_by_size[size]) + 8) + png_by_size[size]
        for size, ostype in ICNS_SLOTS
    )
    dest.write_bytes(b"icns" + struct.pack(">I", len(entries) + 8) + entries)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    source = load_source()
    full = full_bleed(source)
    padded = mac_padded(source)

    full.save(BUILD / "icon.png", optimize=True)
    padded.save(BUILD / "icon-mac.png", optimize=True)
    write_linux_icons(full)
    write_ico(full, BUILD / "icon.ico")
    write_icns(padded, BUILD / "icon.icns")
    print(
        f"wrote {BUILD / 'icon.png'}, {LINUX_ICONS}/, "
        f"{BUILD / 'icon.ico'}, {BUILD / 'icon-mac.png'}, {BUILD / 'icon.icns'}"
    )


if __name__ == "__main__":
    main()
