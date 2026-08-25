/**
 * TerrainLayer.js
 * ------------------------------------------------------------------
 * Pinta el suelo: agua, playa, césped, solares y avenidas.
 *
 * Sustituye al tablero de dos verdes alternos que había antes, que era lo
 * que más delataba que esto era un prototipo.
 *
 * Reparto de trabajo, y el porqué de cada mitad:
 *
 *   LO PLANO se dibuja con Graphics, no con sprites: césped, arena, solar
 *   y agua son rombos de un color liso, y un sprite para eso solo añadiría
 *   peso al atlas y costuras entre baldosas. Los colores salen del mismo
 *   atlas de paleta que los edificios, así que casan sin retoques.
 *
 *   LAS AVENIDAS sí son sprites, porque llevan marcas viales, bordillo y
 *   volumen, y eso a mano no se dibuja bien. Se eligen por autotiling: una
 *   máscara de cuatro bits con los vecinos que también son avenida decide
 *   qué pieza toca.
 *
 *   EL AGUA es lo único que se anima. Es lo que más lo agradece —el mar
 *   quieto parece un error— y lo hace en su propia capa a 8 fotogramas por
 *   segundo, porque nada de esto necesita ir a sesenta.
 * ------------------------------------------------------------------
 */

/* Colores tomados del atlas del pack, para que el suelo case con los
 * edificios sin tener que retocar nada. */
/* Tres verdes MUY proximos entre si. Con tonos separados, la variacion
 * por casilla se lee como un damero de ajedrez en vez de como campo. */
const GRASS = [0x4e922f, 0x53982f, 0x498c2c];
const SAND = 0xd8c58f;
const SAND_DARK = 0xc9b47c;
const LOT = 0x8d8d88;
const LOT_EDGE = 0x777770;
const WATER_DEEP = 0x1f5c7d;
const WATER = 0x2d7fa4;
const WATER_LIGHT = 0x3d97bd;
const FOAM = 0xb9dfe9;

const WATER_FPS = 8;

/** Direcciones en el orden de la máscara de autotiling: N, E, S, O. */
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * Máscara de vecinos → pieza de vial. El bit 1 es norte, el 2 este, el 4
 * sur y el 8 oeste. Los casos de un solo vecino usan la recta que
 * corresponde: un final de calle se lee mejor como calle que como muñón.
 */
const ROAD_TILE = {
  0: 'road_cross',
  1: 'road_ns', 4: 'road_ns', 5: 'road_ns',
  2: 'road_ew', 8: 'road_ew', 10: 'road_ew',
  3: 'road_corner_ne', 6: 'road_corner_se',
  12: 'road_corner_sw', 9: 'road_corner_nw',
  7: 'road_t_e', 14: 'road_t_s', 13: 'road_t_w', 11: 'road_t_n',
  15: 'road_cross',
};

export class TerrainLayer {
  /**
   * @param {Phaser.Scene} scene
   * @param {City} city
   */
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.TW = scene.TW;
    this.TH = scene.TH;

    this.ground = scene.add.graphics().setDepth(-2000);
    this.sea = scene.add.graphics().setDepth(-2100);
    this.roads = [];
    this._t = 0;
    this._seaAt = 0;

