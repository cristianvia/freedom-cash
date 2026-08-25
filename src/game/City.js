/**
 * City.js
 * ------------------------------------------------------------------
 * El estado de la ciudad y los tres sistemas que la mueven: obras,
 * producción de renta y producción de materiales.
 *
 * Van juntos en un fichero a propósito. Los tres mutan el mismo registro
 * —la parcela— y separarlos en tres módulos obligaría a pasarse el mismo
 * objeto de un lado a otro sin ganar nada a cambio.
 *
 * LA PARCELA es el registro central:
 *
 *   { uid, kind, sprite, col, row, fw, fh,
 *     state: 'building' | 'ready',
 *     doneAt,        cuándo termina la obra
 *     collectedAt,   última vez que se recogió
 *     instanceId }   enlace al activo dentro de EconomyEngine
 *
 * El dinero NO vive aquí. Vive en EconomyEngine, que sigue siendo la
 * única fuente de verdad de la economía: cuánto renta un activo, qué
 * impuestos paga y cuánto vale hoy lo decide él. La ciudad solo decide
 * CUÁNDO se cobra y DÓNDE está el edificio.
 * ------------------------------------------------------------------
 */

import {
  tierRules, buildersAt, materialCap, MATERIAL_PLANTS, CIVIC, JOB_BUILDING,
  SCENERY, PERIOD_MS, xpForLevel,
} from './rules.js';
import { Layout, BLOCK_H } from './Layout.js';

/** Cuadrantes temáticos, como en la ciudad antigua: cada categoría, su barrio. */
const DISTRICTS = ['real_estate', 'digital_business', 'financial'];

/** Lo que cuesta convertir una casilla de césped en solar edificable. */
export const URBANIZE_COST = 2500;
export const URBANIZE_MATERIALS = 6;

/* Que terreno admite cada cosa. Los edificios solo van en solar; la
 * decoracion vive en el cesped de fuera de las manzanas, y asi deja de
 * robar sitio construible como hacia antes. */
const LOT_ONLY = new Set(['lot']);
const GRASS_ONLY = new Set(['grass']);

export class City {
  /**
   * @param {EconomyEngine} engine
   * @param {object} models  contenido de models.json
   * @param {object} atlas   contenido de sprites.json
   * @param {number} seed    semilla de la isla
   */
  constructor(engine, models, atlas, seed = 1) {
    this.engine = engine;
    this.models = models.models || models;
    this.atlas = atlas.sprites || atlas;

    /*
     * En el juego por turnos el recurso escaso era «acciones por mes».
     * Aquí ese papel lo hacen los constructores y los materiales, que se
     * ven y se esperan, así que el contador de acciones del motor sobra:
     * se abre del todo para que no bloquee compras.
     */
    engine.ACTIONS_BASE = 9999;
    engine.ACTIONS_MAX = 9999;

    this.layout = new Layout(seed);
    this.cols = this.layout.cols;
    this.rows = this.layout.rows;
    this.plots = new Map();     // uid -> parcela
    this.occupied = new Map();  // "col,row" -> uid
    this._uid = 0;

    this.materials = 20;
    this.level = 1;
    this.xp = 0;
    this.urbanized = new Set();   // césped comprado y convertido en solar
    this.refreshTerrain();

    this.seedCivic();
  }

  /* ============================ REJILLA ============================ */

  key(col, row) { return col + ',' + row; }

  /**
   * Recalcula el mapa de terreno. Se llama al subir de nivel (se abren
   * manzanas) y al urbanizar césped. La ISLA no se toca nunca: lo que
   * cambia es qué está urbanizado, no dónde está la tierra. Si el
   * contorno se recalculase, un edificio ya puesto podría acabar en el mar.
   */
  refreshTerrain() {
    this.terrain = this.layout.terrainAt(this.level);
    for (const k of this.urbanized) {
      if (this.terrain.get(k) === 'grass') this.terrain.set(k, 'lot');
    }
  }

  terrainAt(col, row) { return this.terrain.get(this.key(col, row)) || 'water'; }

