"""
render_isometric.py
======================================================================
Convierte los modelos 3D del pack en sprites isometricos 2:1 listos
para Phaser. Se ejecuta dentro de Blender, sin interfaz:

    blender -b -P tools/render_isometric.py -- --list tools/catalog.txt

Por que pre-renderizar en vez de llevar el 3D al navegador: aqui podemos
pagar oclusion ambiental y sombras suaves que en WebGL en tiempo real no
nos podriamos permitir en un movil. El coste es la camara fija, que en un
city builder no se echa de menos.

Tres decisiones que sostienen todo lo demas:

  1. PIXELES POR UNIDAD CONSTANTE. No se encuadra cada modelo para que
     llene su lienzo: todos se renderizan a la misma escala y luego se
     recortan. Asi un rascacielos sale de verdad mas alto que una casa,
     sin ajustar nada a ojo despues.

  2. ANCLA EXPLICITA. De cada sprite se guarda en que pixel cae el centro
     de su base. Sin ese dato el motor no sabe donde posarlo en el rombo
     y los edificios flotan o se hunden.

  3. TEXTURA SIN FILTRAR. El pack usa un atlas de paleta: cada cara
     apunta a un parche de color de pocos pixeles. Con interpolacion
     lineal los parches vecinos se mezclan y salen halos. Va en Closest.
======================================================================
"""

import bpy, bmesh, sys, os, json, math, argparse
import numpy as np
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

# --------------------------------------------------------------------
# Geometria de la proyeccion
# --------------------------------------------------------------------
# Isometrico 2:1 de videojuego: la elevacion no es la isometrica real de
# 35,26 grados sino arctan(0,5) = 26,565, que es la que hace que un rombo
# mida exactamente el doble de ancho que de alto.
ELEVATION = math.degrees(math.atan(0.5))   # 26.565
CAM_ROT_X = math.radians(90 - ELEVATION)   # 63.435
CAM_ROT_Z = math.radians(45)

TILE_WORLD = 15.0    # unidades de mundo que ocupa una baldosa (medido en el pack)
TILE_PX    = 256     # ancho del rombo en pixeles (retina @2x; el juego usa 128)

# Un cuadrado de TILE_WORLD girado 45 grados mide su diagonal de ancho en
# el plano de camara. De ahi salen los pixeles por unidad.
PPU = TILE_PX / (TILE_WORLD * math.sqrt(2))

MARGIN_PX  = 24      # aire alrededor, para que la sombra no se corte
MAX_RES    = 4096    # tope de seguridad para el estadio y compania

TEXTURE = "assets/low-poly-city-builder/Texture/color_1024x1024.jpg"
OBJ_DIR = "assets/low-poly-city-builder/OBJ"
OUT_DIR = "tools/render_out"


# --------------------------------------------------------------------
def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def pick_engine(scene, want):
    """EEVEE cambio de nombre entre versiones; se elige el que exista."""
    prop = scene.bl_rna.properties["render"].fixed_type.bl_rna.properties["engine"]
    avail = [i.identifier for i in prop.enum_items]
    order = ["CYCLES"] if want == "cycles" else ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"]
    for e in order:
        if e in avail:
            return e
    return avail[0]


def setup_scene(engine="eevee", samples=64):
    scene = bpy.context.scene
    scene.render.engine = pick_engine(scene, engine)
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.resolution_percentage = 100

    if scene.render.engine == "CYCLES":
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        scene.cycles.max_bounces = 4
    else:
        # EEVEE Next: sombras y trazado de rayos, si la version los trae
        for attr, val in (("taa_render_samples", samples),
                          ("use_shadows", True),
                          ("use_raytracing", True)):
            if hasattr(scene.eevee, attr):
                setattr(scene.eevee, attr, val)

    # --- Luz: sol calido de arriba-izquierda + cielo frio de relleno ---
    # La clave de que un low poly se lea bien es que la cara en sombra no
    # sea negra sino azulada: da volumen sin necesidad de mas geometria.
    sun_data = bpy.data.lights.new("Sun", type="SUN")
    sun_data.energy = 3.2
    sun_data.angle = math.radians(8)          # penumbra suave, no dura
    sun_data.color = (1.0, 0.96, 0.88)
    sun = bpy.data.objects.new("Sun", sun_data)
    sun.rotation_euler = (math.radians(52), 0, math.radians(35))
    scene.collection.objects.link(sun)

    fill_data = bpy.data.lights.new("Fill", type="SUN")
    fill_data.energy = 0.9
    fill_data.color = (0.72, 0.82, 1.0)
    fill = bpy.data.objects.new("Fill", fill_data)
    fill.rotation_euler = (math.radians(115), 0, math.radians(215))
    scene.collection.objects.link(fill)

    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.55, 0.68, 0.85, 1)
    bg.inputs[1].default_value = 0.45
    scene.world = world

    # --- Camara ortografica ---
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.clip_start = 1.0
    cam_data.clip_end = 20000.0
    cam = bpy.data.objects.new("Cam", cam_data)
    cam.rotation_euler = (CAM_ROT_X, 0, CAM_ROT_Z)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return scene, cam


