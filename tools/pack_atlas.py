"""
pack_atlas.py
======================================================================
Recorta, escala y empaqueta los PNG de Blender en atlas para Phaser.

    python tools/pack_atlas.py --scale 0.75

Tres cosas que hace y por que:

  1. RECORTA AL ALFA. Blender deja mucho aire alrededor. Recortando se
     ahorra la mitad del atlas, pero hay que corregir el ancla en la
     misma medida o los edificios se descolocan al posarlos.

  2. ESCALA EN ESTA FASE, NO EN BLENDER. Renderizamos siempre a maxima
     resolucion y decidimos aqui a que tamano se envia. Cambiar de 128 a
     256 px de baldosa es un flag, no una hora de render.

  3. SEPARA LOS GIGANTES. Un sprite de mas de 1024 px no entra bien en un
     atlas compartido y obligaria a paginas enormes que se comen la
     memoria de GPU de un movil de gama baja. Esos van sueltos.
"""

import argparse
import json
import math
import os
from PIL import Image

SRC = "tools/render_out"
DST = "assets/atlas"
PAGE = 2048          # lado maximo de una pagina de atlas
SOLO_MIN = 1024      # a partir de aqui, el sprite va en su propio fichero
PAD = 2              # separacion entre sprites, para que no sangren al filtrar


class Skyline:
    """Empaquetador de horizonte: sencillo, rapido y suficiente para
    unos cientos de sprites de alturas parecidas."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.nodes = [(0, 0, w)]        # (x, y, ancho)

    def _fit(self, i, w, h):
        x = self.nodes[i][0]
        if x + w > self.w:
            return None
        y = self.nodes[i][1]
        left = w
        j = i
        while left > 0:
            if j >= len(self.nodes):
                return None
            y = max(y, self.nodes[j][1])
            if y + h > self.h:
                return None
            left -= self.nodes[j][2]
            j += 1
        return y

    def insert(self, w, h):
        best = None
        for i in range(len(self.nodes)):
            y = self._fit(i, w, h)
            if y is not None and (best is None or (y, self.nodes[i][0]) < best[0]):
                best = ((y, self.nodes[i][0]), i)
        if best is None:
            return None
        y, i = best[0][0], best[1]
        x = self.nodes[i][0]

        # se sustituye el tramo cubierto por el nuevo nivel
        node = (x, y + h, w)
        self.nodes.insert(i, node)
        i += 1
        while i < len(self.nodes):
            nx, ny, nw = self.nodes[i]
            if nx >= x + w:
                break
            overlap = (x + w) - nx
            if overlap >= nw:
                self.nodes.pop(i)
            else:
                self.nodes[i] = (nx + overlap, ny, nw - overlap)
                break
        # se fusionan tramos de la misma altura
        i = 0
        while i < len(self.nodes) - 1:
            a, b = self.nodes[i], self.nodes[i + 1]
            if a[1] == b[1]:
                self.nodes[i] = (a[0], a[1], a[2] + b[2])
                self.nodes.pop(i + 1)
            else:
                i += 1
        return x, y


def prepare(name, meta, scale):
    im = Image.open(os.path.join(SRC, name + ".png")).convert("RGBA")
    box = im.split()[-1].getbbox()
    if box is None:
        return None
    im = im.crop(box)
    ax, ay = meta["anchor_px"]
    ax -= box[0]
    ay -= box[1]

    f = scale / meta["supersample"]
    w, h = max(1, round(im.width * f)), max(1, round(im.height * f))
    im = im.resize((w, h), Image.LANCZOS)
    return im, ax * f, ay * f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=float, default=0.75,
                    help="1.0 = baldosa de 256 px; 0.75 = 192; 0.5 = 128")
    ap.add_argument("--format", default="webp", choices=["webp", "png"])
    ap.add_argument("--quality", type=int, default=92)
    ap.add_argument("--out", default=DST)
    args = ap.parse_args()

    manifest = json.load(open(os.path.join(SRC, "manifest.json")))
    os.makedirs(args.out, exist_ok=True)

    prepared, solo = [], []
    for name, meta in sorted(manifest.items()):
        r = prepare(name, meta, args.scale)
        if r is None:
            print("  vacio, se descarta: " + name)
            continue
        im, ax, ay = r
        (solo if max(im.size) >= SOLO_MIN else prepared).append((name, im, ax, ay, meta))

    # los mas altos primero: el horizonte empaqueta mucho mejor asi
    prepared.sort(key=lambda t: -t[1].height)

    sprites = {}
    pages = []
    pending = list(prepared)
    while pending:
        packer = Skyline(PAGE, PAGE)
        page = Image.new("RGBA", (PAGE, PAGE), (0, 0, 0, 0))
        idx = len(pages)
        placed_any = False
        rest = []
        for name, im, ax, ay, meta in pending:
            pos = packer.insert(im.width + PAD, im.height + PAD)
            if pos is None:
                rest.append((name, im, ax, ay, meta))
                continue
            x, y = pos
            page.alpha_composite(im, (x, y))
            sprites[name] = {
                "page": "city-%d" % idx,
                "frame": [x, y, im.width, im.height],
                "anchor": [round(ax, 2), round(ay, 2)],
                "footprint": meta["footprint_tiles"],
                "height_world": meta["size_world"][2],
            }
            placed_any = True
        if not placed_any:
            print("  !! no cabe ni uno, sube PAGE o baja --scale")
            break
        pages.append(("city-%d" % idx, page))
        pending = rest

    for name, im, ax, ay, meta in solo:
        pages.append((name, im))
        sprites[name] = {
            "page": name,
            "frame": [0, 0, im.width, im.height],
            "anchor": [round(ax, 2), round(ay, 2)],
            "footprint": meta["footprint_tiles"],
            "height_world": meta["size_world"][2],
            "solo": True,
        }

    total = 0
    page_size = {}
    for key, im in pages:
        # se recorta la pagina a lo realmente usado: una pagina medio vacia
        # ocupa la misma memoria de GPU que una llena
        box = im.split()[-1].getbbox() or (0, 0, 1, 1)
        im = im.crop((0, 0, box[2], box[3]))
        path = os.path.join(args.out, key + "." + args.format)
        if args.format == "webp":
            im.save(path, quality=args.quality, method=6)
        else:
            im.save(path, optimize=True)
        page_size[key] = [im.width, im.height]
        size = os.path.getsize(path)
        total += size
        print("  %-24s %4dx%-4d  %6.1f KB" % (key, im.width, im.height, size / 1024))

    tile_px = round(manifest[next(iter(manifest))]["tile_px"] * args.scale)
    out = {
        "tile_px": tile_px,
        "tile_h_px": tile_px // 2,
        "tile_world": manifest[next(iter(manifest))]["tile_world"],
        "format": args.format,
        # El ancho de cada pagina hace falta para recortar miniaturas con
        # background-position en la interfaz DOM: sin el, el navegador no
        # sabe a que escala esta el atlas de fondo.
        "pages": page_size,
        "sprites": sprites,
    }
    for name, s_ in sprites.items():
        s_["pageW"], s_["pageH"] = page_size.get(s_["page"], [PAGE, PAGE])

    with open(os.path.join(args.out, "sprites.json"), "w") as f:
        json.dump(out, f, indent=1)

    print("\n%d sprites, %d paginas, %.1f KB en total, baldosa de %d px"
          % (len(sprites), len(pages), total / 1024, tile_px))


main()
