"""Mide la caja de un OBJ leyendo solo las lineas 'v '. Sin Blender."""
import sys, glob, os

def bbox(path):
    lo = [1e18]*3; hi = [-1e18]*3; n = 0
    with open(path, 'r', errors='ignore') as f:
        for line in f:
            if line.startswith('v '):
                p = line.split()
                for i in range(3):
                    val = float(p[i+1])
                    if val < lo[i]: lo[i] = val
                    if val > hi[i]: hi[i] = val
                n += 1
    if not n: return None
    return lo, hi, [hi[i]-lo[i] for i in range(3)], n

D = sys.argv[1]
for name in sys.argv[2:]:
    p = os.path.join(D, name + '.obj')
    if not os.path.exists(p):
        print(f"{name:28s} NO EXISTE"); continue
    lo, hi, size, n = bbox(p)
    print(f"{name:28s} size X={size[0]:8.2f} Y={size[1]:8.2f} Z={size[2]:8.2f}  verts={n:6d}  base_z={lo[1]:8.2f}")