  inBounds(col, row, fw = 1, fh = 1) {
    return col >= 0 && row >= 0 && col + fw <= this.cols && row + fh <= this.rows;
  }

  /**
   * ¿Cabe aquí un edificio de fw×fh?
   *
   * `ignoreUid` existe para poder MOVER una pieza: al comprobar su nuevo
   * sitio hay que ignorar las casillas que ella misma ocupa todavía, o
   * cualquier movimiento que se solape con su posición actual se
   * rechazaría por chocar consigo misma.
   */
  isFree(col, row, fw = 1, fh = 1, ignoreUid = null, allowed = LOT_ONLY) {
    if (!this.inBounds(col, row, fw, fh)) return false;
    for (let c = col; c < col + fw; c++) {
      for (let r = row; r < row + fh; r++) {
        if (!allowed.has(this.terrainAt(c, r))) return false;
        const uid = this.occupied.get(this.key(c, r));
        if (uid != null && uid !== ignoreUid) return false;
      }
    }
    return true;
  }

  /** Césped que se puede comprar para convertirlo en solar. */
  canUrbanize(col, row) {
    return this.terrainAt(col, row) === 'grass';
  }

  urbanize(col, row) {
    if (!this.canUrbanize(col, row)) return false;
    this.urbanized.add(this.key(col, row));
    this.terrain.set(this.key(col, row), 'lot');
    return true;
  }

  /* ------------------------ REPARTO POR ESCALÓN -------------------- */

  /**
   * Fila que le toca a un escalón dentro de su manzana: los altos al
   * fondo, los bajos al frente. Es lo que produce el skyline legible;
   * rellenando por orden de llegada, la ciudad queda como un reguero de
   * cajas sueltas donde no se distingue una torre de un trastero.
   */
  _wantedRowInBlock(tier) {
    const t = Math.max(1, Math.min(5, tier || 1));
    return Math.round((5 - t) / 4 * (BLOCK_H - 1));
  }

  /**
   * Busca el mejor solar libre. Se puntúa cada candidato en vez de
   * recorrer en espiral: así entran a la vez el escalón, el barrio
   * temático y la cercanía al centro, que es como se decide de verdad.
   */
  findSpot(fw, fh, category, tier = 1) {
    const wanted = this._wantedRowInBlock(tier);
    const catIndex = Math.max(0, DISTRICTS.indexOf(category));
    let best = null, bestScore = -Infinity;

    for (const b of this.layout.openBlocks(this.level)) {
      const rows = b.cells.map(p => p.row);
      const top = Math.min(...rows);
      // cada categoría tira hacia una zona distinta de la isla
      const affinity = (Math.abs(b.id.split(':')[0] - catIndex) % 3) === 0 ? 2 : 0;

      for (const p of b.cells) {
        if (!this.isFree(p.col, p.row, fw, fh)) continue;
        const score = affinity
          - Math.abs((p.row - top) - wanted) * 4   // el escalón manda
          - b.d * 0.5                              // luego, hacia el centro
          - p.col * 0.01;                          // desempate estable
        if (score > bestScore) { bestScore = score; best = { col: p.col, row: p.row }; }
      }
    }
    return best;
  }

  /** ¿Queda algún solar libre? Sirve para avisar antes de abrir la tienda. */
  freeLots() {
    let n = 0;
    for (const b of this.layout.openBlocks(this.level)) {
      for (const p of b.cells) if (this.isFree(p.col, p.row)) n++;
    }
    return n;
  }

  footprintOf(sprite) {
    const s = this.atlas[sprite];
    return s && s.footprint ? s.footprint : [1, 1];
  }

  /* =========================== PARCELAS ============================ */

  _occupy(plot) {
    for (let c = plot.col; c < plot.col + plot.fw; c++) {
      for (let r = plot.row; r < plot.row + plot.fh; r++) {
        this.occupied.set(this.key(c, r), plot.uid);
      }
    }
  }

  _release(plot) {
    for (let c = plot.col; c < plot.col + plot.fw; c++) {
      for (let r = plot.row; r < plot.row + plot.fh; r++) {
        if (this.occupied.get(this.key(c, r)) === plot.uid) {
          this.occupied.delete(this.key(c, r));
        }
      }
    }
  }

