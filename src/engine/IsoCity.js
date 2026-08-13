/**
 * IsoCity.js
 * ------------------------------------------------------------------
 * Renderizador isométrico sobre <canvas>. Ya no pega sprites: construye la
 * ciudad con CityArt, que dibuja cada edificio a partir de su ficha.
 *
 * Dos cambios de fondo respecto a la versión de sprites:
 *
 *   1. LA PARCELA CRECE. Antes eran 36 casillas fijas y el jugador llegaba a
 *      tener cientos de activos: a partir del edificio 37 comprar dejaba de
 *      tener consecuencia visual. Ahora el tablero se amplía solo y la escena
 *      se reescala para caber siempre en pantalla.
 *
 *   2. HAY CALLES. Los distritos se separan con viales, así que la ciudad se
 *      lee como un sitio con barrios y no como un bloque macizo de cajas.
 * ------------------------------------------------------------------
 */

import {
  TW, TH, drawTile, drawParcel, drawBuilding, drawTree, drawLamp, drawCoin, heightOf, specFor,
} from './CityArt.js';

const HW = TW / 2;
const HH = TH / 2;

/** Categorías por cuadrante. El cuarto cuadrante queda de parque. */
const QUADRANTS = ['real_estate', 'digital_business', 'financial'];

export class IsoCity {
  constructor(canvas, cols = 6, rows = 6) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cols = cols;
    this.rows = rows;
    this.grid = [];
    this.floatups = [];
    this.placeAnims = {};
    this.dpr = window.devicePixelRatio || 1;
    this.scale = 1;
    this._raf = null;
    this._buildGrid();
  }

  /* ------------------------- LA PARCELA ---------------------------- */

  _buildGrid(keep = null) {
    this.grid = [];
    for (let r = 0; r < this.rows; r++) {
      this.grid[r] = [];
      for (let c = 0; c < this.cols; c++) {
        this.grid[r][c] = { floor: 'ground', building: null, decor: null };
      }
    }
    if (keep) keep.forEach(({ row, col, cell }) => {
      if (this.grid[row] && this.grid[row][col]) this.grid[row][col] = cell;
    });
  }

  /** ¿Qué categoría le toca a esta celda? (null = zona común) */
  districtOf(row, col) {
    const half = Math.floor(this.rows / 2);
    const halfC = Math.floor(this.cols / 2);
    if (row < half && col < halfC) return QUADRANTS[0];
    if (row < half && col >= halfC) return QUADRANTS[1];
    if (row >= half && col >= halfC) return QUADRANTS[2];
    return null;   // cuadrante del parque
  }

  /** Los viales van por el centro del tablero, separando cuadrantes. */
  isRoad(row, col) {
    if (this.rows <= 4) return false;
    return row === Math.floor(this.rows / 2) || col === Math.floor(this.cols / 2);
  }

  /** Pinta suelos, viales y vegetación del cuadrante común. */
  buildDistricts() {
    const FLOORS = { real_estate: 'grass', digital_business: 'ground', financial: 'stone' };
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const g = this.grid[r][c];
        if (this.isRoad(r, c)) { g.floor = 'road'; g.building = null; continue; }
        const d = this.districtOf(r, c);
        g.floor = d ? FLOORS[d] : 'plaza';
      }
    }
    // el cuadrante común es el parque: estanque, arbolado y farolas
    const park = [];
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (!this.districtOf(r, c) && !this.isRoad(r, c)) park.push({ r, c });
    // un estanque de 2x2 en el corazón del parque: da un punto de descanso
    if (park.length >= 6) {
      const pr = park[Math.floor(park.length * 0.42)];
      [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(([dr, dc]) => {
        const g = this.grid[pr.r + dr] && this.grid[pr.r + dr][pr.c + dc];
        if (g && !this.districtOf(pr.r + dr, pr.c + dc) && !this.isRoad(pr.r + dr, pr.c + dc)) {
          g.floor = 'water'; g.decor = null;
        }
      });
    }
    park.forEach(({ r, c }) => {
      const g = this.grid[r][c];
      if (g.building || g.decor || g.floor === 'water') return;
      const h = (r * 37 + c * 19 + r * c) % 10;
      g.decor = h < 7 ? 'tree' : 'lamp';
    });
    this.draw();
  }

  /**
   * Amplía el tablero hasta que quepan `n` edificios. La ciudad deja de tener
   * techo: siempre se ve todo lo que has construido.
   */
  ensureCapacity(n) {
    let grew = false;
    while (this.buildableCells() < n && this.cols < 22) {
      const keep = [];
      for (let r = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++)
          if (this.grid[r][c].building) keep.push({ row: r, col: c, cell: this.grid[r][c] });
      this.cols += 2; this.rows += 2;
      this._buildGrid(keep);
      grew = true;
    }
    if (grew) this.buildDistricts();
    return grew;
  }

  buildableCells() {
    let n = 0;
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (!this.isRoad(r, c) && this.districtOf(r, c)) n++;
    return n;
  }

  /* --------------------------- ESCALA ------------------------------ */

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.draw();
  }

  /** Escala que hace caber la parcela entera, con margen para los edificios. */
  fitScale() {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    const gw = (this.cols + this.rows) * HW;
    const gh = (this.cols + this.rows) * HH + 150;   // hueco para las torres
    return Math.max(0.22, Math.min(1.15, Math.min((w - 40) / gw, (h - 40) / gh)));
  }

  origin() {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    const s = this.scale;
    const gh = (this.cols + this.rows) * HH * s;
    return { ox: w / 2, oy: (h - gh) / 2 + 46 * s };
  }

  cellToScreen(col, row) {
    const { ox, oy } = this.origin();
    const s = this.scale;
    return { x: ox + (col - row) * HW * s, y: oy + (col + row) * HH * s };
  }

  /* ------------------------- EDIFICIOS ----------------------------- */

  freeCellInDistrict(category) {
    // primero, dentro de su barrio; después, donde quepa
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const g = this.grid[r][c];
        if (this.districtOf(r, c) === category && !this.isRoad(r, c) && !g.building) return { row: r, col: c };
      }
    return this.firstFreeCell();
  }

  firstFreeCell() {
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.districtOf(r, c) && !this.isRoad(r, c) && !this.grid[r][c].building) return { row: r, col: c };
    return null;
  }

  /**
   * Coloca un edificio a partir de su ficha de dibujo.
   * @param {object} spec  de CityArt.specFor()
   * @param {{row,col}|null} cell  celda concreta (al restaurar una partida)
   * @returns {{cell}|null}
   */
  placeBuilding(spec, cell = null) {
    const target = cell || this.freeCellInDistrict(spec.cat);
    if (!target) return null;
    const g = this.grid[target.row] && this.grid[target.row][target.col];
    if (!g) return null;
    g.building = spec;
    g.decor = null;
    this.placeAnims[`${target.row},${target.col}`] = { t: 0 };
    this.animate();
    return { cell: target };
  }

  removeBuilding(cell) {
    if (!cell) return;
    const g = this.grid[cell.row] && this.grid[cell.row][cell.col];
    if (g) { g.building = null; this.draw(); }
  }

  /** Reconstruye la ciudad entera desde el portfolio (al cargar una partida). */
  rebuildFrom(assets, tierOf) {
    this.ensureCapacity(assets.length + 2);
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) this.grid[r][c].building = null;
    this.buildDistricts();
    assets.forEach(a => {
      const spec = specFor(a, tierOf ? tierOf(a) : 1);
      const placed = this.placeBuilding(spec, a.cell && this.grid[a.cell.row] ? a.cell : null);
      if (placed) a.cell = placed.cell;
    });
    this.placeAnims = {};
    this.draw();
  }

  setViewData(players, pools) {
    this.globalPlayers = players || null;
    this.globalPools = pools || null;
  }

  emitCoins() {
    if (this.globalPlayers) return;
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const b = this.grid[r][c].building;
        if (!b) continue;
        const p = this.cellToScreen(c, r);
        this.floatups.push({ x: p.x, y: p.y - heightOf(b) * this.scale - 8, life: 1, vy: -0.65 });
      }
    this.animate();
  }

  animate() {
    if (this._raf) return;
    const step = () => {
      this.floatups.forEach(f => { f.y += f.vy; f.life -= 0.02; });
      this.floatups = this.floatups.filter(f => f.life > 0);
      for (const k of Object.keys(this.placeAnims)) {
        this.placeAnims[k].t += 0.075;
        if (this.placeAnims[k].t >= 1) delete this.placeAnims[k];
      }
      this.draw();
      const active = this.floatups.length || Object.keys(this.placeAnims).length;
      this._raf = active ? requestAnimationFrame(step) : null;
    };
    this._raf = requestAnimationFrame(step);
  }

  /* --------------------------- DIBUJO ------------------------------ */

  draw() {
    if (this.globalPlayers) { this.drawMiniCities(this.globalPlayers); return; }
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    this.scale = this.fitScale();

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this._sky(ctx, w, h);

    const { ox, oy } = this.origin();
    ctx.translate(ox, oy);
    ctx.scale(this.scale, this.scale);

    const cells = [];
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) cells.push({ r, c });
    cells.sort((a, b) => (a.r + a.c) - (b.r + b.c));

    // el bloque de terreno primero, y encima las superficies de cada celda
    drawParcel(ctx, this.cols, this.rows);
    for (const { r, c } of cells) {
      const g = this.grid[r][c];
      const x = (c - r) * HW, y = (c + r) * HH;
      drawTile(ctx, x, y, g.floor, `${r},${c}`, {
        axis: r === Math.floor(this.rows / 2) ? 'ns' : 'ew',
      });
    }
    // y después lo que se levanta, de fondo a frente
    for (const { r, c } of cells) {
      const g = this.grid[r][c];
      const x = (c - r) * HW, y = (c + r) * HH;
      if (g.decor === 'tree') drawTree(ctx, x, y, `${r},${c}`);
      else if (g.decor === 'lamp') drawLamp(ctx, x, y, `${r},${c}`);
      if (g.building) {
        const anim = this.placeAnims[`${r},${c}`];
        drawBuilding(ctx, x, y, g.building, anim ? easeOutBack(anim.t) : 1);
      }
    }
    ctx.restore();

    // las monedas van en coordenadas de pantalla, sin escalar
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const f of this.floatups) drawCoin(ctx, f.x, f.y, f.life);
    ctx.restore();
  }

  /** Cielo: un degradado sutil para que la parcela no flote en negro. */
  _sky(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#141c2e');
    g.addColorStop(0.55, '#0e1422');
    g.addColorStop(1, '#0a0f19');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // resplandor cálido tras el horizonte
    const r = ctx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.42, Math.max(w, h) * 0.5);
    r.addColorStop(0, 'rgba(74,168,255,.09)');
    r.addColorStop(1, 'rgba(74,168,255,0)');
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, w, h);
  }

  /* ----------------------- VISTA GLOBAL ----------------------------- */

  drawMiniCities(players) {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this._sky(ctx, w, h);

    const n = Math.max(1, players.length);
    const cols = w < 700 ? Math.min(2, n) : Math.min(4, n);
    const rowsN = Math.ceil(n / cols);
    const cw = w / cols, ch = (h - 20) / rowsN;

    players.forEach((p, i) => {
      const cx = cw * (i % cols) + cw / 2;
      const cy = ch * Math.floor(i / cols) + 24;
      if (p.me) {
        ctx.fillStyle = 'rgba(46,230,160,.06)';
        ctx.fillRect(cw * (i % cols) + 5, cy - 18, cw - 10, ch - 8);
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = p.me ? '#2ee6a0' : '#e7ecf4';
      ctx.font = 'bold 14px system-ui';
      ctx.fillText(`${p.emoji} ${p.name}`, cx, cy);
      ctx.fillStyle = '#8a97ad'; ctx.font = '11px system-ui';
      ctx.fillText(`IE ${p.ie.toFixed(0)}%  ·  ${p.count} activos`, cx, cy + 16);
      const bw = Math.min(150, cw * 0.6), bx = cx - bw / 2, by = cy + 26;
      ctx.fillStyle = '#0d1320'; ctx.fillRect(bx, by, bw, 5);
      ctx.fillStyle = p.won ? '#ffb23e' : '#2ee6a0';
      ctx.fillRect(bx, by, bw * Math.min(1, p.ie / 120), 5);
      this._miniCity(ctx, cx, cy + ch * 0.62, p, Math.min(0.34, cw / 460));
    });
    ctx.restore();
  }

  _miniCity(ctx, ox, oy, player, scale) {
    const N = 4;
    const cells = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push({ r, c });
    cells.sort((a, b) => (a.r + a.c) - (b.r + b.c));
    const list = (player.list || []).slice(0, N * N);

    ctx.save();
    ctx.translate(ox, oy - N * HH * scale);
    ctx.scale(scale, scale);
    for (const { r, c } of cells) {
      drawTile(ctx, (c - r) * HW, (c + r) * HH, 'ground', `m${r},${c}`, { depth: 6 });
    }
    let qi = 0;
    for (const { r, c } of cells) {
      const a = list[qi++];
      if (!a) break;
      drawBuilding(ctx, (c - r) * HW, (c + r) * HH, specFor(a, a._tier || 1), 1);
    }
    ctx.restore();
  }
}

/* ------------------------------ util ------------------------------ */
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  const x = Math.min(1, t);
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
