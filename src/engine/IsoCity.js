/**
 * IsoCity.js
 * ------------------------------------------------------------------
 * Renderizador isométrico 2D sobre <canvas>. Pinta una parcela (grid)
 * con sprites de Kenney, organiza los edificios por DISTRITOS según su
 * categoría y anima su construcción (scale-in) y el cobro (monedas).
 * Ancla inferior-centro. Offsets validados: TW=132, TH=66.
 * ------------------------------------------------------------------
 */

const TW = 132;      // ancho del rombo base
const TH = 66;       // alto del rombo base
const HW = TW / 2;   // 66
const HH = TH / 2;   // 33

// Distritos: cada categoría ocupa un cuadrante del tablero 6x6.
const DISTRICTS = {
  real_estate:      { r0: 0, r1: 2, c0: 0, c1: 2, floor: 't_grass' },
  digital_business: { r0: 0, r1: 2, c0: 3, c1: 5, floor: 't_ground' },
  financial:        { r0: 3, r1: 5, c0: 3, c1: 5, floor: 't_ground' },
};

export class IsoCity {
  constructor(canvas, cols = 6, rows = 6) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cols = cols;
    this.rows = rows;
    this.sprites = {};
    this.grid = [];
    this.floatups = [];      // monedas al cobrar
    this.placeAnims = {};    // "r,c" -> { t } animación de construcción
    this.dpr = window.devicePixelRatio || 1;
    this.centerCell = { row: Math.floor(rows / 2), col: Math.floor(cols / 2) };

    for (let r = 0; r < rows; r++) {
      this.grid[r] = [];
      for (let c = 0; c < cols; c++) {
        this.grid[r][c] = { floor: 't_ground', building: null, decor: null };
      }
    }
    this._raf = null;
  }

  /** Aplica suelos por distrito, plaza central y algo de vegetación. */
  buildDistricts() {
    for (const d of Object.values(DISTRICTS)) {
      for (let r = d.r0; r <= d.r1; r++)
        for (let c = d.c0; c <= d.c1; c++)
          if (this.grid[r] && this.grid[r][c]) this.grid[r][c].floor = d.floor;
    }
    // plaza central con árbol (el "hogar" del jugador)
    const { row, col } = this.centerCell;
    this.grid[row][col].floor = 't_plaza';
    this.grid[row][col].decor = 't_tree';

    // vegetación dispersa en celdas libres del distrito residencial
    const re = DISTRICTS.real_estate;
    const spots = [];
    for (let r = re.r0; r <= re.r1; r++)
      for (let c = re.c0; c <= re.c1; c++)
        if (!this.grid[r][c].building && !this.grid[r][c].decor) spots.push({ r, c });
    shuffle(spots).slice(0, 3).forEach(s => { this.grid[s.r][s.c].decor = 't_tree'; });

    this.draw();
  }

  loadSprites(map) {
    const entries = Object.entries(map);
    return Promise.all(entries.map(([key, url]) => new Promise((res) => {
      const img = new Image();
      img.onload = () => { this.sprites[key] = img; res(); };
      img.onerror = () => { console.warn('No se pudo cargar', url); res(); };
      img.src = url;
    })));
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.draw();
  }

  origin() {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const ox = w / 2;
    const oy = h / 2 - ((this.cols + this.rows) * HH) / 2 + 40;
    return { ox, oy };
  }

  cellToScreen(col, row) {
    const { ox, oy } = this.origin();
    return { x: ox + (col - row) * HW, y: oy + (col + row) * HH };
  }

  /** Primera celda libre dentro del distrito de una categoría (o cualquiera). */
  freeCellInDistrict(category) {
    const d = DISTRICTS[category];
    if (d) {
      for (let r = d.r0; r <= d.r1; r++)
        for (let c = d.c0; c <= d.c1; c++) {
          const g = this.grid[r][c];
          if (g && !g.building && g.floor !== 't_plaza') return { row: r, col: c };
        }
    }
    return this.firstFreeCell();
  }

  firstFreeCell() {
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const g = this.grid[r][c];
        if (!g.building && g.floor !== 't_plaza') return { row: r, col: c };
      }
    return null;
  }

  /** Define los pools de sprites por categoría (variedad visual por distrito). */
  setBuildingPools(pools) { this.buildingPools = pools || {}; }

  /** Elige un sprite de edificio aleatorio del pool de la categoría. */
  pickBuildingSprite(category) {
    const pool = (this.buildingPools && this.buildingPools[category]) || [];
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : category;
  }

  /**
   * Coloca un edificio (sprite variado del distrito) con animación de construcción.
   * @returns {{cell, key}|null}
   */
  placeBuilding(category, cell = null, forcedKey = null) {
    const target = cell || this.freeCellInDistrict(category);
    if (!target) return null;
    const key = forcedKey || this.pickBuildingSprite(category);
    this.grid[target.row][target.col].building = key;
    this.grid[target.row][target.col].decor = null;
    this.placeAnims[`${target.row},${target.col}`] = { t: 0 };
    this.animate();
    return { cell: target, key };
  }

  /** Retira el edificio de una celda (al vender el activo). */
  removeBuilding(cell) {
    if (!cell) return;
    const g = this.grid[cell.row] && this.grid[cell.row][cell.col];
    if (g) { g.building = null; this.draw(); }
  }

  /** Monedas ascendentes desde cada edificio (feedback al cobrar). */
  emitCoins() {
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.grid[r][c].building) {
          const p = this.cellToScreen(c, r);
          this.floatups.push({ x: p.x, y: p.y - 70, life: 1, vy: -0.6 });
        }
    this.animate();
  }

  animate() {
    if (this._raf) return;
    const step = () => {
      // avanzar animaciones
      this.floatups.forEach(f => { f.y += f.vy; f.life -= 0.02; });
      this.floatups = this.floatups.filter(f => f.life > 0);
      for (const k of Object.keys(this.placeAnims)) {
        this.placeAnims[k].t += 0.08;
        if (this.placeAnims[k].t >= 1) delete this.placeAnims[k];
      }
      this.draw();
      const active = this.floatups.length || Object.keys(this.placeAnims).length;
      this._raf = active ? requestAnimationFrame(step) : null;
    };
    this._raf = requestAnimationFrame(step);
  }

  draw() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.clearRect(0, 0, w, h);

    const cells = [];
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        cells.push({ r, c });
    cells.sort((a, b) => (a.r + a.c) - (b.r + b.c));

    for (const { r, c } of cells) {
      const g = this.grid[r][c];
      const p = this.cellToScreen(c, r);
      this.blit(g.floor, p.x, p.y);
      if (g.decor) this.blit(g.decor, p.x, p.y);
      if (g.building) {
        const anim = this.placeAnims[`${r},${c}`];
        const s = anim ? easeOutBack(anim.t) : 1;
        this.blit(g.building, p.x, p.y, s);
      }
    }

    ctx.font = '20px system-ui';
    ctx.textAlign = 'center';
    for (const f of this.floatups) {
      ctx.globalAlpha = Math.max(0, f.life);
      ctx.fillText('🪙', f.x, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** Dibuja un sprite anclado por su base inferior-centro, con escala opcional. */
  blit(key, x, y, s = 1) {
    const img = this.sprites[key];
    if (!img) return;
    const w = img.width * s, hgt = img.height * s;
    this.ctx.drawImage(img, Math.round(x - w / 2), Math.round(y - hgt), Math.round(w), Math.round(hgt));
  }
}

/* ------------------------------ util ------------------------------ */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  const x = Math.min(1, t);
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