def make_material():
    """Un solo material para todo el pack: comparten atlas de color."""
    mat = bpy.data.materials.new("CityAtlas")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.62
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.25

    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(os.path.abspath(TEXTURE))
    tex.interpolation = "Closest"      # atlas de paleta: nada de filtrado
    tex.location = (-400, 300)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def import_obj(path):
    """Importa las mallas nuevas y les hornea la transformacion.

    El importador de OBJ NO reorienta los vertices: deja el modelo con Y
    arriba y le cuelga una rotacion al objeto. Las coordenadas locales
    quedan entonces en un sistema distinto al del mundo, y cualquier
    calculo hecho sobre ellas -la normal de una cara, el eje de escalado-
    apunta a donde no es. Horneando la transformacion, local y mundo pasan
    a ser lo mismo y el resto del fichero puede fiarse de la Z.
    """
    before = set(bpy.data.objects)
    bpy.ops.wm.obj_import(filepath=os.path.abspath(path),
                          forward_axis="NEGATIVE_Z", up_axis="Y")
    objs = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if objs:
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return objs


# --------------------------------------------------------------------
# Despiece del suelo
# --------------------------------------------------------------------
# Cada modelo del pack trae su propia parcela: cesped, acera y a veces un
# aparcamiento entero. Eso impide pintar un terreno coherente debajo,
# porque los bordes de parcelas vecinas se pisan y sus tonos no casan.
#
# El suelo NO se detecta por geometria sino por COLOR, que es lo que
# resulto fiable al medirlo sobre los 54 edificios del catalogo: las caras
# de suelo son horizontales, grandes, estan a ras del punto mas bajo, y su
# color en el atlas cae siempre en dos familias: gris neutro (acera, entre
# 61 y 117 de luminancia) o verde cesped. Catorce coordenadas UV cubren el
# 75% del area de suelo del catalogo.
#
# El umbral de area es lo que salva los escalones, bordillos y aceras de
# entrada, que son horizontales, bajos y grises pero legitimos.

GROUND_MIN_AREA = 6.0     # u^2 por cara: por debajo es detalle, no suelo
GROUND_MAX_H = 0.60       # altura sobre el punto mas bajo del modelo
GROUND_FLAT = 0.985       # |normal.z| minimo para considerarla horizontal
GROUND_SKIRT_H = 0.30     # grosor del canto de la losa, que va sin umbral de area


def load_atlas_pixels():
    """El atlas de color, como array (alto, ancho, 4) para muestrear rapido."""
    img = bpy.data.images.load(os.path.abspath(TEXTURE))
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    return px


def is_ground_color(rgb, paint=False):
    """¿Es color de acera, asfalto o cesped?

    El verde se decide por MATIZ, no por proporcion entre canales. El pack
    usa cespedes que van del verde vivo (0.20, 0.73, 0.37) al apagado
    (0.31, 0.55, 0.39), y cualquier regla del tipo «el verde dobla al
    azul» deja fuera los segundos. El matiz los agrupa a todos.
    """
    r, g, b = float(rgb[0]), float(rgb[1]), float(rgb[2])
    lo, hi = min(r, g, b), max(r, g, b)
    d = hi - lo

    # gris neutro: acera y asfalto. Ni negro ni blanco.
    #
    # El blanco se excluye del caso general para no comerse paredes ni
    # cubiertas claras, pero a ras de suelo solo puede ser pintura vial:
    # sin esta excepcion, al quitar el asfalto de un aparcamiento quedan
    # flotando las rayas de las plazas.
    if d < 0.075:
        return 0.12 < hi < 0.70 or (paint and hi > 0.85)

    sat = d / hi if hi > 0 else 0
    if sat < 0.15 or hi < 0.18:
        return False

    if hi == r:
        hue = 60 * (((g - b) / d) % 6)
    elif hi == g:
        hue = 60 * (2 + (b - r) / d)
    else:
        hue = 60 * (4 + (r - g) / d)

    return 65 <= hue <= 175        # de verde lima a verde azulado


