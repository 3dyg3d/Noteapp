#!/usr/bin/env python3
"""Derive the app's icon assets from the master artwork.

Run after replacing `assets/icon-source.png`:

    python scripts/build-icons.py

Why this exists rather than dropping the artwork straight into `icon.png`:

* **The wordmark has to go.** Every launcher already prints "Geodesic Notes"
  under the icon. Baking it in duplicates the label, and at a real home-screen
  size (roughly 60 px) the lettering is illegible smear that just muddies the
  bottom third.
* **The baked rounded rectangle has to go.** iOS applies its own superellipse
  mask. Feeding it art that already has rounded corners and a black surround
  produces a visible dark ring inside the system mask. Icons must bleed to the
  edges and let the platform cut the shape.
* **Android masks aggressively.** An adaptive icon is a background layer plus a
  foreground layer, and the launcher may crop to a circle, squircle, teardrop or
  rounded square. Only the centre 66% is guaranteed visible, so the emblem is
  rescaled into that safe zone instead of being cropped by the device.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "icon-source.png"
SPLASH_SOURCE = ROOT / "assets" / "splash-source.png"
OUT = ROOT / "assets" / "images"

# --- Measured from the master artwork (1254 x 1254) -----------------------
# The badge interior, excluding the black surround.
BADGE = (37, 41, 1216, 1215)
# Centre of the circular emblem, and the radius of its outer dashed ring.
EMBLEM_CX, EMBLEM_CY = 627, 560
EMBLEM_R = 500
# The baked "GEODESIC NOTES" wordmark starts here. Everything below is dropped.
TEXT_TOP = 1045

BACKGROUND = "#3E3D3C"  # fallback flat slate, if the texture layer is dropped
# Slate tone for the synthesised Android background layer. See
# build_adaptive_background for why it is generated rather than sampled.
SLATE_RGB = (58, 57, 56)
# The splash lockup is drawn on black, and its enclosed areas (the book's unlit
# pages, the cells between the globe struts, the counters inside the letters)
# are genuinely black rather than empty. Compositing it on anything lighter
# turns those into visible black blobs, so both themes use black.
SPLASH_BACKGROUND = "#000000"

# Android reserves the outer 33%: a 1024 px foreground has a 682 px safe circle.
ADAPTIVE_SAFE_FRACTION = 0.66
# Fraction of the 1024 canvas the full badge occupies.
#
# Derived, not guessed. An Android adaptive icon is a 108dp canvas of which only
# the centre 72dp is guaranteed visible, so the safe circle has diameter
# 72/108 = 0.667 of the canvas. A square inscribed in that circle has side
# 0.667 / sqrt(2) = 0.472.
#
# A previous version shipped 0.58 because the mask preview was drawn at the full
# canvas instead of the safe zone, which is why the wordmark was still clipped on
# device. 0.45 leaves a little margin under launchers that mask tighter still.
BADGE_SCALE = 0.45

# Same derivation for the Android 12+ splash icon: a 288dp image masked to a
# 192dp circle, so the safe circle is 0.667 of the canvas. The wordmark lockup is
# about 1.5:1, and a 1.5:1 rectangle inscribed in that circle can be at most
# 0.556 of the canvas wide. 0.52 leaves margin.
SPLASH_WORDMARK_WIDTH = 0.52


def load_source() -> Image.Image:
    if not SOURCE.exists():
        raise SystemExit(f"Missing artwork: {SOURCE}")
    return Image.open(SOURCE).convert("RGB")


def square_crop(img: Image.Image, cx: int, cy: int, half: int) -> Image.Image:
    """Square crop centred on a point, padded with edge pixels if it overruns."""
    left, top, right, bottom = cx - half, cy - half, cx + half, cy + half
    crop = img.crop((left, top, right, bottom))
    return crop


def build_legacy_icon(src: Image.Image) -> Image.Image:
    """Full-bleed square fallback. No transparency, no rounded corners, no text.

    Android 8+ uses the adaptive layers, so this only covers legacy launchers and
    the web PWA icon. It is emitted at 512 and palette-quantised because 1024 px
    of stone texture is around 1.9 MB of bundle for a path most devices never
    take.
    """
    # Sit just inside the badge border so the black surround never appears, and
    # stay above the wordmark.
    half = min(
        EMBLEM_CX - BADGE[0] - 8,
        BADGE[2] - EMBLEM_CX - 8,
        EMBLEM_CY - BADGE[1] - 8,
        TEXT_TOP - EMBLEM_CY - 8,
    )
    icon = square_crop(src, EMBLEM_CX, EMBLEM_CY, half)
    return icon.resize((1024, 1024), Image.LANCZOS)


def build_adaptive_foreground(src: Image.Image) -> Image.Image:
    """The whole badge, wordmark included, scaled to survive Android's masks.

    Earlier this cropped to the emblem and dropped the "GEODESIC NOTES"
    wordmark, on the reasoning that the launcher prints the app name anyway.
    Keeping the wordmark means the badge has to shrink: Android may mask the
    icon to a circle, and a square only fits inside a circle at about 70% of its
    diameter. At 58% of the 1024 canvas the full badge clears every mask shape
    with a little air, which is what BADGE_SCALE is.

    Trade-off, stated plainly: at a 48 dp launcher size the wordmark is a few
    pixels tall and reads as texture rather than text. It is legible in the app
    drawer and in settings, not on the home screen.
    """
    badge = src.crop(BADGE).convert("RGBA")
    side = int(1024 * BADGE_SCALE)
    badge = badge.resize((side, side), Image.LANCZOS)

    # Round the badge's own corners so its hard edge never fights the system
    # mask, and feather it so the boundary is not a stair-step at small sizes.
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, side - 1, side - 1), radius=int(side * 0.14), fill=255
    )
    badge.putalpha(mask.filter(ImageFilter.GaussianBlur(2)))

    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    offset = (1024 - side) // 2
    canvas.paste(badge, (offset, offset), badge)
    return canvas


def build_adaptive_background(_src: Image.Image) -> Image.Image:
    """Full-bleed slate for the Android background layer.

    Generated rather than sampled. Two attempts at reusing the artwork failed
    visibly: mirror-tiling a patch put a kaleidoscope X through the middle, and
    upscaling even the lowest-variance patch smeared the book edges and ring into
    ghost streaks. There is no large area of featureless stone in the source.

    Texture rather than a flat fill, because Android crops this layer with the
    same mask as the foreground and a flat colour made the emblem read as a
    sticker pasted onto a plate. Fine grain plus a soft vignette gives the join
    something to disappear into, and being synthetic it has no structure to
    misread at any crop.
    """
    import random

    size = 1024
    rng = random.Random(0xC0FFEE)  # fixed seed: byte-identical output every run
    base = Image.new("RGB", (size, size), SLATE_RGB)

    # Fine grain, generated small and upscaled so it survives downsampling to
    # launcher size instead of averaging away to flat.
    grain_size = 256
    grain = Image.new("L", (grain_size, grain_size))
    grain.putdata([max(0, min(255, int(rng.gauss(128, 26)))) for _ in range(grain_size * grain_size)])
    grain = grain.resize((size, size), Image.BICUBIC).filter(ImageFilter.GaussianBlur(0.6))

    r, g, b = SLATE_RGB
    tinted = Image.merge(
        "RGB",
        [grain.point(lambda v, c=c: int(c + (v - 128) * 0.32)) for c in (r, g, b)],
    )
    out = Image.blend(base, tinted, 0.85)

    # Subtle centre-bright vignette so the layer has some depth under the emblem.
    vignette = Image.new("L", (size, size), 0)
    ImageDraw.Draw(vignette).ellipse(
        (-size * 0.15, -size * 0.15, size * 1.15, size * 1.15), fill=70
    )
    vignette = vignette.filter(ImageFilter.GaussianBlur(size // 6))
    highlight = Image.new("RGB", (size, size), (96, 95, 93))
    return Image.composite(highlight, out, vignette.point(lambda v: v // 3))


def build_splash(_src: Image.Image) -> Image.Image:
    """The wordmark lockup, on a square canvas, sized to survive a circular mask.

    Android 12+ masks the splash icon to a circle. An earlier attempt fixed the
    cropping by dropping the wordmark and using the round emblem instead, which
    worked but lost the name. The wordmark can be kept: what it cannot do is
    reach the canvas edges.

    So the canvas is square (it has to be, or the mask clips the sides) and the
    lockup sits centred at SPLASH_WORDMARK_WIDTH, which is the widest a 1.5:1
    rectangle can be while still fitting inside the mask's circle.
    """
    import numpy as np
    from scipy import ndimage

    if not SPLASH_SOURCE.exists():
        raise SystemExit(f"Missing splash artwork: {SPLASH_SOURCE}")

    rgb = np.array(Image.open(SPLASH_SOURCE).convert("RGB")).astype(np.float32)
    lum = rgb.mean(axis=2)

    # Alpha from a flood fill seeded at the frame edge, not a plain threshold: a
    # threshold would punch holes through every enclosed black area inside the
    # mark (the book's unlit pages, the cells between the globe struts, the
    # counters inside the letters).
    dark = lum < 14
    labels, _ = ndimage.label(dark)
    edge_labels = set(
        np.unique(np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]))
    ) - {0}
    surround = np.isin(labels, list(edge_labels))

    alpha = np.full(lum.shape, 255.0)
    alpha[surround] = (np.clip((lum - 4.0) / 20.0, 0.0, 1.0) * 255.0)[surround]

    mark = Image.fromarray(np.dstack([rgb.astype(np.uint8), alpha.astype(np.uint8)]), "RGBA")
    bbox = mark.getchannel("A").point(lambda v: 255 if v > 6 else 0).getbbox()
    mark = mark.crop(bbox)

    canvas_size = 1024
    target_w = int(canvas_size * SPLASH_WORDMARK_WIDTH)
    target_h = round(target_w * mark.height / mark.width)
    mark = mark.resize((target_w, target_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    canvas.paste(mark, ((canvas_size - target_w) // 2, (canvas_size - target_h) // 2), mark)
    return canvas


def build_favicon(icon: Image.Image) -> Image.Image:
    # Browsers render this at 16-32 px. Downscale from the finished icon so it
    # inherits the same framing rather than being cropped differently.
    return icon.resize((196, 196), Image.LANCZOS)




# ---------------------------------------------------------------------------
# Android themed icon (Android 13+)
#
# The launcher tints a single-colour glyph to match the user's wallpaper. With
# no monochrome layer the app stays a grey tile while every themed icon around
# it recolours, which looks broken rather than deliberate.
#
# The glyph is drawn here rather than derived from the artwork. Thresholding the
# photoreal render was tried and failed: it picks up the lit upper-left corner
# and the page ruling, and the result is unreadable. Themed icons want a flat
# silhouette anyway, so this draws one: an open book under a geodesic globe with
# a single orbital ring. Detail is deliberately minimal because the glyph has to
# survive being rendered at 48 dp.
# ---------------------------------------------------------------------------
MONO_SS = 3  # supersample factor for the drawn glyph

def _draw(S, g, ox, oy):
    def P(x, y):
        return (ox + x * g, oy + y * g)
    W = g * 0.055
    img = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(img)

    # ---- open book: two pages meeting in a V, outer edges lifted ----
    sx = 0.50
    d.polygon([P(0.07,0.60), P(sx-0.02,0.68), P(sx-0.02,0.92), P(0.07,0.84)], fill=255)
    d.polygon([P(0.93,0.60), P(sx+0.02,0.68), P(sx+0.02,0.92), P(0.93,0.84)], fill=255)
    # three rules per page, cut out: enough to read as text, few enough to survive 48dp
    for i in range(3):
        y = 0.70 + i*0.062
        d.line([P(0.14,y+0.020), P(0.43,y+0.055)], fill=0, width=int(W*0.55))
        d.line([P(0.57,y+0.055), P(0.86,y+0.020)], fill=0, width=int(W*0.55))

    # ---- globe above the gutter, minimal graticule ----
    gcx, gcy, gr = 0.50, 0.34, 0.225
    d.ellipse([P(gcx-gr-0.05,gcy-gr-0.05), P(gcx+gr+0.05,gcy+gr+0.05)], fill=0)
    d.ellipse([P(gcx-gr,gcy-gr), P(gcx+gr,gcy+gr)], fill=255)
    # one equator and one meridian only
    d.line([P(gcx-gr,gcy), P(gcx+gr,gcy)], fill=0, width=int(W*0.5))
    d.ellipse([P(gcx-gr*0.46,gcy-gr), P(gcx+gr*0.46,gcy+gr)], outline=0, width=int(W*0.45))

    # ---- orbital ring: tight to the globe and steeply tilted ----
    ring = Image.new('L', (S,S), 0); rd = ImageDraw.Draw(ring)
    cut  = Image.new('L', (S,S), 0); cd = ImageDraw.Draw(cut)
    rrx, rry = gr*1.24, gr*0.42
    box = [P(gcx-rrx,gcy-rry), P(gcx+rrx,gcy+rry)]
    cd.ellipse(box, outline=255, width=int(W*2.0))
    rd.ellipse(box, outline=255, width=int(W*0.85))
    cut  = cut.rotate(-34, resample=Image.BICUBIC, center=P(gcx,gcy))
    ring = ring.rotate(-34, resample=Image.BICUBIC, center=P(gcx,gcy))
    img = Image.composite(Image.new('L',(S,S),0), img, cut)
    img = Image.composite(Image.new('L',(S,S),255), img, ring)
    return img

def build_monochrome(size=1024, safe=0.60):
    S = size * MONO_SS; g = int(S*safe)
    img = _draw(S, g, (S-g)//2, (S-g)//2)
    a = np.array(img); ys, xs = np.where(a > 8)
    glyph = img.crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1))
    target = int(size*safe); w,h = glyph.size; sc = target/max(w,h)
    glyph = glyph.resize((max(1,int(w*sc)), max(1,int(h*sc))), Image.LANCZOS)
    canvas = Image.new('L',(size,size),0)
    canvas.paste(glyph, ((size-glyph.width)//2, (size-glyph.height)//2))
    out = Image.new('RGBA',(size,size),(255,255,255,255)); out.putalpha(canvas)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    src = load_source()

    icon = build_legacy_icon(src)
    build_favicon(icon).save(OUT / "favicon.png", optimize=True)
    icon.resize((512, 512), Image.LANCZOS).quantize(
        colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG
    ).save(OUT / "icon.png", optimize=True)

    build_adaptive_foreground(src).save(OUT / "adaptive-icon.png", optimize=True)
    build_adaptive_background(src).save(OUT / "adaptive-icon-background.png", optimize=True)
    build_monochrome().save(OUT / "adaptive-icon-monochrome.png", optimize=True)
    splash = build_splash(src)
    splash.save(OUT / "splash-image.png", optimize=True)

    print(f"icon.png             512x512   opaque, full bleed (legacy + web)")
    print(f"adaptive-icon.png   1024x1024  full badge + wordmark at {int(BADGE_SCALE * 100)}% (fits 66% safe circle)")
    print(f"adaptive-icon-background.png 1024x1024  slate texture, full bleed")
    print(f"adaptive-icon-monochrome.png 1024x1024  drawn glyph for themed icons")
    print(f"splash-image.png   {splash.width}x{splash.height}  wordmark lockup, square canvas")
    print(f"favicon.png          196x196")
    print(f"\nbackground: {BACKGROUND}   splash: {SPLASH_BACKGROUND}")


if __name__ == "__main__":
    main()
