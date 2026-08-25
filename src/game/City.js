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

/** Cuadrantes temáticos, como en la ciudad antigua: cada categoría, su barrio. */
const DISTRICTS = ['real_estate', 'digital_business', 'financial'];

export class City {
  /**
   * @param {EconomyEngine} engine
   * @param {object} models  contenido de models.json
   * @param {object} atlas   contenido de sprites.json
   */
  constructor(engine, models, atlas) {
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

    this.cols = 10;
    this.rows = 10;
    this.plots = new Map();     // uid -> parcela
    this.occupied = new Map();  // "col,row" -> uid
    this._uid = 0;

    this.materials = 20;
    this.level = 1;
    this.xp = 0;

    this.seedCivic();
  }

  /* ============================ REJILLA ============================ */

  key(col, row) { return col + ',' + row; }

  inBounds(col, row, fw = 1, fh = 1) {
    return col >= 0 && row >= 0 && col + fw <= this.cols && row + fh <= this.rows;
  }

  isFree(col, row, fw = 1, fh = 1, ignoreUid = null) {
    if (!this.inBounds(col, row, fw, fh)) return false;
    for (let c = col; c < col + fw; c++) {
      for (let r = row; r < row + fh; r++) {
        const uid = this.occupied.get(this.key(c, r));
        if (uid != null && uid !== ignoreUid) return false;
      }
    }
    return true;
  }

  /** Amplía la parcela cuando queda poco sitio: la ciudad nunca se atasca. */
  ensureRoom() {
    const free = this.cols * this.rows - this.occupied.size;
    if (free > 12) return false;
    this.cols += 3;
    this.rows += 3;
    return true;
  }

  /** Cuadrante que le toca a una categoría. */
  districtOrigin(category) {
    const i = Math.max(0, DISTRICTS.indexOf(category));
    const hc = Math.floor(this.cols / 2);
    const hr = Math.floor(this.rows / 2);
    return [{ c: 0, r: 0 }, { c: hc, r: 0 }, { c: 0, r: hr }, { c: hc, r: hr }][i];
  }

  /**
   * Busca sitio para un edificio: primero en su barrio, luego donde quepa.
   * Recorre en espiral desde el origen del cuadrante para que los barrios
   * crezcan compactos en vez de dejar calvas.
   */
  findSpot(fw, fh, category) {
    const o = this.districtOrigin(category);
    const tryFrom = (sc, sr) => {
      for (let d = 0; d < Math.max(this.cols, this.rows); d++) {
        for (let c = sc; c <= sc + d && c < this.cols; c++) {
          for (let r = sr; r <= sr + d && r < this.rows; r++) {
            if ((c === sc + d || r === sr + d) && this.isFree(c, r, fw, fh)) {
              return { col: c, row: r };
            }
          }
        }
      }
      return null;
    };
    let spot = tryFrom(o.c, o.r);
    if (spot) return spot;
    spot = tryFrom(0, 0);
    if (spot) return spot;
    this.ensureRoom();
    return tryFrom(0, 0);
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
    let spot = (col != null && this.isFree(col, row, fw, fh))
      ? { col, row }
      : this.findSpot(fw, fh, spec.category);
    if (!spot) return null;

    const now = Date.now();
    const plot = {
      uid: ++this._uid,
      kind: spec.kind || 'asset',
      sprite: spec.sprite,
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
    let col = 1;
    const row = this.rows - 3;
    CIVIC.forEach(c => {
      const [fw] = this.footprintOf(c.sprite);
      const p = this.add({ kind: 'civic', civicId: c.id, sprite: c.sprite,
        category: 'financial' }, col, row);
      col += (p ? p.fw : fw);
    });
    // El trabajo, pegado a los servicios: la ciudad de partida tiene que
    // caber de un vistazo en un movil, no repartirse por la parcela.
    this.add({ kind: 'job', sprite: JOB_BUILDING.sprite, category: 'digital_business' },
      1, this.rows - 5);
  }

  /** Siembra decoración en huecos, para que la ciudad no tenga calvas. */
  sprinkleScenery(n = 6) {
    let placed = 0, guard = 200;
    while (placed < n && guard-- > 0) {
      const c = Math.floor(Math.random() * this.cols);
      const r = Math.floor(Math.random() * this.rows);
      if (!this.isFree(c, r, 1, 1)) continue;
      const sprite = SCENERY[Math.floor(Math.random() * SCENERY.length)];
      if (!this.atlas[sprite]) continue;
      this.add({ kind: 'scenery', sprite, category: 'real_estate' }, c, r);
      placed++;
    }
    return placed;
  }

  /* ========================== PERSISTENCIA ========================= */

  toJSON() {
    return {
      cols: this.cols, rows: this.rows, uid: this._uid,
      materials: this.materials, level: this.level, xp: this.xp,
      plots: this.list(),
    };
  }

  load(data) {
    if (!data) return;
    this.cols = data.cols ?? this.cols;
    this.rows = data.rows ?? this.rows;
    this._uid = data.uid ?? 0;
    this.materials = data.materials ?? 20;
    this.level = data.level ?? 1;
    this.xp = data.xp ?? 0;
    this.plots.clear();
    this.occupied.clear();
    (data.plots || []).forEach(p => {
      this.plots.set(p.uid, p);
      this._occupy(p);
    });
  }
}