def strip_ground(objs, atlas):
    """Borra las caras de suelo. Devuelve cuantas cayeron."""
    ah, aw = atlas.shape[0], atlas.shape[1]
    removed = 0
    for o in objs:
        me = o.data
        bm = bmesh.new()
        bm.from_mesh(me)
        uv_layer = bm.loops.layers.uv.active
        if uv_layer is None:
            bm.free()
            continue

        bm.verts.ensure_lookup_table()
        zmin = min((o.matrix_world @ v.co).z for v in bm.verts)

        def ground_color_of(f, paint=False):
            u = sum(l[uv_layer].uv.x for l in f.loops) / len(f.loops)
            v = sum(l[uv_layer].uv.y for l in f.loops) / len(f.loops)
            x = min(aw - 1, max(0, int(u * aw)))
            y = min(ah - 1, max(0, int(v * ah)))   # pixels de Blender: fila 0 abajo
            return is_ground_color(atlas[y, x], paint=paint)

        doomed = []
        for f in bm.faces:
            top = max((o.matrix_world @ v.co).z for v in f.verts)

            # 1) la losa: horizontal, a ras de suelo y grande
            big_slab = (abs(f.normal.z) >= GROUND_FLAT
                        and top <= zmin + GROUND_MAX_H
                        and f.calc_area() >= GROUND_MIN_AREA)

            # 2) su canto: la losa tiene un dedo de grosor y sus caras
            #    laterales son verticales, asi que la regla de arriba no las
            #    toca y quedan como un reborde oscuro flotando alrededor del
            #    edificio. Aqui no se pide area: son tiras finas.
            skirt = top <= zmin + GROUND_SKIRT_H

            if (big_slab or skirt) and ground_color_of(f, paint=True):
                doomed.append(f)

        if doomed:
            bmesh.ops.delete(bm, geom=doomed, context="FACES")
            # los vertices que se quedan sin ninguna cara no se ven, pero
            # cuentan para la caja envolvente y descuadrarian el ancla
            loose = [v for v in bm.verts if not v.link_faces]
            if loose:
                bmesh.ops.delete(bm, geom=loose, context="VERTS")
            removed += len(doomed)
            bm.to_mesh(me)
            me.update()
        bm.free()
    return removed


# --------------------------------------------------------------------
# Composicion de baldosas
# --------------------------------------------------------------------
# Los viales del pack no teselan: miden 12, 15, 17 o 21 unidades de ancho
# porque en la escena original van ENTRE parcelas, no sobre casillas. Un
# tramo recto (12x5) se convierte en baldosa repitiendolo tres veces a lo
# largo y estirando el ancho a 15: las marcas viales quedan intactas y el
# resultado tesela exactamente.

def compose(objs, repeat, fit):
    """Repite las mallas en rejilla y las escala a un cuadrado de `fit`."""
    rx, ry = repeat
    lo, hi = world_bbox(objs)
    sx, sy = hi.x - lo.x, hi.y - lo.y

    made = list(objs)
    for ix in range(rx):
        for iy in range(ry):
            if ix == 0 and iy == 0:
                continue
            for o in objs:
                d = o.copy()
                d.data = o.data.copy()
                d.location = (o.location.x + ix * sx, o.location.y + iy * sy,
                              o.location.z)
                bpy.context.scene.collection.objects.link(d)
                made.append(d)

    # Sin esto, los duplicados recien enlazados aun tienen su matriz de
    # mundo sin recalcular y la caja sale con las medidas de antes.
    bpy.context.view_layer.update()
    lo, hi = world_bbox(made)
    kx = fit / max(1e-6, hi.x - lo.x)
    ky = fit / max(1e-6, hi.y - lo.y)
    for o in made:
        o.scale = (o.scale.x * kx, o.scale.y * ky, o.scale.z * min(kx, ky))
        o.location = ((o.location.x - lo.x) * kx, (o.location.y - lo.y) * ky,
                      o.location.z * min(kx, ky))
    bpy.context.view_layer.update()
    return made


def world_bbox(objs):
    lo = Vector((1e18,) * 3)
    hi = Vector((-1e18,) * 3)
    for o in objs:
        for corner in o.bound_box:
            p = o.matrix_world @ Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    return lo, hi


def camera_extent(lo, hi, cam):
    """Cuanto ocupa la caja en el plano de la camara, en unidades."""
    m = cam.matrix_world.inverted()
    xs, ys = [], []
    for ix in (lo.x, hi.x):
        for iy in (lo.y, hi.y):
            for iz in (lo.z, hi.z):
                p = m @ Vector((ix, iy, iz))
                xs.append(p.x)
                ys.append(p.y)
    return max(xs) - min(xs), max(ys) - min(ys)


