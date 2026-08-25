"""
check_sprites.py
======================================================================
Control de calidad de los sprites renderizados.

Busca dos fallos que se cuelan sin avisar y solo se ven jugando:

  MODELOS OSCUROS. Alguna malla del pack trae las UV rotas y casi todas
  sus caras apuntan a una zona negra del atlas. Se renderiza sin error y
  sale una silueta negra en medio de la ciudad.

  SPRITES CASI VACIOS. Si el despiece del suelo se lleva por delante mas
  de la cuenta, queda un sprite con cuatro pixeles sueltos.

    python tools/check_sprites.py
"""

import json
import os
from PIL import Image

SRC = "tools/render_out"
# No hay umbral fijo de oscuridad: un coche negro es legitimamente oscuro
# y un edificio con las UV rotas cae en la misma cifra. Lo que si separa a
# los sospechosos es compararlos con la MEDIANA del catalogo, y que la
# ultima palabra la tenga el ojo mirando la hoja de contactos.
DARK_RATIO = 0.62   # por debajo de este % de la mediana, a revisar
MIN_PIXELS = 60     # un sprite con menos que esto salio vacio de verdad


def main():
    manifest = json.load(open(os.path.join(SRC, "manifest.json")))
    dark, empty, rows = [], [], []

    for name in sorted(manifest):
        path = os.path.join(SRC, name + ".png")
        if not os.path.exists(path):
            continue
        im = Image.open(path).convert("RGBA")
        px = im.load()
        w, h = im.size
        # se muestrea en rejilla: mirar 3 millones de pixeles no aporta nada
        step = max(1, min(w, h) // 90)
        tot = 0
        lum = 0.0
        for y in range(0, h, step):
            for x in range(0, w, step):
                r, g, b, a = px[x, y]
                if a < 128:
                    continue
                tot += 1
                lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

        opaque = tot * step * step
        if opaque < MIN_PIXELS:
            empty.append((name, opaque))
            continue
        rows.append((lum / max(1, tot), name))

    rows.sort()
    if rows:
        median = rows[len(rows) // 2][0]
        dark = [(n, v) for v, n in rows if v < median * DARK_RATIO]
        print("mediana de luminancia: %.3f" % median)

    if dark:
        print("MAS OSCUROS DE LO NORMAL (mirar la hoja: puede ser UV rota):")
        for n, v in dark:
            print("   %-28s %.3f  (%.0f%% de la mediana)"
                  % (n, v, 100 * v / median))
    if empty:
        print("\nCASI VACIOS (el despiece se llevo demasiado):")
        for n, v in empty:
            print("   %-28s ~%d px opacos" % (n, v))
    if not dark and not empty:
        print("Los %d sprites pasan el control." % len(manifest))
    else:
        print("\n%d de %d con problemas." % (len(dark) + len(empty), len(manifest)))


main()
