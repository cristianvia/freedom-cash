"""
build_models_json.py
======================================================================
Asigna un modelo 3D a cada activo del catalogo economico.

El criterio no es estetico sino de lectura: el ESCALON tiene que verse.
Un trastero debe salir caseta y un operador nacional de self-storage
debe salir torre, porque si los 9.000 y los 310.000 euros se dibujan
igual, el jugador no percibe que ha progresado.

El escalon se saca de la cadena de mejoras, igual que hacia tierOf() en
main.js: cuantos peldanos tiene un activo por encima suyo.

Dentro de un escalon la variedad es determinista: el mismo activo recibe
siempre el mismo modelo, pero dos vecinos del mismo escalon no salen
identicos.

    python tools/build_models_json.py
"""

import json
import os

DB = "src/data/assets_database.json"
ATLAS = "assets/atlas/sprites.json"
OUT = "src/data/models.json"

# Escalera de modelos por categoria. Cada nivel es una lista de candidatos:
# el activo elige uno segun el hash de su id, asi que la eleccion es
# estable entre partidas pero no repetitiva entre vecinos.
LADDER = {
    "real_estate": [
        ["house_02", "house_03", "house_06", "house_09"],                 # 1 caseta
        ["house_01", "house_04", "house_05", "house_07", "house_08"],     # 2 vivienda
        ["house_10", "house_15", "highlivingbuilding_b", "hotel_b"],      # 3 bloque
        ["highlivingbuilding_a", "highlivingbuilding_c",
         "highlivingbuilding_d"],                                          # 4 gran altura
        ["skyscraper_a", "skyscraper_c"],                                  # 5 torre
    ],
    "digital_business": [
        ["fruitshop", "cheesemarket", "musicshop"],                        # 1 puesto
        ["boutique", "restaurant", "travel agency", "sport"],              # 2 local
        ["supermarket_a", "supermarket_b", "gasstation_a", "gasstation_b"],# 3 comercio
        ["factorybuilding_a", "factorybuilding_b", "factorybuilding_c",
         "businesscenter"],                                                # 4 nave
        ["skyscraper_b", "skyscraper_a"],                                  # 5 corporacion
    ],
    "financial": [
        ["postoffice", "policestation"],                                   # 1 ventanilla
        ["bank", "school_a"],                                              # 2 sucursal
        ["government_a", "hospital_a"],                                    # 3 institucion
        ["businesscenter", "skyscraper_c"],                                # 4 gestora
        ["skyscraper_b", "skyscraper_c"],                                  # 5 fondo
    ],
}


def hash_str(s):
    """FNV-1a, el mismo que usa CityArt.js: misma semilla, mismo modelo."""
    h = 2166136261
    for ch in str(s):
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def chain_depth(asset_id, by_upgrade):
    """Peldanos que tiene por encima en la cadena de mejora."""
    depth, cur, guard = 0, asset_id, 6
    while guard > 0:
        parent = by_upgrade.get(cur)
        if parent is None:
            break
        depth += 1
        cur = parent
        guard -= 1
    return depth


def tiers_by_price(assets, rungs):
    """Reparte los activos de una categoria en escalones por precio.

    La posicion en la cadena de mejoras no vale para esto: solo nueve de
    los cincuenta y tres activos tienen padre, asi que casi todos caerian
    en el escalon 1 y un taller de 80.000 euros se dibujaria como un
    puesto de mercado. El precio, en cambio, es exactamente lo que el
    jugador percibe como tamano de la inversion.

    Se reparte por cuantiles DENTRO de cada categoria, no en global: los
    activos financieros van de 4.000 a 45.000 y los inmuebles hasta
    310.000; con bandas comunes, el distrito financiero entero saldria
    de escalon 1.
    """
    order = sorted(assets, key=lambda a: a["financials"]["total_price"])
    n = len(order)
    return {a["id"]: min(rungs, 1 + i * rungs // n) for i, a in enumerate(order)}


def main():
    db = json.load(open(DB, encoding="utf-8"))
    atlas = json.load(open(ATLAS))
    have = atlas["sprites"]
    assets = db["assets"]

    # id del hijo -> id del padre que mejora hacia el
    by_upgrade = {}
    for a in assets:
        if a.get("upgrade"):
            by_upgrade[a["upgrade"]] = a["id"]

    # escalon por precio, categoria a categoria
    tier_of = {}
    for cat, ladder in LADDER.items():
        same = [a for a in assets if a["category"] == cat]
        if same:
            tier_of.update(tiers_by_price(same, len(ladder)))
    for a in assets:
        tier_of.setdefault(a["id"], 1)

    models, missing, dist = {}, set(), {}
    for a in assets:
        cat = a["category"] if a["category"] in LADDER else "real_estate"
        # mejorar un activo lo sube de escalon: la mejora se VE
        tier = min(len(LADDER[cat]),
                   tier_of[a["id"]] + chain_depth(a["id"], by_upgrade))
        rung = LADDER[cat][tier - 1]
        cands = [c for c in rung if c in have]
        if not cands:
            missing.update(rung)
            cands = rung
        pick = cands[hash_str(a["id"]) % len(cands)]
        models[a["id"]] = {"sprite": pick, "tier": tier}
        dist["%s/%d" % (cat, tier)] = dist.get("%s/%d" % (cat, tier), 0) + 1

    out = {
        "_nota": ("Modelo 3D de cada activo. Generado por tools/build_models_json.py; "
                  "no editar a mano, se regenera al tocar la escalera de modelos."),
        "models": models,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)

    print("%d activos mapeados -> %s" % (len(models), OUT))
    for k in sorted(dist):
        print("  %-22s %d" % (k, dist[k]))
    if missing:
        print("\n  !! sin sprite en el atlas: " + ", ".join(sorted(missing)))
    used = {m["sprite"] for m in models.values()}
    print("\n  %d modelos distintos en uso" % len(used))


main()
