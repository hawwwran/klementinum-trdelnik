#!/usr/bin/env python3
"""Generate the site icons from the data the app itself draws.

The mark is the spiral seen from above, collapsed to a single year: two rings,
each coloured at every angle by what that day of the year has actually recorded
in 250 years, run through the same OKLab ramp as the coil (src/colors.js). The
outer ring is the hottest that day has ever been, the inner ring the coldest, so
the icon carries the coil's own envelope: January cold and blue at 12 o'clock,
July hot and red at the bottom.

A single ring of daily averages was the obvious first try and it does not work:
Prague's mean daily max never drops below 0 degC, so the whole cold arm of the
ramp is unreachable and the mark comes out uniformly orange.

Outputs (repo root): favicon.svg, icon-32.png, icon-180.png, icon-512.png and,
when ImageMagick is present, favicon.ico.

    python3 tools/make_favicon.py
"""

import json
import math
import shutil
import struct
import subprocess
from datetime import date, timedelta
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent

BG = (17, 17, 16)
SENTINEL = -32768
SEGMENTS_SVG = 72          # 5° arcs: plenty for an icon, keeps the file small
SEGMENTS_PNG = 720
# Two bands with a hairline of background between them, as fractions of the box.
BANDS = [(0.455, 0.310, "tma", max),    # outer: hottest that day has ever been
         (0.295, 0.170, "tmi", min)]    # inner: coldest that day has ever been
SUPERSAMPLE = 8

# --- the app's colour ramp, ported from src/colors.js ------------------------

COLD_STOPS = ["#ffffff", "#0000ff", "#00008b"]
WARM_STOPS = ["#ffffff", "#ffff00", "#ff8c00", "#ff0000", "#8b0000"]


def hex_to_rgb(h):
    n = int(h[1:], 16)
    return ((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c):
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def rgb_to_oklab(rgb):
    r, g, b = (srgb_to_linear(c) for c in rgb)
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    )


def oklab_to_rgb(lab):
    L, a, b = lab
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    out = (
        linear_to_srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linear_to_srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linear_to_srgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    )
    return tuple(min(1.0, max(0.0, c)) for c in out)


COLD_LAB = [rgb_to_oklab(hex_to_rgb(h)) for h in COLD_STOPS]
WARM_LAB = [rgb_to_oklab(hex_to_rgb(h)) for h in WARM_STOPS]


def sample(stops, v):
    pos = v * (len(stops) - 1)
    i = min(len(stops) - 2, int(pos))
    u = pos - i
    a, b = stops[i], stops[i + 1]
    return oklab_to_rgb(tuple(a[j] + (b[j] - a[j]) * u for j in range(3)))


def colour_at(t, c_lo, c_hi):
    if t < 0:
        return sample(COLD_LAB, min(1.0, max(0.0, t / c_lo)))
    return sample(WARM_LAB, min(1.0, max(0.0, t / c_hi)))


# --- the average year, straight out of data/ ---------------------------------


def extremes(element, pick):
    """pick (max or min) of `element` per day-of-year across the whole record."""
    meta = json.loads((root / "data" / "meta.json").read_text())
    raw = (root / "data" / f"{element}.i16").read_bytes()
    values = struct.unpack(f"<{len(raw) // 2}h", raw)
    start = date.fromisoformat(meta["start"])

    bins = [None] * 365
    for i, v in enumerate(values):
        if v == SENTINEL:
            continue
        d = start + timedelta(days=i)
        diy = 366 if (d.year % 4 == 0 and (d.year % 100 != 0 or d.year % 400 == 0)) else 365
        b = min(364, int((d - date(d.year, 1, 1)).days / diy * 365))
        bins[b] = v / 10 if bins[b] is None else pick(bins[b], v / 10)

    series = [v if v is not None else 0.0 for v in bins]
    # A 15-day circular smooth: a record is one freak day, and the icon wants the
    # season. Without it the ring speckles at small sizes.
    win, half = 15, 7
    return [sum(series[(i + k) % 365] for k in range(-half, half + 1)) / win for i in range(365)]