    this.redraw();
  }

  /* --------------------------- DIBUJO ---------------------------- */

  iso(col, row) {
    return { x: (col - row) * (this.TW / 2), y: (col + row) * (this.TH / 2) };
  }

  /** Un rombo relleno, con borde opcional. */
  diamond(g, col, row, color, alpha = 1, edge = null, shrink = 0) {
    const { x, y } = this.iso(col, row);
    const hw = this.TW / 2 - shrink;
    const hh = this.TH / 2 - shrink / 2;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(x, y - hh);
    g.lineTo(x + hw, y);
    g.lineTo(x, y + hh);
    g.lineTo(x - hw, y);
    g.closePath();
    g.fillPath();
    if (edge != null) {
      g.lineStyle(1, edge, 0.5);
      g.strokePath();
    }
  }

  /** Contorno a trazos: dice «aquí se puede construir» sin gritar. */
  dashedDiamond(g, col, row, color, alpha, shrink) {
    const { x, y } = this.iso(col, row);
    const hw = this.TW / 2 - shrink;
    const hh = this.TH / 2 - shrink / 2;
    const pts = [[x, y - hh], [x + hw, y], [x, y + hh], [x - hw, y]];
    g.lineStyle(2, color, alpha);
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % 4];
      // tres trazos por lado, con hueco entre ellos
      for (let k = 0; k < 3; k++) {
        const t0 = k / 3 + 0.06, t1 = (k + 1) / 3 - 0.06;
        g.beginPath();
        g.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0);
        g.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
        g.strokePath();
      }
    }
  }

  /**
   * Ruido barato y estable: da variedad al césped sin guardar nada.
   *
   * Se muestrea a un tercio de resolucion para que las manchas abarquen
   * varias casillas. Sorteando un tono por casilla, el campo salia como
   * un tablero de ajedrez, que es justo lo que veniamos a quitar.
   */
  tint(col, row) {
    const c = Math.floor(col / 3), r = Math.floor(row / 3);
    const h = ((c * 73856093) ^ (r * 19349663) ^ ((col + row) * 83492791)) >>> 0;
    return (h % 1000) / 1000;
  }

  redraw() {
    const g = this.ground;
    g.clear();
    this.roads.forEach(r => r.destroy());
    this.roads = [];

    const t = this.city.terrain;
    for (const [key, kind] of t) {
      const [col, row] = key.split(',').map(Number);
      if (kind === 'water') continue;      // el mar va en su propia capa

      if (kind === 'sand') {
        this.diamond(g, col, row, this.tint(col, row) > 0.5 ? SAND : SAND_DARK);
      } else if (kind === 'lot') {
        /*
         * Cada solar es una parcela con su césped y su plataforma, no un
         * trozo de una losa continua. Pintando todas las casillas del
         * mismo gris, la manzana entera salía como un aparcamiento y no
         * se distinguía dónde acababa un solar y empezaba el siguiente.
         *
         * El solar libre se marca con un contorno claro: es la única
         * casilla donde se puede construir y eso tiene que verse ANTES de
         * abrir la tienda, no después.
         */
        const n = this.tint(col, row);
        this.diamond(g, col, row, GRASS[Math.floor(n * GRASS.length)]);
        const taken = this.city.occupied.has(col + ',' + row);
        if (taken) {
          this.diamond(g, col, row, LOT, 1, LOT_EDGE, this.TW * 0.06);
        } else {
          this.diamond(g, col, row, LOT, 0.35, null, this.TW * 0.13);
          this.dashedDiamond(g, col, row, 0xffffff, 0.5, this.TW * 0.11);
        }
      } else if (kind === 'road') {
        this.diamond(g, col, row, 0x3a3a38);
        this.addRoad(col, row, t);
      } else {
        const n = this.tint(col, row);
        this.diamond(g, col, row, GRASS[Math.floor(n * GRASS.length)]);
      }
    }
    this.drawSea(0);
  }

  /** Coloca la pieza de vial que casa con sus vecinas. */
  addRoad(col, row, terrain) {
    let mask = 0;
    DIRS.forEach(([dc, dr], i) => {
      if (terrain.get((col + dc) + ',' + (row + dr)) === 'road') mask |= 1 << i;
    });
    const name = ROAD_TILE[mask] || 'road_cross';
    const s = this.scene.atlas.sprites[name];
    if (!s) return;

    const { x, y } = this.iso(col, row);
    const [, , w, h] = s.frame;
    const img = this.scene.add.image(x, y, 'page:' + s.page, name);
    img.setOrigin(s.anchor[0] / w, s.anchor[1] / h);
    // justo encima del suelo y por debajo de cualquier edificio
    img.setDepth(-1900 + (col + row) * 0.01);
    this.roads.push(img);
  }

  /* ---------------------------- MAR ------------------------------ */

  /**
   * El mar, con una onda lenta que recorre la costa. No es decorativo por
   * capricho: un mar completamente quieto se lee como un fondo pintado y
   * delata que el mapa es una imagen fija.
   */
  drawSea(time) {
    const g = this.sea;
    g.clear();
    const t = this.city.terrain;

    for (const [key, kind] of t) {
      if (kind !== 'water') continue;
      const [col, row] = key.split(',').map(Number);
      const wave = Math.sin((col + row) * 0.55 + time * 0.0016);
      const near = this.touchesLand(col, row, t);
      const base = near ? WATER_LIGHT : (wave > 0.35 ? WATER : WATER_DEEP);
      this.diamond(g, col, row, base);
      if (near) {
        // espuma en la orilla, latiendo con la misma onda
        this.diamond(g, col, row, FOAM, 0.16 + 0.14 * (wave + 1) / 2, null, 6);
      }
    }
  }

  touchesLand(col, row, t) {
    for (const [dc, dr] of DIRS) {
      const k = (col + dc) + ',' + (row + dr);
      const v = t.get(k);
      if (v && v !== 'water') return true;
    }
    return false;
  }

  update(time) {
    if (time - this._seaAt < 1000 / WATER_FPS) return;
    this._seaAt = time;
    this.drawSea(time);
  }

  destroy() {
    this.ground.destroy();
    this.sea.destroy();
    this.roads.forEach(r => r.destroy());
  }
}