  /**
   * Coloca una parcela. Si lleva buildMs, arranca en obra; si no, ya está.
   * @returns {object|null} la parcela creada
   */
  add(spec, col = null, row = null) {
    const [fw, fh] = this.footprintOf(spec.sprite);
    const allowed = spec.kind === 'scenery' ? GRASS_ONLY : LOT_ONLY;
    const spot = (col != null && this.isFree(col, row, fw, fh, null, allowed))
      ? { col, row }
      : (allowed === LOT_ONLY
        ? this.findSpot(fw, fh, spec.category, spec.tier)
        : null);
    if (!spot) return null;

    const now = Date.now();
    const plot = {
      uid: ++this._uid,
      kind: spec.kind || 'asset',
      sprite: spec.sprite,
      category: spec.category || 'real_estate',   // lo necesita arrange()
      col: spot.col, row: spot.row, fw, fh,
      tier: spec.tier || 1,
      instanceId: spec.instanceId || null,
      plantId: spec.plantId || null,
      civicId: spec.civicId || null,
      state: spec.buildMs > 0 ? 'building' : 'ready',
      doneAt: now + (spec.buildMs || 0),
      collectedAt: now,
    };
    this.plots.set(plot.uid, plot);
    this._occupy(plot);
    return plot;
  }

  remove(uid) {
    const plot = this.plots.get(uid);
    if (!plot) return;
    this._release(plot);
    this.plots.delete(uid);
  }

  /**
   * Muda un edificio a otro solar. Ni la obra en curso ni el reloj de
   * cobro se tocan: mudarse no debe castigarte, o nadie reordenaria nunca
   * su ciudad y la funcion no serviria de nada.
   * @returns {boolean} si cupo
   */
  move(uid, col, row) {
    const plot = this.plots.get(uid);
    if (!plot) return false;
    if (!this.isFree(col, row, plot.fw, plot.fh, uid)) return false;
    this._release(plot);
    plot.col = col;
    plot.row = row;
    this._occupy(plot);
    return true;
  }

  /**
   * Realinea la ciudad entera: cada edificio a la fila que le toca por
   * escalon dentro de su manzana. Ademas de arreglar el desorden de una
   * racha de compras, es la forma de ensenar al jugador como DEBERIA
   * verse su ciudad.
   * @returns {number} cuantos se movieron
   */
  arrange() {
    const movable = this.list()
      .filter(p => p.kind !== 'scenery')
      .sort((a, b) => (b.tier || 1) - (a.tier || 1) || b.fw * b.fh - a.fw * a.fh);

    movable.forEach(p => this._release(p));
    let moved = 0;
    for (const p of movable) {
      const spot = this.findSpot(p.fw, p.fh, p.category || 'real_estate', p.tier);
      const to = spot || { col: p.col, row: p.row };
      if (to.col !== p.col || to.row !== p.row) moved++;
      p.col = to.col;
      p.row = to.row;
      this._occupy(p);
    }
    return moved;
  }

  list() { return [...this.plots.values()]; }

  at(col, row) {
    const uid = this.occupied.get(this.key(col, row));
    return uid == null ? null : this.plots.get(uid);
  }

  /* ============================= OBRAS ============================= */

  building() { return this.list().filter(p => p.state === 'building'); }

  buildersTotal() { return buildersAt(this.level); }

  buildersFree() { return this.buildersTotal() - this.building().length; }

  /** Pasa a 'ready' lo que haya terminado. Devuelve lo recién acabado. */
  tickBuilds(now = Date.now()) {
    const done = [];
    for (const p of this.plots.values()) {
      if (p.state === 'building' && now >= p.doneAt) {
        p.state = 'ready';
        p.collectedAt = now;
        done.push(p);
      }
    }
    return done;
  }

  /** Acelera una obra: el atajo que en estos juegos se paga con gemas. */
  finishNow(uid) {
    const p = this.plots.get(uid);
    if (!p || p.state !== 'building') return false;
    p.doneAt = Date.now();
    return true;
  }

