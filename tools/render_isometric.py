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

import bpy, sys, os, json, math, argparse
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
    """Importa y devuelve las mallas nuevas, ya con Z arriba."""
    before = set(bpy.data.objects)
    bpy.ops.wm.obj_import(filepath=os.path.abspath(path),
                          forward_axis="NEGATIVE_Z", up_axis="Y")
    return [o for o in bpy.data.objects if o not in before and o.type == "MESH"]


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


def render_one(name, mat, scene, cam, out_dir, supersample):
    src = os.path.join(OBJ_DIR, name + ".obj")
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

    lo, hi = world_bbox(objs)
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
    }
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    print("  ok %-28s %dx%d  huella %s" % (name, res_x, res_y, meta["footprint_tiles"]))
    return meta


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default="tools/catalog.txt")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--engine", default="eevee", choices=["eevee", "cycles"])
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--supersample", type=float, default=2.0)
    ap.add_argument("--only", default=None, help="coma-separado, para probar")
    args = ap.parse_args(argv)

    if args.only:
        names = [n.strip() for n in args.only.split(",") if n.strip()]
    else:
        with open(args.list) as f:
            names = [l.split("#")[0].strip() for l in f]
        names = [n for n in names if n]

    os.makedirs(args.out, exist_ok=True)
    clean_scene()
    scene, cam = setup_scene(args.engine, args.samples)
    mat = make_material()

    print("\nMotor %s | %d modelos | %.3f px/unidad | supersample x%s\n"
          % (scene.render.engine, len(names), PPU, args.supersample))

    manifest = {}
    for i, n in enumerate(names, 1):
        print("[%d/%d] %s" % (i, len(names), n))
        m = render_one(n, mat, scene, cam, args.out, args.supersample)
        if m:
            manifest[n] = m

    out_manifest = os.path.join(args.out, "manifest.json")
    with open(out_manifest, "w") as f:
        json.dump(manifest, f, indent=2)
    print("\nListo: %d sprites en %s" % (len(manifest), args.out))


main()
