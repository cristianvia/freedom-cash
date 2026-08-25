/**
 * Layout.js
 * ------------------------------------------------------------------
 * Genera el mapa: una isla, sus manzanas y sus avenidas.
 *
 * Dos reglas que no se pueden romper:
 *
 * 1. LA ISLA NO CAMBIA NUNCA. Se genera entera de una vez a partir de la
 *    semilla de la partida y se queda así para siempre. Si el contorno se
 *    recalculase al subir de nivel, un edificio ya construido podría
 *    acabar en el agua. Lo que cambia con el nivel es qué manzanas están
 *    URBANIZADAS, no dónde está la tierra.
 *
 * 2. LA MISMA SEMILLA DA LA MISMA ISLA. Nada de Math.random() aquí: el
 *    ruido sale de un hash de las coordenadas, así que tu isla es tuya y
 *    sobrevive a recargar la página.
 *
 * El trazado en manzanas es lo que hace legible la ciudad. Las avenidas
 * caen cada cinco columnas y cada tres filas, dejando bloques de 4×2
 * solares. Dentro de cada bloque los edificios se ordenan por escalón —los
 * altos al fondo— y eso produce un skyline que se lee de un vistazo, en
 * vez del reguero de cajas sueltas que salía al rellenar en espiral.
 * ------------------------------------------------------------------
 */

/** Periodo de la trama: 5 solares y una avenida, 3 solares y una avenida.
 *  Con manzanas mas pequenas salia mas asfalto que ciudad. */
export const BLOCK_W = 5;
export const BLOCK_H = 3;
const PERIOD_X = BLOCK_W + 1;
const PERIOD_Y = BLOCK_H + 1;

export const COLS = 25;
export const ROWS = 25;

/** Manzanas urbanizadas al empezar; luego una más por nivel. */
const BLOCKS_AT_START = 1;