def ring_colours(n, clim, c_lo, c_hi):
    """n colours, one per angular slice, starting at 12 o'clock going clockwise."""
    out = []
    for i in range(n):
        doy = (i + 0.5) / n * 365
        lo, hi = int(doy) % 365, (int(doy) + 1) % 365
        u = doy - int(doy)
        t = clim[lo] * (1 - u) + clim[hi] * u
        r, g, b = colour_at(t, c_lo, c_hi)
        out.append((round(r * 255), round(g * 255), round(b * 255)))
    return out


# --- renderers ---------------------------------------------------------------


def render_png(size, bands, c_lo, c_hi):
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), BG + (255,))
    draw = ImageDraw.Draw(img)
    c = s / 2
    step = 360 / SEGMENTS_PNG

    for (r_out, r_in, _, _), series in bands:
        ro, ri = r_out * s, r_in * s
        box = [c - ro, c - ro, c + ro, c + ro]
        for i, col in enumerate(ring_colours(SEGMENTS_PNG, series, c_lo, c_hi)):
            # PIL angles run clockwise from 3 o'clock; the app puts Jan at 12.
            a0 = -90 + i * step
            draw.pieslice(box, a0 - 0.6, a0 + step + 0.6, fill=col + (255,))
        draw.ellipse([c - ri, c - ri, c + ri, c + ri], fill=BG + (255,))
    return img.resize((size, size), Image.LANCZOS)


def arc_path(cx, cy, r_out, r_in, a0, a1):
    def pt(r, a):
        rad = math.radians(a - 90)
        return f"{cx + r * math.cos(rad):.3f} {cy + r * math.sin(rad):.3f}"

    big = 1 if (a1 - a0) % 360 > 180 else 0
    return (f"M {pt(r_out, a0)} A {r_out} {r_out} 0 {big} 1 {pt(r_out, a1)} "
            f"L {pt(r_in, a1)} A {r_in} {r_in} 0 {big} 0 {pt(r_in, a0)} Z")


def render_svg(bands, c_lo, c_hi):
    size = 64
    c = size / 2
    step = 360 / SEGMENTS_SVG

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'width="{size}" height="{size}" role="img" '
        f'aria-label="Klementinum Trdelnik">',
        f'<rect width="{size}" height="{size}" rx="10" fill="rgb{BG}"/>',
        '<g shape-rendering="crispEdges">',
    ]
    for (r_out, r_in, _, _), series in bands:
        ro, ri = r_out * size, r_in * size
        for i, col in enumerate(ring_colours(SEGMENTS_SVG, series, c_lo, c_hi)):
            a0 = i * step
            # Overlap by a hair, or antialiasing leaves seams between the wedges.
            parts.append(f'<path d="{arc_path(c, c, ro, ri, a0 - 0.25, a0 + step + 0.25)}" '
                         f'fill="rgb{col}"/>')
    parts.append("</g></svg>")
    return "\n".join(parts) + "\n"


def main():
    meta = json.loads((root / "data" / "meta.json").read_text())
    c_lo, c_hi = meta["tmin"], meta["tmax"]
    bands = [(b, extremes(b[2], b[3])) for b in BANDS]
    for (_, _, el, pick), series in bands:
        print(f"{el} {pick.__name__} per day: {min(series):.1f} .. {max(series):.1f} °C")

    (root / "favicon.svg").write_text(render_svg(bands, c_lo, c_hi))
    for size in (32, 180, 512):
        render_png(size, bands, c_lo, c_hi).save(root / f"icon-{size}.png")
    print("wrote favicon.svg, icon-32.png, icon-180.png, icon-512.png")

    if shutil.which("convert"):
        subprocess.run(
            ["convert", str(root / "icon-512.png"), "-define", "icon:auto-resize=48,32,16",
             str(root / "favicon.ico")],
            check=True,
        )
        print("wrote favicon.ico")
    else:
        print("ImageMagick not found; skipped favicon.ico")


if __name__ == "__main__":
    main()