  buildProgress(plot, now = Date.now()) {
    const r = tierRules(plot.tier);
    const total = plot.kind === 'plant'
      ? (MATERIAL_PLANTS.find(m => m.id === plot.plantId) || {}).buildMs || r.buildMs
      : r.buildMs;
    return Math.min(1, 1 - (plot.doneAt - now) / Math.max(1, total));
  }

  /* =========================== PRODUCCIÓN ========================== */

  /** Ritmo de cobro de una parcela: cada cuánto llena una tanda y cuántas caben. */
  cycleOf(plot) {
    if (plot.kind === 'plant') {
      const d = MATERIAL_PLANTS.find(m => m.id === plot.plantId);
      return d ? { ms: d.cycleMs, cap: d.capCycles } : { ms: 6e4, cap: 3 };
    }
    if (plot.kind === 'job') return { ms: JOB_BUILDING.cycleMs, cap: JOB_BUILDING.capCycles };
    const r = tierRules(plot.tier);
    return { ms: r.cycleMs, cap: r.capCycles };
  }

  /** Tandas acumuladas, con decimales. El tope es lo que te hace volver. */
  cyclesReady(plot, now = Date.now()) {
    if (plot.state !== 'ready') return 0;
    const { ms, cap } = this.cycleOf(plot);
    return Math.min(cap, (now - plot.collectedAt) / ms);
  }

  /** 0..1 de lo lleno que está el almacén de esa parcela. */
  fillOf(plot, now = Date.now()) {
    return this.cyclesReady(plot, now) / this.cycleOf(plot).cap;
  }

  /**
   * Qué hay ahora mismo dentro de una parcela.
   * @returns {{cash:number, materials:number, ready:boolean}}
   */
  pending(plot, now = Date.now()) {
    const cycles = this.cyclesReady(plot, now);
    if (cycles <= 0) return { cash: 0, materials: 0, ready: false };

    if (plot.kind === 'plant') {
      const d = MATERIAL_PLANTS.find(m => m.id === plot.plantId);
      return { cash: 0, materials: Math.floor(cycles) * (d ? d.perCycle : 0), ready: cycles >= 1 };
    }

    if (plot.kind === 'job') {
      // El sueldo pasa a ser un edificio: deja de ser una fila de tabla.
      const perMonth = this.engine.effectiveSalaryBase();
      return { cash: Math.round(perMonth * cycles * (JOB_BUILDING.cycleMs / PERIOD_MS)),
        materials: 0, ready: cycles >= 0.05 };
    }

    const asset = this.assetOf(plot);
    if (!asset) return { cash: 0, materials: 0, ready: false };
    /*
     * La renta por tanda sale de la cifra MENSUAL del motor, escalada por
     * lo que dura la tanda respecto a un mes. Así un escalón alto no renta
     * más por hora que uno bajo: renta lo mismo, pero molesta menos. Lo
     * que compras al subir de escalón es volumen y comodidad, no un
     * multiplicador escondido.
     */
    const perMonth = this.engine.assetNetIncome(asset);
    const { ms } = this.cycleOf(plot);
    return { cash: Math.round(perMonth * cycles * (ms / PERIOD_MS)),
      materials: 0, ready: cycles >= 0.05 };
  }

  assetOf(plot) {
    if (!plot.instanceId) return null;
    return this.engine.ownedAssets.find(a => a.instanceId === plot.instanceId) || null;
  }

  /** Recoge una parcela. @returns {{cash, materials}} lo recogido */
  collect(plot, now = Date.now()) {
    const got = this.pending(plot, now);
    if (!got.ready) return { cash: 0, materials: 0 };

    if (got.materials) {
      const room = materialCap(this.level) - this.materials;
      got.materials = Math.max(0, Math.min(got.materials, room));
      this.materials += got.materials;
      // Solo se consume el tiempo de las tandas enteras recogidas: si el
      // almacén está lleno no se tira lo que sobra, se queda esperando.
      const d = MATERIAL_PLANTS.find(m => m.id === plot.plantId);
      const taken = d && d.perCycle ? got.materials / d.perCycle : 0;
      plot.collectedAt += taken * this.cycleOf(plot).ms;
    } else {
      this.engine.cash += got.cash;
      plot.collectedAt = now;
    }
    if (got.cash > 0 || got.materials > 0) this.addXp(1 + plot.tier);
    return got;
  }

