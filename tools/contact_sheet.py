"""
contact_sheet.py
======================================================================
Hoja de contactos de los sprites renderizados, todos posados sobre la
misma linea de suelo por su ancla.

Es la unica forma honesta de juzgar el pipeline: mirando los modelos
juntos y a escala real se ve de golpe cual desentona de tamano, cual
trae parcela y cual no, y si las sombras caen todas del mismo lado.

    python tools/contact_sheet.py [--cols 6] [nombre ...]
"""

import json
import os
import sys
import argparse
from PIL import Image, ImageDraw

OUT = "tools/render_out"
BG = (28, 33, 42, 255)
LINE = (74, 92, 112, 255)
TXT = (196, 210, 226, 255)
DIM = (120, 138, 158, 255)
TILE_PX = 256          # ancho del rombo a escala final


def load(name, manifest, scale):
    im = Image.open(os.path.join(OUT, name + ".png")).convert("RGBA")
    ss = manifest[name]["supersample"]
    f = scale / ss
    w, h = max(1, int(im.width * f)), max(1, int(im.height * f))
    im = im.resize((w, h), Image.LANCZOS)
    ax, ay = [c * f for c in manifest[name]["anchor_px"]]
    return im, ax, ay


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--scale", type=float, default=0.5,
                    help="1.0 = tamano final retina; 0.5 entra mejor en pantalla")
    ap.add_argument("--out", default=os.path.join(OUT, "_sheet.png"))
    args = ap.parse_args()

    manifest = json.load(open(os.path.join(OUT, "manifest.json")))
    names = args.names or sorted(manifest.keys())
    names = [n for n in names if n in manifest]

    sprites = [(n,) + load(n, manifest, args.scale) for n in names]

    # La celda se dimensiona por el sprite mas grande, para que la escala
    # relativa se conserve: si cada uno se encajase en su hueco, la
    # comparacion de tamanos -que es justo lo que venimos a mirar- se pierde.
    cw = max(im.width for _, im, _, _ in sprites) + 24
    above = max(ay for _, _, _, ay in sprites)
    below = max(im.height - ay for _, im, _, ay in sprites)
    ch = int(above + below) + 34

    cols = min(args.cols, len(sprites))
    rows = (len(sprites) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cw, rows * ch), BG)
    d = ImageDraw.Draw(sheet)
    tile_w = TILE_PX * args.scale

    for i, (name, im, ax, ay) in enumerate(sprites):
        cx = (i % cols) * cw + cw // 2
        gy = (i // cols) * ch + int(above)     # linea de suelo de la celda

        # rombo de una baldosa, como referencia de escala
        d.polygon([(cx, gy - tile_w / 4), (cx + tile_w / 2, gy),
                   (cx, gy + tile_w / 4), (cx - tile_w / 2, gy)], outline=LINE)
        d.line([(cx - cw // 2 + 6, gy), (cx + cw // 2 - 6, gy)], fill=LINE)
        sheet.alpha_composite(im, (int(cx - ax), int(gy - ay)))

        m = manifest[name]
        d.text((cx - cw // 2 + 8, gy + int(below) + 4), name, fill=TXT)
        d.text((cx - cw // 2 + 8, gy + int(below) + 16),
               "%dx%d  alto %.0fu" % (m["footprint_tiles"][0],
                                      m["footprint_tiles"][1],
                                      m["size_world"][2]), fill=DIM)

    sheet.convert("RGB").save(args.out)
    print("hoja: %s  %dx%d  (%d sprites)" % (args.out, sheet.width, sheet.height, len(sprites)))


main()