/* --------------------------- RUIDO ------------------------------- */

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Ruido de valor con interpolación suave: contornos orgánicos, no dentados. */
function noise2(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/* --------------------------- LA ISLA ------------------------------ */

export class Layout {
  constructor(seed = 1) {
    this.seed = seed >>> 0 || 1;
    this.cols = COLS;
    this.rows = ROWS;
    this.land = new Set();      // "c,r" que son tierra firme
    this.blocks = [];           // manzanas, ordenadas de dentro hacia fuera
    this._build();
  }

  key(c, r) { return c + ',' + r; }

  /** Perfil de la isla: un disco deformado por dos octavas de ruido. */
  _isLand(c, r) {
    const cx = (this.cols - 1) / 2, cy = (this.rows - 1) / 2;
    const R = Math.min(cx, cy);
    const nx = (c - cx) / R, ny = (r - cy) / R;
    const d = Math.sqrt(nx * nx + ny * ny);
    const n = noise2(c * 0.16, r * 0.16, this.seed) * 0.7
      + noise2(c * 0.42, r * 0.42, this.seed ^ 0x9e37) * 0.3;
    // el ruido empuja la orilla hacia dentro o hacia fuera
    return d + (n - 0.5) * 0.62 < 0.86;
  }

  _build() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this._isLand(c, r)) this.land.add(this.key(c, r));
      }
    }
    this._keepBiggestIsland();
    this._carveRoads();
    this._carveBlocks();
  }

  /**
   * Traza la red de avenidas y se queda solo con la parte conectada.
   *
   * Dos cosas se aprendieron probando veinte semillas. La primera, que la
   * avenida tiene que ganarle a la playa: si cualquier casilla que toca el
   * agua se vuelve arena, la costa siega las avenidas y la red queda
   * partida en once de cada veinte islas. Una avenida costera es una
   * avenida, y ademas queda bien.
   *
   * La segunda, que aun asi quedan muñones sueltos donde la isla se
   * estrecha. Se podan: un tramo de asfalto de dos casillas que no lleva a
   * ninguna parte se lee como un error, no como una carretera.
   */
  _carveRoads() {
    const all = new Set();
    for (const k of this.land) {
      const [c, r] = k.split(',').map(Number);
      if (c % PERIOD_X === 0 || r % PERIOD_Y === 0) all.add(k);
    }

    const seen = new Set();
    let best = null;
    for (const start of all) {
      if (seen.has(start)) continue;
      const group = [start];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const [c, r] = stack.pop().split(',').map(Number);
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = this.key(c + dc, r + dr);
          if (all.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); group.push(n); }
        }
      }
      if (!best || group.length > best.length) best = group;
    }
    this.roads = new Set(best || []);
  }

  /**
   * El ruido puede dejar islotes sueltos. Se conserva solo la masa mayor:
   * un solar al que no llega ninguna avenida es un solar inservible, y el
   * jugador no tiene forma de saber por qué no puede construir ahí.
   */
  _keepBiggestIsland() {
    const seen = new Set();
    let best = null;
    for (const k of this.land) {
      if (seen.has(k)) continue;
      const group = [];
      const stack = [k];
      seen.add(k);
      while (stack.length) {
        const cur = stack.pop();
        group.push(cur);
        const [c, r] = cur.split(',').map(Number);
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = this.key(c + dc, r + dr);
          if (this.land.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
      if (!best || group.length > best.length) best = group;
    }
    this.land = new Set(best || []);
  }

  /**
   * Traza las avenidas y agrupa lo que queda en manzanas.
   * Solo cuenta como manzana la que tiene al menos la mitad de sus
   * solares en tierra: media manzana asomando al mar no es sitio donde
   * construir, es una acera con vistas.
   */
  _carveBlocks() {
    const groups = new Map();

    for (const k of this.land) {
      const [c, r] = k.split(',').map(Number);
      if (this.roads.has(k) || this.isShore(c, r)) continue;
      const id = Math.floor(c / PERIOD_X) + ':' + Math.floor(r / PERIOD_Y);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ col: c, row: r });
    }

    const cx = (this.cols - 1) / 2, cy = (this.rows - 1) / 2;
    const full = BLOCK_W * BLOCK_H;
    this.blocks = [...groups.entries()]
      .filter(([, cells]) => cells.length >= full / 2)
      .map(([id, cells]) => {
        const mc = cells.reduce((s, p) => s + p.col, 0) / cells.length;
        const mr = cells.reduce((s, p) => s + p.row, 0) / cells.length;
        return { id, cells, mid: { col: mc, row: mr },
          d: Math.hypot(mc - cx, mr - cy) };
      })
      .sort((a, b) => a.d - b.d);

    // Se urbanizan de dentro hacia fuera: crecer es ganar costa.
    this.blocks.forEach((b, i) => { b.unlock = Math.max(1, i - BLOCKS_AT_START + 2); });
  }

  /* ------------------------- CONSULTA ---------------------------- */

  isAvenue(c, r) { return this.roads.has(this.key(c, r)); }

  /** ¿Toca el agua? Entonces es playa, no solar. */
  isShore(c, r) {
    if (!this.land.has(this.key(c, r))) return false;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!this.land.has(this.key(c + dc, r + dr))) return true;
    }
    return false;
  }

  /**
   * Mapa de terreno para un nivel de ciudad dado.
   * @returns {Map<string,string>} "c,r" -> lot | road | grass | sand | water
   */
  terrainAt(level) {
    const t = new Map();
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const k = this.key(c, r);
        if (!this.land.has(k)) { t.set(k, 'water'); continue; }
        t.set(k, this.isShore(c, r) ? 'sand' : 'grass');
      }
    }

    const lots = new Set();
    for (const b of this.blocks) {
      if (b.unlock > level) continue;
      for (const p of b.cells) {
        const k = this.key(p.col, p.row);
        if (t.get(k) === 'grass') { t.set(k, 'lot'); lots.add(k); }
      }
    }

    /*
     * El asfalto solo se pone donde hay ciudad. Trazar la retícula entera
     * desde el principio llenaba la isla de avenidas que no llevaban a
     * ninguna parte: salían más casillas de asfalto que de césped y el
     * mapa parecía un nudo de autopistas. Lo que no está urbanizado es
     * campo, y la calle aparece cuando llega el barrio.
     */
    for (const k of this.roads) {
      const [c, r] = k.split(',').map(Number);
      let touches = false;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (lots.has(this.key(c + dc, r + dr))) { touches = true; break; }
      }
      if (touches) t.set(k, 'road');
    }
    return t;
  }

  /** La manzana a la que pertenece una casilla, si es solar. */
  blockOf(col, row) {
    const id = Math.floor(col / PERIOD_X) + ':' + Math.floor(row / PERIOD_Y);
    return this.blocks.find(b => b.id === id) || null;
  }

  /** Manzanas ya urbanizadas, de dentro hacia fuera. */
  openBlocks(level) { return this.blocks.filter(b => b.unlock <= level); }

  /** Cuántos solares hay disponibles a este nivel. */
  lotCount(level) {
    return this.openBlocks(level).reduce((s, b) => s + b.cells.length, 0);
  }

  toJSON() { return { seed: this.seed }; }

  static fromJSON(d) { return new Layout(d && d.seed ? d.seed : 1); }
}
