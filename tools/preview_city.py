"""
preview_city.py
======================================================================
Monta una ciudad de prueba a partir del atlas ya empaquetado.

Es el criterio de aceptacion de la fase de arte: si aqui los edificios
se posan bien, no flotan, no se hunden y se tapan en el orden correcto,
entonces los datos de anclaje y huella son buenos y Phaser solo tiene
que repetir esta misma aritmetica.

    python tools/preview_city.py
"""

import json
import os
from PIL import Image

ATLAS = "assets/atlas"
OUT = "tools/render_out/_city.png"

data = json.load(open(os.path.join(ATLAS, "sprites.json")))
TW = data["tile_px"]
TH = data["tile_h_px"]
S = data["sprites"]
EXT = data["format"]

_pages = {}


def page(key):
    if key not in _pages:
        _pages[key] = Image.open(os.path.join(ATLAS, key + "." + EXT)).convert("RGBA")
    return _pages[key]


def sprite(name):
    s = S[name]
    x, y, w, h = s["frame"]
    return page(s["page"]).crop((x, y, x + w, y + h)), s


def iso(col, row, ox, oy):
    return ox + (col - row) * (TW / 2), oy + (col + row) * (TH / 2)


# --------------------------------------------------------------------
# Una manzana de prueba: (nombre, col, row)
# --------------------------------------------------------------------
PLAN = [
    # fila de calle al frente
    ("road_a_01", 0, 4), ("road_a_01", 1, 4), ("road_a_01", 2, 4),
    ("road_a_01", 3, 4), ("road_a_01", 4, 4),
    # vivienda baja
    ("house_02", 0, 0), ("house_08", 1, 0), ("house_03", 2, 0),
    ("house_05", 0, 1), ("house_09", 1, 1), ("house_04", 2, 1),
    # comercio y civico
    ("supermarket_a", 0, 2), ("policestation", 2, 2),
    ("restaurant", 0, 3), ("boutique", 1, 3), ("bank", 2, 3),
    # gran altura al fondo
    ("highlivingbuilding_a", 3, 0), ("skyscraper_b", 3, 2),
    ("hotel_b", 4, 0), ("government_a", 3, 3),
    # verde y decoracion
    ("park_b", 4, 1), ("tree", 4, 3), ("plant", 4, 2),
]


def main():
    missing = [n for n, _, _ in PLAN if n not in S]
    if missing:
        print("faltan del atlas: " + ", ".join(missing))
    plan = [(n, c, r) for n, c, r in PLAN if n in S]

    # Se pinta de fondo a frente: lo que esta mas cerca de la camara
    # (col+row mayor) se dibuja despues y tapa a lo de detras.
    def depth(item):
        n, c, r = item
        fw, fh = S[n]["footprint"]
        return (c + (fw - 1) / 2) + (r + (fh - 1) / 2)

    plan.sort(key=depth)

    # Primera pasada en seco para saber cuanto lienzo hace falta
    boxes = []
    for n, c, r in plan:
        im, s = sprite(n)
        fw, fh = s["footprint"]
        x, y = iso(c + (fw - 1) / 2, r + (fh - 1) / 2, 0, 0)
        ax, ay = s["anchor"]
        boxes.append((x - ax, y - ay, x - ax + im.width, y - ay + im.height))
    minx = min(b[0] for b in boxes)
    miny = min(b[1] for b in boxes)
    maxx = max(b[2] for b in boxes)
    maxy = max(b[3] for b in boxes)

    pad = 40
    W = int(maxx - minx) + pad * 2
    H = int(maxy - miny) + pad * 2
    canvas = Image.new("RGBA", (W, H), (122, 166, 120, 255))   # cesped de fondo
    ox, oy = pad - minx, pad - miny

    for n, c, r in plan:
        im, s = sprite(n)
        fw, fh = s["footprint"]
        x, y = iso(c + (fw - 1) / 2, r + (fh - 1) / 2, ox, oy)
        ax, ay = s["anchor"]
        canvas.alpha_composite(im, (int(round(x - ax)), int(round(y - ay))))

    canvas.convert("RGB").save(OUT)
    print("ciudad: %s  %dx%d  (%d piezas, baldosa %dx%d)"
          % (OUT, W, H, len(plan), TW, TH))


main()