  /**
   * Recoge todo lo que esté listo. Existe porque tocar cuarenta burbujas
   * una a una es trabajo, no juego: la gracia de tocar el edificio se
   * pierde en cuanto hay muchos.
   */
  collectAll(now = Date.now()) {
    let cash = 0, materials = 0, n = 0;
    for (const p of this.plots.values()) {
      const got = this.collect(p, now);
      if (got.cash || got.materials) { cash += got.cash; materials += got.materials; n++; }
    }
    return { cash, materials, count: n };
  }

  materialsFull() { return this.materials >= materialCap(this.level); }

  materialCap() { return materialCap(this.level); }

  spendMaterials(n) {
    if (this.materials < n) return false;
    this.materials -= n;
    return true;
  }

  /* ============================= NIVEL ============================= */

  addXp(n) {
    this.xp += n;
    let up = 0;
    while (this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level++;
      up++;
    }
    // subir de nivel urbaniza una manzana mas: crecer se VE, y se ve en
    // direccion a la costa, que es la recompensa
    if (up) this.refreshTerrain();
    return up;
  }

  xpNeeded() { return xpForLevel(this.level); }

  /* ====================== SIEMBRA INICIAL ========================== */

  /**
   * Los tres edificios de servicio existen desde el minuto uno: son los
   * paneles de fiscalidad, deuda y seguros convertidos en sitios a los
   * que vas, y si no estuvieran ahí desde el principio esas mecánicas
   * quedarían escondidas.
   */
  seedCivic() {
    // Se avanza según lo ancho que sea cada uno, no de casilla en casilla:
    // el ayuntamiento ocupa dos y el hospital tres, así que con paso fijo
    // el banco no encontraba sitio y acababa desterrado al otro extremo
    // de la ciudad, lejos de los otros dos servicios.
    // Sin coordenadas fijas: la isla cambia con la semilla y unas casillas
    // codificadas a mano acabarian en el agua. findSpot() ya sabe elegir.
    CIVIC.forEach(c => {
      this.add({ kind: 'civic', civicId: c.id, sprite: c.sprite,
        category: 'financial', tier: 3 });
    });
    this.add({ kind: 'job', sprite: JOB_BUILDING.sprite,
      category: 'digital_business', tier: 3 });
  }

  /** Siembra decoración en huecos, para que la ciudad no tenga calvas. */
  sprinkleScenery(n = 6) {
    const free = [];
    for (const [k, t] of this.terrain) {
      if (t !== 'grass') continue;
      const [c, r] = k.split(',').map(Number);
      if (this.occupied.has(k)) continue;
      free.push({ col: c, row: r });
    }
    let placed = 0;
    while (placed < n && free.length) {
      const i = Math.floor(Math.random() * free.length);
      const { col, row } = free.splice(i, 1)[0];
      const sprite = SCENERY[Math.floor(Math.random() * SCENERY.length)];
      if (!this.atlas[sprite]) continue;
      if (this.add({ kind: 'scenery', sprite, category: 'real_estate' }, col, row)) {
        placed++;
      }
    }
    return placed;
  }

  /* ========================== PERSISTENCIA ========================= */

  toJSON() {
    return {
      seed: this.layout.seed, uid: this._uid,
      materials: this.materials, level: this.level, xp: this.xp,
      urbanized: [...this.urbanized],
      plots: this.list(),
    };
  }

  load(data) {
    if (!data) return;
    this._uid = data.uid ?? 0;
    this.materials = data.materials ?? 20;
    this.level = data.level ?? 1;
    this.xp = data.xp ?? 0;
    this.urbanized = new Set(data.urbanized || []);
    this.refreshTerrain();
    this.plots.clear();
    this.occupied.clear();
    (data.plots || []).forEach(p => {
      this.plots.set(p.uid, p);
      this._occupy(p);
    });
  }
}