def render_one(entry, mat, scene, cam, out_dir, supersample, atlas):
    name = entry["name"]
    src = os.path.join(OBJ_DIR, entry.get("src", name) + ".obj")
    if not os.path.exists(src):
        print("  !! sin fichero: " + name)
        return None

    objs = import_obj(src)
    if not objs:
        print("  !! sin malla: " + name)
        return None
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)

    stripped = 0
    if entry.get("strip_base") and atlas is not None:
        stripped = strip_ground(objs, atlas)

    if entry.get("compose"):
        c = entry["compose"]
        objs = compose(objs, c.get("repeat", [1, 1]), c.get("fit", TILE_WORLD))


    # En isometrica un sprite NO se puede rotar en pantalla: una recta que
    # va de noreste a suroeste no se ve igual que la misma girada, porque
    # la proyeccion no es simetrica. Las cuatro orientaciones de cada pieza
    # de vial hay que renderizarlas de verdad, girando el modelo aqui.
    #
    # Va DESPUES de componer: al reves, el eje en el que se repite la pieza
    # gira con ella y una recta este-oeste acabaria repetida a lo ancho.
    if entry.get("rotate"):
        lo0, hi0 = world_bbox(objs)
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.transform.rotate(value=math.radians(entry["rotate"]),
                                 orient_axis="Z",
                                 center_override=tuple((lo0 + hi0) / 2))
        bpy.context.view_layer.update()

    lo, hi = world_bbox(objs)
    if hi.x - lo.x <= 0 or hi.z - lo.z <= 0:
        print("  !! el modelo se quedo vacio: " + name)
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
        return None
    # El ancla es el centro de la base: donde se posa en el rombo.
    anchor = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    # Pero la camara apunta al centro de la CAJA, no al ancla: si mirase al
    # ancla, el edificio creceria hacia arriba desde el centro del fotograma
    # y a un rascacielos se le cortaria la azotea.
    center = (lo + hi) / 2

    view_dir = cam.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    cam.location = center - view_dir * 5000.0

    ext_w, ext_h = camera_extent(lo, hi, cam)
    res_x = min(MAX_RES, int((ext_w * PPU + MARGIN_PX * 2) * supersample))
    res_y = min(MAX_RES, int((ext_h * PPU + MARGIN_PX * 2) * supersample))
    res_x += res_x % 2
    res_y += res_y % 2

    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    # ortho_scale se aplica siempre al lado mayor del fotograma
    cam.data.ortho_scale = max(res_x, res_y) / (PPU * supersample)

    out_png = os.path.join(out_dir, name + ".png")
    scene.render.filepath = os.path.abspath(out_png)
    bpy.ops.render.render(write_still=True)

    u, v, _ = world_to_camera_view(scene, cam, anchor)
    meta = {
        "name": name,
        "res": [res_x, res_y],
        "supersample": supersample,
        "anchor_px": [round(u * res_x, 2), round((1 - v) * res_y, 2)],
        "size_world": [round(hi.x - lo.x, 3), round(hi.y - lo.y, 3), round(hi.z - lo.z, 3)],
        "footprint_tiles": [max(1, round((hi.x - lo.x) / TILE_WORLD)),
                            max(1, round((hi.y - lo.y) / TILE_WORLD))],
        "tile_px": TILE_PX,
        "tile_world": TILE_WORLD,
        "kind": entry.get("kind", "building"),
    }
    if entry.get("footprint"):
        meta["footprint_tiles"] = entry["footprint"]   # las baldosas mandan la suya
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    print("  ok %-26s %4dx%-4d huella %s%s"
          % (name, res_x, res_y, meta["footprint_tiles"],
             ("  -%d caras de suelo" % stripped) if stripped else ""))
    return meta


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="tools/catalog.json")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--engine", default="eevee", choices=["eevee", "cycles"])
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--supersample", type=float, default=2.0)
    ap.add_argument("--only", default=None, help="coma-separado, para probar")
    ap.add_argument("--merge", action="store_true",
                    help="conserva del manifiesto anterior lo que no se re-renderiza")
    args = ap.parse_args(argv)

    cat = json.load(open(args.list, encoding="utf-8"))
    defaults = cat.get("defaults", {})
    entries = []
    for e in cat["entries"]:
        if isinstance(e, str):
            e = {"name": e}
        merged = dict(defaults)
        merged.update(e)
        entries.append(merged)

    if args.only:
        want = {n.strip() for n in args.only.split(",") if n.strip()}
        entries = [e for e in entries if e["name"] in want]

    os.makedirs(args.out, exist_ok=True)
    clean_scene()
    scene, cam = setup_scene(args.engine, args.samples)
    mat = make_material()
    atlas = load_atlas_pixels()

    print("\nMotor %s | %d modelos | %.3f px/unidad | supersample x%s\n"
          % (scene.render.engine, len(entries), PPU, args.supersample))

    manifest = {}
    out_manifest_path = os.path.join(args.out, "manifest.json")
    if args.merge and os.path.exists(out_manifest_path):
        manifest = json.load(open(out_manifest_path))

    for i, e in enumerate(entries, 1):
        print("[%d/%d] %s" % (i, len(entries), e["name"]))
        m = render_one(e, mat, scene, cam, args.out, args.supersample, atlas)
        if m:
            manifest[e["name"]] = m

    with open(out_manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print("\nListo: %d sprites en %s" % (len(manifest), args.out))


main()
